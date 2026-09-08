'use client';

/**
 * Columna — una de las 4 columnas del tablero, y su zona droppable (T06 §5).
 *
 * La clave de accesibilidad y de que el kanban funcione: la zona droppable es
 * el CONTENEDOR ENTERO con una altura mínima, no sólo la lista de tarjetas. Es
 * el bug clásico de dnd-kit con varios contenedores — una columna sin tarjetas
 * no tiene superficie y no se le puede soltar la primera tarjeta. El texto de
 * "vacío" lleva `pointer-events-none` para no interceptar el drop.
 *
 * PROHIBIDO cualquier animación CSS de `transform` acá: pisaría el transform
 * inline de dnd-kit en la cascada (app/(panel)/layout.tsx:120-133). Las
 * transiciones de background-color/box-shadow sí están bien y son las que usa el
 * resaltado de "estás por soltar acá".
 */

import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { Columna as ColumnaId, Tarea } from '@/lib/queries/tareas';
import type { Usuario } from '@/lib/queries/usuarios';
import { TarjetaOrdenable } from './TarjetaTarea';

export function Columna({
  id,
  titulo,
  tareas,
  usuarios,
  onAbrir,
}: {
  id: ColumnaId;
  titulo: string;
  tareas: Tarea[];
  usuarios: Usuario[];
  onAbrir: (id: number) => void;
}): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id });

  return (
    /*
      `bg-surface/60` y no `bg-canvas/40`: canvas ES el fondo de la página
      (#08090d), así que `bg-canvas/40` sobre el canvas es EXACTAMENTE el mismo
      color — la columna quedaba sin relleno y en PC, con las 4 al lado, no se
      veía dónde empezaba y terminaba cada una. Tiene que ser translúcida y no
      `bg-surface` a secas: la columna es el hueco y las tarjetas de adentro son
      lo que sobresale, y las tarjetas ya son `bg-surface`. Si la columna usa el
      mismo token opaco, las tarjetas desaparecen contra ella.
    */
    <section
      aria-label={`Columna ${titulo}`}
      className="flex flex-col rounded-2xl border border-border-subtle bg-surface/60 p-3"
    >
      <header className="mb-3 flex items-center justify-between gap-2 px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
          {titulo}
        </h2>
        <span className="rounded-full bg-overlay/7 px-2 py-0.5 text-[11px] font-medium text-neutral-400">
          {tareas.length}
        </span>
      </header>

      {/* El contenedor entero es la zona droppable: min-h para que una columna
          vacía tenga superficie. El resaltado va por background/box-shadow, que
          no tocan el transform de dnd-kit.

          El `min-h` sube a 20rem desde `lg`, que es el breakpoint en el que
          TableroView pasa a 4 columnas: con 8rem fijos el tablero vacío era una
          tira de 128px arriba de una pantalla de 700px de alto y no se leía como
          un tablero. En mobile se queda en 8rem porque ahí las 4 columnas van
          UNA DEBAJO DE OTRA y 20rem cada una serían 80rem de scroll vacío. */}
      <div
        ref={setNodeRef}
        className={`flex min-h-[8rem] flex-1 flex-col gap-2 rounded-xl p-1 transition-[background-color,box-shadow] duration-150 lg:min-h-[20rem] ${
          isOver ? 'bg-good-500/[0.06] shadow-inset-highlight ring-1 ring-inset ring-good-500/30' : ''
        }`}
      >
        <SortableContext items={tareas.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tareas.map((t) => (
            <TarjetaOrdenable
              key={t.id}
              tarea={t}
              usuarios={usuarios}
              onAbrir={() => onAbrir(t.id)}
            />
          ))}
        </SortableContext>

        {/* `m-auto` y no `py-6`: es el único hijo del flex-col, así que el margen
            auto lo centra en los dos ejes. Con `py-6` el texto quedaba pegado
            arriba y las 20rem de abajo se veían como una columna cortada. */}
        {tareas.length === 0 && (
          <p className="pointer-events-none m-auto select-none px-2 text-center text-xs text-neutral-600">
            Soltá una tarjeta acá
          </p>
        )}
      </div>
    </section>
  );
}
