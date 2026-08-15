import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { q, q1 } from '../db';
import { extraerIdDeUtm, filaDesdeRow, getMetricasAds, type RowMetricas } from './ads';

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

/**
 * Tests de T15. Dos grupos, igual que el resto del proyecto:
 *
 * · Puras: `filaDesdeRow` (los cuatro cocientes que devuelven `null`) y
 *   `extraerIdDeUtm` (los 6 casos del plan). Corren siempre.
 * · Con base: la atribución por la zona de la CUENTA (no por orders.day) y que
 *   un objeto sin gasto aparece con ceros. Se saltan sin DATABASE_URL.
 *
 * La fórmula del neto se DUPLICA a propósito en el test: si alguien cambia la
 * implementación, el test dice qué contrato se rompió (D-A7).
 */

// ─── Puras ──────────────────────────────────────────────────────────────────

function row(over: Partial<RowMetricas>): RowMetricas {
  return {
    objectId: '900000000000000001',
    objectName: 'Campaña de prueba',
    accountId: 'act_test',
    campaignId: '900000000000000001',
    adsetId: '',
    adId: '',
    funnelId: 1,
    status: 'ACTIVE',
    effectiveStatus: 'ACTIVE',
    budgetLevel: 'adset',
    budgetMode: 'daily',
    dailyBudgetEur: '25.00',
    spendEur: '0',
    impressions: '0',
    clicks: '0',
    sales: 0,
    revenueEur: '0',
    refundedEur: '0',
    commissionsEur: '0',
    costsEur: '0',
    ultimaAccionAt: null,
    videoReproducciones: null,
    videoThruplay: null,
    videoP25: null,
    videoP50: null,
    videoP75: null,
    videoP100: null,
    alcance: null,
    alcanceImpresiones: null,
    inicioProgramado: null,
    ...over,
  };
}

describe('filaDesdeRow (los cuatro cocientes y el mapeo)', () => {
  it('gasto 0 con ventas → roas y roi en null (nunca 0 ni Infinity)', () => {
    const f = filaDesdeRow('campaign', row({ spendEur: '0', sales: 1, revenueEur: '50' }));
    expect(f.roas).toBeNull();
    expect(f.roi).toBeNull();
    // OJO: cpa = gasto / ventas. Su denominador es `ventas`, no el gasto (D-A7),
    // así que con una venta y gasto 0 el CPA es 0 legítimo, no null.
    expect(f.cpaEur).toBe(0);
  });

  it('sales 0 con gasto → cpaEur null, y roi calculado igual (el denominador del roi es el gasto)', () => {
    const f = filaDesdeRow('adset', row({ spendEur: '40', sales: 0, revenueEur: '0' }));
    expect(f.cpaEur).toBeNull();
    expect(f.roi).not.toBeNull();
    expect(f.roi).toBe(0 / 40); // neto 0 sobre gasto 40 → 0 (es un cociente válido)
  });

  it('los numeric que llegan como string se convierten con Number() una sola vez', () => {
    const f = filaDesdeRow('campaign', row({ spendEur: '44.37' }));
    expect(f.spendEur).toBe(44.37);
    expect(f.spendEur).not.toBe('44.37');
    expect(f.dailyBudgetEur).toBe(25);
  });

  it('neto y ganancia contra la fórmula de D-A7, escrita aparte en el test', () => {
    const r = row({
      spendEur: '20',
      sales: 2,
      revenueEur: '100',
      refundedEur: '10',
      commissionsEur: '5',
      costsEur: '15',
      impressions: '1000',
      clicks: '30',
    });
    const f = filaDesdeRow('adset', r);

    // D-A7 duplicada a propósito:
    // neto = ingresos − devuelto − comisiones − costos · profit = neto − gasto
    const neto = 100 - 10 - 5 - 15;
    const profit = neto - 20;
    const roi = neto / 20;
    const roas = 100 / 20;
    const cpa = 20 / 2;
    const ctr = 30 / 1000;
    const cpc = 20 / 30;

    expect(f.netEur).toBe(neto);
    expect(f.profitEur).toBe(profit);
    expect(f.roi).toBeCloseTo(roi, 10);
    expect(f.roas).toBeCloseTo(roas, 10);
    expect(f.cpaEur).toBeCloseTo(cpa, 10);
    expect(f.ctr).toBeCloseTo(ctr, 10);
    expect(f.cpcEur).toBeCloseTo(cpc, 10);
  });

  it('con impresiones 0 → ctr null; con clicks 0 → cpc null', () => {
    const f = filaDesdeRow('ad', row({ spendEur: '10', impressions: '0', clicks: '0' }));
    expect(f.ctr).toBeNull();
    expect(f.cpcEur).toBeNull();
  });
});

describe('extraerIdDeUtm (los 6 casos de _verificacion-016.sql §5)', () => {
  const casos: Array<[string, string | null]> = [
    ['PXN JEAN VAQUERO 11/08 - Copia|120210000123456', '120210000123456'],
    ['PXN | RARO | 120210000999', '120210000999'],
    ['(directo)', null],
    ['PXN SIN ID', null],
    ['120210000777', '120210000777'],
    ['2026', null],
  ];

  it.each(casos)('%s → %s', (utm, espera) => {
    expect(extraerIdDeUtm(utm)).toBe(espera);
  });
});

// ─── Con base ────────────────────────────────────────────────────────────────

const dbAvailable = Boolean(process.env.DATABASE_URL);
const CUENTA_TEST = 'act_t15_test';
const CAMPAIGN_TEST = '900000000000000099';
const NOMBRE_TEST = '__T15_TEST__';

describe.skipIf(!dbAvailable)('getMetricasAds (integración)', () => {
  beforeAll(async () => {
    await q(
      `INSERT INTO ad_accounts (account_id, platform, name, currency, timezone, funnel_id, active)
       VALUES ($1, 'meta', 'cuenta de prueba T15', 'EUR', 'Europe/Lisbon', 1, true)
       ON CONFLICT (account_id) DO UPDATE SET timezone = 'Europe/Lisbon', active = true`,
      [CUENTA_TEST],
    );
  });

  afterEach(async () => {
    await q(`DELETE FROM orders WHERE source = 't15-test'`);
    await q(`DELETE FROM ad_campaigns WHERE account_id = $1`, [CUENTA_TEST]);
  });

  afterAll(async () => {
    await q(`DELETE FROM orders WHERE source = 't15-test'`);
    await q(`DELETE FROM ad_campaigns WHERE account_id = $1`, [CUENTA_TEST]);
    await q(`DELETE FROM ad_accounts WHERE account_id = $1`, [CUENTA_TEST]);
  });

  async function sembrarCampana(name: string): Promise<void> {
    await q(
      `INSERT INTO ad_campaigns (campaign_id, account_id, name, status, effective_status,
                                 budget_level, daily_budget, synced_at)
       VALUES ($1, $2, $3, 'ACTIVE', 'ACTIVE', 'adset', 2500, now())
       ON CONFLICT (campaign_id) DO UPDATE SET synced_at = now()`,
      [CAMPAIGN_TEST, CUENTA_TEST, name],
    );
  }

  async function sembrarOrden(o: {
    externalId: string;
    campaign?: string;
    amountEur?: number;
    status?: string;
    purchasedAt: string;
    day: string;
  }): Promise<void> {
    await q(
      `INSERT INTO orders (funnel_id, source, external_id, email, status, tier, amount, currency,
                           amount_eur, utm_source, utm_campaign, utm_medium, utm_content,
                           purchased_at, day, commission_amount, commission_amount_eur,
                           cost_amount, cost_amount_eur)
       VALUES ($1::smallint, 't15-test', $2, 't15@test', $3, 'front', 100, 'EUR',
               $4::numeric, '(directo)', $5, '(directo)', '(directo)',
               $6::timestamptz, $7::date, 0, 0, 0, 0)
       ON CONFLICT (source, external_id) DO NOTHING`,
      [
        1,
        o.externalId,
        o.status ?? 'approved',
        o.amountEur ?? 10,
        o.campaign ?? '(directo)',
        o.purchasedAt,
        o.day,
      ],
    );
  }

  it('agrupa por el día de la CUENTA (purchased_at + tz), no por orders.day', async () => {
    // §3 del plan. El `day` de la orden se carga MAL a propósito (ayer): si la
    // query agrupara por orders.day, la venta caería fuera de 'today' y no se
    // atribuiría. Agrupando por la zona de la cuenta, purchased_at = hoy y la
    // venta se atribuye a la campaña.
    await sembrarCampana(NOMBRE_TEST);
    const hoy = new Date();
    const ayer = new Date(hoy.getTime() - 86_400_000);
    await sembrarOrden({
      externalId: 't15-tz-1',
      campaign: `${NOMBRE_TEST}|${CAMPAIGN_TEST}`,
      amountEur: 50,
      purchasedAt: hoy.toISOString(),
      day: ayer.toISOString().slice(0, 10),
    });

    const r = await getMetricasAds({
      level: 'campaign',
      period: 'today',
      accountIds: [CUENTA_TEST],
      nombre: NOMBRE_TEST,
    });

    expect(r.filas).toHaveLength(1);
    expect(r.filas[0].sales).toBe(1);
    expect(r.filas[0].revenueEur).toBeCloseTo(50, 6);
    expect(r.rango.timezone).toBe('Europe/Lisbon');
  });

  it('un objeto sin gasto aparece con ceros, y su roi es null', async () => {
    await sembrarCampana(NOMBRE_TEST);

    const r = await getMetricasAds({
      level: 'campaign',
      period: 'today',
      accountIds: [CUENTA_TEST],
      nombre: NOMBRE_TEST,
    });

    expect(r.filas).toHaveLength(1);
    const f = r.filas[0];
    expect(f.spendEur).toBe(0);
    expect(f.roi).toBeNull();
    expect(f.roas).toBeNull();
    expect(f.sales).toBe(0);
  });

  it('tira zonas horarias mezcladas cuando las cuentas no comparten zona', async () => {
    // P-A03/P-A09: las dos cuentas REALES están en zonas distintas
    // (act_2501… en Europe/Lisbon y act_2120… en America/Argentina/Buenos_Aires),
    // así que `accountIds: []` (todas) tiene que TIRAR y no elegir una. Elegir
    // una calcula el día de la otra cuenta contra el gasto de otro día, en
    // silencio, y con reglas de ROI eso es plata.
    //
    // EL FIXTURE SIEMBRA SUS PROPIAS DOS CUENTAS A PROPÓSITO. La versión
    // anterior de este test no sembraba nada y confiaba en que la base ya
    // tuviera dos cuentas en zonas distintas: pasaba en la base de desarrollo y
    // fallaba en `panel_test`, que arranca sin ninguna cuenta. Un test que
    // depende de datos ambientales no prueba nada y bloquea el deploy por el
    // motivo equivocado.
    const CUENTA_BSAS = 'act_t15_test_bsas';
    try {
      await q(
        `INSERT INTO ad_accounts (account_id, platform, name, currency, timezone, funnel_id, active)
         VALUES ($1, 'meta', 'cuenta de prueba T15 BsAs', 'EUR',
                 'America/Argentina/Buenos_Aires', 1, true)
         ON CONFLICT (account_id) DO UPDATE
           SET timezone = 'America/Argentina/Buenos_Aires', active = true`,
        [CUENTA_BSAS],
      );

      // Con las dos cuentas activas y en zonas distintas, "todas" no es resoluble.
      await expect(
        getMetricasAds({ level: 'campaign', period: 'today', accountIds: [] }),
      ).rejects.toThrow(/zonas horarias mezcladas/);

      // Y el mensaje tiene que nombrar las cuentas y sus zonas: sin eso, el
      // motivo 'zonas_horarias_mezcladas' del historial no dice qué arreglar.
      await expect(
        getMetricasAds({ level: 'campaign', period: 'today', accountIds: [] }),
      ).rejects.toThrow(/America\/Argentina\/Buenos_Aires/);

      // Pero pedir UNA sola cuenta sigue funcionando: es el camino que el
      // usuario tiene que usar hasta que exista la expansión por cuenta (P-A09).
      const soloUna = await getMetricasAds({
        level: 'campaign',
        period: 'today',
        accountIds: [CUENTA_BSAS],
      });
      expect(soloUna.rango.timezone).toBe('America/Argentina/Buenos_Aires');
    } finally {
      await q(`DELETE FROM ad_accounts WHERE account_id = $1`, [CUENTA_BSAS]);
    }
  });
});

// ─── Límites de la query (task 15.5): total, páginas, recorte y hayMas ──────

describe.skipIf(!dbAvailable)('getMetricasAds — límites (R4 c9, c10, c13)', () => {
  const CUENTA_LIM = 'act_t15_lim';

  beforeAll(async () => {
    await q(
      `INSERT INTO ad_accounts (account_id, platform, name, currency, timezone, active)
       VALUES ($1, 'meta', 'cuenta de límites T15', 'EUR', 'Europe/Lisbon', true)
       ON CONFLICT (account_id) DO UPDATE SET timezone = 'Europe/Lisbon', active = true`,
      [CUENTA_LIM],
    );
  });

  afterEach(async () => {
    await q(`DELETE FROM ad_spend WHERE account_id = $1`, [CUENTA_LIM]);
  });

  afterAll(async () => {
    await q(`DELETE FROM ad_spend WHERE account_id = $1`, [CUENTA_LIM]);
    await q(`DELETE FROM ad_accounts WHERE account_id = $1`, [CUENTA_LIM]);
  });

  async function sembrarGasto(n: number): Promise<void> {
    const dia = (
      await q1<{ hoy: string }>(`SELECT (now() AT TIME ZONE 'Europe/Lisbon')::date::text AS hoy`)
    )!.hoy;
    // UN solo INSERT con generate_series, no N inserts secuenciales. Con 1005 filas
    // el loop tardaba más de 5 s: vitest abortaba el test a mitad del sembrado y las
    // filas que seguían cayendo después del afterEach contaminaban al test siguiente,
    // que veía 1026 filas en lugar de 21 y daba hayMas=true en la última página.
    // Limpia antes de sembrar, no solo en el afterEach: si una corrida anterior
    // quedó a medias, el residuo hacía fallar al primer test del bloque.
    await q(`DELETE FROM ad_spend WHERE account_id = $1`, [CUENTA_LIM]);
    await q(
      `INSERT INTO ad_spend (platform, account_id, day, level, campaign_id, campaign_name,
                             adset_id, adset_name, ad_id, ad_name, spend, currency, spend_eur,
                             impressions, clicks, synced_at)
       SELECT 'meta', $1, $2::date, 'ad',
              '91' || lpad(g.i::text, 14, '0'),
              'Campaña 91' || lpad(g.i::text, 14, '0'),
              '', NULL, '', NULL,
              (g.i + 1)::numeric, 'EUR', (g.i + 1)::numeric,
              1, 1, now()
         FROM generate_series(0, $3::int - 1) AS g(i)`,
      [CUENTA_LIM, dia, n],
    );
  }

  it('total y totalPaginas son los del conjunto completo, no los de la página (R4 c10, c13)', async () => {
    await sembrarGasto(25);
    const p1 = await getMetricasAds({
      level: 'campaign',
      period: 'today',
      accountIds: [CUENTA_LIM],
      orderBy: 'gastos',
      orderDir: 'desc',
      page: 1,
      limit: 10,
    });
    expect(p1.total).toBe(25);
    expect(p1.totalPaginas).toBe(3);
    expect(p1.filas).toHaveLength(10);
    expect(p1.hayMas).toBe(true);

    const p3 = await getMetricasAds({
      level: 'campaign',
      period: 'today',
      accountIds: [CUENTA_LIM],
      orderBy: 'gastos',
      orderDir: 'desc',
      page: 3,
      limit: 10,
    });
    expect(p3.filas).toHaveLength(5);
    expect(p3.hayMas).toBe(false); // última página
    expect(p3.pagina).toBe(3);
  });

  it('el recorte a 1000 se aplica DESPUÉS de resolver el orden (R4 c9)', async () => {
    await sembrarGasto(1005);
    const r = await getMetricasAds({
      level: 'campaign',
      period: 'today',
      accountIds: [CUENTA_LIM],
      orderBy: 'gastos',
      orderDir: 'desc',
      page: 1,
      limit: 5000, // pedido por encima del tope del contrato
    });
    expect(r.filas).toHaveLength(1000);
    expect(r.total).toBe(1005);
    expect(r.totalPaginas).toBe(2);
    // el orden manda sobre el recorte: la primera fila es la de mayor gasto
    expect(r.filas[0]!.spendEur).toBe(1005);
  });

  it('hayMas es coherente con la paginación por página: páginas intermedias sí, la última no', async () => {
    await sembrarGasto(21);
    const p2 = await getMetricasAds({
      level: 'campaign',
      period: 'today',
      accountIds: [CUENTA_LIM],
      orderBy: 'gastos',
      orderDir: 'desc',
      page: 2,
      limit: 10,
    });
    expect(p2.hayMas).toBe(true);
    const p3 = await getMetricasAds({
      level: 'campaign',
      period: 'today',
      accountIds: [CUENTA_LIM],
      orderBy: 'gastos',
      orderDir: 'desc',
      page: 3,
      limit: 10,
    });
    expect(p3.hayMas).toBe(false);
  });
});
