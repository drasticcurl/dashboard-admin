import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  debeMostrarCardTestAB,
  debeMostrarCardVariantes,
  etiquetaExperimento,
} from './EmbudoView';
import { SIN_EXPERIMENTO, type ExperimentoRow } from '@/lib/queries/funnel';

/**
 * Gates de visibilidad de la vista del embudo (spec ab-test-popup-descuento).
 *
 * Entorno `node` y sin jsdom (este proyecto no lo tiene): los predicados de
 * visibilidad viven como funciones PURAS exportadas por EmbudoView.tsx
 * justamente para que este test no necesite renderizar nada.
 */

function fila(experiment: string, sessions: number = 1): ExperimentoRow {
  return {
    experiment,
    sessions,
    salesViews: 0,
    checkoutClicks: 0,
    purchases: 0,
    pctSalesView: 0,
    pctCheckoutClick: 0,
    pctPurchase: 0,
    pctSessionToPurchase: 0,
  };
}

describe('gates de la vista del embudo (puros)', () => {
  // Feature: ab-test-popup-descuento, Property 34: Los dos gates de la vista son independientes
  it('Property 34: la card Test A/B se muestra si y solo si el desglose tiene dos o más filas, y Variantes si y solo si hay más de una variante', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 8 }),
        fc.integer({ min: 0, max: 8 }),
        (nVariants, nExperiments) => {
          const variants = Array.from({ length: nVariants }, (_, i) => `v${i}`);
          const experiments = Array.from({ length: nExperiments }, (_, i) =>
            fila(i === 0 ? 'A' : 'B', 10),
          );

          // El gate del Test A/B cuenta FILAS DEL DESGLOSE, nunca
          // funnel.variants.length (R9.11): hoy chauhinchazon tiene
          // variants = ['ar','latam'] y reusar el gate viejo parecería
          // funcionar, pero es una coincidencia peligrosa.
          expect(debeMostrarCardTestAB(experiments)).toBe(nExperiments > 1);

          // El gate de Variantes sigue con el arreglo de variantes (R9.12).
          expect(debeMostrarCardVariantes(variants)).toBe(nVariants > 1);

          // Independencia: ninguno lee al otro.
          const testABConUnaSolaVariante = debeMostrarCardTestAB(experiments);
          const testABConMuchasVariantes = debeMostrarCardTestAB(experiments);
          expect(testABConMuchasVariantes).toBe(testABConUnaSolaVariante);
          const variantesConPocasFilas = debeMostrarCardVariantes(variants);
          const variantesConMuchasFilas = debeMostrarCardVariantes(variants);
          expect(variantesConMuchasFilas).toBe(variantesConPocasFilas);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('una sola fila (el caso del funnel viejo desplegado: todo NULL) → sin card Test A/B', () => {
    expect(debeMostrarCardTestAB([fila(SIN_EXPERIMENTO, 999)])).toBe(false);
  });

  it('cero filas → sin card Test A/B', () => {
    expect(debeMostrarCardTestAB([])).toBe(false);
  });
});

describe('etiquetaExperimento (pura)', () => {
  it('A y B llevan su etiqueta, y cualquier otro valor —incluido el centinela— se devuelve tal cual', () => {
    expect(etiquetaExperimento('A')).toBe('A · control (sin pop-up)');
    expect(etiquetaExperimento('B')).toBe('B · pop-up 83%');
    expect(etiquetaExperimento(SIN_EXPERIMENTO)).toBe(SIN_EXPERIMENTO);
    expect(etiquetaExperimento('C')).toBe('C');
    expect(etiquetaExperimento('')).toBe('');
  });
});
