import { describe, expect, it } from 'vitest';
import {
  anularPresupuestoEnCBO,
  filtrarHuerfanos,
  inferirBudgetLevel,
  normalizarPresupuestos,
} from './jerarquia';
import type { MetaAdSet } from './tipos';

/**
 * Tests de las funciones puras del sync de jerarquía, sin red y sin base.
 * La lógica que toca la base (el upsert por UNNEST) se verifica corriendo
 * `npm run ads:jerarquia` contra las cuentas reales (§8 del task).
 */

function adset(parcial: Partial<MetaAdSet> & { adsetId: string; campaignId: string }): MetaAdSet {
  return {
    name: null,
    status: null,
    effectiveStatus: null,
    dailyBudget: null,
    lifetimeBudget: null,
    optimizationGoal: null,
    billingEvent: null,
    bidStrategy: null,
    createdTime: null,
    startTime: null,
    endTime: null,
    ...parcial,
  };
}

describe('inferirBudgetLevel', () => {
  it('daily_budget con valor → campaign', () => {
    expect(inferirBudgetLevel(2500, null)).toBe('campaign');
  });

  it('lifetime_budget con valor → campaign', () => {
    expect(inferirBudgetLevel(null, 50000)).toBe('campaign');
  });

  it('los dos en null → adset', () => {
    expect(inferirBudgetLevel(null, null)).toBe('adset');
  });

  it('daily_budget: 0 es un valor, no la ausencia de uno → campaign', () => {
    expect(inferirBudgetLevel(0, null)).toBe('campaign');
  });
});

describe('filtrarHuerfanos', () => {
  it('descarta y cuenta el que no tiene padre, el resto pasa', () => {
    const { validos, huerfanos } = filtrarHuerfanos(
      [
        { id: 's1', campaignId: 'c1' },
        { id: 's2', campaignId: 'cX' },
        { id: 's3', campaignId: 'c1' },
      ],
      new Set(['c1']),
      (o) => o.campaignId,
    );
    expect(validos.map((o) => o.id)).toEqual(['s1', 's3']);
    expect(huerfanos).toBe(1);
  });

  it('con el set vacío, todos son huérfanos y no tira', () => {
    const { validos, huerfanos } = filtrarHuerfanos(
      [{ id: 's1', campaignId: 'c1' }],
      new Set<string>(),
      (o) => o.campaignId,
    );
    expect(validos).toEqual([]);
    expect(huerfanos).toBe(1);
  });
});

describe('normalizarPresupuestos', () => {
  it('0 es el centinela de Meta → null, y un valor positivo se conserva', () => {
    expect(normalizarPresupuestos(2500, 0)).toEqual({ dailyBudget: 2500, lifetimeBudget: null });
    expect(normalizarPresupuestos(0, 50000)).toEqual({ dailyBudget: null, lifetimeBudget: 50000 });
  });

  it('null y los valores positivos pasan tal cual', () => {
    expect(normalizarPresupuestos(2500, null)).toEqual({ dailyBudget: 2500, lifetimeBudget: null });
    expect(normalizarPresupuestos(0, 0)).toEqual({ dailyBudget: null, lifetimeBudget: null });
    expect(normalizarPresupuestos(null, null)).toEqual({ dailyBudget: null, lifetimeBudget: null });
  });
});

describe('anularPresupuestoEnCBO', () => {
  it('anula el presupuesto heredado de un conjunto en campaña CBO, y no toca el de un ABO', () => {
    const conjuntos = [
      adset({ adsetId: 's1', campaignId: 'cCBO', dailyBudget: 1000 }),
      adset({ adsetId: 's2', campaignId: 'cABO', dailyBudget: 2000, lifetimeBudget: 999 }),
    ];
    const out = anularPresupuestoEnCBO(conjuntos, new Set(['cCBO']));
    expect(out[0]).toMatchObject({ adsetId: 's1', dailyBudget: null, lifetimeBudget: null });
    expect(out[1]).toMatchObject({ adsetId: 's2', dailyBudget: 2000, lifetimeBudget: 999 });
  });

  it('sin campañas CBO, todos los conjuntos conservan su presupuesto', () => {
    const conjuntos = [adset({ adsetId: 's1', campaignId: 'c1', dailyBudget: 1500 })];
    const out = anularPresupuestoEnCBO(conjuntos, new Set<string>());
    expect(out[0].dailyBudget).toBe(1500);
  });
});
