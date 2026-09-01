import fc from 'fast-check';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { q } from '../db';
import { syncAdSpend } from './sync';
import { fetchInsights, MetaAdsError } from './meta';
import type { MetaInsightRow } from './meta';

/**
 * Property 9 (task 13.3) y tests de ejemplo del sync de creativo (task 13.4).
 * Necesita PostgreSQL: el upsert idempotente se verifica contra ad_spend real.
 * `fetchInsights` se mockea: ninguna propiedad toca Meta.
 */

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

vi.mock('./meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./meta')>();
  return { ...actual, fetchInsights: vi.fn() };
});

const mockFetch = vi.mocked(fetchInsights);

const CUENTA = `P9-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const DESDE = '2026-01-01';
const HASTA = '2026-01-03';

const hexId = (): fc.Arbitrary<string> =>
  fc.integer({ min: 0, max: 0xffffffff }).map((n) => n.toString(16).padStart(8, '0'));

/** Filas de Insights con campos de video presentes, ausentes y en cero. */
function genFilasInsights(): fc.Arbitrary<MetaInsightRow[]> {
  const video = (): fc.Arbitrary<number | null> =>
    fc.oneof(fc.integer({ min: 0, max: 20 }), fc.constant(null));
  return fc.array(
    fc
      .tuple(
        fc.constantFrom(DESDE, '2026-01-02'),
        hexId(),
        hexId(),
        hexId(),
        fc.integer({ min: 0, max: 30 }), // spend
        fc.integer({ min: 0, max: 30 }), // impressions
        fc.integer({ min: 0, max: 30 }), // clicks
        video(),
        video(),
        video(),
        video(),
        video(),
        video(),
      )
      .map(
        ([date, c, s, a, spend, impressions, clicks, vPlays, vThru, v25, v50, v75, v100]) =>
          ({
            date,
            accountId: CUENTA,
            campaignId: `c-${c}`,
            campaignName: `Campaña ${c}`,
            adsetId: `s-${s}`,
            adsetName: `Conjunto ${s}`,
            adId: `a-${a}`,
            adName: `Anuncio ${a}`,
            spend,
            impressions,
            clicks,
            videoReproducciones: vPlays,
            videoThruplay: vThru,
            videoP25: v25,
            videoP50: v50,
            videoP75: v75,
            videoP100: v100,
          }) satisfies MetaInsightRow,
      ),
    { minLength: 0, maxLength: 200 },
  );
}

async function estadoGuardado(): Promise<string> {
  const rows = await q(
    `SELECT day, campaign_id, adset_id, ad_id, spend, impressions, clicks,
            video_plays, video_thruplay, video_p25, video_p50, video_p75, video_p100
       FROM ad_spend WHERE account_id = $1
      ORDER BY day, campaign_id, adset_id, ad_id`,
    [CUENTA],
  );
  return JSON.stringify(rows);
}

afterAll(async () => {
  if (!dbAvailable) return;
  await q('DELETE FROM ad_spend WHERE account_id = $1', [CUENTA]);
});

afterEach(() => {
  mockFetch.mockReset();
});

// Feature: gestion-campanas-anuncios, Property 9: Guardar Metricas_Creativo es
// idempotente
describe.skipIf(!dbAvailable)('Property 9 (R7 c9, c13)', () => {
  it('para todo conjunto de filas de Insights, dos corridas sobre el mismo rango dejan las mismas filas y valores, salvo synced_at', async () => {
    await fc.assert(
      fc.asyncProperty(genFilasInsights(), async (filas) => {
        mockFetch.mockResolvedValue(filas);

        const primera = await syncAdSpend({ from: DESDE, to: HASTA, cuentas: [{ accountId: CUENTA, funnelId: null, currency: 'EUR', name: 'test' }] });
        const estado1 = await estadoGuardado();

        // piso una marca de tiempo vieja para que la comparación no dependa del reloj
        await q('UPDATE ad_spend SET synced_at = now() - interval \'1 day\' WHERE account_id = $1', [CUENTA]);

        const segunda = await syncAdSpend({ from: DESDE, to: HASTA, cuentas: [{ accountId: CUENTA, funnelId: null, currency: 'EUR', name: 'test' }] });
        const estado2 = await estadoGuardado();

        expect(estado2).toBe(estado1);
        expect(segunda.cuentas[0]!.error).toBeNull();
        expect(primera.cuentas[0]!.error).toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Tests de ejemplo (task 13.4) ────────────────────────────────────────────

function filaBasica(sobre: Partial<MetaInsightRow> = {}): MetaInsightRow {
  return {
    date: DESDE,
    accountId: CUENTA,
    campaignId: 'c-ej',
    campaignName: 'Campaña ejemplo',
    adsetId: 's-ej',
    adsetName: 'Conjunto ejemplo',
    adId: 'a-ej',
    adName: 'Anuncio ejemplo',
    spend: 0,
    impressions: 0,
    clicks: 0,
    videoReproducciones: null,
    videoThruplay: null,
    videoP25: null,
    videoP50: null,
    videoP75: null,
    videoP100: null,
    ...sobre,
  };
}

const CUENTAS = [
  { accountId: CUENTA, funnelId: null, currency: 'EUR', name: 'test' },
];

describe.skipIf(!dbAvailable)('sync de creativo — ejemplos (R7 c11, c13, c15)', () => {
  it('una fila con gasto 0 y una impresión se guarda (R7 c13)', async () => {
    mockFetch.mockResolvedValue([filaBasica({ impressions: 5, videoReproducciones: 2 })]);

    const r = await syncAdSpend({ from: DESDE, to: HASTA, cuentas: CUENTAS });
    expect(r.cuentas[0]!.error).toBeNull();
    expect(r.cuentas[0]!.filas).toBe(1);

    const guardada = await q(
      `SELECT impressions, video_plays FROM ad_spend WHERE account_id = $1 AND ad_id = 'a-ej'`,
      [CUENTA],
    );
    expect(guardada).toHaveLength(1);
    expect(Number(guardada[0]!.impressions)).toBe(5);
    expect(Number(guardada[0]!.video_plays)).toBe(2);
  });

  it('el reintento degradado pide sólo gasto, impresiones y clics, y deja el video en NULL (R7 c11)', async () => {
    mockFetch
      .mockImplementationOnce(() => Promise.reject(new MetaAdsError('campo no soportado', 100)))
      .mockImplementationOnce(() =>
        Promise.resolve([filaBasica({ spend: 10, impressions: 5 })]),
      );

    const r = await syncAdSpend({ from: DESDE, to: HASTA, cuentas: CUENTAS });
    expect(r.cuentas[0]!.error).toBeNull();
    // el segundo intento pidió SOLO lo básico
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1]![3]).toBe(true);

    const guardada = await q(
      `SELECT spend, video_plays FROM ad_spend WHERE account_id = $1 AND ad_id = 'a-ej'`,
      [CUENTA],
    );
    expect(guardada).toHaveLength(1);
    expect(Number(guardada[0]!.spend)).toBe(10);
    expect(guardada[0]!.video_plays).toBeNull(); // campo ausente ≠ 0
  });

  it('el error de una cuenta va a last_sync_error recortado a 500 y las demás cuentas siguen (R7 c15)', async () => {
    const fallida = `EJ13-${Date.now()}-fallida`;
    const sana = `EJ13-${Date.now()}-sana`;
    await q(
      `INSERT INTO ad_accounts (account_id, platform, name, currency, active)
       VALUES ($1, 'meta', 'fallida', 'EUR', true), ($2, 'meta', 'sana', 'EUR', true)
       ON CONFLICT (account_id) DO UPDATE SET active = true`,
      [fallida, sana],
    );
    try {
      mockFetch
        .mockImplementationOnce(() => Promise.reject(new MetaAdsError('boom', 100)))
        .mockImplementationOnce(() => Promise.reject(new MetaAdsError('boom de nuevo', 100)))
        .mockImplementationOnce(() => Promise.resolve([filaBasica({ accountId: sana, adId: 'a-sana', spend: 7 })]));

      const r = await syncAdSpend({
        from: DESDE,
        to: HASTA,
        cuentas: [
          { accountId: fallida, funnelId: null, currency: 'EUR', name: 'fallida' },
          { accountId: sana, funnelId: null, currency: 'EUR', name: 'sana' },
        ],
      });
      expect(r.cuentas[0]!.error).not.toBeNull();
      expect(r.cuentas[1]!.error).toBeNull();
      expect(r.cuentas[1]!.filas).toBe(1);

      const err = await q<{ last_sync_error: string | null }>(
        `SELECT last_sync_error FROM ad_accounts WHERE account_id = $1`,
        [fallida],
      );
      expect(err[0]!.last_sync_error).toContain('boom de nuevo');
      expect(err[0]!.last_sync_error!.length).toBeLessThanOrEqual(500);

      const sanaRows = await q(`SELECT count(*)::int AS n FROM ad_spend WHERE account_id = $1`, [sana]);
      expect(sanaRows[0]!.n).toBe(1);
    } finally {
      await q('DELETE FROM ad_spend WHERE account_id = ANY($1::text[])', [[fallida, sana]]);
      await q('DELETE FROM ad_accounts WHERE account_id = ANY($1::text[])', [[fallida, sana]]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// El error pegajoso de una cuenta sin gasto (2026-09-02)
// ─────────────────────────────────────────────────────────────────────────────
//
// El UPDATE de `last_sync_at` / `last_sync_error` vive al final del `tx` que
// escribe las filas, y antes había un `continue` que se iba de la iteración
// cuando la cuenta devolvía cero filas relevantes. Resultado: una cuenta sin
// gasto quedaba congelada en el último instante en que tuvo filas o falló, y un
// error viejo no se limpiaba nunca.
//
// Se vio en producción con la cuenta «Protocolo reset», sin gasto desde el
// 2026-08-26: un `TypeError: fetch failed` transitorio del 2026-09-01 a las
// 14:27 seguía en pantalla 10 horas después, con `min(last_sync_at)` clavado en
// el pasado — y ese mínimo es la puerta de frescura de `live.ts` y del worker,
// así que el TTL de insights quedaba vencido para siempre.
describe.skipIf(!dbAvailable)('una corrida sin filas es exitosa igual', () => {
  const SIN_GASTO = `P9-CERO-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  afterAll(async () => {
    if (!dbAvailable) return;
    await q('DELETE FROM ad_spend WHERE account_id = $1', [SIN_GASTO]);
    await q('DELETE FROM ad_accounts WHERE account_id = $1', [SIN_GASTO]);
  });

  it('cero filas limpia el last_sync_error viejo y adelanta last_sync_at', async () => {
    // La cuenta arranca como quedó en producción: con un error viejo y el reloj
    // detenido hace dos horas.
    await q(
      `INSERT INTO ad_accounts (account_id, platform, name, currency, timezone, active,
                                last_sync_at, last_sync_error)
       VALUES ($1, 'meta', 'sin gasto', 'EUR', 'Europe/Lisbon', true,
               now() - interval '2 hours', 'TypeError: fetch failed')`,
      [SIN_GASTO],
    );

    // Meta responde OK pero sin nada relevante: la cuenta no gastó.
    mockFetch.mockResolvedValue([]);

    const r = await syncAdSpend({
      from: DESDE,
      to: HASTA,
      cuentas: [{ accountId: SIN_GASTO, funnelId: null, currency: 'EUR', name: 'sin gasto' }],
    });

    // Para el resultado es una corrida sana, no un fallo.
    expect(r.cuentas[0]!.error).toBeNull();
    expect(r.cuentas[0]!.filas).toBe(0);

    const fila = await q<{ last_sync_error: string | null; edad_seg: number }>(
      `SELECT last_sync_error,
              extract(epoch FROM (now() - last_sync_at))::int AS edad_seg
         FROM ad_accounts WHERE account_id = $1`,
      [SIN_GASTO],
    );
    // El error viejo se fue...
    expect(fila[0]!.last_sync_error).toBeNull();
    // ...y el reloj avanzó: sin esto `min(last_sync_at)` deja el TTL vencido.
    expect(Number(fila[0]!.edad_seg)).toBeLessThan(60);
  });

  it('un dry-run con cero filas NO toca el reloj ni el error', async () => {
    // La otra mitad: una corrida que no sincronizó nada no puede afirmar que la
    // cuenta está fresca.
    await q(
      `UPDATE ad_accounts SET last_sync_at = now() - interval '2 hours',
                              last_sync_error = 'error previo'
        WHERE account_id = $1`,
      [SIN_GASTO],
    );
    mockFetch.mockResolvedValue([]);

    await syncAdSpend({
      from: DESDE,
      to: HASTA,
      dryRun: true,
      cuentas: [{ accountId: SIN_GASTO, funnelId: null, currency: 'EUR', name: 'sin gasto' }],
    });

    const fila = await q<{ last_sync_error: string | null; edad_seg: number }>(
      `SELECT last_sync_error,
              extract(epoch FROM (now() - last_sync_at))::int AS edad_seg
         FROM ad_accounts WHERE account_id = $1`,
      [SIN_GASTO],
    );
    expect(fila[0]!.last_sync_error).toBe('error previo');
    expect(Number(fila[0]!.edad_seg)).toBeGreaterThan(3000);
  });
});
