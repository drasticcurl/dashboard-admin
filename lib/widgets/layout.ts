/**
 * La lógica pura del runtime de widgets (T03), separada del componente para
 * poder testearla sin DOM ni base (task §2 del plan). Todo lo de acá es una
 * función pura: no tira nunca, no toca red, no guarda estado.
 *
 * La regla que este archivo protege es D-R04 del plan: `null` y
 * `{v:1,widgets:[]}` son DOS estados distintos. `null` es "nunca guardó" y
 * muestra el layout por defecto; el array vacío es "guardó una pantalla sin
 * widgets" y se respeta. Si el código colapsa los dos casos, el usuario borra
 * todos sus widgets, guarda, recarga y le vuelven los de fábrica.
 */

import { z } from 'zod';
import type { WidgetCatalogo, WidgetLayout, WidgetPlacement, WidgetSize } from './tipos';

/** Tope del array guardado. El endpoint es autenticado, pero un layout con
 *  50.000 widgets se guarda una vez y después la pantalla no abre nunca más:
 *  la validación es el único lugar donde eso se puede frenar (task §2). */
const MAX_WIDGETS = 100;

const placementSchema = z.object({
  id: z.string().min(1),
  w: z.union([z.literal(1), z.literal(2)]),
  h: z.union([z.literal(1), z.literal(2)]),
});

/**
 * El esquema de lo que se guarda en settings.ui_layout_*. Lo comparte el
 * endpoint (el POST valida con esto ANTES de tocar la base) y parseLayout.
 * El `v` literal 1 es la versión del formato: un layout de versión futura o
 * pasada no se interpreta a ciegas.
 */
export const widgetLayoutSchema = z.object({
  v: z.literal(1),
  widgets: z.array(placementSchema).max(MAX_WIDGETS),
});

/**
 * Valida y normaliza lo que vino de la base. NUNCA tira: la pantalla no
 * puede quedar en blanco por un layout guardado mal.
 *
 * - fila con null / basura / versión desconocida → null ("mostrá el default");
 * - {v:1,widgets:[]} → ese objeto, TAL CUAL (no null: es el vacío guardado).
 */
export function parseLayout(raw: unknown): WidgetLayout | null {
  if (raw === null || raw === undefined) return null;
  const parsed = widgetLayoutSchema.safeParse(raw);
  if (!parsed.success) return null;
  return { v: 1, widgets: parsed.data.widgets.map((p) => ({ id: p.id, w: p.w, h: p.h })) };
}

/**
 * Cruza el layout con el catálogo y devuelve qué se puede renderizar y qué
 * se descartó, para que la UI lo avise (regla 4 del §4 del plan).
 *
 * Reglas:
 * 1. `layout === null` → `porDefecto`. Distinto de `widgets: []`, que se
 *    respeta (D-R04).
 * 2. Un `id` que no está en el catálogo se descarta y va a `desconocidos`.
 *    No tira, no se reemplaza, no deja huecos.
 * 3. Un `w`/`h` que ya no está en `tamañosPermitidos` cae al
 *    `tamañoPorDefecto`: el layout guardado no manda sobre el catálogo.
 * 4. Un `id` repetido se queda con la PRIMERA aparición (claves repetidas
 *    rompen el `key` de React).
 */
export function resolveLayout<T>(
  layout: WidgetLayout | null,
  catalogo: WidgetCatalogo<T>,
  porDefecto: WidgetPlacement[],
): { placements: WidgetPlacement[]; desconocidos: string[] } {
  if (layout === null) {
    return { placements: porDefecto, desconocidos: [] };
  }

  const placements: WidgetPlacement[] = [];
  const desconocidos: string[] = [];
  const vistos = new Set<string>();

  for (const entry of layout.widgets) {
    const def = catalogo[entry.id];
    if (!def) {
      if (!vistos.has(entry.id)) {
        vistos.add(entry.id);
        desconocidos.push(entry.id);
      }
      continue;
    }
    if (vistos.has(entry.id)) continue;
    vistos.add(entry.id);

    const permitido = def.tamañosPermitidos.some((s) => s.w === entry.w && s.h === entry.h);
    if (permitido) {
      placements.push({ id: entry.id, w: entry.w, h: entry.h });
    } else {
      placements.push({ id: entry.id, w: def.tamañoPorDefecto.w, h: def.tamañoPorDefecto.h });
    }
  }

  return { placements, desconocidos };
}

/**
 * Mueve un widget de `from` a `to`. Devuelve un array nuevo; con un índice
 * fuera de rango devuelve el original sin tocar (el orden no se destruye).
 */
export function reorder(placements: WidgetPlacement[], from: number, to: number): WidgetPlacement[] {
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < 0 ||
    from >= placements.length ||
    to >= placements.length ||
    from === to
  ) {
    return placements;
  }
  const next = placements.slice();
  const [movido] = next.splice(from, 1);
  next.splice(to, 0, movido);
  return next;
}

/**
 * Cambia el tamaño de un widget RESPETANDO `tamañosPermitidos` del catálogo
 * (regla 5 del §4): un tamaño que el widget no acepta no se aplica. Un `id`
 * que no está en el catálogo tampoco cambia nada.
 */
export function resize<T>(
  placements: WidgetPlacement[],
  id: string,
  size: WidgetSize,
  catalogo: WidgetCatalogo<T>,
): WidgetPlacement[] {
  const def = catalogo[id];
  if (!def) return placements;
  const permitido = def.tamañosPermitidos.some((s) => s.w === size.w && s.h === size.h);
  if (!permitido) return placements;
  return placements.map((p) => (p.id === id ? { id: p.id, w: size.w, h: size.h } : p));
}

/**
 * true si el layout actual difiere del guardado. Alimenta el "cambios sin
 * guardar" de la barra (D-R05). El orden ES parte del layout: mismos ids en
 * distinto orden es un cambio.
 *
 * `guardado === null` significa que la base nunca recibió un layout: cualquier
 * estado actual difiere de "no hay nada guardado", así que es un cambio
 * (borrar todos los widgets sin haber guardado nunca también se puede
 * guardar, y guardarlo cambia lo que se ve al recargar).
 */
export function hasChanges(actual: WidgetPlacement[], guardado: WidgetPlacement[] | null): boolean {
  if (guardado === null) return true;
  if (actual.length !== guardado.length) return true;
  return actual.some(
    (p, i) => p.id !== guardado[i].id || p.w !== guardado[i].w || p.h !== guardado[i].h,
  );
}
