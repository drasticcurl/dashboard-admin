'use client';

/**
 * Kit compartido de las secciones de Config (T07 §3): los estilos de input y
 * botón que repetían las nueve secciones, el tipo del flash y la interfaz
 * `ConfigShell` que el ConfigView pasa a cada sección (fetch autenticado,
 * flash, busy). Un solo lugar para no duplicar las mismas clases en diez
 * archivos.
 */

export type Flash = { tone: 'good' | 'bad'; text: string } | null;

export type ConfigShell = {
  api: <T = unknown>(url: string, init?: RequestInit) => Promise<T>;
  show: (tone: 'good' | 'bad', text: string) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
};

/*
  El anillo de foco NO se declara acá: lo hereda del `:focus-visible` global de
  `app/globals.css`, que es el mismo para todo el panel. Antes cada control
  traía su propia variante y había cuatro tratamientos distintos de foco
  conviviendo, así que el indicador cambiaba de forma según en qué pantalla
  estuvieras. El `focus:border-*` sí queda: es la señal de "estoy escribiendo
  acá", y esa tiene que aparecer también cuando entrás con el mouse.
*/
export const inputCls =
  'rounded-lg border border-border-strong bg-canvas/50 px-2.5 py-1.5 text-sm text-neutral-200 shadow-[inset_0_1px_2px_0_rgba(4,6,14,0.45)] transition-colors duration-250 placeholder:text-neutral-600 hover:border-overlay/16 focus:border-good-500/60';
export const btnCls =
  'press rounded-lg px-3 py-1.5 text-xs font-semibold transition-[background-color,border-color,color,filter] duration-250 disabled:cursor-not-allowed disabled:opacity-40';
/* Degradado vertical y texto oscuro: el botón primario es el único relleno
   sólido de color del panel, así que es el que más se nota si se ve plano. */
export const btnPrimary = `${btnCls} bg-gradient-to-b from-good-400 to-good-600 text-canvas shadow-glow-good hover:brightness-110`;
export const btnGhost = `${btnCls} border border-border-strong bg-surface-raised text-neutral-300 shadow-inset-highlight hover:border-overlay/16 hover:bg-surface-overlay hover:text-neutral-100`;
