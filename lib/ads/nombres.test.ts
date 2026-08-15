import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LARGO_MAX_NOMBRE, aplicarRenombre, nombreDeCopia, nombresDeCopias } from './nombres';
import { genNombreObjeto } from '../test/generadores-ads';

/**
 * Tests de ejemplo de nombres de Copia y renombrado (task 7.3). La Property 12
 * (unicidad y largo máximo para todo original y ocupados) vive en la task 7.2.
 */

describe('nombreDeCopia (R10 c5, c6)', () => {
  it('usa el primer secuencial libre, con huecos en los ocupados', () => {
    const ocupados = new Set(['PXN 1 - Copia 1', 'PXN 1 - Copia 2']);
    expect(nombreDeCopia('PXN 1', ocupados)).toBe('PXN 1 - Copia 3');
  });

  it('saltea los huecos y toma el primer número no ocupado', () => {
    const ocupados = new Set(['PXN 1 - Copia 2']);
    expect(nombreDeCopia('PXN 1', ocupados)).toBe('PXN 1 - Copia 1');
  });

  it('un original de 398 caracteres se recorta conservando el sufijo completo y ≥1 carácter heredado', () => {
    const original = 'A'.repeat(398);
    const nombre = nombreDeCopia(original, new Set());
    expect(nombre.length).toBeLessThanOrEqual(LARGO_MAX_NOMBRE);
    expect(nombre.endsWith(' - Copia 1')).toBe(true);
    expect(nombre.startsWith('A')).toBe(true);
    // la parte heredada conserva al menos 1 carácter
    expect(nombre.length).toBeGreaterThan(' - Copia 1'.length);
  });

  it('nunca genera un nombre ya ocupado, aunque haya que avanzar el secuencial', () => {
    const ocupados = new Set(['X - Copia 1', 'X - Copia 2', 'X - Copia 3']);
    expect(nombreDeCopia('X', ocupados)).toBe('X - Copia 4');
  });
});

describe('nombresDeCopias (R10 c5)', () => {
  it('los k nombres son distintos entre sí y distintos de los ocupados', () => {
    const ocupados = new Set(['Y - Copia 2']);
    const nombres = nombresDeCopias('Y', 5, ocupados);
    expect(new Set(nombres).size).toBe(5);
    for (const n of nombres) expect(ocupados.has(n)).toBe(false);
  });
});

describe('aplicarRenombre (R12 c2)', () => {
  it('prefijo', () => {
    expect(aplicarRenombre('Campaña A', { tipo: 'prefijo', texto: '2026-08 - ' })).toBe(
      '2026-08 - Campaña A',
    );
  });

  it('sufijo', () => {
    expect(aplicarRenombre('Campaña A', { tipo: 'sufijo', texto: ' - v2' })).toBe('Campaña A - v2');
  });

  it('reemplazo es sensible a mayúsculas y reemplaza TODAS las apariciones', () => {
    expect(
      aplicarRenombre('Pausa Pausa pausa', { tipo: 'reemplazo', buscar: 'Pausa', poner: 'Pausada' }),
    ).toBe('Pausada Pausada pausa');
  });

  it('reemplazo con poner vacío borra el texto buscado', () => {
    expect(
      aplicarRenombre('A (old) B (old)', { tipo: 'reemplazo', buscar: ' (old)', poner: '' }),
    ).toBe('A B');
  });

  it('exacto reemplaza el nombre completo', () => {
    expect(aplicarRenombre('viejo', { tipo: 'exacto', nombre: 'nuevo' })).toBe('nuevo');
  });
});

// Feature: gestion-campanas-anuncios, Property 12: Los nombres de las Copia no
// colisionan y respetan el largo máximo
describe('Property 12 (R10 c5, c6)', () => {
  it('para todo original y ocupados, los nombres de una corrida son únicos, ≤ 400, y conservan el sufijo y ≥1 carácter heredado', () => {
    fc.assert(
      fc.property(
        genNombreObjeto(),
        fc.array(genNombreObjeto(), { minLength: 0, maxLength: 50 }).map((ns) => new Set(ns)),
        fc.integer({ min: 1, max: 5 }),
        (original, ocupados, k) => {
          const nombres = nombresDeCopias(original, k, ocupados);

          // todos distintos entre sí
          expect(new Set(nombres).size).toBe(nombres.length);
          // distintos de los ocupados
          for (const n of nombres) {
            expect(ocupados.has(n), `«${n}» ya estaba ocupado`).toBe(false);
            // largo máximo
            expect(n.length).toBeLessThanOrEqual(LARGO_MAX_NOMBRE);
            // el sufijo completo siempre está
            expect(n).toMatch(/ - Copia \d+$/);
            // al menos 1 carácter de la parte heredada (el prefijo del nombre,
            // truncado sólo cuando el original es muy largo)
            if (original.length <= LARGO_MAX_NOMBRE - 11) {
              expect(n.startsWith(original)).toBe(true);
            } else {
              expect(n.length).toBeGreaterThan(10);
              expect(n.startsWith(original.slice(0, 1))).toBe(true);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
