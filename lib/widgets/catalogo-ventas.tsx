'use client';

/**
 * El catálogo de widgets de Ventas (task T06 del rediseño).
 *
 * `WidgetCatalogo<VentasWidgetData>`: los datos entran UNA vez por el
 * `WidgetGrid` y bajan a cada widget, ninguno hace fetch (regla 2 del §4 del
 * plan). `VentasWidgetData` envuelve `SalesData` con el estado de
 * visualización (`showEur` y la frescura del gasto de ads) porque el contrato
 * `render: (data, size)` no deja pasar más parámetros: el toggle EUR/ARS es
 * estado de pantalla, no dato de la query, pero el widget lo necesita para
 * elegir el par Orig/Eur.
 *
 * Reglas que este archivo cumple y por qué:
 *
 * - TIPOS CON `import type`: lib/queries/sales.ts importa pg; un import de
 *   valor arrastraría el driver de Postgres al bundle del browser. Todos los
 *   tipos de acá entran como `import type` (se borran al compilar).
 * - UNIDADES: los ratios de sales.ts van en tanto por uno y se muestran con
 *   `fmtPct(x * 100)`. La ÚNICA excepción del archivo es el take rate del
 *   upsell, que devuelve 0-100: acá se reproduce inline con su unidad y NO se
 *   vuelve a multiplicar (test 8 de sales.test.ts lockea la matemática).
 * - MONEDAS: nada se convierte acá. Cada día se convirtió con su propia
 *   cotización, así que el widget elige el par Orig/Eur según el toggle y
 *   formatea con la moneda de la vista. Los ratios (ROAS, ROI, CPA) también
 *   siguen el toggle por la misma razón.
 * - CAMPOS NUEVOS (T02) `number | null` se muestran '—', no 0: fmtPct y
 *   fmtMoney ya dan '—' para valores no finitos (`(v ?? NaN) * 100`).
 * - `id` estable para siempre (clave del layout guardado), `hint` en todos
 *   los ratios, `render` usa el `size` (un KPI en 1x1 es número; en 2x1 suma
 *   el sub; en 2x2 suma un sparkline) y `tamañosPermitidos` honesto: una
 *   tabla de 50 filas no entra en 1x1.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Badge, ChartFrame, EmptyState, Table, fmtAxis, fmtDateTime, fmtInt, fmtMoney, fmtPct } from '@/components/ui';
import type { Tone } from '@/components/ui';
import { panelColors } from '@/tailwind.config';
import type { FrescuraAds } from '@/lib/ads/live';
import type { OrderRow, SalesData, SalesTotals, TierRow } from '@/lib/queries/sales';
import type { WidgetCatalogo, WidgetDef, WidgetGrupo, WidgetPlacement, WidgetSize } from './tipos';

/** Los datos que el WidgetGrid reparte entre los widgets de Ventas. */
export type VentasWidgetData = {
  sales: SalesData;
  /** true = mostrar los importes en EUR; false = moneda del funnel (ARS). */
  showEur: boolean;
  /** Antigüedad del gasto de Meta, para el widget de ads. */
  frescura?: FrescuraAds | null;
};

// ─── Helpers compartidos ───────────────────────────────────────────────────

/** La moneda de visualización resuelta: 'EUR' o la del funnel. */
function curDe(t: SalesTotals, showEur: boolean): string {
  return showEur ? 'EUR' : t.currency;
}

/** Formatea el par Orig/Eur eligiendo según el toggle. El asterisco en EUR
 *  avisa que el total está corto por órdenes sin cotización (fxStale). */
function money(t: SalesTotals, showEur: boolean, eur: number, orig: number): string {
  return `${fmtMoney(showEur ? eur : orig, curDe(t, showEur))}${showEur && t.fxStaleCount > 0 ? ' *' : ''}`;
}

// La misma matemática que upsellTakeRate/realAov en lib/queries/sales.ts (los
// tests la lockean): NO se importan acá porque el archivo arrastra pg.
// OJO CON LA UNIDAD: takeRateUpsell devuelve 0-100, ya multiplicado.
function takeRateUpsell(byTier: TierRow[]): number {
  const front = byTier.find((r) => r.tier === 'front')?.orders ?? 0;
  if (front === 0) return 0;
  const upsell = byTier.find((r) => r.tier === 'upsell')?.orders ?? 0;
  return (upsell / front) * 100;
}

function aovReal(byTier: TierRow[], net: number): number {
  const front = byTier.find((r) => r.tier === 'front')?.orders ?? 0;
  if (front === 0) return 0;
  return net / front;
}

/** Antigüedad del gasto en palabras, del valor que trajo el server. */
function edadAds(f: FrescuraAds | null | undefined): string | null {
  if (!f) return null;
  if (f.error) return 'sync con error';
  const s = f.ageSeconds;
  if (s === null) return 'nunca sincronizado';
  if (s < 90) return 'al día';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86_400) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86_400)} d`;
}

const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-neutral-50',
  good: 'text-good-400',
  warn: 'text-warn-400',
  bad: 'text-bad-400',
  info: 'text-info-400',
};

const TIER_LABEL: Record<string, string> = {
  front: 'Front',
  bump: 'Bump',
  upsell: 'Upsell',
  upsell2: 'Upsell 2',
  downsell: 'Downsell',
  unknown: 'Sin tier',
};

const TIER_TONE: Record<string, Tone> = {
  front: 'good',
  bump: 'info',
  upsell: 'neutral',
  upsell2: 'neutral',
  downsell: 'neutral',
  unknown: 'warn',
};

const STATUS_TONE: Record<string, Tone> = {
  approved: 'good',
  refunded: 'bad',
  chargeback: 'bad',
  pending: 'warn',
};

// Colores del mix por tier: todos de la paleta de tailwind.config.ts
// (panelColors + los tonos -400 de good/bad/info), no literales nuevos.
const TIER_COLOR: Record<string, string> = {
  front: panelColors.good,
  bump: panelColors.info,
  upsell: panelColors.warn,
  upsell2: '#38bdf8',
  downsell: '#fb7185',
  unknown: panelColors.axis,
};

// ─── Cuerpo de KPI ─────────────────────────────────────────────────────────

function KpiCuerpo({
  valor,
  sub,
  tone,
  tamaño,
  spark,
}: {
  valor: string;
  sub?: ReactNode;
  tone: Tone;
  tamaño: WidgetSize;
  spark?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex h-full flex-col">
      <div
        className={`font-mono font-semibold tabular-nums tracking-tight ${TONE_TEXT[tone]} ${
          tamaño.w === 2 ? 'text-3xl' : 'text-2xl'
        }`}
      >
        {valor}
      </div>
      {(tamaño.w === 2 || tamaño.h === 2) && sub !== undefined && sub !== null && (
        <div className="mt-1 text-xs text-neutral-500">{sub}</div>
      )}
      {spark && <div className="mt-2 min-h-0 flex-1">{spark}</div>}
    </div>
  );
}

/** La fábrica de los KPI: 1x1 es número solo (el label vive en el header del
 *  widget), 2x1 suma el sub, y en 2x2 se agrega el sparkline si lo tiene. */
function kpi(config: {
  id: string;
  label: string;
  hint?: string;
  grupo: WidgetGrupo;
  valor: (d: VentasWidgetData) => string;
  sub?: (d: VentasWidgetData) => ReactNode;
  tone?: (d: VentasWidgetData) => Tone;
  tamaño?: WidgetSize;
  tamaños?: WidgetSize[];
  spark?: (d: VentasWidgetData) => ReactNode;
}): WidgetDef<VentasWidgetData> {
  const tamaño = config.tamaño ?? { w: 1, h: 1 };
  return {
    id: config.id,
    label: config.label,
    hint: config.hint,
    grupo: config.grupo,
    tamañoPorDefecto: tamaño,
    tamañosPermitidos: config.tamaños ?? [
      { w: 1, h: 1 },
      { w: 2, h: 1 },
    ],
    render: (d, size) => (
      <KpiCuerpo
        valor={config.valor(d)}
        sub={size.w === 2 || size.h === 2 ? config.sub?.(d) : undefined}
        tone={config.tone?.(d) ?? 'neutral'}
        tamaño={size}
        spark={size.h === 2 ? config.spark?.(d) : undefined}
      />
    ),
  };
}

// ─── Sparkline del neto (para el 2x2 del widget Neto) ──────────────────────

function sparkNeto(sales: SalesData, showEur: boolean): ReactNode {
  const rows = sales.byDay
    .filter((d) => d.orders !== 0)
    .map((d) => ({ day: d.day.slice(5), net: showEur ? d.netEur : d.netOrig }));
  if (rows.length < 2) {
    return <p className="text-xs text-neutral-500">Sin serie para graficar</p>;
  }
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={rows} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="spark-ventas-neto" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={panelColors.good} stopOpacity={0.25} />
            <stop offset="100%" stopColor={panelColors.good} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="net"
          stroke={panelColors.good}
          strokeWidth={1.5}
          fill="url(#spark-ventas-neto)"
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ─── Gráficos por día ──────────────────────────────────────────────────────

type PuntoDia = { day: string; orders: number; net: number; refunded: number };

function serieDia(sales: SalesData, showEur: boolean): PuntoDia[] {
  return sales.byDay.map((d) => ({
    day: d.day,
    orders: d.orders,
    net: showEur ? d.netEur : d.netOrig,
    refunded: showEur ? d.refundedEur : d.refundedOrig,
  }));
}

function TipDia({
  active,
  payload,
  currency,
}: {
  active?: boolean;
  payload?: Array<{ payload: PuntoDia }>;
  currency: string;
}): JSX.Element | null {
  if (!active || !payload?.length) return null;
  const d = payload[0]!.payload;
  return (
    <div className="rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-xs shadow-xl">
      <p className="mb-1 font-semibold text-neutral-100">{d.day}</p>
      <p className="font-mono tabular-nums text-good-400">Neto: {fmtMoney(d.net, currency)}</p>
      <p className="font-mono tabular-nums text-bad-400">
        Devuelto: {fmtMoney(Math.abs(d.refunded), currency)}
      </p>
      <p className="font-mono tabular-nums text-neutral-400">Órdenes: {fmtInt(d.orders)}</p>
    </div>
  );
}

const EJES_DIA = (
  <>
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
  </>
);

function TipDevuelto({
  active,
  payload,
  currency,
}: {
  active?: boolean;
  payload?: Array<{ payload: PuntoDia }>;
  currency: string;
}): JSX.Element | null {
  if (!active || !payload?.length) return null;
  const d = payload[0]!.payload;
  return (
    <div className="rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-xs shadow-xl">
      <p className="mb-1 font-semibold text-neutral-100">{d.day}</p>
      <p className="font-mono tabular-nums text-bad-400">
        Devuelto: {fmtMoney(d.refunded, currency)}
      </p>
      <p className="font-mono tabular-nums text-neutral-400">Órdenes: {fmtInt(d.orders)}</p>
    </div>
  );
}

function Leyenda(): JSX.Element {
  return (
    <div className="mb-2 flex items-center gap-4 text-xs text-neutral-500">
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: panelColors.good }} />
        Neto
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: panelColors.bad }} />
        Devuelto
      </span>
    </div>
  );
}

// ─── Mix por tier ──────────────────────────────────────────────────────────

function TipMix({
  active,
  payload,
  currency,
}: {
  active?: boolean;
  payload?: Array<{ payload: { label: string; net: number; orders: number } }>;
  currency: string;
}): JSX.Element | null {
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload;
  return (
    <div className="rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-xs shadow-xl">
      <p className="mb-1 font-semibold text-neutral-100">{p.label}</p>
      <p className="font-mono tabular-nums text-neutral-200">{fmtMoney(p.net, currency)}</p>
      <p className="font-mono tabular-nums text-neutral-400">{fmtInt(p.orders)} órdenes</p>
    </div>
  );
}

// ─── Email enmascarado (igual que la tabla que existía en VentasView) ──────

function MaskedEmail({ email }: { email: string | null }): JSX.Element {
  const [open, setOpen] = useState(false);
  if (!email) return <span className="text-neutral-600">—</span>;
  const at = email.indexOf('@');
  const masked = at > 0 ? `${email.slice(0, Math.min(2, at))}***${email.slice(at)}` : '***';
  return (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      aria-label={open ? 'Ocultar email completo' : 'Mostrar email completo'}
      className="rounded-sm font-mono tabular-nums text-neutral-300 underline decoration-dotted underline-offset-2 transition-colors hover:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
    >
      {open ? email : masked}
    </button>
  );
}

function attributionLabel(r: OrderRow): string {
  const parts = [r.utmSource, r.utmCampaign].filter((v) => v !== '(directo)');
  return parts.length > 0 ? parts.join(' · ') : '(directo)';
}

// ─── El catálogo ───────────────────────────────────────────────────────────

export const catalogoVentas: WidgetCatalogo<VentasWidgetData> = {
  // ── Plata ──
  'ventas-neto': kpi({
    id: 'ventas-neto',
    label: 'Neto',
    hint: 'Bruto − devuelto − comisiones − costos de producto. Es el número principal.',
    grupo: 'plata',
    tamaño: { w: 2, h: 1 },
    tamaños: [
      { w: 1, h: 1 },
      { w: 2, h: 1 },
      { w: 2, h: 2 },
    ],
    valor: (d) => money(d.sales.totals, d.showEur, d.sales.totals.netEur, d.sales.totals.netOrig),
    sub: () => 'Bruto − devuelto − comisiones − costos',
    tone: () => 'good',
    spark: (d) => sparkNeto(d.sales, d.showEur),
  }),
  'ventas-resultado': kpi({
    id: 'ventas-resultado',
    label: 'Resultado',
    hint: 'Neto − gasto en ads: la plata que queda de verdad.',
    grupo: 'plata',
    tamaño: { w: 2, h: 1 },
    valor: (d) => money(d.sales.totals, d.showEur, d.sales.totals.resultEur, d.sales.totals.resultOrig),
    sub: () => 'Neto − gasto en ads',
    tone: (d) => (d.showEur ? d.sales.totals.resultEur < 0 : d.sales.totals.resultOrig < 0) ? 'bad' : 'good',
  }),
  'ventas-bruto': kpi({
    id: 'ventas-bruto',
    label: 'Bruto',
    grupo: 'plata',
    valor: (d) => money(d.sales.totals, d.showEur, d.sales.totals.grossEur, d.sales.totals.grossOrig),
    sub: () => 'Sin descontar nada',
  }),
  'ventas-devueltos': kpi({
    id: 'ventas-devueltos',
    label: 'Devuelto',
    grupo: 'plata',
    valor: (d) => money(d.sales.totals, d.showEur, d.sales.totals.refundedEur, d.sales.totals.refundedOrig),
    sub: () => 'Reembolsos + chargebacks',
    tone: () => 'bad',
  }),
  'ventas-comisiones': kpi({
    id: 'ventas-comisiones',
    label: 'Comisiones',
    hint: 'Comisión de la pasarela de pago, solo de las aprobadas.',
    grupo: 'plata',
    valor: (d) => money(d.sales.totals, d.showEur, d.sales.totals.commissionsEur, d.sales.totals.commissionsOrig),
    sub: (d) => {
      const t = d.sales.totals;
      const g = d.showEur ? t.grossEur : t.grossOrig;
      const c = d.showEur ? t.commissionsEur : t.commissionsOrig;
      return g > 0 ? `${fmtPct((c / g) * 100, 2)} del bruto` : 'de la pasarela de pago';
    },
    tone: (d) => ((d.showEur ? d.sales.totals.commissionsEur : d.sales.totals.commissionsOrig) > 0 ? 'warn' : 'neutral'),
  }),
  'ventas-costos': kpi({
    id: 'ventas-costos',
    label: 'Costos',
    hint: 'Costo de los productos vendidos, solo de las aprobadas.',
    grupo: 'plata',
    valor: (d) => money(d.sales.totals, d.showEur, d.sales.totals.costsEur, d.sales.totals.costsOrig),
    sub: (d) => {
      const t = d.sales.totals;
      const g = d.showEur ? t.grossEur : t.grossOrig;
      const c = d.showEur ? t.costsEur : t.costsOrig;
      return g > 0 ? `${fmtPct((c / g) * 100, 2)} del bruto` : 'costo de los productos vendidos';
    },
    tone: (d) => ((d.showEur ? d.sales.totals.costsEur : d.sales.totals.costsOrig) > 0 ? 'warn' : 'neutral'),
  }),
  'ventas-ads': kpi({
    id: 'ventas-ads',
    label: 'Gasto en ads',
    hint: 'Publicidad del rango: un costo por día que existe aunque no haya ventas. Viene de Meta y puede quedar atrás sin que nada falle.',
    grupo: 'plata',
    valor: (d) => money(d.sales.totals, d.showEur, d.sales.totals.adSpendEur, d.sales.totals.adSpendOrig),
    sub: (d) => {
      const t = d.sales.totals;
      const s = d.showEur;
      const cpa = s ? t.cpaEur : t.cpa;
      const base = cpa > 0 ? `CPA ${fmtMoney(cpa, curDe(t, s))}` : 'gasto de publicidad';
      const edad = edadAds(d.frescura);
      return edad ? `${base} · ${edad}` : base;
    },
    tone: (d) =>
      d.frescura?.error
        ? 'bad'
        : (d.showEur ? d.sales.totals.adSpendEur : d.sales.totals.adSpendOrig) > 0
          ? 'warn'
          : 'neutral',
  }),
  'ventas-gasto-total': kpi({
    id: 'ventas-gasto-total',
    label: 'Gasto total',
    hint: 'Comisiones + costos + publicidad: todo lo que se puso para producir estas ventas.',
    grupo: 'plata',
    valor: (d) => money(d.sales.totals, d.showEur, d.sales.totals.spendTotalEur, d.sales.totals.spendTotalOrig),
    sub: () => 'Comisiones + costos + publicidad',
  }),
  'ventas-ticket': kpi({
    id: 'ventas-ticket',
    label: 'Ticket promedio',
    hint: 'Neto ÷ órdenes aprobadas.',
    grupo: 'plata',
    valor: (d) => {
      const t = d.sales.totals;
      const v = d.showEur ? t.avgTicketEur : t.avgTicketOrig;
      return v === null ? '—' : money(t, d.showEur, v, v);
    },
    sub: () => 'Neto ÷ órdenes aprobadas',
  }),

  // ── Volumen ──
  'ventas-ordenes': kpi({
    id: 'ventas-ordenes',
    label: 'Órdenes aprobadas',
    hint: 'Una orden devuelta sigue contando en las devueltas y su plata se resta del neto.',
    grupo: 'volumen',
    valor: (d) => fmtInt(d.sales.totals.ordersApproved),
    sub: (d) =>
      `${fmtInt(d.sales.totals.ordersRefunded)} devueltas · ${fmtInt(d.sales.totals.ordersChargeback)} chargebacks`,
  }),
  'ventas-ordenes-devueltas': kpi({
    id: 'ventas-ordenes-devueltas',
    label: 'Órdenes devueltas',
    grupo: 'volumen',
    valor: (d) => fmtInt(d.sales.totals.ordersRefunded),
    sub: () => 'Reembolsos del rango',
  }),
  'ventas-ordenes-chargeback': kpi({
    id: 'ventas-ordenes-chargeback',
    label: 'Chargebacks',
    grupo: 'volumen',
    valor: (d) => fmtInt(d.sales.totals.ordersChargeback),
    sub: () => 'Contracargos del rango',
  }),

  // ── Eficiencia ──
  'ventas-roas': kpi({
    id: 'ventas-roas',
    label: 'ROAS',
    hint: 'Bruto ÷ gasto en ads, en la moneda de la vista. < 1× la publicidad no se pagó sola.',
    grupo: 'eficiencia',
    valor: (d) => {
      const t = d.sales.totals;
      const v = d.showEur ? t.roasEur : t.roas;
      return v > 0 ? `${v.toFixed(2)}×` : '—';
    },
    sub: (d) => {
      const t = d.sales.totals;
      return (d.showEur ? t.roasEur : t.roas) > 0 ? 'bruto ÷ gasto en ads' : 'sin gasto cargado';
    },
    tone: (d) => {
      const v = d.showEur ? d.sales.totals.roasEur : d.sales.totals.roas;
      return v === 0 ? 'neutral' : v < 1 ? 'bad' : v < 2 ? 'warn' : 'good';
    },
  }),
  'ventas-roi': kpi({
    id: 'ventas-roi',
    label: 'ROI',
    hint: 'Resultado ÷ gasto total (comisiones + costos + ads). 3,5 % = por cada 100 puestos vuelven 103,50.',
    grupo: 'eficiencia',
    valor: (d) => {
      const t = d.sales.totals;
      const s = d.showEur;
      const gasto = s ? t.spendTotalEur : t.spendTotalOrig;
      return gasto > 0 ? fmtPct((s ? t.roiEur : t.roi) * 100, 1) : '—';
    },
    sub: (d) => {
      const t = d.sales.totals;
      const s = d.showEur;
      return s
        ? t.spendTotalEur > 0
          ? `resultado ÷ ${money(t, s, t.spendTotalEur, t.spendTotalOrig)} de gasto total`
          : 'sin gasto cargado'
        : t.spendTotalOrig > 0
          ? `resultado ÷ ${money(t, s, t.spendTotalEur, t.spendTotalOrig)} de gasto total`
          : 'sin gasto cargado';
    },
    tone: (d) => {
      const t = d.sales.totals;
      const s = d.showEur;
      const gasto = s ? t.spendTotalEur : t.spendTotalOrig;
      const v = s ? t.roiEur : t.roi;
      return gasto === 0 ? 'neutral' : v < 0 ? 'bad' : v < 0.2 ? 'warn' : 'good';
    },
  }),
  'ventas-cpa': kpi({
    id: 'ventas-cpa',
    label: 'CPA',
    hint: 'Gasto en ads ÷ órdenes aprobadas: cuánto cuesta conseguir cada venta.',
    grupo: 'eficiencia',
    valor: (d) => {
      const t = d.sales.totals;
      const s = d.showEur;
      const v = s ? t.cpaEur : t.cpa;
      return v > 0 ? money(t, s, v, v) : '—';
    },
    sub: () => 'gasto en ads ÷ órdenes aprobadas',
  }),
  'ventas-margen-neto': kpi({
    id: 'ventas-margen-neto',
    label: 'Margen neto',
    hint: 'Neto ÷ bruto, sin ads. 0,35 = 35 %. Puede ser negativo, y así se muestra.',
    grupo: 'eficiencia',
    valor: (d) => fmtPct(((d.sales.totals.netMargin ?? NaN) * 100), 1),
    sub: () => 'Neto ÷ bruto (sin ads)',
    tone: (d) => {
      const v = d.sales.totals.netMargin;
      if (v === null) return 'neutral';
      if (v < 0) return 'bad';
      return v < 0.3 ? 'warn' : 'good';
    },
  }),
  'ventas-tasa-comision': kpi({
    id: 'ventas-tasa-comision',
    label: 'Tasa de comisión',
    hint: 'Comisiones de la pasarela ÷ bruto. 0,03 = 3 %.',
    grupo: 'eficiencia',
    valor: (d) => fmtPct(((d.sales.totals.commissionRate ?? NaN) * 100), 2),
    sub: () => 'comisiones ÷ bruto',
  }),
  'ventas-tasa-costo': kpi({
    id: 'ventas-tasa-costo',
    label: 'Tasa de costo',
    hint: 'Costo de producto ÷ bruto. 0,40 = 40 %.',
    grupo: 'eficiencia',
    valor: (d) => fmtPct(((d.sales.totals.costRate ?? NaN) * 100), 2),
    sub: () => 'costo ÷ bruto',
  }),
  'ventas-take-rate-upsell': kpi({
    id: 'ventas-take-rate-upsell',
    label: 'Take rate del upsell',
    hint: 'Órdenes de tier upsell ÷ órdenes de tier front. OJO: va en 0-100, no en tanto por uno. 0 si no hubo front.',
    grupo: 'eficiencia',
    valor: (d) => fmtPct(takeRateUpsell(d.sales.byTier), 0),
    sub: () => 'órdenes de tier upsell ÷ órdenes de tier front',
  }),
  'ventas-aov-real': kpi({
    id: 'ventas-aov-real',
    label: 'AOV real',
    hint: 'Neto total ÷ órdenes de tier front: cuánto vale cada comprador nuevo.',
    grupo: 'eficiencia',
    valor: (d) => {
      const t = d.sales.totals;
      const s = d.showEur;
      const v = aovReal(d.sales.byTier, s ? t.netEur : t.netOrig);
      return v > 0 ? money(t, s, v, v) : '—';
    },
    sub: () => 'neto ÷ órdenes de tier front',
  }),

  // ── Calidad (métricas de completitud de la config: antes eran banners) ──
  'ventas-tasa-devolucion': kpi({
    id: 'ventas-tasa-devolucion',
    label: 'Tasa de devolución',
    hint: 'Devoluciones + chargebacks ÷ órdenes que fueron venta. Las pending quedan fuera de los dos lados.',
    grupo: 'calidad',
    valor: (d) => fmtPct(((d.sales.totals.refundRate ?? NaN) * 100), 1),
    sub: () => 'devoluciones + chargebacks ÷ ventas',
    tone: (d) => {
      const v = d.sales.totals.refundRate;
      if (v === null) return 'neutral';
      if (v < 0.05) return 'good';
      return v < 0.15 ? 'warn' : 'bad';
    },
  }),
  'ventas-sin-comision': kpi({
    id: 'ventas-sin-comision',
    label: 'Órdenes sin comisión',
    hint: 'Aprobadas con comisión en 0: el neto está por encima de lo que realmente entra.',
    grupo: 'calidad',
    valor: (d) => fmtInt(d.sales.totals.ordersSinComision),
    sub: (d) => (
      <>
        de {fmtInt(d.sales.totals.ordersApproved)} aprobadas —{' '}
        <Link href="/config" className="underline underline-offset-2">
          cargá el % de la pasarela
        </Link>
      </>
    ),
    tone: (d) => (d.sales.totals.ordersSinComision > 0 ? 'warn' : 'neutral'),
  }),
  'ventas-sin-costo': kpi({
    id: 'ventas-sin-costo',
    label: 'Órdenes sin costo',
    hint: 'Aprobadas sin costo de producto cargado: el neto está por encima de lo que realmente queda.',
    grupo: 'calidad',
    valor: (d) => fmtInt(d.sales.totals.ordersSinCosto),
    sub: (d) => (
      <>
        de {fmtInt(d.sales.totals.ordersApproved)} aprobadas —{' '}
        <Link href="/config" className="underline underline-offset-2">
          cargá el costo de cada producto
        </Link>
      </>
    ),
    tone: (d) => (d.sales.totals.ordersSinCosto > 0 ? 'warn' : 'neutral'),
  }),

  // ── Gráficos ──
  'ventas-neto-por-dia': {
    id: 'ventas-neto-por-dia',
    label: 'Neto por día',
    hint: 'Las devoluciones van en negativo, debajo del cero.',
    grupo: 'graficos',
    tamañoPorDefecto: { w: 2, h: 2 },
    tamañosPermitidos: [{ w: 2, h: 2 }],
    render: (d) => {
      const t = d.sales.totals;
      const cur = curDe(t, d.showEur);
      if (d.sales.byDay.every((x) => x.orders === 0)) {
        return (
          <EmptyState
            title="Sin ventas en el rango"
            hint="El día de una venta es el del funnel (orders.day): la medianoche no corre de día."
          />
        );
      }
      const rows = serieDia(d.sales, d.showEur).map((r) => ({ ...r, refunded: -r.refunded }));
      return (
        <div className="flex h-full flex-col">
          <Leyenda />
          <div className="min-h-0 flex-1">
            <ChartFrame alto="lg">
              <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                {EJES_DIA}
                <Tooltip content={<TipDia currency={cur} />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                <Bar dataKey="net" fill={panelColors.good} radius={[3, 3, 0, 0]} />
                <Bar dataKey="refunded" fill={panelColors.bad} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ChartFrame>
          </div>
        </div>
      );
    },
  },
  'ventas-devueltos-por-dia': {
    id: 'ventas-devueltos-por-dia',
    label: 'Devuelto por día',
    hint: 'La plata que volvió, por día. Reembolsos + chargebacks.',
    grupo: 'graficos',
    tamañoPorDefecto: { w: 2, h: 2 },
    tamañosPermitidos: [{ w: 2, h: 2 }],
    render: (d) => {
      const t = d.sales.totals;
      const cur = curDe(t, d.showEur);
      if (d.sales.byDay.every((x) => (d.showEur ? x.refundedEur === 0 : x.refundedOrig === 0))) {
        return <EmptyState title="Sin devoluciones en el rango" />;
      }
      const rows = serieDia(d.sales, d.showEur).map((r) => ({ ...r, refunded: Math.abs(r.refunded) }));
      return (
        <div className="h-full">
          <ChartFrame alto="lg">
            <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              {EJES_DIA}
              <Tooltip content={<TipDevuelto currency={cur} />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
              <Bar dataKey="refunded" fill={panelColors.bad} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ChartFrame>
        </div>
      );
    },
  },
  'ventas-mix-tier': {
    id: 'ventas-mix-tier',
    label: 'Mix por tier',
    hint: 'Cómo se reparte el neto entre los tiers. Los tiers con neto negativo quedan fuera del gráfico (una torta no dibuja negativos); la tabla por tier los muestra.',
    grupo: 'graficos',
    tamañoPorDefecto: { w: 2, h: 2 },
    tamañosPermitidos: [{ w: 2, h: 2 }],
    render: (d) => {
      const t = d.sales.totals;
      const cur = curDe(t, d.showEur);
      const rows = d.sales.byTier
        .map((r) => ({
          tier: r.tier,
          label: TIER_LABEL[r.tier] ?? r.tier,
          net: d.showEur ? r.netEur : r.netOrig,
          orders: r.orders,
        }))
        .filter((r) => r.net > 0);
      if (rows.length === 0) {
        return <EmptyState title="Sin ventas en el rango" />;
      }
      const totalNet = rows.reduce((a, r) => a + r.net, 0);
      return (
        <div className="flex h-full flex-col">
          <div className="relative mx-auto h-44 w-full max-w-60">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Tooltip content={<TipMix currency={cur} />} />
                <Pie
                  data={rows}
                  dataKey="net"
                  nameKey="label"
                  innerRadius={52}
                  outerRadius={78}
                  paddingAngle={2}
                  strokeWidth={0}
                  isAnimationActive={false}
                >
                  {rows.map((r) => (
                    <Cell key={r.tier} fill={TIER_COLOR[r.tier] ?? panelColors.axis} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <p className="text-[11px] text-neutral-500">Neto</p>
              <p className="font-mono text-sm font-semibold tabular-nums text-neutral-50">
                {fmtMoney(totalNet, cur)}
              </p>
            </div>
          </div>
          <ul className="mt-3 space-y-1">
            {rows.map((r) => (
              <li key={r.tier} className="flex items-center justify-between gap-3 text-xs">
                <span className="flex min-w-0 items-center gap-1.5 text-neutral-300">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: TIER_COLOR[r.tier] ?? panelColors.axis }}
                  />
                  <span className="truncate">{r.label}</span>
                  <span className="text-neutral-600">{fmtInt(r.orders)}</span>
                </span>
                <span className="font-mono tabular-nums text-neutral-200">
                  {fmtPct((r.net / totalNet) * 100, 0)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      );
    },
  },

  // ── Listas ──
  'ventas-ultimas': {
    id: 'ventas-ultimas',
    label: 'Últimas ventas',
    hint: 'Las 50 más recientes del rango. El email va enmascarado: click para verlo completo.',
    grupo: 'listas',
    tamañoPorDefecto: { w: 2, h: 2 },
    tamañosPermitidos: [{ w: 2, h: 2 }],
    render: (d) => (
      <Table
        rows={d.sales.recent}
        empty="Sin ventas en el rango"
        columns={[
          {
            key: 'when',
            header: 'Fecha',
            render: (r) => (
              <span className="whitespace-nowrap font-mono text-neutral-300">{fmtDateTime(r.purchasedAt)}</span>
            ),
          },
          { key: 'email', header: 'Email', render: (r) => <MaskedEmail email={r.email} /> },
          {
            key: 'tier',
            header: 'Tier',
            render: (r) => <Badge tone={TIER_TONE[r.tier] ?? 'neutral'}>{TIER_LABEL[r.tier] ?? r.tier}</Badge>,
          },
          {
            key: 'product',
            header: 'Producto',
            render: (r) => (
              <span className="block max-w-56 truncate text-neutral-300" title={r.product ?? undefined}>
                {r.product ?? '—'}
              </span>
            ),
          },
          {
            key: 'orig',
            header: 'Original',
            align: 'right',
            render: (r) => <span className="text-neutral-300">{fmtMoney(r.amount, r.currency)}</span>,
          },
          {
            key: 'eur',
            header: 'EUR',
            align: 'right',
            render: (r) =>
              r.amountEur === null ? (
                <span className="text-neutral-600">—</span>
              ) : (
                <span className="text-neutral-300">
                  {fmtMoney(r.amountEur, 'EUR')}
                  {r.fxStale ? ' *' : ''}
                </span>
              ),
          },
          {
            key: 'status',
            header: 'Status',
            render: (r) => <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status}</Badge>,
          },
          {
            key: 'attribution',
            header: 'Atribución',
            render: (r) => <span className="text-neutral-400">{attributionLabel(r)}</span>,
          },
        ]}
      />
    ),
  },
  'ventas-campanas': {
    id: 'ventas-campanas',
    label: 'Por campaña',
    hint: 'Las 20 principales del rango; el resto se suma en «(otras)». El gasto se une por el id de la campaña de Meta.',
    grupo: 'listas',
    tamañoPorDefecto: { w: 2, h: 2 },
    tamañosPermitidos: [{ w: 2, h: 2 }],
    render: (d) => {
      const t = d.sales.totals;
      const s = d.showEur;
      return (
        <Table
          rows={d.sales.byCampaign}
          empty="Sin ventas en el rango"
          columns={[
            {
              key: 'campaign',
              header: 'Campaña',
              render: (r) =>
                r.campaign === '(otras)' ? (
                  <span className="text-neutral-500">{r.campaign}</span>
                ) : (
                  <span className="text-neutral-200">{r.campaign}</span>
                ),
            },
            { key: 'orders', header: 'Órdenes', align: 'right', render: (r) => fmtInt(r.orders) },
            { key: 'net', header: 'Neto', align: 'right', render: (r) => money(t, s, r.netEur, r.netOrig) },
            {
              key: 'spend',
              header: 'Ads',
              align: 'right',
              render: (r) =>
                r.spendOrig > 0 ? money(t, s, r.spendEur, r.spendOrig) : <span className="text-neutral-600">—</span>,
            },
            {
              key: 'roas',
              header: 'ROAS',
              align: 'right',
              render: (r) =>
                r.roas > 0 ? (
                  <span className={r.roas < 1 ? 'text-bad-400' : r.roas < 2 ? 'text-warn-400' : 'text-good-400'}>
                    {r.roas.toFixed(2)}×
                  </span>
                ) : (
                  <span className="text-neutral-600">—</span>
                ),
            },
            {
              key: 'ticket',
              header: 'Ticket',
              align: 'right',
              render: (r) => (r.orders > 0 ? money(t, s, r.netEur / r.orders, r.netOrig / r.orders) : '—'),
            },
          ]}
        />
      );
    },
  },
  'ventas-fuentes': {
    id: 'ventas-fuentes',
    label: 'Por fuente',
    hint: 'utm_source de cada venta. Las 20 principales; el resto se suma en «(otras)».',
    grupo: 'listas',
    tamañoPorDefecto: { w: 2, h: 1 },
    tamañosPermitidos: [
      { w: 2, h: 1 },
      { w: 2, h: 2 },
    ],
    render: (d) => {
      const t = d.sales.totals;
      const s = d.showEur;
      return (
        <Table
          rows={d.sales.bySource}
          empty="Sin ventas en el rango"
          columns={[
            { key: 'source', header: 'Fuente', render: (r) => <span className="text-neutral-200">{r.source}</span> },
            { key: 'orders', header: 'Órdenes', align: 'right', render: (r) => fmtInt(r.orders) },
            { key: 'net', header: 'Neto', align: 'right', render: (r) => money(t, s, r.netEur, r.netOrig) },
          ]}
        />
      );
    },
  },
  'ventas-tiers': {
    id: 'ventas-tiers',
    label: 'Por tier',
    hint: 'D11: el tier lo setea el usuario en product_map. El take rate del upsell y el AOV real son widgets aparte.',
    grupo: 'listas',
    tamañoPorDefecto: { w: 2, h: 2 },
    tamañosPermitidos: [{ w: 2, h: 2 }],
    render: (d) => {
      const t = d.sales.totals;
      const s = d.showEur;
      const totalNet = s ? t.netEur : t.netOrig;
      return (
        <Table
          rows={d.sales.byTier}
          empty="Sin ventas en el rango"
          columns={[
            {
              key: 'tier',
              header: 'Tier',
              render: (r) => <Badge tone={TIER_TONE[r.tier] ?? 'neutral'}>{TIER_LABEL[r.tier] ?? r.tier}</Badge>,
            },
            { key: 'orders', header: 'Órdenes', align: 'right', render: (r) => fmtInt(r.orders) },
            { key: 'net', header: 'Neto', align: 'right', render: (r) => money(t, s, r.netEur, r.netOrig) },
            {
              key: 'pct',
              header: '% del neto',
              align: 'right',
              render: (r) => (totalNet > 0 ? fmtPct(((s ? r.netEur : r.netOrig) / totalNet) * 100, 0) : '—'),
            },
            {
              key: 'ticket',
              header: 'Ticket prom.',
              align: 'right',
              render: (r) => (r.orders > 0 ? money(t, s, r.netEur / r.orders, r.netOrig / r.orders) : '—'),
            },
          ]}
        />
      );
    },
  },
};

/**
 * El layout por defecto de Ventas (D-R04: se muestra cuando la fila de
 * settings está en null, o sea, nadie guardó todavía).
 *
 * La decisión de jerarquía de esta task: DOS números grandes arriba (Neto y
 * Resultado, en 2x1), cuatro chicos abajo (ROAS, ROI, Órdenes, Ticket) y el
 * resto como tablas y gráficos. Los doce números de antes siguen disponibles
 * en el catálogo: nada se esconde, solo se ordena.
 */
export const LAYOUT_VENTAS_POR_DEFECTO: WidgetPlacement[] = [
  { id: 'ventas-neto', w: 2, h: 1 },
  { id: 'ventas-resultado', w: 2, h: 1 },
  { id: 'ventas-roas', w: 1, h: 1 },
  { id: 'ventas-roi', w: 1, h: 1 },
  { id: 'ventas-ordenes', w: 1, h: 1 },
  { id: 'ventas-ticket', w: 1, h: 1 },
  { id: 'ventas-neto-por-dia', w: 2, h: 2 },
  { id: 'ventas-campanas', w: 2, h: 2 },
  { id: 'ventas-tiers', w: 2, h: 2 },
  { id: 'ventas-ultimas', w: 2, h: 2 },
];
