#!/usr/bin/env node
/**
 * Rollup de Finanzas (plan FINANZAS §5) — recalcula el profit diario en
 * finance_daily_profit desde daily_metrics (TODOS los funnels, sin filtrar
 * por funnel_id: Finanzas es siempre global).
 *
 * Uso (declarado en package.json por T01):
 *   npm run finance:rollup            # recalcula ayer y hoy (2 días)
 *   npm run finance:rollup -- --all   # reconstruye todo desde el primer dato
 *
 * El cron de producción corre DESPUÉS del rollup nocturno de daily_metrics
 * (que a su vez corre después de fetch-fx): si corriera antes, el profit se
 * calcularía con datos de la corrida anterior, hasta 24 h viejos.
 *
 * RECALCULA, no acumula: el ON CONFLICT pisa el valor del día, igual que
 * scripts/rollup.ts. Un día con amount_eur negativo es un día real (se gastó
 * más en ads de lo que entró) y se guarda tal cual.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPool, q } from '../lib/db';
import { today } from '../lib/day';

// tsx no carga .env solo; en dev el env vive en el archivo, en producción
// viene de PM2 y no existe (process.loadEnvFile es de Node >= 20.12).
const envPath = path.join(process.cwd(), '.env');
if (typeof process.loadEnvFile === 'function' && existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

export type FinanceRollupResult = { rows: number; ms: number };

// La misma aritmética que el Resumen (bruto − devuelto − comisiones − costos
// − ads), agregada por día y SIN filtrar por funnel: es la suma de TODOS los
// funnels (verificada en fase 3, #15).
const PROFIT_SQL = `
  SELECT day::text AS day,
         (COALESCE(SUM(revenue_gross_eur), 0)
        - COALESCE(SUM(revenue_refunded_eur), 0)
        - COALESCE(SUM(commissions_eur), 0)
        - COALESCE(SUM(costs_eur), 0)
        - COALESCE(SUM(ad_spend_eur), 0))::text AS profit_eur
  FROM daily_metrics
  WHERE variant = '*' AND day BETWEEN $1::date AND $2::date
  GROUP BY day
  ORDER BY day`;

const UPSERT_SQL = `
  INSERT INTO finance_daily_profit (day, amount_eur)
  VALUES ($1::date, $2::numeric)
  ON CONFLICT (day) DO UPDATE SET
    amount_eur = EXCLUDED.amount_eur,
    computed_at = now()`;

/** Recalcula finance_daily_profit para [from, to]. Devuelve cuántas filas escribió. */
export async function financeRollupRange(opts: { from: string; to: string }): Promise<FinanceRollupResult> {
  const start = Date.now();
  const rows = await q<{ day: string; profit_eur: string }>(PROFIT_SQL, [opts.from, opts.to]);
  for (const r of rows) {
    await q(UPSERT_SQL, [r.day, r.profit_eur]);
  }
  return { rows: rows.length, ms: Date.now() - start };
}

// Aritmética de días sobre strings planos 'YYYY-MM-DD' (Date.UTC no conoce
// TZ, y los días ya vienen resueltos de Postgres en la TZ del dashboard).
function shiftDay(day: string, delta: number): string {
  const t = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + delta);
  return new Date(t).toISOString().slice(0, 10);
}

export async function main(args: string[] = process.argv.slice(2)): Promise<FinanceRollupResult> {
  let all = false;
  for (const a of args) {
    if (a === '--all') all = true;
    else throw new Error(`argumento desconocido: ${a}`);
  }

  const tz = process.env.DASHBOARD_TZ ?? 'America/Argentina/Buenos_Aires';
  const todayStr = await today(tz);

  // Sin argumentos, ayer y hoy (2 días, plan §5): el profit de "hoy" sigue
  // cambiando durante la día (una venta que entra a las 23:50), así que el
  // cron de la madrugada corrige el hoy-que-ya-fue y refresca el de ayer.
  const from = all ? '2000-01-01' : shiftDay(todayStr, -1);
  const to = todayStr;

  const res = await financeRollupRange({ from, to });

  // El cron SIEMPRE deja ayer y hoy registrados (T01 §6): un día sin filas en
  // daily_metrics tiene profit 0 real, no un dato inventado, y el ON CONFLICT
  // DO NOTHING garantiza que el 0 solo llena los huecos — nunca pisa el valor
  // recalculado recién. Con --all no se materializa nada (los días sin datos
  // históricos no existen y no corresponden crear filas fake desde 2001).
  if (!all) {
    await q('INSERT INTO finance_daily_profit (day, amount_eur) VALUES ($1::date, 0) ON CONFLICT (day) DO NOTHING', [from]);
    await q('INSERT INTO finance_daily_profit (day, amount_eur) VALUES ($1::date, 0) ON CONFLICT (day) DO NOTHING', [to]);
  }

  console.log(`finance-rollup: ${res.rows} días en ${res.ms} ms (${from} → ${to})`);
  return res;
}

const isMain =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main()
    .catch((err) => {
      console.error('finance-rollup falló:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => getPool().end().catch(() => {}));
}
