import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { q, q1 } from '../../db';
import { getMetricasAds } from '../../queries/ads';
import { enviar, fetchObjeto } from '../meta';
import * as repo from './repo';
import { correrRegla, reconciliar } from './ejecutor';
import type { Condicion, MetricasObjeto, ResultadoMetricas } from '../tipos';
import { genMetricasObjeto, genRegla } from '../../test/generadores-ads';

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

// Guarda de schema-probe (política de base de la spec reglas-anuncios-por-cuenta):
// la migración 021 la aplica el usuario con su runbook, NUNCA el agente. Contra
// una base en la 019 (`account_ids`, sin `account_id`) el SELECT de reglaPorId
// tira `column "account_id" does not exist`, y este test no arregla la base: se
// saltea con un mensaje claro. Es el equivalente a skipIf(!dbAvailable), misma
// filosofía.
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
      '[ejecutor.test.ts] la base está en la migración 019 (ad_rules.account_id no existe): ' +
        'la 021 la aplica el usuario con su runbook. Suite salteada.',
    );
  }
  ctx.skip();
  return false;
}

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
    syncedAt: '2026-08-12T10:00:00.000Z',
    desaparecidoAt: null,
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
    // Los totales del filtro completo (R7.1). El ejecutor no los lee — evalúa
    // condiciones fila por fila — así que se derivan de `filas` para que el
    // fixture sea coherente y no para que alguna aserción los mire.
    totales: {
      spendEur: filas.reduce((a, f) => a + f.spendEur, 0),
      revenueEur: filas.reduce((a, f) => a + f.revenueEur, 0),
      netEur: filas.reduce((a, f) => a + f.netEur, 0),
      profitEur: filas.reduce((a, f) => a + f.profitEur, 0),
      sales: filas.reduce((a, f) => a + f.sales, 0),
      filas: filas.length,
    },
  };
}

const PREFIJO = 'T16-EJEC-';
const CUENTA_ACTIVA = `${PREFIJO}activa`;
const CUENTA_INACTIVA = `${PREFIJO}inactiva`;

describe.skipIf(!dbAvailable)('ejecutor (integración)', () => {
  beforeAll(async () => {
    // Las dos cuentas del módulo de prueba: una activa (con la que corren todas
    // las Reglas) y una inactiva (para la guarda de cuenta_inactiva).
    await q(
      `INSERT INTO ad_accounts (account_id, platform, name, currency, timezone, active)
       VALUES ($1, 'meta', 'cuenta activa T16', 'EUR', 'America/Argentina/Buenos_Aires', true)
       ON CONFLICT (account_id) DO UPDATE SET timezone = 'America/Argentina/Buenos_Aires', active = true`,
      [CUENTA_ACTIVA],
    );
    await q(
      `INSERT INTO ad_accounts (account_id, platform, name, currency, timezone, active)
       VALUES ($1, 'meta', 'cuenta inactiva T16', 'EUR', 'America/Argentina/Buenos_Aires', false)
       ON CONFLICT (account_id) DO UPDATE SET timezone = 'America/Argentina/Buenos_Aires', active = false`,
      [CUENTA_INACTIVA],
    );
  });

  afterEach(async () => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await q(`DELETE FROM ad_actions WHERE rule_name LIKE $1`, [PREFIJO + '%']);
    await q(`DELETE FROM ad_actions WHERE object_id LIKE $1`, [PREFIJO + '%']);
    await q(`DELETE FROM ad_rule_runs WHERE rule_name LIKE $1`, [PREFIJO + '%']);
    await q(`DELETE FROM ad_rules WHERE name LIKE $1`, [PREFIJO + '%']);
    await q(`DELETE FROM ad_accounts WHERE account_id LIKE $1`, [PREFIJO + '%']);
    // Restaurar los interruptores al lado seguro.
    await q(`UPDATE settings SET value = 'false'::jsonb WHERE key = 'ads_rules_enabled'`);
    await q(`UPDATE settings SET value = 'true'::jsonb WHERE key = 'ads_rules_force_dry_run'`);
  });

  async function crearRegla(
    dryRun: boolean,
    action: string,
    condiciones?: Condicion[],
    accountId = CUENTA_ACTIVA,
  ) {
    const nombre = `${PREFIJO}${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const r = await q1<{ id: number }>(
      `INSERT INTO ad_rules (name, enabled, dry_run, account_id, level, status_filter, action,
                             cooldown_minutes, max_actions_per_object_per_day)
       VALUES ($1, true, $2, $3, 'adset', 'active', $4, 0, 4)
       RETURNING id`,
      [nombre, dryRun, accountId, action],
    );
    const id = r!.id;
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

  it('22b: un objeto que NO cumple no produce fila en ad_actions; se cuenta en objetos_evaluados', async (ctx) => {
    if (!(await requiereEsquema021(ctx))) return;
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

  it('22c: un objeto que cumple pero se omite SÍ produce fila, con estado omitido y skipped_reason', async (ctx) => {
    if (!(await requiereEsquema021(ctx))) return;
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

  it('22d: la fila se abre ANTES del POST; un timeout queda indeterminado y consume cupo', async (ctx) => {
    if (!(await requiereEsquema021(ctx))) return;
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

  it('22e: reconciliar cierra una fila pendiente según lo que dice Meta (after_value → confirmado)', async (ctx) => {
    if (!(await requiereEsquema021(ctx))) return;
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
      name: null,
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

  it('cuenta desactivada: no llama a Meta, no abre Corrida y el motivo nombra la cuenta', async (ctx) => {
    if (!(await requiereEsquema021(ctx))) return;
    await q(`UPDATE settings SET value = 'true'::jsonb WHERE key = 'ads_rules_enabled'`);
    const r = await crearRegla(true, 'pause', undefined, CUENTA_INACTIVA);

    const res = await correrRegla(r, { ahora: new Date('2026-08-12T12:00:00Z') });

    expect(res.corrio).toBe(false);
    expect(res.runId).toBeNull();
    expect(res.motivoNoCorrio).toBe(`cuenta_inactiva: ${CUENTA_INACTIVA}`);
    expect(mockMetricas).not.toHaveBeenCalled();
    expect(mockEnviar).not.toHaveBeenCalled();

    // Sin fila en ad_rule_runs: abrir una Corrida gastaría cupo de
    // max_runs_per_day por un error de configuración.
    const runs = await q1<{ n: string }>(
      `SELECT count(*)::int AS n FROM ad_rule_runs WHERE rule_name = $1`,
      [r.regla.name],
    );
    expect(Number(runs!.n)).toBe(0);

    // El motivo queda en last_run_error para que la pantalla lo muestre.
    const filaRegla = await q1<{ last_run_error: string | null }>(
      `SELECT last_run_error FROM ad_rules WHERE id = $1`,
      [r.regla.id],
    );
    expect(filaRegla?.last_run_error).toContain(CUENTA_INACTIVA);
  });

  it('una Corrida sobre 500 filas de métricas resuelve la zona UNA sola vez', async (ctx) => {
    if (!(await requiereEsquema021(ctx))) return;
    await q(`UPDATE settings SET value = 'true'::jsonb WHERE key = 'ads_rules_enabled'`);
    // Condición imposible: nadie cumple, no se escriben filas de ad_actions y el
    // test mide sólo el conteo de resoluciones de zona.
    const r = await crearRegla(true, 'pause', [{ metric: 'spend', op: '>', value: 999_999 }]);
    const filas = Array.from({ length: 500 }, (_, i) =>
      filaTest({ objectId: `${PREFIJO}obj500-${i}`, spendEur: 1 }),
    );
    mockMetricas.mockResolvedValue(resultadoMetricas(filas));

    const spy = vi.spyOn(repo, 'zonaDeCuenta');
    const res = await correrRegla(r, { ahora: new Date('2026-08-12T12:00:00Z') });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(CUENTA_ACTIVA);
    expect(res.objetosEvaluados).toBe(500);
    spy.mockRestore();
  });

  it('Property 3: toda Corrida pide métricas de exactamente una cuenta y no puede cerrar por zonas mezcladas', async (ctx) => {
    if (!(await requiereEsquema021(ctx))) return;
    await q(`UPDATE settings SET value = 'true'::jsonb WHERE key = 'ads_rules_enabled'`);
    await q(`UPDATE settings SET value = 'true'::jsonb WHERE key = 'ads_rules_force_dry_run'`);

    // Feature: reglas-anuncios-por-cuenta, Property 3: Toda Corrida pide métricas
    // de exactamente una cuenta y no puede cerrar por zonas mezcladas
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(
          genRegla(),
          fc.array(genMetricasObjeto(), { minLength: 0, maxLength: 30 }),
        ),
        async ([base, filasBase]) => {
          // La cuenta que la Regla alcanza es la cuenta activa sembrada: el FK de
          // ad_rules exige que exista en ad_accounts, y la siembra por iteración
          // de una cuenta al azar pesaría el doble.
          const accountId = CUENTA_ACTIVA;
          const filas = filasBase.map((f) => ({ ...f, accountId }));

          // Frenos sin efecto y siempre prendida y en sombra: lo que varía de
          // forma interesante es el alcance y las filas.
          const regla = {
            ...base,
            name: `${PREFIJO}p3-${base.name.slice(0, 150)}`,
            accountId,
            enabled: true,
            dryRun: true,
            windowStart: null,
            windowEnd: null,
            everyMinutes: 1,
            maxRunsPerDay: null,
            cooldownMinutes: 0,
            // `max_actions_per_object_per_day` es smallint: 100_000 desborda el
            // tipo y el INSERT corta con «out of range for type smallint» antes
            // de correr la Regla. 1000 es igual de inocuo (el lote son 0..30
            // objetos y cada uno recibe a lo sumo una acción) y entra en el tipo.
            maxActionsPerObjectPerDay: 1000,
          };

          const r = await q1<{ id: number }>(
            `INSERT INTO ad_rules
               (name, enabled, dry_run, account_id, level, status_filter, name_filter,
                name_filter_mode, action, action_value, action_unit, budget_max, budget_min,
                period, every_minutes, cooldown_minutes, max_actions_per_object_per_day)
             VALUES ($1, true, true, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0, $14)
             RETURNING id`,
            [
              regla.name,
              regla.accountId,
              regla.level,
              regla.statusFilter,
              regla.nameFilter,
              regla.nameFilterMode,
              regla.action,
              regla.actionValue,
              regla.actionUnit,
              regla.budgetMax,
              regla.budgetMin,
              regla.period,
              regla.everyMinutes,
              regla.maxActionsPerObjectPerDay,
            ],
          );
          const ruleId = r!.id;
          let runId: number | null = null;

          try {
            mockMetricas.mockResolvedValue(resultadoMetricas(filas));
            const res = await correrRegla(
              { regla: { ...regla, id: ruleId }, condiciones: [] },
              { ahora: new Date('2026-08-12T12:00:00Z') },
            );
            runId = res.runId;

            // 1. El alcance pedido al Lector es EXACTAMENTE una cuenta, la de la Regla.
            const llamada = mockMetricas.mock.calls.at(-1)![0];
            expect(llamada.accountIds).toEqual([accountId]);

            // 2. La Corrida cierra sin error: el bug de las zonas mezcladas no puede volver.
            expect(res.error).toBeNull();

            // 3. objetos_evaluados = filas que sobreviven los filtros de la Regla.
            const sobreviven = filas.filter((f) => {
              if (!regla.nameFilter) return true;
              const q = regla.nameFilter.toLowerCase();
              const nombre = (f.objectName ?? '').toLowerCase();
              return regla.nameFilterMode === 'not_contains' ? !nombre.includes(q) : nombre.includes(q);
            });
            expect(res.objetosEvaluados).toBe(sobreviven.length);

            // 4. Toda fila de ad_actions con el account_id de la fila de métricas
            //    que la originó (no el de la Regla: hoy coinciden, mañana pueden no).
            const acciones = await q<{ account_id: string }>(
              `SELECT account_id FROM ad_actions WHERE run_id = $1`,
              [res.runId],
            );
            for (const a of acciones) {
              expect(a.account_id).toBe(accountId);
            }

            // 5. Cero filas nuevas con skipped_reason = 'zonas_horarias_mezcladas'.
            const mezcladas = await q1<{ n: string }>(
              `SELECT count(*)::int AS n FROM ad_actions
                WHERE run_id = $1 AND skipped_reason = 'zonas_horarias_mezcladas'`,
              [res.runId],
            );
            expect(Number(mezcladas!.n)).toBe(0);
          } finally {
            // Limpieza por iteración, para entrar en el testTimeout de 30 s.
            if (runId !== null) {
              await q(`DELETE FROM ad_actions WHERE run_id = $1`, [runId]);
              await q(`DELETE FROM ad_rule_runs WHERE id = $1`, [runId]);
            }
            await q(`DELETE FROM ad_rules WHERE id = $1`, [ruleId]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});