// Catálogo de juguete: sirve para probar WidgetGrid en aislamiento (T03).
// NO SE BORRA al terminar el rediseño: es lo que permite aislar el runtime de
// los datos cuando algo se rompa. T05 y T06 tienen sus propios catálogos.

import { TrendUp } from '@phosphor-icons/react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { panelColors } from '@/tailwind.config';
import { fmtAxis, fmtMoney } from '@/components/ui';
import type { WidgetCatalogo } from './tipos';
import { MONEDA_REPORTE } from '@/lib/moneda-reporte';

/** Los datos que T03 le pasa al WidgetGrid para probar el runtime. */
export type DemoData = Record<string, unknown>;

const DEMO_DIAS = [
  { day: '08 ago', net: 1284.5, refunded: 96.0 },
  { day: '09 ago', net: 1642.0, refunded: 60.5 },
  { day: '10 ago', net: 1510.25, refunded: 132.0 },
  { day: '11 ago', net: 1998.75, refunded: 87.25 },
  { day: '12 ago', net: 2215.0, refunded: 45.0 },
  { day: '13 ago', net: 1840.5, refunded: 118.75 },
  { day: '14 ago', net: 2401.0, refunded: 90.0 },
];

export const catalogoDemo: WidgetCatalogo<DemoData> = {
  'demo-kpi': {
    id: 'demo-kpi',
    label: 'Demo KPI',
    hint: 'Un KPI de juguete: en 2x1 muestra también el trend.',
    grupo: 'plata',
    tamañoPorDefecto: { w: 1, h: 1 },
    tamañosPermitidos: [
      { w: 1, h: 1 },
      { w: 2, h: 1 },
    ],
    render: (_data, size) => {
      const value = fmtMoney(1024.5, MONEDA_REPORTE);
      if (size.w === 2) {
        return (
          <div>
            <div className="font-mono text-3xl font-semibold tabular-nums text-neutral-50">
              {value}
            </div>
            <div className="mt-1 text-xs text-neutral-500">
              demo · trend inventado:{' '}
              <span className="inline-flex items-center gap-1 text-good-400">
                <TrendUp size={13} weight="bold" aria-hidden />
                12,4 %
              </span>
            </div>
          </div>
        );
      }
      return (
        <div>
          <div className="text-xs font-medium text-neutral-400">Demo KPI</div>
          <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-neutral-50">
            {value}
          </div>
        </div>
      );
    },
  },
  'demo-lista': {
    id: 'demo-lista',
    label: 'Demo lista',
    hint: 'Una lista corta de juguete: sólo acepta 2x1 y 1x2.',
    grupo: 'listas',
    tamañoPorDefecto: { w: 2, h: 1 },
    tamañosPermitidos: [
      { w: 2, h: 1 },
      { w: 1, h: 2 },
    ],
    render: () => (
      <ul className="space-y-2">
        {DEMO_DIAS.slice(0, 4).map((d) => (
          <li key={d.day} className="flex items-center justify-between gap-4 text-sm">
            <span className="text-neutral-400">{d.day}</span>
            <span className="font-mono tabular-nums text-neutral-200">
              {fmtMoney(d.net, MONEDA_REPORTE)}
            </span>
          </li>
        ))}
      </ul>
    ),
  },
  'demo-grafico': {
    id: 'demo-grafico',
    label: 'Demo gráfico',
    hint: 'Un gráfico de juguete: un gráfico no tiene sentido en 1x1.',
    grupo: 'graficos',
    tamañoPorDefecto: { w: 2, h: 2 },
    tamañosPermitidos: [{ w: 2, h: 2 }],
    render: () => (
      <div className="h-full min-h-44 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={DEMO_DIAS} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis
              dataKey="day"
              tick={{ fontSize: 11, fill: panelColors.axis }}
              tickLine={false}
              axisLine={{ stroke: 'rgba(255,255,255,0.12)' }}
              minTickGap={24}
            />
            <YAxis
              tickFormatter={fmtAxis}
              tick={{ fontSize: 11, fill: panelColors.axis }}
              tickLine={false}
              axisLine={false}
              width={56}
            />
            <Bar dataKey="net" fill={panelColors.good} radius={[3, 3, 0, 0]} />
            <Bar dataKey="refunded" fill={panelColors.bad} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    ),
  },
};
