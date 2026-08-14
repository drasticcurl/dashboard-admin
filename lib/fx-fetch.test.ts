import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { q, q1 } from './db';
import { assertPlausible, fetchRate, saveRate } from './fx-fetch';
import { main as fetchFxMain } from '../scripts/fetch-fx';
import { runBackfill } from '../scripts/backfill-fx';

// Puros: la red se mockea con vi.stubGlobal('fetch', …) y la base con el mock
// de ./db. Los payloads de ejemplo son los del §2 del task T03.
vi.mock('./db', () => ({
  q1: vi.fn(),
  q: vi.fn(),
  tx: vi.fn(),
  getPool: vi.fn(() => ({ end: vi.fn().mockResolvedValue(undefined) })),
}));

vi.mock('../scripts/backfill-fx', () => ({
  runBackfill: vi.fn(async () => ({ updated: 0, stillStale: 0, fromDay: null, toDay: null })),
}));

const DOLARAPI_OK = {
  moneda: 'EUR',
  casa: 'oficial',
  nombre: 'Euro',
  compra: 1714.5291,
  venta: 1728.6485,
  fechaActualizacion: '2026-08-10T16:57:00.000Z',
};

const ERAPI_OK = {
  result: 'success',
  time_last_update_unix: 1754841600,
  base_code: 'ARS',
  rates: { EUR: 0.000578 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function http500(): Response {
  return new Response('', { status: 500 });
}

describe('fetchRate', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('respuesta válida de dolarapi → rate = 1/venta, redondeado a 10 decimales', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(DOLARAPI_OK));
    vi.stubGlobal('fetch', fetchMock);
    const r = await fetchRate('oficial');
    expect(r.source).toBe('dolarapi');
    // dolarapi da "pesos por euro" y la tabla guarda el inverso (T03 §2).
    expect(r.rate).toBe(Math.round((1 / 1728.6485) * 1e10) / 1e10);
    expect(r.asOf).toEqual(new Date('2026-08-10T16:57:00.000Z'));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('dolarapi.com/v1/cotizaciones/eur'),
      expect.anything(),
    );
  });

  it('dolarapi con 500 → cae en er-api y NO invierte el valor', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(http500())
      .mockResolvedValueOnce(jsonResponse(ERAPI_OK));
    vi.stubGlobal('fetch', fetchMock);
    const r = await fetchRate('oficial');
    expect(r.source).toBe('er-api');
    expect(r.rate).toBeCloseTo(0.000578, 9);
    // Invertido daría ~1730: acá está el "error fácil" del task.
    expect(r.rate).toBeLessThan(0.001);
    expect(String(fetchMock.mock.calls[1][0])).toContain('open.er-api.com/v6/latest/ARS');
  });

  it('las dos fuentes fallan → fetchRate tira y el main del script rechaza (el CLI sale 1)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(http500()));
    await expect(fetchRate('oficial')).rejects.toThrow(/no se pudo obtener la cotización/);
    await expect(fetchFxMain(['--day=2026-08-11'])).rejects.toThrow(/no se pudo obtener la cotización/);
  });

  it('venta = 0 → assertPlausible tira (un día a 0 euros no puede escribirse)', () => {
    expect(() => assertPlausible(1 / 0)).toThrow();
    expect(() => assertPlausible(0)).toThrow();
  });

  it('venta = 1.5 (coma corrida) → assertPlausible tira con el valor en el mensaje', () => {
    expect(() => assertPlausible(1 / 1.5)).toThrow(/0\.6666/);
  });

  it('venta como string numérica se parsea; como basura no produce NaN silencioso', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ...DOLARAPI_OK, venta: '1728.6485' })));
    const r = await fetchRate('oficial');
    expect(r.rate).toBe(Math.round((1 / 1728.6485) * 1e10) / 1e10);
    expect(Number.isNaN(r.rate)).toBe(false);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(jsonResponse({ ...DOLARAPI_OK, venta: 'abc' })).mockResolvedValueOnce(http500()),
    );
    await expect(fetchRate('oficial')).rejects.toThrow();
  });

  it('coherencia entre fuentes: los dos rates del §2 del task difieren < 5%', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(DOLARAPI_OK)));
    const fromDolarapi = await fetchRate('oficial');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(http500()).mockResolvedValueOnce(jsonResponse(ERAPI_OK)),
    );
    const fromErApi = await fetchRate('oficial');
    const diff = Math.abs(fromDolarapi.rate - fromErApi.rate) / fromDolarapi.rate;
    expect(diff).toBeLessThan(0.05);
  });
});

describe('saveRate', () => {
  beforeEach(() => vi.resetAllMocks());

  it('existe una fila manual del día → no la pisa', async () => {
    vi.mocked(q1).mockResolvedValue({ source: 'manual' });
    await saveRate('2026-08-11', 0.0005785, 'dolarapi');
    expect(q).not.toHaveBeenCalled();
  });

  it('sin fila manual → upsert con ON CONFLICT', async () => {
    vi.mocked(q1).mockResolvedValue(null);
    vi.mocked(q).mockResolvedValue([]);
    await saveRate('2026-08-11', 0.0005785, 'dolarapi');
    expect(q).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (day, base, quote)'),
      ['2026-08-11', 'ARS', 'EUR', 0.0005785, 'dolarapi'],
    );
  });
});

describe('fetch-fx CLI', () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('fx_source ≠ oficial → unsupported_fx_source, huella en ingest_errors y sin pedir a la red', async () => {
    vi.mocked(q1).mockResolvedValue({ value: '"blue"' });
    vi.mocked(q).mockResolvedValue([]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchFxMain(['--day=2026-08-11'])).rejects.toThrow(/unsupported_fx_source/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(q).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO ingest_errors'),
      ['unsupported_fx_source', expect.any(String), { fx_source: 'blue' }],
    );
  });

  it('feliz: guarda la fila, imprime la línea y corre el backfill', async () => {
    vi.mocked(q1).mockResolvedValueOnce({ value: '"oficial"' }).mockResolvedValue(null);
    vi.mocked(q).mockResolvedValue([]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(DOLARAPI_OK)));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await fetchFxMain(['--day=2026-08-11']);
    expect(q).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO fx_rates'),
      ['2026-08-11', 'ARS', 'EUR', expect.any(Number), 'dolarapi'],
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('2026-08-11 ARS→EUR'));
    expect(runBackfill).toHaveBeenCalledWith({ limit: 5000, dryRun: false });
    logSpy.mockRestore();
  });
});
