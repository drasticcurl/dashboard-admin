'use client';

/**
 * ConfiguradorColumnas (task 20.2): marca y desmarca de forma independiente
 * cada columna que no sea Columna_Fija, y reubica con `@dnd-kit/sortable` SÓLO
 * a la derecha de las fijas (R2 c3, c4, c5, c6). El cambio se refleja en la
 * pintura siguiente en 300 ms o menos SIN emitir ninguna petición de filas:
 * todo pasa por `onColumnas`, que actualiza la configuración en pantalla.
 *
 * Se renderiza DENTRO del panel de `ControlVistas`, no suelto en la pantalla:
 * antes caía siempre abierto arriba de la tabla y con 27 columnas en el
 * catálogo se comía media pantalla. Por eso acá no hay tarjeta propia (la pone
 * el contenedor) y las dos listas tienen el alto acotado con scroll.
 */

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { DotsSixVertical } from '@phosphor-icons/react';
import { CATALOGO_METRICAS, CLAVES_FIJAS, type ColumnaVisible } from '@/lib/ads/catalogo';

export function ConfiguradorColumnas({
  columnas,
  onColumnas,
}: {
  columnas: ColumnaVisible[];
  onColumnas: (columnas: ColumnaVisible[]) => void;
}): JSX.Element {
  const sensores = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const alArrastrar = (e: DragEndEvent): void => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const claves = columnas.map((c) => c.clave);
    const de = claves.indexOf(String(active.id));
    const a = claves.indexOf(String(over.id));
    if (de < 0 || a < 0) return;
    onColumnas(arrayMove(columnas, de, a).map((c) => ({ ...c })));
  };

  const alternar = (clave: string): void => {
    if (CLAVES_FIJAS.includes(clave as (typeof CLAVES_FIJAS)[number])) return;
    const visible = columnas.some((c) => c.clave === clave);
    if (visible) {
      onColumnas(columnas.filter((c) => c.clave !== clave).map((c) => ({ ...c })));
    } else {
      const entrada = CATALOGO_METRICAS.find((e) => e.clave === clave)!;
      onColumnas([...columnas, { clave, ancho: entrada.clave === 'nombre' ? 280 : 120 }].map((c) => ({ ...c })));
    }
  };

  const noFijas = columnas.filter((c) => !CLAVES_FIJAS.includes(c.clave as (typeof CLAVES_FIJAS)[number]));

  return (
    <div>
      <p className="mb-2 text-xs font-semibold text-neutral-200">Columnas visibles</p>
      <DndContext sensors={sensores} collisionDetection={closestCenter} onDragEnd={alArrastrar}>
        <SortableContext items={noFijas.map((c) => c.clave)} strategy={verticalListSortingStrategy}>
          <ul className="max-h-64 space-y-1 overflow-y-auto pr-1">
            {/* Las fijas se listan pero no se pueden desmarcar ni mover (R2 c4, c6). */}
            {CLAVES_FIJAS.map((clave) => {
              const entrada = CATALOGO_METRICAS.find((e) => e.clave === clave)!;
              return (
                <li key={clave} className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-neutral-500">
                  <input type="checkbox" checked disabled aria-label={`${entrada.rotulo} (columna fija)`} className="h-3.5 w-3.5 accent-good-500" />
                  <span className="flex-1">{entrada.rotulo}</span>
                  <span className="text-[10px] text-neutral-600">fija</span>
                </li>
              );
            })}
            {noFijas.map((c) => (
              <FilaOrdenable key={c.clave} columna={c} onAlternar={alternar} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>

      <p className="mt-2 text-xs font-semibold text-neutral-200">Columnas ocultas</p>
      <ul className="max-h-64 space-y-1 overflow-y-auto pr-1">
        {CATALOGO_METRICAS.filter(
          (e) => !CLAVES_FIJAS.includes(e.clave as (typeof CLAVES_FIJAS)[number]) && !columnas.some((c) => c.clave === e.clave),
        ).map((e) => (
          <li key={e.clave} className="flex items-center gap-2 rounded-md px-2 py-1 text-xs">
            <input
              type="checkbox"
              checked={false}
              onChange={() => alternar(e.clave)}
              aria-label={`Mostrar la columna ${e.rotulo}`}
              className="h-3.5 w-3.5 accent-good-500"
            />
            <span className="flex-1 text-neutral-500">{e.rotulo}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FilaOrdenable({
  columna,
  onAlternar,
}: {
  columna: ColumnaVisible;
  onAlternar: (clave: string) => void;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: columna.clave,
  });
  const entrada = CATALOGO_METRICAS.find((e) => e.clave === columna.clave)!;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="flex items-center gap-2 rounded-md bg-overlay/3 px-2 py-1 text-xs text-neutral-300"
    >
      <span
        {...attributes}
        {...listeners}
        className="cursor-grab text-neutral-600 hover:text-neutral-300 active:cursor-grabbing"
        aria-label={`Arrastrar para reordenar ${entrada.rotulo}`}
        title="Arrastrar para reordenar"
      >
        <DotsSixVertical size={14} weight="bold" />
      </span>
      <input
        type="checkbox"
        checked
        onChange={() => onAlternar(columna.clave)}
        aria-label={`Ocultar la columna ${entrada.rotulo}`}
        className="h-3.5 w-3.5 accent-good-500"
      />
      <span className="flex-1">{entrada.rotulo}</span>
      <span className="text-[10px] text-neutral-500">{columna.ancho}px</span>
    </li>
  );
}
