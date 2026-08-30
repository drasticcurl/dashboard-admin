/**
 * Previsualizacion (task 10.1 de gestion-campanas-anuncios): el cálculo, SIN
 * ninguna llamada, de qué haría una Accion_Lote objeto por objeto, más los
 * totales del lote (R14 c2). Pura: sin `pg`, sin red y sin recibir ningún
 * cliente HTTP — no tiene CON QUÉ llamar a nada. La usa el cliente (el
 * Dialogo_Confirmacion la muestra) y el servidor (task 18.1 revalida con la
 * MISMA función), así revalidar no puede dar un resultado distinto al que el
 * usuario confirmó.
 *
 * Los cinco motivos de omisión son el conjunto cerrado de R14 c6.
 */

import type { AccionAds, MetricasObjeto, NivelAds } from './tipos';
import { aplicarRenombre, LARGO_MAX_NOMBRE, nombresDeCopias, type ModoRenombre } from './nombres';
import { MAX_SELECCION } from './seleccion';
import { MONEDA_REPORTE } from '@/lib/moneda-reporte';

export type MotivoOmisionLote =
  | 'ya_esta_en_ese_estado' // R14 c6
  | 'valor_igual_al_anterior'
  | 'campo_no_aplica'
  | 'no_pertenece_al_nivel'
  | 'excede_tope_de_lote';

export type FilaPrevisualizacion = {
  objectId: string;
  objectName: string | null;
  /** Lo que la acción cambia, ya formateado. null = no aplica. */
  antes: string | null;
  despues: string | null;
  /** Cuando hay motivo, el objeto se omite y no se manda. */
  motivo: MotivoOmisionLote | null;
  /** No ejecutable: el diálogo lo marca y no lo manda (R12 c6). */
  ejecutable: boolean;
  /**
   * Aviso que no bloquea por sí mismo: nombre repetido entre hermanos (R12 c7),
   * techo, padre apagado (R6.4) y Objeto_Desaparecido (R3.4). Cuando hay más de
   * uno viajan todos, separados por ` · `.
   */
  advertencia: string | null;
};

export type DesgloseDuplicacion = {
  /**
   * Por objeto origen: cuántos descendientes tiene. Para una campaña, conjuntos
   * y anuncios; para un conjunto, anuncios (el conjunto en sí es 1 por copia).
   * Lo arma el Gestor con filas de los niveles de abajo ya cargadas (lecturas a
   * /api/data/ads, no a Meta): sin esto la previsualización queda incompleta
   * (R14 c12) y el diálogo no deja ejecutar.
   */
  porObjeto: ReadonlyMap<string, { conjuntos: number; anuncios: number }>;
};

/**
 * El `status` de los ANTEPASADOS de un objeto (R6.4). No vive en
 * `MetricasObjeto` y no se puede derivar de él: un objeto no trae la fila de su
 * padre, y el `effectiveStatus` del propio objeto no alcanza (ver
 * `advertenciaPadreApagado`).
 *
 * Se llama «padres» en plural y no «padre» porque un anuncio tiene dos
 * antepasados que lo pueden dejar sin entregar —su conjunto y su campaña— y
 * `FiltrosAds.ocultarPadreApagado` ya usa «padre» con ese mismo alcance amplio.
 *
 * `null` en cualquiera de los dos es "no se sabe" o "no aplica", nunca "está
 * activo": con `null` no se advierte nada.
 */
export type EstadoPadres = {
  /** `status` de la campaña. null a nivel campaña: un objeto no es su padre. */
  campania: string | null;
  /** `status` del conjunto. Sólo lo tienen los anuncios; null en los otros. */
  conjunto: string | null;
};

export type ParametrosAccion = {
  /** Duplicación: copias por objeto, entera 1..5, default 1 (R10 c4). */
  copias?: number;
  /** Presupuesto en EUR, 2 decimales. */
  budgetEur?: number;
  /** Inicio programado en ISO 8601 con offset. */
  inicio?: string;
  /** Renombrado: exactamente uno de los cuatro modos (R12 c2). */
  modo?: ModoRenombre;
  /** Duplicación: el desglose de descendientes por objeto origen (R14 c5). */
  desglose?: DesgloseDuplicacion;
  /**
   * `status` de los antepasados, por objectId (R6.4). Mismo patrón que
   * `desglose`: dato de la jerarquía que la fila no trae y que el llamador
   * consigue de donde puede —el servidor lo lee en `leerObjetos`— sin que este
   * módulo toque nada. Ausente, o sin entrada para un objeto, es "no se sabe" y
   * no produce advertencia.
   */
  padres?: ReadonlyMap<string, EstadoPadres>;
};

export type Previsualizacion = {
  accion: AccionAds;
  /** Nombre de la acción en castellano (R14 c3). */
  rotuloAccion: string;
  nivel: NivelAds;
  alcanzados: number;
  filas: FilaPrevisualizacion[];
  /** Sólo en duplicaciones: el desglose de R14 c5. null = no aplica. */
  aCrear: { campanias: number; conjuntos: number; anuncios: number; total: number } | null;
  /** Sólo en presupuesto: los totales de R13 c8. */
  presupuesto: { deltaTotalEur: number; topeLoteEur: number; techoEur: number } | null;
  /** false cuando faltan datos para calcular algún antes/después (R14 c12). */
  completa: boolean;
};

/** El nombre de cada acción en castellano (R14 c3, R15 c7). Record completo:
 *  agregar un valor a AccionAds sin su rótulo rompe la compilación (R15 c8). */
export const ROTULO_ACCION: Record<AccionAds, string> = {
  pause: 'pausar',
  activate: 'activar',
  budget_increase: 'subir presupuesto',
  budget_decrease: 'bajar presupuesto',
  budget_set: 'fijar presupuesto',
  config: 'configuración',
  duplicate: 'duplicar',
  rename: 'renombrar',
  schedule: 'programar inicio',
};

// Estados que Meta muestra pero no se pueden escribir (mismo conjunto que usa el
// toggle de la tabla): para estas filas la acción de estado no aplica.
export const ESTADOS_NO_ESCRIBIBLES = new Set([
  'ARCHIVED',
  'DELETED',
  'DISAPPROVED',
  'WITH_ISSUES',
  'PENDING_REVIEW',
  'IN_PROCESS',
]);

const eur = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: MONEDA_REPORTE,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Fechas con día, mes, año, hora y minuto (R14 c4). */
const fechaHora = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function fmtFecha(iso: string | null): string | null {
  if (iso === null) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return fechaHora.format(d);
}

function fmtEur(n: number | null): string | null {
  return n === null ? null : eur.format(n);
}

/** El padre de la fila dentro de su nivel: la campaña para los conjuntos, la
 *  cuenta para las campañas. Sirve para armar los `ocupados` de los nombres. */
function padreDe(fila: MetricasObjeto): string {
  return fila.level === 'adset' ? fila.campaignId : fila.accountId;
}

/**
 * Un antepasado con este `status` NO entrega, y por lo tanto el objeto de abajo
 * tampoco, por más que su propio `status` quede en ACTIVE.
 *
 * Cualquier cosa que no sea ACTIVE cuenta: PAUSED es el caso de R6.4, y
 * ARCHIVED o DELETED tampoco entregan. `null` y `''` son "no se sabe" y no
 * advierten nada: una advertencia inventada sobre un dato que no tenemos es
 * peor que el silencio.
 */
function padreApagado(status: string | null): boolean {
  return status !== null && status !== '' && status !== 'ACTIVE';
}

/**
 * La advertencia de R6.4: qué decir cuando se escribe el estado de un objeto
 * cuyo antepasado está apagado. null = no hay nada que advertir.
 *
 * POR QUÉ NO ALCANZA `effectiveStatus`. Parece que sí —`CAMPAIGN_PAUSED` y
 * `ADSET_PAUSED` son exactamente Meta diciendo que el padre está apagado— pero
 * Meta resuelve el `effective_status` con el estado PROPIO antes que con el del
 * padre: un conjunto PAUSED bajo una campaña PAUSED viene con
 * `effective_status = 'PAUSED'`, no `'CAMPAIGN_PAUSED'`. Verificado contra la
 * base: cuando se escribió esto eran 37 de 169 conjuntos, y son justo los que
 * alguien va a querer activar (un objeto que ya está ACTIVE no se activa).
 * Derivar el padre del `effective_status` dejaría la advertencia muda
 * exactamente en el caso que la task vino a cubrir.
 *
 * QUÉ TIENE QUE DECIR AL ACTIVAR. Las tres cosas que el panel no distinguía,
 * porque confirmó un cambio que era real y a la vez inútil: que el cambio se
 * aplicó («queda activo»), que el objeto igual no va a entregar («no entrega») y
 * qué hacer al respecto («hasta que se active la campaña»). Es una advertencia y
 * no un bloqueo: activar un conjunto con la campaña pausada es legítimo cuando
 * se está preparando algo para prender después.
 *
 * QUÉ TIENE QUE DECIR AL PAUSAR (2.11 de `toggle-conjuntos-entrega`). **Otro
 * texto, porque dice otra cosa.** Al activar, «no entrega» es una advertencia
 * sobre el FUTURO; al pausar es una aclaración sobre lo que se está apagando, en
 * PASADO: el objeto ya no entregaba, así que apagarlo no cambia la entrega. No
 * promete nada del futuro porque no hay nada que prometer, y nombra igual al
 * antepasado —la navegación de 2.12 lo necesita para saber a qué fila llevar—.
 *
 * `accion` es explícita y sin default a propósito: el llamador tiene que elegir
 * qué está diciendo. Un default dejaría que la variante equivocada saliera en
 * silencio, y la diferencia entre los dos textos es justamente el tiempo verbal
 * de un hecho que el usuario va a leer para decidir.
 */
export function advertenciaPadreApagado(
  nivel: NivelAds,
  padres: EstadoPadres | undefined,
  accion: 'pause' | 'activate',
): string | null {
  if (nivel === 'campaign' || !padres) return null; // una campaña no tiene padre
  const campania = padreApagado(padres.campania);
  if (nivel === 'adset') {
    if (!campania) return null;
    return accion === 'activate'
      ? 'la campaña está pausada: el conjunto queda activo pero no entrega hasta que se active la campaña'
      : 'la campaña está pausada: el conjunto ya no estaba entregando, así que pausarlo no cambia la entrega';
  }
  // Nivel anuncio: lo apaga cualquiera de los dos antepasados, y el mensaje
  // nombra al que hay que ir a prender. Si son los dos, los dos.
  const conjunto = padreApagado(padres.conjunto);
  if (conjunto && campania) {
    return accion === 'activate'
      ? 'el conjunto y la campaña están pausados: el anuncio queda activo pero no entrega hasta que se activen los dos'
      : 'el conjunto y la campaña están pausados: el anuncio ya no estaba entregando, así que pausarlo no cambia la entrega';
  }
  if (conjunto) {
    return accion === 'activate'
      ? 'el conjunto está pausado: el anuncio queda activo pero no entrega hasta que se active el conjunto'
      : 'el conjunto está pausado: el anuncio ya no estaba entregando, así que pausarlo no cambia la entrega';
  }
  if (campania) {
    return accion === 'activate'
      ? 'la campaña está pausada: el anuncio queda activo pero no entrega hasta que se active la campaña'
      : 'la campaña está pausada: el anuncio ya no estaba entregando, así que pausarlo no cambia la entrega';
  }
  return null;
}

/**
 * La advertencia de R3.4: el objeto está marcado como Objeto_Desaparecido, o
 * sea que Meta dejó de devolverlo y el «antes» que se muestra sale de una copia
 * que ya nadie confirma. null = Meta lo sigue devolviendo.
 *
 * NO bloquea (R3.5): la desaparición puede ser transitoria y el objeto puede
 * seguir siendo escribible. Sólo se dice antes de ejecutar.
 */
function advertenciaDesaparecido(fila: MetricasObjeto): string | null {
  if (fila.desaparecidoAt === null) return null;
  const desde = fmtFecha(fila.desaparecidoAt);
  const cola = 'Meta ya no lo devuelve y la escritura puede fallar';
  return desde === null
    ? `objeto desaparecido: ${cola}`
    : `objeto desaparecido desde el ${desde}: ${cola}`;
}

/** Suma una advertencia sin pisar la que ya había: dos hechos distintos sobre
 *  la misma fila se cuentan los dos. null no agrega nada. */
function sumarAdvertencia(base: FilaPrevisualizacion, texto: string | null): void {
  if (texto === null) return;
  base.advertencia = base.advertencia === null ? texto : `${base.advertencia} · ${texto}`;
}

function vacia(fila: MetricasObjeto): FilaPrevisualizacion {
  return {
    objectId: fila.objectId,
    objectName: fila.objectName,
    antes: null,
    despues: null,
    motivo: null,
    ejecutable: true,
    advertencia: null,
  };
}

/**
 * Calcula la Previsualizacion completa sin tocar la red (R14 c2). Los datos
 * son las filas YA cargadas en el cliente. Cuando falta una fila, o el desglose
 * de una duplicación, `completa` queda en false y el diálogo no deja ejecutar
 * (R14 c12).
 */
export function calcularPrevisualizacion(
  accion: AccionAds,
  nivel: NivelAds,
  filas: readonly MetricasObjeto[],
  seleccion: readonly string[],
  params: ParametrosAccion,
  topes: { techoEur: number; topeLoteEur: number; minimoDiarioEur: number | null },
): Previsualizacion {
  const porId = new Map(filas.map((f) => [f.objectId, f]));
  const out: FilaPrevisualizacion[] = [];
  // Los nombres ya planificados en esta corrida (duplicaciones y renombrados):
  // son parte de los `ocupados` y de la detección de repetidos entre hermanos.
  const planeados = new Map<string, string>();
  let completa = true;

  const encontradas: MetricasObjeto[] = [];
  for (let i = 0; i < seleccion.length; i++) {
    const id = seleccion[i]!;
    const fila = porId.get(id);
    if (!fila) {
      completa = false; // R14 c12: falta el dato para calcular antes/después
      continue;
    }
    if (i >= MAX_SELECCION) {
      out.push({
        objectId: id,
        objectName: fila.objectName,
        antes: null,
        despues: null,
        motivo: 'excede_tope_de_lote',
        ejecutable: false,
        advertencia: null,
      });
      continue;
    }
    encontradas.push(fila);

    if (fila.level !== nivel) {
      out.push({
        objectId: id,
        objectName: fila.objectName,
        antes: null,
        despues: null,
        motivo: 'no_pertenece_al_nivel',
        ejecutable: false,
        advertencia: null,
      });
      continue;
    }

    out.push(calcularFila(accion, nivel, fila, filas, planeados, params, topes));
  }

  const aCrear = accion === 'duplicate' ? desgloseDuplicacion(nivel, encontradas, params) : null;
  if (accion === 'duplicate' && !params.desglose) completa = false; // R14 c5 sin datos

  const presupuesto =
    accion === 'budget_set' && typeof params.budgetEur === 'number'
      ? {
          deltaTotalEur: encontradas.reduce((acc, f) => {
            const actual = f.dailyBudgetEur ?? 0;
            return acc + Math.max(0, params.budgetEur! - actual);
          }, 0),
          topeLoteEur: topes.topeLoteEur,
          techoEur: topes.techoEur,
        }
      : null;

  return {
    accion,
    rotuloAccion: ROTULO_ACCION[accion],
    nivel,
    alcanzados: out.length,
    filas: out,
    aCrear,
    presupuesto,
    completa,
  };
}

/**
 * La fila de UN objeto, con las advertencias que no dependen de la acción ya
 * sumadas encima de las que sí.
 *
 * La advertencia de Objeto_Desaparecido vive acá y no dentro del switch porque
 * R3.4 la pide para TODA acción de escritura, no sólo para las de estado: el
 * hecho es del objeto, no de lo que se le quiere hacer. Va después del switch y
 * no en `vacia` porque varias ramas escriben `advertencia` y la pisarían.
 *
 * Las dos filas que `calcularPrevisualizacion` arma sin pasar por acá
 * (`excede_tope_de_lote` y `no_pertenece_al_nivel`) quedan afuera a propósito:
 * son rechazos del PEDIDO, no del objeto, no se ejecutan por ningún camino y no
 * hay nada que advertir antes de una escritura que no va a ocurrir.
 */
function calcularFila(
  accion: AccionAds,
  nivel: NivelAds,
  fila: MetricasObjeto,
  filasTodas: readonly MetricasObjeto[],
  planeados: Map<string, string>,
  params: ParametrosAccion,
  topes: { techoEur: number; topeLoteEur: number; minimoDiarioEur: number | null },
): FilaPrevisualizacion {
  const base = calcularFilaPorAccion(accion, nivel, fila, filasTodas, planeados, params, topes);
  sumarAdvertencia(base, advertenciaDesaparecido(fila)); // R3.4
  return base;
}

function calcularFilaPorAccion(
  accion: AccionAds,
  nivel: NivelAds,
  fila: MetricasObjeto,
  filasTodas: readonly MetricasObjeto[],
  planeados: Map<string, string>,
  params: ParametrosAccion,
  topes: { techoEur: number; topeLoteEur: number; minimoDiarioEur: number | null },
): FilaPrevisualizacion {
  const base = vacia(fila);

  switch (accion) {
    case 'pause':
    case 'activate': {
      const destino = accion === 'pause' ? 'PAUSED' : 'ACTIVE';
      base.antes = fila.status;
      base.despues = destino;
      if (
        ESTADOS_NO_ESCRIBIBLES.has(fila.status ?? '') ||
        ESTADOS_NO_ESCRIBIBLES.has(fila.effectiveStatus ?? '')
      ) {
        // El objeto no se puede escribir en ningún caso: el estado del padre no
        // cambia nada y nombrarlo acá sería ruido sobre una fila que no se manda.
        base.motivo = 'campo_no_aplica';
        base.ejecutable = false;
      } else {
        if (fila.status === destino) base.motivo = 'ya_esta_en_ese_estado';
        // R6.4 para `activate`, y 2.11 de `toggle-conjuntos-entrega` para
        // `pause`. Los dos textos los elige `advertenciaPadreApagado`; lo que se
        // decide acá es CUÁNDO se dice, y las dos mitades de la condición tienen
        // motivos distintos.
        //
        // `activate` se suma SIEMPRE, incluso cuando el motivo es
        // `ya_esta_en_ese_estado`: «ya está activo y sigue sin entregar» ES el
        // síntoma reportado —"parece que lo habilita pero realmente no lo
        // hace"—. El usuario pidió activar; la respuesta que necesita es la
        // misma se escriba o se omita.
        //
        // `pause` se suma SÓLO sobre una fila `ACTIVE`, o sea sólo cuando la
        // escritura hace algo. Pausar algo que ya está `PAUSED` llega con
        // `motivo: 'ya_esta_en_ese_estado'` y la aclaración no agrega nada: el
        // objeto no cambia y no entregaba antes ni después. Con esta mitad el
        // aviso nuevo aparece sobre los 92 conjuntos `ACTIVE / CAMPAIGN_PAUSED`
        // y no sobre los 67 que ya están pausados, así que el «ruido sobre la
        // operación de lote más común» que temía la versión anterior queda
        // acotado a las filas que efectivamente se están apagando.
        //
        // La asimetría entre las dos mitades es deliberada y no un descuido: son
        // dos preguntas distintas, y cada una tiene su motivo escrito arriba.
        const avisaPadreApagado = accion === 'activate' || fila.status === 'ACTIVE';
        if (avisaPadreApagado) {
          sumarAdvertencia(
            base,
            advertenciaPadreApagado(nivel, params.padres?.get(fila.objectId), accion),
          );
        }
      }
      return base;
    }

    case 'budget_set': {
      const budgetEur = params.budgetEur;
      base.antes = fmtEur(fila.dailyBudgetEur);
      base.despues = typeof budgetEur === 'number' ? fmtEur(budgetEur) : null;
      if (nivel === 'ad' || fila.budgetLevel !== nivel || fila.budgetMode === 'lifetime') {
        base.motivo = 'campo_no_aplica';
        base.ejecutable = false;
      } else if (typeof budgetEur === 'number' && fila.dailyBudgetEur === budgetEur) {
        base.motivo = 'valor_igual_al_anterior';
      } else if (typeof budgetEur === 'number' && budgetEur > topes.techoEur) {
        base.advertencia = `supera el Techo_Absoluto de ${fmtEur(topes.techoEur)} por objeto`;
        base.ejecutable = false;
      }
      return base;
    }

    case 'rename': {
      const modo = params.modo;
      if (!modo) {
        base.motivo = 'campo_no_aplica';
        base.ejecutable = false;
        return base;
      }
      const original = fila.objectName ?? '';
      const nombreNuevo = aplicarRenombre(original, modo).trim();
      base.antes = fila.objectName;
      base.despues = nombreNuevo;
      if (nombreNuevo === '') {
        base.advertencia = 'el nombre quedaría vacío';
        base.ejecutable = false; // R12 c6
      } else if (nombreNuevo.length > LARGO_MAX_NOMBRE) {
        base.advertencia = `supera los ${LARGO_MAX_NOMBRE} caracteres`;
        base.ejecutable = false; // R12 c6
      } else if (nombreNuevo === fila.objectName) {
        base.motivo = 'valor_igual_al_anterior'; // R12 c6: marcado como idéntico
      } else {
        // R12 c7: nombre resultante repetido entre hermanos = advertencia, no bloqueo.
        const repetido =
          filasTodas.some(
            (f) =>
              f.objectId !== fila.objectId &&
              f.objectName === nombreNuevo &&
              padreDe(f) === padreDe(fila),
          ) ||
          Array.from(planeados.entries()).some(
            ([oid, nombre]) => oid !== fila.objectId && nombre === nombreNuevo,
          );
        if (repetido) base.advertencia = 'nombre repetido entre hermanos';
      }
      planeados.set(fila.objectId, nombreNuevo);
      return base;
    }

    case 'schedule': {
      base.antes = fmtFecha(fila.inicioProgramado);
      base.despues = params.inicio ? fmtFecha(params.inicio) : null;
      if (nivel !== 'adset') {
        base.motivo = 'campo_no_aplica'; // R11 c1, c9: el inicio se programa en el conjunto
        base.ejecutable = false;
      } else if (params.inicio !== undefined && fila.inicioProgramado === params.inicio) {
        base.motivo = 'valor_igual_al_anterior';
      }
      return base;
    }

    case 'duplicate': {
      if (nivel === 'ad') {
        base.motivo = 'campo_no_aplica'; // R10 c14: este panel duplica campañas y conjuntos
        base.ejecutable = false;
        return base;
      }
      const k = params.copias ?? 1;
      // ocupados = hermanos del mismo padre que el panel conoce (las filas
      // cargadas) más los nombres ya planificados en la misma corrida.
      const ocupados = new Set(
        filasTodas
          .filter((f) => f.objectId !== fila.objectId && padreDe(f) === padreDe(fila))
          .map((f) => f.objectName ?? ''),
      );
      const nombres = nombresDeCopias(fila.objectName ?? '', k, ocupados);
      for (const n of nombres) planeados.set(`${fila.objectId}#${n}`, n);
      base.antes = fila.objectName;
      base.despues = nombres.join(' · ');
      return base;
    }

    default:
      return base;
  }
}

function desgloseDuplicacion(
  nivel: NivelAds,
  seleccionadas: readonly MetricasObjeto[],
  params: ParametrosAccion,
): { campanias: number; conjuntos: number; anuncios: number; total: number } | null {
  if (nivel === 'ad' || !params.desglose) return null;
  const k = params.copias ?? 1;
  let conjuntos = 0;
  let anuncios = 0;
  for (const f of seleccionadas) {
    const d = params.desglose.porObjeto.get(f.objectId);
    if (!d) return null; // sin el desglose no se puede prometer el número (R14 c5)
    conjuntos += (nivel === 'campaign' ? d.conjuntos : 1) * k;
    anuncios += d.anuncios * k;
  }
  const campanias = nivel === 'campaign' ? seleccionadas.length * k : 0;
  return { campanias, conjuntos, anuncios, total: campanias + conjuntos + anuncios };
}
