'use client';

/**
 * DonaGastos — en qué se va la plata: los gastos del período por categoría.
 *
 * Recibe los movimientos que FinanzasView ya tiene y NO hace fetch: el agregado
 * es `gastosPorCategoria` (gastos.ts), puro y con test.
 *
 * El total va en el centro y la leyenda al lado lleva monto y %: con cinco
 * porciones, el ángulo solo no alcanza para comparar dos parecidas.
 */

import { useState } from 'react';
import { Cell, Pie, PieChart, Tooltip } from 'recharts';
import { panelColors } from '@/tailwind.config';
import { Card, ChartFrame, EmptyState, fmtMoney, fmtPct } from '@/components/ui';
import type { FinanceCategory, FinanceMovement } from '@/lib/queries/finance';
import { MONEDA_REPORTE } from '@/lib/moneda-reporte';
import { gastosPorCategoria, type PeriodoGastos, type PorcionGasto } from './gastos';

/**
 * Un color FIJO por categoría, no por posición: si el orden cambia de un mes a
 * otro, sueldos tiene que seguir siendo el mismo violeta. Sin good ni bad (D8):
 * una categoría de gasto no es buena ni mala. `otros` va en el gris de eje
 * porque es el resto, no una categoría a mirar.
 */
const COLOR: Record<FinanceCategory, string> = {
  sueldos: panelColors.acento,
  herramientas: panelColors.info,
  alquiler: panelColors.warn,
  impuestos: panelColors.acentoLight,
  otros: panelColors.axis,
};

const ETIQUETA: Record<FinanceCategory, string> = {
  sueldos: 'Sueldos',
  herramientas: 'Herramientas',
  alquiler: 'Alquiler',
  impuestos: 'Impuestos',
  otros: 'Otros',
};

const PERIODOS: { v: PeriodoGastos; label: string }[] = [
  { v: 'mes', label: 'Este mes' },
  { v: 'mesPasado', label: 'Mes pasado' },
  { v: 'todo', label: 'Todo' },
];

function DonaTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: PorcionGasto }>;
}): JSX.Element | null {
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload;
  return (
    <div className="rounded-xl border border-border-strong bg-surface-overlay/95 px-3 py-2 text-xs shadow-float backdrop-blur-sm">
      <p className="mb-1 flex items-center gap-1.5 font-semibold text-neutral-100">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: COLOR[p.categoria] }} />
        {ETIQUETA[p.categoria]}
      </p>
      <p className="font-mono tabular-nums text-neutral-200">
        {fmtMoney(p.totalEur, MONEDA_REPORTE)}
        <span className="ml-1.5 text-neutral-500">{fmtPct(p.share * 100)}</span>
      </p>
    </div>
  );
}

export function DonaGastos({
  movimientos,
  hoy,
}: {
  movimientos: FinanceMovement[];
  /** `overview.hoy`, en la TZ del panel: el mes NO sale de `new Date()`. */
  hoy: string;
}): JSX.Element {
  const [periodo, setPeriodo] = useState<PeriodoGastos>('mes');
  const porciones = gastosPorCategoria(movimientos, periodo, hoy);
  const total = porciones.reduce((a, p) => a + p.totalEur, 0);

  return (
    <Card
      title="Gastos por categoría"
      hint="Sólo los movimientos de tipo gasto: los retiros son plata que sacás vos, no un costo del negocio."
      accion={
        // El mismo segmentado que el Diario / Mensual de GraficoSaldo.
        <div
          role="group"
          aria-label="Período de los gastos"
          className="flex items-center gap-0.5 rounded-xl bg-canvas/70 p-1 shadow-[inset_0_1px_2px_0_rgb(var(--sombra)/0.6),inset_0_0_0_1px_rgba(255,255,255,0.05)]"
        >
          {PERIODOS.map(({ v, label }) => (
            <button
              key={v}
              type="button"
              onClick={() => setPeriodo(v)}
              aria-pressed={periodo === v}
              className={`tap press rounded-lg px-3 py-1.5 text-sm transition-[background-color,color,box-shadow] duration-250 ${
                periodo === v
                  ? 'bg-surface-raised font-semibold text-neutral-50 shadow-lozenge'
                  : 'font-medium text-neutral-400 hover:bg-overlay/7 hover:text-neutral-100'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      }
    >
      {porciones.length === 0 ? (
        <EmptyState
          title={periodo === 'todo' ? 'Todavía no hay gastos cargados' : 'No hay gastos cargados en este período'}
          hint="Los gastos se cargan desde Movimientos, o los genera solos un pago programado."
        />
      ) : (
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center">
          <div className="relative w-full max-w-[260px] shrink-0">
            <ChartFrame alto="md">
              <PieChart>
                <Pie
                  data={porciones}
                  dataKey="totalEur"
                  nameKey="categoria"
                  innerRadius="62%"
                  outerRadius="92%"
                  paddingAngle={porciones.length > 1 ? 2 : 0}
                  stroke={panelColors.surface}
                  strokeWidth={2}
                  startAngle={90}
                  endAngle={-270}
                  isAnimationActive={false}
                >
                  {porciones.map((p) => (
                    <Cell key={p.categoria} fill={COLOR[p.categoria]} />
                  ))}
                </Pie>
                <Tooltip content={<DonaTooltip />} />
              </PieChart>
            </ChartFrame>
            {/* El total en el agujero. `pointer-events-none` para que no le robe
                el hover a las porciones que quedan debajo. */}
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-xs text-neutral-500">Total</span>
              <span className="font-mono text-lg font-medium tabular-nums text-neutral-50">
                {fmtMoney(total, MONEDA_REPORTE)}
              </span>
            </div>
          </div>

          <ul className="w-full min-w-0 flex-1 divide-y divide-border-subtle text-sm">
            {porciones.map((p) => (
              <li key={p.categoria} className="flex items-center gap-3 py-2">
                <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: COLOR[p.categoria] }} />
                <span className="flex-1 truncate text-neutral-300">{ETIQUETA[p.categoria]}</span>
                <span className="font-mono tabular-nums text-neutral-100">{fmtMoney(p.totalEur, MONEDA_REPORTE)}</span>
                <span className="w-14 text-right font-mono text-xs tabular-nums text-neutral-500">
                  {fmtPct(p.share * 100)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
