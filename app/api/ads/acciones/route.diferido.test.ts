import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { q, q1 } from '../../../../lib/db';
import { POST } from './route';
import { esperarRefrescosPendientes } from './_diferir';
import { refrescoEnCaminoCritico } from '../../../../lib/ads/plazos';
import { enviar, fetchObjeto } from '../../../../lib/ads/meta';
import { isAuthenticated } from '../../../../lib/auth';
import type { MetaObjetoLeido } from '../../../../lib/ads/tipos';

/**
 * Property 7 de `toggle-conjuntos-entrega`: la relectura de la jerarquía estaba
 * en el camino crítico de la respuesta.
 *
 * ## ESTADO: LOS DOS PRIMEROS CASOS FALLABAN A PROPÓSITO Y AHORA PASAN
 *
 * Se escribieron en la task 4 contra el código SIN arreglar, donde el fallo era el
 * entregable. La task 14 los puso en verde con dos cambios de `route.ts` y **sin
 * tocar una aserción**: la Escritura_Confirmada_Local (14.1) y el
 * Refresco_Diferido (14.2). Los contraejemplos que se midieron entonces quedan
 * anotados más abajo, textuales: son el registro de que el defecto existía y de
 * cuál era.
 *
 * Los dos últimos casos —(c) y (d)— los agrega la task 14.4 y **sólo existen
 * después del arreglo**: son la relectura que ahora corre DESPUÉS de la respuesta.
 *
 * La task 15 usa este archivo como **guarda del acoplamiento C↔D**: el término del
 * refresco sale de la suma del módulo de plazos si y sólo si esto está en verde.
 *
 * ## EL ÚNICO CAMBIO DE PLOMERÍA: DE DÓNDE SALE `esperarRefrescosPendientes`
 *
 * La task 4 dejó acá un puente por `unknown` contra `route.ts`, porque el diseño
 * ponía el helper de diferimiento adentro de ese archivo. **No podía ir ahí**: un
 * `route.ts` no puede exportar nada fuera de los métodos HTTP y las opciones de
 * segmento, y el validador que Next genera en `.next/types` lo rechaza también
 * desde `npx tsc --noEmit` (el error textual está en `_diferir.ts`). El helper
 * quedó en `./_diferir`, así que el puente se reemplazó por el import de verdad.
 * Ninguna aserción cambió.
 *
 * ## LA GUARDA DEL ACOPLAMIENTO C↔D (task 15)
 *
 * El peor caso del servidor que usa el plazo del cliente (tanda D) tiene un término
 * de más o de menos según si la relectura está en el camino crítico:
 * `4 s + 30 s + 30 s` con ella adentro, `4 s + 30 s` sin ella. Ese «según» vive en
 * **una sola línea de código**, `refrescoEnCaminoCritico()` de `lib/ads/plazos.ts`,
 * y es una afirmación sobre ESTE route hecha desde otro archivo.
 *
 * Lo que la sostiene es el caso (a) de acá: mide si la respuesta salió antes de que
 * `fetchObjeto` volviera y afirma que **el flag es igual a lo que midió**. Con eso,
 * las dos formas de desincronizarlos rompen la suite:
 *
 * - poner el flag en `false` sin haber movido la llamada ⇒ el plazo del cliente
 *   queda 30 s más corto que el servidor, y un click que iba a confirmarse termina
 *   `indeterminado` (R2.7, el escenario que el plan declara PROHIBIDO);
 * - volver a poner la llamada en el `await` sin tocar el flag ⇒ lo mismo, por el
 *   otro lado.
 *
 * La aserción es una igualdad y no una implicación a propósito: con
 * `if (!flag) expect(...)`, un flag equivocado APAGARÍA su propia verificación, que
 * es la forma más silenciosa de no tener guarda.
 *
 * **VERIFICADO A MANO EN LA TASK 15, una vez:** con `refrescoEnCaminoCritico()`
 * devolviendo `true` —el valor equivocado para el route de hoy, que ya difiere—
 * rompe **un solo test**, éste, y los otros tres quedan en verde. Salida textual:
 *
 *     × Property 7: la respuesta no espera la relectura (C₄) > (a) la respuesta
 *       sale ANTES de que `fetchObjeto` vuelva (1.16, 2.13)
 *       → refrescoEnCaminoCritico() dice true y el route NO espera la relectura.
 *         […] expected true to be false // Object.is equality
 *
 *     Test Files  1 failed (1)
 *          Tests  1 failed | 3 passed (4)
 *
 * El radio importa tanto como el fallo: si rompiera también (b), (c) o (d), el flag
 * estaría metido en el armado de los otros casos y este archivo mediría dos cosas a
 * la vez. Rompe uno, y es el que mide.
 *
 * ## El defecto, con la línea
 *
 * `app/api/ads/acciones/route.ts:576`:
 *
 *     if (r.estado === 'confirmado') {
 *       await cerrarAccion(id, 'confirmado');
 *       await refrescarJerarquia(d.level, objeto.objectId);   // ← acá
 *
 * `refrescarJerarquia` hace un `fetchObjeto`, o sea un GET a Meta con su propio
 * `AbortSignal.timeout(30_000)` (`lib/ads/meta.ts`, dentro de `pedir`). Con
 * `await`, esos 30 s de peor caso están DENTRO del tiempo que el usuario espera
 * mirando un interruptor que ya cambió de posición, y el dato que la relectura
 * trae no lo necesita nadie para responder: la respuesta ya sabe que Meta
 * confirmó.
 *
 * ## Los cuatro casos: (a) y (b) de la exploración, (c) y (d) del arreglo
 *
 * **(a) la respuesta espera.** Es C₄ literal. Se mide con un deferred que el test
 * controla, no con un `setTimeout` de 30 s: **el test no puede esperar 30 s de
 * reloj y el deferred mide exactamente lo mismo sin reloj**. Una promesa que no
 * se resuelve es el límite de «tarda más que su propio timeout», y encima es
 * determinista: no hay ninguna ventana en la que la máquina lenta del día cambie
 * el resultado.
 *
 * **(b) el refetch retrocede.** Es la dependencia de 1.19 y la razón por la que el
 * arreglo de (a) no puede ser sólo sacar el `await`. `refrescarJerarquia` es hoy
 * lo único que escribe en la base el `status` que Meta confirmó; su `return`
 * temprano cuando `fetchObjeto` no trae nada deja la fila con el `status`
 * ANTERIOR, así que el refetch inmediato del cliente devuelve la posición vieja y
 * el interruptor vuelve para atrás. Conviene verlo una vez, corrido, antes de
 * escribir la Escritura_Confirmada_Local que lo reemplaza (§Fix Implementation,
 * C1): si el arreglo se hiciera sin este caso a la vista, sacar el `await` metería
 * la regresión de 1.19 mientras arregla la espera.
 *
 * **(c) y (d), los dos que agrega la task 14.4: el refresco que ahora corre
 * DESPUÉS.** Son las dos ramas de la relectura —la que trae la fila y la que no—
 * vistas del otro lado de la respuesta, que es un lugar que antes del arreglo no
 * existía. Cada una afirma tres cosas en el mismo recorrido:
 *
 * - que cuando la respuesta sale la fila ya tiene el `status` confirmado **y
 *   todavía no tiene nada más** (la marca y el `synced_at` viejo siguen ahí): es
 *   la Escritura_Confirmada_Local y su alcance de una columna, medidos juntos;
 * - que el refresco diferido efectivamente **corre** y hace su trabajo completo
 *   cuando trae la fila —`desaparecido_at` a NULL y `synced_at` adelantado—, que
 *   es R4.7 cumplida con el atraso del diferido en lugar de cero: segundos, no 15
 *   minutos;
 * - que cuando **no** trae la fila la marca **queda**, que es la regla evidenciaria
 *   de C3: «Meta no nos dio el objeto» es la misma evidencia con la que el sync la
 *   PONE, y una escritura confirmada sola es la mitad de la evidencia que hace
 *   falta para borrarla.
 *
 * La ventana del medio se mide sin reloj, con el mismo deferred de (a): el
 * `fetchObjeto` del refresco queda bloqueado hasta que el test lo suelta, así que
 * «la respuesta salió y el refresco todavía no escribió» es un estado
 * determinista y no una carrera que la máquina cargada del día pueda perder.
 *
 * ## Los contraejemplos, textuales, medidos contra el código sin arreglar
 *
 * (a), con el deferred sin resolver y la gracia arrancando cuando la relectura
 * arranca:
 *
 *     la respuesta esperó a que `fetchObjeto` volviera: 250 ms después de que la
 *     relectura arrancó, el POST todavía no había respondido. Los 30 s del
 *     AbortSignal de `pedir` están dentro del tiempo del usuario.:
 *     expected 'timer' to be 'respuesta' // Object.is equality
 *
 * (b), con `fetchObjeto` devolviendo `null`:
 *
 *     la base devuelve status="ACTIVE" después de un desenlace `confirmado` de
 *     `pause`: la escritura ocurrió en Meta y la fila local no la tiene, así que
 *     un refetch inmediato del cliente devuelve la posición vieja (1.19):
 *     expected 'ACTIVE' to be 'PAUSED' // Object.is equality
 *
 * ## VERIFICADO A MANO QUE (a) MIDE EL `await` Y NO SU PROPIO ARMADO
 *
 * Un test de exploración que falla no prueba nada si falla por su plumbing. Así
 * que en esta task se corrió una vez el experimento inverso: cambiar el `await`
 * de `route.ts:576` por `void` —el arreglo mínimo de (a), sin nada más—, correr
 * este archivo y volver el archivo atrás. Resultado, textual:
 *
 *     Tests  1 failed | 1 passed (2)
 *
 * O sea (a) **pasa** con el `await` sacado y (b) **sigue fallando**. Las dos
 * mitades de la información importan:
 *
 * - (a) pasa ⇒ lo que mide es el `await` y no la carrera, ni Postgres, ni el
 *   deferred. Si estuviera midiendo su propio armado, seguiría rojo.
 * - (b) sigue fallando ⇒ los dos casos son independientes y (b) **no** se arregla
 *   solo al diferir. Es la dependencia de 1.19 dicha por una corrida: sacar el
 *   `await` sin la Escritura_Confirmada_Local arregla la espera y mete la
 *   regresión del interruptor que vuelve para atrás. Por eso la task 14 tiene los
 *   dos pasos y no uno.
 *
 * `route.ts` quedó **sin modificar** por esta task (`git status` limpio para ese
 * archivo). El cambio de verdad lo hace la 14.2.
 *
 * ## LAS DOS CONDICIONES DE CORTE
 *
 * - **Si (a) NO falla**, `refrescarJerarquia` no está en el `await` de
 *   `route.ts:576`. **Parar y volver al diseño.**
 * - **Si (b) NO falla**, hay algo más escribiendo el `status` en el camino de
 *   `pause`/`activate`, y **hay que encontrar qué antes de agregar un segundo
 *   escritor**. Dos lugares clasificando el mismo hecho es la forma del bug
 *   original, y la Escritura_Confirmada_Local sería el tercero.
 *
 * ## El armado es el de `route.frescura.test.ts`, y las filas NO
 *
 * Mocks de `lib/auth` y de `lib/ads/meta` (`enviar`, `fetchObjeto`,
 * `fetchMinimoPresupuesto`), cuenta sembrada con sufijo único y nivel campaña,
 * que es el único que se ejercita de punta a punta: `leerObjetos` selecciona
 * `o.daily_budget` de la tabla del nivel y `ads` no tiene esa columna, así que un
 * `pause` a nivel `ad` corta en el preflight antes de llegar al POST.
 *
 * **Lo que sí cambia son las filas: acá van FRESCAS y SIN marca de desaparición,
 * y es una decisión de aislamiento.** Las de `route.frescura.test.ts` están
 * sembradas con `synced_at = now() - interval '3 days'` y `desaparecido_at`
 * puesto, o sea que `causaDeRelectura` devuelve `'desaparecida'` y el PREFLIGHT
 * también llama a `fetchObjeto` (`lib/ads/acciones.ts`, `relecturaSelectiva`).
 * Con el deferred de (a) eso mediría el preflight y no `refrescarJerarquia`, y
 * peor: la carrera igual la ganaría el timer —el preflight corta a los
 * `PRESUPUESTO_RELECTURA_MS = 4_000`— así que el test fallaría por la razón
 * equivocada y nadie lo notaría. Con la fila fresca, `causaDeRelectura` devuelve
 * `null`, no hay candidatos, y la ÚNICA llamada a `fetchObjeto` del request es la
 * de la relectura de la jerarquía. (a) y (b) lo afirman con un
 * `toHaveBeenCalledTimes(1)`, que es la guarda de que el armado mide lo que dice.
 *
 * **(c) y (d) van al revés, y por eso sus filas van viejas Y marcadas**: lo que
 * miden es la marca, así que la fila tiene que tener una. La consecuencia es que
 * `causaDeRelectura` devuelve `'desaparecida'` y el preflight relee también: son
 * DOS llamadas a `fetchObjeto`, la primera del preflight y la segunda del
 * refresco, y los dos casos lo afirman con `toHaveBeenCalledTimes(2)` por el mismo
 * motivo por el que (a) y (b) afirman una. El bloqueo del deferred se pone sobre la
 * SEGUNDA, que es la del refresco: bloquear la del preflight mediría el
 * `PRESUPUESTO_RELECTURA_MS = 4_000` del preflight y no el diferimiento.
 *
 * ## Lo que este archivo NO afirma, a propósito
 *
 * - **Que la escritura local NO escriba `effective_status` ni los presupuestos**
 *   (§Fix Implementation, C2). (c) y (d) sí cubren `synced_at` y `desaparecido_at`
 *   en la ventana previa al refresco; el resto es preservación y lo verifican la
 *   task 8 y la 14.5 sobre `route.frescura.test.ts`, que afirma `marca` y `sync`
 *   y **no `status`**: por eso la Escritura_Confirmada_Local no lo contradice.
 * - **La latencia real de Meta.** Los 30 s son el timeout declarado, no una
 *   medición: la base local no tiene filas de `ad_actions` con tiempos de
 *   producción y eso ya está declarado como no verificable en §Testing Strategy.
 */

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

vi.mock('../../../../lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/auth')>();
  return { ...actual, isAuthenticated: vi.fn(() => true), getClientIp: () => 'test-ip' };
});

// `guard()` delega en `guardSeccion` de lib/permisos (T03), que ya no lee
// `isAuthenticated`: consulta la base a través de una sesión real. Este test
// no ejercita el 401, así que el mock siempre deja pasar con sesión admin.
vi.mock('../../../../lib/permisos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/permisos')>();
  return {
    ...actual,
    guardSeccion: vi.fn(async () => ({
      sesion: {
        usuarioId: 1,
        usuario: 'test',
        nombre: 'Test',
        esAdmin: true,
        debeCambiarClave: false,
        secciones: actual.SECCIONES,
        esFallback: false,
      },
    })),
  };
});

vi.mock('../../../../lib/ads/meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/ads/meta')>();
  return {
    ...actual,
    enviar: vi.fn(),
    fetchObjeto: vi.fn(),
    fetchMinimoPresupuesto: vi.fn().mockResolvedValue(null),
  };
});

const mockEnviar = vi.mocked(enviar);
const mockFetchObjeto = vi.mocked(fetchObjeto);
const mockAuth = vi.mocked(isAuthenticated);

// ─── Deferred: la relectura que no vuelve, sin reloj ─────────────────────────

type Deferred<T> = { promesa: Promise<T>; resolver: (v: T) => void };

/**
 * Una promesa que el test resuelve cuando quiere. Es el reemplazo del
 * `setTimeout(30_000)` que el diseño prohíbe: mide lo mismo —«la relectura no
 * volvió»— sin gastar 30 s ni depender del reloj de la máquina.
 */
function deferido<T>(): Deferred<T> {
  let resolver!: (v: T) => void;
  const promesa = new Promise<T>((res) => {
    resolver = res;
  });
  return { promesa, resolver };
}

/**
 * La gracia que se le da a la respuesta DESPUÉS de que la relectura arrancó.
 *
 * El reloj no arranca con el POST sino con la primera llamada a `fetchObjeto`, y
 * eso es lo que hace que la carrera sea determinista: lo que tarde Postgres en el
 * preflight, en `abrirAccion` y en `cerrarAccion` queda fuera de la medición. Lo
 * único que se mide es lo que pasa entre «la relectura arrancó» y «la respuesta
 * salió», que es exactamente C₄.
 */
const MS_GRACIA = 250;

const esperar = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Siembra ─────────────────────────────────────────────────────────────────

const CUENTA = `TCD-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
// ids de 20 dígitos: el esquema cerrado exige ^\d{1,20}$
const CAMP_LENTA = '19170000000000000001';
const CAMP_SIN_OBJETO = '19170000000000000002';
// Las dos de (c) y (d): viejas Y marcadas, porque lo que miden es la marca.
const CAMP_DIF_VUELVE = '19170000000000000003';
const CAMP_DIF_AUSENTE = '19170000000000000004';

/**
 * Dos pares de filas, y la diferencia entre ellos es una decisión de aislamiento
 * explicada en el encabezado:
 *
 * - `CAMP_LENTA` y `CAMP_SIN_OBJETO`, para (a) y (b): **frescas y sin marca**, así
 *   `causaDeRelectura` devuelve `null`, el preflight no relee y la única llamada a
 *   `fetchObjeto` del request es la de `refrescarJerarquia`.
 * - `CAMP_DIF_VUELVE` y `CAMP_DIF_AUSENTE`, para (c) y (d): **viejas y marcadas**,
 *   porque lo que esos casos miden es qué le pasa a `desaparecido_at` y a
 *   `synced_at` cuando el refresco corre del otro lado de la respuesta. La
 *   contrapartida es que el preflight también relee: son dos llamadas.
 *
 * En los cuatro, `status = 'ACTIVE'` con `pause` para que la escritura sea un
 * cambio real y el preflight no la omita por `ya_esta_en_ese_estado`.
 */
async function sembrar(): Promise<void> {
  await q(
    `INSERT INTO ad_accounts (account_id, platform, name, currency, active, timezone)
     VALUES ($1, 'meta', 'test C4 diferido', 'EUR', true, 'Europe/Lisbon')
     ON CONFLICT (account_id) DO UPDATE SET active = true`,
    [CUENTA],
  );
  await q(
    `INSERT INTO ad_campaigns (campaign_id, account_id, name, status, effective_status,
                               budget_level, currency, synced_at, desaparecido_at) VALUES
       ($1, $3, 'Campaña con relectura lenta', 'ACTIVE', 'ACTIVE', 'adset', 'EUR', now(), NULL),
       ($2, $3, 'Campaña que Meta no devuelve', 'ACTIVE', 'ACTIVE', 'adset', 'EUR', now(), NULL)
     ON CONFLICT (campaign_id) DO UPDATE
       SET status = 'ACTIVE', effective_status = 'ACTIVE',
           synced_at = now(), desaparecido_at = NULL`,
    [CAMP_LENTA, CAMP_SIN_OBJETO, CUENTA],
  );
  // Las de (c) y (d), en su propio INSERT porque su `ON CONFLICT` es el opuesto:
  // acá la fila tiene que quedar VIEJA y MARCADA, y el de arriba la limpia.
  await q(
    `INSERT INTO ad_campaigns (campaign_id, account_id, name, status, effective_status,
                               budget_level, currency, synced_at, desaparecido_at) VALUES
       ($1, $3, 'Campaña que el refresco diferido vuelve a ver', 'ACTIVE', 'ACTIVE', 'adset', 'EUR',
        now() - interval '3 days', now() - interval '2 days'),
       ($2, $3, 'Campaña que el refresco diferido no ve', 'ACTIVE', 'ACTIVE', 'adset', 'EUR',
        now() - interval '3 days', now() - interval '2 days')
     ON CONFLICT (campaign_id) DO UPDATE
       SET account_id = EXCLUDED.account_id, status = 'ACTIVE', effective_status = 'ACTIVE',
           synced_at = now() - interval '3 days',
           desaparecido_at = now() - interval '2 days'`,
    [CAMP_DIF_VUELVE, CAMP_DIF_AUSENTE, CUENTA],
  );
  // El backoff por cuota rechaza el pedido antes del preflight: se limpia acá
  // para que un archivo anterior de la suite no decida el resultado de este.
  await q(
    `UPDATE settings SET value = '""'::jsonb WHERE key IN ('ads_backoff_until', 'ads_backoff_reason')`,
  );
}

async function fila(
  campaignId: string,
): Promise<{ marca: string | null; sync: string; status: string | null } | null> {
  return await q1<{ marca: string | null; sync: string; status: string | null }>(
    `SELECT desaparecido_at::text AS marca, synced_at::text AS sync, status
       FROM ad_campaigns WHERE campaign_id = $1`,
    [campaignId],
  );
}

const pedir = (body: Record<string, unknown>): Promise<Response> =>
  POST(
    new Request('http://localhost/api/ads/acciones', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
  );

const cuerpoPause = (campaignId: string): Record<string, unknown> => ({
  level: 'campaign',
  accountId: CUENTA,
  action: 'pause',
  objectIds: [campaignId],
});

beforeAll(async () => {
  if (!dbAvailable) return;
  await sembrar();
});

afterAll(async () => {
  if (!dbAvailable) return;
  await q('DELETE FROM ad_actions WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_campaigns WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_accounts WHERE account_id = $1', [CUENTA]);
});

// Feature: toggle-conjuntos-entrega, Property 7: Bug Condition — La respuesta no
// espera la relectura, y el refetch no retrocede
//
// **Validates: Requirements 2.13, 2.14**
describe.skipIf(!dbAvailable)('Property 7: la respuesta no espera la relectura (C₄)', () => {
  it('(a) la respuesta sale ANTES de que `fetchObjeto` vuelva (1.16, 2.13)', async () => {
    mockAuth.mockImplementation(() => true);
    mockEnviar.mockClear();
    mockFetchObjeto.mockClear();
    mockEnviar.mockResolvedValue({ estado: 'confirmado' });

    // La relectura que no vuelve, y el aviso de que arrancó. El `entrada` es lo
    // que hace determinista la carrera: el reloj de la gracia no arranca con el
    // POST sino con la relectura.
    const bloqueo = deferido<MetaObjetoLeido | null>();
    const entrada = deferido<void>();
    mockFetchObjeto.mockImplementation(() => {
      entrada.resolver();
      return bloqueo.promesa;
    });

    const promesaPost = pedir(cuerpoPause(CAMP_LENTA));

    const carrera = await Promise.race([
      promesaPost.then(() => 'respuesta' as const),
      entrada.promesa.then(() => esperar(MS_GRACIA)).then(() => 'timer' as const),
    ]);

    // Se libera SIEMPRE, gane quien gane: un deferred sin resolver dejaría el
    // request colgado y la conexión de Postgres ocupada para el resto de la
    // suite, que corre con `fileParallelism: false` contra las mismas tablas.
    bloqueo.resolver(null);
    const resp = await promesaPost;

    // GUARDA DEL ARMADO, antes de la aserción que importa: si el preflight
    // también hubiera releído, la carrera mediría otra cosa y el fallo diría lo
    // que no es. Ver el encabezado, «El armado es el de route.frescura.test.ts».
    expect(
      mockFetchObjeto,
      'la única llamada a fetchObjeto tiene que ser la de refrescarJerarquia: si son dos, el preflight releyó y la carrera no mide C₄',
    ).toHaveBeenCalledTimes(1);
    expect(mockFetchObjeto).toHaveBeenCalledWith(CAMP_LENTA, 'campaign');

    // La escritura ocurrió y Meta la confirmó: lo que se mide es CUÁNDO sale la
    // respuesta, no si sale bien.
    expect(resp.status).toBe(200);
    const cuerpo = (await resp.json()) as { resultados: { estado: string }[] };
    expect(cuerpo.resultados[0]?.estado).toBe('confirmado');

    // LA ASERCIÓN QUE FALLA HOY. `await refrescarJerarquia(...)` en
    // `route.ts:576` pone el GET a Meta —con su propio AbortSignal de 30 s—
    // adentro del tiempo del usuario.
    expect(
      carrera,
      `la respuesta esperó a que \`fetchObjeto\` volviera: ${MS_GRACIA} ms después de que la relectura arrancó, ` +
        'el POST todavía no había respondido. Los 30 s del AbortSignal de `pedir` están dentro del tiempo del usuario.',
    ).toBe('respuesta');

    // LA GUARDA DEL ACOPLAMIENTO C↔D (task 15), y va acá porque acá está la
    // medición: `carrera` es lo que el route hace de verdad, y el flag de
    // `lib/ads/plazos.ts` es lo que el peor caso del servidor AFIRMA que hace.
    // Esta línea los liga, así que el desajuste es una falla de suite y no una
    // convención que alguien tiene que recordar. Ver el encabezado, «LA GUARDA
    // DEL ACOPLAMIENTO C↔D».
    const laRespuestaEsperoLaRelectura = carrera !== 'respuesta';
    expect(
      refrescoEnCaminoCritico(),
      `refrescoEnCaminoCritico() dice ${refrescoEnCaminoCritico()} y el route ` +
        `${laRespuestaEsperoLaRelectura ? 'SÍ' : 'NO'} espera la relectura. ` +
        'De ese flag sale el término PLAZO_META_LECTURA_MS del peor caso del servidor, y de ese peor ' +
        'caso sale el plazo del cliente: con el flag en false y el route esperando, el plazo queda 30 s ' +
        'MÁS CORTO que el servidor y un click que iba a confirmarse se abandona como `indeterminado` ' +
        '(R2.7). Mover la llamada y cambiar el flag son un solo cambio, no dos.',
    ).toBe(laRespuestaEsperoLaRelectura);
  });

  it('(b) cuando la respuesta sale, la base ya tiene el `status` confirmado (1.18, 1.19, 2.14)', async () => {
    mockAuth.mockImplementation(() => true);
    mockEnviar.mockClear();
    mockFetchObjeto.mockClear();
    mockEnviar.mockResolvedValue({ estado: 'confirmado' });
    // Meta confirma la escritura y NO devuelve el objeto. Es un caso real —el
    // `CAMP_AUSENTE` de `route.frescura.test.ts` está sembrado justo para él— y
    // acá hace dos cosas: dispara el `return` temprano de `refrescarJerarquia`,
    // que es el que deja la fila con el `status` anterior, y **aísla la medición**
    // del refresco diferido que la task 14 va a agregar, porque un refresco que
    // no ve la fila no escribe nada. O sea que después del arreglo esta aserción
    // sigue midiendo la escritura LOCAL y no la relectura.
    mockFetchObjeto.mockResolvedValue(null);

    const antes = await fila(CAMP_SIN_OBJETO);
    expect(antes?.status).toBe('ACTIVE');

    const resp = await pedir(cuerpoPause(CAMP_SIN_OBJETO));
    expect(resp.status).toBe(200);
    const cuerpo = (await resp.json()) as { resultados: { estado: string }[] };
    expect(cuerpo.resultados[0]?.estado).toBe('confirmado');

    // La misma guarda del armado que en (a): una sola llamada, la de la relectura.
    expect(mockFetchObjeto).toHaveBeenCalledTimes(1);

    // Se lee INMEDIATAMENTE después de la respuesta, que es lo que hace el
    // refetch del cliente. Con el arreglo, el `esperarRefrescosPendientes()` del
    // puente no cambia esta lectura: la escritura local ya ocurrió antes de que
    // la respuesta saliera, y el refresco diferido de este caso no escribe.
    await esperarRefrescosPendientes();
    const despues = await fila(CAMP_SIN_OBJETO);

    // LA ASERCIÓN QUE FALLABA ANTES DE LA TASK 14, y el contraejemplo quedó en el
    // mensaje. Sin la Escritura_Confirmada_Local, `refrescarJerarquia` era el
    // ÚNICO escritor del `status` confirmado y cortaba en su `return` temprano, así
    // que la fila quedaba con `ACTIVE` después de un `pause` que Meta confirmó. El
    // refetch del cliente devolvía la posición vieja y el interruptor volvía para
    // atrás: es 1.19.
    expect(
      despues?.status,
      `la base devuelve status=${JSON.stringify(despues?.status)} después de un desenlace \`confirmado\` de \`pause\`: ` +
        'la escritura ocurrió en Meta y la fila local no la tiene, así que un refetch inmediato del cliente devuelve la posición vieja (1.19)',
    ).toBe('PAUSED');
  });

  it('(c) el refresco diferido que TRAE la fila limpia la marca y adelanta el reloj, DESPUÉS de la respuesta (2.13, R4.7)', async () => {
    mockAuth.mockImplementation(() => true);
    mockEnviar.mockClear();
    mockFetchObjeto.mockClear();
    mockEnviar.mockResolvedValue({ estado: 'confirmado' });

    const leido: MetaObjetoLeido = {
      objectId: CAMP_DIF_VUELVE,
      name: 'Campaña que el refresco diferido vuelve a ver',
      status: 'ACTIVE',
      effectiveStatus: 'ACTIVE',
      dailyBudget: null,
      lifetimeBudget: null,
    };

    // La PRIMERA llamada es la del preflight —la fila está marcada, así que
    // `causaDeRelectura` devuelve `'desaparecida'`— y vuelve enseguida: bloquearla
    // mediría el presupuesto de 4 s del preflight y no el diferimiento. La
    // SEGUNDA es la del refresco, y ésa es la que queda bloqueada hasta que el
    // test la suelta. Así la ventana «la respuesta salió y el refresco todavía no
    // escribió» es determinista.
    const bloqueo = deferido<MetaObjetoLeido | null>();
    const entrada = deferido<void>();
    let llamadas = 0;
    mockFetchObjeto.mockImplementation(() => {
      llamadas += 1;
      if (llamadas === 1) return Promise.resolve(leido);
      entrada.resolver();
      return bloqueo.promesa;
    });

    const antes = await fila(CAMP_DIF_VUELVE);
    expect(antes?.marca).not.toBeNull();
    expect(antes?.status).toBe('ACTIVE');

    const resp = await pedir(cuerpoPause(CAMP_DIF_VUELVE));
    expect(resp.status).toBe(200);
    const cuerpo = (await resp.json()) as { resultados: { estado: string }[] };
    expect(cuerpo.resultados[0]?.estado).toBe('confirmado');

    // Guarda del armado: dos llamadas, la del preflight y la del refresco. Si
    // fuera una, el refresco no arrancó y lo que sigue no mide nada.
    expect(
      mockFetchObjeto,
      'tienen que ser dos: la del preflight (la fila está marcada) y la del refresco diferido',
    ).toHaveBeenCalledTimes(2);
    await entrada.promesa;

    // LA VENTANA. El refresco arrancó y está bloqueado, así que esto no es una
    // carrera: es el estado en el que la respuesta dejó la fila.
    const enLaVentana = await fila(CAMP_DIF_VUELVE);

    // Se libera ANTES de afirmar, por el mismo motivo por el que (a) libera «gane
    // quien gane»: un `expect` que falla corta el `it`, y un deferred sin resolver
    // dejaría el refresco pendiente para siempre. Con eso, el
    // `esperarRefrescosPendientes()` del caso (d) esperaría una promesa que nunca
    // llega y el fallo de ACÁ se leería como un timeout ALLÁ. Se probó: pasa.
    bloqueo.resolver(leido);
    await esperarRefrescosPendientes();
    const despues = await fila(CAMP_DIF_VUELVE);

    // La escritura local puso el `status` confirmado **y nada más** (decisión C2),
    // y ésa es la razón por la que un refetch inmediato del cliente ya no
    // retrocede.
    expect(enLaVentana?.status, 'la Escritura_Confirmada_Local ya ocurrió').toBe('PAUSED');
    expect(enLaVentana?.marca, 'la marca la limpia SÓLO la relectura, que todavía no volvió').toBe(
      antes?.marca,
    );
    expect(enLaVentana?.sync, 'la escritura local no adelanta `synced_at`').toBe(antes?.sync);

    // Y el refresco, cuando vuelve, hace su trabajo completo. Es lo que R4.7 pedía
    // «sin el atraso del cron», y sigue cumpliéndose con el atraso del diferido:
    // segundos, no 15 minutos.
    expect(despues?.marca, 'la relectura trajo la fila: el objeto existe y la marca se va').toBeNull();
    expect(new Date(despues!.sync).getTime()).toBeGreaterThan(new Date(antes!.sync).getTime());
    // El `status` que la relectura trajo pisa al de la escritura local, y está
    // bien: es el dato de Meta y es más nuevo que nuestra inferencia.
    expect(despues?.status).toBe('ACTIVE');
  });

  it('(d) el refresco diferido que NO trae la fila deja la marca, y el `status` confirmado queda (2.14, C3)', async () => {
    mockAuth.mockImplementation(() => true);
    mockEnviar.mockClear();
    mockFetchObjeto.mockClear();
    mockEnviar.mockResolvedValue({ estado: 'confirmado' });
    // Meta no devuelve el objeto en ninguna de las dos lecturas. Para el preflight
    // es `no_encontrado` y la acción sigue con el dato de la base (R6.2); para el
    // refresco es el `return` temprano que deja la marca intacta.
    mockFetchObjeto.mockResolvedValue(null);

    const antes = await fila(CAMP_DIF_AUSENTE);
    expect(antes?.marca).not.toBeNull();

    const resp = await pedir(cuerpoPause(CAMP_DIF_AUSENTE));
    expect(resp.status).toBe(200);
    const cuerpo = (await resp.json()) as { resultados: { estado: string }[] };
    expect(cuerpo.resultados[0]?.estado).toBe('confirmado');

    expect(
      mockFetchObjeto,
      'tienen que ser dos: la del preflight (la fila está marcada) y la del refresco diferido',
    ).toHaveBeenCalledTimes(2);

    await esperarRefrescosPendientes();
    const despues = await fila(CAMP_DIF_AUSENTE);

    // La regla evidenciaria de C3: «Meta no nos dio el objeto» es la MISMA
    // evidencia con la que el sync PONE la marca, así que una escritura confirmada
    // sola —la mitad de la evidencia— no la borra.
    expect(despues?.marca, 'sin relectura que traiga la fila, la marca queda').toBe(antes?.marca);
    expect(despues?.sync).toBe(antes?.sync);
    // Y al mismo tiempo el `status` confirmado sí está: son dos escritores con dos
    // alcances, y es lo que hace que diferir la relectura no cueste la regresión
    // de 1.19 ni afloje la regla de la marca.
    expect(despues?.status).toBe('PAUSED');
  });
});
