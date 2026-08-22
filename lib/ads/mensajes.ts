/**
 * El traductor ÚNICO de una respuesta del Endpoint_Acciones a texto para el
 * usuario (task 2.1 de frescura-y-acciones-anuncios). PURA: sin `pg`, sin red y
 * sin React, porque la comparten el toggle de una fila y la ejecución de lote,
 * que hoy interpretan la MISMA respuesta de dos formas distintas: el lote
 * muestra `detail` y el toggle tira `new Error(mensaje ?? \`HTTP ${status}\`)`.
 *
 * De ahí sale el bug reportado como "activar no activa nada": el servidor
 * responde `200` con `resultados: [{ estado: 'omitido', mensaje: null }]`, el
 * `??` cae a la derecha y la pantalla muestra `HTTP 200` — un código de éxito
 * presentado como error, que no dice nada de lo único que importaba (que el
 * objeto se omitió porque la copia local ya lo creía en ese estado).
 *
 * Las seis reglas, en el orden del design §5:
 *
 *   1. primer resultado `confirmado`      → null, SALVO que traiga `advertencia`
 *   2. `omitido`                          → aviso, con el motivo del catálogo
 *   3. `indeterminado`                    → aviso, "no se sabe si se aplicó"
 *   4. `fallido`                          → error, mensaje del catálogo de errores
 *   5. cuerpo `{ ok: false, ... }`        → error, `detail` y si no `error`
 *   6. y sólo si nada aplicó y el status NO es 2xx → un texto con el código
 *
 * ## La excepción de la regla 1: se aplicó y aun así no sirve (R6.4, R3.4)
 *
 * «Confirmado» respondía dos preguntas con una sola palabra: ¿la escritura
 * llegó? y ¿el objeto va a hacer algo? La primera es sí; la segunda no siempre.
 * Un conjunto que se activa con su campaña pausada queda ACTIVE en Meta y no
 * entrega, y eso es exactamente el bug reportado como "parece que lo habilita
 * pero realmente no lo hace" en el caso en que la escritura SÍ se confirmó: en
 * la auditoría hay tres `manual activate` con `estado = confirmado` y
 * `PAUSED → ACTIVE` de un objeto que igual no entregó.
 *
 * La `advertencia` que el Preflight ya calcula (`lib/ads/previsualizacion.ts`)
 * viaja en el resultado y acá se convierte en texto: un `confirmado` con
 * advertencia devuelve un aviso en lugar de `null`, y los otros cuatro
 * desenlaces la SUMAN a su propio texto en lugar de elegir entre las dos cosas
 * —un objeto puede a la vez omitirse por «ya está en ese estado» y no entregar
 * porque su padre está apagado, que en producción es el caso mayoritario.
 *
 * Eso cambia lo que significa «el traductor devolvió un aviso»: ya no equivale a
 * «el cambio no quedó aplicado». Quien use eso para decidir una reversión tiene
 * que mirar `Aviso.aplicado`, no la nulidad del aviso (ver el comentario del
 * campo).
 *
 * ## Por qué el `200` ya no puede aparecer en un texto (R2 c6, Property 3)
 *
 * `httpStatus` se interpola en UN solo lugar del módulo, adentro de la regla 6,
 * que está guardada por `!esExitoso(httpStatus)`. No hay otra rama que lo mire y
 * no hay otra plantilla que lo reciba, así que un status 2xx no tiene por dónde
 * llegar a un texto. Cuando un 2xx no matchea ninguna regla —una respuesta que
 * nuestro server no produce— se devuelve una plantilla fija SIN interpolación.
 *
 * El resto de los textos son plantillas en castellano de este módulo o texto que
 * el servidor ya tradujo: el `mensaje` del catálogo de errores
 * (`lib/ads/errores.ts`), el `detail` de un rechazo y —desde la task 14.3— la
 * `edadDelDato` de una Omisión, que llega formateada precisamente para que el
 * redondeo de la antigüedad no ocurra acá.
 *
 * El único número que este módulo FABRICA, además del status de la regla 6, es el
 * conteo de objetos del resumen de `avisoDeLote`, y no puede colisionar con un
 * status 2xx: el Endpoint_Acciones admite como máximo 100 objetos por
 * Accion_Lote (el motivo `excede_tope_de_lote` de acá al lado es el que lo hace
 * cumplir), así que el conteo más grande que puede llegar a un texto es `100`.
 * Los textos del servidor sí pueden traer dígitos —un mensaje de cuota nombra
 * segundos, un tope nombra euros— y por eso la Property 3 se verifica también
 * por la vía que no depende de ellos: dentro de 2xx, la salida no cambia si
 * cambia el status.
 *
 * ## Los dos llamadores, y por qué no comparten una sola función
 *
 * `mensajeDeResultado` habla de UN objeto: mira `resultados[0]` y sus textos
 * dicen "el cambio", "la fila", "el objeto". Eso es exacto para el toggle, que
 * manda exactamente un objeto por pedido.
 *
 * Una Accion_Lote manda hasta 100, y ahí `resultados[0]` no habla por el resto:
 * un aviso que dijera "el cambio no se aplicó porque ya estaba en ese estado"
 * ante un lote de 100 con una sola omisión sería falso para los otros 99. Por eso
 * el lote entra por `avisoDeLote`, que delega en `mensajeDeResultado` cuando la
 * respuesta es del sobre (400/401/500, `ok: false`) o cuando el lote tenía un
 * solo objeto —los dos casos en los que las dos pantallas ven lo mismo y tienen
 * que decir lo mismo (R2 c5)— y arma un resumen contado cuando hay varios.
 */

import type { MotivoOmisionLote } from './previsualizacion';

/** El tono con el que la pantalla pinta el aviso. */
export type TonoAviso = 'ok' | 'aviso' | 'error';

export type Aviso = {
  tono: TonoAviso;
  /** Nunca vacío: un aviso sin texto sería un éxito silencioso (Property 2). */
  texto: string;
  /**
   * `true` cuando el cambio SÍ quedó aplicado en Meta y el aviso habla de otra
   * cosa: hoy, de que el objeto no va a entregar igual (R6.4). Ausente en todos
   * los demás avisos, que son justamente los desenlaces en los que el cambio no
   * quedó.
   *
   * Existe porque hasta la task 15 la nulidad del aviso alcanzaba para las dos
   * preguntas: `mensajeDeResultado` devolvía `null` sólo ante un `confirmado`,
   * así que «hay aviso» era lo mismo que «no se aplicó», y `ejecutarToggle` de
   * `GestorAnuncios.tsx` deriva de ahí la reversión del Pintado_Optimista
   * (R2 c3). Con la advertencia de padre apagado las dos preguntas se separan, y
   * revertir la fila acá sería el error simétrico al que este spec vino a
   * arreglar: la escritura ocurrió, la fila tiene que quedar en el valor nuevo y
   * el aviso sólo agrega que ese valor no alcanza para entregar.
   *
   * Opcional y no requerido a propósito: la pantalla arma avisos propios (un
   * error de red, por ejemplo) y ninguno de ellos habla de un cambio aplicado,
   * así que «ausente» es el default correcto y no obliga a tocar cada literal.
   */
  aplicado?: boolean;
};

/** Los cinco desenlaces que el Endpoint_Acciones declara por objeto. */
export type EstadoResultadoAccion =
  | 'confirmado'
  | 'fallido'
  | 'indeterminado'
  | 'omitido'
  | 'no_intentado';

/**
 * Los motivos de Omisión que viajan al cliente: los cinco de la
 * Previsualizacion más el de la programación, que el route agrega porque un
 * conjunto que ya arrancó no admite cambio de inicio (R11).
 */
export type MotivoOmision = MotivoOmisionLote | 'ya_esta_entregando';

/**
 * El catálogo de motivos, en castellano y como cláusula (sigue a un "porque").
 * Vivía en `app/(panel)/anuncios/Previsualizacion.tsx`, que ahora lo importa de
 * acá: un solo catálogo, así la tabla de la previa y el aviso posterior a la
 * ejecución no pueden nombrar el mismo motivo de dos maneras.
 *
 * `Record` completo sobre la unión cerrada: sumar un motivo sin su texto rompe
 * la compilación en lugar de mostrar la clave cruda en pantalla.
 */
export const MOTIVO_TEXTO: Record<MotivoOmision, string> = {
  ya_esta_en_ese_estado: 'ya está en el estado que la acción pediría',
  valor_igual_al_anterior: 'el valor resultante es igual al anterior',
  campo_no_aplica: 'el campo que la acción cambia no aplica a este objeto',
  no_pertenece_al_nivel: 'el objeto no pertenece al Nivel_Activo',
  excede_tope_de_lote: 'el objeto excede el límite de 100 objetos por Accion_Lote',
  ya_esta_entregando: 'el conjunto ya arrancó y su inicio no se puede cambiar',
};

export type ResultadoAccion = {
  objectId: string;
  objectName: string | null;
  estado: EstadoResultadoAccion;
  /** Mensaje del catálogo de errores, ya en castellano. null en los desenlaces sin error. */
  mensaje: string | null;
  /** El código de Meta como dato secundario (R16 c9). */
  codigoMeta: number | null;
  creados?: string[];
  motivo?: MotivoOmision;
  /**
   * La antigüedad del dato con el que el Preflight decidió la Omisión, YA
   * formateada por el servidor, para que el aviso cierre con "según un dato de
   * hace X" (R6 c1, task 14.3). La escribe `edadDelDatoDeOmision` de
   * `lib/ads/acciones.ts` como la cola de esa frase, así que los tres valores
   * posibles son de la forma «de hace 4 min», «confirmado contra Meta al
   * resolver el pedido» o «sin fecha de sincronización» — nunca un número solo.
   *
   * Llega formateada y no en segundos a propósito: así el redondeo queda del
   * lado que también escribe la `explicacion` de la auditoría (no puede haber
   * dos versiones de la misma edad) y este módulo no gana una interpolación de
   * números.
   *
   * Opcional porque el Endpoint_Acciones la manda sólo en los resultados
   * `omitido`: es el único desenlace en el que el servidor decidió con un dato
   * local en lugar de con la respuesta de Meta.
   */
  edadDelDato?: string | null;
  /**
   * La advertencia NO bloqueante que el Preflight calculó para este objeto,
   * copiada de `FilaPrevisualizacion.advertencia` por el Endpoint_Acciones: el
   * padre pausado (R6.4) y el Objeto_Desaparecido (R3.4), y las dos juntas
   * separadas por ` · ` cuando aplican las dos.
   *
   * Llega como cláusula en minúscula y sin punto final, igual que los textos de
   * `MOTIVO_TEXTO`, y este módulo la convierte en oración. Es texto que armó el
   * servidor —nunca del cliente— así que vale lo mismo que el `mensaje` del
   * catálogo de errores para la Property 3: se muestra tal cual.
   *
   * Es independiente del desenlace: el objeto puede no entregar tanto si la
   * escritura se aplicó como si se omitió, y en el caso mayoritario de
   * producción (conjuntos ACTIVE bajo campaña pausada) llega junto con
   * `motivo: 'ya_esta_en_ese_estado'`.
   */
  advertencia?: string | null;
};

export type CorteLote = {
  causa: 'token_vencido' | 'cuota' | 'cupo_objetos';
  detalle: string;
  backoffSegundos: number | null;
};

/** El cuerpo de un pedido que el servidor procesó (200). */
export type RespuestaAcciones = {
  ok: true;
  aplicados: number;
  total: number;
  corte: CorteLote | null;
  resultados: readonly ResultadoAccion[];
};

/** El cuerpo de un rechazo: guard (401), esquema o Preflight (400). */
export type ErrorAcciones = {
  ok: false;
  error?: string | null;
  detail?: string | null;
};

export type CuerpoAcciones = RespuestaAcciones | ErrorAcciones;

const TEXTO_INDETERMINADO =
  'No se sabe si el cambio se aplicó en Meta: el pedido no llegó a confirmarse. ' +
  'El resultado se define cuando corra la reconciliación.';

const TEXTO_FALLIDO_SIN_MENSAJE =
  'Meta rechazó el cambio y no informó el motivo. El objeto quedó como estaba.';

const TEXTO_OMITIDO_SIN_MOTIVO =
  'El cambio no se aplicó: el servidor omitió el objeto sin llamar a Meta.';

const TEXTO_NO_INTENTADO =
  'El objeto no se intentó: el lote se cortó antes de llegar a él.';

/**
 * Un 2xx que no encaja en ninguna regla. Plantilla FIJA, sin interpolar el
 * status: es el caso que producía `HTTP 200` (R2 c6, Property 3).
 */
const TEXTO_SIN_DESENLACE =
  'El servidor respondió sin informar el desenlace del objeto: la fila queda con ' +
  'el valor que devuelva la próxima lectura.';

/** 2xx. El único lugar del módulo que mira el rango del status. */
function esExitoso(httpStatus: number): boolean {
  return httpStatus >= 200 && httpStatus < 300;
}

/**
 * Un texto que sirve para mostrar, o null. La cadena vacía cuenta como AUSENTE:
 * un servidor que manda `mensaje: ''` no dijo nada, y un aviso sin texto sería
 * un éxito silencioso — la pantalla no lo puede pintar y el usuario se queda sin
 * saber que el cambio no se aplicó (Property 2, R2 c3).
 *
 * Toma `unknown` porque el cuerpo entra de un `res.json()`: `detail` y `error`
 * pueden llegar con cualquier tipo. Las tres reglas que consumen texto de la
 * respuesta (2, 4 y 5) pasan por acá, así que ninguna puede volver a quedarse
 * con un `??` que sólo cubre `null` y `undefined`.
 */
function textoONulo(valor: unknown): string | null {
  return typeof valor === 'string' && valor !== '' ? valor : null;
}

/**
 * El arreglo de resultados del cuerpo, o vacío. Lee de forma defensiva porque el
 * cuerpo entra de un `res.json()`: un 500 con HTML, un cuerpo vacío o un
 * `{ ok: false }` sin `resultados` no pueden hacer tirar al traductor.
 */
function arregloDeResultados(cuerpo: CuerpoAcciones | null | undefined): readonly unknown[] {
  const bruto = (cuerpo as { resultados?: unknown } | null | undefined)?.resultados;
  return Array.isArray(bruto) ? (bruto as readonly unknown[]) : [];
}

/** El primer resultado del cuerpo, o null si no vino o no es un objeto. */
function primerResultado(cuerpo: CuerpoAcciones | null | undefined): ResultadoAccion | null {
  const primero: unknown = arregloDeResultados(cuerpo)[0];
  return typeof primero === 'object' && primero !== null ? (primero as ResultadoAccion) : null;
}

/**
 * La oración que nombra la antigüedad del dato con el que el Preflight decidió,
 * o `''` cuando no viajó (task 14.3, R6 c1).
 *
 * Va como oración aparte y no incrustada en la razón porque las dos mitades del
 * mensaje responden preguntas distintas —qué decidió el servidor y con qué dato—
 * y porque la razón puede venir del catálogo o del servidor, con o sin punto
 * final propio.
 *
 * `edadDelDato` llega YA formateada (`lib/ads/acciones.ts`,
 * `edadDelDatoDeOmision`), así que acá no hay redondeo ni número: se compone y se
 * muestra. Un valor vacío o de otro tipo cuenta como ausente, como el resto del
 * cuerpo, porque esto entra de un `res.json()`.
 */
function oracionDeEdad(r: ResultadoAccion): string {
  const edad = textoONulo(r.edadDelDato);
  return edad === null ? '' : ` Se decidió según un dato ${edad}.`;
}

/**
 * La `advertencia` del servidor como oración propia, o `''` cuando no viajó
 * (task 15, R6.4, R3.4).
 *
 * Llega como cláusula («la campaña está pausada: el conjunto queda activo pero
 * no entrega hasta que se active la campaña») porque del otro lado la muestra la
 * columna «Qué pasa» de la Previsualizacion, donde una oración con mayúscula
 * quedaría fuera de registro. Acá va a un aviso de una o dos oraciones, así que
 * se le pone la mayúscula y el punto: sumarla como cláusula colgada del texto
 * anterior («El cambio no se aplicó porque ya está en ese estado, la campaña
 * está pausada: …») pega dos hechos distintos en una sola frase y hace ilegible
 * justo el que se venía escondiendo.
 *
 * No se compone con `MOTIVO_TEXTO` ni se reescribe: es texto del servidor y se
 * muestra tal cual, con el mismo criterio que el `mensaje` del catálogo de
 * errores. El ` · ` con el que `sumarAdvertencia` junta dos advertencias
 * sobrevive intacto.
 */
function oracionDeAdvertencia(r: ResultadoAccion): string {
  const adv = textoONulo(r.advertencia);
  if (adv === null) return '';
  const conMayuscula = `${adv.charAt(0).toUpperCase()}${adv.slice(1)}`;
  return ` ${conMayuscula.endsWith('.') ? conMayuscula : `${conMayuscula}.`}`;
}

/**
 * El texto de un desenlace más su advertencia, cuando hay. Lo comparten los
 * cinco desenlaces: la advertencia habla del objeto, no de lo que le pasó al
 * pedido, así que ningún desenlace es motivo para esconderla.
 */
function conAdvertencia(base: string, r: ResultadoAccion): string {
  return `${base}${oracionDeAdvertencia(r)}`;
}

/**
 * Lo que hay que decir de una escritura que Meta confirmó y que igual no va a
 * hacer nada (R6.4). Nombra primero el hecho que el usuario pidió —el cambio se
 * aplicó— porque es lo que distingue este caso de un fallo, y deja la
 * advertencia como segunda oración.
 */
const TEXTO_CONFIRMADO = 'El cambio se aplicó en Meta.';

/** Regla 2: el motivo de la Omisión en castellano (R2 c4, R6 c1). */
function textoDeOmision(r: ResultadoAccion): string {
  // El catálogo primero: es el texto que el usuario ya vio en la previa. Si el
  // motivo no viaja (o llega uno que este cliente no conoce todavía), el
  // mensaje del servidor es mejor que una clave cruda.
  const delCatalogo = r.motivo !== undefined ? MOTIVO_TEXTO[r.motivo] : undefined;
  const razon = textoONulo(delCatalogo) ?? textoONulo(r.mensaje);
  // La antigüedad se agrega en los dos casos, también cuando no se sabe por qué
  // se omitió: ahí es lo ÚNICO que el aviso puede aportar sobre la decisión.
  const base = razon === null ? TEXTO_OMITIDO_SIN_MOTIVO : `El cambio no se aplicó porque ${razon}.`;
  return `${base}${oracionDeEdad(r)}`;
}

/** Regla 5: `detail` y si no `error` (R2 c5), el criterio que ya usa el lote. */
function textoDeError(cuerpo: CuerpoAcciones | null | undefined): string | null {
  if (cuerpo === null || cuerpo === undefined) return null;
  const c = cuerpo as { ok?: unknown; error?: unknown; detail?: unknown };
  if (c.ok === true) return null;
  return textoONulo(c.detail) ?? textoONulo(c.error);
}

/**
 * Traduce una respuesta del Endpoint_Acciones al aviso que va a pantalla.
 * `null` significa que salió todo bien y no hay nada que decir (regla 1).
 * Nunca tira: un cuerpo que no tiene la forma esperada cae en la regla 5 o en
 * la 6, según el status.
 *
 * El `httpStatus` es el de `res.status`. Se pide aparte del cuerpo porque el
 * cuerpo de un rechazo no lo lleva, y porque la regla 6 es el último recurso
 * cuando el cuerpo no alcanza para explicar nada.
 */
export function mensajeDeResultado(
  httpStatus: number,
  cuerpo: CuerpoAcciones | null | undefined,
): Aviso | null {
  const r = primerResultado(cuerpo);

  if (r !== null) {
    // El switch es exhaustivo sobre la unión cerrada de estados: un desenlace
    // nuevo rompe la compilación en lugar de caer sin querer en la regla 6.
    switch (r.estado) {
      case 'confirmado': {
        // Regla 1, con su única excepción: sin advertencia no hay nada que
        // decir, y con advertencia hay algo que decir que NO es un fallo. El
        // `aplicado: true` es lo que impide que el llamador lea este aviso como
        // «el cambio no quedó» y revierta una fila que Meta sí cambió.
        const adv = oracionDeAdvertencia(r);
        if (adv === '') return null;
        return { tono: 'aviso', texto: `${TEXTO_CONFIRMADO}${adv}`, aplicado: true };
      }
      case 'omitido':
        // Regla 2. La advertencia se suma en lugar de competir con el motivo:
        // el caso de producción son los conjuntos ACTIVE bajo campaña pausada,
        // que llegan omitidos por `ya_esta_en_ese_estado` Y sin entregar, y
        // quedarse con uno solo de los dos hechos deja al usuario sin la mitad
        // que explica el síntoma.
        return { tono: 'aviso', texto: conAdvertencia(textoDeOmision(r), r) };
      case 'indeterminado':
        return { tono: 'aviso', texto: conAdvertencia(TEXTO_INDETERMINADO, r) }; // regla 3 (R2 c7)
      case 'fallido':
        // `textoONulo` y no `??`: un `mensaje: ''` es un mensaje ausente, y
        // dejarlo pasar daba `{ tono: 'error', texto: '' }`, que la pantalla no
        // puede mostrar (Property 2).
        //
        // La advertencia va también acá, y no es redundante: la de
        // Objeto_Desaparecido es la explicación más probable de un rechazo de
        // Meta sobre un objeto que la base todavía tiene.
        return {
          tono: 'error',
          texto: conAdvertencia(textoONulo(r.mensaje) ?? TEXTO_FALLIDO_SIN_MENSAJE, r),
        }; // regla 4
      case 'no_intentado':
        // No es una regla nueva: es el quinto estado del mismo conjunto
        // cerrado. Sin esta rama caería en la 6 y un lote cortado mostraría el
        // código HTTP en lugar de decir que al objeto no se llegó.
        //
        // El Endpoint_Acciones no manda `advertencia` en este desenlace (empuja
        // el resultado antes de mirar la Previsualizacion del objeto), pero se
        // compone igual: si algún día la manda, esconderla sería el mismo
        // agujero por una rama nueva.
        return { tono: 'aviso', texto: conAdvertencia(TEXTO_NO_INTENTADO, r) };
    }
  }

  const error = textoDeError(cuerpo);
  if (error !== null) return { tono: 'error', texto: error }; // regla 5

  // Regla 6: el único lugar donde el status se convierte en texto, y sólo
  // cuando NO es exitoso (R2 c6, Property 3).
  if (esExitoso(httpStatus)) return { tono: 'aviso', texto: TEXTO_SIN_DESENLACE };
  return {
    tono: 'error',
    texto: `El pedido no se pudo completar y el servidor no dio detalle (código ${httpStatus}).`,
  };
}

/**
 * Los desenlaces que NO son un cambio aplicado, en el orden en el que el resumen
 * del lote los nombra: primero el que hay que mirar (algo falló en Meta), último
 * el que es consecuencia de un corte y no de este objeto. Con la conjugación de
 * cada uno, porque "1 se omitieron" es la clase de detalle que hace que un aviso
 * se lea como generado y no como escrito.
 *
 * `confirmado` no está: un resumen sólo se arma cuando ninguno se aplicó.
 */
const DESENLACES_DEL_RESUMEN: readonly (readonly [EstadoResultadoAccion, string, string])[] = [
  ['fallido', 'falló', 'fallaron'],
  ['omitido', 'se omitió', 'se omitieron'],
  ['indeterminado', 'quedó sin confirmar', 'quedaron sin confirmar'],
  ['no_intentado', 'no se intentó', 'no se intentaron'],
];

const CIERRE_DEL_RESUMEN = 'El detalle por objeto está en la lista de resultados.';

/**
 * Un cuerpo que se contradice: dice que el lote no se procesó y adentro trae un
 * objeto confirmado. El route de hoy no lo produce —los cuerpos `ok: false` no
 * llevan `resultados`— pero la regla 1 de `avisoDeLote` no puede devolver `null`
 * ahí: un lote que el servidor rechazó y del que la pantalla no dice una palabra
 * es el mismo agujero que este spec vino a cerrar, por otro lado.
 */
const TEXTO_LOTE_SIN_PROCESAR =
  'El servidor no procesó el lote y su respuesta no permite saber por qué. ' +
  'La tabla queda con lo que devuelva la próxima lectura.';

/**
 * El resumen de una Accion_Lote en la que ningún objeto cambió: cuántos y en qué
 * terminaron, contado sobre `resultados` y sin nombrar a ninguno en particular.
 *
 * Los conteos salen del arreglo y no de `aplicados`/`total` del cuerpo a
 * propósito: el resumen describe esa lista, así que contarla es lo que garantiza
 * que el texto y el desglose que la pantalla dibuja al lado no puedan discrepar.
 *
 * El tono es error sólo si algo falló de verdad en Meta. Una tanda entera de
 * omisiones es una advertencia: el cambio no se aplicó, pero nada se rompió, y
 * pintarla de rojo mandaría a buscar un problema que no existe.
 */
function resumenDeLote(rs: readonly ResultadoAccion[]): Aviso {
  const partes: string[] = [];
  for (const [estado, singular, plural] of DESENLACES_DEL_RESUMEN) {
    const n = rs.reduce((a, r) => (r.estado === estado ? a + 1 : a), 0);
    if (n > 0) partes.push(`${n} ${n === 1 ? singular : plural}`);
  }
  const cabeza = `Ninguno de los ${rs.length} objetos cambió`;
  // `partes` vacío significa que el servidor devolvió un desenlace que este
  // cliente todavía no conoce. Se dice lo que sí se sabe —que nada cambió— en
  // lugar de callar: un resumen ausente acá sería el aviso que falta.
  if (partes.length === 0) return { tono: 'aviso', texto: `${cabeza}. ${CIERRE_DEL_RESUMEN}` };
  return {
    tono: rs.some((r) => r.estado === 'fallido') ? 'error' : 'aviso',
    texto: `${cabeza}: ${partes.join(', ')}. ${CIERRE_DEL_RESUMEN}`,
  };
}

/**
 * Traduce una respuesta del Endpoint_Acciones al aviso de una Accion_Lote
 * (task 4.2). `null` significa que no hay nada que agregar arriba del desglose
 * que ya dibuja `ResultadosLote`.
 *
 * Las cuatro reglas, y la frontera que trazan con `ResultadosLote`:
 *
 *   1. El servidor no procesó el lote (`ok: false`, status fuera de 2xx, cuerpo
 *      ilegible) → `mensajeDeResultado`, letra por letra lo mismo que muestra el
 *      toggle. Es el caso de R2 c5: un 400 del esquema o del Preflight, un 401
 *      del guard. No hay desglose que mostrar porque el servidor no llegó a
 *      producir uno, así que el aviso es la única superficie.
 *   2. Un solo objeto → `mensajeDeResultado` también. Un lote de uno y un toggle
 *      son la misma operación con dos botones distintos, y los textos por objeto
 *      del módulo son exactos para ese caso.
 *   3. Varios objetos y al menos uno aplicado → `null`. El desglose de
 *      `ResultadosLote` ya abre con "X de Y aplicados" y lista los que no
 *      quedaron: repetirlo arriba con otras palabras es la forma más rápida de
 *      que dos partes de la pantalla se contradigan.
 *
 *      Lo que HOY queda afuera por esta regla: las `advertencia` de un lote de
 *      varios objetos. Un aviso de arriba no las puede mostrar sin hablar por
 *      objeto (o sin fabricar un conteo que después nadie puede desglosar), así
 *      que el lugar donde van es la lista por objeto de `ResultadosLote`, que
 *      todavía muestra sólo el motivo. La Previsualizacion del diálogo sí las
 *      muestra por fila antes de ejecutar, y el toggle de una fila entra por la
 *      regla 2, así que el camino de un objeto —el del bug reportado— queda
 *      cubierto.
 *   4. Varios objetos y ninguno aplicado → un resumen contado. Es el caso que
 *      hoy se lee como un éxito: el diálogo se cierra, la selección se limpia y
 *      arriba no dice nada, aunque el servidor no haya tocado un solo objeto.
 *
 * Ningún camino le hace decir al aviso algo sobre `resultados[0]` como si valiera
 * para los 100: cuando hay varios, o cuenta o se calla.
 */
export function avisoDeLote(
  httpStatus: number,
  cuerpo: CuerpoAcciones | null | undefined,
): Aviso | null {
  const procesado =
    esExitoso(httpStatus) && (cuerpo as { ok?: unknown } | null | undefined)?.ok === true;
  if (!procesado) {
    // Regla 1. El `??` cubre el único cuerpo con el que `mensajeDeResultado`
    // devuelve null —un primer resultado confirmado y sin advertencia— dentro de
    // un sobre que dice que el lote no se procesó: acá eso no es "nada que
    // decir", es una contradicción, y quedarse callado sería el éxito silencioso
    // de siempre.
    return (
      mensajeDeResultado(httpStatus, cuerpo) ?? { tono: 'error', texto: TEXTO_LOTE_SIN_PROCESAR }
    );
  }

  const rs = arregloDeResultados(cuerpo).filter(
    (r): r is ResultadoAccion => typeof r === 'object' && r !== null,
  );
  // Regla 2. El `<= 1` incluye el arreglo vacío, que el route no produce (todo
  // pedido lleva al menos un objectId y el bucle empuja un resultado por objeto):
  // si igual llegara, `mensajeDeResultado` lo manda a la regla 6 y dice que el
  // servidor no informó el desenlace, que es exactamente lo que pasó.
  if (rs.length <= 1) return mensajeDeResultado(httpStatus, cuerpo);

  if (rs.some((r) => r.estado === 'confirmado')) return null; // regla 3
  return resumenDeLote(rs); // regla 4
}
