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
import {
  ArrowsOut,
  ChartLineUp,
  DotsSixVertical,
  TrendDown,
  TrendUp,
} from '@phosphor-icons/react';

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
  neutral: 'bg-overlay/7 text-neutral-300 ring-border-strong',
  good: 'bg-good-500/14 text-good-300 ring-good-500/22',
  warn: 'bg-warn-500/14 text-warn-300 ring-warn-500/22',
  bad: 'bg-bad-500/14 text-bad-300 ring-bad-500/22',
  info: 'bg-info-500/14 text-info-300 ring-info-500/22',
};

/**
 * El relleno de las barras. Va en degradado vertical y no en color plano: una
 * barra plana se lee como un rectángulo de color, con el degradado se lee como
 * un volumen iluminado desde arriba, que es la misma dirección de luz que
 * usan todas las superficies del panel.
 */
const TONE_BAR: Record<Tone, string> = {
  neutral: 'bg-gradient-to-b from-neutral-300 to-neutral-500',
  good: 'bg-gradient-to-b from-good-400 to-good-600',
  warn: 'bg-gradient-to-b from-warn-400 to-warn-600',
  bad: 'bg-gradient-to-b from-bad-400 to-bad-600',
  info: 'bg-gradient-to-b from-info-400 to-info-600',
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
    /*
      `sheen` dibuja el reflejo de 1px en el canto superior (ver globals.css):
      es un degradado que se apaga en las puntas, no un borde parejo, así la
      tarjeta parece iluminada desde arriba en lugar de contorneada.

      El hint va con `text-pretty` para que no quede una palabra huérfana sola
      en la última línea, que es lo que pasaba con los hints largos de Embudo.
    */
    <div
      className={`sheen rounded-2xl border border-border-subtle bg-surface shadow-card ${
        className ?? ''
      }`}
    >
      {(title || hint) && (
        <div className="flex flex-col gap-1 border-b border-border-subtle px-5 py-4">
          {title && (
            <h2 className="text-sm font-semibold -tracking-[0.01em] text-neutral-100">
              {title}
            </h2>
          )}
          {hint && (
            <p className="max-w-[68ch] text-pretty text-xs leading-relaxed text-neutral-500">
              {hint}
            </p>
          )}
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
    /*
      El KPI es la pieza que más se mira del panel, así que es la que más gana
      con jerarquía: el número creció a 30px con tracking negativo (a ese
      tamaño el espaciado por defecto se ve suelto) y la etiqueta se apagó a
      `neutral-400`. Antes competían: los dos eran chicos y del mismo peso.

      `lift` levanta la tarjeta 2px al hover con la curva spring. En una grilla
      de 4 KPIs, es lo que confirma que cada uno es un objeto separado.
    */
    <div className="sheen lift rounded-2xl border border-border-subtle bg-surface p-4 shadow-card hover:border-overlay/11 hover:shadow-card-hover">
      <div className="truncate text-xs font-medium text-neutral-400">{label}</div>
      <div className="mt-2 flex items-baseline gap-2">
        <span
          className={`font-mono text-[1.875rem] font-semibold leading-none tabular-nums -tracking-[0.03em] ${
            tone === 'neutral' ? 'text-neutral-50' : TONE_TEXT[tone]
          }`}
        >
          {value}
        </span>
        {typeof trend === 'number' && (
          /*
            La tendencia va en su propia pastilla teñida: suelta al lado del
            número parecía parte de la cifra. La flecha ADEMÁS del color, nunca
            sólo el color: en una pantalla en blanco y negro o para un daltónico
            rojo-verde, "+12 %" y "-12 %" tienen que distinguirse igual.
          */
          <span
            className={`flex items-center gap-0.5 rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums ring-1 ${
              trendUp
                ? 'bg-good-500/12 text-good-300 ring-good-500/20'
                : 'bg-bad-500/12 text-bad-300 ring-bad-500/20'
            }`}
          >
            {trendUp ? (
              <TrendUp size={11} weight="bold" aria-hidden="true" />
            ) : (
              <TrendDown size={11} weight="bold" aria-hidden="true" />
            )}
            {fmtPct(Math.abs(trend))}
          </span>
        )}
      </div>
      {sub && <div className="mt-1.5 text-xs text-neutral-500">{sub}</div>}
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
    /*
      `rounded-md` y no `rounded-full`: la pastilla redonda perfecta es la forma
      por defecto de cualquier badge y hace que todos los estados se vean como
      etiquetas pegadas. Con el radio del resto del panel el badge pertenece a
      la tarjeta que lo contiene.
    */
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold tracking-[0.01em] ring-1 ${TONE_PILL[tone]}`}
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
    neutral: 'border-border-strong bg-overlay/4 text-neutral-200',
    good: 'border-good-500/22 bg-good-500/[0.09] text-good-200',
    warn: 'border-warn-500/22 bg-warn-500/[0.09] text-warn-200',
    bad: 'border-bad-500/22 bg-bad-500/[0.09] text-bad-200',
    info: 'border-info-500/22 bg-info-500/[0.09] text-info-200',
  };
  return (
    <div
      className={`rounded-xl border px-4 py-3 text-xs leading-relaxed shadow-inset-highlight ${map[tone]}`}
    >
      {title && <div className="mb-1 font-semibold -tracking-[0.01em]">{title}</div>}
      <div className="max-w-[70ch] text-pretty">{children}</div>
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
              /*
                Encabezado en caja normal, no en VERSALITAS. Los headers ya
                vienen en sentence case desde las vistas ("Campaña",
                "Sesiones") y forzarlos a mayúsculas sólo los hacía gritar y
                más difíciles de leer de reojo. El peso y el tono alcanzan para
                separarlos de los datos.
              */
              <th
                key={c.key}
                scope="col"
                className={`px-3 pb-2.5 pt-1 text-xs font-medium text-neutral-400 ${
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
              <td colSpan={columns.length} className="px-3 py-10 text-center text-sm text-neutral-500">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr
                key={i}
                className="border-b border-overlay/4 transition-colors duration-150 last:border-0 hover:bg-overlay/4"
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={`px-3 py-3 text-neutral-200 ${
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
      {/*
        El canal va HUNDIDO (sombra hacia adentro) y la barra tiene su propio
        reflejo arriba: el mismo par surco/objeto que el control segmentado del
        Nav. Con fondo plano las dos piezas se leían como un solo rectángulo
        bicolor.

        El ancho transiciona en 500ms: cuando cambia el rango o el filtro, las
        barras se reacomodan en lugar de saltar de un valor al otro.
      */}
      <div
        role="img"
        aria-label={`${label}: ${fmtPct(pct)} (${fmtInt(count)})`}
        className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-canvas/70 shadow-[inset_0_1px_2px_0_rgba(4,6,14,0.7),inset_0_0_0_1px_rgba(255,255,255,0.04)]"
      >
        <div
          className={`h-full rounded-full shadow-[inset_0_1px_0_0_rgba(255,255,255,0.22)] transition-[width] duration-500 ease-smooth ${TONE_BAR[barTone]}`}
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
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-overlay/14 border-t-good-400"
    />
  );
}

/**
 * El vacío COMPUESTO, no un párrafo centrado.
 *
 * Lleva una marca de agua circular arriba del texto: sin ella, una tarjeta sin
 * datos se veía como una tarjeta que no terminó de cargar. El círculo dice
 * "acá no hay nada y está bien" en lugar de "algo falló".
 *
 * `action` es opcional y va abajo: es el lugar donde una pantalla puede ofrecer
 * la salida (ir a Config, limpiar filtros) en vez de dejar al usuario en un
 * callejón.
 */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <span
        aria-hidden
        className="mb-1 flex h-11 w-11 items-center justify-center rounded-full bg-overlay/4 text-neutral-600 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]"
      >
        <ChartLineUp size={20} weight="bold" />
      </span>
      <p className="text-sm font-medium text-neutral-300">{title}</p>
      {hint && (
        <p className="max-w-[46ch] text-pretty text-xs leading-relaxed text-neutral-500">
          {hint}
        </p>
      )}
      {action && <div className="mt-2">{action}</div>}
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
      className={`sheen relative h-full rounded-2xl border border-border-subtle bg-surface shadow-card transition-[border-color,box-shadow] duration-250 hover:border-overlay/11 hover:shadow-card-hover ${
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
              <h2 className="truncate text-[11px] font-semibold uppercase tracking-[0.09em] text-neutral-400">
                {title}
              </h2>
            )}
            {hint && (
              <p className="text-pretty text-xs leading-snug text-neutral-500">{hint}</p>
            )}
          </div>
        )}
        <div className="min-h-0 flex-1 p-4">{children}</div>
      </div>
      {onEdit && (
        <div className="absolute right-2 top-2 flex items-center gap-1">
          <span
            aria-hidden
            title="Arrastrar para reordenar"
            className="flex h-7 w-7 cursor-grab items-center justify-center rounded-md text-neutral-500 transition-colors duration-250 hover:bg-overlay/7 hover:text-neutral-200 active:cursor-grabbing"
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
    /*
      El tooltip flota sobre el gráfico, así que usa `shadow-float` (la sombra
      teñida con más caída) en lugar del `shadow-xl` negro de Tailwind: sobre un
      fondo azulado, el negro puro se lee como un agujero.

      Cada serie lleva su punto de color además del texto coloreado: cuando dos
      series tienen tonos parecidos, el texto de color solo no alcanza para
      saber cuál es cuál.
    */
    <div className="rounded-xl border border-border-strong bg-surface-overlay/95 px-3 py-2 text-xs shadow-float backdrop-blur-sm">
      {label !== undefined && label !== '' && (
        <p className="mb-1.5 font-semibold -tracking-[0.01em] text-neutral-100">{label}</p>
      )}
      {bands.map((p, i) => (
        <p
          key={p.name ?? i}
          className="flex items-center gap-1.5 font-mono tabular-nums text-neutral-200"
        >
          <span
            aria-hidden
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: p.color }}
          />
          <span className="text-neutral-400">{p.name ?? 'Valor'}</span>
          <span className="font-semibold text-neutral-100">{fmtInt(Number(p.value))}</span>
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
  /*
    Barra con BARRIDO, no con `animate-pulse`. El pulso hace latir toda la
    pantalla al mismo ritmo, que se lee como un error intermitente; el barrido
    va en una dirección y se lee como progreso. El brillo viaja por
    `transform` (no por `background-position`) para que lo componga la GPU.

    `before:` necesita un ancestro con `overflow-hidden` y `relative`, que es
    lo que hacen las dos primeras clases.
  */
  const bar =
    'relative overflow-hidden rounded-md bg-overlay/6 before:absolute before:inset-0 before:animate-shimmer before:bg-gradient-to-r before:from-transparent before:via-overlay/8 before:to-transparent before:content-[""]';
  const shell = 'sheen rounded-2xl border border-border-subtle bg-surface shadow-card';
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
    /*
      El h1 creció y se le cerró el tracking: es el único título de la pantalla
      y antes pesaba lo mismo que el título de una tarjeta, así que la jerarquía
      "pantalla > tarjeta > dato" no existía. A 22px con -0.02em de tracking la
      cabecera tiene presencia sin ocupar más alto de línea.
    */
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2.5">
        <h1 className="text-[1.375rem] font-semibold -tracking-[0.02em] text-neutral-50">
          {title}
        </h1>
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
      /*
        El foco no se declara acá: lo hereda del `:focus-visible` global de
        `globals.css`, que es el mismo anillo para todo el panel. Antes cada
        control traía su propia variante (había cuatro distintas) y el resultado
        era que el foco cambiaba de forma según dónde estuvieras.
      */
      className={`press inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border-subtle bg-surface-raised shadow-inset-highlight transition-[background-color,border-color,color] duration-250 hover:border-overlay/16 hover:bg-surface-overlay hover:text-neutral-50 disabled:cursor-not-allowed disabled:opacity-40 ${
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
