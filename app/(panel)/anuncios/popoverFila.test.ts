/**
 * Tests de `posicionPopover` (rediseño v3, §Interacciones del handoff).
 *
 * `vitest.config.ts` corre en node sin jsdom, así que no se puede montar el
 * componente: lo que se fija acá es la ARITMÉTICA, que es donde están los dos
 * bugs que el popover puede tener y que no se ven hasta que le pasa a la última
 * fila de la tabla o a la columna de la derecha.
 */

import { describe, expect, it } from 'vitest';
import { ANCHO_POPOVER, posicionPopover } from './PopoverFila';

/** Un marco de tabla típico de desktop: 1240px de ancho, arrancando en y=200. */
const MARCO = { top: 200, left: 40, width: 1240 };

describe('posicionPopover', () => {
  it('cuelga de la fila, en coordenadas del marco y con 6px de aire', () => {
    const r = posicionPopover({
      ancla: { left: 300, right: 340 },
      fila: { top: 400, bottom: 440 },
      marco: MARCO,
      alto: 200,
      altoViewport: 900,
    });

    // 440 (abajo de la fila) − 200 (top del marco) + 6 de aire.
    expect(r.top).toBe(246);
    expect(r.arriba).toBe(false);
    // 300 (el ancla) − 40 (left del marco).
    expect(r.left).toBe(260);
  });

  it('se abre ARRIBA de la fila cuando abajo no entra', () => {
    // La última fila de la página: 40px abajo, y un popover de 300 no entra en
    // los 900 del viewport. Antes esto dejaba Cancelar/Guardar fuera de la
    // pantalla, con el único scroll disponible siendo el de la página —que
    // además movía el popover.
    const r = posicionPopover({
      ancla: { left: 300, right: 340 },
      fila: { top: 820, bottom: 860 },
      marco: MARCO,
      alto: 300,
      altoViewport: 900,
    });

    expect(r.arriba).toBe(true);
    // 820 (arriba de la fila) − 200 (marco) − 300 (alto) − 6 (aire).
    expect(r.top).toBe(314);
  });

  it('el borde exacto: si entra justo, va abajo', () => {
    // bottom 600 + 6 de aire + 294 de alto = 900 = el viewport. Entra.
    const justo = posicionPopover({
      ancla: { left: 300, right: 340 },
      fila: { top: 560, bottom: 600 },
      marco: MARCO,
      alto: 294,
      altoViewport: 900,
    });
    expect(justo.arriba).toBe(false);

    // Un píxel más de alto y ya no entra.
    const unPixelMas = posicionPopover({
      ancla: { left: 300, right: 340 },
      fila: { top: 560, bottom: 600 },
      marco: MARCO,
      alto: 295,
      altoViewport: 900,
    });
    expect(unPixelMas.arriba).toBe(true);
  });

  it('no se sale por la derecha: el menú «⋯» es la última columna', () => {
    // El botón del menú está en x=1260, casi en el canto del marco
    // (40 + 1240 = 1280). Un popover de 288px alineado a ese botón terminaría
    // en 1548: 268px afuera de la pantalla.
    const r = posicionPopover({
      ancla: { left: 1260, right: 1276 },
      fila: { top: 400, bottom: 440 },
      marco: MARCO,
      alto: 200,
      altoViewport: 900,
    });

    // 1240 (ancho del marco) − 288 (popover) − 8 (margen).
    expect(r.left).toBe(1240 - ANCHO_POPOVER - 8);
    // Y el popover entero cae adentro del marco.
    expect(r.left + ANCHO_POPOVER).toBeLessThanOrEqual(MARCO.width);
  });

  it('no se sale por la izquierda cuando el marco es más angosto que el popover', () => {
    // Mobile con la tabla en scroll horizontal: el marco mide 320px y el
    // popover 288. El máximo da 320 − 288 − 8 = 24, que está bien; pero con un
    // marco de 200 daría −96, o sea el popover arrancando fuera de la pantalla.
    // Por eso el mínimo se aplica DESPUÉS del máximo.
    const r = posicionPopover({
      ancla: { left: 10, right: 26 },
      fila: { top: 400, bottom: 440 },
      marco: { top: 200, left: 0, width: 200 },
      alto: 200,
      altoViewport: 900,
    });

    expect(r.left).toBe(8);
  });

  it('el ancla a la izquierda del marco tampoco produce un left negativo', () => {
    const r = posicionPopover({
      ancla: { left: 10, right: 26 },
      fila: { top: 400, bottom: 440 },
      marco: MARCO,
      alto: 200,
      altoViewport: 900,
    });

    // 10 − 40 = −30, acotado al margen.
    expect(r.left).toBe(8);
  });
});
