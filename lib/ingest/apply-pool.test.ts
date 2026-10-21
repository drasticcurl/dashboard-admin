import { describe, expect, it, vi } from 'vitest';
import type { Funnel } from '../funnels';
import type { IngestPayload } from '../types';
import { applyBatch } from './apply';

/**
 * Sin base, a propósito: lo que se prueba es una regla de estructura. Mientras
 * un lote tiene su transacción abierta no puede pedirle otra conexión al pool,
 * porque con 10 lotes a la vez el pool entero queda trabado (registro.md,
 * 2026-10-21 (2)). El pool simulado anota cada consulta que le llega con una
 * transacción abierta; la integración contra Postgres sigue en apply.test.ts.
 */
const estado = vi.hoisted(() => ({ enTx: false, alPoolConTxAbierta: [] as string[] }));

vi.mock('../db', () => ({
  q: vi.fn(async (sql: string) => {
    if (estado.enTx) estado.alPoolConTxAbierta.push(sql);
    return [{ stepIndex: 1, slug: 'p1', label: 'P1', kind: 'question', countsInFunnel: true }];
  }),
  q1: vi.fn(async () => null),
  tx: vi.fn(async (fn: (c: unknown) => Promise<unknown>) => {
    estado.enTx = true;
    try {
      return await fn({ query: async () => ({ rows: [{ day: '2026-10-21' }], rowCount: 1 }) });
    } finally {
      estado.enTx = false;
    }
  }),
}));

const funnel: Funnel = {
  id: 5,
  slug: 'almagemela',
  name: 'Alma Gemela',
  alias: null,
  timezone: 'Europe/Lisbon',
  sellCurrency: 'ARS',
  variants: ['default'],
  experiments: [],
  color: '#000000',
  active: true,
};

const lote = (): IngestPayload => ({
  sessionId: '00000000-0000-4000-8000-000000000001',
  visitorId: '00000000-0000-4000-8000-000000000002',
  events: [
    { name: 'step_view', at: '2026-10-20T23:34:00.000Z', stepIndex: 1, stepSlug: 'p1' },
    { name: 'step_view', at: '2026-10-20T23:34:05.000Z', stepIndex: 7, stepSlug: 'p7' },
  ],
});

describe('applyBatch y el pool', () => {
  it('no le pide conexiones al pool con la transacción abierta', async () => {
    estado.alPoolConTxAbierta = [];
    const r = await applyBatch(funnel, lote());
    expect(r.accepted).toBe(2);
    expect(estado.alPoolConTxAbierta).toEqual([]);
  });

  it('el catálogo leído antes de la transacción sigue avisando los pasos que no existen', async () => {
    const r = await applyBatch(funnel, lote());
    expect(r.warnings).toContain('unknown_step:7');
    expect(r.warnings.some((w) => w.startsWith('step_slug_mismatch'))).toBe(false);
  });
});
