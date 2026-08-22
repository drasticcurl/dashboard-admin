import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { presupuestoDelDialogo, textoDeImporte } from './GestorAnuncios';
import { MINIMO_EUR, parsearPresupuesto } from '@/lib/ads/presupuesto';

/**
 * La otra mitad de la Property 4 (task 3.2 de frescura-y-acciones-anuncios).
 *
 * `lib/ads/presupuesto.test.ts` fija qué textos son un importe válido. Acá se
 * fija lo que el bug reportado rompía: que el importe aceptado sea el que viaja
 * en el payload del Endpoint_Acciones, y que no exista un texto que habilite el
 * botón Ejecutar y produzca un pedido sin `budgetEur`.
 *
 * `presupuestoDelDialogo` y `textoDeImporte` son puras y viven en
 * `GestorAnuncios.tsx` porque son la forma del diálogo, no del dominio; se
 * importan desde acá igual que `problema` y `aplicadoA` de `ReglasView.tsx` en
 * `reglas/_nombres.test.ts`. Sin base, sin red y sin render.
 */

const TECHO = 200;

describe('el importe del diálogo de presupuesto (R1 c1, c3)', () => {
  it('un importe válido produce el fragmento de payload con el mismo número', () => {
    const r = presupuestoDelDialogo('12.34', TECHO);
    expect(r.ok).toBe(true);
    expect(r.cuerpo).toEqual({ budgetEur: 12.34 });
    // La previa se recalcula con el MISMO valor que se manda.
    expect(r.params.budgetEur).toBe(12.34);
    expect(r.bloqueo).toBeNull();
  });

  it('el campo vacío no produce payload y sí produce bloqueo: es el caso que devolvía Required', () => {
    // El camino de la barra de lote: `abrirConfirmacion('budget_set')` sin
    // params. Antes esto mandaba `budgetEur: undefined`, que `JSON.stringify`
    // borra, y el zod del route respondía `Required`.
    const r = presupuestoDelDialogo('', TECHO);
    expect(r.ok).toBe(false);
    expect(r.cuerpo).toBeNull();
    expect(r.bloqueo).toBe('falta el importe del presupuesto');
  });

  it('un importe fuera de la regla se bloquea con el motivo, no con un mensaje genérico', () => {
    expect(presupuestoDelDialogo('0', TECHO).bloqueo).toContain('mínimo');
    expect(presupuestoDelDialogo('200.01', TECHO).bloqueo).toContain('techo');
    expect(presupuestoDelDialogo('10.005', TECHO).bloqueo).toContain('decimales');
    expect(presupuestoDelDialogo('abc', TECHO).bloqueo).toContain('número');
  });

  it('los dos bordes del rango son ejecutables', () => {
    expect(presupuestoDelDialogo('0.01', TECHO).cuerpo).toEqual({ budgetEur: MINIMO_EUR });
    expect(presupuestoDelDialogo('200', TECHO).cuerpo).toEqual({ budgetEur: 200 });
  });
});

describe('la siembra del campo desde la celda de una fila (R1 c2)', () => {
  it('un importe cargado vuelve a entrar como el mismo número', () => {
    // Es la ida y vuelta que hace que la previa muestre el "después" en lugar de
    // un guion cuando el diálogo se abre desde la celda.
    expect(textoDeImporte(12.5)).toBe('12.50');
    expect(presupuestoDelDialogo(textoDeImporte(12.5), TECHO).cuerpo).toEqual({ budgetEur: 12.5 });
  });

  it('sin importe el campo arranca vacío, que es el caso de la barra de lote', () => {
    expect(textoDeImporte(undefined)).toBe('');
    expect(textoDeImporte(Number.NaN)).toBe('');
    expect(textoDeImporte(Number.POSITIVE_INFINITY)).toBe('');
  });
});

// ─── Generadores ─────────────────────────────────────────────────────────────
// Los mismos textos de campo que `lib/ads/presupuesto.test.ts`, con el peso
// puesto en importes bien formados: con puro ruido la propiedad se cumpliría de
// forma trivial (todo bloqueado) y no probaría el camino que manda el pedido.

const textoDeCampo: fc.Arbitrary<string> = fc.oneof(
  { weight: 5, arbitrary: fc.integer({ min: -100, max: 40_000 }).map((c) => (c / 100).toFixed(2)) },
  { weight: 3, arbitrary: fc.integer({ min: -100, max: 40_000 }).map((c) => String(c / 100)) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 40_000 }).map((m) => (m / 1_000).toFixed(3)) },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      '', ' ', '   ', '\t', 'abc', 'NaN', 'Infinity', '1,5', '1.2.3',
      '0', '-5', '0.001', '1e2', '1e-3', '.5', '5.', '+5', '  12.50  ',
    ),
  },
  { weight: 1, arbitrary: fc.string({ maxLength: 10 }) },
);

/** Techos plausibles de `settings`, en céntimos para no generar 1.4e-45. */
const techoPositivo: fc.Arbitrary<number> = fc
  .integer({ min: 1, max: 100_000 })
  .map((centimos) => centimos / 100);

// Feature: frescura-y-acciones-anuncios, Property 4: Conservación del importe
//
// **Validates: Requirements 1.1, 1.3, 1.5**
describe('Property 4: Conservación del importe', () => {
  it('para todo texto y todo techo, si no hay bloqueo entonces el payload lleva exactamente el importe parseado', () => {
    fc.assert(
      fc.property(textoDeCampo, techoPositivo, (texto, techoEur) => {
        const r = presupuestoDelDialogo(texto, techoEur);
        const parseado = parsearPresupuesto(texto, techoEur);

        // Habilitar el botón y tener algo que mandar son la misma condición: no
        // hay un tercer estado donde Ejecutar esté disponible y el pedido salga
        // sin importe.
        expect(r.bloqueo === null).toBe(r.cuerpo !== null);
        expect(r.ok).toBe(parseado.ok);

        if (!r.ok) {
          expect(r.bloqueo.length).toBeGreaterThan(0);
          // Sin importe no se manda nada, así que la previa no puede mostrar un
          // "después" que nadie va a aplicar.
          expect(r.params.budgetEur).toBeUndefined();
          return;
        }

        const valor = parseado.ok ? parseado.valor : null;
        expect(r.cuerpo.budgetEur).toBe(valor);
        // Lo que el usuario ve en la previa es lo que se manda.
        expect(r.params.budgetEur).toBe(r.cuerpo.budgetEur);
        // Y sobrevive al `JSON.stringify` del fetch: acá es donde se perdía la
        // clave cuando el valor era `undefined`, y con ella el pedido entero.
        const viajado = JSON.parse(JSON.stringify({ ...r.cuerpo, action: 'budget_set' })) as {
          budgetEur?: number;
        };
        expect(Object.hasOwn(viajado, 'budgetEur')).toBe(true);
        expect(viajado.budgetEur).toBe(r.cuerpo.budgetEur);
      }),
      { numRuns: 500 },
    );
  });

  it('para todo importe válido, sembrar el campo y volver a leerlo devuelve el mismo importe', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20_000 }).map((c) => c / 100),
        techoPositivo,
        (eur, techoEur) => {
          const r = presupuestoDelDialogo(textoDeImporte(eur), techoEur);
          // Sólo se puede exigir la vuelta cuando el importe entra en el techo:
          // una celda puede traer un valor que la configuración ya no permite.
          if (eur > techoEur) {
            expect(r.ok).toBe(false);
            return;
          }
          expect(r.ok).toBe(true);
          expect(r.cuerpo?.budgetEur).toBe(eur);
        },
      ),
      { numRuns: 300 },
    );
  });
});
