import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { q } from '../db';
import { syncAdSpend } from './sync';
import { fetchInsights } from './meta';
import type { MetaInsightRow } from './meta';

/**
 * La cascada de imputación del gasto (migración 033): una cuenta publicitaria
 * puede servir a varios funnels, y el funnel de cada fila de `ad_spend` sale del
 * mapeo de SU campaña, con caída al funnel de la cuenta.
 *
 * Lo que estaba pasando en producción el 2026-09-14: la cuenta de Chau Hinchazón
 * (funnel 1) tenía 4 campañas `LATAM 14/09 TEST …` gastando ~€59 para el funnel 3,
 * y las 34 filas de gasto quedaron con `funnel_id = 1`. Resultado: el Resumen le
 * cobraba a AR el gasto de LATAM y LATAM mostraba €0,00 con 2 ventas.
 *
 * Necesita PostgreSQL. `fetchInsights` se mockea: no toca Meta.
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

const SUF = `${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const CUENTA = `act_cascada_${SUF}`;
const CAMP_HEREDA = `900${SUF}1`;
const CAMP_MAPEADA = `900${SUF}2`;
const DIA = '2026-09-14';

let funnelCuenta = 0;
let funnelCampania = 0;

function fila(campaignId: string, spend: number): MetaInsightRow {
  return {
    date: DIA,
    accountId: CUENTA,
    campaignId,
    campaignName: `Campaña ${campaignId}`,
    adsetId: `s_${campaignId}`,
    adsetName: 'Conjunto',
    adId: `a_${campaignId}`,
    adName: 'Anuncio',
    spend,
    impressions: 100,
    clicks: 3,
    videoReproducciones: null,
    videoThruplay: null,
    videoP25: null,
    videoP50: null,
    videoP75: null,
    videoP100: null,
  };
}

async function correrSync(): Promise<void> {
  await syncAdSpend({
    from: DIA,
    to: DIA,
    cuentas: [{ accountId: CUENTA, funnelId: funnelCuenta, currency: 'EUR', name: 'cascada' }],
  });
}

/** funnel_id con el que quedó cada campaña en ad_spend. */
async function imputacion(): Promise<Record<string, number | null>> {
  const rows = await q<{ campaign_id: string; funnel_id: number | null }>(
    `SELECT campaign_id, funnel_id FROM ad_spend WHERE account_id = $1 ORDER BY campaign_id`,
    [CUENTA],
  );
  return Object.fromEntries(rows.map((r) => [r.campaign_id, r.funnel_id]));
}

describe.skipIf(!dbAvailable)('sync: imputación por campaña con cascada a la cuenta', () => {
  beforeAll(async () => {
    const f = await q<{ id: number }>(
      `INSERT INTO funnels (slug, name, timezone, sell_currency, ingest_key_hash, active)
       VALUES ($1, 'Cascada cuenta', 'Europe/Lisbon', 'ARS', 'h1_' || md5(random()::text), true),
              ($2, 'Cascada campaña', 'Europe/Lisbon', 'USD', 'h2_' || md5(random()::text), true)
       RETURNING id`,
      [`cascada_cuenta_${SUF}`, `cascada_camp_${SUF}`],
    );
    funnelCuenta = f[0]!.id;
    funnelCampania = f[1]!.id;
    await q(
      `INSERT INTO ad_accounts (account_id, platform, name, currency, timezone, funnel_id, active)
       VALUES ($1, 'meta', 'Cascada', 'EUR', 'Europe/Lisbon', $2::smallint, true)`,
      [CUENTA, funnelCuenta],
    );
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await q('DELETE FROM ad_spend WHERE account_id = $1', [CUENTA]);
    await q('DELETE FROM ad_campaign_funnel WHERE account_id = $1', [CUENTA]);
    await q('DELETE FROM ad_accounts WHERE account_id = $1', [CUENTA]);
    await q('DELETE FROM funnels WHERE id = ANY($1::smallint[])', [[funnelCuenta, funnelCampania]]);
  });

  beforeEach(async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue([fila(CAMP_HEREDA, 10), fila(CAMP_MAPEADA, 20)]);
    await q('DELETE FROM ad_spend WHERE account_id = $1', [CUENTA]);
    await q('DELETE FROM ad_campaign_funnel WHERE account_id = $1', [CUENTA]);
  });

  it('sin mapeo, TODO el gasto va al funnel de la cuenta (idéntico a antes de la 033)', async () => {
    await correrSync();
    expect(await imputacion()).toEqual({
      [CAMP_HEREDA]: funnelCuenta,
      [CAMP_MAPEADA]: funnelCuenta,
    });
  });

  it('con una campaña mapeada, esa fila va a SU funnel y las demás siguen heredando', async () => {
    await q(
      `INSERT INTO ad_campaign_funnel (campaign_id, funnel_id, account_id, campaign_name)
       VALUES ($1, $2::smallint, $3, 'LATAM')`,
      [CAMP_MAPEADA, funnelCampania, CUENTA],
    );
    await correrSync();
    expect(await imputacion()).toEqual({
      [CAMP_HEREDA]: funnelCuenta,
      [CAMP_MAPEADA]: funnelCampania,
    });
  });

  // Es el caso real: el gasto entró antes de que existiera el mapeo. El sync
  // corre cada hora y su ON CONFLICT incluye funnel_id, así que la fila vieja se
  // corrige sin tocar nada más. (El endpoint además reimputa el histórico y
  // recorre el rollup, que es lo que el sync no hace.)
  it('mapear DESPUÉS de que el gasto ya entró: el sync siguiente corrige la fila', async () => {
    await correrSync();
    expect((await imputacion())[CAMP_MAPEADA]).toBe(funnelCuenta);

    await q(
      `INSERT INTO ad_campaign_funnel (campaign_id, funnel_id, account_id)
       VALUES ($1, $2::smallint, $3)`,
      [CAMP_MAPEADA, funnelCampania, CUENTA],
    );
    await correrSync();
    expect((await imputacion())[CAMP_MAPEADA]).toBe(funnelCampania);
  });

  it('borrar el mapeo devuelve la campaña al funnel de la cuenta', async () => {
    await q(
      `INSERT INTO ad_campaign_funnel (campaign_id, funnel_id, account_id)
       VALUES ($1, $2::smallint, $3)`,
      [CAMP_MAPEADA, funnelCampania, CUENTA],
    );
    await correrSync();
    expect((await imputacion())[CAMP_MAPEADA]).toBe(funnelCampania);

    await q('DELETE FROM ad_campaign_funnel WHERE campaign_id = $1', [CAMP_MAPEADA]);
    await correrSync();
    expect((await imputacion())[CAMP_MAPEADA]).toBe(funnelCuenta);
  });

  it('una cuenta sin funnel asignado con una campaña mapeada: la mapeada se imputa y el resto queda sin asignar', async () => {
    await q('UPDATE ad_accounts SET funnel_id = NULL WHERE account_id = $1', [CUENTA]);
    await q(
      `INSERT INTO ad_campaign_funnel (campaign_id, funnel_id, account_id)
       VALUES ($1, $2::smallint, $3)`,
      [CAMP_MAPEADA, funnelCampania, CUENTA],
    );
    try {
      await syncAdSpend({
        from: DIA,
        to: DIA,
        cuentas: [{ accountId: CUENTA, funnelId: null, currency: 'EUR', name: 'cascada' }],
      });
      expect(await imputacion()).toEqual({
        [CAMP_HEREDA]: null,
        [CAMP_MAPEADA]: funnelCampania,
      });
    } finally {
      await q('UPDATE ad_accounts SET funnel_id = $2::smallint WHERE account_id = $1', [CUENTA, funnelCuenta]);
    }
  });
});
