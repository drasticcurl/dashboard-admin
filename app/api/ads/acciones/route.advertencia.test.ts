import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { q } from '../../../../lib/db';
import { POST } from './route';
import { enviar, fetchObjeto, MetaAdsError } from '../../../../lib/ads/meta';
import { isAuthenticated } from '../../../../lib/auth';
import { mensajeDeResultado, type CuerpoAcciones } from '../../../../lib/ads/mensajes';

/**
 * El cableado de la advertencia de la task 15 en el route (R6.4, R3.4).
 *
 * QUÉ DEFIENDE ESTE ARCHIVO Y NO `previsualizacion.test.ts`. Ese prueba que
 * `calcularPrevisualizacion` PONE la advertencia cuando el padre está pausado.
 * Nada de eso llega al usuario si el route no la copia al resultado: el preflight
 * la calculaba, la revalidación la volvía a calcular y el bucle la descartaba,
 * así que la respuesta era idéntica a la de un objeto que sí iba a entregar. Lo
 * que se verifica acá es el viaje: base → preflight → cuerpo HTTP → aviso.
 *
 * LOS TRES DESENLACES, que son los tres `resultados.push` del bucle de estado:
 *
 * 1. `omitido`. Un conjunto ACTIVE bajo una campaña pausada: activarlo se omite
 *    por «ya está en ese estado» Y el objeto no entrega. Contra la cuenta real son
 *    92 de 169 conjuntos, así que es el caso mayoritario, no el borde.
 * 2. `confirmado`. Un conjunto PAUSED bajo una campaña pausada: la escritura se
 *    hace, Meta la confirma y el objeto igual no entrega. Es el caso reportado
 *    como "parece que lo habilita pero realmente no lo hace" con las tres filas
 *    de `manual activate` en `confirmado` de la auditoría.
 * 3. `fallido`. Meta rechaza; la advertencia sigue siendo cierta y viaja igual.
 *
 * Y el caso que NO tiene que advertir nada: la misma acción con la campaña
 * activa. Sin él, un route que devolviera la advertencia siempre pasaría los tres
 * de arriba sin informar nada.
 *
 * A nivel `adset` porque es donde vive R6.4: una campaña no tiene padre y un
 * `pause`/`activate` a nivel `ad` no llega al bucle (`leerObjetos` selecciona
 * columnas de presupuesto que `ads` no tiene).
 *
 * `synced_at = now()` en todos: con el dato fresco la relectura selectiva no
 * corre y el resultado no depende de lo que `fetchObjeto` devuelva antes de
 * decidir. Lo que se mide acá es la advertencia, no la revalidación.
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

const CUENTA = `T15R-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** ids de 20 dígitos (R17 c3), colgados del reloj: las PK de `ad_sets` son
 *  globales y una corrida cortada a mitad no puede chocar con la siguiente. */
const RAIZ = `150${Date.now()}${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`;
const oid = (n: number): string => `${RAIZ}${String(n).padStart(2, '0')}`;

const CAMP_APAGADA = oid(0);
const CAMP_PRENDIDA = oid(1);
/** Ya ACTIVE bajo la campaña pausada: activarlo se omite y no entrega. */
const S_YA_ACTIVO = oid(2);
/** PAUSED bajo la campaña pausada: la escritura ocurre y no entrega. */
const S_SE_ACTIVA = oid(3);
/** Igual que el anterior, para la rama del rechazo de Meta. */
const S_FALLA = oid(4);
/** PAUSED bajo la campaña ACTIVA: no hay nada que advertir. */
const S_SIN_AVISO = oid(5);
/**
 * Los dos de la task 12 de `toggle-conjuntos-entrega` (2.11), y van aparte de los
 * cuatro de arriba a propósito: el `pause` de uno de ellos ESCRIBE, así que el
 * `refrescarJerarquia` del route le deja `status = 'PAUSED'` en la base. Reusar
 * `S_YA_ACTIVO` haría que el orden de los `it` de este archivo decidiera si el
 * caso de la omisión sigue valiendo, que es la forma más barata de tener una
 * suite frágil.
 */
/** ACTIVE / CAMPAIGN_PAUSED bajo la campaña pausada: uno de los 92. Pausarlo escribe. */
const S_PAUSA_ACTIVO = oid(6);
/** PAUSED bajo la campaña pausada: uno de los 67. Pausarlo se omite. */
const S_PAUSA_PAUSADO = oid(7);

type ResultadoHttp = {
  estado: string;
  motivo?: string;
  advertencia?: string | null;
  mensaje: string | null;
};

const pedir = (body: Record<string, unknown>): Promise<Response> =>
  POST(
    new Request('http://localhost/api/ads/acciones', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
  );

/** El pedido de activación de UN conjunto, con el cuerpo ya deserializado: es lo
 *  que después se le pasa al traductor, sin volver a escribirlo a mano. */
async function accionar(
  accion: 'activate' | 'pause',
  adsetId: string,
): Promise<{ cuerpo: CuerpoAcciones; r: ResultadoHttp }> {
  const resp = await pedir({
    level: 'adset',
    accountId: CUENTA,
    action: accion,
    objectIds: [adsetId],
  });
  expect(resp.status).toBe(200);
  const cuerpo = (await resp.json()) as CuerpoAcciones & { resultados: ResultadoHttp[] };
  const r = cuerpo.resultados[0];
  if (!r) throw new Error(`la respuesta no trajo resultado para ${adsetId}`);
  return { cuerpo, r };
}

const activar = (adsetId: string): Promise<{ cuerpo: CuerpoAcciones; r: ResultadoHttp }> =>
  accionar('activate', adsetId);

/** El espejo de `activar` para la task 12 de `toggle-conjuntos-entrega` (2.11). */
const pausar = (adsetId: string): Promise<{ cuerpo: CuerpoAcciones; r: ResultadoHttp }> =>
  accionar('pause', adsetId);

async function sembrar(): Promise<void> {
  await q(
    `INSERT INTO ad_accounts (account_id, platform, name, currency, active, timezone)
     VALUES ($1, 'meta', 'test T15 route', 'EUR', true, 'Europe/Lisbon')
     ON CONFLICT (account_id) DO UPDATE SET active = true, currency = 'EUR'`,
    [CUENTA],
  );
  // ABO (`budget_level = 'adset'`), como las dos cuentas reales. Una campaña
  // PAUSED y una ACTIVE: la diferencia entre las dos es todo lo que decide la
  // advertencia de R6.4.
  await q(
    `INSERT INTO ad_campaigns (campaign_id, account_id, name, status, effective_status,
                               budget_level, currency, synced_at) VALUES
       ($1, $3, 'Campaña pausada T15', 'PAUSED', 'PAUSED', 'adset', 'EUR', now()),
       ($2, $3, 'Campaña activa T15',  'ACTIVE', 'ACTIVE', 'adset', 'EUR', now())`,
    [CAMP_APAGADA, CAMP_PRENDIDA, CUENTA],
  );
  // El `effective_status` de los conjuntos NO es el que produce la advertencia, y
  // los dos valores están representados para que quede escrito: el que ya está
  // ACTIVE viene CAMPAIGN_PAUSED, y el que está PAUSED viene PAUSED aunque su
  // campaña esté apagada, porque Meta resuelve el estado propio primero. Ese
  // segundo es el que hace falta el `status` del padre.
  await q(
    `INSERT INTO ad_sets (adset_id, campaign_id, account_id, name, status, effective_status,
                          currency, daily_budget, synced_at, desaparecido_at) VALUES
       ($1, $5, $7, 'Conjunto ya activo',    'ACTIVE', 'CAMPAIGN_PAUSED', 'EUR', 500, now(), NULL),
       ($2, $5, $7, 'Conjunto que se activa','PAUSED', 'PAUSED',          'EUR', 500, now(), NULL),
       ($3, $5, $7, 'Conjunto que falla',    'PAUSED', 'PAUSED',          'EUR', 500, now(), NULL),
       ($4, $6, $7, 'Conjunto sin aviso',    'PAUSED', 'PAUSED',          'EUR', 500, now(), NULL),
       ($8, $5, $7, 'Conjunto que se pausa', 'ACTIVE', 'CAMPAIGN_PAUSED', 'EUR', 500, now(), NULL),
       ($9, $5, $7, 'Conjunto ya pausado',   'PAUSED', 'PAUSED',          'EUR', 500, now(), NULL)`,
    [
      S_YA_ACTIVO, S_SE_ACTIVA, S_FALLA, S_SIN_AVISO, CAMP_APAGADA, CAMP_PRENDIDA, CUENTA,
      S_PAUSA_ACTIVO, S_PAUSA_PAUSADO,
    ],
  );
}

beforeAll(async () => {
  if (!dbAvailable) return;
  await sembrar();
});

afterAll(async () => {
  if (!dbAvailable) return;
  await q('DELETE FROM ad_actions WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_sets WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_campaigns WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_accounts WHERE account_id = $1', [CUENTA]);
});

beforeEach(async () => {
  if (!dbAvailable) return;
  mockAuth.mockImplementation(() => true);
  mockEnviar.mockReset();
  mockFetchObjeto.mockReset();
  // Un backoff por cuota activo rechaza el pedido antes del preflight, y lo deja
  // puesto cualquier otro archivo de la suite.
  await q(`UPDATE settings SET value = '""'::jsonb WHERE key = 'ads_backoff_until'`);
});

describe.skipIf(!dbAvailable)('la advertencia de padre pausado viaja al cliente (T15, R6.4)', () => {
  it('una omisión por «ya está en ese estado» llega CON la advertencia', async () => {
    const { r } = await activar(S_YA_ACTIVO);

    expect(r.estado).toBe('omitido');
    expect(r.motivo).toBe('ya_esta_en_ese_estado');
    expect(mockEnviar).not.toHaveBeenCalled();
    // Las tres cosas que el panel no distinguía sobre este objeto.
    expect(r.advertencia).toContain('la campaña está pausada');
    expect(r.advertencia).toContain('no entrega');
  });

  it('una escritura CONFIRMADA llega con la advertencia: es el caso reportado', async () => {
    mockEnviar.mockResolvedValue({ estado: 'confirmado' });
    mockFetchObjeto.mockResolvedValue({
      objectId: S_SE_ACTIVA,
      name: 'Conjunto que se activa',
      status: 'ACTIVE',
      effectiveStatus: 'CAMPAIGN_PAUSED',
      dailyBudget: 500,
      lifetimeBudget: null,
    });

    const { cuerpo, r } = await activar(S_SE_ACTIVA);

    expect(mockEnviar).toHaveBeenCalledWith(S_SE_ACTIVA, { status: 'ACTIVE' });
    expect(r.estado).toBe('confirmado');
    expect(r.advertencia).toContain('el conjunto queda activo pero no entrega');

    // El viaje completo: con este cuerpo el traductor deja de callarse, y lo dice
    // sin presentarlo como un fallo ni pedir que la fila vuelva atrás.
    const aviso = mensajeDeResultado(200, cuerpo);
    expect(aviso).not.toBeNull();
    expect(aviso!.tono).toBe('aviso');
    expect(aviso!.aplicado).toBe(true);
    expect(aviso!.texto).toContain('El cambio se aplicó en Meta.');
    expect(aviso!.texto).toContain('no entrega hasta que se active la campaña');
  });

  it('un rechazo de Meta también la lleva, sin perder el tono de error', async () => {
    // Código sin mapear en el catálogo: `traducirError` lo clasifica `fallido`,
    // con mensaje genérico y sin cortar el lote. Alcanza para la rama y no ata el
    // caso a una fila del catálogo que puede cambiar.
    mockEnviar.mockResolvedValue({
      estado: 'fallido',
      error: new MetaAdsError('Invalid parameter', 100, 'OAuthException', 9_999_999, false, undefined, 400),
    });

    const { cuerpo, r } = await activar(S_FALLA);

    expect(r.estado).toBe('fallido');
    expect(r.mensaje).not.toBeNull();
    expect(r.advertencia).toContain('no entrega');

    const aviso = mensajeDeResultado(200, cuerpo);
    expect(aviso!.tono).toBe('error');
    expect(aviso!.aplicado).toBeUndefined(); // acá el cambio NO quedó
    expect(aviso!.texto).toContain('no entrega hasta que se active la campaña');
  });

  it('con la campaña activa no advierte nada, y el traductor vuelve a callarse', async () => {
    mockEnviar.mockResolvedValue({ estado: 'confirmado' });
    mockFetchObjeto.mockResolvedValue({
      objectId: S_SIN_AVISO,
      name: 'Conjunto sin aviso',
      status: 'ACTIVE',
      effectiveStatus: 'ACTIVE',
      dailyBudget: 500,
      lifetimeBudget: null,
    });

    const { cuerpo, r } = await activar(S_SIN_AVISO);

    expect(r.estado).toBe('confirmado');
    expect(r.advertencia).toBeNull();
    // La regla 1 intacta: un confirmado que sí va a entregar no tiene nada que
    // decir, y agregarle un aviso sería ruido en el camino normal.
    expect(mensajeDeResultado(200, cuerpo)).toBeNull();
  });
});

/**
 * El aviso al PAUSAR viaja igual, task 12 de `toggle-conjuntos-entrega` (2.11).
 *
 * QUÉ AGREGA ESTE BLOQUE SOBRE `previsualizacion.test.ts`. Lo mismo que el de
 * arriba: allá se prueba que `calcularPrevisualizacion` PONE el texto; acá que el
 * route lo copia al resultado y que llega al cuerpo HTTP. La diferencia con el
 * bloque de activar es que el filtro nuevo mira `fila.status`, o sea un dato que
 * sale de la BASE, así que la única forma de verificarlo de punta a punta es con
 * dos filas sembradas distintas y el mismo pedido.
 *
 * Los dos casos son exactamente el reparto del bugfix: uno de los **92**
 * (`ACTIVE / CAMPAIGN_PAUSED`, la escritura ocurre) y uno de los **67**
 * (`PAUSED / PAUSED`, la escritura se omite).
 */
describe.skipIf(!dbAvailable)('el aviso al pausar viaja al cliente (task 12, 2.11)', () => {
  const PAUSE_CAMPANIA =
    'la campaña está pausada: el conjunto ya no estaba entregando, así que pausarlo no cambia la entrega';

  it('pausar un conjunto ACTIVE con la campaña pausada trae el texto nuevo', async () => {
    mockEnviar.mockResolvedValue({ estado: 'confirmado' });
    mockFetchObjeto.mockResolvedValue({
      objectId: S_PAUSA_ACTIVO,
      name: 'Conjunto que se pausa',
      status: 'PAUSED',
      effectiveStatus: 'PAUSED',
      dailyBudget: 500,
      lifetimeBudget: null,
    });

    const { cuerpo, r } = await pausar(S_PAUSA_ACTIVO);

    // La escritura es real y con los mismos valores de siempre (3.8).
    expect(mockEnviar).toHaveBeenCalledWith(S_PAUSA_ACTIVO, { status: 'PAUSED' });
    expect(r.estado).toBe('confirmado');
    expect(r.motivo).toBeUndefined();
    // El texto NUEVO, entero: es la aclaración en pasado y no la advertencia
    // sobre el futuro.
    expect(r.advertencia).toBe(PAUSE_CAMPANIA);

    // Y el viaje completo hasta el aviso tonal, que es donde el usuario lo lee:
    // se aplicó, y la aclaración no lo convierte en un fallo.
    const aviso = mensajeDeResultado(200, cuerpo);
    expect(aviso).not.toBeNull();
    expect(aviso!.tono).toBe('aviso');
    expect(aviso!.aplicado).toBe(true);
    expect(aviso!.texto).toContain('ya no estaba entregando');
  });

  it('pausar un conjunto que ya está PAUSED no lo trae, y el traductor se calla', async () => {
    const { cuerpo, r } = await pausar(S_PAUSA_PAUSADO);

    // Se omite: no hay escritura y por lo tanto no hay nada que aclarar.
    expect(r.estado).toBe('omitido');
    expect(r.motivo).toBe('ya_esta_en_ese_estado');
    expect(mockEnviar).not.toHaveBeenCalled();
    expect(r.advertencia).toBeNull();
    // Sin advertencia el traductor vuelve a no tener nada que decir sobre una
    // omisión, que es el comportamiento de siempre para esta rama.
    const aviso = mensajeDeResultado(200, cuerpo);
    expect(aviso?.texto ?? '').not.toContain('no estaba entregando');
  });
});
