/**
 * El agregado de la dona de gastos por categoría. Vive fuera del `.tsx` por el
 * mismo motivo que `serie.ts`: vitest corre en `node` sin jsdom, así que lo que
 * no se saca de un componente queda sin test.
 *
 * Los tipos entran con `import type`: `finance.ts` importa `pg`.
 */

import type { FinanceCategory, FinanceMovement } from '@/lib/queries/finance';

export type PeriodoGastos = 'mes' | 'mesPasado' | 'todo';

export type PorcionGasto = {
  categoria: FinanceCategory;
  /** POSITIVO: cuánto se fue. Una dona no tiene porciones negativas. */
  totalEur: number;
  /** 0..1 sobre el total del período. */
  share: number;
};

/** El mes anterior a `YYYY-MM`, sin pasar por `Date` (ver la cabecera de page.tsx). */
export function mesAnterior(mes: string): string {
  const y = Number(mes.slice(0, 4));
  const m = Number(mes.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/**
 * Suma los GASTOS del período por categoría, de mayor a menor.
 *
 * Sólo `kind = 'gasto'`: un retiro no es un gasto del negocio (es plata que el
 * dueño saca) y meterlo acá lo haría competir con sueldos o alquiler en una
 * torta que pretende decir en qué se va la plata de la operación.
 *
 * `Math.abs` acá SÍ va: el gasto se guarda negativo, y la porción de una dona es
 * un tamaño, no un saldo. La tabla de movimientos sigue mostrando el signo real.
 *
 * Las categorías en 0 no se devuelven: una porción de 0 no se dibuja y en la
 * leyenda sería ruido.
 */
export function gastosPorCategoria(
  movimientos: FinanceMovement[],
  periodo: PeriodoGastos,
  hoy: string,
): PorcionGasto[] {
  const mesHoy = hoy.slice(0, 7);
  const mesBuscado = periodo === 'mes' ? mesHoy : periodo === 'mesPasado' ? mesAnterior(mesHoy) : null;

  const totales = new Map<FinanceCategory, number>();
  for (const m of movimientos) {
    if (m.kind !== 'gasto') continue;
    if (mesBuscado !== null && m.day.slice(0, 7) !== mesBuscado) continue;
    // El CHECK de la base obliga a que un gasto tenga categoría; el `?? 'otros'`
    // es por si alguna fila vieja se escapó, para que no desaparezca del total.
    const cat = m.category ?? 'otros';
    totales.set(cat, (totales.get(cat) ?? 0) + Math.abs(m.amountEur));
  }

  const total = [...totales.values()].reduce((a, b) => a + b, 0);
  return [...totales.entries()]
    .filter(([, v]) => v > 0)
    .map(([categoria, totalEur]) => ({ categoria, totalEur, share: totalEur / total }))
    .sort((a, b) => b.totalEur - a.totalEur);
}
