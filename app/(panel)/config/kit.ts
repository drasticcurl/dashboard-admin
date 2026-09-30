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
  'min-h-[44px] rounded-lg border border-border-strong bg-canvas/50 px-2.5 py-1.5 text-sm text-neutral-200 panel:min-h-0 shadow-[inset_0_1px_2px_0_rgba(12,10,28,0.45)] transition-colors duration-250 placeholder:text-neutral-600 hover:border-overlay/16 focus:border-acento-500/60';
/*
  `tap` (globals.css) le pone 44×44 de mínimo SÓLO debajo de 760px: es el
  mínimo táctil del handoff v3. Va en la clase base compartida y no botón por
  botón porque estos dos estilos cubren los ~120 botones de Config, Finanzas y
  Tareas: ponerlo en cada call site garantizaba que el próximo botón se olvidara.
  En desktop `tap` no emite nada, así que la densidad de la UI no cambia.
*/
export const btnCls =
  'tap press rounded-lg px-3 py-1.5 text-xs font-semibold transition-[background-color,border-color,color,filter] duration-250 disabled:cursor-not-allowed disabled:opacity-40';
/* Degradado vertical y texto oscuro: el botón primario es el único relleno
   sólido de color del panel, así que es el que más se nota si se ve plano.
   Es iris y no verde (D1): el verde quedó para "esto salió bien", y un
   "Guardar" no es un resultado. Termina en el 500 y no en el 600 porque con
   texto `canvas` encima el 600 del iris baja de 4.5:1 (§5 del plan). */
export const btnPrimary = `${btnCls} bg-gradient-to-b from-acento-400 to-acento-500 text-canvas shadow-glow-acento hover:brightness-110`;
export const btnGhost = `${btnCls} border border-border-strong bg-surface-raised text-neutral-300 shadow-inset-highlight hover:border-overlay/16 hover:bg-surface-overlay hover:text-neutral-100`;
