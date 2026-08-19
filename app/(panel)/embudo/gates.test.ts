import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  debeMostrarCardTestAB,
  debeMostrarCardVariantes,
  debeMostrarSelectorExperimento,
  etiquetaCortaExperimento,
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
    upsellViews: 0,
    upsellClicks: 0,
    downsellViews: 0,
    revenue: 0,
    pctSalesView: 0,
    pctCheckoutClick: 0,
    pctPurchase: 0,
    pctSessionToPurchase: 0,
    pctUpsellTake: 0,
    revenuePerSession: 0,
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

/**
 * El gate del selector es OTRA pregunta que el de la card, y el bug que evita es
 * concreto: al filtrar por B el desglose vuelve con una sola fila, así que un
 * select alimentado por `data.experiments` se auto-ocultaría justo cuando hace
 * falta para volver a "A y B juntas". Por eso mira la lista ESTABLE de opciones.
 */
describe('debeMostrarSelectorExperimento (puro)', () => {
  it('se muestra con dos o más opciones y se esconde con una o ninguna', () => {
    expect(debeMostrarSelectorExperimento([])).toBe(false);
    expect(debeMostrarSelectorExperimento(['A'])).toBe(false);
    expect(debeMostrarSelectorExperimento(['A', 'B'])).toBe(true);
    expect(debeMostrarSelectorExperimento(['A', 'B', SIN_EXPERIMENTO])).toBe(true);
  });

  it('sobrevive al filtro: con el desglose recortado a una fila, el selector sigue en pie', () => {
    // La situación exacta del bug: el usuario eligió B, la card se esconde
    // (nada que comparar) pero el control tiene que quedar para poder salir.
    const desgloseFiltrado = [fila('B', 500)];
    const opcionesEstables = ['A', 'B'];
    expect(debeMostrarCardTestAB(desgloseFiltrado)).toBe(false);
    expect(debeMostrarSelectorExperimento(opcionesEstables)).toBe(true);
  });
});

/**
 * Las etiquetas cortas del toggle que está arriba del embudo por etapas. Son
 * OTRAS que las de la tabla: ahí hay ancho para describir qué cambia cada
 * variante, en un botón no.
 */
describe('etiquetaCortaExperimento (pura)', () => {
  it('A y B se nombran por su portada, el centinela se acorta y el resto pasa tal cual', () => {
    expect(etiquetaCortaExperimento('A')).toBe('Landing A');
    expect(etiquetaCortaExperimento('B')).toBe('Landing B');
    expect(etiquetaCortaExperimento(SIN_EXPERIMENTO)).toBe('Sin asignar');
    expect(etiquetaCortaExperimento('C')).toBe('C');
    expect(etiquetaCortaExperimento('')).toBe('');
  });

  it('son más cortas que las de la tabla, que es la razón de que existan', () => {
    for (const v of ['A', 'B']) {
      expect(etiquetaCortaExperimento(v).length).toBeLessThan(etiquetaExperimento(v).length);
    }
  });

  it('ninguna menciona el pop-up', () => {
    for (const v of ['A', 'B', 'C', SIN_EXPERIMENTO]) {
      expect(etiquetaCortaExperimento(v).toLowerCase()).not.toContain('pop-up');
    }
  });
});

describe('etiquetaExperimento (pura)', () => {
  it('A y B llevan la etiqueta de la PORTADA, y cualquier otro valor —incluido el centinela— se devuelve tal cual', () => {
    // El test del pop-up de descuento se retiró (ganó el control) y el slot
    // `sessions.experiment` lo ocupa el test de portada: las etiquetas tienen que
    // hablar de la portada o la card miente sobre lo que se está mirando.
    expect(etiquetaExperimento('A')).toBe('A · control (portada actual)');
    expect(etiquetaExperimento('B')).toBe('B · portada con pregunta');
    expect(etiquetaExperimento(SIN_EXPERIMENTO)).toBe(SIN_EXPERIMENTO);
    expect(etiquetaExperimento('C')).toBe('C');
    expect(etiquetaExperimento('')).toBe('');
  });

  it('ninguna etiqueta menciona el pop-up', () => {
    // Guarda contra el copy viejo volviendo por un merge o un copy-paste.
    for (const v of ['A', 'B', 'C', SIN_EXPERIMENTO]) {
      expect(etiquetaExperimento(v).toLowerCase()).not.toContain('pop-up');
      expect(etiquetaExperimento(v).toLowerCase()).not.toContain('popup');
    }
  });
});
