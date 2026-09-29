import { describe, expect, it } from 'vitest';
import { celdasMes, etiquetaRango, largoRango, ordenar } from './rango-fechas';

describe('celdasMes', () => {
  it('arranca en lunes: septiembre 2026 empieza martes, un hueco', () => {
    const c = celdasMes(2026, 8);
    expect(c[0]).toBeNull();
    expect(c[1]).toBe('2026-09-01');
    expect(c.filter(Boolean)).toHaveLength(30);
  });

  it('febrero de año bisiesto tiene 29', () => {
    expect(celdasMes(2028, 1).filter(Boolean)).toHaveLength(29);
  });
});

describe('largoRango', () => {
  it('cuenta las dos puntas y cruza meses', () => {
    expect(largoRango('2026-09-29', '2026-09-29')).toBe(1);
    expect(largoRango('2026-08-30', '2026-09-02')).toBe(4);
  });
});

describe('ordenar', () => {
  it('pone primero la fecha más vieja', () => {
    expect(ordenar('2026-09-20', '2026-09-01')).toEqual(['2026-09-01', '2026-09-20']);
  });
});

describe('etiquetaRango', () => {
  it('sin año cuando es el año en curso', () => {
    expect(etiquetaRango('2026-09-12', '2026-09-28', '2026-09-29')).toBe('12 sep – 28 sep');
  });

  it('con año corto si alguna punta es de otro año', () => {
    expect(etiquetaRango('2025-12-20', '2026-01-05', '2026-09-29')).toBe('20 dic 25 – 5 ene 26');
  });

  it('un solo día se muestra solo', () => {
    expect(etiquetaRango('2026-09-03', '2026-09-03', '2026-09-29')).toBe('3 sep');
  });
});
