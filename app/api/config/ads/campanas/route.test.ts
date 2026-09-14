import { existsSync } from 'node:fs';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { q, q1 } from '@/lib/db';
import { isAuthenticated } from '@/lib/auth';
import { GET, POST } from './route';

/**
 * Endpoint que asigna una CAMPAÑA a un funnel dentro de una cuenta compartida
 * (migración 033).
 *
 * Lo que verifica, en orden de lo que costaba plata:
 *  · el gasto ya guardado se reimputa (si no, el mapeo solo vale para el futuro);
 *  · `daily_metrics` se recomputa (es un agregado congelado: sin esto el Resumen
 *    sigue mostrando la imputación vieja hasta el cron de la noche);
 *  · el GET dice a qué funnel se está imputando DE VERDAD cada campaña y de qué
 *    funnel son las ventas que se le atribuyeron por UTM — el detector de
 *    "esta campaña está mapeada al funnel equivocado".
 *
 * Necesita PostgreSQL.
 */

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, isAuthenticated: vi.fn(() => true) };
});

// Mismo patrón que app/api/config/vistas-ads/route.test.ts: `guard()` delega en
// `guardSeccion`, que consulta una sesión real; el mock lo ata a
// `isAuthenticated` para poder probar el 401.
vi.mock('@/lib/permisos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/permisos')>();
  return {
    ...actual,
    guardSeccion: vi.fn(async () => {
      const { isAuthenticated: chequear } = await import('@/lib/auth');
      if (!chequear({ get: () => undefined } as never)) {
        return { respuesta: NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 }) };
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

const mockAuth = vi.mocked(isAuthenticated);

const SUF = `${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const CUENTA = `act_campanias_${SUF}`;
// Los ids de campaña tienen que ser NUMÉRICOS y largos: así los manda Meta, y así
// los reconoce la extracción del UTM (`\|\s*[0-9]{6,}\s*$`) que usa el detector
// de ventas. Con un id que lleve letras o guiones el test pasaría por otro camino
// que el de producción.
const NUM = `${process.pid}${Math.floor(Math.random() * 1e6)}`.replace(/\D/g, '').slice(0, 15);
const CAMP_AR = `${NUM}1`;
const CAMP_LATAM = `${NUM}2`;
// Un día reciente: el GET mira los últimos 30 días de gasto y de ventas, así que
// un día fijo del año pasado dejaría todo en cero y el test verificaría nada.
const DIA = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);

let funnelAr = 0;
let funnelLatam = 0;

function req(method: 'GET' | 'POST', urlOrBody?: string | unknown, body?: unknown): NextRequest {
  const url =
    typeof urlOrBody === 'string'
      ? `http://localhost/api/config/ads/campanas${urlOrBody}`
      : 'http://localhost/api/config/ads/campanas';
  const payload = typeof urlOrBody === 'string' ? body : urlOrBody;
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

type Campania = {
  campaignId: string;
  campaignName: string | null;
  funnelId: number | null;
  funnelEfectivoId: number | null;
  funnelEfectivoName: string | null;
  spendEur: number;
  ventasPorFunnel: Array<{ funnelId: number | null; funnelName: string; ventas: number }>;
};

async function listar(): Promise<Campania[]> {
  const res = await GET(req('GET', `?accountId=${CUENTA}`));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { campanias: Campania[] };
  return body.campanias;
}

async function gastoPorFunnel(): Promise<Record<string, number>> {
  const rows = await q<{ funnel_id: number | null; total: string }>(
    `SELECT funnel_id, sum(spend_eur)::text AS total FROM ad_spend
      WHERE account_id = $1 GROUP BY funnel_id`,
    [CUENTA],
  );
  return Object.fromEntries(rows.map((r) => [String(r.funnel_id), Number(r.total)]));
}

describe.skipIf(!dbAvailable)('/api/config/ads/campanas', () => {
  beforeAll(async () => {
    const f = await q<{ id: number }>(
      `INSERT INTO funnels (slug, name, timezone, sell_currency, ingest_key_hash, active)
       VALUES ($1, 'Campanias AR', 'Europe/Lisbon', 'ARS', 'h1_' || md5(random()::text), true),
              ($2, 'Campanias LATAM', 'Europe/Lisbon', 'USD', 'h2_' || md5(random()::text), true)
       RETURNING id`,
      [`campanias_ar_${SUF}`, `campanias_latam_${SUF}`],
    );
    funnelAr = f[0]!.id;
    funnelLatam = f[1]!.id;

    await q(
      `INSERT INTO ad_accounts (account_id, platform, name, currency, timezone, funnel_id, active)
       VALUES ($1, 'meta', 'Compartida', 'EUR', 'Europe/Lisbon', $2::smallint, true)`,
      [CUENTA, funnelAr],
    );
    await q(
      `INSERT INTO ad_campaigns (campaign_id, account_id, name, status, effective_status, budget_level, currency, synced_at)
       VALUES ($1, $3, 'AR 01/03 hook', 'ACTIVE', 'ACTIVE', 'adset', 'EUR', now()),
              ($2, $3, 'LATAM 01/03 test', 'ACTIVE', 'ACTIVE', 'adset', 'EUR', now())`,
      [CAMP_AR, CAMP_LATAM, CUENTA],
    );
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await q('DELETE FROM daily_metrics WHERE funnel_id = ANY($1::smallint[])', [[funnelAr, funnelLatam]]);
    await q('DELETE FROM orders WHERE funnel_id = ANY($1::smallint[])', [[funnelAr, funnelLatam]]);
    await q('DELETE FROM ad_spend WHERE account_id = $1', [CUENTA]);
    await q('DELETE FROM ad_campaign_funnel WHERE account_id = $1', [CUENTA]);
    await q('DELETE FROM ad_accounts WHERE account_id = $1', [CUENTA]);
    await q('DELETE FROM funnels WHERE id = ANY($1::smallint[])', [[funnelAr, funnelLatam]]);
  });

  beforeEach(async () => {
    mockAuth.mockImplementation(() => true);
    await q('DELETE FROM ad_campaign_funnel WHERE account_id = $1', [CUENTA]);
    await q('DELETE FROM ad_spend WHERE account_id = $1', [CUENTA]);
    await q('DELETE FROM orders WHERE funnel_id = ANY($1::smallint[])', [[funnelAr, funnelLatam]]);
    // Gasto de las dos campañas, imputado a la cuenta (el estado que dejaba el
    // sync antes de que existiera el mapeo).
    await q(
      `INSERT INTO ad_spend (platform, account_id, funnel_id, day, level,
                             campaign_id, campaign_name, adset_id, ad_id,
                             spend, currency, spend_eur, impressions, clicks)
       VALUES ('meta', $1, $2::smallint, $3::date, 'ad', $4, 'AR 01/03 hook', 's1', 'a1', 40, 'EUR', 40, 100, 5),
              ('meta', $1, $2::smallint, $3::date, 'ad', $5, 'LATAM 01/03 test', 's2', 'a2', 59, 'EUR', 59, 200, 9)`,
      [CUENTA, funnelAr, DIA, CAMP_AR, CAMP_LATAM],
    );
    // Una venta del funnel LATAM atribuida por UTM a la campaña LATAM: es el
    // detector de "esta campaña no es del funnel al que se le está cobrando".
    await q(
      `INSERT INTO orders (funnel_id, source, external_id, status, tier, amount, currency,
                           amount_eur, utm_campaign, utm_medium, utm_content, purchased_at, day)
       VALUES ($1::smallint, 'checkout_propio', $2, 'approved', 'front', 9.90, 'USD', 8.54,
               $3, '(directo)', '(directo)', ($4::date + time '12:00')::timestamptz, $4::date)`,
      [funnelLatam, `test_campanias_${SUF}`, `LATAM 01/03 test|${CAMP_LATAM}`, DIA],
    );
  });

  it('GET lista las campañas con el funnel EFECTIVO (heredado de la cuenta) y el gasto', async () => {
    const campanias = await listar();
    expect(campanias).toHaveLength(2);
    // Ordenadas por gasto desc: LATAM gastó 59 y AR 40.
    expect(campanias[0]!.campaignId).toBe(CAMP_LATAM);
    expect(campanias[0]!.spendEur).toBe(59);
    for (const c of campanias) {
      expect(c.funnelId).toBeNull(); // sin excepción propia
      expect(c.funnelEfectivoId).toBe(funnelAr); // hereda la cuenta
      expect(c.funnelEfectivoName).toBe('Campanias AR');
    }
  });

  it('GET marca la discrepancia: la campaña LATAM tiene ventas de OTRO funnel que el que paga', async () => {
    const campanias = await listar();
    const latam = campanias.find((c) => c.campaignId === CAMP_LATAM)!;
    expect(latam.ventasPorFunnel).toEqual([
      { funnelId: funnelLatam, funnelName: 'Campanias LATAM', ventas: 1 },
    ]);
    expect(latam.funnelEfectivoId).toBe(funnelAr);
    // El otro no vendió: la lista viene vacía, no con un cero inventado.
    expect(campanias.find((c) => c.campaignId === CAMP_AR)!.ventasPorFunnel).toEqual([]);
  });

  it('POST asigna la campaña, REIMPUTA el gasto ya guardado y recomputa el rollup', async () => {
    expect(await gastoPorFunnel()).toEqual({ [String(funnelAr)]: 99 });

    const res = await POST(
      req('POST', { accountId: CUENTA, campaignId: CAMP_LATAM, funnelId: funnelLatam }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reasignadas: number; rollup: { from: string; to: string } | null };
    expect(body.reasignadas).toBe(1);
    expect(body.rollup).toEqual({ from: DIA, to: DIA, rows: expect.any(Number) });

    // El gasto quedó partido entre los dos funnels.
    expect(await gastoPorFunnel()).toEqual({
      [String(funnelAr)]: 40,
      [String(funnelLatam)]: 59,
    });

    // Y `daily_metrics` ya lo refleja: es lo que lee el Resumen.
    const ar = await q1<{ ads: string }>(
      `SELECT ad_spend_eur::text AS ads FROM daily_metrics WHERE funnel_id = $1 AND day = $2::date AND variant = '*'`,
      [funnelAr, DIA],
    );
    const latam = await q1<{ ads: string }>(
      `SELECT ad_spend_eur::text AS ads FROM daily_metrics WHERE funnel_id = $1 AND day = $2::date AND variant = '*'`,
      [funnelLatam, DIA],
    );
    expect(Number(ar?.ads)).toBe(40);
    expect(Number(latam?.ads)).toBe(59);
  });

  it('POST con funnelId null borra la excepción y el gasto vuelve al funnel de la cuenta', async () => {
    await POST(req('POST', { accountId: CUENTA, campaignId: CAMP_LATAM, funnelId: funnelLatam }));
    expect(await gastoPorFunnel()).toEqual({ [String(funnelAr)]: 40, [String(funnelLatam)]: 59 });

    const res = await POST(req('POST', { accountId: CUENTA, campaignId: CAMP_LATAM, funnelId: null }));
    expect(res.status).toBe(200);
    expect(await gastoPorFunnel()).toEqual({ [String(funnelAr)]: 99 });
    expect((await listar()).every((c) => c.funnelId === null)).toBe(true);
  });

  it('POST del mismo mapeo dos veces no reimputa de nuevo ni corre el rollup al vacío', async () => {
    await POST(req('POST', { accountId: CUENTA, campaignId: CAMP_LATAM, funnelId: funnelLatam }));
    const res = await POST(
      req('POST', { accountId: CUENTA, campaignId: CAMP_LATAM, funnelId: funnelLatam }),
    );
    const body = (await res.json()) as { reasignadas: number; rollup: unknown };
    expect(body.reasignadas).toBe(0);
    expect(body.rollup).toBeNull();
  });

  it('un id de campaña que no es de esa cuenta se rechaza con 404 y no deja mapeo', async () => {
    const res = await POST(req('POST', { accountId: CUENTA, campaignId: '999999999999', funnelId: funnelLatam }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('unknown_campaign');
    const filas = await q('SELECT 1 FROM ad_campaign_funnel WHERE account_id = $1', [CUENTA]);
    expect(filas).toHaveLength(0);
  });

  it('un funnel que no existe se rechaza con 404', async () => {
    const res = await POST(req('POST', { accountId: CUENTA, campaignId: CAMP_LATAM, funnelId: 32767 }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('unknown_funnel');
  });

  it('sin cookie: GET y POST dan 401 y el POST no escribe nada', async () => {
    mockAuth.mockImplementation(() => false);
    const g = await GET(req('GET', `?accountId=${CUENTA}`));
    expect(g.status).toBe(401);
    const p = await POST(req('POST', { accountId: CUENTA, campaignId: CAMP_LATAM, funnelId: funnelLatam }));
    expect(p.status).toBe(401);
    mockAuth.mockImplementation(() => true);
    expect(await gastoPorFunnel()).toEqual({ [String(funnelAr)]: 99 });
  });
});
