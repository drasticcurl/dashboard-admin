import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CATALOGO_METRICAS,
  CLAVES_BASE,
  CLAVES_FIJAS,
  celdasDeFila,
  columnasParaRender,
  entrada,
  formatear,
  valorDeMetrica,
} from './catalogo';
import type { ClaveOrden, MetricasObjeto } from './tipos';
import { genColumnasVisibles, genMetricasObjeto } from '../test/generadores-ads';

/**
 * Tests de ejemplo del Catalogo_Metricas (task 3.4). Las propiedades ejecutables
 * P1 (estructura de la tabla) y P2 (formateo total) viven en las tasks 3.2 y 3.3.
 */

const BASE_ESPERADAS = [
  'seleccion',
  'nombre',
  'estado',
  'presupuesto',
  'ultimaActualizacion',
  'ventas',
  'cpa',
  'gastos',
  'ingresos',
  'ganancia',
  'roas',
  'roi',
];

function fila(level: MetricasObjeto['level'], objectName: string | null): MetricasObjeto {
  return {
    level,
    objectId: 'obj_1',
    objectName,
    accountId: 'act_1',
    campaignId: 'camp_1',
    adsetId: level === 'campaign' ? '' : 'set_1',
    adId: level === 'ad' ? 'obj_1' : '',
    funnelId: null,
    status: 'ACTIVE',
    effectiveStatus: 'ACTIVE',
    budgetLevel: 'adset',
    budgetMode: 'daily',
    dailyBudgetEur: 25,
    spendEur: 40,
    impressions: 100,
    clicks: 5,
    sales: 2,
    revenueEur: 100,
    refundedEur: 0,
    commissionsEur: 5,
    costsEur: 15,
    netEur: 80,
    profitEur: 40,
    roas: 2.5,
    roi: 2,
    cpaEur: 20,
    ctr: 0.05,
    cpcEur: 8,
    ultimaAccionAt: '2026-08-12T10:00:00Z',
    cpmEur: 400,
    hookRate: 0.5,
    videoReproducciones: 50,
    videoThruplay: 10,
    videoP25: 30,
    videoP50: 20,
    videoP75: 15,
    videoP100: 10,
    alcance: 80,
    frecuencia: 1.25,
    inicioProgramado: null,
  };
}

describe('Catalogo_Metricas (R2 c1, c2, c4)', () => {
  it('tiene 27 entradas, con clave única, rótulo de 1..40 y definición de 1..240', () => {
    expect(CATALOGO_METRICAS).toHaveLength(27);
    const claves = CATALOGO_METRICAS.map((e) => e.clave);
    expect(new Set(claves).size).toBe(27);
    for (const e of CATALOGO_METRICAS) {
      expect(e.rotulo.length, `rótulo de ${e.clave}`).toBeGreaterThanOrEqual(1);
      expect(e.rotulo.length, `rótulo de ${e.clave}`).toBeLessThanOrEqual(40);
      expect(e.definicion.length, `definición de ${e.clave}`).toBeGreaterThanOrEqual(1);
      expect(e.definicion.length, `definición de ${e.clave}`).toBeLessThanOrEqual(240);
    }
  });

  it('las Columna_Fija son exactamente seleccion y nombre, y nada más', () => {
    expect([...CLAVES_FIJAS]).toEqual(['seleccion', 'nombre']);
    const fijas = CATALOGO_METRICAS.filter((e) => e.fija).map((e) => e.clave);
    expect(fijas).toEqual(['seleccion', 'nombre']);
  });

  it('las 12 base son exactamente las de R2 c2, en el orden del catálogo', () => {
    expect([...CLAVES_BASE]).toEqual(BASE_ESPERADAS);
    expect(CATALOGO_METRICAS.filter((e) => e.base).map((e) => e.clave)).toEqual(BASE_ESPERADAS);
  });

  it('el estado NO es una Columna_Fija (glosario: se puede ocultar)', () => {
    expect(entrada('estado')?.fija).toBeUndefined();
  });

  it('hook rate lleva su fórmula en el rótulo y declara campoApi + retiroAnunciado (R7 c7, c12)', () => {
    const h = entrada('hookRate')!;
    expect(h.rotulo).toContain('÷');
    expect(h.campoApi).toBe('video_play_actions');
    expect(h.retiroAnunciado).toBe(false);
  });

  it('roi lleva en su definición el puente a la escala de múltiplo de las reglas (D-06)', () => {
    expect(entrada('roi')!.definicion).toContain('1,10');
  });
});

describe('columnasParaRender (R2 c13)', () => {
  it('una clave desconocida se descarta y el resto de la configuración se conserva', () => {
    const resuelto = columnasParaRender([
      { clave: 'gastos', ancho: 100 },
      { clave: 'clave_que_ya_no_existe', ancho: 90 },
      { clave: 'roi', ancho: 80 },
    ]);
    const claves = resuelto.map((c) => c.clave);
    expect(claves).not.toContain('clave_que_ya_no_existe');
    expect(claves.filter((c) => c !== 'seleccion' && c !== 'nombre')).toEqual(['gastos', 'roi']);
    expect(resuelto.find((c) => c.clave === 'gastos')!.ancho).toBe(100);
  });

  it('fuerza las dos fijas a las dos posiciones de más a la izquierda', () => {
    const resuelto = columnasParaRender([
      { clave: 'gastos', ancho: 100 },
      { clave: 'nombre', ancho: 280 },
      { clave: 'seleccion', ancho: 48 },
    ]);
    expect(resuelto.slice(0, 2).map((c) => c.clave)).toEqual(['seleccion', 'nombre']);
    expect(resuelto.map((c) => c.clave)).toEqual(['seleccion', 'nombre', 'gastos']);
  });

  it('no repite claves', () => {
    const resuelto = columnasParaRender([
      { clave: 'gastos', ancho: 100 },
      { clave: 'gastos', ancho: 120 },
      { clave: 'nombre', ancho: 300 },
    ]);
    expect(resuelto.filter((c) => c.clave === 'gastos')).toHaveLength(1);
  });
});

describe('celdasDeFila (R2 c8, c9, c12)', () => {
  it('una columna cuyo nivel no la expone da — y conserva su lugar en la fila', () => {
    // `presupuesto` no existe a nivel anuncio, pero la columna sigue visible.
    const columnas = columnasParaRender([
      { clave: 'presupuesto', ancho: 100 },
      { clave: 'gastos', ancho: 100 },
    ]);
    const celdas = celdasDeFila(columnas, fila('ad', 'Anuncio 1'));
    expect(celdas).toHaveLength(4); // 2 fijas + 2
    expect(celdas[2]).toBe('—'); // presupuesto a nivel ad
    expect(celdas[3]).not.toBe('—');
  });

  it('el valor cero se formatea con el formato declarado, nunca — (R2 c12)', () => {
    const f = fila('adset', 'Conjunto 1');
    const celdas = celdasDeFila(
      columnasParaRender([{ clave: 'ventas', ancho: 80 }]),
      { ...f, sales: 0, revenueEur: 0, dailyBudgetEur: 0, spendEur: 0 },
    );
    expect(celdas[2]).toBe('0'); // ventas 0 → '0', no '—'
    const gastos = celdasDeFila(columnasParaRender([{ clave: 'gastos', ancho: 80 }]), {
      ...f,
      spendEur: 0,
    });
    expect(gastos[2]).toContain('0,00'); // importe EUR con coma y dos decimales
  });

  it('null en la métrica da — (R2 c9)', () => {
    const f = fila('adset', 'Conjunto 1');
    const celdas = celdasDeFila(columnasParaRender([{ clave: 'ctr', ancho: 80 }]), {
      ...f,
      ctr: null,
    });
    expect(celdas[2]).toBe('—');
  });

  it('roi se muestra en múltiplo, igual que el ROAS, y el cero de ctr existe como valor', () => {
    const f = fila('adset', 'Conjunto 1');
    const roi = celdasDeFila(columnasParaRender([{ clave: 'roi', ancho: 80 }]), {
      ...f,
      roi: 1.1,
    });
    // En múltiplo: 1,10 y NO 110. Es la misma escala que usan las condiciones de
    // las reglas, así que lo que se lee en la tabla se puede escribir tal cual en
    // una regla sin convertir nada.
    expect(roi[2]).toContain('1,10');
    expect(roi[2]).not.toContain('110');
    const ctr = celdasDeFila(columnasParaRender([{ clave: 'ctr', ancho: 80 }]), {
      ...f,
      ctr: 0,
    });
    expect(ctr[2]).toContain('0');
  });

  it('formatear: NaN e Infinity son —, y nunca rompe', () => {
    const e = entrada('gastos')!;
    expect(formatear(e, NaN)).toBe('—');
    expect(formatear(e, Infinity)).toBe('—');
    expect(formatear(e, null)).toBe('—');
    expect(formatear(e, undefined)).toBe('—');
  });
});

// Feature: gestion-campanas-anuncios, Property 1: La estructura de la tabla es
// coherente para cualquier subconjunto de columnas
describe('Property 1 (R2 c7, c4, c6)', () => {  it('para todo subconjunto con las fijas y toda permutación, encabezado y filas tienen la misma cantidad de celdas y el mismo orden', () => {
    fc.assert(
      fc.property(
        genColumnasVisibles(),
        fc.array(genMetricasObjeto(), { minLength: 0, maxLength: 50 }),
        (configuracion, filas) => {
          const columnas = columnasParaRender(configuracion);
          // las dos Columna_Fija, siempre en las dos posiciones de más a la izquierda
          expect(columnas.slice(0, 2).map((c) => c.clave)).toEqual(['seleccion', 'nombre']);
          const claves = columnas.map((c) => c.clave);
          expect(new Set(claves).size).toBe(claves.length); // sin repetidas
          // entre 2 y 27 columnas visibles
          expect(claves.length).toBeGreaterThanOrEqual(2);
          expect(claves.length).toBeLessThanOrEqual(27);

          for (const fila of filas) {
            const celdas = celdasDeFila(columnas, fila);
            // cada fila tiene la MISMA cantidad de celdas que el encabezado
            expect(celdas).toHaveLength(columnas.length);
            // y cada celda corresponde a su columna, en el mismo orden
            for (let i = 0; i < columnas.length; i++) {
              const clave = columnas[i]!.clave;
              if (clave === 'seleccion') {
                expect(celdas[i]).toBe('');
                continue;
              }
              const e = entrada(clave)!;
              const esperada = e.niveles.includes(fila.level)
                ? formatear(e, valorDeMetrica(fila, clave as ClaveOrden))
                : '—';
              expect(celdas[i], `celda ${i} (${clave}) del nivel ${fila.level}`).toBe(esperada);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: gestion-campanas-anuncios, Property 2: El formateo de celdas es
// total y nunca confunde cero con ausencia
describe('Property 2 (R2 c9, c12, R7 c3, c14)', () => {
  const valores = fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    fc.constant(NaN),
    fc.constant(Infinity),
    fc.constant(0),
    fc.constant(-0),
    fc.integer({ min: -100, max: 100 }),
    fc.float({ min: -100, max: 100 }),
    fc.double({ min: -1e12, max: 1e12 }),
  );

  it('para toda entrada del catálogo y todo valor: nulo/ausente/NaN/infinito es —, y todo número finito (incluido el cero) se formatea y nunca es —', () => {
    fc.assert(
      fc.property(fc.constantFrom(...CATALOGO_METRICAS), valores, (e, valor) => {
        const r = formatear(e, valor);
        if (valor === null || valor === undefined || (typeof valor === 'number' && !Number.isFinite(valor))) {
          expect(r).toBe('—');
        } else if (typeof valor === 'number') {
          // número finito, incluido el cero: se formatea y NUNCA es —
          expect(r).not.toBe('—');
          expect(r.length).toBeGreaterThan(0);
          if (e.formato === 'eur' || e.formato === 'porcentaje' || e.formato === 'multiplicador') {
            // coma como separador decimal
            expect(r).toMatch(/\d,\d{2}/);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('los importes en EUR llevan coma decimal y dos decimales, también en cero (R2 c12)', () => {
    const e = entrada('gastos')!;
    const r = formatear(e, 0);
    expect(r).toContain(',');
    expect(r).toMatch(/0,00$/);
    const positivo = formatear(e, 1234.5);
    expect(positivo).toContain('1.234,50');
  });

  it('el cero en una métrica de video es 0, distinto del — del campo ausente (R7 c14)', () => {
    const e = entrada('videoReproducciones')!;
    expect(formatear(e, 0)).toBe('0');
    expect(formatear(e, null)).toBe('—');
  });
});
