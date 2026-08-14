'use client';

/**
 * AnunciosView — la tabla del gestor de anuncios (T17 §6).
 *
 * Recibe los datos iniciales del server y refetchea /api/data/ads cuando cambian
 * los filtros (query string), sin navegar. Los dos controles que ESCRIBEN (el
 * toggle de estado y el presupuesto editable) viven acá y no en components/ui.tsx
 * (D-A19, cuatro tasks lo importan).
 *
 * Dos reglas de plata:
 *  - El toggle es optimista pero REVIERTE si el POST falla: un toggle que se
 *    queda en la posición nueva después de fallar es una mentira sobre algo que
 *    está gastando.
 *  - `null` se dibuja como `—`, nunca `0,00`: un objeto sin gasto no tiene ROI,
 *    y mostrar 0,00 hace creer que se pierde plata cuando no se gastó nada.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft } from '@phosphor-icons/react';
import type { FrescuraAds } from '@/lib/ads/live';
import type { MetricasObjeto, NivelAds, ResultadoMetricas } from '@/lib/ads/tipos';
import type { CuentaAds } from './page';
import { SubNav } from './SubNav';
import {
  Badge,
  Banner,
  Card,
  Column,
  EmptyState,
  Skeleton,
  StatCard,
  Table,
  fmtDateTime,
  fmtInt,
  fmtMoney,
  type Tone,
} from '@/components/ui';

type Respuesta = ResultadoMetricas & {
  adsFreshness?: FrescuraAds;
  maxDailyBudgetEur?: number;
  maxDeltaPorTickEur?: number;
};

type Filtros = {
  level: NivelAds;
  period: 'today' | 'yesterday' | '7d' | '7d_excl_today';
  status: 'active' | 'paused' | 'any';
  account: string;
  nombre?: string;
  campaignId?: string;
  adsetId?: string;
  /**
   * Cursor de paginación: el último `objectId` de la página anterior. El SQL lo
   * usa (`objectId > after` con `ORDER BY objectId`), pero antes ni el refetch
   * ni el server lo leían, así que "Cargar más" escribía `?after=` en la URL y
   * no pasaba nada.
   */
  after?: string;
};

const NIVEL_LABEL: Record<NivelAds, string> = {
  campaign: 'Campaña',
  adset: 'Conjunto',
  ad: 'Anuncio',
};

// Estados que Meta muestra pero que no se pueden escribir: no son toggleables.
const NO_TOGGLEABLE = new Set(['ARCHIVED', 'DELETED', 'DISAPPROVED', 'WITH_ISSUES', 'PENDING_REVIEW', 'IN_PROCESS']);

function ratio(n: number | null): string {
  return n === null ? '—' : n.toFixed(2);
}

function money(n: number): string {
  return fmtMoney(n, 'EUR');
}

function nullMoney(n: number | null): string {
  return n === null ? '—' : money(n);
}

export function AnunciosView({
  cuentas,
  initialData,
  adsFreshness,
  filtros,
  breadcrumb,
  desalineada,
}: {
  cuentas: CuentaAds[];
  initialData: ResultadoMetricas;
  adsFreshness: FrescuraAds;
  filtros: Filtros;
  breadcrumb: { nivel: NivelAds; id: string; name: string | null } | null;
  /**
   * No null cuando la cuenta que se está viendo no es la del funnel elegido en
   * el Nav. Sin este aviso los números parecen ser del funnel de arriba y no
   * hay nada en pantalla que diga lo contrario.
   */
  desalineada: { funnelSlug: string; cuentaFunnel: string | null } | null;
}): JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [data, setData] = useState<Respuesta>(initialData);
  const [frescura, setFrescura] = useState<FrescuraAds>(adsFreshness);
  const [maxPresupuesto, setMaxPresupuesto] = useState<number>(200);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [seleccionados, setSeleccionados] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmacion, setConfirmacion] = useState<{
    accion: 'pause' | 'activate' | 'budget_set';
    ids: string[];
    budgetEur?: number;
  } | null>(null);

  // Presupuesto en edición por fila: { [objectId]: string } (texto del input).
  const [editPresupuesto, setEditPresupuesto] = useState<Record<string, string>>({});

  const firstRun = useRef(true);

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    params.set('level', filtros.level);
    params.set('period', filtros.period);
    params.set('status', filtros.status);
    params.set('account', filtros.account);
    if (filtros.nombre) params.set('nombre', filtros.nombre);
    if (filtros.campaignId) params.set('campaignId', filtros.campaignId);
    if (filtros.adsetId) params.set('adsetId', filtros.adsetId);
    if (filtros.after) params.set('after', filtros.after);

    fetch(`/api/data/ads?${params.toString()}`, { signal: ctrl.signal, cache: 'no-store' })
      .then(async (res) => {
        const body = (await res.json()) as Respuesta & { ok: boolean; error?: string };
        if (!res.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${res.status}`);
        return body;
      })
      .then((body) => {
        setData(body);
        if (body.adsFreshness) setFrescura(body.adsFreshness);
        if (typeof body.maxDailyBudgetEur === 'number') setMaxPresupuesto(body.maxDailyBudgetEur);
        setSeleccionados(new Set());
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Error de red');
      })
      .finally(() => setLoading(false));

    return () => ctrl.abort();
  }, [filtros.level, filtros.period, filtros.status, filtros.account, filtros.nombre, filtros.campaignId, filtros.adsetId, filtros.after, retryTick]);

  // ─── Filtros → query string (preservando el resto) ────────────────────────
  const cambiarFiltro = (cambios: Partial<Filtros>): void => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(cambios)) {
      if (v === undefined || v === null || v === '') params.delete(k);
      else params.set(k, String(v));
    }
    // Bajar de nivel resetea el id del padre del nivel anterior.
    if (cambios.level && cambios.level === 'campaign') {
      params.delete('campaignId');
      params.delete('adsetId');
    }
    if (cambios.level && cambios.level === 'adset') params.delete('adsetId');
    router.replace(`/anuncios?${params.toString()}`, { scroll: false });
  };

  const filas = data.filas;
  const totGasto = filas.reduce((a, r) => a + r.spendEur, 0);
  const totIngresos = filas.reduce((a, r) => a + r.revenueEur, 0);
  const totGanancia = filas.reduce((a, r) => a + r.profitEur, 0);
  const totNeto = filas.reduce((a, r) => a + r.netEur, 0);
  const totRoi = totGasto > 0 ? totNeto / totGasto : null;

  const sinAtribuirPct = data.sinAtribuir.sales > 0
    ? data.sinAtribuir.sales / Math.max(1, data.sinAtribuir.sales + filas.reduce((a, r) => a + r.sales, 0))
    : 0;

  const edadAds = ((): string | null => {
    if (frescura.error) return 'sync con error';
    const s = frescura.ageSeconds;
    if (s === null) return 'nunca sincronizado';
    if (s < 90) return 'al día';
    if (s < 3600) return `hace ${Math.round(s / 60)} min`;
    return `hace ${Math.round(s / 3600)} h`;
  })();

  // ─── Acciones sobre objetos ───────────────────────────────────────────────
  const toggleEstado = async (fila: MetricasObjeto): Promise<void> => {
    const destino = fila.status === 'PAUSED' ? 'activate' : 'pause';
    setActionError(null);
    setData((prev) => ({
      ...prev,
      filas: prev.filas.map((r) =>
        r.objectId === fila.objectId ? { ...r, status: destino === 'pause' ? 'PAUSED' : 'ACTIVE' } : r,
      ),
    }));
    try {
      const res = await fetch('/api/ads/acciones', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level: fila.level, action: destino, objectIds: [fila.objectId] }),
      });
      const body = (await res.json()) as { ok: boolean; resultados?: { ok: boolean; error: string | null }[] };
      if (!res.ok || body.ok === false || body.resultados?.[0]?.ok === false) {
        throw new Error(body.resultados?.[0]?.error ?? `HTTP ${res.status}`);
      }
      setRetryTick((x) => x + 1);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
      setRetryTick((x) => x + 1); // revertir a lo que hay en el server
    }
  };

  const enviarLote = async (accion: 'pause' | 'activate' | 'budget_set', ids: string[], budgetEur?: number): Promise<void> => {
    setActionError(null);
    try {
      const res = await fetch('/api/ads/acciones', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level: filtros.level, action: accion, objectIds: ids, budgetEur }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string; detail?: string; aplicados?: number; total?: number; resultados?: { objectId: string; ok: boolean; error: string | null }[] };
      if (!res.ok || body.ok === false) {
        throw new Error(body.detail ?? body.error ?? `HTTP ${res.status}`);
      }
      if (body.aplicados !== body.total) {
        const fallidos = (body.resultados ?? []).filter((r) => !r.ok);
        setActionError(
          `${body.aplicados} de ${body.total} aplicados. No salieron: ${fallidos.slice(0, 5).map((f) => `${f.objectId} (${f.error})`).join(' · ')}`,
        );
      }
      setConfirmacion(null);
      setSeleccionados(new Set());
      setRetryTick((x) => x + 1);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  const todosSeleccionados = filas.length > 0 && filas.every((f) => seleccionados.has(f.objectId));
  const toggleSeleccion = (id: string): void => {
    setSeleccionados((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ─── Columnas ─────────────────────────────────────────────────────────────
  const columns: Column<MetricasObjeto>[] = [
    {
      key: 'sel',
      header: 'Seleccionar',
      render: (f) => (
        <input
          type="checkbox"
          checked={seleccionados.has(f.objectId)}
          onChange={() => toggleSeleccion(f.objectId)}
          aria-label={`Seleccionar ${f.objectName ?? f.objectId}`}
          className="h-4 w-4 rounded border-overlay/20 bg-overlay/4 accent-good-500"
        />
      ),
    },
    {
      key: 'estado',
      header: 'Estado',
      render: (f) => <ToggleEstado fila={f} onToggle={toggleEstado} />,
    },
    {
      key: 'nombre',
      header: NIVEL_LABEL[filtros.level].toUpperCase(),
      render: (f) => (
        <span className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => bajarNivel(f)}
            className="max-w-72 truncate text-left text-neutral-200 underline-offset-2 hover:underline focus:outline-none focus:ring-2 focus:ring-good-500/50"
            title={f.objectName ?? undefined}
          >
            {f.objectName ?? '(sin nombre)'}
          </button>
          {f.effectiveStatus && f.effectiveStatus !== f.status && (
            <Badge tone="warn" >{etiquetaEffective(f.effectiveStatus)}</Badge>
          )}
        </span>
      ),
    },
    {
      key: 'presupuesto',
      header: 'Presupuesto',
      align: 'right',
      render: (f) => <PresupuestoCelda fila={f} edit={editPresupuesto[f.objectId]} onEdit={(v) => setEditPresupuesto((p) => ({ ...p, [f.objectId]: v }))} onConfirm={(eur) => confirmarPresupuesto(f, eur)} />,
    },
    {
      key: 'ultima',
      header: 'Últ. actualización',
      render: (f) => (f.ultimaAccionAt ? <span className="whitespace-nowrap text-neutral-400">{fmtDateTime(f.ultimaAccionAt)}</span> : <span className="text-neutral-600">—</span>),
    },
    { key: 'ventas', header: 'Ventas', align: 'right', render: (f) => fmtInt(f.sales) },
    { key: 'cpa', header: 'CPA', align: 'right', render: (f) => (f.cpaEur === null ? '—' : money(f.cpaEur)) },
    { key: 'gastos', header: 'Gastos', align: 'right', render: (f) => money(f.spendEur) },
    { key: 'ingresos', header: 'Ingresos', align: 'right', render: (f) => money(f.revenueEur) },
    {
      key: 'ganancia',
      header: 'Ganancia',
      align: 'right',
      render: (f) => (
        <span className={f.profitEur < 0 ? 'text-rose-400' : 'text-good-400'}>
          {f.profitEur < 0 ? '−' : ''}{money(Math.abs(f.profitEur))}
        </span>
      ),
    },
    {
      key: 'roas',
      header: 'ROAS',
      align: 'right',
      render: (f) => <RatioTone v={f.roas} umbral={1} />,
    },
    {
      key: 'roi',
      header: 'ROI',
      align: 'right',
      render: (f) => <RatioTone v={f.roi} umbral={1} />,
    },
  ];

  function bajarNivel(f: MetricasObjeto): void {
    if (f.level === 'campaign') cambiarFiltro({ level: 'adset', campaignId: f.objectId });
    else if (f.level === 'adset') cambiarFiltro({ level: 'ad', campaignId: f.campaignId, adsetId: f.objectId });
  }

  function confirmarPresupuesto(f: MetricasObjeto, eur: number): void {
    setConfirmacion({ accion: 'budget_set', ids: [f.objectId], budgetEur: eur });
  }

  // Pedir un lote: arma la confirmación y deja que el diálogo la ejecute.
  const pedirLote = (accion: 'pause' | 'activate' | 'budget_set', budgetEur?: number): void => {
    if (accion === 'budget_set' && budgetEur === undefined) {
      const v = window.prompt('Nuevo presupuesto en EUR (para todos):');
      const n = Number(v);
      if (!v || !Number.isFinite(n) || n <= 0) return;
      budgetEur = n;
    }
    setConfirmacion({ accion, ids: Array.from(seleccionados), budgetEur });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-neutral-50">Anuncios</h1>
          <Badge tone="info">{NIVEL_LABEL[filtros.level]}s</Badge>
          {loading && <span className="text-xs text-neutral-500">Actualizando…</span>}
        </div>
        <SubNav />
      </div>

      {(error || actionError) && (
        <Banner tone="bad" title="No se pudo completar">
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {error && (
              <span>
                No se pudieron cargar los anuncios: {error}
                <button
                  type="button"
                  onClick={() => setRetryTick((x) => x + 1)}
                  className="ml-3 rounded-md border border-border-strong px-2 py-1 font-semibold text-neutral-200 hover:bg-overlay/6"
                >
                  Reintentar
                </button>
              </span>
            )}
            {actionError && <span>La acción no se completó: {actionError}</span>}
          </span>
        </Banner>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-400">
        {breadcrumb && (
          <button type="button" onClick={() => (breadcrumb.nivel === 'campaign' ? cambiarFiltro({ level: 'campaign' }) : cambiarFiltro({ level: 'adset', campaignId: filtros.campaignId }))} className="flex items-center gap-1 rounded-md border border-border-strong px-2 py-1 text-neutral-300 hover:bg-overlay/6">
            <ArrowLeft size={13} weight="bold" /> volver a {breadcrumb.name ?? 'arriba'}
          </button>
        )}
        <span>hoy en <span className="text-neutral-200">{data.rango.timezone}</span></span>
        {edadAds && <span>· gasto {edadAds}</span>}
        {frescura.error && <span className="text-amber-400">({frescura.error})</span>}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Gasto" value={money(totGasto)} sub={edadAds ?? undefined} tone="warn" />
        <StatCard label="Ingresos" value={money(totIngresos)} sub="bruto aprobado" />
        <StatCard label="Ganancia" value={money(totGanancia)} sub="neto − gasto" tone={totGanancia < 0 ? 'bad' : 'good'} />
        <StatCard label="ROI" value={totRoi === null ? '—' : `${totRoi.toFixed(2)}×`} sub="neto ÷ gasto de ads" tone={totRoi === null ? 'neutral' : totRoi < 1 ? 'bad' : totRoi < 2 ? 'warn' : 'good'} />
      </div>

      {data.sinAtribuir.sales > 0 && (
        <Banner tone={sinAtribuirPct > 0.2 ? 'warn' : 'info'} title="Ventas sin atribuir a un anuncio">
          {fmtInt(data.sinAtribuir.sales)} ventas ({money(data.sinAtribuir.revenueEur)}) entraron en el período pero sus UTMs no
          matchean ningún {NIVEL_LABEL[filtros.level].toLowerCase()}. Es plata real que esta tabla no explica.
        </Banner>
      )}

      <FiltrosBar
        cuentas={cuentas}
        filtros={filtros}
        onChange={cambiarFiltro}
        seleccionados={Array.from(seleccionados)}
        onPedirLote={pedirLote}
      />

      {desalineada && (
        <Banner tone="warn" title="La cuenta que ves no es la del funnel elegido arriba">
          {desalineada.cuentaFunnel
            ? `Arriba está elegido "${desalineada.funnelSlug}", pero esta cuenta se imputa a "${desalineada.cuentaFunnel}". Cambiá la cuenta en los filtros, o el funnel arriba.`
            : `Arriba está elegido "${desalineada.funnelSlug}" y esta cuenta no tiene funnel imputado. Asignáselo en Config → Publicidad y el selector de arriba la va a elegir sola.`}
        </Banner>
      )}

      <Card title={NIVEL_LABEL[filtros.level]} hint={filas.length > 0 ? `viendo ${filas.length} fila(s)` : undefined}>
        {loading && filas.length === 0 ? (
          <Skeleton variant="table" rows={8} />
        ) : filas.length === 0 ? (
          <EmptyState
            title={`Sin ${NIVEL_LABEL[filtros.level].toLowerCase()}s en el rango`}
            hint="Probá otro período, otro estado u otra cuenta en los filtros de arriba."
          />
        ) : (
          <Table rows={filas} columns={columns} />
        )}
        {/*
          Paginación por cursor. Avanza de página, NO agrega al final: el SQL
          filtra `objectId > after` con `ORDER BY objectId`, así que la tabla se
          reemplaza. El texto lo dice para que nadie espere una lista que crece,
          y aparece "Volver al principio" porque sin eso no hay forma de
          retroceder salvo editar la URL.
        */}
        {(data.hayMas || filtros.after) && (
          <div className="mt-3 flex items-center justify-center gap-2">
            {filtros.after && (
              <button
                type="button"
                onClick={() => cambiarFiltro({ after: undefined })}
                className="rounded-md border border-border-strong px-3 py-1.5 text-sm text-neutral-300 transition-colors hover:bg-overlay/6"
              >
                Volver al principio
              </button>
            )}
            {data.hayMas && (
              <button
                type="button"
                onClick={() => {
                  const last = filas[filas.length - 1];
                  if (last) cambiarFiltro({ after: last.objectId });
                }}
                className="rounded-md border border-border-strong px-3 py-1.5 text-sm text-neutral-200 transition-colors hover:bg-overlay/6"
              >
                Página siguiente
              </button>
            )}
          </div>
        )}
      </Card>

      {confirmacion && (
        <DialogoConfirmacion
          accion={confirmacion.accion}
          nombres={filas.filter((f) => confirmacion.ids.includes(f.objectId)).map((f) => f.objectName ?? f.objectId)}
          presupuestoViejo={confirmacion.budgetEur !== undefined ? filas.find((f) => confirmacion.ids.includes(f.objectId))?.dailyBudgetEur ?? null : null}
          presupuestoNuevo={confirmacion.budgetEur}
          onCancel={() => setConfirmacion(null)}
          onConfirm={() => enviarLote(confirmacion.accion, confirmacion.ids, confirmacion.budgetEur)}
        />
      )}
    </div>
  );
}

// ─── Piezas ─────────────────────────────────────────────────────────────────

function etiquetaEffective(s: string): string {
  const map: Record<string, string> = {
    CAMPAIGN_PAUSED: 'campaña pausada',
    ADSET_PAUSED: 'conjunto pausado',
    WITH_ISSUES: 'con problemas',
    DISAPPROVED: 'rechazado',
    PENDING_REVIEW: 'en revisión',
    IN_PROCESS: 'procesando',
    PENDING_BILLING_INFO: 'sin facturación',
  };
  return map[s] ?? s;
}

function RatioTone({ v, umbral }: { v: number | null; umbral: number }): JSX.Element {
  if (v === null) return <span className="text-neutral-600">—</span>;
  const tone = v < umbral ? 'text-rose-400' : v < umbral + 1 ? 'text-amber-400' : 'text-good-400';
  return <span className={tone}>{ratio(v)}</span>;
}

function ToggleEstado({ fila, onToggle }: { fila: MetricasObjeto; onToggle: (f: MetricasObjeto) => void }): JSX.Element {
  const noToggleable = NO_TOGGLEABLE.has(fila.status ?? '') || NO_TOGGLEABLE.has(fila.effectiveStatus ?? '');
  if (noToggleable) {
    return <Badge tone="warn">{fila.effectiveStatus ?? fila.status ?? '?'}</Badge>;
  }
  const activo = fila.status === 'ACTIVE';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={activo}
      aria-label={`${fila.objectName ?? fila.objectId}: ${activo ? 'pausar' : 'activar'}`}
      onClick={() => onToggle(fila)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-good-500/50 ${
        activo ? 'bg-good-500' : 'bg-overlay/12'
      }`}
      title={activo ? 'Pausar' : 'Activar'}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          activo ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

function PresupuestoCelda({
  fila,
  edit,
  onEdit,
  onConfirm,
}: {
  fila: MetricasObjeto;
  edit: string | undefined;
  onEdit: (v: string) => void;
  onConfirm: (eur: number) => void;
}): JSX.Element {
  const editable = fila.budgetLevel === fila.level && fila.budgetMode === 'daily';

  if (fila.level === 'ad') return <span className="text-neutral-600">—</span>;

  if (!editable) {
    const motivo =
      fila.budgetMode === 'lifetime'
        ? 'presupuesto total: este panel sólo edita presupuestos diarios'
        : fila.budgetLevel !== fila.level
          ? 'el presupuesto se maneja en la campaña'
          : 'no editable';
    return (
      <span className="text-neutral-500" title={motivo}>
        {fila.dailyBudgetEur === null ? '—' : money(fila.dailyBudgetEur)}
      </span>
    );
  }

  if (edit === undefined) {
    return (
      <button
        type="button"
        onClick={() => onEdit(fila.dailyBudgetEur !== null ? String(fila.dailyBudgetEur) : '')}
        className="rounded px-1 text-neutral-200 underline decoration-dotted underline-offset-2 hover:text-neutral-50 focus:outline-none focus:ring-2 focus:ring-good-500/50"
        title="Editar presupuesto"
      >
        {fila.dailyBudgetEur === null ? '—' : money(fila.dailyBudgetEur)}
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="number"
        min={0}
        step={0.01}
        value={edit}
        autoFocus
        onChange={(e) => onEdit(e.target.value)}
        onBlur={() => {
          const n = Number(edit);
          if (Number.isFinite(n) && n > 0) onConfirm(n);
          else onEdit(''); // descarta
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const n = Number(edit);
            if (Number.isFinite(n) && n > 0) onConfirm(n);
          }
          if (e.key === 'Escape') onEdit('');
        }}
        className="w-24 rounded border border-border-strong bg-overlay/4 px-1 py-0.5 text-right text-sm text-neutral-100 focus:outline-none focus:ring-2 focus:ring-good-500/50"
        aria-label="Presupuesto en euros"
      />
    </span>
  );
}

function FiltrosBar({
  cuentas,
  filtros,
  onChange,
  seleccionados,
  onPedirLote,
}: {
  cuentas: CuentaAds[];
  filtros: Filtros;
  onChange: (c: Partial<Filtros>) => void;
  seleccionados: string[];
  onPedirLote: (accion: 'pause' | 'activate' | 'budget_set') => void;
}): JSX.Element {
  const [nombre, setNombre] = useState(filtros.nombre ?? '');
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cambiarNombre = (v: string): void => {
    setNombre(v);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => onChange({ nombre: v || undefined }), 400);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        value={nombre}
        onChange={(e) => cambiarNombre(e.target.value)}
        placeholder="Buscar por nombre…"
        className="rounded-lg border border-border-strong bg-overlay/4 px-3 py-1.5 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-good-500/50"
      />
      <select
        value={filtros.level}
        onChange={(e) => onChange({ level: e.target.value as NivelAds })}
        aria-label="Nivel"
        className="rounded-lg border border-border-strong bg-overlay/4 px-2 py-1.5 text-sm text-neutral-200 focus:outline-none focus:ring-1 focus:ring-good-500/50"
      >
        <option value="campaign">Campañas</option>
        <option value="adset">Conjuntos</option>
        <option value="ad">Anuncios</option>
      </select>
      <select
        value={filtros.status}
        onChange={(e) => onChange({ status: e.target.value as Filtros['status'] })}
        aria-label="Estado"
        className="rounded-lg border border-border-strong bg-overlay/4 px-2 py-1.5 text-sm text-neutral-200 focus:outline-none focus:ring-1 focus:ring-good-500/50"
      >
        <option value="any">Cualquiera</option>
        <option value="active">Activos</option>
        <option value="paused">Pausados</option>
      </select>
      <select
        value={filtros.account}
        onChange={(e) => onChange({ account: e.target.value })}
        aria-label="Cuenta"
        className="rounded-lg border border-border-strong bg-overlay/4 px-2 py-1.5 text-sm text-neutral-200 focus:outline-none focus:ring-1 focus:ring-good-500/50"
      >
        {cuentas.map((c) => (
          <option key={c.accountId} value={c.accountId}>
            {c.name ?? c.accountId}
          </option>
        ))}
      </select>
      <select
        value={filtros.period}
        onChange={(e) => onChange({ period: e.target.value as Filtros['period'] })}
        aria-label="Período"
        className="rounded-lg border border-border-strong bg-overlay/4 px-2 py-1.5 text-sm text-neutral-200 focus:outline-none focus:ring-1 focus:ring-good-500/50"
      >
        <option value="today">Hoy</option>
        <option value="yesterday">Ayer</option>
        <option value="7d">7 días</option>
        <option value="7d_excl_today">7 días sin hoy</option>
      </select>

      {seleccionados.length > 0 && (
        <span className="flex items-center gap-1 rounded-lg border border-border-strong bg-overlay/4 px-2 py-1">
          <span className="text-xs text-neutral-400">{seleccionados.length} seleccionados</span>
          <button type="button" onClick={() => onPedirLote('pause')} className="rounded px-2 py-0.5 text-xs font-semibold text-warn-300 hover:bg-overlay/6">Pausar</button>
          <button type="button" onClick={() => onPedirLote('activate')} className="rounded px-2 py-0.5 text-xs font-semibold text-good-300 hover:bg-overlay/6">Activar</button>
          <button type="button" onClick={() => onPedirLote('budget_set')} className="rounded px-2 py-0.5 text-xs font-semibold text-neutral-200 hover:bg-overlay/6">Presupuesto</button>
        </span>
      )}
    </div>
  );
}

function DialogoConfirmacion({
  accion,
  nombres,
  presupuestoViejo,
  presupuestoNuevo,
  onCancel,
  onConfirm,
}: {
  accion: 'pause' | 'activate' | 'budget_set';
  nombres: string[];
  presupuestoViejo: number | null;
  presupuestoNuevo: number | undefined;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const verbos: Record<string, string> = {
    pause: 'pausar',
    activate: 'activar',
    budget_set: 'cambiar el presupuesto de',
  };
  const primeros = nombres.slice(0, 5);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-border-strong bg-surface p-5 shadow-2xl">
        <h3 className="text-sm font-semibold text-neutral-100">Confirmar acción</h3>
        <p className="mt-2 text-sm text-neutral-300">
          Vas a {verbos[accion]}{' '}
          <span className="font-medium text-neutral-50">
            {primeros.map((n) => `«${n}»`).join(', ')}
            {nombres.length > 5 ? ` y otros ${nombres.length - 5}` : ''}
          </span>{' '}
          ({nombres.length} {nombres.length === 1 ? 'objeto' : 'objetos'}).
        </p>
        {accion === 'budget_set' && (
          <p className="mt-2 text-sm text-neutral-300">
            De {presupuestoViejo !== null ? money(presupuestoViejo) : '—'} a {money(presupuestoNuevo ?? 0)}.
          </p>
        )}
        <p className="mt-2 text-xs text-neutral-500">Es plata real: la acción se aplica en Meta de inmediato.</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-md border border-border-strong px-3 py-1.5 text-sm text-neutral-300 hover:bg-overlay/6">
            Cancelar
          </button>
          <button type="button" onClick={onConfirm} className="rounded-md bg-good-500 px-3 py-1.5 text-sm font-semibold text-neutral-950 hover:bg-good-400">
            Confirmar
          </button>
        </div>
      </div>
    </div>
  );
}
