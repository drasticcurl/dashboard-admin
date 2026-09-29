'use client';

/**
 * VentasPorHora — el widget de ancho completo del Resumen: las 24 horas del
 * día como una tira, para ver a qué hora se gana y a qué hora se pierde plata.
 *
 * Sigue la regla 2 de lib/widgets/tipos.ts: no hace fetch, recibe
 * `OverviewData` ya cargado. El único estado es de vista (resultado o ventas,
 * y qué hora está bajo el puntero).
 *
 * Dos medidas:
 *  · Resultado (la de arranque): neto − gasto en ads de cada hora. La barra
 *    sube en verde si la hora ganó plata y baja en rojo si perdió, desde una
 *    línea de cero. El gasto por hora sale de la migración 036 (ver
 *    lib/queries/gasto-hora.ts); los días anteriores reparten el del día parejo.
 *  · Ventas: el bruto aprobado, apilado por funnel con su color.
 *
 * Qué dice cada marca, porque todas son dato y ninguna es adorno:
 *  · la rayita gris, el mismo horario del período anterior de igual largo;
 *  · el punto verde que late, la hora en curso (sólo si el rango termina hoy);
 *  · las horas que todavía no pasaron, punteadas: un 0 a las 23 cuando son
 *    las 14 no es "no vendió", es "no llegó".
 *
 * Tiene que entrar ENTERO en 1 fila (240px de tarjeta): nada de scroll. Por
 * eso las lecturas van en una grilla de 2×2 al costado y no apiladas.
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
  horaPeor,
  horaPico,
  mejorFranja,
  valorHora,
  valorPrevHora,
} from '@/lib/widgets/ventas-por-hora';

// La animación de entrada: las barras crecen desde la línea de cero, de la
// medianoche a la noche, 18ms entre hora y hora. `backwards` y no `both` por lo
// mismo que `.reveal` en globals.css (un transform que queda aplicado crea
// containing block). Con prefers-reduced-motion la regla global la deja en 0.
const KEYFRAMES = `@keyframes vph-crece{from{transform:scaleY(0);opacity:.2}to{transform:scaleY(1);opacity:1}}`;

const ETIQUETA = 'text-[11px] uppercase tracking-[0.08em] text-neutral-500';

function tono(v: number): string {
  return v > 0 ? 'text-good-400' : v < 0 ? 'text-bad-400' : 'text-neutral-300';
}

export function VentasPorHora({ data, size }: { data: OverviewData; size: WidgetSize }): JSX.Element {
  const [medida, setMedida] = useState<MedidaHora>('resultado');
  const [activa, setActiva] = useState<number | null>(null);

  const horas = data.byHour;
  const hasta = data.byDay[data.byDay.length - 1]?.day ?? data.ahora.day;
  const enCurso = horaEnCurso(hasta, data.ahora);
  const dias = data.byDay.length;
  const esResultado = medida === 'resultado';

  const { arriba, abajo, total, totalPrev } = useMemo(() => {
    let arriba = 0;
    let abajo = 0;
    let total = 0;
    let totalPrev: number | null = null;
    for (const h of horas) {
      const v = valorHora(h, medida);
      const p = valorPrevHora(h, medida);
      total += v;
      if (p !== null) totalPrev = (totalPrev ?? 0) + p;
      arriba = Math.max(arriba, v, p ?? 0);
      abajo = Math.max(abajo, -v, -(p ?? 0));
    }
    return { arriba, abajo, total, totalPrev };
  }, [horas, medida]);

  const fmt = (v: number): string => fmtMoney(v, data.moneda);
  const rango = arriba + abajo;
  // Dónde cae el cero, en % desde abajo. Sin negativos es el piso, como un
  // gráfico de barras común; con pérdidas sube lo justo para que entren.
  const cero = rango > 0 ? (abajo / rango) * 100 : 0;
  const alto = (v: number): number => (rango > 0 ? (Math.abs(v) / rango) * 100 : 0);

  const pico = horaPico(horas, medida);
  const peor = horaPeor(horas, medida);
  const franja = esResultado ? null : mejorFranja(horas, medida);
  const variacion =
    totalPrev !== null && totalPrev !== 0 ? ((total - totalPrev) / Math.abs(totalPrev)) * 100 : null;
  const pasadas = horas.filter((h) => enCurso === null || h.hour <= enCurso);
  const enRojo = pasadas.filter((h) => h.resultEur < 0).length;
  const ordenes = horas.reduce((a, h) => a + h.orders, 0);
  const gasto = horas.reduce((a, h) => a + h.adSpendEur, 0);

  return (
    <div className="flex h-full min-w-0 flex-col gap-3 panel:flex-row panel:gap-5">
      <style>{KEYFRAMES}</style>

      {/* ── Las lecturas ──────────────────────────────────────────────────── */}
      <div className="flex shrink-0 flex-col gap-2.5 panel:w-64">
        <div
          role="radiogroup"
          aria-label="Qué medir"
          className="inline-flex w-fit rounded-lg border border-border-subtle bg-canvas p-0.5 text-xs font-medium"
        >
          {(['resultado', 'ventas'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={medida === m}
              onClick={() => setMedida(m)}
              className={`rounded-md px-2.5 py-1 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-good-500/60 ${
                medida === m
                  ? 'bg-surface-raised text-neutral-50 shadow-inset-highlight'
                  : 'text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {m === 'resultado' ? 'Ganancia / pérdida' : 'Ventas'}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          <Lectura etiqueta={dias === 1 ? (esResultado ? 'Resultado' : 'Vendido') : `${fmtInt(dias)} días`}>
            <span className={esResultado ? tono(total) : 'text-neutral-100'}>{fmt(total)}</span>
            {variacion !== null && (
              <span
                title="Contra las mismas horas del período anterior de igual largo"
                className={`ml-1.5 inline-flex items-center gap-0.5 text-[11px] font-semibold ${
                  variacion >= 0 ? 'text-good-400' : 'text-bad-400'
                }`}
              >
                {variacion >= 0 ? (
                  <TrendUp size={11} weight="bold" aria-hidden />
                ) : (
                  <TrendDown size={11} weight="bold" aria-hidden />
                )}
                {fmtPct(Math.abs(variacion), 0)}
              </span>
            )}
          </Lectura>

          {esResultado ? (
            <>
              <Lectura etiqueta="Gasto en ads">
                <span className="text-neutral-300">{fmt(gasto)}</span>
              </Lectura>
              <Lectura etiqueta="Mejor hora">
                {pico === null ? (
                  '—'
                ) : (
                  <>
                    {hh(pico)} h <span className="ml-1 text-good-400">{fmtAxis(valorHora(horas[pico]!, medida))}</span>
                  </>
                )}
              </Lectura>
              <Lectura etiqueta="Horas en rojo">
                {peor === null ? (
                  <span className="text-good-400">ninguna</span>
                ) : (
                  <>
                    <span className="text-bad-400">{fmtInt(enRojo)}</span>
                    <span className="text-neutral-500"> de {fmtInt(pasadas.length)}</span>
                  </>
                )}
              </Lectura>
            </>
          ) : (
            <>
              <Lectura etiqueta="Órdenes">{fmtInt(ordenes)}</Lectura>
              <Lectura etiqueta="Hora pico">
                {pico === null ? (
                  '—'
                ) : (
                  <>
                    {hh(pico)} h <span className="ml-1 text-good-400">{fmtAxis(valorHora(horas[pico]!, medida))}</span>
                  </>
                )}
              </Lectura>
              <Lectura etiqueta="Mejor franja">
                {franja === null ? (
                  '—'
                ) : (
                  <>
                    {hh(franja.desde)}–{hh(franja.hasta)}
                    <span className="ml-1 text-neutral-500">{fmtPct(franja.parte * 100, 0)}</span>
                  </>
                )}
              </Lectura>
            </>
          )}
        </div>
      </div>

      {/* ── La tira de 24 horas ───────────────────────────────────────────── */}
      <div className={`relative flex min-h-0 min-w-0 flex-1 flex-col ${size.h === 2 ? 'h-72' : 'h-36'} panel:h-auto`}>
        {rango === 0 && (
          <p className="pointer-events-none absolute inset-x-0 top-1/3 z-10 text-center text-xs text-neutral-500">
            {enCurso !== null ? 'Todavía no hay movimiento hoy.' : 'Sin movimiento en el rango.'}
          </p>
        )}

        <div className="relative flex min-h-0 flex-1 gap-[3px] panel:gap-1" onPointerLeave={() => setActiva(null)}>
          {/* La línea de cero: la que separa ganar de perder. */}
          <div
            aria-hidden
            className={`pointer-events-none absolute inset-x-0 z-[1] h-px ${
              abajo > 0 ? 'bg-overlay/25' : 'bg-overlay/[0.08]'
            }`}
            style={{ bottom: `${cero}%` }}
          />

          {horas.map((h) => {
            const v = valorHora(h, medida);
            const p = valorPrevHora(h, medida);
            const futura = enCurso !== null && h.hour > enCurso;
            const esAhora = enCurso === h.hour;
            const tenue = activa !== null && activa !== h.hour;
            const positivo = v >= 0;

            return (
              <div
                key={h.hour}
                tabIndex={0}
                role="img"
                aria-label={`${hh(h.hour)}:00 — ${esResultado ? (v >= 0 ? 'ganó' : 'perdió') : 'vendió'} ${fmt(Math.abs(v))}${
                  p !== null ? `, período anterior ${fmt(p)}` : ''
                }${futura ? ', todavía no pasó' : ''}`}
                onPointerEnter={() => setActiva(h.hour)}
                onFocus={() => setActiva(h.hour)}
                onBlur={() => setActiva(null)}
                className="relative h-full min-w-0 flex-1 cursor-default rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-good-500/60"
              >
                <div
                  aria-hidden
                  className={`absolute inset-0 rounded-sm transition-colors ${activa === h.hour ? 'bg-overlay/[0.035]' : ''}`}
                />

                {futura ? (
                  <div
                    aria-hidden
                    className="absolute inset-x-0 h-1.5 rounded-sm border border-dashed border-overlay/10"
                    style={{ bottom: `calc(${cero}% - 3px)` }}
                  />
                ) : (
                  v !== 0 && (
                    <div
                      aria-hidden
                      className={`absolute inset-x-0 flex overflow-hidden transition-opacity duration-200 ${
                        positivo ? 'origin-bottom flex-col-reverse rounded-t-[3px]' : 'origin-top flex-col rounded-b-[3px]'
                      } ${tenue ? 'opacity-45' : ''}`}
                      style={{
                        ...(positivo ? { bottom: `${cero}%` } : { top: `${100 - cero}%` }),
                        height: `${Math.max(alto(v), 1.5)}%`,
                        animation: `vph-crece 560ms cubic-bezier(0.32, 0.72, 0, 1) ${h.hour * 18}ms backwards`,
                      }}
                    >
                      {esResultado ? (
                        <div className={`h-full ${positivo ? 'bg-good-500' : 'bg-bad-500'}`} />
                      ) : (
                        data.funnels.map((f) => {
                          const parte = h.perFunnel[f.slug] ?? 0;
                          if (parte <= 0) return null;
                          return <div key={f.slug} style={{ height: `${(parte / v) * 100}%`, backgroundColor: f.color }} />;
                        })
                      )}
                    </div>
                  )
                )}

                {/* El mismo horario del período anterior: una raya, no una
                    barra, para que no compita con la de ahora. */}
                {p !== null && p !== 0 && !futura && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-x-[18%] z-[2] h-[2px] rounded-full bg-neutral-400/55"
                    style={{ bottom: `calc(${p >= 0 ? cero + alto(p) : cero - alto(p)}% - 1px)` }}
                  />
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
              data={data}
              futura={enCurso !== null && activa > enCurso}
            />
          )}
        </div>

        {/* El eje: las 24 horas en desktop, cada 3 en mobile. */}
        <div aria-hidden className="mt-1.5 flex gap-[3px] border-t border-overlay/[0.08] pt-1 panel:gap-1">
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

function Lectura({ etiqueta, children }: { etiqueta: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="min-w-0">
      <p className={ETIQUETA}>{etiqueta}</p>
      <p className="num truncate font-mono text-sm font-medium text-neutral-100">{children}</p>
    </div>
  );
}

function Fila({ label, valor, cls = 'text-neutral-200' }: { label: string; valor: string; cls?: string }): JSX.Element {
  return (
    <p className={`flex justify-between gap-3 tabular-nums ${cls}`}>
      <span>{label}</span>
      <span className="font-mono">{valor}</span>
    </p>
  );
}

function TooltipHora({
  h,
  medida,
  data,
  futura,
}: {
  h: OverviewData['byHour'][number];
  medida: MedidaHora;
  data: OverviewData;
  futura: boolean;
}): JSX.Element {
  const fmt = (v: number): string => fmtMoney(v, data.moneda);
  const p = valorPrevHora(h, medida);
  // Anclado sobre la columna y recortado a los bordes: a las 00 y a las 23 un
  // tooltip centrado se saldría de la tarjeta.
  const centro = ((h.hour + 0.5) / 24) * 100;
  const esResultado = medida === 'resultado';
  const porFunnel = esResultado ? h.resultPerFunnel : h.perFunnel;
  const bandas = data.funnels.filter((f) => (porFunnel[f.slug] ?? 0) !== 0);

  return (
    <div
      role="status"
      className="pointer-events-none absolute top-0 z-20 w-56 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-xs shadow-float"
      style={{ left: `clamp(0px, calc(${centro}% - 112px), calc(100% - 224px))` }}
    >
      <p className="mb-1 font-mono font-semibold text-neutral-100">
        {hh(h.hour)}:00 – {hh(h.hour)}:59
      </p>
      {futura ? (
        <p className="text-neutral-500">Todavía no llegó esta hora.</p>
      ) : (
        <>
          {esResultado ? (
            <>
              <Fila label="Neto" valor={fmt(h.netEur)} cls="text-neutral-300" />
              <Fila label="Gasto en ads" valor={`− ${fmt(h.adSpendEur)}`} cls="text-neutral-400" />
              <p className={`mt-0.5 flex justify-between gap-3 border-t border-divider pt-0.5 font-semibold tabular-nums ${tono(h.resultEur)}`}>
                <span>{h.resultEur >= 0 ? 'Ganó' : 'Perdió'}</span>
                <span className="font-mono">{fmt(Math.abs(h.resultEur))}</span>
              </p>
            </>
          ) : (
            <>
              <Fila label="Bruto" valor={fmt(h.grossEur)} />
              <Fila label="Órdenes" valor={fmtInt(h.orders)} cls="text-neutral-400" />
            </>
          )}
          {p !== null && <Fila label="Período anterior" valor={fmt(p)} cls="text-neutral-500" />}
          {bandas.length > 0 && (
            <div className="mt-1.5 space-y-0.5 border-t border-divider pt-1.5">
              {bandas.map((f) => {
                const v = porFunnel[f.slug] ?? 0;
                return (
                  <p key={f.slug} className="flex items-center justify-between gap-3 tabular-nums">
                    <span className="flex min-w-0 items-center gap-1.5 text-neutral-400">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: f.color }} />
                      <span className="truncate">{f.name}</span>
                    </span>
                    <span className={`font-mono ${esResultado ? tono(v) : 'text-neutral-300'}`}>{fmt(v)}</span>
                  </p>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
