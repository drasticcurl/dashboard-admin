import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { q, q1 } from '../../db';
import { getMetricasAds } from '../../queries/ads';
import { enviar, fetchObjeto } from '../meta';
import * as repo from './repo';
import { correrRegla, reconciliar } from './ejecutor';
import type { Condicion, MetricasObjeto, ResultadoMetricas } from '../tipos';

// Los mocks de red: getMetricasAds es el stub de T13 (tira), así que se reemplaza
// por completo; enviar/fetchObjeto se mockean para no tocar Meta.
vi.mock('../../queries/ads', () => ({ getMetricasAds: vi.fn() }));
vi.mock('../meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../meta')>();
  return { ...actual, enviar: vi.fn(), fetchObjeto: vi.fn(), fetchMinimoPresupuesto: vi.fn() };
});

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

const mockMetricas = vi.mocked(getMetricasAds);
const mockEnviar = vi.mocked(enviar);
const mockFetchObjeto = vi.mocked(fetchObjeto);

function filaTest(overrides: Partial<MetricasObjeto> = {}): MetricasObjeto {
  return {
    level: 'adset',
    objectId: 'obj_1',
    objectName: 'Conjunto de prueba',
    accountId: 'act_1',
    campaignId: 'camp_1',
    adsetId: 'obj_1',
    adId: '',
    funnelId: null,
    status: 'ACTIVE',
    effectiveStatus: 'ACTIVE',
    budgetLevel: 'adset',
    budgetMode: 'daily',
    dailyBudgetEur: 10,
    spendEur: 20,
    impressions: 0,
    clicks: 0,
    sales: 0,
    revenueEur: 0,
    refundedEur: 0,
    commissionsEur: 0,
    costsEur: 0,
    netEur: 0,
    profitEur: 0,
    roas: null,
    roi: null,
    cpaEur: null,
    ctr: null,
    cpcEur: null,
    ultimaAccionAt: null,
    cpmEur: null,
    hookRate: null,
    videoReproducciones: null,
    videoThruplay: null,
    videoP25: null,
    videoP50: null,
    videoP75: null,
    videoP100: null,
    alcance: null,
    frecuencia: null,
    inicioProgramado: null,
    ...overrides,
  };
}

function resultadoMetricas(filas: MetricasObjeto[]): ResultadoMetricas {
  return {
    filas,
    hayMas: false,
    sinAtribuir: { sales: 0, revenueEur: 0 },
    rango: { from: '2026-08-12', to: '2026-08-12', timezone: 'Europe/Lisbon' },
    generatedAt: new Date().toISOString(),
    total: filas.length,
    pagina: 1,
    totalPaginas: 1,
    orden: { clave: 'gastos', dir: 'desc' },
    alcanceError: null,
  };
}

const PREFIJO = 'T16-EJEC-';

describe.skipIf(!dbAvailable)('ejecutor (integración)', () => {
  const idsCreados: number[] = [];

  beforeAll(async () => {
    // Guardar el estado de los interruptores para restaurarlo al final.
    const s = await q1<{ key: string; value: unknown }>(
      `SELECT key, value FROM settings WHERE key IN ('ads_rules_enabled', 'ads_rules_force_dry_run')`,
    );
    // No se tocan acá: los tests que necesitan escritura real los fijan ellos mismos.
  });

  afterEach(async () => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await q(`DELETE FROM ad_actions WHERE rule_name LIKE $1`, [PREFIJO + '%']);
    await q(`DELETE FROM ad_actions WHERE object_id LIKE $1`, [PREFIJO + '%']);
    await q(`DELETE FROM ad_rule_runs WHERE rule_name LIKE $1`, [PREFIJO + '%']);
    await q(`DELETE FROM ad_rules WHERE name LIKE $1`, [PREFIJO + '%']);
    // Restaurar los interruptores al lado seguro.
    await q(`UPDATE settings SET value = 'false'::jsonb WHERE key = 'ads_rules_enabled'`);
    await q(`UPDATE settings SET value = 'true'::jsonb WHERE key = 'ads_rules_force_dry_run'`);
  });

  async function crearRegla(dryRun: boolean, action: string, condiciones?: Condicion[]) {
    const nombre = `${PREFIJO}${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const r = await q1<{ id: number }>(
      `INSERT INTO ad_rules (name, enabled, dry_run, level, status_filter, action, cooldown_minutes, max_actions_per_object_per_day)
       VALUES ($1, true, $2, 'adset', 'active', $3, 0, 4)
       RETURNING id`,
      [nombre, dryRun, action],
    );
    const id = r!.id;
    idsCreados.push(id);
    if (condiciones) {
      for (let i = 0; i < condiciones.length; i++) {
        await q(
          `INSERT INTO ad_rule_conditions (rule_id, metric, op, value, position) VALUES ($1, $2, $3, $4, $5)`,
          [id, condiciones[i].metric, condiciones[i].op, condiciones[i].value, i],
        );
      }
    }
    return (await repo.reglaPorId(id))!;
  }

  it('22b: un objeto que NO cumple no produce fila en ad_actions; se cuenta en objetos_evaluados', async () => {
    await q(`UPDATE settings SET value = 'true'::jsonb WHERE key = 'ads_rules_enabled'`);
    const r = await crearRegla(true, 'pause', [{ metric: 'spend', op: '>', value: 10 }]);
    // 10 objetos: 1 cumple (spend 20), 9 no (spend 1).
    const filas = [
      filaTest({ objectId: 'obj_cumple', spendEur: 20 }),
      ...Array.from({ length: 9 }, (_, i) => filaTest({ objectId: `obj_no_${i}`, spendEur: 1 })),
    ];
    mockMetricas.mockResolvedValue(resultadoMetricas(filas));

    const res = await correrRegla(r, { ahora: new Date('2026-08-12T12:00:00Z') });

    expect(res.objetosEvaluados).toBe(10);
    expect(res.objetosQueCumplen).toBe(1);
    expect(res.simuladas).toBe(1);

    const filasAccion = await q<{ n: string }>(
      `SELECT count(*)::int AS n FROM ad_actions WHERE run_id = $1`,
      [res.runId],
    );
    expect(Number(filasAccion[0].n)).toBe(1);

    const run = await q1<{ objetos_evaluados: number; objetos_que_cumplen: number }>(
      `SELECT objetos_evaluados, objetos_que_cumplen FROM ad_rule_runs WHERE id = $1`,
      [res.runId],
    );
    expect(run?.objetos_evaluados).toBe(10);
    expect(run?.objetos_que_cumplen).toBe(1);
  });

  it('22c: un objeto que cumple pero se omite SÍ produce fila, con estado omitido y skipped_reason', async () => {
    await q(`UPDATE settings SET value = 'true'::jsonb WHERE key = 'ads_rules_enabled'`);
    const r = await crearRegla(true, 'pause', [{ metric: 'spend', op: '>', value: 10 }]);
    // Ya PAUSED → cumple la condición pero el freno de "ya está en ese estado".
    mockMetricas.mockResolvedValue(resultadoMetricas([filaTest({ objectId: 'obj_pausado', spendEur: 20, status: 'PAUSED' })]));

    const res = await correrRegla(r, { ahora: new Date('2026-08-12T12:00:00Z') });

    expect(res.omitidas).toBe(1);
    const filas = await q<{ estado: string; skipped_reason: string | null }>(
      `SELECT estado, skipped_reason FROM ad_actions WHERE run_id = $1`,
      [res.runId],
    );
    expect(filas).toHaveLength(1);
    expect(filas[0].estado).toBe('omitido');
    expect(filas[0].skipped_reason).toBe('ya_esta_en_ese_estado');
  });

  it('22d: la fila se abre ANTES del POST; un timeout queda indeterminado y consume cupo', async () => {
    await q(`UPDATE settings SET value = 'true'::jsonb WHERE key = 'ads_rules_enabled'`);
    await q(`UPDATE settings SET value = 'false'::jsonb WHERE key = 'ads_rules_force_dry_run'`);
    const r = await crearRegla(false, 'pause', [{ metric: 'spend', op: '>', value: 10 }]);
    mockMetricas.mockResolvedValue(resultadoMetricas([filaTest({ objectId: 'obj_real', spendEur: 20 })]));
    mockEnviar.mockResolvedValue({ estado: 'indeterminado', error: new (await import('../meta')).MetaAdsError('timeout') });

    const res = await correrRegla(r, { ahora: new Date('2026-08-12T12:00:00Z') });

    const filaAccion = await q1<{ estado: string }>(
      `SELECT estado FROM ad_actions WHERE run_id = $1`,
      [res.runId],
    );
    expect(filaAccion?.estado).toBe('indeterminado');

    // consume cupo: historialDeHoy lo cuenta como acción real.
    const hist = await repo.historialDeHoy(['obj_real']);
    expect(hist.get('obj_real')?.cuenta).toBe(1);
  });

  it('22e: reconciliar cierra una fila pendiente según lo que dice Meta (after_value → confirmado)', async () => {
    await q(`UPDATE settings SET value = 'true'::jsonb WHERE key = 'ads_rules_enabled'`);
    const obj = `${PREFIJO}recon`;
    await q(
      `INSERT INTO ad_actions (source, account_id, level, object_id, action, ok, estado, explicacion, before_value, after_value, created_at)
       VALUES ('rule', 'act_1', 'adset', $1, 'pause', false, 'pendiente', 'reconciliar', 'ACTIVE', 'PAUSED', now() - interval '5 min')`,
      [obj],
    );
    // Meta dice que quedó PAUSED (el after_value).
    mockFetchObjeto.mockResolvedValue({
      objectId: obj,
      status: 'PAUSED',
      effectiveStatus: 'PAUSED',
      dailyBudget: null,
      lifetimeBudget: null,
    });

    const r = await reconciliar();
    expect(r.confirmadas).toBe(1);

    const filaAccion = await q1<{ estado: string }>(
      `SELECT estado FROM ad_actions WHERE object_id = $1 AND explicacion = 'reconciliar'`,
      [obj],
    );
    expect(filaAccion?.estado).toBe('confirmado');
  });
});
