/**
 * Ventas por funnel (task T07).
 *
 * Bruto, devuelto y neto son tres números distintos y los tres se muestran:
 * el panel viejo contaba las devoluciones como ventas y nunca las restaba,
 * y eso es exactamente lo que esta pantalla arregla.
 *
 *   - bruto   = suma de amount de las órdenes con status = 'approved'
 *   - devuelto = suma de amount de las que NO están aprobadas
 *   - neto    = bruto − devuelto
 *
 * Una orden devuelta SIGUE contando en ordersRefunded y no se borra de la
 * base (D10): el webhook solo la marca. Los totales salen de UN SELECT con
 * FILTER por status (el SQL canónico del task T07 §2); los breakdowns
 * (tier, campaña, fuente, día) usan el mismo WHERE con un filtro de status
 * opcional. La suma con FILTER es la forma de no escanear la tabla una vez
 * por status.
 *
 * El día de una orden es `orders.day`, ya resuelto en la TZ del funnel al
 * ingresarla (T04). Nunca se recalcula acá: `purchased_at::date` en otra TZ
 * mueve las ventas de la medianoche de día y el total del mes no cierra
 * contra el de la semana (T07 §2).
 *
 * `amount` y `amount_eur` son numeric y el driver los devuelve como string;
 * acá se convierten con Number() una sola vez, en el mapeo de cada query.
 */

import { q, q1 } from '@/lib/db';
import { MONEDA_REPORTE } from '@/lib/moneda-reporte';

/** El valor especial de `?f=` para el cajón de ventas sin funnel (T07 §3). */
export const UNATTRIBUTED_FUNNEL = '__unattributed__';

export type SalesStatus = 'approved' | 'refunded' | 'chargeback' | 'all';

export type SalesFilters = {
  funnelId: number | null; // null = cajón "sin atribuir" (NUNCA "todos")
  from: string; // 'YYYY-MM-DD'
  to: string;
  tier?: string;
  utmCampaign?: string;
  utmSource?: string;
  status?: SalesStatus; // default: 'all'
};

export type SalesTotals = {
  ordersApproved: number;
  ordersRefunded: number;
  ordersChargeback: number;
  grossEur: number;
  refundedEur: number;
  netEur: number;
  grossOrig: number;
  refundedOrig: number;
  /** Comisiones de la pasarela, solo de las aprobadas (migración 011). */
  commissionsOrig: number;
  commissionsEur: number;
  /** Costo de los productos vendidos, solo de las aprobadas (migración 013). */
  costsOrig: number;
  costsEur: number;
  /** Aprobadas con costo en 0: el producto no tiene costo cargado. */
  ordersSinCosto: number;
  /**
   * Gasto de publicidad del rango (migración 014). NO sale de las órdenes: es un
   * costo por día que existe aunque no haya ventas, así que no se puede congelar
   * en una venta ni repartir entre ellas sin inventar un criterio.
   */
  adSpendOrig: number;
  adSpendEur: number;
  /** Neto − ads. Es la plata que queda de verdad. */
  resultOrig: number;
  resultEur: number;
  /** Bruto ÷ ads, en la moneda del funnel. 0 si no hay gasto cargado. */
  roas: number;
  /** El mismo ROAS calculado en euros: la tarjeta elige con el toggle EUR/ARS. */
  roasEur: number;
  /** Ads ÷ órdenes aprobadas, en la moneda del funnel. 0 si no hay gasto. */
  cpa: number;
  /** El mismo CPA en euros: la tarjeta lo cambia con el toggle EUR/ARS. */
  cpaEur: number;
  /** Comisiones + costos de producto + publicidad: todo lo que se puso. */
  spendTotalOrig: number;
  spendTotalEur: number;
  /**
   * Resultado ÷ gasto total, en tanto por uno (0,035 = 3,5%). Puede ser
   * negativo. NO es el neto sobre el gasto: el neto ya tiene las comisiones y
   * los costos descontados y dividirlo por ellos los contaría dos veces.
   */
  roi: number;
  roiEur: number;
  /** Órdenes aprobadas con comisión en 0: la config del funnel está sin cargar. */
  ordersSinComision: number;
  netOrig: number;
  currency: string;
  avgTicketEur: number; // neto / órdenes aprobadas
  fxStaleCount: number; // órdenes con conversión provisoria o sin convertir
  unknownTierCount: number;
  // ── Métricas nuevas (T02 del rediseño) ─────────────────────────────────
  // Los campos de esta sección devuelven null cuando no hay denominador, no 0:
  // "no se puede calcular" y "vale cero" son cosas distintas. Los campos de
  // arriba (roas, cpa, roi, avgTicketEur) devuelven 0 por compatibilidad
  // con las vistas y los tests que ya existen — no unificar sin cambiar las
  // dos vistas a la vez.
  /**
   * Tanto por uno: 0,04 = 4 %. Devoluciones + chargebacks sobre las órdenes que
   * alguna vez fueron una venta. Las 'pending' quedan fuera de los dos lados:
   * no son ni una venta ni una devolución.
   */
  refundRate: number | null;
  /** Tanto por uno: 0,35 = 35 %. Neto ÷ bruto. Puede ser negativo, y así se devuelve. null con bruto 0 (posible con neto ≠ 0). */
  netMargin: number | null;
  /** Ticket promedio en la moneda del funnel: neto ÷ aprobadas. null sin aprobadas (el par de avgTicketEur, para el toggle EUR/ARS). */
  avgTicketOrig: number | null;
  /** Tanto por uno. Comisiones de la pasarela ÷ bruto. null con bruto 0. */
  commissionRate: number | null;
  /** Tanto por uno. Costo del producto ÷ bruto. null con bruto 0. */
  costRate: number | null;
};

export type TierRow = { tier: string; orders: number; netEur: number; netOrig: number };
export type CampaignRow = {
  campaign: string;
  orders: number;
  netEur: number;
  netOrig: number;
  /** Gasto de la campaña, unido por campaign_id (migración 014). */
  spendOrig: number;
  spendEur: number;
  /** Bruto de la campaña ÷ su gasto. 0 si no hay gasto. */
  roas: number;
};
export type SourceRow = { source: string; orders: number; netEur: number; netOrig: number };
export type DayRow = { day: string; orders: number; netEur: number; netOrig: number;
                       refundedEur: number; refundedOrig: number };

export type OrderRow = {
  id: number;
  orderNumber: string | null;
  email: string | null;
  status: string;
  tier: string;
  product: string | null; // título del ítem principal (el de mayor amount)
  amount: number;
  currency: string;
  amountEur: number | null;
  fxStale: boolean;
  utmSource: string;
  utmCampaign: string;
  purchasedAt: string; // ISO-8601
};

export type SalesData = {
  totals: SalesTotals;
  byTier: TierRow[];
  byCampaign: CampaignRow[];
  bySource: SourceRow[];
  byDay: DayRow[];
  recent: OrderRow[]; // últimas 50
  unattributed: { orders: number; netEur: number }; // funnel_id IS NULL, mismo rango
  generatedAt: string;
};

// ─── WHERE compartido ───────────────────────────────────────────────────────
//
// Un solo WHERE para todas las queries de ventas, con el patrón
// ($n::text IS NULL OR col = $n) que deja cubrir todas las combinaciones de
// filtro sin armar strings (misma técnica que T06 §2). Los valores SIEMPRE
// van como parámetros.
//
// La rama del funnel tiene DOS formas a propósito: para un funnel concreto
// `funnel_id = $n`, y para el cajón "sin atribuir" `funnel_id IS NULL`. El
// patrón ($1::smallint IS NULL OR funnel_id = $1) con $1 = NULL devolvería
// TODO, no las huérfanas — es el bug silencioso que el plan marca (T07 §2).
function baseWhere(f: SalesFilters, includeStatus: boolean): { where: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  let n = 1;
  const ph = (): string => `$${n++}`;
  const optional = (column: string, value: unknown): string => {
    params.push(value ?? null);
    const p = ph();
    return `(${p}::text IS NULL OR ${column} = ${p})`;
  };

  if (f.funnelId === null) {
    where.push('funnel_id IS NULL');
  } else {
    params.push(f.funnelId);
    where.push(`funnel_id = ${ph()}`);
  }

  params.push(f.from, f.to);
  where.push(`day BETWEEN ${ph()}::date AND ${ph()}::date`);
  where.push(optional('tier', f.tier));
  where.push(optional('utm_campaign', f.utmCampaign));
  where.push(optional('utm_source', f.utmSource));

  if (includeStatus) {
    params.push(f.status ?? 'all');
    const p = ph();
    where.push(`(${p}::text = 'all' OR status = ${p})`);
  }

  return { where: where.join(' AND '), params };
}

// Los totales NO llevan el filtro de status: la suma por status se resuelve
// con los FILTER del SELECT, y el bruto/devuelto/neto tienen que seguir
// siendo los tres números completos aunque la UI esté mirando una sola
// categoría. Los breakdowns y la lista sí lo llevan.
//
// El neto se resta en SQL y no en JS: numeric es decimal exacto, y restar
// 18.85 − 4.51 en el float de JS deja 14.340000000000002 en el JSON.
const TOTALS_SQL = `
  SELECT
    count(*) FILTER (WHERE status = 'approved')::int   AS "ordersApproved",
    count(*) FILTER (WHERE status = 'refunded')::int   AS "ordersRefunded",
    count(*) FILTER (WHERE status = 'chargeback')::int AS "ordersChargeback",
    COALESCE(sum(amount)     FILTER (WHERE status = 'approved'), 0)   AS "grossOrig",
    COALESCE(sum(amount_eur) FILTER (WHERE status = 'approved'), 0)   AS "grossEur",
    COALESCE(sum(amount)     FILTER (WHERE status <> 'approved'), 0)  AS "refundedOrig",
    COALESCE(sum(amount_eur) FILTER (WHERE status <> 'approved'), 0)  AS "refundedEur",
    COALESCE(sum(commission_amount)     FILTER (WHERE status = 'approved'), 0) AS "commissionsOrig",
    COALESCE(sum(commission_amount_eur) FILTER (WHERE status = 'approved'), 0) AS "commissionsEur",
    count(*) FILTER (WHERE status = 'approved' AND commission_amount = 0)::int  AS "ordersSinComision",
    COALESCE(sum(cost_amount)     FILTER (WHERE status = 'approved'), 0) AS "costsOrig",
    COALESCE(sum(cost_amount_eur) FILTER (WHERE status = 'approved'), 0) AS "costsEur",
    count(*) FILTER (WHERE status = 'approved' AND cost_amount = 0)::int        AS "ordersSinCosto",
    -- El neto descuenta las comisiones de las APROBADAS: en una devolución la
    -- pasarela reintegra el cargo, así que no es un costo real (migración 011).
    (COALESCE(sum(amount)     FILTER (WHERE status = 'approved'), 0)
   - COALESCE(sum(amount)     FILTER (WHERE status <> 'approved'), 0)
   - COALESCE(sum(commission_amount) FILTER (WHERE status = 'approved'), 0)
   - COALESCE(sum(cost_amount) FILTER (WHERE status = 'approved'), 0)) AS "netOrig",
    (COALESCE(sum(amount_eur) FILTER (WHERE status = 'approved'), 0)
   - COALESCE(sum(amount_eur) FILTER (WHERE status <> 'approved'), 0)
   - COALESCE(sum(commission_amount_eur) FILTER (WHERE status = 'approved'), 0)
   - COALESCE(sum(cost_amount_eur) FILTER (WHERE status = 'approved'), 0)) AS "netEur",
    count(*) FILTER (WHERE fx_stale OR amount_eur IS NULL)::int AS "fxStaleCount",
    count(*) FILTER (WHERE tier = 'unknown')::int       AS "unknownTierCount"
  FROM orders
  WHERE`;

// "devuelto" = todo lo que no está aprobado, tal como lo define el SQL
// canónico del task (T07 §2). El enum tiene un cuarto valor ('pending') que
// cae del mismo lado; si algún día los pending importan como categoría
// propia, es tema de §10, no de esta query.
const TIER_SQL = `
  SELECT tier,
         count(*)::int AS orders,
         (COALESCE(sum(amount)     FILTER (WHERE status = 'approved'), 0)
        - COALESCE(sum(amount)     FILTER (WHERE status <> 'approved'), 0)
        - COALESCE(sum(commission_amount) FILTER (WHERE status = 'approved'), 0)
        - COALESCE(sum(cost_amount) FILTER (WHERE status = 'approved'), 0)) AS "netOrig",
         (COALESCE(sum(amount_eur) FILTER (WHERE status = 'approved'), 0)
        - COALESCE(sum(amount_eur) FILTER (WHERE status <> 'approved'), 0)
        - COALESCE(sum(commission_amount_eur) FILTER (WHERE status = 'approved'), 0)
        - COALESCE(sum(cost_amount_eur) FILTER (WHERE status = 'approved'), 0)) AS "netEur"
  FROM orders
  WHERE`;

const CAMPAIGN_SQL = `
  SELECT utm_campaign AS campaign,
         count(*)::int AS orders,
         COALESCE(sum(amount) FILTER (WHERE status = 'approved'), 0) AS "grossOrig",
         (COALESCE(sum(amount)     FILTER (WHERE status = 'approved'), 0)
        - COALESCE(sum(amount)     FILTER (WHERE status <> 'approved'), 0)
        - COALESCE(sum(commission_amount) FILTER (WHERE status = 'approved'), 0)
        - COALESCE(sum(cost_amount) FILTER (WHERE status = 'approved'), 0)) AS "netOrig",
         (COALESCE(sum(amount_eur) FILTER (WHERE status = 'approved'), 0)
        - COALESCE(sum(amount_eur) FILTER (WHERE status <> 'approved'), 0)
        - COALESCE(sum(commission_amount_eur) FILTER (WHERE status = 'approved'), 0)
        - COALESCE(sum(cost_amount_eur) FILTER (WHERE status = 'approved'), 0)) AS "netEur"
  FROM orders
  WHERE`;

const SOURCE_SQL = `
  SELECT utm_source AS source,
         count(*)::int AS orders,
         (COALESCE(sum(amount)     FILTER (WHERE status = 'approved'), 0)
        - COALESCE(sum(amount)     FILTER (WHERE status <> 'approved'), 0)
        - COALESCE(sum(commission_amount) FILTER (WHERE status = 'approved'), 0)
        - COALESCE(sum(cost_amount) FILTER (WHERE status = 'approved'), 0)) AS "netOrig",
         (COALESCE(sum(amount_eur) FILTER (WHERE status = 'approved'), 0)
        - COALESCE(sum(amount_eur) FILTER (WHERE status <> 'approved'), 0)
        - COALESCE(sum(commission_amount_eur) FILTER (WHERE status = 'approved'), 0)
        - COALESCE(sum(cost_amount_eur) FILTER (WHERE status = 'approved'), 0)) AS "netEur"
  FROM orders
  WHERE`;

const DAY_SQL = `
  SELECT day::text AS day,
         count(*)::int AS orders,
         (COALESCE(sum(amount)     FILTER (WHERE status = 'approved'), 0)
        - COALESCE(sum(amount)     FILTER (WHERE status <> 'approved'), 0)
        - COALESCE(sum(commission_amount) FILTER (WHERE status = 'approved'), 0)
        - COALESCE(sum(cost_amount) FILTER (WHERE status = 'approved'), 0)) AS "netOrig",
         (COALESCE(sum(amount_eur) FILTER (WHERE status = 'approved'), 0)
        - COALESCE(sum(amount_eur) FILTER (WHERE status <> 'approved'), 0)
        - COALESCE(sum(commission_amount_eur) FILTER (WHERE status = 'approved'), 0)
        - COALESCE(sum(cost_amount_eur) FILTER (WHERE status = 'approved'), 0)) AS "netEur",
         COALESCE(sum(amount)     FILTER (WHERE status <> 'approved'), 0)  AS "refundedOrig",
         COALESCE(sum(amount_eur) FILTER (WHERE status <> 'approved'), 0)  AS "refundedEur"
  FROM orders
  WHERE`;

// El ítem "principal" de la orden es el de mayor amount (plan §3.5): es el
// que le da el tier a orders.tier, así que es el producto que la pantalla
// muestra. LATERAL evita un join que multiplicaría las filas de una orden
// con front + bump.
// El gasto NO se une a `orders`: es por día y por cuenta. Se consulta aparte y
// se suma al agregado (ver el comentario de la migración 014).
// OJO CON LA MONEDA: la cuenta publicitaria puede facturar en otra moneda que la
// del funnel (las de Meta acá están en EUR y los funnels venden en ARS). Sumar
// `spend` crudo y mostrarlo como pesos es comparar dos monedas distintas: el
// Resultado y el ROAS quedaban mal sin ninguna señal.
//
// Se convierte a la moneda del funnel dividiendo el importe en euros por la
// cotización de ese día (`fx_rates` guarda 1 unidad de base en euros). Si no hay
// cotización del día exacto se toma la más reciente anterior, igual que `toEur`.
// $5 es la moneda de reporte: entra como parámetro y no literal para que una
// instancia que consolida en dólares no compare contra filas de fx_rates que
// nadie escribe (el fetcher archiva el par ARS→moneda de reporte, ver
// lib/fx-fetch.ts:saveRate).
const AD_SPEND_SQL = `
  SELECT COALESCE(sum(
           CASE WHEN $4 = $5 THEN spend_eur
                ELSE spend_eur / NULLIF((
                       SELECT fr.rate FROM fx_rates fr
                       WHERE fr.base = $4 AND fr.quote = $5 AND fr.day <= ad_spend.day
                       ORDER BY fr.day DESC LIMIT 1), 0)
           END), 0) AS "adSpendOrig",
         COALESCE(sum(spend_eur), 0) AS "adSpendEur"
  FROM ad_spend
  WHERE day BETWEEN $2::date AND $3::date
    AND ($1::smallint IS NULL OR funnel_id = $1)`;

// Gasto por campaña, unido por el ID que los UTMs traen después del '|'
// (`{{campaign.name}}|{{campaign.id}}`). Unir por ID y no por nombre es lo que
// hace que un rename de campaña en Meta no parta la serie en dos.
const CAMPAIGN_SPEND_SQL = `
  SELECT campaign_id AS id,
         COALESCE(sum(
           CASE WHEN $4 = $5 THEN spend_eur
                ELSE spend_eur / NULLIF((
                       SELECT fr.rate FROM fx_rates fr
                       WHERE fr.base = $4 AND fr.quote = $5 AND fr.day <= ad_spend.day
                       ORDER BY fr.day DESC LIMIT 1), 0)
           END), 0) AS "spendOrig",
         COALESCE(sum(spend_eur), 0) AS "spendEur"
  FROM ad_spend
  WHERE day BETWEEN $2::date AND $3::date
    AND campaign_id <> ''
    AND ($1::smallint IS NULL OR funnel_id = $1)
  GROUP BY campaign_id`;

const RECENT_SQL = `
  SELECT o.id, o.order_number AS "orderNumber", o.email, o.status, o.tier,
         o.amount::text AS amount, o.currency,
         o.amount_eur::text AS "amountEur", o.fx_stale AS "fxStale",
         o.utm_source AS "utmSource", o.utm_campaign AS "utmCampaign",
         o.purchased_at AS "purchasedAt",
         oi.title AS product
  FROM orders o
  LEFT JOIN LATERAL (
    SELECT title FROM order_items
    WHERE order_id = o.id
    ORDER BY amount DESC NULLS LAST, id
    LIMIT 1
  ) oi ON true
  WHERE`;

const UNATTRIBUTED_SQL = `
  SELECT count(*)::int AS orders,
         (COALESCE(sum(amount_eur) FILTER (WHERE status = 'approved'), 0)
        - COALESCE(sum(amount_eur) FILTER (WHERE status <> 'approved'), 0)
        - COALESCE(sum(commission_amount_eur) FILTER (WHERE status = 'approved'), 0)
        - COALESCE(sum(cost_amount_eur) FILTER (WHERE status = 'approved'), 0)) AS "netEur"
  FROM orders
  WHERE funnel_id IS NULL AND day BETWEEN $1::date AND $2::date`;

// Filas tal como salen de pg (numeric → string): el mapeo a números ocurre
// una sola vez, acá, y el resto del proyecto no vuelve a tocar strings.
type TotalsRow = {
  ordersApproved: number;
  ordersRefunded: number;
  ordersChargeback: number;
  grossOrig: string;
  grossEur: string;
  refundedOrig: string;
  commissionsOrig: string;
  commissionsEur: string;
  ordersSinComision: number;
  costsOrig: string;
  costsEur: string;
  ordersSinCosto: number;
  refundedEur: string;
  netOrig: string;
  netEur: string;
  fxStaleCount: number;
  unknownTierCount: number;
};
type TierRowRaw = { tier: string; orders: number; netOrig: string; netEur: string };
type MoneyRowRaw = { orders: number; netEur: string; netOrig: string };
type DayRowRaw = MoneyRowRaw & { day: string; refundedEur: string; refundedOrig: string };
type RecentRowRaw = {
  // bigserial → pg lo devuelve como string (el driver protege el rango de
  // int64); el mapeo lo pasa a number, que es lo que usa la UI.
  id: string;
  orderNumber: string | null;
  email: string | null;
  status: string;
  tier: string;
  amount: string;
  currency: string;
  amountEur: string | null;
  fxStale: boolean;
  utmSource: string;
  utmCampaign: string;
  purchasedAt: Date | string;
  product: string | null;
};

const MONEY = (v: string): number => Number(v);
const NUMERIC = (v: string | null): number | null => (v === null ? null : Number(v));

// Una tabla de 300 campañas es ilegible: se corta en 20 y el resto se suma
// en una fila '(otras)' (mismo criterio que T06 §2).
const BREAKDOWN_CAP = 20;

function capWithOther<T extends { [key: string]: number | string }>(rows: T[], nameKey: keyof T & string): T[] {
  const out = rows.slice(0, BREAKDOWN_CAP);
  if (rows.length > BREAKDOWN_CAP) {
    const rest = rows.slice(BREAKDOWN_CAP);
    out.push({
      ...(rows[0] ?? rows[BREAKDOWN_CAP - 1]!),
      [nameKey]: '(otras)',
      orders: rest.reduce((a, r) => a + Number(r.orders), 0),
      netEur: rest.reduce((a, r) => a + Number(r.netEur), 0),
    } as T);
  }
  return out;
}

// El gráfico por día necesita una fila por día del rango: un día sin ventas
// es un 0, no un hueco en el eje. La aritmética es sobre Date.UTC, que no
// conoce TZ (los días ya están resueltos y son strings planos).
function fillDays(from: string, to: string, rows: DayRow[]): DayRow[] {
  const map = new Map(rows.map((r) => [r.day, r]));
  const start = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const end = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  const out: DayRow[] = [];
  for (let t = start; t <= end; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push(
      map.get(day) ?? { day, orders: 0, netEur: 0, netOrig: 0, refundedEur: 0, refundedOrig: 0 },
    );
  }
  return out;
}

export async function getSalesData(f: SalesFilters): Promise<SalesData> {
  const totalsWhere = baseWhere(f, false);
  const rowsWhere = baseWhere(f, true);

  const currency =
    f.funnelId === null
      ? // Sin funnel no hay sell_currency: se usa la moneda dominante del
        // cajón en el rango (en la práctica los dos funnels venden en ARS).
        (await q1<{ currency: string }>(
          `SELECT currency FROM orders
           WHERE funnel_id IS NULL AND day BETWEEN $1::date AND $2::date
           GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`,
          [f.from, f.to],
        ))?.currency ?? 'ARS'
      : (await q1<{ currency: string }>(`SELECT sell_currency AS currency FROM funnels WHERE id = $1`, [f.funnelId]))?.currency ??
        'ARS';

  // El gasto usa (funnelId, from, to) en ese orden: es su propio WHERE, no el de
  // orders, porque ad_spend no comparte los filtros de tier ni de status.
  // La moneda del funnel va como 4º parámetro (destino de la conversión) y la
  // moneda de reporte como 5º (origen: es la unidad en la que está spend_eur).
  const spendParams = [f.funnelId, f.from, f.to, currency, MONEDA_REPORTE];
  const [
    totalsRow, tierRows, campaignRows, sourceRows, dayRows, recentRows, unattRow,
    spendRow, campaignSpendRows,
  ] = await Promise.all([
      q1<TotalsRow>(`${TOTALS_SQL} ${totalsWhere.where}`, totalsWhere.params),
      q<TierRowRaw>(`${TIER_SQL} ${rowsWhere.where} GROUP BY tier ORDER BY "netEur" DESC, tier`, rowsWhere.params),
      q<MoneyRowRaw & { campaign: string; grossOrig: string }>(
        `${CAMPAIGN_SQL} ${rowsWhere.where} GROUP BY 1 ORDER BY "netEur" DESC`,
        rowsWhere.params,
      ),
      q<MoneyRowRaw & { source: string }>(
        `${SOURCE_SQL} ${rowsWhere.where} GROUP BY 1 ORDER BY "netEur" DESC`,
        rowsWhere.params,
      ),
      q<DayRowRaw>(`${DAY_SQL} ${rowsWhere.where} GROUP BY 1 ORDER BY 1`, rowsWhere.params),
      q<RecentRowRaw>(`${RECENT_SQL} ${rowsWhere.where} ORDER BY o.purchased_at DESC, o.id DESC LIMIT 50`, rowsWhere.params),
      q1<{ orders: number; netEur: string }>(UNATTRIBUTED_SQL, [f.from, f.to]),
      q1<{ adSpendOrig: string; adSpendEur: string }>(AD_SPEND_SQL, spendParams),
      q<{ id: string; spendOrig: string; spendEur: string }>(CAMPAIGN_SPEND_SQL, spendParams),
    ]);

  const t = totalsRow;
  const ordersApproved = t?.ordersApproved ?? 0;
  const netEur = t ? MONEY(t.netEur) : 0;
  const netOrig = t ? MONEY(t.netOrig) : 0;
  const grossOrig = t ? MONEY(t.grossOrig) : 0;
  const grossEur = t ? MONEY(t.grossEur) : 0;
  const adSpendOrig = spendRow ? MONEY(spendRow.adSpendOrig) : 0;
  const adSpendEur = spendRow ? MONEY(spendRow.adSpendEur) : 0;
  const commissionsOrig = t ? MONEY(t.commissionsOrig) : 0;
  const commissionsEur = t ? MONEY(t.commissionsEur) : 0;
  const costsOrig = t ? MONEY(t.costsOrig) : 0;
  const costsEur = t ? MONEY(t.costsEur) : 0;

  // ─── Gasto total y ROI ──────────────────────────────────────────────────
  //
  // QUÉ ENTRA EN EL GASTO TOTAL
  // Todo lo que se puso para producir estas ventas: comisión de la pasarela +
  // costo de los productos vendidos + publicidad. Las devoluciones NO son
  // gasto: son facturación que se fue, y ya salen restadas del bruto.
  //
  // POR QUÉ EL NUMERADOR ES EL RESULTADO Y NO EL NETO
  // El neto YA tiene descontadas las comisiones y los costos. Dividirlo por un
  // gasto que las incluye las cuenta dos veces y da un número que no significa
  // nada: hoy serían 221,63 / 244,64 = 0,91, que leído como ROI parece una
  // pérdida del 9% cuando en realidad la operación deja ganancia.
  //
  // ROI = ganancia ÷ inversión. La ganancia es el Resultado (neto − ads), que es
  // la plata que efectivamente queda; la inversión es el gasto total. Así el
  // número se lee solo: 3,5% significa que por cada 100 puestos vuelven 103,50.
  // Es el complemento exacto del ROAS de costo completo: bruto ÷ gasto total − 1
  // da lo mismo.
  const spendTotalOrig = commissionsOrig + costsOrig + adSpendOrig;
  const spendTotalEur = commissionsEur + costsEur + adSpendEur;
  // El gasto por campaña se indexa por el ID que viene después del '|' en el
  // utm_campaign: unir por ID y no por nombre hace que un rename en Meta no
  // parta la serie de la campaña en dos filas distintas.
  const spendPorCampana = new Map(
    campaignSpendRows.map((r) => [r.id, { orig: MONEY(r.spendOrig), eur: MONEY(r.spendEur) }]),
  );
  const idDeCampana = (utm: string): string => {
    const i = utm.lastIndexOf('|');
    return i === -1 ? '' : utm.slice(i + 1).trim();
  };

  const totals: SalesTotals = {
    ordersApproved,
    ordersRefunded: t?.ordersRefunded ?? 0,
    ordersChargeback: t?.ordersChargeback ?? 0,
    grossEur,
    refundedEur: t ? MONEY(t.refundedEur) : 0,
    netEur,
    grossOrig,
    refundedOrig: t ? MONEY(t.refundedOrig) : 0,
    commissionsOrig,
    commissionsEur,
    ordersSinComision: t ? t.ordersSinComision : 0,
    costsOrig,
    costsEur,
    ordersSinCosto: t ? t.ordersSinCosto : 0,
    netOrig,
    currency,
    // Sin órdenes aprobadas no hay denominador: 0, no NaN en el JSON (test 2).
    avgTicketEur: ordersApproved > 0 ? netEur / ordersApproved : 0,
    fxStaleCount: t?.fxStaleCount ?? 0,
    unknownTierCount: t?.unknownTierCount ?? 0,
    adSpendOrig,
    adSpendEur,
    // El resultado puede ser negativo, y así se muestra: gastar más de lo que
    // entra es exactamente lo que hay que ver.
    resultOrig: netOrig - adSpendOrig,
    resultEur: netEur - adSpendEur,
    // Sin gasto cargado no hay denominador: 0 y no Infinity, que en el JSON
    // sale como null y rompe la UI.
    // Los ratios van en las DOS monedas por la misma razón que el CPA: cada
    // día se convirtió con su propia cotización, así que el ratio calculado en
    // pesos y el calculado en euros no son idénticos (hoy 1,196 contra 1,189).
    // La diferencia es chica pero visible en pantalla, y un usuario que divida
    // a mano los euros que ve tiene que llegar al mismo número que la tarjeta.
    roas: adSpendOrig > 0 ? grossOrig / adSpendOrig : 0,
    roasEur: adSpendEur > 0 ? grossEur / adSpendEur : 0,
    // El CPA va en las DOS monedas, como todo el resto de los importes: la
    // tarjeta lo muestra al lado del gasto y el toggle EUR/ARS lo cambia. Con un
    // solo valor (en la moneda del funnel) la vista en euros mostraba el número
    // en pesos con el símbolo del euro.
    cpa: adSpendOrig > 0 && ordersApproved > 0 ? adSpendOrig / ordersApproved : 0,
    cpaEur: adSpendEur > 0 && ordersApproved > 0 ? adSpendEur / ordersApproved : 0,
    spendTotalOrig,
    spendTotalEur,
    // Sin gasto no hay denominador: 0 y no Infinity (que en JSON sale null y
    // rompe la UI). El ROI puede ser negativo, y así se muestra.
    roi: spendTotalOrig > 0 ? (netOrig - adSpendOrig) / spendTotalOrig : 0,
    roiEur: spendTotalEur > 0 ? (netEur - adSpendEur) / spendTotalEur : 0,
    // ── Métricas nuevas (T02): null sin denominador, en tanto por uno ──
    // Las 'pending' no entran en ninguno de los dos lados del refundRate:
    // una orden pendiente nunca fue una venta, así que ni suma al numerador
    // ni al denominador. Los chargebacks SÍ suman al numerador: para el
    // negocio es plata que volvió, igual que una devolución.
    refundRate:
      ordersApproved + (t?.ordersRefunded ?? 0) + (t?.ordersChargeback ?? 0) > 0
        ? ((t?.ordersRefunded ?? 0) + (t?.ordersChargeback ?? 0)) /
          (ordersApproved + (t?.ordersRefunded ?? 0) + (t?.ordersChargeback ?? 0))
        : null,
    netMargin: grossEur > 0 ? netEur / grossEur : null,
    avgTicketOrig: ordersApproved > 0 ? netOrig / ordersApproved : null,
    commissionRate: grossEur > 0 ? commissionsEur / grossEur : null,
    costRate: grossEur > 0 ? costsEur / grossEur : null,
  };

  return {
    totals,
    byTier: tierRows.map((r) => ({ tier: r.tier, orders: r.orders, netEur: MONEY(r.netEur), netOrig: MONEY(r.netOrig) })),
    byCampaign: capWithOther(
      campaignRows.map((r) => {
        const sp = spendPorCampana.get(idDeCampana(r.campaign));
        const bruto = MONEY(r.grossOrig);
        return {
          campaign: r.campaign,
          orders: r.orders,
          netEur: MONEY(r.netEur),
          netOrig: MONEY(r.netOrig),
          spendOrig: sp?.orig ?? 0,
          spendEur: sp?.eur ?? 0,
          roas: sp && sp.orig > 0 ? bruto / sp.orig : 0,
        };
      }),
      'campaign',
    ),
    bySource: capWithOther(
      sourceRows.map((r) => ({ source: r.source, orders: r.orders,
                               netEur: MONEY(r.netEur), netOrig: MONEY(r.netOrig) })),
      'source',
    ),
    byDay: fillDays(
      f.from,
      f.to,
      dayRows.map((r) => ({ day: r.day, orders: r.orders,
                            netEur: MONEY(r.netEur), netOrig: MONEY(r.netOrig),
                            refundedEur: MONEY(r.refundedEur), refundedOrig: MONEY(r.refundedOrig) })),
    ),
    recent: recentRows.map((r) => ({
      id: Number(r.id),
      orderNumber: r.orderNumber,
      email: r.email,
      status: r.status,
      tier: r.tier,
      product: r.product,
      amount: MONEY(r.amount),
      currency: r.currency,
      amountEur: NUMERIC(r.amountEur),
      fxStale: r.fxStale,
      utmSource: r.utmSource,
      utmCampaign: r.utmCampaign,
      purchasedAt: r.purchasedAt instanceof Date ? r.purchasedAt.toISOString() : new Date(r.purchasedAt).toISOString(),
    })),
    unattributed: { orders: unattRow?.orders ?? 0, netEur: unattRow ? MONEY(unattRow.netEur) : 0 },
    generatedAt: new Date().toISOString(),
  };
}

// ─── Tasas derivadas (T07 §4.3) ─────────────────────────────────────────────
//
// Viven acá como funciones puras para que los tests bloqueen la matemática
// (test 8: 10 front + 3 upsell → 30 %, y con front = 0 → 0, nunca NaN). La
// pantalla las reproduce inline: importar este archivo desde un client
// component arrastraría pg al bundle del browser.
export function upsellTakeRate(byTier: TierRow[]): number {
  // OJO CON LA UNIDAD: esta función devuelve 0-100 (multiplica por 100 acá),
  // al contrario que TODOS los ratios del resto del proyecto, que van en
  // tanto por uno y dejan la multiplicación a la vista (fmtPct(x * 100)).
  // No la uses de modelo, y quien la muestre no debe volver a multiplicar.
  const front = byTier.find((r) => r.tier === 'front')?.orders ?? 0;
  if (front === 0) return 0; // sin front no hay denominador
  const upsell = byTier.find((r) => r.tier === 'upsell')?.orders ?? 0;
  return (upsell / front) * 100;
}

/** AOV real: cuánto vale cada comprador nuevo (neto total ÷ órdenes de tier front). */
export function realAov(byTier: TierRow[], net: number): number {
  const front = byTier.find((r) => r.tier === 'front')?.orders ?? 0;
  if (front === 0) return 0;
  return net / front;
}

// ─── Ajustes de la sección ──────────────────────────────────────────────────

/**
 * Moneda por defecto del toggle, de settings (plan §3.10).
 *
 * El toggle elige entre la moneda de REPORTE y la moneda de VENTA del funnel.
 * Antes devolvía `'EUR' | 'ARS'` literales; ahora la primera sale de
 * MONEDA_REPORTE, porque en una instancia que consolida en dólares el valor
 * 'EUR' guardado en settings no significa nada.
 *
 * 'ARS' se sigue aceptando tal cual por compatibilidad con las filas ya
 * guardadas: significa "mostrar la moneda de venta", que es lo que era.
 */
export async function getDefaultCurrencyView(): Promise<string> {
  const row = await q1<{ value: unknown }>(
    `SELECT value FROM settings WHERE key = 'default_currency_view'`,
  );
  return row?.value === 'ARS' ? 'ARS' : MONEDA_REPORTE;
}

/** TZ del dashboard para el cajón sin atribuir (D19): no hay funnel que la defina. */
export function getDashboardTimezone(): string {
  return process.env.DASHBOARD_TZ ?? 'America/Argentina/Buenos_Aires';
}
