'use client';

/**
 * El runtime de widgets (task T03): la grilla de 4 columnas con los cuatro
 * tamaños de D-R03, el modo edición (agregar, sacar, reordenar arrastrando o
 * con teclado, cambiar tamaño) y el guardado en la VPS con botón explícito
 * (D-R04/D-R05).
 *
 * Es el ÚNICO lugar del rediseño con estado de layout: los widgets son
 * funciones puras de `(data, size)` a JSX (regla 2 del §4) y el catálogo es
 * data. Acá se decide qué se muestra, en qué orden y de qué tamaño.
 *
 * Cosas que se cumplen a propósito:
 * - El asa de arrastre es un elemento propio con aria-label, no el widget
 *   entero: adentro se puede seleccionar texto y clickear.
 * - KeyboardSensor de @dnd-kit (D-R16): Tab hasta el asa, Espacio para
 *   tomarlo, flechas para moverlo, Espacio para soltarlo. No es opcional.
 * - El `activationConstraint` de 8px evita que un clic en un botón del widget
 *   arranque un arrastre.
 * - Los anuncios del movimiento van al lector de pantalla (`announcements`).
 * - Al salir con cambios sin guardar se avisa: `beforeunload` cubre cerrar la
 *   pestaña y recargar, y un listener de clicks cubre la navegación interna
 *   del router (que no dispara `beforeunload`).
 */

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { Announcements, DragEndEvent, UniqueIdentifier } from '@dnd-kit/core';
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowsOut, CaretDown, Check, DotsSixVertical, PencilSimple, Plus, X } from '@phosphor-icons/react';
import { Banner, EmptyState, Grid } from './ui';
import { hasChanges, parseLayout, reorder, resolveLayout, resize } from '@/lib/widgets/layout';
import type {
  WidgetCatalogo,
  WidgetDef,
  WidgetGrupo,
  WidgetLayout,
  WidgetPlacement,
  WidgetSize,
} from '@/lib/widgets/tipos';

const GRUPO_ORDEN: WidgetGrupo[] = ['plata', 'volumen', 'eficiencia', 'calidad', 'graficos', 'listas'];

const GRUPO_LABEL: Record<WidgetGrupo, string> = {
  plata: 'Plata',
  volumen: 'Volumen',
  eficiencia: 'Eficiencia',
  calidad: 'Calidad',
  graficos: 'Gráficos',
  listas: 'Listas',
};

const TAMAÑO_LABEL: Record<string, string> = {
  '1x1': '1 × 1 · chico',
  '2x1': '2 × 1 · ancho',
  '1x2': '1 × 2 · alto',
  '2x2': '2 × 2 · grande',
};

function tamañoLabel(size: WidgetSize): string {
  return TAMAÑO_LABEL[`${size.w}x${size.h}`] ?? `${size.w} × ${size.h}`;
}

function spanClases(placement: WidgetPlacement): string {
  const ancho = placement.w === 2 ? 'md:col-span-2 xl:col-span-2' : '';
  const alto = placement.h === 2 ? 'row-span-2' : '';
  return `${ancho} ${alto}`.trim();
}

const BOTON_SECUNDARIO =
  'inline-flex items-center gap-1.5 rounded-lg border border-border-subtle bg-canvas px-3 py-1.5 text-xs font-medium text-neutral-200 transition-colors hover:bg-overlay/4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-good-500/60 disabled:cursor-not-allowed disabled:opacity-40';

const BOTON_CONTROL =
  'flex h-7 w-7 items-center justify-center rounded-lg border border-border-subtle bg-surface text-neutral-400 transition-colors hover:bg-overlay/4 hover:text-neutral-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-good-500/60';

type ControlesProps<T> = {
  def: WidgetDef<T>;
  placement: WidgetPlacement;
  onCambiarTamaño: (size: WidgetSize) => void;
  onSacar: () => void;
  atributosArrastre: ReturnType<typeof useSortable>['attributes'];
  listenersArrastre: ReturnType<typeof useSortable>['listeners'];
};

/** Los tres controles de edición de un widget: asa de arrastre, menú de
 *  tamaño y botón de quitar. Todos <button>: nada de <div onClick>. */
function ControlesWidget<T>({
  def,
  placement,
  onCambiarTamaño,
  onSacar,
  atributosArrastre,
  listenersArrastre,
}: ControlesProps<T>): JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        {...atributosArrastre}
        {...listenersArrastre}
        aria-label={`Arrastrar ${def.label} para reordenar`}
        title="Arrastrar para reordenar (o Tab + flechas)"
        className={`${BOTON_CONTROL} touch-none cursor-grab active:cursor-grabbing`}
      >
        <DotsSixVertical size={14} weight="bold" />
      </button>
      <MenuTamaños
        labelWidget={def.label}
        sizes={def.tamañosPermitidos}
        actual={placement}
        onChange={onCambiarTamaño}
      />
      <button
        type="button"
        onClick={onSacar}
        aria-label={`Quitar ${def.label}`}
        title="Quitar widget"
        className={BOTON_CONTROL}
      >
        <X size={14} weight="bold" />
      </button>
    </div>
  );
}

/** El menú de tamaño: ofrece SOLO los tamañosPermitidos del widget (regla 5
 *  del §4) y marca el actual. Etiquetas legibles, no "w:2,h:1". */
function MenuTamaños({
  labelWidget,
  sizes,
  actual,
  onChange,
}: {
  labelWidget: string;
  sizes: WidgetSize[];
  actual: WidgetSize;
  onChange: (size: WidgetSize) => void;
}): JSX.Element {
  const [abierto, setAbierto] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        aria-label={`Tamaño de ${labelWidget}`}
        aria-haspopup="menu"
        aria-expanded={abierto}
        title="Cambiar tamaño"
        className={BOTON_CONTROL}
      >
        <ArrowsOut size={14} weight="bold" />
      </button>
      {abierto && (
        <>
          <div className="fixed inset-0 z-20" aria-hidden="true" onClick={() => setAbierto(false)} />
          <div
            role="menu"
            aria-label={`Tamaño de ${labelWidget}`}
            className="absolute right-0 top-9 z-30 w-44 overflow-hidden rounded-xl border border-border-strong bg-surface-raised py-1 shadow-xl"
          >
            {sizes.map((s) => {
              const esActual = s.w === actual.w && s.h === actual.h;
              return (
                <button
                  key={`${s.w}x${s.h}`}
                  type="button"
                  role="menuitemradio"
                  aria-checked={esActual}
                  onClick={() => {
                    onChange(s);
                    setAbierto(false);
                  }}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-overlay/4 focus-visible:outline-none focus-visible:bg-overlay/4 ${
                    esActual ? 'text-good-300' : 'text-neutral-200'
                  }`}
                >
                  {tamañoLabel(s)}
                  {esActual && <Check size={12} weight="bold" />}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/** El contenedor visual de un widget: header con label + hint y el contenido
 *  renderizado con su tamaño. Sin controles en modo normal (no se ve nada de
 *  edición), con controles en modo edición. */
function TarjetaWidget<T>({
  def,
  placement,
  data,
  arrastrando = false,
  controles,
}: {
  def: WidgetDef<T>;
  placement: WidgetPlacement;
  data: T;
  arrastrando?: boolean;
  controles?: ReactNode;
}): JSX.Element {
  return (
    <div
      className={`flex h-full flex-col rounded-2xl border border-border-subtle bg-surface shadow-inset-highlight transition-opacity ${
        arrastrando ? 'opacity-80' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-3 border-b border-border-subtle px-4 py-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-neutral-100">{def.label}</h3>
          {def.hint && <p className="mt-0.5 text-xs text-neutral-500">{def.hint}</p>}
        </div>
        {controles && <div className="flex shrink-0 items-center gap-1.5">{controles}</div>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {def.render(data, { w: placement.w, h: placement.h })}
      </div>
    </div>
  );
}

/** Un widget dentro del SortableContext: el asa es el único elemento con
 *  listeners de arrastre, y todo el movimiento se anuncia al lector de
 *  pantalla desde el DndContext padre. */
function WidgetOrdenable<T>({
  placement,
  def,
  data,
  onCambiarTamaño,
  onSacar,
}: {
  placement: WidgetPlacement;
  def: WidgetDef<T>;
  data: T;
  onCambiarTamaño: (size: WidgetSize) => void;
  onSacar: () => void;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: placement.id,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`relative ${spanClases(placement)} ${isDragging ? 'z-10' : ''}`}
    >
      <TarjetaWidget
        def={def}
        placement={placement}
        data={data}
        arrastrando={isDragging}
        controles={
          <ControlesWidget
            def={def}
            placement={placement}
            onCambiarTamaño={onCambiarTamaño}
            onSacar={onSacar}
            atributosArrastre={attributes}
            listenersArrastre={listeners}
          />
        }
      />
    </div>
  );
}

/** La lista de widgets para agregar, agrupada por `grupo` del catálogo, con
 *  el hint visible y los que ya están en pantalla deshabilitados. */
function ListaWidgets<T>({
  catalogo,
  placements,
  onAgregar,
}: {
  catalogo: WidgetCatalogo<T>;
  placements: WidgetPlacement[];
  onAgregar: (id: string) => void;
}): JSX.Element {
  const enPantalla = new Set(placements.map((p) => p.id));

  return (
    <div className="mb-4 rounded-2xl border border-border-subtle bg-surface p-4">
      {GRUPO_ORDEN.map((grupo) => {
        const defs = Object.values(catalogo).filter((d) => d.grupo === grupo);
        if (defs.length === 0) return null;
        return (
          <div key={grupo} className="mb-4 last:mb-0">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
              {GRUPO_LABEL[grupo]}
            </h3>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {defs.map((def) => {
                const yaEsta = enPantalla.has(def.id);
                return (
                  <button
                    key={def.id}
                    type="button"
                    disabled={yaEsta}
                    onClick={() => onAgregar(def.id)}
                    className={`rounded-xl border border-border-subtle bg-canvas px-3 py-2 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-good-500/60 disabled:cursor-default disabled:opacity-45 ${
                      yaEsta ? '' : 'hover:border-border-strong hover:bg-overlay/3'
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-neutral-100">{def.label}</span>
                      <span className={`text-[11px] font-semibold ${yaEsta ? 'text-neutral-500' : 'text-good-400'}`}>
                        {yaEsta ? 'En pantalla' : '+ Agregar'}
                      </span>
                    </span>
                    {def.hint && <span className="mt-0.5 block text-xs text-neutral-500">{def.hint}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

type EstadoGuardado = 'idle' | 'saving' | 'saved' | 'error';

/**
 * El runtime completo. `data` entra UNA vez y baja a cada widget: ningún
 * widget hace su propio fetch (regla 2 del §4 del plan).
 */
export function WidgetGrid<T>({
  pantalla,
  catalogo,
  data,
  porDefecto,
  layoutGuardado,
}: {
  pantalla: 'resumen' | 'ventas';
  catalogo: WidgetCatalogo<T>;
  data: T;
  porDefecto: WidgetPlacement[];
  layoutGuardado: WidgetLayout | null;
}): JSX.Element {
  // El prop entra como venga (incluso el jsonb crudo de la base): parseLayout
  // lo normaliza y nunca tira, así que un layout guardado mal no puede dejar
  // la pantalla en blanco (regla 4 del §4 del plan).
  const layoutValidado = useMemo(() => parseLayout(layoutGuardado), [layoutGuardado]);
  const resuelto = useMemo(
    () => resolveLayout(layoutValidado, catalogo, porDefecto),
    [layoutValidado, catalogo, porDefecto],
  );

  const [editando, setEditando] = useState(false);
  const [listaAbierta, setListaAbierta] = useState(false);
  const [placements, setPlacements] = useState<WidgetPlacement[]>(resuelto.placements);
  const [guardado, setGuardado] = useState<WidgetPlacement[]>(resuelto.placements);
  const [desconocidos, setDesconocidos] = useState<string[]>(resuelto.desconocidos);
  const [estado, setEstado] = useState<EstadoGuardado>('idle');

  const dirty = hasChanges(placements, guardado);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const nombreDe = (id: UniqueIdentifier): string =>
    typeof id === 'string' ? (catalogo[id]?.label ?? id) : String(id);

  const announcements: Announcements = {
    onDragStart({ active }) {
      return `Agarraste ${nombreDe(active.id)}. Usá las flechas para moverlo; Espacio o Enter para soltar.`;
    },
    onDragOver({ active, over }) {
      if (!over) return undefined;
      return `${nombreDe(active.id)} está sobre ${nombreDe(over.id)}.`;
    },
    onDragEnd({ active, over }) {
      if (!over) return `${nombreDe(active.id)} volvió a su lugar.`;
      return `${nombreDe(active.id)} ahora está en el lugar de ${nombreDe(over.id)}.`;
    },
    onDragCancel({ active }) {
      return `Movimiento cancelado: ${nombreDe(active.id)} quedó donde estaba.`;
    },
  };

  // Guardar vacío es un layout válido (D-R04): NULL y [] son estados distintos
  // y este endpoint los trata como tales.
  async function guardarLayout(): Promise<void> {
    if (estado === 'saving') return;
    setEstado('saving');
    try {
      const res = await fetch('/api/config/ui-layout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pantalla, layout: { v: 1, widgets: placements } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setGuardado(placements);
      setDesconocidos([]);
      setEstado('saved');
    } catch {
      setEstado('error');
    }
  }

  function descartar(): void {
    setPlacements(guardado);
    setEstado('idle');
  }

  function salirDeEditar(): void {
    if (
      dirty &&
      !window.confirm('Hay cambios sin guardar en el layout. Se van a descartar. ¿Salir del modo edición?')
    ) {
      return;
    }
    setPlacements(guardado);
    setListaAbierta(false);
    setEditando(false);
    setEstado('idle');
  }

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setPlacements((prev) => {
      const from = prev.findIndex((p) => p.id === active.id);
      const to = prev.findIndex((p) => p.id === over.id);
      return from === -1 || to === -1 ? prev : reorder(prev, from, to);
    });
  }

  function agregar(id: string): void {
    const def = catalogo[id];
    if (!def) return;
    setPlacements((prev) =>
      prev.some((p) => p.id === id)
        ? prev
        : [...prev, { id, w: def.tamañoPorDefecto.w, h: def.tamañoPorDefecto.h }],
    );
  }

  function sacar(id: string): void {
    setPlacements((prev) => prev.filter((p) => p.id !== id));
  }

  function cambiarTamaño(id: string, size: WidgetSize): void {
    setPlacements((prev) => resize(prev, id, size, catalogo));
  }

  // "Guardado" se muestra unos segundos y vuelve a idle.
  useEffect(() => {
    if (estado !== 'saved') return;
    const t = setTimeout(() => setEstado('idle'), 3000);
    return () => clearTimeout(t);
  }, [estado]);

  // Cerrar la pestaña o recargar con cambios pendientes avisa (D-R05).
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // La navegación interna del router NO dispara beforeunload: un listener en
  // captura cubre los <a> internos (el Nav) mientras haya cambios sin guardar.
  useEffect(() => {
    if (!dirty) return;
    function onDocClick(e: MouseEvent): void {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      const anchor = (e.target as Element | null)?.closest?.('a[href]');
      if (!anchor) return;
      const href = anchor.getAttribute('href') ?? '';
      if (href === '' || href.startsWith('#') || /^(https?:)?\/\//.test(href)) return;
      if (window.confirm('Hay cambios sin guardar en el layout. Si salís de esta pantalla se pierden. ¿Salir igual?')) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    }
    document.addEventListener('click', onDocClick, true);
    return () => document.removeEventListener('click', onDocClick, true);
  }, [dirty]);

  const hayWidgets = placements.length > 0;

  return (
    <div>
      {editando ? (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border-subtle bg-surface px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setListaAbierta((v) => !v)}
                aria-expanded={listaAbierta}
                className={BOTON_SECUNDARIO}
              >
                <Plus size={14} weight="bold" />
                Agregar widgets
                <CaretDown size={12} weight="bold" className={listaAbierta ? 'rotate-180' : ''} />
              </button>
              {dirty && <span className="text-xs font-medium text-warn-400">Cambios sin guardar</span>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {estado === 'saved' && <span className="text-xs font-medium text-good-400">Guardado</span>}
              {estado === 'error' && (
                <span className="text-xs font-medium text-bad-400">No se pudo guardar: reintentá</span>
              )}
              <button type="button" onClick={descartar} disabled={!dirty} className={BOTON_SECUNDARIO}>
                Descartar
              </button>
              <button
                type="button"
                onClick={guardarLayout}
                disabled={!dirty || estado === 'saving'}
                className="inline-flex items-center gap-1.5 rounded-lg bg-good-500 px-3 py-1.5 text-xs font-semibold text-neutral-950 transition-colors hover:bg-good-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-good-500/60 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {estado === 'saving' ? 'Guardando…' : 'Guardar'}
              </button>
              <button type="button" onClick={salirDeEditar} className={BOTON_SECUNDARIO}>
                Listo
              </button>
            </div>
          </div>

          <p className="mb-4 text-xs text-neutral-500">
            Este layout lo ven todos los que entran al panel: la contraseña es compartida y no hay
            usuarios.
          </p>

          {listaAbierta && <ListaWidgets catalogo={catalogo} placements={placements} onAgregar={agregar} />}
        </>
      ) : (
        <div className="mb-4 flex items-center justify-end">
          <button type="button" onClick={() => setEditando(true)} className={BOTON_SECUNDARIO}>
            <PencilSimple size={14} weight="bold" />
            Editar widgets
          </button>
        </div>
      )}

      {desconocidos.length > 0 && (
        <div className="mb-4">
          <Banner tone="warn">
            {desconocidos.length === 1
              ? '1 widget guardado ya no existe y se ignoró. Al guardar se quita del layout.'
              : `${desconocidos.length} widgets guardados ya no existen y se ignoraron. Al guardar se quitan del layout.`}
          </Banner>
        </div>
      )}

      {hayWidgets ? (
        editando ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
            accessibility={{
              announcements,
              screenReaderInstructions: {
                draggable:
                  'Para tomar un widget, apretá Espacio o Enter. Con las flechas lo movés; con Espacio o Enter lo soltás.',
              },
            }}
          >
            <SortableContext items={placements.map((p) => p.id)} strategy={rectSortingStrategy}>
              <Grid className="auto-rows-[240px]">
                {placements.map((p) => {
                  const def = catalogo[p.id];
                  if (!def) return null;
                  return (
                    <WidgetOrdenable
                      key={p.id}
                      placement={p}
                      def={def}
                      data={data}
                      onCambiarTamaño={(size) => cambiarTamaño(p.id, size)}
                      onSacar={() => sacar(p.id)}
                    />
                  );
                })}
              </Grid>
            </SortableContext>
          </DndContext>
        ) : (
          <Grid className="auto-rows-[240px]">
            {placements.map((p) => {
              const def = catalogo[p.id];
              if (!def) return null;
              return (
                <div key={p.id} className={spanClases(p)}>
                  <TarjetaWidget def={def} placement={p} data={data} />
                </div>
              );
            })}
          </Grid>
        )
      ) : (
        <EmptyState
          title="No hay widgets en esta pantalla"
          hint="Entrá al modo edición y agregá los que quieras ver."
        />
      )}
    </div>
  );
}
