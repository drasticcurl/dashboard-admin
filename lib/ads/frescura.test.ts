/**
 * Los números del margen del umbral de relectura (spec `toggle-conjuntos-entrega`,
 * task 11.1).
 *
 * **Este archivo es la aritmética, no la decisión.** Que `causaDeRelectura` use
 * esta suma —y que las dos cotas del margen valgan para todo umbral que `settings`
 * pueda tener— lo verifica la Property 1 de `lib/ads/acciones.margen.test.ts`, que
 * cuantifica sobre el umbral en lugar de fijarlo en 900. Acá se fijan los valores
 * concretos: el par del mundo real, los degenerados y la decisión sobre el margen
 * fraccionario, que es la única de las tres que no es obvia leyendo el código.
 *
 * Que el 900 del período siga siendo el del crontab del repo lo verifica
 * `frescura.cron.test.ts`. Los tres archivos son piezas distintas de R2.3 y
 * ninguno reemplaza a los otros dos.
 *
 * Puro: sin base y sin red.
 */

import { describe, expect, it } from 'vitest';

import {
  PERIODO_SYNC_JERARQUIA_SEGUNDOS,
  UMBRAL_FRESCURA_DEFAULT_SEGUNDOS,
  margenDeRelectura,
  umbralDeRelectura,
} from './frescura';

describe('el par del mundo real (umbral 900, período 900)', () => {
  it('los dos 900 son el 900 de verdad: el seed de la 025 y el schedule del cron', () => {
    // No es una tautología: son DOS números de dos fuentes distintas que hoy
    // coinciden, y el bug 1 es justamente que su coincidencia no estaba escrita en
    // ningún lado. Si alguno se mueve, lo que sigue deja de describir la realidad
    // y hay que releer las dos cotas con los números nuevos.
    expect(UMBRAL_FRESCURA_DEFAULT_SEGUNDOS).toBe(900);
    expect(PERIODO_SYNC_JERARQUIA_SEGUNDOS).toBe(900);
  });

  it('el margen es la mitad del período: 450 s', () => {
    expect(margenDeRelectura(PERIODO_SYNC_JERARQUIA_SEGUNDOS)).toBe(450);
  });

  it('el umbral de relectura es la SUMA y no la resta: 1350 s, no 675', () => {
    expect(
      umbralDeRelectura(UMBRAL_FRESCURA_DEFAULT_SEGUNDOS, PERIODO_SYNC_JERARQUIA_SEGUNDOS),
    ).toBe(1350);

    // El signo, fijado por test y no sólo por comentario. `pisoDeFrescura` de
    // `live.ts` RESTA su margen porque allá `edad < piso ⇒ está fresco`; acá la
    // comparación es `edad > umbral ⇒ releé`, así que restar dispararía la
    // relectura en MÁS clicks que hoy. 675 es el número que este test prohíbe.
    expect(
      umbralDeRelectura(UMBRAL_FRESCURA_DEFAULT_SEGUNDOS, PERIODO_SYNC_JERARQUIA_SEGUNDOS),
    ).not.toBe(675);
  });

  it('las dos cotas se cumplen con esos números: absorbe una corrida y es menor que el período', () => {
    const margen = margenDeRelectura(PERIODO_SYNC_JERARQUIA_SEGUNDOS);

    // Cota inferior: 450 s de corrida es siete minutos y medio, y el comentario de
    // `deploy/cron.panel` declara la corrida barata (una llamada por cuenta y por
    // nivel). **No medido**: el diseño lo declara elegido por argumento.
    expect(margen).toBeGreaterThan(0);

    // Cota superior, la que hace compatibles 2.1 y 2.2: con `margen >= período`,
    // un objeto que se perdió una corrida (edad ≈ 2 × período = 1800 s) dejaría de
    // disparar la relectura, porque `2 × período > período + margen ⟺ margen < período`.
    expect(margen).toBeLessThan(PERIODO_SYNC_JERARQUIA_SEGUNDOS);
    expect(2 * PERIODO_SYNC_JERARQUIA_SEGUNDOS).toBeGreaterThan(
      umbralDeRelectura(PERIODO_SYNC_JERARQUIA_SEGUNDOS, PERIODO_SYNC_JERARQUIA_SEGUNDOS),
    );
  });
});

describe('los degenerados', () => {
  it('período 0: margen 0 y el umbral de relectura queda igual al umbral', () => {
    // Un período 0 no es un cron: es el número que quedaría si alguien borrara la
    // línea del crontab y pusiera la constante en 0. El margen desaparece y el
    // comportamiento vuelve a ser el de HOY —sin margen—, que es la degeneración
    // correcta: no hay período que absorber.
    expect(margenDeRelectura(0)).toBe(0);
    expect(umbralDeRelectura(900, 0)).toBe(900);
  });

  it('umbral 0: el umbral de relectura es exactamente el margen', () => {
    // `topesDeSettings` acepta el 0 (`r.umbral >= 0`), así que este caso llega de
    // verdad. Con umbral 0 la relectura se dispararía en TODO click sin el margen;
    // con el margen se dispara a partir de los 450 s. Sigue siendo un umbral que
    // nadie querría, y no es este módulo el que lo tiene que arreglar.
    expect(umbralDeRelectura(0, 900)).toBe(450);
  });

  it('umbral MENOR que el período: el margen no lo rescata, y eso está declarado', () => {
    // El límite del docblock de `umbralDeRelectura`, fijado por test para que quede
    // claro que es una consecuencia aceptada y no un caso que se olvidó: 510 s
    // sigue siendo menor que los 900 del período, así que un objeto sano cruza el
    // umbral igual y la relectura se dispara en la mayoría de los clicks.
    expect(umbralDeRelectura(60, 900)).toBe(510);
    expect(umbralDeRelectura(60, 900)).toBeLessThan(PERIODO_SYNC_JERARQUIA_SEGUNDOS);

    // Lo que este test PROHÍBE es la defensa silenciosa que se descartó: con
    // `max(umbral, período) + margen` esto daría 1350 y el 60 del operador se
    // habría ignorado sin decir nada.
    expect(umbralDeRelectura(60, 900)).not.toBe(1350);
  });
});

describe('el margen fraccionario: la decisión es NO redondear', () => {
  it('un período impar deja medio segundo, y el medio segundo se conserva', () => {
    expect(margenDeRelectura(901)).toBe(450.5);
    expect(umbralDeRelectura(900, 901)).toBe(1350.5);

    // Los dos redondeos posibles, prohibidos explícitamente para que nadie los
    // agregue «por prolijidad»: no cambian ninguna decisión y esconderían que el
    // número es una división.
    expect(margenDeRelectura(901)).not.toBe(450);
    expect(margenDeRelectura(901)).not.toBe(451);
  });

  it('para toda edad entera, el umbral fraccionario decide igual que su piso', () => {
    // Ésta es la razón de la decisión, y se verifica en lugar de afirmarse. La edad
    // sale de un `Math.floor` en `edadEnSegundos` (`lib/ads/acciones.ts`), así que
    // el dominio real de la comparación son los enteros. Exhaustivo sobre el rango
    // que contiene los dos bordes (1350.5 y 1350) y no una muestra: si hubiera una
    // sola edad entera en la que los dos difieren, está acá.
    const umbralFraccionario = umbralDeRelectura(900, 901); // 1350.5
    const umbralPiso = Math.floor(umbralFraccionario); // 1350

    for (let edad = 0; edad <= 2000; edad++) {
      expect(edad > umbralFraccionario, `edad=${edad}`).toBe(edad > umbralPiso);
    }
  });
});
