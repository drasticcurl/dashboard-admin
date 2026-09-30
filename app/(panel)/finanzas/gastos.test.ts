import { describe, expect, it } from 'vitest';
import type { FinanceMovement } from '@/lib/queries/finance';
import { gastosPorCategoria, mesAnterior } from './gastos';

let id = 0;
function mov(p: Partial<FinanceMovement> & Pick<FinanceMovement, 'kind' | 'amountEur' | 'day'>): FinanceMovement {
  return {
    id: ++id,
    category: null,
    note: '',
    scheduledPaymentId: null,
    createdAt: '',
    updatedAt: '',
    ...p,
  };
}

describe('mesAnterior', () => {
  it('cruza el año en enero', () => {
    expect(mesAnterior('2026-01')).toBe('2025-12');
    expect(mesAnterior('2026-10')).toBe('2026-09');
  });
});

describe('gastosPorCategoria', () => {
  const movs = [
    mov({ kind: 'gasto', category: 'sueldos', amountEur: -1000, day: '2026-09-05' }),
    mov({ kind: 'gasto', category: 'sueldos', amountEur: -500, day: '2026-09-20' }),
    mov({ kind: 'gasto', category: 'alquiler', amountEur: -500, day: '2026-09-01' }),
    mov({ kind: 'gasto', category: 'herramientas', amountEur: -300, day: '2026-08-15' }),
    mov({ kind: 'retiro', category: null, amountEur: -9000, day: '2026-09-10' }),
    mov({ kind: 'aporte', category: null, amountEur: 2000, day: '2026-09-10' }),
  ];

  it('suma sólo gastos del mes, en positivo y de mayor a menor', () => {
    const r = gastosPorCategoria(movs, 'mes', '2026-09-30');
    expect(r).toEqual([
      { categoria: 'sueldos', totalEur: 1500, share: 0.75 },
      { categoria: 'alquiler', totalEur: 500, share: 0.25 },
    ]);
  });

  it('el mes pasado y todo el historial', () => {
    expect(gastosPorCategoria(movs, 'mesPasado', '2026-09-30').map((p) => p.categoria)).toEqual([
      'herramientas',
    ]);
    const todo = gastosPorCategoria(movs, 'todo', '2026-09-30');
    expect(todo.reduce((a, p) => a + p.totalEur, 0)).toBe(2300);
  });

  it('sin gastos devuelve vacío, no porciones en 0', () => {
    expect(gastosPorCategoria(movs, 'mes', '2026-11-02')).toEqual([]);
  });
});
