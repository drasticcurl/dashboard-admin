/**
 * POST /api/ads/acciones — acciones manuales del gestor (T17 §9), refactorizada
 * por gestion-campanas-anuncios (task 18.2).
 *
 * La validación y la auditoría viven en `lib/ads/acciones.ts` (`preflight`,
 * `abrirAccion`/`cerrarAccion`); acá queda el esquema cerrado, la orquestación
 * por objeto y la respuesta unificada. La confirmación de la UI NO es un control
 * de seguridad: este handler se puede invocar directo con un curl autenticado.
 *
 * - `guard` ANTES de deserializar el cuerpo (R17 c1, c2): sin cookie, 401, cero
 *   escrituras, cero llamadas a Meta.
 * - Esquema cerrado con discriminante por acción (R17 c3): un campo no
 *   declarado, un id que no es 1..20 dígitos, un lote de más de 100, un
 *   presupuesto sin dos decimales o una acción fuera del vocabulario rechazan
 *   el pedido entero. Un estado distinto de ACTIVE/PAUSED o una operación de
 *   archivado/borrado NO son representables (R17 c13).
 * - Ejecución POR OBJETO, no atómica (R16 c1), con la fila de `ad_actions`
 *   abierta antes de la llamada y cerrada después (R15 c3). Los únicos cortes
 *   de lote son los tres del design: token vencido, cuota (con backoff por app)
 *   y cupo de objetos (R16 c1, c4, c5, R17 c17).
 * - La relectura selectiva del preflight (task 14.1 de
 *   frescura-y-acciones-anuncios) deja rastro en esa fila: `pf.relecturas` se
 *   busca una vez por objeto y `metricsDeRelectura`/`explicacionDeRelectura`
 *   (task 14.2) lo convierten en el jsonb de `metrics` y en el renglón de la
 *   `explicacion` (R6.3, R6.5). El jsonb va en `abrirAccion` y no en el cierre:
 *   es el dato con el que se decidió, y ese dato existe antes de la decisión.
 *   Para `budget_set` el mapa está vacío y las dos funciones son no-ops.
 * - `edadDelDatoDeOmision` (task 14.3) es lo mismo para el usuario: la
 *   antigüedad del dato con el que se decidió una Omisión viaja en
 *   `ResultadoObjeto.edadDelDato` y `mensajeDeResultado` la cierra en «Se decidió
 *   según un dato …» (R6.1). Va en los CUATRO `resultados.push` que declaran una
 *   Omisión —el del bucle de estado y presupuesto, el del renombre y los dos de
 *   la programación— porque las cuatro se deciden con la copia local.
 *
 * Los interruptores globales del motor NO se consultan (R17 c6). El
 * Techo_Absoluto y el Tope_Lote sí: no tienen excepciones (R17 c5, c7).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getClientIp } from '@/lib/auth';
import { guard } from '../../config/_lib';
import { q, q1 } from '@/lib/db';
import { enviar, fetchObjeto, MetaAdsError, setDailyBudget, setInicio, setNombre } from '@/lib/ads/meta';
import type { NivelAds, ResultadoEscritura } from '@/lib/ads/tipos';
import {
  ETIQUETA_NIVEL,
  abrirAccion,
  activarBackoffCuota,
  armarExplicacion,
  cerrarAccion,
  edadDelDatoDeOmision,
  explicacionDeRelectura,
  metricsDeRelectura,
  preflight,
  type ObjetoPreflight,
  type ResultadoPreflight,
} from '@/lib/ads/acciones';
import { traducirError, type Corte } from '@/lib/ads/errores';
import type { MotivoOmisionLote } from '@/lib/ads/previsualizacion';
import { duplicar, type PedidoCopia } from '@/lib/ads/copias';
// El Refresco_Diferido vive en un módulo hermano y no acá porque un `route.ts` no
// puede exportar nada fuera de los métodos HTTP y las opciones de segmento: el
// validador de `.next/types` lo rechaza y `npx tsc --noEmit` también. El motivo
// completo, con el error textual, está en `_diferir.ts`.
import { diferir } from './_diferir';
import { nombresDeCopias } from '@/lib/ads/nombres';
import { aplicarRenombre, LARGO_MAX_NOMBRE, type ModoRenombre } from '@/lib/ads/nombres';
import { sincronizarJerarquia } from '@/lib/ads/jerarquia';
import { verificarCupoObjetos } from '@/lib/ads/cupo';
import { reconciliarDuplicaciones } from '@/lib/ads/reconciliacion';
import { resolverInicio } from '@/lib/ads/programacion';
import { MONEDA_REPORTE, SIMBOLO_REPORTE } from '@/lib/moneda-reporte';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, { status });
}

/**
 * Todos los mensajes del esquema son propios y en castellano, y cada uno nombra
 * el campo y la regla que se incumplió (R1 c6, task 3.3 de
 * frescura-y-acciones-anuncios). No es cosmética: `detail` de este 400 es el
 * texto que `mensajeDeResultado` pone en pantalla tal cual, así que el default
 * de zod era lo que el usuario leía — un `Required` que no dice qué campo falta
 * ni qué regla lo rechazó, y que en el bug reportado ("editar presupuesto da
 * error required") era el único indicio de que el payload viajaba sin importe.
 *
 * Los textos siguen la convención de `detail` de este endpoint (la de los
 * rechazos del Preflight en `lib/ads/acciones.ts`): cláusula en minúscula, sin
 * punto final, sin repetir la clave del payload — la clave la pone
 * `detalleDeZod` como prefijo, así el mismo mensaje sirve para `budgetEur` y
 * para `modo.texto` sin escribirse dos veces.
 *
 * `required_error` E `invalid_type_error`: el primero cubre el campo ausente y
 * el segundo el campo con otro tipo (y el `NaN`, que zod trata como
 * invalid_type). Sin los dos, uno de los caminos vuelve al default en inglés.
 */
const idMeta = z
  .string({
    required_error: 'falta el id del objeto',
    invalid_type_error: 'cada id de objeto tiene que venir como texto',
  })
  .regex(/^\d{1,20}$/, 'cada id de objeto tiene que ser una secuencia de 1 a 20 dígitos'); // R17 c3

const dosDecimales = (n: number): boolean => Number(n.toFixed(2)) === n;

/**
 * El importe de un presupuesto diario, con las cuatro reglas nombradas. La
 * regla de fondo es la misma que `lib/ads/presupuesto.ts` aplica en el cliente
 * (R1 c5); acá se revalida porque este handler se puede invocar con un curl.
 * El Techo_Absoluto y el Tope_Lote los valida el preflight contra settings
 * (R17 c5, c7): no son cotas de forma y dependen de la cuenta.
 */
const presupuestoEur = z
  .number({
    required_error: 'falta el importe del presupuesto diario en euros',
    invalid_type_error: 'el importe del presupuesto diario tiene que ser un número en euros',
  })
  .positive('el importe del presupuesto diario tiene que ser mayor que cero')
  .finite('el importe del presupuesto diario tiene que ser un número finito')
  .refine(dosDecimales, 'el importe del presupuesto diario admite como máximo dos decimales');

/** El inicio programado (R10 c15, R11 c4). La zona no es opcional: sin offset,
 *  "09:00" no identifica ningún momento. */
const inicioIso = z
  .string({
    required_error: 'falta el inicio programado',
    invalid_type_error: 'el inicio tiene que venir como texto en formato ISO 8601',
  })
  .datetime({
    offset: true,
    message:
      'el inicio tiene que ser una fecha ISO 8601 con zona horaria, por ejemplo 2025-03-01T09:00:00+01:00',
  });

/**
 * Un texto de renombre con su nombre en el mensaje: los cuatro modos comparten
 * las mismas dos cotas (1..max) pero no el mismo campo, así que el mensaje se
 * arma con cómo se llama en pantalla (R12 c1, c3, c4).
 *
 * `recortar` va ANTES de las cotas y no después: los checks de zod corren en el
 * orden en que se agregan, y con el `min(1)` primero un nombre de tres espacios
 * pasaría la cota y llegaría vacío al renombre. Es la invariante que hace
 * irrepresentable un nombre vacío tras recortar.
 */
function textoDeRenombre(max: number, comoSeLlama: string, recortar = false): z.ZodString {
  const texto = z.string({
    required_error: `falta ${comoSeLlama}`,
    invalid_type_error: `${comoSeLlama} tiene que ser texto`,
  });
  return (recortar ? texto.trim() : texto)
    .min(1, `${comoSeLlama} es obligatorio`)
    .max(max, `${comoSeLlama} no puede pasar de ${max} caracteres`);
}

/**
 * `errorMap` y no `invalid_type_error` para los enums: un valor de otro tipo y
 * un texto fuera de la lista son dos códigos distintos (`invalid_type` e
 * `invalid_enum_value`), y `invalid_type_error` sólo cubre el primero. El
 * errorMap cubre los dos con un mensaje que enumera lo aceptado.
 */
const base = z
  .object({
    level: z.enum(['campaign', 'adset', 'ad'], {
      errorMap: () => ({ message: 'el nivel tiene que ser campaign, adset o ad' }),
    }),
    accountId: z
      .string({
        required_error: 'falta la cuenta de anuncios',
        invalid_type_error: 'falta la cuenta de anuncios',
      })
      .min(1, 'falta la cuenta de anuncios')
      .max(64, 'la cuenta de anuncios no puede pasar de 64 caracteres'),
    objectIds: z
      .array(idMeta, {
        required_error: 'falta la lista de objetos sobre los que aplicar la acción',
        invalid_type_error: 'los objetos tienen que venir como una lista de ids',
      })
      .min(1, 'hay que indicar al menos un objeto')
      .max(100, 'el lote admite como máximo 100 objetos por corrida'), // R9 c9, R17 c3
  })
  .strict();

// Las ramas nuevas (duplicate/rename/schedule) se agregan en las tasks 23.3,
// 25.1 y 26.1. El discriminante hace que una acción fuera del vocabulario, un
// estado distinto de ACTIVE/PAUSED o un archivado/borrado NO sean representables
// (R17 c3, c13).
const schema = z.discriminatedUnion('action', [
  base.extend({ action: z.literal('pause') }).strict(),
  base.extend({ action: z.literal('activate') }).strict(),
  base.extend({
    action: z.literal('budget_set'),
    // 0,01 EUR en adelante, con 2 decimales (R13 c1).
    budgetEur: presupuestoEur,
  }).strict(),
  base.extend({
    action: z.literal('duplicate'),
    // R10 c14: este panel duplica campañas y conjuntos, nunca anuncios. Que el
    // tipo lo haga imposible es más barato que un if que alguien puede borrar.
    level: z.enum(['campaign', 'adset'], {
      errorMap: () => ({ message: 'este panel duplica campañas y conjuntos, nunca anuncios' }),
    }),
    // Sin `required_error`: `copias` tiene default, así que el campo ausente
    // nunca llega a la validación (vale 1).
    copias: z
      .number({ invalid_type_error: 'la cantidad de copias tiene que ser un número entero' })
      .int('la cantidad de copias tiene que ser un número entero')
      .min(1, 'se aceptan de 1 a 5 copias por objeto')
      .max(5, 'se aceptan de 1 a 5 copias por objeto')
      .default(1), // R10 c4, c17
    objectIds: z
      .array(idMeta, {
        required_error: 'falta la lista de objetos origen a duplicar',
        invalid_type_error: 'los objetos origen tienen que venir como una lista de ids',
      })
      .min(1, 'hay que indicar al menos un objeto origen')
      .max(20, 'se aceptan hasta 20 objetos origen por corrida de duplicación'), // R17 c15
    inicio: inicioIso.optional(), // R10 c15, c18
    budgetEur: presupuestoEur.optional(), // R10 c16
  }).strict(),
  base.extend({
    action: z.literal('rename'),
    // Exactamente uno de los cuatro modos, garantizado por el tipo (R12 c2).
    // El `exacto` recorta los espacios de los extremos y exige 1..400 (R12 c1,
    // c3, c4): un nombre vacío tras recortar es irrepresentable.
    modo: z.discriminatedUnion('tipo', [
      z
        .object({
          tipo: z.literal('prefijo'),
          texto: textoDeRenombre(100, 'el texto del prefijo'),
        })
        .strict(),
      z
        .object({
          tipo: z.literal('sufijo'),
          texto: textoDeRenombre(100, 'el texto del sufijo'),
        })
        .strict(),
      z
        .object({
          tipo: z.literal('reemplazo'),
          buscar: textoDeRenombre(LARGO_MAX_NOMBRE, 'el texto a buscar'),
          // Sin cota mínima, a diferencia de `buscar`: reemplazar por nada es
          // borrar, y es un pedido legítimo.
          poner: z
            .string({
              required_error: 'falta el texto de reemplazo (puede ser vacío para borrar)',
              invalid_type_error: 'el texto de reemplazo tiene que ser texto',
            })
            .max(LARGO_MAX_NOMBRE, `el texto de reemplazo no puede pasar de ${LARGO_MAX_NOMBRE} caracteres`),
        })
        .strict(),
      z
        .object({
          tipo: z.literal('exacto'),
          nombre: textoDeRenombre(LARGO_MAX_NOMBRE, 'el nombre', true),
        })
        .strict(),
    ]),
  }).strict(),
  base.extend({
    action: z.literal('schedule'),
    // R11 c1, c9: el inicio se programa en el CONJUNTO. Un pedido a nivel ad es
    // imposible de representar: el rechazo pasa a ser un fallo de validación
    // antes de tocar la base, no un if que alguien puede borrar.
    level: z.literal('adset', {
      errorMap: () => ({
        message: 'el inicio se programa en el conjunto: no hay inicio por campaña ni por anuncio',
      }),
    }),
    inicio: inicioIso, // R11 c4
  }).strict(),
]);

/**
 * El primer issue de zod, ya con el campo adelante: `budgetEur: falta el importe
 * del presupuesto diario en euros`. La ruta la pone acá y no cada mensaje para
 * que un mensaje compartido (el de `presupuestoEur`, el de `idMeta`) siga
 * nombrando el campo exacto que falló, incluido el índice dentro de una lista
 * (`objectIds.3`) y el campo anidado de un modo de renombre (`modo.texto`).
 *
 * Devuelve un `string` a propósito: `detail` ya es un string en el contrato de
 * la respuesta y el cliente lo muestra tal cual (R1 c6).
 *
 * Cuando hay más de un issue se informa cuántos quedan. Zod los junta todos,
 * pero un aviso con seis reglas encadenadas no se lee; el conteo alcanza para
 * que nadie corrija una cota y crea que el payload ya estaba bien.
 */
function detalleDeZod(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'el pedido no tiene la forma que el endpoint espera';

  const donde = issue.path.map((p) => String(p)).join('.');
  const texto = mensajeDeIssue(issue);
  const conCampo = donde === '' ? texto : `${donde}: ${texto}`;

  const otros = error.issues.length - 1;
  if (otros <= 0) return conCampo;
  return `${conCampo} (y ${otros} ${otros === 1 ? 'regla' : 'reglas'} más sin cumplir)`;
}

/**
 * Los tres issues que zod arma solo, sin pasar por ningún mensaje del esquema:
 * un cuerpo que no es objeto (JSON roto, que este handler convierte en `null`),
 * una clave no declarada y un discriminante fuera de la lista. Los otros
 * códigos ya llegan con el texto propio del esquema.
 */
function mensajeDeIssue(issue: z.ZodIssue): string {
  if (issue.code === z.ZodIssueCode.unrecognized_keys) {
    return `el pedido trae campos que el endpoint no acepta: ${issue.keys.join(', ')}`;
  }
  if (issue.code === z.ZodIssueCode.invalid_union_discriminator) {
    const opciones = issue.options.map((o) => String(o)).join(', ');
    return `el valor no está entre los que el endpoint acepta: ${opciones}`;
  }
  if (issue.code === z.ZodIssueCode.invalid_type && issue.path.length === 0) {
    return 'el cuerpo del pedido tiene que ser un objeto JSON';
  }
  return issue.message;
}

type ResultadoObjeto = {
  objectId: string;
  objectName: string | null;
  estado: 'confirmado' | 'fallido' | 'indeterminado' | 'omitido' | 'no_intentado';
  /** Mensaje en castellano del catálogo de errores (R16 c9). */
  mensaje: string | null;
  /** El código de Meta como dato secundario (R16 c9). */
  codigoMeta: number | null;
  creados?: string[];
  motivo?: MotivoOmisionLote | 'ya_esta_entregando';
  /**
   * La antigüedad del dato con el que el Preflight decidió la Omisión, YA en
   * palabras (`edadDelDatoDeOmision`, task 14.3). Es la segunda mitad de R6.1: el
   * requisito pide que una Omisión nombre la razón **y** la antigüedad del dato
   * con el que se decidió, y sin esto el cliente recibía sólo la razón —«ya está
   * en el estado que la acción pediría»— que es indistinguible de un botón roto
   * cuando el dato tiene cinco días. Del otro lado la compone `oracionDeEdad`
   * (`lib/ads/mensajes.ts`) como «Se decidió según un dato de hace 5 d.».
   *
   * Formateada y no en segundos: el redondeo queda del lado que también escribe
   * la `explicacion` de la auditoría, así un objeto no puede quedar con «hace
   * 5 d» en el historial y «hace 120 h» en la pantalla.
   *
   * Sólo en los desenlaces `omitido`: es el único en el que el servidor decidió
   * con un dato local en lugar de con la respuesta de Meta. Un `confirmado` o un
   * `fallido` los decidió Meta ahora, y nombrarles una antigüedad haría dudar de
   * una decisión que no se tomó con ese dato.
   */
  edadDelDato?: string | null;
  /**
   * La advertencia NO bloqueante que la Previsualizacion del preflight calculó
   * para este objeto: el padre pausado (R6.4) y el Objeto_Desaparecido (R3.4).
   * Es `FilaPrevisualizacion.advertencia` tal cual —texto que armó
   * `lib/ads/previsualizacion.ts`, nunca del cliente— y del otro lado la traduce
   * a oración `mensajeDeResultado` (`lib/ads/mensajes.ts`).
   *
   * Viaja en los TRES desenlaces del bucle de estado y presupuesto, incluido el
   * `confirmado`, y ahí está el punto: la advertencia de R6.4 no habla de si la
   * escritura llegó sino de si el objeto va a entregar, y el caso reportado
   * («parece que lo habilita pero realmente no lo hace») es justamente el de una
   * escritura confirmada. Mandarla sólo en las omisiones dejaría muda la mitad
   * que explica el síntoma.
   *
   * No la lleva el `no_intentado`: ese resultado se empuja antes de buscar la
   * fila de la Previsualizacion, porque el lote ya venía cortado y del objeto no
   * se sabe nada más que eso.
   */
  advertencia?: string | null;
};

type CorteLote = {
  causa: 'token_vencido' | 'cuota' | 'cupo_objetos';
  detalle: string;
  backoffSegundos: number | null;
};

const TABLA_NIVEL: Record<NivelAds, { tabla: string; pk: string }> = {
  campaign: { tabla: 'ad_campaigns', pk: 'campaign_id' },
  adset: { tabla: 'ad_sets', pk: 'adset_id' },
  ad: { tabla: 'ads', pk: 'ad_id' },
};

const dosDec = new Intl.NumberFormat('es-AR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const eur = (n: number): string => `${SIMBOLO_REPORTE}${dosDec.format(n)}`;

export async function POST(req: NextRequest): Promise<Response> {
  // 1. Guard ANTES de deserializar (R17 c1): sin cookie, 401, nada de nada; y
  //    sin la pestaña Anuncios, 403, tampoco escribe ni llama a Meta (D5).
  const denied = await guard(req);
  if (denied) return denied;

  // 2. Esquema cerrado (R17 c3). El `detail` nombra el campo y la regla, porque
  //    es el texto que el cliente muestra tal cual (R1 c6).
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(400, {
      ok: false,
      error: 'invalid_payload',
      detail: detalleDeZod(parsed.error),
    });
  }
  const d = parsed.data;

  // 3. Preflight: revalida TODO contra la base y settings antes de cualquier
  //    escritura o llamada de escritura a Meta (R14 c10, R17 c4, c5, c7).
  const pf = await preflight({
    level: d.level,
    accountId: d.accountId,
    accion: d.action,
    objectIds: d.objectIds,
    budgetEur: d.action === 'budget_set' || d.action === 'duplicate' ? d.budgetEur : undefined,
    copias: d.action === 'duplicate' ? d.copias : undefined,
    inicio: d.action === 'duplicate' || d.action === 'schedule' ? d.inicio : undefined,
    modo: d.action === 'rename' ? d.modo : undefined,
  });
  if (!pf.ok) {
    return json(400, { ok: false, error: pf.error.motivo, detail: pf.error.detalle });
  }

  const actorHint = `ip=${getClientIp(req.headers)} ua=${(req.headers.get('user-agent') ?? '?').slice(0, 60)}`;

  // ── 3.5. Reconciliación previa: cerrar las duplicaciones sin resolver de ESTA
  // cuenta antes de operar sobre los objetos (es el momento en que importa:
  // es cuando alguien va a volver a tocarlos). Acotada a 20 filas y con
  // presupuesto de 5 segundos; un fallo no bloquea el pedido. ──────────────
  await Promise.race([
    reconciliarDuplicaciones(d.accountId, 20),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]).catch(() => undefined);

  // ── Duplicación: N objetos × K copias = N×K filas de ad_actions, una por
  // Copia, con object_id = el objeto ORIGINAL (P-G05, R15 c6, D-08). ────────
  if (d.action === 'duplicate') {
    const cupo = await verificarCupoObjetos(
      d.accountId,
      d.objectIds.length * d.copias,
    ).catch(() => null);
    return json(200, await ejecutarDuplicacion(d as DuplicarValidado, pf, actorHint, cupo));
  }

  if (d.action === 'rename') {
    return json(200, await ejecutarRenombre(d as RenombrarValidado, pf, actorHint));
  }

  if (d.action === 'schedule') {
    return ejecutarProgramacion(d as ProgramarValidado, pf, actorHint);
  }

  // 4. Ejecución por objeto, NO atómica (R16 c1). Las omisiones de la
  //    revalidación no se mandan a Meta y quedan registradas como 'omitido'.
  const resultados: ResultadoObjeto[] = [];
  let corte: CorteLote | null = null;
  let cortado = false;

  for (let i = 0; i < d.objectIds.length; i++) {
    const objeto = pf.objetos[i]!;
    /**
     * El rastro de la relectura selectiva de ESTE objeto (task 14.1), o
     * `undefined` cuando no hizo falta releerlo porque su dato estaba fresco.
     *
     * Se busca una vez acá y no en cada rama: las dos que abren fila —la Omisión
     * y la escritura— lo necesitan, y una sola búsqueda garantiza que las dos
     * anoten lo mismo sobre el mismo objeto.
     *
     * Para `budget_set` esto es SIEMPRE `undefined` (la relectura corre sólo para
     * `pause` y `activate`), así que las dos funciones de 14.2 son no-ops y no
     * hace falta un condicional por acción: `metricsDeRelectura` devuelve `null`
     * y `explicacionDeRelectura` `undefined`, y la fila queda idéntica a como
     * quedaba antes de esta task.
     */
    const relectura = pf.relecturas.get(objeto.objectId);
    const baseResultado = {
      objectId: objeto.objectId,
      objectName: objeto.objectName,
    };

    if (cortado) {
      resultados.push({ ...baseResultado, estado: 'no_intentado', mensaje: null, codigoMeta: null });
      continue;
    }

    const filaPrevia = pf.previa.filas.find((f) => f.objectId === objeto.objectId);
    /**
     * La advertencia de ESTE objeto (task 15: R6.4 padre pausado, R3.4 objeto
     * desaparecido), leída una sola vez y usada por los tres desenlaces de abajo.
     *
     * Se saca acá y no en cada `push` por el mismo motivo que `relectura`: las
     * tres ramas hablan del mismo objeto y no pueden decir tres cosas distintas
     * sobre él. El `?? null` cubre el objeto que no está en la Previsualizacion,
     * que no ocurre —`pf.objetos` y `pf.previa.filas` salen del mismo lote— pero
     * el `find` es opcional por tipo.
     */
    const advertencia = filaPrevia?.advertencia ?? null;
    if (filaPrevia?.motivo) {
      const explicacion = armarExplicacion({
        accion: d.action,
        nivel: d.level,
        objectName: objeto.objectName,
        objectId: objeto.objectId,
        accountId: d.accountId,
        extra: explicacionDeRelectura(relectura),
      });
      // Las métricas van en el ABRIR y no en el cerrar (R6.3): son el dato con el
      // que se tomó la decisión, y ese dato existe antes de la decisión. Si el
      // proceso se muere entre el INSERT y el UPDATE, la fila igual cuenta con
      // qué se decidió omitir. `cerrarAccion(id, 'omitido')` no cambia.
      const id = await abrirAccion({
        accountId: d.accountId,
        nivel: d.level,
        objectId: objeto.objectId,
        objectName: objeto.objectName,
        accion: d.action,
        before: filaPrevia.antes,
        after: filaPrevia.despues,
        explicacion,
        actorHint,
        metrics: metricsDeRelectura(relectura) ?? undefined,
      });
      await cerrarAccion(id, 'omitido');
      resultados.push({
        ...baseResultado,
        estado: 'omitido',
        mensaje: null,
        codigoMeta: null,
        motivo: filaPrevia.motivo,
        // R6.1: la razón sola no distingue un dato viejo de un botón roto, que
        // es el bug reportado. La misma `relectura` que fue a `metrics` decide
        // cuál de los tres textos sale, así que la antigüedad de la auditoría y
        // la de la pantalla no pueden discrepar.
        edadDelDato: edadDelDatoDeOmision(objeto, relectura),
        // El caso mayoritario de la cuenta real: un conjunto ACTIVE bajo una
        // campaña pausada se omite por `ya_esta_en_ese_estado` Y no entrega. Sin
        // los dos datos, el aviso explica por qué no se escribió y no por qué el
        // objeto sigue sin hacer nada.
        advertencia,
      });
      continue;
    }

    const { campos, before, after, explicacion } = preparar(
      d,
      d.level,
      objeto,
      explicacionDeRelectura(relectura),
    );

    // La fila se abre ANTES del POST y se cierra después (R15 c3). Con la
    // Discrepancia puesta acá, la fila de una escritura que se hizo PORQUE Meta
    // desmintió a la base lleva el par de estados aunque la llamada después falle
    // o quede indeterminada: el motivo de la decisión no depende del desenlace.
    const id = await abrirAccion({
      accountId: d.accountId,
      nivel: d.level,
      objectId: objeto.objectId,
      objectName: objeto.objectName,
      accion: d.action,
      before,
      after,
      explicacion,
      actorHint,
      metrics: metricsDeRelectura(relectura) ?? undefined,
    });

    let r: ResultadoEscritura;
    try {
      r = await enviar(objeto.objectId, campos);
    } catch (e) {
      r = {
        estado: 'indeterminado',
        error: new MetaAdsError(e instanceof Error ? e.message : String(e), undefined, undefined, undefined, true),
      };
    }

    if (r.estado === 'confirmado') {
      await cerrarAccion(id, 'confirmado');
      // Escritura_Confirmada_Local (task 14.1): el MISMO valor que salió en el
      // POST y que Meta acaba de confirmar, escrito sin ir a Meta.
      //
      // Va con `campos.status` y NO con `after` para que no haya una segunda
      // derivación del mismo hecho: `campos` es literalmente el cuerpo del POST.
      // `after` es su versión para la auditoría y hoy coincide, pero son dos
      // lugares y este código no tiene por qué elegir entre ellos.
      await escribirStatusConfirmado(d.level, objeto.objectId, campos.status);
      // Refresco_Diferido (task 14.2): se dispara y NO se espera. Antes había un
      // `await` acá, o sea un GET a Meta con su propio timeout de 30 s adentro
      // del tiempo que el usuario pasa mirando un interruptor que ya cambió de
      // posición, para traer un dato que la respuesta no necesita.
      diferir(refrescarJerarquia(d.level, objeto.objectId));
      // La advertencia va también acá, y es el desenlace en el que más importa:
      // R6.4 pide distinguir «no entrega» de «la acción falló», y el caso
      // reportado es una escritura que Meta CONFIRMÓ sobre un objeto que igual no
      // entregó. El aviso del cliente la presenta como segunda oración de «el
      // cambio se aplicó», no como un fallo.
      resultados.push({
        ...baseResultado,
        estado: 'confirmado',
        mensaje: null,
        codigoMeta: null,
        advertencia,
      });
      continue;
    }

    // Error: el catálogo decide clasificación y corte (R16 c4, c5, c9).
    const ctx = {
      objectId: objeto.objectId,
      objectName: objeto.objectName,
      nivel: d.level,
      accountId: d.accountId,
    };
    const traducido = traducirError(
      {
        codigo: r.error.code,
        subcodigo: r.error.subcode,
        httpStatus: r.error.httpStatus,
        transient: r.error.transient,
        mensaje: r.error.message,
      },
      ctx,
    );
    await cerrarAccion(id, traducido.clasifica, { error: r.error.message });
    resultados.push({
      ...baseResultado,
      estado: traducido.clasifica,
      mensaje: traducido.mensaje,
      codigoMeta: traducido.codigoMeta,
      // Un rechazo no vuelve falsa la advertencia: la de Objeto_Desaparecido
      // (R3.4) es la explicación más probable de que Meta rechace una escritura
      // sobre un objeto que la base todavía tiene.
      advertencia,
    });

    const corteDelError = cortePara(traducido.corta);
    if (corteDelError) {
      if (corteDelError.causa === 'cuota') {
        // R17 c17: activar el backoff por app y devolver los segundos.
        const segundos = await activarBackoffCuota();
        corte = { causa: 'cuota', detalle: traducido.mensaje, backoffSegundos: segundos };
      } else {
        corte = { causa: corteDelError.causa, detalle: traducido.mensaje, backoffSegundos: null };
      }
      cortado = true;
    }
  }

  return json(200, {
    ok: true,
    aplicados: resultados.filter((r) => r.estado === 'confirmado').length,
    total: resultados.length,
    corte,
    resultados,
  });
}

function cortePara(c: Corte): { causa: 'token_vencido' | 'cuota' | 'cupo_objetos' } | null {
  return c === null ? null : { causa: c };
}

// ── La duplicación (R10, R15 c6, R17 c15, c16, D-08) ────────────────────────

type DuplicarValidado = {
  action: 'duplicate';
  level: 'campaign' | 'adset';
  accountId: string;
  objectIds: string[];
  copias: number;
  inicio?: string;
  budgetEur?: number;
};

async function ejecutarDuplicacion(
  d: DuplicarValidado,
  pf: Extract<ResultadoPreflight, { ok: true }>,
  actorHint: string,
  cupo: Awaited<ReturnType<typeof verificarCupoObjetos>> | null,
): Promise<Record<string, unknown>> {
  const k = d.copias;

  // Nombres planificados: determinísticos y sin colisión (P12), contra los
  // hermanos que la jerarquía local conoce más los ya planificados en la corrida.
  const ocupadosPorOrigen = new Map<string, Set<string>>();
  const planeados = new Set<string>();
  for (const o of pf.objetos) {
    const hermanos =
      d.level === 'campaign'
        ? await q<{ name: string | null }>(
            `SELECT name FROM ad_campaigns WHERE account_id = $1 AND campaign_id <> $2 AND name IS NOT NULL`,
            [d.accountId, o.objectId],
          )
        : await q<{ name: string | null }>(
            `SELECT name FROM ad_sets WHERE campaign_id = $1 AND adset_id <> $2 AND name IS NOT NULL`,
            [o.campaignId, o.objectId],
          );
    const ocupados = new Set(hermanos.map((h) => h.name!));
    ocupadosPorOrigen.set(o.objectId, ocupados);
  }

  // Un pedido por Copia, con el desglose exacto del árbol (R10 c1, c2).
  const desglose = await desgloseDe(d.level, d.accountId, d.objectIds);
  const pedidos: PedidoCopia[] = [];
  const originales: ObjetoPreflight[] = [];
  const numeroDeCopia: number[] = [];
  for (const o of pf.objetos) {
    const conteo = desglose.get(o.objectId) ?? { conjuntos: 0, anuncios: 0 };
    const ocupados = new Set(Array.from(ocupadosPorOrigen.get(o.objectId) ?? []).concat(Array.from(planeados)));
    const nombres = nombresDeCopias(o.objectName ?? '', k, ocupados);
    for (let n = 0; n < k; n++) {
      const nombre = nombres[n]!;
      planeados.add(nombre);
      const sufijo = (nombre.match(/ - Copia \d+$/) ?? [''])[0]!;
      pedidos.push({
        objectId: o.objectId,
        nivel: d.level,
        campaignId: d.level === 'adset' ? o.campaignId : undefined,
        nombre,
        sufijo,
        objetosEsperados: d.level === 'campaign' ? 1 + conteo.conjuntos + conteo.anuncios : 1 + conteo.anuncios,
        inicio: d.inicio,
      });
      originales.push(o);
      numeroDeCopia.push(n + 1);
    }
  }

  // R15 c3: la fila se abre ANTES de la llamada. object_id = el ORIGINAL;
  // after_value = el nombre planificado (la llave de la reconciliación, P-G05).
  const filasAuditoria: { id: number; pedido: PedidoCopia }[] = [];
  for (const pedido of pedidos) {
    const id = await abrirAccion({
      accountId: d.accountId,
      nivel: d.level,
      objectId: pedido.objectId,
      objectName: pedido.nombre,
      accion: 'duplicate',
      before: pedido.objectId,
      after: pedido.nombre,
      explicacion: armarExplicacion({
        accion: 'duplicate',
        nivel: d.level,
        objectName: pedido.objectId,
        objectId: pedido.objectId,
        accountId: d.accountId,
        extra: `«${pedido.nombre}»`,
      }),
      actorHint,
      metrics: {
        copia: numeroDeCopia[filasAuditoria.length],
        de: k,
        nivel: d.level,
        objetos_esperados: pedido.objetosEsperados,
        presupuesto_pedido_eur: d.budgetEur ?? null,
        presupuesto_aplicado: false,
        inicio_pedido: d.inicio ?? null,
        inicio_efectivo: d.inicio ?? null,
      },
    });
    filasAuditoria.push({ id, pedido });
  }

  // La operación de copia, UNA sola vez (R10 c10: nunca se repite).
  const creados = await duplicar(d.accountId, pedidos);

  // ── Cierre por Copia y cortes ──
  const resultados: ResultadoObjeto[] = [];
  let corte: CorteLote | null = null;
  let cortado = false;
  for (let i = 0; i < pedidos.length; i++) {
    const pedido = pedidos[i]!;
    const fila = filasAuditoria[i]!;
    const baseResultado = {
      objectId: pedido.objectId,
      objectName: pedido.nombre,
    };

    if (cortado || i >= creados.length) {
      resultados.push({
        ...baseResultado,
        estado: 'no_intentado',
        mensaje: null,
        codigoMeta: null,
        creados: [],
      });
      await cerrarAccion(fila.id, 'omitido');
      continue;
    }

    const r = creados[i]!;
    if (r.estado === 'confirmado') {
      await cerrarAccion(fila.id, 'confirmado', {
        metrics: { creados: r.creados, presupuesto_aplicado: false },
      });
      resultados.push({
        ...baseResultado,
        estado: 'confirmado',
        mensaje: null,
        codigoMeta: null,
        creados: r.creados,
      });
      continue;
    }

    const traducido = traducirError(
      {
        codigo: r.error.code,
        subcodigo: r.error.subcode,
        httpStatus: r.error.httpStatus,
        transient: r.error.transient,
        mensaje: r.error.message,
      },
      { objectId: pedido.objectId, objectName: pedido.nombre, nivel: d.level, accountId: d.accountId },
    );
    await cerrarAccion(fila.id, traducido.clasifica, {
      error: r.error.message,
      metrics: { creados: r.creados, handle: r.estado === 'indeterminado' ? r.handle : null },
    });
    resultados.push({
      ...baseResultado,
      estado: traducido.clasifica,
      mensaje: traducido.mensaje,
      codigoMeta: traducido.codigoMeta,
      creados: r.creados,
    });

    const c = cortePara(traducido.corta);
    if (c) {
      if (c.causa === 'cuota') {
        const segundos = await activarBackoffCuota();
        corte = { causa: 'cuota', detalle: traducido.mensaje, backoffSegundos: segundos };
      } else {
        corte = { causa: c.causa, detalle: traducido.mensaje, backoffSegundos: null };
      }
      cortado = true; // R16 c5: los no intentados vuelven como no_intentado
    }
  }

  // ── Sync de la jerarquía dentro de 5 s de la confirmación (R10 c9) ──
  const confirmadas = resultados.filter((r) => r.estado === 'confirmado');
  let jerarquiaSincronizada = false;
  if (confirmadas.length > 0) {
    const sync = Promise.race([
      // R10 c10: si el sync falla o no termina en 60 s, la duplicación queda
      // confirmada igual y NO se repite la operación de copia.
      sincronizarJerarquia({ cuentas: [d.accountId] })
        .then(() => true)
        .catch(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 60_000)),
    ]);
    jerarquiaSincronizada = await sync;
  }

  // ── Presupuesto sobre el objeto de la Copia que lo lleva (R10 c16, R18 c3, c7) ──
  if (d.budgetEur !== undefined && jerarquiaSincronizada) {
    const filaPorNombre = new Map(filasAuditoria.map((f) => [f.pedido.nombre, f.id]));
    for (const r of confirmadas) {
      const original = pf.objetos.find((o) => o.objectId === r.objectId);
      if (!original) continue;
      const aplicado = await aplicarPresupuesto(d.accountId, r, original.budgetLevel, d.budgetEur);
      if (aplicado.ok) {
        const filaId = filaPorNombre.get(r.objectName ?? '');
        if (filaId !== undefined) {
          await q(
            `UPDATE ad_actions SET metrics = metrics || '{"presupuesto_aplicado": true}'::jsonb
              WHERE id = $1`,
            [filaId],
          );
        }
      }
    }
  }

  return {
    ok: true,
    aplicados: confirmadas.length,
    total: pedidos.length,
    corte,
    resultados,
    jerarquiaSincronizada,
    cupo,
  };
}

/** Aplica el presupuesto a la Copia sobre el objeto que lo lleva: la campaña si
 *  el original era CBO, cada conjunto si era ABO (R18 c3, c7). Nunca tira: un
 *  fallo deja la Copia pausada con el presupuesto heredado (R10 c19). */
async function aplicarPresupuesto(
  accountId: string,
  copia: { objectId: string; objectName?: string | null; creados?: string[] },
  budgetLevelOrigen: 'campaign' | 'adset' | null,
  budgetEur: number,
): Promise<{ ok: boolean; motivo: string | null }> {
  try {
    const nombre = copia.objectName;
    if (!nombre) return { ok: false, motivo: 'sin nombre planificado para encontrar la Copia' };
    const camp = await q1<{ id: string }>(
      `SELECT campaign_id AS id FROM ad_campaigns WHERE account_id = $1 AND name = $2
        ORDER BY synced_at DESC LIMIT 1`,
      [accountId, nombre],
    );
    if (!camp) return { ok: false, motivo: 'la jerarquía local todavía no incluye la Copia' };

    const unidades = Math.round(budgetEur * 100);
    if (budgetLevelOrigen === 'adset') {
      const conjuntos = await q<{ id: string }>(
        `SELECT adset_id AS id FROM ad_sets WHERE campaign_id = $1 AND daily_budget IS NOT NULL`,
        [camp.id],
      );
      for (const s of conjuntos) {
        await setDailyBudget(s.id, unidades);
      }
      return { ok: true, motivo: null };
    }
    await setDailyBudget(camp.id, unidades);
    return { ok: true, motivo: null };
  } catch (e) {
    return { ok: false, motivo: e instanceof Error ? e.message : String(e) };
  }
}

/** El desglose de descendientes por objeto origen (misma cuenta que usa el
 *  preflight): una lectura de la jerarquía local, no de Meta (R14 c5). */
async function desgloseDe(
  level: NivelAds,
  accountId: string,
  objectIds: string[],
): Promise<Map<string, { conjuntos: number; anuncios: number }>> {
  const out = new Map<string, { conjuntos: number; anuncios: number }>();
  if (level === 'campaign') {
    const sets = await q<{ campaign_id: string; n: number }>(
      `SELECT campaign_id, count(*)::int AS n FROM ad_sets WHERE account_id = $1 AND campaign_id = ANY($2::text[]) GROUP BY campaign_id`,
      [accountId, objectIds],
    );
    const ads = await q<{ campaign_id: string; n: number }>(
      `SELECT campaign_id, count(*)::int AS n FROM ads WHERE account_id = $1 AND campaign_id = ANY($2::text[]) GROUP BY campaign_id`,
      [accountId, objectIds],
    );
    const adsPorCamp = new Map(ads.map((r) => [r.campaign_id, r.n]));
    for (const s of sets) out.set(s.campaign_id, { conjuntos: s.n, anuncios: adsPorCamp.get(s.campaign_id) ?? 0 });
    for (const id of objectIds) if (!out.has(id)) out.set(id, { conjuntos: 0, anuncios: 0 });
  } else if (level === 'adset') {
    const ads = await q<{ adset_id: string; n: number }>(
      `SELECT adset_id, count(*)::int AS n FROM ads WHERE account_id = $1 AND adset_id = ANY($2::text[]) GROUP BY adset_id`,
      [accountId, objectIds],
    );
    const porSet = new Map(ads.map((r) => [r.adset_id, r.n]));
    for (const id of objectIds) out.set(id, { conjuntos: 0, anuncios: porSet.get(id) ?? 0 });
  }
  return out;
}

/**
 * Campos, before/after y explicación de una acción, por objeto.
 *
 * `extra` es el renglón de la relectura selectiva (task 14.2) y lo llevan sólo
 * `pause` y `activate`, que son las dos acciones que releen. La rama
 * `budget_set` NO lo usa: su `extra` ya carga la transición de importes
 * («€5,00 → €8,00»), y para esa acción `relectura` es siempre `undefined`, así
 * que sumarlo no agregaría nada y sí podría desplazar el importe fuera de los
 * 300 caracteres en los que `armarExplicacion` corta.
 */
function preparar(
  d: { action: 'pause' | 'activate' | 'budget_set'; budgetEur?: number },
  nivel: NivelAds,
  o: ObjetoPreflight,
  extra?: string,
): { campos: Record<string, string>; before: string | null; after: string | null; explicacion: string } {
  if (d.action === 'pause') {
    return {
      campos: { status: 'PAUSED' },
      before: o.status,
      after: 'PAUSED',
      explicacion: armarExplicacion({
        accion: 'pause',
        nivel,
        objectName: o.objectName,
        objectId: o.objectId,
        accountId: o.accountId,
        extra,
      }),
    };
  }
  if (d.action === 'activate') {
    return {
      campos: { status: 'ACTIVE' },
      before: o.status,
      after: 'ACTIVE',
      explicacion: armarExplicacion({
        accion: 'activate',
        nivel,
        objectName: o.objectName,
        objectId: o.objectId,
        accountId: o.accountId,
        extra,
      }),
    };
  }
  const presupuesto = d.budgetEur!;
  return {
    campos: { daily_budget: String(Math.round(presupuesto * 100)) },
    before: o.dailyBudget !== null ? eur(o.dailyBudget / 100) : null,
    after: eur(presupuesto),
    explicacion: armarExplicacion({
      accion: 'budget_set',
      nivel,
      objectName: o.objectName,
      objectId: o.objectId,
      accountId: o.accountId,
      extra: `${o.dailyBudget !== null ? eur(o.dailyBudget / 100) : '—'} → ${eur(presupuesto)}`,
    }),
  };
}

/**
 * Escribe en la fila local el `status` que Meta acaba de confirmar: UNA columna,
 * cero llamadas a Meta (task 14.1 de `toggle-conjuntos-entrega`, R2.14, R1.19).
 *
 * Existe porque `refrescarJerarquia` dejó de estar en el camino crítico y era el
 * ÚNICO escritor del `status` confirmado. Sin esto, diferir la relectura mete la
 * regresión de 1.19: el refetch inmediato del cliente devuelve la posición vieja
 * y el interruptor vuelve para atrás por un instante, que es el síntoma que este
 * spec vino a arreglar. No es una suposición sobre Meta: `enviar` devolvió
 * `confirmado`, o sea que Meta aceptó `status = campos.status`.
 *
 * ## QUÉ NO ESCRIBE, Y EL MOTIVO DE CADA UNO (decisión C2 del diseño)
 *
 * `refrescarJerarquia` escribe cinco cosas en su UPDATE. Ésta escribe una.
 *
 * - **`effective_status`: no. No lo sabemos.** Pausar un conjunto cambia también
 *   el efectivo de sus anuncios, y activar uno bajo una campaña pausada lo deja
 *   en `CAMPAIGN_PAUSED`. Derivarlo exigiría reimplementar la resolución de Meta,
 *   que este repo ya documentó dos veces como sutil (el estado propio gana sobre
 *   el del padre). Queda con el valor anterior hasta que el Refresco_Diferido o
 *   el cron lo actualicen.
 * - **Presupuestos: no.** La acción de estado no los toca.
 * - **`synced_at`: no.** Ponerlo en `now()` afirmaría que la fila ENTERA está
 *   fresca —incluidos el `effective_status` que no actualizamos y los
 *   presupuestos— cuando lo único confirmado es un campo. Es la misma frescura
 *   falsa que la tanda A arregla del otro lado.
 * - **`desaparecido_at`: no.** La sigue limpiando SÓLO la relectura, por la regla
 *   evidenciaria que `refrescarJerarquia` documenta abajo: una escritura
 *   confirmada MÁS una relectura que trajo la fila es evidencia directa de que el
 *   objeto existe. La escritura sola es la mitad de esa evidencia.
 *
 * ## LAS DOS CONSECUENCIAS VISIBLES, DECLARADAS
 *
 * 1. Después de pausar uno de los conjuntos `ACTIVE`/`CAMPAIGN_PAUSED`, la fila
 *    queda `status = PAUSED` con `effective_status = CAMPAIGN_PAUSED` hasta que
 *    el Refresco_Diferido vuelva (segundos). En esa ventana el badge dice
 *    «campaña pausada» sobre una fila cuyo propio estado es `PAUSED`: es un dato
 *    atrasado, no una afirmación falsa sobre la entrega —no entrega de las dos
 *    formas—.
 * 2. La fila puede seguir viéndose «vieja» en la Marca_Frescura inmediatamente
 *    después de una acción, porque `synced_at` no se adelanta. Es honesto: nadie
 *    confirmó la fila entera contra Meta.
 *
 * ## LAS DOS SALIDAS DESCARTADAS, PARA QUE NO SE REDISCUTAN
 *
 * - *Devolver el estado nuevo en la respuesta.* El cliente YA tiene ese valor: es
 *   el que pintó optimistamente. Sería un segundo lugar clasificando el mismo
 *   hecho, que es la forma del bug original.
 * - *Aceptar el refetch viejo con una guarda del estilo de
 *   `conservarPintadoEnVuelo`.* Esa guarda sólo actúa mientras el id está en
 *   `enVuelo`, y el `refrescar()` del cliente dispara el GET DESPUÉS de que el
 *   `finally` lo sacó del set. Mantenerlo adentro hasta que la lectura vuelva
 *   alargaría el tiempo en que la fila descarta clicks: convertiría un dato viejo
 *   en un control temporalmente muerto.
 *
 * El `status` llega como `string | undefined` porque este bucle también corre
 * `budget_set`, cuyos `campos` no traen `status`. Sin cambio de estado no hay
 * nada confirmado que escribir y la función no hace nada: el `if` está acá y no
 * en el llamador para que la regla «sólo se escribe lo que Meta confirmó» viva en
 * un solo lugar.
 */
async function escribirStatusConfirmado(
  level: NivelAds,
  objectId: string,
  status: string | undefined,
): Promise<void> {
  if (status === undefined) return;
  // Sin la rama por nivel que sí tiene `refrescarJerarquia` acá abajo: ésa existe
  // porque `ads` no tiene las columnas de presupuesto, y esta escritura no las
  // toca. `status` está en las tres tablas.
  const t = TABLA_NIVEL[level];
  await q(`UPDATE ${t.tabla} SET status = $2 WHERE ${t.pk} = $1`, [objectId, status]);
}

/**
 * Relee el objeto en Meta y refresca la fila de la jerarquía (T17 §9.9).
 *
 * Limpia además `desaparecido_at` (T16, R3.6, R4.7). La marca significa "Meta
 * dejó de devolver este objeto", y una escritura confirmada seguida de una
 * relectura que trajo la fila es evidencia directa de lo contrario: existe. No
 * es un caso especial frente a la regla de `escribirCuenta` (T6.1) —la marca se
 * pone cuando una corrida no vio el objeto y se saca cuando lo vio— es la misma
 * regla aplicada a la lectura de un objeto en lugar de a la de una cuenta.
 * Sin esto, un objeto que Meta dejó de listar en el sync pero que sigue
 * aceptando escrituras quedaría advertido como desaparecido hasta que el cron
 * volviera a listarlo, que es exactamente el atraso que R4.7 pide evitar.
 *
 * El `return` temprano cuando `fetchObjeto` no trae nada NO limpia la marca, y
 * es deliberado: "Meta no nos dio el objeto" es la misma evidencia con la que el
 * sync la PONE, así que borrarla ahí contradiría la marca en lugar de
 * corregirla. Los dos caminos de esta función que no ven la fila —el `null` y la
 * excepción que cae en el catch— dejan la marca y el `synced_at` viejo intactos,
 * que es lo que hace que la fila se siga viendo vieja en la tabla.
 *
 * La limpieza va en el mismo UPDATE que el resto de las columnas y sin guarda
 * por el valor previo, a diferencia del sync: acá la fila se reescribe igual y
 * es una sola, así que no hay tuplas muertas que ahorrar.
 *
 * Desde la task 14.2 de `toggle-conjuntos-entrega` esta función **corre diferida**
 * (`diferir(...)`, sin `await`) y su cuerpo no cambió ni una línea. Lo único que
 * cambió es CUÁNDO: ya no está en el camino crítico de la respuesta. Dos cosas que
 * eso mueve y quedan escritas acá porque es donde se leen:
 *
 * - El `status` confirmado ya NO depende de esta función:
 *   `escribirStatusConfirmado` lo escribe antes de que la respuesta salga. Ésta
 *   sigue siendo la única que escribe `effective_status`, los presupuestos,
 *   `synced_at` y `desaparecido_at`.
 * - R4.7 pedía limpiar `desaparecido_at` «sin el atraso del cron» y se sigue
 *   cumpliendo, con el atraso del diferido en lugar de cero: **segundos, no 15
 *   minutos**. Es un debilitamiento acotado y declarado, y preserva la regla en
 *   lugar de aflojarla.
 */
async function refrescarJerarquia(level: NivelAds, objectId: string): Promise<void> {
  try {
    const o = await fetchObjeto(objectId, level);
    if (!o) return;
    const t = TABLA_NIVEL[level];
    if (level === 'ad') {
      await q(
        `UPDATE ads SET status = $2, effective_status = $3, synced_at = now(), desaparecido_at = NULL WHERE ad_id = $1`,
        [objectId, o.status, o.effectiveStatus],
      );
    } else {
      await q(
        `UPDATE ${t.tabla} SET status = $2, effective_status = $3, daily_budget = $4, lifetime_budget = $5, synced_at = now(), desaparecido_at = NULL WHERE ${t.pk} = $1`,
        [objectId, o.status, o.effectiveStatus, o.dailyBudget, o.lifetimeBudget],
      );
    }
  } catch {
    // Best-effort: la jerarquía se refresca en el próximo sync. La acción ya
    // quedó confirmada en Meta y en ad_actions.
  }
}

// ── El renombrado (R12) ─────────────────────────────────────────────────────

type RenombrarValidado = {
  action: 'rename';
  level: 'campaign' | 'adset' | 'ad';
  accountId: string;
  objectIds: string[];
  modo: ModoRenombre;
};

async function ejecutarRenombre(
  d: RenombrarValidado,
  pf: Extract<ResultadoPreflight, { ok: true }>,
  actorHint: string,
): Promise<Record<string, unknown>> {
  const resultados: ResultadoObjeto[] = [];
  let corte: CorteLote | null = null;
  let cortado = false;

  for (const objeto of pf.objetos) {
    const baseResultado = { objectId: objeto.objectId, objectName: objeto.objectName };

    if (cortado) {
      resultados.push({ ...baseResultado, estado: 'no_intentado', mensaje: null, codigoMeta: null });
      continue;
    }

    const filaPrevia = pf.previa.filas.find((f) => f.objectId === objeto.objectId);
    if (filaPrevia?.motivo) {
      resultados.push({
        ...baseResultado,
        estado: 'omitido',
        mensaje: null,
        codigoMeta: null,
        motivo: filaPrevia.motivo,
        // R6.1 está redactado sobre la Omisión de estado, pero la afirmación que
        // el usuario lee es la misma acá: el nombre con el que se comparó salió
        // de la copia local. `pf.relecturas` está vacío para el renombre (la
        // relectura selectiva corre sólo para `pause` y `activate`), así que esto
        // cae siempre en el camino del `synced_at` de la fila, que es exactamente
        // el dato que decidió. Callarlo haría que el mismo motivo
        // (`valor_igual_al_anterior`) se leyera distinto según qué acción lo
        // produjo.
        edadDelDato: edadDelDatoDeOmision(objeto, pf.relecturas.get(objeto.objectId)),
      });
      continue;
    }

    const actual = objeto.objectName ?? '';
    const solicitado = aplicarRenombre(actual, d.modo).trim();

    // R12 c3, c4: sin llamar a Meta. En un lote, el objeto queda fallido y el
    // resto continúa (R12 c10).
    if (solicitado === '') {
      const explicacion = armarExplicacion({
        accion: 'rename',
        nivel: d.level,
        objectName: objeto.objectName,
        objectId: objeto.objectId,
        accountId: d.accountId,
      });
      const id = await abrirAccion({
        accountId: d.accountId,
        nivel: d.level,
        objectId: objeto.objectId,
        objectName: objeto.objectName,
        accion: 'rename',
        before: actual,
        after: solicitado,
        explicacion,
        actorHint,
      });
      await cerrarAccion(id, 'fallido', { error: 'el nombre es obligatorio' });
      resultados.push({
        ...baseResultado,
        estado: 'fallido',
        mensaje: 'El nombre es obligatorio: no se aplicó ningún cambio.',
        codigoMeta: null,
      });
      continue;
    }
    if (solicitado.length > LARGO_MAX_NOMBRE) {
      const id = await abrirAccion({
        accountId: d.accountId,
        nivel: d.level,
        objectId: objeto.objectId,
        objectName: objeto.objectName,
        accion: 'rename',
        before: actual,
        after: solicitado.slice(0, 400),
        explicacion: armarExplicacion({
          accion: 'rename',
          nivel: d.level,
          objectName: objeto.objectName,
          objectId: objeto.objectId,
          accountId: d.accountId,
        }),
        actorHint,
      });
      await cerrarAccion(id, 'fallido', { error: `el nombre supera los ${LARGO_MAX_NOMBRE} caracteres` });
      resultados.push({
        ...baseResultado,
        estado: 'fallido',
        mensaje: `El nombre supera los ${LARGO_MAX_NOMBRE} caracteres que admite la Marketing API.`,
        codigoMeta: null,
      });
      continue;
    }

    const explicacion = armarExplicacion({
      accion: 'rename',
      nivel: d.level,
      objectName: objeto.objectName,
      objectId: objeto.objectId,
      accountId: d.accountId,
      extra: `«${solicitado}»`,
    });
    const id = await abrirAccion({
      accountId: d.accountId,
      nivel: d.level,
      objectId: objeto.objectId,
      objectName: objeto.objectName,
      accion: 'rename',
      before: actual,
      after: solicitado,
      explicacion,
      actorHint,
    });

    let r: ResultadoEscritura;
    try {
      r = await setNombre(objeto.objectId, solicitado);
    } catch (e) {
      r = {
        estado: 'indeterminado',
        error: new MetaAdsError(e instanceof Error ? e.message : String(e), undefined, undefined, undefined, true),
      };
    }

    if (r.estado === 'confirmado') {
      // R12 c5: releer el nombre en Meta dentro de 10 s y reflejarlo en la fila
      // local dentro de los 5 s siguientes.
      const releido = await Promise.race([
        fetchObjeto(objeto.objectId, d.level).then((o) => o?.name ?? null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
      ]);
      if (releido !== null) {
        // `desaparecido_at = NULL` por la misma regla que `refrescarJerarquia`
        // (T16, R3.6, R4.7): esta rama es una escritura que Meta confirmó MÁS una
        // relectura que trajo el objeto, que es la evidencia directa de que
        // existe. No hay una razón por la que un `pause` confirmado desmienta la
        // marca y un `rename` confirmado no.
        //
        // Va en esta rama y no arriba del `if` porque el otro camino no distingue
        // «Meta no devolvió el objeto» de «lo devolvió sin nombre», y el primero
        // es exactamente la evidencia con la que el sync PONE la marca. Ahí la
        // función ya declara la escritura no verificada
        // (`pendiente_verificacion`) y deja la fila local intacta: dejar también
        // la marca es lo coherente. Se pierde el caso del objeto devuelto sin
        // nombre, que conserva la marca hasta el próximo sync — el mismo
        // comportamiento de antes de esta task, y el error hacia el lado seguro.
        const t = TABLA_NIVEL[d.level];
        await q(
          `UPDATE ${t.tabla} SET name = $2, synced_at = now(), desaparecido_at = NULL WHERE ${t.pk} = $1`,
          [objeto.objectId, releido],
        );
        await cerrarAccion(id, 'confirmado');
        resultados.push({ ...baseResultado, estado: 'confirmado', mensaje: null, codigoMeta: null });
      } else {
        // R12 c11: la fila local conserva el nombre anterior, queda marcada
        // pendiente de verificación y se avisa.
        await cerrarAccion(id, 'confirmado', {
          metrics: { pendiente_verificacion: true },
        });
        resultados.push({
          ...baseResultado,
          estado: 'confirmado',
          mensaje: 'El renombrado no pudo verificarse: la fila local conserva el nombre anterior hasta la próxima sincronización.',
          codigoMeta: null,
        });
      }
      continue;
    }

    const traducido = traducirError(
      {
        codigo: r.error.code,
        subcodigo: r.error.subcode,
        httpStatus: r.error.httpStatus,
        transient: r.error.transient,
        mensaje: r.error.message,
      },
      { objectId: objeto.objectId, objectName: objeto.objectName, nivel: d.level, accountId: d.accountId },
    );
    await cerrarAccion(id, traducido.clasifica, { error: r.error.message });
    resultados.push({
      ...baseResultado,
      estado: traducido.clasifica,
      mensaje: traducido.mensaje,
      codigoMeta: traducido.codigoMeta,
    });

    const c = cortePara(traducido.corta);
    if (c) {
      if (c.causa === 'cuota') {
        const segundos = await activarBackoffCuota();
        corte = { causa: 'cuota', detalle: traducido.mensaje, backoffSegundos: segundos };
      } else {
        corte = { causa: c.causa, detalle: traducido.mensaje, backoffSegundos: null };
      }
      cortado = true;
    }
  }

  return {
    ok: true,
    aplicados: resultados.filter((r) => r.estado === 'confirmado').length,
    total: resultados.length,
    corte,
    resultados,
  };
}

// ─── La programación del inicio (R11) ───────────────────────────────────────

type ProgramarValidado = {
  action: 'schedule';
  level: 'adset';
  accountId: string;
  objectIds: string[];
  inicio: string;
};

async function ejecutarProgramacion(
  d: ProgramarValidado,
  pf: Extract<ResultadoPreflight, { ok: true }>,
  actorHint: string,
): Promise<Response> {
  const resultados: ResultadoObjeto[] = [];
  let corte: CorteLote | null = null;
  let cortado = false;

  // R11 c4: el inicio se resuelve a un ÚNICO instante con desplazamiento
  // explícito y segundos en 00, en la Zona_Cuenta. El cliente mandó un instante;
  // la pared en la zona de la cuenta es la fecha y hora que el usuario eligió.
  const pared = await q1<{ fecha: string; hora: string }>(
    `SELECT to_char($1::timestamptz AT TIME ZONE $2, 'YYYY-MM-DD') AS fecha,
            to_char($1::timestamptz AT TIME ZONE $2, 'HH24:MI') AS hora`,
    [d.inicio, pf.zona],
  );
  if (!pared) {
    return json(400, { ok: false, error: 'fecha_invalida', detail: 'no se pudo resolver el inicio en la zona de la cuenta' });
  }
  const resuelto = await resolverInicio(pared.fecha, pared.hora, pf.zona);

  for (const objeto of pf.objetos) {
    const baseResultado = { objectId: objeto.objectId, objectName: objeto.objectName };

    if (cortado) {
      resultados.push({ ...baseResultado, estado: 'no_intentado', mensaje: null, codigoMeta: null });
      continue;
    }

    const filaPrevia = pf.previa.filas.find((f) => f.objectId === objeto.objectId);
    if (filaPrevia?.motivo) {
      resultados.push({
        ...baseResultado,
        estado: 'omitido',
        mensaje: null,
        codigoMeta: null,
        motivo: filaPrevia.motivo,
        // Igual que en el renombre: `pf.relecturas` está vacío para `schedule`,
        // así que la antigüedad es la del `synced_at` de la fila con la que se
        // comparó (R6.1).
        edadDelDato: edadDelDatoDeOmision(objeto, pf.relecturas.get(objeto.objectId)),
      });
      continue;
    }

    // R11 c6: un objeto que YA está entregando (inicio programado alcanzado)
    // se omite sin enviarle ningún cambio, y el lote sigue.
    const inicioLocal = objeto.inicioProgramado;
    if (inicioLocal !== null && new Date(inicioLocal).getTime() <= Date.now()) {
      const id = await abrirAccion({
        accountId: d.accountId,
        nivel: d.level,
        objectId: objeto.objectId,
        objectName: objeto.objectName,
        accion: 'schedule',
        before: inicioLocal,
        after: resuelto.instante,
        explicacion: armarExplicacion({
          accion: 'schedule',
          nivel: d.level,
          objectName: objeto.objectName,
          objectId: objeto.objectId,
          accountId: d.accountId,
        }),
        actorHint,
      });
      await cerrarAccion(id, 'omitido');
      resultados.push({
        ...baseResultado,
        estado: 'omitido',
        mensaje: 'El objeto ya está entregando: el inicio de un conjunto que arrancó no se puede cambiar.',
        codigoMeta: null,
        motivo: 'ya_esta_entregando',
        // El caso más nítido de R6.1 fuera del estado: esta omisión se decide
        // comparando `objeto.inicioProgramado` —una columna de la copia local que
        // nada en este endpoint relee— contra el reloj. Si la fila está vieja, el
        // conjunto puede no haber arrancado nunca y el panel igual se niega a
        // programarlo; la antigüedad es lo único que deja verlo.
        edadDelDato: edadDelDatoDeOmision(objeto, pf.relecturas.get(objeto.objectId)),
      });
      continue;
    }

    const explicacion = armarExplicacion({
      accion: 'schedule',
      nivel: d.level,
      objectName: objeto.objectName,
      objectId: objeto.objectId,
      accountId: d.accountId,
      extra: `${pared.fecha} ${pared.hora} (${pf.zona})`,
    });
    const id = await abrirAccion({
      accountId: d.accountId,
      nivel: d.level,
      objectId: objeto.objectId,
      objectName: objeto.objectName,
      accion: 'schedule',
      before: inicioLocal,
      after: resuelto.instante,
      explicacion,
      actorHint,
      metrics: { inicio_pedido: d.inicio, inicio_efectivo: resuelto.instante },
    });

    let r: ResultadoEscritura;
    try {
      r = await setInicio(objeto.objectId, resuelto.instante);
    } catch (e) {
      r = {
        estado: 'indeterminado',
        error: new MetaAdsError(e instanceof Error ? e.message : String(e), undefined, undefined, undefined, true),
      };
    }

    if (r.estado === 'confirmado') {
      // R11 c7: releer dentro de 10 s y actualizar la fila local con el inicio
      // y el estado que devuelve Meta.
      const releido = await Promise.race([
        fetchObjeto(objeto.objectId, d.level),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
      ]);
      if (releido) {
        // `desaparecido_at = NULL`: misma regla que `refrescarJerarquia` (T16,
        // R3.6, R4.7). Escritura confirmada por Meta + relectura que trajo la
        // fila = el objeto existe. El `if` ya separa las dos ramas que la regla
        // exige separar: cuando la relectura no vuelve (o se agota el
        // presupuesto de 10 s) no se toca nada, porque «Meta no nos dio el
        // objeto» es la evidencia con la que el sync PONE la marca.
        await q(
          `UPDATE ad_sets SET start_time = $2::timestamptz, status = $3, effective_status = $4, synced_at = now(),
                  desaparecido_at = NULL
            WHERE adset_id = $1`,
          [objeto.objectId, resuelto.instante, releido.status, releido.effectiveStatus],
        );
      }
      await cerrarAccion(id, 'confirmado', { metrics: { inicio_efectivo: resuelto.instante } });
      resultados.push({
        ...baseResultado,
        estado: 'confirmado',
        mensaje: resuelto.ajustadoPorDst
          ? `El inicio se ajustó por un cambio de horario: el instante efectivo enviado es ${resuelto.efectivo} (${pf.zona}).`
          : null,
        codigoMeta: null,
      });
      continue;
    }

    const traducido = traducirError(
      {
        codigo: r.error.code,
        subcodigo: r.error.subcode,
        httpStatus: r.error.httpStatus,
        transient: r.error.transient,
        mensaje: r.error.message,
      },
      { objectId: objeto.objectId, objectName: objeto.objectName, nivel: d.level, accountId: d.accountId },
    );
    await cerrarAccion(id, traducido.clasifica, { error: r.error.message });
    resultados.push({
      ...baseResultado,
      estado: traducido.clasifica,
      mensaje: traducido.mensaje,
      codigoMeta: traducido.codigoMeta,
    });

    const c = cortePara(traducido.corta);
    if (c) {
      if (c.causa === 'cuota') {
        const segundos = await activarBackoffCuota();
        corte = { causa: 'cuota', detalle: traducido.mensaje, backoffSegundos: segundos };
      } else {
        corte = { causa: c.causa, detalle: traducido.mensaje, backoffSegundos: null };
      }
      cortado = true;
    }
  }

  return json(200, {
    ok: true,
    aplicados: resultados.filter((r) => r.estado === 'confirmado').length,
    total: resultados.length,
    corte,
    resultados,
  });
}
