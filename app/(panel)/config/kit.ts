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

export const inputCls =
  'rounded-lg border border-border-strong bg-overlay/4 px-2 py-1.5 text-sm text-neutral-200 focus:border-good-500/50 focus:outline-none focus:ring-1 focus:ring-good-500/50';
export const btnCls =
  'rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-good-500/50 disabled:opacity-40';
export const btnPrimary = `${btnCls} bg-good-500 text-white hover:bg-good-400`;
export const btnGhost = `${btnCls} border border-border-strong text-neutral-300 hover:bg-overlay/6`;
