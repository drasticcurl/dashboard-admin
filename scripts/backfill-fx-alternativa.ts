#!/usr/bin/env node
/**
 * Carga la cotización MONEDA_ALTERNATIVA → MONEDA_REPORTE (hoy USD → EUR) de
 * días YA PASADOS, para que el switch EUR/USD del Resumen pueda convertir un
 * período viejo con la cotización de cada día y no con la de hoy.
 *
 * Por qué hace falta: el cron (fetch-fx.ts) archiva el par recién desde que
 * existe el switch, y antes sólo lo archivaba desde que el funnel LATAM empezó
 * a vender en dólares (2026-09-14). Sin esto, el Resumen de junio en dólares
 * usaría la primera cotización que haya, que es de septiembre.
 *
 * Fuente: api.frankfurter.dev (referencia del BCE), la misma que ya usa el
 * segundo salto de backfill-fx-historico.ts. El cron usa er-api para el día a
 * día; la diferencia entre las dos es de centésimas de punto y no se calibra.
 * Se guarda con source='bce' para que en /config se vea de dónde salió cada
 * fila.
 *
 * El BCE no publica fines de semana ni feriados suyos: esos días se arrastra el
 * último cruce publicado (misma convención que el script del peso).
 *
 * NUNCA pisa una fila existente, de ninguna fuente: ni la del cron ni la que el
 * usuario cargó a mano.
 *
 * Uso: tsx scripts/backfill-fx-alternativa.ts [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--dry-run]
 * Sin --from arranca en el primer día de daily_metrics; sin --to, hoy.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPool, q, q1, tx } from '../lib/db';
import { today } from '../lib/day';
import { assertPlausibleParidad } from '../lib/fx-fetch';
import { MONEDA_ALTERNATIVA, MONEDA_REPORTE } from '../lib/moneda-reporte';
import { dayRange, lookupCarry } from './backfill-fx-historico';

const envPath = path.join(process.cwd(), '.env');
if (typeof process.loadEnvFile === 'function' && existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const ECB_URL = 'https://api.frankfurter.dev/v1';
const FETCH_TIMEOUT_MS = 30_000;
export const SOURCE_LABEL = 'bce';

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validateDay(day: string, flag: string): void {
  const m = DAY_RE.exec(day);
  if (!m) throw new Error(`${flag} inválido: '${day}' (espera YYYY-MM-DD)`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new Error(`${flag} inválido: '${day}' no es una fecha del calendario`);
  }
}

function round10(n: number): number {
  return Math.round(n * 1e10) / 1e10;
}

/**
 * Unidades de MONEDA_REPORTE por 1 MONEDA_ALTERNATIVA, por día hábil del BCE.
 *
 * `base` va en la URL y la respuesta dice de vuelta contra qué base está: se
 * chequea igual que `fetchParidad` chequea `base_code`, porque entre dos
 * monedas a la par un valor invertido (1,16 en vez de 0,86) pasa cualquier
 * banda de plausibilidad.
 */
export async function fetchCruceBce(from: string, to: string): Promise<Record<string, number>> {
  const pad = new Date(Date.parse(`${from}T00:00:00Z`) - 10 * 86_400_000).toISOString().slice(0, 10);
  const url = `${ECB_URL}/${pad}..${to}?base=${MONEDA_ALTERNATIVA}&symbols=${MONEDA_REPORTE}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let body: Record<string, unknown>;
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} desde ${url}`);
    body = (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
  const base = String(body.base ?? '').toUpperCase();
  if (base !== MONEDA_ALTERNATIVA) {
    throw new Error(`frankfurter: se pidió base ${MONEDA_ALTERNATIVA} y devolvió '${base}'`);
  }
  const rates = body.rates;
  if (!rates || typeof rates !== 'object') throw new Error('frankfurter: respuesta sin "rates"');
  const out: Record<string, number> = {};
  for (const [day, v] of Object.entries(rates as Record<string, unknown>)) {
    const n = Number((v as Record<string, unknown> | null)?.[MONEDA_REPORTE]);
    if (DAY_RE.test(day) && Number.isFinite(n) && n > 0) out[day] = n;
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`frankfurter: no vino ningún cruce ${MONEDA_ALTERNATIVA}/${MONEDA_REPORTE}`);
  }
  return out;
}

export async function runAlternativa(opts: { from?: string; to?: string; dryRun: boolean }): Promise<{
  inserted: number;
  skipped: number;
  missing: string[];
  from: string;
  to: string;
} | null> {
  let { from, to } = opts;
  if (!from) {
    const r = await q1<{ d: string | null }>(`SELECT min(day)::text AS d FROM daily_metrics`);
    if (!r?.d) {
      console.log('fx alternativa: daily_metrics está vacía, nada que hacer');
      return null;
    }
    from = r.d;
  }
  if (!to) to = await today(process.env.DASHBOARD_TZ ?? 'America/Argentina/Buenos_Aires');
  validateDay(from, '--from');
  validateDay(to, '--to');

  const days = dayRange(from, to);
  const existentes = await q<{ day: string }>(
    `SELECT day::text AS day FROM fx_rates
      WHERE base = $1 AND quote = $2 AND day BETWEEN $3::date AND $4::date`,
    [MONEDA_ALTERNATIVA, MONEDA_REPORTE, from, to],
  );
  const ya: Record<string, true> = {};
  for (const r of existentes) ya[r.day] = true;

  const cruce = await fetchCruceBce(from, to);
  const todo: Array<{ day: string; rate: number; deDia: string }> = [];
  const missing: string[] = [];
  let skipped = 0;
  for (const day of days) {
    if (ya[day]) {
      skipped += 1;
      continue;
    }
    const v = lookupCarry(cruce, day);
    if (!v) {
      missing.push(day);
      continue;
    }
    const rate = round10(v.value);
    try {
      assertPlausibleParidad(MONEDA_ALTERNATIVA, rate);
    } catch (err) {
      console.error(`fx alternativa ${day}: ${err instanceof Error ? err.message : err}`);
      missing.push(day);
      continue;
    }
    todo.push({ day, rate, deDia: v.fromDay });
  }

  if (opts.dryRun) {
    for (const t of todo) {
      const nota = t.deDia !== t.day ? ` [arrastre del ${t.deDia}]` : '';
      console.log(`[dry-run] ${t.day} ${MONEDA_ALTERNATIVA}→${MONEDA_REPORTE} ${t.rate}${nota}`);
    }
  } else if (todo.length > 0) {
    await tx(async (c) => {
      for (const t of todo) {
        await c.query(
          `INSERT INTO fx_rates (day, base, quote, rate, source, fetched_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (day, base, quote) DO NOTHING`,
          [t.day, MONEDA_ALTERNATIVA, MONEDA_REPORTE, t.rate, SOURCE_LABEL],
        );
      }
    });
  }

  const verbo = opts.dryRun ? 'cargaría' : 'cargó';
  console.log(
    `fx ${MONEDA_ALTERNATIVA}→${MONEDA_REPORTE} ${from}..${to}: ${verbo} ${todo.length} días, ` +
      `${skipped} ya tenían cotización, ${missing.length} sin fuente`,
  );
  if (missing.length > 0) console.log(`  días sin fuente: ${missing.join(', ')}`);
  return { inserted: opts.dryRun ? 0 : todo.length, skipped, missing, from, to };
}

async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  let from: string | undefined;
  let to: string | undefined;
  let dryRun = false;
  for (const a of args) {
    if (a.startsWith('--from=')) from = a.slice('--from='.length);
    else if (a.startsWith('--to=')) to = a.slice('--to='.length);
    else if (a === '--dry-run') dryRun = true;
    else throw new Error(`argumento desconocido: ${a}`);
  }
  await runAlternativa({ from, to, dryRun });
}

const isMain =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main()
    .catch((err) => {
      console.error('backfill-fx-alternativa falló:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => getPool().end().catch(() => {}));
}
