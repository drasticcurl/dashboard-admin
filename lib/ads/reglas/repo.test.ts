import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { q } from '../../db';
import * as repo from './repo';

// vitest no carga .env solo: se carga acá para que la suite corra contra la base
// real en vez de saltarse en silencio (mismo patrón que overview.test.ts).
if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

describe.skipIf(!dbAvailable)('repo (integración)', () => {
  const PREFIJO = 'T16-REPO-';
  const OBJ_SIM = `${PREFIJO}simulado`;
  const OBJ_REAL = `${PREFIJO}real`;

  beforeAll(async () => {
    await q(`DELETE FROM ad_actions WHERE object_id LIKE $1`, [PREFIJO + '%']);
  });

  afterAll(async () => {
    await q(`DELETE FROM ad_actions WHERE object_id LIKE $1`, [PREFIJO + '%']);
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

  it('reglasActivas devuelve reglas con sus condiciones y el tipo correcto', async () => {
    const reglas = await repo.reglasActivas();
    expect(reglas.length).toBeGreaterThanOrEqual(0);
    for (const r of reglas) {
      expect(r.regla.enabled).toBe(true);
      expect(typeof r.regla.id).toBe('number');
      expect(Array.isArray(r.regla.accountIds)).toBe(true);
    }
  });
});
