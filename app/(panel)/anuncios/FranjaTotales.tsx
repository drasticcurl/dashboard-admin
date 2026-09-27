'use client';

/**
 * FranjaTotales — los totales del filtro, siempre a la vista y en chico.
 *
 * Vivían adentro de «Más filtros, columnas y totales» como cuatro StatCard de
 * 26px. Plegados no se veían nunca, y desplegados ocupaban dos filas de
 * tarjetas antes de la tabla. Ahora son una franja de celdas con el número a
 * 16px, fuera del desplegable, y suman dos que responden la pregunta que se
 * hacía a mano sumando los rojos de la columna Ganancia:
 *
 *   · Pérdida de <objetos> sin ganancia — la suma de las ganancias negativas.
 *     Es lo que esos objetos le restaron a la ganancia total.
 *   · Ganancia descontando <objetos> perdiendo — la ganancia total sin ellos,
 *     o sea `profitEur − perdidaEur`: cuánto se estaría ganando si no hubieran
 *     estado prendidos (su gasto no se habría hecho, pero sus ventas tampoco).
 *
 * Las dos salen del servidor (`totales.perdidaEur`) y no de las filas de la
 * página: con el resultado paginado, sumar los rojos de la pantalla daría la
 * pérdida de la página 1 y no la del filtro.
 *
 * Grilla con `gap-px` sobre el color del divisor en vez de bordes por celda:
 * las líneas quedan de 1px en cualquier cantidad de columnas y cuando la
 * grilla hace wrap no aparecen bordes dobles ni huérfanos.
 */

import type { ResultadoMetricas } from '@/lib/ads/tipos';
import { fmtInt } from '@/components/ui';

type Tono = 'neutral' | 'good' | 'warn' | 'bad';

const TONO_TEXTO: Record<Tono, string> = {
  neutral: 'text-neutral-50',
  good: 'text-good-400',
  warn: 'text-warn-400',
  bad: 'text-bad-400',
};

function Celda({
  label,
  valor,
  sub,
  tono = 'neutral',
  titulo,
}: {
  label: string;
  valor: string;
  sub?: string;
  tono?: Tono;
  /** El texto largo del hover: qué es el número y cómo se calcula. */
  titulo?: string;
}): JSX.Element {
  return (
    <div className="min-w-0 bg-surface px-3 py-2.5" title={titulo}>
      <div className="text-[11px] font-medium leading-tight text-neutral-400 max-panel:text-xs">{label}</div>
      <div className={`num mt-1 font-mono text-base font-medium -tracking-[0.01em] ${TONO_TEXTO[tono]}`}>{valor}</div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-neutral-500 max-panel:text-xs">{sub}</div>}
    </div>
  );
}

export function FranjaTotales({
  totales,
  alcance,
  plural,
  edadGasto,
  detalle,
  money,
}: {
  totales: ResultadoMetricas['totales'];
  /** «conjuntos activos»: nivel y estado, para los rótulos de siempre. */
  alcance: string;
  /** «conjuntos»: sólo el nivel, para los dos rótulos nuevos, que ya son largos. */
  plural: string;
  edadGasto: string;
  /** La línea de sobre cuántas filas y con qué filtros (detalleDeTotales). */
  detalle: string;
  money: (n: number) => string;
}): JSX.Element {
  const gasto = totales.spendEur;
  // El ROI se deriva acá porque el agregado no manda cocientes a propósito: el
  // cociente de las sumas no es la suma de los cocientes. `null` y NO 0 cuando
  // no hubo gasto: un 0 se leería como «no devolvió nada».
  const roi = gasto > 0 ? totales.netEur / gasto : null;
  const perdida = totales.perdidaEur; // ≤ 0
  const sinPerdedores = totales.profitEur - perdida;
  const n = totales.filasPerdiendo;

  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border-subtle bg-divider sm:grid-cols-3 2xl:grid-cols-6">
        <Celda label={`Gasto de ${alcance}`} valor={money(gasto)} sub={edadGasto} tono="warn" />
        <Celda label={`Ingresos de ${alcance}`} valor={money(totales.revenueEur)} sub="bruto aprobado" />
        <Celda
          label={`Ganancia de ${alcance}`}
          valor={money(totales.profitEur)}
          sub="neto − gasto"
          tono={totales.profitEur < 0 ? 'bad' : 'good'}
        />
        <Celda
          label={`ROI de ${alcance}`}
          valor={roi === null ? '—' : `${roi.toFixed(2)}×`}
          sub="neto ÷ gasto de ads"
          tono={roi === null ? 'neutral' : roi < 1 ? 'bad' : roi < 2 ? 'warn' : 'good'}
        />
        <Celda
          label={`Pérdida de ${plural} sin ganancia`}
          valor={money(perdida)}
          sub={n === 0 ? 'nada en rojo' : `${fmtInt(n)} en rojo`}
          tono={perdida < 0 ? 'bad' : 'neutral'}
          titulo={`La suma de la columna Ganancia de los ${plural} que dan negativo: lo que le restaron a la ganancia total en el período.`}
        />
        <Celda
          label={`Ganancia descontando ${plural} perdiendo`}
          valor={money(sinPerdedores)}
          sub={n === 0 ? 'igual a la ganancia' : `sin esos ${fmtInt(n)} prendidos`}
          tono={sinPerdedores < 0 ? 'bad' : 'good'}
          titulo={`La ganancia total sin los ${plural} en rojo: cuánto se estaría ganando si no hubieran estado prendidos (ni su gasto ni sus ventas).`}
        />
      </div>
      <p className="text-xs text-neutral-500">{detalle}</p>
    </div>
  );
}
