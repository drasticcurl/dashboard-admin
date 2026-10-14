import { describe, expect, it } from 'vitest';
import { armarAvisoProfit, armarAvisoVenta, formatearMonto, formatearPrecio, tramoDe, type DatosAviso } from './mensajes';

const base: DatosAviso = {
  resultado: 0,
  neto: 0,
  gasto: 0,
  ventas: 0,
  roi: null,
  simbolo: '€',
  cierre: false,
};

describe('tramoDe', () => {
  it('sin ventas ni gasto es sin_movimiento', () => {
    expect(tramoDe(base)).toBe('sin_movimiento');
  });
  it('centavos arriba o abajo es empate', () => {
    expect(tramoDe({ ...base, resultado: 3, gasto: 100, ventas: 2, roi: 1.03 })).toBe('empate');
  });
  it('decide por ROI y no por el monto', () => {
    expect(tramoDe({ ...base, resultado: 200, gasto: 100, ventas: 5, roi: 3 })).toBe('fuego');
    expect(tramoDe({ ...base, resultado: 200, gasto: 1000, ventas: 5, roi: 1.2 })).toBe('ganancia');
    expect(tramoDe({ ...base, resultado: -200, gasto: 1000, ventas: 5, roi: 0.8 })).toBe('perdida');
    expect(tramoDe({ ...base, resultado: -200, gasto: 300, ventas: 1, roi: 0.33 })).toBe('catastrofe');
  });
  it('sin gasto decide por el signo', () => {
    expect(tramoDe({ ...base, resultado: 80, ventas: 2 })).toBe('ganancia');
  });
});

describe('armarAvisoProfit', () => {
  it('el número va en el título, con signo', () => {
    const a = armarAvisoProfit({ ...base, resultado: 1234.4, neto: 1734.4, gasto: 500, ventas: 30, roi: 3.47 }, 'x');
    expect(a.titulo).toBe('🟢 Hoy vamos +€1.234');
    expect(a.cuerpo).toContain('30 ventas · gasto €500 · ROI 3.47×');
  });
  it('una pérdida lleva el menos y el rojo', () => {
    const a = armarAvisoProfit({ ...base, resultado: -90, neto: 10, gasto: 100, ventas: 1, roi: 0.1 }, 'x');
    expect(a.titulo).toBe('🔴 Hoy vamos −€90');
    expect(a.cuerpo).toContain('1 venta ·');
  });
  it('el de medianoche habla de ayer', () => {
    const a = armarAvisoProfit({ ...base, resultado: 50, neto: 150, gasto: 100, ventas: 3, roi: 1.5, cierre: true }, 'x');
    expect(a.titulo).toBe('🟢 Cierre de ayer +€50');
  });
  it('la frase rota con la semilla y es estable', () => {
    const d = { ...base, resultado: 500, neto: 600, gasto: 100, ventas: 9, roi: 6 };
    const frases = new Set(['06', '10', '14', '18', '22'].map((h) => armarAvisoProfit(d, `2026-10-01T${h}`).cuerpo));
    expect(frases.size).toBeGreaterThan(1);
    expect(armarAvisoProfit(d, 's').cuerpo).toBe(armarAvisoProfit(d, 's').cuerpo);
  });
});

describe('formatearMonto', () => {
  it('cero va sin signo', () => {
    expect(formatearMonto(0, 'US$')).toBe('US$0');
  });
});

describe('armarAvisoVenta', () => {
  const venta = { tier: 'front', amount: 39990, currency: 'ARS', numero: '9005', funnel: 'Chau Hinchazón' };

  it('front: venta aprobada con funnel en el título', () => {
    expect(armarAvisoVenta(venta)).toEqual({
      titulo: '💰 ¡Venta aprobada! | Chau Hinchazón',
      cuerpo: 'Valor: $ 39.990 · #9005',
      tipo: 'front',
    });
  });
  it('upsell y upsell2 son post-compra', () => {
    expect(armarAvisoVenta({ ...venta, tier: 'upsell', amount: 15990 })).toEqual({
      titulo: '➕ Upsell aceptado #9005',
      cuerpo: '$ 15.990 (post-compra) · Chau Hinchazón',
      tipo: 'post',
    });
    expect(armarAvisoVenta({ ...venta, tier: 'upsell2' })).toMatchObject({
      titulo: '➕ Upsell 2 aceptado #9005',
      tipo: 'post',
    });
    expect(armarAvisoVenta({ ...venta, tier: 'downsell' }).tipo).toBe('post');
  });
  it('checkout propio no tiene número y una venta sin funnel lo dice', () => {
    expect(armarAvisoVenta({ ...venta, numero: null, funnel: null })).toEqual({
      titulo: '💰 ¡Venta aprobada! | sin atribuir',
      cuerpo: 'Valor: $ 39.990',
      tipo: 'front',
    });
  });
  it('front con order bump lo dice en el título y desglosa el monto', () => {
    expect(armarAvisoVenta({ ...venta, amount: 47780, bump: 7790 })).toEqual({
      titulo: '💰 ¡Venta aprobada + bump! | Chau Hinchazón',
      cuerpo: 'Valor: $ 47.780 (bump $ 7.790) · #9005',
      tipo: 'front',
    });
  });
  it('formatea centavos solo si los hay y monedas sin símbolo conocido', () => {
    expect(formatearPrecio(69.82, 'USD')).toBe('US$ 69,82');
    expect(formatearPrecio(100, 'CLP')).toBe('100 CLP');
  });
});
