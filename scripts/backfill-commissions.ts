/**
 * Recalcula la comisión Y el costo de producto de órdenes ya registradas, con
 * las reglas y los costos vigentes.
 *
 * CUÁNDO SE CORRE
 * · La primera vez que se cargan reglas (las ventas anteriores quedaron en 0).
 * · Cuando cambia una comisión y se quiere reexpresar un período pasado.
 *
 * POR QUÉ ES UN SCRIPT EXPLÍCITO Y NO AUTOMÁTICO
 * Reescribe montos de ventas. La comisión se congela en la fila justamente para
 * que un reporte cerrado no se mueva solo (migración 011); recalcularla es una
 * decisión, no un efecto de tocar una pantalla. Por eso `--dry-run` va primero
 * en los ejemplos y existen `--from/--to`: lo normal es corregir un rango.
 *
 *   npm run commissions:backfill -- --dry-run
 *   npm run commissions:backfill
 *   npm run commissions:backfill -- --funnel=chauhinchazon --from=2026-08-01
 *   npm run commissions:backfill -- --recalcular-todas   (pisa las que ya tenían)
 *
 * Recalcula las dos cosas en la misma pasada a propósito: las dos se congelan en
 * la orden con el mismo criterio y se descuentan del mismo neto, así que
 * corregir una sin la otra deja el número a mitad de camino.
 */

import { q, tx } from '../lib/db';
import { getFunnelBySlug, listFunnels } from '../lib/funnels';
import { applyCommissions, rulesForFunnel } from '../lib/commissions';
import { applyCosts, costsForShop, type ProductCost } from '../lib/costs';

type Fila = {
  id: string;
  amount: string;
  currency: string;
  shopDomain: string;
  fxRate: string | null;
  commissionAmount: string;
  costAmount: string;
  items: Array<{ productId: string | null; title: string | null; quantity: number }> | null;
};

function arg(nombre: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  return p ? p.slice(nombre.length + 3) : undefined;
}
const tiene = (n: string): boolean => process.argv.includes(`--${n}`);

async function main(): Promise<void> {
  const dryRun = tiene('dry-run');
  const recalcularTodas = tiene('recalcular-todas');
  const slug = arg('funnel');
  const from = arg('from');
  const to = arg('to');

  const funnels = slug
    ? [await getFunnelBySlug(slug)].filter((f): f is NonNullable<typeof f> => f !== null)
    : await listFunnels({ includeInactive: true });
  if (funnels.length === 0) {
    console.error(slug ? `no existe el funnel '${slug}'` : 'no hay funnels');
    process.exit(1);
  }

  let totalTocadas = 0;
  const avisos: string[] = [];

  for (const f of funnels) {
    const reglas = await rulesForFunnel(f.id);
    const cond = ['funnel_id = $1'];
    const params: unknown[] = [f.id];
    if (from) {
      params.push(from);
      cond.push(`day >= $${params.length}::date`);
    }
    if (to) {
      params.push(to);
      cond.push(`day <= $${params.length}::date`);
    }
    // Por default solo las que están en 0 (el caso "recién cargué las reglas").
    // Pisar las que ya tienen un valor calculado con otras reglas reescribe
    // historia y hay que pedirlo a propósito.
    // Por default, las que no tienen NI comisión NI costo calculado.
    if (!recalcularTodas) cond.push('(commission_amount = 0 OR cost_amount = 0)');

    // Los ítems se traen agregados en la misma query: sin esto habría una
    // consulta por orden y un backfill de un año serían miles de round-trips.
    const filas = await q<Fila>(
      `SELECT o.id::text AS id, o.amount::text AS amount, o.currency,
              o.shop_domain AS "shopDomain",
              o.fx_rate::text AS "fxRate",
              o.commission_amount::text AS "commissionAmount",
              o.cost_amount::text AS "costAmount",
              (SELECT json_agg(json_build_object(
                        'productId', oi.shopify_product_id,
                        'title', oi.title,
                        'quantity', oi.quantity))
                 FROM order_items oi WHERE oi.order_id = o.id) AS items
       FROM orders o WHERE ${cond.join(' AND ')} ORDER BY o.day, o.id`,
      params,
    );

    // Los costos se leen por tienda; se cachean para no repetir la consulta.
    const costosPorTienda = new Map<string, ProductCost[]>();
    const costosDe = async (shop: string): Promise<ProductCost[]> => {
      const yaEsta = costosPorTienda.get(shop);
      if (yaEsta) return yaEsta;
      const c = await costsForShop(shop);
      costosPorTienda.set(shop, c);
      return c;
    };

    if (reglas.length === 0 && filas.length > 0) {
      // Sin reglas de comisión igual puede haber costos que aplicar, así que no
      // se corta acá: solo se avisa.
      console.log(`  ${f.slug.padEnd(16)} sin reglas de comisión activas`);
    }

    const detalle = reglas
      .map((r) => (r.kind === 'percent' ? `${r.value}%` : `${r.value} ${r.currency}`))
      .join(' + ');

    let comVieja = 0;
    let comNueva = 0;
    let costVieja = 0;
    let costNueva = 0;
    const updates: Array<
      [string, number, number | null, string, number, number | null, string]
    > = [];

    for (const r of filas) {
      const fxRate = r.fxRate === null ? null : Number(r.fxRate);
      const c = applyCommissions({
        amount: Number(r.amount),
        currency: r.currency,
        rules: reglas,
        fxRate,
      });
      const k = applyCosts({
        items: r.items ?? [],
        currency: r.currency,
        shopDomain: r.shopDomain,
        costs: await costosDe(r.shopDomain),
        fxRate,
      });
      // Array y no Set: el tsconfig de T01 no habilita downlevelIteration.
      [...c.warnings, ...k.warnings].forEach((w) => {
        if (!avisos.includes(w)) avisos.push(w);
      });
      comVieja += Number(r.commissionAmount);
      comNueva += c.amount;
      costVieja += Number(r.costAmount);
      costNueva += k.amount;
      updates.push([
        r.id,
        c.amount,
        c.amountEur,
        JSON.stringify(c.breakdown),
        k.amount,
        k.amountEur,
        JSON.stringify(k.breakdown),
      ]);
    }

    console.log(
      `  ${f.slug.padEnd(16)} ${String(filas.length).padStart(5)} órdenes · ${detalle || 'sin comisiones'}\n` +
        `  ${' '.repeat(16)} comisión ${comVieja.toFixed(2)} → ${comNueva.toFixed(2)} ${f.sellCurrency}\n` +
        `  ${' '.repeat(16)} costo    ${costVieja.toFixed(2)} → ${costNueva.toFixed(2)} ${f.sellCurrency}`,
    );

    if (dryRun || updates.length === 0) {
      totalTocadas += updates.length;
      continue;
    }

    // En lotes y en transacción: un backfill a medias dejaría un rango con dos
    // comisiones distintas y el total del mes no cerraría contra el de la semana.
    const LOTE = 500;
    for (let i = 0; i < updates.length; i += LOTE) {
      const lote = updates.slice(i, i + LOTE);
      await tx(async (c) => {
        await c.query(
          `UPDATE orders AS o SET
             commission_amount     = u.amount,
             commission_amount_eur = u.amount_eur,
             commission_breakdown  = u.breakdown,
             cost_amount           = u.cost,
             cost_amount_eur       = u.cost_eur,
             cost_breakdown        = u.cost_breakdown,
             updated_at            = now()
           FROM UNNEST($1::bigint[], $2::numeric[], $3::numeric[], $4::jsonb[],
                       $5::numeric[], $6::numeric[], $7::jsonb[])
                AS u(id, amount, amount_eur, breakdown, cost, cost_eur, cost_breakdown)
           WHERE o.id = u.id`,
          [
            lote.map((x) => x[0]),
            lote.map((x) => x[1]),
            lote.map((x) => x[2]),
            lote.map((x) => x[3]),
            lote.map((x) => x[4]),
            lote.map((x) => x[5]),
            lote.map((x) => x[6]),
          ],
        );
      });
    }
    totalTocadas += updates.length;
  }

  if (avisos.length > 0) {
    console.log('\nAvisos:');
    for (const a of avisos) console.log(`  · ${a}`);
  }

  console.log(
    dryRun
      ? `\n[dry-run] se actualizarían ${totalTocadas} órdenes. No se escribió nada.`
      : `\n${totalTocadas} órdenes actualizadas.`,
  );
  if (!dryRun && totalTocadas > 0) {
    console.log('Corré el rollup para que el Resumen refleje el cambio:');
    console.log('  npm run rollup -- --days=400');
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
