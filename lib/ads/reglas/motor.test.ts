import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { debeCorrer, dentroDeVentana, evaluar } from './motor';
import { horaLocalEn } from '../zona';
import type { Condicion, MetricasObjeto, Regla } from '../tipos';
import { genMetricasObjeto, genRegla, ZONAS_P16 } from '../../test/generadores-ads';

// Factories mínimas para construir filas de métricas y reglas a mano (§1 del
// task: los tests de motor.ts no necesitan base ni red).

function fila(overrides: Partial<MetricasObjeto> = {}): MetricasObjeto {
  return {
    level: 'adset',
    objectId: 'obj_1',
    objectName: 'PXN JEAN VAQUERO 11/08 - Copia',
    accountId: 'act_1234567',
    campaignId: 'camp_1',
    adsetId: 'obj_1',
    adId: '',
    funnelId: null,
    status: 'ACTIVE',
    effectiveStatus: 'ACTIVE',
    budgetLevel: 'adset',
    budgetMode: 'daily',
    dailyBudgetEur: 10,
    spendEur: 4.37,
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
    ...overrides,
  };
}

function regla(overrides: Partial<Regla> = {}): Regla {
  return {
    id: 1,
    name: 'regla de prueba',
    enabled: true,
    dryRun: false,
    accountId: 'act_1234567',
    level: 'adset',
    statusFilter: 'active',
    nameFilter: null,
    nameFilterMode: 'contains',
    action: 'pause',
    actionValue: null,
    actionUnit: null,
    budgetMax: null,
    budgetMin: null,
    period: 'today',
    metricsLevel: 'object',
    everyMinutes: 15,
    windowStart: null,
    windowEnd: null,
    maxRunsPerDay: null,
    cooldownMinutes: 0,
    maxActionsPerObjectPerDay: 4,
    ...overrides,
  };
}

const ctx = (overrides: Record<string, unknown> = {}) => ({
  ahora: new Date('2026-08-12T12:00:00Z'),
  horaLocal: '12:00',
  accionesRealesHoy: 0,
  ultimaAccionRealAt: null,
  minimoPresupuesto: null,
  ...overrides,
});

describe('evaluar — condiciones (AND, null, operadores)', () => {
  it('dos condiciones que se cumplen → cumple: true; una de dos que no → false (es AND)', () => {
    const c: Condicion[] = [
      { metric: 'spend', op: '>', value: 4 },
      { metric: 'sales', op: '=', value: 0 },
    ];
    const cumple = evaluar(regla({ action: 'pause' }), c, fila({ spendEur: 4.37, sales: 0 }), ctx());
    expect(cumple.cumple).toBe(true);

    const noCumple = evaluar(
      regla({ action: 'pause' }),
      c,
      fila({ spendEur: 4.37, sales: 1 }),
      ctx(),
    );
    expect(noCumple.cumple).toBe(false);
    expect(noCumple.motivo).toBeNull();
  });

  it('roi: null con roi < 1.1 → NO cumple, motivo metrica_indefinida (el falso positivo más caro)', () => {
    const d = evaluar(
      regla({ action: 'pause' }),
      [{ metric: 'roi', op: '<', value: 1.1 }],
      fila({ roi: null, spendEur: 0 }),
      ctx(),
    );
    expect(d.cumple).toBe(false);
    expect(d.motivo).toBe('metrica_indefinida');
  });

  it('los seis operadores contra el borde exacto (roi = 1.3)', () => {
    const f = fila({ roi: 1.3 });
    const evalua = (op: Condicion['op']) => evaluar(regla({ action: 'pause' }), [{ metric: 'roi', op, value: 1.3 }], f, ctx());
    expect(evalua('>').cumple).toBe(false);
    expect(evalua('>=').cumple).toBe(true);
    expect(evalua('<').cumple).toBe(false);
    expect(evalua('<=').cumple).toBe(true);
    expect(evalua('=').cumple).toBe(true);
    expect(evalua('!=').cumple).toBe(false);
  });

  it('cero condiciones → cumple (se aplica a todo lo que pasó el filtro de alcance)', () => {
    const d = evaluar(regla({ action: 'pause' }), [], fila(), ctx());
    expect(d.cumple).toBe(true);
  });
});

describe('evaluar — frenos', () => {
  it('cooldown de 60 min con última acción hace 12 → cooldown; hace 61 → aplica', () => {
    const ahora = new Date('2026-08-12T12:00:00Z');
    const r = regla({ action: 'pause', cooldownMinutes: 60 });
    const enCooldown = evaluar(
      r,
      [],
      fila(),
      ctx({ ahora, ultimaAccionRealAt: new Date(ahora.getTime() - 12 * 60_000) }),
    );
    expect(enCooldown.motivo).toBe('cooldown');
    expect(enCooldown.aplicar).toBe(false);

    const fuera = evaluar(
      r,
      [],
      fila(),
      ctx({ ahora, ultimaAccionRealAt: new Date(ahora.getTime() - 61 * 60_000) }),
    );
    expect(fuera.aplicar).toBe(true);
  });

  it('maxActionsPerObjectPerDay: 4 con 4 acciones hoy → max_por_objeto; con 3 → aplica', () => {
    const r = regla({ action: 'pause', maxActionsPerObjectPerDay: 4 });
    const tope = evaluar(r, [], fila(), ctx({ accionesRealesHoy: 4 }));
    expect(tope.motivo).toBe('max_por_objeto');
    const ok = evaluar(r, [], fila(), ctx({ accionesRealesHoy: 3 }));
    expect(ok.aplicar).toBe(true);
  });

  // Migración 024. El caso que motivó el 0: un apagador que ya gastó el cupo
  // del día (propio o de otra regla sobre el mismo objeto, porque el cupo se
  // cuenta por objeto) se rendía justo cuando hacía falta.
  it('maxActionsPerObjectPerDay: 0 es SIN TOPE y actúa aunque ya haya acciones hoy', () => {
    const r = regla({ action: 'pause', maxActionsPerObjectPerDay: 0 });
    const d = evaluar(r, [], fila(), ctx({ accionesRealesHoy: 40 }));
    expect(d.motivo).toBe(null);
    expect(d.aplicar).toBe(true);
  });

  it('pause sobre un objeto ya PAUSED → ya_esta_en_ese_estado', () => {
    const d = evaluar(regla({ action: 'pause' }), [], fila({ status: 'PAUSED' }), ctx());
    expect(d.motivo).toBe('ya_esta_en_ese_estado');
    expect(d.cumple).toBe(true);
    expect(d.aplicar).toBe(false);
  });

  it('activate sobre un objeto ya ACTIVE → ya_esta_en_ese_estado', () => {
    const d = evaluar(regla({ action: 'activate' }), [], fila({ status: 'ACTIVE' }), ctx());
    expect(d.motivo).toBe('ya_esta_en_ese_estado');
  });

  it('presupuesto sobre un conjunto con budgetLevel: campaign → sin_presupuesto_en_este_nivel', () => {
    const d = evaluar(
      regla({ action: 'budget_increase', actionValue: 250, actionUnit: 'percent', budgetMax: 25 }),
      [],
      fila({ level: 'adset', budgetLevel: 'campaign' }),
      ctx(),
    );
    expect(d.motivo).toBe('sin_presupuesto_en_este_nivel');
  });

  it('EL ORDEN: un objeto en cooldown Y en el techo reporta cooldown (paso 4 antes que 6)', () => {
    const ahora = new Date('2026-08-12T12:00:00Z');
    const d = evaluar(
      regla({ action: 'budget_increase', actionValue: 250, actionUnit: 'percent', budgetMax: 25, cooldownMinutes: 60 }),
      [],
      fila({ dailyBudgetEur: 25 }), // ya en el techo €25
      ctx({ ahora, ultimaAccionRealAt: new Date(ahora.getTime() - 12 * 60_000) }),
    );
    expect(d.motivo).toBe('cooldown');
  });
});

describe('evaluar — aritmética del presupuesto (D-A9, D-A9b, D-A9c)', () => {
  const subir250 = () =>
    regla({ action: 'budget_increase', actionValue: 250, actionUnit: 'percent', budgetMax: 1000 });

  it('250% sobre 1000 → 2500 (factor, NO incremento: si da 3500 está mal)', () => {
    const d = evaluar(subir250(), [], fila({ dailyBudgetEur: 10 }), ctx());
    expect(d.aplicar).toBe(true);
    expect(d.presupuestoAntes).toBe(1000);
    expect(d.presupuestoDespues).toBe(2500);
  });

  it('100% sobre 2500 → 2500 (factor, no incremento)', () => {
    const d = evaluar(
      regla({ action: 'budget_increase', actionValue: 100, actionUnit: 'percent', budgetMax: 1000 }),
      [],
      fila({ dailyBudgetEur: 25 }),
      ctx(),
    );
    expect(d.presupuestoDespues).toBe(2500);
  });

  it('techo €25: 250% sobre 1100 → 2500 (recortado), aplicar true (el caso «Duplicar a $25»)', () => {
    const d = evaluar(
      regla({ action: 'budget_increase', actionValue: 250, actionUnit: 'percent', budgetMax: 25 }),
      [],
      fila({ dailyBudgetEur: 11 }),
      ctx(),
    );
    expect(d.aplicar).toBe(true);
    expect(d.presupuestoDespues).toBe(2500);
  });

  it('ya en 2500 con techo €25 → techo_alcanzado, aplicar false', () => {
    const d = evaluar(
      regla({ action: 'budget_increase', actionValue: 250, actionUnit: 'percent', budgetMax: 25 }),
      [],
      fila({ dailyBudgetEur: 25 }),
      ctx(),
    );
    expect(d.motivo).toBe('techo_alcanzado');
    expect(d.aplicar).toBe(false);
  });

  it('+€1 fijo sobre 2500 → 2600 (fixed sí es incremento)', () => {
    const d = evaluar(
      regla({ action: 'budget_increase', actionValue: 1, actionUnit: 'fixed', budgetMax: 100 }),
      [],
      fila({ dailyBudgetEur: 25 }),
      ctx(),
    );
    expect(d.presupuestoDespues).toBe(2600);
  });

  it('budget_decrease con -€1 fijo sobre 2500 → 2400, NO 2600 (el signo lo pone la acción)', () => {
    const d = evaluar(
      regla({ action: 'budget_decrease', actionValue: 1, actionUnit: 'fixed', budgetMin: 1 }),
      [],
      fila({ dailyBudgetEur: 25 }),
      ctx(),
    );
    expect(d.presupuestoDespues).toBe(2400);
  });

  it('budget_decrease con 50% sobre 2500 → 1250 (el factor lleva la dirección)', () => {
    const d = evaluar(
      regla({ action: 'budget_decrease', actionValue: 50, actionUnit: 'percent', budgetMin: 1 }),
      [],
      fila({ dailyBudgetEur: 25 }),
      ctx(),
    );
    expect(d.presupuestoDespues).toBe(1250);
  });

  it('minimoPresupuesto 100: 50% sobre 200 → 100 (no bajo el mínimo); 40% → 80 recortado a 100', () => {
    const r = () =>
      regla({ action: 'budget_decrease', actionValue: 50, actionUnit: 'percent', budgetMin: 1 });
    const justo = evaluar(r(), [], fila({ dailyBudgetEur: 2 }), ctx({ minimoPresupuesto: 100 }));
    expect(justo.presupuestoDespues).toBe(100);
    expect(justo.motivo).toBeNull();

    const r40 = () =>
      regla({ action: 'budget_decrease', actionValue: 40, actionUnit: 'percent', budgetMin: 1 });
    const recortado = evaluar(r40(), [], fila({ dailyBudgetEur: 2 }), ctx({ minimoPresupuesto: 100 }));
    expect(recortado.presupuestoDespues).toBe(100);
  });

  it('minimoPresupuesto null no se trata como 0: el piso queda a cargo del usuario', () => {
    const r = regla({ action: 'budget_decrease', actionValue: 1, actionUnit: 'fixed', budgetMin: 0.5 });
    const d = evaluar(r, [], fila({ dailyBudgetEur: 2 }), ctx({ minimoPresupuesto: null }));
    // 200 − 100 = 100, piso del usuario 50 → queda 100 (aplica). null no fuerza
    // ningún mínimo de cuenta ni convierte el piso en 0.
    expect(d.motivo).toBeNull();
    expect(d.presupuestoDespues).toBe(100);
  });

  it('tope absoluto (D-A9c): maxDailyBudgetEur 200 y cálculo de 25000 → tope_absoluto, aplicar false', () => {
    const d = evaluar(
      regla({ action: 'budget_increase', actionValue: 2500, actionUnit: 'percent', budgetMax: 1000 }),
      [],
      fila({ dailyBudgetEur: 100 }), // 100 € → 2500% → 25000
      ctx({ maxDailyBudgetEur: 200 }),
    );
    expect(d.motivo).toBe('tope_absoluto');
    expect(d.aplicar).toBe(false);
  });

  it('budgetMode: lifetime con acción de presupuesto → presupuesto_lifetime_no_soportado', () => {
    const d = evaluar(
      regla({ action: 'budget_increase', actionValue: 250, actionUnit: 'percent', budgetMax: 25 }),
      [],
      fila({ budgetLevel: 'adset', budgetMode: 'lifetime' }),
      ctx(),
    );
    expect(d.motivo).toBe('presupuesto_lifetime_no_soportado');
  });
});

describe('debeCorrer — ventana y cadencia', () => {
  const dr = (overrides: Partial<Regla> = {}) => regla({ enabled: true, ...overrides });
  const ahora = new Date('2026-08-12T12:00:00Z');

  it('ventana 22:00–06:00 con 23:30 → corre; con 12:00 → no', () => {
    const r = dr({ windowStart: '22:00', windowEnd: '06:00' });
    expect(debeCorrer(r, { ahora, horaLocal: '23:30', ultimaCorridaAt: null, corridasHoy: 0 }).correr).toBe(true);
    expect(debeCorrer(r, { ahora, horaLocal: '12:00', ultimaCorridaAt: null, corridasHoy: 0 }).motivo).toBe('fuera_de_ventana_horaria');
  });

  it('ventana 09:00–18:00 con 23:30 → no corre', () => {
    const r = dr({ windowStart: '09:00', windowEnd: '18:00' });
    expect(debeCorrer(r, { ahora, horaLocal: '23:30', ultimaCorridaAt: null, corridasHoy: 0 }).correr).toBe(false);
  });

  it('ventana 00:00–00:59 con 00:30 → corre; con 01:00 → no (la regla «Activar todas a las 0 horas»)', () => {
    const r = dr({ windowStart: '00:00', windowEnd: '00:59' });
    expect(debeCorrer(r, { ahora, horaLocal: '00:30', ultimaCorridaAt: null, corridasHoy: 0 }).correr).toBe(true);
    expect(debeCorrer(r, { ahora, horaLocal: '01:00', ultimaCorridaAt: null, corridasHoy: 0 }).correr).toBe(false);
  });

  it('everyMinutes 15 con última corrida hace 3 min → no; hace 16 → sí', () => {
    const r = dr({ everyMinutes: 15 });
    expect(debeCorrer(r, { ahora, horaLocal: '12:00', ultimaCorridaAt: new Date(ahora.getTime() - 3 * 60_000), corridasHoy: 0 }).motivo).toBe('cadencia');
    expect(debeCorrer(r, { ahora, horaLocal: '12:00', ultimaCorridaAt: new Date(ahora.getTime() - 16 * 60_000), corridasHoy: 0 }).correr).toBe(true);
  });

  it('maxRunsPerDay 10 con 10 corridas hoy → no corre', () => {
    const r = dr({ maxRunsPerDay: 10 });
    expect(debeCorrer(r, { ahora, horaLocal: '12:00', ultimaCorridaAt: null, corridasHoy: 10 }).motivo).toBe('max_corridas_diarias');
    expect(debeCorrer(r, { ahora, horaLocal: '12:00', ultimaCorridaAt: null, corridasHoy: 9 }).correr).toBe(true);
  });

  it('regla apagada → motivo apagada', () => {
    expect(debeCorrer(dr({ enabled: false }), { ahora, horaLocal: '12:00', ultimaCorridaAt: null, corridasHoy: 0 }).motivo).toBe('apagada');
  });
});

describe('dentroDeVentana', () => {
  it('soporta ventana que cruza la medianoche', () => {
    expect(dentroDeVentana('23:30', '22:00', '06:00')).toBe(true);
    expect(dentroDeVentana('02:00', '22:00', '06:00')).toBe(true);
    expect(dentroDeVentana('12:00', '22:00', '06:00')).toBe(false);
  });
});

describe('las seis reglas del seed, de punta a punta', () => {
  // Regla 2 «Duplicar a $25»: sales > 2 · roi > 1.3 · spend < 10 · budget < 11, escalar 250%, techo 25.
  const duplicar25 = regla({
    action: 'budget_increase',
    actionValue: 250,
    actionUnit: 'percent',
    budgetMax: 25,
  });
  const cond25: Condicion[] = [
    { metric: 'sales', op: '>', value: 2 },
    { metric: 'roi', op: '>', value: 1.3 },
    { metric: 'spend', op: '<', value: 10 },
    { metric: 'budget', op: '<', value: 11 },
  ];

  it('conjunto roi 1.52, 3 ventas, gasto 8, presupuesto 10 → aplica y el nuevo es 2500', () => {
    const d = evaluar(
      duplicar25,
      cond25,
      fila({ roi: 1.52, sales: 3, spendEur: 8, dailyBudgetEur: 10 }),
      ctx(),
    );
    expect(d.cumple).toBe(true);
    expect(d.aplicar).toBe(true);
    expect(d.presupuestoDespues).toBe(2500);
  });

  it('el mismo con presupuesto 12 → NO cumple (budget < 11)', () => {
    const d = evaluar(
      duplicar25,
      cond25,
      fila({ roi: 1.52, sales: 3, spendEur: 8, dailyBudgetEur: 12 }),
      ctx(),
    );
    expect(d.cumple).toBe(false);
  });

  // Regla 5 «Apagar - Gasto +$10 ROI -1.10»: roi < 1.1 · spend > 7, pausar.
  const apagar10 = regla({ action: 'pause' });
  const cond10: Condicion[] = [
    { metric: 'roi', op: '<', value: 1.1 },
    { metric: 'spend', op: '>', value: 7 },
  ];
  it('roi 0.9, gasto 8 → aplica (pausa)', () => {
    const d = evaluar(apagar10, cond10, fila({ roi: 0.9, spendEur: 8 }), ctx());
    expect(d.cumple).toBe(true);
    expect(d.aplicar).toBe(true);
  });

  // Regla 6 «Apagar - Gasto +$4 sin ventas»: spend > 4 · sales = 0, pausar.
  const apagar4 = regla({ action: 'pause' });
  const cond4: Condicion[] = [
    { metric: 'spend', op: '>', value: 4 },
    { metric: 'sales', op: '=', value: 0 },
  ];
  it('gasto 5, 0 ventas → aplica; gasto 5, 1 venta → NO aplica', () => {
    expect(evaluar(apagar4, cond4, fila({ spendEur: 5, sales: 0 }), ctx()).aplicar).toBe(true);
    expect(evaluar(apagar4, cond4, fila({ spendEur: 5, sales: 1 }), ctx()).cumple).toBe(false);
  });
});

// ─── La ventana en la Zona_Cuenta y las Properties 2 y 6 ────────────────────
// Generadores y oráculos locales (spec reglas-anuncios-por-cuenta). La Hora_Local
// sale de `horaLocalEn`, que la Property 1 ya verificó contra PostgreSQL.

const pad2 = (n: number): string => String(n).padStart(2, '0');
const horaMM = (): fc.Arbitrary<string> =>
  fc.tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 })).map(
    ([h, m]) => `${pad2(h)}:${pad2(m)}`,
  );

const genCondicion = (): fc.Arbitrary<Condicion> =>
  fc
    .tuple(
      fc.constantFrom<Condicion['metric']>(
        'sales', 'revenue', 'spend', 'net', 'profit', 'roi', 'roas', 'cpa',
        'budget', 'impressions', 'clicks', 'ctr', 'cpc',
      ),
      fc.constantFrom<Condicion['op']>('>', '>=', '<', '<=', '=', '!='),
      fc.float({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true }),
    )
    .map(([metric, op, value]) => ({ metric, op, value }));

const AHORA_MS = Date.now();
const FECHA_MIN = new Date(AHORA_MS - 2 * 365.25 * 86_400_000);
const FECHA_MAX = new Date(AHORA_MS + 2 * 365.25 * 86_400_000);

describe('los dos casos del Requisito 5: la ventana se mide en la zona de la cuenta', () => {
  it('ventana 00:00–00:59 en America/Argentina/Buenos_Aires a las 03:30 UTC → corre', () => {
    const instante = new Date('2026-08-12T03:30:00Z');
    const horaLocal = horaLocalEn('America/Argentina/Buenos_Aires', instante);
    expect(horaLocal).toBe('00:30'); // UTC−3 todo el año: sin DST desde 2009
    const r = regla({ enabled: true, windowStart: '00:00', windowEnd: '00:59' });
    expect(
      debeCorrer(r, { ahora: instante, horaLocal, ultimaCorridaAt: null, corridasHoy: 0 }).correr,
    ).toBe(true);
  });

  it('la misma ventana en Europe/Lisbon a las 03:30 UTC → fuera_de_ventana_horaria', () => {
    const instante = new Date('2026-08-12T03:30:00Z');
    const horaLocal = horaLocalEn('Europe/Lisbon', instante);
    const r = regla({ enabled: true, windowStart: '00:00', windowEnd: '00:59' });
    expect(
      debeCorrer(r, { ahora: instante, horaLocal, ultimaCorridaAt: null, corridasHoy: 0 }).motivo,
    ).toBe('fuera_de_ventana_horaria');
  });
});

describe('Property 2: la Ventana_Horaria con la Hora_Local de la Zona_Cuenta', () => {
  it('para toda regla con ventana, toda zona y todo instante, correr equivale a la forma h>=s||h<=e', () => {
    // Feature: reglas-anuncios-por-cuenta, Property 2: La Ventana_Horaria se
    // decide con la Hora_Local de la Zona_Cuenta y cruza medianoche
    fc.assert(
      fc.property(
        genRegla().filter((r) => r.windowStart !== null && r.windowEnd !== null),
        fc.constantFrom(...ZONAS_P16),
        fc.date({ min: FECHA_MIN, max: FECHA_MAX, noInvalidDate: true }),
        (r, zona, instante) => {
          const conVentana = { ...r, enabled: true, everyMinutes: 1, maxRunsPerDay: null };
          const horaLocal = horaLocalEn(zona, instante);
          const h = horaLocal.slice(0, 5);
          const s = conVentana.windowStart!.slice(0, 5);
          const e = conVentana.windowEnd!.slice(0, 5);
          // Oráculo: la forma que soporta el cruce de medianoche. No se usa
          // `dentroDeVentana`, que es justo lo que se verifica.
          const oraculo = s <= e ? h >= s && h <= e : h >= s || h <= e;
          const res = debeCorrer(conVentana, {
            ahora: instante,
            horaLocal,
            ultimaCorridaAt: null,
            corridasHoy: 0,
          });
          expect(res.correr).toBe(oraculo);
          if (!res.correr) expect(res.motivo).toBe('fuera_de_ventana_horaria');
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Property 6: la Decision no depende de la cuenta de la Regla', () => {
  it('cambiar sólo el accountId devuelve una Decision idéntica en sus seis campos', () => {
    // Feature: reglas-anuncios-por-cuenta, Property 6: La Decision del Motor no
    // depende de la cuenta de la Regla
    fc.assert(
      fc.property(
        genRegla(),
        genMetricasObjeto(),
        fc.array(genCondicion(), { minLength: 0, maxLength: 5 }),
        fc.uuid(),
        fc.uuid(),
        (r, fila, condiciones, idA, idB) => {
          if (idA === idB) return;
          const contexto = ctx({ ahora: new Date('2026-08-12T12:00:00Z') });
          const a = evaluar({ ...r, accountId: idA }, condiciones, fila, contexto);
          const b = evaluar({ ...r, accountId: idB }, condiciones, fila, contexto);
          expect(a.cumple).toBe(b.cumple);
          expect(a.motivo).toBe(b.motivo);
          expect(a.aplicar).toBe(b.aplicar);
          expect(a.presupuestoAntes).toBe(b.presupuestoAntes);
          expect(a.presupuestoDespues).toBe(b.presupuestoDespues);
          expect(a.metrics).toEqual(b.metrics);
        },
      ),
      { numRuns: 100 },
    );
  });
});
