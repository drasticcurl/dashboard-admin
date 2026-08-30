#!/usr/bin/env node
/**
 * Carga cotizaciones ARS→moneda de reporte de días YA PASADOS, para que el
 * histórico
 * importado (el CSV de Shopify arranca el 2026-06-02) tenga importe en euros.
 *
 * Por qué existe aparte de fetch-fx.ts: ese script pide la cotización de HOY.
 * Su `--day` solo elige en qué fila la escribe, así que usarlo para junio
 * escribiría el valor de hoy con fecha de junio, que es exactamente lo que no
 * queremos (un reporte de junio tiene que estar en la cotización de junio).
 *
 * De dónde sale el número, en dos saltos:
 *   1. ARS por USD oficial del día → api.argentinadatos.com (histórico del BNA,
 *      con los fines de semana ya arrastrados desde el viernes).
 *   2. EUR por USD del día → api.frankfurter.dev (referencia del BCE).
 *   rate = (1 / ventaUSD) * eurPorUsd
 *
 * Ninguna fuente gratis publica la pizarra en EUROS del BNA por fecha; el
 * dólar sí. El cruce por dólar da ~1,5% más de pesos por euro que la pizarra
 * de euros de dolarapi (12/08: 1748 vs 1721, porque el BNA le pone otro spread
 * al euro). Ese 1,5% se deja como está a propósito: NO se calibra con un
 * factor sacado de un día, porque un factor inventado parece más preciso de lo
 * que es. Se guarda con source='oficial-usd-ecb' para que en /config se vea de
 * dónde salió cada fila y no se confunda con las del cron.
 *
 * El BCE no publica sábados, domingos ni feriados suyos: para esos días se
 * arrastra el último cruce publicado (misma convención que ya usa la fuente
 * del peso). Se informa cuántos días salieron arrastrados.
 *
 * NUNCA pisa una fila existente, de ninguna fuente: si un día ya tiene
 * cotización (del cron o cargada a mano por el usuario), se saltea.
 *
 * Uso: tsx scripts/backfill-fx-historico.ts [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--dry-run]
 * Sin --from/--to toma el rango de las ventas que están sin convertir.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPool, q, q1, tx } from '../lib/db';
import { assertPlausible } from '../lib/fx-fetch';
import { MONEDA_REPORTE } from '../lib/moneda-reporte';

// tsx no carga .env solo; en dev el env vive en el archivo, en producción
// viene de PM2 y no existe (process.loadEnvFile es de Node >= 20.12).
const envPath = path.join(process.cwd(), '.env');
if (typeof process.loadEnvFile === 'function' && existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const AD_URL = 'https://api.argentinadatos.com/v1/cotizaciones/dolares/oficial';
const ECB_URL = 'https://api.frankfurter.dev/v1';
const FETCH_TIMEOUT_MS = 30_000;

/** Etiqueta de procedencia: la fila se calculó con USD del BNA y cruce del BCE. */
// La etiqueta dice cuantos saltos se usaron, y eso depende de la moneda de
// reporte: para dolares el BNA ya publica ARS/USD y no hay cruce del BCE.
// Queda en la columna `source` de fx_rates para que en Config se vea de donde
// salio cada fila.
export const SOURCE_LABEL = MONEDA_REPORTE === 'USD' ? 'oficial-usd' : 'oficial-usd-ecb';

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

// pg devuelve `date` como Date local; se recompone con los componentes locales
// porque toISOString correría un día en una máquina con TZ negativa.
function dayStr(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** Días calendario de `from` a `to`, inclusive. En UTC para que no salte con el DST. */
export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!(start <= end)) throw new Error(`rango vacío: --from=${from} es posterior a --to=${to}`);
  for (let t = start; t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

function round10(n: number): number {
  return Math.round(n * 1e10) / 1e10;
}

function fmtRate(rate: number): string {
  return rate.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
}

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} desde ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Se usan objetos planos y no Map porque el tsconfig no habilita
// downlevelIteration y recorrer un Map rompe el build.
type DayMap = Record<string, number>;

/** ARS por USD (venta) del dólar oficial, por día. */
export async function fetchUsdArs(): Promise<DayMap> {
  const body = await getJson(AD_URL);
  if (!Array.isArray(body)) throw new Error(`argentinadatos: respuesta inesperada (no es un array)`);
  const out: DayMap = {};
  for (const row of body as Array<Record<string, unknown>>) {
    const fecha = typeof row.fecha === 'string' ? row.fecha : null;
    const venta = Number(row.venta);
    // Una fila con venta 0 o basura daría Infinity al invertirla: se descarta
    // acá y el día queda como faltante, que es visible, en vez de escribir un
    // número absurdo.
    if (fecha && DAY_RE.test(fecha) && Number.isFinite(venta) && venta > 0) out[fecha] = venta;
  }
  if (Object.keys(out).length === 0) throw new Error('argentinadatos: no vino ninguna cotización usable');
  return out;
}

/** EUR por USD del BCE, por día hábil, en el rango pedido. */
export async function fetchEurUsd(from: string, to: string): Promise<DayMap> {
  // El BCE publica el cruce del día alrededor de las 16:00 CET: se pide desde
  // 10 días antes de `from` para tener de dónde arrastrar si el primer día del
  // rango cae fin de semana o feriado.
  const pad = new Date(Date.parse(`${from}T00:00:00Z`) - 10 * 86_400_000).toISOString().slice(0, 10);
  const body = await getJson(`${ECB_URL}/${pad}..${to}?base=USD&symbols=EUR`);
  const rates = (body as Record<string, unknown>).rates;
  if (!rates || typeof rates !== 'object') throw new Error('frankfurter: respuesta sin "rates"');
  const out: DayMap = {};
  for (const [day, v] of Object.entries(rates as Record<string, unknown>)) {
    const eur = Number((v as Record<string, unknown> | null)?.EUR);
    if (DAY_RE.test(day) && Number.isFinite(eur) && eur > 0) out[day] = eur;
  }
  if (Object.keys(out).length === 0) throw new Error('frankfurter: no vino ningún cruce EUR/USD');
  return out;
}

/**
 * Último valor disponible en `map` para `day` o, si no hay, el del día anterior
 * más cercano (hasta `maxBack` días atrás). Devuelve también de qué día salió,
 * para poder informar cuántas filas quedaron arrastradas.
 */
export function lookupCarry(map: DayMap, day: string, maxBack = 10): { value: number; fromDay: string } | null {
  let t = Date.parse(`${day}T00:00:00Z`);
  for (let i = 0; i <= maxBack; i += 1) {
    const d = new Date(t).toISOString().slice(0, 10);
    const v = map[d];
    if (v !== undefined) return { value: v, fromDay: d };
    t -= 86_400_000;
  }
  return null;
}

export type HistoricoResult = {
  inserted: number;
  skipped: number;
  missing: string[];
  carried: number;
  from: string;
  to: string;
};

export async function runHistorico(opts: {
  from?: string;
  to?: string;
  dryRun: boolean;
}): Promise<HistoricoResult | null> {
  let { from, to } = opts;

  // Sin rango explícito: el de las ventas que todavía no tienen euros. Así el
  // script es idempotente y no hay que acordarse de las fechas del CSV.
  if (!from || !to) {
    const r = await q1<{ min_day: Date | string | null; max_day: Date | string | null }>(
      `SELECT min(day) AS min_day, max(day) AS max_day FROM orders
       WHERE currency <> $1 AND (amount_eur IS NULL OR fx_stale = true)`,
      [MONEDA_REPORTE],
    );
    if (!r?.min_day || !r?.max_day) {
      console.log('fx histórico: no hay ventas sin convertir, nada que hacer');
      return null;
    }
    from = from ?? dayStr(r.min_day);
    to = to ?? dayStr(r.max_day);
  }
  validateDay(from, '--from');
  validateDay(to, '--to');

  const days = dayRange(from, to);

  // Se saltean de entrada los días que ya tienen fila: no se pisa ni la del
  // cron ni la que el usuario cargó a mano.
  const existingRows = await q<{ day: Date | string }>(
    `SELECT day FROM fx_rates WHERE base = 'ARS' AND quote = $3 AND day BETWEEN $1 AND $2`,
    [from, to, MONEDA_REPORTE],
  );
  const existing: Record<string, true> = {};
  for (const row of existingRows) existing[dayStr(row.day)] = true;

  // Para USD el segundo salto NO EXISTE: `fetchUsdArs` ya devuelve pesos por
  // dolar, que es exactamente el par que hay que guardar. Pedirle el cruce
  // EUR/USD al BCE y multiplicar daria un rate ARS->EUR archivado bajo
  // quote='USD' (saveRate usa MONEDA_REPORTE), o sea el histórico entero mal por
  // un ~13% sin que nada falle.
  const usdArs = await fetchUsdArs();
  const eurUsd = MONEDA_REPORTE === 'EUR' ? await fetchEurUsd(from, to) : null;

  const todo: Array<{ day: string; rate: number; usd: number; usdDay: string; ecbDay: string }> = [];
  const missing: string[] = [];
  let skipped = 0;
  let carried = 0;

  for (const day of days) {
    if (existing[day]) {
      skipped += 1;
      continue;
    }
    const usd = lookupCarry(usdArs, day);
    // Con USD no hay segundo salto: se usa un factor 1 para que el resto del
    // cuerpo (el arrastre, el dry-run, el reporte) no necesite ramas.
    const ecb = eurUsd ? lookupCarry(eurUsd, day) : { value: 1, fromDay: day };
    if (!usd || !ecb) {
      missing.push(day);
      continue;
    }
    const rate = round10((1 / usd.value) * ecb.value);
    try {
      assertPlausible(rate);
    } catch (err) {
      // Un valor fuera de rango es un problema de la fuente, no un día sin
      // dato: se anota para que quede visible y se sigue con el resto.
      console.error(`fx histórico ${day}: ${err instanceof Error ? err.message : err}`);
      missing.push(day);
      continue;
    }
    if (usd.fromDay !== day || ecb.fromDay !== day) carried += 1;
    todo.push({ day, rate, usd: usd.value, usdDay: usd.fromDay, ecbDay: ecb.fromDay });
  }

  if (opts.dryRun) {
    for (const t of todo) {
      const arsPorEur = 1 / t.rate;
      const nota =
        t.usdDay !== t.day || t.ecbDay !== t.day
          ? MONEDA_REPORTE === 'EUR'
            ? ` [arrastre usd=${t.usdDay} bce=${t.ecbDay}]`
            : ` [arrastre usd=${t.usdDay}]`
          : '';
      console.log(
        `[dry-run] ${t.day} ARS→${MONEDA_REPORTE} ${fmtRate(t.rate)} ` +
          `(1 ${MONEDA_REPORTE} = ${arsPorEur.toFixed(2)} ARS, USD ${t.usd})${nota}`,
      );
    }
  } else if (todo.length > 0) {
    // Todo el rango en una transacción: media carga dejaría el reporte con
    // unos días en euros y otros no, que es más difícil de detectar que cero.
    await tx(async (c) => {
      for (const t of todo) {
        await c.query(
          `INSERT INTO fx_rates (day, base, quote, rate, source, fetched_at)
           VALUES ($1, 'ARS', $4, $2, $3, now())
           ON CONFLICT (day, base, quote) DO NOTHING`,
          [t.day, t.rate, SOURCE_LABEL, MONEDA_REPORTE],
        );
      }
    });
  }

  const verbo = opts.dryRun ? 'cargaría' : 'cargó';
  console.log(
    `fx histórico ${from}..${to}: ${verbo} ${todo.length} días (${carried} con arrastre de fin de semana/feriado), ` +
      `${skipped} ya tenían cotización, ${missing.length} sin fuente`,
  );
  if (missing.length > 0) console.log(`  días sin fuente: ${missing.join(', ')}`);

  return { inserted: opts.dryRun ? 0 : todo.length, skipped, missing, carried, from, to };
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
  await runHistorico({ from, to, dryRun });
}

const isMain =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main()
    .catch((err) => {
      console.error('backfill-fx-historico falló:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => getPool().end().catch(() => {}));
}
