/**
 * La Zona_Cuenta y su default, en UN solo lugar.
 *
 * Existe por un bug real: el default estaba escrito en lib/queries/ads.ts, en
 * lib/ads/alcance.ts y en lib/ads/acciones.ts, y `repo.zonasDeCuentas` además
 * filtraba `timezone IS NOT NULL` en lugar de aplicar el default. Una cuenta con
 * `timezone` en NULL más una en Buenos Aires le parecía UNA zona al ejecutor y
 * DOS al lector de métricas.
 *
 * Este módulo es puro: sólo Intl. No importa `lib/db` ni `lib/ads/meta`.
 */

/**
 * Zona que se usa cuando `ad_accounts.timezone` está en NULL (P-A03): no se
 * asume UTC en silencio. Se devuelve en `ResultadoMetricas.rango.timezone` y en
 * `CuentaAds.timezone` para que la pantalla lo muestre.
 *
 * ES LA ÚNICA DEFINICIÓN DE ESTE VALOR EN `lib/`. Si aparece una segunda, el
 * ejecutor y el lector pueden volver a discrepar sobre la zona de una cuenta.
 */
export const TZ_DEFAULT = 'Europe/Lisbon';

/**
 * La hora de pared en una zona, como 'HH:MM' de 24 horas con relleno de cero.
 * La comparación lexicográfica de dos strings así es una comparación correcta de
 * reloj, que es lo que `dentroDeVentana` necesita.
 *
 * Se mueve acá desde `ejecutor.ts` para poder probarla contra PostgreSQL sin
 * arrastrar la base ni Meta (Property 1).
 */
export function horaLocalEn(tz: string, fecha: Date): string {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: tz,
  });
  const partes = fmt.formatToParts(fecha);
  const hh = partes.find((p) => p.type === 'hour')?.value ?? '00';
  const mm = partes.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hh}:${mm}`;
}
