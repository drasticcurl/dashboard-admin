/**
 * Tests de los briefs. Todo PURO: sin base, sin red, sin `skipIf`.
 *
 * ─── EL TEST QUE JUSTIFICA EL ARCHIVO ──────────────────────────────────────
 * "el brief no cambia si los datos no cambian". La huella del brief ES la caché
 * (migración 029), así que un `generatedAt` que se cuele adentro no rompe nada
 * visible: la pantalla sigue funcionando, los insights siguen apareciendo, y lo
 * único que pasa es que cada llamada paga de nuevo porque la huella nunca
 * coincide. Es una regresión que no da ningún error y sólo se ve en la factura,
 * así que tiene que estar lockeada por un test.
 *
 * El resto cubre los signos y la propagación de null, que es donde un error se
 * ve razonable en pantalla.
 */

import { describe, expect, it } from 'vitest';
import { mediana, ratio, variacion } from './brief';
import { armarBriefResumen } from './brief-resumen';
import { armarBriefFinanzas } from './brief-finanzas';
import type { FunnelSummary, OverviewData } from '@/lib/queries/overview';
import type { ReconciliacionMes } from '@/lib/queries/reconciliacion';

// ─── Helpers de brief.ts ────────────────────────────────────────────────────

describe('mediana', () => {
  it('ignora los null en vez de contarlos como 0', () => {
    // Con los null como 0 la mediana de esto sería 0.1 y no 0.2.
    expect(mediana([0.1, null, 0.2, null, 0.3])).toBe(0.2);
  });

  it('devuelve null si no queda ningún valor', () => {
    expect(mediana([null, null])).toBeNull();
    expect(mediana([])).toBeNull();
  });

  it('promedia los dos centrales con cantidad par', () => {
    expect(mediana([0.1, 0.2, 0.3, 0.4])).toBeCloseTo(0.25, 10);
  });

  it('es mediana y no promedio: un outlier no la mueve', () => {
    // El caso real: un funnel con 4 sesiones y 1 venta convierte al 25 % y
    // correría el promedio lo suficiente para que los otros tres parezcan malos.
    expect(mediana([0.02, 0.025, 0.03, 0.25])).toBeCloseTo(0.0275, 10);
  });
});

describe('variacion', () => {
  it('devuelve null sin base, y no 0 %', () => {
    expect(variacion(100, null)).toBeNull();
    expect(variacion(100, undefined)).toBeNull();
    expect(variacion(100, 0)).toBeNull();
  });

  it('usa el valor absoluto de la base: una mejora sobre una pérdida es positiva', () => {
    // Venía perdiendo 1000 y ahora pierde 500: mejoró. Dividiendo por −1000
    // saldría −0,5 y se leería como una caída del 50 %.
    expect(variacion(-500, -1000)).toBe(0.5);
  });

  it('calcula la variación normal', () => {
    expect(variacion(120, 100)).toBe(0.2);
    expect(variacion(80, 100)).toBe(-0.2);
  });
});

describe('ratio', () => {
  it('devuelve null sin denominador en vez de Infinity o NaN', () => {
    expect(ratio(10, 0)).toBeNull();
    expect(ratio(0, 0)).toBeNull();
  });
});

// ─── Fábricas ───────────────────────────────────────────────────────────────

function funnel(over: Partial<FunnelSummary> = {}): FunnelSummary {
  return {
    funnelId: 1,
    slug: 'uno',
    name: 'Uno',
    color: '#fff',
    sellCurrency: 'ARS',
    timezone: 'America/Argentina/Buenos_Aires',
    sessions: 1000,
    quizStarted: 600,
    salesViews: 300,
    checkoutClicks: 100,
    orders: 30,
    ordersRefunded: 1,
    netEur: 3000,
    netOrig: 3000,
    adSpendEur: 1000,
    adSpendOrig: 1000,
    grossEur: 3500,
    resultEur: 2000,
    roas: 3.5,
    // roi = neto ÷ gasto = 3000/1000 (campo agregado por T07 del módulo
    // usuarios-y-tareas; esta fábrica sólo completa el tipo, el brief no lo usa).
    roi: 3,
    convSessionToSale: 0.03,
    avgTicketEur: 100,
    lastEventAt: '2026-09-03T12:00:00.000Z',
    refundRate: 1 / 30,
    netMargin: 3000 / 3500,
    convCheckoutToSale: 0.3,
    convSessionToQuiz: 0.6,
    convQuizToSalesView: 0.5,
    revPerSession: 3,
    cpa: 1000 / 30,
    ...over,
  };
}

function overview(over: Partial<OverviewData> = {}): OverviewData {
  return {
    totals: {
      sessions: 1000,
      orders: 30,
      netEur: 3000,
      avgTicketEur: 100,
      ordersRefunded: 1,
      refundedEur: 100,
      adSpendEur: 1000,
      resultEur: 2000,
      roas: 3.5,
      roi: 3,
      grossEur: 3500,
      quizStarted: 600,
      salesViews: 300,
      checkoutClicks: 100,
      refundRate: 1 / 30,
      netMargin: 3000 / 3500,
      convSessionToSale: 0.03,
      convCheckoutToSale: 0.3,
      revPerSession: 3,
      cpa: 1000 / 30,
    },
    funnels: [funnel()],
    byDay: [
      { day: '2026-09-01', netEur: 1500, orders: 15, sessions: 500, perFunnel: { uno: 1500 } },
      { day: '2026-09-02', netEur: 1500, orders: 15, sessions: 500, perFunnel: { uno: 1500 } },
    ],
    alerts: [],
    generatedAt: '2026-09-04T15:00:00.000Z',
    staleRollup: false,
    prev: null,
    lastRollupAt: '2026-09-04T14:55:00.000Z',
    // El insight guardado NO entra al brief: sería darle de comer al modelo su
    // propia salida anterior, y además `generadoEn` es un timestamp que rompería
    // la huella. Está acá sólo para completar el tipo.
    insight: null,
    ...over,
  };
}

const RANGO = { from: '2026-09-01', to: '2026-09-02' };

// ─── La huella ──────────────────────────────────────────────────────────────

describe('estabilidad del brief (esto protege la caché)', () => {
  it('el brief del Resumen no contiene NINGUN timestamp', () => {
    const brief = armarBriefResumen(overview(), RANGO);
    const json = JSON.stringify(brief);

    // `generatedAt` y `lastRollupAt` existen en OverviewData y cambian en cada
    // request. Si alguno se cuela, la huella nunca vuelve a coincidir y cada
    // apertura de la pantalla paga una llamada nueva.
    expect(json).not.toContain('generatedAt');
    expect(json).not.toContain('lastRollupAt');
    expect(json).not.toContain('2026-09-04T15:00:00.000Z');
    expect(json).not.toContain('2026-09-04T14:55:00.000Z');
    // Ninguna hora con formato ISO, venga del campo que venga.
    expect(json).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('dos briefs de los mismos datos son byte-idénticos', () => {
    // Es la propiedad que hace que la huella sirva. Si esto falla, hay algo no
    // determinístico adentro (un Date, un Math.random, un orden de Map).
    const a = JSON.stringify(armarBriefResumen(overview(), RANGO));
    const b = JSON.stringify(armarBriefResumen(overview(), RANGO));
    expect(a).toBe(b);
  });

  it('el brief de Finanzas tampoco trae timestamps, pero sí el día', () => {
    const brief = armarBriefFinanzas({
      hoy: '2026-09-04',
      reconciliacion: [],
      ultimoPatrimonio: null,
      faltanCargarHoy: [],
      serieDelMes: [],
      movimientos: [],
      atrasados: [],
    });
    const json = JSON.stringify(brief);

    // La FECHA sí va: cambia una vez por día, que es la cadencia buscada.
    expect(brief.hoy).toBe('2026-09-04');
    // La HORA no.
    expect(json).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });
});

// ─── Resumen ────────────────────────────────────────────────────────────────

describe('armarBriefResumen', () => {
  it('calcula el tramo vista → checkout, que no existe en FunnelSummary', () => {
    // Sin este tramo, un funnel que lleva gente a la página de venta y no la
    // hace clickear es indistinguible de uno que sí y pierde en el checkout.
    const brief = armarBriefResumen(overview(), RANGO);
    // 100 clicks ÷ 300 vistas
    expect(brief.funnels[0]!.embudo.vistaACheckout).toBeCloseTo(0.3333, 4);
  });

  it('normaliza a null los campos viejos que devuelven 0 sin denominador', () => {
    // `roas`, `avgTicketEur` y `convSessionToSale` devuelven 0 sin denominador
    // por compatibilidad con las vistas (documentado en overview.ts). El brief no
    // puede decirle al modelo que el ROAS fue 0 cuando lo que pasa es que no hay
    // gasto cargado — es exactamente el caso de la instancia sin módulo de ads.
    const sinAds = overview({
      funnels: [funnel({ adSpendEur: 0, roas: 0, orders: 0, avgTicketEur: 0, cpa: null })],
    });
    const f = armarBriefResumen(sinAds, RANGO).funnels[0]!;

    expect(f.roas).toBeNull();
    expect(f.ticketPromedioEur).toBeNull();
    expect(f.cpaEur).toBeNull();
  });

  it('marca como no comparable un funnel sin tráfico suficiente y lo saca de la mediana', () => {
    const brief = armarBriefResumen(
      overview({
        funnels: [
          funnel({ slug: 'grande', sessions: 1000, convCheckoutToSale: 0.3 }),
          // 4 sesiones, 1 venta: 25 % de conversión que no significa nada.
          funnel({ slug: 'chico', sessions: 4, orders: 1, convCheckoutToSale: 1 }),
        ],
      }),
      RANGO,
    );

    expect(brief.funnels.find((f) => f.slug === 'chico')!.comparable).toBe(false);
    // La mediana es la del funnel grande solo, no 0.65.
    expect(brief.medianasDelConjunto.checkoutAOrden).toBe(0.3);
  });

  it('sin período anterior no inventa deltas', () => {
    expect(armarBriefResumen(overview({ prev: null }), RANGO).cambioVsAnterior).toBeNull();
  });

  it('descompone el cambio contra el período anterior', () => {
    const brief = armarBriefResumen(
      overview({
        prev: { netEur: 4000, orders: 40, sessions: 800, avgTicketEur: 100, adSpendEur: 800, resultEur: 3200 },
      }),
      RANGO,
    );

    // El neto bajó 25 % pero las sesiones subieron 25 %: no es tráfico. Es
    // exactamente la lectura que el brief tiene que habilitar.
    expect(brief.cambioVsAnterior!.netoPct).toBe(-0.25);
    expect(brief.cambioVsAnterior!.sesionesPct).toBe(0.25);
    expect(brief.cambioVsAnterior!.resultadoAbsEur).toBe(-1200);
  });

  it('pasa el estado del rollup como confiabilidad', () => {
    expect(armarBriefResumen(overview({ staleRollup: true }), RANGO).datosConfiables).toBe(false);
    expect(armarBriefResumen(overview({ staleRollup: false }), RANGO).datosConfiables).toBe(true);
  });
});

// ─── Finanzas ───────────────────────────────────────────────────────────────

function mes(over: Partial<ReconciliacionMes> = {}): ReconciliacionMes {
  return {
    month: '2026-07',
    gananciaMedidaEur: 3100,
    cierreEur: 10000,
    diaCierre: '2026-07-31',
    resultadoOperativoEur: 4000,
    netoEur: 5000,
    adsEur: 1000,
    gastosEur: 900,
    retirosEur: 0,
    aportesEur: 0,
    ajustesEur: 0,
    esperadoEur: 3100,
    huecoEur: 0,
    huecoPct: 0,
    ...over,
  };
}

const BASE_FIN = {
  hoy: '2026-09-04',
  ultimoPatrimonio: null,
  faltanCargarHoy: [],
  serieDelMes: [],
  movimientos: [],
  atrasados: [],
};

describe('armarBriefFinanzas — la racha de huecos', () => {
  it('cuenta los meses consecutivos con el hueco del mismo signo', () => {
    // Tres meses seguidos con hueco negativo: no es timing, falta registrar algo.
    const brief = armarBriefFinanzas({
      ...BASE_FIN,
      reconciliacion: [
        mes({ month: '2026-06', huecoEur: -500 }),
        mes({ month: '2026-07', huecoEur: -600 }),
        mes({ month: '2026-08', huecoEur: -400 }),
      ],
    });

    expect(brief.huecos.rachaMismoSigno).toBe(3);
    expect(brief.huecos.acumuladoEur).toBe(-1500);
  });

  it('un hueco que alterna de signo corta la racha en 1', () => {
    // El patrón de timing: una venta del 31 que entra al banco el 2 deja el hueco
    // de un mes invertido en el siguiente, y los dos se compensan.
    const brief = armarBriefFinanzas({
      ...BASE_FIN,
      reconciliacion: [
        mes({ month: '2026-07', huecoEur: -500 }),
        mes({ month: '2026-08', huecoEur: 500 }),
      ],
    });

    expect(brief.huecos.rachaMismoSigno).toBe(1);
    expect(brief.huecos.acumuladoEur).toBe(0);
  });

  it('un mes sin medir corta la racha: no se afirma continuidad sobre un hueco desconocido', () => {
    const brief = armarBriefFinanzas({
      ...BASE_FIN,
      reconciliacion: [
        mes({ month: '2026-06', huecoEur: -500 }),
        mes({ month: '2026-07', gananciaMedidaEur: null, huecoEur: null }),
        mes({ month: '2026-08', huecoEur: -400 }),
      ],
    });

    expect(brief.huecos.rachaMismoSigno).toBe(1);
    expect(brief.huecos.mesesSinMedir).toBe(1);
  });
});

describe('armarBriefFinanzas — runway y patrimonio', () => {
  it('el runway usa el dinero LIQUIDO, no el patrimonio total', () => {
    // Con 6000 líquidos, 9000 retenidos y 3000 de deuda, el patrimonio son
    // 12000. Usar el total daría 12 meses de runway; los reales son 6, porque el
    // retenido no paga el alquiler.
    const brief = armarBriefFinanzas({
      ...BASE_FIN,
      ultimoPatrimonio: {
        day: '2026-09-03',
        totalEur: 12000,
        dineroEur: 6000,
        retenidoEur: 9000,
        deudaEur: 3000,
        esperadas: 4,
        cargadas: 4,
        completo: true,
        faltan: [],
      },
      // Dos meses cerrados con 1000 de gastos cada uno → promedio 1000.
      reconciliacion: [
        mes({ month: '2026-07', gastosEur: 1000 }),
        mes({ month: '2026-08', gastosEur: 1000 }),
      ],
    });

    expect(brief.gastos.promedioMensualEur).toBe(1000);
    expect(brief.gastos.runwayMeses).toBe(6);
    expect(brief.patrimonio!.proporcionRetenido).toBe(0.6);
    expect(brief.patrimonio!.deudaSobreLiquido).toBe(0.5);
  });

  it('excluye el mes en curso del promedio de gastos', () => {
    // Septiembre está a medias: si entrara al promedio, lo bajaría y el runway
    // saldría falsamente optimista.
    const brief = armarBriefFinanzas({
      ...BASE_FIN,
      hoy: '2026-09-04',
      reconciliacion: [
        mes({ month: '2026-08', gastosEur: 1000 }),
        mes({ month: '2026-09', gastosEur: 50 }),
      ],
    });

    expect(brief.gastos.promedioMensualEur).toBe(1000);
  });

  it('sin patrimonio cargado el bloque entero es null, no un objeto de ceros', () => {
    // El bug que este test bloquea: mandarle `dineroEur: 0` al modelo le hace
    // escribir "no queda plata" sobre una empresa que sólo no cargó los saldos.
    // Y con el promedio de gastos en 1000, un `dinero` de 0 daba runwayMeses: 0,
    // que es la afirmación más alarmante que el panel puede hacer.
    const brief = armarBriefFinanzas({
      ...BASE_FIN,
      reconciliacion: [mes({ month: '2026-08', gastosEur: 1000 })],
    });

    expect(brief.patrimonio).toBeNull();
    expect(brief.gastos.promedioMensualEur).toBe(1000);
    expect(brief.gastos.runwayMeses).toBeNull();
  });

  it('cuenta los días incompletos del mes con el criterio de saldo.ts', () => {
    const brief = armarBriefFinanzas({
      ...BASE_FIN,
      reconciliacion: [],
      serieDelMes: [
        { day: '2026-09-01', totalEur: 100 },
        { day: '2026-09-02', totalEur: null },
        { day: '2026-09-03', totalEur: null },
        { day: '2026-09-04', totalEur: 120 },
      ],
    });

    expect(brief.completitud.diasIncompletosDelMes).toBe(2);
    expect(brief.completitud.diasDelMesTranscurridos).toBe(4);
  });
});

describe('armarBriefFinanzas — gastos por categoría', () => {
  it('compara los 3 meses cerrados más nuevos contra los 3 anteriores, en magnitud', () => {
    const reconciliacion = [
      mes({ month: '2026-03' }),
      mes({ month: '2026-04' }),
      mes({ month: '2026-05' }),
      mes({ month: '2026-06' }),
      mes({ month: '2026-07' }),
      mes({ month: '2026-08' }),
      mes({ month: '2026-09' }),
    ];

    const brief = armarBriefFinanzas({
      ...BASE_FIN,
      hoy: '2026-09-04',
      reconciliacion,
      movimientos: [
        // previos: 03, 04, 05 — 180 de herramientas
        gasto('2026-03-10', 'herramientas', -180),
        // recientes: 06, 07, 08 — 340 de herramientas
        gasto('2026-06-10', 'herramientas', -340),
        // un gasto de septiembre (mes en curso, fuera de las dos ventanas)
        gasto('2026-09-02', 'herramientas', -9999),
      ],
    });

    const herr = brief.gastos.porCategoria.find((c) => c.categoria === 'herramientas')!;
    // Magnitudes positivas, no los negativos de la base.
    expect(herr.previosEur).toBe(180);
    expect(herr.recientesEur).toBe(340);
    expect(herr.variacionPct).toBeCloseTo((340 - 180) / 180, 4);
  });

  it('ignora los movimientos que no son gasto', () => {
    const brief = armarBriefFinanzas({
      ...BASE_FIN,
      hoy: '2026-09-04',
      reconciliacion: [mes({ month: '2026-08' })],
      movimientos: [
        { ...gasto('2026-08-10', null, -5000), kind: 'retiro' as const },
        { ...gasto('2026-08-11', null, 2000), kind: 'aporte' as const },
        gasto('2026-08-12', 'sueldos', -1000),
      ],
    });

    expect(brief.gastos.porCategoria).toHaveLength(1);
    expect(brief.gastos.porCategoria[0]!.categoria).toBe('sueldos');
    expect(brief.gastos.porCategoria[0]!.recientesEur).toBe(1000);
  });
});

function gasto(
  day: string,
  category: 'herramientas' | 'sueldos' | null,
  amountEur: number,
): FinanceMovementLike {
  return {
    id: 1,
    kind: 'gasto',
    category,
    amountEur,
    note: '',
    day,
    scheduledPaymentId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

type FinanceMovementLike = import('@/lib/queries/finance').FinanceMovement;
