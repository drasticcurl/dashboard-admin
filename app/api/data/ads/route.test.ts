import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { q } from '../../../../lib/db';
import { GET } from './route';
import { isAuthenticated } from '../../../../lib/auth';
import { fetchAlcance } from '../../../../lib/ads/meta';
import { getMetricasAds } from '../../../../lib/queries/ads';

/**
 * Tests del endpoint de datos (task 16.3): 401 sin cookie, el 422 de zonas
 * mezcladas, que las columnas sin Metricas_Rango no disparan ninguna llamada de
 * alcance, y la precedencia de cuenta de R1 c12 con su aviso.
 *
 * `ensureFreshAdSpend` se mockea entero: sin eso, la lectura "en vivo" pegaría
 * al sync real y tocaría daily_metrics de la base de desarrollo.
 */

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

vi.mock('../../../../lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/auth')>();
  return { ...actual, isAuthenticated: vi.fn(() => true) };
});

vi.mock('../../../../lib/ads/live', () => ({
  ensureFreshAdSpend: vi.fn().mockResolvedValue({
    syncedAt: new Date().toISOString(),
    ageSeconds: 1,
    refreshed: false,
    error: null,
  }),
}));

vi.mock('../../../../lib/ads/meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/ads/meta')>();
  return { ...actual, fetchAlcance: vi.fn() };
});

vi.mock('../../../../lib/queries/ads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/queries/ads')>();
  return { ...actual, getMetricasAds: vi.fn(actual.getMetricasAds) };
});

const mockAuth = vi.mocked(isAuthenticated);
const mockFetchAlcance = vi.mocked(fetchAlcance);
const mockGetMetricas = vi.mocked(getMetricasAds);

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
