import { q, q1 } from './db';
import { MONEDA_REPORTE, type MonedaReporte } from './moneda-reporte';

export type FxFetchResult = { rate: number; source: 'dolarapi' | 'er-api'; asOf: Date };

// Sin reintentos en el proceso: si falla, el cron del día siguiente y el
// backfill resuelven (T03 §3). 8 s de timeout para no colgar el cron con una
// fuente muerta.
const FETCH_TIMEOUT_MS = 8_000;

/**
 * Endpoint de la fuente primaria por moneda de reporte.
 *
 * Los dos devuelven la MISMA forma (`{ venta, fechaActualizacion }`, con
 * `venta` = cuántos pesos vale una unidad), así que `fetchDolarapi` no necesita
 * ramas: solo cambia la URL. Ojo que son dos familias distintas de ruta en la
 * API — `/cotizaciones/<moneda>` para el euro y `/dolares/<casa>` para el
 * dólar — y no se pueden generar concatenando el código de moneda.
 */
const DOLARAPI_URL: Record<MonedaReporte, string> = {
  EUR: 'https://dolarapi.com/v1/cotizaciones/eur',
  USD: 'https://dolarapi.com/v1/dolares/oficial',
};

// Respaldo: devuelve un objeto `rates` con TODAS las monedas contra la base que
// se pide en la ruta, así que la misma URL sirve para las dos monedas de reporte
// y lo único que cambia es qué clave se lee.
//
// Esta familia de ruta SÍ se genera concatenando el código de moneda (a
// diferencia de dolarapi, ver el comentario de DOLARAPI_URL): es la que usa
// `fetchParidad` para los pares que no salen del peso.
function erApiUrl(base: string): string {
  return `https://open.er-api.com/v6/latest/${base}`;
}

/**
 * Sanidad: rechaza valores absurdos antes de escribir. Una API que devuelve
 * 0, null, un string o un número con la coma corrida escribiría todas las
 * ventas del día en 0 (o con órdenes de magnitud de error) y el reporte
 * quedaría mudo sin que nada falle: esta defensa corre antes de cada
 * escritura, en el fetcher y también en saveRate.
 *
 * LA BANDA SIRVE PARA LAS DOS MONEDAS, y no por casualidad: el euro y el dólar
 * están en el mismo orden de magnitud contra el peso (hoy ~1753 y ~1535 pesos
 * respectivamente, o sea rates de 5,7e-4 y 6,5e-4), y la banda cubre de 100 a
 * 1.000.000 pesos por unidad. Lo que NO hace es distinguir un par del otro: un
 * rate ARS→USD pasa igual el chequeo escrito para ARS→EUR. Esa confusión la
 * ataja `saveRate`, que escribe el `quote` desde MONEDA_REPORTE y no desde lo
 * que devolvió la fuente.
 */
export function assertPlausible(rate: number): void {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) {
    throw new Error(`fx: cotización absurda: ${String(rate)} (no es un número finito)`);
  }
  if (!(rate > 1e-6 && rate < 1e-2)) {
    throw new Error(
      `fx: cotización absurda: ${rate} (esperada entre 1e-6 y 1e-2, o sea entre 100 y ` +
        `1.000.000 ARS por ${MONEDA_REPORTE})`,
    );
  }
}

/**
 * Sanidad de un par que NO sale del peso (hoy USD→EUR, el de las ventas LATAM).
 *
 * POR QUÉ NO SIRVE LA BANDA DE `assertPlausible`
 * Está escrita para el peso: 1 ARS son ~5,7e-4 EUR. Un USD→EUR de 0,86 la
 * dispararía y el cron nunca escribiría la fila.
 *
 * Y POR QUÉ ESTA BANDA ES TAN ANCHA, QUE ES LO QUE IMPORTA
 * Entre dos monedas que están a la par, una banda NO PUEDE atrapar el error
 * grave de este archivo, que es invertir el valor: 1/0,862246 = 1,16 y pasa
 * cualquier banda razonable. Lo que lo ataja es `base_code` en `fetchParidad`
 * — la fuente dice contra qué moneda está expresado el objeto `rates`, y si no
 * es la que pedimos se tira. Esta banda cubre lo otro: un 0, un null, un string
 * que se vuelve NaN, o una coma corrida de varios órdenes de magnitud.
 */
export function assertPlausibleParidad(base: string, rate: number): void {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) {
    throw new Error(`fx: cotización absurda para ${base}→${MONEDA_REPORTE}: ${String(rate)} (no es un número finito)`);
  }
  if (!(rate > 1e-4 && rate < 1e4)) {
    throw new Error(
      `fx: cotización absurda para ${base}→${MONEDA_REPORTE}: ${rate} (esperada entre 1e-4 y 1e4)`,
    );
  }
}

/**
 * La banda que corresponde a la base: el peso tiene la suya porque su orden de
 * magnitud es otro. Un solo punto de despacho para que `saveRate` no tenga que
 * saber de qué par se trata.
 */
export function assertPlausibleDe(base: string, rate: number): void {
  if (base.toUpperCase() === 'ARS') {
    assertPlausible(rate);
    return;
  }
  assertPlausibleParidad(base.toUpperCase(), rate);
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
  const body = await getJson(DOLARAPI_URL[MONEDA_REPORTE]);
  // dolarapi devuelve "cuántos pesos vale una unidad" (venta): la tabla guarda
  // lo inverso, así que se invierte. venta=0 daría Infinity y assertPlausible
  // lo frena antes de escribir.
  const venta = Number(body.venta);
  const rate = round10(1 / venta);
  assertPlausible(rate);
  const asOf = typeof body.fechaActualizacion === 'string' ? new Date(body.fechaActualizacion) : new Date();
  return { rate, source: 'dolarapi', asOf };
}

async function fetchErApi(): Promise<FxFetchResult> {
  const body = await getJson(erApiUrl('ARS'));
  if (body.result !== 'success') throw new Error(`er-api: result='${String(body.result)}'`);
  // rates[MONEDA] YA es "cuántas unidades de esa moneda vale un peso": acá NO se
  // invierte, es el error fácil de este archivo (la fuente primaria sí se
  // invierte, dos líneas arriba). El test de coherencia del 5% entre las dos
  // fuentes es el que lo atrapa si alguien lo toca.
  const valor = (body.rates as Record<string, unknown> | null | undefined)?.[MONEDA_REPORTE];
  const rate = round10(Number(valor));
  assertPlausible(rate);
  const unix = Number(body.time_last_update_unix);
  const asOf = Number.isFinite(unix) ? new Date(unix * 1000) : new Date();
  return { rate, source: 'er-api', asOf };
}

/**
 * Cotización de `base` → moneda de reporte para un par que no sale del peso.
 *
 * ── POR QUÉ EXISTE ────────────────────────────────────────────────────────
 * `fetchRate` archiva un solo par: ARS→moneda de reporte. El funnel
 * `chauhinchazon-latam` vende en USD (Hotmart y el checkout propio), así que sus
 * ventas llamaban a `getRate(day, 'USD', 'EUR')` contra una tabla que no tiene
 * ni una fila de ese par: entraban con `amount_eur = NULL` y `fx_stale = true`,
 * y el funnel mostraba €0 de ingresos con ventas reales adentro. Lo mismo del
 * otro lado: el gasto de una campaña LATAM se lee contra `f.sell_currency`, así
 * que sin la fila USD→EUR la columna en moneda del funnel daba 0.
 *
 * ── POR QUÉ er-api Y NO EL CRUCE VÍA PESO ─────────────────────────────────
 * Se podría calcular USD→EUR dividiendo los dos valores de dolarapi
 * (pesos por dólar ÷ pesos por euro). Se descartó: ese cruce le mete el spread
 * del mercado argentino a una venta que se cobró en dólares en Hotmart y se
 * consolida en euros — dos monedas que nunca pasaron por un peso. El valor de
 * esa venta quedaría atado a qué tan abierta está la brecha ese día. er-api
 * publica la paridad directa, que es la que corresponde.
 *
 * ── NO TIENE FUENTE DE RESPALDO, A PROPÓSITO ──────────────────────────────
 * dolarapi solo cotiza contra el peso: no hay segunda fuente para este par sin
 * agregar otro proveedor. Si er-api falla, el día queda sin fila y las ventas de
 * ese día quedan con `fx_stale = true` hasta que el backfill del cron siguiente
 * las complete — que es exactamente el comportamiento que ya tiene el par del
 * peso cuando sus dos fuentes fallan.
 */
export async function fetchParidad(base: string): Promise<FxFetchResult> {
  const b = base.toUpperCase();
  if (b === MONEDA_REPORTE) {
    throw new Error(`fx: ${b} es la moneda de reporte, no necesita cotización`);
  }
  const body = await getJson(erApiUrl(b));
  if (body.result !== 'success') throw new Error(`er-api: result='${String(body.result)}'`);
  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ ESTE CHEQUEO ES LA DEFENSA PRINCIPAL, NO UN EXTRA.                      │
  // └─────────────────────────────────────────────────────────────────────────┘
  // `rates` está expresado contra `base_code`. Si la ruta devolviera otra base
  // (un redirect, una moneda que la fuente no conoce y resuelve a USD, un typo
  // en el código de tres letras), el número seguiría siendo plausible y se
  // archivaría bajo el par equivocado sin que nada falle. Ver el comentario de
  // assertPlausibleParidad: entre monedas a la par, la banda no alcanza.
  const baseCode = String(body.base_code ?? '').toUpperCase();
  if (baseCode !== b) {
    throw new Error(`er-api: se pidió ${b} y devolvió base_code='${baseCode}'`);
  }
  // Igual que en fetchErApi: `rates[X]` ya es "cuántas unidades de X vale 1 de
  // la base". NO se invierte.
  const valor = (body.rates as Record<string, unknown> | null | undefined)?.[MONEDA_REPORTE];
  if (valor === undefined || valor === null) {
    throw new Error(`er-api: la respuesta de ${b} no trae rates.${MONEDA_REPORTE}`);
  }
  const rate = round10(Number(valor));
  assertPlausibleParidad(b, rate);
  const unix = Number(body.time_last_update_unix);
  const asOf = Number.isFinite(unix) ? new Date(unix * 1000) : new Date();
  return { rate, source: 'er-api', asOf };
}

/**
 * Las monedas que hay que cotizar además del peso: las `sell_currency` de los
 * funnels activos, sin ARS (la trae la fuente primaria) y sin la moneda de
 * reporte (que no necesita conversión: `toReportCurrency` la corta antes).
 *
 * Sale de la base y no de una lista en el código para que agregar un funnel que
 * venda en otra moneda no requiera tocar el fetcher. Y por eso mismo la
 * instancia de infinix (moneda de reporte USD, funnels en ARS) devuelve un array
 * vacío y queda byte-idéntica a como estaba.
 */
export async function monedasDeVentaAExtraer(): Promise<string[]> {
  const rows = await q<{ base: string }>(
    `SELECT DISTINCT upper(sell_currency) AS base
       FROM funnels
      WHERE active
        AND sell_currency IS NOT NULL
        AND upper(sell_currency) NOT IN ('ARS', $1)
      ORDER BY 1`,
    [MONEDA_REPORTE],
  );
  return rows.map((r) => r.base);
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

/**
 * Guarda (o pisa) la fila del día para el par `base` → moneda de reporte.
 *
 * El `quote` sale de MONEDA_REPORTE y no de lo que devolvió la fuente: es el
 * único lugar donde se decide bajo qué par se archiva la cotización, así que un
 * cambio de moneda no puede dejar filas mezcladas en la misma clave.
 *
 * `base` es el ÚLTIMO parámetro y con default 'ARS' para no tocar los tres
 * llamadores que ya existían: el par del peso sigue escribiéndose igual.
 * SIEMPRE se guarda en mayúscula — `funnels.sell_currency` es 'USD' y las
 * queries del rollup y de Ventas unen `fx_rates.base = f.sell_currency`, así que
 * una fila 'usd' no matchea con nada y la conversión queda en 0 sin ningún error
 * a la vista (fue exactamente lo que pasó con la fila cargada a mano el
 * 2026-09-14).
 */
export async function saveRate(day: string, rate: number, source: string, base = 'ARS'): Promise<void> {
  const b = base.toUpperCase();
  assertPlausibleDe(b, rate);
  // Una fila manual es una decisión del usuario y le gana al cron (D13): se
  // verifica antes del INSERT y ni siquiera --force la pisa (T03 §3).
  const existing = await q1<{ source: string }>(
    `SELECT source FROM fx_rates WHERE day = $1 AND base = $2 AND quote = $3`,
    [day, b, MONEDA_REPORTE],
  );
  if (existing?.source === 'manual') return;
  await q(
    `INSERT INTO fx_rates (day, base, quote, rate, source, fetched_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (day, base, quote)
     DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source, fetched_at = now()`,
    [day, b, MONEDA_REPORTE, rate, source],
  );
}
