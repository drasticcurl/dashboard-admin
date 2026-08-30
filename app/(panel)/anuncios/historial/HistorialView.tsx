'use client';

/**
 * HistorialView — la pantalla /anuncios/historial (T19).
 *
 * Lista cronológica de `ad_actions`. La columna que importa es `explicacion`
 * (el renglón en castellano que escribió el motor) y va sin truncar, con el
 * ancho máximo. El badge de resultado sale de `estado` (columna explícita con
 * vocabulario cerrado), no de combinar `dry_run`/`ok`/`skipped_reason`: así se
 * pueden representar `indeterminado` ("no se sabe si se aplicó") y `pendiente`.
 */

import { useCallback, useEffect, useState } from 'react';
import { Badge, Banner, Card, EmptyState, Skeleton, Table, fmtDateTime } from '@/components/ui';
import type { Tone } from '@/components/ui';
import { ROTULO_ACCION } from '@/lib/ads/previsualizacion';
import { MONEDA_REPORTE, SIMBOLO_REPORTE } from '@/lib/moneda-reporte';

const ESTADOS = ['confirmado', 'simulado', 'omitido', 'fallido', 'indeterminado', 'pendiente'] as const;
const SOURCES = ['rule', 'manual', 'system'] as const;
// El Vocabulario_Acciones completo: un Record<AccionAds, string> cuyo orden es
// el del tipo, así agregar un valor sin su rótulo rompe la compilación (R15 c8).
const ACCIONES = Object.keys(ROTULO_ACCION) as (keyof typeof ROTULO_ACCION)[];

type FilaHistorial = {
  id: number;
  created_at: string;
  explicacion: string;
  estado: string;
  dry_run: boolean;
  ok: boolean;
  skipped_reason: string | null;
  actor_hint: string | null;
  rule_id: number | null;
  rule_name: string | null;
  source: string;
  account_id: string;
  level: string;
  object_id: string;
  object_name: string | null;
  action: string;
  before_value: string | null;
  after_value: string | null;
  metrics: Record<string, unknown>;
  error: string | null;
  /** Sólo en filas de duplicación: los descendientes creados (R15 c6, D-08). */
  descendientes?: Array<{ id: string; nivel: string; nombre: string | null }>;
};

// ─── Derivación del badge desde `estado`, con switch exhaustivo ──────────────
// El default con `const _: never` hace que agregar un estado rompa la
// compilación en lugar de producir un badge vacío (task §6.1).
type Estado = (typeof ESTADOS)[number];

function badgeEstado(estado: Estado): { texto: string; tone: Tone; tooltip?: string } {
  switch (estado) {
    case 'confirmado':
      return { texto: 'hecho', tone: 'good' };
    case 'simulado':
      return { texto: 'simulado', tone: 'info' };
    case 'omitido':
      return { texto: 'omitido', tone: 'neutral' };
    case 'fallido':
      return { texto: 'error', tone: 'bad' };
    case 'indeterminado':
      return {
        texto: 'sin confirmar',
        tone: 'warn',
        tooltip: 'No se sabe si se aplicó: el POST puede haber llegado a Meta y cortado por timeout. El reconciliador lo resuelve en el tick siguiente.',
      };
    case 'pendiente':
      return {
        texto: 'en curso',
        tone: 'warn',
        tooltip: 'Se está intentando ahora, o el proceso murió a mitad de camino.',
      };
    default: {
      const _: never = estado;
      return { texto: String(_), tone: 'neutral' };
    }
  }
}

// ─── Formateadores ───────────────────────────────────────────────────────────

const dosDecimales = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sinDecimales = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });

function eur(n: number): string {
  return `${SIMBOLO_REPORTE}${dosDecimales.format(n)}`;
}
function numero(n: number): string {
  return dosDecimales.format(n);
}

const METRICA_LABEL: Record<string, string> = {
  spendEur: 'Gasto',
  dailyBudgetEur: 'Presupuesto',
  sales: 'Ventas',
  roi: 'ROI',
  roas: 'ROAS',
  spend: 'Gasto',
  revenue: 'Ingresos',
  net: 'Neto',
  profit: 'Ganancia',
  cpa: 'CPA',
  budget: 'Presupuesto',
  impressions: 'Impresiones',
  clicks: 'Clics',
  ctr: 'CTR',
  cpc: 'CPC',
};

function formatearMetrica(k: string, v: unknown): string {
  if (typeof v !== 'number') return String(v ?? '—');
  if (k.endsWith('Eur') || ['spend', 'revenue', 'net', 'profit', 'cpa', 'budget'].includes(k)) return eur(v);
  if (['roi', 'roas', 'ctr', 'cpc'].includes(k)) return numero(v);
  return sinDecimales.format(v);
}

const inputCls =
  'rounded-lg border border-border-strong bg-overlay/4 px-2 py-1.5 text-sm text-neutral-200 focus:border-good-500/50 focus:outline-none focus:ring-1 focus:ring-good-500/50';
const chipCls =
  'rounded-full px-2.5 py-1 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-good-500/50';

export function HistorialView(): JSX.Element {
  const [filas, setFilas] = useState<FilaHistorial[]>([]);
  const [cargando, setCargando] = useState(true);
  const [hayMas, setHayMas] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [estado, setEstado] = useState('');
  const [source, setSource] = useState('');
  const [accion, setAccion] = useState('');
  const [objeto, setObjeto] = useState('');

  const cargar = useCallback(
    async (opts?: { before?: number; agregar?: boolean }) => {
      setCargando(true);
      setError(null);
      try {
        const qs = new URLSearchParams();
        if (estado) qs.set('estado', estado);
        if (source) qs.set('source', source);
        if (accion) qs.set('accion', accion);
        if (objeto) qs.set('objeto', objeto);
        if (opts?.before) qs.set('before', String(opts.before));
        qs.set('limit', '100');

        const res = await fetch(`/api/data/ads/historial?${qs.toString()}`, { cache: 'no-store' });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          filas?: FilaHistorial[];
          hayMas?: boolean;
          error?: string;
          detail?: string;
        };
        if (!res.ok) throw new Error(body.detail ?? body.error ?? `HTTP ${res.status}`);

        const nuevas = body.filas ?? [];
        setFilas((prev) => (opts?.agregar ? [...prev, ...nuevas] : nuevas));
        setHayMas(body.hayMas ?? false);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setCargando(false);
      }
    },
    [estado, source, accion, objeto],
  );

  // Refetchea cuando cambia un filtro (resetea la lista).
  useEffect(() => {
    void cargar();
  }, [cargar]);

  const ultimoId = filas.length ? filas[filas.length - 1].id : null;

  return (
    <div className="space-y-4">
      {/* Encabezado y SubNav: app/(panel)/anuncios/layout.tsx */}

      {error && (
        <Banner tone="bad" title="No se pudo cargar">
          <span className="flex flex-wrap items-center gap-3">
            {error}
            <button
              type="button"
              onClick={() => void cargar()}
              className="rounded-md border border-border-strong px-2 py-1 font-semibold text-neutral-200 hover:bg-overlay/6"
            >
              Reintentar
            </button>
          </span>
        </Banner>
      )}

      {/* ── Filtros ── */}
      <Card title="Historial de acciones">
        <p className="mb-3 text-xs text-neutral-500">
          El rastro técnico de cada fila (IP y user-agent) no es una identidad de usuario: el panel
          se autentica con una contraseña compartida y sin tabla de usuarios, así que «quién lo hizo»
          no se puede saber más allá de ese rastro.
        </p>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <select className={inputCls} value={estado} onChange={(e) => setEstado(e.target.value)}>
            <option value="">Todos los resultados</option>
            {ESTADOS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
          <select className={inputCls} value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">Toda fuente</option>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select className={inputCls} value={accion} onChange={(e) => setAccion(e.target.value)}>
            <option value="">Toda acción</option>
            {ACCIONES.map((a) => (
              <option key={a} value={a}>
                {ROTULO_ACCION[a]}
              </option>
            ))}
          </select>
          <input className={inputCls} value={objeto} onChange={(e) => setObjeto(e.target.value)} placeholder="id de objeto (1201…)" />
          <button
            type="button"
            className={`${chipCls} ${estado === 'fallido' ? 'bg-bad-500/20 text-bad-200' : 'border border-border-strong text-neutral-300 hover:bg-overlay/6'}`}
            onClick={() => setEstado(estado === 'fallido' ? '' : 'fallido')}
          >
            solo errores
          </button>
          <button
            type="button"
            className={`${chipCls} ${estado === 'indeterminado' ? 'bg-warn-500/20 text-warn-200' : 'border border-border-strong text-neutral-300 hover:bg-overlay/6'}`}
            onClick={() => setEstado(estado === 'indeterminado' ? '' : 'indeterminado')}
          >
            sin confirmar
          </button>
        </div>

        {cargando && filas.length === 0 ? (
          <Skeleton variant="table" rows={8} />
        ) : filas.length === 0 ? (
          <EmptyState title="No hay acciones" hint="Todavía no hay nada que mostrar para estos filtros." />
        ) : (
          <Table
            rows={filas}
            columns={[
              { key: 'cuando', header: 'Cuándo', render: (f) => <span className="whitespace-nowrap text-neutral-400">{fmtDateTime(f.created_at)}</span> },
              {
                key: 'que',
                header: 'Qué pasó',
                className: 'min-w-[380px] whitespace-normal leading-snug',
                render: (f) => (
                  <span className="text-neutral-200">
                    <span className="mr-2 rounded bg-overlay/6 px-1.5 py-0.5 text-[11px] font-semibold text-neutral-400">
                      {ROTULO_ACCION[f.action as keyof typeof ROTULO_ACCION] ?? f.action}
                    </span>
                    {f.explicacion}
                  </span>
                ),
              },
              {
                key: 'regla',
                header: 'Regla',
                render: (f) =>
                  f.source === 'system' ? (
                    <Badge tone="info">configuración</Badge>
                  ) : f.rule_name ? (
                    <span className="text-neutral-300">{f.rule_name}</span>
                  ) : (
                    <span className="text-neutral-500">(regla borrada)</span>
                  ),
              },
              {
                key: 'resultado',
                header: 'Resultado',
                render: (f) => {
                  const b = badgeEstado(f.estado as Estado);
                  return (
                    <span title={b.tooltip}>
                      <Badge tone={b.tone}>{b.texto}</Badge>
                    </span>
                  );
                },
              },
              {
                key: 'detalle',
                header: 'Detalle',
                render: (f) => (
                  <span className="text-xs text-neutral-400">
                    {f.before_value || f.after_value ? (
                      <span className="tabular-nums">
                        {f.before_value ?? '—'} → {f.after_value ?? '—'}
                      </span>
                    ) : (
                      <span className="text-neutral-500">{f.object_id}</span>
                    )}
                    {f.error && <span className="ml-2 block text-bad-300">{f.error}</span>}
                    {f.action === 'duplicate' && f.descendientes && f.descendientes.length > 0 && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-neutral-500 hover:text-neutral-300">
                          objetos creados ({f.descendientes.length})
                        </summary>
                        <ul className="mt-1 space-y-0.5 rounded-lg bg-canvas/50 p-2">
                          {f.descendientes.map((d) => (
                            <li key={d.id} className="tabular-nums">
                              {d.nivel}: {d.nombre ?? '(sin nombre)'} ({d.id})
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {Object.keys(f.metrics ?? {}).length > 0 && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-neutral-500 hover:text-neutral-300">métricas</summary>
                        <ul className="mt-1 space-y-0.5 rounded-lg bg-canvas/50 p-2">
                          {Object.entries(f.metrics).map(([k, v]) => (
                            <li key={k} className="tabular-nums">
                              {METRICA_LABEL[k] ?? k}: {formatearMetrica(k, v)}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {f.actor_hint && (
                      <span className="mt-1 block text-neutral-600" title="Rastro técnico del pedido, no una identidad de usuario">
                        {f.actor_hint}
                      </span>
                    )}
                  </span>
                ),
              },
            ]}
          />
        )}

        {hayMas && (
          <div className="mt-3 flex justify-center">
            <button
              type="button"
              className="rounded-lg border border-border-strong px-3 py-1.5 text-xs font-semibold text-neutral-300 hover:bg-overlay/6"
              disabled={cargando || ultimoId == null}
              onClick={() => void cargar({ before: ultimoId!, agregar: true })}
            >
              {cargando ? 'Cargando…' : 'Cargar más'}
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
