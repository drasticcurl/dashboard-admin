/**
 * Prioridad → color, etiqueta y orden, en funciones puras y testeadas (T06 §4).
 *
 * Por qué acá y no inline en la tarjeta: el color de una prioridad se decide
 * UNA vez y se testea (prioridad.test.ts vigila que ningún valor devuelto sea un
 * literal de color). Si el mapeo viviera en el JSX, no habría dónde apuntar el
 * test y "alta es verde" se colaría sin que nada falle.
 *
 * `Tone` se importa de components/ui.tsx (que se lee, no se toca): son los
 * mismos tokens que usan Banner, Pill y el resto del panel, así que la franja de
 * una tarjeta y un cartel de error hablan el mismo idioma de color. Cero
 * literales de color acá: todo sale como un `Tone` y quien pinta resuelve el
 * token de Tailwind.
 */

import type { Prioridad } from '@/lib/queries/tareas';
import type { Tone } from '@/components/ui';

/** Las tres prioridades en orden de severidad. Igual que `PRIORIDADES` de
 *  lib/queries/tareas.ts (misma fuente, el CHECK de la 031), duplicada acá para
 *  que este módulo de UI no dependa del orden interno de la capa de datos. */
export const PRIORIDADES = ['alta', 'media', 'baja'] as const;

/**
 * El tono de cada prioridad: alta → rojo, media → naranja, baja → gris.
 *
 * `neutral` y NO `good` para la baja, aunque se ofreció "verde o gris": en este
 * panel `good` es EL color de acento (el underline de la pestaña activa, el
 * botón primario, el shadow-glow-good). Una tarjeta de prioridad baja pintada de
 * verde compite con los controles y se lee como "esta está bien" cuando lo que
 * dice es "esta puede esperar". El gris es el ausente de severidad, que es
 * exactamente lo que "baja" significa.
 */
export function tonoDePrioridad(p: Prioridad): Tone {
  switch (p) {
    case 'alta':
      return 'bad';
    case 'media':
      return 'warn';
    case 'baja':
      return 'neutral';
  }
}

/** El texto visible. El color nunca es la única señal (T06 §4): la franja de
 *  color va SIEMPRE acompañada de esta palabra, para quien no distingue rojo de
 *  naranja. */
export function etiquetaDePrioridad(p: Prioridad): string {
  switch (p) {
    case 'alta':
      return 'Alta';
    case 'media':
      return 'Media';
    case 'baja':
      return 'Baja';
  }
}

/** Para ordenar: alta primero (0), baja última (2). */
export function ordenDePrioridad(p: Prioridad): number {
  switch (p) {
    case 'alta':
      return 0;
    case 'media':
      return 1;
    case 'baja':
      return 2;
  }
}
