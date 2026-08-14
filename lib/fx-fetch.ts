import { q, q1 } from './db';

export type FxFetchResult = { rate: number; source: 'dolarapi' | 'er-api'; asOf: Date };

// Sin reintentos en el proceso: si falla, el cron del día siguiente y el
// backfill resuelven (T03 §3). 8 s de timeout para no colgar el cron con una
// fuente muerta.
const FETCH_TIMEOUT_MS = 8_000;

const DOLARAPI_URL = 'https://dolarapi.com/v1/cotizaciones/eur';
const ERAPI_URL = 'https://open.er-api.com/v6/latest/ARS';

/**
 * Sanidad: rechaza valores absurdos antes de escribir. Una API que devuelve
 * 0, null, un string o un número con la coma corrida escribiría todas las
 * ventas del día en 0 euros (o con órdenes de magnitud de error) y el reporte
 * quedaría mudo sin que nada falle: esta defensa corre antes de cada
 * escritura, en el fetcher y también en saveRate.
 */
export function assertPlausible(rate: number): void {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) {
    throw new Error(`fx: cotización absurda: ${String(rate)} (no es un número finito)`);
  }
  // Rango aceptado para ARS→EUR: entre 100 y 1.000.000 pesos por euro.
  if (!(rate > 1e-6 && rate < 1e-2)) {
    throw new Error(
      `fx: cotización absurda: ${rate} (esperada entre 1e-6 y 1e-2, o sea entre 100 y 1.000.000 ARS por EUR)`,
    );
  }
}

// La columna es numeric(20,10): el redondeo en JS tiene que matchear el de la
// columna, si no la fila guardada y la que imprime el cron no coinciden.
function round10(n: number): number {
  return Math.round(n * 1e10) / 1e10;
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} desde ${url}`);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchDolarapi(): Promise<FxFetchResult> {
  const body = await getJson(DOLARAPI_URL);
  // dolarapi devuelve "cuántos pesos vale un euro" (venta): la tabla guarda
  // lo inverso, así que se invierte. venta=0 daría Infinity y assertPlausible
  // lo frena antes de escribir.
  const venta = Number(body.venta);
  const rate = round10(1 / venta);
  assertPlausible(rate);
  const asOf = typeof body.fechaActualizacion === 'string' ? new Date(body.fechaActualizacion) : new Date();
  return { rate, source: 'dolarapi', asOf };
}

async function fetchErApi(): Promise<FxFetchResult> {
  const body = await getJson(ERAPI_URL);
  if (body.result !== 'success') throw new Error(`er-api: result='${String(body.result)}'`);
  // rates.EUR YA es "cuántos euros vale un peso": acá NO se invierte, es el
  // error fácil de este task. El test de coherencia del 5% entre fuentes es
  // el que lo atrapa si alguien lo toca.
  const eur = (body.rates as Record<string, unknown> | null | undefined)?.EUR;
  const rate = round10(Number(eur));
  assertPlausible(rate);
  const unix = Number(body.time_last_update_unix);
  const asOf = Number.isFinite(unix) ? new Date(unix * 1000) : new Date();
  return { rate, source: 'er-api', asOf };
}

/** Pide la cotización a la fuente primaria; si falla, a la de respaldo. */
export async function fetchRate(fxSource: string): Promise<FxFetchResult> {
  if (fxSource !== 'oficial') {
    // La paridad vía blue necesita una fórmula de dos saltos (EUR/USD) que
    // cambia todos los números de ventas del panel: es una decisión del
    // negocio (P-01 del plan), no del código. Se tira claro y el script deja
    // la huella en ingest_errors para que el usuario lo vea en el panel.
    throw new Error(
      `unsupported_fx_source: settings.fx_source='${fxSource}' (solo se implementa 'oficial', ver P-01 del plan)`,
    );
  }
  try {
    return await fetchDolarapi();
  } catch (dolarapiErr) {
    // Una respuesta 200 con un valor absurdo es un fallo de la fuente, igual
    // que un 500: se cae al respaldo para escribir el dato bueno en vez de
    // dejar el día vacío.
    try {
      return await fetchErApi();
    } catch (erApiErr) {
      const d = dolarapiErr instanceof Error ? dolarapiErr.message : String(dolarapiErr);
      const e = erApiErr instanceof Error ? erApiErr.message : String(erApiErr);
      throw new Error(`no se pudo obtener la cotización (dolarapi: ${d}; er-api: ${e})`);
    }
  }
}

/** Guarda (o pisa) la fila del día. */
export async function saveRate(day: string, rate: number, source: string): Promise<void> {
  assertPlausible(rate);
  // Una fila manual es una decisión del usuario y le gana al cron (D13): se
  // verifica antes del INSERT y ni siquiera --force la pisa (T03 §3).
  const existing = await q1<{ source: string }>(
    `SELECT source FROM fx_rates WHERE day = $1 AND base = $2 AND quote = $3`,
    [day, 'ARS', 'EUR'],
  );
  if (existing?.source === 'manual') return;
  await q(
    `INSERT INTO fx_rates (day, base, quote, rate, source, fetched_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (day, base, quote)
     DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source, fetched_at = now()`,
    [day, 'ARS', 'EUR', rate, source],
  );
}
