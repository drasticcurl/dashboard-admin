import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { nombreDeCopia } from './_nombres';
import { aplicadoA, problema } from './ReglasView';
import { formBase } from './_formBase';

/**
 * Property 10 y los dos casos puros de la pantalla (task 9.5 y 9.6).
 *
 * `problema` y `aplicadoA` viven en ReglasView.tsx (componente cliente) y se
 * importan desde acá; si el environment 'node' de Vitest no puede cargar el
 * componente (recharts, etc.), el plan B del task es moverlas a _nombres.ts.
 */

describe('nombreDeCopia', () => {
  it('Feature: reglas-anuncios-por-cuenta, Property 10: el nombre que propone Duplicar nunca colisiona dentro de la cuenta', () => {
    fc.assert(
      fc.property(
        genNombre().chain((base) =>
          // Algunos ocupados son exactamente los primeros candidatos de la
          // copia, para forzar el bucle de sufijos.
          fc
            .array(
              fc.oneof(
                fc.constant(`${base} (copia)`),
                fc.constant(`${base} (copia 2)`),
                fc.constant(`${base} (copia 3)`),
                fc.string({ minLength: 1, maxLength: 200 }),
              ),
              { minLength: 0, maxLength: 50 },
            )
            .map((ocupados) => ({ base, ocupados })),
        ),
        ({ base, ocupados }) => {
          const propuesto = nombreDeCopia(base, ocupados);
          // El único es (account_id, name): la colisión se mide contra los
          // nombres de ESA cuenta y de ninguna otra.
          expect(ocupados).not.toContain(propuesto);
          // Nunca vacío después de trim, y dentro del tope de 200 de
          // ad_rules.name (el mismo que el zod).
          expect(propuesto.trim().length).toBeGreaterThan(0);
          expect(propuesto.length).toBeLessThanOrEqual(200);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Generador del nombre base: 1..200 caracteres, incluidos los que ya terminan
  // en un sufijo de copia, que es el caso que se verifica aparte.
  function genNombre(): fc.Arbitrary<string> {
    return fc.oneof(
      fc.string({ minLength: 1, maxLength: 200 }),
      fc
        .tuple(fc.string({ minLength: 1, maxLength: 180 }), fc.integer({ min: 1, max: 99 }))
        .map(([base, n]) => `${base} (copia ${n})`),
    );
  }
});

describe('problema y aplicadoA (task 9.6)', () => {
  it('problema con accountId vacío devuelve el mensaje que nombra el campo (R8 c4)', () => {
    expect(problema(formBase({ accountId: '' }))).toBe('Falta la cuenta de anuncios.');
    // Con cuenta elegida, el mensaje de cuenta no aparece.
    expect(problema(formBase({ accountId: 'act_123' }))).toBeNull();
  });

  // La ventana horaria tenía dos formas de guardarse mal, y las dos terminaban
  // en una regla que no corre: media ventana (400 del API, después de llenar
  // todo el formulario) y las dos horas iguales, que nadie atajaba y deja a la
  // regla con 60 segundos por día para correr.
  it('problema ataja la media ventana horaria y las dos horas iguales', () => {
    expect(problema(formBase({ windowStart: '08:00', windowEnd: '' }))).toContain('completa o vacía');
    expect(problema(formBase({ windowStart: '', windowEnd: '23:00' }))).toContain('completa o vacía');
    expect(problema(formBase({ windowStart: '12:30', windowEnd: '12:30' }))).toContain('ese minuto exacto');
    // Una ventana normal y una que cruza la medianoche (dentroDeVentana la
    // soporta con start > end) son válidas.
    expect(problema(formBase({ windowStart: '08:00', windowEnd: '23:00' }))).toBeNull();
    expect(problema(formBase({ windowStart: '22:00', windowEnd: '06:00' }))).toBeNull();
  });

  it('aplicadoA nombra la cuenta concreta y su zona, nunca "N cuentas" ni "todas las cuentas" (R8 c6)', () => {
    const cuentas = [
      { accountId: 'act_a', name: 'HIlvanapp', timezone: 'Europe/Lisbon' },
      { accountId: 'act_b', name: 'Protocolo reset', timezone: 'America/Argentina/Buenos_Aires' },
    ];
    const texto = aplicadoA({ accountId: 'act_b', level: 'adset', statusFilter: 'active' }, cuentas);
    expect(texto).toContain('Protocolo reset');
    expect(texto).toContain('America/Argentina/Buenos_Aires');
    expect(texto).not.toContain('cuentas');
    expect(texto).not.toContain('todas');
  });
});
