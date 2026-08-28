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
        {fmtMoney(total, 'EUR')}
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
              {fmtMoney(d.dineroEur, 'EUR')}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-neutral-500">Retenido</span>
            <span className="font-mono tabular-nums text-neutral-300">
              {fmtMoney(d.retenidoEur, 'EUR')}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-neutral-500">Deuda</span>
            <span className="font-mono tabular-nums text-bad-300">
              −{fmtMoney(d.deudaEur, 'EUR')}
            </span>
          </span>
        </div>
      )}
    </div>
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
}: {
  initialOverview: FinanceOverview;
  initialMovements: FinanceMovement[];
  initialScheduledPayments: ScheduledPayment[];
  initialSaldo: SaldoOverview;
  initialDiario: PuntoDiario[];
  initialMensual: PuntoMensual[];
  initialCuentas: FinanceAccount[];
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
    if (!confirm(`Borrar el movimiento "${m.note}" por ${fmtMoney(m.amountEur, 'EUR')}?`)) return;
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
        <button type="button" className={btnGhost} disabled={busy} onClick={ejecutarAhora}>
          Ejecutar pagos atrasados
        </button>
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

      {/* Falta cargar el saldo de hoy. Va ARRIBA del banner de pagos atrasados:
          por D5, olvidarse UNA cuenta hace perder el punto del día entero en el
          gráfico, así que es el aviso más urgente de la pantalla. Y nombra las
          cuentas en vez de decir "cargá el saldo", para que sea accionable. */}
      {overview.faltanCargarHoy.length > 0 && (
        <Banner
          tone="warn"
          title={`Falta cargar el saldo de hoy en ${overview.faltanCargarHoy.length} ${
            overview.faltanCargarHoy.length === 1 ? 'cuenta' : 'cuentas'
          }`}
        >
          {overview.faltanCargarHoy.join(', ')} — hasta que estén todas, el día de hoy no tiene
          patrimonio y no aparece en el gráfico.
        </Banner>
      )}

      {atrasados.length > 0 && (
        <Banner tone="warn" title={`${atrasados.length} pago${atrasados.length === 1 ? '' : 's'} programado${atrasados.length === 1 ? '' : 's'} atrasado${atrasados.length === 1 ? '' : 's'}`}>
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {atrasados.map((p) => p.name).join(', ')} — el día ya pasó y todavía no generó el gasto.
            </span>
            <button
              type="button"
              className={`${btnCls} border border-warn-500/30 bg-warn-500/10 text-warn-200 hover:bg-warn-500/20`}
              disabled={busy}
              onClick={ejecutarAhora}
            >
              Ejecutar ahora
            </button>
          </span>
        </Banner>
      )}

      {/* La carga diaria: UN formulario con una fila por cuenta y UN botón, que
          manda todas juntas (es una transacción). No cuatro formularios: por D5
          cargar 3 de 4 no le sirve de nada al usuario. */}
      <CargaDiaria cuentas={saldo.cuentas} hoy={saldo.hoyStr} onGuardado={() => router.refresh()} />

      {/* El gráfico nuevo. Reemplazó a un BarChart de dos barras apiladas (profit
          + movimientos) cuya altura NO era el neto, porque recharts apila los
          negativos hacia el otro lado en vez de restarlos: el neto sólo se veía
          en el tooltip. Ahora es una sola serie y el toggle cambia qué mide. */}
      <GraficoSaldo diario={diario} mensual={mensual} />

      <Card title="Movimientos" hint="Gastos, retiros, ajustes y aportes cargados a mano. El signo se muestra tal cual se guarda. NO afectan al patrimonio: el saldo que cargás ya los incluye.">
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
                  {fmtMoney(m.amountEur, 'EUR')}
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
      </Card>

      <Card title="Pagos programados" hint="La plantilla de un gasto recurrente mensual. Cada mes, el día indicado, el cron genera el gasto automáticamente.">
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
              render: (p) => <span className="tabular-nums">{fmtMoney(p.amountEur, 'EUR')}</span>,
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
      </Card>

      {/* Las cuentas van AL FINAL: es configuración, no algo que se mire todos
          los días. La acción principal de esta sección es CERRAR una cuenta, no
          borrarla — borrarla se lleva sus saldos en cascada y cambia el
          patrimonio de todos esos días hacia atrás (plan SALDO D10). */}
      <CuentasSection cuentas={cuentas} onCambio={() => router.refresh()} />
    </div>
  );
}
