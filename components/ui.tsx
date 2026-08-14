'use client';

/**
 * Kit de UI compartido del panel — tema oscuro, mismo lenguaje visual que el
 * `/admin` de los funnels. La paleta vive en tokens de `tailwind.config.ts`
 * (canvas, surface, surface-raised, border-subtle, border-strong y los tonos
 * good/warn/bad/info), no hardcodeada acá.
 *
 * Este archivo es la razón por la que el rediseño corre por olas: lo importan
 * las 8 pantallas sin poder modificarlo. Las firmas de los componentes que ya
 * existían no cambiaron (D-R10): este task SÓLO agregó Grid, Widget,
 * ChartFrame, Skeleton, Toolbar, IconButton y fmtAxis.
 *
 * El `'use client'` de arriba es necesario para ChartFrame (monta
 * ResponsiveContainer de recharts). Los componentes siguen sin hooks: todo
 * llega por props, el estado vive en las pantallas.
 *
 * Accesibilidad, no opcional:
 *   - Las barras llevan `role="img"` con `aria-label` (un lector de pantalla
 *     no ve el ancho de un div).
 *   - Los colores nunca son el único portador de información: el peor paso de
 *     BarRow lleva además el texto "peor", no solo rojo.
 *   - Todo control interactivo es un `<button>` o `<a>` real, alcanzable con
 *     Tab y con foco visible. IconButton exige `label` en el tipo.
 */

import type { ReactNode } from 'react';
import { Children, cloneElement, isValidElement } from 'react';
import type { ReactElement } from 'react';
import { ResponsiveContainer, Tooltip } from 'recharts';
import { ArrowsOut, DotsSixVertical, TrendDown, TrendUp } from '@phosphor-icons/react';

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';

// ─── Tonos ─────────────────────────────────────────────────────────────────

const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-neutral-300',
  good: 'text-good-400',
  warn: 'text-warn-400',
  bad: 'text-bad-400',
  info: 'text-info-400',
};

const TONE_PILL: Record<Tone, string> = {
  neutral: 'bg-overlay/6 text-neutral-300 ring-border-strong',
  good: 'bg-good-500/15 text-good-300 ring-good-500/20',
  warn: 'bg-warn-500/15 text-warn-300 ring-warn-500/20',
  bad: 'bg-bad-500/15 text-bad-300 ring-bad-500/20',
  info: 'bg-info-500/15 text-info-300 ring-info-500/20',
};

const TONE_BAR: Record<Tone, string> = {
  neutral: 'bg-neutral-400',
  good: 'bg-good-500',
  warn: 'bg-warn-500',
  bad: 'bg-bad-500',
  info: 'bg-info-500',
};

// ─── Card ──────────────────────────────────────────────────────────────────

export function Card({
  title,
  hint,
  children,
  className,
}: {
  title?: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={`rounded-2xl border border-border-subtle bg-surface shadow-card ${
        className ?? ''
      }`}
    >
      {(title || hint) && (
        <div className="flex flex-col gap-1 border-b border-border-subtle px-5 py-4">
          {title && <h2 className="text-sm font-semibold text-neutral-100">{title}</h2>}
          {hint && <p className="text-xs text-neutral-500">{hint}</p>}
        </div>
      )}
      <div className="p-5">{children}</div>
    </div>
  );
}

// ─── StatCard (KPI) ─────────────────────────────────────────────────────────

export function StatCard({
  label,
  value,
  sub,
  tone = 'neutral',
  trend,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: Tone;
  trend?: number;
}): JSX.Element {
  const trendUp = typeof trend === 'number' && trend >= 0;
  return (
    <div className="rounded-2xl border border-border-subtle bg-surface p-4 shadow-inset-highlight">
      <div className="truncate text-xs font-medium text-neutral-400">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span
          className={`font-mono text-2xl font-semibold tabular-nums tracking-tight ${
            tone === 'neutral' ? 'text-neutral-50' : TONE_TEXT[tone]
          }`}
        >
          {value}
        </span>
        {typeof trend === 'number' && (
          <span
            className={`flex items-center gap-0.5 font-mono text-xs font-semibold tabular-nums ${
              trendUp ? 'text-good-400' : 'text-bad-400'
            }`}
          >
            {trendUp ? (
              <TrendUp size={12} weight="bold" aria-hidden="true" />
            ) : (
              <TrendDown size={12} weight="bold" aria-hidden="true" />
            )}
            {fmtPct(Math.abs(trend))}
          </span>
        )}
      </div>
      {sub && <div className="mt-1 text-xs text-neutral-500">{sub}</div>}
    </div>
  );
}

// ─── Badge / Pill ────────────────────────────────────────────────────────────

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: Tone;
}): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${TONE_PILL[tone]}`}
    >
      {children}
    </span>
  );
}

// ─── Banner ─────────────────────────────────────────────────────────────────

export function Banner({
  tone,
  title,
  children,
}: {
  tone: Tone;
  title?: string;
  children: ReactNode;
}): JSX.Element {
  const map: Record<Tone, string> = {
    neutral: 'border-border-strong bg-overlay/3 text-neutral-200',
    good: 'border-good-500/20 bg-good-500/[0.08] text-good-200',
    warn: 'border-warn-500/20 bg-warn-500/[0.08] text-warn-200',
    bad: 'border-bad-500/20 bg-bad-500/[0.08] text-bad-200',
    info: 'border-info-500/20 bg-info-500/[0.08] text-info-200',
  };
  return (
    <div className={`rounded-xl border px-4 py-2.5 text-xs ${map[tone]}`}>
      {title && <div className="mb-1 font-semibold">{title}</div>}
      {children}
    </div>
  );
}

// ─── Tabla ──────────────────────────────────────────────────────────────────

export type Column<T> = {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right';
  className?: string;
};

export function Table<T>({
  rows,
  columns,
  empty = 'Sin datos',
}: {
  rows: T[];
  columns: Column<T>[];
  empty?: string;
}): JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border-subtle">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500 ${
                  c.align === 'right' ? 'text-right' : ''
                } ${c.className ?? ''}`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-8 text-center text-sm text-neutral-500">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr
                key={i}
                className="border-b border-overlay/4 last:border-0 hover:bg-overlay/2"
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={`px-3 py-2.5 text-neutral-200 ${
                      c.align === 'right' ? 'font-mono text-right tabular-nums' : ''
                    } ${c.className ?? ''}`}
                  >
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ─── BarRow — la barra del embudo ───────────────────────────────────────────

export function BarRow({
  label,
  pct,
  count,
  tone = 'neutral',
  highlight = false,
}: {
  label: string;
  pct: number;
  count: number;
  tone?: Tone;
  highlight?: boolean;
}): JSX.Element {
  // El ancho de la barra es la única cosa visual: clamp contra 0..100 para
  // que un dato raro no deforme el layout.
  const clamped = Math.min(100, Math.max(0, pct));
  const barTone = highlight ? 'bad' : tone;
  return (
    <div className="flex h-9 items-center gap-3">
      <span className="w-44 shrink-0 truncate text-xs font-medium text-neutral-300" title={label}>
        {label}
      </span>
      <div
        role="img"
        aria-label={`${label}: ${fmtPct(pct)} (${fmtInt(count)})`}
        className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-overlay/6"
      >
        <div
          className={`h-full rounded-full ${TONE_BAR[barTone]}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span
        className={`w-16 shrink-0 text-right font-mono text-xs font-semibold tabular-nums ${
          highlight ? 'text-bad-400' : 'text-neutral-200'
        }`}
      >
        {fmtPct(pct)}
      </span>
      <span className="w-20 shrink-0 text-right font-mono text-xs tabular-nums text-neutral-400">
        {fmtInt(count)}
      </span>
      {highlight && (
        <span className="w-10 shrink-0 text-right text-[11px] font-semibold text-bad-400">
          peor
        </span>
      )}
    </div>
  );
}

// ─── Estados ────────────────────────────────────────────────────────────────

export function Spinner(): JSX.Element {
  return (
    <span
      role="status"
      aria-label="Cargando"
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-overlay/20 border-t-overlay/80"
    />
  );
}

export function EmptyState({
  title,
  hint,
}: {
  title: string;
  hint?: string;
}): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-1 py-10 text-center">
      <p className="text-sm font-medium text-neutral-300">{title}</p>
      {hint && <p className="text-xs text-neutral-500">{hint}</p>}
    </div>
  );
}

// ─── Formateadores — uno solo por concepto ──────────────────────────────────
// Los cuatro paneles formatean distinto si cada uno usa su propio
// Intl.NumberFormat: estos helpers son el formato único.

const intFmt = new Intl.NumberFormat('es-AR');

/** 12.345 */
export function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return intFmt.format(n);
}

/** 12,3 % — con coma decimal es-AR y espacio antes del signo. */
export function fmtPct(n: number, decimals: number = 1): string {
  if (!Number.isFinite(n)) return '—';
  const fmt = new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${fmt.format(n)} %`;
}

/** € 1.234,56 · $ 1.234,56 — es-AR pone el símbolo con espacio. */
export function fmtMoney(n: number, currency: string): string {
  if (!Number.isFinite(n)) return '—';
  const code = currency.toUpperCase();
  try {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    // Código de moneda que el ICU no conoce: nunca romper el panel por eso.
    return `${code} ${intFmt.format(n)}`;
  }
}

const dateFmt = new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: 'short' });
const dateTimeFmt = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

// El ICU de es-AR abrevia los meses con punto ("ago.") y el spec del kit
// pide "ago": el punto final no aporta nada y solo ensucia la columna.
function stripTrailingDot(s: string): string {
  return s.endsWith('.') ? s.slice(0, -1) : s;
}

/** 11 ago */
export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return stripTrailingDot(dateFmt.format(d));
}

/** 11 ago 14:03 */
export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return stripTrailingDot(dateTimeFmt.format(d));
}

// ─── Primitivos nuevos del rediseño (T01) ──────────────────────────────────

/** La grilla de 4 columnas del plan (D-R03). Colapsa a 2 en md y 1 en móvil. */
export function Grid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={`grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4 ${className ?? ''}`}>
      {children}
    </div>
  );
}

/**
 * El contenedor de un widget. Ocupa `w` × `h` celdas de la Grid.
 * `onEdit` es opcional: sin él el widget es de sólo lectura (modo normal);
 * con él muestra el asa de arrastre y el menú de tamaño (modo edición).
 */
export function Widget({
  title,
  hint,
  w,
  h,
  children,
  className,
  onEdit,
}: {
  title?: string;
  hint?: string;
  w: 1 | 2;
  h: 1 | 2;
  children: ReactNode;
  className?: string;
  onEdit?: () => void;
}): JSX.Element {
  return (
    <div
      className={`relative h-full rounded-2xl border border-border-subtle bg-surface shadow-inset-highlight ${
        className ?? ''
      }`}
    >
      {/*
        Padding contenido y label en mayúsculas chicas. Con `px-5 py-4` + `p-5`
        un KPI de 1x1 quedaba con el número nadando en aire y la tarjeta se veía
        vacía; el label en versalitas además lo separa del número de un vistazo
        en lugar de competir con él, que es como se leen las tarjetas de un
        panel y no como un título de sección.

        El `pr-16` del header deja lugar a los dos controles de edición, que
        están posicionados absolutos arriba a la derecha: sin eso, un título
        largo se les mete abajo.
      */}
      <div className="flex h-full flex-col">
        {(title || hint) && (
          <div className="flex flex-col gap-0.5 border-b border-border-subtle px-4 py-3 pr-16">
            {title && (
              <h2 className="truncate text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
                {title}
              </h2>
            )}
            {hint && <p className="text-xs leading-snug text-neutral-500">{hint}</p>}
          </div>
        )}
        <div className="min-h-0 flex-1 p-4">{children}</div>
      </div>
      {onEdit && (
        <div className="absolute right-2 top-2 flex items-center gap-1">
          <span
            aria-hidden
            title="Arrastrar para reordenar"
            className="flex h-6 w-6 cursor-grab items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-overlay/4 hover:text-neutral-300 active:cursor-grabbing"
          >
            <DotsSixVertical size={14} weight="bold" />
          </span>
          <IconButton label="Tamaño del widget" onClick={onEdit}>
            <ArrowsOut size={14} weight="bold" />
          </IconButton>
        </div>
      )}
    </div>
  );
}

/**
 * El marco de un gráfico: alto fijo, ResponsiveContainer y el Tooltip común.
 * Existe porque hoy el MISMO Tooltip está duplicado idéntico en ResumenView
 * L389-395 y VentasView L679-685, y cada vista define su propio fmtAxis.
 *
 * Si el gráfico trae su propio `<Tooltip>` (porque necesita filas propias:
 * moneda, totales), se respeta y no se inyecta el común. El común muestra la
 * etiqueta del dato y una fila por serie con el valor entero; para importes
 * pasá tu propio Tooltip.
 */
const CHART_HEIGHTS = {
  sm: 'h-48',
  md: 'h-64',
  lg: 'h-80',
} as const;

export function ChartFrame({
  alto = 'md',
  children,
}: {
  alto?: 'sm' | 'md' | 'lg';
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={CHART_HEIGHTS[alto]}>
      <ResponsiveContainer width="100%" height="100%">
        {injectSharedTooltip(children as ReactElement)}
      </ResponsiveContainer>
    </div>
  );
}

/** El Tooltip común: la etiqueta del dato y una fila por serie no vacía. */
function ChartTip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string }>;
  label?: string | number;
}): JSX.Element | null {
  if (!active || !payload?.length) return null;
  const bands = payload.filter((p) => Number(p.value) !== 0);
  if (bands.length === 0) return null;
  return (
    <div className="rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-xs shadow-xl">
      {label !== undefined && label !== '' && (
        <p className="mb-1 font-semibold text-neutral-100">{label}</p>
      )}
      {bands.map((p, i) => (
        <p key={p.name ?? i} className="font-mono tabular-nums" style={{ color: p.color }}>
          {p.name ?? 'Valor'}: {fmtInt(Number(p.value))}
        </p>
      ))}
    </div>
  );
}

/**
 * Inyecta el Tooltip común en el chart hijo si todavía no trae uno.
 * `cloneElement` en el elemento raíz (el <BarChart>/<AreaChart>/…) alcanza:
 * recharts acepta el Tooltip como hijo del chart en cualquier posición.
 */
function injectSharedTooltip(
  children: ReactElement<{ children?: ReactNode }>,
): ReactElement<{ children?: ReactNode }> {
  const hasTooltip = Children.toArray(children.props.children).some(
    (child) => isValidElement(child) && child.type === Tooltip,
  );
  if (hasTooltip) return children;
  return cloneElement(children, {
    children: [
      ...Children.toArray(children.props.children),
      <Tooltip
        key="chart-frame-tooltip"
        content={<ChartTip />}
        cursor={{ fill: 'rgba(255, 255, 255, 0.04)' }}
      />,
    ],
  });
}

/** Esqueleto con la FORMA del contenido. Reemplaza al spinner centrado. */
export function Skeleton({
  variant,
  rows = 3,
}: {
  variant: 'kpi' | 'chart' | 'table' | 'text';
  rows?: number;
}): JSX.Element {
  const bar = 'animate-pulse rounded-md bg-overlay/6';
  const shell = 'rounded-2xl border border-border-subtle bg-surface';
  if (variant === 'kpi') {
    return (
      <div role="status" aria-label="Cargando" className={`${shell} p-4`}>
        <div className={`${bar} h-3 w-24`} />
        <div className={`${bar} mt-3 h-7 w-32`} />
        <div className={`${bar} mt-2 h-3 w-20`} />
      </div>
    );
  }
  if (variant === 'chart') {
    return (
      <div role="status" aria-label="Cargando" className={`${shell} p-5`}>
        <div className={`${bar} h-4 w-40`} />
        <div className={`${bar} mt-4 h-48 w-full`} />
      </div>
    );
  }
  if (variant === 'table') {
    return (
      <div role="status" aria-label="Cargando" className={`${shell} p-5`}>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className={`${bar} ${i === 0 ? 'h-4' : 'mt-3 h-3'}`} />
        ))}
      </div>
    );
  }
  return (
    <div role="status" aria-label="Cargando" className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className={`${bar} h-3 ${i % 3 === 0 ? 'w-3/4' : 'w-full'}`} />
      ))}
    </div>
  );
}

/** La barra de acciones de una pantalla: título a la izquierda, controles a la derecha. */
export function Toolbar({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold tracking-tight text-neutral-100">{title}</h1>
        {badge}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/** Un botón de sólo icono, con aria-label OBLIGATORIO en el tipo. */
export function IconButton({
  label,
  onClick,
  children,
  tone = 'neutral',
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  tone?: Tone;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border-subtle bg-surface transition-colors hover:bg-overlay/4 hover:text-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-good-500/60 disabled:cursor-not-allowed disabled:opacity-40 ${
        tone === 'neutral' ? 'text-neutral-300' : TONE_TEXT[tone]
      }`}
    >
      {children}
    </button>
  );
}

/** Eje compacto: 1,2M · 3k · 450 — sin el símbolo para no ensanchar el eje. */
export function fmtAxis(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(0)}k`;
  return String(Math.round(v));
}
