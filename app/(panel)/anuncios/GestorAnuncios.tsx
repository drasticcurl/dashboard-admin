'use client';

/**
 * GestorAnuncios (task 20.4): el ÚNICO componente con estado de la pantalla
 * /anuncios. Reemplaza a AnunciosView en un swap atómico (AnunciosView.tsx se
 * elimina en esta task). Todo lo demás recibe props y emite callbacks.
 *
 * El estado es: Nivel_Activo, Seleccion_Activa, Filtro_Cascada, columnas en
 * pantalla, Orden_Tabla y página. Las transiciones de nivel, filtro y cascada
 * se delegan a `lib/ads/seleccion.ts` (la misma máquina de estados que verifica
 * la Property 8). La URL refleja el Nivel_Activo y la lista completa de ids de
 * la cascada (R8 c7), y al cargar con esos parámetros la tabla abre ya filtrada
 * sin intervención del usuario (R8 c13).
 *
 * Después de una Accion_Lote se vuelven a pedir las filas y se dibuja SOLO lo
 * que devolvió ese pedido, descartando todo valor optimista (R16 c6); si ese
 * pedido falla o tarda más de 10 s, el detalle de resultados queda visible, se
 * avisa que la tabla puede no reflejar el servidor y se ofrece reintentar
 * (R16 c7). El toggle de una fila no confirmada queda en el valor del servidor
 * (R16 c10).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { UMBRAL_FRESCURA_DEFAULT_SEGUNDOS } from '@/lib/ads/frescura';
import type { FrescuraAds } from '@/lib/ads/live';
import type { FrescuraJerarquia } from '@/lib/ads/liveJerarquia';
import { plazoClienteEstadoMs } from '@/lib/ads/plazos';
import { textoEdad, usePollingGasto } from '@/lib/ads/polling';
import type {
  AccionAds,
  ClaveOrden,
  MetricasObjeto,
  NivelAds,
  PeriodoAds,
  ResultadoMetricas,
} from '@/lib/ads/tipos';
import type { CuentaAds } from './page';
import { TabsNivel } from './TabsNivel';
import { BarraFrescura } from './BarraFrescura';
import { BarraFiltros } from './BarraFiltros';
import { ChipCascada } from './ChipCascada';
import { ControlVistas } from './ControlVistas';
import { TablaAds, type FilaEnProceso } from './TablaAds';
import { frasesFrescura, resumenFrescura } from './celdas';
import { Paginacion } from './Paginacion';
import { BarraSeleccion } from './BarraSeleccion';
import { DialogoConfirmacion } from './DialogoConfirmacion';
import { FormularioPresupuesto } from './FormularioPresupuesto';
import { FormularioDuplicar } from './FormularioDuplicar';
import { FormularioRenombrar, modoDeFormulario, type ModoFormulario } from './FormularioRenombrar';
import { FormularioProgramar } from './FormularioProgramar';
import { isoConOffset, mananaMedianocheLocal } from './zonaHoraria';
import { ResultadosLote, type RespuestaLote } from './ResultadosLote';
import { Banner, Card, EmptyState, Skeleton, StatCard, fmtInt, fmtMoney } from '@/components/ui';
import {
  aplicarEvento,
  estadoInicial,
  type Cascada,
  type EstadoSeleccion,
  type EventoSeleccion,
  MAX_SELECCION,
} from '@/lib/ads/seleccion';
import { cascadaDeCampania, cascadaInicial, paramsDeNivel } from './cascadaUrl';
import {
  calcularPrevisualizacion,
  type ParametrosAccion,
  type Previsualizacion as Previa,
} from '@/lib/ads/previsualizacion';
import { parsearPresupuesto } from '@/lib/ads/presupuesto';
import {
  avisoDeLote,
  mensajeDeResultado,
  type Aviso,
  type CuerpoAcciones,
} from '@/lib/ads/mensajes';
import {
  columnasParaRender,
  CATALOGO_METRICAS,
  type ColumnaVisible,
} from '@/lib/ads/catalogo';
import {
  parseRepoVistas,
  resolverVista,
  type Orden,
  type RepoVistas,
  type Vista,
} from '@/lib/ads/vistas';
import { siguienteOrden, ORDEN_DEFAULT, type EstadoOrden } from '@/lib/ads/orden';

type Respuesta = ResultadoMetricas & {
  adsFreshness?: FrescuraAds;
  /**
   * La frescura de la Jerarquía, y `null` cuando el pedido no llevó `forzar`:
   * sin `forzar` el endpoint no la consulta (R4.8), así que `null` es "este
   * pedido no preguntó" y NO "está vieja". Ver `aplicarRespuesta`.
   */
  jerarquiaFreshness?: FrescuraJerarquia | null;
  maxDailyBudgetEur?: number;
  maxDeltaPorTickEur?: number;
  /** Segundos a partir de los cuales una Frescura_Objeto se considera vieja (025). */
  frescuraUmbralSegundos?: number;
  alcanceError?: string | null;
  sinCuentas?: boolean;
};

const NIVEL_LABEL: Record<NivelAds, string> = {
  campaign: 'Campañas',
  adset: 'Conjuntos',
  ad: 'Anuncios',
};

function money(n: number): string {
  return fmtMoney(n, 'EUR');
}

/**
 * Los sustantivos de cada nivel, con la concordancia del adjetivo de estado.
 * «campañas activas» y «conjuntos activos»: el select de Barra_Filtros dice
 * «Activos» para los tres niveles porque ahí es una opción suelta, pero acá el
 * alcance se lee como prosa dentro del rótulo del KPI.
 */
const OBJETOS_NIVEL: Record<NivelAds, { plural: string; activo: string; pausado: string }> = {
  campaign: { plural: 'campañas', activo: 'activas', pausado: 'pausadas' },
  adset: { plural: 'conjuntos', activo: 'activos', pausado: 'pausados' },
  ad: { plural: 'anuncios', activo: 'activos', pausado: 'pausados' },
};

/**
 * El alcance de los totales en dos palabras, para el rótulo de cada StatCard
 * (R7.2, R7.4 — task 17.2).
 *
 * Sólo nivel y estado, que son los dos filtros que hacen entrar y salir filas de
 * un total sin que la plata cambie: pausar un conjunto con el filtro en
 * «Activos» lo saca del agregado, y con el rótulo «Gasto» a secas eso se lee
 * como una caída de gasto. Con «Gasto de conjuntos activos» se lee por lo que
 * es. Los demás filtros vigentes van en `detalleDeTotales`: meterlos todos en
 * cuatro rótulos truncados los haría ilegibles sin agregar información.
 */
export function alcanceDeTotales(nivel: NivelAds, status: 'active' | 'paused' | 'any'): string {
  const o = OBJETOS_NIVEL[nivel];
  if (status === 'active') return `${o.plural} ${o.activo}`;
  if (status === 'paused') return `${o.plural} ${o.pausado}`;
  return o.plural;
}

/**
 * La línea de contexto de abajo de la barra de KPIs: sobre cuántas filas están
 * calculados los cuatro números y qué más los está recortando (R7.2).
 *
 * Va una sola vez y no en el `sub` de cada tarjeta porque es la misma frase para
 * los cuatro, y el `sub` del gasto ya lleva su Marca_Frescura.
 *
 * La cláusula «no las N en pantalla» aparece SÓLO cuando los dos números
 * difieren: con el filtro entero en una página no hay ambigüedad que aclarar, y
 * la aclaración permanente sería ruido en el caso normal.
 */
export function detalleDeTotales(a: {
  filasFiltro: number;
  filasPantalla: number;
  nombre: string;
  cascada: { nivel: 'campaign' | 'adset'; ids: readonly string[] } | null;
  ocultarSinDatos: boolean;
  ocultarPadreApagado: boolean;
}): string {
  const cuenta = `${fmtInt(a.filasFiltro)} ${a.filasFiltro === 1 ? 'fila' : 'filas'}`;
  const partes = [
    a.filasPantalla < a.filasFiltro
      ? `Sobre ${cuenta} del filtro, no las ${fmtInt(a.filasPantalla)} en pantalla`
      : `Sobre ${cuenta} del filtro`,
  ];
  if (a.nombre !== '') partes.push(`nombre contiene «${a.nombre}»`);
  if (a.cascada && a.cascada.ids.length > 0) {
    const n = a.cascada.ids.length;
    const padre =
      a.cascada.nivel === 'campaign' ? (n === 1 ? 'campaña' : 'campañas') : n === 1 ? 'conjunto' : 'conjuntos';
    partes.push(`dentro de ${fmtInt(n)} ${padre}`);
  }
  if (a.ocultarSinDatos) partes.push('sin las filas sin datos');
  if (a.ocultarPadreApagado) partes.push('sin las que tienen el padre apagado');
  return partes.join(' · ');
}

const TOPES_ABORTO = 10_000; // R16 c7: 10 s para el refetch posterior a un lote

/**
 * Las tres caras del importe que el usuario tiene escrito en el diálogo de
 * presupuesto (task 3.2 de frescura-y-acciones-anuncios).
 *
 * Existen juntas porque el bug que este spec vino a arreglar fue exactamente que
 * estaban separadas: la Previsualizacion se recalculaba con `Number(texto)`, el
 * botón Ejecutar no miraba el texto para nada y el payload se armaba desde
 * `confirmacion.params.budgetEur`, que en el camino de la barra de lote nunca
 * existió. `JSON.stringify` borra las claves con `undefined`, así que el pedido
 * salía sin `budgetEur` y el zod del route respondía `Required` (R1 c1).
 *
 * `cuerpo` es el fragmento del payload y su `budgetEur` es **obligatorio y
 * number**: no hay forma de mandarlo vacío. Es lo que hace imposible el
 * `Required` por construcción y no por cuidado del llamador.
 */
export type PresupuestoDelDialogo =
  | {
      ok: true;
      /** Lo que se mezcla en el payload del Endpoint_Acciones. */
      cuerpo: { budgetEur: number };
      /** Lo que recalcula la Previsualizacion: el MISMO importe que se manda. */
      params: ParametrosAccion;
      bloqueo: null;
    }
  | {
      ok: false;
      cuerpo: null;
      /** Sin importe: la previa muestra "después: —" en lugar de un valor que no se va a mandar. */
      params: ParametrosAccion;
      /** El motivo, en castellano, por el que Ejecutar queda deshabilitado (R1 c4). */
      bloqueo: string;
    };

/**
 * Interpreta el texto del campo de presupuesto una sola vez para los tres
 * consumidores. PURA y exportada para el test de la Property 4: mientras el
 * armado del payload viva del mismo resultado que el bloqueo del botón, no puede
 * existir un texto que habilite Ejecutar y produzca un pedido sin importe o con
 * otro importe (R1 c1, c3, c5).
 */
export function presupuestoDelDialogo(texto: string, techoEur: number): PresupuestoDelDialogo {
  const importe = parsearPresupuesto(texto, techoEur);
  if (!importe.ok) {
    // El `texto` del rechazo y no `textoDeMotivo(motivo)`: es el MISMO campo del
    // MISMO objeto que pinta el borde rojo del campo en `FormularioPresupuesto`,
    // así que los dos mensajes no pueden contradecirse por construcción (3.6). Y
    // es el único que trae la explicación interpolada de `ambiguo`, que nombra
    // las dos lecturas posibles del texto y no puede salir de un `Record` fijo.
    return { ok: false, cuerpo: null, params: {}, bloqueo: importe.texto };
  }
  return {
    ok: true,
    cuerpo: { budgetEur: importe.valor },
    params: { budgetEur: importe.valor },
    bloqueo: null,
  };
}

/**
 * El texto con el que se siembra el campo cuando la acción llega con un importe
 * ya resuelto (la edición de la celda de una fila). Con dos decimales fijos para
 * que vuelva a entrar por `parsearPresupuesto` como el mismo número: es la ida y
 * vuelta que R1 c2 pide para que la previa muestre el "después" en lugar de un
 * guion.
 */
export function textoDeImporte(eur: number | undefined): string {
  return typeof eur === 'number' && Number.isFinite(eur) ? eur.toFixed(2) : '';
}

/**
 * La acción que le corresponde al interruptor de una fila (task 4.1 de
 * frescura-y-acciones-anuncios, R2 c1 y c2).
 *
 * `status === 'ACTIVE'` es LA MISMA comparación con la que `ToggleEstado` de
 * `celdas.tsx` decide si dibuja el interruptor encendido. Que las dos salgan de
 * la misma expresión es todo el punto: antes acá estaba `status === 'PAUSED' ?
 * 'activate' : 'pause'`, que manda `pause` para cualquier valor que no sea
 * literalmente `PAUSED`. Una fila con `status` nulo —o con un valor que este
 * cliente no conoce— se dibujaba apagada y al tocarla pedía pausar: quedaba
 * imposible de encender desde el panel, que es el bug reportado como "el de
 * habilitar conjunto parece que lo habilita pero realmente no lo hace".
 *
 * Pura y exportada para el test de la Property 1: la coherencia entre lo que se
 * dibuja y lo que se pide tiene que poder verificarse para TODO valor de
 * `status`, y este repo corre vitest en node, sin render.
 */
export function accionDeToggle(status: string | null): 'pause' | 'activate' {
  return status === 'ACTIVE' ? 'pause' : 'activate';
}

/**
 * El `status` que el Pintado_Optimista deja en la fila para cada acción. Sale de
 * acá y no de un ternario suelto porque la reversión lo necesita para saber si
 * la fila todavía muestra lo que pintamos.
 */
export function statusOptimista(accion: 'pause' | 'activate'): 'PAUSED' | 'ACTIVE' {
  return accion === 'pause' ? 'PAUSED' : 'ACTIVE';
}

/**
 * La oración con la que termina TODO aviso de un toggle que no confirmó,
 * **textual en las dos ramas** de `textoDeFalloDeToggle` (task 16.2, R2.6).
 *
 * Es una constante y no dos literales copiados porque es lo único que el aviso
 * puede afirmar cuando el desenlace es indeterminado, y porque es la oración que
 * los tests de las dos causas —la red en `toggleEstado.test.ts`, el plazo acá—
 * buscan por la palabra «reconciliación».
 *
 * **Lo que NO dice, y no puede decir: que el cambio no ocurrió.** Un POST cortado
 * pudo haberse aplicado en Meta igual (R3.1), así que el aviso dice qué pasó con
 * la FILA —que quedó como estaba— y deja el desenlace del PEDIDO abierto. Es el
 * mismo criterio con el que `enviar` clasifica su propio timeout como
 * `indeterminado` en lugar de como fallo.
 */
const CIERRE_INDETERMINADO =
  'La fila quedó como estaba; si el pedido llegó a Meta, el resultado se define ' +
  'cuando corra la reconciliación.';

/**
 * ¿Este error es el plazo del cliente que se venció, y no otra cosa?
 *
 * Mira `error.name`, que es donde el `DOMException` de un `AbortSignal` lo pone:
 * `TimeoutError` cuando el signal salió de `AbortSignal.timeout` en Node/undici
 * —el caso de este código— y `AbortError` en algunos navegadores. Los dos nombres
 * están medidos y anotados en el docblock de `errorDePlazo` de
 * `toggleEstado.test.ts`.
 *
 * **Cuando no reconoce nada devuelve `false`, y eso cae al segundo texto a
 * propósito: decir menos, no afirmar más.** El segundo texto interpola el mensaje
 * del error, que para un error desconocido es más informativo que una frase sobre
 * un plazo que puede no haber sido la causa. La rama del plazo afirma algo
 * concreto —«esperamos 44 s»— y sólo se usa cuando eso es verdad.
 */
export function esAbortoPorPlazo(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const nombre = (error as { name?: unknown }).name;
  return nombre === 'TimeoutError' || nombre === 'AbortError';
}

/**
 * El texto del aviso cuando un toggle no confirma (task 16.2).
 *
 * Pura y exportada, el mismo patrón que `accionDeToggle` y `statusOptimista`: el
 * texto de un aviso que tiene que cumplir R2.6 y R3.1 se verifica sin render o no
 * se verifica.
 *
 * Dos ramas, porque el vencimiento del plazo y un error de red son dos hechos
 * distintos para el usuario aunque el desenlace sea el mismo. Antes de esta
 * función había una sola y el `catch` interpolaba `e.message`, que para un
 * `AbortSignal.timeout` es `The operation was aborted due to timeout`: una frase
 * en inglés dentro de un aviso en castellano, que además no dice cuánto se
 * esperó.
 *
 * **Las dos terminan con `CIERRE_INDETERMINADO`, textual.** Ninguna afirma que el
 * cambio no ocurrió.
 *
 * @param plazoMs el plazo que se le dio al pedido, para poder nombrarlo. Sale de
 *   `plazoClienteEstadoMs`, así que si el peor caso del servidor cambia el aviso
 *   dice el número nuevo sin que nadie lo edite.
 */
export function textoDeFalloDeToggle(error: unknown, plazoMs: number): string {
  if (esAbortoPorPlazo(error)) {
    return `El cambio de estado no confirmó en ${Math.round(plazoMs / 1000)} segundos. ${CIERRE_INDETERMINADO}`;
  }
  const detalle = error instanceof Error ? error.message : String(error);
  return `El cambio de estado no se pudo completar: ${detalle}. ${CIERRE_INDETERMINADO}`;
}

/** El plazo de `duplicate`, que este spec NO toca (R3.14). */
const PLAZO_LOTE_DUPLICATE_MS = 300_000;

/**
 * El plazo del lote, que este spec deja en 60 s para todo lo que no sea
 * `pause`/`activate` ni `duplicate`.
 *
 * **PENDIENTE CON DUEÑO CONOCIDO, y va acá y no implícito en un `if`:**
 * `budget_set`, `rename` y `schedule` tienen la MISMA clase de defecto que este
 * spec arregla para `pause`/`activate` —un plazo del cliente fijo que nadie
 * comparó contra el peor caso de su propio camino en el servidor— y siguen con
 * este número. Quedan afuera porque R1.9 y R2.5–R2.8 hablan de `pause`/`activate`
 * y porque extenderlo pide medir el peor caso de cada una: `budget_set` tiene su
 * propio `fetchMinimoPresupuesto` en el preflight, y `rename` tiene su propia
 * copia de la relectura (`route.ts`, los dos caminos del renombrado) que la tanda
 * C **no** difirió.
 */
const PLAZO_LOTE_OTRAS_MS = 60_000;

/**
 * El plazo que el cliente le da a un lote, por acción y por cantidad de objetos
 * (task 16.3, R1.9 y R2.7).
 *
 * Era `accion === 'duplicate' ? 300_000 : 60_000`, y el 60 s era el bug: es MENOR
 * que el peor caso del servidor para **un solo objeto** pre-C (64 s), y el lote
 * hace ese camino por objeto en serie. Un lote de 20 se abandonaba a los 60 s
 * cuando el servidor podía tardar 604 s, y cada pedido abandonado que estaba por
 * confirmarse se convierte en un desenlace indeterminado: exactamente lo que R2.7
 * prohíbe.
 *
 * Pura y exportada por la misma razón que `textoDeFalloDeToggle`: el número está
 * adentro de un `fetch` de un handler del componente, y es lo único de ese handler
 * que un test puede mirar.
 *
 * **`duplicate` no se toca (R3.14):** sus 300 s no salen de esta cuenta —su peor
 * caso es la creación de `n × copias` objetos, otro camino— y sus filas fantasma y
 * su vaciado al responder dependen de ese número.
 */
export function plazoDeLoteMs(accion: AccionAds, cantidad: number): number {
  if (accion === 'duplicate') return PLAZO_LOTE_DUPLICATE_MS;
  if (accion === 'pause' || accion === 'activate') return plazoClienteEstadoMs(cantidad);
  return PLAZO_LOTE_OTRAS_MS;
}

// ─── La ida y la vuelta del nivel y la cascada por la URL (2.12) ─────────────
//
// Las cuatro piezas puras del link del tercer estado del interruptor viven en
// `./cascadaUrl`, y **no acá**: `page.tsx` las necesita y este archivo es
// `'use client'`, así que sus exports le llegan al server como referencias de
// cliente y llamarlas tira «Attempted to call … from the server». El módulo de al
// lado no tiene directiva y sirve a los dos. El detalle largo está en su docblock.

/**
 * La lista de filas con el `status` de UNA cambiado. Escritura condicional: con
 * `siMuestra` la fila se toca sólo si todavía muestra ese valor; sin él, siempre.
 *
 * Las dos escrituras del toggle salen de acá porque su diferencia es de una
 * comparación y es la que decide si la reversión puede pisar un dato más nuevo
 * que el nuestro. Dos `.map` inline casi iguales, con esa comparación en uno solo,
 * es la clase de detalle que se pierde al leer y que ningún test podía nombrar.
 *
 *   pintar   → filasConEstado(filas, id, pintado)
 *   revertir → filasConEstado(filas, id, statusPrevio, pintado)
 *
 * Genérica sobre lo único que mira: un objeto con `objectId` y `status`. Así el
 * test la usa con filas mínimas y no queda atada a los cuarenta campos de
 * `MetricasObjeto`.
 */
export function filasConEstado<F extends { objectId: string; status: string | null }>(
  filas: readonly F[],
  objectId: string,
  status: string | null,
  siMuestra?: string | null,
): F[] {
  return filas.map((f) =>
    f.objectId === objectId && (siMuestra === undefined || f.status === siMuestra)
      ? { ...f, status }
      : f,
  );
}

/**
 * El contador monótono de pedidos de filas (task 12, R5 c4).
 *
 * Tres fuentes piden filas sin coordinarse entre sí: el efecto de filtros, el
 * Boton_Actualizar (que con `forzar` espera dos sincronizaciones y puede tardar
 * hasta 60 s) y el refetch posterior a un lote. Nada garantiza que respondan en
 * el orden en que salieron, así que hoy la última respuesta en llegar gana
 * aunque sea la más vieja: es uno de los mecanismos detrás del "el gasto baja de
 * la nada", porque una lectura anterior pisa números más frescos.
 *
 * El `AbortController` que cada pedido ya tiene no alcanza: aborta por timeout,
 * no cancela el pedido anterior cuando sale uno nuevo.
 *
 * Dos contadores y no uno:
 *
 *   - `emitida` numera los pedidos AL SALIR. Es lo que hace distinguibles dos
 *     pedidos emitidos en orden aunque respondan al revés; un número tomado al
 *     volver sería el orden de llegada, que es justo lo que no sirve.
 *   - `aplicada` es el número de la última respuesta que llegó a pantalla, y es
 *     contra ese —y no contra `emitida`— que se compara. Comparar contra
 *     `emitida` descartaría toda respuesta que no fuera la del último pedido, así
 *     que si el último falla la pantalla se quedaría con datos viejos teniendo
 *     una respuesta buena en la mano.
 */
export type Secuencia = {
  /** Toma el número del pedido que sale. */
  emitir: () => number;
  /**
   * ¿La respuesta del pedido `seq` sigue siendo la más nueva que llegó? Sin
   * efecto: lo usa el camino del fallo, que no pinta nada pero tampoco tiene que
   * avisar de un pedido que ya quedó atrás (R5 c4, "se descarta sin tocar la
   * pantalla ni avisar").
   */
  vigente: (seq: number) => boolean;
  /**
   * `true` si la respuesta del pedido `seq` se puede pintar, y en ese caso queda
   * registrada como la última aplicada. `false` es un descarte: no es un error y
   * no produce ningún aviso.
   */
  aplicar: (seq: number) => boolean;
};

export function crearSecuencia(): Secuencia {
  let emitida = 0;
  let aplicada = 0;
  // Estrictamente mayor. Cada número se usa una sola vez, así que para una
  // respuesta real "no menor que la última aplicada" y "mayor que la última
  // aplicada" son lo mismo; con el estricto, además, aplicar dos veces la misma
  // respuesta es imposible.
  const vigente = (seq: number): boolean => seq > aplicada;
  return {
    emitir: () => (emitida += 1),
    vigente,
    aplicar: (seq: number): boolean => {
      if (!vigente(seq)) return false;
      aplicada = seq;
      return true;
    },
  };
}

/**
 * Las filas que llegaron, con el `status` que ya está en pantalla para las que
 * tienen un cambio de estado en vuelo (task 12).
 *
 * El Pintado_Optimista del toggle es la cuarta escritura sobre `data.filas`, y la
 * única que no viene del endpoint: el contador de secuencia no puede ordenarla
 * porque no es una respuesta. Lo que sí se sabe es que, mientras el id está en
 * `enVuelo`, ninguna respuesta puede traer el resultado de esa escritura —no
 * terminó— así que el valor de la fila que hay en pantalla es más informado que
 * el que trae cualquier lectura.
 *
 * Esto es lo que le faltaba a la reversión de la task 4.1: su guarda sólo puede
 * comparar valores, y una respuesta que llegara trayendo justo el valor pintado
 * la dejaba sin forma de saber si la fila mostraba el pintado o una confirmación
 * del servidor. Congelando el `status` de esas filas mientras el pedido está en
 * vuelo, la pregunta pasa a tener una sola respuesta posible.
 *
 * Sólo el `status`, que es lo único que el Pintado_Optimista escribe: el gasto,
 * el nombre y el presupuesto de esa fila se actualizan como los de todas.
 *
 * Pura y exportada para el test: sin jsdom en este repo, la única forma de
 * ejercitar esta decisión es afuera del componente.
 */
export function conservarPintadoEnVuelo<F extends { objectId: string; status: string | null }>(
  enPantalla: readonly F[],
  llegadas: F[],
  enVuelo: ReadonlySet<string>,
): F[] {
  if (enVuelo.size === 0) return llegadas;
  const pintado = new Map<string, string | null>();
  for (const f of enPantalla) if (enVuelo.has(f.objectId)) pintado.set(f.objectId, f.status);
  if (pintado.size === 0) return llegadas;
  return llegadas.map((f) =>
    pintado.has(f.objectId) ? { ...f, status: pintado.get(f.objectId) ?? null } : f,
  );
}

/**
 * Lo que el toggle de una fila necesita del componente, inyectado en lugar de
 * capturado por closure (task 4.3).
 *
 * `ejecutarToggle` vive afuera del componente por una razón que este repo hace
 * cara: `vitest.config.ts` corre en node, sin jsdom y sin testing-library. Un
 * `toggleEstado` adentro del componente sólo se puede ejercitar renderizando,
 * así que la guarda de doble disparo (R2 c8) y la reversión (R2 c3) —las dos
 * cosas que este spec vino a arreglar— quedaban sin test. Con el entorno
 * explícito se ejercitan con el código real: el test le pasa `filasConEstado`
 * como `pintar` y cuenta los pedidos que salen por `pedir`.
 */
export type EntornoToggle = {
  /** Los ids con un pedido en vuelo. Se comparte entre invocaciones (R2 c8). */
  enVuelo: Set<string>;
  /** Escribe el `status` de una fila de la tabla, con la misma firma que `filasConEstado`. */
  pintar: (objectId: string, status: string | null, siMuestra?: string | null) => void;
  /** El aviso que va a pantalla. Nunca se llama con texto vacío (Property 2). */
  avisar: (aviso: Aviso) => void;
  /** Vuelve a pedir las filas. Sólo en el desenlace confirmado. */
  refrescar: () => void;
  /** El `fetch` del Endpoint_Acciones, inyectado para poder contar los pedidos. */
  pedir: (url: string, init: RequestInit) => Promise<Response>;
};

/**
 * El cambio de estado de UNA fila: Pintado_Optimista, pedido, y reversión en
 * todo desenlace que no sea `confirmado` (R2 c1 a c8).
 *
 * Toma de la fila sólo los cuatro campos que manda en el pedido, y no la fila
 * entera: es lo que hace que el test pueda armar una fila mínima.
 */
export async function ejecutarToggle(
  fila: Pick<MetricasObjeto, 'objectId' | 'level' | 'accountId' | 'status'>,
  entorno: EntornoToggle,
): Promise<void> {
  if (entorno.enVuelo.has(fila.objectId)) return; // R2 c8
  entorno.enVuelo.add(fila.objectId);

  const statusPrevio = fila.status;
  const destino = accionDeToggle(statusPrevio); // R2 c1, c2
  const pintado = statusOptimista(destino);

  // Pintado_Optimista, sin Dialogo_Confirmacion (R14 c11): el toggle de una
  // fila se deshace con otro click.
  entorno.pintar(fila.objectId, pintado);

  /**
   * Deshace el Pintado_Optimista (R2 c3). `celdas.tsx` ya documentaba esta
   * reversión desde antes, pero no existía: la única corrección era el refetch
   * del `retryTick`, que lee de una base que puede estar igual de vieja que la
   * copia con la que se decidió.
   *
   * Restaura `statusPrevio` y no PAUSED/ACTIVE: la fila pudo haber llegado con
   * `status` nulo o con un valor que este cliente no conoce, y ese es el valor
   * al que tiene que volver.
   *
   * Toca la fila SÓLO si todavía muestra lo que pintamos. Si entretanto llegó
   * una respuesta del endpoint de datos con otro valor, ese valor es más nuevo
   * que nuestro previo y pisarlo sería devolver la fila a un pasado.
   *
   * El caso que esta guarda no podía distinguir por sí sola —una respuesta que
   * llega trayendo justo el valor que pintamos— ya no llega: mientras el id
   * está en `enVuelo`, `conservarPintadoEnVuelo` conserva el `status` que hay
   * en pantalla y ninguna respuesta lo toca (task 12). Así que si la fila
   * muestra lo que pintamos, es lo que pintamos y no una confirmación del
   * servidor con el mismo valor.
   */
  const revertir = (): void => {
    entorno.pintar(fila.objectId, statusPrevio, pintado);
  };

  /**
   * El plazo de ESTE pedido (task 16.2, R2.5).
   *
   * ## Por qué el plazo entra acá y no en el `pedir` del componente
   *
   * `pedir` es `(url, init) => fetch(url, init)` y vive adentro del componente,
   * o sea en la parte del archivo que ningún test de este repo puede tocar
   * (vitest corre en node, sin jsdom y sin testing-library). Si el número
   * estuviera ahí, la desigualdad de R2.7 —que el plazo del cliente sea mayor que
   * el peor caso del servidor— quedaría sin verificar justamente en el camino que
   * el usuario usa. Acá el `init` es observable: el `pedir` del test lo registra.
   *
   * `1` porque el toggle de una fila manda UN objeto: es el mismo `objectIds` de
   * abajo, y por eso el `n` no es un parámetro de esta función.
   *
   * **El vencimiento no necesita código nuevo**: el abort rechaza el `pedir`, cae
   * en el `catch` de abajo, y ese `catch` ya revierte con su guarda condicional,
   * ya avisa y ya libera el id en el `finally`. Lo único que cambia es el texto.
   */
  const plazoMs = plazoClienteEstadoMs(1);

  try {
    const res = await entorno.pedir('/api/ads/acciones', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: fila.level, accountId: fila.accountId, action: destino, objectIds: [fila.objectId] }),
      signal: AbortSignal.timeout(plazoMs),
    });
    const av = mensajeDeResultado(res.status, await cuerpoDeAcciones(res));
    // Lo que decide la reversión es `aplicado`, NO la nulidad del aviso.
    //
    // Hasta la task 15 las dos cosas eran la misma: el traductor devolvía
    // `null` en un solo caso —`confirmado`— así que "hay aviso" equivalía a "el
    // cambio no quedó" y una sola condición servía para revertir y para avisar.
    // Desde R6.4 no: un `confirmado` que trae `advertencia` (el conjunto se
    // activó y su campaña está pausada, así que no va a entregar) devuelve
    // aviso, y lo marca con `aplicado: true` justamente para que acá no se lea
    // como un fallo. Revertir ahí dejaría la fila en PAUSED mientras el texto
    // dice que el cambio se aplicó: el error simétrico al `HTTP 200` que este
    // spec vino a arreglar, y el desenlace mayoritario en estas cuentas.
    //
    // Que `aplicado: true` sólo pueda venir de un `confirmado` es invariante de
    // `lib/ads/mensajes.ts`, verificada allá ("sólo el confirmado se marca como
    // aplicado" y su Property 2). Acá se confía en eso y no se vuelve a mirar el
    // estado del resultado: sería el segundo lugar que clasifica desenlaces, que
    // es de donde salió el bug original.
    //
    // El `throw new Error(mensaje ?? HTTP ${status})` que estaba en este lugar
    // mostraba el literal "HTTP 200" ante una Omisión: un código de éxito
    // presentado como error (R2 c6, Property 3).
    if (av !== null && av.aplicado !== true) {
      revertir();
      entorno.avisar(av);
      return;
    }
    // El cambio quedó. Si además hay algo que decir —hoy, que el objeto no
    // entrega— se dice sin tocar la fila: el Pintado_Optimista ya muestra el
    // valor que Meta confirmó.
    if (av !== null) entorno.avisar(av);
    // Y se relee, también en ese caso: el route hace `refrescarJerarquia` —una
    // lectura del objeto contra Meta y un UPDATE de status, effective_status,
    // synced_at y desaparecido_at— ANTES de responder, así que este refetch
    // trae lo que Meta confirmó y no el dato del cron (R16 c6/c10, R4 c7). Vale
    // igual con advertencia: la advertencia habla del padre, no de que la
    // escritura no haya ocurrido, y el `effective_status` que la lectura trae
    // (CAMPAIGN_PAUSED) es precisamente lo que el aviso está anunciando.
    //
    // En los desenlaces sin aplicar no se pide: la base no cambió, la fila ya
    // volvió a su valor y un refetch sólo podría deshacer la reversión con el
    // mismo dato viejo que causó la Omisión.
    entorno.refrescar();
  } catch (e) {
    // Red, plazo vencido o cuerpo ilegible: no se sabe si Meta lo aplicó, así que
    // la fila vuelve a lo que era (R2 c3) en lugar de quedar afirmando un cambio
    // que nadie confirmó.
    //
    // El texto sale de `textoDeFalloDeToggle` y no de un template acá para que las
    // dos causas se puedan distinguir —el plazo nombra el plazo, el resto
    // interpola el mensaje— sin que ninguna de las dos pueda afirmar que el cambio
    // no ocurrió (R2.6, R3.1). La oración del cierre es textual en las dos.
    revertir();
    entorno.avisar({ tono: 'error', texto: textoDeFalloDeToggle(e, plazoMs) });
  } finally {
    entorno.enVuelo.delete(fila.objectId);
  }
}

/**
 * El cuerpo de una respuesta del Endpoint_Acciones, o `null` si no vino JSON.
 * Un 502 del proxy con HTML hacía tirar a `res.json()` y el catch mostraba
 * `Unexpected token <` en lugar de decir algo del pedido. Con `null`,
 * `mensajeDeResultado` conserva el status y explica lo que pasó.
 */
async function cuerpoDeAcciones(res: Response): Promise<CuerpoAcciones | null> {
  try {
    return (await res.json()) as CuerpoAcciones;
  } catch {
    return null;
  }
}

/**
 * El GET al endpoint de datos, con su presupuesto de espera propio. Afuera del
 * componente para que `pedirFilas` quede siendo lo único que hace: tomar el
 * número de secuencia y disparar esto.
 */
async function leerFilas(url: string, timeoutMs: number): Promise<Respuesta> {
  const ctrl = new AbortController();
  const alarma = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    const body = (await res.json()) as Respuesta & { ok: boolean; error?: string };
    if (!res.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body;
  } finally {
    clearTimeout(alarma);
  }
}

export function GestorAnuncios({
  cuentas,
  initialData,
  adsFreshness,
  jerarquiaFreshness,
  nivelInicial,
  filtrosIniciales,
  vistaPorDefecto,
  nombresCascada,
  frescuraUmbralSegundos,
}: {
  cuentas: CuentaAds[];
  initialData: ResultadoMetricas;
  adsFreshness: FrescuraAds;
  /**
   * La antigüedad de la Jerarquía en el PRIMER render (R4.5), leída en el server
   * component sin sincronizar nada.
   *
   * Hace falta como prop por la misma razón que el umbral de abajo, y por una
   * más grave: el cliente recibe `jerarquiaFreshness` sólo en las respuestas con
   * `forzar`, o sea únicamente cuando el usuario aprieta Actualizar. Sin este
   * valor la barra no tendría edad de Jerarquía que mostrar hasta el primer
   * click, y el número que R4.5 pide exhibir aparte del gasto sería invisible
   * justo mientras nadie lo fuerza, que es cuando importa verlo.
   */
  jerarquiaFreshness: FrescuraJerarquia;
  nivelInicial: NivelAds;
  filtrosIniciales: {
    period: PeriodoAds;
    status: 'active' | 'paused' | 'any';
    account: string;
    nombre?: string;
    campaignIds?: string[];
    adsetIds?: string[];
    ocultarSinDatos: boolean;
    ocultarPadreApagado: boolean;
  };
  vistaPorDefecto: Vista | null;
  /** id → nombre de los ids de la cascada de la URL, para el ChipCascada (R8 c4). */
  nombresCascada: Record<string, string>;
  /**
   * El umbral de Frescura_Objeto de `settings`, ya resuelto en el server para
   * que la PRIMERA pintura lo tenga (task 7.3). Sin esto, el efecto de filtros
   * —que no corre en el primer render— dejaría la primera pantalla marcando
   * filas contra un default distinto del configurado, y las marcas cambiarían
   * solas al primer cambio de filtro.
   */
  frescuraUmbralSegundos?: number;
}): JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [nivel, setNivel] = useState<NivelAds>(nivelInicial);
  const [period, setPeriod] = useState<PeriodoAds>(filtrosIniciales.period);
  const [status, setStatus] = useState<'active' | 'paused' | 'any'>(filtrosIniciales.status);
  // La cuenta NO es estado: la determina el funnel del selector de arriba y
  // llega resuelta desde el server component. Cambiar de funnel navega y
  // remonta la página, así que acá es constante en toda la vida del componente.
  const account = filtrosIniciales.account;
  const [nombre, setNombre] = useState(filtrosIniciales.nombre ?? '');
  const [ocultarSinDatos, setOcultarSinDatos] = useState(filtrosIniciales.ocultarSinDatos);
  const [ocultarPadreApagado, setOcultarPadreApagado] = useState(
    filtrosIniciales.ocultarPadreApagado,
  );

  const [estadoSel, setEstadoSel] = useState<EstadoSeleccion>(
    estadoInicial(nivelInicial),
  );
  const [cascada, setCascada] = useState<Cascada | null>(() =>
    cascadaInicial(nivelInicial, filtrosIniciales.campaignIds, filtrosIniciales.adsetIds),
  );

  // Vista aplicada y columnas en pantalla (R3 c8: la Vista_Por_Defecto llega
  // del server component en el primer render, sin salto visual).
  const [repo, setRepo] = useState<RepoVistas | null>(null);
  const [errorRepo, setErrorRepo] = useState<string | null>(null);
  const [vistaAplicada, setVistaAplicada] = useState<Vista | null>(vistaPorDefecto);
  const [ignoradas, setIgnoradas] = useState<string[]>([]);

  const [columnas, setColumnas] = useState<ColumnaVisible[]>(() =>
    vistaPorDefecto
      ? resolverVista(vistaPorDefecto).columnas
      : columnasParaRender(
          CATALOGO_METRICAS.filter((e) => e.base).map((e) => ({
            clave: e.clave,
            ancho: e.clave === 'nombre' ? 0 : 100, // 0 = sin declarar → 25 % en TablaAds (R5 c8)
          })),
        ),
  );
  const [ordenEstado, setOrdenEstado] = useState<EstadoOrden>(
    vistaPorDefecto
      ? { ...resolverVista(vistaPorDefecto).orden, pagina: 1 }
      : { ...ORDEN_DEFAULT, pagina: 1 },
  );

  const [data, setData] = useState<Respuesta>(initialData);
  const [frescura, setFrescura] = useState<FrescuraAds>(adsFreshness);
  // La de la Jerarquía va en su propio estado y no dentro de `frescura`: son dos
  // sincronizaciones que llegan por caminos distintos —el gasto en cada
  // respuesta, la Jerarquía sólo en las forzadas— y meterlas en un objeto haría
  // que actualizar una obligara a decir algo de la otra.
  const [frescuraJerarquia, setFrescuraJerarquia] =
    useState<FrescuraJerarquia>(jerarquiaFreshness);
  const [maxPresupuesto, setMaxPresupuesto] = useState(200);
  const [maxDelta, setMaxDelta] = useState(300);
  // El umbral con el que se decide si una fila está vieja. Lo consume la marca
  // de la celda de nombre y el conteo de filas desactualizadas (task 8).
  //
  // El default sólo se usa si la respuesta no lo trae: el primer render lo recibe
  // como prop del server component, así que el valor real de `settings` ya está
  // antes de que corra el primer fetch del cliente.
  const [umbralFrescura, setUmbralFrescura] = useState(
    frescuraUmbralSegundos ?? UMBRAL_FRESCURA_DEFAULT_SEGUNDOS,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  const [refrescando, setRefrescando] = useState(false);
  const [frenoSegundos, setFrenoSegundos] = useState<number | null>(null);
  const ultimoRefresco = useRef<number>(0);
  // El tick automático del gasto: estado propio y separado de `refrescando`,
  // que es el del Boton_Actualizar. Si compartieran uno, el tick deshabilitaría
  // el botón cada minuto y le correría el freno de 10 s al usuario.
  const [refrescandoFondo, setRefrescandoFondo] = useState(false);
  const tickEnVuelo = useRef(false);

  const [confirmacion, setConfirmacion] = useState<{
    accion: AccionAds;
    previa: Previa;
    params: ParametrosAccion;
    ids: string[];
  } | null>(null);
  const [dialogoPresupuesto, setDialogoPresupuesto] = useState('');
  const [dialogoDuplicar, setDialogoDuplicar] = useState({
    copias: 1,
    presupuesto: '',
    fecha: '',
    hora: '00:00',
  });
  const [dialogoRenombrar, setDialogoRenombrar] = useState<{
    modo: ModoFormulario;
    prefijo: string;
    sufijo: string;
    buscar: string;
    poner: string;
    nombreExacto: string;
  }>({ modo: 'prefijo', prefijo: '', sufijo: '', buscar: '', poner: '', nombreExacto: '' });
  const [dialogoProgramar, setDialogoProgramar] = useState({ fecha: '', hora: '00:00' });
  const [desglose, setDesglose] = useState<Map<string, { conjuntos: number; anuncios: number }> | null>(null);
  const [ejecutando, setEjecutando] = useState(false);
  const [resultados, setResultados] = useState<RespuestaLote | null>(null);
  const [avisoTablaVieja, setAvisoTablaVieja] = useState(false);
  // El aviso lleva tono desde la task 4.1: una Omisión del toggle es una
  // advertencia (el cambio no se aplicó, pero nada falló) y pintarla de rojo
  // sería su propia mentira chica.
  const [aviso, setAvisoTonal] = useState<Aviso | null>(null);
  /**
   * El aviso de siempre, con tono de error. Lo siguen usando los productores
   * cuyo único desenlace ES un error: guardar una Vista, el refresco de gasto,
   * el `onNotificar` de ControlVistas, y los tres cortes de `ejecutarLote` que
   * no llegan a leer una respuesta del Endpoint_Acciones (selección de otro
   * nivel, importe inválido, timeout del lote).
   *
   * Los dos que sí traducen una respuesta —el toggle y la respuesta del lote—
   * pasan por `setAvisoTonal`, porque ahí hay desenlaces que no son errores: una
   * Omisión no aplicó el cambio pero no rompió nada.
   */
  const setAviso = (texto: string | null): void =>
    setAvisoTonal(texto === null ? null : { tono: 'error', texto });
  // Filas fantasma de las copias en creación (R18 c4, c9): estado SEPARADO de
  // data.filas, se vacían completas cuando el Endpoint_Acciones responde.
  const [enProceso, setEnProceso] = useState<FilaEnProceso[]>([]);

  const firstRun = useRef(true);

  /**
   * El contador de pedidos de filas de esta pantalla (task 12, R5 c4). En un ref
   * y no en estado: descartar una respuesta no dibuja nada, y un `setState` por
   * pedido volvería a renderizar la tabla para no cambiar nada.
   *
   * Los dos contadores viven adentro del objeto, así que la comparación y el
   * registro de la última aplicada no pueden separarse: no hay forma de preguntar
   * si una respuesta se aplica y olvidarse de anotarla.
   */
  const secuencia = useRef(crearSecuencia()).current;

  // ── La cuenta y el aviso de R1 c12 ──
  // ── Pedido de filas ──────────────────────────────────────────────────────
  const construirUrl = useCallback(
    (extra?: { forzar?: boolean }): string => {
      const params = new URLSearchParams();
      params.set('level', nivel);
      params.set('period', period);
      params.set('status', status);
      params.set('account', account);
      if (nombre) params.set('nombre', nombre);
      if (ocultarSinDatos) params.set('sinDatos', '0');
      if (ocultarPadreApagado) params.set('padreApagado', '0');
      if (cascada && cascada.ids.length > 0) {
        for (const id of cascada.ids) params.append(cascada.nivel === 'campaign' ? 'campaignIds' : 'adsetIds', id);
      }
      params.set('orderBy', ordenEstado.clave);
      params.set('orderDir', ordenEstado.dir);
      params.set('page', String(ordenEstado.pagina));
      if (columnas.length > 0) params.set('columnas', columnas.map((c) => c.clave).join(','));
      if (extra?.forzar) params.set('forzar', '1');
      return `/api/data/ads?${params.toString()}`;
    },
    [nivel, period, status, account, nombre, cascada, ordenEstado, columnas, ocultarSinDatos, ocultarPadreApagado],
  );

  /**
   * Emite un pedido de filas. Devuelve el número de secuencia junto con la
   * promesa del cuerpo, y no un `Promise<Respuesta>` a secas, por dos razones:
   * el número queda tomado antes de que salga el `fetch` (el orden de emisión es
   * exacto, no el de resolución), y el llamador lo tiene también en el camino
   * del fallo, donde no hay cuerpo del cual sacarlo.
   *
   * Un único punto de emisión: cualquier pedido de filas pasa por acá, así que
   * no hay forma de emitir uno sin número.
   */
  const pedirFilas = useCallback(
    (opts?: { forzar?: boolean; timeoutMs?: number }): { seq: number; cuerpo: Promise<Respuesta> } => ({
      seq: secuencia.emitir(),
      cuerpo: leerFilas(construirUrl({ forzar: opts?.forzar }), opts?.timeoutMs ?? 30_000),
    }),
    [construirUrl, secuencia],
  );

  /**
   * Pinta una respuesta del endpoint de datos, o la descarta si ya se aplicó una
   * más nueva (R5 c4). Devuelve si se aplicó.
   *
   * Las seis escrituras van juntas y bajo la MISMA guarda porque salen del mismo
   * cuerpo: aplicar las filas de una respuesta y la Marca_Frescura de otra sería
   * mostrar números de una lectura con la antigüedad de otra, que es la misma
   * clase de mentira que este spec vino a sacar de la pantalla. Antes cada
   * llamador hidrataba lo que se acordaba —el efecto de filtros los cuatro
   * ajustes, el Boton_Actualizar y el tick sólo la frescura—; centralizarlo deja
   * un solo lugar donde agregar lo que traiga la respuesta.
   *
   * Todas preguntan por el valor antes de escribirlo, y eso NO es defensa de más:
   * el endpoint devuelve algunos campos sólo en algunos pedidos. La frescura de
   * la Jerarquía viaja nula cuando el pedido no llevó `forzar`, porque sin
   * `forzar` no se consulta, y "no la consulté" no es "está vieja". Escribirla
   * igual haría que el tick del polling —uno por minuto, ninguno con `forzar`—
   * borrara al minuto la antigüedad que el Boton_Actualizar acababa de traer. La
   * guarda de secuencia no cubre ese caso: el tick es posterior y se aplica con
   * todo derecho; lo que no tiene es nada que decir sobre la Jerarquía. Lo que se
   * agregue acá va con la misma forma.
   */
  const aplicarRespuesta = (seq: number, body: Respuesta): boolean => {
    if (!secuencia.aplicar(seq)) return false;
    setData((prev) => ({
      ...body,
      filas: conservarPintadoEnVuelo(prev.filas, body.filas, enVueloToggle.current),
    }));
    if (body.adsFreshness) setFrescura(body.adsFreshness);
    if (body.jerarquiaFreshness) setFrescuraJerarquia(body.jerarquiaFreshness);
    if (typeof body.maxDailyBudgetEur === 'number') setMaxPresupuesto(body.maxDailyBudgetEur);
    if (typeof body.maxDeltaPorTickEur === 'number') setMaxDelta(body.maxDeltaPorTickEur);
    if (typeof body.frescuraUmbralSegundos === 'number') setUmbralFrescura(body.frescuraUmbralSegundos);
    return true;
  };

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setLoading(true);
    setError(null);
    const { seq, cuerpo } = pedirFilas();
    cuerpo
      .then((body) => {
        aplicarRespuesta(seq, body);
      })
      .catch((err: unknown) => {
        // Un pedido que falló después de que llegara uno más nuevo no tiene nada
        // que decir: la pantalla ya muestra datos posteriores a este, y el cartel
        // de error hablaría de un pedido que quedó atrás.
        if (!secuencia.vigente(seq)) return;
        if (err instanceof DOMException && err.name === 'AbortError') {
          setError('el pedido de filas no respondió en 30 segundos');
        } else {
          setError(err instanceof Error ? err.message : 'Error de red');
        }
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nivel, period, status, account, nombre, cascada, ordenEstado.clave, ordenEstado.dir, ordenEstado.pagina, ocultarSinDatos, ocultarPadreApagado, retryTick]);

  // ── La URL refleja nivel y cascada (R8 c7) ──
  const escribirUrl = useCallback(
    (nuevoNivel: NivelAds, nuevaCascada: { nivel: 'campaign' | 'adset'; ids: readonly string[] } | null, extra?: Record<string, string>) => {
      const params = paramsDeNivel(searchParams.toString(), nuevoNivel, nuevaCascada, extra);
      router.replace(`/anuncios?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  // ── Transiciones de selección y cascada (la máquina de seleccion.ts) ─────
  const evento = useCallback(
    (ev: EventoSeleccion): EstadoSeleccion => {
      const siguiente = aplicarEvento(estadoSel, ev);
      setEstadoSel(siguiente);
      setCascada(siguiente.cascada && siguiente.cascada.ids.length > 0 ? siguiente.cascada : null);
      return siguiente;
    },
    [estadoSel],
  );

  const cambiarNivel = (nuevoNivel: NivelAds): void => {
    if (nuevoNivel === nivel) return; // R1 c15
    const siguiente = evento({
      tipo: 'cambiar_nivel',
      nivel: nuevoNivel,
      idsEnOrdenDeTabla: data.filas.map((f) => f.objectId),
      idsDeLaCuenta: new Set(estadoSel.cascada?.ids ?? []),
    });
    setNivel(nuevoNivel);
    escribirUrl(
      nuevoNivel,
      siguiente.cascada && siguiente.cascada.ids.length > 0 ? siguiente.cascada : null,
    );
  };

  const cambiarFiltro = (cambios: { period?: PeriodoAds; status?: 'active' | 'paused' | 'any'; nombre?: string; ocultarSinDatos?: boolean; ocultarPadreApagado?: boolean }): void => {
    // R9 c6: la selección se vacía, la cascada se conserva
    evento({ tipo: 'cambiar_filtro' });
    if (cambios.period !== undefined) setPeriod(cambios.period);
    if (cambios.status !== undefined) setStatus(cambios.status);
    if (cambios.nombre !== undefined) setNombre(cambios.nombre);
    if (cambios.ocultarSinDatos !== undefined) setOcultarSinDatos(cambios.ocultarSinDatos);
    if (cambios.ocultarPadreApagado !== undefined) setOcultarPadreApagado(cambios.ocultarPadreApagado);
    const params = new URLSearchParams(searchParams.toString());
    if (cambios.period !== undefined) params.set('period', cambios.period);
    if (cambios.status !== undefined) params.set('status', cambios.status);
    if (cambios.nombre !== undefined) {
      if (cambios.nombre) params.set('nombre', cambios.nombre);
      else params.delete('nombre');
    }
    if (cambios.ocultarSinDatos !== undefined) {
      if (cambios.ocultarSinDatos) params.set('sinDatos', '0');
      else params.delete('sinDatos');
    }
    if (cambios.ocultarPadreApagado !== undefined) {
      if (cambios.ocultarPadreApagado) params.set('padreApagado', '0');
      else params.delete('padreApagado');
    }
    router.replace(`/anuncios?${params.toString()}`, { scroll: false });
  };

  const limpiarCascada = (): void => {
    evento({ tipo: 'limpiar_cascada' });
    const params = new URLSearchParams(searchParams.toString());
    params.delete('campaignIds');
    params.delete('adsetIds');
    router.replace(`/anuncios?${params.toString()}`, { scroll: false });
  };

  const bajarNivel = (fila: MetricasObjeto): void => {
    if (fila.level === 'ad') return;
    // R8 c12: click en el nombre → nivel de abajo con ese id como ÚNICA cascada.
    const nivelAbajo: NivelAds = fila.level === 'campaign' ? 'adset' : 'ad';
    const nuevaCascada: Cascada = {
      nivel: fila.level,
      ids: [fila.objectId],
      descartados: 0,
      motivo: null,
    };
    setEstadoSel(estadoInicial(nivelAbajo));
    setCascada(nuevaCascada);
    setNivel(nivelAbajo);
    escribirUrl(nivelAbajo, nuevaCascada);
  };

  /**
   * Sube al nivel campaña con la campaña de esta fila como única cascada (2.12 de
   * `toggle-conjuntos-entrega`). **Espejo exacto de `bajarNivel`.**
   *
   * Lo dispara el link del tercer estado del interruptor: un conjunto con
   * `effective_status = 'CAMPAIGN_PAUSED'` no entrega y lo único que lo haría
   * entregar es activar su campaña, que hasta ahora había que ir a buscar a mano.
   *
   * **NO pasa por la máquina de estados de `seleccion.ts`**, igual que
   * `bajarNivel`: esa máquina no tiene evento para SUBIR, y agregarlo es más
   * cambio que estas líneas. El precedente ya estaba y esto no lo inventa.
   *
   * **No hay SQL nuevo, y eso se verificó antes de elegir este camino**: el
   * filtro de cascada de `lib/queries/ads.ts` es `o."campaignId" = ANY($campaignIds)`
   * en el `WHERE` de afuera, y a nivel campaña el `SELECT` emite
   * `c.campaign_id AS "campaignId"`. O sea que `level=campaign&campaignIds=<id>`
   * ya filtra a esa campaña.
   *
   * **Es navegación y no cascada de escritura**: la campaña se activa con su
   * propio interruptor en su propia fila. Activar una campaña cambia la entrega y
   * el gasto de todos sus conjuntos, y hoy no hay ninguna previa que muestre ese
   * alcance antes de tocar 92 objetos.
   *
   * Lo que se descartó y no se rediscute: filtrar por `nombre` (es substring e
   * insensible a mayúsculas, así que con dos campañas parecidas lleva a la fila
   * equivocada o a dos) y cambiar de nivel resaltando sin filtrar (la tabla está
   * paginada y ordenada por gasto, y una campaña pausada sin gasto puede no estar
   * en la página o quedar escondida por `status=active` o `ocultarSinDatos`).
   */
  const subirACampania = (fila: MetricasObjeto): void => {
    const nuevaCascada = cascadaDeCampania(fila);
    if (nuevaCascada === null) return;
    setEstadoSel(estadoInicial('campaign'));
    setCascada(nuevaCascada);
    setNivel('campaign');
    escribirUrl('campaign', nuevaCascada);
  };

  const tildar = (id: string): void => {
    if (estadoSel.seleccion.ids.includes(id)) evento({ tipo: 'destildar', id });
    else evento({ tipo: 'tildar', id });
  };

  // ── Vista por defecto y repo (R3 c8, c9) ──
  useEffect(() => {
    fetch('/api/config/vistas-ads', { cache: 'no-store' })
      .then(async (res) => {
        const body = (await res.json()) as { ok: boolean; repo: RepoVistas | null };
        if (!res.ok || body.ok === false) throw new Error('sin respuesta');
        return body.repo;
      })
      .then((leido) => {
        setRepo(leido);
        if (vistaAplicada === null) {
          if (leido?.porDefecto) {
            const porDefecto = leido.vistas.find((v) => v.id === leido.porDefecto) ?? null;
            if (porDefecto) aplicarVista(porDefecto);
          } else if (leido !== null && leido.vistas.length === 0) {
            // repo guardado sin Vistas: se respeta (R3 c9), no hay nada que aplicar
          } else {
            setErrorRepo('no hay Vista por defecto: se usa la configuración de las doce columnas');
          }
        }
      })
      .catch(() => setErrorRepo('no se pudieron cargar las Vistas'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const aplicarVista = (vista: Vista): void => {
    const resuelta = resolverVista(vista);
    setColumnas(resuelta.columnas);
    setOrdenEstado({ clave: resuelta.orden.clave, dir: resuelta.orden.dir, pagina: 1 });
    setVistaAplicada(vista);
    setIgnoradas(resuelta.ignoradas);
  };

  const guardarRepo = async (nuevo: RepoVistas): Promise<void> => {
    const res = await fetch('/api/config/vistas-ads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: nuevo }),
    });
    const body = (await res.json()) as { ok: boolean; detail?: string };
    if (!res.ok || body.ok === false) {
      setAviso(`No se pudo guardar la Vista: ${body.detail ?? `HTTP ${res.status}`}`);
      return;
    }
    setRepo(nuevo);
  };

  // ── Orden y columnas ──
  const onOrden = (clave: ClaveOrden): void => {
    setOrdenEstado((prev) => siguienteOrden(prev, clave));
  };
  const onAncho = (clave: string, ancho: number): void => {
    setColumnas((prev) => prev.map((c) => (c.clave === clave ? { ...c, ancho } : c)));
  };
  const onReordenar = (clave: string, posicion: number): void => {
    setColumnas((prev) => {
      const sin = prev.filter((c) => c.clave !== clave);
      const movida = prev.find((c) => c.clave === clave)!;
      const insertar = Math.max(2, Math.min(posicion, sin.length));
      const out = [...sin];
      out.splice(insertar, 0, { ...movida });
      return out;
    });
  };

  // ── Boton_Actualizar (R1 c7..c11) ──
  const actualizar = (): void => {
    const ahora = Date.now();
    const desdeUltimo = ahora - ultimoRefresco.current;
    if (desdeUltimo < 10_000) {
      setFrenoSegundos(Math.ceil((10_000 - desdeUltimo) / 1000));
      return;
    }
    ultimoRefresco.current = ahora;
    setFrenoSegundos(null);
    setRefrescando(true);
    // El pedido más largo de los tres —con `forzar` espera el sync de gasto y el
    // de la Jerarquía antes de leer— así que es el que más probablemente vuelva
    // después de uno emitido más tarde.
    const { seq, cuerpo } = pedirFilas({ forzar: true, timeoutMs: 60_000 });
    cuerpo
      .then((body) => {
        aplicarRespuesta(seq, body);
      })
      .catch((err: unknown) => {
        if (!secuencia.vigente(seq)) return;
        // R1 c9: filas guardadas y marca anterior, sin modificar
        setAviso(
          `El refresco de gasto falló: ${err instanceof Error ? err.message : 'sin respuesta'} — se muestran las filas guardadas.`,
        );
      })
      .finally(() => {
        setRefrescando(false);
        setTimeout(() => setFrenoSegundos(null), 10_000);
      });
  };

  // ── El tick automático del gasto (lib/ads/polling.ts) ────────────────────
  // Es el mismo pedido del Boton_Actualizar pero SIN `forzar`: el TTL del server
  // decide si toca a Meta o devuelve lo que ya está guardado, así que dejar la
  // pantalla abierta toda la tarde no multiplica las llamadas. Y es silencioso:
  // no toca `loading` (eso cambia la tabla por el esqueleto cada minuto), no
  // pisa la selección y no corre el freno de 10 s, que es del usuario.
  usePollingGasto(
    () => {
      if (tickEnVuelo.current) return;
      tickEnVuelo.current = true;
      setRefrescandoFondo(true);
      const { seq, cuerpo } = pedirFilas();
      cuerpo
        .then((body) => {
          aplicarRespuesta(seq, body);
          // Si el refetch de después de un lote había fallado (R16 c7), este
          // pedido es el que vuelve a poner la tabla al día: dejar el aviso de
          // tabla vieja sería avisar de algo que ya no pasa. Afuera de la guarda:
          // un cuerpo que se descarta se descarta porque hay otro más nuevo en
          // pantalla, y eso también prueba que la tabla es del servidor.
          setAvisoTablaVieja(false);
        })
        .catch(() => {
          // Un tick que falla no dice nada: las filas y la marca anteriores
          // siguen en pantalla, el mismo criterio de R1 c9. La marca de frescura
          // va a ir contando el atraso sola, y el próximo tick reintenta.
        })
        .finally(() => {
          tickEnVuelo.current = false;
          setRefrescandoFondo(false);
        });
    },
    {
      // Nada de moverle la mesa al usuario: con un diálogo abierto, un lote
      // corriendo, filas fantasma esperando respuesta o cualquier otro pedido
      // en curso, el tick se saltea y vuelve a intentar al minuto siguiente.
      pausado:
        loading || refrescando || ejecutando || confirmacion !== null || enProceso.length > 0,
    },
  );

  // Las dos edades de la barra (R4.5), del mismo `textoEdad` para que se puedan
  // comparar de un vistazo. El `'—'` es el caso sin frescura ninguna, que con las
  // dos llegando del server component en el primer render no debería verse.
  const edadGasto = textoEdad(frescura) ?? '—';
  const edadJerarquia = textoEdad(frescuraJerarquia) ?? '—';

  // ── Acciones ─────────────────────────────────────────────────────────────
  /**
   * Los ids con un cambio de estado en vuelo (R2 c8, task 4.1). Un Set por id y
   * no un booleano global: tocar dos filas distintas a la vez es legítimo, dos
   * escrituras sobre la MISMA fila no. En producción quedaron dos filas
   * `activate confirmado` sobre el mismo conjunto separadas por un segundo,
   * porque no había ninguna guarda.
   *
   * Ref y no estado: **es la guarda, no el dibujo** (3.11). Tiene que ser
   * síncrono, porque dos clicks en el mismo tick no pueden pasar los dos y un
   * `setState` es asíncrono. Lo que se dibuja sale de `togglesEnCurso`, abajo.
   */
  const enVueloToggle = useRef<Set<string>>(new Set());

  /**
   * Los ids que se DIBUJAN como en curso (2.15, task 14.3). Dos estructuras con
   * dos trabajos, y el reparto es la decisión: el ref de arriba decide si el
   * pedido sale, este estado decide qué ve el usuario mientras el pedido está en
   * vuelo. Antes el único indicio era el Pintado_Optimista, que es indistinguible
   * de un cambio ya confirmado.
   *
   * El comentario original del ref decía que un `setState` por click volvería a
   * renderizar la tabla entera sin necesidad. Ese argumento no se pierde, se
   * acota: **el camino del toggle ya renderiza la tabla entera**, porque el
   * Pintado_Optimista llama a `setData`. El render que ese comentario quería
   * evitar era el de consultar la guarda en CADA click —incluidos los
   * descartados—, y eso sigue saliendo del ref. Este estado agrega un render al
   * arrancar y uno al terminar, sobre un camino que ya tenía uno de cada.
   */
  const [togglesEnCurso, setTogglesEnCurso] = useState<ReadonlySet<string>>(new Set());

  const marcarEnCurso = (objectId: string, enCurso: boolean): void =>
    setTogglesEnCurso((prev) => {
      const next = new Set(prev);
      if (enCurso) next.add(objectId);
      else next.delete(objectId);
      return next;
    });

  /**
   * El toggle de una fila: `ejecutarToggle` con este componente como entorno.
   * Toda la lógica está allá arriba, afuera del componente, para que la guarda y
   * la reversión se puedan testear sin render (task 4.3).
   *
   * El marcado del dibujo va acá y no adentro de `ejecutarToggle` porque el
   * `enVuelo` del entorno ya dice lo mismo y sumarle un tercer lugar que lo
   * repita sería el problema que este spec vino a arreglar. El `finally` es del
   * `then/finally` de la promesa y no del `try` de allá: lo único que necesita es
   * correr cuando el pedido termine, con cualquier desenlace.
   */
  const toggleEstado = (fila: MetricasObjeto): Promise<void> => {
    // Si el id ya está en vuelo el pedido se descarta allá adentro, así que acá
    // tampoco se marca nada: la señal tiene que decir «hay un pedido», y el
    // segundo click no crea ninguno.
    if (enVueloToggle.current.has(fila.objectId)) return Promise.resolve();
    marcarEnCurso(fila.objectId, true);
    return ejecutarToggle(fila, {
      enVuelo: enVueloToggle.current,
      pintar: (objectId, status, siMuestra) =>
        setData((prev) => ({
          ...prev,
          filas: filasConEstado(prev.filas, objectId, status, siMuestra),
        })),
      avisar: setAvisoTonal,
      refrescar: () => setRetryTick((x) => x + 1),
      pedir: (url, init) => fetch(url, init),
    }).finally(() => marcarEnCurso(fila.objectId, false));
  };

  const editarPresupuesto = (fila: MetricasObjeto, eur: number): void => {
    // El importe escrito en la celda siembra el campo del diálogo, y el alcance
    // es esa fila aunque no esté tildada (R1 c2): sin el idsOverride la previa
    // salía vacía y Ejecutar quedaba deshabilitado para siempre. Es el mismo
    // criterio que el renombrado de una fila, que ya pasa `[fila.objectId]`.
    abrirConfirmacion('budget_set', { budgetEur: eur }, [fila.objectId]);
  };

  const abrirConfirmacion = (accion: AccionAds, params: ParametrosAccion = {}, idsOverride?: string[]): void => {
    // R1 c2: el campo se siembra con el importe que trae el llamador y sólo
    // queda vacío cuando no viene ninguno (el camino de la barra de lote).
    // Pisarlo siempre con '' borraba el valor de la celda antes de que el
    // usuario viera el diálogo, y por eso la previa decía "después: —".
    setDialogoPresupuesto(textoDeImporte(params.budgetEur));
    const ids = idsOverride ?? [...estadoSel.seleccion.ids];
    const previa = calcularPrevisualizacion(
      accion,
      nivel,
      data.filas,
      ids,
      params,
      { techoEur: maxPresupuesto, topeLoteEur: maxDelta, minimoDiarioEur: null },
    );
    setConfirmacion({ accion, previa, params, ids });

    if (accion === 'duplicate') {
      // El desglose de descendientes viene de lecturas a /api/data/ads (R14 c5):
      // cero llamadas a Meta, cero llamadas al Endpoint_Acciones.
      setDialogoDuplicar({
        copias: 1,
        presupuesto: '',
        fecha: mananaMedianocheLocal(data.rango.timezone),
        hora: '00:00',
      });
      setDesglose(null);
      void cargarDesglose(ids);
    }
    if (accion === 'rename') {
      const unica = ids.length === 1 ? data.filas.find((f) => f.objectId === ids[0]) : undefined;
      setDialogoRenombrar({
        modo: unica ? 'exacto' : 'prefijo',
        prefijo: '',
        sufijo: '',
        buscar: '',
        poner: '',
        nombreExacto: unica?.objectName ?? '',
      });
    }
    if (accion === 'schedule') {
      setDialogoProgramar({ fecha: mananaMedianocheLocal(data.rango.timezone), hora: '00:00' });
    }
  };

  const cargarDesglose = async (ids: string[]): Promise<void> => {
    const qs = new URLSearchParams();
    for (const id of ids) qs.append('campaignIds', id);
    try {
      const [setsRes, adsRes] = await Promise.all([
        fetch(`/api/data/ads?level=adset&account=${account}&${qs.toString()}&limit=1000`, { cache: 'no-store' }),
        fetch(`/api/data/ads?level=ad&account=${account}&${qs.toString()}&limit=1000`, { cache: 'no-store' }),
      ]);
      const sets = (await setsRes.json()) as { filas?: MetricasObjeto[] };
      const ads = (await adsRes.json()) as { filas?: MetricasObjeto[] };
      const mapa = new Map<string, { conjuntos: number; anuncios: number }>();
      for (const id of ids) mapa.set(id, { conjuntos: 0, anuncios: 0 });
      for (const f of sets.filas ?? []) {
        const x = mapa.get(f.campaignId) ?? { conjuntos: 0, anuncios: 0 };
        mapa.set(f.campaignId, { conjuntos: x.conjuntos + 1, anuncios: x.anuncios });
      }
      for (const f of ads.filas ?? []) {
        const x = mapa.get(f.campaignId) ?? { conjuntos: 0, anuncios: 0 };
        mapa.set(f.campaignId, { conjuntos: x.conjuntos, anuncios: x.anuncios + 1 });
      }
      setDesglose(mapa);
    } catch {
      setDesglose(null); // R14 c12: la previa queda incompleta y no se ejecuta
    }
  };

  const cerrarConfirmacion = (): void => {
    // R14 c8: la Seleccion_Activa se conserva intacta, cero llamadas
    setConfirmacion(null);
    setEjecutando(false);
  };

  const ejecutarLote = async (): Promise<void> => {
    if (!confirmacion) return;
    // R9 c12: si la selección no corresponde al nivel vigente, no se llama
    if (estadoSel.seleccion.nivel !== nivel) {
      setAviso('La selección no corresponde al nivel vigente: no se ejecutó nada.');
      setEstadoSel(estadoInicial(nivel));
      cerrarConfirmacion();
      return;
    }
    const ids = confirmacion.ids;
    // R1 c1, c3: el importe que viaja es el que el campo tiene AHORA, leído con
    // la MISMA regla que habilita el botón. `confirmacion.params.budgetEur` no
    // sirve: es el valor con el que se abrió el diálogo, no el que el usuario
    // dejó, y desde la barra de lote no existe.
    const presupuesto =
      confirmacion.accion === 'budget_set'
        ? presupuestoDelDialogo(dialogoPresupuesto, maxPresupuesto)
        : null;
    if (presupuesto !== null && !presupuesto.ok) {
      // No se emite un pedido que ya sabemos que el route va a rechazar, y el
      // aviso nombra el campo y la regla incumplida en lugar de un `Required`
      // (R1 c6). El diálogo queda abierto: el importe se corrige y se reintenta.
      setAviso(`No se fijó el presupuesto: ${presupuesto.bloqueo}.`);
      return;
    }
    setEjecutando(true);
    try {
      const body: Record<string, unknown> = {
        level: nivel,
        accountId: account,
        action: confirmacion.accion,
        objectIds: ids,
      };
      if (presupuesto !== null) body.budgetEur = presupuesto.cuerpo.budgetEur;
      if (confirmacion.accion === 'duplicate') {
        const n = Number(dialogoDuplicar.presupuesto);
        body.copias = dialogoDuplicar.copias;
        body.inicio = isoConOffset(data.rango.timezone, dialogoDuplicar.fecha, dialogoDuplicar.hora);
        if (dialogoDuplicar.presupuesto !== '' && Number.isFinite(n)) body.budgetEur = n;
      }
      if (confirmacion.accion === 'rename') {
        const modo = modoDeFormulario(dialogoRenombrar.modo, dialogoRenombrar);
        if (!modo) throw new Error('el modo de renombrado está incompleto');
        body.modo = modo;
      }
      if (confirmacion.accion === 'schedule') {
        body.inicio = isoConOffset(data.rango.timezone, dialogoProgramar.fecha, dialogoProgramar.hora);
      }
      // R18 c4: las filas de creación en proceso aparecen en ≤2 s de la
      // confirmación, sin recargar y sin esperar al cron.
      if (confirmacion.accion === 'duplicate') {
        const k = dialogoDuplicar.copias;
        const filasEnProceso: FilaEnProceso[] = [];
        for (const f of data.filas) {
          if (!ids.includes(f.objectId)) continue;
          for (let n = 1; n <= k; n++) {
            filasEnProceso.push({
              clave: `${f.objectId}#${n}`,
              nombrePlanificado: `${f.objectName ?? f.objectId} - Copia ${n}`,
              origenId: f.objectId,
              nivel,
            });
          }
        }
        setEnProceso(filasEnProceso);
      }
      const res = await fetch('/api/ads/acciones', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        // R18 c6: si el lote asíncrono no responde dentro de su plazo, se vacía
        // el estado en proceso y se informa qué se aplicó y qué no. El `catch` de
        // abajo no cambia con la task 16.3: ya conserva la ambigüedad («los
        // resultados sin confirmar se definen cuando corra la reconciliación») y ya
        // vacía las filas en proceso. Lo único que cambia es el número, y ahora
        // depende de la acción y de cuántos objetos van.
        signal: AbortSignal.timeout(plazoDeLoteMs(confirmacion.accion, ids.length)),
      });
      const cuerpo = await cuerpoDeAcciones(res);
      // R16 c6 / R18 c9: las filas fantasma se VACÍAN completas al responder y
      // se dibuja sólo lo que devuelve el servidor.
      setEnProceso([]);
      // El MISMO traductor que el toggle (task 4.2, R2 c5). El
      // `detail ?? error ?? HTTP ${status}` que estaba acá ya mostraba el detail
      // —eso el toggle no lo hacía— pero mantenía su propio último recurso con el
      // código HTTP, así que las dos pantallas tenían dos criterios para el mismo
      // cuerpo. `avisoDeLote` delega en `mensajeDeResultado` para el sobre y para
      // el lote de un objeto, y cuenta cuando hay varios: nunca deja que
      // `resultados[0]` hable por los otros 99.
      const av = avisoDeLote(res.status, cuerpo);
      if (cuerpo === null || cuerpo.ok !== true) {
        setAvisoTonal(av);
        // El desglose de un lote anterior no puede quedar en pantalla al lado del
        // error de este: serían dos afirmaciones sobre distintos pedidos leídas
        // como una. Cuando el rechazo es del esquema o del Preflight el servidor
        // no escribió nada, así que la tabla sigue siendo válida y no hace falta
        // marcarla vieja.
        setResultados(null);
        if (cuerpo === null) setAvisoTablaVieja(true); // cuerpo ilegible: no se sabe qué se aplicó
        return;
      }
      setResultados({
        aplicados: cuerpo.aplicados,
        total: cuerpo.total,
        corte: cuerpo.corte,
        resultados: [...cuerpo.resultados],
      });
      // Sólo cuando ningún objeto cambió, y como resumen contado: el "X de Y
      // aplicados" y la lista de no confirmados los dibuja `ResultadosLote`, que
      // es la superficie real de reporte del lote.
      setAvisoTonal(av);
      setConfirmacion(null);
      setEstadoSel(estadoInicial(nivel));
      // R16 c6: dibujar SOLO lo que devuelve el servidor
      try {
        // `cuerpo` acá arriba es el del Endpoint_Acciones; este es el del
        // endpoint de datos. Renombrado para que no haya dos cosas distintas con
        // el mismo nombre en la misma función.
        const { seq, cuerpo: respuesta } = pedirFilas({ timeoutMs: TOPES_ABORTO });
        // Si esta respuesta se descarta es porque otra posterior ya se aplicó, y
        // esa también vino del servidor: el valor optimista no sobrevive por
        // ningún camino.
        aplicarRespuesta(seq, await respuesta);
        setAvisoTablaVieja(false);
      } catch {
        setAvisoTablaVieja(true); // R16 c7
      }
    } catch (e) {
      // Timeout de 300 s o red: las filas en proceso se vacían igual (R18 c6);
      // los objetos ya creados quedan pausados y sin borrar, y NO hay reintento
      // automático. Las filas de ad_actions abiertas quedan indeterminadas y
      // las cierra la reconciliación.
      setEnProceso([]);
      setAviso(
        `El lote no respondió a tiempo: ${e instanceof Error ? e.message : String(e)}. ` +
          'Lo que haya quedado creado está pausado; los resultados sin confirmar se definen cuando corra la reconciliación.',
      );
      setAvisoTablaVieja(true);
    } finally {
      setEjecutando(false);
    }
  };

  // ── Totales de la barra de KPIs (R7.1, R7.3, Property 9 — task 17.2) ──
  //
  // Del FILTRO COMPLETO, no de la página. Los cinco números eran
  // `data.filas.reduce(...)`, o sea el gasto de las filas visibles: con el
  // resultado paginado, pasar a la página 2 mostraba un gasto más chico sin que
  // nadie hubiera gastado menos, y eso es el reporte que este spec vino a
  // cerrar. `data.totales` lo calcula el servidor con la misma cadena de CTEs
  // sin OFFSET ni LIMIT, así que es una función del filtro y no de la página.
  const filas = data.filas;
  const totales = data.totales;
  const totGasto = totales.spendEur;
  const totIngresos = totales.revenueEur;
  const totGanancia = totales.profitEur;
  const totNeto = totales.netEur;
  // El ROI se deriva ACÁ porque el agregado no manda cocientes a propósito: el
  // cociente de las sumas no es la suma de los cocientes. `null` y NO 0 cuando
  // no hubo gasto, que es la regla de lib/ads/tipos.ts: un 0 se leería como
  // «no devolvió nada», y sin gasto el retorno no se puede calcular.
  const totRoi = totGasto > 0 ? totNeto / totGasto : null;
  // El alcance con el que se rotulan los cuatro KPIs y la línea de contexto de
  // abajo. Los dos salen de los filtros vigentes, no de `data`: `data` puede ser
  // de un pedido anterior mientras el nuevo está en vuelo, y en ese instante el
  // rótulo tiene que decir sobre qué se pidió el número que se está por pintar.
  //
  // (Salvo el conteo de filas, que sí es de `data`: es un dato del resultado.)
  const alcance = alcanceDeTotales(nivel, status);
  const detalleTotales = detalleDeTotales({
    filasFiltro: totales.filas,
    filasPantalla: filas.length,
    nombre,
    cascada,
    ocultarSinDatos,
    ocultarPadreApagado,
  });
  // El denominador también pasa al agregado: mezclarlo con las ventas de UNA
  // página hacía que la proporción —y con ella el color del Banner— cambiara al
  // pasar de página, con el numerador quieto.
  //
  // Queda una asimetría que desde el cliente no se puede cerrar: `sinAtribuir`
  // es de la cuenta y el período completos (su SQL no lleva nivel, estado ni
  // nombre) y `totales.sales` es del filtro, así que un filtro que esconde
  // ventas atribuidas infla la proporción. Por eso sólo decide el TONO del
  // Banner y no se muestra como número: lo que el Banner afirma es el conteo de
  // ventas sin atribuir, que sí es exacto.
  const sinAtribuirPct =
    data.sinAtribuir.sales > 0
      ? data.sinAtribuir.sales / Math.max(1, data.sinAtribuir.sales + totales.sales)
      : 0;

  // ── Frescura de las filas en pantalla (task 8, R3.1 y R3.3) ──────────────
  /**
   * El instante contra el que se miden TODAS las antigüedades de esta pintura.
   *
   * Se toma cuando cambia `data`, es decir cuando llega una respuesta del
   * endpoint, y no en cada render: así la marca de una fila no se mueve porque el
   * usuario tildó un checkbox, y todas las filas de una misma respuesta se miden
   * contra el mismo reloj. Es el mismo criterio que la Marca_Frescura del gasto,
   * que muestra el `ageSeconds` que calculó el server y se queda quieta hasta el
   * próximo pedido; acá el cálculo es del cliente porque lo que viaja son las dos
   * fechas de cada fila, no una edad ya resuelta.
   *
   * `data` es la única dependencia real: el umbral no entra en la cuenta del
   * instante, sólo en la clasificación.
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ahoraFrescura = useMemo(() => Date.now(), [data]);

  const frescuraFilas = useMemo(
    () => resumenFrescura(filas, umbralFrescura, ahoraFrescura),
    [filas, umbralFrescura, ahoraFrescura],
  );
  const frasesFrescuraFilas = useMemo(
    () => frasesFrescura(frescuraFilas, filas.length, umbralFrescura),
    [frescuraFilas, filas.length, umbralFrescura],
  );

  // Una sola lectura del campo para la previa, el bloqueo del botón y el payload
  // de `ejecutarLote`: los tres salen de acá, así el "después" que el usuario
  // confirma es exactamente el importe que se manda (Property 4).
  const presupuestoDialogo = useMemo(
    () => presupuestoDelDialogo(dialogoPresupuesto, maxPresupuesto),
    [dialogoPresupuesto, maxPresupuesto],
  );

  const previaConPresupuesto = useMemo(() => {
    if (!confirmacion || confirmacion.accion !== 'budget_set') return confirmacion?.previa ?? null;
    return calcularPrevisualizacion(
      'budget_set',
      nivel,
      data.filas,
      confirmacion.ids,
      presupuestoDialogo.params,
      { techoEur: maxPresupuesto, topeLoteEur: maxDelta, minimoDiarioEur: null },
    );
  }, [confirmacion, presupuestoDialogo, nivel, data.filas, maxPresupuesto, maxDelta]);

  const previaDuplicar = useMemo(() => {
    if (!confirmacion || confirmacion.accion !== 'duplicate') return null;
    const n = Number(dialogoDuplicar.presupuesto);
    const params: ParametrosAccion = {
      copias: dialogoDuplicar.copias,
      desglose: desglose ? { porObjeto: desglose } : undefined,
      budgetEur: dialogoDuplicar.presupuesto !== '' && Number.isFinite(n) ? n : undefined,
      inicio: isoConOffset(data.rango.timezone, dialogoDuplicar.fecha, dialogoDuplicar.hora),
    };
    return calcularPrevisualizacion(
      'duplicate',
      nivel,
      data.filas,
      confirmacion.ids,
      params,
      { techoEur: maxPresupuesto, topeLoteEur: maxDelta, minimoDiarioEur: null },
    );
  }, [confirmacion, dialogoDuplicar, desglose, nivel, data.filas, maxPresupuesto, maxDelta, data.rango.timezone]);

  const previaRenombrar = useMemo(() => {
    if (!confirmacion || confirmacion.accion !== 'rename') return null;
    const modo = modoDeFormulario(dialogoRenombrar.modo, dialogoRenombrar);
    return calcularPrevisualizacion(
      'rename',
      nivel,
      data.filas,
      confirmacion.ids,
      { modo: modo ?? undefined },
      { techoEur: maxPresupuesto, topeLoteEur: maxDelta, minimoDiarioEur: null },
    );
  }, [confirmacion, dialogoRenombrar, nivel, data.filas, maxPresupuesto, maxDelta]);

  const previaProgramar = useMemo(() => {
    if (!confirmacion || confirmacion.accion !== 'schedule') return null;
    return calcularPrevisualizacion(
      'schedule',
      nivel,
      data.filas,
      confirmacion.ids,
      { inicio: isoConOffset(data.rango.timezone, dialogoProgramar.fecha, dialogoProgramar.hora) },
      { techoEur: maxPresupuesto, topeLoteEur: maxDelta, minimoDiarioEur: null },
    );
  }, [confirmacion, dialogoProgramar, nivel, data.filas, maxPresupuesto, maxDelta, data.rango.timezone]);

  const destinoPresupuesto = useMemo((): 'campaña (CBO)' | 'cada conjunto (ABO)' | 'mixto' | null => {
    if (nivel !== 'campaign' && nivel !== 'adset') return null;
    const niveles = new Set(
      data.filas
        .filter((f) => estadoSel.seleccion.ids.includes(f.objectId))
        .map((f) => f.budgetLevel),
    );
    if (niveles.size === 0) return null;
    if (niveles.has(null)) return 'mixto';
    if (niveles.size > 1) return 'mixto';
    return niveles.has('campaign') ? 'campaña (CBO)' : 'cada conjunto (ABO)';
  }, [nivel, data.filas, estadoSel.seleccion.ids]);

  return (
    <div className="space-y-4">
      {/* El encabezado y el SubNav los pone app/(panel)/anuncios/layout.tsx:
          uno solo para las tres pestañas, para que no cambien de lugar. */}
      <TabsNivel nivel={nivel} onNivel={cambiarNivel} />

      <div className="flex flex-wrap items-center justify-end gap-3">
        {loading && <span className="text-xs text-neutral-500">Actualizando…</span>}
        {!loading && refrescandoFondo && (
          <span className="text-xs text-neutral-500">actualizando gasto…</span>
        )}
        <BarraFrescura
          edadGasto={edadGasto}
          errorGasto={frescura.error}
          edadJerarquia={edadJerarquia}
          errorJerarquia={frescuraJerarquia.error}
          refrescando={refrescando}
          segundosRestantes={frenoSegundos}
          onActualizar={actualizar}
        />
      </div>

      <BarraFiltros
        nivel={nivel}
        period={period}
        rango={data.rango}
        status={status}
        cuenta={account}
        nombre={nombre}
        cuentas={cuentas}
        cascada={
          cascada ? (
            <ChipCascada cascada={cascada} nivelActivo={nivel} nombres={new Map(Object.entries(nombresCascada))} onLimpiar={limpiarCascada} />
          ) : null
        }
        ocultarSinDatos={ocultarSinDatos}
        ocultarPadreApagado={ocultarPadreApagado}
        onPeriodo={(p) => cambiarFiltro({ period: p })}
        onOcultarSinDatos={(v) => cambiarFiltro({ ocultarSinDatos: v })}
        onOcultarPadreApagado={(v) => cambiarFiltro({ ocultarPadreApagado: v })}
        onStatus={(s) => cambiarFiltro({ status: s })}
        onNombre={(n) => cambiarFiltro({ nombre: n })}
      />

      <ControlVistas
        repo={repo}
        vistaAplicada={vistaAplicada}
        columnas={columnas}
        orden={{ clave: ordenEstado.clave, dir: ordenEstado.dir }}
        ignoradas={ignoradas}
        errorRepo={errorRepo}
        onCambiarRepo={(r) => void guardarRepo(r)}
        onAplicarVista={aplicarVista}
        onColumnas={setColumnas}
        onNotificar={setAviso}
      />

      {(error || aviso || avisoTablaVieja) && (
        <Banner
          // El Banner junta los tres avisos, así que alcanza que uno sea un
          // error para pintar el bloque de error. Sólo cuando lo único que hay
          // es una advertencia se pinta ámbar: una Omisión del toggle, o un lote
          // en el que nada se aplicó y nada falló. El cambio no ocurrió, pero no
          // hay nada roto que ir a buscar.
          tone={error === null && !avisoTablaVieja && aviso?.tono === 'aviso' ? 'warn' : 'bad'}
          title="Aviso"
        >
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {error && (
              <span>
                No se pudieron cargar las filas: {error}
                <button
                  type="button"
                  onClick={() => setRetryTick((x) => x + 1)}
                  className="ml-3 rounded-md border border-border-strong px-2 py-1 font-semibold text-neutral-200 hover:bg-overlay/6"
                >
                  Reintentar
                </button>
              </span>
            )}
            {aviso && <span>{aviso.texto}</span>}
            {avisoTablaVieja && (
              <span>
                La tabla puede no reflejar el estado del servidor.
                <button
                  type="button"
                  onClick={() => setRetryTick((x) => x + 1)}
                  className="ml-3 rounded-md border border-border-strong px-2 py-1 font-semibold text-neutral-200 hover:bg-overlay/6"
                >
                  Reintentar
                </button>
              </span>
            )}
          </span>
        </Banner>
      )}

      {resultados && <ResultadosLote respuesta={resultados} />}


      {/* Los cuatro rótulos nombran el alcance («Gasto de conjuntos activos») y
          la línea de abajo dice sobre cuántas filas y con qué otros filtros
          (R7.2, R7.4). El rótulo lleva nivel y estado porque son los filtros que
          mueven filas dentro y fuera del total sin que la plata cambie; el resto
          va en la línea, que es una sola para los cuatro. */}
      <div className="space-y-2">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label={`Gasto de ${alcance}`} value={money(totGasto)} sub={edadGasto} tone="warn" />
          <StatCard label={`Ingresos de ${alcance}`} value={money(totIngresos)} sub="bruto aprobado" />
          <StatCard label={`Ganancia de ${alcance}`} value={money(totGanancia)} sub="neto − gasto" tone={totGanancia < 0 ? 'bad' : 'good'} />
          <StatCard label={`ROI de ${alcance}`} value={totRoi === null ? '—' : `${totRoi.toFixed(2)}×`} sub="neto ÷ gasto de ads" tone={totRoi === null ? 'neutral' : totRoi < 1 ? 'bad' : totRoi < 2 ? 'warn' : 'good'} />
        </div>
        <p className="text-xs text-neutral-500">{detalleTotales}</p>
      </div>

      {data.sinAtribuir.sales > 0 && (
        <Banner tone={sinAtribuirPct > 0.2 ? 'warn' : 'info'} title="Ventas sin atribuir a un anuncio">
          {fmtInt(data.sinAtribuir.sales)} ventas ({money(data.sinAtribuir.revenueEur)}) entraron en el período pero sus UTMs no
          matchean ningún {NIVEL_LABEL[nivel].toLowerCase()}. Es plata real que esta tabla no explica.
        </Banner>
      )}

      <BarraSeleccion
        nivel={nivel}
        cantidad={estadoSel.seleccion.ids.length}
        topeAlcanzado={estadoSel.seleccion.ids.length >= MAX_SELECCION}
        onAccion={(a) => {
          if (a === 'budget_set') abrirConfirmacion(a);
          else if (a === 'pause' || a === 'activate') abrirConfirmacion(a);
          else abrirConfirmacion(a); // duplicate / schedule / rename: sus formularios llegan en las tasks siguientes
        }}
      />

      {/* `totales.filas` y no `total`: los dos cuentan las filas del filtro, pero
          `total` sale de un `count(*) OVER ()` de la query de filas, así que es
          relativo al cursor en el camino `after` y colapsa a 0 en una página más
          allá del final —y ahí este aviso desaparecía justo cuando el resultado
          seguía siendo enorme—. Lo mismo en el `hint` de la Card de abajo. */}
      {data.totales.filas > 1000 && (
        <Banner tone="info" title="Resultado acotado">
          Los filtros alcanzan {fmtInt(data.totales.filas)} filas y se devuelven hasta 1000 por página (tope del contrato).
        </Banner>
      )}

      {/* R3.3: cuántas de las filas que se están mostrando tienen el dato
          atrasado, y cuántas Meta ya no devuelve. Sin marcas no hay Banner: un
          bloque que dice "0 filas viejas" es ruido en el caso normal.

          El conteo es sobre las filas VISIBLES y lo dice con esas palabras («N
          de las M filas en pantalla», en `frasesFrescura`), porque no hay ningún
          agregado del servidor que cuente desactualizados sobre el filtro
          completo: las fechas de frescura viajan por fila y la clasificación la
          hace el cliente. Ese "en pantalla" es MÁS necesario desde la task 17.2,
          no menos: la barra de KPIs de arriba ya está calculada sobre el filtro
          entero, así que dos números del mismo tablero tienen alcances distintos
          y cada uno tiene que declarar el suyo. */}
      {frasesFrescuraFilas.length > 0 && (
        <Banner
          // Ámbar sólo cuando hay desaparecidas: son las que no se arreglan
          // solas. Un atraso de la jerarquía lo cierra la próxima corrida del
          // cron y no amerita el color de un problema.
          tone={frescuraFilas.desaparecidas > 0 ? 'warn' : 'neutral'}
          title="Filas con el dato atrasado"
        >
          <span className="flex flex-col gap-1">
            {frasesFrescuraFilas.map((frase) => (
              <span key={frase}>{frase}</span>
            ))}
          </span>
        </Banner>
      )}

      <Card title={NIVEL_LABEL[nivel]} hint={`viendo ${filas.length} de ${fmtInt(data.totales.filas)} fila(s)`}>
        {loading && filas.length === 0 ? (
          <Skeleton variant="table" rows={8} />
        ) : filas.length === 0 ? (
          <EmptyState
            title={`Sin ${NIVEL_LABEL[nivel].toLowerCase()} en el rango`}
            hint="Probá otro período, otro estado u otra cuenta en los filtros de arriba."
          />
        ) : (
          <TablaAds
            filas={filas}
            columnas={columnas}
            orden={{ clave: ordenEstado.clave, dir: ordenEstado.dir }}
            seleccionados={new Set(estadoSel.seleccion.ids)}
            grilla
            onOrden={onOrden}
            onAncho={onAncho}
            onReordenar={onReordenar}
            onSeleccion={tildar}
            onSeleccionTodas={() =>
              evento({ tipo: 'tildar_todas', idsPagina: filas.map((f) => f.objectId) })
            }
            onBajarNivel={bajarNivel}
            onIrACampania={subirACampania}
            onEditarPresupuesto={editarPresupuesto}
            togglesEnCurso={togglesEnCurso}
            onToggleEstado={(f) => void toggleEstado(f)}
            onRenombrarFila={(fila) => abrirConfirmacion('rename', {}, [fila.objectId])}
            enProceso={enProceso}
            zona={data.rango.timezone}
            umbralFrescura={umbralFrescura}
            ahora={ahoraFrescura}
          />
        )}
        <Paginacion
          pagina={ordenEstado.pagina}
          totalPaginas={data.totalPaginas}
          onPagina={(p) => setOrdenEstado((prev) => ({ ...prev, pagina: p }))}
        />
      </Card>

      {confirmacion && (
        <DialogoConfirmacion
          previa={
            confirmacion.accion === 'budget_set' && previaConPresupuesto
              ? previaConPresupuesto
              : confirmacion.accion === 'duplicate' && previaDuplicar
                ? previaDuplicar
                : confirmacion.accion === 'rename' && previaRenombrar
                  ? previaRenombrar
                  : confirmacion.accion === 'schedule' && previaProgramar
                    ? previaProgramar
                    : confirmacion.previa
          }
          ejecutando={ejecutando}
          // R1 c4: mientras el importe no cumpla la regla, Ejecutar queda
          // deshabilitado y el diálogo dice por qué. La misma lectura que arma
          // el payload, así no hay forma de habilitar el botón para un texto
          // que después no se puede mandar (R1 c5).
          bloqueo={confirmacion.accion === 'budget_set' ? presupuestoDialogo.bloqueo : null}
          onConfirmar={() => void ejecutarLote()}
          onCancelar={cerrarConfirmacion}
        >
          {confirmacion.accion === 'budget_set' && (
            <FormularioPresupuesto
              techoEur={maxPresupuesto}
              valor={dialogoPresupuesto}
              onValor={setDialogoPresupuesto}
            />
          )}
          {confirmacion.accion === 'duplicate' && (
            <FormularioDuplicar
              zona={data.rango.timezone}
              copias={dialogoDuplicar.copias}
              presupuesto={dialogoDuplicar.presupuesto}
              fecha={dialogoDuplicar.fecha}
              hora={dialogoDuplicar.hora}
              destinoPresupuesto={destinoPresupuesto}
              onCopias={(copias) => setDialogoDuplicar((p) => ({ ...p, copias }))}
              onPresupuesto={(presupuesto) => setDialogoDuplicar((p) => ({ ...p, presupuesto }))}
              onFecha={(fecha) => setDialogoDuplicar((p) => ({ ...p, fecha }))}
              onHora={(hora) => setDialogoDuplicar((p) => ({ ...p, hora }))}
            />
          )}
          {confirmacion.accion === 'rename' && (
            <FormularioRenombrar
              modo={dialogoRenombrar.modo}
              prefijo={dialogoRenombrar.prefijo}
              sufijo={dialogoRenombrar.sufijo}
              buscar={dialogoRenombrar.buscar}
              poner={dialogoRenombrar.poner}
              nombreExacto={dialogoRenombrar.nombreExacto}
              onModo={(modo) => setDialogoRenombrar((p) => ({ ...p, modo }))}
              onPrefijo={(prefijo) => setDialogoRenombrar((p) => ({ ...p, prefijo }))}
              onSufijo={(sufijo) => setDialogoRenombrar((p) => ({ ...p, sufijo }))}
              onBuscar={(buscar) => setDialogoRenombrar((p) => ({ ...p, buscar }))}
              onPoner={(poner) => setDialogoRenombrar((p) => ({ ...p, poner }))}
              onNombreExacto={(nombreExacto) => setDialogoRenombrar((p) => ({ ...p, nombreExacto }))}
            />
          )}
          {confirmacion.accion === 'schedule' && (
            <FormularioProgramar
              zona={data.rango.timezone}
              fecha={dialogoProgramar.fecha}
              hora={dialogoProgramar.hora}
              onFecha={(fecha) => setDialogoProgramar((p) => ({ ...p, fecha }))}
              onHora={(hora) => setDialogoProgramar((p) => ({ ...p, hora }))}
            />
          )}
        </DialogoConfirmacion>
      )}
    </div>
  );
}
