import { describe, expect, it } from 'vitest';
import { calcularPrevisualizacion } from './previsualizacion';
import type { MetricasObjeto, NivelAds } from './tipos';

/**
 * Tests de la Previsualizacion (task 10.2). La Previsualizacion se calcula con
 * los datos ya cargados, con cero llamadas (R14 c2): esta función no recibe
 * ningún cliente HTTP, así que no hay nada que mockear.
 */

function fila(objectId: string, nivel: NivelAds, sobre: Partial<MetricasObjeto> = {}): MetricasObjeto {
  return {
    level: nivel,
    objectId,
    objectName: `Objeto ${objectId}`,
    accountId: 'act_1',
    campaignId: nivel === 'campaign' ? objectId : 'camp_1',
    adsetId: nivel === 'ad' ? 'set_1' : objectId,
    adId: nivel === 'ad' ? objectId : '',
    funnelId: null,
    status: 'ACTIVE',
    effectiveStatus: 'ACTIVE',
    budgetLevel: nivel === 'ad' ? null : nivel,
    budgetMode: 'daily',
    dailyBudgetEur: 10,
    spendEur: 5,
    impressions: 100,
    clicks: 5,
    sales: 1,
    revenueEur: 50,
    refundedEur: 0,
    commissionsEur: 0,
    costsEur: 0,
    netEur: 50,
    profitEur: 45,
    roas: 10,
    roi: 10,
    cpaEur: 5,
    ctr: 0.05,
    cpcEur: 1,
    ultimaAccionAt: null,
    cpmEur: 50,
    hookRate: 0.5,
    videoReproducciones: 50,
    videoThruplay: 10,
    videoP25: 20,
    videoP50: 15,
    videoP75: 10,
    videoP100: 5,
    alcance: null,
    frecuencia: null,
    inicioProgramado: null,
    ...sobre,
  };
}

const TOPES = { techoEur: 200, topeLoteEur: 300, minimoDiarioEur: 1 };

describe('los cinco motivos de omisión (R14 c6)', () => {
  it('ya_esta_en_ese_estado: pausar algo ya pausado', () => {
    const f = fila('s1', 'adset', { status: 'PAUSED' });
    const p = calcularPrevisualizacion('pause', 'adset', [f], ['s1'], {}, TOPES);
    expect(p.filas[0]!.motivo).toBe('ya_esta_en_ese_estado');
    expect(p.filas[0]!.ejecutable).toBe(true);
  });

  it('valor_igual_al_anterior: presupuesto con el mismo importe', () => {
    const f = fila('s1', 'adset', { dailyBudgetEur: 10 });
    const p = calcularPrevisualizacion('budget_set', 'adset', [f], ['s1'], { budgetEur: 10 }, TOPES);
    expect(p.filas[0]!.motivo).toBe('valor_igual_al_anterior');
  });

  it('campo_no_aplica: presupuesto a nivel anuncio, en nivel ajeno y presupuesto total', () => {
    const ad = fila('a1', 'ad');
    const p1 = calcularPrevisualizacion('budget_set', 'ad', [ad], ['a1'], { budgetEur: 10 }, TOPES);
    expect(p1.filas[0]!.motivo).toBe('campo_no_aplica');
    expect(p1.filas[0]!.ejecutable).toBe(false);

    const heredado = fila('s1', 'adset', { budgetLevel: 'campaign' });
    const p2 = calcularPrevisualizacion('budget_set', 'adset', [heredado], ['s1'], { budgetEur: 10 }, TOPES);
    expect(p2.filas[0]!.motivo).toBe('campo_no_aplica');

    const lifetime = fila('s1', 'adset', { budgetMode: 'lifetime' });
    const p3 = calcularPrevisualizacion('budget_set', 'adset', [lifetime], ['s1'], { budgetEur: 10 }, TOPES);
    expect(p3.filas[0]!.motivo).toBe('campo_no_aplica');
  });

  it('no_pertenece_al_nivel: la fila es de otro nivel', () => {
    const camp = fila('c1', 'campaign');
    const p = calcularPrevisualizacion('pause', 'adset', [camp], ['c1'], {}, TOPES);
    expect(p.filas[0]!.motivo).toBe('no_pertenece_al_nivel');
    expect(p.filas[0]!.ejecutable).toBe(false);
  });

  it('excede_tope_de_lote: más de 100 objetos', () => {
    const filas = Array.from({ length: 101 }, (_, i) => fila(`s${i}`, 'adset'));
    const p = calcularPrevisualizacion('pause', 'adset', filas, filas.map((f) => f.objectId), {}, TOPES);
    expect(p.filas[100]!.motivo).toBe('excede_tope_de_lote');
    expect(p.filas[100]!.ejecutable).toBe(false);
    expect(p.filas[99]!.motivo).not.toBe('excede_tope_de_lote');
  });
});

describe('completa (R14 c12)', () => {
  it('false cuando falta una fila de la selección', () => {
    const f = fila('s1', 'adset');
    const p = calcularPrevisualizacion('pause', 'adset', [f], ['s1', 's_inexistente'], {}, TOPES);
    expect(p.completa).toBe(false);
  });

  it('false en una duplicación sin desglose (R14 c5)', () => {
    const f = fila('c1', 'campaign');
    const p = calcularPrevisualizacion('duplicate', 'campaign', [f], ['c1'], { copias: 2 }, TOPES);
    expect(p.completa).toBe(false);
    expect(p.aCrear).toBeNull();
  });
});

describe('duplicación (R14 c5, R10 c5)', () => {
  it('muestra el desglose de objetos a crear y el nombre exacto de cada Copia', () => {
    const f = fila('c1', 'campaign');
    const desglose = {
      porObjeto: new Map([['c1', { conjuntos: 2, anuncios: 6 }]]),
    };
    const p = calcularPrevisualizacion('duplicate', 'campaign', [f], ['c1'], { copias: 2, desglose }, TOPES);
    expect(p.completa).toBe(true);
    expect(p.aCrear).toEqual({ campanias: 2, conjuntos: 4, anuncios: 12, total: 18 });
    expect(p.filas[0]!.despues).toBe('Objeto c1 - Copia 1 · Objeto c1 - Copia 2');
  });

  it('los nombres esquivan los ocupados por hermanos', () => {
    const f = fila('c2', 'campaign', { objectName: 'PXN 1' });
    const hermana = fila('c1', 'campaign', { objectName: 'PXN 1 - Copia 1' });
    const desglose = { porObjeto: new Map([['c2', { conjuntos: 1, anuncios: 1 }]]) };
    const p = calcularPrevisualizacion('duplicate', 'campaign', [f, hermana], ['c2'], { copias: 1, desglose }, TOPES);
    expect(p.filas[0]!.despues).toBe('PXN 1 - Copia 2');
  });

  it('a nivel anuncio no aplica (R10 c14)', () => {
    const ad = fila('a1', 'ad');
    const p = calcularPrevisualizacion('duplicate', 'ad', [ad], ['a1'], { copias: 1 }, TOPES);
    expect(p.filas[0]!.motivo).toBe('campo_no_aplica');
    expect(p.filas[0]!.ejecutable).toBe(false);
  });
});

describe('presupuesto (R13 c8)', () => {
  it('muestra el delta total que el lote agrega y los dos topes', () => {
    const a = fila('s1', 'adset', { dailyBudgetEur: 10 });
    const b = fila('s2', 'adset', { dailyBudgetEur: 30 });
    const c = fila('s3', 'adset', { dailyBudgetEur: 25 });
    const p = calcularPrevisualizacion('budget_set', 'adset', [a, b, c], ['s1', 's2', 's3'], { budgetEur: 20 }, TOPES);
    // a: +10, b: 0 (baja, no cuenta), c: 0 (baja)
    expect(p.presupuesto!.deltaTotalEur).toBeCloseTo(10);
    expect(p.presupuesto!.topeLoteEur).toBe(300);
    expect(p.presupuesto!.techoEur).toBe(200);
  });

  it('un importe por encima del Techo_Absoluto queda no ejecutable con advertencia', () => {
    const f = fila('s1', 'adset', { dailyBudgetEur: 10 });
    const p = calcularPrevisualizacion('budget_set', 'adset', [f], ['s1'], { budgetEur: 201 }, TOPES);
    expect(p.filas[0]!.ejecutable).toBe(false);
    expect(p.filas[0]!.advertencia).toContain('Techo_Absoluto');
  });
});

describe('renombrado (R12 c6, c7)', () => {
  it('nombre repetido entre hermanos es advertencia y NO bloquea', () => {
    const a = fila('s1', 'adset', { objectName: 'Frío' });
    const b = fila('s2', 'adset', { objectName: 'Frío - v2' });
    const p = calcularPrevisualizacion(
      'rename',
      'adset',
      [a, b],
      ['s1'],
      { modo: { tipo: 'sufijo', texto: ' - v2' } },
      TOPES,
    );
    expect(p.filas[0]!.despues).toBe('Frío - v2');
    expect(p.filas[0]!.advertencia).toBe('nombre repetido entre hermanos');
    expect(p.filas[0]!.ejecutable).toBe(true);
  });

  it('el que quedaría vacío o pasaría de 400 queda no ejecutable (R12 c6)', () => {
    const a = fila('s1', 'adset', { objectName: 'Frío' });
    const pVacio = calcularPrevisualizacion(
      'rename',
      'adset',
      [a],
      ['s1'],
      { modo: { tipo: 'exacto', nombre: '   ' } },
      TOPES,
    );
    expect(pVacio.filas[0]!.ejecutable).toBe(false);
    expect(pVacio.filas[0]!.advertencia).toContain('vacío');

    const pLargo = calcularPrevisualizacion(
      'rename',
      'adset',
      [a],
      ['s1'],
      { modo: { tipo: 'exacto', nombre: 'x'.repeat(401) } },
      TOPES,
    );
    expect(pLargo.filas[0]!.ejecutable).toBe(false);
    expect(pLargo.filas[0]!.advertencia).toContain('400');
  });

  it('el nombre resultante idéntico se marca (R12 c6)', () => {
    const a = fila('s1', 'adset', { objectName: 'Frío' });
    const p = calcularPrevisualizacion(
      'rename',
      'adset',
      [a],
      ['s1'],
      { modo: { tipo: 'exacto', nombre: 'Frío' } },
      TOPES,
    );
    expect(p.filas[0]!.motivo).toBe('valor_igual_al_anterior');
  });
});

describe('forma de la Previsualizacion (R14 c3, c4)', () => {
  it('informa la acción en castellano, el nivel y la cantidad de alcanzados', () => {
    const filas = Array.from({ length: 7 }, (_, i) => fila(`s${i}`, 'adset'));
    const p = calcularPrevisualizacion('activate', 'adset', filas, filas.map((f) => f.objectId), {}, TOPES);
    expect(p.rotuloAccion).toBe('activar');
    expect(p.nivel).toBe('adset');
    expect(p.alcanzados).toBe(7);
    expect(p.filas).toHaveLength(7);
  });

  it('lista todas las filas: la UI muestra 50 con scroll y contabiliza el resto', () => {
    const filas = Array.from({ length: 60 }, (_, i) => fila(`s${i}`, 'adset'));
    const p = calcularPrevisualizacion('pause', 'adset', filas, filas.map((f) => f.objectId), {}, TOPES);
    expect(p.filas).toHaveLength(60);
    expect(p.filas.slice(0, 50)).toHaveLength(50);
    expect(p.filas.length - 50).toBe(10);
  });

  it('pausar/activar en lote con un solo objeto también produce Previsualizacion (R14 c9)', () => {
    const f = fila('s1', 'adset');
    const p = calcularPrevisualizacion('pause', 'adset', [f], ['s1'], {}, TOPES);
    expect(p.filas).toHaveLength(1);
    expect(p.filas[0]!.antes).toBe('ACTIVE');
    expect(p.filas[0]!.despues).toBe('PAUSED');
  });
});
