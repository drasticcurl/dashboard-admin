'use client';

/**
 * BarraSeleccion (task 20.3): la cantidad exacta de objetos de la
 * Seleccion_Activa, el nombre del Nivel_Activo y únicamente las Accion_Lote
 * habilitadas para ese nivel (R9 c7, R11 c1, R13 c10, R10 c14). Oculto con 0
 * objetos (R9 c11): los controles no existen hasta que hay selección.
 */

import type { NivelAds } from '@/lib/ads/tipos';
import { MAX_SELECCION } from '@/lib/ads/seleccion';
import type { AccionAds } from '@/lib/ads/tipos';
import { ROTULO_ACCION } from '@/lib/ads/previsualizacion';

const NIVEL_LABEL: Record<NivelAds, string> = {
  campaign: 'campañas',
  adset: 'conjuntos',
  ad: 'anuncios',
};

/** Las Accion_Lote habilitadas por nivel. Un nivel no listado no las muestra. */
const ACCIONES_POR_NIVEL: Record<NivelAds, AccionAds[]> = {
  campaign: ['pause', 'activate', 'duplicate'],
  adset: ['pause', 'activate', 'budget_set', 'duplicate', 'schedule', 'rename'],
  ad: ['pause', 'activate', 'rename'],
};

const TONO_ACCION: Partial<Record<AccionAds, string>> = {
  pause: 'text-warn-300',
  activate: 'text-good-300',
  duplicate: 'text-info-300',
};

export function BarraSeleccion({
  nivel,
  cantidad,
  topeAlcanzado,
  onAccion,
}: {
  nivel: NivelAds;
  cantidad: number;
  /** true cuando la selección llegó a 100 y el tilde 101 se bloqueó (R9 c10). */
  topeAlcanzado: boolean;
  onAccion: (accion: AccionAds) => void;
}): JSX.Element {
  if (cantidad === 0) return <></>;

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border-strong bg-overlay/4 px-2 py-1">
      <span className="text-xs text-neutral-400">
        <span className="font-semibold text-neutral-100">{cantidad}</span> {NIVEL_LABEL[nivel]} seleccionadas
      </span>
      {topeAlcanzado && (
        <span className="text-xs text-warn-300" title={`Tope de ${MAX_SELECCION} objetos por Accion_Lote`}>
          (tope de {MAX_SELECCION})
        </span>
      )}
      {ACCIONES_POR_NIVEL[nivel].map((a) => (
        <button
          key={a}
          type="button"
          onClick={() => onAccion(a)}
          className={`rounded px-2 py-0.5 text-xs font-semibold hover:bg-overlay/6 focus:outline-none focus-visible:ring-2 focus-visible:ring-good-500/60 ${
            TONO_ACCION[a] ?? 'text-neutral-200'
          }`}
        >
          {ROTULO_ACCION[a]}
        </button>
      ))}
    </div>
  );
}
