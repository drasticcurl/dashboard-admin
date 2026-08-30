/**
 * Importa el export de órdenes de Shopify (CSV) a `orders`.
 *
 *   npm run import:csv -- --file=orders_export_1.csv --dry-run
 *   npm run import:csv -- --file=orders_export_1.csv
 *   npm run import:csv -- --file=... --shop=mitienda.myshopify.com
 *
 * PARA QUÉ
 * El webhook solo trae las ventas que ocurren desde que se configuró. Todo lo
 * anterior existe únicamente en Shopify, y sin eso el panel no puede comparar
 * contra ningún período pasado.
 *
 * IDEMPOTENTE POR DISEÑO
 * Usa `source='shopify'` y `external_id='shopify_'||Id`, la MISMA clave que el
 * webhook. Así las órdenes que ya entraron por webhook se saltean solas
 * (`ON CONFLICT DO NOTHING`) y una orden importada hoy no se duplica si mañana
 * llega un webhook de devolución sobre ella.
 *
 * LO QUE EL CSV NO TRAE, Y CÓMO SE RESUELVE
 * · `product_id`: no viene (el SKU está vacío en todas las filas). El producto se
 *   resuelve por `Lineitem name` contra `product_map.label`. Con tres nombres
 *   distintos en el archivo es verificable a ojo; si un nombre no matchea, la
 *   orden entra con tier 'unknown' y se informa, nunca se adivina.
 * · Cotización de días viejos: `fx_rates` arranca el día que se instaló el panel,
 *   así que las órdenes anteriores quedan con `amount_eur` NULL y `fx_stale`.
 *   Se informa al final. Para verlas en euros hay que cargar cotizaciones de esos
 *   días a mano y correr `fx:backfill` — inventar una conversión retroactiva con
 *   la cotización de hoy distorsionaría todo el histórico.
 *
 * LO QUE NO SE IMPORTA
 * Las órdenes `expired` y `pending` no son ventas: el pago nunca se completó.
 * Importarlas las contaría como plata devuelta (las queries suman como devuelto
 * todo lo que no está aprobado). Se saltean y se informan.
 */

import { readFileSync } from 'node:fs';
import { q, tx } from '../lib/db';
import { listFunnels } from '../lib/funnels';
import { applyCommissions, rulesForFunnel, type CommissionRule } from '../lib/commissions';
import { applyCosts, costsForShop, type ProductCost } from '../lib/costs';
import { toReportCurrency } from '../lib/fx';

// ─── CSV ────────────────────────────────────────────────────────────────────
/**
 * Parser RFC 4180 mínimo. Se escribe a mano en lugar de sumar una dependencia
 * porque el único requisito no trivial es el que sí importa acá: los campos
 * entrecomillados contienen saltos de línea (los Note Attributes son
 * `clave: valor` uno por línea), así que partir por `\n` rompe el archivo.
 */
function parseCsv(texto: string): string[][] {
  const filas: string[][] = [];
  let campo = '';
  let fila: string[] = [];
  let enComillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]!;
    if (enComillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i++;
        } else enComillas = false;
      } else campo += c;
    } else if (c === '"') {
      enComillas = true;
    } else if (c === ',') {
      fila.push(campo);
      campo = '';
    } else if (c === '\n') {
      fila.push(campo);
      filas.push(fila);
      fila = [];
      campo = '';
    } else if (c !== '\r') {
      campo += c;
    }
  }
  if (campo !== '' || fila.length > 0) {
    fila.push(campo);
    filas.push(fila);
  }
  return filas;
}

/** `clave: valor` por línea → objeto. Las claves repetidas: gana la primera. */
function parseNoteAttributes(texto: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const linea of texto.split('\n')) {
    const i = linea.indexOf(':');
    if (i <= 0) continue;
    const k = linea.slice(0, i).trim();
    const v = linea.slice(i + 1).trim();
    if (k && v && !(k in out)) out[k] = v;
  }
  return out;
}

const DIRECTO = '(directo)';
/** Misma normalización que el ingest y el webhook: si los tres no coinciden, la atribución se parte. */
function limpiarUtm(v: string | undefined): string {
  if (!v) return DIRECTO;
  const s = decodeURIComponent(v.replace(/\+/g, ' ')).replace(/\s+/g, ' ').trim();
  return s === '' ? DIRECTO : s;
}

function arg(n: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${n}=`));
  return p ? p.slice(n.length + 3) : undefined;
}
const tiene = (n: string): boolean => process.argv.includes(`--${n}`);

type Orden = {
  externalId: string;
  orderNumber: string;
  email: string | null;
  status: 'approved' | 'refunded';
  amount: number;
  currency: string;
  purchasedAt: string;
  itemName: string;
  itemQty: number;
  na: Record<string, string>;
  country: string | null;
};

async function main(): Promise<void> {
  const file = arg('file');
  if (!file) {
    console.error('falta --file=orders_export_1.csv');
    process.exit(1);
  }
  const dryRun = tiene('dry-run');
  // El default NO es '*': se toma el dominio que ya usan las órdenes del webhook.
  // Asumir el comodín fue un error real — `product_map` guarda el dominio de la
  // tienda, así que `costsForShop('*')` no encontraba ningún costo y las 3859
  // órdenes importadas quedaron con costo 0 (el aviso de la pantalla lo delató).
  const shopDomain =
    arg('shop') ??
    (
      await q<{ d: string }>(
        `SELECT shop_domain AS d FROM orders WHERE shop_domain <> '*'
         GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`,
      )
    )[0]?.d ??
    '*';
  console.log(`Tienda: ${shopDomain}${arg('shop') ? '' : '  (deducida de las órdenes existentes)'}`);

  const filas = parseCsv(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const head = filas[0]!;
  const col = (n: string): number => head.indexOf(n);
  const iId = col('Id');
  if (iId === -1) {
    console.error('el CSV no tiene columna "Id": ¿es el export de órdenes de Shopify?');
    process.exit(1);
  }
  const idx = {
    id: iId,
    name: col('Name'),
    email: col('Email'),
    fin: col('Financial Status'),
    paid: col('Paid at'),
    created: col('Created at'),
    cancelled: col('Cancelled at'),
    currency: col('Currency'),
    total: col('Total'),
    na: col('Note Attributes'),
    item: col('Lineitem name'),
    qty: col('Lineitem quantity'),
    country: col('Billing Country'),
  };

  const ordenes: Orden[] = [];
  const saltadas: Record<string, number> = {};

  for (let i = 1; i < filas.length; i++) {
    const f = filas[i]!;
    const id = (f[idx.id] ?? '').trim();
    if (!id) continue;

    const fin = (f[idx.fin] ?? '').trim().toLowerCase();
    const cancelada = (f[idx.cancelled] ?? '').trim() !== '';

    let status: 'approved' | 'refunded';
    if (fin === 'paid') status = cancelada ? 'refunded' : 'approved';
    else if (fin === 'refunded') status = 'refunded';
    else {
      // expired / pending: el pago nunca se completó, no es una venta.
      saltadas[fin || '(vacío)'] = (saltadas[fin || '(vacío)'] ?? 0) + 1;
      continue;
    }

    const total = Number((f[idx.total] ?? '0').replace(',', '.'));
    ordenes.push({
      externalId: `shopify_${id}`,
      orderNumber: (f[idx.name] ?? '').trim(),
      email: (f[idx.email] ?? '').trim().toLowerCase() || null,
      status,
      amount: Number.isFinite(total) ? total : 0,
      currency: (f[idx.currency] ?? 'ARS').trim() || 'ARS',
      purchasedAt: (f[idx.paid] ?? '').trim() || (f[idx.created] ?? '').trim(),
      itemName: (f[idx.item] ?? '').trim(),
      itemQty: Number(f[idx.qty] ?? '1') || 1,
      na: parseNoteAttributes(f[idx.na] ?? ''),
      country: (f[idx.country] ?? '').trim() || null,
    });
  }

  // ── Catálogos para resolver producto, funnel, comisiones y costos ──
  const funnels = await listFunnels({ includeInactive: true });
  const porSlug = new Map(funnels.map((f) => [f.slug, f]));
  const mapa = await q<{ productId: string; label: string | null; tier: string; funnelId: number }>(
    `SELECT product_id AS "productId", label, tier, funnel_id AS "funnelId" FROM product_map`,
  );
  // Nombre del ítem → producto mapeado. El CSV no trae product_id y el SKU está
  // vacío, así que el nombre es el único puente disponible.
  const porNombre = new Map(mapa.filter((m) => m.label).map((m) => [m.label!.trim(), m]));
  const costos = await costsForShop(shopDomain);
  const reglasPorFunnel = new Map<number | null, CommissionRule[]>();
  const reglasDe = async (fid: number | null): Promise<CommissionRule[]> => {
    const y = reglasPorFunnel.get(fid);
    if (y) return y;
    const r = await rulesForFunnel(fid);
    reglasPorFunnel.set(fid, r);
    return r;
  };

  const yaEstan = new Set(
    (await q<{ externalId: string }>(`SELECT external_id AS "externalId" FROM orders WHERE source = 'shopify'`)).map(
      (r) => r.externalId,
    ),
  );

  const nombresSinMapear = new Map<string, number>();
  let nuevas = 0;
  let duplicadas = 0;
  let sinFunnel = 0;
  let sinTier = 0;
  let sinFx = 0;
  let conSid = 0;
  let brutoImportado = 0;

  type Insert = {
    o: Orden;
    funnelId: number | null;
    productId: string | null;
    tier: string;
    day: string;
    amountEur: number | null;
    fxRate: number | null;
    fxStale: boolean;
    comAmount: number;
    comEur: number | null;
    comBreakdown: string;
    costAmount: number;
    costEur: number | null;
    costBreakdown: string;
  };
  const aInsertar: Insert[] = [];

  for (const o of ordenes) {
    if (yaEstan.has(o.externalId)) {
      duplicadas++;
      continue;
    }

    // Funnel: el cart attribute manda; si no está, el producto; si tampoco, NULL.
    const m = porNombre.get(o.itemName);
    if (!m && o.itemName) nombresSinMapear.set(o.itemName, (nombresSinMapear.get(o.itemName) ?? 0) + 1);
    const porAttr = o.na.funnel ? porSlug.get(o.na.funnel)?.id ?? null : null;
    const funnelId = porAttr ?? m?.funnelId ?? null;
    const tier = m?.tier ?? 'unknown';
    if (funnelId === null) sinFunnel++;
    if (tier === 'unknown') sinTier++;
    if (o.na.sid) conSid++;

    const tz =
      (funnelId !== null ? funnels.find((f) => f.id === funnelId)?.timezone : undefined) ??
      process.env.DASHBOARD_TZ ??
      'America/Argentina/Buenos_Aires';
    const dayRow = await q<{ day: string }>(
      'SELECT ($1::timestamptz AT TIME ZONE $2)::date::text AS day',
      [o.purchasedAt, tz],
    );
    const day = dayRow[0]!.day;

    const fx = await toReportCurrency(o.amount, o.currency, day);
    if (!fx || fx.stale) sinFx++;

    const com = applyCommissions({
      amount: o.amount,
      currency: o.currency,
      rules: await reglasDe(funnelId),
      fxRate: fx?.rate ?? null,
    });
    const cost = applyCosts({
      items: [{ productId: m?.productId ?? null, title: o.itemName, quantity: o.itemQty }],
      currency: o.currency,
      shopDomain,
      costs: costos,
      fxRate: fx?.rate ?? null,
    });

    if (o.status === 'approved') brutoImportado += o.amount;
    nuevas++;
    aInsertar.push({
      o,
      funnelId,
      productId: m?.productId ?? null,
      tier,
      day,
      amountEur: fx?.amountEur ?? null,
      fxRate: fx?.rate ?? null,
      fxStale: fx ? fx.stale : true,
      comAmount: com.amount,
      comEur: com.amountEur,
      comBreakdown: JSON.stringify(com.breakdown),
      costAmount: cost.amount,
      costEur: cost.amountEur,
      costBreakdown: JSON.stringify(cost.breakdown),
    });
  }

  // ── Informe ──
  console.log(`Archivo: ${file}`);
  console.log(`  órdenes en el CSV:        ${ordenes.length + Object.values(saltadas).reduce((a, b) => a + b, 0)}`);
  for (const [k, v] of Object.entries(saltadas)) {
    console.log(`    salteadas '${k}':        ${v}  (el pago nunca se completó)`);
  }
  console.log(`  ya estaban en la base:   ${duplicadas}`);
  console.log(`  a importar:              ${nuevas}`);
  console.log(`  bruto de las aprobadas:  ${brutoImportado.toFixed(2)}`);
  console.log(`  sin funnel resuelto:     ${sinFunnel}`);
  console.log(`  con tier 'unknown':      ${sinTier}`);
  console.log(`  sin cotización del día:  ${sinFx}  → quedan sin monto en euros`);
  console.log(`  con sid (atan a sesión): ${conSid}`);
  if (nombresSinMapear.size > 0) {
    console.log('\n  Nombres de producto sin mapear (entran con tier unknown):');
    // Array.from y no for..of sobre el Map: el tsconfig de T01 no habilita
    // downlevelIteration.
    for (const [n, c] of Array.from(nombresSinMapear.entries())) {
      console.log(`    ${String(c).padStart(5)}  ${n}`);
    }
    console.log('    → mapealos en /config → Productos y corré commissions:backfill');
  }

  if (dryRun || aInsertar.length === 0) {
    console.log(dryRun ? '\n[dry-run] no se escribió nada.' : '\nNada nuevo para importar.');
    return;
  }

  // ── Insert en lotes ──
  const LOTE = 500;
  let escritas = 0;
  for (let i = 0; i < aInsertar.length; i += LOTE) {
    const lote = aInsertar.slice(i, i + LOTE);
    await tx(async (c) => {
      for (const x of lote) {
        const utms = x.o.na;
        const res = await c.query<{ id: string }>(
          `INSERT INTO orders (funnel_id, source, shop_domain, external_id, order_number, email, status, tier,
                               amount, currency, amount_eur, fx_rate, fx_day, fx_stale,
                               commission_amount, commission_amount_eur, commission_breakdown,
                               cost_amount, cost_amount_eur, cost_breakdown,
                               session_id, visitor_id,
                               utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid,
                               country, purchased_at, day, raw)
           VALUES ($1::smallint, 'shopify', $2, $3, $4, $5, $6, $7,
                   $8::numeric, $9, $10::numeric, $11::numeric, $12::date, $13,
                   $14::numeric, $15::numeric, $16::jsonb,
                   $17::numeric, $18::numeric, $19::jsonb,
                   $20::uuid, $21::uuid,
                   $22, $23, $24, $25, $26, $27,
                   $28, $29::timestamptz, $30::date, $31::jsonb)
           ON CONFLICT (source, external_id) DO NOTHING
           RETURNING id`,
          [
            x.funnelId, shopDomain, x.o.externalId, x.o.orderNumber, x.o.email, x.o.status, x.tier,
            x.o.amount, x.o.currency, x.amountEur, x.fxRate, x.fxRate === null ? null : x.day, x.fxStale,
            x.comAmount, x.comEur, x.comBreakdown,
            x.costAmount, x.costEur, x.costBreakdown,
            // Solo uuid válidos: un sid basura rompería el cast y abortaría el lote.
            /^[0-9a-f-]{36}$/i.test(utms.sid ?? '') ? utms.sid : null,
            /^[0-9a-f-]{36}$/i.test(utms.vid ?? '') ? utms.vid : null,
            limpiarUtm(utms.utm_source), limpiarUtm(utms.utm_medium), limpiarUtm(utms.utm_campaign),
            limpiarUtm(utms.utm_content), limpiarUtm(utms.utm_term), utms.fbclid ?? null,
            x.o.country, x.o.purchasedAt, x.day,
            JSON.stringify({ importedFrom: 'shopify_csv', noteAttributes: utms }),
          ],
        );
        const id = res.rows[0]?.id;
        if (!id) continue;
        escritas++;
        // El ítem, para que el costo tenga desglose y la vista de productos sin
        // mapear funcione igual que con las órdenes del webhook.
        await c.query(
          `INSERT INTO order_items (order_id, shopify_product_id, title, quantity, amount, tier)
           VALUES ($1::bigint, $2, $3, $4::int, $5::numeric, $6)`,
          [id, x.productId, x.o.itemName, x.o.itemQty, x.o.amount, x.tier],
        );
        // Si la venta trae sid, se marca la sesión como compradora: es lo que
        // hace que el embudo cuente esa compra en su paso final.
        if (/^[0-9a-f-]{36}$/i.test(utms.sid ?? '') && x.funnelId !== null) {
          await c.query(
            `UPDATE sessions SET purchased_at = LEAST(purchased_at, $2::timestamptz)
             WHERE id = $1::uuid AND funnel_id = $3::smallint`,
            [utms.sid, x.o.purchasedAt, x.funnelId],
          );
        }
      }
    });
    console.log(`  … ${Math.min(i + LOTE, aInsertar.length)}/${aInsertar.length}`);
  }

  console.log(`\n${escritas} órdenes importadas.`);
  console.log('Corré el rollup para que el Resumen las tome:');
  console.log('  npm run rollup -- --all');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
