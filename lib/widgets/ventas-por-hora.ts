/**
 * La cuenta del widget "Ventas por hora", separada del JSX para poder
 * testearla sin DOM (mismo criterio que lib/widgets/layout.ts).
 *
 * Todo es puro: recibe las 24 horas de `OverviewData.byHour` y devuelve lo que
 * el widget dibuja. No tira nunca.
 */

import type { HourPoint } from '@/lib/queries/overview';

export type MedidaHora = 'importe' | 'ordenes';

export function valorHora(h: HourPoint, medida: MedidaHora): number {
  return medida === 'importe' ? h.grossEur : h.orders;
}

export function valorPrevHora(h: HourPoint, medida: MedidaHora): number | null {
  return medida === 'importe' ? h.prevGrossEur : h.prevOrders;
}

/** La hora con más ventas. null si no se vendió nada: no hay pico que marcar. */
export function horaPico(horas: HourPoint[], medida: MedidaHora): number | null {
  let mejor: number | null = null;
  let max = 0;
  for (const h of horas) {
    const v = valorHora(h, medida);
    if (v > max) {
      max = v;
      mejor = h.hour;
    }
  }
  return mejor;
}

/**
 * La franja de `largo` horas seguidas que más vende, y qué parte del total se
 * lleva. Da la vuelta por la medianoche (23→00→01 es una franja), porque para
 * un funnel que vende de noche cortar a las 00 partiría su mejor momento en dos.
 *
 * null sin ventas. Con empate se queda con la primera, que es la más temprana.
 */
export function mejorFranja(
  horas: HourPoint[],
  medida: MedidaHora,
  largo = 3,
): { desde: number; hasta: number; parte: number } | null {
  const valores = Array.from({ length: 24 }, (_, i) => {
    const h = horas.find((x) => x.hour === i);
    return h ? valorHora(h, medida) : 0;
  });
  const total = valores.reduce((a, v) => a + v, 0);
  if (total <= 0) return null;
  let mejorDesde = 0;
  let mejorSuma = -1;
  for (let desde = 0; desde < 24; desde++) {
    let suma = 0;
    for (let k = 0; k < largo; k++) suma += valores[(desde + k) % 24]!;
    if (suma > mejorSuma) {
      mejorSuma = suma;
      mejorDesde = desde;
    }
  }
  return { desde: mejorDesde, hasta: (mejorDesde + largo) % 24, parte: mejorSuma / total };
}

/**
 * La hora en curso SOLO si el rango termina hoy: en un rango cerrado ("ayer",
 * o uno personalizado del mes pasado) no hay "ahora" que marcar ni horas
 * futuras que atenuar.
 */
export function horaEnCurso(rangoHasta: string, ahora: { day: string; hour: number }): number | null {
  return rangoHasta === ahora.day ? ahora.hour : null;
}

/** '07' → para el eje y las etiquetas: dos dígitos, sin "h" (la pone el que la usa). */
export function hh(h: number): string {
  return String(h).padStart(2, '0');
}
