/**
 * Property 5: El tope de delta por Tick es por cuenta y no se filtra entre
 * cuentas (spec reglas-anuncios-por-cuenta, task 1.4).
 *
 * Puro: sin base, sin red. La máquina de estados es chica y los invariantes son
 * universales: 100 iteraciones cuestan microsegundos.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { aplicarDelta, acumuladorDe, crearAcumuladores, type AcumuladorDelta } from './acumuladores';

const genCuentas = (): fc.Arbitrary<string[]> =>
  fc.set(fc.uuid(), { minLength: 1, maxLength: 5 }).map((s) => Array.from(s));

describe('acumuladores', () => {
  it('para toda secuencia de deltas, cada cuenta respeta su propio tope y no se filtra entre cuentas', () => {
    // Feature: reglas-anuncios-por-cuenta, Property 5: El tope de delta por Tick
    // es por cuenta y no se filtra entre cuentas
    fc.assert(
      fc.property(
        genCuentas().chain((cuentas) =>
          fc
            .tuple(
              fc.integer({ min: 0, max: 1000 }), // tope en EUR
              // Deltas en unidades mínimas: positivos, cero, negativos, y algunos
              // que pasan el tope de un salto (±€2000 cubren cualquier tope).
              fc.array(
                fc.tuple(
                  fc.constantFrom(...cuentas),
                  fc.integer({ min: -200_000, max: 200_000 }),
                ),
                { minLength: 0, maxLength: 50 },
              ),
            )
            .map(([topeEur, seq]) => ({ cuentas, topeEur, seq })),
        ),
        ({ cuentas, topeEur, seq }) => {
          const topeMin = Math.round(topeEur * 100);
          const mapa = crearAcumuladores(cuentas, topeEur);

          // Un mapa recién creado está todo en cero, con el tope del Tick.
          for (const c of cuentas) {
            const a = mapa.get(c)!;
            expect(a.sumado).toBe(0);
            expect(a.topeMin).toBe(topeMin);
          }

          // El modelo: la subsecuencia de UNA sola cuenta contra un acumulador
          // nuevo. El estado de las otras cuentas no puede influir en este.
          const solos = new Map<string, AcumuladorDelta>();
          for (const c of cuentas) solos.set(c, { sumado: 0, topeMin });

          for (const [c, delta] of seq) {
            const antes = mapa.get(c)!.sumado;
            const aceptado = aplicarDelta(mapa.get(c)!, delta);
            const soloAceptado = aplicarDelta(solos.get(c)!, delta);

            // El resultado es idéntico al de la subsecuencia de esa sola cuenta.
            expect(aceptado).toBe(soloAceptado);
            expect(mapa.get(c)!.sumado).toBe(solos.get(c)!.sumado);

            if (delta <= 0) {
              // Un delta ≤ 0 se acepta sin consumir tope.
              expect(aceptado).toBe(true);
              expect(mapa.get(c)!.sumado).toBe(antes);
            } else if (aceptado) {
              expect(mapa.get(c)!.sumado).toBe(antes + delta);
            } else {
              // Un rechazo deja el acumulador intacto.
              expect(mapa.get(c)!.sumado).toBe(antes);
            }
          }

          // Nunca se supera el tope de la cuenta.
          for (const c of cuentas) {
            expect(mapa.get(c)!.sumado).toBeLessThanOrEqual(topeMin);
          }

          // `acumuladorDe` crea el que falta (cuenta desactivada a mitad de Tick).
          const extra = 'cuenta-que-no-estaba';
          const creado = acumuladorDe(mapa, extra, topeEur);
          expect(creado.sumado).toBe(0);
          expect(creado.topeMin).toBe(topeMin);
          expect(mapa.get(extra)).toBe(creado);
        },
      ),
      { numRuns: 100 },
    );
  });
});
