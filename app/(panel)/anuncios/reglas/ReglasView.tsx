'use client';

/**
 * ReglasView — la pantalla /anuncios/reglas (T19).
 *
 * Lista de reglas con su switch de estado, el banner de los dos interruptores
 * globales (D-A12b), el formulario de crear/editar y el diálogo de confirmación
 * escrita para sacar el modo sombra.
 *
 * DÓNDE VIVE EL MODO SOMBRA / REAL
 * En el menú «⋮» de cada fila, no en una columna: el badge SOMBRA repetido en
 * todas las filas era ruido (es el default de toda regla nueva) y el modo se
 * consulta justo cuando se lo va a cambiar. En la tabla sólo queda un badge
 * REAL, y sólo en las reglas que pueden tocar Meta: ese estado sí no puede
 * quedar invisible.
 *
 * Los switches y el constructor de condiciones viven acá (D-A19): no se toca
 * `components/ui.tsx`. La referencia es `ConfigView.tsx` (formularios de
 * escritura, listas, confirmaciones). El servidor es la única fuente de verdad:
 * acá se muta contra `/api/ads/reglas` y `/api/ads/interruptores` y se refetchea.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clock, Crosshair, DotsThreeVertical, Lightning, ListChecks, X } from '@phosphor-icons/react';
import type { Condicion, NivelAds, PeriodoAds } from '@/lib/ads/tipos';
import type { ResultadoCorrida } from '@/lib/ads/reglas/ejecutor';
import type { CuentaAds, EstadoInterruptores, ReglaFila } from './_tipos';
import { nombreDeCopia } from './_nombres';
import {
  motivoAlcanceInutil,
  motivoCondicionesImposibles,
  motivoVentanaInvalida,
  type CondicionCoherencia,
} from '@/lib/ads/reglas/coherencia';
// El núcleo compartido del parseo: qué número dice un texto, sin ninguna
// política. La política de esta pantalla la pone `numeroDeCampo`, abajo.
import { leerNumeroEscrito, type MotivoNumero, type NumeroEscrito } from '@/lib/monto';
// Los valores YA GUARDADOS que huelen a este bug. Es EL MISMO módulo que importa
// `scripts/verificar-montos-reglas.ts`: un predicado y un umbral, no dos que
// puedan discrepar. Eso es lo que hace verificable la Property 7.
import { sospechasDeRegla, type Sospecha } from '@/lib/ads/reglas/sospecha';
import { importarCsvUtmify } from '@/lib/ads/reglas/utmify';
import { Badge, Banner, Card, EmptyState, Table, fmtDateTime } from '@/components/ui';
import type { Tone } from '@/components/ui';
import { MONEDA_REPORTE, SIMBOLO_REPORTE } from '@/lib/moneda-reporte';

// ─── Etiquetas y formateadores ───────────────────────────────────────────────

type Accion = 'pause' | 'activate' | 'budget_increase' | 'budget_decrease';
type StatusFilter = 'active' | 'paused' | 'any';

const ACCION_LABEL: Record<Accion, string> = {
  pause: 'Pausar',
  activate: 'Activar',
  budget_increase: 'Subir presupuesto',
  budget_decrease: 'Bajar presupuesto',
};

const NIVEL_LABEL: Record<NivelAds, string> = {
  campaign: 'Campañas',
  adset: 'Conjuntos',
  ad: 'Anuncios',
};

const STATUS_LABEL: Record<StatusFilter, string> = {
  active: 'activos',
  paused: 'pausados',
  any: 'cualquier estado',
};

const PERIODO_LABEL: Record<PeriodoAds, string> = {
  today: 'hoy',
  yesterday: 'ayer',
  '7d': '7 días',
  '7d_excl_today': '7 días sin hoy',
};

const METRICA_LABEL: Record<Condicion['metric'], string> = {
  sales: 'ventas',
  revenue: 'ingresos',
  spend: 'gasto',
  net: 'neto',
  profit: 'ganancia',
  roi: 'ROI',
  roas: 'ROAS',
  cpa: 'CPA',
  budget: 'presupuesto',
  impressions: 'impresiones',
  clicks: 'clics',
  ctr: 'CTR',
  cpc: 'CPC',
};

/**
 * Los operadores en castellano, para el selector del formulario.
 *
 * En la tabla se siguen mostrando los símbolos: ahí el texto es un resumen de
 * una línea en una celda angosta («Pausar · si ROI <= 1,2 y gasto > 9») y las
 * palabras lo desbordan. Elegir es otra cosa: «<=» y «>=» al lado en un select
 * se confunden, y equivocarse ahí apaga campañas que había que dejar prendidas.
 */
const OP_LABEL: Record<Condicion['op'], string> = {
  '>': 'mayor que',
  '>=': 'mayor o igual que',
  '<': 'menor que',
  '<=': 'menor o igual que',
  '=': 'igual a',
  '!=': 'distinto de',
};

const OPS: readonly Condicion['op'][] = ['>', '>=', '<', '<=', '=', '!='];

/** Las que apagan o sacan plata: las que conviene no dejar sin condiciones. */
const accionDestructiva = (a: Accion): boolean => a === 'pause' || a === 'budget_decrease';

/**
 * Las opciones de la ventana horaria: las 24 horas en punto más «23:59».
 *
 * En punto porque una ventana es un turno («de 8 a 23»), no un instante, y el
 * campo libre de minutos era una fuente de errores: dos `<input type="time">`
 * sueltos dejan guardar media ventana o las dos horas iguales, y las dos cosas
 * rompen la regla en silencio. 23:59 está para poder decir «hasta el final del
 * día» sin perder los últimos 59 minutos, que es lo que pasaría con 23:00.
 */
const HORAS_VENTANA: readonly string[] = [
  ...Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`),
  '23:59',
];

/**
 * Las horas del selector, incluyendo la guardada si no es una hora en punto.
 * El import de CSV de UTMify trae horarios arbitrarios (08:30): sin esto, abrir
 * esa regla para cambiarle otra cosa le movería la ventana sin avisar.
 */
function opcionesHora(actual: string): readonly string[] {
  if (actual === '' || HORAS_VENTANA.includes(actual)) return HORAS_VENTANA;
  return [...HORAS_VENTANA, actual].sort();
}

// Unidad para mostrar el valor de cada métrica: €, múltiplo o cantidad.
const METRICA_UNIDAD: Record<Condicion['metric'], 'euro' | 'numero' | 'entero'> = {
  sales: 'entero',
  revenue: 'euro',
  spend: 'euro',
  net: 'euro',
  profit: 'euro',
  roi: 'numero',
  roas: 'numero',
  cpa: 'euro',
  budget: 'euro',
  impressions: 'entero',
  clicks: 'entero',
  ctr: 'numero',
  cpc: 'euro',
};

const METRICAS: { value: Condicion['metric']; label: string }[] = (Object.keys(METRICA_LABEL) as Condicion['metric'][]).map(
  (value) => ({ value, label: METRICA_LABEL[value] }),
);

const dosDecimales = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sinDecimales = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });

function eur(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `${SIMBOLO_REPORTE}${dosDecimales.format(n)}`;
}

function numero(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return dosDecimales.format(n);
}

function frecuenciaLabel(m: number): string {
  if (m >= 1440) return '1× día';
  if (m >= 60 && m % 60 === 0) return `Cada ${m / 60} h`;
  return `Cada ${m} min`;
}

function formatearValorCondicion(c: { metric: Condicion['metric']; value: number }): string {
  const u = METRICA_UNIDAD[c.metric];
  if (u === 'entero') return sinDecimales.format(c.value);
  if (u === 'euro') return eur(c.value);
  return numero(c.value);
}

// ─── Estilos (el mismo kit que ConfigView) ───────────────────────────────────

const inputCls =
  'rounded-lg border border-border-strong bg-overlay/4 px-2 py-1.5 text-sm text-neutral-200 focus:border-good-500/50 focus:outline-none focus:ring-1 focus:ring-good-500/50 disabled:opacity-40';
const btnCls =
  'rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-good-500/50 disabled:opacity-40';
const btnPrimary = `${btnCls} bg-good-500 text-white hover:bg-good-400`;
const btnGhost = `${btnCls} border border-border-strong text-neutral-300 hover:bg-overlay/6`;
const btnDanger = `${btnCls} border border-bad-500/30 text-bad-300 hover:bg-bad-500/10`;

// ─── Switch accesible (role="switch", foco visible) ─────────────────────────

function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-good-500/50 disabled:opacity-40 ${
        checked ? 'bg-good-500' : 'bg-overlay/15'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

// ─── Menú de acciones (los tres puntos) ─────────────────────────────────────

type ItemMenu = {
  label: string;
  onSelect: () => void;
  /** Rojo, para lo que borra. */
  peligro?: boolean;
  /** Ámbar, para lo que le da permiso a la regla de tocar Meta. */
  aviso?: boolean;
  /**
   * Segunda línea, más chica, debajo del label. Es donde vive la explicación
   * del modo sombra/real: la columna «Modo» de la tabla se fue, y una etiqueta
   * de tres palabras no alcanza para decir qué implica cambiarlo.
   */
  detalle?: string;
  title?: string;
};

/**
 * El menú de acciones de una fila (y el «Más» de la barra de arriba).
 *
 * POR QUÉ VA EN UN PORTAL Y NO EN LA CELDA
 * La tabla vive dentro de un `overflow-x-auto` (`Table` de components/ui). Un
 * panel con `position: absolute` adentro de esa celda queda RECORTADO por ese
 * overflow y, peor, ensancha el scroll horizontal de la tabla. Con
 * `createPortal` a `document.body` + `position: fixed` calculado desde el rect
 * del disparador, el menú se dibuja por encima de todo y la tabla no se mueve.
 *
 * `encabezado` es la línea de estado de arriba (el modo de la regla) y va
 * AFUERA del `role="menu"`: un texto que no se puede elegir no puede ser hijo
 * de un menú.
 *
 * ACCESIBILIDAD (no hay ningún menú previo en el repo del que copiarla)
 *   - El disparador es un `<button>` real con `aria-haspopup="menu"`,
 *     `aria-expanded` y `aria-label` obligatorio por tipo.
 *   - El panel es `role="menu"` y cada opción `role="menuitem"`.
 *   - Escape cierra Y devuelve el foco al disparador; un click afuera cierra
 *     sin moverlo. Flechas arriba/abajo, Home y End recorren las opciones.
 *   - Al abrir, el foco va a la primera opción: con teclado, abrir un menú y
 *     que el foco se quede atrás es quedarse sin salida.
 *
 * Cualquier scroll o resize CIERRA el menú en lugar de recalcular la posición:
 * recalcular en cada píxel pelea con el scroll de la tabla y con el de la
 * página, y un menú abierto es un estado de milisegundos.
 */
function MenuAcciones({
  etiqueta,
  items,
  disabled,
  variante = 'icono',
  encabezado,
}: {
  etiqueta: string;
  items: ItemMenu[];
  disabled?: boolean;
  variante?: 'icono' | 'texto';
  /** Línea de estado arriba de las opciones (el modo de la regla). */
  encabezado?: string;
}): JSX.Element {
  const [abierto, setAbierto] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const idPanel = useId();

  const cerrar = useCallback((devolverFoco: boolean) => {
    setAbierto(false);
    if (devolverFoco) triggerRef.current?.focus();
  }, []);

  function abrir(): void {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Alto estimado: 30 px por opción simple, 46 si tiene segunda línea, más el
    // encabezado y el padding. Sólo se usa para decidir si el menú se abre hacia
    // arriba, así que una aproximación alcanza.
    const alto =
      items.reduce((acc, it) => acc + (it.detalle ? 46 : 30), 0) + (encabezado ? 34 : 0) + 10;
    const cabeAbajo = window.innerHeight - r.bottom > alto + 8;
    // `documentElement.clientWidth` y no `window.innerWidth`: innerWidth incluye
    // el ancho de la barra de scroll y `position: fixed` no, así que el menú
    // quedaba corrido ~15 px a la izquierda del botón.
    const anchoViewport = document.documentElement.clientWidth;
    setPos({
      top: cabeAbajo ? r.bottom + 4 : Math.max(8, r.top - alto - 4),
      // Anclado a la derecha: el disparador está en el borde derecho de la
      // tabla y un menú que crece hacia la derecha se saldría de la pantalla.
      right: Math.max(8, anchoViewport - r.right),
    });
    setAbierto(true);
  }

  useEffect(() => {
    if (!abierto) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cerrar(true);
      }
    };
    const onDown = (e: Event): void => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      cerrar(false);
    };
    const onMover = (): void => cerrar(false);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    // `true` en el scroll: la tabla scrollea en su propio div, y sin captura el
    // listener de window nunca se enteraría.
    window.addEventListener('scroll', onMover, true);
    window.addEventListener('resize', onMover);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onMover, true);
      window.removeEventListener('resize', onMover);
    };
  }, [abierto, cerrar]);

  useEffect(() => {
    if (abierto) itemsRef.current[0]?.focus();
  }, [abierto]);

  function navegar(e: React.KeyboardEvent<HTMLDivElement>): void {
    const n = items.length;
    if (n === 0) return;
    const actual = itemsRef.current.findIndex((b) => b === document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      itemsRef.current[(actual + 1 + n) % n]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      itemsRef.current[(actual - 1 + n) % n]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      itemsRef.current[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      itemsRef.current[n - 1]?.focus();
    }
  }

  const claseTrigger =
    variante === 'texto'
      ? `${btnGhost} inline-flex items-center gap-1`
      : 'inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border-strong text-neutral-300 transition-colors hover:bg-overlay/6 hover:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-good-500/50 disabled:opacity-40';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={etiqueta}
        title={etiqueta}
        aria-haspopup="menu"
        aria-expanded={abierto}
        aria-controls={abierto ? idPanel : undefined}
        disabled={disabled}
        onClick={() => (abierto ? cerrar(true) : abrir())}
        className={claseTrigger}
      >
        {variante === 'texto' && <span>Más</span>}
        <DotsThreeVertical size={variante === 'texto' ? 13 : 16} weight="bold" aria-hidden="true" />
      </button>

      {abierto && pos !== null && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={panelRef}
              id={idPanel}
              style={{ position: 'fixed', top: pos.top, right: pos.right }}
              className="z-[60] w-[17rem] overflow-hidden rounded-xl border border-border-strong bg-surface-raised shadow-2xl"
            >
              {/* El encabezado va AFUERA del role="menu": un texto que no es una
                  opción no puede ser hijo de un menú (un lector de pantalla lo
                  anunciaría como si se pudiera elegir). */}
              {encabezado && (
                <p className="border-b border-border-subtle px-3 py-2 text-[11px] leading-snug text-neutral-400">
                  {encabezado}
                </p>
              )}
              <div role="menu" aria-label={etiqueta} onKeyDown={navegar} className="p-1">
                {items.map((it, i) => (
                  <button
                    key={it.label}
                    ref={(el) => {
                      itemsRef.current[i] = el;
                    }}
                    type="button"
                    role="menuitem"
                    title={it.title}
                    onClick={() => {
                      // Cerrar sin devolver el foco: la acción casi siempre abre
                      // el formulario o un diálogo, y ahí va a ir el foco.
                      setAbierto(false);
                      it.onSelect();
                    }}
                    className={`block w-full rounded-lg px-3 py-1.5 text-left text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-good-500/50 ${
                      it.peligro
                        ? 'text-bad-300 hover:bg-bad-500/10'
                        : it.aviso
                          ? 'text-warn-300 hover:bg-warn-500/10'
                          : 'text-neutral-200 hover:bg-overlay/8 hover:text-neutral-50'
                    }`}
                  >
                    {it.label}
                    {it.detalle && (
                      <span className="mt-0.5 block text-[10px] font-normal leading-snug text-neutral-500">
                        {it.detalle}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

// ─── El tipo del formulario y sus helpers ────────────────────────────────────

type CondicionDraft = { metric: Condicion['metric']; op: Condicion['op']; value: string };

type FormEstado = {
  name: string;
  accountId: string;
  level: NivelAds;
  statusFilter: StatusFilter;
  nameFilter: string;
  nameFilterMode: 'contains' | 'not_contains';
  action: Accion;
  actionValue: string;
  actionUnit: 'percent' | 'fixed';
  budgetMax: string;
  budgetMin: string;
  period: PeriodoAds;
  everyMinutes: number;
  windowStart: string;
  windowEnd: string;
  maxRunsPerDay: string;
  cooldownMinutes: number;
  maxActionsPerObjectPerDay: number;
  conditions: CondicionDraft[];
};

function formVacio(accountId = ''): FormEstado {
  return {
    name: '',
    accountId,
    level: 'adset',
    statusFilter: 'active',
    nameFilter: '',
    nameFilterMode: 'contains',
    action: 'pause',
    actionValue: '',
    actionUnit: 'percent',
    budgetMax: '',
    budgetMin: '',
    period: 'today',
    everyMinutes: 15,
    windowStart: '',
    windowEnd: '',
    maxRunsPerDay: '',
    cooldownMinutes: 60,
    maxActionsPerObjectPerDay: 4,
    conditions: [],
  };
}

function formDeRegla(r: ReglaFila): FormEstado {
  return {
    name: r.name,
    accountId: r.accountId,
    level: r.level,
    statusFilter: r.statusFilter,
    nameFilter: r.nameFilter ?? '',
    nameFilterMode: r.nameFilterMode,
    action: r.action,
    actionValue: r.actionValue != null ? String(r.actionValue) : '',
    actionUnit: r.actionUnit ?? 'percent',
    budgetMax: r.budgetMax != null ? String(r.budgetMax) : '',
    budgetMin: r.budgetMin != null ? String(r.budgetMin) : '',
    period: r.period,
    everyMinutes: r.everyMinutes,
    windowStart: r.windowStart ?? '',
    windowEnd: r.windowEnd ?? '',
    maxRunsPerDay: r.maxRunsPerDay != null ? String(r.maxRunsPerDay) : '',
    cooldownMinutes: r.cooldownMinutes,
    maxActionsPerObjectPerDay: r.maxActionsPerObjectPerDay,
    conditions: r.condiciones.map((c) => ({ metric: c.metric, op: c.op, value: String(c.value) })),
  };
}

function esPresupuesto(action: Accion): boolean {
  return action === 'budget_increase' || action === 'budget_decrease';
}

// El porcentaje es un FACTOR (D-A9): 250% = actual × 2,5 → €10,00 pasa a €25,00.
// La etiqueta dice "escalar al X% del presupuesto actual", nunca "aumentar X%".
function previewFactor(f: FormEstado): string {
  if (!esPresupuesto(f.action) || f.actionUnit !== 'percent') return '';
  const p = Number(f.actionValue);
  if (!Number.isFinite(p) || p <= 0) return '';
  const base = 10; // ejemplo: no hay un objeto real alcanzado (task §8)
  const nuevo = base * (p / 100);
  const techo = f.budgetMax ? Number(f.budgetMax) : null;
  const piso = f.budgetMin ? Number(f.budgetMin) : null;
  let final = nuevo;
  let corte = '';
  if (techo != null && Number.isFinite(techo) && nuevo > techo) {
    final = techo;
    corte = `Con el límite de ${eur(techo)}, queda en ${eur(techo)}.`;
  } else if (piso != null && Number.isFinite(piso) && nuevo < piso) {
    final = piso;
    corte = `Con el piso de ${eur(piso)}, queda en ${eur(piso)}.`;
  }
  if (p === 100) return `Un conjunto con ${eur(base)} quedaría igual (100% = sin cambio).`;
  return `Un conjunto con ${eur(base)} pasaría a ${eur(final)}.${corte ? ` ${corte}` : ''}`;
}

// Validación client-side de lo mismo que valida la base (task §4.5): el usuario
// no tiene que descubrir los CHECK por un 400.
//
// Está partida en una función por pestaña porque el formulario ahora tiene
// pestañas: con un único mensaje no había forma de saber en cuál está el campo
// que falta, y el usuario se quedaba con el botón deshabilitado y sin pistas.
// `problema` sigue siendo la composición de las tres, y es la que decide si se
// puede guardar. Exportada para los tests (9.6).
export function problema(
  f: FormEstado,
  otras: readonly { accountId: string; name: string }[] = [],
): string | null {
  return problemaAlcance(f, otras) ?? problemaAccion(f) ?? problemaCondiciones(f) ?? problemaProgramacion(f);
}

/**
 * Lo que dice un campo numérico escrito a mano: nada, un número, o un texto que
 * no nombra ningún número.
 *
 * EL CAMBIO DE TIPO ES EL DISEÑO, NO UN EFECTO COLATERAL. Antes esto devolvía un
 * `number` con NaN como única señal, y con eso la validación no podía distinguir
 * «vacío» de «ilegible» de «ambiguo»: lo único que podía preguntar era
 * `Number.isFinite` sobre el número YA CORROMPIDO, así que `1.000` llegaba a
 * `problemaAccion` convertido en 1 y lo aprobaba (cláusula 1.8). Con los tres
 * estados nombrados, cada call site decide sobre el TEXTO y no sobre el número
 * que alguien eligió por él (2.9).
 */
export type CampoNumerico =
  | { estado: 'vacio' }
  | { estado: 'ok'; valor: number }
  | { estado: 'error'; motivo: MotivoNumero; detalle: string };

/** La rama de rechazo, que es la única que `problemaDeCampo` necesita. */
type ErrorDeCampo = Extract<CampoNumerico, { estado: 'error' }>;

/**
 * Qué le pasa al texto, en una frase, sin nombrar ningún campo.
 *
 * Para `ambiguo` es la `explicacion` del núcleo TAL CUAL: esa frase no nombra
 * ningún sustantivo («"1.000" se puede leer de dos formas: …»), así que sirve
 * igual para un importe, para un ROI y para un límite de ejecuciones. Es la única
 * cadena que las tres pantallas comparten palabra por palabra (2.1).
 *
 * Los otros tres motivos hoy no se muestran —el mensaje de un no-número se arma
 * con el texto bruto y es el de siempre—, y están acá para que un `title` o un
 * log no tenga que volver a mapear el motivo. `vacio` no es alcanzable desde
 * `numeroDeCampo` (el campo en blanco corta antes, y un texto con dígitos no
 * puede quedar vacío al limpiar el ruido) y se mapea igual para que el `switch`
 * sea exhaustivo: si el núcleo suma un motivo, esto no compila. Mismo criterio
 * que `errorDeLectura` en `lib/monto.ts`.
 */
function detalleDeLectura(n: Extract<NumeroEscrito, { ok: false }>): string {
  switch (n.motivo) {
    case 'ambiguo':
      return n.explicacion;
    case 'vacio':
      return 'no quedó ningún número después de limpiar los espacios y los símbolos';
    case 'caracteres':
      return 'un número lleva sólo dígitos, coma o punto';
    case 'ilegible':
      return 'los separadores no forman ningún número';
  }
}

/**
 * Qué número dice un campo de Reglas. Usa el NÚCLEO compartido
 * (`leerNumeroEscrito`, `lib/monto.ts`), que es lo que hace que el mismo texto se
 * lea igual acá, en Finanzas y en el diálogo de presupuesto (2.4), y le suma la
 * política de esta pantalla.
 *
 * TRES DECISIONES DE POLÍTICA, que son de acá y no del núcleo:
 *
 * 1. **`vacio` es SÓLO el campo en blanco** (`''` o espacios), y es un estado
 *    propio y distinto del 0. El NaN de antes existía exactamente para eso y
 *    ahora está nombrado: es lo que hace que el vacío conserve su mensaje (3.7),
 *    viaje como `null` y nunca como 0 (3.10) y no se confunda con un 0 escrito a
 *    propósito, que en una condición es legítimo (3.9). Un texto que era todo
 *    ruido, como `'€'` —el `vacio` del núcleo—, cae en `error` (lo ataja la
 *    decisión 2, que corta antes), igual que en el presupuesto y igual que antes:
 *    el campo tiene algo escrito y ese algo no es un número.
 *
 * 2. **UN TEXTO SIN NINGÚN DÍGITO NO ES 0.** El núcleo resuelve `'.'` (y `','`,
 *    y `'-.'`) como 0 —es la familia (f) de §Alcance del spec, declarada y no
 *    corregida porque corregirla cambiaría el mensaje de `parsearMonto('.')`, que
 *    la cláusula 3.13 congela—. En el presupuesto eso es inocuo porque el 0 lo
 *    ataja `bajo_el_minimo`. ACÁ NO HAY MÍNIMO, y en una condición el 0 es
 *    legítimo a propósito (3.9), así que «gasto > .» pasaría de bloquearse («no
 *    es un número») a guardarse como «gasto > 0» — que en una regla de pausar
 *    significa PAUSÁ TODO. Es el modo de falla que 3.7 vino a evitar, entrando
 *    por otra puerta. La política se pone acá y no en el núcleo: el núcleo no
 *    tiene política, cada pantalla pone la suya. Pinneado en
 *    `numeroDeCampo.test.ts`.
 *
 * 3. **La finitud se pliega dentro de `error`**, al revés que el presupuesto: un
 *    `ok` de Reglas trae siempre un número finito, así que ningún call site puede
 *    olvidarse del chequeo. Se puede porque acá ninguna cláusula congela el orden
 *    de los mensajes, y preserva el veredicto de antes: un texto de 400 dígitos
 *    daba Infinity y ya caía en «no es un número».
 *
 * Exportada para los tests, con el mismo criterio que `problema`, `aplicadoA` y
 * las tres `problema*`: es una función pura y el test de la Bug_Condition
 * (`montoAmbiguo.test.ts`) la tiene que poder llamar directo para medir qué
 * número dice un texto, sin pasar por la validación que la envuelve.
 */
export function numeroDeCampo(s: string): CampoNumerico {
  if (s.trim() === '') return { estado: 'vacio' };

  if (!/\d/.test(s)) {
    // Decisión 2 de arriba: sin dígitos no hay número, aunque el núcleo lo
    // resuelva como 0.
    return { estado: 'error', motivo: 'ilegible', detalle: 'no hay ningún dígito' };
  }

  // Al núcleo se le pasa el texto SIN recortar: limpia el ruido igual, y la frase
  // de la ambigüedad cita el original recortado, que es el que la persona ve.
  const n = leerNumeroEscrito(s);
  if (!n.ok) return { estado: 'error', motivo: n.motivo, detalle: detalleDeLectura(n) };
  if (!Number.isFinite(n.valor)) {
    // Decisión 3: 400 dígitos dan Infinity y eso no es un número que se pueda
    // guardar en ningún campo.
    return { estado: 'error', motivo: 'ilegible', detalle: 'el número es demasiado grande' };
  }
  return { estado: 'ok', valor: n.valor };
}

/**
 * El problema de un campo que no se pudo leer, con el campo nombrado (2.6, 2.7).
 * Único helper para las tres pestañas.
 *
 * DOS FORMAS Y NO UNA: la segunda es literalmente el mensaje que ya existía y que
 * 2.7 cita, palabra por palabra, y la primera es la que necesita la frase
 * interpolada del núcleo, que trae LAS DOS lecturas posibles porque el valor del
 * rechazo está en que la persona elija (2.1).
 */
function problemaDeCampo(nombre: string, bruto: string, r: ErrorDeCampo): string {
  return r.motivo === 'ambiguo' ? `${nombre}: ${r.detalle}` : `${nombre} no es un número: «${bruto}».`;
}

/** Lo que puede estar mal en la pestaña Alcance (y el nombre, que va arriba). */
export function problemaAlcance(
  f: FormEstado,
  otras: readonly { accountId: string; name: string }[] = [],
): string | null {
  // R8 c4: la cuenta es obligatoria; el botón de guardar queda deshabilitado
  // hasta que el selector tenga un valor.
  if (!f.accountId) return 'Falta la cuenta de anuncios.';
  const nombre = f.name.trim();
  if (nombre === '') return 'Falta el nombre de la regla.';
  // El único es (account_id, name) desde la 021. El API contesta 409 con un
  // mensaje claro, pero llegar hasta ahí obliga a rellenar todo de nuevo; y el
  // caso que lo dispara es duplicar una regla y olvidarse de renombrarla.
  if (otras.some((o) => o.accountId === f.accountId && o.name.trim() === nombre)) {
    return `Ya existe una regla llamada «${nombre}» en esta cuenta: el nombre es único por cuenta.`;
  }
  return motivoAlcanceInutil(f.action, f.statusFilter);
}

/**
 * Lo que puede estar mal en la pestaña Acción (todo es de presupuesto).
 *
 * Los tres campos se leen UNA VEZ CADA UNO al principio, y los cortes de después
 * miran `valor`, que es un número que el texto dice de verdad. Antes el corte
 * `v <= 0` se hacía sobre lo que `Number('1.000')` había devuelto, así que la
 * validación aprobaba 1 donde la persona había escrito mil: eso es 1.8, y con el
 * estado nombrado no se puede volver a escribir.
 */
export function problemaAccion(f: FormEstado): string | null {
  if (!esPresupuesto(f.action)) return null;
  const valor = numeroDeCampo(f.actionValue);
  const techo = numeroDeCampo(f.budgetMax);
  const piso = numeroDeCampo(f.budgetMin);

  if (valor.estado === 'error') {
    return problemaDeCampo('El valor de la acción', f.actionValue.trim(), valor);
  }
  // El vacío y el 0 comparten mensaje, como antes: los dos son «falta el valor».
  if (valor.estado === 'vacio' || valor.valor <= 0) return 'Falta el valor de la acción.';
  const v = valor.valor;

  // `=== ''` y no `.trim() === ''`, que es lo que decía antes: un techo con sólo
  // espacios no dispara este corte y termina viajando como `null`.
  if (f.action === 'budget_increase' && f.budgetMax === '') return 'Falta el límite máximo (techo).';
  if (f.action === 'budget_decrease' && f.budgetMin === '') return 'Falta el límite mínimo (piso).';
  if (f.actionUnit === 'percent') {
    if (f.action === 'budget_increase' && v <= 100)
      return 'Un factor menor a 100 BAJA el presupuesto; para subir al doble va 200%.';
    if (f.action === 'budget_decrease' && v >= 100)
      return 'Para bajar a la mitad va 50%; 250% multiplica por 2,5.';
  }
  if (techo.estado === 'error') {
    return problemaDeCampo('El límite máximo', f.budgetMax.trim(), techo);
  }
  if (piso.estado === 'error') {
    return problemaDeCampo('El límite mínimo', f.budgetMin.trim(), piso);
  }
  if (techo.estado === 'ok' && techo.valor <= 0) return 'El límite máximo tiene que ser mayor a 0.';
  if (piso.estado === 'ok' && piso.valor <= 0) return 'El límite mínimo tiene que ser mayor a 0.';
  if (techo.estado === 'ok' && piso.estado === 'ok' && techo.valor < piso.valor)
    return `Con techo ${techo.valor} y piso ${piso.valor} no hay ningún valor que satisfaga los dos.`;
  // DEFECTO SEPARADO Y PREVIO, no de este arreglo: no hay ningún corte por el tope
  // de `numeric(14,2)` en estos tres importes. Un valor más grande lo rechaza la
  // base con un error de Postgres. Agregar el corte acá cambiaría el veredicto de
  // textos que hoy pasan, así que queda anotado y afuera.
  return null;
}

/**
 * Lo que puede estar mal en la pestaña Condiciones.
 *
 * El valor vacío es la trampa peor de todo el formulario: `Number('')` es 0, así
 * que «gasto mayor que ␣» se guardaba como «gasto > 0», que en una regla de
 * pausar significa pausar absolutamente todo lo que pase el filtro de alcance.
 * Nada avisaba: ni el formulario, ni el API (0 es un valor legítimo), ni la
 * base. La contradicción entre condiciones vive en `lib/ads/reglas/coherencia`
 * porque el API valida con la misma función.
 *
 * Cada condición se lee UNA SOLA VEZ, al entrar, y `motivoCondicionesImposibles`
 * recibe los valores YA PARSEADOS: recién se lo llama cuando todas dieron `ok`,
 * así que deja de poder recibir un NaN (su `Number.isFinite` de entrada era el
 * único freno, y saltear una condición en silencio es lo contrario de avisar).
 */
export function problemaCondiciones(f: FormEstado): string | null {
  const leidas: CondicionCoherencia[] = [];
  for (let i = 0; i < f.conditions.length; i++) {
    const c = f.conditions[i]!;
    const bruto = c.value.trim();
    const nombre = `${METRICA_LABEL[c.metric]} (condición ${i + 1})`;
    const r = numeroDeCampo(c.value);
    if (r.estado === 'vacio') {
      return `${nombre} no tiene valor. Un valor vacío se guardaría como 0, no como «sin límite».`;
    }
    if (r.estado === 'error') {
      return problemaDeCampo(`El valor de ${nombre}`, bruto, r);
    }
    // DEFECTO SEPARADO Y PREVIO, no de este arreglo: NO se corta por cantidad de
    // decimales. `ad_rule_conditions.value` es `numeric(16,4)`, así que un quinto
    // decimal lo redondea Postgres sin avisar, y antes tampoco había nada que lo
    // atrapara. Agregar el rechazo acá cambiaría el veredicto de textos que hoy
    // pasan, o sea una regresión no declarada: queda anotado y afuera.
    leidas.push({ metric: c.metric, op: c.op, value: r.valor });
  }
  return motivoCondicionesImposibles(leidas, (m) => METRICA_LABEL[m as Condicion['metric']] ?? m);
}

/**
 * Lo que puede estar mal en la pestaña Programación.
 *
 * La ventana horaria se valida con `lib/ads/reglas/coherencia`, el mismo módulo
 * que usa el API: media ventana (que la base rechaza con
 * `ad_rules_ventana_completa`) y las dos horas iguales, que no rechazaba nadie y
 * deja a la regla con 60 segundos por día para correr.
 */
export function problemaProgramacion(f: FormEstado): string | null {
  const mv = motivoVentanaInvalida(f.windowStart, f.windowEnd);
  if (mv !== null) return mv;

  // El `Number(tope)` crudo se fue: era el otro lugar donde `1.000` pasaba como
  // 1 y `Number.isInteger(1)` lo bendecía (1.9). Ahora valida y arma el payload
  // el MISMO parseo.
  const tope = f.maxRunsPerDay.trim();
  const r = numeroDeCampo(f.maxRunsPerDay);
  if (r.estado !== 'vacio') {
    // La ambigüedad se explica; todo el resto conserva el mensaje de siempre, que
    // es lo que 2.8 pide para `1,5`: se lee 1,5 y se rechaza por no ser entero.
    if (r.estado === 'error' && r.motivo === 'ambiguo') {
      return problemaDeCampo('El límite de ejecuciones diarias', tope, r);
    }
    if (r.estado === 'error' || !Number.isInteger(r.valor) || r.valor <= 0) {
      return 'El límite de ejecuciones diarias tiene que ser un entero mayor a 0, o vacío para no tener límite.';
    }
    // DEFECTO SEPARADO Y PREVIO, no de este arreglo: no hay corte por el tope de
    // `smallint` (32767). Un entero más grande lo rechaza la base con un error de
    // Postgres. Es feo y es de antes; agregarlo acá sería una regresión no
    // declarada sobre textos que hoy pasan.
  }
  if (!Number.isInteger(f.cooldownMinutes) || f.cooldownMinutes < 0) {
    return 'El cooldown por objeto tiene que ser 0 o más minutos.';
  }
  return null;
}

/**
 * R8 c6: el alcance de una Regla se describe nombrando ESA cuenta y su zona,
 * nunca con una cantidad ("N cuentas") ni con la leyenda de todas las activas.
 * Exportada para los tests (9.6). Si la cuenta no está entre las activas (se
 * desactivó después de que la regla se creara), queda el id como nombre.
 */
export function aplicadoA(
  r: { accountId: string; level: NivelAds; statusFilter: StatusFilter },
  cuentas: readonly CuentaAds[],
): string {
  const cuenta = cuentas.find((c) => c.accountId === r.accountId);
  const nombre = cuenta ? (cuenta.name ?? cuenta.accountId) : r.accountId;
  const zona = cuenta ? ` · ${cuenta.timezone}` : '';
  return `${NIVEL_LABEL[r.level]} ${STATUS_LABEL[r.statusFilter]} · ${nombre}${zona}`;
}

/** Los nombres de las bandas, textuales del script: el mismo reporte, dos lugares. */
const NOMBRE_BANDA: Record<Sospecha['banda'], string> = {
  alta: 'muy probable',
  baja: 'posible',
};

/** Lo que la celda «Acción y condición» pinta cuando la regla tiene un valor sospechoso. */
export type AvisoSospecha = { etiqueta: string; detalle: string };

/**
 * El aviso de la celda «Acción y condición»: qué dice el badge y qué dice su
 * tooltip, o `null` si no hay nada que señalar (2.14).
 *
 * PURO Y EXPORTADO PARA LOS TESTS: decidir si la fila lleva badge no necesita
 * render. Es la parte de la Property 7 que se puede verificar sin base — la
 * sospecha que ve la UI es la que reporta el script, porque las dos salen de
 * `sospechasDeRegla` y `ReglaFila` satisface `ReglaAuditable` sin conversiones.
 *
 * EL ORDEN DE LAS CONDICIONES NO ES UN DETALLE. La etiqueta de una condición dice
 * «(condición N)» con N = índice + 1, así que el número del badge coincide con el
 * del reporte sólo si las dos listas están ordenadas igual, y las dos las ordena
 * `position`. `ReglaFila.condiciones` YA viene así: `listarReglas` (`_server.ts`)
 * las trae con `ORDER BY rule_id, position` y es la única fuente de la lista,
 * tanto en la carga inicial (`page.tsx`) como en cada `refrescar()`
 * (GET /api/ads/reglas, que llama a la misma función). No se reordena acá porque
 * no se puede: `Condicion` no lleva `position` — el orden del array ES el orden.
 * Si alguien saca ese ORDER BY, este número se corre en silencio.
 *
 * PURAMENTE VISUAL: no deshabilita nada, no filtra la lista y NO impide que la
 * regla siga corriendo (2.14). Un techo de 5 EUR puesto a propósito va a mostrar
 * el badge y eso está bien: es indistinguible de un `5.000` corrompido, así que
 * dice «revisar» y no «error», y la corrección es de una persona (2.13).
 */
export function avisoDeSospecha(r: ReglaFila): AvisoSospecha | null {
  const ss = sospechasDeRegla(r);
  if (ss.length === 0) return null;
  const lineas = ss.map((s) => {
    const marca = s.extension ? ' (es un porcentaje, no un importe)' : '';
    return (
      `· ${s.etiqueta}: guardado ${s.valor} — si se escribió «${s.textoProbable}», ` +
      `quería decir ${s.valorProbable} [${NOMBRE_BANDA[s.banda]}]${marca}`
    );
  });
  return {
    etiqueta: ss.length === 1 ? 'revisar 1 importe' : `revisar ${ss.length} importes`,
    detalle: [
      'Puede haber quedado mil veces más chico: el parseo viejo leía «1.500» como 1,5. Ya está',
      'arreglado, pero lo guardado no se corrige solo. Revisalo a mano — la regla sigue corriendo.',
      '',
      ...lineas,
    ].join('\n'),
  };
}

/**
 * El payload que viaja al API. Exportada para los tests: es el último punto
 * donde un número corrompido todavía se puede observar antes de salir del
 * cliente, así que el test de la Bug_Condition la usa para afirmar que un texto
 * ambiguo no produce NINGÚN valor. Se llama en un solo lugar de producción
 * (`:1912`), detrás de `disabled={!puedeGuardar}`.
 */
export function payloadDeForm(f: FormEstado, id?: number): Record<string, unknown> {
  const ep = esPresupuesto(f.action);
  // Todos los números pasan por `numeroDeCampo`, el mismo que usa la validación:
  // si el formulario acepta «1,3», el payload manda 1.3; y si el texto era
  // ambiguo, la validación ya bloqueó el guardado y acá no se arma ningún valor.
  return {
    id,
    name: f.name.trim(),
    accountId: f.accountId,
    level: f.level,
    statusFilter: f.statusFilter,
    nameFilter: f.nameFilter.trim() || null,
    nameFilterMode: f.nameFilterMode,
    action: f.action,
    actionValue: ep ? valorONull(numeroDeCampo(f.actionValue)) : null,
    actionUnit: ep ? f.actionUnit : null,
    budgetMax: ep ? valorONull(numeroDeCampo(f.budgetMax)) : null,
    budgetMin: ep ? valorONull(numeroDeCampo(f.budgetMin)) : null,
    period: f.period,
    everyMinutes: f.everyMinutes,
    windowStart: f.windowStart || null,
    windowEnd: f.windowEnd || null,
    maxRunsPerDay: valorONull(numeroDeCampo(f.maxRunsPerDay)),
    cooldownMinutes: f.cooldownMinutes,
    maxActionsPerObjectPerDay: f.maxActionsPerObjectPerDay,
    conditions: f.conditions.map((c) => ({
      metric: c.metric,
      op: c.op,
      value: valorONull(numeroDeCampo(c.value)),
    })),
  };
}

/**
 * El campo vacío viaja como `null` y NUNCA como 0 (3.10): un 0 en el techo de una
 * regla es un techo de cero euros, y en una condición es «pausá todo».
 *
 * El `null` del caso `error` es INALCANZABLE y se deja como `null` a propósito. El
 * payload se arma en un solo lugar (`:1912`), detrás de `disabled={!puedeGuardar}`
 * con `puedeGuardar = prob === null && !guardando`, así que cuando se llega acá
 * `problema()` ya devolvió `null` y ningún campo está en `error`. Si algún día ese
 * camino se abre, el API rechaza un `null` en un campo obligatorio de forma
 * ruidosa, mientras que un 0 se guardaría en silencio. Es la lección de 3.7.
 */
const valorONull = (r: CampoNumerico): number | null => (r.estado === 'ok' ? r.valor : null);

function payloadDeRegla(r: ReglaFila, over: { enabled?: boolean; dryRun?: boolean } = {}): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    accountId: r.accountId,
    level: r.level,
    statusFilter: r.statusFilter,
    nameFilter: r.nameFilter,
    nameFilterMode: r.nameFilterMode,
    action: r.action,
    actionValue: r.actionValue,
    actionUnit: r.actionUnit,
    budgetMax: r.budgetMax,
    budgetMin: r.budgetMin,
    period: r.period,
    everyMinutes: r.everyMinutes,
    windowStart: r.windowStart,
    windowEnd: r.windowEnd,
    maxRunsPerDay: r.maxRunsPerDay,
    cooldownMinutes: r.cooldownMinutes,
    maxActionsPerObjectPerDay: r.maxActionsPerObjectPerDay,
    conditions: r.condiciones,
    enabled: over.enabled ?? r.enabled,
    dryRun: over.dryRun ?? r.dryRun,
  };
}

// ─── Vista principal ─────────────────────────────────────────────────────────

type Flash = { tone: 'good' | 'bad'; text: string } | null;

/** Lo que contesta POST /api/ads/reglas/csv. */
type RespuestaImport = {
  creadas: number;
  borradas: number;
  cuentas: string[];
  omitidas: { accountId: string; name: string; motivo: string }[];
  errores: { linea: number; name: string; error: string }[];
  avisos: string[];
};

export function ReglasView({
  initial,
}: {
  initial: { reglas: ReglaFila[]; interruptores: EstadoInterruptores; cuentas: CuentaAds[] };
}): JSX.Element {
  const [reglas, setReglas] = useState(initial.reglas);
  const [sw, setSw] = useState(initial.interruptores);
  const cuentas = initial.cuentas;
  const [flash, setFlash] = useState<Flash>(null);
  const [busy, setBusy] = useState(false);
  const [editando, setEditando] = useState<ReglaFila | null>(null);
  const [nueva, setNueva] = useState(false);
  // La cuenta que deja preseleccionada el botón "Nueva regla en esta cuenta".
  const [nuevaEnCuenta, setNuevaEnCuenta] = useState<string | null>(null);
  const [duplicando, setDuplicando] = useState<ReglaFila | null>(null);
  const [confirmar, setConfirmar] = useState<{ regla: ReglaFila; resultado: ResultadoCorrida; texto: string } | null>(null);
  const [corrida, setCorrida] = useState<{ regla: ReglaFila; resultado: ResultadoCorrida } | null>(null);
  // Import / export de CSV
  const [importando, setImportando] = useState(false);
  const [resultadoImport, setResultadoImport] = useState<RespuestaImport | null>(null);
  const [vaciando, setVaciando] = useState(false);

  const show = useCallback((tone: 'good' | 'bad', text: string) => setFlash({ tone, text }), []);

  async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      cache: 'no-store',
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string; detail?: string };
    if (!res.ok) throw new Error(body.detail ?? body.error ?? `HTTP ${res.status}`);
    return body;
  }

  async function refrescar() {
    const [r, s] = await Promise.all([
      api<{ reglas: ReglaFila[] }>('/api/ads/reglas'),
      api<EstadoInterruptores>('/api/ads/interruptores'),
    ]);
    setReglas(r.reglas);
    setSw(s);
  }

  async function toggleGlobal(campo: 'habilitado' | 'forzarSombra', valor: boolean) {
    setBusy(true);
    try {
      await api('/api/ads/interruptores', { method: 'POST', body: JSON.stringify({ [campo]: valor }) });
      await refrescar();
      show('good', campo === 'forzarSombra' ? (valor ? 'Modo simulación global activado' : 'Modo simulación global apagado') : valor ? 'Reglas habilitadas' : 'Reglas deshabilitadas');
    } catch (e) {
      show('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function actualizarRegla(r: ReglaFila, over: { enabled?: boolean; dryRun?: boolean }) {
    setBusy(true);
    try {
      await api('/api/ads/reglas', { method: 'POST', body: JSON.stringify(payloadDeRegla(r, over)) });
      await refrescar();
      show('good', 'Regla actualizada');
    } catch (e) {
      show('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Sacar el modo sombra es la única acción del panel que le da a un cron
  // permiso para gastar plata: confirmación escrita con el preview de qué haría
  // ahora mismo (task §3.2).
  async function pedirActivarReal(r: ReglaFila) {
    setBusy(true);
    try {
      const res = await api<{ resultado: ResultadoCorrida }>(`/api/ads/reglas?preview=1`, {
        method: 'POST',
        body: JSON.stringify({ id: r.id }),
      });
      setConfirmar({ regla: r, resultado: res.resultado, texto: '' });
    } catch (e) {
      show('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function correrAhora(r: ReglaFila) {
    setBusy(true);
    try {
      const res = await api<{ resultado: ResultadoCorrida }>(`/api/ads/reglas?preview=1`, {
        method: 'POST',
        body: JSON.stringify({ id: r.id }),
      });
      setCorrida({ regla: r, resultado: res.resultado });
    } catch (e) {
      show('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function borrar(r: ReglaFila) {
    if (!window.confirm(`¿Borrar la regla "${r.name}"? Su historial NO se borra.`)) return;
    setBusy(true);
    try {
      await api(`/api/ads/reglas?id=${r.id}`, { method: 'DELETE' });
      await refrescar();
      show('good', 'Regla borrada — el historial se conserva');
    } catch (e) {
      show('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function editar(r: ReglaFila) {
    setNueva(false);
    setNuevaEnCuenta(null);
    setDuplicando(null);
    setEditando(r);
  }

  function duplicar(r: ReglaFila) {
    setNueva(false);
    setNuevaEnCuenta(null);
    setEditando(null);
    // El único es (account_id, name) desde la 021: el nombre que no colisiona
    // se busca entre los nombres de ESA cuenta (R8 c8), y la copia queda en la
    // misma cuenta.
    const nombre = nombreDeCopia(r.name, reglas.filter((x) => x.accountId === r.accountId).map((x) => x.name));
    setDuplicando({ ...r, name: nombre });
  }

  function abrirNuevaEnCuenta(accountId: string) {
    setNueva(true);
    setNuevaEnCuenta(accountId);
    setEditando(null);
    setDuplicando(null);
  }

  function cerrarFormulario() {
    setNueva(false);
    setNuevaEnCuenta(null);
    setEditando(null);
    setDuplicando(null);
  }

  // El formulario es un popup y ya no una Card al final de la página: no hace
  // falta ningún scrollIntoView para que «Editar» se note (era el arreglo de
  // cuando el editor se pintaba a dos pantallas de scroll de la lista).

  /** Baja el CSV. El route manda Content-Disposition: attachment. */
  function exportarCsv(accountId?: string) {
    const url = accountId
      ? `/api/ads/reglas/csv?accountId=${encodeURIComponent(accountId)}`
      : '/api/ads/reglas/csv';
    // Un <a> temporal y no `location.href`: con el href directo, si el server
    // contestara un error en vez del archivo, el navegador se iría de la página
    // y el usuario perdería lo que tuviera abierto.
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function importarCsv(opts: { csv: string; accountIds: string[]; reemplazar: boolean }) {
    setBusy(true);
    try {
      const res = await api<RespuestaImport>('/api/ads/reglas/csv', {
        method: 'POST',
        body: JSON.stringify(opts),
      });
      setImportando(false);
      setResultadoImport(res);
      await refrescar();
      show('good', `${res.creadas} regla(s) importadas — apagadas y en modo simulación`);
    } catch (e) {
      show('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function vaciarTodas() {
    setBusy(true);
    try {
      // No hay endpoint de borrado en lote: se usa el DELETE por id, que ya está
      // probado y conserva el historial (sus FK hacia ad_rules son SET NULL).
      // Secuencial a propósito: veinte DELETE en paralelo se pelean por el pool
      // de conexiones y no se gana nada en una acción que se hace una vez.
      let n = 0;
      for (const r of reglas) {
        await api(`/api/ads/reglas?id=${r.id}`, { method: 'DELETE' });
        n += 1;
      }
      setVaciando(false);
      await refrescar();
      show('good', `${n} regla(s) borradas — el historial se conserva`);
    } catch (e) {
      show('bad', (e as Error).message);
      // Puede haber quedado a medias: refrescar para mostrar el estado real.
      await refrescar();
    } finally {
      setBusy(false);
    }
  }

  async function guardar(payload: Record<string, unknown>, id?: number) {
    setBusy(true);
    try {
      await api('/api/ads/reglas', { method: 'POST', body: JSON.stringify(payload) });
      await refrescar();
      cerrarFormulario();
      show('good', id ? 'Regla guardada' : 'Regla creada — nace apagada y en modo simulación');
    } catch (e) {
      show('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const accionDe = (r: ReglaFila): string => {
    let a = ACCION_LABEL[r.action];
    if (r.action === 'budget_increase' || r.action === 'budget_decrease') {
      a +=
        r.actionUnit === 'percent'
          ? ` (escalar al ${r.actionValue}% del presupuesto)`
          : ` (${r.action === 'budget_increase' ? 'sumar' : 'restar'} ${eur(r.actionValue ?? 0)})`;
    }
    const cond =
      r.condiciones.length === 0
        ? 'sin condiciones'
        : r.condiciones
            .map((c) => `${METRICA_LABEL[c.metric]} ${c.op} ${formatearValorCondicion(c)}`)
            .join(' y ');
    return `${a} · si ${cond}`;
  };

  const frecuencia = (r: ReglaFila): string =>
    `${frecuenciaLabel(r.everyMinutes)} · ${PERIODO_LABEL[r.period]}${
      r.windowStart && r.windowEnd ? ` · ${r.windowStart}-${r.windowEnd}` : ''
    }`;

  // ── La lista agrupada por cuenta (R8 c5): una sección por Cuenta_Activa, con
  //    el nombre y la zona en el encabezado y su botón "Nueva regla en esta
  //    cuenta" (R8 c7). Las reglas cuya cuenta ya no está activa van al final,
  //    agrupadas por su id. ───────────────────────────────────────────────────
  const grupos: { accountId: string; encabezado: string; reglas: ReglaFila[] }[] = [];
  const idsConGrupo = new Set<string>();
  for (const c of cuentas) {
    const encabezado = `${c.name ?? c.accountId} · ${c.timezone}`;
    const de = reglas.filter((r) => r.accountId === c.accountId);
    idsConGrupo.add(c.accountId);
    grupos.push({ accountId: c.accountId, encabezado, reglas: de });
  }
  for (const id of Array.from(new Set(reglas.filter((r) => !idsConGrupo.has(r.accountId)).map((r) => r.accountId)))) {
    grupos.push({ accountId: id, encabezado: id, reglas: reglas.filter((r) => r.accountId === id) });
  }

  return (
    <div className="space-y-4">
      {/* Encabezado y SubNav: app/(panel)/anuncios/layout.tsx */}
      {busy && (
        <div className="flex justify-end">
          <span className="text-xs text-neutral-500">Guardando…</span>
        </div>
      )}

      {flash && (
        <Banner tone={flash.tone} title={flash.tone === 'good' ? 'Listo' : 'No se pudo'}>
          {flash.text}
        </Banner>
      )}

      {/* ── Banner global: imposible confundir el mundo simulado con el real ── */}
      <Banner tone={sw.forzarSombra ? 'info' : 'warn'} title={sw.forzarSombra ? 'Modo simulación global activo' : 'Reglas en modo REAL'}>
        <div className="space-y-2">
          <p className="text-[13px] leading-snug">
            {sw.forzarSombra
              ? 'Ninguna regla está tocando Meta: todas registran lo que habrían hecho. Revisá el historial y apagá este interruptor cuando quieras que actúen de verdad.'
              : 'Las reglas prendidas que estén en modo real (badge REAL) están cambiando estados y presupuestos en Meta de verdad.'}
          </p>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-1">
            <label className="flex items-center gap-2 text-xs text-neutral-300">
              <Switch
                checked={sw.habilitado}
                disabled={busy}
                label="Reglas habilitadas"
                onChange={(v) => toggleGlobal('habilitado', v)}
              />
              Reglas habilitadas
            </label>
            <label className="flex items-center gap-2 text-xs text-neutral-300">
              <Switch
                checked={sw.forzarSombra}
                disabled={busy}
                label="Modo simulación global"
                onChange={(v) => toggleGlobal('forzarSombra', v)}
              />
              Modo simulación global
            </label>
            <span className="text-xs text-neutral-400">
              Worker:{' '}
              {sw.workerLastTick ? `última corrida ${fmtDateTime(sw.workerLastTick)}` : 'sin corridas registradas'}
              {sw.backoffReason ? ` · en backoff: ${sw.backoffReason}` : ''}
            </span>
          </div>
        </div>
      </Banner>

      {/* ── Barra de acciones de la pantalla ── */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <MenuAcciones
          etiqueta="Más opciones de reglas"
          variante="texto"
          disabled={busy}
          items={[
            { label: 'Importar reglas desde CSV…', onSelect: () => setImportando(true) },
            {
              label: reglas.length === 0 ? 'Exportar a CSV (no hay reglas)' : `Exportar las ${reglas.length} reglas a CSV`,
              onSelect: () => exportarCsv(),
            },
            ...(reglas.length > 0
              ? [
                  {
                    label: `Vaciar las ${reglas.length} reglas…`,
                    peligro: true,
                    onSelect: () => setVaciando(true),
                  },
                ]
              : []),
          ]}
        />
        <button
          type="button"
          className={btnPrimary}
          disabled={busy || cuentas.length === 0}
          onClick={() => abrirNuevaEnCuenta(cuentas[0]?.accountId ?? '')}
        >
          Crear regla
        </button>
      </div>

      {/* ── Lista ── */}
      <Card
        title={`Reglas · ${reglas.length}`}
        hint="El switch de estado de cada fila, el modo sombra/real en el menú «⋮» de cada regla y los dos interruptores globales de arriba son los controles del módulo: ninguno es una variable de entorno."
      >
        {cuentas.length === 0 ? (
          // Sin Cuenta_Activa cargada no se puede crear ninguna regla: el API y
          // la base la rechazan. En lugar de un formulario que va a fallar, el
          // estado vacío apunta a donde se cargan las cuentas.
          <div className="flex flex-col items-center gap-1 py-10 text-center">
            <p className="text-sm font-medium text-neutral-300">No hay cuentas publicitarias activas</p>
            <p className="text-xs text-neutral-500">
              Cargá las cuentas en{' '}
              <a href="/config?s=publicidad" className="underline underline-offset-2">
                Config → Publicidad
              </a>
              : sin una cuenta activa no se puede crear ninguna regla.
            </p>
          </div>
        ) : (
          <>
            {reglas.length === 0 && (
              <EmptyState title="Todavía no hay reglas" hint="Creá la primera con «Nueva regla en esta cuenta»." />
            )}
            {grupos.map((g) => (
              <div key={g.accountId} className="mt-4 first:mt-0">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">{g.encabezado}</h3>
                  <button
                    type="button"
                    className={btnGhost}
                    disabled={busy}
                    onClick={() => abrirNuevaEnCuenta(g.accountId)}
                  >
                    Nueva regla en esta cuenta
                  </button>
                </div>
                {g.reglas.length === 0 ? (
                  <p className="py-2 text-xs text-neutral-500">Sin reglas en esta cuenta.</p>
                ) : (
                  <Table
                    rows={g.reglas}
                    columns={[
                      {
                        key: 'enabled',
                        header: 'Estado',
                        render: (r) => (
                          <Switch checked={r.enabled} disabled={busy} label={`Prender ${r.name}`} onChange={(v) => actualizarRegla(r, { enabled: v })} />
                        ),
                      },
                      {
                        key: 'nombre',
                        header: 'Nombre',
                        render: (r) => (
                          <span className="font-medium text-neutral-100">
                            {r.name}
                            {/*
                              La columna «Modo» se fue de la tabla (el modo vive
                              en el menú de los tres puntos), pero el estado
                              PELIGROSO no puede quedar invisible: una regla en
                              real puede pausar campañas o mover presupuesto.
                              Por eso el badge aparece sólo cuando dryRun es
                              false. «SOMBRA» no se muestra: es el default de
                              todas las reglas y llenaba la tabla de ruido.
                            */}
                            {!r.dryRun && (
                              <span className="ml-2">
                                <Badge tone="warn">REAL</Badge>
                              </span>
                            )}
                            {r.condiciones.length === 0 && (
                              <span className="ml-2">
                                <Badge tone="bad">sin condiciones: se aplica a todo</Badge>
                              </span>
                            )}
                          </span>
                        ),
                      },
                      { key: 'aplicado', header: 'Aplicado a', render: (r) => <span className="text-neutral-300">{aplicadoA(r, cuentas)}</span> },
                      {
                        key: 'accion',
                        header: 'Acción y condición',
                        // 2.14: el aviso de valor sospechoso va acá, en la celda
                        // donde el importe se muestra, y no al lado del nombre —
                        // ahí ya hay dos badges (REAL y «sin condiciones»). El
                        // detalle va en el `title`, como los badges del historial.
                        render: (r) => {
                          const aviso = avisoDeSospecha(r);
                          return (
                            <span className="text-neutral-300">
                              {accionDe(r)}
                              {aviso && (
                                <span className="ml-2" title={aviso.detalle}>
                                  <Badge tone="warn">{aviso.etiqueta}</Badge>
                                </span>
                              )}
                            </span>
                          );
                        },
                      },
                      { key: 'frecuencia', header: 'Frecuencia y período', render: (r) => <span className="text-neutral-300">{frecuencia(r)}</span> },
                      {
                        key: 'ultima',
                        header: 'Última corrida',
                        render: (r) =>
                          r.lastRunError ? (
                            <Badge tone="bad">{r.lastRunError.slice(0, 32)}</Badge>
                          ) : r.lastRunAt ? (
                            <span className="text-neutral-400">{fmtDateTime(r.lastRunAt)}</span>
                          ) : (
                            <Badge tone="neutral">nunca</Badge>
                          ),
                      },
                      {
                        key: 'acciones',
                        header: 'Más',
                        align: 'right',
                        render: (r) => (
                          <span className="flex justify-end">
                            <MenuAcciones
                              etiqueta={`Acciones de ${r.name}`}
                              disabled={busy}
                              // El modo de la regla se lee acá, en el menú, y no
                              // en una columna: es un dato que se consulta al ir
                              // a cambiarlo, no en cada barrido de la tabla.
                              encabezado={
                                r.dryRun
                                  ? 'Modo sombra: anota lo que haría, no toca Meta.'
                                  : sw.forzarSombra
                                    ? 'Modo real, frenado por el modo simulación global de arriba.'
                                    : 'Modo real: cuando está prendida, cambia Meta de verdad.'
                              }
                              items={[
                                { label: 'Editar', onSelect: () => editar(r) },
                                { label: 'Duplicar', onSelect: () => duplicar(r) },
                                { label: 'Correr ahora (simulado)', onSelect: () => correrAhora(r) },
                                {
                                  label: r.dryRun ? 'Pasar a modo real…' : 'Volver a modo sombra',
                                  detalle: r.dryRun
                                    ? 'Le da permiso para tocar Meta cuando esté prendida'
                                    : 'Vuelve a simular: deja de tocar Meta',
                                  aviso: r.dryRun,
                                  title:
                                    'Sacar el modo sombra da permiso a la regla para tocar Meta cuando esté habilitada',
                                  onSelect: () =>
                                    r.dryRun ? pedirActivarReal(r) : actualizarRegla(r, { dryRun: true }),
                                },
                                { label: 'Exportar esta cuenta a CSV', onSelect: () => exportarCsv(r.accountId) },
                                { label: 'Borrar', peligro: true, onSelect: () => borrar(r) },
                              ]}
                            />
                          </span>
                        ),
                      },
                    ]}
                  />
                )}
              </div>
            ))}
          </>
        )}

      </Card>

      {/* ── Formulario (popup) ── */}
      {(nueva || editando || duplicando) && (
        <FormularioRegla
          /*
           * LA `key` ES EL ARREGLO DEL BOTÓN «EDITAR», no una optimización.
           *
           * `FormularioRegla` copia `inicial` a estado local con `useState`, y
           * useState sólo lee su argumento en el PRIMER render. Sin `key`,
           * React reusaba el componente ya montado al pasar de una regla a
           * otra (o de «Crear regla» a «Editar»): los campos seguían
           * mostrando lo anterior y el botón parecía no hacer nada. Y era
           * peor que un no-op: `editId` SÍ es una prop y sí cambiaba, así que
           * «Guardar cambios» escribía los valores de una regla sobre el id
           * de la otra. Con una key distinta por destino, el componente se
           * remonta y `useState` vuelve a leer `inicial`.
           *
           * El nombre entra en la key de duplicar porque duplicar dos veces
           * la misma regla da el mismo id y distinto nombre («(copia 2)»).
           */
          key={
            editando
              ? `editar-${editando.id}`
              : duplicando
                ? `duplicar-${duplicando.id}-${duplicando.name}`
                : `nueva-${nuevaEnCuenta ?? ''}`
          }
          cuentas={cuentas}
          maxDailyBudgetEur={sw.maxDailyBudgetEur}
          inicial={editando ? formDeRegla(editando) : duplicando ? formDeRegla(duplicando) : formVacio(nuevaEnCuenta ?? '')}
          editId={editando?.id}
          guardando={busy}
          otras={reglas}
          onCancel={cerrarFormulario}
          onSave={guardar}
        />
      )}

      {/* ── Diálogo de confirmación escrita (sacar el modo sombra) ── */}
      {confirmar && (
        <Modal
          title="Vas a darle permiso para gastar plata"
          onClose={() => setConfirmar(null)}
        >
          <div className="space-y-3 text-sm text-neutral-200">
            <p>
              La regla <strong className="text-neutral-100">«{confirmar.regla.name}»</strong> ejecuta{' '}
              <strong className="text-neutral-100">{ACCION_LABEL[confirmar.regla.action].toLowerCase()}</strong>.
            </p>
            {confirmar.resultado.corrio ? (
              <p>
                Ahora mismo alcanza a{' '}
                <strong className="text-neutral-100">{confirmar.resultado.objetosQueCumplen}</strong> objeto
                {confirmar.resultado.objetosQueCumplen === 1 ? '' : 's'} (evaluó{' '}
                {confirmar.resultado.objetosEvaluados}, en modo simulación).
              </p>
            ) : (
              <p>No corrió: {confirmar.resultado.motivoNoCorrio ?? confirmar.resultado.error ?? 'sin datos'}.</p>
            )}
            <p className="text-xs text-neutral-400">
              A partir de ahora, cuando la regla esté habilitada, cambiará estados y presupuestos en Meta de verdad.
              Escribí el nombre de la regla para confirmar.
            </p>
            {/* Las tres llaves: prendida + regla en real + simulación global
                apagada. Sin este aviso, sacarle el modo sombra a una regla
                "no hacía nada" y no había forma de saber por qué. */}
            {(sw.forzarSombra || !confirmar.regla.enabled || !sw.habilitado) && (
              <Banner tone="info" title="Todavía va a seguir simulando">
                <ul className="list-inside list-disc space-y-0.5 text-xs">
                  {sw.forzarSombra && <li>El «Modo simulación global» de arriba está prendido: apagalo para que actúe.</li>}
                  {!sw.habilitado && <li>El interruptor «Reglas habilitadas» está apagado: ninguna regla corre.</li>}
                  {!confirmar.regla.enabled && <li>Esta regla está apagada: prendé su switch en la columna Estado.</li>}
                </ul>
              </Banner>
            )}
            <input
              className={inputCls}
              value={confirmar.texto}
              onChange={(e) => setConfirmar({ ...confirmar, texto: e.target.value })}
              placeholder={confirmar.regla.name}
            />
            <div className="flex gap-2">
              <button
                type="button"
                className={btnDanger}
                disabled={busy || confirmar.texto.trim() !== confirmar.regla.name}
                onClick={async () => {
                  const r = confirmar.regla;
                  setConfirmar(null);
                  await actualizarRegla(r, { dryRun: false });
                }}
              >
                Pasar a modo real
              </button>
              <button type="button" className={btnGhost} onClick={() => setConfirmar(null)}>
                Cancelar
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── Resultado de "correr ahora" (siempre simulado) ── */}
      {corrida && (
        <Modal title={`Corrida simulada de «${corrida.regla.name}»`} onClose={() => setCorrida(null)}>
          <div className="space-y-3 text-sm text-neutral-200">
            <Banner tone="info">Esto fue una simulación: no se tocó Meta.</Banner>
            <p>
              Evaluó {corrida.resultado.objetosEvaluados} objetos · habría ejecutado{' '}
              {corrida.resultado.simuladas + corrida.resultado.omitidas === 0
                ? 'ninguna acción'
                : `${corrida.resultado.simuladas} (más ${corrida.resultado.omitidas} omitidas)`}
              .
            </p>
            {corrida.resultado.acciones.length > 0 && (
              <ul className="max-h-72 list-inside list-disc space-y-1 overflow-y-auto text-xs text-neutral-300">
                {corrida.resultado.acciones.map((a, i) => (
                  <li key={i}>{a.explicacion}</li>
                ))}
              </ul>
            )}
            {corrida.resultado.error && <p className="text-xs text-bad-300">Error: {corrida.resultado.error}</p>}
            <button type="button" className={btnPrimary} onClick={() => setCorrida(null)}>
              Cerrar
            </button>
          </div>
        </Modal>
      )}

      {/* ── Importar CSV de UTMify ── */}
      {importando && (
        <DialogoImportar
          cuentas={cuentas}
          reglas={reglas}
          busy={busy}
          onCerrar={() => setImportando(false)}
          onImportar={importarCsv}
        />
      )}

      {/* ── Qué pasó con el import ── */}
      {resultadoImport && (
        <Modal title="Resultado del import" onClose={() => setResultadoImport(null)}>
          <div className="space-y-3 text-sm text-neutral-200">
            <Banner tone="good" title={`${resultadoImport.creadas} regla(s) importadas`}>
              {resultadoImport.borradas > 0
                ? `Se borraron ${resultadoImport.borradas} reglas viejas y se crearon ${resultadoImport.creadas}. `
                : ''}
              Todas quedaron apagadas y en modo simulación: activarlas es un paso aparte, regla por regla.
            </Banner>

            {resultadoImport.omitidas.length > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Omitidas · {resultadoImport.omitidas.length}
                </p>
                <ul className="mt-1 max-h-40 list-inside list-disc overflow-y-auto text-xs text-neutral-400">
                  {resultadoImport.omitidas.map((o, i) => (
                    <li key={i}>
                      «{o.name}» en {o.accountId}: {o.motivo}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {resultadoImport.errores.length > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-bad-300">
                  Filas con error · {resultadoImport.errores.length}
                </p>
                <ul className="mt-1 max-h-40 list-inside list-disc overflow-y-auto text-xs text-bad-200">
                  {resultadoImport.errores.map((e, i) => (
                    <li key={i}>
                      línea {e.linea} «{e.name}»: {e.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {resultadoImport.avisos.length > 0 && (
              <ul className="max-h-48 list-inside list-disc space-y-1 overflow-y-auto text-xs text-neutral-400">
                {resultadoImport.avisos.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            )}

            <button type="button" className={btnPrimary} onClick={() => setResultadoImport(null)}>
              Cerrar
            </button>
          </div>
        </Modal>
      )}

      {/* ── Vaciar todas las reglas ── */}
      {vaciando && (
        <Modal title="Vaciar todas las reglas" onClose={() => setVaciando(false)}>
          <div className="space-y-3 text-sm text-neutral-200">
            <p>
              Se van a borrar las <strong className="text-neutral-100">{reglas.length}</strong> reglas de todas las
              cuentas.
            </p>
            <p className="text-xs text-neutral-400">
              El historial de corridas y de acciones NO se borra: queda con el nombre de la regla congelado. Si tenés el
              CSV, se puede volver a importar.
            </p>
            <div className="flex gap-2">
              <button type="button" className={btnDanger} disabled={busy} onClick={vaciarTodas}>
                {busy ? 'Borrando…' : `Sí, borrar las ${reglas.length}`}
              </button>
              <button type="button" className={btnGhost} disabled={busy} onClick={() => setVaciando(false)}>
                Cancelar
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Diálogo de importar CSV ─────────────────────────────────────────────────

/**
 * El import, con vista previa.
 *
 * La previa usa `importarCsvUtmify`, EL MISMO traductor que corre en el server:
 * el archivo se traduce en el navegador para mostrar qué va a entrar, cuántas
 * filas fallaron y por qué, y sólo entonces se manda. Así el usuario no
 * descubre un error de mapeo después de escribir en la base, y lo que ve en la
 * previa es exactamente lo que el server va a insertar (misma función, mismos
 * datos), no una aproximación.
 */
function DialogoImportar({
  cuentas,
  reglas,
  busy,
  onCerrar,
  onImportar,
}: {
  cuentas: CuentaAds[];
  reglas: ReglaFila[];
  busy: boolean;
  onCerrar: () => void;
  onImportar: (opts: { csv: string; accountIds: string[]; reemplazar: boolean }) => Promise<void>;
}): JSX.Element {
  const [csv, setCsv] = useState('');
  const [nombreArchivo, setNombreArchivo] = useState<string | null>(null);
  const [seleccion, setSeleccion] = useState<string[]>(cuentas.map((c) => c.accountId));
  const [reemplazar, setReemplazar] = useState(false);

  const previa = useMemo(() => (csv.trim() === '' ? null : importarCsvUtmify(csv)), [csv]);
  const aBorrar = reglas.filter((r) => seleccion.includes(r.accountId)).length;
  const total = (previa?.reglas.length ?? 0) * seleccion.length;
  const puedeImportar = !busy && total > 0 && seleccion.length > 0;

  async function elegirArchivo(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const f = e.target.files?.[0];
    if (!f) return;
    setNombreArchivo(f.name);
    setCsv(await f.text());
  }

  function toggleCuenta(accountId: string): void {
    setSeleccion((prev) =>
      prev.includes(accountId) ? prev.filter((a) => a !== accountId) : [...prev, accountId],
    );
  }

  return (
    <Modal title="Importar reglas desde un CSV de UTMify" onClose={onCerrar}>
      <div className="space-y-4 text-sm text-neutral-200">
        <div className="space-y-2">
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Archivo .csv
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={elegirArchivo}
              className="text-xs text-neutral-300 file:mr-2 file:rounded-lg file:border file:border-border-strong file:bg-overlay/6 file:px-2 file:py-1 file:text-xs file:text-neutral-200"
            />
          </label>
          <p className="text-[11px] text-neutral-600">
            O pegá el contenido acá abajo. {nombreArchivo && <>Cargado: {nombreArchivo}.</>}
          </p>
          <textarea
            className={`${inputCls} h-24 w-full font-mono text-[11px]`}
            value={csv}
            onChange={(e) => {
              setCsv(e.target.value);
              setNombreArchivo(null);
            }}
            placeholder="adPlatform,name,nameContains,applyTo,actionType,…"
            spellCheck={false}
          />
        </div>

        {/* ── A qué cuentas ── */}
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">Cuentas de destino</p>
          <p className="mb-2 text-[11px] leading-tight text-neutral-600">
            El CSV de UTMify no dice a qué cuenta publicitaria va cada regla. Con más de una cuenta marcada se crea una
            copia de cada regla en cada cuenta, y la ventana horaria de cada copia se evalúa en la zona de SU cuenta.
          </p>
          <div className="space-y-1">
            {cuentas.map((c) => (
              <label key={c.accountId} className="flex items-center gap-2 text-xs text-neutral-300">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-good-500"
                  checked={seleccion.includes(c.accountId)}
                  onChange={() => toggleCuenta(c.accountId)}
                />
                {c.name ?? c.accountId} · {c.timezone}
              </label>
            ))}
          </div>
        </div>

        {/* ── Reemplazar o agregar ── */}
        <label className="flex items-start gap-2 text-xs text-neutral-300">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-bad-500"
            checked={reemplazar}
            onChange={(e) => setReemplazar(e.target.checked)}
          />
          <span>
            Borrar las reglas que ya están en esas cuentas antes de importar
            {reemplazar && aBorrar > 0 && (
              <strong className="text-bad-300"> — se van a borrar {aBorrar} regla(s)</strong>
            )}
            <span className="block text-[11px] text-neutral-600">
              Sin esto, una regla cuyo nombre ya existe en la cuenta se omite (el nombre es único por cuenta).
            </span>
          </span>
        </label>

        {/* ── Vista previa ── */}
        {previa && (
          <div className="space-y-2 rounded-xl border border-border-subtle bg-overlay/2 p-3">
            <p className="text-xs text-neutral-300">
              <strong className="text-neutral-100">{previa.reglas.length}</strong> regla(s) listas
              {seleccion.length > 1 && <> × {seleccion.length} cuentas = {total} filas</>}
              {previa.errores.length > 0 && (
                <span className="text-bad-300"> · {previa.errores.length} fila(s) con error</span>
              )}
            </p>

            {previa.reglas.length > 0 && (
              <ul className="max-h-32 space-y-0.5 overflow-y-auto text-[11px] text-neutral-400">
                {previa.reglas.map((r) => (
                  <li key={r.name}>
                    {r.name} — {ACCION_LABEL[r.action].toLowerCase()}
                    {r.actionUnit === 'percent' && ` al ${r.actionValue}%`}
                    {r.actionUnit === 'fixed' && ` ${eur(r.actionValue ?? 0)}`}
                    {r.budgetMax != null && ` (techo ${eur(r.budgetMax)})`}
                    {r.budgetMin != null && ` (piso ${eur(r.budgetMin)})`} · {frecuenciaLabel(r.everyMinutes)}
                  </li>
                ))}
              </ul>
            )}

            {previa.errores.length > 0 && (
              <ul className="max-h-32 list-inside list-disc space-y-0.5 overflow-y-auto text-[11px] text-bad-200">
                {previa.errores.map((e, i) => (
                  <li key={i}>
                    línea {e.linea} «{e.name}»: {e.error}
                  </li>
                ))}
              </ul>
            )}

            {previa.avisos.length > 0 && (
              <ul className="max-h-32 list-inside list-disc space-y-0.5 overflow-y-auto text-[11px] text-neutral-500">
                {previa.avisos.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            className={btnPrimary}
            disabled={!puedeImportar}
            onClick={() => onImportar({ csv, accountIds: seleccion, reemplazar })}
          >
            {busy ? 'Importando…' : total > 0 ? `Importar ${total} regla(s)` : 'Importar'}
          </button>
          <button type="button" className={btnGhost} disabled={busy} onClick={onCerrar}>
            Cancelar
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Modal ───────────────────────────────────────────────────────────────────

/**
 * El popup de la pantalla: encabezado fijo con el título y la X, cuerpo
 * scrolleable y pie opcional.
 *
 * POR QUÉ SCROLLEA EL CUERPO Y NO LA PÁGINA
 * El formulario de reglas tiene veinte campos y no entra en una notebook. Si el
 * diálogo crece libre, «Guardar» termina abajo del borde de la ventana y no hay
 * forma de llegar (el fondo no scrollea). Con `max-h` en el panel, el cuerpo en
 * `overflow-y-auto` y el pie afuera de ese cuerpo, los botones quedan siempre a
 * la vista.
 *
 * `cerrarAlClickAfuera=false` es para el formulario: un click al costado no
 * puede tirar a la basura veinte campos recién llenados. Escape sí cierra
 * siempre — es lo que se espera de un diálogo.
 */
function Modal({
  title,
  hint,
  onClose,
  children,
  footer,
  ancho = 'sm',
  cerrarAlClickAfuera = true,
}: {
  title: string;
  hint?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  ancho?: 'sm' | 'lg';
  cerrarAlClickAfuera?: boolean;
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      // `e.target === e.currentTarget`: sólo el fondo cierra. Con un onClick
      // pelado, arrastrar el mouse desde un input hasta afuera también cerraba.
      onMouseDown={(e) => {
        if (cerrarAlClickAfuera && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`flex max-h-[calc(100vh-2rem)] w-full flex-col overflow-hidden rounded-2xl border border-border-subtle bg-surface shadow-2xl ${
          ancho === 'lg' ? 'max-w-3xl' : 'max-w-lg'
        }`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border-subtle px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-neutral-100">{title}</h2>
            {hint && <p className="mt-0.5 text-xs leading-snug text-neutral-500">{hint}</p>}
          </div>
          <button
            type="button"
            aria-label="Cerrar"
            title="Cerrar"
            onClick={onClose}
            className="-mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-overlay/8 hover:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-good-500/50"
          >
            <X size={14} weight="bold" aria-hidden="true" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="border-t border-border-subtle px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

// ─── Formulario de crear / editar ────────────────────────────────────────────

type TabForm = 'alcance' | 'accion' | 'condiciones' | 'programacion';

/**
 * Las cuatro secciones del formulario, en el orden en que se lee la regla:
 * a qué le aplica → qué hace → cuándo se cumple → cada cuánto mira.
 *
 * Antes eran quince campos en una grilla de dos columnas donde «Estado» (el
 * filtro de alcance) quedaba al lado de «Modo» (el del filtro por nombre) y
 * los tres frenos se mezclaban con las condiciones. El orden es el mismo que
 * usa UTMify (acción antes que condiciones), que además es el que ya tenía el
 * formulario: agrupar no reordenó nada, sólo puso títulos donde no había.
 */
const TABS_FORM: readonly { id: TabForm; rotulo: string; Icono: typeof Crosshair }[] = [
  { id: 'alcance', rotulo: 'Alcance', Icono: Crosshair },
  { id: 'accion', rotulo: 'Acción', Icono: Lightning },
  { id: 'condiciones', rotulo: 'Condiciones', Icono: ListChecks },
  { id: 'programacion', rotulo: 'Programación', Icono: Clock },
];

/**
 * La regla entera en una frase, para el pie del popup.
 *
 * Con las pestañas, ninguna pantalla muestra todos los campos a la vez: sin
 * esta línea, «Guardar» se aprieta sin poder releer lo que se está por guardar.
 * Usa las mismas etiquetas en castellano que los selectores (`OP_LABEL`), así
 * que se lee igual que lo que se eligió.
 */
function resumenForm(f: FormEstado): string {
  const filtro = f.nameFilter.trim()
    ? ` que ${f.nameFilterMode === 'contains' ? 'contienen' : 'no contienen'} «${f.nameFilter.trim()}»`
    : '';
  const cond =
    f.conditions.length === 0
      ? 'sin condiciones (aplica a todos)'
      : f.conditions
          .map((c) => `${METRICA_LABEL[c.metric]} ${OP_LABEL[c.op]} ${c.value === '' ? '—' : c.value}`)
          .join(' y ');
  const ventana =
    f.windowStart !== '' && f.windowEnd !== '' ? `${f.windowStart}–${f.windowEnd}` : 'a toda hora';
  return `${ACCION_LABEL[f.action]} ${NIVEL_LABEL[f.level].toLowerCase()} ${STATUS_LABEL[f.statusFilter]}${filtro} si ${cond} · ${PERIODO_LABEL[f.period]} · ${frecuenciaLabel(f.everyMinutes)} · ${ventana}`;
}

function FormularioRegla({
  cuentas,
  maxDailyBudgetEur,
  inicial,
  editId,
  guardando,
  otras,
  onCancel,
  onSave,
}: {
  cuentas: CuentaAds[];
  maxDailyBudgetEur: number;
  inicial: FormEstado;
  editId?: number;
  guardando?: boolean;
  /** Todas las reglas, para avisar del nombre repetido antes del 409. */
  otras: readonly { id: number; accountId: string; name: string }[];
  onCancel: () => void;
  onSave: (payload: Record<string, unknown>, id?: number) => Promise<void>;
}): JSX.Element {
  const [f, setF] = useState<FormEstado>(inicial);
  const set = (p: Partial<FormEstado>) => setF((prev) => ({ ...prev, ...p }));

  const ep = esPresupuesto(f.action);
  const preview = previewFactor(f);
  // La regla que se está editando no compite consigo misma por el nombre.
  const otrasReglas = useMemo(() => otras.filter((o) => o.id !== editId), [otras, editId]);
  const prob = problema(f, otrasReglas);

  function setCondicion(i: number, p: Partial<CondicionDraft>) {
    setF((prev) => ({
      ...prev,
      conditions: prev.conditions.map((c, idx) => (idx === i ? { ...c, ...p } : c)),
    }));
  }

  function agregarCondicion() {
    setF((prev) => ({
      ...prev,
      conditions: [...prev.conditions, { metric: 'roi', op: '>', value: '' }],
    }));
  }

  function quitarCondicion(i: number) {
    setF((prev) => ({ ...prev, conditions: prev.conditions.filter((_, idx) => idx !== i) }));
  }

  const [tab, setTab] = useState<TabForm>('alcance');
  const idTabs = useId();
  const tabsRef = useRef<(HTMLButtonElement | null)[]>([]);

  // «Personalizado» se DEDUCE del estado, no es una bandera aparte: con una
  // bandera propia se puede desincronizar de las horas (personalizado con las
  // dos vacías, o cualquiera con horas cargadas) y eso es justo lo que rompía.
  const ventanaPersonalizada = f.windowStart !== '' || f.windowEnd !== '';
  const zonaCuenta = cuentas.find((c) => c.accountId === f.accountId)?.timezone ?? null;

  // El nombre y la cuenta ya los cubre `problemaAlcance`: sin esto la condición
  // estaba escrita dos veces y una de las dos se iba a quedar atrás.
  const puedeGuardar = prob === null && !guardando;

  // En qué pestaña está el campo que falta. El botón Guardar se deshabilita con
  // `prob`, y sin esto el usuario se quedaba con un botón muerto y el problema
  // escondido en una pestaña que no estaba mirando.
  const tabConProblema: TabForm | null = problemaAlcance(f, otrasReglas)
    ? 'alcance'
    : problemaAccion(f)
      ? 'accion'
      : problemaCondiciones(f)
        ? 'condiciones'
        : problemaProgramacion(f)
          ? 'programacion'
          : null;

  const panelProps = (id: TabForm) => ({
    role: 'tabpanel' as const,
    id: `${idTabs}-panel-${id}`,
    'aria-labelledby': `${idTabs}-tab-${id}`,
  });

  return (
    <Modal
      title={editId ? `Actualizar regla #${editId}` : 'Nueva regla'}
      hint={
        editId
          ? 'Los cambios se aplican en la próxima corrida. El modo sombra/real no se toca acá: está en el menú «⋮» de la fila.'
          : 'Una regla nueva nace apagada y en modo sombra: prenderla y pasarla a real son dos pasos aparte, desde el menú «⋮» de su fila.'
      }
      ancho="lg"
      // Un click afuera no puede descartar el formulario a medio llenar.
      cerrarAlClickAfuera={false}
      onClose={onCancel}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* El pie dice siempre una de dos cosas: qué falta y dónde, o la regla
              entera leída en una frase. Con las pestañas, un formulario válido
              no se puede revisar de un vistazo, y esta línea lo devuelve. */}
          <div className="min-w-0 flex-1 basis-64 text-[11px] leading-snug">
            {prob ? (
              <button
                type="button"
                onClick={() => tabConProblema && setTab(tabConProblema)}
                className="rounded text-left text-warn-300 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-warn-500/50"
              >
                {prob}
                {tabConProblema && (
                  <span className="text-neutral-500">
                    {' '}
                    — ir a {TABS_FORM.find((t) => t.id === tabConProblema)?.rotulo}
                  </span>
                )}
              </button>
            ) : (
              <span className="text-neutral-500">{resumenForm(f)}</span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" className={btnGhost} onClick={onCancel}>
              Cancelar
            </button>
            <button
              type="button"
              className={btnPrimary}
              disabled={!puedeGuardar}
              onClick={() => onSave(payloadDeForm(f, editId), editId)}
            >
              {guardando ? 'Guardando…' : editId ? 'Guardar cambios' : 'Crear regla'}
            </button>
          </div>
        </div>
      }
    >
      {/* El nombre queda AFUERA de las pestañas: es la identidad de la regla, no
          una de sus opciones, y tiene que estar visible desde cualquier pestaña. */}
      <label className="flex flex-col gap-1 text-xs text-neutral-500">
        Nombre de la regla
        <input
          className={inputCls}
          value={f.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="Apagar - Gasto +$10 sin ventas"
        />
      </label>

      {/* ── Pestañas ──────────────────────────────────────────────────────────
          El orden cuenta la regla como una oración: a qué le aplica, qué hace,
          cuándo se cumple y cada cuánto mira. Mismo patrón visual que
          TabsNivel del gestor (subrayado del acento, ícono Phosphor,
          aria-selected), no un tercer estilo de pestaña para el mismo panel. */}
      <div
        role="tablist"
        aria-label="Secciones de la regla"
        className="mt-4 flex items-end gap-1 overflow-x-auto border-b border-border-subtle"
        onKeyDown={(e) => {
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
          e.preventDefault();
          const i = TABS_FORM.findIndex((t) => t.id === tab);
          const n = TABS_FORM.length;
          const siguiente = e.key === 'ArrowRight' ? (i + 1) % n : (i - 1 + n) % n;
          setTab(TABS_FORM[siguiente].id);
          // Mover el foco además de la selección: con roving tabindex, la
          // pestaña que queda seleccionada es la única con tabIndex 0, y dejar
          // el foco en la anterior deja al teclado sin salida.
          tabsRef.current[siguiente]?.focus();
        }}
      >
        {TABS_FORM.map(({ id, rotulo, Icono }) => {
          const activa = id === tab;
          const marcada = id === tabConProblema;
          return (
            <button
              key={id}
              ref={(el) => {
                tabsRef.current[TABS_FORM.findIndex((t) => t.id === id)] = el;
              }}
              type="button"
              role="tab"
              id={`${idTabs}-tab-${id}`}
              aria-selected={activa}
              aria-controls={`${idTabs}-panel-${id}`}
              tabIndex={activa ? 0 : -1}
              onClick={() => setTab(id)}
              className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-good-500/60 ${
                activa
                  ? 'border-good-500 text-good-300'
                  : 'border-transparent text-neutral-500 hover:text-neutral-300'
              }`}
            >
              <Icono size={14} weight={activa ? 'fill' : 'regular'} aria-hidden="true" />
              {rotulo}
              {marcada && (
                // El punto ámbar no es el único portador: el pie dice el mensaje
                // completo y el título del botón lo repite.
                <span
                  title="Falta algo en esta sección"
                  aria-label="Falta algo en esta sección"
                  className="h-1.5 w-1.5 rounded-full bg-warn-400"
                />
              )}
            </button>
          );
        })}
      </div>

      {/* ── Alcance: a qué objetos les aplica ── */}
      {tab === 'alcance' && (
        <div {...panelProps('alcance')} className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-neutral-500 sm:col-span-2">
            Cuenta de anuncios
            <select className={inputCls} value={f.accountId} onChange={(e) => set({ accountId: e.target.value })}>
              <option value="">— elegí una cuenta —</option>
              {cuentas.map((c) => (
                <option key={c.accountId} value={c.accountId}>
                  {c.name ?? c.accountId} — {c.timezone}
                </option>
              ))}
            </select>
            <span className="text-[11px] text-neutral-600">
              La ventana horaria y el período de cálculo se evalúan en la zona de esta cuenta.
            </span>
          </label>

          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Aplicar regla a
            <select className={inputCls} value={f.level} onChange={(e) => set({ level: e.target.value as NivelAds })}>
              <option value="campaign">Campañas</option>
              <option value="adset">Conjuntos</option>
              <option value="ad">Anuncios</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Estado
            <select className={inputCls} value={f.statusFilter} onChange={(e) => set({ statusFilter: e.target.value as StatusFilter })}>
              <option value="active">Activos</option>
              <option value="paused">Pausados</option>
              <option value="any">Cualquier estado</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Filtrar por nombre
            <input className={inputCls} value={f.nameFilter} onChange={(e) => set({ nameFilter: e.target.value })} placeholder="PXN" />
            <span className="text-[11px] text-neutral-600">Vacío = sin filtrar por nombre.</span>
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Modo del filtro
            <select className={inputCls} value={f.nameFilterMode} onChange={(e) => set({ nameFilterMode: e.target.value as 'contains' | 'not_contains' })}>
              <option value="contains">contiene</option>
              <option value="not_contains">no contiene</option>
            </select>
          </label>
        </div>
      )}

      {/* ── Acción: qué hace cuando se cumple ── */}
      {tab === 'accion' && (
        <div {...panelProps('accion')} className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-neutral-500 sm:col-span-2">
            Acción
            <select
              className={inputCls}
              value={f.action}
              onChange={(e) => {
                const a = e.target.value as Accion;
                // Al cambiar de acción se limpian valor/techo/piso para no arrastrar
                // un número de otra acción (los campos no se esconden, se vacían).
                set({ action: a, actionValue: '', budgetMax: '', budgetMin: '' });
              }}
            >
              <option value="pause">Pausar</option>
              <option value="activate">Activar</option>
              {f.level !== 'ad' && <option value="budget_increase">Subir presupuesto</option>}
              {f.level !== 'ad' && <option value="budget_decrease">Bajar presupuesto</option>}
            </select>
            {f.level === 'ad' && (
              <span className="text-[11px] text-neutral-600">
                En Meta los anuncios no tienen presupuesto: a nivel anuncio sólo se puede pausar o activar.
              </span>
            )}
          </label>

          {!ep && (
            <p className="text-[11px] leading-snug text-neutral-600 sm:col-span-2">
              {f.action === 'pause'
                ? 'Pausar no necesita más configuración. Es idempotente: un objeto ya pausado se descarta solo.'
                : 'Activar no necesita más configuración.'}
            </p>
          )}

          {ep && (
            <>
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                {f.actionUnit === 'percent' ? 'Escalar al % del presupuesto actual' : f.action === 'budget_increase' ? `Sumar ${SIMBOLO_REPORTE} al presupuesto actual` : `Restar ${SIMBOLO_REPORTE} al presupuesto actual`}
                <input
                  className={`${inputCls} tabular-nums`}
                  inputMode="decimal"
                  value={f.actionValue}
                  onChange={(e) => set({ actionValue: e.target.value })}
                  placeholder={f.actionUnit === 'percent' ? '250' : '10'}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                Unidad
                <select className={inputCls} value={f.actionUnit} onChange={(e) => set({ actionUnit: e.target.value as 'percent' | 'fixed' })}>
                  <option value="percent">escalar al %</option>
                  <option value="fixed">sumar/restar {SIMBOLO_REPORTE}</option>
                </select>
              </label>
              {f.actionUnit === 'percent' && (
                <span className="text-[11px] text-neutral-400 sm:col-span-2">
                  El % es un factor, no un incremento: 250% = ×2,5. {preview || ''} Con 100% marcado como «sin cambio».
                </span>
              )}

              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                Límite máximo de presupuesto{f.action === 'budget_increase' ? ' (obligatorio al subir)' : ''}
                <input
                  className={`${inputCls} tabular-nums`}
                  inputMode="decimal"
                  value={f.budgetMax}
                  disabled={f.action !== 'budget_increase' && f.action !== 'budget_decrease'}
                  onChange={(e) => set({ budgetMax: e.target.value })}
                  placeholder="25"
                />
                <span className="text-[11px] text-neutral-600">El máximo absoluto por objeto es {eur(maxDailyBudgetEur)}.</span>
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                Límite mínimo de presupuesto{f.action === 'budget_decrease' ? ' (obligatorio al bajar)' : ''}
                <input
                  className={`${inputCls} tabular-nums`}
                  inputMode="decimal"
                  value={f.budgetMin}
                  onChange={(e) => set({ budgetMin: e.target.value })}
                  placeholder="5"
                />
              </label>
            </>
          )}
        </div>
      )}

      {/* ── Condiciones: cuándo se considera que la regla se cumple ── */}
      {tab === 'condiciones' && (
        <div {...panelProps('condiciones')} className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-neutral-500">
              Período de cálculo
              <select className={inputCls} value={f.period} onChange={(e) => set({ period: e.target.value as PeriodoAds })}>
                <option value="today">hoy</option>
                <option value="yesterday">ayer</option>
                <option value="7d">7 días</option>
                <option value="7d_excl_today">7 días sin hoy</option>
              </select>
              <span className="text-[11px] text-neutral-600">Sobre qué ventana de datos se miden las métricas.</span>
            </label>

            <label className="flex flex-col gap-1 text-xs text-neutral-500">
              Nivel de las condiciones
              <select className={inputCls} value="object" disabled title="Las métricas del padre llegan en una versión próxima">
                <option value="object">del objeto</option>
              </select>
              <span className="text-[11px] text-neutral-600" title="'del padre' no está implementado: no se ofrece ni deshabilitado con la opción visible">
                Fijo en «del objeto»: las métricas del padre llegan en una versión próxima.
              </span>
            </label>
          </div>

          <div className="rounded-xl border border-border-subtle bg-overlay/2 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                Se cumple cuando
              </span>
              <button
                type="button"
                className={btnGhost}
                onClick={agregarCondicion}
                title="No hay OR: dos reglas separadas expresan lo mismo y se pueden prender y apagar por separado."
              >
                + agregar condición
              </button>
              <span className="text-[11px] text-neutral-600">Se combinan con Y (no hay OR).</span>
            </div>

            {f.conditions.length === 0 ? (
              // Sin condiciones la regla es legítima («pausar todo lo que se
              // llame X»), así que no se bloquea. Pero con una acción
              // destructiva conviene decirlo con el alcance puesto en la frase:
              // «pausar TODOS los conjuntos activos» se entiende distinto que
              // «sin condiciones».
              accionDestructiva(f.action) ? (
                <Banner tone="bad" title="Esta regla no tiene condiciones">
                  Va a {ACCION_LABEL[f.action].toLowerCase()}{' '}
                  <strong className="text-neutral-100">
                    todos los {NIVEL_LABEL[f.level].toLowerCase()} {STATUS_LABEL[f.statusFilter]}
                  </strong>{' '}
                  {f.nameFilter.trim()
                    ? `que ${f.nameFilterMode === 'contains' ? 'contengan' : 'no contengan'} «${f.nameFilter.trim()}»`
                    : 'de la cuenta, sin mirar ninguna métrica'}
                  . Si era eso, seguí; si no, agregá una condición.
                </Banner>
              ) : (
                <p className="text-xs text-neutral-500">
                  Sin condiciones, la regla se aplica a <strong className="text-bad-300">todos</strong> los objetos que pasan el
                  filtro de alcance.
                </p>
              )
            ) : (
              <div className="space-y-2">
                {f.conditions.map((c, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-2 items-center gap-2 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1.1fr)_minmax(0,6rem)_auto]"
                  >
                    <select
                      className={inputCls}
                      aria-label={`Métrica de la condición ${i + 1}`}
                      value={c.metric}
                      onChange={(e) => setCondicion(i, { metric: e.target.value as Condicion['metric'] })}
                    >
                      {METRICAS.map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label}
                          {METRICA_UNIDAD[m.value] === 'euro' ? ` (${SIMBOLO_REPORTE})` : METRICA_UNIDAD[m.value] === 'numero' ? ' (múltiplo)' : ' (cantidad)'}
                        </option>
                      ))}
                    </select>
                    {/* Palabras y no símbolos: «<=» y «>=» al lado en un select se
                        confunden, y elegir mal acá apaga lo que había que dejar. */}
                    <select
                      className={inputCls}
                      aria-label={`Comparación de la condición ${i + 1}`}
                      value={c.op}
                      onChange={(e) => setCondicion(i, { op: e.target.value as Condicion['op'] })}
                    >
                      {OPS.map((o) => (
                        <option key={o} value={o}>
                          {OP_LABEL[o]}
                        </option>
                      ))}
                    </select>
                    <input
                      className={`${inputCls} tabular-nums`}
                      aria-label={`Valor de la condición ${i + 1}`}
                      inputMode="decimal"
                      value={c.value}
                      onChange={(e) => setCondicion(i, { value: e.target.value })}
                      placeholder="1.3"
                    />
                    <button
                      type="button"
                      className={btnGhost}
                      aria-label={`Quitar la condición ${i + 1}`}
                      onClick={() => quitarCondicion(i)}
                    >
                      quitar
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <p className="text-[11px] leading-tight text-neutral-500">
            <strong className="text-neutral-400">ROI</strong> = neto ÷ gasto de ads. El neto ya tiene restadas las comisiones y el
            costo de producto. ROI 1,30 significa que el neto es 1,3 veces lo gastado en ads. <strong className="text-neutral-400">ROAS</strong> =
            ingresos brutos ÷ gasto, sin restar nada. El ROI de la sección Ventas se calcula distinto: no los compares.
          </p>
        </div>
      )}

      {/* ── Programación: cada cuánto mira y con qué frenos ── */}
      {tab === 'programacion' && (
        <div {...panelProps('programacion')} className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Frecuencia
            <select className={inputCls} value={f.everyMinutes} onChange={(e) => set({ everyMinutes: Number(e.target.value) })}>
              {[1, 5, 15, 30, 60, 1440].map((m) => (
                <option key={m} value={m}>
                  {frecuenciaLabel(m)}
                </option>
              ))}
            </select>
            <span className="text-[11px] text-neutral-600">Cada cuánto se evalúa la regla.</span>
          </label>

          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Límite de ejecuciones diarias
            <input
              className={`${inputCls} tabular-nums`}
              inputMode="numeric"
              value={f.maxRunsPerDay}
              onChange={(e) => set({ maxRunsPerDay: e.target.value })}
              placeholder="vacío = sin límite"
            />
            <span className="text-[11px] text-neutral-600">Cuántas veces por día puede correr, como máximo.</span>
          </label>

          {/*
            INTERVALO DE EJECUCIÓN — «Cualquiera» o «Personalizado».
            Antes eran dos `<input type="time">` sueltos, y eso permitía dos
            estados que rompen la regla sin avisar: media ventana (400 del API
            después de llenar el formulario) y las dos horas iguales (la regla
            queda viva pero con 60 segundos por día para correr, así que con
            cadencia de 15 minutos no corre nunca). Con un selector explícito el
            24/7 se elige, no se deduce de dos campos vacíos, y las horas salen
            de una lista en punto en lugar de un campo libre de minutos.
          */}
          <label className="flex flex-col gap-1 text-xs text-neutral-500 sm:col-span-2">
            Intervalo de ejecución
            <select
              className={inputCls}
              value={ventanaPersonalizada ? 'personalizado' : 'cualquiera'}
              onChange={(e) =>
                e.target.value === 'cualquiera'
                  ? set({ windowStart: '', windowEnd: '' })
                  : set({ windowStart: '08:00', windowEnd: '23:00' })
              }
            >
              <option value="cualquiera">Cualquiera — a toda hora, 24/7</option>
              <option value="personalizado">Personalizado — sólo en una franja</option>
            </select>
            {!ventanaPersonalizada && (
              <span className="text-[11px] text-neutral-600">
                La regla puede correr a cualquier hora del día.
              </span>
            )}
          </label>

          {ventanaPersonalizada && (
            <>
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                Horario inicial
                <select
                  className={`${inputCls} tabular-nums`}
                  value={f.windowStart}
                  onChange={(e) => set({ windowStart: e.target.value })}
                >
                  {opcionesHora(f.windowStart).map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                Horario final
                <select
                  className={`${inputCls} tabular-nums`}
                  value={f.windowEnd}
                  onChange={(e) => set({ windowEnd: e.target.value })}
                >
                  {opcionesHora(f.windowEnd).map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </label>
              <span className="text-[11px] leading-snug text-neutral-600 sm:col-span-2">
                En la zona de la cuenta ({zonaCuenta ?? 'sin cuenta elegida'}).
                {f.windowStart > f.windowEnd && f.windowEnd !== ''
                  ? ' El inicio es posterior al fin, así que la ventana cruza la medianoche.'
                  : ''}
              </span>
            </>
          )}

          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Cooldown por objeto (min)
            <input
              className={`${inputCls} tabular-nums`}
              inputMode="numeric"
              value={f.cooldownMinutes}
              onChange={(e) => {
                // Se clampea en 0 acá: un negativo pasa el `|| 0` (es truthy) y
                // muere en el CHECK ad_rules_cooldown_valido con un 400.
                const n = Number(e.target.value);
                set({ cooldownMinutes: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0 });
              }}
            />
            <span className="text-[11px] text-neutral-600">
              Cuánto esperar antes de volver a tocar el MISMO objeto. 0 = sin espera.
            </span>
          </label>

          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Máx. acciones por objeto por día
            <input
              className={`${inputCls} tabular-nums`}
              inputMode="numeric"
              value={f.maxActionsPerObjectPerDay}
              onChange={(e) => {
                // Sin `|| 1`: ese fallback hacía imposible escribir el 0, que es
                // justo el valor que significa «sin tope».
                const n = Number(e.target.value);
                set({ maxActionsPerObjectPerDay: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0 });
              }}
            />
            <span className="text-[11px] text-neutral-600">
              {f.maxActionsPerObjectPerDay === 0
                ? 'Sin tope: la regla puede actuar todas las veces que haga falta. Es lo que corresponde para una regla de pausar.'
                : 'El cupo se cuenta por objeto, no por regla: las acciones de otras reglas sobre el mismo objeto también lo gastan. 0 = sin tope.'}
            </span>
          </label>
        </div>
      )}

      {/* ── Avisos que no bloquean (los que bloquean van en el pie) ── */}
      {f.action === 'budget_increase' && f.budgetMax !== '' && Number(f.budgetMax) > maxDailyBudgetEur && (
        <div className="mt-4">
          <Banner tone="warn" title="El techo supera el máximo absoluto">
            El techo de {eur(Number(f.budgetMax))} está por encima del máximo absoluto por objeto ({eur(maxDailyBudgetEur)}): las
            subidas se van a cortar siempre en ese tope.
          </Banner>
        </div>
      )}
    </Modal>
  );
}
