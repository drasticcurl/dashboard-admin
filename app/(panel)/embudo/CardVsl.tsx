'use client';

/**
 * CardVsl — retención del VSL, en /embudo: ¿lo miran entero? ¿en qué segundo
 * se van? ¿cuántos llegan a la oferta?
 *
 * Trae sus datos de /api/data/vsl (como CardPitch) con el mismo rango que el
 * resto de la pantalla. Si el funnel tiene varios VSL (la venta y los upsells)
 * se elige cuál mirar arriba a la derecha; por defecto, la venta (`plan`).
 * Si en el rango nadie activó el sonido de ningún VSL, la card no se dibuja.
 */

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { CartesianGrid, Line, LineChart, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts';
import { panelColors } from '@/tailwind.config';
import type { Funnel } from '@/lib/funnels';
import type { VslData } from '@/lib/queries/vsl';
import { Card, ChartFrame, EmptyState, Spinner, StatCard, fmtInt, fmtPct } from '@/components/ui';
import { mmss } from './CardPitch';

const NOMBRE_PAGINA: Record<string, string> = {
  plan: 'Venta',
  'upsell-u1': 'Upsell 1',
  'upsell-u2': 'Upsell 2',
  'upsell-u3': 'Upsell 3',
  'upsell-u4': 'Upsell 4',
  upsell: 'Upsell',
};

export function nombrePagina(page: string): string {
  return NOMBRE_PAGINA[page] ?? page;
}

const HINT =
  'Solo cuenta a quienes activaron el sonido: mirar el video muteado no es escuchar el pitch. La curva dice qué % seguía escuchando en cada momento; los tramos dicen dónde se fue más gente. "Lo terminaron" = llegaron a los últimos 10 s. Respeta el rango de arriba.';

export function CardVsl({ funnel }: { funnel: Funnel }) {
  const searchParams = useSearchParams();
  const range = searchParams.get('range');
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  const [page, setPage] = useState<string | null>(null);
  const [data, setData] = useState<VslData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ f: funnel.slug });
    if (from && to) {
      params.set('from', from);
      params.set('to', to);
    } else {
      params.set('range', range ?? 'today');
    }
    if (page) params.set('page', page);
    fetch(`/api/data/vsl?${params.toString()}`, { signal: ctrl.signal, cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as VslData;
      })
      .then(setData)
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Error de red');
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [funnel.slug, range, from, to, page]);

  // Sin un solo VSL con sonido en el rango, la card no aporta nada: no se dibuja.
  if (!loading && !error && data && data.paginas.length === 0) return null;
  if (!data && loading) {
    return (
      <Card title="VSL: cuánto lo miran" hint={HINT}>
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      </Card>
    );
  }

  const selector =
    data && data.paginas.length > 1 ? (
      <select
        aria-label="Qué VSL mirar"
        value={data.page ?? ''}
        onChange={(e) => setPage(e.target.value)}
        className="rounded-md border border-border-subtle bg-surface px-2 py-1 text-xs text-neutral-200"
      >
        {data.paginas.map((p) => (
          <option key={p.page} value={p.page}>
            {nombrePagina(p.page)} ({fmtInt(p.conSonido)})
          </option>
        ))}
      </select>
    ) : undefined;

  if (error || !data) {
    return (
      <Card title="VSL: cuánto lo miran" hint={HINT}>
        <EmptyState title="No se pudo cargar" hint={error ?? 'Sin datos'} />
      </Card>
    );
  }

  const pct = (n: number) => (data.conSonido > 0 ? (n / data.conSonido) * 100 : 0);

  return (
    <Card title={`VSL: cuánto lo miran · ${data.page ? nombrePagina(data.page) : ''}`} hint={HINT} accion={selector}>
      <div className={`space-y-5 ${loading ? 'opacity-60' : ''}`}>
        <div className="grid grid-cols-2 gap-3 panel:grid-cols-4">
          <StatCard label="Activaron el sonido" value={fmtInt(data.conSonido)} />
          <StatCard
            label="Escuchan en promedio"
            value={data.promedioSec === null ? '—' : mmss(data.promedioSec)}
            sub={
              data.medianaSec === null
                ? undefined
                : `mediana ${mmss(data.medianaSec)}${data.duracionSec ? ` de ${mmss(data.duracionSec)}` : ''}`
            }
          />
          <StatCard
            label="Llegaron a la oferta"
            value={fmtPct(pct(data.llegaronOferta), 0)}
            sub={`${fmtInt(data.llegaronOferta)}${data.ofertaEnSec !== null ? ` · oferta en ${mmss(data.ofertaEnSec)}` : ''}`}
          />
          <StatCard
            label="Lo terminaron"
            value={data.terminaron === null ? '—' : fmtPct(pct(data.terminaron), 0)}
            sub={data.terminaron === null ? 'falta la duración del video' : `${fmtInt(data.terminaron)} personas`}
          />
        </div>

        {data.curva.length > 1 ? (
          <ChartFrame alto="md">
            <LineChart data={data.curva} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={panelColors.grid} vertical={false} />
              <XAxis
                dataKey="segundo"
                type="number"
                domain={['dataMin', 'dataMax']}
                tickFormatter={mmss}
                tick={{ fontSize: 11, fill: panelColors.axis }}
                tickLine={false}
                axisLine={{ stroke: panelColors.axisLine }}
                minTickGap={28}
              />
              <YAxis
                domain={[0, 100]}
                tickFormatter={(v: number) => `${v}%`}
                tick={{ fontSize: 11, fill: panelColors.axis }}
                tickLine={false}
                axisLine={false}
                width={44}
              />
              <Tooltip
                formatter={(v: number) => [fmtPct(v, 0), 'siguen escuchando']}
                labelFormatter={(s: number) => mmss(s)}
                contentStyle={{ background: panelColors.grid, border: 'none', fontSize: 12 }}
              />
              {data.ofertaEnSec !== null && (
                <ReferenceLine
                  x={data.ofertaEnSec}
                  stroke={panelColors.acento}
                  strokeDasharray="4 4"
                  label={{ value: 'oferta', position: 'insideTopRight', fill: panelColors.axis, fontSize: 10 }}
                />
              )}
              <Line
                type="monotone"
                dataKey="pct"
                stroke={panelColors.info}
                strokeWidth={2}
                dot={{ r: 2 }}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ChartFrame>
        ) : (
          <EmptyState title="Todavía no hay curva" hint="Nadie escuchó este VSL con sonido en el rango elegido." />
        )}

        {data.peoresTramos.length > 0 && (
          <div>
            <h3 className="font-display text-sm font-semibold -tracking-[0.01em] text-neutral-100">
              Dónde se va más gente
            </h3>
            <ul className="mt-2 space-y-1 text-sm text-neutral-300">
              {data.peoresTramos.map((t) => (
                <li key={t.desde} className="tabular-nums">
                  Entre {mmss(t.desde)} y {mmss(t.hasta)}:{' '}
                  <span className="font-semibold text-neutral-100">{fmtPct(t.pct, 0)}</span>{' '}
                  <span className="text-neutral-500">({fmtInt(t.seFueron)} personas)</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
