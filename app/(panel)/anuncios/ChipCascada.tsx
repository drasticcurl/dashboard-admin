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
import type { NivelAds } from '@/lib/ads/tipos';

const NIVEL_DE: Record<Cascada['nivel'], string> = {
  campaign: 'Conjuntos de',
  adset: 'Anuncios de',
};

/**
 * El rótulo del chip.
 *
 * `NIVEL_DE` nombra a los HIJOS del nivel de la cascada, que es lo correcto
 * mientras el nivel activo esté debajo: parado en conjuntos con una cascada de
 * campaña, «Conjuntos de "X"» describe exactamente lo que hay en la tabla.
 *
 * El caso que la task 13.4 de `toggle-conjuntos-entrega` agrega es el de estar
 * **en el mismo nivel que la cascada**: `subirACampania` deja
 * `level=campaign&campaignIds=<id>`, o sea el nivel campaña filtrado a una
 * campaña. Ahí la tabla no muestra los conjuntos de X, muestra X, y el rótulo
 * viejo diría «Conjuntos de "X"» sobre una tabla de una sola campaña.
 *
 * Se decide con `nivelActivo === cascada.nivel` y no con `nivelActivo ===
 * 'campaign'`: lo que hace raro al rótulo no es la campaña, es que el nivel de la
 * cascada y el nivel de la tabla coincidan.
 *
 * Pura y exportada por el mismo criterio que `dibujoDeEstado` y `senalDeEntrega`:
 * vitest corre en node y sin render, así que la única forma de tener el rótulo
 * bajo test es que sea una función y no una expresión adentro del JSX.
 */
export function rotuloCascada(cascada: Cascada, nivelActivo: NivelAds, nombre: string): string {
  if (nivelActivo === cascada.nivel) {
    return cascada.nivel === 'campaign' ? `La campaña "${nombre}"` : `El conjunto "${nombre}"`;
  }
  return `${NIVEL_DE[cascada.nivel]} "${nombre}"`;
}

export function ChipCascada({
  cascada,
  nivelActivo,
  nombres,
  onLimpiar,
}: {
  cascada: Cascada;
  /** El Nivel_Activo de la tabla: decide el rótulo cuando coincide con el de la cascada. */
  nivelActivo: NivelAds;
  /** id → nombre del objeto padre, de las filas ya cargadas. */
  nombres: ReadonlyMap<string, string>;
  onLimpiar: () => void;
}): JSX.Element {
  if (cascada.ids.length === 0) return <></>;

  const primero = cascada.ids[0]!;
  const nombre = (nombres.get(primero) ?? primero).slice(0, 40);
  const resto = cascada.ids.length - 1;
  const texto = `${rotuloCascada(cascada, nivelActivo, nombre)}${resto > 0 ? ` +${resto}` : ''}`;

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
