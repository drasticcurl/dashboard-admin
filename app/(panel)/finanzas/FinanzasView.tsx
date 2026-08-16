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
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import { panelColors } from '@/tailwind.config';
import type {
  FinanceCategory,
  FinanceMovement,
  FinanceMovementKind,
  FinanceOverview,
  MonthlyPoint,
  ScheduledPayment,
} from '@/lib/queries/finance';
import { Badge, Banner, Card, ChartFrame, IconButton, Spinner, Table, fmtAxis, fmtDate, fmtMoney, fmtPct } from '@/components/ui';
import { inputCls, btnCls, btnPrimary, btnGhost } from '../config/kit';

const CATEGORIES: FinanceCategory[] = ['sueldos', 'herramientas', 'alquiler', 'impuestos', 'otros'];

const KIND_LABEL: Record<FinanceMovementKind, string> = {
  gasto: 'Gasto',
  retiro: 'Retiro',
  ajuste: 'Ajuste',
};

const KIND_TONE: Record<FinanceMovementKind, 'neutral' | 'info' | 'warn'> = {
  gasto: 'neutral',
  retiro: 'info',
  ajuste: 'warn',
};

async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return body;
}

function MovimientoTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; payload: MonthlyPoint }>;
}): JSX.Element | null {
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload;
  return (
    <div className="rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-xs shadow-xl">
      <p className="mb-1 font-semibold text-neutral-100">{p.month}</p>
      <p className="tabular-nums text-neutral-200">Neto: {fmtMoney(p.netEur, 'EUR')}</p>
      <p className="tabular-nums text-neutral-400">Profit: {fmtMoney(p.profitEur, 'EUR')}</p>
      <p className="tabular-nums text-neutral-400">Movimientos: {fmtMoney(p.movementsEur, 'EUR')}</p>
    </div>
  );
}

type Flash = { tone: 'good' | 'bad'; text: string } | null;

export function FinanzasView({
  initialOverview,
  initialMovements,
  initialScheduledPayments,
}: {
  initialOverview: FinanceOverview;
  initialMovements: FinanceMovement[];
  initialScheduledPayments: ScheduledPayment[];
}): JSX.Element {
  const router = useRouter();

  const [overview, setOverview] = useState<FinanceOverview>(initialOverview);
  const [movements, setMovements] = useState<FinanceMovement[]>(initialMovements);
  const [scheduled, setScheduled] = useState<ScheduledPayment[]>(initialScheduledPayments);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash>(null);

  // router.refresh() re-ejecuta la página y baja props frescas: estos tres
  // efectos son los que las adoptan sin perder el estado del componente.
  useEffect(() => setOverview(initialOverview), [initialOverview]);
  useEffect(() => setMovements(initialMovements), [initialMovements]);
  useEffect(() => setScheduled(initialScheduledPayments), [initialScheduledPayments]);

  const show = useCallback((tone: 'good' | 'bad', text: string) => setFlash({ tone, text }), []);

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

  const [movForm, setMovForm] = useState({
    kind: 'gasto' as FinanceMovementKind,
    category: 'sueldos' as FinanceCategory,
    amount: '',
    note: '',
    day: '',
  });
  const [ajusteNegativo, setAjusteNegativo] = useState(false);
  const [editMov, setEditMov] = useState<number | null>(null);

  const movFormVacio = { kind: 'gasto' as const, category: 'sueldos' as FinanceCategory, amount: '', note: '', day: '' };

  function armarMontoAbs(): number {
    const n = Number(movForm.amount);
    if (!Number.isFinite(n) || n <= 0) throw new Error('el monto tiene que ser mayor que cero');
    return n;
  }

  async function guardarMovimiento(): Promise<void> {
    const amountAbs = armarMontoAbs();
    // El backend espera el valor absoluto para gasto/retiro; para ajuste, el
    // signo lo pone el toggle +/− de la UI.
    const amountEur = movForm.kind === 'ajuste' ? (ajusteNegativo ? -amountAbs : amountAbs) : amountAbs;
    const body = {
      kind: movForm.kind,
      category: movForm.kind === 'gasto' ? movForm.category : null,
      amountEur,
      note: movForm.note.trim(),
      day: movForm.day,
    };
    await conBusy(async () => {
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
      amount: String(Math.abs(m.amountEur)), // el form SIEMPRE pide el valor absoluto
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

  async function guardarPago(): Promise<void> {
    const amountEur = Number(pagoForm.amount);
    if (!Number.isFinite(amountEur) || amountEur <= 0) throw new Error('el monto tiene que ser mayor que cero');
    const body = {
      name: pagoForm.name.trim(),
      category: pagoForm.category,
      amountEur,
      dayOfMonth: Number(pagoForm.dayOfMonth),
    };
    await conBusy(async () => {
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
    setPagoForm({ name: p.name, category: p.category, amount: String(p.amountEur), dayOfMonth: p.dayOfMonth });
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
      const res = await api<{ ejecutados: string[] }>('/api/finanzas/pagos-programados/ejecutar-ahora', {
        method: 'POST',
      });
      show(
        'good',
        res.ejecutados.length > 0
          ? `Ejecutados: ${res.ejecutados.join(', ')}`
          : 'No hay pagos atrasados para ejecutar',
      );
      router.refresh();
    });
  }

  // ─── Derivados de render ──────────────────────────────────────────────────

  const [filtroKind, setFiltroKind] = useState<'todos' | FinanceMovementKind>('todos');
  const movsVisibles = filtroKind === 'todos' ? movements : movements.filter((m) => m.kind === filtroKind);
  const atrasados = overview.atrasados;

  const montoValido =
    Number.isFinite(Number(movForm.amount)) &&
    Number(movForm.amount) > 0 &&
    (movForm.kind !== 'gasto' || movForm.category !== null) &&
    movForm.note.trim().length > 0 &&
    movForm.day.length === 10;

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

      {/* El patrimonio: SUM(finance_daily_profit) + SUM(finance_movements), todo el histórico (D1). */}
      <div
        className={`rounded-2xl border bg-surface p-5 shadow-inset-highlight ${
          overview.patrimonioTotalEur < 0 ? 'border-bad-500/20' : 'border-border-subtle'
        }`}
      >
        <div className="truncate text-xs font-medium text-neutral-400">Patrimonio total</div>
        <div
          className={`mt-1.5 font-mono text-4xl font-semibold tabular-nums tracking-tight ${
            overview.patrimonioTotalEur < 0 ? 'text-bad-400' : 'text-neutral-50'
          }`}
        >
          {fmtMoney(overview.patrimonioTotalEur, 'EUR')}
        </div>
        <div className="mt-1 text-xs text-neutral-500">Todo el histórico · profit diario + movimientos</div>
      </div>

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

      <Card title="Evolución mensual" hint="Los últimos 12 meses, siempre continuos — un mes sin datos aparece en 0.">
        <ChartFrame alto="sm">
          <BarChart data={overview.byMonth} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis
              dataKey="month"
              tickFormatter={(v: string) => `${v.slice(5, 7)}/${v.slice(2, 4)}`}
              tick={{ fontSize: 11, fill: panelColors.axis }}
              tickLine={false}
              axisLine={{ stroke: 'rgba(255,255,255,0.12)' }}
              minTickGap={16}
            />
            <YAxis
              tickFormatter={fmtAxis}
              tick={{ fontSize: 11, fill: panelColors.axis }}
              tickLine={false}
              axisLine={false}
              width={56}
            />
            <Tooltip content={<MovimientoTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
            {/* Las dos barras apiladas suman el neto del mes: profit (lo que
                generó el negocio) + movimientos (gastos, retiros y ajustes,
                normalmente en negativo). */}
            <Bar dataKey="profitEur" name="Profit" stackId="mes" fill={panelColors.good} radius={[2, 2, 0, 0]} />
            <Bar dataKey="movementsEur" name="Movimientos" stackId="mes" fill={panelColors.warn} />
          </BarChart>
        </ChartFrame>
      </Card>

      <Card title="Movimientos" hint="Gastos, retiros y ajustes cargados a mano. El signo se muestra tal cual se guarda.">
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
              </select>
            </label>
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
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className={btnPrimary}
              disabled={busy || !montoValido}
              onClick={guardarMovimiento}
            >
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
          </div>
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
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className={btnPrimary}
              disabled={busy || pagoForm.name.trim().length === 0 || !(Number(pagoForm.amount) > 0)}
              onClick={guardarPago}
            >
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
          </div>
        </div>
      </Card>
    </div>
  );
}
