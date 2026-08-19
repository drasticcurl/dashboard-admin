/**
 * Tests del traductor UTMify ↔ Reglas.
 *
 * Todo puro: sin base, sin red. El corazón es el CSV REAL que mandó el usuario
 * (12 reglas, `rules-UTMify-3`), verificado valor por valor: si alguien rompe
 * la conversión de céntimos o la dirección del factor de porcentaje, estos
 * tests fallan con el número exacto en vez de dejar pasar una regla que gasta
 * cien veces más de lo que dice su nombre.
 */

import { describe, expect, it } from 'vitest';
import {
  COLUMNAS_UTMIFY,
  exportarCsvUtmify,
  importarCsvUtmify,
  parsearCsv,
  type ReglaImportada,
  type ReglaParaExportar,
} from './utmify';

// ─── El CSV real del usuario, tal cual ──────────────────────────────────────

const CSV_REAL = `adPlatform,name,nameContains,applyTo,actionType,actionFixedCentsInfo,actionLimitCentsInfo,actionPercentInfo,blockConditions,blockOperator,calculationPeriod,frequencyType,frequencyOncePerDayHour,intervalStartTime,intervalEndTime,executionLimit,timeZoneIana,scope
Meta,Activar todas a las 0 horas a ver como rinden,,PausedCampaigns,Enable,,,,"[{""field"":""roi"",""operator"":""GreaterThan"",""valueA"":1.3,""valueB"":null}]",And,LastSevenDays,OncePerDay,0,,,,,
Meta,Duplicar a $25 - Gasto -$10 +2 ventas ROI +1.3,,ActiveAdsets,IncreaseBudget,90099,2500,,"[{""field"":""roi"",""operator"":""GreaterThan"",""valueA"":1.3,""valueB"":null},{""field"":""spend"",""operator"":""LessThan"",""valueA"":1000,""valueB"":null},{""field"":""approvedSales"",""operator"":""GreaterEqual"",""valueA"":2,""valueB"":null}]",And,Today,Each30Mins,,,,,UTC-6,
Meta,Duplicar a $50- Gasto +$15 ROI +1.3,,ActiveAdsets,IncreaseBudget,,5000,5,"[{""field"":""roi"",""operator"":""GreaterThan"",""valueA"":1.3,""valueB"":null},{""field"":""budget"",""operator"":""GreaterThan"",""valueA"":2000,""valueB"":null},{""field"":""spend"",""operator"":""GreaterThan"",""valueA"":1300,""valueB"":null},{""field"":""budget"",""operator"":""LessEqual"",""valueA"":3000,""valueB"":null}]",And,Today,Each30Mins,,,,,UTC-6,
Meta,Duplicar a $100 - Gasto +$50 ROI +1.3,,ActiveAdsets,IncreaseBudget,,10000,2.5,"[{""field"":""roi"",""operator"":""GreaterThan"",""valueA"":1.3,""valueB"":null},{""field"":""spend"",""operator"":""GreaterThan"",""valueA"":3000,""valueB"":null}]",And,Today,Each30Mins,,,,,UTC-6,
Meta,Apagar - Gasto +$10 ROI -1.10,,ActiveAdsets,Pause,,,,"[{""field"":""roi"",""operator"":""LessEqual"",""valueA"":1.05,""valueB"":null},{""field"":""spend"",""operator"":""GreaterEqual"",""valueA"":750,""valueB"":null}]",And,Today,Each10Mins,,,,,,
Meta,Apagar - Gasto +$4 sin ventas,,ActiveAdsets,Pause,,,,"[{""field"":""approvedSales"",""operator"":""LessEqual"",""valueA"":0,""valueB"":null},{""field"":""spend"",""operator"":""GreaterThan"",""valueA"":350,""valueB"":null}]",And,Today,Each10Mins,,,,,,
Meta,Duplicar a $200 - Gasto +$100 ROI +1.3 (copia),,ActiveAdsets,IncreaseBudget,,20000,2.5,"[{""field"":""roi"",""operator"":""GreaterThan"",""valueA"":1.3,""valueB"":null},{""field"":""spend"",""operator"":""GreaterThan"",""valueA"":6500,""valueB"":null}]",And,Today,Each30Mins,,,,,,
Meta,ACTIVAR A LAS 00 CAMPAÑAS,PXN,PausedCampaigns,Enable,,,,"[{""field"":""roi"",""operator"":""GreaterThan"",""valueA"":1.2,""valueB"":null}]",And,LastSevenDays,OncePerDay,0,,,,,
Meta,ACTIVAR A LAS 00 CAMPAÑAS (copia),PXN,PausedAdsets,Enable,,,,"[{""field"":""roi"",""operator"":""GreaterThan"",""valueA"":1.2,""valueB"":null}]",And,LastSevenDays,OncePerDay,0,,,,,
Meta,Apagar - Gasto +$10 ROI -1.10 (copia),,ActiveAdsets,Pause,,,,"[{""field"":""roi"",""operator"":""LessEqual"",""valueA"":1.2,""valueB"":null},{""field"":""spend"",""operator"":""GreaterThan"",""valueA"":900,""valueB"":null}]",And,Today,Each30Mins,,,,,,
Meta,resetear presupuesto a 25 roi 1.8,,ActiveCampaigns,ReduceBudget,90000,2500,,"[{""field"":""roi"",""operator"":""GreaterThan"",""valueA"":1.8,""valueB"":null},{""field"":""spend"",""operator"":""GreaterThan"",""valueA"":2000,""valueB"":null}]",And,Today,OncePerDay,23,,,,,
Meta,resetear presupuesto a 15 roi 1.3,,ActiveCampaigns,ReduceBudget,90000,1500,,"[{""field"":""spend"",""operator"":""GreaterThan"",""valueA"":1000,""valueB"":null},{""field"":""spend"",""operator"":""LessThan"",""valueA"":2000,""valueB"":null},{""field"":""roi"",""operator"":""GreaterThan"",""valueA"":1.3,""valueB"":null}]",And,Today,OncePerDay,23,,,,,
`;

/** Una fila cualquiera del CSV, para armar casos borde sin repetir 18 columnas. */
function fila(over: Partial<Record<(typeof COLUMNAS_UTMIFY)[number], string>>): string {
  const base: Record<(typeof COLUMNAS_UTMIFY)[number], string> = {
    adPlatform: 'Meta',
    name: 'Regla de prueba',
    nameContains: '',
    applyTo: 'ActiveAdsets',
    actionType: 'Pause',
    actionFixedCentsInfo: '',
    actionLimitCentsInfo: '',
    actionPercentInfo: '',
    blockConditions: '[{"field":"roi","operator":"GreaterThan","valueA":1.3,"valueB":null}]',
    blockOperator: 'And',
    calculationPeriod: 'Today',
    frequencyType: 'Each30Mins',
    frequencyOncePerDayHour: '',
    intervalStartTime: '',
    intervalEndTime: '',
    executionLimit: '',
    timeZoneIana: '',
    scope: '',
  };
  const f = { ...base, ...over };
  const escapar = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `${COLUMNAS_UTMIFY.join(',')}\n${COLUMNAS_UTMIFY.map((c) => escapar(f[c])).join(',')}\n`;
}

function unaRegla(csv: string): ReglaImportada {
  const r = importarCsvUtmify(csv);
  expect(r.errores).toEqual([]);
  expect(r.reglas).toHaveLength(1);
  return r.reglas[0];
}

function errorDe(csv: string): string {
  const r = importarCsvUtmify(csv);
  expect(r.reglas).toHaveLength(0);
  expect(r.errores).toHaveLength(1);
  return r.errores[0].error;
}

// ─── El parser de CSV ───────────────────────────────────────────────────────

describe('parsearCsv', () => {
  it('no parte por las comas que están adentro de un campo entrecomillado', () => {
    // Es EL caso del formato: blockConditions es JSON con comas adentro. Un
    // split(',') devolvería 5 campos en vez de 2.
    const filas = parsearCsv('a,b\n1,"x,y,z"\n');
    expect(filas).toEqual([
      ['a', 'b'],
      ['1', 'x,y,z'],
    ]);
  });

  it('convierte "" en una comilla literal', () => {
    const filas = parsearCsv('a\n"dijo ""hola"""\n');
    expect(filas).toEqual([['a'], ['dijo "hola"']]);
  });

  it('acepta CRLF y no deja un \\r pegado al último campo', () => {
    expect(parsearCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('se come el BOM que agregan Excel y Sheets', () => {
    // Sin esto la primera columna se llama '\uFEFFadPlatform' y no se reconoce
    // ninguna cabecera.
    expect(parsearCsv('\uFEFFadPlatform,name\nMeta,x\n')[0][0]).toBe('adPlatform');
  });

  it('conserva los campos vacíos del final de la fila', () => {
    expect(parsearCsv('a,b,c\n1,,\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', ''],
    ]);
  });

  it('ignora las líneas en blanco', () => {
    expect(parsearCsv('a\n1\n\n\n')).toEqual([['a'], ['1']]);
  });
});

// ─── El CSV real, fila por fila ─────────────────────────────────────────────

describe('importarCsvUtmify — el CSV real del usuario (12 reglas)', () => {
  const res = importarCsvUtmify(CSV_REAL);

  it('importa las 12 filas sin un solo error', () => {
    expect(res.errores).toEqual([]);
    expect(res.reglas).toHaveLength(12);
  });

  it('fila 1 «Activar todas a las 0 horas»: campaña pausada, 1×/día a las 00', () => {
    expect(res.reglas[0]).toEqual({
      name: 'Activar todas a las 0 horas a ver como rinden',
      level: 'campaign',
      statusFilter: 'paused',
      nameFilter: null,
      nameFilterMode: 'contains',
      action: 'activate',
      actionValue: null,
      actionUnit: null,
      budgetMax: null,
      budgetMin: null,
      period: '7d_excl_today',
      everyMinutes: 1440,
      windowStart: '00:00',
      windowEnd: '00:59',
      maxRunsPerDay: 1,
      cooldownMinutes: 1440,
      maxActionsPerObjectPerDay: 4,
      conditions: [{ metric: 'roi', op: '>', value: 1.3 }],
    });
  });

  it('fila 2 «Duplicar a $25»: fijo €900,99 con techo €25 (céntimos ÷ 100)', () => {
    const r = res.reglas[1];
    expect(r.action).toBe('budget_increase');
    expect(r.actionUnit).toBe('fixed');
    // 90099 céntimos = €900,99. Si esto llegara como 90099 la regla intentaría
    // subir el presupuesto a noventa mil euros en cada corrida.
    expect(r.actionValue).toBe(900.99);
    expect(r.budgetMax).toBe(25);
    expect(r.budgetMin).toBeNull();
    expect(r.level).toBe('adset');
    expect(r.statusFilter).toBe('active');
    expect(r.everyMinutes).toBe(30);
    // Las tres condiciones: ROI es un múltiplo (no se divide), el gasto son
    // céntimos (sí se divide) y las ventas son una cantidad (no se divide).
    expect(r.conditions).toEqual([
      { metric: 'roi', op: '>', value: 1.3 },
      { metric: 'spend', op: '<', value: 10 },
      { metric: 'sales', op: '>=', value: 2 },
    ]);
  });

  it('fila 3 «Duplicar a $50»: el factor 5 de UTMify es 500% acá', () => {
    const r = res.reglas[2];
    expect(r.actionUnit).toBe('percent');
    expect(r.actionValue).toBe(500);
    expect(r.budgetMax).toBe(50);
    expect(r.conditions).toEqual([
      { metric: 'roi', op: '>', value: 1.3 },
      { metric: 'budget', op: '>', value: 20 },
      { metric: 'spend', op: '>', value: 13 },
      { metric: 'budget', op: '<=', value: 30 },
    ]);
  });

  it('fila 4 «Duplicar a $100»: el factor 2,5 es 250%', () => {
    const r = res.reglas[3];
    expect(r.actionValue).toBe(250);
    expect(r.actionUnit).toBe('percent');
    expect(r.budgetMax).toBe(100);
    expect(r.conditions).toEqual([
      { metric: 'roi', op: '>', value: 1.3 },
      { metric: 'spend', op: '>', value: 30 },
    ]);
  });

  it('fila 5 «Apagar ROI -1.10»: pausa cada 10 min, gasto €7,50', () => {
    const r = res.reglas[4];
    expect(r.action).toBe('pause');
    expect(r.actionValue).toBeNull();
    expect(r.actionUnit).toBeNull();
    expect(r.budgetMax).toBeNull();
    expect(r.everyMinutes).toBe(10);
    expect(r.cooldownMinutes).toBe(10);
    expect(r.conditions).toEqual([
      { metric: 'roi', op: '<=', value: 1.05 },
      { metric: 'spend', op: '>=', value: 7.5 },
    ]);
  });

  it('fila 6 «Apagar sin ventas»: ventas <= 0 y gasto €3,50', () => {
    expect(res.reglas[5].conditions).toEqual([
      { metric: 'sales', op: '<=', value: 0 },
      { metric: 'spend', op: '>', value: 3.5 },
    ]);
  });

  it('fila 7 «Duplicar a $200»: techo €200 y gasto €65', () => {
    const r = res.reglas[6];
    expect(r.budgetMax).toBe(200);
    expect(r.conditions[1]).toEqual({ metric: 'spend', op: '>', value: 65 });
  });

  it('fila 8 «ACTIVAR A LAS 00 CAMPAÑAS»: filtro de nombre PXN', () => {
    const r = res.reglas[7];
    expect(r.nameFilter).toBe('PXN');
    expect(r.nameFilterMode).toBe('contains');
    expect(r.level).toBe('campaign');
    expect(r.statusFilter).toBe('paused');
  });

  it('fila 9 «(copia)»: igual que la 8 pero a nivel conjunto', () => {
    const r = res.reglas[8];
    expect(r.level).toBe('adset');
    expect(r.statusFilter).toBe('paused');
    expect(r.nameFilter).toBe('PXN');
  });

  it('fila 10 «Apagar (copia)»: el nombre dice $10 pero la condición dice €9', () => {
    // El nombre y la condición no coinciden EN EL EXPORT. Se importa el valor
    // real (900 céntimos = €9), no el del nombre: el nombre es una etiqueta que
    // el usuario escribió, la condición es lo que la regla hace.
    expect(res.reglas[9].conditions).toEqual([
      { metric: 'roi', op: '<=', value: 1.2 },
      { metric: 'spend', op: '>', value: 9 },
    ]);
  });

  it('fila 11 «resetear a 25»: bajar con piso €25, una vez al día a las 23', () => {
    expect(res.reglas[10]).toEqual({
      name: 'resetear presupuesto a 25 roi 1.8',
      level: 'campaign',
      statusFilter: 'active',
      nameFilter: null,
      nameFilterMode: 'contains',
      action: 'budget_decrease',
      actionValue: 900,
      actionUnit: 'fixed',
      budgetMax: null,
      // El truco del "resetear": restar €900 con piso €25 deja el presupuesto
      // EN €25, sea cual sea el valor de partida.
      budgetMin: 25,
      period: 'today',
      everyMinutes: 1440,
      windowStart: '23:00',
      windowEnd: '23:59',
      maxRunsPerDay: 1,
      cooldownMinutes: 1440,
      maxActionsPerObjectPerDay: 4,
      conditions: [
        { metric: 'roi', op: '>', value: 1.8 },
        { metric: 'spend', op: '>', value: 20 },
      ],
    });
  });

  it('fila 12 «resetear a 15»: piso €15 y un rango de gasto con dos condiciones', () => {
    const r = res.reglas[11];
    expect(r.budgetMin).toBe(15);
    expect(r.conditions).toEqual([
      { metric: 'spend', op: '>', value: 10 },
      { metric: 'spend', op: '<', value: 20 },
      { metric: 'roi', op: '>', value: 1.3 },
    ]);
  });

  it('avisa de la zona horaria que ignora y de los frenos que pone', () => {
    const todos = res.avisos.join(' ');
    expect(todos).toContain('UTC-6');
    expect(todos).toContain('cooldown');
    expect(todos).toContain('apagada y en modo simulación');
    expect(todos).toContain('7 días sin hoy');
  });

  it('ninguna regla importada trae enabled ni dryRun: no son del formato', () => {
    for (const r of res.reglas) {
      expect(r).not.toHaveProperty('enabled');
      expect(r).not.toHaveProperty('dryRun');
      expect(r).not.toHaveProperty('accountId');
    }
  });
});

// ─── Lo que se rechaza, y por qué ───────────────────────────────────────────

describe('importarCsvUtmify — filas que no se pueden traducir', () => {
  it('rechaza blockOperator Or: el motor no tiene OR', () => {
    // Importarlo como And cambiaría el conjunto de objetos alcanzados sin que
    // nadie se entere: es el error más caro que puede tener este import.
    expect(errorDe(fila({ blockOperator: 'Or' }))).toContain('sólo combina condiciones con Y');
  });

  it('rechaza un applyTo desconocido', () => {
    expect(errorDe(fila({ applyTo: 'ActiveWhatever' }))).toContain('no se reconoce');
  });

  it('rechaza el operador Between y sugiere las dos condiciones', () => {
    const csv = fila({
      blockConditions: '[{"field":"roi","operator":"Between","valueA":1,"valueB":2}]',
    });
    expect(errorDe(csv)).toContain('dos condiciones');
  });

  it('rechaza valueB no nulo aunque el operador sea simple', () => {
    const csv = fila({
      blockConditions: '[{"field":"roi","operator":"GreaterThan","valueA":1,"valueB":5}]',
    });
    expect(errorDe(csv)).toContain('valueB');
  });

  it('rechaza una métrica que este panel no tiene', () => {
    const csv = fila({
      blockConditions: '[{"field":"frequency","operator":"GreaterThan","valueA":3,"valueB":null}]',
    });
    expect(errorDe(csv)).toContain('no existe en este panel');
  });

  it('rechaza subir presupuesto sin techo', () => {
    const csv = fila({ actionType: 'IncreaseBudget', actionPercentInfo: '2', actionLimitCentsInfo: '' });
    expect(errorDe(csv)).toContain('no se detiene nunca');
  });

  it('rechaza bajar presupuesto sin piso', () => {
    const csv = fila({ actionType: 'ReduceBudget', actionFixedCentsInfo: '1000', actionLimitCentsInfo: '' });
    expect(errorDe(csv)).toContain('piso');
  });

  it('rechaza un factor que sube cuando la acción baja', () => {
    // percent 2 = 200% multiplica por 2 y SUBE: con ReduceBudget es una
    // contradicción que la base también rechaza (ad_rules_percent_direccion).
    const csv = fila({ actionType: 'ReduceBudget', actionPercentInfo: '2', actionLimitCentsInfo: '500' });
    expect(errorDe(csv)).toContain('lo SUBE');
  });

  it('rechaza un factor que baja cuando la acción sube', () => {
    const csv = fila({ actionType: 'IncreaseBudget', actionPercentInfo: '0.5', actionLimitCentsInfo: '5000' });
    expect(errorDe(csv)).toContain('lo BAJA');
  });

  it('rechaza presupuesto a nivel anuncio (en Meta los anuncios no tienen)', () => {
    const csv = fila({
      applyTo: 'ActiveAds',
      actionType: 'IncreaseBudget',
      actionPercentInfo: '2',
      actionLimitCentsInfo: '5000',
    });
    expect(errorDe(csv)).toContain('anuncios no tienen presupuesto');
  });

  it('rechaza porcentaje y fijo al mismo tiempo', () => {
    const csv = fila({
      actionType: 'IncreaseBudget',
      actionPercentInfo: '2',
      actionFixedCentsInfo: '1000',
      actionLimitCentsInfo: '5000',
    });
    expect(errorDe(csv)).toContain('no se sabe cuál usar');
  });

  it('rechaza una plataforma que no es Meta', () => {
    expect(errorDe(fila({ adPlatform: 'Google' }))).toContain('sólo maneja Meta');
  });

  it('rechaza el nombre vacío', () => {
    expect(errorDe(fila({ name: '' }))).toContain('name');
  });

  it('rechaza media ventana horaria', () => {
    const csv = fila({ intervalStartTime: '08:00', intervalEndTime: '' });
    expect(errorDe(csv)).toContain('completa o vacía');
  });

  it('una fila mala no se lleva puestas a las buenas', () => {
    const malaYBuena = `${CSV_REAL}Meta,Rota,,ActiveNada,Pause,,,,[],And,Today,Each10Mins,,,,,,\n`;
    const r = importarCsvUtmify(malaYBuena);
    expect(r.reglas).toHaveLength(12);
    expect(r.errores).toHaveLength(1);
    expect(r.errores[0].name).toBe('Rota');
    expect(r.errores[0].linea).toBe(14);
  });

  it('un archivo que no es de reglas se rechaza entero, con explicación', () => {
    const r = importarCsvUtmify('foo,bar\n1,2\n');
    expect(r.reglas).toHaveLength(0);
    expect(r.avisos.join(' ')).toContain('no parece un export de reglas de UTMify');
  });

  it('un archivo vacío no explota', () => {
    expect(importarCsvUtmify('')).toEqual({ reglas: [], errores: [], avisos: ['El archivo está vacío.'] });
  });

  it('deduplica los nombres repetidos y lo avisa', () => {
    const dos = `${CSV_REAL}Meta,Apagar - Gasto +$4 sin ventas,,ActiveAdsets,Pause,,,,[],And,Today,Each10Mins,,,,,,\n`;
    const r = importarCsvUtmify(dos);
    expect(r.reglas.filter((x) => x.name === 'Apagar - Gasto +$4 sin ventas')).toHaveLength(1);
    expect(r.avisos.join(' ')).toContain('más de una vez');
  });

  it('una regla sin condiciones se importa pero con un aviso fuerte', () => {
    const r = importarCsvUtmify(fila({ blockConditions: '' }));
    expect(r.reglas).toHaveLength(1);
    expect(r.reglas[0].conditions).toEqual([]);
    expect(r.avisos.join(' ')).toContain('TODOS los objetos');
  });
});

// ─── Export y round-trip ────────────────────────────────────────────────────

describe('exportarCsvUtmify', () => {
  const importadas = importarCsvUtmify(CSV_REAL).reglas;
  const paraExportar: ReglaParaExportar[] = importadas.map((r) => ({
    ...r,
    accountId: 'act_123',
    condiciones: r.conditions,
  }));

  it('escribe el encabezado exacto de UTMify', () => {
    expect(exportarCsvUtmify(paraExportar).split('\n')[0]).toBe(COLUMNAS_UTMIFY.join(','));
  });

  it('escribe una línea por regla más el encabezado', () => {
    const lineas = exportarCsvUtmify(paraExportar).trimEnd().split('\n');
    expect(lineas).toHaveLength(13);
  });

  it('vuelve a poner los importes en céntimos', () => {
    const csv = exportarCsvUtmify([paraExportar[1]]);
    // €900,99 → 90099 y techo €25 → 2500, los mismos números del archivo original.
    expect(csv).toContain(',90099,2500,');
  });

  it('vuelve a poner el porcentaje como factor', () => {
    const csv = exportarCsvUtmify([paraExportar[3]]);
    // 250% → 2.5, no 250 ni 2.50.
    expect(csv.split('\n')[1]).toContain(',2.5,');
  });

  it('el JSON de condiciones queda entrecomillado y con "" adentro', () => {
    const csv = exportarCsvUtmify([paraExportar[0]]);
    expect(csv).toContain('"[{""field"":""roi""');
  });

  it('reescribe las ventas como approvedSales', () => {
    const csv = exportarCsvUtmify([paraExportar[5]]);
    expect(csv).toContain('approvedSales');
  });

  it('OncePerDay va con la hora en su columna y los intervalos vacíos', () => {
    const csv = exportarCsvUtmify([paraExportar[10]]); // la de las 23:00
    const campos = parsearCsv(csv)[1];
    const idx = (c: string): number => COLUMNAS_UTMIFY.indexOf(c as (typeof COLUMNAS_UTMIFY)[number]);
    expect(campos[idx('frequencyType')]).toBe('OncePerDay');
    expect(campos[idx('frequencyOncePerDayHour')]).toBe('23');
    expect(campos[idx('intervalStartTime')]).toBe('');
    expect(campos[idx('intervalEndTime')]).toBe('');
  });

  it('pone el id de cuenta en scope: sin eso, dos cuentas dan nombres repetidos', () => {
    const campos = parsearCsv(exportarCsvUtmify([paraExportar[0]]))[1];
    expect(campos[COLUMNAS_UTMIFY.indexOf('scope')]).toBe('act_123');
  });

  it('ROUND-TRIP: importar → exportar → importar da exactamente lo mismo', () => {
    // Es la garantía de que las dos direcciones son inversas de verdad. Si una
    // conversión de céntimos o de factor está sólo en un sentido, esto falla.
    const vuelta = importarCsvUtmify(exportarCsvUtmify(paraExportar));
    expect(vuelta.errores).toEqual([]);
    expect(vuelta.reglas).toEqual(importadas);
  });

  it('ROUND-TRIP del archivo original: el CSV exportado reimporta igual', () => {
    const csv = exportarCsvUtmify(paraExportar);
    const vuelta = importarCsvUtmify(csv).reglas;
    for (let i = 0; i < importadas.length; i++) {
      expect(vuelta[i].name).toBe(importadas[i].name);
      expect(vuelta[i].action).toBe(importadas[i].action);
      expect(vuelta[i].actionValue).toBe(importadas[i].actionValue);
      expect(vuelta[i].actionUnit).toBe(importadas[i].actionUnit);
      expect(vuelta[i].budgetMax).toBe(importadas[i].budgetMax);
      expect(vuelta[i].budgetMin).toBe(importadas[i].budgetMin);
      expect(vuelta[i].conditions).toEqual(importadas[i].conditions);
      expect(vuelta[i].everyMinutes).toBe(importadas[i].everyMinutes);
      expect(vuelta[i].windowStart).toBe(importadas[i].windowStart);
      expect(vuelta[i].level).toBe(importadas[i].level);
      expect(vuelta[i].statusFilter).toBe(importadas[i].statusFilter);
    }
  });

  it('un nombre con comas y comillas sobrevive el round-trip', () => {
    const raro: ReglaParaExportar = {
      ...paraExportar[0],
      name: 'Apagar "malas", ROI < 1,05',
    };
    const vuelta = importarCsvUtmify(exportarCsvUtmify([raro]));
    expect(vuelta.errores).toEqual([]);
    expect(vuelta.reglas[0].name).toBe('Apagar "malas", ROI < 1,05');
  });
});
