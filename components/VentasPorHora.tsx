'use client';

/**
 * VentasPorHora — el widget de ancho completo del Resumen: las 24 horas del
 * día como una tira, para ver a qué hora entra la plata.
 *
 * Sigue la regla 2 de lib/widgets/tipos.ts: no hace fetch, recibe
 * `OverviewData` ya cargado. El único estado es de vista (importe u órdenes, y
 * qué hora está bajo el puntero).
 *
 * Qué dice cada marca, porque todas son dato y ninguna es adorno:
 *  · la barra, apilada por funnel con su color (en "órdenes" es una sola, no
 *    hay desglose de órdenes por funnel y hora);
 *  · la rayita gris, el mismo horario del período anterior de igual largo;
 *  · el punto verde que late, la hora en curso (sólo si el rango termina hoy);
 *  · las horas que todavía no pasaron, punteadas: un 0 a las 23 cuando son
 *    las 14 no es "no vendió", es "no llegó".
 *
 * El gráfico es a mano y no recharts: 24 columnas con un tooltip propio pesan
 * menos que un BarChart y permiten la hora en curso y las futuras, que en
 * recharts serían un `shape` custom por barra.
 */

import { useMemo, useState } from 'react';
import { TrendDown, TrendUp } from '@phosphor-icons/react';
import { fmtAxis, fmtInt, fmtMoney, fmtPct } from '@/components/ui';
import type { OverviewData } from '@/lib/queries/overview';
import type { WidgetSize } from '@/lib/widgets/tipos';
import {
  type MedidaHora,
  hh,
  horaEnCurso,
  horaPico,
  mejorFranja,
  valorHora,
  valorPrevHora,
} from '@/lib/widgets/ventas-por-hora';

// La animación de entrada: las barras crecen desde el piso de la medianoche
// a la noche, 18ms entre hora y hora. `backwards` y no `both` por lo mismo que
// `.reveal` en globals.css (un transform que queda aplicado crea containing
// block). Con prefers-reduced-motion la regla global la deja en 0.
const KEYFRAMES = `@keyframes vph-crece{from{transform:scaleY(0);opacity:.2}to{transform:scaleY(1);opacity:1}}`;

export function VentasPorHora({ data, size }: { data: OverviewData; size: WidgetSize }): JSX.Element {
  const [medida, setMedida] = useState<MedidaHora>('importe');
  const [activa, setActiva] = useState<number | null>(null);

  const horas = data.byHour;
  const hasta = data.byDay[data.byDay.length - 1]?.day ?? data.ahora.day;
  const enCurso = horaEnCurso(hasta, data.ahora);
  const dias = data.byDay.length;

  const { max, total, totalPrev, pico, franja } = useMemo(() => {
    let max = 0;
    let total = 0;
    let totalPrev: number | null = null;
    for (const h of horas) {
      const v = valorHora(h, medida);
      const p = valorPrevHora(h, medida);
      total += v;
      if (p !== null) totalPrev = (totalPrev ?? 0) + p;
      max = Math.max(max, v, p ?? 0);
    }
    return { max, total, totalPrev, pico: horaPico(horas, medida), franja: mejorFranja(horas, medida) };
  }, [horas, medida]);

  const fmt = (v: number): string => (medida === 'importe' ? fmtMoney(v, data.moneda) : fmtInt(v));
  const funnelsConColor = data.funnels;
  const picoValor = pico === null ? 0 : valorHora(horas[pico]!, medida);
  const variacion = totalPrev !== null && totalPrev > 0 ? ((total - totalPrev) / totalPrev) * 100 : null;
  const alto = size.h === 2;

  return (
    <div className="flex h-full min-w-0 flex-col gap-4 panel:flex-row panel:gap-6">
      <style>{KEYFRAMES}</style>

      {/* ── Las tres lecturas ─────────────────────────────────────────────── */}
      <div className="flex shrink-0 flex-col gap-3 panel:w-52">
        <div
          role="radiogroup"
          aria-label="Qué medir"
          className="inline-flex w-fit rounded-lg border border-border-subtle bg-canvas p-0.5 text-xs font-medium"
        >
          {(['importe', 'ordenes'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={medida === m}
              onClick={() => setMedida(m)}
              className={`rounded-md px-2.5 py-1 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-good-500/60 ${
                medida === m ? 'bg-surface-raised text-neutral-50 shadow-inset-highlight' : 'text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {m === 'importe' ? 'Importe' : 'Órdenes'}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-3 gap-3 panel:grid-cols-1 panel:gap-2.5">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-[0.08em] text-neutral-500">Hora pico</p>
            <p className="num font-mono text-xl font-medium -tracking-[0.02em] text-neutral-50">
              {pico === null ? '—' : `${hh(pico)}:00`}
              {pico !== null && (
                <span className="ml-2 text-xs font-normal tracking-normal text-good-400">{fmt(picoValor)}</span>
              )}
            </p>
          </div>
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-[0.08em] text-neutral-500">Mejor franja</p>
            <p className="num font-mono text-sm text-neutral-200">
              {franja === null ? (
                '—'
              ) : (
                <>
                  {hh(franja.desde)}–{hh(franja.hasta)} h
                  <span className="ml-1.5 text-neutral-500">{fmtPct(franja.parte * 100, 0)}</span>
                </>
              )}
            </p>
          </div>
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-[0.08em] text-neutral-500">
              {dias === 1 ? 'Total del día' : `Suma de ${fmtInt(dias)} días`}
            </p>
            <p className="num flex flex-wrap items-baseline gap-x-2 font-mono text-sm text-neutral-200">
              {fmt(total)}
              {variacion !== null && (
                <span
                  title="Contra las mismas horas del período anterior de igual largo"
                  className={`inline-flex items-center gap-0.5 text-xs font-semibold ${
                    variacion >= 0 ? 'text-good-400' : 'text-bad-400'
                  }`}
                >
                  {variacion >= 0 ? <TrendUp size={12} weight="bold" aria-hidden /> : <TrendDown size={12} weight="bold" aria-hidden />}
                  {fmtPct(Math.abs(variacion), 0)}
                </span>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* ── La tira de 24 horas ───────────────────────────────────────────── */}
      <div className={`relative flex min-h-0 min-w-0 flex-1 flex-col ${alto ? 'h-72' : 'h-40'} panel:h-auto`}>
        {total === 0 && (
          <p className="pointer-events-none absolute inset-x-0 top-1/3 z-10 text-center text-xs text-neutral-500">
            {enCurso !== null ? 'Todavía no entró ninguna venta hoy.' : 'Sin ventas en el rango.'}
          </p>
        )}

        <div
          className="relative flex min-h-0 flex-1 items-end gap-[3px] panel:gap-1"
          onPointerLeave={() => setActiva(null)}
        >
          {/* Guías horizontales a la mitad y al tope: dan escala sin eje Y. */}
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-overlay/[0.06]" />
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-overlay/[0.04]" />
          {max > 0 && (
            <span aria-hidden className="pointer-events-none absolute -top-0.5 right-0 -translate-y-full font-mono text-[10px] text-neutral-600">
              {medida === 'importe' ? fmtAxis(max) : fmtInt(max)}
            </span>
          )}

          {horas.map((h) => {
            const v = valorHora(h, medida);
            const p = valorPrevHora(h, medida);
            const futura = enCurso !== null && h.hour > enCurso;
            const esAhora = enCurso === h.hour;
            const esPico = pico === h.hour && v > 0;
            const pct = max > 0 ? (v / max) * 100 : 0;
            const pctPrev = max > 0 && p !== null ? (p / max) * 100 : null;
            const tenue = activa !== null && activa !== h.hour;

            return (
              <div
                key={h.hour}
                tabIndex={0}
                role="img"
                aria-label={`${hh(h.hour)}:00 — ${fmt(v)}${p !== null ? `, período anterior ${fmt(p)}` : ''}${futura ? ', todavía no pasó' : ''}`}
                onPointerEnter={() => setActiva(h.hour)}
                onFocus={() => setActiva(h.hour)}
                onBlur={() => setActiva(null)}
                className="group/hora relative flex h-full min-w-0 flex-1 cursor-default flex-col justify-end rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-good-500/60"
              >
                {/* La columna entera se ilumina al pasar: el blanco de 3%
                    marca la hora sin tapar la barra. */}
                <div
                  aria-hidden
                  className={`absolute inset-0 rounded-sm transition-colors ${activa === h.hour ? 'bg-overlay/[0.035]' : ''}`}
                />

                {futura ? (
                  <div aria-hidden className="relative h-1.5 rounded-sm border border-dashed border-overlay/10" />
                ) : (
                  <div
                    aria-hidden
                    className={`relative flex origin-bottom flex-col-reverse overflow-hidden rounded-t-[3px] transition-opacity duration-200 ${
                      tenue ? 'opacity-45' : ''
                    }`}
                    style={{
                      height: `${Math.max(pct, v > 0 ? 2 : 0)}%`,
                      animation: `vph-crece 560ms cubic-bezier(0.32, 0.72, 0, 1) ${h.hour * 18}ms backwards`,
                    }}
                  >
                    {medida === 'importe' && v > 0 ? (
                      funnelsConColor.map((f) => {
                        const parte = h.perFunnel[f.slug] ?? 0;
                        if (parte <= 0) return null;
                        return <div key={f.slug} style={{ height: `${(parte / v) * 100}%`, backgroundColor: f.color }} />;
                      })
                    ) : (
                      <div className="h-full bg-good-500" />
                    )}
                  </div>
                )}

                {/* El mismo horario del período anterior: una raya, no una
                    barra, para que no compita con la de ahora. */}
                {pctPrev !== null && pctPrev > 0 && !futura && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-x-[18%] h-[2px] rounded-full bg-neutral-400/55"
                    style={{ bottom: `calc(${pctPrev}% - 1px)` }}
                  />
                )}

                {esPico && activa === null && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute left-1/2 hidden -translate-x-1/2 whitespace-nowrap font-mono text-[10px] font-medium text-good-300 panel:block"
                    style={{ bottom: `calc(${pct}% + 4px)` }}
                  >
                    {medida === 'importe' ? fmtAxis(v) : fmtInt(v)}
                  </span>
                )}

                {esAhora && (
                  <span aria-hidden className="pointer-events-none absolute -bottom-[3px] left-1/2 flex h-1.5 w-1.5 -translate-x-1/2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-good-400 opacity-60" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-good-400" />
                  </span>
                )}
              </div>
            );
          })}

          {activa !== null && (
            <TooltipHora
              h={horas[activa]!}
              medida={medida}
              fmt={fmt}
              data={data}
              futura={enCurso !== null && activa > enCurso}
            />
          )}
        </div>

        {/* El eje: las 24 horas en desktop, cada 3 en mobile. */}
        <div aria-hidden className="mt-2 flex gap-[3px] border-t border-overlay/[0.08] pt-1.5 panel:gap-1">
          {horas.map((h) => (
            <span
              key={h.hour}
              className={`min-w-0 flex-1 text-center font-mono text-[10px] tabular-nums ${
                enCurso === h.hour
                  ? 'font-semibold text-good-300'
                  : activa === h.hour
                    ? 'text-neutral-200'
                    : h.hour % 3 === 0
                      ? 'text-neutral-500'
                      : 'invisible text-neutral-700 panel:visible'
              }`}
            >
              {hh(h.hour)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function TooltipHora({
  h,
  medida,
  fmt,
  data,
  futura,
}: {
  h: OverviewData['byHour'][number];
  medida: MedidaHora;
  fmt: (v: number) => string;
  data: OverviewData;
  futura: boolean;
}): JSX.Element {
  const v = valorHora(h, medida);
  const p = valorPrevHora(h, medida);
  // Anclado sobre la columna y recortado a los bordes: a las 00 y a las 23 un
  // tooltip centrado se saldría de la tarjeta.
  const centro = ((h.hour + 0.5) / 24) * 100;
  const bandas = data.funnels.filter((f) => (h.perFunnel[f.slug] ?? 0) > 0);

  return (
    <div
      role="status"
      className="pointer-events-none absolute top-0 z-20 w-52 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-xs shadow-float"
      style={{ left: `clamp(0px, calc(${centro}% - 104px), calc(100% - 208px))` }}
    >
      <p className="mb-1 font-mono font-semibold text-neutral-100">
        {hh(h.hour)}:00 – {hh(h.hour)}:59
      </p>
      {futura ? (
        <p className="text-neutral-500">Todavía no llegó esta hora.</p>
      ) : (
        <>
          <p className="flex justify-between gap-3 tabular-nums text-neutral-200">
            <span>{medida === 'importe' ? 'Bruto' : 'Órdenes'}</span>
            <span className="font-mono">{fmt(v)}</span>
          </p>
          {medida === 'importe' && (
            <p className="flex justify-between gap-3 tabular-nums text-neutral-400">
              <span>Órdenes</span>
              <span className="font-mono">{fmtInt(h.orders)}</span>
            </p>
          )}
          {p !== null && (
            <p className="flex justify-between gap-3 tabular-nums text-neutral-500">
              <span>Período anterior</span>
              <span className="font-mono">{fmt(p)}</span>
            </p>
          )}
          {medida === 'importe' && bandas.length > 0 && (
            <div className="mt-1.5 space-y-0.5 border-t border-divider pt-1.5">
              {bandas.map((f) => (
                <p key={f.slug} className="flex items-center justify-between gap-3 tabular-nums">
                  <span className="flex min-w-0 items-center gap-1.5 text-neutral-400">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: f.color }} />
                    <span className="truncate">{f.name}</span>
                  </span>
                  <span className="font-mono text-neutral-300">{fmtMoney(h.perFunnel[f.slug] ?? 0, data.moneda)}</span>
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
