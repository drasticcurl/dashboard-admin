/**
 * Los plazos de una acción de estado (`pause`/`activate`), en UN solo lugar.
 *
 * ## Por qué existe, y por qué no es cosmética
 *
 * El plazo que el cliente le da a un click tiene que ser MAYOR que el peor caso
 * del servidor: un plazo más corto abandona pedidos que estaban por confirmarse y
 * los convierte en desenlaces indeterminados, que es peor que la espera que este
 * spec vino a bajar. Esa desigualdad sólo se puede verificar si los dos lados
 * salen del MISMO número.
 *
 * Antes de este módulo los timeouts de Meta eran dos `AbortSignal.timeout` con el
 * literal 30 000 adentro, en `lib/ads/meta.ts`, y cualquier cuenta del peor caso
 * era una COPIA de esos literales. Con las constantes acá, la desigualdad se evalúa contra
 * el número que las llamadas usan de verdad: **si alguien baja el timeout de
 * `enviar`, el plazo del cliente baja con él** en lugar de quedar mintiendo.
 *
 * ## Este módulo es puro y no importa NADA
 *
 * Lo leen `lib/ads/meta.ts` (servidor) y `app/(panel)/anuncios/GestorAnuncios.tsx`
 * (`'use client'`). Si alguna vez importa `pg`, `lib/db` o `next/headers`, el
 * bundle del cliente se rompe.
 */

/**
 * Deadline del POST de escritura a Meta: el `AbortSignal.timeout` de `enviar`
 * (`lib/ads/meta.ts`), que es el único camino de escritura de estado.
 *
 * El vencimiento NO se clasifica como fallo: `enviar` lo devuelve como
 * `indeterminado`, porque un POST cortado por timeout pudo haberse aplicado en
 * Meta igual.
 */
export const PLAZO_META_ESCRITURA_MS = 30_000;

/**
 * Deadline del GET de lectura a Meta: el `AbortSignal.timeout` de `pedir`
 * (`lib/ads/meta.ts`), que es el que usa `fetchObjeto`.
 *
 * Entra dos veces en el camino de un click: la relectura del preflight
 * (acotada además por `PRESUPUESTO_RELECTURA_MS`) y la de `refrescarJerarquia`.
 * Es el presupuesto de un cron, no el de alguien esperando que un interruptor
 * conteste, y por eso el preflight le pone su propio tope por encima.
 */
export const PLAZO_META_LECTURA_MS = 30_000;

/**
 * Presupuesto de tiempo de TODA la relectura del preflight, en milisegundos.
 *
 * Es del LOTE ENTERO y no por objeto: `relecturaSelectiva` calcula el límite una
 * sola vez antes del loop, así que en el peor caso de `n` objetos este término va
 * FUERA del `n ×`. Para un objeto da lo mismo; para 20 la diferencia es
 * `4 s + 20 × 60 s` contra `20 × 64 s`.
 *
 * `TOPE_RELECTURA` (`lib/ads/acciones.ts`) acota la CANTIDAD de llamadas; esto
 * acota la espera, que es lo que el usuario siente. 4 s alcanzan para unas 10
 * lecturas a la latencia habitual de la Graph API y, cuando la latencia se va,
 * cortan a los 4 s en lugar de a los 10 × `PLAZO_META_LECTURA_MS`.
 *
 * Cada llamada se corre contra el REMANENTE del presupuesto, no contra el total:
 * una sola llamada colgada se come su parte y las siguientes ya no se intentan,
 * en lugar de multiplicar la espera por la cantidad de candidatos.
 *
 * **`lib/ads/acciones.ts` lo RE-EXPORTA** y no lo declara: `acciones.relectura.test.ts`
 * y `togglePlazo.test.ts` lo importan desde ahí y uno de los dos lo interpola en el
 * texto de «presupuesto agotado», así que mover el import de esos tests sería
 * editarlos por un cambio que no cambia ningún valor.
 */
export const PRESUPUESTO_RELECTURA_MS = 4_000;

/**
 * Lo que se le reserva al request por encima de las llamadas a Meta: preflight,
 * consultas a la base, `abrirAccion`/`cerrarAccion` y el viaje HTTP.
 *
 * La cota del peor caso es sobre las llamadas a Meta y NO sobre el request
 * entero: nada de eso otro tiene deadline, así que un Postgres que se arrastra
 * puede pasarse de la cota. Esta holgura es lo que cubre ese margen y **es una
 * estimación, no una medición**: no hay filas de producción con tiempos reales de
 * clicks.
 */
export const HOLGURA_CLIENTE_MS = 10_000;

/**
 * ¿La relectura de la jerarquía está DENTRO del tiempo que el usuario espera?
 *
 * Es el único punto donde vive el acoplamiento entre la tanda C (el refresco
 * diferido) y la tanda D (los plazos del cliente) de `toggle-conjuntos-entrega`,
 * y por eso es una función y no un número suelto adentro de la suma: en el peor
 * caso del servidor, el término `PLAZO_META_LECTURA_MS` está si y sólo si esto
 * devuelve `true`.
 *
 * **HOY ES `false`, y es el estado real del route.** La task 14.2 sacó
 * `refrescarJerarquia` del `await` de `app/api/ads/acciones/route.ts`: ahora pasa
 * por `diferir(...)` de `app/api/ads/acciones/_diferir.ts`, así que el GET a Meta
 * —con su propio `AbortSignal.timeout` de `PLAZO_META_LECTURA_MS`— corre DESPUÉS
 * de que la respuesta salió. El peor caso por objeto pasó de `4 s + 30 s + 30 s`
 * a `4 s + 30 s`.
 *
 * ## SU VALOR TIENE QUE COINCIDIR CON LO QUE EL ROUTE HACE DE VERDAD
 *
 * Este flag no es una preferencia ni una perilla: es una afirmación sobre otro
 * archivo. Si dice `false` y el route todavía espera la relectura, el plazo del
 * cliente sale 30 s más corto que el peor caso, y un click cuyo servidor tarda
 * 64 s se abandona a los 44 s. Eso convierte un pedido que estaba por confirmarse
 * en un desenlace `indeterminado` sobre una escritura que el usuario no sabe si
 * ocurrió, que es exactamente lo que R2.7 prohíbe y es peor que la espera que
 * este spec vino a bajar.
 *
 * **QUIÉN LO VERIFICA: `app/api/ads/acciones/route.diferido.test.ts`**, caso (a).
 * Ese test corre el POST del route con un `fetchObjeto` bloqueado, mide si la
 * respuesta salió antes de que la relectura volviera, y afirma que este flag es
 * igual a lo que midió. O sea que la guarda no es este comentario ni la memoria de
 * nadie: cambiar este valor sin haber movido la llamada —o mover la llamada sin
 * cambiar este valor— deja la suite en rojo. Verificado a mano una vez, con la
 * salida textual anotada en el docblock de ese archivo.
 *
 * ## EL ESCENARIO PROHIBIDO
 *
 * Poner `false` acá mientras la tanda C **no está desplegada**. No alcanza con que
 * el código del route esté en la rama: el número tiene que corresponder al
 * servidor que le contesta al cliente. Los otros dos órdenes son seguros: C antes
 * de D calcula el plazo una sola vez con 34 s (fila: 44 s); D antes de C lo
 * calcula con 64 s (fila: 74 s) y **baja solo** cuando C entra, porque los dos
 * números salen de esta misma suma.
 *
 * ## LA COTA ES SOBRE LAS LLAMADAS A META, NO SOBRE EL REQUEST ENTERO
 *
 * Lo que este flag mueve es un timeout de Meta, y el peor caso que lo consume
 * —`peorCasoEstadoMs`, acá abajo— suma timeouts de Meta y nada más. El preflight, las consultas
 * a la base y `abrirAccion`/`cerrarAccion` **no tienen deadline**, así que el
 * request puede pasarse de la cota si Postgres se arrastra. `HOLGURA_CLIENTE_MS`
 * es lo único que se le reserva a eso y **es una estimación, no una medición**: no
 * hay filas de producción con tiempos reales de clicks. Por eso R2.6 —el
 * vencimiento del plazo tiene que ser `indeterminado` y nunca un fallo— existe y
 * no es opcional: este número puede quedar corto sin que nada de acá se entere.
 */
export function refrescoEnCaminoCritico(): boolean {
  return false;
}
/**
 * El peor caso del SERVIDOR para una acción de estado sobre `n` objetos, en ms:
 * la suma de los deadlines de las llamadas a Meta que el camino confirmado hace.
 *
 * ## `PRESUPUESTO_RELECTURA_MS` va FUERA del `n ×`, y es una corrección al reporte
 *
 * El material de entrada de este spec contaba el peor caso como `n × 64 s`, o sea
 * con el presupuesto de la relectura adentro del producto. Es incorrecto:
 * `relecturaSelectiva` (`lib/ads/acciones.ts`) calcula su `limite` **una sola vez
 * antes del loop**, así que esos 4 s son el presupuesto del LOTE ENTERO y no de
 * cada objeto. Para un objeto da lo mismo —64 s de las dos formas, que es la razón
 * por la que el error no se veía— pero para 20 la diferencia es `4 + 20 × 60 =
 * 1204 s` contra `20 × 64 = 1280 s`, y el número que el plazo del lote usa es el
 * primero.
 *
 * ## Qué NO está en esta suma, y por eso es una COTA y no una medición
 *
 * Sólo llamadas a Meta. El preflight, las consultas a la base,
 * `abrirAccion`/`cerrarAccion` y el viaje HTTP **no tienen deadline**, así que el
 * request puede pasarse de esta cota si Postgres se arrastra.
 * `HOLGURA_CLIENTE_MS` es lo único que se le reserva a eso, y es una estimación:
 * no hay filas de producción con tiempos reales de clicks. Por eso R2.6 —el
 * vencimiento tiene que ser `indeterminado` y nunca un fallo— no es opcional.
 *
 * @param n cantidad de objetos del pedido
 * @param refrescoDentro si la relectura de la jerarquía está en el camino
 *   crítico. **Ningún llamador de producción lo pasa**: el default es
 *   `refrescoEnCaminoCritico()`, que es el único lugar donde vive el acoplamiento
 *   C↔D y el único que el test del route verifica contra la realidad. Existe para
 *   que `plazos.test.ts` pueda evaluar los DOS mundos del flag en la misma
 *   corrida —hoy el flag es `false`, así que sin este parámetro los números
 *   pre-C quedarían escritos y nunca ejecutados—. Pasarlo desde código de
 *   producción sería saltear esa guarda: no se hace.
 */
export function peorCasoEstadoMs(
  n: number,
  refrescoDentro: boolean = refrescoEnCaminoCritico(),
): number {
  const porObjeto = PLAZO_META_ESCRITURA_MS + (refrescoDentro ? PLAZO_META_LECTURA_MS : 0);
  return PRESUPUESTO_RELECTURA_MS + n * porObjeto;
}

/**
 * El plazo que el CLIENTE le da a una acción de estado sobre `n` objetos, en ms.
 *
 * Es el peor caso del servidor más la holgura, y esa desigualdad
 * —`plazoClienteEstadoMs(n) > peorCasoEstadoMs(n)` para todo `n`— es literalmente
 * R2.7: un plazo menor abandona pedidos que estaban por confirmarse y los
 * convierte en desenlaces `indeterminado`, que es peor que la espera que este
 * spec vino a bajar.
 *
 * ## EL PLAZO CRECE LINEALMENTE CON `n`, Y ESO ES UN PISO, NO UN OBJETIVO DE UX
 *
 * Con 20 objetos son 614 s (post-C) o 1214 s (pre-C): diez o veinte minutos. **No
 * es una decisión de producto: es lo que R2.7 impone.** Lo que baja la espera es
 * la tanda C —parte el peor caso por objeto casi al medio— y lo que la hace
 * legible es la señal de «en curso» de R2.15.
 *
 * **Se evaluó ponerle un techo y se descartó**: con los mismos 300 s de
 * `duplicate`, todo lote de más de 5 objetos volvería a violar R2.7
 * (`peorCasoEstadoMs(5) = 154 s` está bien, `peorCasoEstadoMs(10) = 304 s` ya se
 * pasa). Un techo no acorta el servidor, sólo hace que el cliente deje de
 * esperarlo.
 *
 * Los números, para que no haya que hacer la cuenta:
 *
 * | `n` | peor caso post-C | plazo post-C | peor caso pre-C | plazo pre-C |
 * |---|---|---|---|---|
 * | 1 | 34 s | **44 s** | 64 s | **74 s** |
 * | 2 | 64 s | 74 s | 124 s | 134 s |
 * | 20 | 604 s | **614 s** | 1204 s | **1214 s** |
 *
 * @param refrescoDentro ver `peorCasoEstadoMs`: es un parámetro de test y ningún
 *   llamador de producción lo pasa.
 */
export function plazoClienteEstadoMs(
  n: number,
  refrescoDentro: boolean = refrescoEnCaminoCritico(),
): number {
  return peorCasoEstadoMs(n, refrescoDentro) + HOLGURA_CLIENTE_MS;
}
