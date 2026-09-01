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

  // ───────────────────────────────────────────────────────────────────────────
  // El bucle de pausas del 2026-09-01
  // ───────────────────────────────────────────────────────────────────────────
  //
  // `objetos` es la unión de la jerarquía con los objetos que SÓLO tienen gasto,
  // y el anti-join decide quién entra por la segunda rama. Cuando ese anti-join
  // apuntaba a la jerarquía YA FILTRADA por estado, un conjunto pausado con gasto
  // salía de la primera rama y volvía a entrar por la segunda con `status` en
  // NULL: o sea que pedir "activos" devolvía un pausado, disfrazado de "no sé".
  //
  // Con eso, la regla «Apagar - Gasto +$4 sin ventas» pausó los mismos 15
  // conjuntos entre 23 y 57 veces por día, porque el chequeo de
  // `ya_esta_en_ese_estado` compara contra 'PAUSED' y NULL no es 'PAUSED'.
  //
  // Los dos tests son las dos mitades del invariante y hay que leerlos juntos: el
  // primero pide que el filtro de estado se respete, el segundo que la rama de
  // solo-gasto siga existiendo. Arreglar uno rompiendo el otro es el error que
  // este par previene.
  describe('el filtro de estado y la rama de solo-gasto', () => {
    beforeAll(async () => {
      // 8004: PAUSADO, en la jerarquía, CON gasto. El caso del bucle.
      await q(
        `INSERT INTO ad_sets (adset_id, campaign_id, account_id, name, status, effective_status,
                              currency, synced_at)
         VALUES ('8004', '9001', $1, 'S 8004 pausado con gasto', 'PAUSED', 'PAUSED', 'EUR', now())
         ON CONFLICT (adset_id) DO UPDATE SET status = 'PAUSED', effective_status = 'PAUSED'`,
        [CUENTA],
      );
      // 8005: NO existe en ad_sets, sólo tiene gasto. Es para lo que la rama existe.
      await q(
        `INSERT INTO ad_spend (platform, account_id, day, level, campaign_id, campaign_name,
                               adset_id, adset_name, ad_id, ad_name, spend, currency, spend_eur,
                               impressions, clicks, synced_at)
         SELECT 'meta', $1, $2::date, 'ad', '9001', 'C', u.sid, 'S', u.aid, 'A',
                u.gasto, 'EUR', u.gasto, 10, 1, now()
           FROM unnest($3::text[], $4::text[], $5::numeric[]) AS u(sid, aid, gasto)`,
        [CUENTA, dia, ['8004', '8005'], ['7004', '7005'], [7.18, 3]],
      );
    });

    it('un conjunto PAUSADO con gasto NO aparece al pedir los activos', async () => {
      const activos = await pedir({ status: 'active' });
      // Ni presente, ni colado con el estado en NULL por la otra rama.
      expect(activos.filas.map((f) => f.objectId)).not.toContain('8004');
      // Ningún objeto QUE ESTÁ EN LA JERARQUÍA se cuela con otro estado.
      expect(activos.filas.filter((f) => f.status !== null).every((f) => f.status === 'ACTIVE')).toBe(true);
    });

    it('lo que sí se cuela con estado NULL es sólo lo que no está en la jerarquía', async () => {
      // Y no es un agujero del filtro: la rama de solo-gasto es deliberadamente
      // ciega al estado, porque esconder gasto por no conocer el estado es peor
      // que mostrarlo. La consecuencia es que una regla de pausar PUEDE recibir
      // un objeto con `status` en null incluso pidiendo "activos", y por eso el
      // freno `estado_desconocido` de `motor.ts` es la segunda mitad del
      // arreglo, no un adorno.
      const activos = await pedir({ status: 'active' });
      const sinEstado = activos.filas.filter((f) => f.status === null).map((f) => f.objectId);
      expect(sinEstado).toEqual(['8005']);
      const enJerarquia = await q1<{ n: string }>(
        `SELECT count(*)::int AS n FROM ad_sets WHERE adset_id = '8005'`,
      );
      expect(Number(enJerarquia!.n)).toBe(0);
    });

    it('el mismo conjunto SÍ aparece al pedir los pausados, con su estado real', async () => {
      const pausados = await pedir({ status: 'paused' });
      const f = pausados.filas.find((x) => x.objectId === '8004');
      expect(f).toBeDefined();
      // Y con el estado de verdad, no en NULL: es lo que hace que el motor pueda
      // descartarlo con 'ya_esta_en_ese_estado' en vez de volver a pausarlo.
      expect(f!.status).toBe('PAUSED');
      expect(f!.spendEur).toBeGreaterThan(0);
    });

    it('un objeto que SÓLO tiene gasto sigue apareciendo, con estado NULL', async () => {
      // La razón de ser de la rama: gasto que no se puede esconder porque el
      // objeto no está en la jerarquía. Si se borrara la rama para arreglar lo de
      // arriba, este gasto desaparecería del panel sin que nadie se entere.
      const todos = await pedir({ status: 'any' });
      const f = todos.filas.find((x) => x.objectId === '8005');
      expect(f).toBeDefined();
      expect(f!.status).toBeNull();
      expect(f!.spendEur).toBeGreaterThan(0);
    });
  });
});
