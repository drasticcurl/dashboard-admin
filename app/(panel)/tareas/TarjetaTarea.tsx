'use client';

/**
 * TarjetaTarea — la tarjeta del tablero (T06 §5), en dos piezas:
 *
 *  · `TarjetaTarea`  — presentacional pura. La usa el DragOverlay (sin
 *    listeners) y, envuelta, la versión ordenable.
 *  · `TarjetaOrdenable` — le agrega el `useSortable` y el ASA de arrastre.
 *
 * El asa es un <button> propio con aria-label, NO la tarjeta entera (molde:
 * WidgetGrid.tsx). Si el arrastre fuera toda la tarjeta no se podría clickear
 * para abrir el detalle ni seleccionar el título. El click en el resto de la
 * tarjeta abre el detalle.
 *
 * El color de prioridad NUNCA es la única señal: una franja de color a la
 * izquierda MÁS la palabra (Alta/Media/Baja). Los contadores son 0 y no
 * undefined con las listas vacías (por eso `.length`, no un `?.`).
 *
 * Sin animaciones de transform acá: el `transform` inline lo pone dnd-kit y una
 * animación CSS lo pisaría (app/(panel)/layout.tsx:120-133).
 */

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChatCircle, DotsSixVertical, LinkSimple } from '@phosphor-icons/react';
import type { Tarea } from '@/lib/queries/tareas';
import type { Usuario } from '@/lib/queries/usuarios';
import { etiquetaDePrioridad, tonoDePrioridad } from './prioridad';
import { estaVencida } from './TableroView';
import type { Tone } from '@/components/ui';

// La franja de prioridad, por token (cero literales de color).
const FRANJA: Record<Tone, string> = {
  neutral: 'bg-neutral-600',
  good: 'bg-good-500',
  warn: 'bg-warn-500',
  bad: 'bg-bad-500',
  info: 'bg-info-500',
};
const PILL: Record<Tone, string> = {
  neutral: 'bg-overlay/7 text-neutral-300',
  good: 'bg-good-500/14 text-good-300',
  warn: 'bg-warn-500/14 text-warn-300',
  bad: 'bg-bad-500/14 text-bad-300',
  info: 'bg-info-500/14 text-info-300',
};

function inicial(nombre: string): string {
  return (nombre.trim()[0] ?? '?').toUpperCase();
}

/** 'YYYY-MM-DD' → 'D mmm' corta, sin tocar zona horaria (se parte el string). */
function fechaCorta(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  if (!y || !m || !d) return iso;
  return `${d} ${meses[m - 1]}`;
}

export function TarjetaTarea({
  tarea,
  usuarios,
  overlay = false,
  onAbrir,
  asa,
}: {
  tarea: Tarea;
  usuarios: Usuario[];
  /** true cuando la pinta el DragOverlay: da la sombra "levantada". */
  overlay?: boolean;
  onAbrir?: () => void;
  /** El asa de arrastre, inyectada por TarjetaOrdenable. */
  asa?: JSX.Element;
}): JSX.Element {
  const tono = tonoDePrioridad(tarea.prioridad);
  const asignado = usuarios.find((u) => u.id === tarea.asignadoA);
  const nombre = tarea.asignadoNombre || asignado?.nombre || '—';
  const vencida = estaVencida(tarea.venceEl);
  const nComentarios = tarea.comentarios.length;
  const nLinks = tarea.links.length;

  return (
    <div
      className={`relative flex overflow-hidden rounded-xl border border-border-subtle bg-surface transition-[background-color,box-shadow] duration-150 ${
        overlay ? 'shadow-float' : 'hover:bg-surface-overlay'
      }`}
    >
      {/* Franja de color de prioridad. La palabra va abajo: el color no es la
          única señal. aria-hidden porque el texto ya lo dice. */}
      <span aria-hidden className={`w-1 shrink-0 ${FRANJA[tono]}`} />

      <div className="min-w-0 flex-1 p-3">
        <div className="flex items-start justify-between gap-2">
          <button
            type="button"
            onClick={onAbrir}
            disabled={!onAbrir}
            className="min-w-0 flex-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-good-500/60 disabled:cursor-default"
          >
            <span className="line-clamp-2 text-sm font-medium text-neutral-100">
              {tarea.titulo}
            </span>
          </button>
          {asa}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
          <span className={`rounded-full px-2 py-0.5 font-medium ${PILL[tono]}`}>
            {etiquetaDePrioridad(tarea.prioridad)}
          </span>

          {tarea.venceEl && (
            <span className={`font-medium ${vencida ? 'text-bad-400' : 'text-neutral-500'}`}>
              {vencida ? 'venció ' : 'vence '}
              {fechaCorta(tarea.venceEl)}
            </span>
          )}

          {nLinks > 0 && (
            <span className="inline-flex items-center gap-1 text-neutral-500">
              <LinkSimple size={12} weight="bold" aria-hidden />
              <span aria-label={`${nLinks} enlaces`}>{nLinks}</span>
            </span>
          )}

          {nComentarios > 0 && (
            <span className="inline-flex items-center gap-1 text-neutral-500">
              <ChatCircle size={12} weight="bold" aria-hidden />
              <span aria-label={`${nComentarios} comentarios`}>{nComentarios}</span>
            </span>
          )}

          <span
            className="ml-auto flex h-6 w-6 items-center justify-center rounded-full bg-overlay/10 text-[11px] font-semibold text-neutral-300"
            title={nombre}
            aria-label={`Asignada a ${nombre}`}
          >
            {inicial(nombre)}
          </span>
        </div>
      </div>
    </div>
  );
}

export function TarjetaOrdenable({
  tarea,
  usuarios,
  onAbrir,
}: {
  tarea: Tarea;
  usuarios: Usuario[];
  onAbrir: () => void;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tarea.id,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'opacity-40' : ''}
    >
      <TarjetaTarea
        tarea={tarea}
        usuarios={usuarios}
        onAbrir={onAbrir}
        asa={
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={`Arrastrar la tarea ${tarea.titulo}`}
            title="Arrastrar para mover (o Tab + Espacio + flechas)"
            className="flex h-7 w-7 shrink-0 touch-none cursor-grab items-center justify-center rounded-lg border border-border-subtle text-neutral-500 transition-colors hover:bg-overlay/4 hover:text-neutral-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-good-500/60 active:cursor-grabbing"
          >
            <DotsSixVertical size={14} weight="bold" />
          </button>
        }
      />
    </div>
  );
}
