import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MINIMO_EUR, parsearPresupuesto, textoDeMotivo, type MotivoPresupuesto } from './presupuesto';
import { leerNumeroEscrito } from '../monto';

/**
 * Tests de `parsearPresupuesto` (task 1.2 de frescura-y-acciones-anuncios).
 *
 * Lo que este archivo fija son **los cortes y su ORDEN**. La función devuelve un
 * motivo por rechazo, y un texto puede incumplir varias reglas a la vez:
 * `'0,005'` está bajo el mínimo Y tiene tres decimales. Cuál de los dos se
 * informa no es un detalle de implementación, es lo que el usuario lee, así que
 * va pinneado caso por caso.
 *
 * Función pura: sin base, sin red y sin React, así que no hay nada que mockear.
 *
 * ─── LO QUE CAMBIÓ EN LA TASK 3.6 DE `parseo-montos-anuncios` ───────────────
 *
 * Este archivo era, además, la guarda de la refactorización anterior: fijaba que
 * centralizar la regla NO había movido el límite entre válido e inválido,
 * comparando contra la `reglaOriginal` copiada del `valido` de
 * `FormularioPresupuesto` (R1 c5). **Ese rol se retiró acá y vive ahora en
 * `lib/ads/presupuesto.preservacion.test.ts`**, y el motivo está escrito abajo,
 * donde estaba la property: `parseo-montos-anuncios` MUEVE ese límite a
 * propósito, así que un oráculo `Number()` sin el predicado de las excepciones
 * declaradas no puede seguir siendo la guarda.
 *
 * Los casos que cambiaron de veredicto son los cinco de la tabla
 * §Preservation Checking → «Los cinco casos existentes que sí cambian» del
 * diseño, y están **declarados de antemano**: cada uno afirma acá el veredicto
 * NUEVO, con el viejo anotado al lado. Donde el caso viejo era lo único que
 * probaba un orden de cortes (el mínimo ganándole a los decimales, el techo
 * ganándole a los decimales), se **reescribió con coma** en lugar de borrarse:
 * la coma es la otra forma de escribir tres decimales y ahora se lee (2.2), así
 * que la cobertura del corte se conserva textualmente.
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

  it('lo que no nombra ningún número es no_numero, incluidos NaN e Infinity escritos', () => {
    // `'1,5'` estaba en esta lista y ya NO está: pasó a ser un importe válido, y
    // se afirma como tal en el test de la coma, abajo (caso 1 de los cinco).
    expect(motivoDe('abc', TECHO)).toBe('no_numero');
    expect(motivoDe('1.2.3', TECHO)).toBe('no_numero');
    expect(motivoDe('NaN', TECHO)).toBe('no_numero');
    expect(motivoDe('Infinity', TECHO)).toBe('no_numero');
    expect(motivoDe('-Infinity', TECHO)).toBe('no_numero');
  });

  it('la coma decimal se lee, como en Finanzas: «1,5» es un importe y no no_numero (2.2)', () => {
    // CASO 1 DE LOS CINCO CAMBIOS DECLARADOS. Hoy daba `no_numero` porque
    // `Number('1,5')` es NaN, y no era el caso raro sino el NORMAL: en castellano
    // la coma es el separador decimal. Ahora qué número dice el texto lo decide
    // el núcleo compartido, que es el mismo de Finanzas (2.2, 2.4).
    expect(valorDe('1,5', TECHO)).toBe(1.5);
    expect(valorDe('100,50', 5_000)).toBe(100.5);
  });

  it('el cero, los negativos y todo lo que está debajo del mínimo son bajo_el_minimo', () => {
    expect(motivoDe('0', TECHO)).toBe('bajo_el_minimo');
    expect(motivoDe('-0', TECHO)).toBe('bajo_el_minimo');
    expect(motivoDe('-5', TECHO)).toBe('bajo_el_minimo');
    // CASO 2 DE LOS CINCO: `'0.009'` y `'0.005'` ya NO llegan al corte del
    // mínimo, porque los dos están dentro de la Bug_Condition (un punto, tres
    // dígitos a la derecha) y el corte de la ambigüedad es anterior. Su veredicto
    // nuevo se afirma en el test de la ambigüedad, abajo.
    //
    // Los mismos dos importes ESCRITOS CON COMA sí llegan hasta acá, y es lo que
    // conserva la cobertura de este orden de cortes: tres decimales Y bajo el
    // mínimo sigue informando el mínimo, que es lo único que el caso viejo
    // probaba y lo único que se perdería si se borrara.
    expect(motivoDe('0,009', TECHO)).toBe('bajo_el_minimo');
    expect(motivoDe('0,005', TECHO)).toBe('bajo_el_minimo');
  });

  it('el mínimo exacto y el techo exacto son válidos: los dos bordes son cerrados', () => {
    expect(valorDe('0.01', TECHO)).toBe(MINIMO_EUR);
    expect(valorDe('100', TECHO)).toBe(100);
    expect(valorDe('100.00', TECHO)).toBe(100);
  });

  it('el techo más un céntimo es sobre_el_techo', () => {
    expect(motivoDe('100.01', TECHO)).toBe('sobre_el_techo');
    expect(motivoDe('1000', TECHO)).toBe('sobre_el_techo');
    // CASO 2, la otra mitad: `'100.001'` está dentro de la Bug_Condition y pasa a
    // `ambiguo` (se afirma abajo). Con coma llega igual hasta el techo, así que
    // «sobre el techo Y con tres decimales gana el techo» sigue probado.
    expect(motivoDe('100,001', TECHO)).toBe('sobre_el_techo');
  });

  it('tres decimales dentro del rango es mas_de_dos_decimales', () => {
    // CASO 3 DE LOS CINCO. Los tres textos de este corte —`'10.005'`,
    // `'12.345'`, `'0.011'`— están dentro de la Bug_Condition y pasan a
    // `ambiguo`. El corte de decimales NO desapareció, y por eso el caso se
    // REESCRIBE CON COMA en lugar de borrarse: `'10,005'` son los mismos tres
    // decimales por el camino que ahora se lee, y es el único texto que sigue
    // llegando hasta este corte.
    expect(motivoDe('10,005', TECHO)).toBe('mas_de_dos_decimales');
  });

  it('los textos de la Bug_Condition son ambiguo, y ese corte va antes del mínimo, del techo y de los decimales', () => {
    // CASOS 2 y 3 DE LOS CINCO, con el veredicto nuevo. Los seis textos tienen la
    // misma forma —un punto y EXACTAMENTE tres dígitos a la derecha— y se
    // rechazaban por tres motivos distintos, ninguno de los cuales ofrecía las dos
    // lecturas posibles del texto: `'1.000'` es mil o uno, y un campo de plata no
    // adivina (2.1).
    //
    // El `// hoy:` de cada línea es la columna «Hoy» de la tabla del diseño, o sea
    // el veredicto del oráculo congelado en `presupuesto.preservacion.test.ts`,
    // que es donde esos seis rechazos siguen estando afirmados de los dos lados.
    //
    // Que este corte esté ANTES del mínimo, del techo y de los decimales es lo que
    // se pinnea acá: los tres motivos viejos hablaban de rango o de precisión
    // sobre un número que el sistema había elegido solo.
    expect(motivoDe('0.009', TECHO)).toBe('ambiguo'); // hoy: bajo_el_minimo
    expect(motivoDe('0.005', TECHO)).toBe('ambiguo'); // hoy: bajo_el_minimo
    expect(motivoDe('100.001', TECHO)).toBe('ambiguo'); // hoy: sobre_el_techo
    expect(motivoDe('10.005', TECHO)).toBe('ambiguo'); // hoy: mas_de_dos_decimales
    expect(motivoDe('12.345', TECHO)).toBe('ambiguo'); // hoy: mas_de_dos_decimales
    expect(motivoDe('0.011', TECHO)).toBe('ambiguo'); // hoy: mas_de_dos_decimales
  });

  it('la notación exponencial se rechaza: un importe lleva sólo números, coma o punto (2.5)', () => {
    // CASO 4 DE LOS CINCO, y es un cambio DELIBERADO de comportamiento:
    // `Number('1e2')` es 100, así que el importe se aceptaba, `'1e-3'` se
    // rechazaba por el mínimo y `'1e21'` por el techo. Los tres pasan a
    // `no_numero`, o sea de «se interpreta» a «se rechaza», porque nadie
    // tipea notación exponencial en un campo de plata queriendo decir un importe;
    // es la familia (c) de §Alcance, y va anotado para que no se «arregle» de
    // vuelta.
    expect(motivoDe('1e2', TECHO)).toBe('no_numero'); // hoy: válido, 100
    expect(motivoDe('1e-3', TECHO)).toBe('no_numero'); // hoy: bajo_el_minimo
    expect(motivoDe('1e21', TECHO)).toBe('no_numero'); // hoy: sobre_el_techo
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
// cumple las tres condiciones, y que el importe aceptado es exactamente el que el
// texto dice. La otra mitad (que ese importe es el que viaja en el payload) se
// verifica en la task 3.2, donde vive `ejecutarLote`.
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
        // El importe es el del texto, no una versión redondeada de él. Se compara
        // contra el NÚCLEO y no contra `Number(texto)`, que era el parseo viejo
        // escrito acá adentro: `Number('1,5')` es NaN, así que esta aserción
        // fallaba con el contraejemplo `["1,5", 1.5]` —«expected 1.5 to be NaN»—
        // en cuanto el generador sacaba un texto con coma. Las otras cuatro
        // aserciones de este test (finitud, mínimo, techo, dos decimales) valen
        // igual que antes; la única que hablaba de `Number` es ésta.
        //
        // El núcleo es el que decide qué número dice el texto en las tres
        // pantallas (2.4), así que preguntarle a él es lo que la propiedad quiso
        // decir siempre: el importe no es una reinterpretación del texto.
        const leido = leerNumeroEscrito(texto);
        expect(leido.ok, `el núcleo tiene que leer ${JSON.stringify(texto)}`).toBe(true);
        if (leido.ok) expect(r.valor).toBe(leido.valor);
      }),
      { numRuns: 500 },
    );
  });

  // ─── LA MITAD QUE SE RETIRÓ EN LA TASK 3.6, Y POR QUÉ ─────────────────────
  //
  // Acá vivía «aceptar coincide con la regla que estaba escrita a mano en el
  // formulario»: una property con la `reglaOriginal` copiada del `valido` de
  // `FormularioPresupuesto.tsx`, o sea `Number(texto)` más los tres cortes,
  // exigiendo que `parsearPresupuesto(...).ok` diera lo mismo para todo texto y
  // todo techo. Era el oráculo de la refactorización ANTERIOR (R1 c5), cuando
  // centralizar la regla no tenía que mover el límite entre válido e inválido.
  //
  // `parseo-montos-anuncios` MUEVE ese límite a propósito, así que la property
  // pasó a fallar en cualquier flip de aceptación: el contraejemplo que dejó fue
  // `["0o17", 15]` —hoy `Number('0o17')` es 15 y el importe se aceptaba, ahora es
  // `no_numero` (familia (c), cláusula 2.5)—. No es un fallo aislado ni una
  // semilla desafortunada: `1e2`, `0x10`, `0b11`, `+5`, `€5`, `1 000`, `100,50` y
  // todos los textos de C rompen la misma aserción.
  //
  // NO SE AFLOJÓ Y NO SE BORRÓ EN SILENCIO: su cobertura quedó subsumida, y con
  // MÁS fuerza, por la Property 2 de `lib/ads/presupuesto.preservacion.test.ts`,
  // que compara contra EL MISMO oráculo `Number()` congelado —también duplicado a
  // propósito— con tres cosas que esta property no tenía:
  //
  //   · el predicado de las SIETE familias de excepción declaradas (a–g de
  //     §Alcance), así que un flip que NO esté declarado sigue siendo un
  //     contraejemplo en lugar de un fallo permanente;
  //   · la comparación campo por campo (`ok`, `valor` y MOTIVO), donde acá sólo se
  //     comparaba el booleano `ok`: un texto que pasa de rechazarse por
  //     `mas_de_dos_decimales` a rechazarse por `sobre_el_techo` es otro mensaje
  //     en la pantalla y esta property no lo veía;
  //   · la tabla de flips (Guarda 2), que exige que cada familia DEMUESTRE su
  //     cambio con los dos veredictos, y que es lo que impide ensanchar el
  //     predicado para tapar un flip nuevo.
  //
  // La razón de que viva allá y no acá está escrita en el plan: el oráculo
  // congelado tiene que estar en un archivo distinto de los que la task 3.6 edita,
  // para que no se lo toque por arrastre. Mantener una segunda copia del mismo
  // oráculo en este archivo es, además, el error que este spec vino a arreglar una
  // escala más arriba: la misma regla escrita dos veces, ensanchándose por
  // separado.
});
