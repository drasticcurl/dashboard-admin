import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { q, q1 } from './db';
import {
  assertPlausibleParidad,
  fetchParidad,
  monedasDeVentaAExtraer,
  saveRate,
} from './fx-fetch';
import { main as fetchFxMain } from '../scripts/fetch-fx';
import { runBackfill } from '../scripts/backfill-fx';

/**
 * El par que NO sale del peso: <moneda de venta> → moneda de reporte.
 *
 * Por qué existe: el funnel `chauhinchazon-latam` vende en USD y `fx_rates` solo
 * tenía filas ARS→EUR, así que sus ventas entraban con `amount_eur = NULL` y
 * `fx_stale = true` — el funnel mostraba €0 de ingresos con ventas reales
 * adentro, y una campaña LATAM mostraba ROAS 0 con gasto real (que es lo que
 * pausaría una regla). Hasta el 2026-09-14 la fila se cargaba a mano.
 *
 * Puros: la red se mockea con vi.stubGlobal('fetch', …) y la base con el mock de
 * ./db, igual que fx-fetch.test.ts.
 */

vi.mock('./db', () => ({
  q1: vi.fn(),
  q: vi.fn(),
  tx: vi.fn(),
  getPool: vi.fn(() => ({ end: vi.fn().mockResolvedValue(undefined) })),
}));

vi.mock('../scripts/backfill-fx', () => ({
  runBackfill: vi.fn(async () => ({ updated: 0, stillStale: 0, fromDay: null, toDay: null })),
}));

// Respuesta real de open.er-api.com/v6/latest/USD (recortada a lo que se lee).
const ERAPI_USD = {
  result: 'success',
  time_last_update_unix: 1757894401,
  base_code: 'USD',
  rates: { USD: 1, EUR: 0.862246, ARS: 1518.5 },
};

const DOLARAPI_OK = {
  moneda: 'EUR',
  casa: 'oficial',
  nombre: 'Euro',
  compra: 1714.5291,
  venta: 1728.6485,
  fechaActualizacion: '2026-09-14T16:57:00.000Z',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('fetchParidad', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('lee rates[moneda de reporte] SIN invertir y pide la ruta de la base', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(ERAPI_USD));
    vi.stubGlobal('fetch', fetchMock);
    const r = await fetchParidad('USD');
    expect(r.rate).toBe(0.862246);
    // Invertido daría 1,16: es el error fácil de este archivo.
    expect(r.rate).toBeLessThan(1);
    expect(r.source).toBe('er-api');
    expect(String(fetchMock.mock.calls[0][0])).toContain('open.er-api.com/v6/latest/USD');
  });

  it('la base llega en minúscula y se pide igual en mayúscula', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(ERAPI_USD));
    vi.stubGlobal('fetch', fetchMock);
    await fetchParidad('usd');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/latest/USD');
  });

  // La defensa que la banda no puede dar: entre monedas a la par, un valor
  // invertido o de otro par pasa cualquier chequeo numérico.
  it('base_code distinto del pedido → tira y no devuelve un número plausible', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...ERAPI_USD, base_code: 'GBP' })));
    await expect(fetchParidad('USD')).rejects.toThrow(/se pidió USD y devolvió base_code='GBP'/);
  });

  it('respuesta sin la moneda de reporte en rates → tira con el par en el mensaje', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...ERAPI_USD, rates: { ARS: 1518.5 } })));
    await expect(fetchParidad('USD')).rejects.toThrow(/no trae rates\.EUR/);
  });

  it("result != 'success' → tira", async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...ERAPI_USD, result: 'error' })));
    await expect(fetchParidad('USD')).rejects.toThrow(/result='error'/);
  });

  it('rate en 0 o basura → assertPlausibleParidad tira antes de escribir', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...ERAPI_USD, rates: { EUR: 0 } })));
    await expect(fetchParidad('USD')).rejects.toThrow(/absurda/);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...ERAPI_USD, rates: { EUR: 'abc' } })));
    await expect(fetchParidad('USD')).rejects.toThrow(/absurda/);
  });

  it('pedir la moneda de reporte contra sí misma es un error de programa, no una cotización de 1', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchParidad('EUR')).rejects.toThrow(/es la moneda de reporte/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('assertPlausibleParidad', () => {
  it('acepta el orden de magnitud de dos monedas fuertes y rechaza 0/NaN/Infinity', () => {
    expect(() => assertPlausibleParidad('USD', 0.862246)).not.toThrow();
    expect(() => assertPlausibleParidad('USD', 1.16)).not.toThrow();
    expect(() => assertPlausibleParidad('USD', 0)).toThrow();
    expect(() => assertPlausibleParidad('USD', Number.NaN)).toThrow();
    expect(() => assertPlausibleParidad('USD', Number.POSITIVE_INFINITY)).toThrow();
  });

  it('un rate con la coma corrida varios órdenes de magnitud NO pasa', () => {
    expect(() => assertPlausibleParidad('USD', 0.0000862)).toThrow();
    expect(() => assertPlausibleParidad('USD', 86224.6)).toThrow();
  });
});

describe('saveRate con base', () => {
  beforeEach(() => vi.resetAllMocks());

  it('la base se guarda en MAYÚSCULA aunque llegue en minúscula', async () => {
    vi.mocked(q1).mockResolvedValue(null);
    vi.mocked(q).mockResolvedValue([]);
    await saveRate('2026-09-14', 0.862246, 'er-api', 'usd');
    expect(q).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO fx_rates'), [
      '2026-09-14',
      'USD',
      'EUR',
      0.862246,
      'er-api',
    ]);
  });

  it('sin base explícita sigue escribiendo ARS (los llamadores viejos no cambian)', async () => {
    vi.mocked(q1).mockResolvedValue(null);
    vi.mocked(q).mockResolvedValue([]);
    await saveRate('2026-09-14', 0.0005682, 'dolarapi');
    expect(q).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO fx_rates'), [
      '2026-09-14',
      'ARS',
      'EUR',
      0.0005682,
      'dolarapi',
    ]);
  });

  it('una cotización de paridad NO se valida con la banda del peso (0,86 sería absurda ahí)', async () => {
    vi.mocked(q1).mockResolvedValue(null);
    vi.mocked(q).mockResolvedValue([]);
    await expect(saveRate('2026-09-14', 0.862246, 'er-api', 'USD')).resolves.toBeUndefined();
    // Y la inversa: con base ARS, ese mismo 0,86 sí es absurdo.
    await expect(saveRate('2026-09-14', 0.862246, 'er-api', 'ARS')).rejects.toThrow(/absurda/);
  });

  // Documenta un límite REAL, no un descuido: 5,68e-4 es la magnitud de un rate
  // del peso y bajo la base USD pasa igual. Ninguna banda puede distinguir eso
  // sin rechazar monedas legítimas (COP→EUR es 2,2e-4). Lo que ataja el par
  // equivocado es `base_code` en fetchParidad, no el rango.
  it('la banda de paridad NO discrimina de qué par es el número: eso lo hace base_code', async () => {
    vi.mocked(q1).mockResolvedValue(null);
    vi.mocked(q).mockResolvedValue([]);
    await expect(saveRate('2026-09-14', 0.0005682, 'er-api', 'USD')).resolves.toBeUndefined();
  });

  it('respeta la fila manual del par (D13), no solo la del peso', async () => {
    vi.mocked(q1).mockResolvedValue({ source: 'manual' });
    await saveRate('2026-09-14', 0.862246, 'er-api', 'USD');
    expect(q).not.toHaveBeenCalled();
  });
});

describe('monedasDeVentaAExtraer', () => {
  beforeEach(() => vi.resetAllMocks());

  it('excluye ARS (la trae la fuente primaria) y la moneda de reporte', async () => {
    vi.mocked(q).mockResolvedValue([{ base: 'USD' }]);
    const bases = await monedasDeVentaAExtraer();
    expect(bases).toEqual(['USD']);
    const [sql, params] = vi.mocked(q).mock.calls[0]!;
    expect(sql).toContain("NOT IN ('ARS', $1)");
    expect(sql).toContain('WHERE active');
    expect(params).toEqual(['EUR']);
  });

  it('sin funnels en otra moneda devuelve vacío (la instancia que solo vende en pesos no cambia)', async () => {
    vi.mocked(q).mockResolvedValue([]);
    expect(await monedasDeVentaAExtraer()).toEqual([]);
  });
});

describe('fetch-fx CLI con más de un par', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('guarda el par del peso Y el de la moneda de venta, y corre el backfill una sola vez', async () => {
    // q1: fx_source, fila del día ARS (no existe), fila del día USD (no existe),
    // y la que consulta saveRate antes de cada INSERT.
    vi.mocked(q1).mockResolvedValueOnce({ value: '"oficial"' }).mockResolvedValue(null);
    vi.mocked(q).mockImplementation(async (sql: string) =>
      sql.includes('FROM funnels') ? ([{ base: 'USD' }] as never) : ([] as never),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('er-api') ? jsonResponse(ERAPI_USD) : jsonResponse(DOLARAPI_OK),
      ),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await fetchFxMain(['--day=2026-09-14']);

    const inserts = vi
      .mocked(q)
      .mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO fx_rates'))
      .map(([, params]) => params);
    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toEqual(['2026-09-14', 'ARS', 'EUR', expect.any(Number), 'dolarapi']);
    expect(inserts[1]).toEqual(['2026-09-14', 'USD', 'EUR', 0.862246, 'er-api']);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('2026-09-14 USD→EUR'));
    expect(runBackfill).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  // El orden importa: si el fallo del par nuevo cortara antes, el backfill no
  // correría y las ventas en pesos del día quedarían sin convertir por un
  // problema que no es suyo.
  it('si falla el par de la moneda de venta: el del peso queda guardado, el backfill corre y recién ahí tira (exit 1)', async () => {
    vi.mocked(q1).mockResolvedValueOnce({ value: '"oficial"' }).mockResolvedValue(null);
    vi.mocked(q).mockImplementation(async (sql: string) =>
      sql.includes('FROM funnels') ? ([{ base: 'USD' }] as never) : ([] as never),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('er-api') ? new Response('', { status: 500 }) : jsonResponse(DOLARAPI_OK),
      ),
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(fetchFxMain(['--day=2026-09-14'])).rejects.toThrow(/no se pudo cotizar 1 par/);

    const inserts = vi
      .mocked(q)
      .mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO fx_rates'))
      .map(([, params]) => params);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toEqual(['2026-09-14', 'ARS', 'EUR', expect.any(Number), 'dolarapi']);
    expect(runBackfill).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('USD→EUR falló'));
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('el par de la moneda de venta ya cargado a mano no se pisa', async () => {
    // El mock mira el SQL y los parámetros en vez de contar llamadas: entre
    // medio hay dos SELECT de fx_rates (el chequeo del CLI y el de saveRate) y
    // un orden fijo se rompe con cualquier cambio interno.
    vi.mocked(q1).mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM settings')) return { value: '"oficial"' } as never;
      if (sql.includes('FROM fx_rates') && params?.[1] === 'USD') return { source: 'manual' } as never;
      return null as never;
    });
    vi.mocked(q).mockImplementation(async (sql: string) =>
      sql.includes('FROM funnels') ? ([{ base: 'USD' }] as never) : ([] as never),
    );
    const fetchMock = vi.fn(async (url: string) => {
      void url;
      return jsonResponse(DOLARAPI_OK);
    });
    vi.stubGlobal('fetch', fetchMock);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await fetchFxMain(['--day=2026-09-14']);

    const inserts = vi
      .mocked(q)
      .mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO fx_rates'));
    expect(inserts).toHaveLength(1); // solo el del peso
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('USD→EUR: no se pisa la cotización manual'));
    // Y no se le pegó a er-api: el chequeo de la fila manual pasa ANTES de la red.
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('er-api'))).toBe(true);
    logSpy.mockRestore();
  });
});
