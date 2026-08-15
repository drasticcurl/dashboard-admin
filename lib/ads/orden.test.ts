import { describe, expect, it } from 'vitest';
import { ORDEN_DEFAULT, comparadorOrden, siguienteOrden } from './orden';
import type { MetricasObjeto } from './tipos';

/**
 * Tests de ejemplo del Orden_Tabla (task 4.2). La Property 6 completa (modelo
 * contra SQL, con nulos y empates) vive en la task 15.3, porque su enunciado
 * incluye la mitad SQL y necesita base.
 */

function fila(objectId: string, sobre: Partial<MetricasObjeto> = {}): MetricasObjeto {
  return {
    level: 'adset',
    objectId,
    objectName: `Nombre ${objectId}`,
    accountId: 'act_1',
    campaignId: 'camp_1',
    adsetId: objectId,
    adId: '',
    funnelId: null,
    status: 'ACTIVE',
    effectiveStatus: 'ACTIVE',
    budgetLevel: 'adset',
    budgetMode: 'daily',
    dailyBudgetEur: 10,
    spendEur: 0,
    impressions: 0,
    clicks: 0,
    sales: 0,
    revenueEur: 0,
    refundedEur: 0,
    commissionsEur: 0,
    costsEur: 0,
    netEur: 0,
    profitEur: 0,
    roas: null,
    roi: null,
    cpaEur: null,
    ctr: null,
    cpcEur: null,
    ultimaAccionAt: null,
    cpmEur: null,
    hookRate: null,
    videoReproducciones: null,
    videoThruplay: null,
    videoP25: null,
    videoP50: null,
    videoP75: null,
    videoP100: null,
    alcance: null,
    frecuencia: null,
    inicioProgramado: null,
    ...sobre,
  };
}

describe('siguienteOrden (R4 c1, c2, c8, c11)', () => {
  it('primer click en una columna nueva → descendente y página 1', () => {
    const s = siguienteOrden(ORDEN_DEFAULT, 'ventas');
    expect(s).toEqual({ clave: 'ventas', dir: 'desc', pagina: 1 });
  });

  it('click en la misma columna → invierte, sin estado intermedio sin orden', () => {
    const desc = siguienteOrden(ORDEN_DEFAULT, 'ventas');
    const asc = siguienteOrden(desc, 'ventas');
    expect(asc).toEqual({ clave: 'ventas', dir: 'asc', pagina: 1 });
    expect(siguienteOrden(asc, 'ventas')).toEqual({ clave: 'ventas', dir: 'desc', pagina: 1 });
  });

  it('un encabezado no ordenable no cambia nada (ni la página)', () => {
    const actual = { clave: 'ventas' as const, dir: 'desc' as const, pagina: 3 };
    expect(siguienteOrden(actual, 'seleccion')).toBe(actual);
  });

  it('cambiar la clave o la dirección vuelve a la página 1', () => {
    const actual = { clave: 'ventas' as const, dir: 'asc' as const, pagina: 3 };
    expect(siguienteOrden(actual, 'gastos').pagina).toBe(1);
    expect(siguienteOrden(actual, 'ventas').pagina).toBe(1);
  });
});

describe('comparadorOrden (R4 c6, c7)', () => {
  const a = fila('a');
  const b = fila('b');
  const c = fila('c');

  it('los nulos van al final en las DOS direcciones', () => {
    const conNull = fila('n', { ventas: 0, spendEur: 5 });
    const sinNull = { ...b, ventas: 10 };
    const nulo = { ...c, ventas: null as unknown as number };

    for (const dir of ['asc', 'desc'] as const) {
      const cmp = comparadorOrden('ventas', dir);
      // el nulo queda DESPUÉS de cualquiera con valor, en ambas direcciones
      expect(cmp(nulo, sinNull)).toBeGreaterThan(0);
      expect(cmp(sinNull, nulo)).toBeLessThan(0);
    }
  });

  it('el cero es un valor, no ausencia', () => {
    const cero = { ...a, spendEur: 0 };
    const nulo = { ...b, spendEur: null as unknown as number };
    for (const dir of ['asc', 'desc'] as const) {
      const cmp = comparadorOrden('gastos', dir);
      expect(cmp(cero, nulo)).toBeLessThan(0);
      expect(cmp(nulo, cero)).toBeGreaterThan(0);
    }
  });

  it('desempata por objectId SIEMPRE ascendente, también en descendente', () => {
    const a5 = { ...a, ventas: 5 };
    const b5 = { ...b, ventas: 5 };
    expect(comparadorOrden('ventas', 'desc')(a5, b5)).toBeLessThan(0);
    expect(comparadorOrden('ventas', 'asc')(a5, b5)).toBeLessThan(0);
    expect(comparadorOrden('ventas', 'desc')(b5, a5)).toBeGreaterThan(0);
  });

  it('compara strings con localeCompare (nombre)', () => {
    const x = { ...a, objectName: 'Bbb' };
    const y = { ...b, objectName: 'Aaa' };
    expect(comparadorOrden('nombre', 'asc')(x, y)).toBeGreaterThan(0);
    expect(comparadorOrden('nombre', 'desc')(x, y)).toBeLessThan(0);
  });
});
