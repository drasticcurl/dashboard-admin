'use client';

/**
 * DialogoConfirmacion (task 20.3): muestra la Previsualizacion completa y exige
 * una confirmación explícita antes de ejecutar (R14 c1, c7, c8, c9). Se abre en
 * 300 ms o menos porque el cálculo es local (cero llamadas, R14 c2). Se usa
 * también para pausar y activar en lote, incluso con un solo objeto, y NUNCA
 * para el toggle de una fila (R14 c11).
 *
 * - Ejecutar queda deshabilitado hasta que el usuario active el control de
 *   confirmación explícito, y mientras la llamada al Endpoint_Acciones está en
 *   vuelo.
 * - Cancelar queda habilitado hasta que la ejecución comienza, y conserva la
 *   Seleccion_Activa intacta (el estado no se toca acá).
 * - `bloqueo` (task 3.1) es un veto que declara el padre: cuando no es nula,
 *   Ejecutar queda deshabilitado y el texto se muestra al lado del botón
 *   (R1.4). El padre es el que sabe si el formulario de la acción está
 *   completo; meter esa lógica acá adentro obligaría al diálogo a conocer los
 *   cinco formularios (presupuesto, duplicar, renombrar, programar y el caso
 *   pelado de pausar/activar). El bloqueo se SUMA a las condiciones propias del
 *   diálogo, no las reemplaza.
 */

import { useId, useState } from 'react';
import { Previsualizacion } from './Previsualizacion';
import type { Previsualizacion as Previa } from '@/lib/ads/previsualizacion';

export function DialogoConfirmacion({
  previa,
  ejecutando,
  bloqueo,
  onConfirmar,
  onCancelar,
  children,
}: {
  previa: Previa;
  ejecutando: boolean;
  /**
   * Motivo por el que el padre no deja ejecutar todavía (por ejemplo, un
   * importe de presupuesto inválido). `null` o ausente = sin veto del padre.
   */
  bloqueo?: string | null;
  onConfirmar: () => void;
  onCancelar: () => void;
  /** Los formularios de la acción (presupuesto, duplicar, programar, renombrar). */
  children?: React.ReactNode;
}): JSX.Element {
  const [confirmado, setConfirmado] = useState(false);
  const idBloqueo = useId();

  const hayEjecutable = previa.filas.some((f) => f.motivo === null && f.ejecutable);
  const puedeEjecutar = previa.completa && hayEjecutable && confirmado && !ejecutando && !bloqueo;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/80 backdrop-blur-sm p-4" role="dialog" aria-modal="true">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border-strong bg-surface p-5 shadow-float">
        <h3 className="text-sm font-semibold text-neutral-100">Confirmar acción</h3>

        <div className="mt-3">
          <Previsualizacion previa={previa} />
        </div>

        {children && <div className="mt-3 border-t border-border-subtle pt-3">{children}</div>}

        <p className="mt-3 text-xs text-neutral-500">
          Son objetos reales de una cuenta que gasta plata: la acción se aplica en Meta.
        </p>

        <label className="mt-3 flex items-center gap-2 text-sm text-neutral-300">
          <input
            type="checkbox"
            checked={confirmado}
            disabled={ejecutando}
            onChange={(e) => setConfirmado(e.target.checked)}
            className="h-4 w-4 accent-good-500"
          />
          Confirmo explícitamente que quiero ejecutar esta acción.
        </label>

        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          {bloqueo && (
            /*
             * `role="status"` (aria-live polite implícito) porque un botón
             * deshabilitado no recibe foco: sin la región viva, el lector de
             * pantalla nunca anunciaría por qué Ejecutar dejó de estar
             * disponible. El `aria-describedby` del botón, además, ata el motivo
             * al control para quien recorre el diálogo con el cursor virtual.
             */
            <p id={idBloqueo} role="status" className="mr-auto text-xs text-bad-300">
              {bloqueo}
            </p>
          )}
          <button
            type="button"
            onClick={onCancelar}
            disabled={ejecutando}
            className="rounded-md border border-border-strong px-3 py-1.5 text-sm text-neutral-300 hover:bg-overlay/6 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirmar}
            disabled={!puedeEjecutar}
            aria-describedby={bloqueo ? idBloqueo : undefined}
            className="rounded-md bg-good-500 px-3 py-1.5 text-sm font-semibold text-neutral-950 hover:bg-good-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {ejecutando ? 'Ejecutando…' : 'Ejecutar'}
          </button>
        </div>
      </div>
    </div>
  );
}
