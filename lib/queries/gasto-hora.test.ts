import { describe, expect, it } from 'vitest';
import { repartirGastoDelDia } from './gasto-hora';

const H = 3_600_000;
const inicio = Date.UTC(2026, 8, 29, 3); // 00:00 en Buenos Aires
const at = (h: number, m = 0): number => inicio + h * H + m * 60_000;
const suma = (xs: number[]): number => xs.reduce((a, v) => a + v, 0);

describe('repartirGastoDelDia', () => {
  it('sin lecturas reparte parejo en el día cerrado', () => {
    const horas = repartirGastoDelDia({ inicioMs: inicio, ahoraMs: at(30), total: 24, lecturas: [] });
    expect(horas.every((v) => Math.abs(v - 1) < 1e-9)).toBe(true);
  });

  it('sin lecturas, hoy reparte sólo entre las horas que pasaron', () => {
    const horas = repartirGastoDelDia({ inicioMs: inicio, ahoraMs: at(10), total: 10, lecturas: [] });
    expect(horas[9]).toBeCloseTo(1);
    expect(horas[10]).toBe(0);
    expect(suma(horas)).toBeCloseTo(10);
  });

  it('reparte el gasto entre dos lecturas en proporción al tiempo', () => {
    // 13:30 → 14:30 se gastaron 60: 30 a las 13, 30 a las 14.
    const horas = repartirGastoDelDia({
      inicioMs: inicio,
      ahoraMs: at(14, 30),
      total: 60,
      lecturas: [
        { t: at(13, 30), acum: 0 },
        { t: at(14, 30), acum: 60 },
      ],
    });
    expect(horas[13]).toBeCloseTo(30);
    expect(horas[14]).toBeCloseTo(30);
    expect(suma(horas)).toBeCloseTo(60);
  });

  it('lo acumulado antes de la primera lectura se reparte desde las 00', () => {
    const horas = repartirGastoDelDia({
      inicioMs: inicio,
      ahoraMs: at(12),
      total: 12,
      lecturas: [{ t: at(12), acum: 12 }],
    });
    expect(horas[0]).toBeCloseTo(1);
    expect(horas[11]).toBeCloseTo(1);
    expect(suma(horas)).toBeCloseTo(12);
  });

  it('una corrección posterior a la última lectura cierra el total del día', () => {
    const horas = repartirGastoDelDia({
      inicioMs: inicio,
      ahoraMs: at(40),
      total: 30,
      lecturas: [{ t: at(22), acum: 22 }],
    });
    expect(horas[22]).toBeCloseTo(4);
    expect(horas[23]).toBeCloseTo(4);
    expect(suma(horas)).toBeCloseTo(30);
  });
});
