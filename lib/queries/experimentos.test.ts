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
  return {
    experiment,
    sessions: 0,
    salesViews: 0,
    checkoutClicks: 0,
    purchases: 0,
    upsellViews: 0,
    upsellClicks: 0,
    downsellViews: 0,
    revenue: 0,
    ...over,
  };
}

// Tuplas válidas de contadores: el embudo es jerárquico (compras ⊆ clicks ⊆
// ventas ⊆ sesiones), y encadenando los rangos el generador cubre ceros en
// cualquier posición SIN filtrar.
//
// El tramo del upsell se engancha DEBAJO de las compras (upsellClicks ⊆
// upsellViews ⊆ purchases): al upsell solo se llega comprando el front, así que
// generar clics de upsell sin compras produciría tuplas que la base nunca puede
// devolver y un take rate arriba de 100.
const contadores = fc
  .integer({ min: 0, max: 1000 })
  .chain((sessions) =>
    fc
      .integer({ min: 0, max: sessions })
      .chain((salesViews) =>
        fc
          .integer({ min: 0, max: salesViews })
          .chain((checkoutClicks) =>
            fc.integer({ min: 0, max: checkoutClicks }).chain((purchases) =>
              fc.integer({ min: 0, max: purchases }).chain((upsellViews) =>
                fc
                  .integer({ min: 0, max: upsellViews })
                  .chain((upsellClicks) =>
                    fc
                      .integer({ min: 0, max: purchases })
                      .chain((downsellViews) =>
                        // La plata no está acotada por los contadores: un upsell
                        // caro mueve el total sin mover ninguna cuenta.
                        fc.integer({ min: 0, max: 5_000_000 }).map((revenue) => ({
                          sessions,
                          salesViews,
                          checkoutClicks,
                          purchases,
                          upsellViews,
                          upsellClicks,
                          downsellViews,
                          revenue,
                        })),
                      ),
                  ),
              ),
            ),
          ),
      ),
  );

// Feature: ab-test-popup-descuento, Property 32: Las tasas derivadas son cocientes acotados y sin división por cero
describe('calcularTasasExperimento (pura)', () => {
  it('Property 32: para cualquier tupla de contadores las cinco tasas son el cociente en %, quedan en [0, 100] y valen 0 con denominador 0', () => {
    fc.assert(
      fc.property(contadores, (c) => {
        const [fila] = calcularTasasExperimento([{ experiment: 'A', ...c }]);
        expect(fila!.pctSalesView).toBe(c.sessions === 0 ? 0 : (c.salesViews / c.sessions) * 100);
        expect(fila!.pctCheckoutClick).toBe(c.salesViews === 0 ? 0 : (c.checkoutClicks / c.salesViews) * 100);
        expect(fila!.pctPurchase).toBe(c.checkoutClicks === 0 ? 0 : (c.purchases / c.checkoutClicks) * 100);
        expect(fila!.pctSessionToPurchase).toBe(c.sessions === 0 ? 0 : (c.purchases / c.sessions) * 100);
        // El take rate del upsell se mide contra las COMPRAS del front.
        expect(fila!.pctUpsellTake).toBe(c.purchases === 0 ? 0 : (c.upsellClicks / c.purchases) * 100);

        for (const tasa of [
          fila!.pctSalesView,
          fila!.pctCheckoutClick,
          fila!.pctPurchase,
          fila!.pctSessionToPurchase,
          fila!.pctUpsellTake,
        ]) {
          expect(Number.isFinite(tasa)).toBe(true);
          expect(tasa).toBeGreaterThanOrEqual(0);
          expect(tasa).toBeLessThanOrEqual(100);
        }
      }),
      { numRuns: 100 },
    );
  });

  // La plata por sesión NO es un porcentaje: no está acotada a 100 y su cota
  // superior es el total facturado (el caso de una sola sesión). Se testea
  // aparte a propósito: metida en el bucle de arriba, el
  // `toBeLessThanOrEqual(100)` la haría fallar con razón.
  it('la plata por sesión es el cociente exacto, vale 0 sin sesiones y no está acotada a 100', () => {
    fc.assert(
      fc.property(contadores, (c) => {
        const [fila] = calcularTasasExperimento([{ experiment: 'A', ...c }]);
        expect(fila!.revenuePerSession).toBe(c.sessions === 0 ? 0 : c.revenue / c.sessions);
        expect(Number.isFinite(fila!.revenuePerSession)).toBe(true);
        expect(fila!.revenuePerSession).toBeGreaterThanOrEqual(0);
        expect(fila!.revenuePerSession).toBeLessThanOrEqual(c.revenue);
      }),
      { numRuns: 100 },
    );
  });

  it('plata sin sesiones → 0, nunca Infinity (el caso que rompería la card)', () => {
    const [fila] = calcularTasasExperimento([contador('A', { sessions: 0, revenue: 99_000 })]);
    expect(fila!.revenuePerSession).toBe(0);
    expect(Number.isFinite(fila!.revenuePerSession)).toBe(true);
  });

  it('la plata por sesión separa dos variantes con la MISMA conversión y distinto ticket', () => {
    // El escenario que justifica la columna: B convierte igual que A pero
    // factura el doble por upsells. Con `pctSessionToPurchase` empatan, y el
    // test se decidiría mal.
    const [a, b] = calcularTasasExperimento([
      contador('A', { sessions: 1000, purchases: 50, revenue: 500_000 }),
      contador('B', { sessions: 1000, purchases: 50, revenue: 1_000_000 }),
    ]);
    expect(a!.pctSessionToPurchase).toBe(b!.pctSessionToPurchase);
    expect(a!.revenuePerSession).toBe(500);
    expect(b!.revenuePerSession).toBe(1000);
  });

  it('el take rate del upsell no se contamina con las vistas del upsell', () => {
    // Mismos clics sobre las mismas compras ⇒ mismo take rate, aunque una
    // variante le muestre el upsell a menos gente. Si el denominador fueran las
    // vistas, B saldría con el triple de take rate sin vender uno más.
    const [a, b] = calcularTasasExperimento([
      contador('A', { sessions: 100, purchases: 20, upsellViews: 20, upsellClicks: 5 }),
      contador('B', { sessions: 100, purchases: 20, upsellViews: 8, upsellClicks: 5 }),
    ]);
    expect(a!.pctUpsellTake).toBe(25);
    expect(b!.pctUpsellTake).toBe(25);
  });

  it('ceros en todas las posiciones → todas las tasas en 0 exacto, nunca NaN ni Infinity', () => {
    const filas = calcularTasasExperimento([contador('A', { sessions: 0, salesViews: 0, checkoutClicks: 0, purchases: 0 })]);
    expect(filas[0]!.pctSalesView).toBe(0);
    expect(filas[0]!.pctCheckoutClick).toBe(0);
    expect(filas[0]!.pctPurchase).toBe(0);
    expect(filas[0]!.pctSessionToPurchase).toBe(0);
    expect(filas[0]!.pctUpsellTake).toBe(0);
    expect(filas[0]!.revenuePerSession).toBe(0);
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
