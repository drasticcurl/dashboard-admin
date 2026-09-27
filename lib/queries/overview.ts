/**
 * Resumen unificado (task T08) — todos los funnels en una pantalla, en euros.
 *
 * Esta pantalla lee EXCLUSIVAMENTE de daily_metrics (plan §3.8): cruzar
 * todos los funnels contra las tablas base en cada carga es un escaneo
 * completo de sessions + orders, y con N funnels eso no escala. La tabla la
 * recalcula el cron (scripts/rollup.ts) y acá no se re-deriva nada: si el
 * rollup está viejo, la pantalla lo dice (staleRollup) en vez de inventar
 * números — un cero creíble de un cron muerto es la peor forma de perder la
 * confianza en el panel (task §4).
 *
 * El neto es bruto − devuelto en EUR, la misma matemática que T07 (suma de
 * amount_eur con FILTER por status): el test 4 del task lockea que ambos
 * coincidan exactamente. Las restas y sumas van en SQL — numeric es decimal
 * exacto, y restar en el float de JS deja colas de 0.000000000002 en el
 * JSON.
 *
 * D12: todo en EUR para poder sumar. D19: el rango del Resumen se resuelve
 * con DASHBOARD_TZ (no hay funnel que lo defina).
 */

import { q, q1 } from '@/lib/db';
import { listFunnels } from '@/lib/funnels';
import { leerInsightVigente, type InsightGuardado } from '@/lib/ia/insights';
import { MONEDA_REPORTE, type MonedaReporte } from '@/lib/moneda-reporte';
import { UNATTRIBUTED_FUNNEL } from './sales';

export type OverviewFilters = { from: string; to: string }; // en DASHBOARD_TZ

export type FunnelSummary = {
  funnelId: number;
  slug: string;
  name: string;
  color: string;
  sellCurrency: string;
  timezone: string;
  sessions: number;
  quizStarted: number;
  salesViews: number;
  checkoutClicks: number;
  orders: number;
  ordersRefunded: number;
  netEur: number;
  netOrig: number;
  /** Gasto de publicidad del rango (migración 014). */
  adSpendEur: number;
  adSpendOrig: number;
  /** Neto − ads: la plata que queda. Puede ser negativo, y así se muestra. */
  resultEur: number;
  /** Bruto ÷ ads. 0 si no hay gasto cargado. */
  roas: number;
  /** Neto ÷ ads, como múltiplo (D16). Equilibrio en 1.00×. Distinto del roas
   *  por el numerador (neto vs bruto). null sin gasto, nunca 0 ni Infinity —
   *  a diferencia del roas, que devuelve 0 por compatibilidad y no se unifica
   *  (ver el docblock de `totals.roi`). El widget usa el de `totals`. */
  roi: number | null;
  /** Bruto (antes de devoluciones, comisiones y costos). Es el numerador del ROAS. */
  grossEur: number;
  convSessionToSale: number; // orders / sessions
  avgTicketEur: number;
  lastEventAt: string | null; // para detectar un funnel que dejó de reportar
  // ── Métricas nuevas (T02 del rediseño) ────────────────────────────────
  // Los campos de esta sección devuelven null cuando no hay denominador, no 0:
  // "no se puede calcular" y "vale cero" son cosas distintas. Los campos de
  // arriba (roas, convSessionToSale, avgTicketEur) devuelven 0 por
  // compatibilidad con las vistas y los tests que ya existen — no unificar
  // sin cambiar las dos vistas a la vez.
  /** Tanto por uno: 0,04 = 4 %. Devoluciones sobre órdenes aprobadas. null sin órdenes. */
  refundRate: number | null;
  /** Tanto por uno: 0,35 = 35 %. Neto ÷ bruto. Puede ser negativo, y así se devuelve. null con bruto 0 (posible con neto ≠ 0). */
  netMargin: number | null;
  /** Tanto por uno: 0,28 = 28 %. Órdenes ÷ clicks al checkout. null sin clicks. */
  convCheckoutToSale: number | null;
  /** Tanto por uno. Quiz arrancados ÷ sesiones. null sin sesiones. */
  convSessionToQuiz: number | null;
  /** Tanto por uno. Vistas de la página de venta ÷ quiz arrancados. null sin quiz. */
  convQuizToSalesView: number | null;
  /** EUR por sesión. Neto ÷ sesiones: la métrica que junta tráfico y plata. null sin sesiones. */
  revPerSession: number | null;
  /** EUR por orden. Gasto de ads ÷ órdenes (existe en Ventas y falta acá: con esto se comparan dos funnels). null sin órdenes. */
  cpa: number | null;
};

/**
 * La cotización con la que se convirtió el ÚLTIMO día del rango cuando el
 * Resumen se mira en la moneda alternativa (el switch EUR/USD). Es la que se
 * muestra al lado del switch; los días anteriores usan cada uno la suya.
 */
export type CotizacionVista = {
  /** Unidades de la moneda de reporte por 1 de la moneda vista (EUR por USD). */
  rate: number;
  /** De qué día es la fila. Distinto del último día del rango = arrastrada. */
  dia: string;
  source: string;
};

export type OverviewData = {
  /**
   * En qué moneda están TODOS los importes de este objeto. Los campos se
   * siguen llamando `*Eur` por lo mismo que las columnas (ver
   * SUFIJO_COLUMNA_REPORTE): el nombre dice "moneda consolidada", y esta es la
   * que dice cuál. Los widgets formatean con esto y NO con el `?moneda=` de la
   * URL: mientras el pedido nuevo viaja, los números viejos siguen diciendo su
   * moneda de verdad.
   */
  moneda: MonedaReporte;
  /** null cuando `moneda` es la de reporte (no hubo conversión). */
  cotizacion: CotizacionVista | null;
  /**
   * La moneda que se pidió y no se pudo usar porque `fx_rates` no tiene
   * ninguna fila del par. Los importes quedan en la de reporte y la pantalla
   * lo avisa; convertir con un factor inventado sería peor que no convertir.
   */
  monedaSinCotizacion: MonedaReporte | null;
  totals: {
    sessions: number;
    orders: number;
    netEur: number;
    avgTicketEur: number;
    ordersRefunded: number;
    refundedEur: number;
    adSpendEur: number;
    /** Neto total − ads total. El número que dice si el negocio gana o pierde. */
    resultEur: number;
    roas: number;
    /**
     * ROI: neto ÷ gasto de publicidad, como múltiplo. Equilibrio en 1.00× (D16).
     *
     * NO es lo mismo que el `roas` de acá arriba, y la diferencia es el
     * numerador: `roas` usa el BRUTO (antes de devoluciones, comisiones y costos)
     * y este usa el NETO. Es lo que lo hace un número distinto y no una segunda
     * opinión sobre el mismo.
     *
     * Se descartó `resultEur / adSpendEur`, que también es "retorno sobre la
     * inversión": su equilibrio cae en 0.00× y un múltiplo cuyo cero es el
     * break-even no se lee de un vistazo. Además la ganancia en plata ya la dice
     * el widget de Resultado. La relación es `roi = 1 + resultEur/gasto`,
     * verificada en tasks/usuarios-y-tareas/_verificacion-sesion.mjs
     * (afirmación 16).
     *
     * null sin gasto cargado, nunca 0 ni Infinity: es la regla de los campos
     * nuevos (líneas 58-62), y "no se puede calcular" y "vale cero" son cosas
     * distintas. NO se unifica con el `roas`, que devuelve 0 por compatibilidad.
     */
    roi: number | null;
    // ── Métricas nuevas (T02 del rediseño) ──────────────────────────────
    // Los campos de esta sección devuelven null cuando no hay denominador,
    // no 0, con el mismo criterio de los campos nuevos de FunnelSummary.
    /** El bruto sumado de todos los funnels. YA se calcula (variable `brutoTotal`,
     *  el numerador del roas de totals) y no se expone: hoy el panel muestra un
     *  ROAS sin poder mostrar de dónde sale. */
    grossEur: number;
    /** Sumas que existen por funnel y no en el total. Un widget de Resumen que
     *  quiera "clicks al checkout" hoy tiene que sumarlas en el componente. */
    quizStarted: number;
    salesViews: number;
    checkoutClicks: number;
    /**
     * Los mismos ratios del §3.1 de la task, a nivel total. Se calculan con
     * los TOTALES, no promediando los de cada funnel (ver el comentario del
     * roas). null sin denominador.
     */
    refundRate: number | null;
    netMargin: number | null;
    convSessionToSale: number | null;
    convCheckoutToSale: number | null;
    revPerSession: number | null;
    cpa: number | null;
  };
  funnels: FunnelSummary[];
  byDay: {
    day: string;
    netEur: number;
    orders: number;
    sessions: number;
    perFunnel: Record<string, number>; // netEur por slug, para el gráfico apilado
  }[];
  alerts: Alert[];
  generatedAt: string;
  staleRollup: boolean; // true si el rollup más nuevo tiene más de 30 min
  // Adiciones que la pantalla exige (task §6.2 y §6.6): el trend de las
  // StatCards necesita el período anterior, y el pie la fecha del último
  // rollup. El tipo canónico del task no las lista, pero sin estos datos la
  // UI no puede renderizar lo que el task pide.
  prev: PrevTotals | null; // null cuando no hay período anterior posible (rango 'all')
  lastRollupAt: string | null;
  /**
   * El análisis con IA más reciente, o null si no hay o la feature está apagada
   * (sin `OPENAI_API_KEY`).
   *
   * VIAJA ACA Y NO LO PIDE EL WIDGET porque la regla 2 de `lib/widgets/tipos.ts`
   * es que un widget nunca hace fetch: recibe todo por parámetro. Es un SELECT
   * indexado a una tabla de unas pocas filas, no una llamada a OpenAI — el
   * análisis lo genera el cron o el botón, nunca el render (ver la cabecera de la
   * migración 029).
   */
  insight: InsightGuardado | null;
};

export type PrevTotals = {
  netEur: number;
  orders: number;
  sessions: number;
  avgTicketEur: number;
  // Agregados por T02 (rediseño): el trend de un widget de Resultado o de
  // Gasto necesita el período anterior de estos dos, y computePrev ya corre
  // summarySql, que trae adSpendEur — son dos líneas, no una query más.
  adSpendEur: number;
  resultEur: number;
};

export type Alert = { tone: 'warn' | 'bad'; text: string; href?: string };

// ─── Queries ────────────────────────────────────────────────────────────────
//
// El WHERE filtra variant = '*' a propósito: solo la fila total lleva las
// ventas (las filas por variante las escriben con 0, porque orders no tiene
// variant confiable — comentario en scripts/rollup.ts). Las métricas de
// sesión también se leen de la fila '*': count sin filtro de variante, que
// es la definición correcta del total.
type SummaryRow = {
  funnelId: number;
  sessions: number;
  quizStarted: number;
  salesViews: number;
  checkoutClicks: number;
  orders: number;
  ordersRefunded: number;
  netEur: string;
  netOrig: string;
  refundedEur: string;
  adSpendEur: string;
  adSpendOrig: string;
  grossEur: string;
};

/**
 * El factor que pasa cada fila de daily_metrics a la moneda en la que se mira.
 *
 * Sin conversión es un 1 constante y la query queda igual que siempre. Con
 * conversión (el switch en la moneda alternativa) cada fila se divide por la
 * cotización de SU día: la última fila del par con `day <= dm.day`, y si el
 * día es anterior a la primera cotización guardada, la primera que haya. Ese
 * segundo caso es para que un histórico sin backfill (npm run
 * fx:historico-alternativa) se vea aproximado en lugar de en cero.
 *
 * `$3`/`$4` son la base y el quote del par: moneda vista → moneda de reporte,
 * o sea "cuántos EUR vale 1 USD". Dividir por eso pasa EUR a USD.
 */
function joinFactor(convierte: boolean): string {
  if (!convierte) return 'CROSS JOIN (SELECT 1::numeric AS k) fx';
  return `CROSS JOIN LATERAL (
    SELECT 1 / COALESCE(
      (SELECT r.rate FROM fx_rates r
        WHERE r.base = $3 AND r.quote = $4 AND r.day <= dm.day
        ORDER BY r.day DESC LIMIT 1),
      (SELECT r.rate FROM fx_rates r
        WHERE r.base = $3 AND r.quote = $4
        ORDER BY r.day ASC LIMIT 1)
    ) AS k
  ) fx`;
}

// Las columnas `_eur` se multiplican por el factor; las de la moneda de venta
// (`revenue_gross`, `ad_spend`, …) NO: son el "neto en su moneda" de cada
// funnel y no dependen de en qué moneda se mire el consolidado.
function summarySql(convierte: boolean): string {
  return `
  SELECT dm.funnel_id AS "funnelId",
         SUM(dm.sessions_count)::int       AS sessions,
         SUM(dm.quiz_started)::int         AS "quizStarted",
         SUM(dm.sales_views)::int          AS "salesViews",
         SUM(dm.checkout_clicks)::int      AS "checkoutClicks",
         SUM(dm.orders_count)::int         AS orders,
         SUM(dm.orders_refunded)::int      AS "ordersRefunded",
         -- El neto descuenta comisiones, igual que la pantalla de Ventas: si las
         -- dos definiciones difieren, el panel muestra dos verdades para lo
         -- mismo y deja de usarse (test 4 de T08).
         (COALESCE(SUM(dm.revenue_gross_eur * fx.k), 0)
        - COALESCE(SUM(dm.revenue_refunded_eur * fx.k), 0)
        - COALESCE(SUM(dm.commissions_eur * fx.k), 0)
        - COALESCE(SUM(dm.costs_eur * fx.k), 0))::text AS "netEur",
         COALESCE(SUM(dm.ad_spend_eur * fx.k), 0)::text AS "adSpendEur",
         COALESCE(SUM(dm.ad_spend), 0)::text     AS "adSpendOrig",
         COALESCE(SUM(dm.revenue_gross_eur * fx.k), 0)::text AS "grossEur",
         (COALESCE(SUM(dm.revenue_gross), 0)
        - COALESCE(SUM(dm.revenue_refunded), 0)
        - COALESCE(SUM(dm.commissions), 0)
        - COALESCE(SUM(dm.costs), 0))::text AS "netOrig",
         COALESCE(SUM(dm.revenue_refunded_eur * fx.k), 0)::text AS "refundedEur"
  FROM daily_metrics dm
  ${joinFactor(convierte)}
  WHERE dm.variant = '*' AND dm.day BETWEEN $1::date AND $2::date
  GROUP BY dm.funnel_id`;
}

type DayRowRaw = {
  day: string;
  funnelId: number;
  netEur: string;
  orders: number;
  sessions: number;
};

function daySql(convierte: boolean): string {
  return `
  SELECT dm.day::text AS day, dm.funnel_id AS "funnelId",
         (COALESCE(SUM(dm.revenue_gross_eur * fx.k), 0)
        - COALESCE(SUM(dm.revenue_refunded_eur * fx.k), 0))::text AS "netEur",
         SUM(dm.orders_count)::int  AS orders,
         SUM(dm.sessions_count)::int AS sessions
  FROM daily_metrics dm
  ${joinFactor(convierte)}
  WHERE dm.variant = '*' AND dm.day BETWEEN $1::date AND $2::date
  GROUP BY 1, 2
  ORDER BY day`;
}

/** Los parámetros de summarySql/daySql: el rango, y el par si se convierte. */
function paramsRango(from: string, to: string, moneda: MonedaReporte): string[] {
  return moneda === MONEDA_REPORTE ? [from, to] : [from, to, moneda, MONEDA_REPORTE];
}

/**
 * La cotización del último día del rango (o la última anterior), para
 * mostrarla al lado del switch. null si el par no tiene ni una fila: en ese
 * caso no se convierte nada (ver `monedaSinCotizacion`).
 */
const COTIZACION_SQL = `
  SELECT day::text AS dia, rate::text AS rate, source
    FROM fx_rates
   WHERE base = $1 AND quote = $2
   ORDER BY (day <= $3::date) DESC,
            CASE WHEN day <= $3::date THEN day END DESC,
            day ASC
   LIMIT 1`;

// La "última señal" de un funnel: la más reciente entre el último batche de
// tracking (sessions.last_seen_at) y la última compra registrada por el
// webhook (orders.purchased_at). Es el único dato del Resumen que no puede
// salir de daily_metrics (la tabla es por día, sin timestamps), y por eso
// escanea las dos tablas base: es un MAX por funnel, barato hoy, y si un día
// pesa, el índice que lo arregle es tema de §10, no de esta query.
const LAST_EVENT_SQL = `
  SELECT funnel_id AS "funnelId", MAX(ts) AS "lastEventAt"
  FROM (
    SELECT funnel_id, last_seen_at AS ts FROM sessions
    UNION ALL
    SELECT funnel_id, purchased_at FROM orders WHERE purchased_at IS NOT NULL
  ) t
  GROUP BY 1`;

type CountRow = { n: number };
type RollupRow = { computedAt: Date | null };
type LastEventRow = { funnelId: number; lastEventAt: Date };

const UNATTRIBUTED_SQL = `
  SELECT count(*)::int AS n
  FROM orders
  WHERE funnel_id IS NULL AND day BETWEEN $1::date AND $2::date`;

// fx_stale y tier unknown van SIN filtro de rango a propósito: son alarmas
// del sistema, no del período que se mira. Una orden sin convertir de hace
// dos semanas sigue haciendo que el total en EUR esté corto hoy.
const FX_STALE_SQL = `
  SELECT count(*)::int AS n FROM orders WHERE fx_stale OR amount_eur IS NULL`;
const UNKNOWN_TIER_SQL = `
  SELECT count(*)::int AS n FROM orders WHERE tier = 'unknown'`;
const INGEST_ERRORS_SQL = `
  SELECT count(*)::int AS n FROM ingest_errors WHERE received_at >= now() - interval '24 hours'`;
const LATEST_ROLLUP_SQL = `
  SELECT max(computed_at) AS "computedAt" FROM daily_metrics`;

const MONEY = (v: string): number => Number(v);
const ISO = (d: Date | null): string | null => (d === null ? null : d.toISOString());

// Aritmética de días sobre strings planos 'YYYY-MM-DD' (Date.UTC no conoce
// TZ; los días ya vienen resueltos de Postgres).
function shiftDay(day: string, delta: number): string {
  const t = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + delta);
  return new Date(t).toISOString().slice(0, 10);
}

function dayCount(from: string, to: string): number {
  return Math.round((Date.UTC(
    Number(to.slice(0, 4)),
    Number(to.slice(5, 7)) - 1,
    Number(to.slice(8, 10)),
  ) - Date.UTC(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)) - 1,
    Number(from.slice(8, 10)),
  )) / 86_400_000) + 1;
}

async function computePrev(from: string, to: string, moneda: MonedaReporte): Promise<PrevTotals> {
  const rows = await q<SummaryRow>(summarySql(moneda !== MONEDA_REPORTE), paramsRango(from, to, moneda));
  let netEur = 0;
  let orders = 0;
  let sessions = 0;
  let adSpendEur = 0;
  for (const r of rows) {
    netEur += MONEY(r.netEur);
    orders += r.orders;
    sessions += r.sessions;
    adSpendEur += MONEY(r.adSpendEur);
  }
  return {
    netEur,
    orders,
    sessions,
    avgTicketEur: orders > 0 ? netEur / orders : 0,
    adSpendEur,
    resultEur: netEur - adSpendEur,
  };
}

/** El reloj '14:20' de los alerts, en la TZ del dashboard (D19). */
function fmtClock(iso: string): string {
  const tz = process.env.DASHBOARD_TZ ?? 'America/Argentina/Buenos_Aires';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(d);
}

const intFmt = new Intl.NumberFormat('es-AR');
const fmtInt = (n: number): string => intFmt.format(n);

/**
 * `moneda` es la moneda en la que se quieren ver los importes (el switch
 * EUR/USD). Por defecto la de reporte, que es lo que siguen pidiendo el brief
 * de IA y los tests: para ellos no cambia nada.
 */
export async function getOverviewData(
  f: OverviewFilters,
  monedaPedida: MonedaReporte = MONEDA_REPORTE,
): Promise<OverviewData> {
  const now = Date.now();

  // Primero la cotización: sin ninguna fila del par no se convierte (un factor
  // NULL daría todos los importes en 0, creíbles y falsos), se sigue en la
  // moneda de reporte y la pantalla avisa.
  let moneda: MonedaReporte = MONEDA_REPORTE;
  let cotizacion: CotizacionVista | null = null;
  let monedaSinCotizacion: MonedaReporte | null = null;
  if (monedaPedida !== MONEDA_REPORTE) {
    const c = await q1<{ dia: string; rate: string; source: string }>(COTIZACION_SQL, [
      monedaPedida,
      MONEDA_REPORTE,
      f.to,
    ]);
    if (c && Number(c.rate) > 0) {
      moneda = monedaPedida;
      cotizacion = { rate: Number(c.rate), dia: c.dia, source: c.source };
    } else {
      monedaSinCotizacion = monedaPedida;
    }
  }
  const convierte = moneda !== MONEDA_REPORTE;

  const [
    funnelRows,
    summaryRows,
    dayRows,
    unattRow,
    fxRow,
    tierRow,
    ingestRow,
    rollupRow,
    lastEventRows,
    insight,
  ] = await Promise.all([
    listFunnels(),
    q<SummaryRow>(summarySql(convierte), paramsRango(f.from, f.to, moneda)),
    q<DayRowRaw>(daySql(convierte), paramsRango(f.from, f.to, moneda)),
    q1<CountRow>(UNATTRIBUTED_SQL, [f.from, f.to]),
    q1<CountRow>(FX_STALE_SQL),
    q1<CountRow>(UNKNOWN_TIER_SQL),
    q1<CountRow>(INGEST_ERRORS_SQL),
    q1<RollupRow>(LATEST_ROLLUP_SQL),
    q<LastEventRow>(LAST_EVENT_SQL),
    leerInsightVigente('resumen'),
  ]);

  // Período anterior de igual largo (task §6.2): 7d compara contra los 7
  // días anteriores. Con 'all' (from = 2000-01-01, el centinela de lib/day)
  // no hay período anterior posible y prev queda null: el trend se oculta,
  // no se inventa un 0%.
  const len = dayCount(f.from, f.to);
  const prev =
    f.from <= '2000-01-01'
      ? null
      : await computePrev(shiftDay(f.from, -len), shiftDay(f.from, -1), moneda);

  const summaryByFunnel = new Map(summaryRows.map((r) => [r.funnelId, r]));
  const lastByFunnel = new Map(lastEventRows.map((r) => [r.funnelId, r.lastEventAt]));

  let refundedEur = 0;
  const funnels: FunnelSummary[] = funnelRows.map((fn) => {
    const r = summaryByFunnel.get(fn.id);
    const sessions = r?.sessions ?? 0;
    const orders = r?.orders ?? 0;
    const ordersRefunded = r?.ordersRefunded ?? 0;
    const quizStarted = r?.quizStarted ?? 0;
    const salesViews = r?.salesViews ?? 0;
    const checkoutClicks = r?.checkoutClicks ?? 0;
    const netEur = r ? MONEY(r.netEur) : 0;
    const adSpendEur = r ? MONEY(r.adSpendEur) : 0;
    const grossEur = r ? MONEY(r.grossEur) : 0;
    if (r) refundedEur += MONEY(r.refundedEur);
    return {
      funnelId: fn.id,
      slug: fn.slug,
      name: fn.name,
      color: fn.color,
      sellCurrency: fn.sellCurrency,
      timezone: fn.timezone,
      sessions,
      quizStarted,
      salesViews,
      checkoutClicks,
      orders,
      ordersRefunded,
      netEur,
      netOrig: r ? MONEY(r.netOrig) : 0,
      adSpendEur,
      adSpendOrig: r ? MONEY(r.adSpendOrig) : 0,
      grossEur,
      // Puede quedar negativo: gastar más de lo que entra es lo que hay que ver.
      resultEur: netEur - adSpendEur,
      // Sin gasto no hay denominador: 0 y no Infinity (que en JSON sale null).
      roas: adSpendEur > 0 ? grossEur / adSpendEur : 0,
      // ROI: neto ÷ gasto (D16). Distinto del roas por el numerador (neto vs
      // bruto). null sin gasto, nunca 0 — es la regla de los campos nuevos, y
      // NO se unifica con el roas de acá arriba (que devuelve 0).
      roi: adSpendEur > 0 ? netEur / adSpendEur : null,
      // Sin sesiones no hay denominador: 0, no NaN en el JSON (test 2).
      convSessionToSale: sessions > 0 ? orders / sessions : 0,
      avgTicketEur: orders > 0 ? netEur / orders : 0,
      lastEventAt: ISO(lastByFunnel.get(fn.id) ?? null),
      // ── Métricas nuevas (T02): null sin denominador, en tanto por uno ──
      refundRate: orders > 0 ? ordersRefunded / orders : null,
      // El denominador es el bruto, que puede ser 0 con neto distinto de 0
      // (una devolución de una venta de otro mes): null, no -Infinity.
      netMargin: grossEur > 0 ? netEur / grossEur : null,
      convCheckoutToSale: checkoutClicks > 0 ? orders / checkoutClicks : null,
      convSessionToQuiz: sessions > 0 ? quizStarted / sessions : null,
      convQuizToSalesView: quizStarted > 0 ? salesViews / quizStarted : null,
      revPerSession: sessions > 0 ? netEur / sessions : null,
      cpa: orders > 0 ? adSpendEur / orders : null,
    };
  });

  // Ordenadas por neto descendente (task §6.3): el funnel que más plata
  // mueve es el que se ve primero.
  funnels.sort((a, b) => b.netEur - a.netEur);

  const totalsSessions = funnels.reduce((a, fn) => a + fn.sessions, 0);
  const totalsOrders = funnels.reduce((a, fn) => a + fn.orders, 0);
  const totalsNetEur = funnels.reduce((a, fn) => a + fn.netEur, 0);
  const totalsOrdersRefunded = funnels.reduce((a, fn) => a + fn.ordersRefunded, 0);
  const totalsAdSpendEur = funnels.reduce((a, fn) => a + fn.adSpendEur, 0);
  const totalsQuizStarted = funnels.reduce((a, fn) => a + fn.quizStarted, 0);
  const totalsSalesViews = funnels.reduce((a, fn) => a + fn.salesViews, 0);
  const totalsCheckoutClicks = funnels.reduce((a, fn) => a + fn.checkoutClicks, 0);
  // El ROAS del conjunto se calcula con el BRUTO sumado, no promediando los ROAS
  // de cada funnel: un promedio de ratios no significa nada. Y el bruto es el
  // bruto de verdad, no `neto + ads` — el neto ya tiene descontadas las
  // devoluciones, las comisiones y los costos, así que sumarle los ads daría un
  // numerador inventado y un ROAS más bajo que el real. El mismo criterio vale
  // para TODOS los ratios nuevos de totals (T02): se calculan con los totales,
  // nunca promediando los ratios por funnel — un funnel con 1 venta y otro con
  // 1.000 no pesan lo mismo.
  const brutoTotal = funnels.reduce((a, fn) => a + fn.grossEur, 0);
  const totals: OverviewData['totals'] = {
    sessions: totalsSessions,
    orders: totalsOrders,
    netEur: totalsNetEur,
    ordersRefunded: totalsOrdersRefunded,
    refundedEur,
    avgTicketEur: totalsOrders > 0 ? totalsNetEur / totalsOrders : 0,
    adSpendEur: totalsAdSpendEur,
    resultEur: totalsNetEur - totalsAdSpendEur,
    roas: totalsAdSpendEur > 0 ? brutoTotal / totalsAdSpendEur : 0,
    // ROI del conjunto: neto TOTAL ÷ gasto TOTAL, nunca promediando los roi de
    // cada funnel (mismo criterio que el roas de acá arriba: un promedio de
    // ratios no significa nada). Usa el neto, no el bruto — es lo que lo hace
    // distinto del roas. null sin gasto, nunca 0 ni Infinity (regla de los
    // campos nuevos, líneas 58-62), y NO se unifica con el roas.
    roi: totalsAdSpendEur > 0 ? totalsNetEur / totalsAdSpendEur : null,
    // ── Métricas nuevas (T02): null sin denominador, en tanto por uno ──
    grossEur: brutoTotal,
    quizStarted: totalsQuizStarted,
    salesViews: totalsSalesViews,
    checkoutClicks: totalsCheckoutClicks,
    refundRate: totalsOrders > 0 ? totalsOrdersRefunded / totalsOrders : null,
    netMargin: brutoTotal > 0 ? totalsNetEur / brutoTotal : null,
    convSessionToSale: totalsSessions > 0 ? totalsOrders / totalsSessions : null,
    convCheckoutToSale: totalsCheckoutClicks > 0 ? totalsOrders / totalsCheckoutClicks : null,
    revPerSession: totalsSessions > 0 ? totalsNetEur / totalsSessions : null,
    cpa: totalsOrders > 0 ? totalsAdSpendEur / totalsOrders : null,
  };

  // byDay: una fila por día del rango, incluidos los sin datos — un día
  // ausente en el gráfico miente sobre la continuidad (test 3). perFunnel
  // arranca con todos los funnels en 0 para que cada banda del apilado sea
  // continua.
  const byDayKey = new Map<string, DayRowRaw>();
  for (const r of dayRows) byDayKey.set(`${r.day}:${r.funnelId}`, r);
  const byDay: OverviewData['byDay'] = [];
  for (let t = 0; t < len; t++) {
    const day = shiftDay(f.from, t);
    const perFunnel: Record<string, number> = {};
    for (const fn of funnels) perFunnel[fn.slug] = 0;
    let netEur = 0;
    let orders = 0;
    let sessions = 0;
    for (const fn of funnels) {
      const r = byDayKey.get(`${day}:${fn.funnelId}`);
      if (!r) continue;
      const n = MONEY(r.netEur);
      perFunnel[fn.slug] = n;
      netEur += n;
      orders += r.orders;
      sessions += r.sessions;
    }
    byDay.push({ day, netEur, orders, sessions, perFunnel });
  }

  // ─── Alerts (task §4) ──────────────────────────────────────────────────
  //
  // Las dos 'bad' son las que importan: un funnel que dejó de mandar
  // eventos, o un cron muerto, hacen que el panel muestre ceros creíbles.
  // La ventana de 6 h evita falsos positivos de madrugada; un funnel que
  // NUNCA reportó no es un funnel caído, es uno nuevo, y no alerta.
  const alerts: Alert[] = [];
  for (const fn of funnels) {
    if (fn.lastEventAt && now - new Date(fn.lastEventAt).getTime() > 6 * 3600 * 1000) {
      alerts.push({ tone: 'bad', text: `${fn.name} no reporta desde las ${fmtClock(fn.lastEventAt)}` });
    }
  }
  if ((unattRow?.n ?? 0) > 0) {
    alerts.push({
      tone: 'warn',
      text: `${fmtInt(unattRow!.n)} ventas sin funnel asignado`,
      href: `/ventas?f=${UNATTRIBUTED_FUNNEL}`,
    });
  }
  if ((fxRow?.n ?? 0) > 0) {
    alerts.push({ tone: 'warn', text: `${fmtInt(fxRow!.n)} órdenes con cotización provisoria` });
  }
  if ((tierRow?.n ?? 0) > 0) {
    alerts.push({ tone: 'warn', text: `${fmtInt(tierRow!.n)} órdenes sin tier`, href: '/config' });
  }
  if ((ingestRow?.n ?? 0) > 0) {
    alerts.push({ tone: 'warn', text: `${fmtInt(ingestRow!.n)} eventos con problemas`, href: '/config' });
  }

  const computedAt = rollupRow?.computedAt ?? null;
  const lastRollupAt = ISO(computedAt);
  const staleRollup = lastRollupAt === null || now - new Date(lastRollupAt).getTime() > 30 * 60 * 1000;
  // Sin funnels no hay rollup que esperar: el alerta de cron muerto sería
  // ruido sobre un panel que no tiene nada que mostrar.
  if (staleRollup && funnels.length > 0) {
    alerts.push({
      tone: 'bad',
      text: lastRollupAt
        ? `el rollup no corre desde las ${fmtClock(lastRollupAt)}`
        : 'el rollup no corrió nunca — corré npm run rollup',
    });
  }

  return {
    moneda,
    cotizacion,
    monedaSinCotizacion,
    totals,
    funnels,
    byDay,
    alerts,
    generatedAt: new Date().toISOString(),
    staleRollup,
    prev,
    lastRollupAt,
    insight,
  };
}
