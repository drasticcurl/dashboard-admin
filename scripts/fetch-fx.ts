#!/usr/bin/env node
/**
 * Cron diario de la cotización ARS→moneda de reporte (T03, D12/D13 del plan).
 * El par lo decide NEXT_PUBLIC_REPORT_CURRENCY (ver lib/moneda-reporte.ts).
 *
 * Línea de cron (la instalación de la máquina la escribe T12):
 *   # Cotización ARS→moneda de reporte, todos los días a las 03:10 hora de Argentina
 *   10 3 * * * cd /srv/panel/current && /usr/bin/node scripts/fetch-fx.js >> /var/log/panel/fx.log 2>&1
 *
 * 03:10 y no medianoche: dolarapi publica el valor del día hábil y a las
 * 00:00 todavía puede tener el de ayer; además el día ya cerró en ART, así
 * que la cotización se asocia al día correcto.
 *
 * Uso: tsx scripts/fetch-fx.ts [--day=YYYY-MM-DD] [--force]
 * Exit 0 si guardó, 1 si no pudo con ninguna de las dos fuentes: ese código
 * de salida es lo que hace que el cron avise.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPool, q, q1 } from '../lib/db';
import { today } from '../lib/day';
import { fetchRate, saveRate, type FxFetchResult } from '../lib/fx-fetch';
import { MONEDA_REPORTE } from '../lib/moneda-reporte';
import { runBackfill } from './backfill-fx';

// tsx no carga .env solo; en dev el env vive en el archivo, en producción
// viene de PM2 y no existe (process.loadEnvFile es de Node >= 20.12).
const envPath = path.join(process.cwd(), '.env');
if (typeof process.loadEnvFile === 'function' && existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// El regex solo atrapa la forma; un 2026-02-31 pasa el regex pero no existe
// como fecha y Postgres no lo guarda: se valida el calendario antes de
// mandarlo, para que el error diga qué argumento está mal y no "invalid input
// syntax for type date".
function validateDay(day: string): void {
  const m = DAY_RE.exec(day);
  if (!m) throw new Error(`--day inválido: '${day}' (espera YYYY-MM-DD)`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new Error(`--day inválido: '${day}' no es una fecha del calendario`);
  }
}

// El cron y la impresión de la línea usan el mismo redondeo que la columna
// numeric(20,10): recortar los ceros finales es solo presentación.
function fmtRate(rate: number): string {
  return rate.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
}

async function readFxSource(): Promise<string> {
  const row = await q1<{ value: string }>(`SELECT value::text AS value FROM settings WHERE key = $1`, [
    'fx_source',
  ]);
  // El seed de T01 la crea, pero si no existe el default del plan (P-01) es
  // oficial y no hay que tirar el cron por eso.
  if (!row) return 'oficial';
  return JSON.parse(row.value) as string;
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const tz = process.env.DASHBOARD_TZ ?? 'America/Argentina/Buenos_Aires';

  let day: string | undefined;
  let force = false;
  for (const a of args) {
    if (a.startsWith('--day=')) day = a.slice('--day='.length);
    else if (a === '--force') force = true;
    else throw new Error(`argumento desconocido: ${a}`);
  }
  if (!day) day = await today(tz);
  validateDay(day);

  const fxSource = await readFxSource();

  let rate: FxFetchResult;
  try {
    rate = await fetchRate(fxSource);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // La configuración blue es una decisión del negocio (P-01): se falla
    // fuerte, y la huella en ingest_errors es lo que hace que el panel la
    // muestre (D20: que aparezca un warning, no que el número esté mal).
    if (msg.startsWith('unsupported_fx_source')) {
      await q(
        `INSERT INTO ingest_errors (reason, detail, payload) VALUES ($1, $2, $3)`,
        ['unsupported_fx_source', msg, { fx_source: fxSource }],
      ).catch((e) =>
        console.error('no se pudo anotar en ingest_errors:', e instanceof Error ? e.message : e),
      );
    }
    throw err;
  }

  // La fila del día ya existe: sin --force no se pisa (la PK no duplica, pero
  // reescribir una cotización ya guardada no aporta nada). La fila manual la
  // verifica de nuevo saveRate por si este chequeo se saltea algún día.
  const existing = await q1<{ source: string }>(
    `SELECT source FROM fx_rates WHERE day = $1 AND base = $2 AND quote = $3`,
    [day, 'ARS', MONEDA_REPORTE],
  );

  if (existing?.source === 'manual') {
    console.log(`fx ${day}: no se pisa la cotización manual`);
  } else if (existing && !force) {
    console.log(`fx ${day}: ya existe una fila (${existing.source}), --force para pisar`);
  } else {
    await saveRate(day, rate.rate, rate.source);
    console.log(
      `${day} ARS→${MONEDA_REPORTE} ${fmtRate(rate.rate)} (${rate.source}, 1 ${MONEDA_REPORTE} = ${(1 / rate.rate).toFixed(2)} ARS)`,
    );
  }

  // Corre también cuando el día ya estaba guardado: si la corrida anterior
  // guardó y falló antes del backfill, esto lo sana sin esperar a mañana.
  await runBackfill({ limit: 5000, dryRun: false });
}

const isMain =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main()
    .catch((err) => {
      console.error('fetch-fx falló:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => getPool().end().catch(() => {}));
}
