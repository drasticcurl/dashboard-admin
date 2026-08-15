/**
 * El nombre visible de un funnel. Módulo PURO y aparte de `lib/funnels.ts` a
 * propósito.
 *
 * `lib/funnels.ts` importa `lib/db.ts`, que importa `pg`. `components/Nav.tsx`
 * es un componente de cliente: si importa el helper desde ahí, webpack arrastra
 * `pg` al bundle del navegador y el build se cae. Por eso esto vive solo, sin
 * una sola importación.
 */

/** Lo mínimo que hace falta para decidir el nombre: no se pide el `Funnel` entero. */
export type FunnelNombrable = { name: string; alias: string | null };

/**
 * El alias si tiene contenido, si no el nombre real. Un alias de solo espacios
 * cuenta como sin alias.
 *
 * Un solo lugar decide esto, para que no queden dos criterios distintos para el
 * mismo funnel según qué pantalla lo muestre.
 */
export function nombreVisible(f: FunnelNombrable): string {
  const a = f.alias?.trim();
  return a ? a : f.name;
}
