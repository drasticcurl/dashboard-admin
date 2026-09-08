'use client';

/**
 * FinanzasView — patrimonio, evolución mensual, movimientos y pagos
 * programados (plan FINANZAS §6).
 *
 * Recibe los datos iniciales del server y se maneja sola de ahí en adelante:
 * cada mutación llama al route correspondiente y después `router.refresh()`,
 * que re-ejecuta el server component de la página — así el patrimonio (que
 * no tiene endpoint propio) también queda al día sin recargar el browser.
 * Los `useEffect` de abajo sincronizan el estado local con las props frescas
 * que deja el refresh.
 *
 * Todo lo que se muestra ya viene calculado de getFinanceOverview() /
 * listMovements() / listScheduledPayments(): acá no se recalcula nada. Los
 * tipos entran con `import type` a propósito: un import de valor arrastraría
 * pg al bundle del browser.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  FinanceCategory,
  FinanceMovement,
  FinanceMovementKind,
  FinanceOverview,
  ScheduledPayment,
} from '@/lib/queries/finance';
import type {
  AccountWithBalance,
  FinanceAccount,
  PuntoDiario,
  PuntoMensual,
  SaldoOverview,
} from '@/lib/queries/saldo';
import { Badge, Banner, Card, IconButton, Spinner, Table, fmtDate, fmtMoney } from '@/components/ui';
import { inputCls, btnCls, btnPrimary, btnGhost } from '../config/kit';
import { formatearMontoParaInput, parsearMonto } from '@/lib/monto';
import { CargaDiaria } from './CargaDiaria';
import { CuentasSection } from './CuentasSection';
import { GraficoSaldo } from './GraficoSaldo';
import { Modal } from './Modal';
import { MONEDA_REPORTE } from '@/lib/moneda-reporte';
import { PanelInsight } from '@/components/PanelInsight';
import type { ReconciliacionMes } from '@/lib/queries/reconciliacion';
import type { InsightGuardado } from '@/lib/ia/insights';

// Este archivo ya NO importa recharts. El gráfico vive en GraficoSaldo.tsx, que
// además es el único que lo necesita: dejarlo acá arrastraba la librería a un
// componente de 600 líneas que casi nunca la usaba.

const CATEGORIES: FinanceCategory[] = ['sueldos', 'herramientas', 'alquiler', 'impuestos', 'otros'];

const KIND_LABEL: Record<FinanceMovementKind, string> = {
  gasto: 'Gasto',
  retiro: 'Retiro',
  ajuste: 'Ajuste',
  aporte: 'Aporte',
};

const KIND_TONE: Record<FinanceMovementKind, 'neutral' | 'info' | 'warn' | 'good'> = {
  gasto: 'neutral',
  retiro: 'info',
  ajuste: 'warn',
  // `good` porque es plata que ENTRA: es el único movimiento con signo positivo.
  aporte: 'good',
};

/**
 * Qué es cada tipo, en una línea, al lado del selector.
 *
 * El de `aporte` no es decorativo: es el único que cambia un número de la
 * pantalla de forma no obvia. La ganancia del mes se calcula como
 * `Δ patrimonio − retiros − aportes`, así que plata propia cargada como `ajuste`
 * en lugar de `aporte` infla la ganancia del mes sin que nada avise. Sin esta
 * ayuda nadie va a saber cuál elegir.
 */
const KIND_AYUDA: Record<FinanceMovementKind, string> = {
  gasto: 'plata que sale del negocio (sueldos, herramientas, alquiler…).',
  retiro: 'plata que sacás para vos. No cuenta como pérdida del negocio.',
  ajuste: 'una corrección a mano cuando algo no cierra. No afecta la ganancia.',
  aporte: 'plata que entra desde afuera del negocio; se descuenta de la ganancia del mes.',
};

async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; detail?: string };
  if (!res.ok) {
    // `detail` PRIMERO. Los routes ponen el motivo legible ("un gasto necesita
    // categoría") en detail y un código estable en error: leyendo sólo error, el
    // banner rojo le mostraba al usuario la palabra "invalid_payload" y todo el
    // trabajo de traducir los CHECK a español se perdía en esta línea.
    throw new Error(body.detail ?? body.error ?? `HTTP ${res.status}`);
  }
  return body;
}

type Flash = { tone: 'good' | 'bad'; text: string } | null;

/** Qué sección está abierta. `null` = sólo el patrimonio y el gráfico. */
type Vista = null | 'saldo' | 'movimientos' | 'pagos' | 'cuentas';

/**
 * Los cuatro accesos a las secciones que ya no están abiertas por defecto.
 *
 * El de «Cargar saldo de hoy» NO es un botón más y por eso se ve distinto:
 * cuando falta el saldo del día se pone amarillo y late. El motivo no es
 * decorativo — un día al que le falta una cuenta no tiene patrimonio, así que no
 * aparece en el gráfico y el número grande queda en "sin información". Olvidarse
 * no degrada el dato: lo borra. Y como el saldo se mide una vez por día, si no
 * se carga hoy ese día se pierde para siempre.
 *
 * Cuando ya está cargado, el mismo botón se apaga a neutro con un ✓: el color
 * pasa a ser la respuesta a "¿ya lo hice?", que es la pregunta que uno se hace
 * al entrar.
 *
 * Los contadores de los otros tres son la única forma de saber que hay algo
 * adentro sin abrirlos, ahora que no se ven. Y el de pagos atrasados va en rojo
 * porque reemplaza a un banner: si no lo mostrara acá, un pago atrasado dejaría
 * de avisar por completo.
 */
function Botonera({
  faltanHoy,
  atrasados,
  movimientos,
  cuentas,
  onAbrir,
}: {
  faltanHoy: string[];
  atrasados: number;
  movimientos: number;
  cuentas: number;
  onAbrir: (v: Vista) => void;
}): JSX.Element {
  const falta = faltanHoy.length > 0;

  const base =
    'press flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left text-sm font-medium transition-[background-color,border-color,box-shadow] duration-250';

  return (
    <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
      <button
        type="button"
        onClick={() => onAbrir('saldo')}
        // `animate-latido` sólo cuando falta. Se apaga sola con
        // prefers-reduced-motion (regla de @layer base): queda el amarillo sin
        // el movimiento, y el color dice lo mismo.
        className={
          falta
            ? `${base} animate-latido border-warn-500/40 bg-warn-500/10 text-warn-200 hover:bg-warn-500/20`
            : `${base} border-border-subtle bg-surface text-neutral-300 hover:bg-overlay/6 hover:text-neutral-100`
        }
      >
        <span className="flex flex-col gap-0.5">
          <span>{falta ? 'Cargar saldo de hoy' : 'Saldo de hoy cargado'}</span>
          <span className={`text-xs font-normal ${falta ? 'text-warn-300' : 'text-neutral-500'}`}>
            {falta
              ? faltanHoy.length === 1
                ? `falta ${faltanHoy[0]}`
                : `faltan ${faltanHoy.length} cuentas`
              : 'editar o cargar otro día'}
          </span>
        </span>
        <span aria-hidden className="shrink-0 text-base">
          {falta ? '!' : '✓'}
        </span>
      </button>

      <button
        type="button"
        onClick={() => onAbrir('movimientos')}
        className={`${base} border-border-subtle bg-surface text-neutral-300 hover:bg-overlay/6 hover:text-neutral-100`}
      >
        <span className="flex flex-col gap-0.5">
          <span>Movimientos</span>
          <span className="text-xs font-normal text-neutral-500">
            {movimientos === 0 ? 'ninguno todavía' : `${movimientos} cargado${movimientos === 1 ? '' : 's'}`}
          </span>
        </span>
      </button>

      <button
        type="button"
        onClick={() => onAbrir('pagos')}
        className={
          atrasados > 0
            ? `${base} border-bad-500/40 bg-bad-500/10 text-bad-200 hover:bg-bad-500/20`
            : `${base} border-border-subtle bg-surface text-neutral-300 hover:bg-overlay/6 hover:text-neutral-100`
        }
      >
        <span className="flex flex-col gap-0.5">
          <span>Pagos programados</span>
          <span className={`text-xs font-normal ${atrasados > 0 ? 'text-bad-300' : 'text-neutral-500'}`}>
            {atrasados > 0
              ? `${atrasados} atrasado${atrasados === 1 ? '' : 's'}`
              : 'al día'}
          </span>
        </span>
      </button>

      <button
        type="button"
        onClick={() => onAbrir('cuentas')}
        className={`${base} border-border-subtle bg-surface text-neutral-300 hover:bg-overlay/6 hover:text-neutral-100`}
      >
        <span className="flex flex-col gap-0.5">
          <span>Cuentas</span>
          <span className="text-xs font-normal text-neutral-500">
            {cuentas} {cuentas === 1 ? 'cuenta' : 'cuentas'}
          </span>
        </span>
      </button>
    </div>
  );
}



/**
 * El número grande de la pantalla: el patrimonio del último día COMPLETO.
 *
 * `patrimonioTotalEur` puede ser `null`, y eso NO se tapa con un 0. Un
 * patrimonio de cero es un dato real y dramático; "todavía no cargaste ningún día
 * completo" es otra cosa. Mostrar 0 en el segundo caso las vuelve
 * indistinguibles, y es exactamente el bug que el tipo `number | null` existe
 * para prevenir (plan SALDO D3, D5).
 *
 * Y va con la FECHA de la foto: un patrimonio sin fecha no significa nada. Si el
 * usuario no cargó en tres días, ver "9.300 EUR · al 25/08" es la diferencia
 * entre confiar en el número y confiar de más.
 */
function PatrimonioCard({ overview }: { overview: FinanceOverview }): JSX.Element {
  const total = overview.patrimonioTotalEur;

  if (total === null) {
    return (
      <div className="rounded-2xl border border-border-subtle bg-surface p-5 shadow-inset-highlight">
        <div className="truncate text-xs font-medium text-neutral-400">Patrimonio</div>
        <div className="mt-1.5 font-mono text-3xl font-semibold tracking-tight text-neutral-500">
          sin información
        </div>
        <div className="mt-1 text-xs text-neutral-500">
          Cargá el saldo de todas tus cuentas para tener la primera foto.
        </div>
      </div>
    );
  }

  const negativo = total < 0;
  const d = overview.desglose;

  return (
    <div
      className={`rounded-2xl border bg-surface p-5 shadow-inset-highlight ${
        negativo ? 'border-bad-500/20' : 'border-border-subtle'
      }`}
    >
      <div className="truncate text-xs font-medium text-neutral-400">Patrimonio</div>
      <div
        className={`mt-1.5 font-mono text-4xl font-semibold tabular-nums tracking-tight ${
          negativo ? 'text-bad-400' : 'text-neutral-50'
        }`}
      >
        {fmtMoney(total, MONEDA_REPORTE)}
      </div>
      <div className="mt-1 text-xs text-neutral-500">
        Medido{overview.diaPatrimonio ? ` al ${fmtDate(overview.diaPatrimonio)}` : ''} · el último día
        con todas las cuentas cargadas
      </div>

      {d && (
        // El desglose es la razón de ser de las cuentas: sin él, el total no dice
        // cuánto es plata disponible, cuánto está retenido y cuánto se debe.
        // `deudaEur` llega POSITIVO (es "cuánto debemos") y el − se pone acá,
        // nunca con Math.abs() sobre el total.
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 border-t border-border-subtle pt-3 text-xs">
          <span className="flex items-center gap-1.5">
            <span className="text-neutral-500">Disponible</span>
            <span className="font-mono tabular-nums text-neutral-200">
              {fmtMoney(d.dineroEur, MONEDA_REPORTE)}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-neutral-500">Retenido</span>
            <span className="font-mono tabular-nums text-neutral-300">
              {fmtMoney(d.retenidoEur, MONEDA_REPORTE)}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-neutral-500">Deuda</span>
            <span className="font-mono tabular-nums text-bad-300">
              −{fmtMoney(d.deudaEur, MONEDA_REPORTE)}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * La reconciliación mes a mes. Lo único que hay que leer es la columna "hueco".
 *
 * Los meses van del más NUEVO al más viejo (la query los devuelve al revés):
 * el mes que importa es el último y tiene que estar arriba, no al final de una
 * tabla de seis filas.
 *
 * Un hueco null NO se muestra como 0: se muestra como "—" con la explicación de
 * que a ese mes le falta un cierre completo. Es la misma regla que el resto del
 * módulo (`PatrimonioCard` hace lo mismo con un patrimonio sin medir), y acá
 * importa más que en ningún lado: un 0 en esta columna significa "cuadra
 * perfecto", que es lo contrario de "no se pudo medir".
 */
function TablaReconciliacion({ meses }: { meses: ReconciliacionMes[] }): JSX.Element {
  const filas = [...meses].reverse();

  return (
    <Table
      rows={filas}
      empty="Todavía no hay meses para reconciliar."
      columns={[
        {
          key: 'mes',
          header: 'Mes',
          render: (m) => <span className="font-mono tabular-nums text-neutral-300">{m.month}</span>,
        },
        {
          key: 'medida',
          header: 'Medida',
          align: 'right',
          render: (m) =>
            m.gananciaMedidaEur === null ? (
              <span title="Falta el cierre completo de este mes o del anterior" className="text-neutral-600">
                —
              </span>
            ) : (
              <span className="font-mono tabular-nums">
                {fmtMoney(m.gananciaMedidaEur, MONEDA_REPORTE)}
              </span>
            ),
        },
        {
          key: 'esperada',
          header: 'Esperada',
          align: 'right',
          render: (m) => (
            <span
              className="font-mono tabular-nums text-neutral-400"
              title={`ventas netas ${fmtMoney(m.netoEur, MONEDA_REPORTE)} − ads ${fmtMoney(
                m.adsEur,
                MONEDA_REPORTE,
              )} − gastos ${fmtMoney(m.gastosEur, MONEDA_REPORTE)}`}
            >
              {fmtMoney(m.esperadoEur, MONEDA_REPORTE)}
            </span>
          ),
        },
        {
          key: 'hueco',
          header: 'Hueco',
          align: 'right',
          render: (m) => <CeldaHueco mes={m} />,
        },
      ]}
    />
  );
}

/**
 * El hueco con su color. El umbral del 10 % existe para no pintar de rojo un
 * desfase de fechas: casi todos los meses tienen algo de hueco por una venta que
 * cruza el cierre, y si cualquier hueco se marcara en rojo la columna sería roja
 * siempre y dejaría de señalar nada.
 */
function CeldaHueco({ mes }: { mes: ReconciliacionMes }): JSX.Element {
  if (mes.huecoEur === null) {
    return (
      <span title="Sin cierre completo no hay con qué comparar" className="text-neutral-600">
        —
      </span>
    );
  }

  const grande = mes.huecoPct !== null && Math.abs(mes.huecoPct) > 0.1;
  return (
    <span
      className={`font-mono tabular-nums ${grande ? 'text-warn-400' : 'text-neutral-300'}`}
      title={
        mes.huecoPct === null
          ? 'Sin base para calcular el porcentaje'
          : `${(mes.huecoPct * 100).toFixed(1)} % sobre lo esperado`
      }
    >
      {mes.huecoEur > 0 ? '+' : ''}
      {fmtMoney(mes.huecoEur, MONEDA_REPORTE)}
    </span>
  );
}

export function FinanzasView({
  initialOverview,
  initialMovements,
  initialScheduledPayments,
  initialSaldo,
  initialDiario,
  initialMensual,
  initialCuentas,
  initialReconciliacion,
  initialInsight,
}: {
  initialOverview: FinanceOverview;
  initialMovements: FinanceMovement[];
  initialScheduledPayments: ScheduledPayment[];
  initialSaldo: SaldoOverview;
  initialDiario: PuntoDiario[];
  initialMensual: PuntoMensual[];
  initialCuentas: FinanceAccount[];
  initialReconciliacion: ReconciliacionMes[];
  initialInsight: InsightGuardado | null;
}): JSX.Element {
  const router = useRouter();

  const [overview, setOverview] = useState<FinanceOverview>(initialOverview);
  const [movements, setMovements] = useState<FinanceMovement[]>(initialMovements);
  const [scheduled, setScheduled] = useState<ScheduledPayment[]>(initialScheduledPayments);
  const [saldo, setSaldo] = useState<SaldoOverview>(initialSaldo);
  const [diario, setDiario] = useState<PuntoDiario[]>(initialDiario);
  const [mensual, setMensual] = useState<PuntoMensual[]>(initialMensual);
  const [cuentas, setCuentas] = useState<FinanceAccount[]>(initialCuentas);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash>(null);

  /**
   * Qué sección está abierta. `null` = la pantalla por defecto, que muestra sólo
   * el patrimonio y su gráfico.
   *
   * Antes las cuatro secciones estaban abiertas al mismo tiempo y la pantalla
   * medía más de 2000 px: para ver el gráfico había que scrollear por arriba de
   * un formulario de carga, y para cargar el saldo había que buscarlo entre dos
   * tablas. Lo que se mira todos los días y lo que se administra cada tanto
   * tenían el mismo peso visual.
   */
  const [vista, setVista] = useState<Vista>(null);

  // router.refresh() re-ejecuta la página y baja props frescas: estos efectos
  // son los que las adoptan sin perder el estado del componente.
  useEffect(() => setOverview(initialOverview), [initialOverview]);
  useEffect(() => setMovements(initialMovements), [initialMovements]);
  useEffect(() => setScheduled(initialScheduledPayments), [initialScheduledPayments]);
  useEffect(() => setSaldo(initialSaldo), [initialSaldo]);
  useEffect(() => setDiario(initialDiario), [initialDiario]);
  useEffect(() => setMensual(initialMensual), [initialMensual]);
  useEffect(() => setCuentas(initialCuentas), [initialCuentas]);

  const show = useCallback((tone: 'good' | 'bad', text: string) => setFlash({ tone, text }), []);

  // Al cerrar una sección se limpia el flash: el cartel de "Listo" de lo que se
  // hizo adentro del modal quedaría flotando sobre la pantalla del patrimonio
  // sin contexto de a qué se refería.
  const cerrarVista = useCallback(() => {
    setVista(null);
    setFlash(null);
  }, []);

  // El aviso de éxito se borra solo a los 6 s. El de error NO: si algo no se
  // guardó, el cartel se queda hasta que el usuario haga otra cosa.
  useEffect(() => {
    if (flash?.tone !== 'good') return;
    const t = setTimeout(() => setFlash(null), 6000);
    return () => clearTimeout(t);
  }, [flash]);

  async function conBusy(fn: () => Promise<void>): Promise<void> {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      show('bad', e instanceof Error ? e.message : 'Error de red');
    } finally {
      setBusy(false);
    }
  }

  // ─── Formulario de movimientos ────────────────────────────────────────────

  // El día arranca en HOY (en la TZ del panel, que la trae el server): antes
  // arrancaba vacío y, como el botón sólo se habilitaba con la fecha puesta y
  // nada decía que faltaba, parecía que el formulario estaba roto.
  const movFormVacio = {
    kind: 'gasto' as FinanceMovementKind,
    category: 'sueldos' as FinanceCategory,
    amount: '',
    note: '',
    day: initialOverview.hoy,
  };

  const [movForm, setMovForm] = useState(movFormVacio);
  const [ajusteNegativo, setAjusteNegativo] = useState(false);
  const [editMov, setEditMov] = useState<number | null>(null);

  /**
   * Qué le falta al formulario para poder guardarse, en palabras. Devuelve null
   * cuando está listo.
   *
   * Existe porque antes el botón "Cargar" se deshabilitaba con un booleano y no
   * había NADA que dijera por qué: con el monto escrito como "100,50" (la forma
   * normal de escribir plata en español) el botón quedaba gris para siempre y no
   * había forma de darse cuenta de qué pasaba.
   */
  function faltaEnMovimiento(): string | null {
    const monto = parsearMonto(movForm.amount);
    if (!monto.ok) return monto.error;
    if (movForm.note.trim().length === 0) return 'falta la nota: ¿en qué se fue?';
    if (movForm.day.length !== 10) return 'falta la fecha del movimiento';
    return null;
  }

  async function guardarMovimiento(): Promise<void> {
    // La validación va DENTRO de conBusy: antes tiraba una excepción desde acá,
    // fuera del try, así que el error terminaba como unhandled rejection en la
    // consola del browser en lugar de aparecer en pantalla.
    await conBusy(async () => {
      const monto = parsearMonto(movForm.amount);
      if (!monto.ok) throw new Error(monto.error);
      if (movForm.note.trim().length === 0) throw new Error('la nota no puede estar vacía');
      if (movForm.day.length !== 10) throw new Error('elegí la fecha del movimiento');

      // El backend espera el valor absoluto para gasto/retiro; para ajuste, el
      // signo lo pone el toggle +/− de la UI.
      const amountEur =
        movForm.kind === 'ajuste' ? (ajusteNegativo ? -monto.valor : monto.valor) : monto.valor;
      const body = {
        kind: movForm.kind,
        category: movForm.kind === 'gasto' ? movForm.category : null,
        amountEur,
        note: movForm.note.trim(),
        day: movForm.day,
      };

      if (editMov === null) {
        await api('/api/finanzas/movimientos', { method: 'POST', body: JSON.stringify(body) });
      } else {
        await api('/api/finanzas/movimientos', { method: 'PATCH', body: JSON.stringify({ id: editMov, ...body }) });
      }
      setEditMov(null);
      setMovForm(movFormVacio);
      setAjusteNegativo(false);
      show('good', editMov === null ? 'Movimiento cargado' : 'Movimiento actualizado');
      router.refresh();
    });
  }

  function editarMovimiento(m: FinanceMovement): void {
    setEditMov(m.id);
    setMovForm({
      kind: m.kind,
      category: m.category ?? 'sueldos',
      amount: formatearMontoParaInput(m.amountEur), // el form SIEMPRE pide el valor absoluto
      note: m.note,
      day: m.day,
    });
    setAjusteNegativo(m.kind === 'ajuste' && m.amountEur < 0);
  }

  async function borrarMovimiento(m: FinanceMovement): Promise<void> {
    if (!confirm(`Borrar el movimiento "${m.note}" por ${fmtMoney(m.amountEur, MONEDA_REPORTE)}?`)) return;
    await conBusy(async () => {
      await api(`/api/finanzas/movimientos?id=${m.id}`, { method: 'DELETE' });
      show('good', 'Movimiento borrado');
      router.refresh();
    });
  }

  // ─── Formulario de pagos programados ──────────────────────────────────────

  const [pagoForm, setPagoForm] = useState({ name: '', category: 'sueldos' as FinanceCategory, amount: '', dayOfMonth: 1 });
  const [editPago, setEditPago] = useState<number | null>(null);

  const pagoFormVacio = { name: '', category: 'sueldos' as FinanceCategory, amount: '', dayOfMonth: 1 };

  function faltaEnPago(): string | null {
    if (pagoForm.name.trim().length === 0) return 'falta el nombre del pago';
    const monto = parsearMonto(pagoForm.amount);
    if (!monto.ok) return monto.error;
    return null;
  }

  async function guardarPago(): Promise<void> {
    await conBusy(async () => {
      // Mismo motivo que en guardarMovimiento: validar acá adentro y no antes
      // del try, así el error se ve en pantalla.
      if (pagoForm.name.trim().length === 0) throw new Error('el nombre no puede estar vacío');
      const monto = parsearMonto(pagoForm.amount);
      if (!monto.ok) throw new Error(monto.error);

      const body = {
        name: pagoForm.name.trim(),
        category: pagoForm.category,
        amountEur: monto.valor,
        dayOfMonth: Number(pagoForm.dayOfMonth),
      };

      if (editPago === null) {
        await api('/api/finanzas/pagos-programados', { method: 'POST', body: JSON.stringify(body) });
      } else {
        await api('/api/finanzas/pagos-programados', { method: 'PATCH', body: JSON.stringify({ id: editPago, ...body }) });
      }
      setEditPago(null);
      setPagoForm(pagoFormVacio);
      show('good', editPago === null ? 'Pago programado cargado' : 'Pago programado actualizado');
      router.refresh();
    });
  }

  function editarPago(p: ScheduledPayment): void {
    setEditPago(p.id);
    setPagoForm({
      name: p.name,
      category: p.category,
      amount: formatearMontoParaInput(p.amountEur),
      dayOfMonth: p.dayOfMonth,
    });
  }

  async function togglePago(p: ScheduledPayment): Promise<void> {
    await conBusy(async () => {
      await api('/api/finanzas/pagos-programados', {
        method: 'PATCH',
        body: JSON.stringify({ id: p.id, active: !p.active }),
      });
      show('good', p.active ? 'Pago pausado' : 'Pago reactivado');
      router.refresh();
    });
  }

  async function borrarPago(p: ScheduledPayment): Promise<void> {
    if (!confirm(`Borrar el pago programado "${p.name}"? El historial de lo ya pagado se conserva.`)) return;
    await conBusy(async () => {
      await api(`/api/finanzas/pagos-programados?id=${p.id}`, { method: 'DELETE' });
      show('good', 'Pago programado borrado');
      router.refresh();
    });
  }

  async function ejecutarAhora(): Promise<void> {
    await conBusy(async () => {
      const res = await api<{ ejecutados: string[]; fallidos: { name: string; error: string }[] }>(
        '/api/finanzas/pagos-programados/ejecutar-ahora',
        { method: 'POST' },
      );
      router.refresh();

      // Los que fallaron ganan el cartel: un gasto que no se generó es plata
      // que falta en el patrimonio. Antes esto se descartaba y la pantalla
      // decía "No hay pagos atrasados para ejecutar" en verde.
      if (res.fallidos.length > 0) {
        const detalle = res.fallidos.map((f) => `${f.name} (${f.error})`).join('; ');
        const ok = res.ejecutados.length > 0 ? `Se generaron: ${res.ejecutados.join(', ')}. ` : '';
        throw new Error(`${ok}NO se pudo generar el gasto de: ${detalle}`);
      }

      show(
        'good',
        res.ejecutados.length > 0
          ? `Ejecutados: ${res.ejecutados.join(', ')}`
          : 'No hay pagos atrasados para ejecutar',
      );
    });
  }

  // ─── Derivados de render ──────────────────────────────────────────────────

  const [filtroKind, setFiltroKind] = useState<'todos' | FinanceMovementKind>('todos');
  const movsVisibles = filtroKind === 'todos' ? movements : movements.filter((m) => m.kind === filtroKind);
  const atrasados = overview.atrasados;

  // Lo que falta, para mostrarlo. El botón ya NO se deshabilita por esto: se
  // deshabilita sólo mientras hay un pedido en vuelo. Un botón gris sin motivo
  // es un callejón sin salida, y era el síntoma que se reportó.
  const faltaMov = faltaEnMovimiento();
  const faltaPago = faltaEnPago();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-neutral-50">Finanzas</h1>
          {busy && (
            <span className="flex items-center gap-2 text-xs text-neutral-500">
              <Spinner /> Guardando…
            </span>
          )}
        </div>
      </div>

      {flash && (
        <Banner tone={flash.tone} title={flash.tone === 'good' ? 'Listo' : 'No se pudo'}>
          {flash.text}
        </Banner>
      )}

      {/* El patrimonio: la suma de los saldos que el usuario MIDIÓ el último día
          completo, con el signo de cada tipo de cuenta (plan SALDO D1). Ya no se
          calcula desde daily_metrics ni se le suman los movimientos: un saldo
          tipeado ya incluye los gastos. */}
      <PatrimonioCard overview={overview} />

      <Botonera
        faltanHoy={overview.faltanCargarHoy}
        atrasados={atrasados.length}
        movimientos={movements.length}
        cuentas={cuentas.length}
        onAbrir={setVista}
      />

      {/* El gráfico. Es lo único, además del patrimonio, que se ve sin tocar
          nada: son las dos cosas que el usuario quiere de un vistazo. */}
      <GraficoSaldo diario={diario} mensual={mensual} />

      <div className="grid gap-4 lg:grid-cols-2">
        {/* La reconciliación NO depende de la IA y va primero: es el número, y el
            análisis de al lado es la lectura del número. Si el hueco no cierra, eso
            se ve acá aunque OPENAI_API_KEY no exista. */}
        <Card
          title="Ganancia medida vs. operación"
          hint="El patrimonio lo tipeás vos; las ventas y el gasto de ads entran solos. Son dos caminos independientes, así que el hueco entre ellos es lo que delata una venta o un gasto sin registrar. Un hueco chico que alterna de signo es timing (una venta de fin de mes que entra al banco el siguiente); uno que se repite del mismo lado es algo que falta."
        >
          <TablaReconciliacion meses={initialReconciliacion} />
        </Card>

        <Card title="Análisis con IA">
          <PanelInsight inicial={initialInsight} ambito="finanzas" />
        </Card>
      </div>

      {vista === 'saldo' && (
        <Modal
          titulo="Cargar los saldos del día"
          descripcion="Una vez al día: cuánto hay en cada cuenta. El patrimonio es la suma con el signo de cada tipo."
          onCerrar={cerrarVista}
        >
          <CargaDiaria
            cuentas={saldo.cuentas}
            hoy={saldo.hoyStr}
            onGuardado={() => router.refresh()}
          />
        </Modal>
      )}

      {vista === 'movimientos' && (
        <Modal
          titulo="Movimientos"
          descripcion="Gastos, retiros, ajustes y aportes. NO afectan al patrimonio: el saldo que cargás ya los incluye."
          ancho="lg"
          onCerrar={cerrarVista}
        >
          <div className="mb-3 flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-neutral-500">
              Tipo
              <select
                className={inputCls}
                value={filtroKind}
                onChange={(e) => setFiltroKind(e.target.value as 'todos' | FinanceMovementKind)}
              >
                <option value="todos">Todos</option>
                <option value="gasto">Gastos</option>
                <option value="retiro">Retiros</option>
                <option value="ajuste">Ajustes</option>
                <option value="aporte">Aportes</option>
              </select>
            </label>
          </div>
          <Table
            rows={movsVisibles}
            empty="Todavía no hay movimientos."
            columns={[
              { key: 'day', header: 'Fecha', render: (m) => <span className="whitespace-nowrap">{fmtDate(m.day)}</span> },
              {
                key: 'kind',
                header: 'Tipo',
                render: (m) => <Badge tone={KIND_TONE[m.kind]}>{KIND_LABEL[m.kind]}</Badge>,
              },
              {
                key: 'category',
                header: 'Categoría',
                render: (m) => <span className="text-neutral-400">{m.category ?? '—'}</span>,
              },
              { key: 'note', header: 'Nota', render: (m) => <span className="text-neutral-300">{m.note}</span> },
              // El monto lleva su signo REAL: un gasto se ve negativo. Nunca Math.abs en el render.
              {
                key: 'amount',
                header: 'Monto',
                align: 'right',
                render: (m) => (
                  <span className={m.amountEur < 0 ? 'text-bad-300' : 'text-good-300'}>
                    {fmtMoney(m.amountEur, MONEDA_REPORTE)}
                  </span>
                ),
              },
              {
                key: 'acciones',
                header: '',
                align: 'right',
                render: (m) => (
                  <span className="flex justify-end gap-1.5">
                    <button type="button" className={btnGhost} disabled={busy} onClick={() => editarMovimiento(m)}>
                      Editar
                    </button>
                    <IconButton label={`Borrar ${m.note}`} onClick={() => borrarMovimiento(m)} disabled={busy}>
                      <span aria-hidden>✕</span>
                    </IconButton>
                  </span>
                ),
              },
            ]}
          />

          <div className="mt-4 rounded-xl border border-border-subtle bg-overlay/2 p-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              {editMov === null ? 'Cargar movimiento' : 'Editar movimiento'}
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                Tipo
                <select
                  className={inputCls}
                  value={movForm.kind}
                  onChange={(e) => setMovForm({ ...movForm, kind: e.target.value as FinanceMovementKind })}
                >
                  <option value="gasto">Gasto</option>
                  <option value="retiro">Retiro</option>
                  <option value="ajuste">Ajuste</option>
                  <option value="aporte">Aporte</option>
                </select>
              </label>
              {/* Qué es cada tipo. El de `aporte` no es decorativo: es el único que
                  mueve un número de forma no obvia (la ganancia del mes lo
                  descuenta), así que sin esta línea nadie sabría cuándo usarlo en
                  vez de un ajuste — y elegir mal infla la ganancia sin avisar. */}
              <p className="text-xs text-neutral-500">{KIND_AYUDA[movForm.kind]}</p>
              {movForm.kind === 'gasto' ? (
                <label className="flex flex-col gap-1 text-xs text-neutral-500">
                  Categoría (obligatoria)
                  <select
                    className={inputCls}
                    value={movForm.category}
                    onChange={(e) => setMovForm({ ...movForm, category: e.target.value as FinanceCategory })}
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="flex flex-col gap-1 text-xs text-neutral-500">
                  Categoría
                  <p className="self-end pb-2 text-xs text-neutral-600">No aplica</p>
                </div>
              )}
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                Monto (EUR)
                <span className="flex items-center gap-1">
                  {movForm.kind === 'ajuste' ? (
                    <>
                      {/* El toggle +/− es solo del armado del payload: el campo
                          siempre se tipea en positivo y el signo se aplica al
                          mandar. */}
                      <button
                        type="button"
                        className={`${btnCls} ${ajusteNegativo ? 'bg-warn-500/15 text-warn-300' : 'border border-border-strong text-neutral-300'}`}
                        onClick={() => setAjusteNegativo(!ajusteNegativo)}
                        aria-pressed={ajusteNegativo}
                      >
                        {ajusteNegativo ? '−' : '+'}
                      </button>
                    </>
                  ) : null}
                  <input
                    className={inputCls}
                    inputMode="decimal"
                    placeholder="0.00"
                    value={movForm.amount}
                    onChange={(e) => setMovForm({ ...movForm, amount: e.target.value })}
                  />
                </span>
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                Nota
                <input
                  className={inputCls}
                  maxLength={200}
                  placeholder="¿En qué se fue?"
                  value={movForm.note}
                  onChange={(e) => setMovForm({ ...movForm, note: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                Día (el que corresponde al movimiento)
                <input
                  className={inputCls}
                  type="date"
                  value={movForm.day}
                  onChange={(e) => setMovForm({ ...movForm, day: e.target.value })}
                />
              </label>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" className={btnPrimary} disabled={busy} onClick={guardarMovimiento}>
                {editMov === null ? 'Cargar' : 'Guardar cambios'}
              </button>
              {editMov !== null && (
                <button
                  type="button"
                  className={btnGhost}
                  disabled={busy}
                  onClick={() => {
                    setEditMov(null);
                    setMovForm(movFormVacio);
                    setAjusteNegativo(false);
                  }}
                >
                  Cancelar
                </button>
              )}
              {/* El motivo, al lado del botón, mientras el formulario no está
                  listo. `aria-live` para que un lector de pantalla lo anuncie
                  cuando cambia sin que se recargue nada. */}
              {faltaMov !== null && movForm.amount.trim().length > 0 && (
                <span className="text-xs text-warn-300" aria-live="polite">
                  {faltaMov}
                </span>
              )}
            </div>
            <p className="mt-2 text-xs text-neutral-500">
              El monto se escribe con coma para los decimales: <span className="text-neutral-400">1234,56</span>.
            </p>
            {movForm.kind === 'ajuste' && (
              <p className="mt-2 text-xs text-neutral-500">
                El ajuste se carga con el signo del toggle (+/−) y puede ir en cualquier dirección.
              </p>
            )}
          </div>
        </Modal>
      )}

      {vista === 'pagos' && (
        <Modal
          titulo="Pagos programados"
          descripcion="La plantilla de un gasto recurrente mensual. Cada mes, el día indicado, el cron genera el gasto."
          ancho="lg"
          onCerrar={cerrarVista}
        >
          <div className="mb-3 flex justify-end">
            <button type="button" className={btnGhost} disabled={busy} onClick={ejecutarAhora}>
              Ejecutar pagos atrasados
            </button>
          </div>
          <Table
            rows={scheduled}
            empty="Todavía no hay pagos programados."
            columns={[
              { key: 'name', header: 'Nombre', render: (p) => <span className="text-neutral-200">{p.name}</span> },
              { key: 'category', header: 'Categoría', render: (p) => <Badge tone="neutral">{p.category}</Badge> },
              {
                key: 'amount',
                header: 'Monto',
                align: 'right',
                render: (p) => <span className="tabular-nums">{fmtMoney(p.amountEur, MONEDA_REPORTE)}</span>,
              },
              { key: 'day', header: 'Día del mes', align: 'right', render: (p) => <span className="tabular-nums">{p.dayOfMonth}</span> },
              {
                key: 'estado',
                header: 'Estado',
                render: (p) => (
                  <span className="flex items-center gap-1.5">
                    <Badge tone={p.active ? 'good' : 'neutral'}>{p.active ? 'Activo' : 'Pausado'}</Badge>
                    {p.atrasado && <Badge tone="warn">Atrasado</Badge>}
                  </span>
                ),
              },
              {
                key: 'acciones',
                header: '',
                align: 'right',
                render: (p) => (
                  <span className="flex justify-end gap-1.5">
                    <button type="button" className={btnGhost} disabled={busy} onClick={() => editarPago(p)}>
                      Editar
                    </button>
                    <button type="button" className={btnGhost} disabled={busy} onClick={() => togglePago(p)}>
                      {p.active ? 'Pausar' : 'Activar'}
                    </button>
                    <IconButton label={`Borrar ${p.name}`} onClick={() => borrarPago(p)} disabled={busy}>
                      <span aria-hidden>✕</span>
                    </IconButton>
                  </span>
                ),
              },
            ]}
          />

          <div className="mt-4 rounded-xl border border-border-subtle bg-overlay/2 p-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              {editPago === null ? 'Cargar pago programado' : 'Editar pago programado'}
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                Nombre
                <input
                  className={inputCls}
                  maxLength={80}
                  placeholder="Alquiler de la oficina"
                  value={pagoForm.name}
                  onChange={(e) => setPagoForm({ ...pagoForm, name: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                Categoría
                <select
                  className={inputCls}
                  value={pagoForm.category}
                  onChange={(e) => setPagoForm({ ...pagoForm, category: e.target.value as FinanceCategory })}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                Monto (EUR, siempre positivo)
                <input
                  className={inputCls}
                  inputMode="decimal"
                  placeholder="400"
                  value={pagoForm.amount}
                  onChange={(e) => setPagoForm({ ...pagoForm, amount: e.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                Día del mes (1-28)
                <select
                  className={inputCls}
                  value={pagoForm.dayOfMonth}
                  onChange={(e) => setPagoForm({ ...pagoForm, dayOfMonth: Number(e.target.value) })}
                >
                  {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" className={btnPrimary} disabled={busy} onClick={guardarPago}>
                {editPago === null ? 'Cargar' : 'Guardar cambios'}
              </button>
              {editPago !== null && (
                <button
                  type="button"
                  className={btnGhost}
                  disabled={busy}
                  onClick={() => {
                    setEditPago(null);
                    setPagoForm(pagoFormVacio);
                  }}
                >
                  Cancelar
                </button>
              )}
              {faltaPago !== null && pagoForm.amount.trim().length > 0 && (
                <span className="text-xs text-warn-300" aria-live="polite">
                  {faltaPago}
                </span>
              )}
            </div>
          </div>
        </Modal>
      )}

      {vista === 'cuentas' && (
        <Modal
          titulo="Cuentas"
          descripcion="Donde vive la plata. Cerrar una cuenta conserva su historial; borrarla lo reescribe."
          ancho="lg"
          onCerrar={cerrarVista}
        >
          <CuentasSection cuentas={cuentas} onCambio={() => router.refresh()} />
        </Modal>
      )}
    </div>
  );
}
