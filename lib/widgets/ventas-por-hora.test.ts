import { describe, expect, it } from 'vitest';
import type { HourPoint } from '@/lib/queries/overview';
import { horaEnCurso, horaPico, mejorFranja } from './ventas-por-hora';

/** Las 24 horas con los importes dados por hora (lo que no está va en 0). */
function dia(importes: Record<number, number>): HourPoint[] {
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    orders: importes[hour] ? 1 : 0,
    grossEur: importes[hour] ?? 0,
    perFunnel: {},
    prevOrders: null,
    prevGrossEur: null,
  }));
}

describe('horaPico', () => {
  it('devuelve la hora con más importe', () => {
    expect(horaPico(dia({ 9: 10, 21: 50, 22: 30 }), 'importe')).toBe(21);
  });

  it('sin ventas no hay pico', () => {
    expect(horaPico(dia({}), 'importe')).toBeNull();
  });
});

describe('mejorFranja', () => {
  it('encuentra las 3 horas seguidas que más venden y su parte del total', () => {
    const f = mejorFranja(dia({ 2: 10, 20: 30, 21: 30, 22: 30 }), 'importe');
    expect(f).toEqual({ desde: 20, hasta: 23, parte: 0.9 });
  });

  it('da la vuelta por la medianoche', () => {
    const f = mejorFranja(dia({ 23: 40, 0: 40, 1: 20, 12: 10 }), 'importe');
    expect(f?.desde).toBe(23);
    expect(f?.hasta).toBe(2);
  });

  it('sin ventas no hay franja', () => {
    expect(mejorFranja(dia({}), 'importe')).toBeNull();
  });
});

describe('horaEnCurso', () => {
  it('marca la hora sólo si el rango termina hoy', () => {
    expect(horaEnCurso('2026-09-29', { day: '2026-09-29', hour: 14 })).toBe(14);
    expect(horaEnCurso('2026-09-28', { day: '2026-09-29', hour: 14 })).toBeNull();
  });
});
