'use client';

/**
 * Paginacion (task 20.1): la página vigente y el total de páginas alcanzadas
 * por los filtros vigentes, con el retroceso desactivado en la primera página y
 * el avance en la última (R4 c10).
 */

import { CaretLeft, CaretRight } from '@phosphor-icons/react';

export function Paginacion({
  pagina,
  totalPaginas,
  onPagina,
}: {
  pagina: number;
  totalPaginas: number;
  onPagina: (pagina: number) => void;
}): JSX.Element {
  if (totalPaginas <= 1) return <></>;

  return (
    <div className="mt-3 flex items-center justify-center gap-3">
      <button
        type="button"
        onClick={() => onPagina(pagina - 1)}
        disabled={pagina <= 1}
        aria-label="Página anterior"
        className="inline-flex items-center gap-1 rounded-md border border-border-strong px-2 py-1 text-xs font-semibold text-neutral-300 transition-colors hover:bg-overlay/6 focus:outline-none focus-visible:ring-2 focus-visible:ring-good-500/60 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <CaretLeft size={12} weight="bold" /> Anterior
      </button>
      <span className="text-xs text-neutral-400">
        Página <span className="font-semibold text-neutral-200">{pagina}</span> de{' '}
        <span className="font-semibold text-neutral-200">{totalPaginas}</span>
      </span>
      <button
        type="button"
        onClick={() => onPagina(pagina + 1)}
        disabled={pagina >= totalPaginas}
        aria-label="Página siguiente"
        className="inline-flex items-center gap-1 rounded-md border border-border-strong px-2 py-1 text-xs font-semibold text-neutral-300 transition-colors hover:bg-overlay/6 focus:outline-none focus-visible:ring-2 focus-visible:ring-good-500/60 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Siguiente <CaretRight size={12} weight="bold" />
      </button>
    </div>
  );
}
