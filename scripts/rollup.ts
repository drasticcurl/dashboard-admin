#!/usr/bin/env node
/**
 * Rollup de daily_metrics (task T08) — el Resumen unificado lee de esta
 * tabla (plan §3.8), así que el número de esta pantalla vale lo que valga
 * esta corrida.
 *
 * Uso (declarado en package.json por T01):
 *   npm run rollup                 # últimos 3 días (cron cada 10 minutos)
 *   npm run rollup -- --days=35    # último mes (cron de la noche)
 *   npm run rollup -- --from=2026-01-01 --to=2026-08-11
 *   npm run rollup -- --all        # reconstruye todo desde el primer dato
 *
 * RECALCULA, no acumula: cada fila se vuelve a contar desde las tablas
 * base y el ON CONFLICT pisa el valor viejo. Un rollup que sumara
 * incrementos se desincroniza a la primera corrida doble, y el cron corre
 * cada 10 minutos, así que dos corridas solapadas son la norma, no el
 * error. La idempotencia la lockea el test 5 de la task.
 *
 * Por cada (funnel_id, day) escribe una fila variant='*' (todas) y una por
 * cada variante con datos ese día. Las métricas salen de las dos queries
 * canónicas del task (sesiones con/sin filtro de variante, y ventas), las
 * mismas definiciones que T06 y T07: si difirieran, el Resumen y las
 * secciones mostrarían números distintos para lo mismo.
 *
 * Cron (el archivo lo instala T12; el nocturno va DESPUÉS del fetch-fx de
 * las 03:10 para que el día cerrado use la cotización buena):
 *   cada 10 minutos:         rollup --days=3
 *   03:25 de la noche:       rollup --days=35
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPool, q } from '../lib/db';
import { today } from '../lib/day';
import { MONEDA_REPORTE } from '../lib/moneda-reporte';

// tsx no carga .env solo; en dev el env vive en el archivo, en producción
// viene de PM2 y no existe (process.loadEnvFile es de Node >= 20.12).
const envPath = path.join(process.cwd(), '.env');
if (typeof process.loadEnvFile === 'function' && existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

export type RollupResult = { rows: number; ms: number };

// ─── Las tres queries que definen la matemática del Resumen ───────────────
//
// Son las mismas definiciones que T06/T07 (task T08 §3), en versión
// agrupada: en vez de una query por (funnel, day), una sola pasada por
// rango con GROUP BY. Los valores son idénticos — un COUNT con el mismo
// WHERE no depende de cómo se agrupe.
//
// La fila variant='*' sale de su PROPIO count sin filtro de variante,
// nunca de la suma en JS de las filas por variante: una sesión con
// variante nula o desconocida tiene que contar en el total (task T08 §3).
type SessionGroupRow = {
  funnelId: number;
  day: string;
  variant: string;
  sessions: number;
  quizStarted: number;
  salesViews: number;
  checkoutClicks: number;
};
type SessionStarRow = Omit<SessionGroupRow, 'variant'>;
type OrderRow = {
  funnelId: number;
  day: string;
  orders: number;
  ordersRefunded: number;
  grossOrig: string;
  refundedOrig: string;
  grossEur: string;
  refundedEur: string;
  commissions: string;
  commissionsEur: string;
  costs: string;
  costsEur: string;
};

const SESSION_GROUP_SQL = `
  SELECT funnel_id AS "funnelId", day::text AS day, variant,
         count(*)::int AS sessions,
         count(*) FILTER (WHERE max_step_index >= 1)::int          AS "quizStarted",
         count(*) FILTER (WHERE sales_view_at IS NOT NULL)::int    AS "salesViews",
         count(*) FILTER (WHERE checkout_click_at IS NOT NULL)::int AS "checkoutClicks"
  FROM sessions
  WHERE day BETWEEN $1::date AND $2::date
  GROUP BY funnel_id, day, variant`;

const SESSION_STAR_SQL = `
  SELECT funnel_id AS "funnelId", day::text AS day,
         count(*)::int AS sessions,
         count(*) FILTER (WHERE max_step_index >= 1)::int          AS "quizStarted",
         count(*) FILTER (WHERE sales_view_at IS NOT NULL)::int    AS "salesViews",
         count(*) FILTER (WHERE checkout_click_at IS NOT NULL)::int AS "checkoutClicks"
  FROM sessions
  WHERE day BETWEEN $1::date AND $2::date
  GROUP BY funnel_id, day`;

const ORDER_SQL = `
  SELECT funnel_id AS "funnelId", day::text AS day,
         count(*) FILTER (WHERE status = 'approved')::int AS orders,
         count(*) FILTER (WHERE status <> 'approved')::int AS "ordersRefunded",
         COALESCE(sum(amount)     FILTER (WHERE status = 'approved'), 0)::numeric AS "grossOrig",
         COALESCE(sum(amount)     FILTER (WHERE status <> 'approved'), 0)::numeric AS "refundedOrig",
         COALESCE(sum(amount_eur) FILTER (WHERE status = 'approved'), 0)::numeric AS "grossEur",
         COALESCE(sum(amount_eur) FILTER (WHERE status <> 'approved'), 0)::numeric AS "refundedEur",
         -- Comisiones solo de las aprobadas: en una devolución la pasarela
         -- reintegra el cargo (migración 011).
         COALESCE(sum(commission_amount)     FILTER (WHERE status = 'approved'), 0)::numeric AS "commissions",
         COALESCE(sum(commission_amount_eur) FILTER (WHERE status = 'approved'), 0)::numeric AS "commissionsEur",
         COALESCE(sum(cost_amount)     FILTER (WHERE status = 'approved'), 0)::numeric AS "costs",
         COALESCE(sum(cost_amount_eur) FILTER (WHERE status = 'approved'), 0)::numeric AS "costsEur"
  FROM orders
  WHERE day BETWEEN $1::date AND $2::date
    -- Sin funnel no se puede agregar: daily_metrics.funnel_id es NOT NULL con FK.
    -- Estas ventas NO se pierden: la pantalla de Ventas las muestra en su propio
    -- cajon 'sin atribuir', que se calcula directo de la tabla orders (D10). Sin
    -- este filtro la clave del bucket quedaba 'null:...' y el rollup abortaba con
    -- 'invalid input syntax for type smallint: NaN' — paso al importar el
    -- histórico, donde 28 órdenes de un producto sin mapear entraron sin funnel.
    AND funnel_id IS NOT NULL
  GROUP BY funnel_id, day`;

const UPSERT_SQL = `
  INSERT INTO daily_metrics
    (funnel_id, day, variant, sessions_count, quiz_started, sales_views,
     checkout_clicks, orders_count, orders_refunded, revenue_gross,
     revenue_refunded, revenue_gross_eur, revenue_refunded_eur,
     commissions, commissions_eur, costs, costs_eur, ad_spend, ad_spend_eur)
  SELECT * FROM UNNEST(
    $1::smallint[], $2::date[], $3::text[],
    $4::int[], $5::int[], $6::int[], $7::int[],
    $8::int[], $9::int[],
    $10::numeric[], $11::numeric[], $12::numeric[], $13::numeric[],
    $14::numeric[], $15::numeric[], $16::numeric[], $17::numeric[],
    $18::numeric[], $19::numeric[])
  ON CONFLICT (funnel_id, day, variant) DO UPDATE SET
    sessions_count = EXCLUDED.sessions_count,
    quiz_started = EXCLUDED.quiz_started,
    sales_views = EXCLUDED.sales_views,
    checkout_clicks = EXCLUDED.checkout_clicks,
    orders_count = EXCLUDED.orders_count,
    orders_refunded = EXCLUDED.orders_refunded,
    revenue_gross = EXCLUDED.revenue_gross,
    revenue_refunded = EXCLUDED.revenue_refunded,
    revenue_gross_eur = EXCLUDED.revenue_gross_eur,
    revenue_refunded_eur = EXCLUDED.revenue_refunded_eur,
    commissions = EXCLUDED.commissions,
    commissions_eur = EXCLUDED.commissions_eur,
    costs = EXCLUDED.costs,
    costs_eur = EXCLUDED.costs_eur,
    ad_spend = EXCLUDED.ad_spend,
    ad_spend_eur = EXCLUDED.ad_spend_eur,
    computed_at = now()`;

/** Recalcula daily_metrics para [from, to]. Devuelve cuántas filas escribió. */
export async function rollupRange(opts: { from: string; to: string }): Promise<RollupResult> {
  const start = Date.now();
  const [variantRows, starRows, orderRows] = await Promise.all([
    q<SessionGroupRow>(SESSION_GROUP_SQL, [opts.from, opts.to]),
    q<SessionStarRow>(SESSION_STAR_SQL, [opts.from, opts.to]),
    q<OrderRow>(ORDER_SQL, [opts.from, opts.to]),
  ]);

  // Gasto de publicidad del rango, agregado por funnel y día: el detalle por
  // anuncio vive en ad_spend y no hace falta acá.
  //
  // `ad_spend.spend` está en la moneda de la CUENTA de anuncios (las cuentas
  // facturan en EUR), no en la del funnel. `daily_metrics.ad_spend` es la
  // columna "en moneda del funnel", igual que revenue_gross o commissions: si
  // se copiara `spend` tal cual, un funnel que vende en pesos quedaría con
  // 198,10 donde van ~340.000, y el resultado en ARS saldría inflado por la
  // diferencia. Se convierte dividiendo el importe en euros por la cotización
  // del día (fx_rates guarda 1 unidad de base en euros), con la misma
  // expresión que usa AD_SPEND_SQL en lib/queries/sales.ts.
  const adsRows = await q<{ funnelId: number; day: string; spend: string; spendEur: string }>(
    `SELECT a.funnel_id AS "funnelId", a.day::text AS day,
            COALESCE(sum(
              CASE WHEN f.sell_currency = $3 THEN a.spend_eur
                   ELSE a.spend_eur / NULLIF((
                          SELECT fr.rate FROM fx_rates fr
                          WHERE fr.base = f.sell_currency AND fr.quote = $3 AND fr.day <= a.day
                          ORDER BY fr.day DESC LIMIT 1), 0)
              END), 0)::text AS spend,
            COALESCE(sum(a.spend_eur), 0)::text AS "spendEur"
     FROM ad_spend a
     JOIN funnels f ON f.id = a.funnel_id
     WHERE a.day BETWEEN $1::date AND $2::date AND a.funnel_id IS NOT NULL
     GROUP BY 1, 2`,
    [opts.from, opts.to, MONEDA_REPORTE],
  );
  const adsByDay = new Map<string, { spend: string; spendEur: string }>();
  for (const r of adsRows) adsByDay.set(`${r.funnelId}:${r.day}`, r);

  const ordersByDay = new Map<string, OrderRow>();
  for (const r of orderRows) ordersByDay.set(`${r.funnelId}:${r.day}`, r);
  const sessionsByDay = new Map<string, SessionGroupRow | SessionStarRow>();
  for (const r of variantRows) sessionsByDay.set(`${r.funnelId}:${r.day}:${r.variant}`, r);
  for (const r of starRows) sessionsByDay.set(`${r.funnelId}:${r.day}:*`, r);

  // Las filas por variante llevan las ventas en 0 a propósito: orders no
  // tiene columna variant poblada de forma confiable (viene del cart
  // attribute y puede faltar, P-09), así que las ventas viven SOLO en la
  // fila '*'. Si no, alguien va a mirar la fila 'ar' y creer que ese funnel
  // no vendió nada (task T08 §3).
  // Las claves ya son únicas por construcción (starRows y variantRows salen
  // de GROUP BYs completos), así que un Set solo sirve de filtro contra la
  // repetición de las claves de orders (un día puede tener ventas sin una
  // sola sesión — un upsell abierto desde el mail no pasa por el quiz, D10 —
  // y esa plata tiene que llegar a la fila '*' igual). Se itera el array,
  // no el Set: el tsconfig de T01 no habilita el protocolo de iteración.
  const seenKeys = new Set<string>();
  const bucketKeys: string[] = [];
  const addKey = (k: string): void => {
    if (seenKeys.has(k)) return;
    seenKeys.add(k);
    bucketKeys.push(k);
  };
  for (const r of starRows) addKey(`${r.funnelId}:${r.day}:*`);
  for (const r of variantRows) addKey(`${r.funnelId}:${r.day}:${r.variant}`);
  for (const r of orderRows) addKey(`${r.funnelId}:${r.day}:*`);
  // Un día con gasto y sin una sola sesión ni venta igual tiene que aparecer:
  // es precisamente el día que hay que mirar.
  for (const r of adsRows) addKey(`${r.funnelId}:${r.day}:*`);

  const funnelIds: number[] = [];
  const days: string[] = [];
  const variants: string[] = [];
  const sessions: number[] = [];
  const quizStarted: number[] = [];
  const salesViews: number[] = [];
  const checkoutClicks: number[] = [];
  const orders: number[] = [];
  const ordersRefunded: number[] = [];
  const grossOrig: string[] = [];
  const refundedOrig: string[] = [];
  const grossEur: string[] = [];
  const refundedEur: string[] = [];
  const commissions: string[] = [];
  const commissionsEur: string[] = [];
  const costs: string[] = [];
  const costsEur: string[] = [];
  const adSpend: string[] = [];
  const adSpendEur: string[] = [];

  for (const key of bucketKeys) {
    const [funnelId, day, variant] = key.split(':') as [string, string, string];
    const s = sessionsByDay.get(key);
    const o = ordersByDay.get(`${funnelId}:${day}`);
    const isStar = variant === '*';

    funnelIds.push(Number(funnelId));
    days.push(day);
    variants.push(variant);
    sessions.push(s?.sessions ?? 0);
    quizStarted.push(s?.quizStarted ?? 0);
    salesViews.push(s?.salesViews ?? 0);
    checkoutClicks.push(s?.checkoutClicks ?? 0);
    orders.push(isStar ? o?.orders ?? 0 : 0);
    ordersRefunded.push(isStar ? o?.ordersRefunded ?? 0 : 0);
    grossOrig.push(isStar ? o?.grossOrig ?? '0' : '0');
    refundedOrig.push(isStar ? o?.refundedOrig ?? '0' : '0');
    grossEur.push(isStar ? o?.grossEur ?? '0' : '0');
    refundedEur.push(isStar ? o?.refundedEur ?? '0' : '0');
    commissions.push(isStar ? o?.commissions ?? '0' : '0');
    commissionsEur.push(isStar ? o?.commissionsEur ?? '0' : '0');
    costs.push(isStar ? o?.costs ?? '0' : '0');
    costsEur.push(isStar ? o?.costsEur ?? '0' : '0');
    // El gasto de ads vive en su propia tabla (por día, no por venta), así que
    // se toma de su propio mapa y solo va en la fila '*'.
    const g = adsByDay.get(`${funnelId}:${day}`);
    adSpend.push(isStar ? g?.spend ?? '0' : '0');
    adSpendEur.push(isStar ? g?.spendEur ?? '0' : '0');
  }

  if (funnelIds.length > 0) {
    await q(UPSERT_SQL, [
      funnelIds, days, variants,
      sessions, quizStarted, salesViews, checkoutClicks,
      orders, ordersRefunded,
      grossOrig, refundedOrig, grossEur, refundedEur,
      commissions, commissionsEur, costs, costsEur, adSpend, adSpendEur,
    ]);
  }

  return { rows: funnelIds.length, ms: Date.now() - start };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// El regex solo atrapa la forma; un 2026-02-31 pasa el regex pero no existe
// como fecha y Postgres no lo guarda: se valida el calendario antes de
// mandarlo, igual que fetch-fx.ts.
function validateDay(day: string): void {
  const m = DAY_RE.exec(day);
  if (!m) throw new Error(`--day inválido: '${day}' (espera YYYY-MM-DD)`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new Error(`--day inválido: '${day}' no es una fecha del calendario`);
  }
}

// Aritmética de días sobre strings planos 'YYYY-MM-DD' (Date.UTC no conoce
// TZ, y los días ya están resueltos en la TZ del funnel al escribirse).
function shiftDay(day: string, delta: number): string {
  const t = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + delta);
  return new Date(t).toISOString().slice(0, 10);
}

export async function main(args: string[] = process.argv.slice(2)): Promise<RollupResult> {
  let days: number | null = null;
  let from: string | undefined;
  let to: string | undefined;
  let all = false;
  for (const a of args) {
    if (a.startsWith('--days=')) days = Number(a.slice('--days='.length));
    else if (a.startsWith('--from=')) from = a.slice('--from='.length);
    else if (a.startsWith('--to=')) to = a.slice('--to='.length);
    else if (a === '--all') all = true;
    else throw new Error(`argumento desconocido: ${a}`);
  }

  const tz = process.env.DASHBOARD_TZ ?? 'America/Argentina/Buenos_Aires';
  const todayStr = await today(tz);

  if (all) {
    from = '2000-01-01';
    to = todayStr;
  } else if (from || to) {
    if (!from || !to) throw new Error('--from y --to van juntos');
  } else {
    // Sin argumentos, los últimos 3 días: es lo que corre el cron de los
    // 10 minutos, y la corrida de verificación del task también lo usa.
    const n = days ?? 3;
    from = shiftDay(todayStr, -(n - 1));
    to = todayStr;
  }

  validateDay(from);
  validateDay(to);
  if (from > to) throw new Error(`rango inválido: from (${from}) no puede ser después de to (${to})`);

  const res = await rollupRange({ from, to });
  console.log(`rollup: ${res.rows} filas en ${res.ms} ms (${from} → ${to})`);
  return res;
}

const isMain =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main()
    .catch((err) => {
      console.error('rollup falló:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => getPool().end().catch(() => {}));
}
