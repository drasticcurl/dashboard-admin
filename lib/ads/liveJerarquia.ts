/**
 * Jerarquía en vivo: refresca estados, presupuestos y nombres desde Meta cuando
 * el usuario aprieta Actualizar en el gestor de anuncios (R4.1).
 *
 * EL PROBLEMA
 * `lib/ads/live.ts` resolvió esto para el gasto: el render sincroniza y la
 * pantalla muestra un número que es de hace segundos. La Jerarquía quedó afuera,
 * y su único disparador siguió siendo el cron de 15 minutos. El resultado es un
 * panel que muestra dos cosas con dos edades: el gasto al día y, al lado, un
 * estado y un presupuesto que pueden ser de hace un cuarto de hora. Tocás algo
 * en el administrador de anuncios de Meta, volvés al panel, y el panel te dice
 * lo contrario de lo que acabás de hacer. Peor: el Preflight DECIDE con esa
 * copia, así que un dato viejo no solo se muestra mal, además omite acciones.
 *
 * CÓMO
 * Misma forma que `live.ts`, con las mismas cuatro defensas, porque el problema
 * es el mismo problema:
 *
 *   1. TTL (300 s por defecto): un freno propio, independiente del del gasto
 *      (R4.2). Apretar el botón diez veces seguidas hace UNA llamada.
 *   2. Timeout propio (10 s por defecto; el botón pide 30 s): si Meta tarda, la
 *      pantalla se dibuja con las filas que ya están guardadas en vez de quedarse
 *      colgada (R4.3). El sync sigue de fondo y el próximo pedido lo encuentra
 *      escrito.
 *   3. Nunca tira: un error de Meta no puede dejar el gestor sin filas (R4.4).
 *      Se devuelve en `error` y la barra de frescura lo muestra al lado de la
 *      edad.
 *   4. Promise en vuelo compartido, así dos pestañas apretando el botón a la vez
 *      comparten un solo sync en lugar de disparar dos.
 *
 * POR QUÉ LOS NÚMEROS SON MÁS ALTOS QUE LOS DEL GASTO
 * El Sync_Gasto es UNA llamada a Insights por cuenta. La Sync_Jerarquia son
 * cuatro por cuenta (campañas, conjuntos, anuncios y la lectura DSA), más los
 * upserts de los tres niveles en una transacción. Es varias veces más caro y
 * cambia mucho menos seguido: los estados y los presupuestos se mueven cuando
 * alguien los mueve, no minuto a minuto como el gasto. Un TTL de 60 s acá sería
 * gastar cupo de la API para volver a traer lo mismo.
 *
 * QUIÉN LLAMA A ESTO
 * Sólo `/api/data/ads`, y sólo cuando el pedido viene con `forzar` (R4.8). El
 * polling automático NO la dispara a propósito: es un sync por cuenta y por
 * nivel, y multiplicarlo por pestaña abierta es exactamente lo que el cupo de
 * Meta no perdona. El cron de 15 minutos sigue existiendo y no es redundante
 * (R4.6): cubre las horas en las que nadie tiene el panel abierto.
 */

import { q1 } from '../db';
import { sincronizarJerarquia } from './jerarquia';

/**
 * Segundos que se considera "fresca" la Jerarquía de una cuenta. Configurable
 * por si Meta aprieta, con su propio nombre y no compartido con el del gasto:
 * son dos sincronizaciones con costos distintos y tienen que poder moverse por
 * separado (R4.2).
 */
function ttlSegundos(): number {
  const n = Number(process.env.ADS_JERARQUIA_TTL_SECONDS ?? 300);
  return Number.isFinite(n) && n >= 0 ? n : 300;
}

/** Cuánto se espera al sync antes de dibujar con lo que ya está guardado. */
function timeoutMs(): number {
  const n = Number(process.env.ADS_JERARQUIA_TIMEOUT_MS ?? 10_000);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}

/**
 * ACÁ NO VA EL `pisoDeFrescura` DE `live.ts`, Y ES UNA DECISIÓN, NO UN OLVIDO.
 *
 * Ese margen existe para un caso concreto: un llamador que pide a intervalo
 * FIJO igual al TTL. Como el reloj se escribe cuando el sync TERMINA, el tick
 * siguiente ve una edad de TTL menos lo que tardó la llamada, la lee como
 * "todavía fresco", y el dato se mueve cada dos ticks en lugar de cada uno. El
 * margen absorbe la duración del sync.
 *
 * La Jerarquía no tiene ese llamador, por diseño: R4.8 le prohíbe al polling
 * dispararla, y su único llamador es el Boton_Actualizar, que es un click y no
 * un reloj — y que además pasa `forzar`, o sea que se saltea la comparación
 * contra el TTL de todos modos. No hay tick que proteger.
 *
 * Y el margen no es gratis: baja el TTL efectivo. Ponerlo acá debilitaría el
 * único freno que le queda a un sync caro, para resolver un problema que no
 * existe. Si algún día algo llega a pedir la Jerarquía a intervalo fijo, el
 * margen se agrega en ese momento, con el tick concreto a la vista.
 */

export type FrescuraJerarquia = {
  /** Cuándo terminó la última Sync_Jerarquia de la cuenta (ISO), null si nunca. */
  syncedAt: string | null;
  /** Antigüedad en segundos, null si nunca se sincronizó. */
  ageSeconds: number | null;
  /** Se disparó una llamada a Meta en este pedido. */
  refreshed: boolean;
  /** Error de la última corrida, si hay. La pantalla sigue con lo guardado. */
  error: string | null;
};

/**
 * La edad y el error de UNA cuenta, en una sola consulta.
 *
 * Sin `min()` ni `max()`, al revés que `leerFrescura` de `live.ts`: el gasto se
 * sincroniza para todas las cuentas de una vez y ahí la más atrasada es la que
 * manda, pero la Jerarquía se pide por cuenta y el gestor muestra una cuenta a
 * la vez. Agregar entre cuentas diría que la jerarquía que estoy mirando está
 * atrasada porque OTRA, que no está en pantalla, falló.
 *
 * El error viaja en la MISMA consulta que la hora porque son las dos mitades de
 * un solo hecho: `anotarCorrida` avanza el reloj también cuando la corrida falla
 * (así se sabe que se intentó, y así el TTL sigue frenando cuando Meta está
 * rechazando llamadas), de modo que sin el error al lado un fallo se leería como
 * un dato fresco.
 *
 * El filtro por `active AND platform = 'meta'` es el mismo con el que
 * `cuentasActivas` arma la lista que `sincronizarJerarquia` va a recorrer. Que el
 * lector y el sincronizador describan el mismo conjunto es lo que hace que la
 * respuesta signifique algo: una cuenta que quedó inactiva no se sincroniza más,
 * y devolver su reloj viejo sugeriría que sí. Sin fila, la respuesta es "nunca
 * sincronizado", que es exactamente lo que pasa con esa cuenta.
 */
async function leerFrescura(accountId: string): Promise<Omit<FrescuraJerarquia, 'refreshed'>> {
  const row = await q1<{ synced_at: string | null; age: string | null; err: string | null }>(
    `SELECT last_hierarchy_sync_at::text AS synced_at,
            EXTRACT(EPOCH FROM (now() - last_hierarchy_sync_at))::text AS age,
            last_hierarchy_sync_error AS err
       FROM ad_accounts
      WHERE account_id = $1 AND active AND platform = 'meta'`,
    [accountId],
  );
  if (!row || row.synced_at === null) {
    return { syncedAt: null, ageSeconds: null, error: row?.err ?? null };
  }
  return {
    syncedAt: row.synced_at,
    ageSeconds: Math.round(Number(row.age)),
    error: row.err ?? null,
  };
}

/**
 * Los sync en vuelo, POR CUENTA, no la única variable de `live.ts`.
 *
 * `syncAdSpend` es una corrida global: dos pedidos simultáneos quieren lo mismo
 * y compartir el promise es exactamente lo correcto. Acá el sync es de UNA
 * cuenta, así que una sola variable haría que un pedido de la cuenta B se
 * quedara esperando el sync de la cuenta A y volviera diciendo `refreshed: true`
 * sin haber traído nada de lo suyo. Con la clave por cuenta, dos cuentas
 * distintas disparan dos sync y cada una espera el propio.
 *
 * Los promises NUNCA rechazan: el catch está adentro. Así el `Promise.race` de
 * abajo no puede tirar, y un fallo de Meta no deja un rechazo sin manejar cuando
 * gana el timeout (que es el caso normal cuando Meta anda lento: el llamador ya
 * se fue, y sin el catch adentro el proceso vería un unhandled rejection).
 *
 * La entrada se borra en el `finally`, así que el mapa no crece: a lo sumo tiene
 * tantas entradas como cuentas sincronizando en este instante.
 */
const enVuelo = new Map<string, Promise<void>>();

/**
 * Refresca la Jerarquía de una cuenta si hace falta y devuelve qué tan fresca
 * quedó. No tira nunca (R4.4).
 *
 * A diferencia de `ensureFreshAdSpend`, no recibe rango ni día: no hay un
 * equivalente del `if (hasta < hoy)` que ahí evita ir a buscar el gasto de un
 * día ya cerrado. La Jerarquía no tiene período — el estado y el presupuesto de
 * un conjunto son los de ahora, y mirar un rango de la semana pasada no los
 * vuelve inmutables.
 *
 * `opts.forzar` saltea SOLO la comparación contra el TTL. Es lo que usa el
 * Boton_Actualizar. El promise en vuelo compartido se mantiene, así que dos
 * pestañas apretando el botón a la vez siguen compartiendo un solo sync.
 *
 * `opts.timeoutMs`: presupuesto de espera antes de dibujar con lo guardado
 * (R4.3). Default 10 s; el botón pide 30 s, porque ahí el usuario pidió esperar.
 */
export async function ensureFreshJerarquia(
  accountId: string,
  opts?: {
    /** Ignora el TTL de frescura (R4.2). Sólo el Boton_Actualizar lo usa. */
    forzar?: boolean;
    /** Presupuesto de espera. Default 10 s; el botón usa 30 s. */
    timeoutMs?: number;
  },
): Promise<FrescuraJerarquia> {
  const antes = await leerFrescura(accountId);

  const ttl = ttlSegundos();
  if (!opts?.forzar && antes.ageSeconds !== null && antes.ageSeconds < ttl) {
    return { ...antes, refreshed: false };
  }

  let corriendo = enVuelo.get(accountId);
  if (!corriendo) {
    // `sincronizarJerarquia` ya atrapa por cuenta: un fallo de Meta termina en
    // `ResultadoCuenta.error` y en `last_hierarchy_sync_error`, sin rechazar. Lo
    // que este catch atrapa es el fallo DURO —la base caída al listar las
    // cuentas activas, por ejemplo— donde la corrida se cae antes de anotar
    // nada. Se loguea y no se propaga: el reloj no avanzó, así que la pantalla
    // va a seguir mostrando la edad vieja, que es la señal correcta.
    let fallo: string | null = null;
    corriendo = sincronizarJerarquia({ cuentas: [accountId] })
      .then(() => undefined)
      .catch((e) => {
        fallo = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        enVuelo.delete(accountId);
        if (fallo) console.error(`ads jerarquía en vivo: el sync de ${accountId} falló:`, fallo);
      });
    enVuelo.set(accountId, corriendo);
  }

  let alarma: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    corriendo,
    new Promise<void>((resolve) => {
      alarma = setTimeout(resolve, opts?.timeoutMs ?? timeoutMs());
    }),
  ]);
  if (alarma) clearTimeout(alarma);

  // La segunda lectura es la que devuelve el resultado, y de acá sale el `error`
  // que ve la pantalla. NO del `ResultadoCuenta` que devuelve
  // `sincronizarJerarquia`, por tres razones:
  //
  // 1. Es la única fuente que existe en todos los caminos. Cuando gana el
  //    timeout no hay resultado que leer: el sync sigue corriendo y el llamador
  //    ya se fue. Con la base como fuente, ese caso devuelve el error de la
  //    corrida anterior (si hubo) en lugar de un `null` que significaría "todo
  //    bien" cuando lo que pasó es "todavía no sé".
  // 2. No se pierde nada. `anotarCorrida` persiste EXACTAMENTE el `error` del
  //    `ResultadoCuenta`, así que la columna no es una copia degradada del
  //    resultado: es el mismo valor. Leerlo de la base no cuesta información,
  //    cuesta una consulta que igual hay que hacer para la edad.
  // 3. El error y la hora salen de la misma fila y la misma consulta, así que no
  //    pueden contradecirse. Cruzar un error del resultado con una hora de la
  //    base abre la ventana para mostrar "hace 2 s, sin errores" sobre una
  //    corrida que falló, que es el bug que este spec vino a cerrar.
  //
  // El precio, y es intencional: una cuenta que no es EUR avanza el reloj con el
  // error en NULL (decisión de T6.2, porque saltear por moneda no es un fallo
  // sino una cuenta fuera de alcance), así que se va a ver permanentemente
  // fresca. Es correcto: su corrida termina bien, decidiendo que no hay nada que
  // traer. El "fuera de alcance" viaja por `ResultadoCuenta.monedaNoSoportada`,
  // que es el campo que existe para eso, y las filas conservan su `synced_at`
  // propio, que es con el que la tabla las marca como viejas.
  const despues = await leerFrescura(accountId);
  return { ...despues, refreshed: true };
}
