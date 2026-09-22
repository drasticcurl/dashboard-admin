/**
 * Rendimiento → color y etiqueta, en un módulo puro (sin `lib/db`).
 *
 * Por qué existe este archivo y no se usa `RENDIMIENTOS` de
 * `lib/queries/creativos.ts` directo desde la UI: ese módulo importa `lib/db.ts`
 * (que trae `pg`, server-only). Un `import type` de un tipo se borra en
 * compilación y no arrastra nada, pero `RENDIMIENTOS` es un VALOR (una const
 * array) — importarlo desde un componente `'use client'` mete el módulo entero
 * en el bundle del cliente, y el build de Next falla ("Module not found: fs/net/tls",
 * que es `pg` intentando resolver sus dependencias de Node en el navegador).
 * Mismo problema, mismo remedio que `Nav.tsx` con `lib/permisos` y
 * `app/(panel)/tareas/prioridad.ts` con `lib/queries/tareas`: se duplica la
 * constante en un módulo sin imports de servidor.
 */

import type { Rendimiento } from '@/lib/queries/creativos';
import type { Tone } from '@/components/ui';

/** Igual que `RENDIMIENTOS` de lib/queries/creativos.ts (misma fuente, el CHECK
 *  de la 034), duplicada acá para que este módulo de UI no dependa de `lib/db`. */
export const RENDIMIENTOS = ['alto', 'medio', 'bajo'] as const;

/** alto → verde, medio → naranja, bajo → rojo. Mismo criterio de color que
 *  `tonoDePrioridad` (alta severidad = bad), pero leído al revés: acá "alto" es
 *  el resultado bueno, así que va en `good`. */
export function tonoDeRendimiento(r: Rendimiento): Tone {
  switch (r) {
    case 'alto':
      return 'good';
    case 'medio':
      return 'warn';
    case 'bajo':
      return 'bad';
  }
}

/** El texto visible. El color nunca es la única señal: siempre va acompañado
 *  de esta palabra. */
export function etiquetaDeRendimiento(r: Rendimiento): string {
  switch (r) {
    case 'alto':
      return 'Alto';
    case 'medio':
      return 'Medio';
    case 'bajo':
      return 'Bajo';
  }
}
