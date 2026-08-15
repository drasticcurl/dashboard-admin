import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { q, q1 } from '../../db';
import { TZ_DEFAULT } from '../zona';
import * as repo from './repo';

// vitest no carga .env solo: se carga acá para que la suite corra contra la base
// real en vez de saltarse en silencio (mismo patrón que overview.test.ts).
if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

// Guarda de schema-probe (política de base de la spec reglas-anuncios-por-cuenta):
// la migración 021 la aplica el usuario con su runbook, NUNCA el agente. Contra
// una base en la 019 (`account_ids`, sin `account_id`) el SELECT de reglasActivas
// tira `column "account_id" does not exist`, y este test no arregla la base: los
// tests que necesitan el esquema nuevo se saltean con un mensaje claro. Es el
// equivalente a skipIf(!dbAvailable), misma filosofía.
//
// No puede ser un `describe.skipIf` con el probe adentro porque la consulta es
// async y el tsconfig del proyecto (target ES5) no admite top-level await; el
// skip se hace por test con `ctx.skip()`.
let avisoEsquemaDado = false;

async function requiereEsquema021(ctx: { skip: () => void }): Promise<boolean> {
  if (!dbAvailable) {
    ctx.skip();
    return false;
  }
  try {
    const r = await q1<{ n: string }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'ad_rules' AND column_name = 'account_id'`,
    );
    if (Number(r?.n ?? 0) > 0) return true;
  } catch {
    // base caída o probe fallido: se saltea igual que sin DATABASE_URL.
  }
  if (!avisoEsquemaDado) {
    avisoEsquemaDado = true;
    console.warn(
      '[repo.test.ts] la base está en la migración 019 (ad_rules.account_id no existe): ' +
        'la 021 la aplica el usuario con su runbook. Tests que la necesitan salteados.',
    );
  }
  ctx.skip();
  return false;
}

describe.skipIf(!dbAvailable)('repo (integración)', () => {
  const PREFIJO = 'T16-REPO-';
  const OBJ_SIM = `${PREFIJO}simulado`;
  const OBJ_REAL = `${PREFIJO}real`;
  const CUENTA_TZ_NULA = `${PREFIJO}cuenta-tz-nula`;
  const CUENTA_INACTIVA = `${PREFIJO}cuenta-inactiva`;
  const CUENTA_REGLA = `${PREFIJO}cuenta-con-regla`;

  beforeAll(async () => {
    await q(`DELETE FROM ad_actions WHERE object_id LIKE $1`, [PREFIJO + '%']);
    await q(`DELETE FROM ad_rules WHERE name LIKE $1`, [PREFIJO + '%']);
    await q(`DELETE FROM ad_accounts WHERE account_id LIKE $1`, [PREFIJO + '%']);
  });

  afterAll(async () => {
    await q(`DELETE FROM ad_actions WHERE object_id LIKE $1`, [PREFIJO + '%']);
    await q(`DELETE FROM ad_rules WHERE name LIKE $1`, [PREFIJO + '%']);
    await q(`DELETE FROM ad_accounts WHERE account_id LIKE $1`, [PREFIJO + '%']);
  });

  it('historialDeHoy: las simuladas NO consumen cupo; confirmado e indeterminado SÍ (verificación 016 §8)', async () => {
    await q(
      `INSERT INTO ad_actions (source, account_id, level, object_id, action, dry_run, ok, estado, explicacion, metrics)
       VALUES
         ('rule', 'act_1', 'adset', $1, 'pause', true,  true,  'simulado',      'x', '{}'),
         ('rule', 'act_1', 'adset', $2, 'pause', false, true,  'confirmado',    'x', '{}'),
         ('rule', 'act_1', 'adset', $2, 'pause', false, false, 'indeterminado', 'x', '{}')`,
      [OBJ_SIM, OBJ_REAL],
    );

    const hist = await repo.historialDeHoy([OBJ_SIM, OBJ_REAL]);

    // Simulada: no consume cupo, no bloquea → ni siquiera aparece en el Map.
    expect(hist.has(OBJ_SIM)).toBe(false);

    // Confirmado + indeterminado: dos que consumen cupo; la indeterminada bloquea.
    expect(hist.get(OBJ_REAL)?.cuenta).toBe(2);
    expect(hist.get(OBJ_REAL)?.sinCerrar).toBe(true);
  });

  it('interruptores(): con la fila ausente devuelve el lado seguro (habilitado false, forzarSombra true, topes 0)', async () => {
    const s = await repo.interruptores();
    // Sin saber el estado actual de la base, no se puede afirmar habilitado; se
    // verifica el TIPO y que los topes sean números finitos ≥ 0.
    expect(typeof s.habilitado).toBe('boolean');
    expect(typeof s.forzarSombra).toBe('boolean');
    expect(Number.isFinite(s.maxDailyBudgetEur)).toBe(true);
    expect(s.maxDailyBudgetEur).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(s.maxDeltaPorTickEur)).toBe(true);
  });

  it('reglasActivas devuelve reglas con sus condiciones y el tipo correcto', async (ctx) => {
    if (!(await requiereEsquema021(ctx))) return;
    const reglas = await repo.reglasActivas();
    expect(reglas.length).toBeGreaterThanOrEqual(0);
    for (const r of reglas) {
      expect(r.regla.enabled).toBe(true);
      expect(typeof r.regla.id).toBe('number');
      expect(typeof r.regla.accountId).toBe('string');
    }
  });

  it('zonaDeCuenta: timezone en NULL resuelve TZ_DEFAULT con activa true; active=false da activa false', async () => {
    await q(
      `INSERT INTO ad_accounts (account_id, platform, name, currency, timezone, active)
       VALUES ($1, 'meta', 'tz nula', 'EUR', NULL, true)
       ON CONFLICT (account_id) DO UPDATE SET timezone = NULL, active = true`,
      [CUENTA_TZ_NULA],
    );
    const r = await repo.zonaDeCuenta(CUENTA_TZ_NULA);
    expect(r).not.toBeNull();
    // El MISMO COALESCE(timezone, TZ_DEFAULT) que aplica getMetricasAds (R6 c3).
    expect(r!.timezone).toBe(TZ_DEFAULT);
    expect(r!.activa).toBe(true);

    await q(
      `INSERT INTO ad_accounts (account_id, platform, name, currency, timezone, active)
       VALUES ($1, 'meta', 'inactiva', 'EUR', 'America/Argentina/Buenos_Aires', false)
       ON CONFLICT (account_id) DO UPDATE SET timezone = 'America/Argentina/Buenos_Aires', active = false`,
      [CUENTA_INACTIVA],
    );
    const inactiva = await repo.zonaDeCuenta(CUENTA_INACTIVA);
    expect(inactiva).not.toBeNull();
    expect(inactiva!.activa).toBe(false);
    expect(inactiva!.timezone).toBe('America/Argentina/Buenos_Aires');
  });

  it('borrar una ad_accounts con al menos una Regla asociada tira 23503 y no borra ni la cuenta ni las Reglas', async (ctx) => {
    if (!(await requiereEsquema021(ctx))) return;
    await q(
      `INSERT INTO ad_accounts (account_id, platform, name, currency, timezone, active)
       VALUES ($1, 'meta', 'con regla', 'EUR', 'Europe/Lisbon', true)
       ON CONFLICT (account_id) DO UPDATE SET timezone = 'Europe/Lisbon', active = true`,
      [CUENTA_REGLA],
    );
    const r = await q1<{ id: number }>(
      `INSERT INTO ad_rules (name, enabled, dry_run, account_id, level, status_filter, action,
                             cooldown_minutes, max_actions_per_object_per_day)
       VALUES ($1, false, true, $2, 'adset', 'active', 'pause', 0, 4)
       RETURNING id`,
      [`${PREFIJO}regla-fk`, CUENTA_REGLA],
    );
    const ruleId = r!.id;

    // El FK de la 021 es ON DELETE RESTRICT: borrar la cuenta no puede borrar en
    // silencio la automatización que la operaba.
    await expect(
      q(`DELETE FROM ad_accounts WHERE account_id = $1`, [CUENTA_REGLA]),
    ).rejects.toMatchObject({ code: '23503' });

    const cuenta = await q1<{ n: string }>(
      `SELECT count(*)::int AS n FROM ad_accounts WHERE account_id = $1`,
      [CUENTA_REGLA],
    );
    expect(Number(cuenta!.n)).toBe(1);
    const regla = await q1<{ n: string }>(
      `SELECT count(*)::int AS n FROM ad_rules WHERE id = $1`,
      [ruleId],
    );
    expect(Number(regla!.n)).toBe(1);
  });
});
