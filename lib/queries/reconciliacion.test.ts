/**
 * Tests de `calcularHueco` — la aritmética de la reconciliación mensual.
 *
 * Todo PURO: sin base, sin `skipIf`. La función se extrajo justamente para que
 * la parte que puede estar mal (los signos y la propagación de null) se pueda
 * verificar sin datos reales.
 *
 * Los dos casos que justifican el archivo:
 *
 *  · `gananciaMedidaEur: null` tiene que dar `huecoEur: null`, NO 0. Un mes sin
 *    cierre completo no es un mes que cerró perfecto, y si el hueco saliera 0 la
 *    pantalla diría "todo cuadra" sobre un mes que nadie cargó.
 *  · Los gastos entran NEGATIVOS (así los guarda la base, lo garantiza un CHECK)
 *    y el esperado los RESTA. Si el signo se manejara mal, un mes con 900 de
 *    gastos daría un esperado 1800 más alto y el hueco sería exactamente el
 *    doble de los gastos — un error que "se ve razonable" en pantalla.
 */

import { describe, expect, it } from 'vitest';
import { calcularHueco } from './reconciliacion';

describe('calcularHueco', () => {
  it('un mes que cierra exacto da hueco 0', () => {
    // neto 5000 − ads 1000 = 4000 operativo; menos 900 de gastos = 3100
    // esperado. El patrimonio medido subió exactamente 3100.
    const r = calcularHueco({
      gananciaMedidaEur: 3100,
      netoEur: 5000,
      adsEur: 1000,
      gastosSignedEur: -900,
    });

    expect(r.resultadoOperativoEur).toBe(4000);
    expect(r.gastosEur).toBe(900);
    expect(r.esperadoEur).toBe(3100);
    expect(r.huecoEur).toBe(0);
    expect(r.huecoPct).toBe(0);
  });

  it('resta los gastos en vez de sumarlos: entran negativos y salen como magnitud', () => {
    // El bug que este test bloquea: si el signo se propagara sin Math.abs, el
    // esperado sería 4000 − (−900) = 4900 y el hueco daría −1800 (el doble de
    // los gastos) en un mes que en realidad cuadra.
    const r = calcularHueco({
      gananciaMedidaEur: 3100,
      netoEur: 5000,
      adsEur: 1000,
      gastosSignedEur: -900,
    });

    expect(r.gastosEur).toBe(900);
    expect(r.esperadoEur).toBe(3100);
    expect(r.huecoEur).not.toBe(-1800);
  });

  it('sin medición el hueco es null, nunca 0', () => {
    const r = calcularHueco({
      gananciaMedidaEur: null,
      netoEur: 5000,
      adsEur: 1000,
      gastosSignedEur: -900,
    });

    // El lado operativo SÍ se calcula: no depende de que haya saldos cargados.
    expect(r.resultadoOperativoEur).toBe(4000);
    expect(r.esperadoEur).toBe(3100);
    // Y la comparación no existe.
    expect(r.huecoEur).toBeNull();
    expect(r.huecoPct).toBeNull();
  });

  it('un hueco positivo es patrimonio que subió más de lo explicable', () => {
    // Midió 4000 y sólo 3100 tienen explicación: 900 entraron de algún lado que
    // el panel no registró (una venta que no llegó por el webhook, típicamente).
    const r = calcularHueco({
      gananciaMedidaEur: 4000,
      netoEur: 5000,
      adsEur: 1000,
      gastosSignedEur: -900,
    });

    expect(r.huecoEur).toBe(900);
    expect(r.huecoPct).toBeCloseTo(900 / 3100, 10);
  });

  it('un hueco negativo es plata que salió sin registrarse', () => {
    const r = calcularHueco({
      gananciaMedidaEur: 2000,
      netoEur: 5000,
      adsEur: 1000,
      gastosSignedEur: -900,
    });

    expect(r.huecoEur).toBe(-1100);
    expect(r.huecoPct).toBeCloseTo(-1100 / 3100, 10);
  });

  it('con esperado 0 el hueco existe y el porcentaje es null', () => {
    // No se divide por cero y no se devuelve Infinity, que en JSON sale como
    // null igual pero después de haber pasado por un NaN en la UI.
    const r = calcularHueco({
      gananciaMedidaEur: 500,
      netoEur: 900,
      adsEur: 0,
      gastosSignedEur: -900,
    });

    expect(r.esperadoEur).toBe(0);
    expect(r.huecoEur).toBe(500);
    expect(r.huecoPct).toBeNull();
  });

  it('con esperado negativo el porcentaje usa el valor absoluto', () => {
    // Un mes que perdió plata: esperado −1000, y midió −500, o sea que perdió
    // 500 MENOS de lo previsto. El hueco es +500 y el porcentaje tiene que ser
    // positivo. Dividiendo por −1000 saldría −0,5 y se leería al revés.
    const r = calcularHueco({
      gananciaMedidaEur: -500,
      netoEur: 200,
      adsEur: 700,
      gastosSignedEur: -500,
    });

    expect(r.esperadoEur).toBe(-1000);
    expect(r.huecoEur).toBe(500);
    expect(r.huecoPct).toBe(0.5);
  });

  it('redondea a dos decimales: la resta de floats no deja cola', () => {
    // El caso real: 4200,50 − 1100,30 en float da 3100,1999999999998, y el
    // hueco de un mes que cierra perfecto se mostraría como un número raro que
    // parece un bug de otra cosa.
    const r = calcularHueco({
      gananciaMedidaEur: 3100.2,
      netoEur: 4200.5,
      adsEur: 0,
      gastosSignedEur: -1100.3,
    });

    expect(r.esperadoEur).toBe(3100.2);
    expect(r.huecoEur).toBe(0);
  });

  it('un mes sin nada cargado da todo en cero sin romperse', () => {
    const r = calcularHueco({
      gananciaMedidaEur: 0,
      netoEur: 0,
      adsEur: 0,
      gastosSignedEur: 0,
    });

    expect(r.resultadoOperativoEur).toBe(0);
    expect(r.gastosEur).toBe(0);
    expect(r.esperadoEur).toBe(0);
    expect(r.huecoEur).toBe(0);
    // esperado 0 → sin denominador.
    expect(r.huecoPct).toBeNull();
  });
});
