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
    // El caso sano por defecto: recién confirmado contra Meta y presente. Los
    // tests de objeto viejo o desaparecido lo pisan por `sobre`.
    syncedAt: '2026-08-12T10:00:00.000Z',
    desaparecidoAt: null,
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

/**
 * Las dos advertencias de la task 15. Las dos son NO bloqueantes a propósito:
 * lo que estaba roto no era que el panel dejara hacer algo indebido, era que
 * hacía algo real y no decía que igual no servía.
 */
describe('padre apagado (R6.4)', () => {
  const padres = (campania: string | null, conjunto: string | null = null) => ({
    padres: new Map([['x1', { campania, conjunto }]]),
  });

  it('activar un conjunto con la campaña pausada advierte y NO bloquea', () => {
    const f = fila('x1', 'adset', { status: 'PAUSED', effectiveStatus: 'PAUSED' });
    const p = calcularPrevisualizacion('activate', 'adset', [f], ['x1'], padres('PAUSED'), TOPES);
    const r = p.filas[0]!;
    // Las tres cosas que el panel no distinguía: se aplicó, no entrega, qué hacer.
    expect(r.advertencia).toContain('el conjunto queda activo');
    expect(r.advertencia).toContain('no entrega');
    expect(r.advertencia).toContain('hasta que se active la campaña');
    expect(r.ejecutable).toBe(true);
    expect(r.motivo).toBeNull();
    expect(r.despues).toBe('ACTIVE');
  });

  it('el effective_status del propio objeto NO alcanza para saberlo', () => {
    // Un conjunto PAUSED bajo una campaña PAUSED viene con effective_status
    // 'PAUSED', no 'CAMPAIGN_PAUSED': Meta resuelve primero el estado propio.
    // Sin el status del padre no hay advertencia posible, y es justo el caso que
    // alguien va a querer activar.
    const f = fila('x1', 'adset', { status: 'PAUSED', effectiveStatus: 'PAUSED' });
    const sinPadres = calcularPrevisualizacion('activate', 'adset', [f], ['x1'], {}, TOPES);
    expect(sinPadres.filas[0]!.advertencia).toBeNull();
    const conPadres = calcularPrevisualizacion('activate', 'adset', [f], ['x1'], padres('PAUSED'), TOPES);
    expect(conPadres.filas[0]!.advertencia).not.toBeNull();
  });

  it('advierte también cuando el objeto YA está activo y no entrega', () => {
    const f = fila('x1', 'adset', { status: 'ACTIVE', effectiveStatus: 'CAMPAIGN_PAUSED' });
    const p = calcularPrevisualizacion('activate', 'adset', [f], ['x1'], padres('PAUSED'), TOPES);
    expect(p.filas[0]!.motivo).toBe('ya_esta_en_ese_estado');
    expect(p.filas[0]!.advertencia).toContain('no entrega');
  });

  it('con la campaña activa no advierte nada', () => {
    const f = fila('x1', 'adset', { status: 'PAUSED', effectiveStatus: 'PAUSED' });
    const p = calcularPrevisualizacion('activate', 'adset', [f], ['x1'], padres('ACTIVE'), TOPES);
    expect(p.filas[0]!.advertencia).toBeNull();
  });

  it('una campaña no tiene padre: nunca advierte', () => {
    const f = fila('x1', 'campaign', { status: 'PAUSED', effectiveStatus: 'PAUSED' });
    const p = calcularPrevisualizacion('activate', 'campaign', [f], ['x1'], padres('PAUSED'), TOPES);
    expect(p.filas[0]!.advertencia).toBeNull();
  });

  it('un anuncio se advierte por el conjunto, por la campaña o por los dos', () => {
    const f = fila('x1', 'ad', { status: 'PAUSED', effectiveStatus: 'PAUSED' });
    const soloConjunto = calcularPrevisualizacion('activate', 'ad', [f], ['x1'], padres('ACTIVE', 'PAUSED'), TOPES);
    expect(soloConjunto.filas[0]!.advertencia).toContain('el conjunto está pausado');
    expect(soloConjunto.filas[0]!.advertencia).toContain('hasta que se active el conjunto');

    const soloCampania = calcularPrevisualizacion('activate', 'ad', [f], ['x1'], padres('PAUSED', 'ACTIVE'), TOPES);
    expect(soloCampania.filas[0]!.advertencia).toContain('la campaña está pausada');
    expect(soloCampania.filas[0]!.advertencia).toContain('el anuncio queda activo');

    const ambos = calcularPrevisualizacion('activate', 'ad', [f], ['x1'], padres('PAUSED', 'PAUSED'), TOPES);
    expect(ambos.filas[0]!.advertencia).toContain('el conjunto y la campaña están pausados');
    expect(ambos.filas[0]!.ejecutable).toBe(true);
  });

  it('un padre desconocido no advierte: null es "no se sabe", no "está activo"', () => {
    const f = fila('x1', 'adset', { status: 'PAUSED', effectiveStatus: 'PAUSED' });
    const nulo = calcularPrevisualizacion('activate', 'adset', [f], ['x1'], padres(null), TOPES);
    expect(nulo.filas[0]!.advertencia).toBeNull();
    const vacio = calcularPrevisualizacion('activate', 'adset', [f], ['x1'], padres(''), TOPES);
    expect(vacio.filas[0]!.advertencia).toBeNull();
  });

  it('un estado no escribible no gana la advertencia: la fila no se manda', () => {
    const f = fila('x1', 'adset', { status: 'ARCHIVED', effectiveStatus: 'ARCHIVED' });
    const p = calcularPrevisualizacion('activate', 'adset', [f], ['x1'], padres('PAUSED'), TOPES);
    expect(p.filas[0]!.motivo).toBe('campo_no_aplica');
    expect(p.filas[0]!.advertencia).toBeNull();
  });
});

/**
 * El aviso al PAUSAR, task 12 de `toggle-conjuntos-entrega` (1.12, 2.11).
 *
 * ## Qué defecto cierra
 *
 * Hasta acá `advertenciaPadreApagado` se sumaba sólo para `activate`, así que el
 * usuario que apagaba uno de los **92 conjuntos `ACTIVE / CAMPAIGN_PAUSED`** de la
 * cuenta no leía nada: el aviso de que ese conjunto no entregaba llegaba en el
 * SEGUNDO click, cuando lo volvía a prender. 2.11 lo mueve al momento del click.
 *
 * ## Por qué es OTRO texto y no el mismo
 *
 * Al activar, «no entrega» es una advertencia sobre el futuro —«queda activo pero
 * no entrega hasta que se active la campaña»—. Al pausar es una aclaración sobre
 * lo que se está apagando, y va en pasado: el conjunto ya no entregaba, así que
 * pausarlo no cambia la entrega. Reusar el texto de activar acá diría algo falso
 * («queda activo») sobre una fila que se está apagando.
 *
 * ## El `status === 'ACTIVE'` es la mitad de la decisión
 *
 * El aviso se suma sólo cuando el `pause` escribe de verdad. Pausar algo que ya
 * está `PAUSED` llega con `motivo: 'ya_esta_en_ese_estado'` y la aclaración no
 * agrega nada. Con eso el aviso aparece sobre los 92 y no sobre los 67, que es la
 * diferencia entre decir algo útil y hacer ruido en la operación de lote más
 * común. La asimetría con `activate` —que sí se suma sobre
 * `ya_esta_en_ese_estado`— tiene su propio motivo y está afirmada arriba.
 */
describe('el aviso al pausar algo que ya no entregaba (1.12, 2.11)', () => {
  const padres = (campania: string | null, conjunto: string | null = null) => ({
    padres: new Map([['x1', { campania, conjunto }]]),
  });

  /**
   * Los cuatro textos de `activate`, LITERALES y comparados con `toBe`.
   *
   * 3.5 los congela carácter por carácter, así que acá no salen del productor:
   * un test que le pregunta la respuesta a la función que está probando no
   * detecta que la función cambió de respuesta. Es el único bloque del archivo
   * que los escribe a mano y es a propósito.
   */
  const ACTIVATE = {
    adsetCampania:
      'la campaña está pausada: el conjunto queda activo pero no entrega hasta que se active la campaña',
    adConjunto:
      'el conjunto está pausado: el anuncio queda activo pero no entrega hasta que se active el conjunto',
    adCampania:
      'la campaña está pausada: el anuncio queda activo pero no entrega hasta que se active la campaña',
    adAmbos:
      'el conjunto y la campaña están pausados: el anuncio queda activo pero no entrega hasta que se activen los dos',
  } as const;

  /** Los textos nuevos de `pause`, también literales. */
  const PAUSE = {
    adsetCampania:
      'la campaña está pausada: el conjunto ya no estaba entregando, así que pausarlo no cambia la entrega',
    adConjunto:
      'el conjunto está pausado: el anuncio ya no estaba entregando, así que pausarlo no cambia la entrega',
    adCampania:
      'la campaña está pausada: el anuncio ya no estaba entregando, así que pausarlo no cambia la entrega',
    adAmbos:
      'el conjunto y la campaña están pausados: el anuncio ya no estaba entregando, así que pausarlo no cambia la entrega',
  } as const;

  it('pausar uno de los 92 lo dice en el momento del click, en pasado y nombrando la campaña', () => {
    // El caso reportado: `ACTIVE / CAMPAIGN_PAUSED` bajo campaña pausada. La
    // escritura ocurre —el objeto pasa a PAUSED— y lo que hay que aclarar es que
    // la entrega no cambia, porque ya era cero.
    const f = fila('x1', 'adset', { status: 'ACTIVE', effectiveStatus: 'CAMPAIGN_PAUSED' });
    const p = calcularPrevisualizacion('pause', 'adset', [f], ['x1'], padres('PAUSED'), TOPES);
    const r = p.filas[0]!;

    expect(r.advertencia).toBe(PAUSE.adsetCampania);
    // Nombra al antepasado: el link de la navegación de 2.12 sale de ahí.
    expect(r.advertencia).toContain('la campaña está pausada');
    // Y no promete nada del futuro, que es lo que separa este texto del de
    // activar: no dice «queda activo» ni «hasta que se active».
    expect(r.advertencia).not.toContain('hasta que');
    expect(r.advertencia).not.toContain('queda activo');
    // Sigue siendo advertencia y no bloqueo, igual que la de activar (3.5).
    expect(r.ejecutable).toBe(true);
    expect(r.motivo).toBeNull();
    expect(r.despues).toBe('PAUSED');
  });

  it('los tres textos de anuncio, en la forma del pasado', () => {
    const f = fila('x1', 'ad', { status: 'ACTIVE', effectiveStatus: 'CAMPAIGN_PAUSED' });

    const soloConjunto = calcularPrevisualizacion('pause', 'ad', [f], ['x1'], padres('ACTIVE', 'PAUSED'), TOPES);
    expect(soloConjunto.filas[0]!.advertencia).toBe(PAUSE.adConjunto);

    const soloCampania = calcularPrevisualizacion('pause', 'ad', [f], ['x1'], padres('PAUSED', 'ACTIVE'), TOPES);
    expect(soloCampania.filas[0]!.advertencia).toBe(PAUSE.adCampania);

    const ambos = calcularPrevisualizacion('pause', 'ad', [f], ['x1'], padres('PAUSED', 'PAUSED'), TOPES);
    expect(ambos.filas[0]!.advertencia).toBe(PAUSE.adAmbos);
    expect(ambos.filas[0]!.ejecutable).toBe(true);
  });

  it('un `pause` sobre una fila que YA está PAUSED no trae aviso: la aclaración no agrega nada', () => {
    // Los 67. `motivo: 'ya_esta_en_ese_estado'`, no se escribe nada, y el objeto
    // no entregaba antes ni después: decirlo sería ruido sobre la operación de
    // lote más común.
    const f = fila('x1', 'adset', { status: 'PAUSED', effectiveStatus: 'PAUSED' });
    const p = calcularPrevisualizacion('pause', 'adset', [f], ['x1'], padres('PAUSED'), TOPES);

    expect(p.filas[0]!.motivo).toBe('ya_esta_en_ese_estado');
    expect(p.filas[0]!.advertencia).toBeNull();
  });

  it('la asimetría con `activate` se conserva: activar SÍ avisa sobre `ya_esta_en_ese_estado`', () => {
    // El mismo par de filas, la misma campaña pausada, y las dos acciones. La
    // diferencia no es un descuido: «ya está activo y sigue sin entregar» ES el
    // síntoma reportado, y «ya está pausado y sigue sin entregar» no le dice nada
    // a nadie.
    const yaActivo = fila('x1', 'adset', { status: 'ACTIVE', effectiveStatus: 'CAMPAIGN_PAUSED' });
    const pActivar = calcularPrevisualizacion('activate', 'adset', [yaActivo], ['x1'], padres('PAUSED'), TOPES);
    expect(pActivar.filas[0]!.motivo).toBe('ya_esta_en_ese_estado');
    expect(pActivar.filas[0]!.advertencia).toBe(ACTIVATE.adsetCampania);

    const yaPausado = fila('x1', 'adset', { status: 'PAUSED', effectiveStatus: 'PAUSED' });
    const pPausar = calcularPrevisualizacion('pause', 'adset', [yaPausado], ['x1'], padres('PAUSED'), TOPES);
    expect(pPausar.filas[0]!.motivo).toBe('ya_esta_en_ese_estado');
    expect(pPausar.filas[0]!.advertencia).toBeNull();
  });

  it('los cuatro textos de `activate` no cambiaron, carácter por carácter (3.5)', () => {
    const adset = fila('x1', 'adset', { status: 'PAUSED', effectiveStatus: 'PAUSED' });
    expect(
      calcularPrevisualizacion('activate', 'adset', [adset], ['x1'], padres('PAUSED'), TOPES).filas[0]!.advertencia,
    ).toBe(ACTIVATE.adsetCampania);

    const ad = fila('x1', 'ad', { status: 'PAUSED', effectiveStatus: 'PAUSED' });
    expect(
      calcularPrevisualizacion('activate', 'ad', [ad], ['x1'], padres('ACTIVE', 'PAUSED'), TOPES).filas[0]!.advertencia,
    ).toBe(ACTIVATE.adConjunto);
    expect(
      calcularPrevisualizacion('activate', 'ad', [ad], ['x1'], padres('PAUSED', 'ACTIVE'), TOPES).filas[0]!.advertencia,
    ).toBe(ACTIVATE.adCampania);
    expect(
      calcularPrevisualizacion('activate', 'ad', [ad], ['x1'], padres('PAUSED', 'PAUSED'), TOPES).filas[0]!.advertencia,
    ).toBe(ACTIVATE.adAmbos);
  });

  it('a nivel campaña `pause` sigue devolviendo null: una campaña no tiene padre', () => {
    // La guarda de `nivel === 'campaign'` está antes de mirar la acción, y tiene
    // que seguir estándolo: pausar una campaña no puede ganar un aviso sobre un
    // antepasado que no existe.
    const f = fila('x1', 'campaign', { status: 'ACTIVE', effectiveStatus: 'ACTIVE' });
    const p = calcularPrevisualizacion('pause', 'campaign', [f], ['x1'], padres('PAUSED'), TOPES);
    expect(p.filas[0]!.advertencia).toBeNull();
  });

  it('con la campaña activa, pausar no advierte nada', () => {
    // El camino normal: se apaga algo que sí estaba entregando. No hay ninguna
    // distancia entre lo que el panel confirma y lo que pasa en Meta.
    const f = fila('x1', 'adset', { status: 'ACTIVE', effectiveStatus: 'ACTIVE' });
    const p = calcularPrevisualizacion('pause', 'adset', [f], ['x1'], padres('ACTIVE'), TOPES);
    expect(p.filas[0]!.advertencia).toBeNull();
  });

  it('un padre desconocido tampoco advierte al pausar: null es "no se sabe"', () => {
    const f = fila('x1', 'adset', { status: 'ACTIVE', effectiveStatus: 'CAMPAIGN_PAUSED' });
    expect(
      calcularPrevisualizacion('pause', 'adset', [f], ['x1'], padres(null), TOPES).filas[0]!.advertencia,
    ).toBeNull();
    expect(
      calcularPrevisualizacion('pause', 'adset', [f], ['x1'], padres(''), TOPES).filas[0]!.advertencia,
    ).toBeNull();
    // Y sin el mapa de padres tampoco: el `effectiveStatus` del propio objeto no
    // alcanza para saberlo, ni para activar ni para pausar.
    expect(calcularPrevisualizacion('pause', 'adset', [f], ['x1'], {}, TOPES).filas[0]!.advertencia).toBeNull();
  });

  it('un estado no escribible no gana el aviso al pausar: la fila no se manda', () => {
    const f = fila('x1', 'adset', { status: 'ARCHIVED', effectiveStatus: 'ARCHIVED' });
    const p = calcularPrevisualizacion('pause', 'adset', [f], ['x1'], padres('PAUSED'), TOPES);
    expect(p.filas[0]!.motivo).toBe('campo_no_aplica');
    expect(p.filas[0]!.advertencia).toBeNull();
  });
});

describe('Objeto_Desaparecido (R3.4)', () => {
  const DESDE = '2026-08-14T09:30:00.000Z';

  it('advierte antes de ejecutar y NO bloquea (R3.5)', () => {
    const f = fila('s1', 'adset', { status: 'PAUSED', desaparecidoAt: DESDE });
    const p = calcularPrevisualizacion('activate', 'adset', [f], ['s1'], {}, TOPES);
    expect(p.filas[0]!.advertencia).toContain('objeto desaparecido desde el');
    expect(p.filas[0]!.advertencia).toContain('la escritura puede fallar');
    expect(p.filas[0]!.ejecutable).toBe(true);
    expect(p.filas[0]!.motivo).toBeNull();
  });

  it('vale para TODA acción de escritura, no sólo para las de estado', () => {
    const acciones = [
      ['pause', {}],
      ['activate', {}],
      ['budget_set', { budgetEur: 20 }],
      ['schedule', { inicio: '2026-09-01T10:00:00.000+02:00' }],
      ['rename', { modo: { tipo: 'exacto' as const, nombre: 'Nuevo' } }],
      ['duplicate', { copias: 1, desglose: { porObjeto: new Map([['s1', { conjuntos: 0, anuncios: 2 }]]) } }],
    ] as const;
    for (const [accion, params] of acciones) {
      const f = fila('s1', 'adset', { desaparecidoAt: DESDE });
      const p = calcularPrevisualizacion(accion, 'adset', [f], ['s1'], params, TOPES);
      expect(p.filas[0]!.advertencia, `acción ${accion}`).toContain('objeto desaparecido');
    }
  });

  it('sin marca de desaparición no dice nada', () => {
    const f = fila('s1', 'adset', { status: 'PAUSED', desaparecidoAt: null });
    const p = calcularPrevisualizacion('activate', 'adset', [f], ['s1'], {}, TOPES);
    expect(p.filas[0]!.advertencia).toBeNull();
  });

  it('con una fecha ilegible advierte igual, sin la fecha', () => {
    const f = fila('s1', 'adset', { desaparecidoAt: 'no-es-una-fecha' });
    const p = calcularPrevisualizacion('pause', 'adset', [f], ['s1'], {}, TOPES);
    expect(p.filas[0]!.advertencia).toBe(
      'objeto desaparecido: Meta ya no lo devuelve y la escritura puede fallar',
    );
  });

  it('se suma a la advertencia que ya había, no la pisa', () => {
    // Dos hechos distintos sobre la misma fila: el padre apagado y la
    // desaparición. Perder uno de los dos sería volver a esconder algo.
    const f = fila('x1', 'adset', { status: 'PAUSED', effectiveStatus: 'PAUSED', desaparecidoAt: DESDE });
    const p = calcularPrevisualizacion(
      'activate',
      'adset',
      [f],
      ['x1'],
      { padres: new Map([['x1', { campania: 'PAUSED', conjunto: null }]]) },
      TOPES,
    );
    expect(p.filas[0]!.advertencia).toContain('hasta que se active la campaña');
    expect(p.filas[0]!.advertencia).toContain('objeto desaparecido');
    expect(p.filas[0]!.advertencia).toContain(' · ');
  });

  it('una fila fuera del tope del lote no gana la advertencia: no se manda', () => {
    const filas = Array.from({ length: 101 }, (_, i) => fila(`s${i}`, 'adset', { desaparecidoAt: DESDE }));
    const p = calcularPrevisualizacion('pause', 'adset', filas, filas.map((f) => f.objectId), {}, TOPES);
    expect(p.filas[100]!.motivo).toBe('excede_tope_de_lote');
    expect(p.filas[100]!.advertencia).toBeNull();
    expect(p.filas[99]!.advertencia).toContain('objeto desaparecido');
  });
});
