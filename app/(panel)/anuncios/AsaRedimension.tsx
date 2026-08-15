'use client';

/**
 * AsaRedimension (task 19.3): el control de redimensionado de una columna de la
 * Tabla_Anuncios (R5).
 *
 * - Es un `<button>` real de ZONA_ASA (8) píxeles de ancho y la altura completa
 *   del encabezado, alcanzable con Tab en un único paso y con anillo de foco de
 *   2 píxeles en todo su perímetro (R5 c1, c4).
 * - Arrastre con pointer events: 1 píxel por cada píxel de desplazamiento,
 *   acotado a ANCHO_MIN..ANCHO_MAX (48..640), reflejado en pantalla en menos de
 *   100 ms (R5 c2, c3). El ancho en vuelo va por `onAncho` en cada movimiento.
 * - Teclado: flecha izquierda −16 píxeles, flecha derecha +16 (R5 c5).
 * - Escape durante el arrastre restaura el ancho inicial del arrastre (R5 c13).
 * - Al soltar (o al pulsar una flecha) el ancho resultante se registra en la
 *   configuración en pantalla vía `onAncho` — NUNCA en el Repo_Vistas: al
 *   Repo_Vistas va sólo cuando el usuario guarda la Vista (R5 c6, c7).
 */

import { useCallback, useRef } from 'react';

export const ANCHO_MIN = 48;
export const ANCHO_MAX = 640;
export const PASO_TECLADO = 16; // R5 c5
export const ZONA_ASA = 8; // R5 c1, píxeles de zona activa

function acotar(ancho: number): number {
  return Math.min(ANCHO_MAX, Math.max(ANCHO_MIN, ancho));
}

export function AsaRedimension({
  ancho,
  onAncho,
  label,
}: {
  ancho: number;
  onAncho: (ancho: number) => void;
  label: string;
}): JSX.Element {
  // El arrastre en curso: posición inicial del puntero y ancho inicial.
  const arrastre = useRef<{ x0: number; ancho0: number } | null>(null);
  const raf = useRef<number | null>(null);

  const mover = useCallback(
    (x: number) => {
      if (!arrastre.current) return;
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(() => {
        if (!arrastre.current) return;
        const dx = x - arrastre.current.x0;
        onAncho(acotar(arrastre.current.ancho0 + dx));
      });
    },
    [onAncho],
  );

  const soltar = useCallback(
    (restaurar: boolean) => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      const a = arrastre.current;
      arrastre.current = null;
      if (restaurar && a) onAncho(a.ancho0); // R5 c13: Escape restaura el inicial
    },
    [onAncho],
  );

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      style={{ width: ZONA_ASA }}
      className="group absolute inset-y-0 right-0 flex items-center justify-center cursor-col-resize touch-none rounded-sm bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-good-500"
      onPointerDown={(e) => {
        e.preventDefault();
        arrastre.current = { x0: e.clientX, ancho0: ancho };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (arrastre.current) mover(e.clientX);
      }}
      onPointerUp={() => soltar(false)}
      onPointerCancel={() => soltar(true)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          onAncho(acotar(ancho - PASO_TECLADO)); // R5 c5
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          onAncho(acotar(ancho + PASO_TECLADO));
        } else if (e.key === 'Escape') {
          e.preventDefault();
          soltar(true);
        }
      }}
    >
      {/* La marca visual del asa, más angosta que la zona activa. */}
      <span className="h-4 w-px rounded bg-overlay/20 transition-colors group-hover:bg-good-500/60 group-focus-visible:bg-good-500/60" />
    </button>
  );
}
