'use client';

/**
 * El catálogo de widgets de Resumen (task T05).
 *
 * Sigue el contrato de lib/widgets/tipos.ts (plan §4): cada widget es una
 * función pura de `(data, size)` a JSX — no hace fetch, no tiene estado, no
 * toca la base. Los datos entran UNA vez por la pantalla y bajan a cada
 * widget.
 *
 * Este archivo importa recharts, así que sólo se puede importar desde
 * componentes client (nota P-R08 de T03): la página lo evita a propósito y
 * sólo baja el layout guardado como prop.
 *
 * Los tipos de lib/queries/overview entran con `import type`: un import de
 * valor arrastraría pg al bundle del browser.
 *
 * Unidades (T02 §2): los ratios van en tanto por uno y fmtPct NO multiplica,
 * así que el idioma es `fmtPct(x * 100)`. Los campos nuevos son
 * `number | null`: null = "no se puede calcular" y se muestra como "—" con
 * `fmtPct((x ?? NaN) * 100)`.
 */

import Link from 'next/link';
import { TrendDown, TrendUp } from '@phosphor-icons/react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { panelColors } from '@/tailwind.config';
import {
  Banner,
  ChartFrame,
  EmptyState,
  Table,
  fmtAxis,
  fmtDateTime,
  fmtInt,
  fmtMoney,
  fmtPct,
} from '@/components/ui';
import type { FunnelSummary, OverviewData } from '@/lib/queries/overview';
import type { WidgetCatalogo, WidgetSize } from './tipos';
import { MONEDA_REPORTE, SIMBOLO_REPORTE } from '@/lib/moneda-reporte';

// El trend es (actual − anterior) ÷ anterior. Sin período anterior (rango
// 'all') o con anterior en 0 no hay comparación posible: undefined, y el KPI
// no dibuja la flecha — no se inventa un 0% ni una división por cero.
function trendPct(cur: number, prev: number | undefined): number | undefined {
  if (prev === undefined || prev === 0) return undefined;
  return ((cur - prev) / prev) * 100;
}

type SparkPoint = { day: string; v: number };

/** El sparkline del KPI en 2x2: un área sin ejes ni tooltip. */
function Sparkline({ points, color }: { points: SparkPoint[]; color: string }): JSX.Element {
  return (
    <div className="h-16 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            fill={color}
            fillOpacity={0.12}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

type KpiDatos = {
  valor: string;
  sub?: string;
  trend?: number;
  tone?: 'neutral' | 'good' | 'bad';
  spark?: SparkPoint[];
  sparkColor?: string;
};

/**
 * El cuerpo de un KPI según su tamaño (§4 regla 3 del plan): en 1x1 número
 * solo (el label está en el header del widget), en 2x1 agrega el sub y el
 * trend contra el período anterior, en 2x2 agrega el sparkline por día.
 */
function Kpi({ size, k }: { size: WidgetSize; k: KpiDatos }): JSX.Element {
  const toneCls =
    k.tone === 'good' ? 'text-good-400' : k.tone === 'bad' ? 'text-bad-400' : 'text-neutral-50';
  const hayTrend = typeof k.trend === 'number';
  return (
    <div className="flex h-full flex-col">
      {/* El número escala con el ancho: en 1x1 un text-2xl quedaba chico y
          perdido en la tarjeta, que es la mitad de por qué los widgets se veían
          flojos. La otra mitad era que el trend sólo aparecía en 2x1. */}
      <div
        className={`font-mono font-semibold tabular-nums tracking-tight ${toneCls} ${
          size.w === 2 ? 'text-3xl' : 'text-2xl'
        }`}
      >
        {k.valor}
      </div>

      {/* El TREND se muestra en TODOS los tamaños, incluido 1x1: es el dato que
          convierte un número suelto en información ("500 EUR" no dice nada,
          "500 EUR, +12% vs el período anterior" sí). El `sub`, que es más
          verboso, sigue reservado para los anchos. */}
      {(hayTrend || (size.w === 2 && k.sub)) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-500">
          {hayTrend && (
            <span
              className={`inline-flex items-center gap-1 font-mono font-semibold tabular-nums ${
                k.trend! >= 0 ? 'text-good-400' : 'text-bad-400'
              }`}
            >
              {k.trend! >= 0 ? (
                <TrendUp size={13} weight="bold" aria-hidden />
              ) : (
                <TrendDown size={13} weight="bold" aria-hidden />
              )}
              {fmtPct(Math.abs(k.trend!))}
            </span>
          )}
          {size.w === 2 && k.sub && <span>{k.sub}</span>}
        </div>
      )}

      {size.h === 2 && k.spark && k.spark.length > 1 && (
        <div className="mt-auto h-16 w-full pt-3">
          <Sparkline points={k.spark} color={k.sparkColor ?? panelColors.good} />
        </div>
      )}
    </div>
  );
}

const byDayNeto = (d: OverviewData): SparkPoint[] => d.byDay.map((x) => ({ day: x.day, v: x.netEur }));
const byDayOrdenes = (d: OverviewData): SparkPoint[] => d.byDay.map((x) => ({ day: x.day, v: x.orders }));
const byDaySesiones = (d: OverviewData): SparkPoint[] => d.byDay.map((x) => ({ day: x.day, v: x.sessions }));
const byDayTicket = (d: OverviewData): SparkPoint[] =>
  d.byDay.filter((x) => x.orders > 0).map((x) => ({ day: x.day, v: x.netEur / x.orders }));

const LINK_CLS =
  'rounded-lg border border-border-subtle px-2.5 py-1 text-xs font-semibold text-neutral-300 transition-colors hover:bg-overlay/4 hover:text-neutral-50 focus:outline-none focus:ring-2 focus:ring-good-500/50';

/** La tarjeta de un funnel: neto EUR + neto en su moneda + los links. */
function FunnelCard({ f }: { f: FunnelSummary }): JSX.Element {
  return (
    <div className="rounded-xl border border-border-subtle bg-canvas p-3.5">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: f.color }} />
        <span className="truncate text-sm font-semibold text-neutral-50" title={f.name}>
          {f.name}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="text-lg font-semibold tabular-nums tracking-tight text-neutral-50">
          {fmtMoney(f.netEur, MONEDA_REPORTE)}
        </span>
        <span className="text-xs tabular-nums text-neutral-400">
          {fmtMoney(f.netOrig, f.sellCurrency)}
        </span>
      </div>
      <p className="mt-1 text-xs tabular-nums text-neutral-500">
        {fmtInt(f.orders)} órdenes · {fmtInt(f.sessions)} sesiones · conv{' '}
        {fmtPct(f.convSessionToSale * 100, 1)} · ticket {fmtMoney(f.avgTicketEur, MONEDA_REPORTE)}
      </p>
      <div className="mt-2.5 flex gap-2">
        <Link href={`/embudo?f=${f.slug}`} className={LINK_CLS}>
          Embudo
        </Link>
        <Link href={`/ventas?f=${f.slug}`} className={LINK_CLS}>
          Ventas
        </Link>
      </div>
    </div>
  );
}

/** Una celda de la tabla comparativa: el conteo y la tasa sobre las sesiones. */
function StageCell({ n, base }: { n: number; base: number }): JSX.Element {
  return (
    <span className="whitespace-nowrap">
      <span className="tabular-nums text-neutral-200">{fmtInt(n)}</span>
      <span className="ml-1.5 text-[11px] tabular-nums text-neutral-500">
        {base > 0 ? fmtPct((n / base) * 100, 1) : '—'}
      </span>
    </span>
  );
}

type DayPoint = OverviewData['byDay'][number];

function StackedTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string; payload: DayPoint }>;
}): JSX.Element | null {
  if (!active || !payload?.length) return null;
  const d = payload[0]!.payload;
  const bands = payload.filter((p) => Number(p.value) !== 0);
  return (
    <div className="rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-xs shadow-float">
      <p className="mb-1 font-semibold text-neutral-100">{d.day}</p>
      <p className="tabular-nums text-neutral-300">Total: {fmtMoney(d.netEur, MONEDA_REPORTE)}</p>
      {bands.map((p) => (
        <p key={p.name} className="tabular-nums" style={{ color: p.color }}>
          {p.name}: {fmtMoney(Number(p.value), 'EUR')}
        </p>
      ))}
      <p className="tabular-nums text-neutral-400">
        Órdenes: {fmtInt(d.orders)} · Sesiones: {fmtInt(d.sessions)}
      </p>
    </div>
  );
}

/** El apilado por día: una banda por funnel con su color. */
function NetoPorDia({ data }: { data: OverviewData }): JSX.Element {
  if (data.byDay.every((d) => d.netEur === 0)) {
    return <EmptyState title="Sin ventas en el rango" />;
  }
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-400">
        {data.funnels.map((f) => (
          <span key={f.slug} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: f.color }} /> {f.name}
          </span>
        ))}
      </div>
      <ChartFrame alto="md">
        <BarChart data={data.byDay} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
          <XAxis
            dataKey="day"
            tickFormatter={(v: string) => `${v.slice(8)}/${v.slice(5, 7)}`}
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
          <Tooltip content={<StackedTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
          {data.funnels.map((f) => (
            <Bar key={f.slug} dataKey={`perFunnel.${f.slug}`} stackId="net" fill={f.color} name={f.name} />
          ))}
        </BarChart>
      </ChartFrame>
    </div>
  );
}

function SesionesPorDia({ data }: { data: OverviewData }): JSX.Element {
  if (data.byDay.every((d) => d.sessions === 0)) {
    return <EmptyState title="Sin sesiones en el rango" />;
  }
  return (
    <ChartFrame alto="md">
      <BarChart data={data.byDay} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
        <XAxis
          dataKey="day"
          tickFormatter={(v: string) => `${v.slice(8)}/${v.slice(5, 7)}`}
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
        <Bar dataKey="sessions" name="Sesiones" fill={panelColors.info} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ChartFrame>
  );
}

/** La tabla comparativa de hitos: sesión → quiz → venta → checkout → compra. */
function TablaFunnels({ data }: { data: OverviewData }): JSX.Element {
  return (
    <Table
      rows={data.funnels}
      empty="Sin datos en el rango"
      columns={[
        {
          key: 'funnel',
          header: 'Funnel',
          render: (f) => (
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: f.color }} />
              <span className="text-neutral-200">{f.name}</span>
            </span>
          ),
        },
        { key: 'sessions', header: 'Sesiones', align: 'right', render: (f) => fmtInt(f.sessions) },
        {
          key: 'quiz',
          header: 'Quiz',
          align: 'right',
          render: (f) => <StageCell n={f.quizStarted} base={f.sessions} />,
        },
        {
          key: 'venta',
          header: 'Venta',
          align: 'right',
          render: (f) => <StageCell n={f.salesViews} base={f.sessions} />,
        },
        {
          key: 'checkout',
          header: 'Checkout',
          align: 'right',
          render: (f) => <StageCell n={f.checkoutClicks} base={f.sessions} />,
        },
        {
          key: 'compra',
          header: 'Compra',
          align: 'right',
          render: (f) => <StageCell n={f.orders} base={f.sessions} />,
        },
        {
          key: 'conv',
          header: 'Conversión',
          align: 'right',
          render: (f) => <span className="tabular-nums">{fmtPct(f.convSessionToSale * 100, 1)}</span>,
        },
      ]}
    />
  );
}

/**
 * Los avisos del sistema, menos el del rollup viejo: ese se muestra fijo
 * arriba de la pantalla (task §3) y duplicarlo acá sería ruido. El filtro
 * matchea el texto que genera lib/queries/overview.ts — si ese texto cambia
 * lo peor que pasa es un aviso repetido, no un aviso perdido.
 */
function Alertas({ data }: { data: OverviewData }): JSX.Element {
  const visibles = data.alerts.filter((a) => !a.text.startsWith('el rollup no'));
  if (visibles.length === 0) {
    return <EmptyState title="No hay alertas" />;
  }
  return (
    <div className="space-y-2">
      {visibles.map((a, i) => (
        <Banner key={i} tone={a.tone}>
          {a.href ? (
            <Link href={a.href} className="underline underline-offset-2">
              {a.text}
            </Link>
          ) : (
            a.text
          )}
        </Banner>
      ))}
    </div>
  );
}

function EstadoRollup({ data, size }: { data: OverviewData; size: WidgetSize }): JSX.Element {
  const viejo = data.staleRollup;
  return (
    <div className="flex h-full flex-col">
      <div
        className={`text-2xl font-semibold tracking-tight ${viejo ? 'text-bad-300' : 'text-good-400'}`}
      >
        {viejo ? 'Viejo' : 'Al día'}
      </div>
      {size.w === 2 && (
        <p className="mt-1.5 text-xs text-neutral-500">
          {data.lastRollupAt
            ? `último rollup: ${fmtDateTime(data.lastRollupAt)}`
            : 'el rollup no corrió nunca'}
        </p>
      )}
    </div>
  );
}

export const catalogoResumen: WidgetCatalogo<OverviewData> = {
  // ─── plata ───────────────────────────────────────────────────────────────
  neto: {
    id: 'neto',
    label: 'Neto total',
    hint: 'Bruto − devoluciones − comisiones − costos, todo en EUR.',
    grupo: 'plata',
    tamañoPorDefecto: { w: 1, h: 1 },
    tamañosPermitidos: [
      { w: 1, h: 1 },
      { w: 2, h: 1 },
      { w: 2, h: 2 },
    ],
    render: (d, size) => (
      <Kpi
        size={size}
        k={{
          valor: fmtMoney(d.totals.netEur, MONEDA_REPORTE),
          sub: 'EUR · bruto − devuelto',
          trend: trendPct(d.totals.netEur, d.prev?.netEur),
          tone: 'good',
          spark: byDayNeto(d),
          sparkColor: panelColors.good,
        }}
      />
    ),
  },
  resultado: {
    id: 'resultado',
    label: 'Resultado',
    hint: 'Neto − gasto en ads: la plata que queda después de pagar la publicidad. Puede ser negativo.',
    grupo: 'plata',
    tamañoPorDefecto: { w: 1, h: 1 },
    tamañosPermitidos: [
      { w: 1, h: 1 },
      { w: 2, h: 1 },
    ],
    render: (d, size) => (
      <Kpi
        size={size}
        k={{
          valor: fmtMoney(d.totals.resultEur, MONEDA_REPORTE),
          sub: 'neto − gasto en ads',
          trend: trendPct(d.totals.resultEur, d.prev?.resultEur),
          tone: d.totals.resultEur < 0 ? 'bad' : 'good',
        }}
      />
    ),
  },
  bruto: {
    id: 'bruto',
    label: 'Bruto',
    hint: 'Antes de devoluciones, comisiones y costos: es el numerador del ROAS.',
    grupo: 'plata',
    tamañoPorDefecto: { w: 1, h: 1 },
    tamañosPermitidos: [
      { w: 1, h: 1 },
      { w: 2, h: 1 },
    ],
    render: (d, size) => (
      <Kpi
        size={size}
        k={{
          valor: fmtMoney(d.totals.grossEur, MONEDA_REPORTE),
          sub: 'antes de devoluciones y costos',
        }}
      />
    ),
  },
  ads: {
    id: 'ads',
    label: 'Gasto en ads',
    hint: 'El gasto de publicidad del período, en EUR (Meta, sincronizado).',
    grupo: 'plata',
    tamañoPorDefecto: { w: 1, h: 1 },
    tamañosPermitidos: [
      { w: 1, h: 1 },
      { w: 2, h: 1 },
    ],
    render: (d, size) => (
      <Kpi
        size={size}
        k={{
          valor: fmtMoney(d.totals.adSpendEur, MONEDA_REPORTE),
          sub: 'gasto en publicidad',
          trend: trendPct(d.totals.adSpendEur, d.prev?.adSpendEur),
        }}
      />
    ),
  },
  devuelto: {
    id: 'devuelto',
    label: 'Devuelto',
    hint: 'El importe devuelto del período, en EUR.',
    grupo: 'plata',
    tamañoPorDefecto: { w: 1, h: 1 },
    tamañosPermitidos: [
      { w: 1, h: 1 },
      { w: 2, h: 1 },
    ],
    render: (d, size) => (
      <Kpi
        size={size}
        k={{
          valor: fmtMoney(d.totals.refundedEur, MONEDA_REPORTE),
          sub: `${fmtInt(d.totals.ordersRefunded)} órdenes devueltas`,
        }}
      />
    ),
  },
  ticket: {
    id: 'ticket',
    label: 'Ticket promedio',
    hint: 'Neto ÷ órdenes, en EUR.',
    grupo: 'plata',
    tamañoPorDefecto: { w: 1, h: 1 },
    tamañosPermitidos: [
      { w: 1, h: 1 },
      { w: 2, h: 1 },
      { w: 2, h: 2 },
    ],
    render: (d, size) => (
      <Kpi
        size={size}
        k={{
          valor: fmtMoney(d.totals.avgTicketEur, MONEDA_REPORTE),
          sub: 'neto ÷ órdenes',
          trend: trendPct(d.totals.avgTicketEur, d.prev?.avgTicketEur),
          spark: byDayTicket(d),
          sparkColor: panelColors.info,
        }}
      />
    ),
  },

  // ─── volumen ─────────────────────────────────────────────────────────────
  ordenes: {
    id: 'ordenes',
    label: 'Órdenes',
    hint: 'Las órdenes aprobadas del período.',
    grupo: 'volumen',
    tamañoPorDefecto: { w: 1, h: 1 },
    tamañosPermitidos: [
      { w: 1, h: 1 },
      { w: 2, h: 1 },
      { w: 2, h: 2 },
    ],
    render: (d, size) => (
      <Kpi
        size={size}
        k={{
          valor: fmtInt(d.totals.orders),
          sub: `${fmtInt(d.totals.ordersRefunded)} devueltas`,
          trend: trendPct(d.totals.orders, d.prev?.orders),
          spark: byDayOrdenes(d),
          sparkColor: panelColors.info,
        }}
      />
    ),
  },
  sesiones: {
    id: 'sesiones',
    label: 'Sesiones',
    hint: 'Sesiones únicas del período.',
    grupo: 'volumen',
    tamañoPorDefecto: { w: 1, h: 1 },
    tamañosPermitidos: [
      { w: 1, h: 1 },
      { w: 2, h: 1 },
      { w: 2, h: 2 },
    ],
    render: (d, size) => (
      <Kpi
        size={size}
        k={{
          valor: fmtInt(d.totals.sessions),
          sub: 'sesiones únicas',
          trend: trendPct(d.totals.sessions, d.prev?.sessions),
          spark: byDaySesiones(d),
          sparkColor: panelColors.info,
        }}
      />
    ),
  },
  quiz: {
    id: 'quiz',
    label: 'Quiz arrancado',
    hint: 'Sesiones que llegaron a la primera pregunta del quiz.',
    grupo: 'volumen',
    tamañoPorDefecto: { w: 1, h: 1 },
    tamañosPermitidos: [
      { w: 1, h: 1 },
      { w: 2, h: 1 },
    ],
    render: (d, size) => (
      <Kpi size={size} k={{ valor: fmtInt(d.totals.quizStarted), sub: 'arrancaron el quiz' }} />
    ),
  },
  'vistas-venta': {
    id: 'vistas-venta',
    label: 'Vistas de la venta',
    hint: 'Sesiones que vieron la página de venta.',
    grupo: 'volumen',
    tamañoPorDefecto: { w: 1, h: 1 },
    tamañosPermitidos: [
      { w: 1, h: 1 },
      { w: 2, h: 1 },
    ],
    render: (d, size) => (
      <Kpi size={size} k={{ valor: fmtInt(d.totals.salesViews), sub: 'vieron la página de venta' }} />
    ),
  },
  checkout: {
    id: 'checkout',
    label: 'Clicks al checkout',
    hint: 'Sesiones que clickearon "comprar".',
    grupo: 'volumen',
    tamañoPorDefecto: { w: 1, h: 1 },
    tamañosPermitidos: [
      { w: 1, h: 1 },
      { w: 2, h: 1 },
    ],
    render: (d, size) => (
      <Kpi size={size} k={{ valor: fmtInt(d.totals.checkoutClicks), sub: 'clickearon comprar' }} />
    ),
  },

  // ─── eficiencia ──────────────────────────────────────────────────────────
  roas: {
    id: 'roas',
    label: 'ROAS',
    hint: `Bruto ÷ gasto en ads: por cada ${SIMBOLO_REPORTE} de publicidad, cuánto ${SIMBOLO_REPORTE} bruto volvió. 0 sin gasto cargado.`,
    grupo: 'eficiencia',
    tamañoPorDefecto: { w: 1, h: 1 },
    tamañosPermitidos: [
      { w: 1, h: 1 },
      { w: 2, h: 1 },
    ],
    render: (d, size) => (
      <Kpi
        size={size}
        k={{ valor: fmtMoney(d.totals.roas, MONEDA_REPORTE), sub: 'bruto ÷ gasto en ads' }}
      />
    ),
  },
  cpa: {
    id: 'cpa',
    label: 'CPA',
    hint: 'Gasto en ads ÷ órdenes: cuánto cuesta conseguir una venta. — sin órdenes.',
    grupo: 'eficiencia',
    tamañoPorDefecto: { w: 1, h: 1 },
    tamañosPermitidos: [
      { w: 1, h: 1 },
      { w: 2, h: 1 },
    ],
    render: (d, size) => (
      <Kpi
        size={size}
        k={{ valor: fmtMoney(d.totals.cpa ?? NaN, MONEDA_REPORTE), sub: 'gasto en ads ÷ órdenes' }}
      />
    ),
  },
  'conv-sesion-venta': {
    id: 'conv-sesion-venta',
    label: 'Conversión sesión → venta',
    hint: 'Órdenes ÷ sesiones: qué parte de las sesiones termina comprando. — sin sesiones.',
    grupo: 'eficiencia',
    tamañoPorDefecto: { w: 1, h: 1 },
    tamañosPermitidos: [
      { w: 1, h: 1 },
      { w: 2, h: 1 },
    ],
    render: (d, size) => (
      <Kpi
        size={size}
        k={{ valor: fmtPct((d.totals.convSessionToSale ?? NaN) * 100), sub: 'órdenes ÷ sesiones' }}
      />
    ),
  },
  'conv-checkout-venta': {
    id: 'conv-checkout-venta',
    label: 'Conversión checkout → venta',
    hint: 'Órdenes ÷ clicks al checkout: de los que clickean comprar, cuántos compran. — sin clicks.',
    grupo: 'eficiencia',
    tamañoPorDefecto: { w: 1, h: 1 },
    tamañosPermitidos: [
      { w: 1, h: 1 },
      { w: 2, h: 1 },
    ],
    render: (d, size) => (
      <Kpi
        size={size}
        k={{ valor: fmtPct((d.totals.convCheckoutToSale ?? NaN) * 100), sub: 'órdenes ÷ clicks al checkout' }}
      />
    ),
  },
  'rev-sesion': {
    id: 'rev-sesion',
    label: 'Ingreso por sesión',
    hint: 'Neto ÷ sesiones, en EUR: junta tráfico y plata en un número. — sin sesiones.',
    grupo: 'eficiencia',
    tamañoPorDefecto: { w: 1, h: 1 },
    tamañosPermitidos: [
      { w: 1, h: 1 },
      { w: 2, h: 1 },
    ],
    render: (d, size) => (
      <Kpi
        size={size}
        k={{ valor: fmtMoney(d.totals.revPerSession ?? NaN, MONEDA_REPORTE), sub: 'neto ÷ sesiones' }}
      />
    ),
  },
  margen: {
    id: 'margen',
    label: 'Margen neto',
    hint: 'Neto ÷ bruto: cuánto del bruto sobrevive a devoluciones, comisiones y costos. Puede ser negativo.',
    grupo: 'eficiencia',
    tamañoPorDefecto: { w: 1, h: 1 },
    tamañosPermitidos: [
      { w: 1, h: 1 },
      { w: 2, h: 1 },
    ],
    render: (d, size) => (
      <Kpi
        size={size}
        k={{
          valor: fmtPct((d.totals.netMargin ?? NaN) * 100),
          sub: 'neto ÷ bruto',
          tone: d.totals.netMargin !== null && d.totals.netMargin < 0 ? 'bad' : 'neutral',
        }}
      />
    ),
  },

  // ─── calidad ─────────────────────────────────────────────────────────────
  'tasa-devolucion': {
    id: 'tasa-devolucion',
    label: 'Tasa de devolución',
    hint: 'Órdenes devueltas ÷ órdenes. — sin órdenes.',
    grupo: 'calidad',
    tamañoPorDefecto: { w: 1, h: 1 },
    tamañosPermitidos: [
      { w: 1, h: 1 },
      { w: 2, h: 1 },
    ],
    render: (d, size) => (
      <Kpi
        size={size}
        k={{
          valor: fmtPct((d.totals.refundRate ?? NaN) * 100),
          sub: `${fmtInt(d.totals.ordersRefunded)} devueltas de ${fmtInt(d.totals.orders)}`,
        }}
      />
    ),
  },
  rollup: {
    id: 'rollup',
    label: 'Estado del rollup',
    hint: 'El rollup recalcula daily_metrics. Si está viejo, los números de esta pantalla pueden estar desactualizados.',
    grupo: 'calidad',
    tamañoPorDefecto: { w: 1, h: 1 },
    tamañosPermitidos: [
      { w: 1, h: 1 },
      { w: 2, h: 1 },
    ],
    render: (d, size) => <EstadoRollup data={d} size={size} />,
  },
  alertas: {
    id: 'alertas',
    label: 'Alertas',
    hint: 'Avisos del sistema: funnels que no reportan, ventas sin atribuir, órdenes sin tier. El rollup viejo se avisa aparte, fijo arriba de todo.',
    grupo: 'calidad',
    tamañoPorDefecto: { w: 2, h: 1 },
    tamañosPermitidos: [
      { w: 2, h: 1 },
      { w: 1, h: 2 },
    ],
    render: (d) => <Alertas data={d} />,
  },

  // ─── graficos ────────────────────────────────────────────────────────────
  'neto-dia': {
    id: 'neto-dia',
    label: 'Neto por día',
    hint: 'Una banda por funnel: el conjunto crece si la pila crece, y un funnel tapa la caída de otro.',
    grupo: 'graficos',
    tamañoPorDefecto: { w: 2, h: 2 },
    tamañosPermitidos: [{ w: 2, h: 2 }],
    render: (d) => <NetoPorDia data={d} />,
  },
  'sesiones-dia': {
    id: 'sesiones-dia',
    label: 'Sesiones por día',
    hint: 'Las sesiones únicas de cada día del rango.',
    grupo: 'graficos',
    tamañoPorDefecto: { w: 2, h: 2 },
    tamañosPermitidos: [{ w: 2, h: 2 }],
    render: (d) => <SesionesPorDia data={d} />,
  },

  // ─── listas ──────────────────────────────────────────────────────────────
  funnels: {
    id: 'funnels',
    label: 'Funnels',
    hint: 'Uno por funnel, ordenados por neto: neto EUR, neto en su moneda y links a Embudo y Ventas.',
    grupo: 'listas',
    tamañoPorDefecto: { w: 2, h: 2 },
    tamañosPermitidos: [{ w: 2, h: 2 }],
    render: (d) => (
      <div className="grid gap-3 sm:grid-cols-2">
        {d.funnels.map((f) => (
          <FunnelCard key={f.slug} f={f} />
        ))}
      </div>
    ),
  },
  'tabla-funnels': {
    id: 'tabla-funnels',
    label: 'Embudo comparado',
    hint: 'Hitos, no pasos del quiz: comparar funnels con preguntas distintas solo tiene sentido a este nivel.',
    grupo: 'listas',
    tamañoPorDefecto: { w: 2, h: 2 },
    tamañosPermitidos: [
      { w: 2, h: 1 },
      { w: 2, h: 2 },
    ],
    render: (d) => <TablaFunnels data={d} />,
  },
};
