/**
 * Tests de la parte pura de `insights.ts`: la huella y el guard de alucinación.
 *
 * No toca la base (el pool de `lib/db` es lazy, así que importar el módulo no
 * abre ninguna conexión) y por eso no lleva `skipIf`.
 *
 * Lo que se verifica acá es lo que no se puede verificar mirando la pantalla:
 * que la huella sea estable ante un refactor pero no ante un cambio de datos, y
 * que una cita inventada se caiga. Las dos son invisibles si están mal —la
 * primera sólo se nota en la factura, la segunda sólo si alguien va a chequear un
 * número a mano.
 */

import { describe, expect, it } from 'vitest';
import { canonicalizar, huellaDe, parsearValorCitado, validarEvidencia } from './insights';
import type { Insight } from './openai';

describe('canonicalizar', () => {
  it('ordena las claves: reordenar campos no invalida la caché', () => {
    // El escenario: alguien reordena dos campos del tipo del brief. No cambió
    // ningún dato, así que la huella no puede cambiar — si cambiara, un refactor
    // cosmético regeneraría todos los insights y pagaría por nada.
    expect(canonicalizar({ b: 1, a: 2 })).toBe(canonicalizar({ a: 2, b: 1 }));
  });

  it('ordena en profundidad, no sólo el primer nivel', () => {
    expect(canonicalizar({ x: { d: 1, c: 2 } })).toBe(canonicalizar({ x: { c: 2, d: 1 } }));
  });

  it('respeta el orden de los arrays: ahí el orden ES el dato', () => {
    // Los funnels vienen ordenados por neto y la serie de días es cronológica.
    // Ordenar arrays perdería esa información.
    expect(canonicalizar([1, 2])).not.toBe(canonicalizar([2, 1]));
  });

  it('distingue null de 0 y de ausente', () => {
    expect(canonicalizar({ a: null })).not.toBe(canonicalizar({ a: 0 }));
    expect(canonicalizar({ a: null })).not.toBe(canonicalizar({}));
  });
});

describe('huellaDe', () => {
  it('los mismos datos dan la misma huella', () => {
    expect(huellaDe({ a: 1, b: [2, 3] })).toBe(huellaDe({ b: [2, 3], a: 1 }));
  });

  it('un número distinto da una huella distinta', () => {
    expect(huellaDe({ neto: 3000 })).not.toBe(huellaDe({ neto: 3001 }));
  });

  it('agregar un campo invalida la caché, y tiene que hacerlo', () => {
    expect(huellaDe({ a: 1 })).not.toBe(huellaDe({ a: 1, b: 2 }));
  });
});

describe('parsearValorCitado', () => {
  it('lee el formato plano', () => {
    expect(parsearValorCitado('3100.2')).toBe(3100.2);
    expect(parsearValorCitado('-500')).toBe(-500);
    expect(parsearValorCitado('0.0432')).toBe(0.0432);
  });

  it('lee el formato es-AR con punto de miles y coma decimal', () => {
    expect(parsearValorCitado('3.100,20')).toBe(3100.2);
    expect(parsearValorCitado('12.345,67')).toBe(12345.67);
  });

  it('lee una coma sola como decimal', () => {
    // Es como escribe un modelo al que se le pidió castellano.
    expect(parsearValorCitado('4,32')).toBe(4.32);
  });

  it('tolera el signo de porcentaje y el símbolo de moneda', () => {
    expect(parsearValorCitado('4,32 %')).toBe(4.32);
    expect(parsearValorCitado('€ 1234.56')).toBe(1234.56);
    expect(parsearValorCitado('EUR 900')).toBe(900);
  });

  it('devuelve null para lo que no es número', () => {
    expect(parsearValorCitado('mercado pago')).toBeNull();
    expect(parsearValorCitado('')).toBeNull();
  });
});

// ─── El guard de alucinación ────────────────────────────────────────────────

const BRIEF = {
  moneda: 'EUR',
  totales: { netoEur: 3000, adsEur: 1000, margenNeto: 0.8571 },
  funnels: [{ slug: 'reset', resultadoEur: -250, embudo: { checkoutAOrden: 0.0432 } }],
};

function insight(evidencia: { metrica: string; valor: string }[]): Insight {
  return { titulo: 't', cuerpo: 'c', tono: 'info', evidencia };
}

describe('validarEvidencia', () => {
  it('acepta una cita que coincide exacto con el brief', () => {
    const r = validarEvidencia([insight([{ metrica: 'totales.netoEur', valor: '3000' }])], BRIEF);

    expect(r.validados).toHaveLength(1);
    expect(r.validados[0]!.evidencia).toHaveLength(1);
    expect(r.citasDescartadas).toBe(0);
  });

  it('acepta un ratio citado como porcentaje', () => {
    // El brief tiene 0.0432 y el prompt le pide escribirlo como 4,32 %. Citar
    // 4.32 es correcto, no una invención.
    const r = validarEvidencia(
      [insight([{ metrica: 'embudo.checkoutAOrden', valor: '4,32 %' }])],
      BRIEF,
    );

    expect(r.citasDescartadas).toBe(0);
    expect(r.validados[0]!.evidencia).toHaveLength(1);
  });

  it('descarta un número que no está en el brief', () => {
    // 3500 no existe en ningún lado: el modelo lo inventó o lo calculó de cabeza,
    // y las dos cosas son motivo suficiente para no mostrarlo.
    const r = validarEvidencia(
      [
        insight([
          { metrica: 'totales.netoEur', valor: '3000' },
          { metrica: 'totales.brutoEur', valor: '3500' },
        ]),
      ],
      BRIEF,
    );

    expect(r.citasDescartadas).toBe(1);
    expect(r.validados[0]!.evidencia).toHaveLength(1);
    expect(r.validados[0]!.evidencia[0]!.valor).toBe('3000');
  });

  it('descarta el insight entero si NINGUNA de sus citas existe', () => {
    // Es el caso que justifica todo el guard: un insight cuyos números no salen
    // del brief no es un insight, es una invención con formato.
    const r = validarEvidencia(
      [
        insight([{ metrica: 'totales.netoEur', valor: '99999' }]),
        insight([{ metrica: 'totales.adsEur', valor: '1000' }]),
      ],
      BRIEF,
    );

    expect(r.insightsDescartados).toBe(1);
    expect(r.validados).toHaveLength(1);
    expect(r.validados[0]!.evidencia[0]!.valor).toBe('1000');
  });

  it('conserva un insight sin evidencia', () => {
    // "Faltan saldos por cargar" no tiene un número que citar y sigue siendo lo
    // más útil que se puede decir.
    const r = validarEvidencia([insight([])], BRIEF);

    expect(r.validados).toHaveLength(1);
    expect(r.insightsDescartados).toBe(0);
  });

  it('acepta un valor de texto que está en el brief', () => {
    const r = validarEvidencia(
      [insight([{ metrica: 'funnels[0].slug', valor: 'reset' }])],
      BRIEF,
    );

    expect(r.citasDescartadas).toBe(0);
  });

  it('acepta un número negativo tal como está', () => {
    const r = validarEvidencia(
      [insight([{ metrica: 'funnels[0].resultadoEur', valor: '-250' }])],
      BRIEF,
    );

    expect(r.citasDescartadas).toBe(0);
  });

  it('encuentra números anidados en cualquier profundidad', () => {
    const r = validarEvidencia(
      [insight([{ metrica: 'x', valor: '0.8571' }])],
      BRIEF,
    );

    expect(r.citasDescartadas).toBe(0);
  });
});
