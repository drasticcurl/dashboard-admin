'use client';

/**
 * El logo del panel — UNA definición, dos lugares.
 *
 * Vive en su propio archivo client porque lo consumen dos server components
 * distintos (el layout de `(panel)` y el login de `app/page.tsx`) y
 * `@phosphor-icons/react` llama a `createContext` al importarse, que la build
 * server-only de React no tiene.
 *
 * Antes estaba duplicado: `Nav.tsx` dibujaba un ChartLineUp de 28px con radio
 * `lg`, y el login una letra "P" de 36px con radio `xl` — la misma marca en
 * dos versiones que ya habían divergido en tamaño, radio y glifo (la decisión
 * D-R11 había sacado la letra P del logo, pero el login nunca se actualizó).
 * Con un solo componente y una prop de tamaño eso no puede volver a pasar.
 *
 * Es una pastilla de vidrio del acento del panel (iris, rediseño iris), con el
 * reflejo especular arriba y el halo teñido del mismo iris en lugar de una
 * sombra negra. Hasta v3 era verde (`good`), y el logo del panel quedaba del
 * mismo color que una ganancia: la marca es interfaz, no un resultado (D1).
 */

import { ChartLineUp } from '@phosphor-icons/react';

const TAMANOS = {
  sm: { caja: 'h-7 w-7 rounded-lg', icono: 16 },
  md: { caja: 'h-9 w-9 rounded-xl', icono: 20 },
} as const;

export function PanelLogo({ size = 'sm' }: { size?: keyof typeof TAMANOS }): JSX.Element {
  const { caja, icono } = TAMANOS[size];
  return (
    <span
      className={`relative flex shrink-0 items-center justify-center bg-gradient-to-b from-acento-400 to-acento-600 text-canvas shadow-glow-acento ${caja}`}
    >
      {/*
        Las dos capas que lo hacen ver como un objeto y no como un cuadrado
        pintado: un reflejo interno arriba (la luz cae desde arriba en todo el
        panel) y un anillo interno de 1px que hace de canto.
      */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.45),inset_0_0_0_1px_rgba(255,255,255,0.14)]"
      />
      <ChartLineUp size={icono} weight="bold" aria-hidden />
    </span>
  );
}
