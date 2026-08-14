'use client';

/**
 * LeadsView — la pantalla de leads de un funnel (task T09 §A).
 *
 * Recibe los datos que renderizó el server y refetchea /api/data/leads ante
 * cambios de funnel/rango, igual que las otras secciones. El export CSV es
 * un link directo al route: la cookie viaja sola (mismo origen) y el
 * `Content-Disposition: attachment` fuerza la descarga con el nombre del
 * panel viejo (`shopify-leads-<fecha>.csv`).
 *
 * No se importa nada en runtime desde lib/queries/leads.ts a propósito: ese
 * archivo importa pg y Supabase fetch, y traerlo al bundle del browser
 * rompería el build del client. Los tipos entran como `import type`.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Download, UsersThree } from '@phosphor-icons/react';
import type { Funnel } from '@/lib/funnels';
import type { LeadsData } from '@/lib/queries/leads';
import {
  Banner,
  Card,
  EmptyState,
  Skeleton,
  StatCard,
  Table,
  fmtDateTime,
  fmtInt,
} from '@/components/ui';

// Los mismos cortes que el CSV viejo (severidadBucket): >= 8 alta, >= 5
// media, el resto baja. La etiqueta de la tabla y el tag del export no
// pueden divergir o el dato se lee distinto en dos lugares.
function severidadLabel(score: number): string {
  if (score >= 8) return 'alta';
  if (score >= 5) return 'media';
  return 'baja';
}

// El orden de la tabla viaja en el query string (D-R14): sobrevive al
// refresh y se puede compartir por link, como el resto de los filtros.
type SortLeads = 'recientes' | 'severidad';

export function LeadsView({
  funnel,
  initialData,
}: {
  funnel: Funnel;
  initialData: LeadsData;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [data, setData] = useState<LeadsData>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [onlyNonBuyers, setOnlyNonBuyers] = useState(true);
  const [since, setSince] = useState('');

  const sort: SortLeads = searchParams.get('sort') === 'severidad' ? 'severidad' : 'recientes';

  const filas = useMemo(() => {
    const rows = [...data.recent];
    if (sort === 'severidad') {
      rows.sort((a, b) => (b.severidad ?? -1) - (a.severidad ?? -1));
    } else {
      rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    }
    return rows;
  }, [data.recent, sort]);

  function cambiarSort(v: SortLeads) {
    const params = new URLSearchParams(searchParams.toString());
    if (v === 'recientes') params.delete('sort');
    else params.set('sort', v);
    router.replace(`/leads?${params.toString()}`, { scroll: false });
  }

  const firstRun = useRef(true);

  // Sólo el rango y el funnel disparan el refetch: el ?sort= es un reorden
  // client-side y no tiene que volver a pegarle al server.
  const rangeKey = [
    searchParams.get('from'),
    searchParams.get('to'),
    searchParams.get('range'),
  ].join('|');

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ f: funnel.slug });
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    if (from && to) {
      params.set('from', from);
      params.set('to', to);
    } else {
      params.set('range', searchParams.get('range') ?? 'today');
    }

    fetch(`/api/data/leads?${params.toString()}`, {
      signal: ctrl.signal,
      cache: 'no-store',
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as LeadsData;
      })
      .then(setData)
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Error de red');
      })
      .finally(() => setLoading(false));

    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [funnel.slug, rangeKey, retryTick]);

  const exportParams = new URLSearchParams({
    f: funnel.slug,
    format: 'csv',
    onlyNonBuyers: onlyNonBuyers ? '1' : '0',
  });
  if (since) exportParams.set('since', since);
  const exportHref = `/api/data/leads?${exportParams.toString()}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="flex items-center gap-2 text-lg font-semibold text-neutral-50">
            <UsersThree size={20} weight="bold" className="text-neutral-400" /> Leads
          </h1>
          <span className="text-sm text-neutral-500">· {funnel.name}</span>
          {loading && <span className="text-xs text-neutral-500">Actualizando…</span>}
        </div>
      </div>

      {error && (
        <Banner tone="bad" title="No se pudieron cargar los leads">
          <span className="flex flex-wrap items-center gap-3">
            {error}
            <button
              type="button"
              onClick={() => setRetryTick((x) => x + 1)}
              className="rounded-md border border-white/10 px-2 py-1 font-semibold text-neutral-200 hover:bg-white/[0.06]"
            >
              Reintentar
            </button>
          </span>
        </Banner>
      )}

      {!data.configured && (
        <Banner tone="warn" title="Funnel sin configurar">
          No hay credenciales de Supabase para <code className="rounded bg-white/10 px-1">{funnel.slug}</code>.
          Agregá{' '}
          <code className="rounded bg-white/10 px-1">
            SUPABASE_URL_{funnel.slug.toUpperCase()}
          </code>{' '}
          y{' '}
          <code className="rounded bg-white/10 px-1">
            SUPABASE_SERVICE_KEY_{funnel.slug.toUpperCase()}
          </code>{' '}
          al env del dashboard para ver sus leads. El resto del panel sigue
          funcionando igual.
        </Banner>
      )}
      {data.supabaseError && (
        <Banner tone="bad" title="Supabase no responde">
          <code className="rounded bg-white/10 px-1">{data.supabaseError}</code> — los números
          muestran ceros hasta que el fetch funcione.
        </Banner>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Total leads" value={fmtInt(data.totalLeads)} sub="Histórico" />
        <StatCard label="En el rango" value={fmtInt(data.rangeLeads)} sub="Días del selector" tone="info" />
        <StatCard label="No-compradores" value={fmtInt(data.nonBuyers)} sub="Del rango, sin compra aprobada" tone="good" />
        <StatCard label="Últimas 24 h" value={fmtInt(data.last24h)} />
        <StatCard label="Últimos 7 d" value={fmtInt(data.last7d)} />
        <StatCard label="Últimos 30 d" value={fmtInt(data.last30d)} />
      </div>

      <Card
        title="Exportar a Shopify"
        hint="El mismo CSV que bajaba /api/admin/leads-export: mismo formato, BOM y tags — Shopify lo acepta tal cual."
      >
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-300">
            <input
              type="checkbox"
              checked={onlyNonBuyers}
              onChange={(e) => setOnlyNonBuyers(e.target.checked)}
              className="h-4 w-4 accent-emerald-500"
            />
            Solo no-compradores
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Desde el día
            <input
              type="date"
              value={since}
              onChange={(e) => setSince(e.target.value)}
              className="rounded-lg border border-border-strong bg-overlay/4 px-2 py-1.5 text-sm text-neutral-200 focus:border-good-500/50 focus:outline-none"
            />
          </label>
          <a
            href={data.configured ? exportHref : undefined}
            aria-disabled={!data.configured}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-good-500/50 ${
              data.configured
                ? 'bg-good-500 text-white hover:bg-good-400'
                : 'pointer-events-none bg-overlay/6 text-neutral-500'
            }`}
          >
            <Download size={15} weight="bold" /> Exportar CSV
          </a>
          <span className="text-xs text-neutral-500">
            {data.lastLeadAt ? `Último lead: ${fmtDateTime(data.lastLeadAt)}` : 'Sin leads todavía'}
          </span>
        </div>
      </Card>

      <Card title="Últimos 100 leads" hint="Email enmascarado; click para verlo completo">
        <div className="mb-3 flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-neutral-500">
            Orden
            <select
              value={sort}
              onChange={(e) => cambiarSort(e.target.value as SortLeads)}
              aria-label="Orden de la tabla de leads"
              className="rounded-lg border border-border-strong bg-overlay/4 px-2 py-1.5 text-sm text-neutral-200 focus:border-good-500/50 focus:outline-none"
            >
              <option value="recientes" className="bg-surface">Más recientes primero</option>
              <option value="severidad" className="bg-surface">Mayor severidad primero</option>
            </select>
          </label>
        </div>
        {loading && filas.length === 0 ? (
          <Skeleton variant="table" rows={6} />
        ) : filas.length === 0 ? (
          <EmptyState
            title="No hay leads todavía"
            hint="Cuando la gente empiece a contestar el quiz, van a aparecer acá con su severidad y su estado de compra. El rango del selector de arriba puede estar dejándolos afuera."
          />
        ) : (
          <Table
            rows={filas}
            empty="No hay leads todavía"
            columns={[
            {
              key: 'when',
              header: 'Fecha',
              render: (r) => (
                <span className="whitespace-nowrap text-neutral-300">{fmtDateTime(r.createdAt)}</span>
              ),
            },
            {
              key: 'email',
              header: 'Email',
              render: (r) => <MaskedEmail email={r.email} />,
            },
            {
              key: 'nombre',
              header: 'Nombre',
              render: (r) => <span className="text-neutral-300">{r.nombre ?? '—'}</span>,
            },
            {
              key: 'compro',
              header: 'Compró',
              render: (r) => <ComproBadge compro={r.compro} />,
            },
            {
              key: 'fuente',
              header: 'Fuente',
              render: (r) => <span className="text-neutral-400">{r.utmSource ?? '—'}</span>,
            },
            {
              key: 'campana',
              header: 'Campaña',
              render: (r) => <span className="text-neutral-400">{r.utmCampaign ?? '—'}</span>,
            },
            {
              key: 'tipo',
              header: 'Tipo',
              align: 'right',
              render: (r) => (
                <span className="tabular-nums text-neutral-300">
                  {r.tipoHinchazon == null ? '—' : r.tipoHinchazon}
                </span>
              ),
            },
            {
              key: 'severidad',
              header: 'Severidad',
              render: (r) => {
                if (r.severidad == null) return <span className="text-neutral-600">—</span>;
                return (
                  <span className="text-neutral-300">
                    {r.severidad}/10 · {severidadLabel(r.severidad)}
                  </span>
                );
              },
              },
            ]}
          />
          )}
      </Card>
    </div>
  );
}

/**
 * Email enmascarado por defecto (lu***@gmail.com), completo detrás de un
 * click — la misma protección que T07 §5: datos personales en un dominio
 * público que se comparte por captura.
 */
function MaskedEmail({ email }: { email: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const at = email.indexOf('@');
  const masked = at > 0 ? `${email.slice(0, Math.min(2, at))}***${email.slice(at)}` : '***';
  return (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      aria-label={open ? 'Ocultar email completo' : 'Mostrar email completo'}
      className="rounded-sm tabular-nums text-neutral-300 underline decoration-dotted underline-offset-2 transition-colors hover:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-good-500/50"
    >
      {open ? email : masked}
    </button>
  );
}

/**
 * `compro` puede venir como boolean o como string según cómo se haya escrito
 * históricamente en `clientes`: se muestra honesto, nunca se asume un tipo.
 */
function ComproBadge({ compro }: { compro: boolean | string | null }): JSX.Element {
  if (compro == null || compro === '' || compro === false || compro === 'false') {
    return <span className="text-neutral-600">No</span>;
  }
  return <span className="font-medium text-emerald-400">Sí</span>;
}
