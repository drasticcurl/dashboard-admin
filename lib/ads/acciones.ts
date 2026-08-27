/**
 * Preflight y auditoría del Endpoint_Acciones (task 18.1 de
 * gestion-campanas-anuncios). La confirmación de la interfaz NO es un control
 * de seguridad: todo lo que la Previsualizacion mostró se revalida acá, del
 * lado del servidor, con los datos reales de la base (R14 c10).
 *
 * - `preflight`: rechaza el lote completo SIN una sola escritura ni una sola
 *   llamada de escritura a Meta cuando algo no pasa (R17 c4, c5, c7, c11, c12,
 *   R13 c2..c7, c11, R10 c17, c18, R11 c5). Revalida con
 *   `calcularPrevisualizacion` — el MISMO módulo que usó el cliente — así
 *   revalidar no puede contradecir lo que el usuario confirmó (R14 c10).
 * - `relecturaSelectiva` (task 14.1 de frescura-y-acciones-anuncios): antes de
 *   esa revalidación, y SÓLO para `pause` y `activate`, los objetos cuyo dato
 *   local está viejo o marcado como desaparecido se releen contra Meta con
 *   `fetchObjeto` (una LECTURA, nunca una escritura), y el estado real reemplaza
 *   al de la base para decidir la Omisión (R6.2, R6.3). Sin esto el panel puede
 *   contestar "ya está en ese estado" sobre un objeto que Meta dice que no: en
 *   producción hay objetos con hasta 5 días y 17 horas de atraso, y eso es lo
 *   que hacía ver el interruptor como roto.
 * - `metricsDeRelectura`/`explicacionDeRelectura` (task 14.2): esa relectura deja
 *   rastro en la fila de auditoría. La Discrepancia va a `ad_actions.metrics`
 *   como `{ discrepancia: { local, real, syncedAt } }` (jsonb, sin cambio de
 *   schema) y se nombra en la `explicacion` (R6.3); las salidas en las que la
 *   relectura NO se pudo hacer quedan anotadas también, porque R6.5 pide poder
 *   distinguir lo que no llegó a Meta de lo que llegó y fue rechazado.
 * - `edadDelDatoDeOmision` (task 14.3): lo mismo pero para el usuario. Devuelve
 *   la antigüedad del dato con el que se decidió la Omisión, ya en palabras, para
 *   que el route la ponga en `ResultadoObjeto.edadDelDato` y el aviso pueda decir
 *   "ya está en ese estado, según un dato de hace 5 d" (R6.1). Sin ese segundo
 *   dato el mensaje es idéntico para una Omisión correcta y para una tomada sobre
 *   una fila que Meta dejó de confirmar hace una semana.
 * - `abrirAccion`/`cerrarAccion`: la fila de `ad_actions` se abre en `pendiente`
 *   ANTES de la llamada a Meta y se cierra con el estado resultante (R15 c3).
 *   La `explicacion` la arma el servidor y NO acepta texto del cliente
 *   (R15 c5); `actor_hint` lleva el rastro técnico con tope de 200 caracteres.
 * - `activarBackoffCuota`/`segundosBackoffRestante`: el backoff por app de
 *   `ads_backoff_*`, con la MISMA forma de cuatro filas y el mismo escalón
 *   min(15 × 2^failures, 60) que usa el worker (R17 c17).
 *
 * Los interruptores globales del motor (`ads_rules_enabled`,
 * `ads_rules_force_dry_run`) NO se consultan (R17 c6): siguen siendo del motor.
 */

import { q, q1 } from '../db';
import {
  PERIODO_SYNC_JERARQUIA_SEGUNDOS,
  UMBRAL_FRESCURA_DEFAULT_SEGUNDOS,
  umbralDeRelectura,
} from './frescura';
import { fetchMinimoPresupuesto, fetchObjeto } from './meta';
import { PRESUPUESTO_RELECTURA_MS } from './plazos';
import { TZ_DEFAULT } from './zona';
import type { AccionAds, MetaObjetoLeido, MetricasObjeto, NivelAds } from './tipos';
import { calcularPrevisualizacion, type ParametrosAccion, type Previsualizacion } from './previsualizacion';
import type { ModoRenombre } from './nombres';

export type ObjetoPreflight = {
  objectId: string;
  objectName: string | null;
  accountId: string;
  status: string | null;
  effectiveStatus: string | null;
  campaignId: string;
  budgetLevel: 'campaign' | 'adset' | null;
  budgetMode: 'daily' | 'lifetime' | null;
  /** Unidades mínimas, como la base. */
  dailyBudget: number | null;
  currency: string | null;
  inicioProgramado: string | null;
  /**
   * Frescura_Objeto de la fila: cuándo la Sync_Jerarquia vio este objeto por
   * última vez, en ISO. Es el dato con el que el preflight decide cuando no
   * relee, y la antigüedad que R6.1 pide nombrar en el mensaje de Omisión.
   */
  syncedAt: string | null;
  /** Marca de Objeto_Desaparecido (025). null = Meta lo sigue devolviendo. */
  desaparecidoAt: string | null;
  /**
   * `status` de la campaña de este objeto (R6.4): lo único que distingue "se
   * activó y entrega" de "se activó y no entrega". null a nivel campaña —un
   * objeto no es su propio padre— y cuando la fila del padre no está en la base.
   */
  statusCampania: string | null;
  /** `status` del conjunto. Sólo a nivel anuncio; null en los otros dos. */
  statusConjunto: string | null;
};

// ─── Relectura selectiva contra Meta (R6.2, R6.3) ────────────────────────────

/**
 * Cuántos objetos se releen contra Meta en un mismo preflight.
 *
 * El lote admite hasta 100 objetos (`objectIds.max(100)` del route), pero el
 * caso que importa es el del interruptor de una fila: UN objeto. 10 cubre
 * completa una selección hecha a mano —la cantidad que una persona tilda para
 * arreglar algo— y corta antes de que el preflight se vuelva una ráfaga.
 *
 * El tope existe porque `preflight` corre ANTES de la primera escritura: todo
 * lo que tarde acá es tiempo en el que el lote entero no empezó. Releer 100
 * objetos en secuencia, a 200-500 ms por llamada, serían 20-50 s de espera
 * delante de un lote que después va a escribir de a uno igual.
 *
 * Los objetos que quedan afuera del tope NO se bloquean: se deciden con el dato
 * de la base y quedan anotados con `resultado: 'no_intentada'`, que es
 * exactamente el comportamiento del caso en que `fetchObjeto` falla.
 */
export const TOPE_RELECTURA = 10;

/**
 * Presupuesto de tiempo de TODA la relectura, en milisegundos. El tope de arriba
 * acota la CANTIDAD de llamadas; esto acota la espera, que es lo que el usuario
 * siente. El número y su justificación viven en `lib/ads/plazos.ts`, junto a los
 * dos deadlines de Meta, porque los tres son términos de la misma suma: el peor
 * caso de un click, contra el que se compara el plazo del cliente.
 *
 * **Se RE-EXPORTA desde acá a propósito.** `acciones.relectura.test.ts` y
 * `togglePlazo.test.ts` lo importan de `lib/ads/acciones` y uno de los dos lo
 * interpola en el texto de «presupuesto agotado»: cambiarles el path del import
 * sería editar dos tests por un cambio que no mueve ningún valor.
 */
export { PRESUPUESTO_RELECTURA_MS };

/**
 * Qué pasó con la relectura de un objeto. Sólo los dos primeros decidieron con
 * el dato de Meta; los otros tres decidieron con el de la base y dejaron
 * anotado por qué no se pudo revalidar (R6.2: no bloquean la acción).
 */
export type ResultadoRelectura =
  | 'coincide' // Meta devolvió lo mismo que la base
  | 'discrepa' // Meta devolvió otra cosa: el estado real reemplazó al local
  | 'no_encontrado' // `fetchObjeto` devolvió null: Meta no dio el objeto
  | 'error' // `fetchObjeto` tiró, o no volvió dentro del presupuesto
  | 'no_intentada'; // fuera del tope, sin presupuesto, o backoff de cuota activo

/**
 * El rastro de una relectura, por objeto. Es el hand-off de esta task hacia las
 * dos que siguen:
 *
 * - **14.2** escribe la Discrepancia en `ad_actions.metrics` como
 *   `{ discrepancia: { local, real, syncedAt } }`: los tres campos se llaman
 *   igual acá a propósito. Cuando `resultado` es `'discrepa'` por el
 *   `effective_status` y no por el `status`, `local` y `real` van a coincidir y
 *   el par que cambió es `localEffective` / `realEffective`: conviene guardar
 *   los cuatro.
 * - **14.3** arma el mensaje de Omisión. `edadSegundos` es la antigüedad que
 *   R6.1 pide nombrar, y `decidioConMeta(...)` dice si corresponde decir "según
 *   un dato de hace X" (se decidió con la base) o que el estado se confirmó
 *   contra Meta recién.
 *
 * Un objeto SIN entrada en el mapa es un objeto que no necesitaba relectura: su
 * dato estaba dentro del umbral. Para esos, la antigüedad sale de
 * `ObjetoPreflight.syncedAt`, que viene poblado para todos.
 */
export type RelecturaPreflight = {
  objectId: string;
  /** Por qué entró: el dato pasó el umbral, o el objeto está marcado. */
  causa: 'vieja' | 'desaparecida';
  /** El `synced_at` de la base. El `syncedAt` que 14.2 escribe en metrics. */
  syncedAt: string | null;
  /** Antigüedad de ese dato en segundos enteros. null = no hay `synced_at`. */
  edadSegundos: number | null;
  /** `status` de la base al momento de decidir. El `local` de 14.2. */
  local: string | null;
  /** `status` que devolvió Meta. null = no se pudo leer. El `real` de 14.2. */
  real: string | null;
  /** El par equivalente de `effective_status`. */
  localEffective: string | null;
  realEffective: string | null;
  resultado: ResultadoRelectura;
  /** Rastro técnico: el error, o por qué no se intentó. null = no hace falta. */
  detalle: string | null;
};

/**
 * true cuando la Omisión de este objeto se decidió con el estado que devolvió
 * Meta y no con el de la base.
 *
 * Vive acá y no en cada consumidor porque 14.2 y 14.3 tienen que estar de
 * acuerdo: si una anota "revalidado contra Meta" y la otra dice "según un dato
 * de hace 5 días" sobre el mismo objeto, el mensaje vuelve a mentir.
 *
 * `undefined` (el objeto no estaba viejo, no se releyó) devuelve false: se
 * decidió con la base, aunque la base estuviera fresca.
 */
export function decidioConMeta(r: RelecturaPreflight | undefined): boolean {
  return r !== undefined && (r.resultado === 'coincide' || r.resultado === 'discrepa');
}

// ─── La Discrepancia en la auditoría (task 14.2, R6.3, R6.5) ─────────────────

/**
 * La antigüedad de un dato en palabras, escrita como la cola de una frase que
 * arranca con el sustantivo: `un dato ${textoAntiguedad(e)}` → «un dato de hace
 * 5 d». Se compone así para que la misma función sirva a la `explicacion` de la
 * auditoría y al mensaje de Omisión que R6.1 pide (task 14.3), sin que cada
 * consumidor arme su propio redondeo.
 *
 * Los escalones y las abreviaturas son los de `textoEdadGasto` de
 * `lib/ads/polling.ts` a propósito: la Marca_Frescura de la barra y la
 * antigüedad que la auditoría nombra hablan del MISMO `synced_at`, y dos
 * redondeos distintos sobre el mismo número harían dudar de los dos. No se
 * importa de ahí porque ese módulo es `'use client'` y esto corre en el servidor.
 *
 * `null` no se dice como «hace 0 s»: un objeto sin `synced_at` es uno del que no
 * se sabe cuándo se vio, que es peor que uno viejo, no mejor.
 */
export function textoAntiguedad(edadSegundos: number | null): string {
  if (edadSegundos === null) return 'sin fecha de sincronización';
  if (edadSegundos < 60) return 'de hace menos de un minuto';
  if (edadSegundos < 3_600) return `de hace ${Math.round(edadSegundos / 60)} min`;
  if (edadSegundos < 86_400) return `de hace ${Math.round(edadSegundos / 3_600)} h`;
  return `de hace ${Math.round(edadSegundos / 86_400)} d`;
}

/**
 * Un lado de la comparación —el de la base o el de Meta— en palabras.
 *
 * `conEfectivo` no lo decide este lado solo: lo decide la comparación, en
 * `parDeLaDiscrepancia`. Un `effective_status` nulo se dice `desconocido` y no se
 * omite: cuando se está mostrando el par, «Meta no informó el efectivo» es
 * justamente el dato.
 */
function estadoLegible(status: string | null, effective: string | null, conEfectivo: boolean): string {
  const s = status ?? 'desconocido';
  return conEfectivo ? `${s}/${effective ?? 'desconocido'}` : s;
}

/**
 * Los dos lados de una Discrepancia, con el `effective_status` a la vista SÓLO
 * cuando hace falta.
 *
 * LA REGLA. Se muestra el par cuando el `status` solo no distingue los dos lados,
 * o cuando el efectivo de alguno de los dos contradice a su propio `status`.
 *
 * POR QUÉ LA PRIMERA MITAD. Hay dos formas reales de que los `status` coincidan y
 * la Discrepancia esté entera en el efectivo: `ACTIVE` con `effective_status =
 * WITH_ISSUES` (un objeto que figura activo y NO entrega) y un `fetchObjeto` que
 * vuelve sin efectivo cuando la base sí lo tenía. En las dos, un texto armado
 * sólo con `status` diría «Meta decía PAUSED y la base PAUSED»: una Discrepancia
 * que se informa y se esconde en la misma frase, que es la clase de mentira que
 * este spec vino a sacar de la pantalla.
 *
 * POR QUÉ LA SEGUNDA. Cuando el que cambió es el `status` pero Meta además
 * contesta que el objeto no entrega, eso hay que decirlo: si no, la frase informa
 * que el estado pasó a ACTIVE y calla que sigue sin entregar.
 *
 * Y por qué no siempre: cuando el `status` ya distingue los lados y el efectivo
 * no contradice a nadie, se calla. «Meta decía ACTIVE y la base PAUSED» se lee
 * mejor que la versión con las cuatro palabras, y un efectivo nulo en los dos
 * lados no aporta un «desconocido/desconocido». El jsonb guarda los cuatro
 * valores igual, siempre.
 */
function parDeLaDiscrepancia(r: RelecturaPreflight): { real: string; local: string } {
  const statusDistingue = r.local !== r.real;
  const efectivoContradice =
    (r.localEffective !== null && r.localEffective !== r.local) ||
    (r.realEffective !== null && r.realEffective !== r.real);
  const conEfectivo = !statusDistingue || efectivoContradice;
  return {
    real: estadoLegible(r.real, r.realEffective, conEfectivo),
    local: estadoLegible(r.local, r.localEffective, conEfectivo),
  };
}

/**
 * Lo que la relectura deja escrito en `ad_actions.metrics` (jsonb, sin cambio de
 * schema).
 *
 * DOS BLOQUES Y NO UNO. `revalidacion` está siempre que hubo relectura y cuenta
 * el INTENTO; `discrepancia` está sólo cuando Meta contestó algo distinto de la
 * base y cuenta el HECHO. Separarlos es lo que hace que la pregunta que importa
 * se pueda hacer en SQL sin leer el texto: `WHERE metrics ? 'discrepancia'` son
 * las filas donde la copia local mintió, y `WHERE metrics -> 'revalidacion' ->>
 * 'decidioConMeta' = 'false'` son las que se decidieron con un dato que nadie
 * pudo confirmar.
 *
 * `discrepancia` lleva los tres campos que el design nombra (`local`, `real`,
 * `syncedAt`) y además el par de `effective_status`, porque cuando la
 * Discrepancia es del efectivo (local ACTIVE/ACTIVE, real ACTIVE/WITH_ISSUES)
 * `local` y `real` coinciden y el bloque sin los otros dos parecería un error de
 * escritura. `syncedAt` se repite en los dos bloques a propósito: es el único
 * dato duplicado y hace que `discrepancia` se entienda sola, que es como se va a
 * leer cuando alguien la busque por su nombre.
 */
export type MetricsRelectura = {
  revalidacion: {
    /** Qué pasó con la lectura. Los cinco valores de `ResultadoRelectura`. */
    resultado: ResultadoRelectura;
    /** Por qué este objeto se releyó: el dato pasó el umbral, o está marcado. */
    causa: 'vieja' | 'desaparecida';
    /**
     * true = la decisión se tomó con lo que contestó Meta; false = con la copia
     * local, porque la lectura no se pudo hacer. Es redundante con `resultado` y
     * está igual: es LA distinción que R6.5 pide poder hacer, y quien lea la
     * fila dentro de seis meses no tiene por qué saber cuáles de los cinco
     * valores llegaron a Meta. Sale de `decidioConMeta`, la misma función que
     * usa el mensaje al cliente, así que las dos no pueden contradecirse.
     */
    decidioConMeta: boolean;
    /** El `synced_at` de la copia local con la que se hubiera decidido. */
    syncedAt: string | null;
    /** Su antigüedad en segundos enteros, la que R6.1 pide nombrar. */
    edadSegundos: number | null;
    /** Por qué no se pudo revalidar: el error, el tope, el backoff. */
    detalle: string | null;
  };
  discrepancia?: {
    /** `status` de la base al momento de decidir. */
    local: string | null;
    /** `status` que devolvió Meta. */
    real: string | null;
    /** El par equivalente de `effective_status`. */
    localEffective: string | null;
    realEffective: string | null;
    /** De cuándo era el dato local que Meta desmintió. */
    syncedAt: string | null;
  };
};

/**
 * El fragmento de `metrics` de un objeto, o `null` cuando no hay nada que
 * anotar.
 *
 * QUÉ SE REGISTRA Y POR QUÉ. Las cinco salidas de la relectura se anotan, no
 * sólo la Discrepancia:
 *
 * - `discrepa`: lo pide R6.3 y es el hecho que explica el bug reportado.
 * - `coincide`: prueba que la Omisión se decidió contra Meta y no contra una
 *   fila de cinco días. Sin esta anotación las dos filas son idénticas en la
 *   auditoría, y la pregunta «¿el botón está roto o el dato estaba viejo?» —la
 *   que este spec vino a contestar— vuelve a quedar sin respuesta.
 * - `error`, `no_encontrado`, `no_intentada`: R6.5 quiere distinguir lo que no
 *   llegó a Meta. «No se pudo revalidar» es justo lo que se olvida, y es la
 *   diferencia entre un dato confirmado y uno que se dio por bueno.
 *
 * QUÉ NO SE REGISTRA: el caso normal. `undefined` (el objeto no necesitaba
 * relectura porque su dato estaba dentro del umbral) devuelve `null` y la fila
 * no gana ni una clave. Así la presencia del bloque es en sí misma información
 * —«acá la copia local no alcanzaba»— en lugar de ruido en todas las filas. La
 * antigüedad de esas filas sale de `ObjetoPreflight.syncedAt`, que viene poblado
 * para todas.
 */
export function metricsDeRelectura(r: RelecturaPreflight | undefined): MetricsRelectura | null {
  if (r === undefined) return null;
  const m: MetricsRelectura = {
    revalidacion: {
      resultado: r.resultado,
      causa: r.causa,
      decidioConMeta: decidioConMeta(r),
      syncedAt: r.syncedAt,
      edadSegundos: r.edadSegundos,
      detalle: r.detalle,
    },
  };
  if (r.resultado === 'discrepa') {
    m.discrepancia = {
      local: r.local,
      real: r.real,
      localEffective: r.localEffective,
      realEffective: r.realEffective,
      syncedAt: r.syncedAt,
    };
  }
  return m;
}

/**
 * El `extra` que `armarExplicacion` agrega a la frase de la auditoría, o
 * `undefined` cuando no hubo relectura y no hay nada que decir.
 *
 * La Discrepancia queda en `metrics` de forma consultable, pero un jsonb no se
 * lee de corrido: R6.3 pide NOMBRARLA, y el renglón en castellano de
 * `explicacion` es lo que se ve en el historial y lo que alguien va a leer
 * cuando pregunte por qué el panel hizo lo que hizo. Los cinco casos llevan
 * texto por la misma razón por la que los cinco van a `metrics`: la fila que
 * dice «se decidió con un dato de hace 5 d que nadie pudo confirmar» es tan útil
 * como la que dice «Meta contestó otra cosa».
 *
 * CORTO A PROPÓSITO. `armarExplicacion` corta en 300 caracteres y el nombre del
 * objeto va antes, así que cada carácter de acá compite con el nombre. Los cinco
 * textos quedan abajo de 80 para que la frase entre completa con nombres de
 * largo normal; con un nombre de 300 caracteres el corte se lleva esta parte y
 * la Discrepancia queda igual en `metrics`, que es donde no se puede truncar.
 */
export function explicacionDeRelectura(r: RelecturaPreflight | undefined): string | undefined {
  if (r === undefined) return undefined;
  const ant = textoAntiguedad(r.edadSegundos);
  switch (r.resultado) {
    case 'discrepa': {
      const par = parDeLaDiscrepancia(r);
      return `discrepancia: Meta decía ${par.real} y la base ${par.local} (dato ${ant})`;
    }
    case 'coincide':
      // Acá los dos lados coinciden, así que el efectivo se muestra por lo que
      // dice de por sí: un ACTIVE/WITH_ISSUES confirmado sigue sin entregar.
      return `revalidado contra Meta, que confirmó ${estadoLegible(r.real, r.realEffective, r.realEffective !== r.real)} (dato local ${ant})`;
    case 'no_encontrado':
      return `sin revalidar: Meta no devolvió el objeto (se decidió con el dato local ${ant})`;
    case 'error':
      return `sin revalidar: la lectura a Meta falló (se decidió con el dato local ${ant})`;
    default:
      return `sin revalidar contra Meta (se decidió con el dato local ${ant})`;
  }
}

// ─── La antigüedad en el mensaje de Omisión (task 14.3, R6.1) ────────────────

/**
 * La antigüedad del dato con el que el Preflight decidió una Omisión, escrita
 * como la cola de «según un dato …» que el cliente cierra. Es el valor de
 * `ResultadoAccion.edadDelDato` (`lib/ads/mensajes.ts`), que R6.1 pide para que
 * el aviso no diga sólo «ya está en ese estado» sino «ya está en ese estado,
 * según un dato de hace 5 d» — la diferencia entre un botón roto y un dato
 * viejo, que es la pregunta que este spec vino a contestar.
 *
 * VIAJA FORMATEADA Y NO EN SEGUNDOS a propósito: `mensajes.ts` documenta que su
 * regla 6 es el ÚNICO lugar del módulo que interpola un número, y así el
 * redondeo queda de este lado, con el mismo `textoAntiguedad` que usa la
 * `explicacion` de la auditoría (task 14.2). Un objeto no puede quedar con «hace
 * 5 d» en el historial y «hace 120 h» en la pantalla.
 *
 * LOS TRES CAMINOS, que son los tres estados en los que la relectura selectiva
 * puede dejar a un objeto:
 *
 * 1. **Se decidió contra Meta** (`coincide` o `discrepa`, o sea
 *    `decidioConMeta`): la antigüedad del `synced_at` local YA NO es la del dato
 *    que decidió, así que nombrarla mentiría al revés —haría dudar de una
 *    decisión que se tomó con una lectura de ahora—. Se dice eso, que además es
 *    la información útil: el estado se confirmó en el momento del pedido.
 * 2. **Hubo relectura y no se pudo usar** (`error`, `no_encontrado`,
 *    `no_intentada`): decidió la copia local, y su edad es la que la relectura
 *    ya calculó (`edadSegundos`, medida en el instante de la decisión y no
 *    ahora). Se nombra, y se agrega que no se pudo revalidar: R6.5 pide poder
 *    distinguir lo que no llegó a Meta, y del lado del usuario eso es la
 *    diferencia entre un dato viejo confirmado y uno que se dio por bueno.
 * 3. **No hubo relectura** (`undefined`): el dato estaba dentro del umbral, así
 *    que no hay entrada en el mapa y la edad sale de `ObjetoPreflight.syncedAt`,
 *    que `leerObjetos` puebla para todos los objetos. Es el caso más común —una
 *    Omisión legítima sobre un dato fresco— y R6.1 pide la antigüedad en TODA
 *    Omisión, no sólo en las de los objetos viejos.
 *
 * UN `synced_at` NULO NO SE DICE COMO «recién»: `textoAntiguedad(null)` devuelve
 * «sin fecha de sincronización», porque un objeto del que no se sabe cuándo se
 * vio es peor que uno viejo, no mejor. Sin esto, la resta contra un `null` daría
 * cero y el mensaje presentaría el peor dato posible como el mejor.
 *
 * SIRVE A LAS SEIS ACCIONES y no sólo a las dos de estado. `relecturas` está
 * vacío para las otras cuatro, así que cae siempre en el camino 3 — y ahí la
 * frase sigue siendo verdadera: la Omisión de `budget_set` por
 * `valor_igual_al_anterior` también se decidió con el `daily_budget` de la copia
 * local, cuya antigüedad es ese mismo `synced_at`.
 */
export function edadDelDatoDeOmision(
  o: ObjetoPreflight,
  r: RelecturaPreflight | undefined,
  ahora: Date = new Date(),
): string {
  if (decidioConMeta(r)) return 'confirmado contra Meta al resolver el pedido';
  if (r !== undefined) return `${textoAntiguedad(r.edadSegundos)}, que no se pudo revalidar contra Meta`;
  return textoAntiguedad(edadEnSegundos(o.syncedAt, ahora));
}

export type MotivoRechazo =
  | 'objetos_invalidos'
  | 'tope_absoluto'
  | 'tope_lote'
  | 'presupuesto_lifetime_no_soportado'
  | 'moneda_no_soportada'
  | 'sin_presupuesto_en_este_nivel'
  | 'presupuesto_bajo_el_minimo'
  | 'muchas_copias'
  | 'backoff_activo'
  | 'fecha_invalida'
  | 'previsualizacion_incompleta';

export type ErrorPreflight = { motivo: MotivoRechazo; detalle: string };

export type ResultadoPreflight =
  | {
      ok: true;
      /**
       * Los objetos como REALMENTE están: para `pause` y `activate`, los que se
       * releyeron contra Meta llevan el `status` y el `effective_status` que
       * devolvió Meta, no el de la base (R6.3). Es la misma foto con la que se
       * calculó `previa`, así que el `before_value` de la auditoría y el `antes`
       * del mensaje no pueden discrepar entre sí.
       */
      objetos: ObjetoPreflight[];
      /** La revalidación con el mismo módulo del cliente (R14 c10). */
      previa: Previsualizacion;
      topes: { techoEur: number; topeLoteEur: number };
      minimoDiarioEur: number | null;
      zona: string;
      /**
       * El rastro de la relectura selectiva, por objectId. Vacío cuando la
       * acción no es de estado o cuando todos los datos estaban frescos.
       */
      relecturas: Map<string, RelecturaPreflight>;
    }
  | { ok: false; error: ErrorPreflight };

const TABLA_NIVEL: Record<NivelAds, { tabla: string; pk: string }> = {
  campaign: { tabla: 'ad_campaigns', pk: 'campaign_id' },
  adset: { tabla: 'ad_sets', pk: 'adset_id' },
  ad: { tabla: 'ads', pk: 'ad_id' },
};

export const ETIQUETA_NIVEL: Record<NivelAds, string> = {
  campaign: 'campaña',
  adset: 'conjunto',
  ad: 'anuncio',
};

const dosDecimales = new Intl.NumberFormat('es-AR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const eur = (n: number): string => `€${dosDecimales.format(n)}`;

// ─── Topes de settings (la ÚNICA fuente, R17 c7) ─────────────────────────────

/**
 * Los dos topes de presupuesto y el umbral de Frescura_Objeto, en UNA sola
 * vuelta: son tres subselects de la misma tabla de una fila, igual que en
 * `/api/data/ads`. El umbral viaja acá y no en una consulta propia porque
 * agregarle un round trip al preflight para leer un número de `settings` es el
 * costo que este spec vino a bajar, no a subir.
 *
 * Los defaults repiten los de la migración que sembró cada fila (200, 300 y el
 * 900 de la 025): `settings.value` es jsonb y puede tener cualquier cosa, y un
 * `NaN` acá dejaría a todos los objetos por encima del umbral y convertiría cada
 * click en una relectura contra Meta.
 *
 * El del umbral sale de `UMBRAL_FRESCURA_DEFAULT_SEGUNDOS` y no de un literal:
 * es el mismo número que leen `/api/data/ads`, `page.tsx` y `GestorAnuncios.tsx`.
 */
export async function topesDeSettings(): Promise<{
  techoEur: number;
  topeLoteEur: number;
  umbralFrescuraSegundos: number;
}> {
  const r = await q1<{ max: unknown; delta: unknown; umbral: unknown }>(
    `SELECT (SELECT value FROM settings WHERE key = 'ads_max_daily_budget_eur') AS "max",
            (SELECT value FROM settings WHERE key = 'ads_max_delta_por_tick_eur') AS "delta",
            (SELECT value FROM settings WHERE key = 'ads_frescura_umbral_segundos') AS "umbral"`,
  );
  return {
    techoEur: typeof r?.max === 'number' ? (r.max as number) : 200,
    topeLoteEur: typeof r?.delta === 'number' ? (r.delta as number) : 300,
    umbralFrescuraSegundos:
      typeof r?.umbral === 'number' && r.umbral >= 0
        ? (r.umbral as number)
        : UMBRAL_FRESCURA_DEFAULT_SEGUNDOS,
  };
}

// ─── Backoff por app (ads_backoff_*), misma forma que el worker ─────────────

async function leerBackoff(): Promise<{ until: Date | null; failures: number }> {
  const filas = await q<{ key: string; value: unknown }>(
    `SELECT key, value FROM settings WHERE key IN ('ads_backoff_until', 'ads_backoff_failures')`,
  );
  const m = new Map(filas.map((f) => [f.key, f.value]));
  const hasta = m.get('ads_backoff_until');
  const hastaStr = typeof hasta === 'string' && hasta.length > 0 ? hasta : null;
  return {
    until: hastaStr ? new Date(hastaStr) : null,
    failures: Number(m.get('ads_backoff_failures')) || 0,
  };
}

async function setValor(key: string, value: unknown): Promise<void> {
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

/** Segundos enteros que faltan para que expire el backoff por app. null = no hay. */
export async function segundosBackoffRestante(): Promise<number | null> {
  const b = await leerBackoff();
  if (!b.until || b.until.getTime() <= Date.now()) return null;
  return Math.ceil((b.until.getTime() - Date.now()) / 1000);
}

/**
 * Activa el backoff por app tras un error de cuota, con el mismo escalón del
 * worker: min(15 × 2^failures, 60) minutos. Devuelve los segundos enteros
 * restantes (R17 c17).
 */
export async function activarBackoffCuota(): Promise<number> {
  const b = await leerBackoff();
  const minutos = Math.min(15 * 2 ** b.failures, 60);
  const until = new Date(Date.now() + minutos * 60_000);
  await setValor('ads_backoff_until', until.toISOString());
  await setValor('ads_backoff_reason', `Meta respondió un error de cuota (17/613) durante una acción manual. Pausado ${minutos} min (reincidencia ${b.failures + 1}).`);
  await setValor('ads_backoff_failures', b.failures + 1);
  await setValor('ads_backoff_clean_ticks', 0);
  return minutos * 60;
}

// ─── Lectura de objetos ──────────────────────────────────────────────────────

async function leerObjetos(
  level: NivelAds,
  accountId: string,
  objectIds: string[],
): Promise<(ObjetoPreflight | null)[]> {
  const t = TABLA_NIVEL[level];
  const budgetLevelSql =
    level === 'campaign'
      ? 'o.budget_level'
      : level === 'adset'
        ? '(SELECT c.budget_level FROM ad_campaigns c WHERE c.campaign_id = o.campaign_id)'
        : 'NULL::text';
  const inicioSql =
    level === 'campaign'
      ? 'o.start_time'
      : level === 'adset'
        ? 'o.start_time'
        : 'NULL::timestamptz';
  // Los anuncios NO tienen presupuesto: en Meta vive en la campaña (CBO) o en el
  // conjunto (ABO), nunca en el anuncio, y la migración 016 dejó `ads` sin esas
  // dos columnas a propósito (lo dice en su comentario). Emitirlas igual hacía
  // que TODO `pause` o `activate` a nivel anuncio muriera acá con `column
  // o.daily_budget does not exist`, dentro del preflight y antes de llegar a
  // Meta: el interruptor de una fila de anuncio no fallaba por la lógica del
  // toggle sino porque el preflight no podía ni leer el objeto.
  const dailySql = level === 'ad' ? 'NULL::bigint' : 'o.daily_budget';
  const lifetimeSql = level === 'ad' ? 'NULL::bigint' : 'o.lifetime_budget';
  const campaignSql =
    level === 'campaign' ? 'o.campaign_id' : level === 'adset' ? 'o.campaign_id' : 'o.campaign_id';
  // Los antepasados (R6.4). Un conjunto tiene la campaña; un anuncio tiene las
  // dos, y cualquiera de las dos apagada lo deja sin entregar. Una campaña no
  // tiene padre: las dos columnas van NULL, que es "no aplica".
  //
  // Subselect escalar y no JOIN, igual que `budgetLevelSql`: `campaign_id` y
  // `adset_id` son las PK de sus tablas, así que devuelve una fila o ninguna, y
  // "ninguna" tiene que llegar como NULL sin sacar el objeto del resultado —un
  // padre que falta no puede hacer que el preflight rechace el lote entero.
  //
  // NO se usa el `effective_status` del propio objeto aunque parezca que
  // alcanza: Meta lo resuelve con el estado PROPIO antes que con el del padre,
  // así que un conjunto PAUSED bajo una campaña PAUSED viene `PAUSED` y no
  // `CAMPAIGN_PAUSED`. Son justo los objetos que alguien va a querer activar.
  const statusCampaniaSql =
    level === 'campaign'
      ? 'NULL::text'
      : '(SELECT c.status FROM ad_campaigns c WHERE c.campaign_id = o.campaign_id)';
  const statusConjuntoSql =
    level === 'ad' ? '(SELECT s.status FROM ad_sets s WHERE s.adset_id = o.adset_id)' : 'NULL::text';

  const rows = await q<{
    objectId: string;
    name: string | null;
    status: string | null;
    effectiveStatus: string | null;
    campaignId: string;
    budgetLevel: string | null;
    dailyBudget: string | null;
    lifetimeBudget: string | null;
    currency: string | null;
    inicioProgramado: Date | string | null;
    syncedAt: Date | string | null;
    desaparecidoAt: Date | string | null;
    statusCampania: string | null;
    statusConjunto: string | null;
  }>(
    `SELECT o.${t.pk} AS "objectId", o.name, o.status, o.effective_status AS "effectiveStatus",
            ${campaignSql} AS "campaignId",
            ${budgetLevelSql} AS "budgetLevel",
            ${dailySql} AS "dailyBudget", ${lifetimeSql} AS "lifetimeBudget",
            a.currency, ${inicioSql} AS "inicioProgramado",
            o.synced_at AS "syncedAt", o.desaparecido_at AS "desaparecidoAt",
            ${statusCampaniaSql} AS "statusCampania",
            ${statusConjuntoSql} AS "statusConjunto"
       FROM ${t.tabla} o
       JOIN ad_accounts a ON a.account_id = o.account_id AND a.active AND a.platform = 'meta'
      WHERE o.account_id = $1 AND o.${t.pk} = ANY($2::text[])`,
    [accountId, objectIds],
  );
  const porId = new Map(rows.map((r) => [r.objectId, r]));
  return objectIds.map((id) => {
    const r = porId.get(id);
    if (!r) return null; // id desconocido: el preflight lo rechaza en bloque
    return {
      objectId: r.objectId,
      objectName: r.name,
      accountId,
      status: r.status,
      effectiveStatus: r.effectiveStatus,
      campaignId: r.campaignId,
      budgetLevel: (r.budgetLevel === 'campaign' || r.budgetLevel === 'adset' ? r.budgetLevel : null) as 'campaign' | 'adset' | null,
      budgetMode:
        r.dailyBudget !== null
          ? 'daily'
          : r.lifetimeBudget !== null
            ? 'lifetime'
            : null,
      dailyBudget: r.dailyBudget === null ? null : Number(r.dailyBudget),
      currency: r.currency,
      inicioProgramado: aIso(r.inicioProgramado),
      syncedAt: aIso(r.syncedAt),
      desaparecidoAt: aIso(r.desaparecidoAt),
      statusCampania: r.statusCampania,
      statusConjunto: r.statusConjunto,
    };
  });
}

/** Un `timestamptz` de pg a ISO. `pg` devuelve `Date` con el driver configurado
 *  y string cuando el tipo se resuelve como texto; los dos casos se normalizan
 *  al mismo ISO que usa el resto del contrato. */
function aIso(v: Date | string | null): string | null {
  if (v === null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** La fila de la jerarquía como MetricasObjeto (lo mínimo que la
 *  Previsualizacion lee), para revalidar con el MISMO módulo del cliente. */
function aMetricas(o: ObjetoPreflight, level: NivelAds): MetricasObjeto {
  return {
    level,
    objectId: o.objectId,
    objectName: o.objectName,
    accountId: o.accountId,
    campaignId: o.campaignId,
    adsetId: level === 'campaign' ? '' : level === 'adset' ? o.objectId : '',
    adId: level === 'ad' ? o.objectId : '',
    funnelId: null,
    status: o.status,
    effectiveStatus: o.effectiveStatus,
    budgetLevel: o.budgetLevel,
    budgetMode: o.budgetMode,
    dailyBudgetEur: o.dailyBudget === null ? null : o.dailyBudget / 100,
    spendEur: 0,
    impressions: 0,
    clicks: 0,
    sales: 0,
    revenueEur: 0,
    refundedEur: 0,
    commissionsEur: 0,
    costsEur: 0,
    netEur: 0,
    profitEur: 0,
    roas: null,
    roi: null,
    cpaEur: null,
    ctr: null,
    cpcEur: null,
    ultimaAccionAt: null,
    cpmEur: null,
    hookRate: null,
    videoReproducciones: null,
    videoThruplay: null,
    videoP25: null,
    videoP50: null,
    videoP75: null,
    videoP100: null,
    alcance: null,
    frecuencia: null,
    inicioProgramado: o.inicioProgramado,
    // Frescura de la Jerarquía, poblada por task 14.1: `leerObjetos` ya trae
    // `synced_at` y `desaparecido_at`, que es lo que la task 7.1 dejó pedido acá.
    // `calcularPrevisualizacion` todavía no los lee —la advertencia de objeto
    // desaparecido es de la task 15— pero la relectura selectiva sí decide con
    // ellos, y el `status` que llega en `o` ya puede venir de Meta y no de la
    // base. Cuando eso pasó, `syncedAt` es la foto que la relectura reemplazó:
    // el rastro de lo que se leyó vive en `relecturas`, no acá.
    syncedAt: o.syncedAt,
    desaparecidoAt: o.desaparecidoAt,
  };
}

/** El desglose de descendientes por objeto origen, desde la base (R14 c5):
 *  una lectura de la jerarquía local, no de Meta. */
async function desgloseDesdeBase(
  level: NivelAds,
  objectIds: string[],
): Promise<Map<string, { conjuntos: number; anuncios: number }>> {
  const out = new Map<string, { conjuntos: number; anuncios: number }>();
  if (level === 'campaign') {
    const sets = await q<{ campaign_id: string; n: number }>(
      `SELECT campaign_id, count(*)::int AS n FROM ad_sets WHERE campaign_id = ANY($1::text[]) GROUP BY campaign_id`,
      [objectIds],
    );
    const ads = await q<{ campaign_id: string; n: number }>(
      `SELECT campaign_id, count(*)::int AS n FROM ads WHERE campaign_id = ANY($1::text[]) GROUP BY campaign_id`,
      [objectIds],
    );
    const adsPorCamp = new Map(ads.map((r) => [r.campaign_id, r.n]));
    for (const s of sets) {
      out.set(s.campaign_id, { conjuntos: s.n, anuncios: adsPorCamp.get(s.campaign_id) ?? 0 });
    }
    for (const id of objectIds) if (!out.has(id)) out.set(id, { conjuntos: 0, anuncios: 0 });
  } else if (level === 'adset') {
    const ads = await q<{ adset_id: string; n: number }>(
      `SELECT adset_id, count(*)::int AS n FROM ads WHERE adset_id = ANY($1::text[]) GROUP BY adset_id`,
      [objectIds],
    );
    const porSet = new Map(ads.map((r) => [r.adset_id, r.n]));
    for (const id of objectIds) out.set(id, { conjuntos: 0, anuncios: porSet.get(id) ?? 0 });
  }
  return out;
}

// ─── La relectura selectiva (R6.2, R6.3) ─────────────────────────────────────

/** Marca de "no volvió dentro del presupuesto", distinguible del `null` que
 *  `fetchObjeto` devuelve cuando Meta no dio el objeto. */
const AGOTADO = Symbol('presupuesto de relectura agotado');

/** Corre una promesa contra un presupuesto de tiempo, limpiando el timer: sin
 *  el `clearTimeout` cada relectura rápida dejaría un timer de segundos colgado
 *  en el event loop. Una rechazo de `p` sale por el `throw`, no por el símbolo. */
async function conPresupuesto<T>(p: Promise<T>, ms: number): Promise<T | typeof AGOTADO> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<typeof AGOTADO>((resolve) => {
        t = setTimeout(() => resolve(AGOTADO), ms);
      }),
    ]);
  } finally {
    if (t !== undefined) clearTimeout(t);
  }
}

function edadEnSegundos(syncedAt: string | null, ahora: Date): number | null {
  if (syncedAt === null) return null;
  const t = new Date(syncedAt).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((ahora.getTime() - t) / 1000));
}

/**
 * Por qué habría que releer este objeto, o null si su dato alcanza.
 *
 * Un `synced_at` nulo o ilegible cuenta como viejo: "no sé de cuándo es este
 * dato" no es una razón para confiar en él.
 *
 * LA COMPARACIÓN NO ES CONTRA `umbralSegundos` PELADO, y ésa es la corrección del
 * bug 1: el umbral de `settings` vale 900 y el cron de la jerarquía corre cada 900
 * s, así que sin margen la edad de una fila SANA cruzaba el umbral por la sola
 * varianza de la corrida y metía una lectura a Meta en el camino crítico de cada
 * click. `umbralDeRelectura` le SUMA la mitad del período (el signo importa y está
 * explicado allá): el borde pasa de 900 a 1350 s. Lo que se conserva es el caso
 * para el que la relectura existe —una corrida perdida deja la edad en ≈1800 s y
 * sigue releyendo—, porque el margen es menor que el período.
 *
 * **El orden de estas tres líneas es lo que preserva 3.15, no el cuidado de quien
 * edita**: la marca de desaparición devuelve antes de mirar la edad, y el
 * `edad === null` —`synced_at` nulo o ilegible— cortocircuita antes de la
 * comparación, así que ninguno de los tres mira el margen. Moverlos debajo de la
 * comparación pone en rojo los tres casos de `acciones.margen.test.ts`.
 *
 * El otro consumidor del mismo valor de `settings`, `frescuraDeFila` de
 * `celdas.tsx`, NO lleva margen a propósito: pregunta otra cosa (si el dato se le
 * tiene que ver viejo a una persona) y su borde es un compromiso de producto.
 *
 * Exportada para la Property 1 de `toggle-conjuntos-entrega` (task 1), con el
 * mismo criterio con el que ya están exportadas `dibujoDeEstado`,
 * `frescuraDeFila` y `accionDeToggle`: la decisión tiene que poder verificarse
 * para TODO par (umbral, edad) y la única otra entrada sería `relecturaSelectiva`,
 * que es privada, pega a la base y mockea `fetchObjeto` — o sea que la property
 * quedaría atada a un integration test. El `export` no cambia comportamiento.
 */
export function causaDeRelectura(
  o: ObjetoPreflight,
  umbralSegundos: number,
  ahora: Date,
): 'vieja' | 'desaparecida' | null {
  if (o.desaparecidoAt !== null) return 'desaparecida';
  const edad = edadEnSegundos(o.syncedAt, ahora);
  if (edad === null || edad > umbralDeRelectura(umbralSegundos, PERIODO_SYNC_JERARQUIA_SEGUNDOS)) return 'vieja';
  return null;
}

/**
 * Relee contra Meta los objetos cuyo dato local no alcanza para decidir una
 * Omisión, y devuelve la misma lista con el estado real puesto encima.
 *
 * SÓLO PARA `pause` Y `activate`. La Omisión que este spec vino a arreglar es la
 * de `ya_esta_en_ese_estado` (R6.1), que se decide con `status` y
 * `effective_status`. `budget_set` tiene la misma clase de problema con
 * `valor_igual_al_anterior`, pero su preflight ya hace una lectura a Meta
 * (`fetchMinimoPresupuesto`) y sumarle una por objeto duplicaría el costo de un
 * camino que hoy ni llega a Meta; queda fuera del alcance de esta task.
 *
 * QUÉ SE REEMPLAZA Y QUÉ NO. Sólo `status` y `effectiveStatus`, que son los dos
 * campos que la decisión lee y los dos únicos que `fetchObjeto` devuelve sobre el
 * mismo hecho. `budgetLevel` NO viene de `fetchObjeto` (es de la campaña, no del
 * objeto) y pisarlo lo perdería; `dailyBudget` y `budgetMode` vienen, pero
 * dejarlos entrar acá cambiaría en silencio la entrada de verificaciones que sólo
 * corren para `budget_set` —y con el riesgo de la conversión: `fetchObjeto`
 * devuelve unidades mínimas y `MetricasObjeto.dailyBudgetEur` está en EUR, con el
 * ×100 ocurriendo una sola vez en el borde (ver la advertencia 3 de `tipos.ts`).
 * Ninguna decisión de esta task necesita el presupuesto, así que no cruza.
 *
 * SECUENCIAL, no en paralelo. `pedir` de `lib/ads/meta` no tiene freno propio:
 * N lecturas en paralelo son una ráfaga de N pedidos simultáneos con el mismo
 * token de app, que es la forma exacta de sacarle a Meta un 17/613. Ese error
 * durante una LECTURA le costaría a toda la app un `activarBackoffCuota` de
 * hasta 60 minutos sin poder escribir, para mejorar una decisión que igual sabe
 * tomarse con el dato de la base. Un preflight que envenena el camino de
 * escritura es peor que un preflight que decide con un dato viejo. Además, en
 * secuencia el presupuesto de tiempo puede cortar limpio entre llamadas: cada
 * lectura que volvió cuenta, y las que faltan quedan anotadas.
 */
async function relecturaSelectiva(d: {
  accion: AccionAds;
  level: NivelAds;
  objetos: ObjetoPreflight[];
  umbralSegundos: number;
  ahora: Date;
}): Promise<{ objetos: ObjetoPreflight[]; relecturas: Map<string, RelecturaPreflight> }> {
  const relecturas = new Map<string, RelecturaPreflight>();
  if (d.accion !== 'pause' && d.accion !== 'activate') return { objetos: d.objetos, relecturas };

  const candidatos: { i: number; causa: 'vieja' | 'desaparecida' }[] = [];
  for (let i = 0; i < d.objetos.length; i++) {
    const causa = causaDeRelectura(d.objetos[i]!, d.umbralSegundos, d.ahora);
    if (causa !== null) candidatos.push({ i, causa });
  }
  if (candidatos.length === 0) return { objetos: d.objetos, relecturas };

  // Con un backoff por cuota activo la relectura no se intenta: Meta ya frenó a
  // esta app y sumarle lecturas alarga el castigo sobre las escrituras, que son
  // lo que el usuario pidió. Se lee una sola vez y sólo cuando hay candidatos.
  const backoff = await segundosBackoffRestante();

  const objetos = d.objetos.slice();
  const limite = Date.now() + PRESUPUESTO_RELECTURA_MS;

  for (let k = 0; k < candidatos.length; k++) {
    const { i, causa } = candidatos[k]!;
    const o = objetos[i]!;
    const base: RelecturaPreflight = {
      objectId: o.objectId,
      causa,
      syncedAt: o.syncedAt,
      edadSegundos: edadEnSegundos(o.syncedAt, d.ahora),
      local: o.status,
      real: null,
      localEffective: o.effectiveStatus,
      realEffective: null,
      resultado: 'no_intentada',
      detalle: null,
    };

    if (backoff !== null) {
      relecturas.set(o.objectId, {
        ...base,
        detalle: `hay un backoff por cuota activo: quedan ${backoff} segundos y no se le suman lecturas`,
      });
      continue;
    }
    if (k >= TOPE_RELECTURA) {
      relecturas.set(o.objectId, {
        ...base,
        detalle: `el lote traía ${candidatos.length} objetos para revalidar y se releyeron los primeros ${TOPE_RELECTURA}`,
      });
      continue;
    }
    const restante = limite - Date.now();
    if (restante <= 0) {
      relecturas.set(o.objectId, {
        ...base,
        detalle: `se agotó el presupuesto de ${PRESUPUESTO_RELECTURA_MS} ms de la relectura`,
      });
      continue;
    }

    let leido: MetaObjetoLeido | null | typeof AGOTADO;
    try {
      leido = await conPresupuesto(fetchObjeto(o.objectId, d.level), restante);
    } catch (e) {
      // R6.2: un fallo de la lectura NO bloquea la acción. Se decide con el dato
      // de la base y queda anotado que no se pudo revalidar.
      relecturas.set(o.objectId, {
        ...base,
        resultado: 'error',
        detalle: (e instanceof Error ? e.message : String(e)).slice(0, 200),
      });
      continue;
    }

    if (leido === AGOTADO) {
      relecturas.set(o.objectId, {
        ...base,
        resultado: 'error',
        detalle: `la lectura no volvió dentro de los ${restante} ms que quedaban de presupuesto`,
      });
      continue;
    }
    if (leido === null) {
      // Meta no devolvió el objeto. Es la MISMA evidencia con la que la
      // Sync_Jerarquia pone `desaparecido_at`, así que no se toca el estado
      // local: se decide con la base y se anota. Marcar el objeto es tarea del
      // sync, no de un preflight de lectura.
      relecturas.set(o.objectId, {
        ...base,
        resultado: 'no_encontrado',
        detalle: 'Meta no devolvió el objeto en la relectura',
      });
      continue;
    }

    // El estado real reemplaza al de la base para decidir la Omisión (R6.3).
    const discrepa = leido.status !== o.status || leido.effectiveStatus !== o.effectiveStatus;
    objetos[i] = { ...o, status: leido.status, effectiveStatus: leido.effectiveStatus };
    relecturas.set(o.objectId, {
      ...base,
      real: leido.status,
      realEffective: leido.effectiveStatus,
      resultado: discrepa ? 'discrepa' : 'coincide',
      detalle: null,
    });
  }

  return { objetos, relecturas };
}

// ─── El preflight ────────────────────────────────────────────────────────────

export async function preflight(d: {
  level: NivelAds;
  accountId: string;
  accion: AccionAds;
  objectIds: string[];
  budgetEur?: number;
  copias?: number;
  inicio?: string;
  modo?: ModoRenombre;
  ahora?: Date;
}): Promise<ResultadoPreflight> {
  const ahora = d.ahora ?? new Date();

  // 1. Objetos reales, de ESTA cuenta, de una cuenta activa (R17 c4). Un id de
  //    otra cuenta o inventado no aparece en el JOIN y se rechaza el lote.
  const objetosLeidos = await leerObjetos(d.level, d.accountId, d.objectIds);
  const faltantes = d.objectIds.filter((id, i) => !objetosLeidos[i] || objetosLeidos[i]!.objectId !== id);
  if (faltantes.length > 0) {
    return {
      ok: false,
      error: {
        motivo: 'objetos_invalidos',
        detalle: `objetos que no existen, no pertenecen a la cuenta ${d.accountId} o están en una cuenta inactiva: ${faltantes.slice(0, 10).join(', ')}`,
      },
    };
  }
  const objetos = objetosLeidos as ObjetoPreflight[];

  // 2. Una sola cuenta → una sola Zona_Cuenta (R17 c12).
  const zonaRow = await q1<{ tz: string }>(
    `SELECT COALESCE(timezone, $2) AS tz FROM ad_accounts WHERE account_id = $1`,
    [d.accountId, TZ_DEFAULT],
  );
  const zona = zonaRow?.tz ?? TZ_DEFAULT;

  // 3. Techo_Absoluto y Tope_Lote, SOLO de settings (R17 c5, c7), más el umbral
  //    de Frescura_Objeto que decide qué objetos se releen (R6.2).
  const cfg = await topesDeSettings();
  const topes = { techoEur: cfg.techoEur, topeLoteEur: cfg.topeLoteEur };

  // 4. Backoff por cuota activo → rechazo de las duplicaciones en lote ANTES
  //    de cualquier llamada (R17 c11).
  if (d.accion === 'duplicate') {
    const segundos = await segundosBackoffRestante();
    if (segundos !== null) {
      return {
        ok: false,
        error: {
          motivo: 'backoff_activo',
          detalle: `hay un backoff por cuota activo: quedan ${segundos} segundos antes de poder duplicar`,
        },
      };
    }
    // 5. Topes de la corrida (R17 c15): 20 orígenes, 100 Copias.
    if (d.objectIds.length > 20) {
      return {
        ok: false,
        error: {
          motivo: 'muchas_copias',
          detalle: 'se aceptan hasta 20 objetos origen por corrida de duplicación',
        },
      };
    }
    const k = d.copias ?? 1;
    if (!Number.isInteger(k) || k < 1 || k > 5 || d.objectIds.length * k > 100) {
      return {
        ok: false,
        error: {
          motivo: 'muchas_copias',
          detalle: 'se aceptan de 1 a 5 copias por objeto y hasta 100 copias por corrida',
        },
      };
    }
    // 6. Fecha de inicio (R10 c18): posterior al pedido en Zona_Cuenta y no más
    //    de 6 meses.
    if (d.inicio !== undefined) {
      const instante = new Date(d.inicio);
      const tope = ahora.getTime() + 180 * 24 * 3600 * 1000;
      if (Number.isNaN(instante.getTime()) || instante.getTime() <= ahora.getTime() || instante.getTime() > tope) {
        return {
          ok: false,
          error: {
            motivo: 'fecha_invalida',
            detalle: 'el inicio tiene que ser posterior al momento actual y no más de 6 meses después, interpretado en la zona de la cuenta',
          },
        };
      }
    }
  }

  // 7. Programación (R11 c2, c5): entre el instante actual y 365 días.
  if (d.accion === 'schedule') {
    const instante = d.inicio !== undefined ? new Date(d.inicio) : new Date(NaN);
    const tope = ahora.getTime() + 365 * 24 * 3600 * 1000;
    if (Number.isNaN(instante.getTime()) || instante.getTime() <= ahora.getTime() || instante.getTime() > tope) {
      return {
        ok: false,
        error: {
          motivo: 'fecha_invalida',
          detalle: 'el inicio tiene que ser posterior al momento actual y no más de 365 días después, interpretado en la zona de la cuenta',
        },
      };
    }
  }

  // 8. Presupuesto: todas las verificaciones ANTES de cualquier cambio
  //    (R13 c12). Aplica también al presupuesto que llega con una duplicación.
  let minimoDiarioEur: number | null = null;
  if (d.budgetEur !== undefined && (d.accion === 'budget_set' || d.accion === 'duplicate')) {
    if (d.budgetEur > topes.techoEur) {
      return {
        ok: false,
        error: {
          motivo: 'tope_absoluto',
          detalle: `${eur(d.budgetEur)} pasa el máximo de ${eur(topes.techoEur)} por objeto`,
        },
      };
    }
    let delta = 0;
    const afectados: string[] = [];
    for (const o of objetos) {
      const actual = o.dailyBudget !== null ? o.dailyBudget / 100 : 0;
      if (d.budgetEur > actual) delta += d.budgetEur - actual;
      if (o.budgetMode === 'lifetime') {
        return {
          ok: false,
          error: {
            motivo: 'presupuesto_lifetime_no_soportado',
            detalle: `objetos con presupuesto TOTAL en lugar de diario (este panel edita únicamente presupuestos diarios): ${o.objectId}`,
          },
        };
      }
      if (o.currency !== 'EUR') {
        return {
          ok: false,
          error: {
            motivo: 'moneda_no_soportada',
            detalle: `objetos cuya cuenta no factura en EUR: ${o.objectId} (${o.currency ?? '?'})`,
          },
        };
      }
      if (o.budgetLevel !== d.level) {
        return {
          ok: false,
          error: {
            motivo: 'sin_presupuesto_en_este_nivel',
            detalle: `objetos cuyo presupuesto vive en otro nivel de la jerarquía: ${o.objectId} (${o.budgetLevel ?? 'ninguno'})`,
          },
        };
      }
      afectados.push(o.objectId);
    }
    if (delta > topes.topeLoteEur) {
      return {
        ok: false,
        error: {
          motivo: 'tope_lote',
          detalle: `el lote sumaría ${eur(delta)} de presupuesto nuevo, más que el máximo de ${eur(topes.topeLoteEur)} por corrida`,
        },
      };
    }
    // Mínimo diario que informa la cuenta (R13 c7): lectura a Meta, nunca una
    // escritura. null = no se sabe, y entonces no se rechaza por eso.
    const minimoUnidades = await fetchMinimoPresupuesto(d.accountId).catch(() => null);
    minimoDiarioEur = minimoUnidades === null ? null : minimoUnidades / 100;
    if (minimoDiarioEur !== null && d.budgetEur < minimoDiarioEur) {
      return {
        ok: false,
        error: {
          motivo: 'presupuesto_bajo_el_minimo',
          detalle: `${eur(d.budgetEur)} está por debajo del mínimo diario de ${eur(minimoDiarioEur)} que informa la cuenta (${afectados.slice(0, 5).join(', ')})`,
        },
      };
    }
  }

  // 9. Relectura selectiva contra Meta (R6.2, R6.3): sólo para `pause` y
  //    `activate`, y sólo sobre los objetos cuyo dato local está viejo o
  //    marcado. Va ANTES de la revalidación porque su único efecto es cambiar el
  //    estado con el que la Previsualizacion decide la Omisión. Son LECTURAS:
  //    ninguna rama de acá escribe en Meta ni en la base.
  const { objetos: objetosReales, relecturas } = await relecturaSelectiva({
    accion: d.accion,
    level: d.level,
    objetos,
    umbralSegundos: cfg.umbralFrescuraSegundos,
    ahora,
  });

  // 10. Revalidación con el MISMO módulo que usó el cliente (R14 c10): lo que el
  //    usuario confirmó no puede dar distinto acá.
  const filas = objetosReales.map((o) => aMetricas(o, d.level));
  const params: ParametrosAccion = {
    copias: d.copias,
    budgetEur: d.budgetEur,
    inicio: d.inicio,
    modo: d.modo,
    desglose: d.accion === 'duplicate' ? { porObjeto: await desgloseDesdeBase(d.level, d.objectIds) } : undefined,
    // R6.4: el estado de los antepasados, que `MetricasObjeto` no tiene dónde
    // llevar. Se pasa siempre y no sólo para `activate` —la que hoy lo lee— para
    // que el dato esté disponible sin una condición más; `leerObjetos` ya lo
    // trajo en la misma consulta y armar el mapa no cuesta una vuelta de red.
    // La relectura selectiva no lo toca: sólo reemplaza `status` y
    // `effectiveStatus` del objeto, nunca los de su padre.
    padres: new Map(
      objetosReales.map((o) => [o.objectId, { campania: o.statusCampania, conjunto: o.statusConjunto }]),
    ),
  };
  const previa = calcularPrevisualizacion(d.accion, d.level, filas, d.objectIds, params, {
    techoEur: topes.techoEur,
    topeLoteEur: topes.topeLoteEur,
    minimoDiarioEur,
  });
  if (!previa.completa) {
    return {
      ok: false,
      error: {
        motivo: 'previsualizacion_incompleta',
        detalle: 'los datos del servidor no alcanzaron para revalidar la Previsualizacion del cliente',
      },
    };
  }

  return { ok: true, objetos: objetosReales, previa, topes, minimoDiarioEur, zona, relecturas };
}

// ─── Auditoría: abrir y cerrar filas de ad_actions ───────────────────────────

/**
 * La explicación en castellano la arma el SERVIDOR, de 1 a 300 caracteres,
 * nombrando la acción, el nivel, el nombre del objeto y la cuenta, y SIN aceptar
 * texto provisto por el cliente (R15 c5).
 *
 * `extra` lo usan las SEIS acciones (task 14.2): `pause` y `activate` lo
 * ignoraban, y ahí es donde la Discrepancia tiene que aparecer (R6.3). El
 * separador es el mismo `: ` que ya usaba `budget_set`, así que las tres frases
 * de estado se leen igual. Sigue sin ser texto del cliente: lo único que se pasa
 * por acá son frases que armó este módulo.
 */
export function armarExplicacion(d: {
  accion: AccionAds;
  nivel: NivelAds;
  objectName: string | null;
  objectId: string;
  accountId: string;
  extra?: string;
}): string {
  const nombre = d.objectName ?? d.objectId;
  let s: string;
  switch (d.accion) {
    case 'pause':
      s = `Manual: se pausó el ${ETIQUETA_NIVEL[d.nivel]} «${nombre}» (${d.accountId})${d.extra ? `: ${d.extra}` : ''}.`;
      break;
    case 'activate':
      s = `Manual: se activó el ${ETIQUETA_NIVEL[d.nivel]} «${nombre}» (${d.accountId})${d.extra ? `: ${d.extra}` : ''}.`;
      break;
    case 'budget_set':
      s = `Manual: se fijó el presupuesto diario del ${ETIQUETA_NIVEL[d.nivel]} «${nombre}» (${d.accountId})${d.extra ? `: ${d.extra}` : ''}.`;
      break;
    case 'duplicate':
      s = `Manual: se duplicó el ${ETIQUETA_NIVEL[d.nivel]} «${nombre}» (${d.accountId})${d.extra ? ` como ${d.extra}` : ''}, con sus descendientes, todos pausados.`;
      break;
    case 'rename':
      s = `Manual: se renombró el ${ETIQUETA_NIVEL[d.nivel]} «${nombre}» (${d.accountId})${d.extra ? ` a ${d.extra}` : ''}.`;
      break;
    case 'schedule':
      s = `Manual: se programó el inicio del ${ETIQUETA_NIVEL[d.nivel]} «${nombre}» (${d.accountId})${d.extra ? ` para ${d.extra}` : ''}.`;
      break;
    default:
      s = `Manual: acción ${d.accion} sobre el ${ETIQUETA_NIVEL[d.nivel]} «${nombre}» (${d.accountId}).`;
  }
  return s.slice(0, 300);
}

export async function abrirAccion(d: {
  accountId: string;
  nivel: NivelAds;
  objectId: string;
  objectName: string | null;
  accion: AccionAds;
  before: string | null;
  after: string | null;
  explicacion: string;
  actorHint: string;
  metrics?: Record<string, unknown>;
}): Promise<number> {
  const row = await q1<{ id: string }>(
    `INSERT INTO ad_actions
       (source, account_id, level, object_id, object_name, action, before_value, after_value,
        dry_run, ok, estado, explicacion, metrics, actor_hint)
     VALUES ('manual', $1, $2, $3, $4, $5, $6, $7, false, false, 'pendiente', $8, $9::jsonb, $10)
     RETURNING id`,
    [
      d.accountId,
      d.nivel,
      d.objectId,
      d.objectName,
      d.accion,
      d.before,
      d.after,
      d.explicacion,
      JSON.stringify(d.metrics ?? {}),
      d.actorHint.slice(0, 200),
    ],
  );
  return Number((row as { id: string }).id);
}

export async function cerrarAccion(
  id: number,
  estado: 'confirmado' | 'fallido' | 'indeterminado' | 'omitido',
  extra: { error?: string | null; metrics?: Record<string, unknown> } = {},
): Promise<void> {
  // El cierre ocurre dentro de los 5 s del fin de la llamada (R15 c3): lo
  // garantiza el llamador, que await-ea este UPDATE apenas vuelve de Meta.
  //
  // `undefined` VIAJA COMO NULL DE SQL, NO COMO JSON null (task 14.2). El
  // `JSON.stringify(extra.metrics ?? null)` que estaba acá antes mandaba el texto
  // `'null'`, que `$5::jsonb` convierte en un JSON null: no es SQL NULL, así que
  // el CASE tomaba la otra rama y corría `metrics || 'null'::jsonb`. Postgres
  // resuelve la concatenación de un objeto con un valor que no es objeto
  // ARMANDO UN ARRAY, así que cada cierre sin métricas convertía `{...}` en
  // `[{...}, null]` y se llevaba puesto lo que la fila tenía. En la base de hoy
  // se ve: las filas manuales cerradas quedaron con `metrics = [{}, null]`.
  //
  // Con `{}` no se notaba porque no había nada que perder. Con la Discrepancia
  // sí: `abrirAccion` la escribe ANTES de la llamada —es el dato con el que se
  // decidió, y tiene que estar aunque el proceso se muera a mitad— y el cierre
  // de una Omisión no le pasa métricas nuevas. Sin este arreglo, R6.3 se
  // cumpliría durante los milisegundos que separan el INSERT del UPDATE.
  await q(
    `UPDATE ad_actions
        SET estado = $2, ok = $3, error = $4,
            metrics = CASE WHEN $5::jsonb IS NULL THEN metrics ELSE metrics || $5::jsonb END
      WHERE id = $1`,
    [
      id,
      estado,
      estado === 'confirmado',
      extra.error ?? null,
      extra.metrics === undefined ? null : JSON.stringify(extra.metrics),
    ],
  );
}
