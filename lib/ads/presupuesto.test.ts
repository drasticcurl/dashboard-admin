import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MINIMO_EUR, parsearPresupuesto, textoDeMotivo, type MotivoPresupuesto } from './presupuesto';

/**
 * Tests de `parsearPresupuesto` (task 1.2 de frescura-y-acciones-anuncios).
 *
 * Este archivo fija dos cosas distintas, y la segunda es la que importa para el
 * bug que el spec vino a arreglar:
 *
 * 1. Los cortes y su ORDEN. La función devuelve un motivo por rechazo, y un
 *    texto puede incumplir varias reglas a la vez: `'0.005'` está bajo el
 *    mínimo Y tiene tres decimales. Cuál de los dos se informa no es un detalle
 *    de implementación, es lo que el usuario lee, así que va pinneado caso por
 *    caso.
 * 2. Que centralizar la regla NO movió el límite entre válido e inválido. La
 *    regla vivía escrita a mano en el `valido` de `FormularioPresupuesto`, y la
 *    Property 4 de abajo la reproduce tal cual para exigir que las dos
 *    coincidan para todo texto y todo techo. Es la guarda de la refactorización:
 *    si alguien "mejora" un corte y con eso empieza a aceptar o rechazar textos
 *    que antes no, este archivo lo detiene antes de que el formulario y el
 *    Endpoint_Acciones vuelvan a discrepar (R1 c5).
 *
 * Función pura: sin base, sin red y sin React, así que no hay nada que mockear.
 */

/** El motivo del rechazo, o `null` si el texto era válido. Existe para que cada
 *  caso borde quepa en una línea, sin repetir el estrechamiento de la unión. */
function motivoDe(texto: string, techoEur: number): MotivoPresupuesto | null {
  const r = parsearPresupuesto(texto, techoEur);
  return r.ok ? null : r.motivo;
}

/** El importe aceptado, o `null` si el texto fue rechazado. */
function valorDe(texto: string, techoEur: number): number | null {
  const r = parsearPresupuesto(texto, techoEur);
  return r.ok ? r.valor : null;
}

const TECHO = 100;

describe('los cortes de parsearPresupuesto, en su orden (R1 c5)', () => {
  it('la cadena vacía y la de sólo espacios son vacio, no bajo_el_minimo', () => {
    // `Number('   ')` es 0, así que sin el corte por vacío estos textos se
    // rechazarían hablando del mínimo de 0,01 frente a un campo en blanco.
    expect(motivoDe('', TECHO)).toBe('vacio');
    expect(motivoDe(' ', TECHO)).toBe('vacio');
    expect(motivoDe('   ', TECHO)).toBe('vacio');
    expect(motivoDe('\t\n', TECHO)).toBe('vacio');
  });

  it('lo que Number no puede interpretar es no_numero, incluidos NaN e Infinity escritos', () => {
    expect(motivoDe('abc', TECHO)).toBe('no_numero');
    expect(motivoDe('1,5', TECHO)).toBe('no_numero'); // coma decimal: el input es type=number, pero pegar texto la deja pasar
    expect(motivoDe('1.2.3', TECHO)).toBe('no_numero');
    expect(motivoDe('NaN', TECHO)).toBe('no_numero');
    expect(motivoDe('Infinity', TECHO)).toBe('no_numero');
    expect(motivoDe('-Infinity', TECHO)).toBe('no_numero');
  });

  it('el cero, los negativos y todo lo que está debajo del mínimo son bajo_el_minimo', () => {
    expect(motivoDe('0', TECHO)).toBe('bajo_el_minimo');
    expect(motivoDe('-0', TECHO)).toBe('bajo_el_minimo');
    expect(motivoDe('-5', TECHO)).toBe('bajo_el_minimo');
    expect(motivoDe('0.009', TECHO)).toBe('bajo_el_minimo');
    // Tres decimales Y bajo el mínimo: gana el corte anterior.
    expect(motivoDe('0.005', TECHO)).toBe('bajo_el_minimo');
  });

  it('el mínimo exacto y el techo exacto son válidos: los dos bordes son cerrados', () => {
    expect(valorDe('0.01', TECHO)).toBe(MINIMO_EUR);
    expect(valorDe('100', TECHO)).toBe(100);
    expect(valorDe('100.00', TECHO)).toBe(100);
  });

  it('el techo más un céntimo es sobre_el_techo', () => {
    expect(motivoDe('100.01', TECHO)).toBe('sobre_el_techo');
    expect(motivoDe('1000', TECHO)).toBe('sobre_el_techo');
    // Sobre el techo Y con tres decimales: gana el corte anterior.
    expect(motivoDe('100.001', TECHO)).toBe('sobre_el_techo');
  });

  it('tres decimales dentro del rango es mas_de_dos_decimales', () => {
    expect(motivoDe('10.005', TECHO)).toBe('mas_de_dos_decimales');
    expect(motivoDe('12.345', TECHO)).toBe('mas_de_dos_decimales');
    expect(motivoDe('0.011', TECHO)).toBe('mas_de_dos_decimales');
  });

  it('la notación exponencial se interpreta como el número que es', () => {
    // `Number('1e2')` es 100: entra al rango y tiene cero decimales.
    expect(valorDe('1e2', TECHO)).toBe(100);
    expect(motivoDe('1e-3', TECHO)).toBe('bajo_el_minimo');
    expect(motivoDe('1e21', TECHO)).toBe('sobre_el_techo');
  });

  it('un techo que no es número rechaza todo importe, con sobre_el_techo', () => {
    // Conserva el comportamiento del `&&` original: con `techoEur` NaN la
    // comparación `n <= techoEur` era falsa y el importe se rechazaba. Se pinnea
    // porque el techo sale de `settings` y una fila ausente puede llegar como NaN.
    expect(motivoDe('10', Number.NaN)).toBe('sobre_el_techo');
    expect(motivoDe('10', 0)).toBe('sobre_el_techo');
  });
});

describe('textoDeMotivo (R1 c6)', () => {
  it('los cinco motivos tienen mensaje, y el del mínimo nombra el importe', () => {
    const motivos: MotivoPresupuesto[] = [
      'vacio',
      'no_numero',
      'bajo_el_minimo',
      'sobre_el_techo',
      'mas_de_dos_decimales',
    ];
    for (const m of motivos) {
      expect(textoDeMotivo(m).length, `mensaje de ${m}`).toBeGreaterThan(0);
    }
    // Con coma decimal, como el resto de los importes del panel.
    expect(textoDeMotivo('bajo_el_minimo')).toContain('0,01');
  });
});

// ─── Generadores ─────────────────────────────────────────────────────────────
// Locales a este archivo y no en `lib/test/generadores-ads.ts`: son textos de un
// campo de formulario, no objetos del dominio, y no los comparte nadie más.

/** Techo en 0,01..5000,00 EUR, siempre positivo. Se genera en céntimos para no
 *  producir techos como 1.4e-45, que ningún `settings` puede tener. */
const techoPositivo: fc.Arbitrary<number> = fc
  .integer({ min: 1, max: 500_000 })
  .map((centimos) => centimos / 100);

/** Lo que el usuario puede dejar en el campo. La mezcla está pesada a propósito
 *  hacia importes bien formados: con puro texto al azar la Property 4 se
 *  cumpliría de forma trivial (todo rechazado) y no probaría el camino válido.
 *  Los literales de abajo son los que `Number` interpreta de forma sorprendente
 *  (hexadecimal, binario, punto suelto, espacios unicode). */
const textoDeCampo: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: -1_000, max: 300_000 }).map((c) => (c / 100).toFixed(2)) },
  { weight: 3, arbitrary: fc.integer({ min: -1_000, max: 300_000 }).map((c) => String(c / 100)) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 300_000 }).map((m) => (m / 1_000).toFixed(3)) },
  {
    weight: 2,
    arbitrary: fc
      .tuple(fc.integer({ min: -99, max: 99 }), fc.integer({ min: -4, max: 22 }))
      .map(([mantisa, exp]) => `${mantisa}e${exp}`),
  },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      '', ' ', '   ', '\t', '\n', '\u00a0', '\ufeff', '\u3000',
      'abc', 'NaN', 'Infinity', '-Infinity', '1,5', '1.2.3', '1_000',
      '0x10', '0b11', '0o17', '+5', '-0', '.5', '5.', '0', '0.01', '0.001',
    ),
  },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 300_000 }).map((c) => `  ${c / 100}  `) },
  { weight: 1, arbitrary: fc.string({ maxLength: 12 }) },
);

// Feature: frescura-y-acciones-anuncios, Property 4: Conservación del importe
//
// **Validates: Requirements 1.5**
//
// La mitad de la propiedad que vive en este módulo: que lo que la regla acepta
// es exactamente lo que cumple las tres condiciones, y que aceptar/rechazar es
// lo mismo que hacía la regla suelta del formulario. La otra mitad (que el
// importe aceptado es el que viaja en el payload) se verifica en la task 3.2,
// donde vive `ejecutarLote`.
describe('Property 4 (R1 c5)', () => {
  it('para todo texto y todo techo positivo, un ok trae un importe entre el mínimo y el techo y con a lo sumo dos decimales', () => {
    fc.assert(
      fc.property(textoDeCampo, techoPositivo, (texto, techoEur) => {
        const r = parsearPresupuesto(texto, techoEur);
        if (!r.ok) {
          // El rechazo siempre trae motivo, y el motivo siempre tiene mensaje:
          // es lo que hace imposible el `Required` sin campo del route (R1 c6).
          expect(textoDeMotivo(r.motivo).length).toBeGreaterThan(0);
          return;
        }
        expect(Number.isFinite(r.valor)).toBe(true);
        expect(r.valor).toBeGreaterThanOrEqual(MINIMO_EUR);
        expect(r.valor).toBeLessThanOrEqual(techoEur);
        expect(Number(r.valor.toFixed(2))).toBe(r.valor);
        // El importe es el del texto, no una versión redondeada de él.
        expect(r.valor).toBe(Number(texto));
      }),
      { numRuns: 500 },
    );
  });

  it('para todo texto y todo techo positivo, aceptar coincide con la regla que estaba escrita a mano en el formulario', () => {
    /** La regla original, copiada tal cual del `valido` de
     *  `FormularioPresupuesto.tsx` antes de centralizarla. Se deja duplicada
     *  A PROPÓSITO: es el oráculo de la refactorización. */
    const reglaOriginal = (texto: string, techoEur: number): boolean => {
      const n = Number(texto);
      return (
        texto !== '' &&
        Number.isFinite(n) &&
        n >= 0.01 &&
        n <= techoEur &&
        Number(n.toFixed(2)) === n
      );
    };

    fc.assert(
      fc.property(textoDeCampo, techoPositivo, (texto, techoEur) => {
        expect(
          parsearPresupuesto(texto, techoEur).ok,
          `texto ${JSON.stringify(texto)} con techo ${techoEur}`,
        ).toBe(reglaOriginal(texto, techoEur));
      }),
      { numRuns: 500 },
    );
  });
});
