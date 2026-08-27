/**
 * Los números del peor caso del servidor y del plazo del cliente (spec
 * `toggle-conjuntos-entrega`, task 16.1).
 *
 * **Este archivo es la aritmética, no el cableado.** Que el `init` del POST lleve
 * de verdad `plazoClienteEstadoMs(1)` y que el lote use `plazoClienteEstadoMs(n)`
 * lo verifica `app/(panel)/anuncios/togglePlazo.test.ts`, que además lee los
 * timeouts del código fuente de `lib/ads/meta.ts` en lugar de importarlos: ahí la
 * afirmación es «los dos lados salen del mismo número», acá es «la suma es esta».
 * Que `refrescoEnCaminoCritico()` no esté mintiendo sobre el route lo verifica
 * `app/api/ads/acciones/route.diferido.test.ts`. Los tres son piezas distintas de
 * R2.7 y R2.8 y ninguno reemplaza a los otros dos.
 *
 * ## Por qué los dos mundos del flag se pasan por parámetro
 *
 * `refrescoEnCaminoCritico()` hoy devuelve `false` —la tanda C entró— así que un
 * test que sólo llame a `peorCasoEstadoMs(n)` verificaría la columna post-C y
 * dejaría la pre-C escrita en un comentario y nunca ejecutada. El segundo
 * parámetro de las dos funciones existe para eso y para nada más: ningún llamador
 * de producción lo pasa. Los números pre-C importan porque son los que el plan
 * ordena usar si D se shippea antes de C (§Las dos cosas que no se pueden
 * recuperar, escenario 2), y un número que nadie corrió no es un número.
 *
 * Puro: sin base y sin red.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  HOLGURA_CLIENTE_MS,
  PLAZO_META_ESCRITURA_MS,
  PLAZO_META_LECTURA_MS,
  PRESUPUESTO_RELECTURA_MS,
  peorCasoEstadoMs,
  plazoClienteEstadoMs,
  refrescoEnCaminoCritico,
} from './plazos';

/** Los dos mundos, nombrados, para que las tablas de abajo se lean. */
const POST_C = false; // la relectura salió del camino crítico (task 14.2)
const PRE_C = true; // `refrescarJerarquia` todavía en el `await` del route

describe('las constantes de las que sale todo', () => {
  it('son las que los timeouts de Meta declaran hoy', () => {
    // No es tautología: son los números que `lib/ads/meta.ts` le pasa a sus dos
    // `AbortSignal.timeout`. Si alguien baja el de `enviar`, este test cambia y el
    // plazo del cliente baja con él, que es justamente lo que la task 10 compró.
    expect(PLAZO_META_ESCRITURA_MS).toBe(30_000);
    expect(PLAZO_META_LECTURA_MS).toBe(30_000);
    expect(PRESUPUESTO_RELECTURA_MS).toBe(4_000);
    expect(HOLGURA_CLIENTE_MS).toBe(10_000);
  });
});

describe('peorCasoEstadoMs — el mundo post-C, que es el de hoy', () => {
  it('el flag dice que la relectura NO está en el camino crítico', () => {
    // Si esto falla, el resto de este describe está midiendo el otro mundo y los
    // números de abajo son los equivocados. La guarda de que el flag coincide con
    // el route es `route.diferido.test.ts`, no este archivo.
    expect(refrescoEnCaminoCritico()).toBe(POST_C);
  });

  it('n=1: 34 s, y el default del parámetro es el flag', () => {
    expect(peorCasoEstadoMs(1, POST_C)).toBe(34_000);
    // Sin el segundo argumento tiene que dar lo mismo: el default es el flag y no
    // una copia suya.
    expect(peorCasoEstadoMs(1)).toBe(34_000);
  });

  it('n=2: 64 s — el mismo número que un solo objeto daba PRE-C, y no es casualidad', () => {
    // 4 000 + 2 × 30 000 = 64 000, igual que 4 000 + 1 × 60 000. Es el número que
    // hacía que el 60 s del lote «alcanzara por casualidad» para un objeto y
    // fallara para dos, y es el contraejemplo con el que la property de
    // `togglePlazo.test.ts` shrinkeaba a n=2.
    expect(peorCasoEstadoMs(2, POST_C)).toBe(64_000);
  });

  it('n=20: 604 s, con el presupuesto de la relectura FUERA del producto', () => {
    expect(peorCasoEstadoMs(20, POST_C)).toBe(604_000);

    // La corrección al material de entrada, fijada por test: contarlo por objeto
    // daría 20 × 34 000 = 680 000. `relecturaSelectiva` calcula su `limite` una
    // sola vez antes del loop, así que los 4 s son del lote entero.
    expect(peorCasoEstadoMs(20, POST_C)).not.toBe(20 * 34_000);
  });
});

describe('peorCasoEstadoMs — el mundo pre-C, que es el que vale si D se shippea antes que C', () => {
  it('n=1: 64 s', () => {
    expect(peorCasoEstadoMs(1, PRE_C)).toBe(64_000);
  });

  it('n=2: 124 s', () => {
    expect(peorCasoEstadoMs(2, PRE_C)).toBe(124_000);
  });

  it('n=20: 1204 s, y no 1280 s', () => {
    expect(peorCasoEstadoMs(20, PRE_C)).toBe(1_204_000);

    // Los dos números que el reporte inicial daba y que esta corrección descarta:
    // `n × 64 s` con la relectura adentro del producto.
    expect(peorCasoEstadoMs(20, PRE_C)).not.toBe(20 * 64_000);
  });

  it('la tanda C parte el peor caso por objeto exactamente al medio', () => {
    // 30 000 de los 60 000 por objeto. Es la razón por la que el plazo de la fila
    // baja de 74 s a 44 s cuando C entra, sin que nadie toque un número.
    for (const n of [1, 2, 20]) {
      expect(peorCasoEstadoMs(n, PRE_C) - peorCasoEstadoMs(n, POST_C)).toBe(
        n * PLAZO_META_LECTURA_MS,
      );
    }
  });
});

describe('plazoClienteEstadoMs — los cuatro números que el diseño fija', () => {
  it('n=1: 44 s post-C, 74 s pre-C', () => {
    expect(plazoClienteEstadoMs(1, POST_C)).toBe(44_000);
    expect(plazoClienteEstadoMs(1, PRE_C)).toBe(74_000);
    // El que el toggle de UNA fila usa de verdad, con el flag de hoy.
    expect(plazoClienteEstadoMs(1)).toBe(44_000);
  });

  it('n=2: 74 s post-C, 134 s pre-C', () => {
    expect(plazoClienteEstadoMs(2, POST_C)).toBe(74_000);
    expect(plazoClienteEstadoMs(2, PRE_C)).toBe(134_000);
  });

  it('n=20: 614 s post-C, 1214 s pre-C', () => {
    expect(plazoClienteEstadoMs(20, POST_C)).toBe(614_000);
    expect(plazoClienteEstadoMs(20, PRE_C)).toBe(1_214_000);
  });

  it('el techo de 300 s está descartado por test y no sólo por comentario', () => {
    // Con un techo de 300 s —los mismos de `duplicate`— todo lote de más de 5
    // objetos volvería a violar R2.7. Acá está el borde exacto, para que nadie
    // proponga el techo de nuevo sin ver a partir de dónde rompe.
    const TECHO_DESCARTADO = 300_000;
    expect(peorCasoEstadoMs(5, POST_C)).toBeLessThan(TECHO_DESCARTADO); // 154 s: entraría
    expect(peorCasoEstadoMs(10, POST_C)).toBeGreaterThan(TECHO_DESCARTADO); // 304 s: ya no
  });
});

// Feature: toggle-conjuntos-entrega, Property 3: Expected Behavior — El plazo del
// cliente cubre el peor caso del servidor
//
// **Validates: Requirements 2.7, 2.8**
describe('Property 3: el plazo del cliente cubre el peor caso, para todo n y en los dos mundos', () => {
  it('plazoClienteEstadoMs(n) > peorCasoEstadoMs(n)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000 }), fc.boolean(), (n, refrescoDentro) => {
        const peorCaso = peorCasoEstadoMs(n, refrescoDentro);
        const plazo = plazoClienteEstadoMs(n, refrescoDentro);

        expect(
          plazo,
          `n=${n}, refresco ${refrescoDentro ? 'DENTRO' : 'fuera'} del camino crítico: ` +
            `plazo ${plazo} ms contra un peor caso de ${peorCaso} ms`,
        ).toBeGreaterThan(peorCaso);

        // Y por cuánto: exactamente la holgura, ni más ni menos. Un plazo que
        // superara el peor caso «por algo» sería tan poco verificable como el 60 s
        // que este spec vino a corregir.
        expect(plazo - peorCaso).toBe(HOLGURA_CLIENTE_MS);
      }),
      { numRuns: 300 },
    );
  });

  it('el peor caso crece con n, así que el plazo nunca se queda corto al agregar objetos', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 999 }), fc.boolean(), (n, refrescoDentro) => {
        // La otra mitad de R2.7 que un plazo fijo no podía cumplir: el 60 s de hoy
        // es monótono en nada, y por eso alcanzaba para un objeto y no para dos.
        expect(plazoClienteEstadoMs(n + 1, refrescoDentro)).toBeGreaterThan(
          plazoClienteEstadoMs(n, refrescoDentro),
        );
      }),
      { numRuns: 200 },
    );
  });
});
