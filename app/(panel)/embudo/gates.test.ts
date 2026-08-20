import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as EmbudoModule from './EmbudoView';
import { debeMostrarCardVariantes } from './EmbudoView';

/**
 * Gates de visibilidad de la vista del embudo.
 *
 * Entorno `node` y sin jsdom (este proyecto no lo tiene): los predicados de
 * visibilidad viven como funciones PURAS exportadas por EmbudoView.tsx
 * justamente para que este test no necesite renderizar nada.
 *
 * HISTORIA, porque explica por qué este archivo quedó tan corto: nació con la
 * spec `ab-test-popup-descuento` y su Property 34 cubría DOS gates
 * independientes, el de la card `Test A/B` y el de `Variantes`. El desglose por
 * test A/B se retiró de la vista al cerrarse el test de portada (ganó la
 * variante B, la portada quedó fija y el funnel dejó de emitir la dimensión),
 * así que de los cinco puros que exportaba EmbudoView quedó uno.
 *
 * Lo que este archivo cuida ahora son dos cosas distintas:
 *  1. que el gate de `Variantes` siga siendo el arreglo de variantes del funnel;
 *  2. que la superficie del A/B NO vuelva a medias.
 */

describe('debeMostrarCardVariantes (puro)', () => {
  it('se muestra si y solo si el funnel tiene más de una variante', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 8 }), (nVariants) => {
        const variants = Array.from({ length: nVariants }, (_, i) => `v${i}`);
        expect(debeMostrarCardVariantes(variants)).toBe(nVariants > 1);
      }),
      { numRuns: 100 },
    );
  });

  it('los casos concretos que importan: 0, 1 y el ar/latam de chauhinchazon', () => {
    expect(debeMostrarCardVariantes([])).toBe(false);
    // Un funnel de un solo mercado (reset: ['default']) no muestra el desglose:
    // una tabla de una fila que repite el total no dice nada.
    expect(debeMostrarCardVariantes(['default'])).toBe(false);
    expect(debeMostrarCardVariantes(['ar', 'latam'])).toBe(true);
  });

  it('el gate mira el LARGO del arreglo, no qué hay adentro', () => {
    // Es un gate de "¿hay algo que desglosar?", no de "¿es este mercado?".
    expect(debeMostrarCardVariantes(['ar', 'ar'])).toBe(true);
    expect(debeMostrarCardVariantes(['cualquiera', 'otra'])).toBe(true);
  });
});

/**
 * El embudo es UNO SOLO: la vista no vuelve a partirse por test A/B sin que
 * alguien lo decida a propósito.
 *
 * Esto no es un test de cosmética. La superficie del A/B eran DOS piezas
 * acopladas —una card de desglose y un toggle que REEMPLAZABA al de base y
 * recortaba el embudo entero con `?exp=`— más un filtro que viajaba por la URL,
 * el server component y la API. Media superficie reintroducida es peor que
 * ninguna: un toggle sin card deja recortando el embudo sin nada que explique el
 * recorte, y una card sin toggle no se puede sacar de la pantalla.
 *
 * Si vuelve un experimento, que vuelva completo y este test se reescriba
 * a mano. Que se rompa es la señal de "leé por qué se sacó antes de rearmarlo".
 */
describe('la superficie del test A/B no volvió a medias', () => {
  it('EmbudoView no exporta ninguno de los puros del A/B', () => {
    const exportados = Object.keys(EmbudoModule);
    for (const retirado of [
      'etiquetaExperimento',
      'etiquetaCortaExperimento',
      'debeMostrarCardTestAB',
      'debeMostrarSelectorExperimento',
    ]) {
      expect(exportados).not.toContain(retirado);
    }
  });

  it('sigue exportando el gate de Variantes y la vista', () => {
    // La contracara del test de arriba: que "no exporta el A/B" no se cumpla
    // porque el módulo se rompió y no exporta nada.
    const exportados = Object.keys(EmbudoModule);
    expect(exportados).toContain('debeMostrarCardVariantes');
    expect(exportados).toContain('EmbudoView');
  });
});
