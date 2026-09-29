/**
 * Aritmética de fechas del selector de período (components/RangePicker.tsx),
 * separada para testearla sin DOM.
 *
 * Todo sobre strings 'YYYY-MM-DD' y Date.UTC: son fechas de calendario, sin
 * hora ni zona, y hacerlas con el Date local correría un día en el cambio de
 * horario. El server vuelve a validar lo que llega por `?from=&to=`
 * (resolveFunnelRange), así que esto es comodidad de UI, no la defensa.
 */

export const DIA_RE = /^\d{4}-\d{2}-\d{2}$/;

export function aDia(y: number, m0: number, d: number): string {
  return new Date(Date.UTC(y, m0, d)).toISOString().slice(0, 10);
}

export function partes(dia: string): { y: number; m0: number; d: number } {
  return { y: Number(dia.slice(0, 4)), m0: Number(dia.slice(5, 7)) - 1, d: Number(dia.slice(8, 10)) };
}

/** Días entre dos fechas, contando las dos puntas: del 1 al 3 son 3. */
export function largoRango(desde: string, hasta: string): number {
  const a = partes(desde);
  const b = partes(hasta);
  return Math.round((Date.UTC(b.y, b.m0, b.d) - Date.UTC(a.y, a.m0, a.d)) / 86_400_000) + 1;
}

/**
 * Las celdas de un mes para una grilla que arranca el LUNES: `null` en los
 * huecos antes del día 1, para que el 1 caiga bajo su día de la semana.
 */
export function celdasMes(y: number, m0: number): (string | null)[] {
  const primero = new Date(Date.UTC(y, m0, 1)).getUTCDay(); // 0 = domingo
  const huecos = (primero + 6) % 7;
  const dias = new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
  const celdas: (string | null)[] = Array.from({ length: huecos }, () => null);
  for (let d = 1; d <= dias; d++) celdas.push(aDia(y, m0, d));
  return celdas;
}

/** Ordena las dos puntas: se puede clickear primero el final y después el inicio. */
export function ordenar(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MESES_LARGOS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

export function nombreMes(m0: number): string {
  return MESES_LARGOS[m0] ?? '';
}

/**
 * '12 sep – 28 sep' para el botón del header. El año sólo aparece si alguna
 * punta no es del año de `hoy`: casi siempre se mira el año en curso y el año
 * repetido es ruido. Un solo día se muestra solo.
 */
export function etiquetaRango(desde: string, hasta: string, hoy: string): string {
  const a = partes(desde);
  const b = partes(hasta);
  const anio = partes(hoy).y;
  const conAnio = a.y !== anio || b.y !== anio;
  const fmt = (p: { y: number; m0: number; d: number }): string =>
    `${p.d} ${MESES[p.m0]}${conAnio ? ` ${String(p.y).slice(2)}` : ''}`;
  return desde === hasta ? fmt(a) : `${fmt(a)} – ${fmt(b)}`;
}
