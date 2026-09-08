'use client';

/**
 * TableroView — el tablero kanban completo (T06 §5).
 *
 * Server component `page.tsx` trae `initial` (tareas + usuarios) y `yo`
 * (id/nombre/esAdmin de la sesión); acá vive todo el estado del cliente: el
 * switch de "de quién", el drag & drop entre las 4 columnas y el modal de
 * detalle. Cero fetch de datos en el cliente para la primera pintura: eso ya lo
 * hizo el server.
 *
 * El molde de arrastre es components/WidgetGrid.tsx (el único dnd-kit completo
 * del repo): mismos sensores (PointerSensor con distance:8 para que un click en
 * un botón de la tarjeta no arranque un arrastre + KeyboardSensor), mismos
 * announcements y screenReaderInstructions en castellano, el asa como <button>
 * propio. Lo que NO se copia es su persistencia con debounce: acá cada
 * movimiento es un POST a /api/tareas/mover con la lista de la columna (D12).
 *
 * Diferencia clave con WidgetGrid: son VARIOS contenedores (4 columnas), no uno.
 * Por eso `closestCorners` y no `closestCenter` (las columnas tienen alturas
 * distintas; con closestCenter soltar cerca del borde inferior de una columna
 * corta cae en la de al lado), y por eso cada columna es un `useDroppable` cuyo
 * contenedor entero —no sólo la lista— es la zona droppable, con altura mínima,
 * para que una columna VACÍA acepte que le suelten la primera tarjeta.
 */

import { useMemo, useState } from 'react';
import { Plus } from '@phosphor-icons/react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type {
  Announcements,
  DragEndEvent,
  DragStartEvent,
  UniqueIdentifier,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import type { Columna as ColumnaId, Prioridad, Tarea } from '@/lib/queries/tareas';
import type { Usuario } from '@/lib/queries/usuarios';
import { SELECT_HEADER } from '@/components/Nav';
import { Banner } from '@/components/ui';
import { btnPrimary } from '@/app/(panel)/config/kit';
import { Columna } from './Columna';
import { TarjetaTarea } from './TarjetaTarea';
import { DetalleTarea } from './DetalleTarea';
import { NuevaTarea } from './NuevaTarea';

// ─── El "yo" que baja del server (T06 §5) ───────────────────────────────────

export type Yo = { id: number; nombre: string; esAdmin: boolean };

// ─── Las 4 columnas, con su etiqueta visible ─────────────────────────────────

export const ORDEN_COLUMNAS: readonly ColumnaId[] = [
  'por_hacer',
  'en_progreso',
  'en_revision',
  'hecho',
] as const;

export const ETIQUETA_COLUMNA: Record<ColumnaId, string> = {
  por_hacer: 'Por hacer',
  en_progreso: 'En progreso',
  en_revision: 'En revisión',
  hecho: 'Hecho',
};

// ─── Funciones puras (testeadas en tablero.test.ts, sin jsdom) ───────────────

/**
 * Reparte las tareas en las 4 columnas y devuelve SIEMPRE las 4 claves, aunque
 * alguna quede vacía (una columna vacía tiene que existir para ser droppable).
 * Dentro de cada columna ordena por `posicion` y DESEMPATA por `id`: dos filas
 * escritas en la misma transacción comparten marca de tiempo (now() es la hora
 * de inicio de la tx, D13), así que sin el desempate por id el orden sería no
 * determinista.
 */
export function agruparPorColumna(tareas: readonly Tarea[]): Record<ColumnaId, Tarea[]> {
  const grupos: Record<ColumnaId, Tarea[]> = {
    por_hacer: [],
    en_progreso: [],
    en_revision: [],
    hecho: [],
  };
  for (const t of tareas) grupos[t.columna].push(t);
  for (const col of ORDEN_COLUMNAS) {
    grupos[col].sort((a, b) => (a.posicion - b.posicion) || (a.id - b.id));
  }
  return grupos;
}

/**
 * Mueve el id del índice `desde` al índice `hasta` DENTRO de una misma lista y
 * devuelve la lista resultante. Es el reordenamiento dentro de una columna.
 *
 * Invariante (propiedad 9 de §6, testeada con fast-check): el resultado es
 * SIEMPRE una permutación de la entrada — mismo largo, mismos elementos, sin
 * duplicados ni pérdidas. Perder un id acá es una tarjeta que desaparece del
 * tablero y reaparece en el siguiente refresh en un lugar impredecible.
 */
export function nuevoOrdenAlSoltar(
  ids: readonly number[],
  desde: number,
  hasta: number,
): number[] {
  const copia = [...ids];
  if (
    desde < 0 ||
    desde >= copia.length ||
    hasta < 0 ||
    hasta >= copia.length ||
    desde === hasta
  ) {
    // Soltar en el mismo lugar (o un índice fuera de rango) no cambia nada: no
    // dispara un POST inútil.
    return copia;
  }
  const [movido] = copia.splice(desde, 1);
  copia.splice(hasta, 0, movido!);
  return copia;
}

/**
 * Inserta `id` en la posición `hasta` de la lista destino (una columna a la que
 * la tarjeta NO pertenecía). `hasta` fuera de rango cae al final. El id no puede
 * estar ya en `idsDestino` (viene de otra columna), pero si estuviera se lo saca
 * primero para no duplicarlo.
 */
export function moverEntreColumnas(
  idsDestino: readonly number[],
  id: number,
  hasta: number,
): number[] {
  const sinDuplicado = idsDestino.filter((x) => x !== id);
  const pos = hasta < 0 ? sinDuplicado.length : Math.min(hasta, sinDuplicado.length);
  sinDuplicado.splice(pos, 0, id);
  return sinDuplicado;
}

/** Un no-admin edita SÓLO las tareas que tiene asignadas; el admin, todas. */
export function puedeEditar(yo: Yo, tarea: Pick<Tarea, 'asignadoA'>): boolean {
  return yo.esAdmin || tarea.asignadoA === yo.id;
}

/**
 * ¿La fecha de vencimiento ya pasó? HOY NO cuenta como vencido: el límite es el
 * arranque del día siguiente. `venceEl` es 'YYYY-MM-DD' y `hoy` un Date; se
 * comparan por día calendario para que la hora no mueva el límite.
 */
export function estaVencida(venceEl: string | null, hoy: Date = new Date()): boolean {
  if (!venceEl) return false;
  const hoyStr = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(
    hoy.getDate(),
  ).padStart(2, '0')}`;
  return venceEl < hoyStr;
}

// ─── El componente ───────────────────────────────────────────────────────────

export function TableroView({
  initial,
  yo,
  asignadoInicial = 'todas',
}: {
  initial: { tareas: Tarea[]; usuarios: Usuario[] };
  yo: Yo;
  asignadoInicial?: string;
}): JSX.Element {
  const [tareas, setTareas] = useState<Tarea[]>(initial.tareas);
  const [asignado, setAsignado] = useState<string>(asignadoInicial);
  const [abierta, setAbierta] = useState<number | null>(null);
  const [creando, setCreando] = useState(false);
  const [arrastrando, setArrastrando] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const usuariosActivos = useMemo(
    () => initial.usuarios.filter((u) => u.activo),
    [initial.usuarios],
  );

  // El filtro del switch es del cliente: el server ya trajo TODAS las tareas
  // (el switch es igual para todos, admin o no). Filtrar acá evita un refetch
  // por cada cambio del select y mantiene el drag & drop sobre el mismo estado.
  const visibles = useMemo(() => {
    if (asignado === 'todas') return tareas;
    const id = Number(asignado);
    return Number.isFinite(id) ? tareas.filter((t) => t.asignadoA === id) : tareas;
  }, [tareas, asignado]);

  const grupos = useMemo(() => agruparPorColumna(visibles), [visibles]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const tareaPorId = (id: UniqueIdentifier): Tarea | undefined =>
    tareas.find((t) => t.id === Number(id));

  const nombreDe = (id: UniqueIdentifier): string => tareaPorId(id)?.titulo ?? String(id);
  const nombreColumna = (id: UniqueIdentifier | undefined): string => {
    if (id == null) return '';
    const s = String(id);
    if (s in ETIQUETA_COLUMNA) return ETIQUETA_COLUMNA[s as ColumnaId];
    return tareaPorId(id)?.columna ? ETIQUETA_COLUMNA[tareaPorId(id)!.columna] : s;
  };

  const announcements: Announcements = {
    onDragStart({ active }) {
      return `Agarraste la tarea ${nombreDe(active.id)}. Usá las flechas para moverla; Espacio o Enter para soltar.`;
    },
    onDragOver({ active, over }) {
      if (!over) return undefined;
      return `${nombreDe(active.id)} está sobre ${nombreColumna(over.id)}.`;
    },
    onDragEnd({ active, over }) {
      if (!over) return `${nombreDe(active.id)} volvió a su lugar.`;
      return `${nombreDe(active.id)} quedó en ${nombreColumna(over.id)}.`;
    },
    onDragCancel({ active }) {
      return `Movimiento cancelado: ${nombreDe(active.id)} quedó donde estaba.`;
    },
  };

  // Dado el `over` (que puede ser otra tarjeta o el contenedor de una columna),
  // ¿en qué columna cae y en qué índice dentro de ella?
  function destinoDelDrop(
    overId: UniqueIdentifier,
  ): { columna: ColumnaId; indice: number } | null {
    const overStr = String(overId);
    // Soltó sobre el contenedor de una columna (incluida una vacía): va al final.
    if (overStr in ETIQUETA_COLUMNA) {
      const col = overStr as ColumnaId;
      return { columna: col, indice: grupos[col].length };
    }
    // Soltó sobre otra tarjeta: su columna, en la posición de esa tarjeta.
    const overTarea = tareaPorId(overId);
    if (!overTarea) return null;
    const col = overTarea.columna;
    const idx = grupos[col].findIndex((t) => t.id === overTarea.id);
    return { columna: col, indice: idx < 0 ? grupos[col].length : idx };
  }

  async function handleDragEnd(event: DragEndEvent): Promise<void> {
    setArrastrando(null);
    const { active, over } = event;
    if (!over) return;

    const movida = tareaPorId(active.id);
    if (!movida) return;
    const destino = destinoDelDrop(over.id);
    if (!destino) return;

    const idsDestinoActual = grupos[destino.columna].map((t) => t.id);
    const mismaColumna = movida.columna === destino.columna;

    let ordenDestino: number[];
    if (mismaColumna) {
      const desde = idsDestinoActual.indexOf(movida.id);
      // El índice destino: si soltó sobre sí misma o el mismo lugar, no cambia.
      const hasta = Math.min(destino.indice, idsDestinoActual.length - 1);
      ordenDestino = nuevoOrdenAlSoltar(idsDestinoActual, desde, hasta);
      if (
        desde === hasta ||
        (ordenDestino.length === idsDestinoActual.length &&
          ordenDestino.every((x, i) => x === idsDestinoActual[i]))
      ) {
        // Nada cambió: no dispares un POST inútil.
        return;
      }
    } else {
      ordenDestino = moverEntreColumnas(idsDestinoActual, movida.id, destino.indice);
    }

    // Optimista: actualizá el estado local PRIMERO. Una tarjeta que se queda
    // donde la soltaste pero en la base está en otro lado es el peor resultado:
    // el siguiente refresh la mueve sola y parece un fantasma.
    const previo = tareas;
    setError(null);
    setTareas((prev) =>
      aplicarMovimiento(prev, movida.id, destino.columna, ordenDestino),
    );

    try {
      const res = await fetch('/api/tareas/mover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: movida.id, columna: destino.columna, orden: ordenDestino }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      // Rollback: volvé al estado anterior EXACTO y avisá.
      setTareas(previo);
      setError('No se pudo mover la tarjeta. Volvió a su lugar; reintentá.');
    }
  }

  function reemplazarTarea(t: Tarea): void {
    // Merge, no reemplazo bruto: si justo antes hubo un cambio de columna
    // (moverDesdeDetalle ya escribió columna+posicion), el PATCH trae la
    // posicion vieja y un reemplazo la revertiría. El merge deja que lo último
    // que se escribió de cada campo gane.
    setTareas((prev) => prev.map((x) => (x.id === t.id ? { ...x, ...t } : x)));
  }

  /**
   * Cambio de columna desde el select del detalle: la tarjeta va al FINAL de la
   * columna destino. Mismo optimista + POST + rollback que el drag & drop.
   * Lanza si el POST falla, para que el detalle muestre el error y no crea que
   * guardó.
   */
  async function moverDesdeDetalle(id: number, columna: ColumnaId): Promise<void> {
    const idsDestino = tareas
      .filter((t) => t.columna === columna && t.id !== id)
      .sort((a, b) => (a.posicion - b.posicion) || (a.id - b.id))
      .map((t) => t.id);
    const orden = [...idsDestino, id];

    const previo = tareas;
    setTareas((prev) => aplicarMovimiento(prev, id, columna, orden));
    try {
      const res = await fetch('/api/tareas/mover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, columna, orden }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      setTareas(previo);
      throw e;
    }
  }

  function quitarTarea(id: number): void {
    setTareas((prev) => prev.filter((x) => x.id !== id));
    setAbierta((a) => (a === id ? null : a));
  }

  /**
   * Una tarea creada entra al frente de su columna en el estado local: el
   * server ya la escribió con la `posicion` que le tocó (crearTarea la pone al
   * final internamente), así que no hace falta reescribir nada acá — a
   * diferencia de `aplicarMovimiento`, esto no es un reordenamiento, es un
   * alta. El próximo refresh la trae en el lugar exacto que el server decidió.
   */
  function agregarTarea(t: Tarea): void {
    setTareas((prev) => [...prev, t]);
  }

  const tareaAbierta = abierta != null ? tareas.find((t) => t.id === abierta) ?? null : null;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold -tracking-[0.01em] text-neutral-50">Tareas</h1>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-neutral-500">
            Mostrar
            {/* Mismo SELECT_HEADER que el select de funnel y el de rango: cuando
                divergen el header se ve desalineado. */}
            <select
              value={asignado}
              onChange={(e) => setAsignado(e.target.value)}
              className={SELECT_HEADER}
              aria-label="Filtrar tareas por asignado"
            >
              <option value="todas">Todas</option>
              {usuariosActivos.map((u) => (
                <option key={u.id} value={String(u.id)}>
                  {u.nombre}
                  {u.id === yo.id ? ' (yo)' : ''}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className={btnPrimary} onClick={() => setCreando(true)}>
            <Plus size={14} weight="bold" className="mr-1 inline" />
            Nueva tarea
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4">
          <Banner tone="bad">{error}</Banner>
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={(e: DragStartEvent) => setArrastrando(Number(e.active.id))}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setArrastrando(null)}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable:
              'Para tomar una tarea, apretá Espacio o Enter sobre su asa. Con las flechas la movés entre columnas; con Espacio o Enter la soltás.',
          },
        }}
      >
        {/* Las 4 columnas desde `lg` (1024px) y no desde `xl` (1280px): el
            `<main>` del layout mide `max-w-7xl` = 1280px, así que en un laptop de
            1152 o 1280 lógicos —la mitad de las pantallas— el tablero se veía en
            2 columnas de 2 filas, que es una lista, no un kanban. A 1024px cada
            columna queda en ~235px y la fila de chips de la tarjeta ya es
            `flex-wrap`, así que aguanta. */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          {ORDEN_COLUMNAS.map((col) => (
            <Columna
              key={col}
              id={col}
              titulo={ETIQUETA_COLUMNA[col]}
              tareas={grupos[col]}
              usuarios={initial.usuarios}
              onAbrir={(id) => setAbierta(id)}
            />
          ))}
        </div>

        <DragOverlay>
          {arrastrando != null && tareaPorId(arrastrando) ? (
            <TarjetaTarea
              tarea={tareaPorId(arrastrando)!}
              usuarios={initial.usuarios}
              overlay
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      {tareaAbierta && (
        <DetalleTarea
          tarea={tareaAbierta}
          yo={yo}
          usuarios={initial.usuarios}
          onCerrar={() => setAbierta(null)}
          onActualizada={reemplazarTarea}
          onBorrada={quitarTarea}
          onMover={moverDesdeDetalle}
        />
      )}

      {creando && (
        <NuevaTarea
          yo={yo}
          usuarios={usuariosActivos}
          onCerrar={() => setCreando(false)}
          onCreada={agregarTarea}
        />
      )}
    </div>
  );
}

/**
 * Aplica un movimiento al arreglo de tareas: la tarjeta `id` pasa a `columna` y
 * las posiciones de esa columna se reescriben 10, 20, 30… siguiendo `orden`
 * (D12). Es lo que hace el estado local coincidir con lo que el server va a
 * escribir, para que el refresh no mueva nada.
 */
export function aplicarMovimiento(
  tareas: readonly Tarea[],
  id: number,
  columna: ColumnaId,
  orden: readonly number[],
): Tarea[] {
  const posDe = new Map<number, number>();
  orden.forEach((tid, i) => posDe.set(tid, (i + 1) * 10));
  return tareas.map((t) => {
    if (t.id === id) {
      return { ...t, columna, posicion: posDe.get(id) ?? t.posicion };
    }
    if (t.columna === columna && posDe.has(t.id)) {
      return { ...t, posicion: posDe.get(t.id)! };
    }
    return t;
  });
}
