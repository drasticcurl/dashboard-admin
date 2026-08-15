import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SIN_EXPERIMENTO, calcularTasasExperimento, type ExperimentoContadores } from './funnel';

/**
 * Desglose del experimento (spec ab-test-popup-descuento).
 *
 * Todo PURO: `calcularTasasExperimento` no toca la base, así que este archivo
 * no lleva skipIf ni schema-probe.
 */

function contador(experiment: string, over: Partial<ExperimentoContadores> = {}): ExperimentoContadores {
  return { experiment, sessions: 0, salesViews: 0, checkoutClicks: 0, purchases: 0, ...over };
}

// Tuplas válidas de contadores: el embudo es jerárquico (compras ⊆ clicks ⊆
// ventas ⊆ sesiones), y encadenando los rangos el generador cubre ceros en
// cualquier posición SIN filtrar.
const contadores = fc
  .integer({ min: 0, max: 1000 })
  .chain((sessions) =>
    fc
      .integer({ min: 0, max: sessions })
      .chain((salesViews) =>
        fc
          .integer({ min: 0, max: salesViews })
          .chain((checkoutClicks) =>
            fc
              .integer({ min: 0, max: checkoutClicks })
              .map((purchases) => ({ sessions, salesViews, checkoutClicks, purchases })),
          ),
      ),
  );

// Feature: ab-test-popup-descuento, Property 32: Las tasas derivadas son cocientes acotados y sin división por cero
describe('calcularTasasExperimento (pura)', () => {
  it('Property 32: para cualquier tupla de contadores las cuatro tasas son el cociente en %, quedan en [0, 100] y valen 0 con denominador 0', () => {
    fc.assert(
      fc.property(contadores, (c) => {
        const [fila] = calcularTasasExperimento([
          { experiment: 'A', sessions: c.sessions, salesViews: c.salesViews, checkoutClicks: c.checkoutClicks, purchases: c.purchases },
        ]);
        expect(fila!.pctSalesView).toBe(c.sessions === 0 ? 0 : (c.salesViews / c.sessions) * 100);
        expect(fila!.pctCheckoutClick).toBe(c.salesViews === 0 ? 0 : (c.checkoutClicks / c.salesViews) * 100);
        expect(fila!.pctPurchase).toBe(c.checkoutClicks === 0 ? 0 : (c.purchases / c.checkoutClicks) * 100);
        expect(fila!.pctSessionToPurchase).toBe(c.sessions === 0 ? 0 : (c.purchases / c.sessions) * 100);

        for (const tasa of [fila!.pctSalesView, fila!.pctCheckoutClick, fila!.pctPurchase, fila!.pctSessionToPurchase]) {
          expect(Number.isFinite(tasa)).toBe(true);
          expect(tasa).toBeGreaterThanOrEqual(0);
          expect(tasa).toBeLessThanOrEqual(100);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('ceros en todas las posiciones → las cuatro tasas en 0 exacto, nunca NaN ni Infinity', () => {
    const filas = calcularTasasExperimento([contador('A', { sessions: 0, salesViews: 0, checkoutClicks: 0, purchases: 0 })]);
    expect(filas[0]!.pctSalesView).toBe(0);
    expect(filas[0]!.pctCheckoutClick).toBe(0);
    expect(filas[0]!.pctPurchase).toBe(0);
    expect(filas[0]!.pctSessionToPurchase).toBe(0);
    const json = JSON.stringify(filas);
    expect(json).not.toContain('NaN');
    expect(json).not.toContain('Infinity');
  });

  it('denominador 0 en posiciones intermedias: venta sin clics y clics sin compra dan 0 en su tasa', () => {
    const filas = calcularTasasExperimento([
      contador('A', { sessions: 100, salesViews: 50, checkoutClicks: 0, purchases: 0 }),
    ]);
    expect(filas[0]!.pctSalesView).toBe(50);
    expect(filas[0]!.pctCheckoutClick).toBe(0); // 0 clics / 50 ventas
    expect(filas[0]!.pctPurchase).toBe(0); // 0 compras / 0 clics
    expect(filas[0]!.pctSessionToPurchase).toBe(0);
  });

  it('el orden de salida es A, B, el resto alfabético y el centinela siempre último', () => {
    const filas = calcularTasasExperimento([
      contador(SIN_EXPERIMENTO, { sessions: 9 }),
      contador('B', { sessions: 2 }),
      contador('Z', { sessions: 6 }),
      contador('A', { sessions: 1 }),
      contador('M', { sessions: 5 }),
    ]);
    expect(filas.map((f) => f.experiment)).toEqual(['A', 'B', 'M', 'Z', SIN_EXPERIMENTO]);
  });

  it('el orden no depende del orden de entrada: la entrada se reordena, no se muta', () => {
    const entrada = [
      contador('Z'),
      contador(SIN_EXPERIMENTO),
      contador('B'),
      contador('A'),
      contador('C'),
    ];
    const salida = calcularTasasExperimento(entrada);
    expect(salida.map((f) => f.experiment)).toEqual(['A', 'B', 'C', 'Z', SIN_EXPERIMENTO]);
    // La entrada quedó como estaba: la función es pura de verdad.
    expect(entrada.map((f) => f.experiment)).toEqual(['Z', SIN_EXPERIMENTO, 'B', 'A', 'C']);
  });

  it('sin filas → arreglo vacío', () => {
    expect(calcularTasasExperimento([])).toEqual([]);
  });
});
