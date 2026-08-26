'use client';

/**
 * ChipCascada (task 20.1): el indicador visible del Filtro_Cascada, con su
 * texto y su control de limpieza (R8 c4, c5, c6).
 *
 * - Con 1 id: `Conjuntos de "«nombre»"`, nombre recortado a 40 caracteres y el
 *   id como respaldo cuando el nombre no está disponible.
 * - Con 2..50 ids: `Conjuntos de "«nombre»" +N`, donde N es la cantidad de
 *   identificadores restantes.
 * - Siempre lleva el control de limpieza, que vacía el Filtro_Cascada sin tocar
 *   el Nivel_Activo ni los demás filtros.
 */

import { X } from '@phosphor-icons/react';
import type { Cascada } from '@/lib/ads/seleccion';

const NIVEL_DE: Record<Cascada['nivel'], string> = {
  campaign: 'Conjuntos de',
  adset: 'Anuncios de',
};

export function ChipCascada({
  cascada,
  nombres,
  onLimpiar,
}: {
  cascada: Cascada;
  /** id → nombre del objeto padre, de las filas ya cargadas. */
  nombres: ReadonlyMap<string, string>;
  onLimpiar: () => void;
}): JSX.Element {
  if (cascada.ids.length === 0) return <></>;

  const primero = cascada.ids[0]!;
  const nombre = (nombres.get(primero) ?? primero).slice(0, 40);
  const resto = cascada.ids.length - 1;
  const texto = `${NIVEL_DE[cascada.nivel]} "${nombre}"${resto > 0 ? ` +${resto}` : ''}`;

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-good-500/30 bg-good-500/10 px-3 py-1 text-xs font-semibold text-good-200">
      <span title={cascada.ids.join(', ')}>{texto}</span>
      {cascada.descartados > 0 && (
        <span className="text-[10px] font-normal text-neutral-400" title={`Se descartaron ${cascada.descartados} identificadores (motivo: ${cascada.motivo ?? 'tope'})`}>
          −{cascada.descartados}
        </span>
      )}
      <button
        type="button"
        onClick={onLimpiar}
        aria-label="Limpiar el filtro de cascada"
        title="Limpiar el filtro de cascada"
        className="rounded-full p-0.5 text-good-300 transition-colors hover:bg-good-500/20 hover:text-good-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-good-500/60"
      >
        <X size={12} weight="bold" />
      </button>
    </span>
  );
}
