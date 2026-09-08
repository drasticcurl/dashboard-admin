import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { q } from '../../../../lib/db';
import { GET } from './route';
import { isAuthenticated } from '../../../../lib/auth';
import { fetchAlcance } from '../../../../lib/ads/meta';
import { getMetricasAds } from '../../../../lib/queries/ads';
import { ensureFreshAdSpend } from '../../../../lib/ads/live';
import { ensureFreshJerarquia } from '../../../../lib/ads/liveJerarquia';

/**
 * Tests del endpoint de datos (task 16.3): 401 sin cookie, el 422 de zonas
 * mezcladas, que las columnas sin Metricas_Rango no disparan ninguna llamada de
 * alcance, y la precedencia de cuenta de R1 c12 con su aviso.
 *
 * `ensureFreshAdSpend` y `ensureFreshJerarquia` se mockean enteros: sin eso, la
 * lectura "en vivo" pegaría a los sync reales y tocaría `daily_metrics` y la
 * Jerarquía de la base de desarrollo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL ORDEN ENTRE SINCRONIZAR Y LEER (task 13, Property 8)
 *
 * Es la regresión que este spec vino a arreglar: el endpoint leía las métricas
 * PRIMERO y sincronizaba después, así que toda respuesta salía con los números
 * anteriores al sync y lo que el sync traía recién aparecía en el pedido
 * SIGUIENTE. Desde afuera se veía como "aprieto Actualizar y sigue igual".
 *
 * POR QUÉ NO ALCANZA `toHaveBeenCalled()`
 * Que los dos sync se llamen es verdad en los dos órdenes: el roto también los
 * llamaba. Un test así pasa igual con la regresión puesta, o sea que no prueba
 * nada. Lo que hay que observar es la SECUENCIA, y para eso los tres mocks
 * —los dos sync y la lectura— escriben en un registro compartido (`espia.orden`)
 * y las aserciones comparan posiciones dentro de ese registro.
 *
 * Cada sync deja dos marcas, `inicio` y `fin`, con un turno de macrotarea en el
 * medio. Las dos marcas y no una porque hay dos preguntas distintas que
 * responder: que el sync TERMINÓ antes de que la lectura empiece (R5.1) y que
 * los dos ARRANCARON antes de que cualquiera termine, o sea que corren en
 * paralelo y no en serie.
 * ─────────────────────────────────────────────────────────────────────────────
 */

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

/**
 * El registro de orden, compartido por los tres mocks de abajo.
 *
 * Va en `vi.hoisted` y no en un `const` normal porque los factories de
 * `vi.mock` se izan por encima de los imports: cuando `./route` se importe y
 * arrastre `lib/ads/live`, el cuerpo de este archivo todavía no corrió y un
 * `const` del módulo estaría en su zona muerta.
 */
const espia = vi.hoisted(() => {
  const orden: string[] = [];

  /**
   * Un sync simulado que deja dos marcas y cede el turno entre las dos.
   *
   * El `setTimeout` es lo que hace que el registro signifique algo. Con un sync
   * que resuelve sincrónicamente, `inicio` y `fin` caerían pegados y no habría
   * diferencia observable entre esperar los dos en paralelo y esperarlos uno
   * después del otro. La duración no importa —nadie mide tiempo acá, sólo
   * posiciones— y las aserciones no dependen de cuánto tarda el timer, sólo de
   * que exista un corte entre `inicio` y `fin`.
   */
  async function marcarSync(etiqueta: string): Promise<void> {
    orden.push(`${etiqueta}:inicio`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    orden.push(`${etiqueta}:fin`);
  }

  return { orden, marcarSync };
});

vi.mock('../../../../lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/auth')>();
  return { ...actual, isAuthenticated: vi.fn(() => true) };
});

// `guard()` delega en `guardSeccion` de lib/permisos (T03), que ya no lee
// `isAuthenticated`: consulta la base a través de una sesión real. El mock se
// ata al mismo `isAuthenticated` de arriba para que "sin cookie → 401" siga
// funcionando cuando el test hace `mockAuth.mockImplementation(() => false)`.
vi.mock('../../../../lib/permisos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/permisos')>();
  return {
    ...actual,
    guardSeccion: vi.fn(async () => {
      const { isAuthenticated: chequear } = await import('../../../../lib/auth');
      if (!chequear({ get: () => undefined })) {
        return {
          respuesta: (await import('next/server')).NextResponse.json(
            { ok: false, error: 'unauthorized' },
            { status: 401 },
          ),
        };
      }
      return {
        sesion: {
          usuarioId: 1,
          usuario: 'test',
          nombre: 'Test',
          esAdmin: true,
          debeCambiarClave: false,
          secciones: actual.SECCIONES,
          esFallback: false,
        },
      };
    }),
  };
});

vi.mock('../../../../lib/ads/live', () => ({
  ensureFreshAdSpend: vi.fn(async () => {
    await espia.marcarSync('gasto');
    return {
      syncedAt: new Date().toISOString(),
      ageSeconds: 1,
      refreshed: false,
      error: null,
    };
  }),
}));

// Mismo criterio que el mock del gasto: el módulo entero, para que la Jerarquía
// en vivo no salga a Meta ni escriba `ad_campaigns`/`ad_sets`/`ads`. El valor
// devuelto es el que la respuesta tiene que dejar pasar en `jerarquiaFreshness`,
// con `refreshed: true` para distinguirlo de un pedido que no la disparó.
vi.mock('../../../../lib/ads/liveJerarquia', () => ({
  ensureFreshJerarquia: vi.fn(async () => {
    await espia.marcarSync('jerarquia');
    return {
      syncedAt: new Date().toISOString(),
      ageSeconds: 2,
      refreshed: true,
      error: null,
    };
  }),
}));

vi.mock('../../../../lib/ads/meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/ads/meta')>();
  return { ...actual, fetchAlcance: vi.fn() };
});

// La lectura NO se reemplaza, se envuelve: corre la consulta de verdad y además
// deja su marca en el registro. Es la única forma de que la marca de la lectura
// signifique "acá empezó a leer" y no "acá un stub devolvió filas inventadas".
vi.mock('../../../../lib/queries/ads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/queries/ads')>();
  return {
    ...actual,
    getMetricasAds: vi.fn(async (...args: Parameters<typeof actual.getMetricasAds>) => {
      espia.orden.push('lectura');
      return actual.getMetricasAds(...args);
    }),
  };
});

const mockAuth = vi.mocked(isAuthenticated);
const mockFetchAlcance = vi.mocked(fetchAlcance);
const mockGetMetricas = vi.mocked(getMetricasAds);
const mockGasto = vi.mocked(ensureFreshAdSpend);
const mockJerarquia = vi.mocked(ensureFreshJerarquia);

const CUENTA = `ED-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const OTRA = `${CUENTA}-otra`;

function get(url: string): Promise<Response> {
  return GET(new NextRequest(`http://localhost/api/data/ads${url}`));
}

beforeAll(async () => {
  if (!dbAvailable) return;
  await q(
    `INSERT INTO ad_accounts (account_id, platform, name, currency, active, timezone) VALUES
       ($1, 'meta', 'test', 'EUR', true, 'Europe/Lisbon'),
       ($2, 'meta', 'otra', 'EUR', true, 'America/Argentina/Buenos_Aires')
     ON CONFLICT (account_id) DO UPDATE SET active = true, timezone = EXCLUDED.timezone`,
    [CUENTA, OTRA],
  );
});

afterAll(async () => {
  if (!dbAvailable) return;
  await q('DELETE FROM ad_accounts WHERE account_id = ANY($1::text[])', [[CUENTA, OTRA]]);
});

describe.skipIf(!dbAvailable)('GET /api/data/ads (R1 c7, c12, R7 c6, R4 c10)', () => {
  it('sin cookie → 401, sin datos', async () => {
    mockAuth.mockImplementation(() => false);
    const resp = await get('');
    expect(resp.status).toBe(401);
    const cuerpo = (await resp.json()) as { ok: boolean };
    expect(cuerpo.ok).toBe(false);
  });

  it('zonas horarias mezcladas sale como 422 y no como 500', async () => {
    mockAuth.mockImplementation(() => true);
    mockGetMetricas.mockRejectedValueOnce(new Error('zonas horarias mezcladas: a=Z, b=W'));
    const resp = await get('?account=act_x');
    expect(resp.status).toBe(422);
    const cuerpo = (await resp.json()) as { ok: boolean; error: string };
    expect(cuerpo.ok).toBe(false);
    expect(cuerpo.error).toContain('zonas horarias mezcladas');
  });

  it('columnas sin Metricas_Rango no disparan ninguna llamada de alcance (R7 c6)', async () => {
    mockAuth.mockImplementation(() => true);
    mockGetMetricas.mockRestore();
    mockFetchAlcance.mockClear();
    mockFetchAlcance.mockResolvedValue([]);

    const resp = await get(`?account=${CUENTA}&columnas=gastos,ventas,ctr&page=1&orderBy=gastos&orderDir=desc`);
    expect(resp.status).toBe(200);
    expect(mockFetchAlcance).not.toHaveBeenCalled();
    const cuerpo = (await resp.json()) as { ok: boolean; total: number; pagina: number; totalPaginas: number; orden: unknown };
    expect(cuerpo.ok).toBe(true);
    expect(typeof cuerpo.total).toBe('number');
    expect(typeof cuerpo.pagina).toBe('number');
    expect(typeof cuerpo.totalPaginas).toBe('number');
    expect(cuerpo.orden).toBeTruthy();
  });

  it('los topes de settings viajan como números, incluido el umbral de frescura (task 7.3)', async () => {
    mockAuth.mockImplementation(() => true);
    const resp = await get(`?account=${CUENTA}&columnas=gastos`);
    expect(resp.status).toBe(200);
    const cuerpo = (await resp.json()) as {
      maxDailyBudgetEur: unknown;
      maxDeltaPorTickEur: unknown;
      frescuraUmbralSegundos: unknown;
    };
    // Nunca `undefined` ni `NaN`: el cliente los usa como techo del campo de
    // presupuesto y como umbral de la marca de fila vieja.
    expect(typeof cuerpo.maxDailyBudgetEur).toBe('number');
    expect(typeof cuerpo.maxDeltaPorTickEur).toBe('number');
    expect(typeof cuerpo.frescuraUmbralSegundos).toBe('number');
    expect(cuerpo.frescuraUmbralSegundos as number).toBeGreaterThan(0);
  });

  it('columnas con alcance SÍ disparan asegurarAlcance', async () => {
    mockAuth.mockImplementation(() => true);
    mockFetchAlcance.mockClear();
    mockFetchAlcance.mockResolvedValue([]);

    const resp = await get(`?account=${CUENTA}&columnas=alcance,frecuencia`);
    expect(resp.status).toBe(200);
    expect(mockFetchAlcance).toHaveBeenCalled();
  });

  it('un ?account= inexistente cae a la regla siguiente y avisa (R1 c12)', async () => {
    mockAuth.mockImplementation(() => true);
    const resp = await get(`?account=act_inexistente_999`);
    expect(resp.status).toBe(200);
    const cuerpo = (await resp.json()) as { ok: boolean; avisoCuenta: string | null; rango: { timezone: string } };
    expect(cuerpo.ok).toBe(true);
    expect(cuerpo.avisoCuenta).toContain('no se aplicó');
    // cayó a la primera cuenta activa (o a la del funnel), con su zona
    expect(typeof cuerpo.rango.timezone).toBe('string');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Feature: frescura-y-acciones-anuncios, Property 8: Sincronizar precede a leer
//
// **Validates: Requirements 5.1, 5.2**
//
// Para todo pedido que dispare un sync, el instante en que la lectura de
// métricas comienza es posterior al instante en que el sync terminó o agotó su
// presupuesto de espera. No existe un camino en el que la respuesta se arme con
// datos leídos antes de un sync que ese mismo pedido disparó.
//
// Los mocks del sync de este archivo nunca agotan el presupuesto de espera, así
// que lo que se fija acá es la primera mitad: los dos sync TERMINARON antes de
// leer. La otra mitad de R5.2 —que al vencer el timeout se dibuja con lo
// guardado— se verifica donde vive esa decisión, en `lib/ads/liveJerarquia.test.ts`:
// el endpoint no la toma, sólo espera un promise que esos módulos ya resuelven
// solos cuando se les agota el presupuesto.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!dbAvailable)('GET /api/data/ads: el orden entre sincronizar y leer (task 13)', () => {
  beforeEach(() => {
    mockAuth.mockImplementation(() => true);
    // El registro es de módulo y sobrevive entre tests: sin vaciarlo, un
    // `indexOf` levantaría la marca del test anterior.
    espia.orden.length = 0;
    mockGasto.mockClear();
    mockJerarquia.mockClear();
    mockGetMetricas.mockClear();
    mockFetchAlcance.mockClear();
    mockFetchAlcance.mockResolvedValue([]);
  });

  it('con forzar, los dos sync terminan ANTES de que arranque la lectura (R5.1)', async () => {
    const resp = await get(`?account=${CUENTA}&columnas=gastos&forzar=1`);
    expect(resp.status).toBe(200);

    const iGastoFin = espia.orden.indexOf('gasto:fin');
    const iJerarquiaFin = espia.orden.indexOf('jerarquia:fin');
    const iLectura = espia.orden.indexOf('lectura');

    // Las tres marcas TIENEN que existir, y esto no es ceremonia: un sync que
    // no se llamó deja su `indexOf` en -1, o sea "antes de la lectura" por
    // accidente. Sin este chequeo, un endpoint que dejara de sincronizar del
    // todo pasaría la comparación de abajo.
    expect(iGastoFin).toBeGreaterThanOrEqual(0);
    expect(iJerarquiaFin).toBeGreaterThanOrEqual(0);
    expect(iLectura).toBeGreaterThanOrEqual(0);

    // Property 8. Con el orden invertido —el que este spec vino a arreglar— la
    // lectura queda en la posición 0 y las dos comparaciones fallan.
    expect(iGastoFin).toBeLessThan(iLectura);
    expect(iJerarquiaFin).toBeLessThan(iLectura);

    // La forma completa del registro, que es más fuerte que las dos
    // comparaciones sueltas: la lectura es lo ÚLTIMO que pasa, y pasa una sola
    // vez. Si mañana alguien lee una vez antes y otra después, esto lo marca.
    expect(espia.orden).toEqual(['gasto:inicio', 'jerarquia:inicio', 'gasto:fin', 'jerarquia:fin', 'lectura']);

    // Y la frescura de la Jerarquía viaja en la respuesta del camino forzado
    // (R4.5): es lo que le permite a la barra mostrarla aparte de la del gasto.
    const cuerpo = (await resp.json()) as { jerarquiaFreshness: { refreshed: boolean } | null };
    expect(cuerpo.jerarquiaFreshness).toMatchObject({ refreshed: true });
  });

  it('los dos sync corren en paralelo y no uno después del otro', async () => {
    await get(`?account=${CUENTA}&columnas=gastos&forzar=1`);

    // Los dos arrancaron antes de que cualquiera terminara. No es una carrera:
    // `Promise.all` evalúa las dos llamadas de forma sincrónica antes de esperar
    // a ninguna, y cada mock deja su `inicio` también sincrónicamente, así que
    // las dos marcas de arranque caen siempre juntas y antes de los timers. En
    // serie (`await uno; await otro;`) `gasto:fin` precedería necesariamente a
    // `jerarquia:inicio`, y esta comparación falla sin depender del reloj.
    expect(espia.orden.indexOf('jerarquia:inicio')).toBeLessThan(espia.orden.indexOf('gasto:fin'));
  });

  it('sin forzar, la Sync_Jerarquia NO se dispara y el gasto sí (R4.8)', async () => {
    const resp = await get(`?account=${CUENTA}&columnas=gastos`);
    expect(resp.status).toBe(200);

    // El requisito que evita que una pestaña olvidada multiplique un sync que es
    // una llamada por cuenta y por nivel. El polling entra por acá.
    expect(mockJerarquia).not.toHaveBeenCalled();
    // El del gasto sí: tiene TTL propio y es una sola llamada a Insights.
    expect(mockGasto).toHaveBeenCalledTimes(1);
    // Y sigue sincronizando antes de leer, que es lo que hace que el polling
    // también muestre números posteriores a su propio sync.
    expect(espia.orden).toEqual(['gasto:inicio', 'gasto:fin', 'lectura']);

    // `null` y no un objeto: la barra tiene que poder distinguir "en este pedido
    // no hubo Sync_Jerarquia" de "corrió y quedó fresca".
    const cuerpo = (await resp.json()) as { jerarquiaFreshness: unknown };
    expect(cuerpo.jerarquiaFreshness).toBeNull();
  });

  it('el camino forzado le pide 30 s a la Jerarquía y 60 s al gasto (R4.1, R1 c7)', async () => {
    const resp = await get(`?account=${CUENTA}&columnas=gastos&forzar=1`);
    expect(resp.status).toBe(200);

    // La cuenta resuelta, no la del query string sin validar: es la que la
    // precedencia de R1 c12 dejó, y es de la que el sync tiene que traer datos.
    expect(mockJerarquia).toHaveBeenCalledTimes(1);
    expect(mockJerarquia).toHaveBeenCalledWith(CUENTA, { forzar: true, timeoutMs: 30_000 });

    // El gasto recibe el último día del rango, el día de hoy en la zona de la
    // cuenta, y su propio presupuesto de espera.
    expect(mockGasto).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      forzar: true,
      timeoutMs: 60_000,
    });
  });
});
