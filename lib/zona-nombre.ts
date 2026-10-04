/**
 * El nombre corto de una zona horaria para mostrar al lado de un "hoy". Módulo
 * PURO (sin imports) por lo mismo que `lib/funnel-nombre.ts`: lo usan
 * componentes de cliente y no pueden arrastrar `pg` al bundle.
 *
 * Existe porque el panel corta el día con dos relojes a la vez: el General en
 * Lisboa y cada funnel en la suya (Astra en Buenos Aires). Un "hoy" sin la zona
 * al lado es exactamente lo que hizo leer un ROI de 3× donde había 1,5×.
 */

const NOMBRES: Record<string, string> = {
  'Europe/Lisbon': 'Lisboa',
  'America/Argentina/Buenos_Aires': 'Buenos Aires',
  'Europe/Madrid': 'Madrid',
  'Europe/Berlin': 'Berlín',
  'America/Mexico_City': 'Ciudad de México',
  'America/Bogota': 'Bogotá',
  'America/Santiago': 'Santiago',
  'America/Lima': 'Lima',
  'America/Montevideo': 'Montevideo',
  'America/Sao_Paulo': 'São Paulo',
  UTC: 'UTC',
};

/**
 * 'Europe/Lisbon' → 'Lisboa'. Una zona que no está en la tabla se muestra por
 * su último tramo ('America/Asuncion' → 'Asuncion'): mejor un nombre en inglés
 * que el identificador entero.
 */
export function nombreZona(tz: string): string {
  return NOMBRES[tz] ?? (tz.split('/').pop() ?? tz).replace(/_/g, ' ');
}
