'use client';

/**
 * TablaAds — la Tabla_Anuncios (task 19.3 de gestion-campanas-anuncios).
 *
 * Un `<table>` PROPIO de la sección Anuncios: `components/ui.tsx` no se toca
 * (P-G04, R6 c5). La tabla compartida no tiene ancho por columna, ni asa de
 * redimensionado, ni encabezado ordenable, ni Columnas_Fijas pegadas, ni
 * grilla vertical, ni recorte con tooltip; esta tabla necesita las siete cosas.
 *
 * - Bordes (R6): `table-layout: fixed` con un `<colgroup>` que lleva el ancho
 *   de cada columna. Cada celda menos la última lleva `border-r
 *   border-overlay/4` → exactamente N−1 bordes verticales por fila, y ninguno
 *   cuando N es 1 (R6 c4). Los horizontales son los de la tabla compartida
 *   (BORDE_ENCABEZADO/BORDE_FILAS, origen `components/ui.tsx`). El hover sigue
 *   `hover:bg-overlay/2` sin tocar bordes (R6 c6). La fila de ancho completo
 *   del estado vacío usa `colSpan` y no lleva bordes verticales internos (R6 c9).
 * - Columnas_Fijas (R5 c9, R6 c8): `position: sticky; left: 0` con z-index por
 *   encima de las celdas que pasan atrás, y su propio `border-r` siempre
 *   visible durante el scroll.
 * - Redimensionado (R5): AsaRedimension, 1 px por píxel, 48..640, flechas ±16,
 *   Escape restaura. El ancho se registra en la configuración en pantalla
 *   (`onAncho`), NUNCA en el Repo_Vistas (R5 c6).
 * - Ancho por defecto de `nombre` (R5 c8): cuando la configuración no lo
 *   declara (ancho ≤ 0), se asigna el 25 % del ancho visible de la tabla,
 *   medido con un ResizeObserver, acotado al rango.
 * - Recorte por celda (R5 c10): ellipsis con `title` para el texto completo.
 * - Reordenamiento (R2 c6): `@dnd-kit/sortable`; el SortableContext incluye
 *   SOLO las claves no fijas, así arrastrar una Columna_Fija o soltar a su
 *   izquierda no produce un movimiento válido y el orden previo queda intacto.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
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
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { DotsThree, PencilSimple } from '@phosphor-icons/react';
import type { ClaveOrden, MetricasObjeto, NivelAds } from '@/lib/ads/tipos';
import {
  CLAVES_FIJAS,
  entrada,
  formatear,
  valorDeMetrica,
  type ColumnaVisible,
} from '@/lib/ads/catalogo';
import { AsaRedimension, ANCHO_MAX, ANCHO_MIN } from './AsaRedimension';
import { EncabezadoOrdenable, ariaSortDe } from './EncabezadoOrdenable';
import { MarcaFrescura, PresupuestoCelda, ToggleEstado, etiquetaEffective } from './celdas';
import {
  PopoverFila,
  posicionPopover,
  presupuestoEditable,
  useEsMobile,
  type EstadoPopover,
  type ModoPresupuesto,
  type VistaPopover,
} from './PopoverFila';
import { Badge, fmtMoney } from '@/components/ui';
import { MONEDA_REPORTE } from '@/lib/moneda-reporte';

/** El importe de la celda de presupuesto. Mismo formato que `celdas.tsx`. */
function money(n: number): string {
  return fmtMoney(n, MONEDA_REPORTE);
}

/** El ancho de la columna del menú «⋯». 44px = el mínimo táctil. */
const ANCHO_ACCIONES = 44;

/**
 * Alto con el que se decide si el popover entra abajo de la fila.
 *
 * Es una ESTIMACIÓN y no una medición, a propósito: medir el popover exige
 * montarlo primero, y montarlo en la posición equivocada para después
 * corregirla produce un salto visible de un frame. 300 es el alto del
 * formulario de presupuesto, que es el más alto de los tres; con el menú (que
 * mide ~180) el resultado es que a veces se abre arriba cuando abajo había
 * lugar, que es inofensivo. Lo que no puede pasar es lo contrario: abrirse
 * abajo y quedar cortado.
 */
const ALTO_POPOVER = 300;

/** El token del borde de celda. Origen: el borde entre filas del Table
 *  compartido de `components/ui.tsx` (`border-b border-overlay/4`): R6 c2
 *  exige que verticales y horizontales compartan color y grosor. */
export const BORDE_CELDA = 'border-overlay/4';
const BORDE_ENCABEZADO = 'border-border-subtle'; // components/ui.tsx, thead

export type FilaEnProceso = {
  /** Clave local, no un id de Meta: el id no existe todavía (design §15). */
  clave: string;
  nombrePlanificado: string;
  origenId: string;
  nivel: NivelAds;
};

export type PropsTablaAds = {
  filas: MetricasObjeto[];
  columnas: ColumnaVisible[];
  orden: { clave: ClaveOrden; dir: 'asc' | 'desc' };
  seleccionados: ReadonlySet<string>;
  /** Grilla vertical. En Tabla_Anuncios es siempre true (R6 c1). */
  grilla: boolean;
  onOrden: (clave: ClaveOrden) => void;
  onAncho: (clave: string, ancho: number) => void;
  onReordenar: (clave: string, posicion: number) => void;
  onSeleccion: (objectId: string) => void;
  onSeleccionTodas: () => void;
  onBajarNivel: (fila: MetricasObjeto) => void;
  onEditarPresupuesto: (fila: MetricasObjeto, eur: number) => void;
  onToggleEstado: (fila: MetricasObjeto) => void;
  /**
   * Sube al nivel campaña con la campaña de la fila como única cascada (2.12 de
   * `toggle-conjuntos-entrega`). Lo usa el link del tercer estado del
   * interruptor, para las filas cuyo `effective_status` dice `CAMPAIGN_PAUSED`.
   *
   * Es NAVEGACIÓN y no cascada de escritura: la campaña se activa con su propio
   * interruptor en su propia fila.
   */
  onIrACampania: (fila: MetricasObjeto) => void;
  /**
   * Los ids con un cambio de estado en vuelo (2.15 de `toggle-conjuntos-entrega`,
   * task 14.3). Sólo se DIBUJA con esto: la guarda de doble disparo es el `Set`
   * del ref de `GestorAnuncios`, que tiene que ser síncrono.
   *
   * Opcional para que la tabla se pueda dibujar sin él; sin el set, ninguna fila
   * se ve en curso, que es exactamente lo que se veía antes de esta task.
   */
  togglesEnCurso?: ReadonlySet<string>;
  /** Edición del nombre de UNA fila: abre el renombrado en modo exacto (R12 c1).
   *
   * `nombre` es el que el popover del rediseño v3 siembra en el campo. Es
   * opcional: sin él el diálogo abre con el campo vacío, que es como se
   * comportaba el lápiz de la celda antes del rediseño.
   */
  onRenombrarFila: (fila: MetricasObjeto, nombre?: string) => void;
  /**
   * Duplicar UNA fila desde el menú «⋯» (rediseño v3). Abre el
   * Dialogo_Confirmacion de `duplicate` con esa fila como único alcance, igual
   * que hace la barra de lote con la selección.
   */
  onDuplicarFila: (fila: MetricasObjeto) => void;
  /**
   * Filas fantasma de las copias en creación (R18 c4, c9): existen SOLO
   * mientras el lote está en vuelo, no son MetricasObjeto y se dibujan APARTE,
   * arriba de la tabla real, con el badge de creación en proceso. Se vacían
   * completas cuando el Endpoint_Acciones responde (R16 c6 sin excepción).
   */
  enProceso?: FilaEnProceso[];
  /**
   * La Zona_Cuenta, para la columna de inicio programado (R11 c8): la fecha y
   * hora se expresan en la zona de la cuenta, no en la del navegador.
   */
  zona?: string;
  /**
   * Segundos a partir de los cuales el dato de una fila se marca como viejo
   * (`ads_frescura_umbral_segundos` de `settings`, task 8 / R3.1).
   *
   * Obligatorio y sin default: el default vive en un solo lugar
   * (`GestorAnuncios`, que lo recibe del server component y de la respuesta del
   * endpoint), y una tabla con un umbral inventado marcaría filas contra un
   * número que nadie configuró.
   */
  umbralFrescura: number;
  /**
   * El instante contra el que se mide la antigüedad de TODAS las filas de esta
   * pintura. Lo pasa el llamador y no se lee de `Date.now()` por fila: con un
   * reloj por celda, dos filas confirmadas por la misma corrida del sync pueden
   * mostrar antigüedades distintas.
   */
  ahora: number;
};

const NIVEL_LABEL: Record<NivelAds, string> = {
  campaign: 'Campaña',
  adset: 'Conjunto',
  ad: 'Anuncio',
};

function acotar(a: number): number {
  return Math.min(ANCHO_MAX, Math.max(ANCHO_MIN, a));
}

/** La celda de un encabezado no fijo, envuelta en useSortable. */
function CeldaOrdenable({
  columna,
  ariaSort,
  className,
  style,
  children,
}: {
  columna: ColumnaVisible;
  ariaSort: 'ascending' | 'descending' | 'none' | undefined;
  className: string;
  style: React.CSSProperties;
  children: React.ReactNode;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: columna.clave,
  });
  return (
    <th
      ref={setNodeRef}
      scope="col"
      aria-sort={ariaSort}
      style={{ ...style, transform: CSS.Transform.toString(transform), transition }}
      className={`${className} ${isDragging ? 'z-30 opacity-60' : ''}`}
      {...attributes}
      {...listeners}
    >
      {children}
    </th>
  );
}

export function TablaAds(props: PropsTablaAds): JSX.Element {
  const { filas, columnas, orden, seleccionados, grilla } = props;
  const contenedor = useRef<HTMLDivElement | null>(null);
  /**
   * El MARCO: el div `position:relative` que envuelve al scroller horizontal y
   * que es el contexto de posicionamiento del popover.
   *
   * Tiene que ser un elemento distinto del scroller y no el scroller mismo:
   * `overflow-x: auto` con el otro eje en `visible` hace que el navegador
   * compute `overflow-y: auto` también, así que un popover absoluto adentro del
   * scroller queda RECORTADO abajo (o le agrega una barra de scroll vertical a
   * la tabla). Es la trampa clásica de "puse el popover adentro del contenedor
   * con scroll y desaparece".
   */
  const marco = useRef<HTMLDivElement | null>(null);
  const [anchoVisible, setAnchoVisible] = useState<number>(1200);
  const esMobile = useEsMobile();

  /** El popover anclado a una fila (rediseño v3). `null` = cerrado. */
  const [popover, setPopover] = useState<EstadoPopover | null>(null);

  const filaDelPopover = useMemo(
    () => (popover ? (filas.find((f) => f.objectId === popover.filaId) ?? null) : null),
    [popover, filas],
  );

  /**
   * Si la fila del popover desaparece de la página —cambió el filtro, se pasó de
   * página, el sync la dejó de devolver— el popover se cierra.
   *
   * Sin esto queda un formulario de presupuesto flotando sobre una tabla que ya
   * no muestra la fila de la que habla, y Guardar aplicaría el importe a un
   * objeto que no está en pantalla. Es el caso que hace que esto no sea una
   * prolijidad.
   */
  useEffect(() => {
    if (popover && filaDelPopover === null) setPopover(null);
  }, [popover, filaDelPopover]);

  /**
   * Abre el popover midiendo la fila y el marco en el momento del click.
   *
   * El `closest('tr')` sale del botón y no de un id de fila: el botón siempre
   * está dentro de su `<tr>`, y buscar el nodo por id obligaría a poner un id en
   * cada fila sólo para esto.
   */
  const abrirPopover = (fila: MetricasObjeto, boton: HTMLElement, vista: VistaPopover): void => {
    const tr = boton.closest('tr');
    const cajaMarco = marco.current?.getBoundingClientRect();
    if (!tr || !cajaMarco) return;
    const { top, left } = posicionPopover({
      ancla: boton.getBoundingClientRect(),
      fila: tr.getBoundingClientRect(),
      marco: cajaMarco,
      alto: ALTO_POPOVER,
      altoViewport: window.innerHeight,
    });
    setPopover({ vista, filaId: fila.objectId, top, left });
  };

  // R5 c8: el ancho por defecto del nombre es el 25 % del ancho visible.
  useEffect(() => {
    const el = contenedor.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setAnchoVisible(w);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const anchosEfectivos = useMemo(() => {
    const out = new Map<string, number>();
    for (const c of columnas) {
      let a = c.ancho;
      if (c.clave === 'nombre' && a <= 0) a = Math.round(anchoVisible * 0.25);
      out.set(c.clave, acotar(a));
    }
    return out;
  }, [columnas, anchoVisible]);

  const sensores = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const alArrastrar = (e: DragEndEvent): void => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const claves = columnas.map((c) => c.clave);
    const de = claves.indexOf(String(active.id));
    const a = claves.indexOf(String(over.id));
    // Sólo claves no fijas participan: soltar sobre una fija es imposible, y
    // el primer destino válido está siempre a la derecha de las fijas (R2 c6).
    if (de < 0 || a < 0) return;
    const nuevas = arrayMove(claves, de, a);
    props.onReordenar(String(active.id), nuevas.indexOf(String(active.id)));
  };

  const todasTildadas = filas.length > 0 && filas.every((f) => seleccionados.has(f.objectId));
  const algunas = !todasTildadas && filas.some((f) => seleccionados.has(f.objectId));
  const clavesNoFijas = columnas.filter((c) => !CLAVES_FIJAS.includes(c.clave as (typeof CLAVES_FIJAS)[number])).map((c) => c.clave);

  // El presupuesto ya no se edita en línea: lo hace el popover anclado a la fila
  // (rediseño v3). El estado por fila que había acá se fue con el input.

  const celda = (c: ColumnaVisible, fila: MetricasObjeto, i: number): React.ReactNode => {
    if (c.clave === 'seleccion') {
      return (
        <input
          type="checkbox"
          checked={seleccionados.has(fila.objectId)}
          onChange={() => props.onSeleccion(fila.objectId)}
          aria-label={`Seleccionar ${NIVEL_LABEL[fila.level].toLowerCase()} ${fila.objectName ?? fila.objectId}`}
          className="h-4 w-4 rounded border-overlay/20 bg-overlay/4 accent-good-500"
        />
      );
    }
    if (c.clave === 'nombre') {
      return (
        <span className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => props.onBajarNivel(fila)}
            disabled={fila.level === 'ad'}
            className="max-w-full truncate text-left text-neutral-200 underline-offset-2 hover:underline focus:outline-none focus:ring-2 focus:ring-good-500/50 disabled:cursor-default disabled:no-underline"
            title={fila.objectName ?? undefined}
          >
            {fila.objectName ?? '(sin nombre)'}
          </button>
          <button
            type="button"
            onClick={() => props.onRenombrarFila(fila)}
            aria-label={`Renombrar ${fila.objectName ?? fila.objectId}`}
            title="Renombrar este objeto"
            className="shrink-0 rounded p-0.5 text-neutral-500 hover:text-neutral-200 focus:outline-none focus:ring-2 focus:ring-good-500/50"
          >
            <PencilSimple size={12} />
          </button>
          {fila.effectiveStatus && fila.effectiveStatus !== fila.status && (
            <Badge tone="warn">{etiquetaEffective(fila.effectiveStatus)}</Badge>
          )}
          {/* R3.1: el dato viejo se ve viejo, y el objeto que Meta dejó de
              devolver se ve distinto del que sólo está atrasado. */}
          <MarcaFrescura fila={fila} umbralSegundos={props.umbralFrescura} ahora={props.ahora} />
        </span>
      );
    }
    if (c.clave === 'estado') {
      return (
        <ToggleEstado
          fila={fila}
          onToggle={props.onToggleEstado}
          onIrACampania={props.onIrACampania}
          enCurso={props.togglesEnCurso?.has(fila.objectId) ?? false}
        />
      );
    }
    if (c.clave === 'presupuesto') {
      /*
        Rediseño v3: cuando el presupuesto SE PUEDE editar, la celda es un botón
        con lápiz que abre el popover anclado a la fila. La edición en línea que
        había antes (un input dentro de la celda, de ~90px de ancho, en una tabla
        con scroll horizontal) se iba de pantalla al costado justo cuando había
        que leer el número que se estaba escribiendo.

        Cuando NO se puede editar sigue siendo `PresupuestoCelda`, que es la que
        tiene el texto del motivo por cada caso (nivel anuncio, presupuesto de
        por vida, presupuesto en otro nivel). No se duplica ese texto acá.
      */
      if (!presupuestoEditable(fila)) {
        return (
          <PresupuestoCelda
            fila={fila}
            edit={undefined}
            onEdit={() => undefined}
            onConfirm={() => undefined}
          />
        );
      }
      return (
        <button
          type="button"
          onClick={(e) => abrirPopover(fila, e.currentTarget, 'presupuesto')}
          aria-haspopup="dialog"
          aria-expanded={popover?.filaId === fila.objectId && popover.vista === 'presupuesto'}
          title="Editar presupuesto"
          className="tap group flex items-center gap-1.5 rounded px-1 text-neutral-200 transition-colors duration-250 hover:text-neutral-50 focus:outline-none focus:ring-2 focus:ring-good-500/50"
        >
          <span className="tabular-nums">
            {fila.dailyBudgetEur === null ? '—' : money(fila.dailyBudgetEur)}
          </span>
          <PencilSimple
            size={12}
            aria-hidden
            className="shrink-0 text-neutral-500 transition-colors duration-250 group-hover:text-good-400"
          />
        </button>
      );
    }

    const e = entrada(c.clave);
    if (!e) return '—';
    if (c.clave === 'inicioProgramado' && props.zona && typeof fila.inicioProgramado === 'string') {
      // R11 c8: la fecha y hora del inicio programado se expresan en la
      // Zona_Cuenta, no en la zona del navegador.
      const d = new Date(fila.inicioProgramado);
      if (Number.isNaN(d.getTime())) return '—';
      const valor = new Intl.DateTimeFormat('es-AR', {
        timeZone: props.zona,
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }).format(d);
      return (
        <span title={valor} className="block truncate">
          {valor}
        </span>
      );
    }
    const valor = formatear(e, valorDeMetrica(fila, c.clave as ClaveOrden));
    if (c.clave === 'ganancia') {
      return (
        <span className={fila.profitEur < 0 ? 'text-bad-400' : 'text-good-400'} title={valor}>
          {valor}
        </span>
      );
    }
    return (
      <span title={valor} className="block truncate">
        {valor}
      </span>
    );
  };

  return (
    /*
      El MARCO. No tiene overflow: es sólo el contexto de posicionamiento del
      popover, y el scroll horizontal vive en el div de adentro. Ver el comentario
      del ref `marco` para por qué no pueden ser el mismo elemento.
    */
    <div ref={marco} className="relative">
      <div ref={contenedor} className="overflow-x-auto">
        {props.enProceso && props.enProceso.length > 0 && (
          <div className="mb-2 space-y-1">
            {props.enProceso.map((f) => (
              <div
                key={f.clave}
                className="flex items-center gap-2 rounded-md border border-info-500/30 bg-info-500/[0.07] px-3 py-1.5 text-xs"
              >
                <Badge tone="info">creación en proceso</Badge>
                <span className="truncate text-neutral-200" title={f.nombrePlanificado}>
                  {f.nombrePlanificado}
                </span>
                <span className="text-neutral-500">
                  {NIVEL_LABEL[f.nivel].toLowerCase()} copiando de {f.origenId}
                </span>
              </div>
            ))}
          </div>
        )}
        <table className="w-full text-left text-sm" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            {columnas.map((c) => (
              <col key={c.clave} style={{ width: anchosEfectivos.get(c.clave) ?? acotar(c.ancho) }} />
            ))}
            {/* La columna del menú «⋯». Va en el colgroup y NO en el catálogo de
                columnas (`lib/ads/catalogo.ts`) a propósito: el catálogo define
                las columnas que se pueden ocultar, reordenar y redimensionar, y
                esta no es una de ellas — es el control de la fila y tiene que
                estar siempre, en el mismo lugar. Meterla al catálogo la haría
                ocultable, y un usuario que la oculta pierde el acceso a
                duplicar y renombrar sin ninguna forma de darse cuenta. */}
            <col style={{ width: ANCHO_ACCIONES }} />
          </colgroup>
          <thead>
            <tr className={`border-b ${BORDE_ENCABEZADO}`}>
              <DndContext sensors={sensores} collisionDetection={closestCenter} onDragEnd={alArrastrar}>
                <SortableContext items={clavesNoFijas} strategy={horizontalListSortingStrategy}>
                  {columnas.map((c, i) => {
                    const e = entrada(c.clave);
                    const esFija = CLAVES_FIJAS.includes(c.clave as (typeof CLAVES_FIJAS)[number]);
                    // Con la columna de acciones al final, NINGUNA columna del
                    // catálogo es la última: todas llevan su borde derecho, y la
                    // de acciones es la que no lo lleva. Sigue dando N−1 bordes
                    // verticales por fila (R6 c4), con N = columnas + 1.
                    const esUltima = false;
                    const leftFija = c.clave === 'nombre' ? (anchosEfectivos.get('seleccion') ?? 48) : 0;
                    const stickyClase = esFija ? 'sticky z-20 bg-surface' : '';
                    const clases = `relative px-3 py-2 align-middle text-xs font-semibold uppercase tracking-wide ${stickyClase} ${
                      grilla && !esUltima ? `border-r ${BORDE_CELDA}` : ''
                    }`;
                    const estilo: React.CSSProperties = esFija ? { position: 'sticky', left: leftFija } : {};

                    const contenido =
                      c.clave === 'seleccion'
                        ? (
                            <input
                              type="checkbox"
                              checked={todasTildadas}
                              ref={(el) => {
                                if (el) el.indeterminate = algunas;
                              }}
                              onChange={() => props.onSeleccionTodas()}
                              aria-label="Seleccionar todas las filas de la página"
                              className="h-4 w-4 rounded border-overlay/20 bg-overlay/4 accent-good-500"
                            />
                          )
                        : e
                          ? (
                              <EncabezadoOrdenable entrada={e} orden={orden} onOrden={props.onOrden}>
                                {e.rotulo}
                              </EncabezadoOrdenable>
                            )
                          : c.clave;

                    const cuerpo = (
                      <>
                        <span className="block truncate">{contenido}</span>
                        <AsaRedimension
                          ancho={anchosEfectivos.get(c.clave) ?? acotar(c.ancho)}
                          onAncho={(a) => props.onAncho(c.clave, a)}
                          label={`Ancho de la columna ${e?.rotulo ?? c.clave}`}
                        />
                      </>
                    );

                    const ariaSort = e ? ariaSortDe(e, orden) : undefined;

                    if (esFija) {
                      return (
                        <th
                          key={c.clave}
                          scope="col"
                          aria-sort={ariaSort}
                          style={estilo}
                          className={clases}
                        >
                          {cuerpo}
                        </th>
                      );
                    }
                    return (
                      <CeldaOrdenable
                        key={c.clave}
                        columna={c}
                        ariaSort={ariaSort}
                        className={clases}
                        style={estilo}
                      >
                        {cuerpo}
                      </CeldaOrdenable>
                    );
                  })}
                </SortableContext>
              </DndContext>
              {/* Sin rótulo visible: una columna de 44px no tiene lugar para una
                  palabra, y "acciones" en mayúsculas cortado a "ACC…" es peor que
                  nada. El nombre va en sr-only para el lector de pantalla. */}
              <th scope="col" className="px-2 py-2">
                <span className="sr-only">Acciones de la fila</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {filas.length === 0 ? (
              <tr className={`border-b ${BORDE_CELDA}`}>
                {/* Fila de ancho completo: sin bordes verticales internos (R6 c9). */}
                <td
                  colSpan={columnas.length + 1}
                  className="px-3 py-8 text-center text-sm text-neutral-500"
                >
                  Sin filas para estos filtros
                </td>
              </tr>
            ) : (
              filas.map((fila, i) => {
                const abierta = popover?.filaId === fila.objectId;
                return (
                  <tr
                    key={fila.objectId}
                    /*
                      La fila abierta se pinta con el acento OSCURO y no con el
                      `bg-overlay/2` del hover: con el popover encima, "la fila que
                      estoy editando" y "la fila que tengo debajo del mouse" tienen
                      que ser distinguibles. El hover se suprime en la fila activa
                      para que pasar el mouse no la apague.
                    */
                    className={`border-b ${BORDE_CELDA} last:border-0 ${
                      abierta ? 'bg-good-900' : 'hover:bg-overlay/2'
                    }`}
                  >
                    {columnas.map((c, j) => {
                      const esFija = CLAVES_FIJAS.includes(c.clave as (typeof CLAVES_FIJAS)[number]);
                      const esUltima = false;
                      const leftFija = c.clave === 'nombre' ? (anchosEfectivos.get('seleccion') ?? 48) : 0;
                      return (
                        <td
                          key={c.clave}
                          style={esFija ? { position: 'sticky', left: leftFija } : undefined}
                          className={`px-3 py-2.5 align-middle text-neutral-200 ${
                            /* La celda sticky necesita fondo SÓLIDO o se ve pasar
                               el contenido por debajo al scrollear. Cuando la fila
                               está abierta, ese fondo tiene que ser el del acento
                               y no `bg-surface`, o la primera columna queda como
                               un parche gris en medio de la fila verde. */
                            esFija ? (abierta ? 'sticky z-20 bg-good-900' : 'sticky z-20 bg-surface') : ''
                          } ${c.clave !== 'seleccion' && c.clave !== 'nombre' && c.clave !== 'estado' && c.clave !== 'presupuesto' ? 'font-mono text-right tabular-nums' : ''} ${
                            grilla && !esUltima ? `border-r ${BORDE_CELDA}` : ''
                          }`}
                        >
                          {celda(c, fila, i)}
                        </td>
                      );
                    })}
                    <td className="px-2 py-2.5 align-middle">
                      <button
                        type="button"
                        onClick={(e) => abrirPopover(fila, e.currentTarget, 'menu')}
                        aria-haspopup="dialog"
                        aria-expanded={abierta}
                        aria-label={`Acciones de ${fila.objectName ?? fila.objectId}`}
                        title="Presupuesto, renombrar, duplicar, pausar"
                        className={`press flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-250 focus:outline-none focus:ring-2 focus:ring-good-500/50 ${
                          abierta
                            ? 'bg-good-800 text-good-100'
                            : 'text-neutral-500 hover:bg-overlay/8 hover:text-neutral-100'
                        }`}
                      >
                        <DotsThree size={18} weight="bold" aria-hidden />
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {popover && filaDelPopover && (
        <PopoverFila
          estado={popover}
          fila={filaDelPopover}
          esMobile={esMobile}
          onVista={(vista) => setPopover((p) => (p ? { ...p, vista } : p))}
          onCerrar={() => setPopover(null)}
          /* Guardar CIERRA el popover y abre el Dialogo_Confirmacion con el
             importe sembrado. El popover no manda el POST: ver el encabezado de
             PopoverFila.tsx para por qué eso no es una vuelta innecesaria. */
          onPresupuesto={(eur: number, _modo: ModoPresupuesto) => {
            setPopover(null);
            props.onEditarPresupuesto(filaDelPopover, eur);
          }}
          onRenombrar={(nombre) => {
            setPopover(null);
            props.onRenombrarFila(filaDelPopover, nombre);
          }}
          onDuplicar={() => {
            setPopover(null);
            props.onDuplicarFila(filaDelPopover);
          }}
          onToggle={() => {
            setPopover(null);
            props.onToggleEstado(filaDelPopover);
          }}
        />
      )}
    </div>
  );
}

export { ANCHO_MIN, ANCHO_MAX };
