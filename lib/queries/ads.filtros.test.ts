import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q, q1 } from '../db';
import { getMetricasAds } from './ads';

/**
 * Los dos interruptores de ruido de la Barra_Filtros:
 *
 *   ocultarSinDatos      → saca las filas sin gasto Y sin ventas en el período.
 *   ocultarPadreApagado  → saca los conjuntos y anuncios apagados por su padre
 *                          (CAMPAIGN_PAUSED / ADSET_PAUSED en Meta).
 *
 * El invariante que importa y el que justifica este archivo: UNA FILA CON GASTO
 * NO SE OCULTA NUNCA. Un filtro de ruido que esconde plata gastada es peor que
 * no tener filtro, porque el número que falta no se ve por definición.
 */
if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}
const dbAvailable = Boolean(process.env.DATABASE_URL);
const CUENTA = `FILT-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ZONA = 'Europe/Lisbon';

describe.skipIf(!dbAvailable)('filtros de ruido (ocultarSinDatos, ocultarPadreApagado)', () => {
  let dia: string;

  beforeAll(async () => {
    await q(
      `INSERT INTO ad_accounts (account_id, platform, name, currency, timezone, active)
       VALUES ($1, 'meta', 'cuenta de filtros', 'EUR', $2, true)
       ON CONFLICT (account_id) DO UPDATE SET timezone = $2, active = true`,
      [CUENTA, ZONA],
    );
    dia = (await q1<{ hoy: string }>(
      `SELECT (now() AT TIME ZONE $1)::date::text AS hoy`,
      [ZONA],
    ))!.hoy;

    // Tres campañas: una con gasto, una sin nada, y una con gasto cuyo conjunto
    // figura apagado por la campaña.
    await q(
      `INSERT INTO ad_campaigns (campaign_id, account_id, name, status, effective_status,
                                 budget_level, currency, synced_at)
       SELECT u.cid, $1, 'C ' || u.cid, u.st, u.est, 'adset', 'EUR', now()
         FROM unnest($2::text[], $3::text[], $4::text[]) AS u(cid, st, est)`,
      [CUENTA, ['9001', '9002', '9003'], ['ACTIVE', 'ACTIVE', 'PAUSED'], ['ACTIVE', 'ACTIVE', 'PAUSED']],
    );
    await q(
      `INSERT INTO ad_sets (adset_id, campaign_id, account_id, name, status, effective_status,
                            currency, synced_at)
       SELECT u.sid, u.cid, $1, 'S ' || u.sid, u.st, u.est, 'EUR', now()
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS u(sid, cid, st, est)`,
      [
        CUENTA,
        ['8001', '8002', '8003'],
        ['9001', '9002', '9003'],
        ['ACTIVE', 'ACTIVE', 'ACTIVE'],
        // 8003 está ACTIVE por sí mismo pero apagado porque su campaña está en pausa.
        ['ACTIVE', 'ACTIVE', 'CAMPAIGN_PAUSED'],
      ],
    );
    // Gasto sólo para 8001 y 8003. 8002 queda en cero absoluto.
    await q(
      `INSERT INTO ad_spend (platform, account_id, day, level, campaign_id, campaign_name,
                             adset_id, adset_name, ad_id, ad_name, spend, currency, spend_eur,
                             impressions, clicks, synced_at)
       SELECT 'meta', $1, $2::date, 'ad', u.cid, 'C', u.sid, 'S', u.aid, 'A',
              u.gasto, 'EUR', u.gasto, 10, 1, now()
         FROM unnest($3::text[], $4::text[], $5::text[], $6::numeric[])
              AS u(cid, sid, aid, gasto)`,
      [CUENTA, dia, ['9001', '9003'], ['8001', '8003'], ['7001', '7003'], [5, 7]],
    );
  });

  afterAll(async () => {
    await q(`DELETE FROM ad_spend WHERE account_id = $1`, [CUENTA]);
    await q(`DELETE FROM ad_sets WHERE account_id = $1`, [CUENTA]);
    await q(`DELETE FROM ad_campaigns WHERE account_id = $1`, [CUENTA]);
    await q(`DELETE FROM ad_accounts WHERE account_id = $1`, [CUENTA]);
  });

  const pedir = (extra: Record<string, unknown> = {}) =>
    getMetricasAds({
      level: 'adset',
      period: 'today',
      accountIds: [CUENTA],
      status: 'any',
      page: 1,
      limit: 100,
      ...extra,
    });

  it('sin los filtros se ven los tres conjuntos', async () => {
    const r = await pedir();
    expect(r.filas.map((f) => f.objectId).sort()).toEqual(['8001', '8002', '8003']);
  });

  it('ocultarSinDatos saca el que no tiene ni gasto ni ventas', async () => {
    const r = await pedir({ ocultarSinDatos: true });
    expect(r.filas.map((f) => f.objectId).sort()).toEqual(['8001', '8003']);
  });

  it('ocultarSinDatos NUNCA oculta una fila con gasto', async () => {
    const r = await pedir({ ocultarSinDatos: true });
    for (const f of r.filas) {
      if (f.spendEur > 0) expect(r.filas.map((x) => x.objectId)).toContain(f.objectId);
    }
    // Las dos que gastaron siguen estando, y el total refleja el recorte.
    expect(r.filas.filter((f) => f.spendEur > 0)).toHaveLength(2);
    expect(r.total).toBe(2);
  });

  it('ocultarPadreApagado saca el que está apagado por su campaña, no por sí mismo', async () => {
    const r = await pedir({ ocultarPadreApagado: true });
    expect(r.filas.map((f) => f.objectId).sort()).toEqual(['8001', '8002']);
    // 8003 estaba ACTIVE por sí mismo: lo que lo saca es el effective_status.
    expect(r.filas.find((f) => f.objectId === '8003')).toBeUndefined();
  });

  it('los dos filtros juntos se combinan en conjunción', async () => {
    const r = await pedir({ ocultarSinDatos: true, ocultarPadreApagado: true });
    expect(r.filas.map((f) => f.objectId)).toEqual(['8001']);
    expect(r.total).toBe(1);
  });

  it('a nivel campaña ocultarPadreApagado es inocuo: una campaña no tiene padre', async () => {
    const sin = await pedir({ level: 'campaign' });
    const con = await pedir({ level: 'campaign', ocultarPadreApagado: true });
    expect(con.filas.map((f) => f.objectId).sort()).toEqual(sin.filas.map((f) => f.objectId).sort());
  });
});
