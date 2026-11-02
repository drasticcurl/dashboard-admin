'use client';

/**
 * FunnelsElegidos — el widget "Funnels" del Resumen: TODOS los funnels que
 * tuvieron actividad en el rango (ventas, devoluciones, gasto o neto), en una
 * grilla que ocupa todo el ancho, en PC y en el celu.
 *
 * Por qué todos: desde el 2026-11-02 el usuario quiere ver todos los que
 * vendieron o gastaron en el rango, sin tener que elegir. Se sacó el picker de
 * hasta cuatro, con su guardado en localStorage. Los funnels sin nada en el
 * rango no entran: una tarjeta de ceros no le dice nada a quien mira.
 *
 * El orden es el de `data.funnels`, que ya viene por neto: el que más vende,
 * arriba. Si el widget es más bajo que la lista, la lista scrollea adentro en
 * vez de cortarse.
 */

import Link from 'next/link';
import { fmtInt, fmtMoney, fmtPct } from '@/components/ui';
import type { FunnelSummary, OverviewData } from '@/lib/queries/overview';
import type { MonedaReporte } from '@/lib/moneda-reporte';
import type { WidgetSize } from '@/lib/widgets/tipos';

/** Un funnel tiene datos si en el rango hubo algo que contar: órdenes (aunque
 *  estén devueltas), gasto de ads, o un neto distinto de cero. */
export function tieneDatos(f: FunnelSummary): boolean {
  return f.orders > 0 || f.ordersRefunded > 0 || f.adSpendEur > 0 || f.netEur !== 0;
}

export function FunnelsElegidos({ data }: { data: OverviewData; size: WidgetSize }): JSX.Element {
  // Se conserva el orden de `data.funnels` (por neto), igual que en el resto del Resumen.
  const visibles = data.funnels.filter(tieneDatos);

  return (
    <div className="flex h-full min-w-0 flex-col gap-2.5">
      <span className="text-[11px] uppercase tracking-[0.08em] text-neutral-500">
        {visibles.length} con datos de {data.funnels.length}
      </span>

      {/* Columnas de 190px como mínimo y el resto del ancho se reparte: en PC
          llena la fila, en el celu queda una o dos por fila. `items-start` deja
          que cada tarjeta mida lo suyo, sin estirarse a la altura de la fila. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {visibles.length === 0 ? (
          <p className="text-xs text-neutral-500">Ningún funnel tuvo ventas ni gasto en este rango.</p>
        ) : (
          <div
            className="grid items-start gap-2"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}
          >
            {visibles.map((f) => (
              <TarjetaCompacta key={f.slug} f={f} moneda={data.moneda} />
            ))}
          </div>
        )}
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
          className="min-w-0 truncate rounded-sm text-xs font-semibold text-neutral-200 decoration-acento-400 transition-colors hover:text-neutral-50 hover:underline hover:underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-acento-500/60"
          title={`${f.name} — ver ventas`}
        >
          {f.name}
        </Link>
        <Link
          href={`/embudo?f=${f.slug}`}
          className="shrink-0 rounded px-1 text-[11px] font-medium text-neutral-500 transition-colors hover:text-acento-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-acento-500/60"
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
