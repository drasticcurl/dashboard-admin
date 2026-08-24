/**
 * Tests del parseo de montos de Finanzas.
 *
 * El caso que originó el archivo está en el primer bloque: "100,50" tenía que
 * dar 100.5 (antes daba NaN y dejaba el botón gris) y "1.000" NO puede dar 1
 * en silencio (antes guardaba un euro donde el usuario quiso mil).
 */
import { describe, expect, it } from 'vitest';
import { formatearMontoParaInput, parsearMonto } from './monto';

function valor(raw: string): number | string {
  const r = parsearMonto(raw);
  return r.ok ? r.valor : `ERROR: ${r.error}`;
}

describe('parsearMonto', () => {
  it('la coma decimal del español funciona (el bug del botón que nunca se habilitaba)', () => {
    expect(valor('100,50')).toBe(100.5);
    expect(valor('0,99')).toBe(0.99);
    expect(valor('1234,5')).toBe(1234.5);
    expect(valor('1.234,56')).toBe(1234.56);
    expect(valor('1.500,00')).toBe(1500);
  });

  it('el punto decimal también, cuando no es ambiguo', () => {
    expect(valor('100.50')).toBe(100.5);
    expect(valor('100.5')).toBe(100.5);
    expect(valor('0.99')).toBe(0.99);
  });

  it('los enteros pelados', () => {
    expect(valor('100')).toBe(100);
    expect(valor('1')).toBe(1);
    expect(valor('999999')).toBe(999999);
  });

  it('agrupación de miles, en los dos estilos', () => {
    expect(valor('1.000.000')).toBe(1000000);
    expect(valor('1,000,000')).toBe(1000000);
    expect(valor('1,234.56')).toBe(1234.56);
    expect(valor('12.345.678,90')).toBe(12345678.9);
  });

  it('"1.000" se RECHAZA en vez de guardar 1 en silencio', () => {
    const r = parsearMonto('1.000');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('1000');
      expect(r.error).toContain('dos formas');
    }
    // Los otros que caían en la misma trampa.
    expect(parsearMonto('2.500').ok).toBe(false);
    expect(parsearMonto('10.000').ok).toBe(false);
  });

  it('limpia el ruido de un copy-paste', () => {
    expect(valor(' 100,50 ')).toBe(100.5);
    expect(valor('€100,50')).toBe(100.5);
    expect(valor('1 234,56')).toBe(1234.56);
    expect(valor('1\u00a0234,56')).toBe(1234.56);
  });

  it('rechaza con un mensaje, nunca con NaN ni con un botón gris', () => {
    for (const malo of ['', '   ', 'abc', '10a', '-50', '0', '0,00', '1,2,3', '1.00.000', '100,555']) {
      const r = parsearMonto(malo);
      expect(r.ok, `"${malo}" debería fallar`).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
  });

  it('el signo menos se rechaza explicando de quién es el signo', () => {
    const r = parsearMonto('-100');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('signo');
  });

  it('más de 2 decimales se rechaza (numeric(14,2) redondearía sin avisar)', () => {
    const r = parsearMonto('10,999');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('2 decimales');
  });

  it('el techo de numeric(14,2)', () => {
    expect(parsearMonto('999999999999,99').ok).toBe(true);
    expect(parsearMonto('1000000000000').ok).toBe(false);
  });

  it('lo que devuelve ya está redondeado a 2 decimales', () => {
    const r = parsearMonto('0,07');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.valor).toBe(0.07);
  });
});

describe('formatearMontoParaInput', () => {
  it('vuelve al input con coma y en positivo, y parsearMonto lo acepta de nuevo', () => {
    expect(formatearMontoParaInput(-500)).toBe('500');
    expect(formatearMontoParaInput(-29.99)).toBe('29,99');
    expect(formatearMontoParaInput(100.5)).toBe('100,50');

    // La ida y vuelta no puede perder plata: es lo que pasa al editar un
    // movimiento y volver a guardarlo sin tocar el monto.
    for (const n of [-1, -29.99, -500, -1234.56, 0.07, -1000]) {
      const round = parsearMonto(formatearMontoParaInput(n));
      expect(round.ok, `${n} no sobrevivió la ida y vuelta`).toBe(true);
      if (round.ok) expect(round.valor).toBe(Math.abs(n));
    }
  });
});
