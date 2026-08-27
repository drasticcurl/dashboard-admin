import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  accionDeToggle,
  ejecutarToggle,
  filasConEstado,
  statusOptimista,
  type EntornoToggle,
} from './GestorAnuncios';
import { PRESUPUESTO_RELECTURA_MS } from '@/lib/ads/acciones';
import type { Aviso, ResultadoAccion } from '@/lib/ads/mensajes';
import type { MetricasObjeto, NivelAds } from '@/lib/ads/tipos';

/**
 * Property 3 (Bug_Condition) de `toggle-conjuntos-entrega`, task 2: el POST del
 * toggle sale sin plazo, y el plazo del lote es menor que el peor caso del
 * servidor.
 *
 * ## ESTE ARCHIVO TIENE QUE FALLAR HOY, Y EL FALLO ES EL ENTREGABLE
 *
 * Se escribe ANTES del arreglo y **no se arregla ni el test ni el código cuando
 * falle**: la task 16.4 vuelve a correr ESTE archivo y ahí sí tiene que pasar.
 * Los dos casos fallan, por dos razones distintas:
 *
 * **(a) el `pedir` que nunca resuelve.** `ejecutarToggle` (`GestorAnuncios.tsx`)
 * arma el `init` del POST con `method`, `headers` y `body`, y nada más; el
 * `pedir` que le pasa el componente es `fetch(url, init)` pelado
 * (`GestorAnuncios.tsx:1152`). O sea que el POST del interruptor de UNA fila no
 * tiene deadline de ninguna clase, mientras que la LECTURA de filas del mismo
 * archivo (`leerFilas`, `:570`) sí tiene su `AbortController` con `timeoutMs`
 * explícito. Contraejemplos textuales de la corrida de esta task:
 *
 *     expected undefined to be an instance of AbortSignal      ← init.signal
 *     un POST sin plazo deja el toggle colgado: expected 'colgado' not to be 'colgado'
 *
 * y el estado en el que queda todo, que es el síntoma de 1.8: la fila sigue
 * pintada con el valor nuevo, el id sigue en `enVuelo` —así que un segundo click
 * se descarta y el control queda muerto hasta recargar la página— y no hubo
 * ningún aviso.
 *
 * **(b) la desigualdad.** El plazo del lote es `60_000` para todo lo que no sea
 * `duplicate` (`GestorAnuncios.tsx:1316`) y el peor caso del servidor para UN
 * solo objeto es `4_000 + 30_000 + 30_000 = 64_000`: el presupuesto de la
 * relectura del preflight, más el POST a Meta de `enviar`, más la relectura de
 * `refrescarJerarquia` que hoy está en el `await` del route. Contraejemplos
 * textuales:
 *
 *     plazo del cliente 60000 ms contra un peor caso de 64000 ms:
 *       expected 60000 to be greater than 64000
 *
 *     Counterexample: [1]                    ← la property sobre n, shrunk a 1
 *     n=1: plazo 60000 ms contra un peor caso de 64000 ms:
 *       expected 60000 to be greater than 64000
 *
 * Un click cuyo servidor tarda 64 s se abandona a los 60 s, y el desenlace es
 * `indeterminado` sobre un pedido que estaba por confirmarse.
 *
 * ## LO QUE ESTE ARCHIVO NO PRUEBA, Y NO SE TAPA
 *
 * **El vencimiento del plazo contra el reloj real queda SIN TEST.** Ningún test
 * de esta suite puede esperar 44 s, y `AbortSignal.timeout` no respeta los fake
 * timers de vitest: el timer vive en la implementación de la plataforma, no en el
 * loop que vitest controla. Mockear `AbortSignal` para simularlo verificaría el
 * mock. Así que lo verificable —y lo que se verifica acá— es que el `init` LLEVA
 * el plazo; el desenlace del vencimiento (reversión + aviso que no afirma que el
 * cambio no ocurrió) lo prueba la forma `plazo` del generador de
 * `toggleEstado.test.ts` con un rechazo de nombre `TimeoutError` (tasks 6 y
 * 16.5). Está declarado igual en §Testing Strategy del diseño.
 *
 * Por eso la carrera del caso (a) está condicionada a que el `init` no traiga
 * `signal`: sin plazo, «esto no termina» es exactamente lo que hay que
 * demostrar; con plazo puesto, quien corta el pedido es el `fetch` contra el
 * reloj del sistema y este test no lo puede observar sin esperar el plazo
 * entero.
 *
 * ## Los helpers están COPIADOS de `toggleEstado.test.ts`, a propósito
 *
 * `fila()` y `tabla()` son los de ahí, con un solo agregado: `tabla()` guarda
 * también los `init` que salen por `pedir`, que es el dato de este archivo. No se
 * editó ese archivo porque en este plan tiene otros dos editores (la task 6 le
 * agrega la forma `plazo` al generador y la 13.2 endurece sus `toEqual`) y
 * porque su `pedir` no expone el `init`. Extraerlos a un helper compartido es un
 * refactor que ninguna de las tres tasks necesita.
 */

// ─── El puente hacia `lib/ads/plazos.ts`, que todavía no existe ──────────────

/**
 * El módulo de plazos lo crea la task 10 (las constantes), la 15 le agrega
 * `refrescoEnCaminoCritico` y la 16.1 las dos funciones. Hasta entonces los
 * números se leen de donde hoy están escritos: el `AbortSignal.timeout` del lote
 * en `GestorAnuncios.tsx` y los dos de `lib/ads/meta.ts`.
 *
 * El import es dinámico con especificador computado a propósito: con un literal,
 * tsc intentaría resolver un módulo que hoy no existe y `npx tsc --noEmit`
 * dejaría de estar limpio mientras este test falla. Es el mismo criterio que el
 * puente por `unknown` de `montoAmbiguo.test.ts` y
 * `numeroDeCampo.preservacion.test.ts`, aplicado a un módulo entero en lugar de
 * a un export.
 */
type ModuloPlazos = {
  peorCasoEstadoMs?: (n: number) => number;
  plazoClienteEstadoMs?: (n: number) => number;
  refrescoEnCaminoCritico?: () => boolean;
};

const RAIZ = process.cwd();
const RUTA_PLAZOS = path.join(RAIZ, 'lib', 'ads', 'plazos.ts');
const RUTA_META = path.join(RAIZ, 'lib', 'ads', 'meta.ts');
const RUTA_GESTOR = path.join(RAIZ, 'app', '(panel)', 'anuncios', 'GestorAnuncios.tsx');

async function moduloPlazos(): Promise<ModuloPlazos | null> {
  if (!existsSync(RUTA_PLAZOS)) return null;
  const mod: unknown = await import(/* @vite-ignore */ RUTA_PLAZOS);
  return mod as ModuloPlazos;
}

const plazos = await moduloPlazos();

// ─── Leer los plazos que el código declara, y no copiarlos ───────────────────

const fuente = (ruta: string): string => readFileSync(ruta, 'utf8');

/**
 * Cada `AbortSignal.timeout(...)` de un archivo, con el nombre de la función que
 * lo contiene y el ARGUMENTO textual. Así la lectura no depende del número de
 * línea, que es lo único que el diseño cita y lo primero que se mueve.
 */
function plazosDeclarados(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /AbortSignal\.timeout\(([^)]*)\)/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const declaraciones = [...src.slice(0, m.index).matchAll(/function\s+([A-Za-z0-9_$]+)\s*[<(]/g)];
    const contenedora = declaraciones[declaraciones.length - 1]?.[1] ?? `offset_${m.index}`;
    out.set(contenedora, m[1]!.trim());
  }
  return out;
}

/**
 * El número que un argumento de `AbortSignal.timeout` vale de verdad: un literal
 * (`30_000`, como hoy) o una constante nombrada (`PLAZO_META_ESCRITURA_MS`,
 * después de la task 10) que se busca primero en el módulo de plazos y después en
 * el archivo donde aparece. `null` = no se pudo resolver.
 */
function resolverPlazo(argumento: string | undefined, src: string): number | null {
  if (argumento === undefined) return null;
  if (/^[0-9_]+$/.test(argumento)) return Number(argumento.replace(/_/g, ''));
  if (!/^[A-Za-z0-9_$]+$/.test(argumento)) return null; // una expresión, no un plazo fijo
  for (const texto of [existsSync(RUTA_PLAZOS) ? fuente(RUTA_PLAZOS) : '', src]) {
    const m = new RegExp(`${argumento}\\s*(?::\\s*number\\s*)?=\\s*([0-9_]+)`).exec(texto);
    if (m) return Number(m[1]!.replace(/_/g, ''));
  }
  return null;
}

/** Los dos plazos de Meta, leídos de `lib/ads/meta.ts`. */
function plazosDeMeta(): { escritura: number; lectura: number } {
  const src = fuente(RUTA_META);
  const declarados = plazosDeclarados(src);
  const escritura = resolverPlazo(declarados.get('enviar'), src);
  const lectura = resolverPlazo(declarados.get('pedir'), src);
  if (escritura === null || lectura === null) {
    // CONDICIÓN DE CORTE de la task 2: si alguno de los timeouts no es el que se
    // leyó, hay que parar y volver al diseño en lugar de inventar un número.
    throw new Error(
      `no se pudo leer el plazo de Meta en ${RUTA_META}: ` +
        `enviar=${String(declarados.get('enviar'))} pedir=${String(declarados.get('pedir'))}. ` +
        'El peor caso del servidor sale de esos dos POST/GET; sin ellos la desigualdad de 2.7 no se puede evaluar.',
    );
  }
  return { escritura, lectura };
}

/**
 * El peor caso del servidor para `n` objetos, en ms, con los plazos que el código
 * declara.
 *
 * `PRESUPUESTO_RELECTURA_MS` va FUERA del `n ×` porque su presupuesto es del LOTE
 * entero: `relecturaSelectiva` calcula el límite una vez antes del loop. Para un
 * objeto da lo mismo (64 s de las dos formas); para 20 la diferencia es
 * 1204 s contra 1280 s, y es el número que el plazo del lote usa.
 *
 * El término de la lectura es `refrescarJerarquia`, que HOY está en el `await` de
 * `route.ts:576`. Cuando la tanda C lo saque del camino crítico, el flag de la
 * task 15 lo dice y el término desaparece de la suma; hasta entonces está.
 */
function peorCasoServidorMs(n: number): number {
  const { escritura, lectura } = plazosDeMeta();
  const refresco = plazos?.refrescoEnCaminoCritico?.() ?? true;
  return PRESUPUESTO_RELECTURA_MS + n * (escritura + (refresco ? lectura : 0));
}

/**
 * El plazo que el cliente le da a una acción de estado sobre `n` objetos, en ms.
 *
 * Hoy sale del `AbortSignal.timeout` del lote (`GestorAnuncios.tsx:1316`), que es
 * un número fijo y no depende de `n` —eso es parte del defecto—, y el toggle de
 * UNA fila no tiene ninguno, que es el caso (a). Con la task 16 sale de
 * `plazoClienteEstadoMs`.
 */
function plazoClienteMs(n: number): number {
  const delModulo = plazos?.plazoClienteEstadoMs?.(n);
  if (typeof delModulo === 'number') return delModulo;

  const src = fuente(RUTA_GESTOR);
  // El ternario del lote: `duplicate ? 300_000 : 60_000`. Lo que interesa es la
  // rama de `pause`/`activate`, o sea la del `:`. `duplicate` queda afuera de C₂
  // por 3.14 y sigue en 300 s.
  for (const argumento of plazosDeclarados(src).values()) {
    const m = /:\s*([0-9_]+)\s*$/.exec(argumento);
    if (m) return Number(m[1]!.replace(/_/g, ''));
  }
  throw new Error(
    `no se pudo leer el plazo del cliente: ni ${RUTA_PLAZOS} expone plazoClienteEstadoMs ` +
      `ni ${RUTA_GESTOR} tiene un AbortSignal.timeout con un número en la rama que no es duplicate.`,
  );
}

// ─── Helpers, copiados de `toggleEstado.test.ts` ─────────────────────────────

type Fila = Pick<MetricasObjeto, 'objectId' | 'level' | 'accountId' | 'status' | 'effectiveStatus'>;

function fila(status: string | null, sobre: Partial<Fila> = {}): Fila {
  return { objectId: 's1', level: 'adset', accountId: 'act_1', status, effectiveStatus: status, ...sobre };
}

type CuerpoPedido = {
  level: NivelAds;
  accountId: string;
  action: 'pause' | 'activate';
  objectIds: string[];
};

/**
 * El componente reducido a lo que el toggle toca. Igual al de
 * `toggleEstado.test.ts` más `inits`: el `init` completo de cada pedido, que es
 * donde se mira si viaja el plazo.
 */
function tabla(filas: Fila[], responder: (pedido: number) => Promise<Response>) {
  const registro = {
    filas,
    avisos: [] as Aviso[],
    pedidos: [] as CuerpoPedido[],
    inits: [] as RequestInit[],
    urls: [] as string[],
    refrescos: 0,
  };

  const entorno: EntornoToggle = {
    enVuelo: new Set<string>(),
    pintar: (objectId, status, siMuestra) => {
      registro.filas = filasConEstado(registro.filas, objectId, status, siMuestra);
    },
    avisar: (a) => registro.avisos.push(a),
    refrescar: () => {
      registro.refrescos += 1;
    },
    pedir: (url, init) => {
      registro.urls.push(url);
      registro.inits.push(init);
      registro.pedidos.push(JSON.parse(String(init.body)) as CuerpoPedido);
      return responder(registro.pedidos.length);
    },
  };

  const statusDe = (objectId: string): string | null | undefined =>
    registro.filas.find((f) => f.objectId === objectId)?.status;

  return { registro, entorno, statusDe };
}

function respuesta(httpStatus: number, cuerpo: unknown): Response {
  return new Response(JSON.stringify(cuerpo), {
    status: httpStatus,
    headers: { 'content-type': 'application/json' },
  });
}

function con(...rs: readonly ResultadoAccion[]): unknown {
  return { ok: true, aplicados: 0, total: rs.length, corte: null, resultados: rs };
}

const CONFIRMADO = (): Response =>
  respuesta(
    200,
    con({
      objectId: 's1',
      objectName: 'Conjunto frío EUR',
      estado: 'confirmado',
      mensaje: null,
      codigoMeta: null,
    }),
  );

/** Un `pedir` que no vuelve nunca: el servidor que se quedó pensando. */
const NUNCA_VUELVE = (): Promise<Response> => new Promise<Response>(() => {});

const esperar = (ms: number): Promise<'colgado'> =>
  new Promise((resolve) => setTimeout(() => resolve('colgado'), ms));

// ─── Caso (a) — el POST de una fila sale sin plazo ───────────────────────────

describe('Caso (a): el POST del toggle de una fila sale sin plazo (1.6, 1.8, 2.5)', () => {
  it('el `init` que `ejecutarToggle` le pasa a `pedir` lleva el plazo del cliente', async () => {
    const f = fila('PAUSED');
    const { registro, entorno } = tabla([f], async () => CONFIRMADO());

    await ejecutarToggle(f, entorno);

    expect(registro.inits).toHaveLength(1);
    const init = registro.inits[0]!;
    // Lo que ya viaja hoy y tiene que seguir viajando: el plazo se suma, no
    // reemplaza nada.
    expect(init.method).toBe('POST');
    expect(init.body).toBeTypeOf('string');
    // HOY: `expected undefined to be an instance of AbortSignal`. El plazo entra
    // en `ejecutarToggle` y no en el `pedir` del componente (task 16.2), porque
    // es la función que sabe cuántos objetos manda y la única de las dos que un
    // test puede tocar sin render.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('un POST que no vuelve nunca deja el toggle sin terminar, la fila pintada y el id en vuelo (1.8)', async () => {
    const f = fila('PAUSED');
    const { registro, entorno, statusDe } = tabla([f], NUNCA_VUELVE);

    // La afirmación es «esto no termina», así que se verifica con un timeout DEL
    // TEST y acotado: 50 ms, no el `testTimeout: 30_000` de `vitest.config.ts`.
    const carrera = await Promise.race([
      ejecutarToggle(f, entorno).then(() => 'terminó' as const),
      esperar(50),
    ]);

    // El estado en el que queda todo mientras el pedido está en vuelo. Vale en
    // los dos mundos y es el síntoma que 1.8 reporta.
    expect(registro.pedidos).toHaveLength(1);
    expect(statusDe('s1')).toBe(statusOptimista(accionDeToggle(f.status)));
    expect(entorno.enVuelo.has('s1')).toBe(true);
    expect(registro.avisos).toEqual([]);
    expect(registro.refrescos).toBe(0);

    // Y por eso el segundo click se descarta: el control queda muerto.
    await ejecutarToggle(f, entorno);
    expect(registro.pedidos).toHaveLength(1);

    // La afirmación que falla hoy. Condicionada a que el `init` no traiga plazo
    // porque el vencimiento contra el reloj real no lo puede observar ningún test
    // de esta suite (ver el encabezado): sin plazo, «no termina» es literal y
    // para siempre; con plazo, quien corta es el `fetch`.
    if (registro.inits[0]!.signal === undefined || registro.inits[0]!.signal === null) {
      expect(
        carrera,
        'un POST sin plazo deja el toggle colgado: la fila queda pintada con un valor que nadie confirmó y el id no sale nunca de enVuelo',
      ).not.toBe('colgado');
    }
  });
});

// ─── Caso (b) — la desigualdad ───────────────────────────────────────────────

// Feature: toggle-conjuntos-entrega, Property 3: Bug Condition — El plazo del
// cliente cubre el peor caso del servidor
//
// **Validates: Requirements 2.5, 2.7, 2.8**
describe('Property 3: El plazo del cliente cubre el peor caso del servidor', () => {
  it('para UN objeto, el plazo del cliente es mayor que el peor caso del servidor (1.9, 2.7)', () => {
    const peorCaso = peorCasoServidorMs(1);
    const plazo = plazoClienteMs(1);

    // Los términos, para que el fallo se lea sin abrir el diseño:
    //   4_000 (presupuesto de la relectura del preflight, del lote entero)
    // + 30_000 (el POST de `enviar` a Meta)
    // + 30_000 (la relectura de `refrescarJerarquia`) SÓLO si el refresco está
    //          todavía en el camino crítico de la respuesta.
    //
    // **El término de la lectura está condicionado y no sumado fijo, y es el ajuste
    // que la task 16.4 hace acá.** Cuando esta task se escribió (task 2, contra el
    // código sin arreglar) la tanda C no existía y el peor caso de un objeto era
    // 64 000, así que la suma se escribió con los tres términos adentro y la
    // corrida daba `expected 60000 to be greater than 64000`. Después de la 14.2 el
    // refresco salió del `await` del route, `refrescoEnCaminoCritico()` devuelve
    // `false` y el peor caso de un objeto es 34 000: la aserción de tres términos
    // pasó a fallar con `expected 34000 to be 64000`.
    //
    // La corrección NO es cambiar el literal a 34 000 —eso volvería a fijar un
    // mundo y volvería a mentir cuando el otro valga—, sino leer el flag, que es lo
    // que la task 2 ya pedía: «escribirlo con las constantes leídas del código y no
    // con literales, así el test sigue diciendo la verdad cuando alguno cambie».
    // Con el flag en `false` esto vale 34 000 y con el flag en `true`, 64 000.
    const refrescoDentro = plazos?.refrescoEnCaminoCritico?.() ?? true;
    expect(peorCaso).toBe(
      PRESUPUESTO_RELECTURA_MS +
        plazosDeMeta().escritura +
        (refrescoDentro ? plazosDeMeta().lectura : 0),
    );
    expect(plazo, `plazo del cliente ${plazo} ms contra un peor caso de ${peorCaso} ms`).toBeGreaterThan(
      peorCaso,
    );
  });

  it('para todo n >= 1, el plazo del cliente cubre el peor caso de ese lote', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (n) => {
        const peorCaso = peorCasoServidorMs(n);
        const plazo = plazoClienteMs(n);

        // El plazo de hoy es un número fijo que no mira `n`: con 20 objetos el
        // peor caso es 604 s (post-C) o 1204 s (pre-C) contra los mismos 60 s.
        expect(plazo, `n=${n}: plazo ${plazo} ms contra un peor caso de ${peorCaso} ms`).toBeGreaterThan(
          peorCaso,
        );

        // Y la guarda que hace que esto siga diciendo la verdad cuando alguien
        // cambie un timeout: si el módulo de plazos ya existe, su peor caso tiene
        // que ser el que los timeouts del código declaran, no una copia.
        const delModulo = plazos?.peorCasoEstadoMs?.(n);
        if (typeof delModulo === 'number') expect(delModulo).toBe(peorCaso);
      }),
      { numRuns: 200 },
    );
  });
});

// ─── El arreglo: lo que las tasks 16.2 y 16.3 agregan ────────────────────────

/**
 * Lo de arriba es la task 2 y **no se afloja**: sus dos casos son el
 * Bug_Condition y la task 16.4 los vuelve a correr tal cual. Lo de acá abajo es lo
 * que sólo se puede afirmar DESPUÉS del arreglo.
 *
 * Los imports van acá y no arriba a propósito: `textoDeFalloDeToggle`,
 * `esAbortoPorPlazo` y `plazoDeLoteMs` no existían cuando se escribió la task 2, y
 * dejarlos abajo hace visible qué parte del archivo es el contraejemplo y qué
 * parte es la verificación del arreglo.
 */
const { esAbortoPorPlazo, plazoDeLoteMs, textoDeFalloDeToggle } = await import('./GestorAnuncios');
const { PLAZO_META_LECTURA_MS, peorCasoEstadoMs, plazoClienteEstadoMs, refrescoEnCaminoCritico } =
  await import('@/lib/ads/plazos');

/**
 * La oración que R2.6 pide y que el diseño declara **textual en las dos ramas**
 * (§D3). Está escrita completa acá, y no leída de la implementación, porque es el
 * valor esperado: un test que importa la constante que está probando no prueba
 * nada.
 */
const CIERRE =
  'La fila quedó como estaba; si el pedido llegó a Meta, el resultado se define ' +
  'cuando corra la reconciliación.';

describe('el plazo del `init` es el que dice el módulo de plazos (16.2, 2.5)', () => {
  it('el `signal` sale de `plazoClienteEstadoMs(1)` y no de un número escrito en el componente', async () => {
    const f = fila('PAUSED');
    const { registro, entorno } = tabla([f], async () => CONFIRMADO());

    await ejecutarToggle(f, entorno);

    const init = registro.inits[0]!;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // Un signal recién creado por `AbortSignal.timeout` no está abortado: el plazo
    // corre contra el reloj real y esto tarda microsegundos.
    expect(init.signal!.aborted).toBe(false);

    // Y el número. No se puede leer del `AbortSignal` —la plataforma no lo expone—
    // así que se verifica por el otro lado: el plazo que el módulo declara para UN
    // objeto es mayor que el peor caso del servidor para UN objeto, que es
    // exactamente R2.7 sobre el pedido que este `init` manda.
    expect(plazoClienteEstadoMs(1)).toBeGreaterThan(peorCasoEstadoMs(1));
    // 44 s con el flag de hoy (34 s de peor caso + 10 s de holgura). Si la tanda C
    // se revirtiera, serían 74 s y este test lo diría solo.
    expect(plazoClienteEstadoMs(1)).toBe(peorCasoEstadoMs(1) + 10_000);
  });

  it('`1` es la cantidad correcta: el toggle de una fila manda un solo objeto', () => {
    // La razón por la que `ejecutarToggle` usa `plazoClienteEstadoMs(1)` y no
    // `plazoDeLoteMs`: su `objectIds` es `[fila.objectId]`. Si algún día mandara
    // más de uno, el plazo tendría que crecer con él y este test se rompería antes
    // que el usuario.
    expect(plazoClienteEstadoMs(1)).toBeLessThan(plazoClienteEstadoMs(2));
  });
});

describe('textoDeFalloDeToggle — las dos ramas y la oración que comparten (16.2, 2.6, 3.1)', () => {
  const abortos = [
    new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    new DOMException('This operation was aborted', 'AbortError'),
  ];

  for (const error of abortos) {
    it(`la rama del plazo (${error.name}) nombra el plazo y NO el mensaje del proveedor`, () => {
      const texto = textoDeFalloDeToggle(error, 44_000);

      expect(texto).toBe(`El cambio de estado no confirmó en 44 segundos. ${CIERRE}`);
      // Lo que este texto vino a sacar: la frase en inglés del proveedor dentro de
      // un aviso en castellano.
      expect(texto).not.toContain('aborted');
      // Y lo que agrega: cuánto se esperó, que el aviso viejo no decía.
      expect(texto).toContain('44 segundos');
    });
  }

  it('el número del plazo sale del argumento, así que el aviso del lote diría el suyo', () => {
    // No está hardcodeado en 44: si el peor caso del servidor cambia, el aviso dice
    // el número nuevo sin que nadie lo edite. 614 s es el plazo de un lote de 20
    // post-C.
    expect(textoDeFalloDeToggle(abortos[0]!, 614_000)).toContain('614 segundos');
    expect(textoDeFalloDeToggle(abortos[0]!, 74_000)).toContain('74 segundos');
  });

  it('la rama del error interpola el mensaje', () => {
    const texto = textoDeFalloDeToggle(new TypeError('Failed to fetch'), 44_000);

    expect(texto).toBe(`El cambio de estado no se pudo completar: Failed to fetch. ${CIERRE}`);
    // No nombra un plazo que no fue la causa.
    expect(texto).not.toContain('segundos');
  });

  it('un error que no es `Error` no rompe el aviso', () => {
    // El `catch` recibe `unknown`: un `throw 'texto'` o un `throw null` llegan acá.
    expect(textoDeFalloDeToggle('se cayó todo', 44_000)).toBe(
      `El cambio de estado no se pudo completar: se cayó todo. ${CIERRE}`,
    );
    expect(textoDeFalloDeToggle(null, 44_000)).toContain('null');
  });

  it('LAS DOS ramas terminan con la oración de la reconciliación, textual', () => {
    // El corazón de R2.6, y la razón por la que la oración es una constante en la
    // implementación y no dos literales copiados. Property sobre cualquier error:
    // el desenlace es indeterminado por definición, así que el cierre no puede
    // depender de la causa.
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constantFrom(...abortos),
          fc.string().map((m) => new TypeError(m)),
          fc.string(),
          fc.constant(null),
          fc.constant(undefined),
          fc.integer(),
        ),
        fc.integer({ min: 1_000, max: 2_000_000 }),
        (error, plazoMs) => {
          const texto = textoDeFalloDeToggle(error, plazoMs);

          expect(texto.endsWith(CIERRE), `no cierra con la oración: ${texto}`).toBe(true);
          // R3.1 y R2.6: el aviso NO puede decir que el cambio no ocurrió. Las tres
          // formas de decirlo que estaban a mano, prohibidas por test.
          expect(texto).not.toContain('no se aplicó');
          expect(texto).not.toContain('no ocurrió');
          expect(texto).not.toContain('no se cambió');
          expect(texto.trim().length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('esAbortoPorPlazo — reconoce los dos nombres y cae al otro texto si no reconoce (16.2)', () => {
  it('los dos nombres que un abort puede traer', () => {
    // `TimeoutError` es el de Node/undici, que es el que produce el
    // `AbortSignal.timeout` de `ejecutarToggle`; `AbortError` el de algunos
    // navegadores, que es por donde le llega al usuario. Los dos medidos y anotados
    // en `toggleEstado.test.ts`.
    expect(esAbortoPorPlazo(new DOMException('x', 'TimeoutError'))).toBe(true);
    expect(esAbortoPorPlazo(new DOMException('x', 'AbortError'))).toBe(true);
  });

  it('todo lo demás es `false`: decir menos, no afirmar más', () => {
    // La decisión de la 16.2: cuando no reconoce nada cae al segundo texto, que
    // interpola el mensaje. Afirmar «esperamos 44 s» sobre un error que puede no
    // tener nada que ver con el plazo sería afirmar de más.
    expect(esAbortoPorPlazo(new TypeError('Failed to fetch'))).toBe(false);
    expect(esAbortoPorPlazo(new Error('boom'))).toBe(false);
    expect(esAbortoPorPlazo({ name: 'OtroError' })).toBe(false);
    expect(esAbortoPorPlazo(null)).toBe(false);
    expect(esAbortoPorPlazo(undefined)).toBe(false);
    expect(esAbortoPorPlazo('TimeoutError')).toBe(false); // un string no es un error
    expect(esAbortoPorPlazo(42)).toBe(false);
  });

  it('mira `name` y no el mensaje: un error de red que menciona el timeout no es un plazo', () => {
    expect(esAbortoPorPlazo(new TypeError('fetch failed after timeout'))).toBe(false);
  });
});

describe('el recorrido de punta a punta del plazo vencido (16.5, 2.6, 3.2)', () => {
  it('deja la fila en `statusPrevio`, libera el id, y el aviso nombra el plazo sin afirmar que el cambio no ocurrió', async () => {
    // `status` nulo a propósito: es la fila del bug original, y la que hace ver que
    // se restaura el valor previo y no PAUSED/ACTIVE (3.2). Éste es el caso que la
    // task 6 no podía escribir todavía —el aviso interpolaba `e.message` en inglés—
    // y que la 16.5 suma sobre el arreglo.
    const f = fila(null);
    const { registro, entorno, statusDe } = tabla([f], async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });

    await ejecutarToggle(f, entorno);

    expect(statusDe('s1')).toBeNull();
    expect(entorno.enVuelo.size).toBe(0);
    expect(registro.refrescos).toBe(0);
    expect(registro.avisos).toHaveLength(1);
    expect(registro.avisos[0]!.tono).toBe('error');
    // El texto completo, con el plazo que el módulo declara para un objeto.
    expect(registro.avisos[0]!.texto).toBe(
      `El cambio de estado no confirmó en ${Math.round(plazoClienteEstadoMs(1) / 1000)} segundos. ${CIERRE}`,
    );
    // Y la fila queda accionable: un plazo vencido no es un bloqueo permanente.
    await ejecutarToggle(f, entorno);
    expect(registro.pedidos).toHaveLength(2);
  });
});

describe('el plazo del lote (16.3, 1.9, 3.14)', () => {
  it('`pause` y `activate` salen de `plazoClienteEstadoMs(n)` y crecen con el lote', () => {
    for (const accion of ['pause', 'activate'] as const) {
      expect(plazoDeLoteMs(accion, 1)).toBe(plazoClienteEstadoMs(1));
      expect(plazoDeLoteMs(accion, 20)).toBe(plazoClienteEstadoMs(20));
      // El defecto de 1.9, fijado por test para que no vuelva: 60 s es MENOR que el
      // peor caso del servidor a partir de dos objetos post-C (64 s) y de uno solo
      // pre-C. El plazo nuevo lo cubre para todo n.
      expect(plazoDeLoteMs(accion, 2)).toBeGreaterThan(peorCasoEstadoMs(2));
      expect(plazoDeLoteMs(accion, 20)).toBeGreaterThan(peorCasoEstadoMs(20));
    }
  });

  it('`duplicate` sigue en 300 s, sin una sola dependencia de esta cuenta (3.14)', () => {
    // Su peor caso es la creación de `n × copias` objetos, que es otro camino, y sus
    // filas fantasma y su vaciado al responder dependen de ese número.
    expect(plazoDeLoteMs('duplicate', 1)).toBe(300_000);
    expect(plazoDeLoteMs('duplicate', 20)).toBe(300_000);
    expect(plazoDeLoteMs('duplicate', 100)).toBe(300_000);
  });

  it('`budget_set`, `rename` y `schedule` quedan en 60 s: alcance declarado, no olvido', () => {
    // Tienen la misma clase de defecto y siguen con el número viejo. Está escrito en
    // el diseño (§Alcance, punto 2) y fijado acá para que el día que alguien lo
    // extienda tenga que borrar este test a propósito.
    for (const accion of ['budget_set', 'rename', 'schedule'] as const) {
      expect(plazoDeLoteMs(accion, 1)).toBe(60_000);
      expect(plazoDeLoteMs(accion, 50)).toBe(60_000);
    }
  });

  it('el plazo del lote de `pause` para n=1 coincide con el del toggle de una fila', () => {
    // No es casualidad y conviene que se rompa si dejan de coincidir: son el mismo
    // pedido con el mismo peor caso del servidor, mandado desde dos lugares.
    expect(plazoDeLoteMs('pause', 1)).toBe(plazoClienteEstadoMs(1));
  });
});

describe('la desigualdad se sigue evaluando contra los timeouts del código, no contra copias (2.8)', () => {
  it('el peor caso del módulo es el que `lib/ads/meta.ts` declara', () => {
    // La otra mitad de la guarda del caso (b): arriba se compara el peor caso LEÍDO
    // del fuente con el del módulo para todo n; acá se nombra el término que la
    // tanda C sacó, para que el fallo diga cuál de los dos mundos está midiendo.
    const { escritura, lectura } = plazosDeMeta();
    const refrescoDentro = refrescoEnCaminoCritico();

    expect(peorCasoEstadoMs(1)).toBe(
      PRESUPUESTO_RELECTURA_MS + escritura + (refrescoDentro ? lectura : 0),
    );
    expect(PLAZO_META_LECTURA_MS).toBe(lectura);
    // Y el tamaño del término que el flag prende y apaga, por objeto.
    expect(peorCasoEstadoMs(1, true) - peorCasoEstadoMs(1, false)).toBe(PLAZO_META_LECTURA_MS);
  });
});
