import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { alcanceDeTotales, detalleDeTotales } from './GestorAnuncios';
import type { NivelAds } from '@/lib/ads/tipos';

/**
 * El rótulo de la barra de KPIs (task 17.2 de frescura-y-acciones-anuncios,
 * R7.2 y R7.4).
 *
 * Los números de la barra ya son del filtro completo —los calcula el SQL de
 * `getMetricasAds` y los verifica `lib/queries/ads.totales*.test.ts`—. Lo que se
 * fija acá es lo otro que pide R7: que la pantalla DIGA sobre qué están
 * calculados, porque un total del filtro con el rótulo «Gasto» a secas se sigue
 * leyendo como una caída de gasto cuando el usuario cambia el filtro de estado.
 *
 * `alcanceDeTotales` y `detalleDeTotales` son puras y viven en
 * `GestorAnuncios.tsx` porque son la forma de esta pantalla y no del dominio; se
 * importan desde acá igual que `presupuestoDelDialogo` en
 * `presupuestoDialogo.test.ts`. Sin base, sin red y sin render.
 */

const NIVELES: NivelAds[] = ['campaign', 'adset', 'ad'];
const ESTADOS = ['active', 'paused', 'any'] as const;

const base = {
  filasFiltro: 10,
  filasPantalla: 10,
  nombre: '',
  cascada: null,
  ocultarSinDatos: false,
  ocultarPadreApagado: false,
};

describe('el alcance del rótulo: nivel + estado (R7.4)', () => {
  it('nombra el nivel y el estado con la concordancia de cada nivel', () => {
    expect(alcanceDeTotales('campaign', 'active')).toBe('campañas activas');
    expect(alcanceDeTotales('adset', 'active')).toBe('conjuntos activos');
    expect(alcanceDeTotales('ad', 'paused')).toBe('anuncios pausados');
    expect(alcanceDeTotales('campaign', 'paused')).toBe('campañas pausadas');
  });

  it('con el estado en «Cualquiera» no inventa un adjetivo', () => {
    // El filtro no recorta por estado: decir «activas» sería la mentira inversa.
    expect(alcanceDeTotales('campaign', 'any')).toBe('campañas');
    expect(alcanceDeTotales('adset', 'any')).toBe('conjuntos');
    expect(alcanceDeTotales('ad', 'any')).toBe('anuncios');
  });

  it('el rótulo que se arma con él distingue los dos estados del mismo nivel', () => {
    // Es el caso del reporte: el mismo período, el filtro de estado cambiado, y
    // dos números de gasto distintos que ahora se explican solos.
    expect(`Gasto de ${alcanceDeTotales('adset', 'active')}`).toBe('Gasto de conjuntos activos');
    expect(`Gasto de ${alcanceDeTotales('adset', 'paused')}`).toBe('Gasto de conjuntos pausados');
  });
});

describe('la línea de contexto de la barra (R7.2)', () => {
  it('dice cuántas filas del filtro, y nada más si no hay otros filtros', () => {
    expect(detalleDeTotales(base)).toBe('Sobre 10 filas del filtro');
  });

  it('aclara «no las N en pantalla» sólo cuando la página muestra menos', () => {
    expect(detalleDeTotales({ ...base, filasFiltro: 1234, filasPantalla: 500 })).toBe(
      'Sobre 1.234 filas del filtro, no las 500 en pantalla',
    );
    // Filtro entero en una página: no hay ambigüedad que aclarar.
    expect(detalleDeTotales({ ...base, filasFiltro: 7, filasPantalla: 7 })).toBe(
      'Sobre 7 filas del filtro',
    );
  });

  it('concuerda el singular y sobrevive al filtro vacío', () => {
    expect(detalleDeTotales({ ...base, filasFiltro: 1, filasPantalla: 1 })).toBe(
      'Sobre 1 fila del filtro',
    );
    expect(detalleDeTotales({ ...base, filasFiltro: 0, filasPantalla: 0 })).toBe(
      'Sobre 0 filas del filtro',
    );
  });

  it('enumera los filtros que no entran en el rótulo', () => {
    const texto = detalleDeTotales({
      filasFiltro: 34,
      filasPantalla: 20,
      nombre: 'promo',
      cascada: { nivel: 'campaign', ids: ['1', '2', '3'] },
      ocultarSinDatos: true,
      ocultarPadreApagado: true,
    });
    expect(texto).toBe(
      'Sobre 34 filas del filtro, no las 20 en pantalla · nombre contiene «promo» · ' +
        'dentro de 3 campañas · sin las filas sin datos · sin las que tienen el padre apagado',
    );
  });

  it('la cascada nombra el nivel del padre y concuerda en singular', () => {
    expect(detalleDeTotales({ ...base, cascada: { nivel: 'campaign', ids: ['9'] } })).toContain(
      'dentro de 1 campaña',
    );
    expect(detalleDeTotales({ ...base, cascada: { nivel: 'adset', ids: ['9', '8'] } })).toContain(
      'dentro de 2 conjuntos',
    );
    // Una cascada sin ids no está filtrando nada y no se anuncia.
    expect(detalleDeTotales({ ...base, cascada: { nivel: 'adset', ids: [] } })).toBe(
      'Sobre 10 filas del filtro',
    );
  });
});

describe('la línea no depende de la página (Property 9, del lado del rótulo)', () => {
  it('para todo par de tamaños de página, la cantidad de filas del filtro que declara es la misma', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 5000 }),
        (filasFiltro, a, b) => {
          const pagA = Math.min(a, filasFiltro);
          const pagB = Math.min(b, filasFiltro);
          const declara = (filasPantalla: number): string =>
            detalleDeTotales({ ...base, filasFiltro, filasPantalla }).split(',')[0]!;
          // La página cambia qué se aclara, nunca el total sobre el que se
          // afirma que están calculados los KPIs.
          expect(declara(pagA)).toBe(declara(pagB));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('para todo nivel y estado, el alcance nombra el nivel', () => {
    fc.assert(
      fc.property(fc.constantFrom(...NIVELES), fc.constantFrom(...ESTADOS), (nivel, status) => {
        const sustantivo = { campaign: 'campañas', adset: 'conjuntos', ad: 'anuncios' }[nivel];
        expect(alcanceDeTotales(nivel, status)).toContain(sustantivo);
      }),
    );
  });
});
