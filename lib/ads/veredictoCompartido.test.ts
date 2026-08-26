import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { leerNumeroEscrito, parsearMonto } from '../monto';
import { MINIMO_EUR, parsearPresupuesto } from './presupuesto';
import { numeroDeCampo } from '@/app/(panel)/anuncios/reglas/ReglasView';
import {
  RUIDO,
  techoPositivo,
  textoDeC,
  textoDeCConSigno,
  textoDeCampo,
  textoDeFamiliaE,
} from '../test/preservacion-montos';

/**
 * Feature: parseo-montos-anuncios — Property 4: Veredicto compartido
 *
 * **Validates: Requirements 2.4**
 *
 * LAS TRES PANTALLAS LEEN EL MISMO NÚMERO. Finanzas (`parsearMonto`), el
 * presupuesto de Anuncios (`parsearPresupuesto`) y los campos de Reglas
 * (`numeroDeCampo`) coinciden en si un texto nombra un número y en CUÁL es. Pueden
 * diferir en ACEPTARLO —cada una tiene sus cortes de rango, de signo y de
 * decimales—, pero no en qué dice el texto.
 *
 * ─── QUÉ VERIFICA DE VERDAD ─────────────────────────────────────────────────
 *
 * Que la cláusula 2.4 se cumplió COMPARTIENDO el núcleo y no escribiendo una
 * cuarta copia que casualmente hoy coincide. Un `Number()` suelto que alguien
 * agregue mañana en cualquiera de las tres rompe una de las tres patas de abajo,
 * y el contraejemplo trae el texto exacto.
 *
 * La propiedad está escrita sobre «QUÉ NÚMERO DICE» y no sobre «lo acepta», que es
 * la distinción que la hace verdadera y no vacía. Las tres políticas que hacen que
 * aceptar difiera legítimamente:
 *
 *   · **Finanzas** rechaza el signo (lo pone el tipo de movimiento), exige mayor
 *     que cero, dos decimales como máximo y menos que el tope de `numeric(14,2)`;
 *   · **el presupuesto** tiene mínimo (0,01) y techo (el de `settings`), y también
 *     corta en dos decimales;
 *   · **Reglas** rechaza un texto sin ningún dígito (el núcleo resuelve `'.'` como
 *     0 y acá no hay mínimo que lo ataje: «gasto > .» se guardaría como «gasto >
 *     0», o sea «pausá todo») y pliega la finitud adentro de `error`.
 *
 * Las tres están escritas abajo como checklist, así que la tercera pata no dice
 * «rechazó, y estará bien»: exige que el rechazo sea ATRIBUIBLE a un corte
 * declarado de esa pantalla.
 *
 * ─── POR QUÉ ESTE ARCHIVO IMPORTA DE `app/` ─────────────────────────────────
 *
 * `numeroDeCampo` vive en `ReglasView.tsx` porque es la política de esa pantalla,
 * no del dominio. El import cruzado es de un TEST, que es el único caso en que el
 * repo lo hace (`lib/queries/ads.zonas.test.ts` importa `reglas/_server`); ningún
 * módulo de producción de `lib/` importa de `app/`, y esta propiedad no cambia eso.
 * Vive en `lib/ads/` y no en la carpeta del panel porque las otras dos pantallas
 * de las tres son las de acá.
 *
 * Todo es puro: no hay base, ni red, ni render.
 */

/** El tope de `numeric(14,2)`, el mismo corte que `parsearMonto` aplica. Es el
 *  único número de la política de Finanzas que no está exportado. */
const MAX_FINANZAS = 1_000_000_000_000;

/** Los textos con los que se mide: los del campo compartido más las tres formas
 *  ambiguas (la Bug_Condition, la regla ancha y la misma con signo) y ruido puro,
 *  que es donde vivía el bug que nadie escribió a mano. */
const textoDePantalla: fc.Arbitrary<string> = fc.oneof(
  { weight: 8, arbitrary: textoDeCampo },
  { weight: 2, arbitrary: textoDeC },
  { weight: 1, arbitrary: textoDeFamiliaE },
  { weight: 1, arbitrary: textoDeCConSigno },
  { weight: 1, arbitrary: fc.string({ maxLength: 8 }) },
);

// Feature: parseo-montos-anuncios, Property 4: el veredicto es el mismo en las
// tres pantallas
//
// **Validates: Requirements 2.4**
describe('Property 4: el veredicto es el mismo en las tres pantallas', () => {
  it('para todo texto, las tres coinciden en si nombra un número y en cuál es, y todo rechazo es de una política declarada', () => {
    let aceptaFinanzas = 0;
    let aceptaPresupuesto = 0;
    let aceptaReglas = 0;
    let coincidenDos = 0;

    fc.assert(
      fc.property(textoDePantalla, techoPositivo, (texto, techoEur) => {
        const nucleo = leerNumeroEscrito(texto);
        const finanzas = parsearMonto(texto);
        const presupuesto = parsearPresupuesto(texto, techoEur);
        const reglas = numeroDeCampo(texto);
        const contexto = `${JSON.stringify(texto)} (techo ${techoEur})`;

        // ─── Pata 1: si el texto no nombra ningún número, NINGUNA acepta ─────
        //
        // Es la dirección que protege del bug: un texto ambiguo («1.000») no lo
        // puede aceptar una pantalla y rechazar otra, porque el que decide si
        // nombra un número es uno solo.
        if (!nucleo.ok) {
          expect(finanzas.ok, `${contexto}: Finanzas acepta un texto sin número`).toBe(false);
          expect(presupuesto.ok, `${contexto}: el presupuesto acepta un texto sin número`).toBe(false);
          expect(reglas.estado, `${contexto}: Reglas acepta un texto sin número`).not.toBe('ok');
          return;
        }

        const n = nucleo.valor;

        // ─── Pata 2: la que acepta, acepta EXACTAMENTE ese número ───────────
        //
        // De acá sale el corolario que el diseño enuncia: si dos pantallas aceptan
        // el mismo texto, el número es el mismo, porque las dos son iguales a n.
        if (finanzas.ok) {
          aceptaFinanzas++;
          expect(finanzas.valor, `${contexto}: Finanzas lee otro número`).toBe(n);
        }
        if (presupuesto.ok) {
          aceptaPresupuesto++;
          expect(presupuesto.valor, `${contexto}: el presupuesto lee otro número`).toBe(n);
        }
        if (reglas.estado === 'ok') {
          aceptaReglas++;
          expect(reglas.valor, `${contexto}: Reglas lee otro número`).toBe(n);
        }
        if ([finanzas.ok, presupuesto.ok, reglas.estado === 'ok'].filter(Boolean).length >= 2) {
          coincidenDos++;
        }

        // ─── Pata 3: el que rechaza un número que el texto SÍ dice, lo rechaza
        //             por un corte declarado de su propia política ────────────
        //
        // Sin esta pata la propiedad se cumpliría con una pantalla que rechaza
        // todo. Cada checklist es la política de esa pantalla y nada más: si un
        // rechazo no entra en ninguna, es un parseo escondido y el contraejemplo
        // lo nombra.
        const limpio = texto.replace(RUIDO, '');
        if (!finanzas.ok) {
          const politicaDeFinanzas =
            limpio.startsWith('-') || // el signo lo pone el tipo de movimiento
            nucleo.decimales > 2 || // numeric(14,2)
            !Number.isFinite(n) ||
            n <= 0 ||
            n >= MAX_FINANZAS;
          expect(politicaDeFinanzas, `${contexto}: Finanzas rechaza ${n} sin política — ${finanzas.error}`).toBe(true);
        }
        if (!presupuesto.ok) {
          const politicaDelPresupuesto =
            texto.trim() === '' ||
            !Number.isFinite(n) ||
            !(n >= MINIMO_EUR) ||
            !(n <= techoEur) ||
            Number(n.toFixed(2)) !== n;
          expect(
            politicaDelPresupuesto,
            `${contexto}: el presupuesto rechaza ${n} sin política — ${presupuesto.motivo}`,
          ).toBe(true);
        }
        if (reglas.estado !== 'ok') {
          const politicaDeReglas =
            texto.trim() === '' || // el campo en blanco es su propio estado
            !/\d/.test(texto) || // sin dígitos no hay número, aunque el núcleo lea 0
            !Number.isFinite(n);
          expect(politicaDeReglas, `${contexto}: Reglas rechaza ${n} sin política — ${reglas.estado}`).toBe(true);
        }
      }),
      { numRuns: 1_000 },
    );

    // Las tres aceptan una parte apreciable de los textos: sin esto, una pantalla
    // que rechazara todo dejaría las patas 1 y 3 pasando y la 2 sin ejecutarse
    // nunca. Los pisos están muy por debajo de lo medido (≈340, ≈600 y ≈370 de
    // 1000) para no depender de la semilla.
    expect(aceptaFinanzas, 'textos que Finanzas acepta').toBeGreaterThan(50);
    expect(aceptaPresupuesto, 'textos que el presupuesto acepta').toBeGreaterThan(50);
    expect(aceptaReglas, 'textos que Reglas acepta').toBeGreaterThan(50);
    expect(coincidenDos, 'textos que al menos dos pantallas aceptan').toBeGreaterThan(50);
  });

  /**
   * La tabla concreta: los textos que separan «qué número dice» de «lo acepta».
   * Está pinneada caso por caso porque es la que se lee cuando alguien duda de por
   * qué las tres pueden discrepar en el veredicto sin discrepar en el número, y
   * porque no depende de ninguna semilla.
   *
   * `lee` es el número que el texto dice, o `null` si no dice ninguno. Las tres
   * columnas de aceptación son el veredicto de cada pantalla con techo 5000.
   */
  it('la tabla de los textos que separan «qué número dice» de «lo acepta»', () => {
    const TECHO = 5_000;
    const casos: readonly {
      texto: string;
      lee: number | null;
      finanzas: boolean;
      presupuesto: boolean;
      reglas: boolean;
      nota: string;
    }[] = [
      // Lo que las tres leen y las tres aceptan.
      { texto: '1000', lee: 1000, finanzas: true, presupuesto: true, reglas: true, nota: 'mil es mil en las tres' },
      { texto: '12,50', lee: 12.5, finanzas: true, presupuesto: true, reglas: true, nota: 'la coma decimal (2.2)' },
      { texto: '€5', lee: 5, finanzas: true, presupuesto: true, reglas: true, nota: 'el ruido se limpia (2.5)' },
      { texto: '1.234,56', lee: 1234.56, finanzas: true, presupuesto: true, reglas: true, nota: 'miles y decimal' },
      // Ninguna lee un número: no hay veredicto que comparar, hay rechazo en las tres.
      { texto: '1.000', lee: null, finanzas: false, presupuesto: false, reglas: false, nota: 'la Bug_Condition' },
      { texto: '1000.000', lee: null, finanzas: false, presupuesto: false, reglas: false, nota: 'la regla ancha' },
      { texto: '-1.000', lee: null, finanzas: false, presupuesto: false, reglas: false, nota: 'familia (g), el signo no la esquiva' },
      { texto: '1e3', lee: null, finanzas: false, presupuesto: false, reglas: false, nota: 'exponencial: ya no se interpreta (2.5)' },
      { texto: '1.00.000', lee: null, finanzas: false, presupuesto: false, reglas: false, nota: 'agrupación mal formada' },
      { texto: 'abc', lee: null, finanzas: false, presupuesto: false, reglas: false, nota: 'sin número' },
      { texto: '', lee: null, finanzas: false, presupuesto: false, reglas: false, nota: 'el campo en blanco' },
      // LAS TRES POLÍTICAS: el número es el mismo y el veredicto no.
      { texto: '-5', lee: -5, finanzas: false, presupuesto: false, reglas: true, nota: 'el signo: Finanzas lo prohíbe, el presupuesto lo lee bajo el mínimo, una condición «ganancia < -5» es legítima' },
      { texto: '0', lee: 0, finanzas: false, presupuesto: false, reglas: true, nota: 'el 0: Finanzas exige > 0, el presupuesto tiene mínimo, «ventas <= 0» es una condición deliberada (3.9)' },
      { texto: '0,005', lee: 0.005, finanzas: false, presupuesto: false, reglas: true, nota: 'tres decimales: los dos importes cortan en dos, un ROI no' },
      { texto: '5000,01', lee: 5000.01, finanzas: true, presupuesto: false, reglas: true, nota: 'el techo de la cuenta es sólo del presupuesto' },
      { texto: '.', lee: 0, finanzas: false, presupuesto: false, reglas: false, nota: 'familia (f): el núcleo lo resuelve como 0 y las tres lo rechazan, cada una por su corte' },
    ];

    for (const c of casos) {
      const nucleo = leerNumeroEscrito(c.texto);
      const leido = nucleo.ok ? nucleo.valor : null;
      expect(leido, `${JSON.stringify(c.texto)} — ${c.nota}`).toBe(c.lee);
      expect(parsearMonto(c.texto).ok, `Finanzas con ${JSON.stringify(c.texto)}`).toBe(c.finanzas);
      expect(parsearPresupuesto(c.texto, TECHO).ok, `presupuesto con ${JSON.stringify(c.texto)}`).toBe(c.presupuesto);
      expect(numeroDeCampo(c.texto).estado === 'ok', `Reglas con ${JSON.stringify(c.texto)}`).toBe(c.reglas);
    }

    // Y la mitad que la tabla existe para demostrar: donde dos aceptan, el número
    // es el mismo, incluso cuando la tercera rechaza.
    const dobles = casos.filter((c) => [c.finanzas, c.presupuesto, c.reglas].filter(Boolean).length >= 2);
    expect(dobles.length, 'casos donde al menos dos aceptan').toBeGreaterThan(4);
    for (const c of dobles) {
      const numeros = [
        parsearMonto(c.texto),
        parsearPresupuesto(c.texto, TECHO),
      ]
        .filter((r): r is { ok: true; valor: number } => r.ok)
        .map((r) => r.valor);
      const enReglas = numeroDeCampo(c.texto);
      if (enReglas.estado === 'ok') numeros.push(enReglas.valor);
      for (const v of numeros) expect(v, `${JSON.stringify(c.texto)}: dos pantallas, dos números`).toBe(c.lee);
    }
  });
});
