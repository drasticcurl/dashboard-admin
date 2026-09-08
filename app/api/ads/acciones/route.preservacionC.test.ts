import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { q, q1 } from '../../../../lib/db';
import { POST } from './route';
import { enviar, fetchObjeto } from '../../../../lib/ads/meta';
import { isAuthenticated } from '../../../../lib/auth';

/**
 * Property 8 (Preservation) de `toggle-conjuntos-entrega`, task 8 — el baseline
 * de 3.9, observado contra el código SIN arreglar.
 *
 * ## ESTE ARCHIVO PASA HOY, Y ESO ES EL PUNTO
 *
 * Al revés que `route.diferido.test.ts`, que es la exploración de la misma tanda
 * y falla a propósito. Acá se corre el código sin arreglar sobre un input de ¬C₄,
 * se anota lo que hace y el test afirma eso. La task 14.5 lo vuelve a correr.
 *
 * ## POR QUÉ ESTE ARCHIVO EXISTE Y NO ES UN RENGLÓN EN OTRO
 *
 * De las tres cosas que la tanda C no puede cambiar, DOS ya están cubiertas y no
 * se duplican acá —se nombran para que el baseline sea rastreable y no un «ya
 * está en algún lado»—:
 *
 * - **3.12 y la mitad de secuencia de 3.13**: `secuenciaPedidos.test.ts`, 21
 *   tests, verde. `conservarPintadoEnVuelo` conserva el `status` en pantalla de
 *   los ids en vuelo —incluido un `status` nulo, que es el caso que el Pintado
 *   Optimista rompía— y la Property 7 de ese archivo («Monotonía del estado de
 *   pantalla») fija que una respuesta vieja no pisa una más nueva para todo orden
 *   de llegada.
 * - **La otra mitad de 3.13, el presupuesto de espera propio de la lectura**:
 *   `leerFilas` (`GestorAnuncios.tsx:575`) arma su `AbortController` con el
 *   `timeoutMs` que recibe, y sus tres llamadores le pasan 30 s (el default de
 *   `pedirFilas`), 60 s (el Botón Actualizar, `:1064`) y `TOPES_ABORTO = 10_000`
 *   (el refetch posterior a un lote, `:1359`). **Eso NO tiene test ejecutable y
 *   queda declarado como hueco, no tapado**: `leerFilas` hace un `fetch` real y
 *   no recibe el fetch por parámetro, así que la única forma de afirmarlo sería
 *   mockear `globalThis.fetch`, que es más armado que lo que compra. La tanda C
 *   no toca `leerFilas` ni sus llamadores, así que el hueco no crece con este
 *   spec; `togglePlazo.test.ts` (task 2) ya lo usa como el lado sano de la
 *   asimetría lectura/escritura del bug 2.
 *
 * Lo que sí faltaba —y es lo único que este archivo agrega— es la mitad de 3.9
 * que dice **ANTES**.
 *
 * ## QUÉ ESTABA CUBIERTO DE 3.9 Y QUÉ NO
 *
 * «Queda `confirmado`» sí lo estaba, dos veces: la Property de `route.test.ts`
 * afirma exactamente una fila `manual` por objeto intentado, ninguna `pendiente`
 * al terminar y el `estado` final que le toca a cada desenlace (`confirmado`,
 * `fallido`, `indeterminado`); y `route.discrepancia.test.ts` lo lee de la base
 * para el camino de `pause`.
 *
 * «Se abre **ANTES** del POST» no lo estaba. Lo más cerca que hay son dos
 * observaciones indirectas: que una acción OMITIDA deja fila aunque `enviar`
 * nunca se llame (`route.discrepancia.test.ts`) y que una escritura `fallido` o
 * `indeterminado` también deja fila (`route.test.ts`). Las dos son consistentes
 * con el orden correcto y ninguna lo fija: un route que abriera la fila DESPUÉS
 * del POST, con el desenlace ya en mano, las pasaría a las dos.
 *
 * **Y es justo el orden que la tanda C puede romper.** La Escritura_Confirmada
 * Local se agrega en esa misma región de `route.ts` —entre el POST y el cierre— y
 * el diseño la autoriza a escribir `status` y nada más. Un reordenamiento que
 * mueva `abrirAccion` para juntarlo con la escritura local dejaría la fila de
 * auditoría abierta después de la llamada a Meta: si el proceso se muere entre
 * las dos, la escritura ocurrió en Meta y no quedó registrada en ninguna parte,
 * que es lo que 3.9 existe para impedir. La forma de fijarlo es mirar la base
 * **desde adentro del POST**, que es lo que hace el test de abajo.
 *
 * ## EL ARMADO, Y POR QUÉ LA FILA VA FRESCA
 *
 * Es el de `route.diferido.test.ts`: mocks de `lib/auth` y de `lib/ads/meta`,
 * cuenta con sufijo único, nivel campaña —el único que se ejercita de punta a
 * punta, porque `leerObjetos` selecciona `o.daily_budget` y `ads` no tiene esa
 * columna— y la fila **fresca y sin marca de desaparición**, para que
 * `causaDeRelectura` devuelva `null` y el preflight no releea. Sin eso, el
 * `fetchObjeto` del preflight se mezcla con el de `refrescarJerarquia` y la
 * observación mediría un request con dos viajes en vez de uno.
 *
 * `abrirAccion` corre en autocommit (`q1` suelto, sin transacción abierta), así
 * que la consulta que el mock de `enviar` hace por otra conexión VE la fila. Si
 * algún día eso se envuelve en una transacción, este test se pone rojo y hay que
 * leerlo como lo que sería: la fila dejó de estar visible antes del POST.
 *
 * ## VERIFICADO A MANO QUE MIDE EL ORDEN Y NO SU PROPIO ARMADO
 *
 * Un test de preservación que pasa no prueba nada si pasaría igual con el
 * comportamiento roto. Así que se corrió el experimento inverso, con el mismo
 * criterio con el que la task 4 verificó su caso (a): mover el bloque
 * `abrirAccion` de `route.ts` a DESPUÉS del `try/catch` del `enviar` —el
 * reordenamiento que 3.9 prohíbe, y el único cambio— y correr este archivo.
 * Resultado, textual:
 *
 *     Tests  1 failed (1)
 *     → no había ninguna fila de ad_actions cuando `enviar` arrancó: la fila se
 *       abre DESPUÉS del POST y una escritura que ocurra en Meta puede quedar sin
 *       registrar: expected null not to be null
 *
 * O sea: falla, y falla por la aserción que corresponde y con el mensaje que
 * explica el daño. `route.ts` quedó **sin modificar** por esta task (`git status`
 * limpio para ese archivo).
 *
 * Vale la pena anotar qué pasó con los OTROS tests en esa corrida invertida: los
 * de `route.discrepancia.test.ts` y la Property de `route.test.ts` no se corrieron
 * en el experimento, pero por lo que afirman habrían seguido verdes —el estado
 * final de la fila no cambia con el reordenamiento—. Es la razón por la que este
 * archivo hacía falta.
 *
 * NECESITA POSTGRES.
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

const CUENTA = `TP8-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
// id de 20 dígitos: el esquema cerrado exige ^\d{1,20}$
const CAMP = '19180000000000000001';

type FilaAccion = { id: string; estado: string; ok: boolean; action: string };

/** La última fila de auditoría del objeto, o `null` si todavía no hay ninguna. */
async function accion(): Promise<FilaAccion | null> {
  return await q1<FilaAccion>(
    `SELECT id::text AS id, estado, ok, action FROM ad_actions
      WHERE account_id = $1 AND object_id = $2 AND source = 'manual'
      ORDER BY id DESC LIMIT 1`,
    [CUENTA, CAMP],
  );
}

async function cuantasFilas(): Promise<number> {
  const r = await q1<{ n: number }>(
    `SELECT count(*)::int AS n FROM ad_actions WHERE account_id = $1 AND object_id = $2`,
    [CUENTA, CAMP],
  );
  return r?.n ?? 0;
}

async function sembrar(): Promise<void> {
  await q(
    `INSERT INTO ad_accounts (account_id, platform, name, currency, active, timezone)
     VALUES ($1, 'meta', 'test P8 preservación C', 'EUR', true, 'Europe/Lisbon')
     ON CONFLICT (account_id) DO UPDATE SET active = true`,
    [CUENTA],
  );
  // Fresca y sin marca: `causaDeRelectura` devuelve `null` y el preflight no
  // relee. `ACTIVE` con `pause` para que la escritura sea un cambio real y el
  // preflight no la omita por `ya_esta_en_ese_estado`.
  await q(
    `INSERT INTO ad_campaigns (campaign_id, account_id, name, status, effective_status,
                               budget_level, currency, synced_at, desaparecido_at)
     VALUES ($1, $2, 'Campaña P8', 'ACTIVE', 'ACTIVE', 'adset', 'EUR', now(), NULL)
     ON CONFLICT (campaign_id) DO UPDATE
       SET status = 'ACTIVE', effective_status = 'ACTIVE', synced_at = now(), desaparecido_at = NULL`,
    [CAMP, CUENTA],
  );
  // Un backoff por cuota dejado por otro archivo de la suite rechaza el pedido
  // antes del preflight y este test mediría otra cosa.
  await q(
    `UPDATE settings SET value = '""'::jsonb WHERE key IN ('ads_backoff_until', 'ads_backoff_reason')`,
  );
}

const pedir = (): Promise<Response> =>
  POST(
    new Request('http://localhost/api/ads/acciones', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        level: 'campaign',
        accountId: CUENTA,
        action: 'pause',
        objectIds: [CAMP],
      }),
    }) as never,
  );

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

// Feature: toggle-conjuntos-entrega, Property 8: Preservation — El pintado, la
// reversión y la marca de desaparición
//
// **Validates: Requirements 3.9**
describe.skipIf(!dbAvailable)('Property 8: la fila de ad_actions se abre ANTES del POST (3.9)', () => {
  it('cuando `enviar` arranca la fila ya existe en `pendiente`, y ES LA MISMA que queda `confirmado`', async () => {
    mockAuth.mockImplementation(() => true);
    mockEnviar.mockReset();
    mockFetchObjeto.mockReset();
    // La relectura de la jerarquía no devuelve el objeto: así no escribe nada y la
    // observación queda aislada de lo que la tanda C va a mover.
    mockFetchObjeto.mockResolvedValue(null);

    // LA OBSERVACIÓN: se mira la base DESDE ADENTRO del POST a Meta. Es el único
    // momento en el que el orden es visible; después de la respuesta las dos
    // versiones —abrir antes o abrir después— dejan la misma fila.
    let alMomentoDelPost: FilaAccion | null | undefined;
    mockEnviar.mockImplementation(async () => {
      alMomentoDelPost = await accion();
      return { estado: 'confirmado' };
    });

    expect(await cuantasFilas(), 'la siembra no deja filas de ad_actions').toBe(0);

    const resp = await pedir();
    expect(resp.status).toBe(200);
    const cuerpo = (await resp.json()) as { resultados: { estado: string }[] };
    expect(cuerpo.resultados[0]?.estado).toBe('confirmado');

    // Guarda del armado: si `enviar` no se llamó, no hubo POST y no hay orden que
    // observar. Sin esto un preflight que omitiera la acción dejaría el test verde
    // sin haber medido nada.
    expect(mockEnviar, 'el POST a Meta tiene que haber salido').toHaveBeenCalledWith(CAMP, {
      status: 'PAUSED',
    });
    expect(alMomentoDelPost, 'el mock de `enviar` no llegó a mirar la base').not.toBeUndefined();

    // 3.9, primera mitad: la fila EXISTÍA cuando el POST arrancó, y estaba abierta.
    expect(
      alMomentoDelPost,
      'no había ninguna fila de ad_actions cuando `enviar` arrancó: la fila se abre DESPUÉS del POST y una escritura que ocurra en Meta puede quedar sin registrar',
    ).not.toBeNull();
    expect(alMomentoDelPost!.estado).toBe('pendiente');
    expect(alMomentoDelPost!.ok).toBe(false);
    expect(alMomentoDelPost!.action).toBe('pause');

    // 3.9, segunda mitad: queda `confirmado`. Y **es la misma fila**: se compara el
    // id, no el estado. Un route que abriera una fila nueva en el cierre dejaría
    // también un `confirmado` en la base, con la `pendiente` huérfana al lado.
    const despues = await accion();
    expect(despues?.id).toBe(alMomentoDelPost!.id);
    expect(despues?.estado).toBe('confirmado');
    expect(despues?.ok).toBe(true);
    expect(await cuantasFilas(), 'una acción, una fila').toBe(1);
  });
});
