'use client';

/**
 * BarraFrescura (task 20.1): la Marca_Frescura y el Boton_Actualizar, alineados
 * a la derecha, entre Tabs_Nivel y Barra_Filtros (R1 c6..c11).
 *
 * - La Marca_Frescura dice la antigüedad del gasto guardado en minutos enteros
 *   mientras sea menor a 60 minutos, en horas enteras a partir de 60, y un
 *   texto propio cuando nunca se obtuvo gasto (R1 c6).
 * - El Boton_Actualizar dispara `onActualizar`; el freno de un refresco cada
 *   10 segundos es del llamador (useRef con el timestamp del disparo), que pasa
 *   `segundosRestantes` entre 1 y 10 para informarlo sin llamar a nada (R1 c10,
 *   c11).
 * - Mientras el refresco está en curso el botón queda deshabilitado con un
 *   indicador de carga, y las filas y la marca previas siguen visibles (R1 c8).
 */

import { Spinner } from '@/components/ui';

export function BarraFrescura({
  edad,
  error,
  refrescando,
  segundosRestantes,
  onActualizar,
}: {
  /** Texto ya resuelto de la Marca_Frescura (el Gestor lo arma con FrescuraAds). */
  edad: string;
  error: string | null;
  refrescando: boolean;
  /** null = sin freno activo; 1..10 = segundos que faltan para el próximo disparo. */
  segundosRestantes: number | null;
  onActualizar: () => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-neutral-400">
        gasto {edad}
        {error && <span className="ml-1 text-amber-400">({error})</span>}
      </span>
      <button
        type="button"
        onClick={onActualizar}
        disabled={refrescando || segundosRestantes !== null}
        className="inline-flex items-center gap-1.5 rounded-md border border-border-strong px-2.5 py-1.5 text-xs font-semibold text-neutral-200 transition-colors hover:bg-overlay/6 focus:outline-none focus-visible:ring-2 focus-visible:ring-good-500/60 disabled:cursor-not-allowed disabled:opacity-50"
        title={
          segundosRestantes !== null
            ? `Esperá ${segundosRestantes} segundo${segundosRestantes === 1 ? '' : 's'} para volver a actualizar`
            : 'Forzar un refresco del gasto (ignora el TTL)'
        }
      >
        {refrescando ? <Spinner /> : null}
        {refrescando
          ? 'Actualizando…'
          : segundosRestantes !== null
            ? `Actualizar (${segundosRestantes}s)`
            : 'Actualizar'}
      </button>
    </div>
  );
}
