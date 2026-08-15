'use client';

/**
 * FormularioRenombrar (task 25.2): los tres modos de lote del renombrado
 * (R12 c2): anteponer un prefijo (1..100), agregar un sufijo (1..100) o
 * reemplazar todas las apariciones de un texto (1..400, sensible a mayúsculas)
 * por otro (0..400). La Previsualizacion muestra por objeto el nombre actual y
 * el resultante, marcando los idénticos, los no ejecutables (vacío o >400) y
 * el nombre repetido entre hermanos como advertencia que no bloquea (R12 c6,
 * c7) — todo eso ya lo calcula `calcularPrevisualizacion`.
 */

import type { ModoRenombre } from '@/lib/ads/nombres';

export type ModoFormulario = 'prefijo' | 'sufijo' | 'reemplazo' | 'exacto';

export function FormularioRenombrar({
  modo,
  prefijo,
  sufijo,
  buscar,
  poner,
  nombreExacto,
  onModo,
  onPrefijo,
  onSufijo,
  onBuscar,
  onPoner,
  onNombreExacto,
}: {
  modo: ModoFormulario;
  prefijo: string;
  sufijo: string;
  buscar: string;
  poner: string;
  nombreExacto: string;
  onModo: (m: ModoFormulario) => void;
  onPrefijo: (s: string) => void;
  onSufijo: (s: string) => void;
  onBuscar: (s: string) => void;
  onPoner: (s: string) => void;
  onNombreExacto: (s: string) => void;
}): JSX.Element {
  const inputCls =
    'rounded border border-border-strong bg-overlay/4 px-2 py-1 text-sm text-neutral-100 focus:outline-none focus:ring-1 focus:ring-good-500/50';

  return (
    <div className="space-y-2 text-sm text-neutral-300">
      {modo === 'exacto' ? (
        <label className="flex items-center gap-2">
          <span>Nombre nuevo (1..400):</span>
          <input
            type="text"
            value={nombreExacto}
            maxLength={400}
            onChange={(e) => onNombreExacto(e.target.value)}
            className={`${inputCls} w-80`}
            aria-label="Nombre nuevo exacto"
          />
        </label>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="modo-renombre"
              checked={modo === 'prefijo'}
              onChange={() => onModo('prefijo')}
              className="h-3.5 w-3.5 accent-good-500"
            />
            Anteponer
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="modo-renombre"
              checked={modo === 'sufijo'}
              onChange={() => onModo('sufijo')}
              className="h-3.5 w-3.5 accent-good-500"
            />
            Agregar sufijo
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="modo-renombre"
              checked={modo === 'reemplazo'}
              onChange={() => onModo('reemplazo')}
              className="h-3.5 w-3.5 accent-good-500"
            />
            Reemplazar texto
          </label>
        </div>
      )}

      {modo === 'prefijo' && (
        <label className="flex items-center gap-2">
          <span>Prefijo (1..100):</span>
          <input
            type="text"
            value={prefijo}
            maxLength={100}
            onChange={(e) => onPrefijo(e.target.value)}
            className={`${inputCls} w-64`}
            aria-label="Prefijo"
          />
        </label>
      )}
      {modo === 'sufijo' && (
        <label className="flex items-center gap-2">
          <span>Sufijo (1..100):</span>
          <input
            type="text"
            value={sufijo}
            maxLength={100}
            onChange={(e) => onSufijo(e.target.value)}
            className={`${inputCls} w-64`}
            aria-label="Sufijo"
          />
        </label>
      )}
      {modo === 'reemplazo' && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2">
            <span>Buscar (sensible a mayúsculas):</span>
            <input
              type="text"
              value={buscar}
              maxLength={400}
              onChange={(e) => onBuscar(e.target.value)}
              className={`${inputCls} w-48`}
              aria-label="Texto a buscar"
            />
          </label>
          <label className="flex items-center gap-2">
            <span>Poner:</span>
            <input
              type="text"
              value={poner}
              maxLength={400}
              onChange={(e) => onPoner(e.target.value)}
              className={`${inputCls} w-48`}
              aria-label="Texto de reemplazo"
            />
          </label>
        </div>
      )}
    </div>
  );
}

/** El ModoRenombre del contrato, para la previsualización y el POST. */
export function modoDeFormulario(
  modo: ModoFormulario,
  valores: { prefijo: string; sufijo: string; buscar: string; poner: string; nombreExacto: string },
): ModoRenombre | null {
  if (modo === 'prefijo' && valores.prefijo.trim() !== '') return { tipo: 'prefijo', texto: valores.prefijo };
  if (modo === 'sufijo' && valores.sufijo.trim() !== '') return { tipo: 'sufijo', texto: valores.sufijo };
  if (modo === 'reemplazo' && valores.buscar !== '') return { tipo: 'reemplazo', buscar: valores.buscar, poner: valores.poner };
  if (modo === 'exacto') return { tipo: 'exacto', nombre: valores.nombreExacto.trim() };
  return null;
}
