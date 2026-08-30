import { q1 } from './db';
import { MONEDA_REPORTE } from './moneda-reporte';

export type FxLookup = { rate: number; day: string; stale: boolean; source: string };

/**
 * La conversión se hace en el momento de la ingesta y se congela en la fila
 * (D12/D13): un reporte de marzo no puede cambiar porque hoy se movió el
 * dólar. Acá vive solo la lectura; el fetcher que escribe fx_rates lo escribe
 * T03.
 *
 * La moneda destino sale de `MONEDA_REPORTE` (env `NEXT_PUBLIC_REPORT_CURRENCY`,
 * default EUR): `getRate` siempre fue paramétrico en base/quote, lo que estaba
 * hardcodeado era el destino que le pasaba `toReportCurrency`.
 */

/**
 * Cotización para un día. Si no existe la del día pedido, devuelve la más
 * reciente anterior con stale=true. Si no hay ninguna, devuelve null: el
 * llamador guarda la venta sin amount_eur, nunca la descarta.
 */
export async function getRate(day: string, base: string, quote: string): Promise<FxLookup | null> {
  // Dos subconsultas de una fila cada una unidas con FULL OUTER JOIN: el día
  // exacto gana; si no existe, cae a la última anterior. COALESCE no alcanza
  // sin saber cuál de las dos filas es la buena, y el flag stale sale de ahí.
  const row = await q1<{ rate: string | null; day: string | null; source: string | null; stale: boolean }>(
    `SELECT COALESCE(dr.rate, lr.rate)::text AS rate,
            COALESCE(dr.day, lr.day)::text AS day,
            COALESCE(dr.source, lr.source) AS source,
            (dr.rate IS NULL AND lr.rate IS NOT NULL) AS stale
     FROM (SELECT rate, day, source FROM fx_rates
           WHERE day = $1 AND base = $2 AND quote = $3) AS dr
     FULL OUTER JOIN (SELECT rate, day, source FROM fx_rates
                      WHERE base = $2 AND quote = $3 AND day < $1
                      ORDER BY day DESC LIMIT 1) AS lr ON true
     LIMIT 1`,
    [day, base, quote],
  );
  if (!row || row.rate === null) return null;
  return { rate: Number(row.rate), day: row.day!, stale: row.stale, source: row.source! };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Convierte a la MONEDA DE REPORTE y redondea a 2 decimales. Null si no hay
 * cotización, y en ese caso el llamador guarda la venta sin el monto convertido
 * (nunca la descarta).
 *
 * El nombre del campo que devuelve sigue siendo `amountEur` porque así se llama
 * la columna en la base: ver `SUFIJO_COLUMNA_REPORTE` en lib/moneda-reporte.ts
 * para por qué no se renombraron. Con MONEDA_REPORTE='USD' este número son
 * dólares.
 */
export async function toReportCurrency(
  amount: number,
  currency: string,
  day: string,
): Promise<{ amountEur: number; rate: number; fxDay: string; stale: boolean } | null> {
  // Una venta que ya está en la moneda de reporte no necesita cotización: sin
  // este corto circuito, un funnel que venda en la moneda de reporte quedaría
  // esperando una fila ARS→X que nadie escribe.
  if (currency === MONEDA_REPORTE) {
    return { amountEur: round2(amount), rate: 1, fxDay: day, stale: false };
  }
  const fx = await getRate(day, currency, MONEDA_REPORTE);
  if (!fx) return null;
  return { amountEur: round2(amount * fx.rate), rate: fx.rate, fxDay: fx.day, stale: fx.stale };
}
