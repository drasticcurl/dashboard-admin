import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  armarCurvaRetencion,
  calcularTasasPitch,
  grillaHitos,
  type PitchContadores,
} from './pitch';

/**
 * Las funciones puras del A/B del pitch.
 *
 * Todo acá corre SIN base: `calcularTasasPitch` y `armarCurvaRetencion` son
 * aritmética que se equivoca en silencio (un porcentaje mal calculado se ve
 * perfectamente creíble en pantalla), así que van vigiladas aparte de la query.
 */

function contador(brazo: string, over: Partial<PitchContadores> = {}): PitchContadores {
  return {
    brazo,
    vistasUpsell: 0,
    clicks: 0,
    ventas: 0,
    ventasVip: 0,
    revenue: 0,
    revenueVip: 0,
    conSonido: 0,
    reveladoEnSec: null,
    ...over,
  };
}

/**
 * Tuplas de contadores que la base puede devolver de verdad.
 *
 * El tramo del upsell es jerárquico —`ventas ⊆ clicks ⊆ vistasUpsell`— y encadenar
 * los rangos cubre ceros en cualquier posición sin filtrar. Generar ventas sin
 * clicks produciría tuplas imposibles y un `pctCierre` arriba de 100 que no
 * representa ningún estado real.
 *
 * `conSonido` cuelga de `vistasUpsell` (no se puede activar el sonido de un video
 * que no se vio) pero es independiente de los clicks: se puede escuchar todo el
 * pitch y no comprar.
 *
 * `ventasVip` cuelga de `vistasUpsell` y NO de `ventas`: son dos `EXISTS`
 * independientes en la query, así que nada garantiza que el VIP sea un subconjunto
 * de las ventas del upsell. En producción lo es (nadie compró VIP sin upsell), pero
 * el generador tiene que poder producir el caso contrario para que las tasas se
 * prueben también ahí — es justamente el caso en el que un `(+N VIP)` pegado a las
 * ventas mentiría.
 */
const contadores = fc
  .integer({ min: 0, max: 1000 })
  .chain((vistasUpsell) =>
    fc.tuple(
      fc.constant(vistasUpsell),
      fc.integer({ min: 0, max: vistasUpsell }), // conSonido
      fc.integer({ min: 0, max: vistasUpsell }), // clicks
    ),
  )
  .chain(([vistasUpsell, conSonido, clicks]) =>
    fc.integer({ min: 0, max: clicks }).chain((ventas) =>
      fc
        .tuple(
          fc.integer({ min: 0, max: vistasUpsell }), // ventasVip: NO acotado por ventas
          fc.integer({ min: 0, max: 5_000_000 }), // revenue (upsell, sin VIP)
          fc.integer({ min: 0, max: 5_000_000 }), // revenueVip
        )
        .map(([ventasVip, revenue, revenueVip]) => ({
          vistasUpsell,
          conSonido,
          clicks,
          ventas,
          ventasVip,
          revenue,
          revenueVip,
          reveladoEnSec: null as number | null,
        })),
    ),
  );

describe('calcularTasasPitch (pura)', () => {
  it('las cuatro tasas son el cociente en %, quedan en [0,100] y valen 0 con denominador 0', () => {
    fc.assert(
      fc.property(contadores, (c) => {
        const [fila] = calcularTasasPitch([{ brazo: 'pitch_A', ...c }]);
        expect(fila!.pctVentas).toBe(c.vistasUpsell === 0 ? 0 : (c.ventas / c.vistasUpsell) * 100);
        expect(fila!.pctClicks).toBe(c.vistasUpsell === 0 ? 0 : (c.clicks / c.vistasUpsell) * 100);
        expect(fila!.pctCierre).toBe(c.clicks === 0 ? 0 : (c.ventas / c.clicks) * 100);
        expect(fila!.pctConSonido).toBe(
          c.vistasUpsell === 0 ? 0 : (c.conSonido / c.vistasUpsell) * 100,
        );

        for (const tasa of [
          fila!.pctVentas,
          fila!.pctClicks,
          fila!.pctCierre,
          fila!.pctConSonido,
        ]) {
          expect(Number.isFinite(tasa)).toBe(true);
          expect(tasa).toBeGreaterThanOrEqual(0);
          expect(tasa).toBeLessThanOrEqual(100);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('la plata por vista es el cociente exacto y vale 0 sin vistas, sin quedar acotada a 100', () => {
    fc.assert(
      fc.property(contadores, (c) => {
        const [fila] = calcularTasasPitch([{ brazo: 'pitch_A', ...c }]);
        expect(fila!.revenuePorVista).toBe(
          c.vistasUpsell === 0 ? 0 : c.revenue / c.vistasUpsell,
        );
        expect(Number.isFinite(fila!.revenuePorVista)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * La plata del VIP NO puede tocar la columna que decide.
   *
   * Es la regresión de un error que estuvo en producción: `revenue` sumaba
   * `tier IN ('upsell','upsell2')`, así que la facturación de `/upsell2` —otra
   * página, aguas abajo del pitch— entraba en el ARS/vista del test. Con los datos
   * reales del 2026-08-28 le movía la ventaja del brazo A del 10,8 % al 13,5 % con
   * 2 ventas de VIP de diferencia.
   */
  it('revenueVip NO entra en la plata por vista, por más grande que sea', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 50_000_000 }), (revenueVip) => {
        const [fila] = calcularTasasPitch([
          contador('pitch_A', { vistasUpsell: 200, ventas: 20, revenue: 400_000, revenueVip }),
        ]);
        // Siempre 400000/200 = 2000, sin importar cuánto facturó el VIP.
        expect(fila!.revenuePorVista).toBe(2000);
      }),
      { numRuns: 100 },
    );
  });

  it('ventasVip no altera ninguna tasa: es informativa y vive en su propia columna', () => {
    const sinVip = calcularTasasPitch([
      contador('pitch_A', { vistasUpsell: 100, clicks: 30, ventas: 15 }),
    ])[0]!;
    const conVip = calcularTasasPitch([
      contador('pitch_A', { vistasUpsell: 100, clicks: 30, ventas: 15, ventasVip: 9 }),
    ])[0]!;
    expect(conVip.pctVentas).toBe(sinVip.pctVentas);
    expect(conVip.pctCierre).toBe(sinVip.pctCierre);
    expect(conVip.revenuePorVista).toBe(sinVip.revenuePorVista);
  });

  it('denominador 0 da 0 y NUNCA NaN ni Infinity, que es lo que llegaría al JSON', () => {
    const [fila] = calcularTasasPitch([contador('pitch_A', { revenue: 99_000 })]);
    expect(fila!.pctVentas).toBe(0);
    expect(fila!.pctCierre).toBe(0);
    expect(fila!.revenuePorVista).toBe(0);

    // Las tasas se chequean UNA POR UNA y no con un `not.toContain('null')` sobre
    // la fila entera: `reveladoEnSec` es null legítimamente (ningún evento trajo
    // el segundo) y ese null no tiene nada de malo. El que no puede aparecer es
    // el que sale de serializar un NaN, y ese solo puede venir de estos cinco.
    const json = JSON.stringify({
      pctVentas: fila!.pctVentas,
      pctClicks: fila!.pctClicks,
      pctCierre: fila!.pctCierre,
      pctConSonido: fila!.pctConSonido,
      revenuePorVista: fila!.revenuePorVista,
    });
    expect(json).not.toContain('null');
    expect(json).not.toContain('NaN');
  });

  it('ordena por brazo alfabético, decidido en TS y no por la collation de la base', () => {
    const filas = calcularTasasPitch([contador('pitch_B'), contador('pitch_A')]);
    expect(filas.map((f) => f.brazo)).toEqual(['pitch_A', 'pitch_B']);
  });
});

describe('grillaHitos (pura)', () => {
  it('espeja la grilla despareja del funnel: 5, 15, 30 y de ahí cada 60', () => {
    expect(grillaHitos(300)).toEqual([5, 15, 30, 60, 120, 180, 240, 300]);
  });

  it('es estrictamente creciente para cualquier techo', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2000 }), (hasta) => {
        const g = grillaHitos(hasta);
        for (let i = 1; i < g.length; i++) expect(g[i]!).toBeGreaterThan(g[i - 1]!);
      }),
      { numRuns: 100 },
    );
  });
});

describe('armarCurvaRetencion (pura)', () => {
  it('la curva NUNCA sube: es una acumulada inversa sobre el máximo por sesión', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            brazo: fc.constantFrom('pitch_A', 'pitch_B'),
            maxSec: fc.integer({ min: 1, max: 500 }),
            sesiones: fc.integer({ min: 1, max: 200 }),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        (filas) => {
          const curva = armarCurvaRetencion(filas, ['pitch_A', 'pitch_B']);
          for (const brazo of ['pitch_A', 'pitch_B']) {
            for (let i = 1; i < curva.length; i++) {
              // Con tolerancia de punto flotante: son divisiones.
              expect(curva[i]!.pct[brazo]!).toBeLessThanOrEqual(curva[i - 1]!.pct[brazo]! + 1e-9);
              expect(curva[i]!.sesiones[brazo]!).toBeLessThanOrEqual(curva[i - 1]!.sesiones[brazo]!);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('cada brazo con datos arranca en 100 %, así se compara la FORMA de la caída', () => {
    const curva = armarCurvaRetencion(
      [
        { brazo: 'pitch_A', maxSec: 400, sesiones: 20 },
        { brazo: 'pitch_A', maxSec: 60, sesiones: 80 },
        // Diez veces menos tráfico: en absolutos parecería retener peor.
        { brazo: 'pitch_B', maxSec: 400, sesiones: 2 },
        { brazo: 'pitch_B', maxSec: 60, sesiones: 8 },
      ],
      ['pitch_A', 'pitch_B'],
    );
    expect(curva[0]!.pct['pitch_A']).toBeCloseTo(100, 6);
    expect(curva[0]!.pct['pitch_B']).toBeCloseTo(100, 6);
    // Y con la misma forma, las dos curvas coinciden pese al 10× de diferencia.
    for (const p of curva) {
      expect(p.pct['pitch_A']).toBeCloseTo(p.pct['pitch_B']!, 6);
    }
  });

  it('un brazo sin un solo evento conserva su clave en 0 y no desaparece del gráfico', () => {
    // Deducir los brazos de las filas dejaría a pitch_B afuera y recharts
    // dibujaría una serie menos sin avisar.
    const curva = armarCurvaRetencion(
      [{ brazo: 'pitch_A', maxSec: 120, sesiones: 10 }],
      ['pitch_A', 'pitch_B'],
    );
    expect(curva.length).toBeGreaterThan(0);
    for (const p of curva) {
      expect(p.sesiones).toHaveProperty('pitch_B');
      expect(p.sesiones['pitch_B']).toBe(0);
      expect(p.pct['pitch_B']).toBe(0);
    }
  });

  it('el segundo exacto del flush final cae en su hito y no crea un bucket propio', () => {
    // El flush emite un segundo fuera de la grilla (47). Contando eventos por
    // hito habría un punto en 47; tomando el máximo por sesión, esa sesión
    // simplemente llegó hasta el hito de 30 y no al de 60.
    const curva = armarCurvaRetencion([{ brazo: 'pitch_A', maxSec: 47, sesiones: 5 }], ['pitch_A']);
    expect(curva.map((p) => p.segundo)).toEqual([5, 15, 30]);
    expect(curva.at(-1)!.sesiones['pitch_A']).toBe(5);
  });

  it('sin datos devuelve una curva vacía, que la UI pinta como estado vacío', () => {
    expect(armarCurvaRetencion([], ['pitch_A'])).toEqual([]);
    expect(armarCurvaRetencion([{ brazo: 'pitch_A', maxSec: 0, sesiones: 3 }], ['pitch_A'])).toEqual(
      [],
    );
    // Sin brazos tampoco hay curva, aunque haya filas.
    expect(armarCurvaRetencion([{ brazo: 'pitch_A', maxSec: 60, sesiones: 3 }], [])).toEqual([]);
  });

  it('ningún punto lleva NaN ni Infinity al JSON', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            brazo: fc.constantFrom('pitch_A', 'pitch_B'),
            maxSec: fc.integer({ min: 0, max: 400 }),
            sesiones: fc.integer({ min: 0, max: 100 }),
          }),
          { maxLength: 20 },
        ),
        (filas) => {
          const json = JSON.stringify(armarCurvaRetencion(filas, ['pitch_A', 'pitch_B']));
          expect(json).not.toContain('NaN');
          expect(json).not.toContain('Infinity');
        },
      ),
      { numRuns: 150 },
    );
  });
});
