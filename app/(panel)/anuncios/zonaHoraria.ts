'use client';

/**
 * Utilidades de Zona_Cuenta para el CLIENTE. La aritmética definitiva de las
 * fechas vive en PostgreSQL (`lib/ads/programacion.ts`, `lib/day.ts`): esto es
 * SOLO para proponer el valor por defecto del formulario (mañana a las 00:00 en
 * la Zona_Cuenta, R11 c2) y para armar el ISO con desplazamiento explícito que
 * el Endpoint_Acciones revalida y resuelve del lado del servidor (R11 c4).
 */

/** Mañana, como 'YYYY-MM-DD', en la Zona_Cuenta. */
export function mananaMedianocheLocal(zona: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: zona,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const manana = new Date(Date.now() + 24 * 3600 * 1000);
  return fmt.format(manana);
}

/** El desplazamiento horario (minutos) de la zona para una fecha local. */
function offsetMinutos(zona: string, fechaLocal: string, horaLocal: string): number {
  const comoUTC = Date.parse(`${fechaLocal}T${horaLocal}:00Z`);
  if (Number.isNaN(comoUTC)) return 0;
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: zona,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(comoUTC));
  const mapa = new Map(partes.map((p) => [p.type, p.value]));
  const pared = Date.UTC(
    Number(mapa.get('year')),
    Number(mapa.get('month')) - 1,
    Number(mapa.get('day')),
    Number(mapa.get('hour')),
    Number(mapa.get('minute')),
  );
  return Math.round((pared - comoUTC) / 60_000);
}

/** `fecha` + `hora` locales en la Zona_Cuenta → ISO 8601 con offset explícito
 *  y segundos en 00 (R11 c4). La autoridad final es el servidor. */
export function isoConOffset(zona: string, fecha: string, hora: string): string {
  const off = offsetMinutos(zona, fecha, hora);
  const signo = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${fecha}T${hora}:00${signo}${hh}:${mm}`;
}
