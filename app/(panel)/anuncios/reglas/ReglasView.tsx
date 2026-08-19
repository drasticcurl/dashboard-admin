'use client';

/**
 * ReglasView — la pantalla /anuncios/reglas (T19).
 *
 * Lista de reglas con su switch de estado y su switch de modo sombra, el banner
 * de los dos interruptores globales (D-A12b), el formulario de crear/editar y
 * el diálogo de confirmación escrita para sacar el modo sombra.
 *
 * Los switches y el constructor de condiciones viven acá (D-A19): no se toca
 * `components/ui.tsx`. La referencia es `ConfigView.tsx` (formularios de
 * escritura, listas, confirmaciones). El servidor es la única fuente de verdad:
 * acá se muta contra `/api/ads/reglas` y `/api/ads/interruptores` y se refetchea.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DotsThreeVertical } from '@phosphor-icons/react';
import type { Condicion, NivelAds, PeriodoAds } from '@/lib/ads/tipos';
import type { ResultadoCorrida } from '@/lib/ads/reglas/ejecutor';
import type { CuentaAds, EstadoInterruptores, ReglaFila } from './_tipos';
import { nombreDeCopia } from './_nombres';
import { importarCsvUtmify } from '@/lib/ads/reglas/utmify';
import { Badge, Banner, Card, EmptyState, Table, fmtDateTime } from '@/components/ui';
import type { Tone } from '@/components/ui';

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
  return `€${dosDecimales.format(n)}`;
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
}: {
  etiqueta: string;
  items: ItemMenu[];
  disabled?: boolean;
  variante?: 'icono' | 'texto';
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
    // Alto estimado: 30 px por opción más el padding. Sólo se usa para decidir
    // si el menú se abre hacia arriba, así que una aproximación alcanza.
    const alto = items.length * 30 + 10;
    const cabeAbajo = window.innerHeight - r.bottom > alto + 8;
    setPos({
      top: cabeAbajo ? r.bottom + 4 : Math.max(8, r.top - alto - 4),
      // Anclado a la derecha: el disparador está en el borde derecho de la
      // tabla y un menú que crece hacia la derecha se saldría de la pantalla.
      right: Math.max(8, window.innerWidth - r.right),
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
              role="menu"
              aria-label={etiqueta}
              onKeyDown={navegar}
              style={{ position: 'fixed', top: pos.top, right: pos.right }}
              className="z-[60] min-w-[14rem] rounded-xl border border-border-strong bg-surface-raised p-1 shadow-2xl"
            >
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
                      : 'text-neutral-200 hover:bg-overlay/8 hover:text-neutral-50'
                  }`}
                >
                  {it.label}
                </button>
              ))}
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
// no tiene que descubrir los CHECK por un 400. Exportada para los tests (9.6).
export function problema(f: FormEstado): string | null {
  // R8 c4: la cuenta es obligatoria; el botón de guardar queda deshabilitado
  // hasta que el selector tenga un valor.
  if (!f.accountId) return 'Falta la cuenta de anuncios.';
  if (!esPresupuesto(f.action)) return null;
  const v = f.actionValue === '' ? null : Number(f.actionValue);
  if (v == null || v <= 0) return 'Falta el valor de la acción.';
  if (f.action === 'budget_increase' && f.budgetMax === '') return 'Falta el límite máximo (techo).';
  if (f.action === 'budget_decrease' && f.budgetMin === '') return 'Falta el límite mínimo (piso).';
  if (f.actionUnit === 'percent') {
    if (f.action === 'budget_increase' && v <= 100)
      return 'Un factor menor a 100 BAJA el presupuesto; para subir al doble va 200%.';
    if (f.action === 'budget_decrease' && v >= 100)
      return 'Para bajar a la mitad va 50%; 250% multiplica por 2,5.';
  }
  const max = f.budgetMax === '' ? null : Number(f.budgetMax);
  const min = f.budgetMin === '' ? null : Number(f.budgetMin);
  if (max != null && min != null && max < min)
    return `Con techo ${max} y piso ${min} no hay ningún valor que satisfaga los dos.`;
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

function payloadDeForm(f: FormEstado, id?: number): Record<string, unknown> {
  const ep = esPresupuesto(f.action);
  return {
    id,
    name: f.name.trim(),
    accountId: f.accountId,
    level: f.level,
    statusFilter: f.statusFilter,
    nameFilter: f.nameFilter.trim() || null,
    nameFilterMode: f.nameFilterMode,
    action: f.action,
    actionValue: ep ? (f.actionValue === '' ? null : Number(f.actionValue)) : null,
    actionUnit: ep ? f.actionUnit : null,
    budgetMax: ep ? (f.budgetMax === '' ? null : Number(f.budgetMax)) : null,
    budgetMin: ep ? (f.budgetMin === '' ? null : Number(f.budgetMin)) : null,
    period: f.period,
    everyMinutes: f.everyMinutes,
    windowStart: f.windowStart || null,
    windowEnd: f.windowEnd || null,
    maxRunsPerDay: f.maxRunsPerDay === '' ? null : Number(f.maxRunsPerDay),
    cooldownMinutes: f.cooldownMinutes,
    maxActionsPerObjectPerDay: f.maxActionsPerObjectPerDay,
    conditions: f.conditions.map((c) => ({ metric: c.metric, op: c.op, value: Number(c.value) })),
  };
}

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
  // El contenedor del formulario, para llevar la vista hasta él al abrirlo: con
  // dos cuentas y varias reglas, la Card del formulario queda a dos pantallas
  // de scroll y «Editar» parecía no hacer nada.
  const formRef = useRef<HTMLDivElement>(null);

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

  // Llevar la vista al formulario cuando se abre o cuando pasa de una regla a
  // otra. La Card del formulario se pinta DEBAJO de la lista, y con dos cuentas
  // cargadas queda a dos pantallas de scroll: «Editar» abría el editor fuera de
  // la vista y no había ninguna señal de que hubiera pasado algo.
  useEffect(() => {
    if (!nueva && !editando && !duplicando) return;
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [nueva, editando, duplicando]);

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
              : 'Las reglas marcadas como ACTIVA están cambiando estados y presupuestos en Meta de verdad.'}
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
        hint="El switch de modo sombra por fila y los dos interruptores globales de arriba son los cuatro controles del módulo: ninguno es una variable de entorno."
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
                        key: 'modo',
                        header: 'Modo',
                        render: (r) =>
                          r.dryRun ? <Badge tone="info">SOMBRA</Badge> : <Badge tone="warn">ACTIVA</Badge>,
                      },
                      {
                        key: 'nombre',
                        header: 'Nombre',
                        render: (r) => (
                          <span className="font-medium text-neutral-100">
                            {r.name}
                            {r.condiciones.length === 0 && (
                              <span className="ml-2">
                                <Badge tone="bad">sin condiciones: se aplica a todo</Badge>
                              </span>
                            )}
                          </span>
                        ),
                      },
                      { key: 'aplicado', header: 'Aplicado a', render: (r) => <span className="text-neutral-300">{aplicadoA(r, cuentas)}</span> },
                      { key: 'accion', header: 'Acción y condición', render: (r) => <span className="text-neutral-300">{accionDe(r)}</span> },
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
                              items={[
                                { label: 'Editar', onSelect: () => editar(r) },
                                { label: 'Duplicar', onSelect: () => duplicar(r) },
                                { label: 'Correr ahora (simulado)', onSelect: () => correrAhora(r) },
                                {
                                  label: r.dryRun ? 'Activar en real…' : 'Volver a modo sombra',
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

      {/* ── Formulario ── */}
      <div ref={formRef}>
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
            onCancel={cerrarFormulario}
            onSave={guardar}
          />
        )}
      </div>

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
                Activar en real
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

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl border border-border-subtle bg-surface p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <h2 className="mb-3 text-sm font-semibold text-neutral-100">{title}</h2>
        {children}
      </div>
    </div>
  );
}

// ─── Formulario de crear / editar ────────────────────────────────────────────

function FormularioRegla({
  cuentas,
  maxDailyBudgetEur,
  inicial,
  editId,
  onCancel,
  onSave,
}: {
  cuentas: CuentaAds[];
  maxDailyBudgetEur: number;
  inicial: FormEstado;
  editId?: number;
  onCancel: () => void;
  onSave: (payload: Record<string, unknown>, id?: number) => Promise<void>;
}): JSX.Element {
  const [f, setF] = useState<FormEstado>(inicial);
  const set = (p: Partial<FormEstado>) => setF((prev) => ({ ...prev, ...p }));

  const ep = esPresupuesto(f.action);
  const prob = problema(f);
  const preview = previewFactor(f);

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

  return (
    <Card title={editId ? `Editar regla #${editId}` : 'Nueva regla'} hint="Una regla nueva nace apagada y en modo simulación.">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Nombre de la regla
          <input className={inputCls} value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="Apagar - Gasto +$10" />
        </label>

        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Cuenta de anuncios
          <select className={inputCls} value={f.accountId} onChange={(e) => set({ accountId: e.target.value })}>
            <option value="">— elegí una cuenta —</option>
            {cuentas.map((c) => (
              <option key={c.accountId} value={c.accountId}>
                {c.name ?? c.accountId} — {c.timezone}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-neutral-600">La ventana horaria se evalúa en la zona de esta cuenta.</span>
        </label>

        <div className="grid grid-cols-2 gap-2">
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
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Filtrar por nombre
            <input className={inputCls} value={f.nameFilter} onChange={(e) => set({ nameFilter: e.target.value })} placeholder="PXN" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Modo
            <select className={inputCls} value={f.nameFilterMode} onChange={(e) => set({ nameFilterMode: e.target.value as 'contains' | 'not_contains' })}>
              <option value="contains">contiene</option>
              <option value="not_contains">no contiene</option>
            </select>
          </label>
        </div>

        <label className="flex flex-col gap-1 text-xs text-neutral-500">
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
        </label>

        {ep && (
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-xs text-neutral-500">
              {f.actionUnit === 'percent' ? 'Escalar al % del presupuesto actual' : f.action === 'budget_increase' ? 'Sumar € al presupuesto actual' : 'Restar € al presupuesto actual'}
              <input
                className={inputCls}
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
                <option value="fixed">sumar/restar €</option>
              </select>
            </label>
            {f.actionUnit === 'percent' && (
              <span className="col-span-2 text-[11px] text-neutral-400">
                El % es un factor, no un incremento: 250% = ×2,5. {preview || ''} Con 100% marcado como «sin cambio».
              </span>
            )}
          </div>
        )}

        {ep && (
          <>
            <label className="flex flex-col gap-1 text-xs text-neutral-500">
              Límite máximo de presupuesto{f.action === 'budget_increase' ? ' (obligatorio al subir)' : ''}
              <input
                className={inputCls}
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
                className={inputCls}
                inputMode="decimal"
                value={f.budgetMin}
                onChange={(e) => set({ budgetMin: e.target.value })}
                placeholder="5"
              />
            </label>
          </>
        )}

        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Nivel de las condiciones
          <select className={inputCls} value="object" disabled title="Las métricas del padre llegan en una versión próxima">
            <option value="object">del objeto</option>
          </select>
          <span className="text-[11px] text-neutral-600" title="'del padre' no está implementado: no se ofrece ni deshabilitado con la opción visible">
            Fijo en «del objeto»: las métricas del padre llegan en una versión próxima.
          </span>
        </label>

        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Período de cálculo
          <select className={inputCls} value={f.period} onChange={(e) => set({ period: e.target.value as PeriodoAds })}>
            <option value="today">hoy</option>
            <option value="yesterday">ayer</option>
            <option value="7d">7 días</option>
            <option value="7d_excl_today">7 días sin hoy</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Frecuencia
          <select className={inputCls} value={f.everyMinutes} onChange={(e) => set({ everyMinutes: Number(e.target.value) })}>
            {[1, 5, 15, 30, 60, 1440].map((m) => (
              <option key={m} value={m}>
                {frecuenciaLabel(m)}
              </option>
            ))}
          </select>
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Intervalo desde
            <input type="time" className={inputCls} value={f.windowStart} onChange={(e) => set({ windowStart: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Intervalo hasta
            <input type="time" className={inputCls} value={f.windowEnd} onChange={(e) => set({ windowEnd: e.target.value })} />
          </label>
          <span className="col-span-2 text-[11px] text-neutral-600">Vacío = a cualquier hora.</span>
        </div>

        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Límite de ejecuciones diarias
          <input className={inputCls} inputMode="numeric" value={f.maxRunsPerDay} onChange={(e) => set({ maxRunsPerDay: e.target.value })} placeholder="vacío = sin límite" />
        </label>

        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Cooldown por objeto (min)
          <input className={inputCls} inputMode="numeric" value={f.cooldownMinutes} onChange={(e) => set({ cooldownMinutes: Number(e.target.value) || 0 })} />
        </label>

        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Máx. acciones por objeto por día
          <input className={inputCls} inputMode="numeric" value={f.maxActionsPerObjectPerDay} onChange={(e) => set({ maxActionsPerObjectPerDay: Number(e.target.value) || 1 })} />
        </label>
      </div>

      {/* ── Condiciones: chips combinados con AND ── */}
      <div className="mt-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Condiciones</span>
          <button
            type="button"
            className={btnGhost}
            onClick={agregarCondicion}
            title="No hay OR: dos reglas separadas expresan lo mismo y se pueden prender y apagar por separado."
          >
            + agregar
          </button>
          <span className="text-[11px] text-neutral-600">Se combinan con Y (no hay OR).</span>
        </div>

        <p className="mb-2 text-[11px] leading-tight text-neutral-500">
          <strong className="text-neutral-400">ROI</strong> = neto ÷ gasto de ads. El neto ya tiene restadas las comisiones y el
          costo de producto. ROI 1,30 significa que el neto es 1,3 veces lo gastado en ads. <strong className="text-neutral-400">ROAS</strong> =
          ingresos brutos ÷ gasto, sin restar nada. El ROI de la sección Ventas se calcula distinto: no los compares.
        </p>

        {f.conditions.length === 0 ? (
          <p className="text-xs text-neutral-500">
            Sin condiciones, la regla se aplica a <strong className="text-bad-300">todos</strong> los objetos que pasan el filtro de alcance.
          </p>
        ) : (
          <div className="space-y-2">
            {f.conditions.map((c, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <select className={inputCls} value={c.metric} onChange={(e) => setCondicion(i, { metric: e.target.value as Condicion['metric'] })}>
                  {METRICAS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                      {METRICA_UNIDAD[m.value] === 'euro' ? ' (€)' : METRICA_UNIDAD[m.value] === 'numero' ? ' (múltiplo)' : ' (cantidad)'}
                    </option>
                  ))}
                </select>
                <select className={inputCls} value={c.op} onChange={(e) => setCondicion(i, { op: e.target.value as Condicion['op'] })}>
                  {['>', '>=', '<', '<=', '=', '!='].map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
                <input className={inputCls} inputMode="decimal" value={c.value} onChange={(e) => setCondicion(i, { value: e.target.value })} placeholder="1.3" />
                <button type="button" className={btnGhost} onClick={() => quitarCondicion(i)}>
                  quitar
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Validación y acciones ── */}
      {prob && (
        <Banner tone="warn" title="Revisá antes de guardar">
          {prob}
        </Banner>
      )}
      {f.action === 'budget_increase' && f.budgetMax !== '' && Number(f.budgetMax) > maxDailyBudgetEur && (
        <Banner tone="warn" title="El techo supera el máximo absoluto">
          El techo de {eur(Number(f.budgetMax))} está por encima del máximo absoluto por objeto ({eur(maxDailyBudgetEur)}): las
          subidas se van a cortar siempre en ese tope.
        </Banner>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          className={btnPrimary}
          disabled={!f.name.trim() || !f.accountId || prob !== null}
          onClick={() => onSave(payloadDeForm(f, editId), editId)}
        >
          {editId ? 'Guardar cambios' : 'Crear regla'}
        </button>
        <button type="button" className={btnGhost} onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </Card>
  );
}
