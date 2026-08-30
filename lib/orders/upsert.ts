import { tx, q1 } from '../db';
import { getFunnelById } from '../funnels';
import { toReportCurrency } from '../fx';
import { applyCommissions, rulesForFunnel } from '../commissions';
import { applyCosts, costsForShop } from '../costs';
import type { Tier } from '../types';
import { buyerEmail, resolveAttribution } from './attribution';
import { resolveFunnel, resolveTier } from './resolve';
import type { ShopifyOrder } from './types';

/**
 * Inserción/actualización de una orden de Shopify (plan §5, task T04 §5).
 *
 * Los ESCRIBOS van todos en una sola transacción: order + order_items + link
 * a la sesión. Si algo falla a mitad de camino, no queda una orden sin ítems
 * ni una sesión marcada sin orden. Las LECTURAS (resolución de funnel y de
 * tier, día local, cotización, herencia de UTMs) corren antes, sobre el pool:
 * los helpers congelados (resolveFunnel, resolveTier, toEur) no reciben un
 * client de transacción, y una lectura no tiene por qué estar dentro del
 * commit.
 */

export type UpsertResult = {
  orderId: number | null; // null solo cuando es un reenvío (duplicate)
  isNew: boolean;
  funnelId: number | null;
  warnings: string[];
};

type Item = {
  productId: string | null;
  variantId: string | null;
  title: string | null;
  quantity: number;
  price: number;
  index: number;
};

function lineItems(order: ShopifyOrder): Item[] {
  return (order.line_items ?? []).map((li, i) => ({
    productId: li.product_id != null ? String(li.product_id) : null,
    variantId: li.variant_id != null ? String(li.variant_id) : null,
    title: li.title || li.name || null,
    quantity: Number(li.quantity) || 1,
    price: Number.parseFloat(li.price ?? '0') || 0,
    index: i,
  }));
}

/**
 * Principal (D11 / plan §3.5): el tier del ítem de mayor amount; empate → el
 * de mayor cantidad; si sigue empatado, el primero del line_items.
 */
function principalTier(items: Item[], tiers: Tier[]): Tier {
  let best: Item | null = null;
  let principal: Tier = 'unknown';
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const better =
      best === null ||
      it.price > best.price ||
      (it.price === best.price && it.quantity > best.quantity);
    if (better) {
      best = it;
      principal = tiers[i];
    }
  }
  return principal;
}

export async function upsertOrder(
  order: ShopifyOrder,
  shopDomain: string,
  raw: unknown,
): Promise<UpsertResult> {
  if (order.id == null) {
    throw new Error('external_id: la orden no trae id');
  }
  const externalId = `shopify_${order.id}`;
  const orderNumber = order.order_number != null ? String(order.order_number) : order.name ?? null;
  const email = buyerEmail(order) || null;
  const amount = Number.parseFloat(order.total_price ?? order.current_total_price ?? '0') || 0;
  const currency = order.currency ?? 'ARS';
  const purchasedAt = order.processed_at || order.created_at || new Date().toISOString();
  const country =
    order.billing_address?.country_code ?? order.shipping_address?.country_code ?? null;

  const items = lineItems(order);

  // Los productIds se resuelven ordenados por amount desc (con empate por
  // quantity y orden original): resolveFunnel se queda con el primer match,
  // que es el del ítem más caro (D10 paso 2).
  const productIds = items
    .filter((it) => it.productId !== null)
    .sort((a, b) => b.price - a.price || b.quantity - a.quantity || a.index - b.index)
    .map((it) => it.productId!);

  const tiers = await Promise.all(items.map((it) => resolveTier(shopDomain, it.productId)));

  // Atribución completa (note_attributes → landing_site → fbclid → herencia
  // por email). La herencia pega contra orders, así que no puede estar dentro
  // del tx de escritura de esta misma orden.
  const att = await resolveAttribution(order);

  // D10: nunca se descarta una venta; el cajón "sin atribuir" es un resultado
  // válido, no un error.
  const funnel = await resolveFunnel({
    attrFunnel: att.funnel ?? undefined,
    shopDomain,
    productIds,
  });

  // El día es una resolución de zona horaria: en SQL, no en JS (lib/day.ts
  // explica por qué la aritmética de TZ en JS corre un día en horario de
  // verano). Sin funnel (D10 paso 4) se usa la TZ del dashboard.
  // Una sola lectura del funnel para las dos cosas que necesita esta función: la
  // zona horaria (para el día) y la comisión vigente (para congelarla).
  const funnelCfg = funnel.funnelId ? await getFunnelById(funnel.funnelId) : null;
  const timezone =
    funnelCfg?.timezone ?? process.env.DASHBOARD_TZ ?? 'America/Argentina/Buenos_Aires';
  const dayRow = await q1<{ day: string }>(
    'SELECT ($1::timestamptz AT TIME ZONE $2)::date::text AS day',
    [purchasedAt, timezone],
  );
  const day = dayRow!.day;

  // Conversión a EUR congelada en la fila (D12/D13). Sin cotización no se
  // falla la venta: amount_eur NULL + fx_stale, y backfill-fx (T03) completa.
  const fx = await toReportCurrency(amount, currency, day);

  const principal = principalTier(items, tiers);

  // Comisión de la pasarela, congelada igual que la cotización: se lee el
  // porcentaje vigente del funnel y se copia a la fila junto con el monto
  // resultante. Ver lib/orders/commission.ts y la migración 011.
  //
  // Se convierte a euros con la cotización de ESTA orden (fx.rate), no con la de
  // hoy: si se usara otra, la comisión en euros no cerraría contra su bruto.
  const comision = applyCommissions({
    amount,
    currency,
    rules: await rulesForFunnel(funnel.funnelId),
    fxRate: fx?.rate ?? null,
  });

  // Costo por producto, por ítem y por cantidad (migración 013). Se congela con
  // el mismo criterio que la comisión: cambiar el costo mañana no reescribe una
  // venta de la semana pasada.
  const costo = applyCosts({
    items: items.map((it) => ({ productId: it.productId, title: it.title, quantity: it.quantity })),
    currency,
    shopDomain,
    costs: await costsForShop(shopDomain),
    fxRate: fx?.rate ?? null,
  });

  const { orderId, isNew } = await tx(async (c) => {
    const ins = await c.query(
      `INSERT INTO orders (funnel_id, source, shop_domain, external_id, order_number, email, tier,
                           amount, currency, amount_eur, fx_rate, fx_day, fx_stale,
                           commission_amount, commission_amount_eur, commission_breakdown,
                           cost_amount, cost_amount_eur, cost_breakdown,
                           session_id, visitor_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid,
                           country, purchased_at, day, raw)
       VALUES ($1::smallint, 'shopify', $2, $3, $4, $5, $6, $7::numeric, $8,
               $9::numeric, $10::numeric, $11::date, $12,
               $25::numeric, $26::numeric, $27::jsonb,
               $28::numeric, $29::numeric, $30::jsonb,
               $13::uuid, $14::uuid, $15, $16, $17, $18, $19, $20, $21,
               $22::timestamptz, $23::date, $24::jsonb)
       ON CONFLICT (source, external_id) DO NOTHING
       RETURNING id`,
      [
        funnel.funnelId,
        shopDomain,
        externalId,
        orderNumber,
        email,
        principal,
        amount,
        currency,
        fx?.amountEur ?? null,
        fx?.rate ?? null,
        fx?.fxDay ?? null,
        fx ? fx.stale : true,
        att.sid,
        att.vid,
        att.utms.utm_source,
        att.utms.utm_medium,
        att.utms.utm_campaign,
        att.utms.utm_content,
        att.utms.utm_term,
        att.fbclid,
        country,
        purchasedAt,
        day,
        JSON.stringify(raw),
        comision.amount,
        comision.amountEur,
        JSON.stringify(comision.breakdown),
        costo.amount,
        costo.amountEur,
        JSON.stringify(costo.breakdown),
      ],
    );

    if (ins.rowCount === 0) {
      // Reenvío (Shopify manda orders/create y orders/paid de la misma compra,
      // y reintenta lo que falle): UNIQUE (source, external_id) deduplica y acá
      // no se toca NADA de la fila existente. El caller registra 'duplicate'.
      return { orderId: null as number | null, isNew: false as const };
    }
    const orderId = ins.rows[0].id as number;

    if (items.length > 0) {
      // Un solo INSERT multi-row: los ítems son del mismo orden y comparten
      // transacción con ella (no pueden quedar items de una orden que falló).
      const rows: string[] = [];
      const params: unknown[] = [orderId];
      let p = 1;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        rows.push(
          `($1, $${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}::int, $${p + 5}::numeric, $${p + 6})`,
        );
        params.push(
          it.productId,
          it.variantId,
          it.title,
          it.quantity,
          it.price || null,
          tiers[i],
        );
        p += 6;
      }
      await c.query(
        `INSERT INTO order_items (order_id, shopify_product_id, shopify_variant_id, title,
                                  quantity, amount, tier)
         VALUES ${rows.join(', ')}`,
        params,
      );
    }

    if (att.sid) {
      await c.query(
        'UPDATE orders SET session_id = $1, visitor_id = $2 WHERE id = $3',
        [att.sid, att.vid, orderId],
      );
      // El AND funnel_id no es decorativo: sin él, un sid cruzado marcaría
      // como compradora la sesión de otro funnel (plan §5). Si el UPDATE no
      // afecta filas (sesión purgada por retención, o compra desde otro
      // dispositivo), no es un error: la orden queda con session_id guardado.
      await c.query(
        'UPDATE sessions SET purchased_at = LEAST(purchased_at, $2::timestamptz) WHERE id = $1 AND funnel_id = $3',
        [att.sid, purchasedAt, funnel.funnelId],
      );
    }

    return { orderId, isNew: true as const };
  });

  return { orderId, isNew, funnelId: funnel.funnelId, warnings: funnel.warnings };
}
