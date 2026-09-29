'use client';

/**
 * FunnelsElegidos — el widget "Funnels" del Resumen en su versión compacta:
 * hasta TRES funnels elegidos por el usuario, uno debajo del otro en 1×2 o uno
 * al lado del otro en 2×1.
 *
 * Por qué un tope de 3: el widget antes mostraba TODOS los funnels en 2×2 con
 * scroll, y los que no venden (los que están en 0) empujaban a los que sí fuera
 * de la vista. Con 3 tarjetas el widget entra en 1×2 sin scroll.
 *
 * La elección se guarda en localStorage, por navegador: es una preferencia de
 * vista de quien mira, no parte del layout compartido (que se guarda en la VPS
 * y lo ven todos). Sin nada guardado, o si lo guardado ya no existe, van los 3
 * que más neto hicieron en el rango (`data.funnels` ya viene ordenado por neto).
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Check, SlidersHorizontal } from '@phosphor-icons/react';
import { fmtInt, fmtMoney, fmtPct } from '@/components/ui';
import type { FunnelSummary, OverviewData } from '@/lib/queries/overview';
import type { MonedaReporte } from '@/lib/moneda-reporte';
import type { WidgetSize } from '@/lib/widgets/tipos';

const CLAVE = 'resumen.funnels.elegidos';
const MAXIMO = 3;

function leerGuardados(): string[] | null {
  try {
    const raw = window.localStorage.getItem(CLAVE);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null;
  } catch {
    return null;
  }
}

function guardar(slugs: string[]): void {
  try {
    window.localStorage.setItem(CLAVE, JSON.stringify(slugs));
  } catch {
    // Navegador sin storage (modo privado estricto): la elección dura lo que la pestaña.
  }
}

export function FunnelsElegidos({ data, size }: { data: OverviewData; size: WidgetSize }): JSX.Element {
  const [guardados, setGuardados] = useState<string[] | null>(null);
  const [abierto, setAbierto] = useState(false);

  // Se lee después de montar y no en el useState inicial: el server no tiene
  // localStorage, y leerlo en el primer render daría un HTML distinto al del
  // server (error de hidratación).
  useEffect(() => setGuardados(leerGuardados()), []);

  const existentes = new Set(data.funnels.map((f) => f.slug));
  const validos = (guardados ?? []).filter((s) => existentes.has(s)).slice(0, MAXIMO);
  const elegidos = validos.length > 0 ? validos : data.funnels.slice(0, MAXIMO).map((f) => f.slug);
  // En el orden de `data.funnels` (por neto) y no en el de los clicks: el que
  // más vende arriba, igual que en el resto del Resumen.
  const visibles = data.funnels.filter((f) => elegidos.includes(f.slug));

  function alternar(slug: string): void {
    const esta = elegidos.includes(slug);
    if (esta && elegidos.length === 1) return; // al menos uno: un widget vacío no dice nada
    if (!esta && elegidos.length >= MAXIMO) return;
    const nuevos = esta ? elegidos.filter((s) => s !== slug) : [...elegidos, slug];
    setGuardados(nuevos);
    guardar(nuevos);
  }

  const horizontal = size.h === 1;

  return (
    <div className="relative flex h-full min-w-0 flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-[0.08em] text-neutral-500">
          {visibles.length} de {data.funnels.length}
        </span>
        <button
          type="button"
          onClick={() => setAbierto((v) => !v)}
          aria-expanded={abierto}
          aria-haspopup="true"
          className="tap inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-2 py-1 text-xs font-medium text-neutral-300 transition-colors hover:bg-overlay/4 hover:text-neutral-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-good-500/60"
        >
          <SlidersHorizontal size={12} weight="bold" aria-hidden />
          Elegir
        </button>
      </div>

      {abierto && (
        <>
          <div className="fixed inset-0 z-20" aria-hidden="true" onClick={() => setAbierto(false)} />
          <div
            role="group"
            aria-label={`Elegí hasta ${MAXIMO} funnels`}
            className="absolute right-0 top-8 z-30 w-60 overflow-hidden rounded-xl border border-border-strong bg-surface-raised py-1 shadow-float"
          >
            <p className="px-3 pb-1 pt-1.5 text-[11px] text-neutral-500">Hasta {MAXIMO} a la vez</p>
            {data.funnels.map((f) => {
              const marcado = elegidos.includes(f.slug);
              const bloqueado = !marcado && elegidos.length >= MAXIMO;
              return (
                <button
                  key={f.slug}
                  type="button"
                  role="checkbox"
                  aria-checked={marcado}
                  disabled={bloqueado}
                  onClick={() => alternar(f.slug)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-200 transition-colors hover:bg-overlay/4 focus-visible:bg-overlay/4 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span
                    className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                      marcado ? 'border-good-500 bg-good-500 text-neutral-950' : 'border-border-strong'
                    }`}
                  >
                    {marcado && <Check size={10} weight="bold" />}
                  </span>
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: f.color }} />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <span className="font-mono text-[11px] tabular-nums text-neutral-500">
                    {fmtMoney(f.netEur, data.moneda)}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}

      {/* En 2×1 una columna por funnel elegido (2 o 3), todas del mismo ancho;
          en mobile, una debajo de la otra. En 1×2, filas del mismo alto. */}
      <div
        className={`grid min-h-0 flex-1 gap-2 ${horizontal ? 'panel:[grid-template-columns:repeat(var(--cols),minmax(0,1fr))]' : 'auto-rows-fr'}`}
        style={{ '--cols': Math.max(visibles.length, 1) } as React.CSSProperties}
      >
        {visibles.map((f) => (
          <TarjetaCompacta key={f.slug} f={f} moneda={data.moneda} />
        ))}
      </div>
    </div>
  );
}

/**
 * La tarjeta de un funnel, comprimida: lo que antes eran cinco líneas y dos
 * botones ahora son tres líneas, y el nombre entero es el link a Ventas (el
 * de Embudo queda como flecha chica). El orden de lectura es el mismo de antes:
 * neto → resultado → volumen.
 */
function TarjetaCompacta({ f, moneda }: { f: FunnelSummary; moneda: MonedaReporte }): JSX.Element {
  const resultadoCls =
    f.resultEur > 0 ? 'text-good-400' : f.resultEur < 0 ? 'text-bad-400' : 'text-neutral-400';
  return (
    <div
      className="relative flex min-w-0 flex-col justify-center overflow-hidden rounded-xl border border-border-subtle bg-canvas px-3 py-2"
      // Un filo del color del funnel a la izquierda: identifica la tarjeta sin
      // gastar una línea en el punto de color.
      style={{ boxShadow: `inset 2px 0 0 0 ${f.color}` }}
    >
      <div className="flex items-center justify-between gap-2">
        <Link
          href={`/ventas?f=${f.slug}`}
          className="min-w-0 truncate text-xs font-semibold text-neutral-200 hover:text-neutral-50 hover:underline hover:underline-offset-2"
          title={`${f.name} — ver ventas`}
        >
          {f.name}
        </Link>
        <Link
          href={`/embudo?f=${f.slug}`}
          className="shrink-0 rounded px-1 text-[11px] font-medium text-neutral-500 hover:text-neutral-200"
          title="Ver el embudo"
        >
          embudo →
        </Link>
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
        <span
          className="num font-mono text-lg font-medium -tracking-[0.02em] text-neutral-50"
          title={`${fmtMoney(f.netOrig, f.sellCurrency)} en su moneda`}
        >
          {fmtMoney(f.netEur, moneda)}
        </span>
        <span className={`font-mono text-xs font-semibold tabular-nums ${resultadoCls}`} title="Resultado: neto − gasto en ads">
          {f.resultEur > 0 ? '+' : ''}
          {fmtMoney(f.resultEur, moneda)}
        </span>
      </div>
      <p className="mt-0.5 truncate text-[11px] tabular-nums text-neutral-500">
        {f.roi === null ? 'sin ads' : `ROI ${f.roi.toFixed(2)}×`} · {fmtInt(f.orders)} órd · conv{' '}
        {fmtPct(f.convSessionToSale * 100, 1)}
      </p>
    </div>
  );
}
