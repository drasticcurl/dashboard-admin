import { tx, q1 } from '../db';
import { getFunnelById } from '../funnels';
import { toReportCurrency } from '../fx';
import { applyCommissions, rulesForFunnel } from '../commissions';
import { applyCosts, costsForShop } from '../costs';
import { cleanUtmValue, DIRECT_LABEL } from '../ingest/schema';
import { resolveFunnel, resolveTier } from './resolve';
import type { PayloadVentaCheckoutPropio } from './checkout-propio-tipos';

/**
 * Inserción de una venta de checkout-kashhhpay en `orders` (T02, plan
 * panel-y-capi §4).
 *
 * Es el equivalente de upsertOrder() (lib/orders/upsert.ts) para esta
 * fuente, pero MÁS SIMPLE en un punto clave: esta venta nunca tiene
 * line_items. Es un solo cobro por un solo producto (whopPlanId) — no hay
 * order_items que insertar ni "ítem principal" que elegir por precio. Copiar
 * la lógica de múltiples ítems de Shopify acá sería inventar un caso que no
 * existe (YAGNI, D0 del plan).
 *
 * Todo lo demás (centinela de UTMs, día por TZ vía SQL, conversión a EUR
 * congelada, comisiones/costos) es el MISMO patrón que Shopify: dos fuentes
 * de orders.* con reglas de negocio distintas en cómo llega el dato, pero
 * con la misma forma de fila al final, porque son las queries de reportes
 * las que leen esa fila y no les importa de dónde vino.
 */

export type UpsertResultCheckoutPropio = {
  orderId: number | null; // null solo cuando es un reenvío (duplicate)
  isNew: boolean;
  funnelId: number | null;
};

/**
 * `shop_domain` de la fila de `product_map` que atribuye estas ventas
 * (D2 del plan). OJO — no confundir con `orders.shop_domain`: son dos
 * columnas de dos tablas distintas con el mismo nombre. La de `product_map`
 * es el "namespace" para resolver el funnel (D2); la de `orders` es un
 * centinela genérico ('*') que usan TODAS las fuentes no-Shopify, incluida
 * esta (regla 1 de la task).
 */
export const PRODUCT_MAP_SHOP_DOMAIN = 'checkout_propio' as const;

/** Prefijo de external_id por fuente, igual que Shopify usa 'shopify_'. */
const EXTERNAL_ID_PREFIX = 'checkout_propio_';

export async function upsertOrderCheckoutPropio(
  payload: PayloadVentaCheckoutPropio,
): Promise<UpsertResultCheckoutPropio> {
  const externalId = `${EXTERNAL_ID_PREFIX}${payload.cobroId}`;
  // orders.shop_domain SIEMPRE es '*' para esta fuente: no hay múltiples
  // "tiendas" checkout-kashhhpay, así que no hace falta el domain real acá.
  // El domain que sí importa (D2) es el de product_map, ver PRODUCT_MAP_SHOP_DOMAIN.
  const shopDomainOrders = '*';

  // Las 5 UTMs se normalizan al centinela '(directo)' con la MISMA función
  // que usa el ingest (cleanUtmValue de lib/ingest/schema.ts): si esta fuente
  // normalizara distinto, una campaña llegada por checkout-propio y la misma
  // campaña llegada por el embudo de tracking no matchearían en ningún
  // GROUP BY utm_campaign que las cruce.
  const utms = {
    utm_source: cleanUtmValue(payload.utms.utm_source) || DIRECT_LABEL,
    utm_medium: cleanUtmValue(payload.utms.utm_medium) || DIRECT_LABEL,
    utm_campaign: cleanUtmValue(payload.utms.utm_campaign) || DIRECT_LABEL,
    utm_content: cleanUtmValue(payload.utms.utm_content) || DIRECT_LABEL,
    utm_term: cleanUtmValue(payload.utms.utm_term) || DIRECT_LABEL,
  };
  // fbclid vacío → NULL, nunca ''. Es un token opaco (no una dimensión de
  // reporte): un '' rompería cualquier WHERE fbclid IS NOT NULL que asuma
  // que "vino algo" ≠ cadena vacía (misma regla que lib/ingest/schema.ts).
  const fbclid = cleanUtmValue(payload.fbclid) || null;

  // MAYÚSCULA. Guardaba `.toLowerCase()` y eso dejó las dos ventas LATAM del
  // 2026-09-14 con `currency = 'usd'`, que no matchea con nada:
  // `funnels.sell_currency` es 'USD', y tanto AD_SPEND_SQL (lib/queries/sales.ts)
  // como el rollup unen `fx_rates.base = f.sell_currency`. La venta se convertía
  // solo porque alguien cargó a mano una fila `base='usd'`; el gasto de la misma
  // campaña, que se lee por `sell_currency`, seguía dando 0.
  const currency = payload.moneda.toUpperCase();
  const amount = Number.parseFloat(payload.monto) || 0;

  // D2: resolveFunnel() SIN attrFunnel — esta venta no tiene cart attribute,
  // el único canal de atribución es product_map por (shop_domain, product_id).
  // Se usa tal cual, sin modificarlo (regla no negociable de la task).
  const funnel = await resolveFunnel({
    shopDomain: PRODUCT_MAP_SHOP_DOMAIN,
    productIds: [payload.whopPlanId],
  });

  // Mismo patrón que upsert.ts: una sola lectura del funnel resuelto para la
  // TZ (día local) y para las reglas de comisión vigentes.
  const funnelCfg = funnel.funnelId ? await getFunnelById(funnel.funnelId) : null;
  const timezone =
    funnelCfg?.timezone ?? process.env.DASHBOARD_TZ ?? 'America/Argentina/Buenos_Aires';
  // El día se calcula en SQL, no en JS: la aritmética de zona horaria en JS
  // corre un día en horario de verano (mismo comentario que upsert.ts). Sin
  // funnel resuelto (D10 paso 4) se usa la TZ del dashboard, no UTC crudo.
  const dayRow = await q1<{ day: string }>(
    'SELECT ($1::timestamptz AT TIME ZONE $2)::date::text AS day',
    [payload.purchasedAt, timezone],
  );
  const day = dayRow!.day;

  // Conversión a EUR congelada en la fila. Sin cotización no se rechaza la
  // venta: amount_eur queda NULL + fx_stale, igual que Shopify (D12/D13).
  const fx = await toReportCurrency(amount, currency, day);

  // Tier: resolveTier() tolera cualquier string como product_id (no exige
  // formato de Shopify) — se usa el whopPlanId directo, como indica la
  // regla 7 de la task. Sin fila en product_map → 'unknown', igual que Shopify.
  const tier = await resolveTier(PRODUCT_MAP_SHOP_DOMAIN, payload.whopPlanId);

  // Comisión y costo se congelan sobre el monto TOTAL: no hay order_items que
  // desglosar (regla 9 de la task), pero SÍ se aplican si el funnel resuelto
  // tiene reglas — mismo criterio que Shopify, solo que sobre un ítem único.
  const comision = applyCommissions({
    amount,
    currency,
    rules: await rulesForFunnel(funnel.funnelId),
    fxRate: fx?.rate ?? null,
  });
  const costo = applyCosts({
    items: [{ productId: payload.whopPlanId, title: null, quantity: 1 }],
    currency,
    shopDomain: PRODUCT_MAP_SHOP_DOMAIN,
    costs: await costsForShop(PRODUCT_MAP_SHOP_DOMAIN),
    fxRate: fx?.rate ?? null,
  });

  // sessionId/visitorId son opcionales en el contrato A (a diferencia de
  // /api/ingest): una venta real no puede desaparecer del dashboard de
  // facturación solo porque el tracking de embudo no la pudo atar a una
  // sesión (criterio de aceptación 5 del plan). Se guardan si vinieron, sin
  // exigirlos.
  const sessionId = payload.sessionId ?? null;
  const visitorId = payload.visitorId ?? null;

  const { orderId, isNew } = await tx(async (c) => {
    const ins = await c.query(
      `INSERT INTO orders (funnel_id, source, shop_domain, external_id, email, tier,
                           amount, currency, amount_eur, fx_rate, fx_day, fx_stale,
                           commission_amount, commission_amount_eur, commission_breakdown,
                           cost_amount, cost_amount_eur, cost_breakdown,
                           session_id, visitor_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid,
                           purchased_at, day, raw)
       VALUES ($1::smallint, 'checkout_propio', $2, $3, $4, $5,
               $6::numeric, $7, $8::numeric, $9::numeric, $10::date, $11,
               $20::numeric, $21::numeric, $22::jsonb,
               $23::numeric, $24::numeric, $25::jsonb,
               $12::uuid, $13::uuid, $14, $15, $16, $17, $18, $19,
               $26::timestamptz, $27::date, $28::jsonb)
       ON CONFLICT (source, external_id) DO NOTHING
       RETURNING id`,
      [
        funnel.funnelId,
        shopDomainOrders,
        externalId,
        payload.email,
        tier,
        amount,
        currency,
        fx?.amountEur ?? null,
        fx?.rate ?? null,
        fx?.fxDay ?? null,
        fx ? fx.stale : true,
        sessionId,
        visitorId,
        utms.utm_source,
        utms.utm_medium,
        utms.utm_campaign,
        utms.utm_content,
        utms.utm_term,
        fbclid,
        comision.amount,
        comision.amountEur,
        JSON.stringify(comision.breakdown),
        costo.amount,
        costo.amountEur,
        JSON.stringify(costo.breakdown),
        payload.purchasedAt,
        day,
        JSON.stringify(payload),
      ],
    );

    if (ins.rowCount === 0) {
      // El cron de salidas reintenta con backoff exponencial (D3 del plan):
      // sin este UNIQUE(source, external_id), un reintento después de un
      // timeout de red (donde el INSERT sí se completó pero la respuesta se
      // perdió) duplicaría la venta. El caller registra 'duplicate'.
      return { orderId: null as number | null, isNew: false as const };
    }
    const orderId = ins.rows[0].id as number;

    // Mismo patrón que lib/orders/upsert.ts (Shopify): sin este UPDATE la
    // venta queda bien guardada en `orders` (con session_id correcto) pero
    // el embudo nunca la cuenta, porque "Compraron" lee
    // sessions.purchased_at, no orders. Bug real encontrado en producción
    // (2026-09-20): 6 ventas de Alma Gemela con sessionId válido y existente
    // no aparecían en "Compraron" porque este UPDATE no existía en el flujo
    // de checkout-propio (solo estaba en el de Shopify).
    // `LEAST` no pisa una fecha anterior si la sesión ya tenía purchased_at
    // (p.ej. un segundo ítem de la misma sesión). El AND funnel_id evita que
    // un sessionId cruzado marque como compradora la sesión de otro funnel.
    if (sessionId) {
      await c.query(
        'UPDATE sessions SET purchased_at = LEAST(purchased_at, $2::timestamptz) WHERE id = $1 AND funnel_id = $3',
        [sessionId, payload.purchasedAt, funnel.funnelId],
      );
    }

    return { orderId, isNew: true as const };
  });

  return { orderId, isNew, funnelId: funnel.funnelId };
}
