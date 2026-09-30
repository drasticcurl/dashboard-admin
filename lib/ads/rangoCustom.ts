/**
 * El rango personalizado de /anuncios (`?from=YYYY-MM-DD&to=YYYY-MM-DD`), el que
 * se elige con el calendario en lugar de los períodos fijos.
 *
 * Se acota a dos bordes:
 *  · `minimo`: el primer día con ventas registradas en el panel. Antes de esa
 *    fecha no hay ventas que atribuir, así que un ROAS o un CPA de ese período
 *    sería gasto contra cero y no significaría nada.
 *  · `hoy`: no hay datos del futuro.
 *
 * Es pura (sin DB ni reloj) para que el test fije los bordes. Devuelve null
 * cuando el pedido no es un rango válido, y ahí el llamador cae al período fijo.
 */

const DIA = /^\d{4}-\d{2}-\d{2}$/;

export function resolverRangoCustom(
  from: string | null | undefined,
  to: string | null | undefined,
  hoy: string,
  minimo: string | null,
): { desde: string; hasta: string } | null {
  if (!from || !to || !DIA.test(from) || !DIA.test(to) || from > to) return null;
  const desde = minimo && from < minimo ? minimo : from;
  const hasta = to > hoy ? hoy : to;
  if (desde > hasta) return null;
  return { desde, hasta };
}
