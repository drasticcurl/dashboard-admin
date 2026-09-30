import { describe, expect, it } from 'vitest';
import { repartirGastoDelDia, tramosGastoDelDia, volcarEnHoras } from './gasto-hora';

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

describe('día de Meta en otra zona que el panel (cuenta en Lisboa, panel en Buenos Aires)', () => {
  // El día de Meta del 29/09 en Lisboa (UTC+1) va de las 20:00 del 28 a las
  // 20:00 del 29 en Buenos Aires. El panel mira el 29 de 00:00 a 24:00.
  const inicioMeta = inicio - 4 * H;
  const finMeta = inicioMeta + 24 * H;

  it('el gasto de anoche (20:00–00:00) NO se aplasta en la hora 00 de hoy', () => {
    // Lecturas cada hora a los :07, 1 por hora de Meta: 24 de gasto parejo.
    const lecturas = Array.from({ length: 24 }, (_, k) => ({ t: inicioMeta + (k + 1) * H, acum: k + 1 }));
    const tramos = tramosGastoDelDia({ inicioMs: inicioMeta, finMs: finMeta, ahoraMs: at(40), total: 24, lecturas });
    const horas = Array.from({ length: 24 }, () => 0);
    volcarEnHoras(tramos, inicio, inicio + 24 * H, horas);
    // Bug viejo: horas[0] daba 5 (las 4 horas de anoche + la propia).
    expect(horas[0]).toBeCloseTo(1);
    expect(horas[19]).toBeCloseTo(1);
    // De las 20 en adelante es el día SIGUIENTE de Meta: no es de este.
    expect(horas[20]).toBe(0);
    // Sólo 20 de las 24 horas de gasto cayeron en el día del panel.
    expect(suma(horas)).toBeCloseTo(20);
  });

  it('el día siguiente de Meta completa las 20–23 del panel', () => {
    const tramos = tramosGastoDelDia({
      inicioMs: finMeta,
      finMs: finMeta + 24 * H,
      ahoraMs: at(60),
      total: 24,
      lecturas: [],
    });
    const horas = Array.from({ length: 24 }, () => 0);
    volcarEnHoras(tramos, inicio, inicio + 24 * H, horas);
    expect(horas[20]).toBeCloseTo(1);
    expect(horas[23]).toBeCloseTo(1);
    expect(horas[0]).toBe(0);
    expect(suma(horas)).toBeCloseTo(4);
  });

  it('una corrección sobre un día cerrado queda dentro del día, no en el siguiente', () => {
    const tramos = tramosGastoDelDia({
      inicioMs: inicio,
      finMs: inicio + 24 * H,
      ahoraMs: at(40),
      total: 30,
      lecturas: [{ t: at(24), acum: 24 }],
    });
    const horas = Array.from({ length: 24 }, () => 0);
    volcarEnHoras(tramos, inicio, inicio + 24 * H, horas);
    expect(suma(horas)).toBeCloseTo(30);
  });
});
