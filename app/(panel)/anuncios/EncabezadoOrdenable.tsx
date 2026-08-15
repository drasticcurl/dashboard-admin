'use client';

/**
 * EncabezadoOrdenable (task 19.3): el `<th>` de una columna ordenable de la
 * Tabla_Anuncios (R4).
 *
 * - El encabezado ordenable es un `<button>` real dentro del `<th>`: click,
 *   Enter y Espacio activan el orden (R4 c1, c2).
 * - `aria-sort` con `descending`/`ascending` ÚNICAMENTE en la columna del
 *   Orden_Tabla, y `none` en el resto de los ordenables (R4 c4).
 * - Un indicador visible de la dirección en la misma columna del Orden_Tabla.
 * - El texto de definición del Catalogo_Metricas aparece al apuntar el puntero
 *   o al llevar el foco (R2 c10): es el tooltip de la entrada.
 */

import type { ClaveOrden } from '@/lib/ads/tipos';
import type { EntradaCatalogo } from '@/lib/ads/catalogo';

export function EncabezadoOrdenable({
  entrada,
  orden,
  onOrden,
  children,
}: {
  entrada: EntradaCatalogo;
  orden: { clave: ClaveOrden; dir: 'asc' | 'desc' };
  onOrden: (clave: ClaveOrden) => void;
  /** El contenido del encabezado (rótulo, sin el botón). */
  children: React.ReactNode;
}): JSX.Element {
  const activa = entrada.clave !== 'seleccion' && orden.clave === entrada.clave;

  if (!entrada.ordenable) {
    return <span className="text-neutral-500">{children}</span>;
  }

  return (
    <button
      type="button"
      title={entrada.definicion}
      aria-label={`${entrada.rotulo}: ${entrada.definicion}`}
      onClick={() => onOrden(entrada.clave as ClaveOrden)}
      className="group inline-flex w-full items-center gap-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-good-500/60"
    >
      <span className={activa ? 'text-neutral-100' : 'text-neutral-500 group-hover:text-neutral-300'}>
        {children}
      </span>
      {/*
        Indicador visible de la dirección vigente, sólo en la columna del
        Orden_Tabla (R4 c4).
      */}
      <span aria-hidden="true" className="text-[10px] leading-none text-neutral-400">
        {activa ? (orden.dir === 'desc' ? '↓' : '↑') : ''}
      </span>
    </button>
  );
}

/** El valor de `aria-sort` del th que envuelve a esta entrada (R4 c4). */
export function ariaSortDe(
  entrada: EntradaCatalogo,
  orden: { clave: ClaveOrden; dir: 'asc' | 'desc' },
): 'ascending' | 'descending' | 'none' | undefined {
  if (!entrada.ordenable) return undefined;
  if (orden.clave !== entrada.clave) return 'none';
  return orden.dir === 'asc' ? 'ascending' : 'descending';
}
