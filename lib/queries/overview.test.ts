import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { q } from '../db';
import { getFunnelBySlug, type Funnel } from '../funnels';
import { localDay } from '../day';
import { rollupRange } from '../../scripts/rollup';
import { getOverviewData } from './overview';
import { getSalesData } from './sales';

// vitest no carga .env solo (mismo patrón que lib/orders/webhook.test.ts):
// cargarlo acá hace que la suite corra contra la base real en vez de
// saltarse en silencio.
if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

/**
 * Integración con Postgres real: el Resumen es plata sumada, y la
 * matemática del rollup (recalcular, no acumular) no se puede testear sin
 * datos de verdad.
 *
 * Aislamiento por día, igual que T06/T07: los días de prueba son fijos
 * (2026-08-03..05, lejos de los datos reales de hoy y de los días de los
 * otros archivos de tests, que usan 07-31..08-02 y 08-10/11) y el cleanup
 * es un DELETE por día. Los tests de alerts (6 y 7) usan funnels
 * sintéticos: los funnels reales reciben datos frescos de otros archivos
 * que corren EN PARALELO (webhook.test escribe en chau/reset hoy), y un
 * `last_event_at` reciente haría el assert de "no reporta" no determinista.
 * El test 8 borra daily_metrics ENTERA: staleRollup mira el max(computed_at)
 * global de la tabla, y cualquier fila fresca (real o de un test anterior)
 * lo haría falso. La tabla es 100 % derivada — la reconstruye el rollup —,
 * así que el borrado no pierde información, solo tiempo de recálculo.
 */
const DAY = '2026-08-03';
const DAY_EMPTY = '2026-08-04';

const dbCleanupDays = [DAY, DAY_EMPTY];
const createdSids: string[] = [];
const createdFunnelSlugs: string[] = [];

describe.skipIf(!dbAvailable)('getOverviewData (integración)', () => {
  let chau: Funnel;
  let reset: Funnel;

  beforeAll(async () => {
    chau = (await getFunnelBySlug('chauhinchazon'))!;
    reset = (await getFunnelBySlug('reset'))!;
    if (!chau || !reset) {
      throw new Error('faltan los funnels del seed: corré npm run db:migrate');
    }
  });

  afterEach(async () => {
    const sids = createdSids.splice(0);
    if (sids.length) await q('DELETE FROM sessions WHERE id = ANY($1::uuid[])', [sids]);
    await q('DELETE FROM sessions WHERE day = ANY($1::date[])', [dbCleanupDays]);
    await q('DELETE FROM orders WHERE day = ANY($1::date[])', [dbCleanupDays]);
    await q('DELETE FROM daily_metrics WHERE day = ANY($1::date[])', [dbCleanupDays]);
    const slugs = createdFunnelSlugs.splice(0);
    if (slugs.length) await q('DELETE FROM funnels WHERE slug = ANY($1::text[])', [slugs]);
  });

  /** Un funnel sintético: los tests de alerts no pueden depender de los reales. */
  async function seedFunnel(slug: string, name: string): Promise<Funnel> {
    createdFunnelSlugs.push(slug);
    const hash = createHash('sha256').update(randomUUID()).digest('hex');
    await q(
      `INSERT INTO funnels (slug, name, ingest_key_hash, color)
       VALUES ($1, $2, $3, '#0ea5e9')`,
      [slug, name, hash],
    );
    const f = await getFunnelBySlug(slug);
    if (!f) throw new Error('no se pudo crear el funnel sintético');
    return f;
  }

  /** Una sesión de prueba, con el last_seen_at que el caso necesite. */
  async function seedSession(
    funnelId: number,
    day: string,
    maxStepIndex: number,
    opts: { lastSeenAt?: string; hitos?: number } = {},
  ): Promise<void> {
    const sid = randomUUID();
    createdSids.push(sid);
    const hitos = opts.hitos ?? 0;
    await q(
      `INSERT INTO sessions (id, funnel_id, visitor_id, variant, day, started_at, last_seen_at,
         max_step_index, sales_view_at, checkout_click_at, purchased_at, utm_campaign)
       VALUES ($1::uuid, $2, $3::uuid, 'default', $4::date, $5::timestamptz, $5::timestamptz, $6,
               $7::timestamptz, $8::timestamptz, $9::timestamptz, '(directo)')`,
      [
        sid,
        funnelId,
        randomUUID(),
        day,
        opts.lastSeenAt ?? `${day}T12:00:00Z`,
        maxStepIndex,
        hitos >= 1 ? `${day}T12:00:00Z` : null,
        hitos >= 2 ? `${day}T12:00:00Z` : null,
        hitos >= 3 ? `${day}T12:00:00Z` : null,
      ],
    );
  }

  /** Una orden de prueba (mismo shape que en sales.test.ts, T07). */
  async function seedOrder(
    funnelId: number,
    o: {
      externalId: string;
      amount: number;
      amountEur: number | null;
      tier?: string;
      status?: string;
      day?: string;
    },
  ): Promise<void> {
    await q(
      `INSERT INTO orders (funnel_id, source, external_id, status, tier, amount, currency,
                           amount_eur, fx_stale, utm_campaign, purchased_at, day)
       VALUES ($1::smallint, 'manual', $2, $3, $4, $5::numeric, 'ARS',
               $6::numeric, false, '(directo)', $7::timestamptz, $7::date)
       ON CONFLICT (source, external_id) DO NOTHING`,
      [
        funnelId,
        o.externalId,
        o.status ?? 'approved',
        o.tier ?? 'front',
        o.amount,
        o.amountEur,
        `${o.day ?? DAY}T12:00:00Z`,
      ],
    );
  }

  /** rollup + overview del rango de un día, en un paso. */
  async function overviewDay(from: string, to: string = from) {
    await rollupRange({ from, to });
    return getOverviewData({ from, to });
  }

  it('1. dos funnels con datos → totals es la suma exacta y funnels tiene las dos filas', async () => {
    // chau: 3 sesiones, 2 aprobadas + 1 devuelta. reset: 2 sesiones, 1 aprobada.
    await seedSession(chau.id, DAY, 0);
    await seedSession(chau.id, DAY, 1, { hitos: 3 });
    await seedSession(chau.id, DAY, 21, { hitos: 2 });
    await seedSession(reset.id, DAY, 0);
    await seedSession(reset.id, DAY, 5);
    await seedOrder(chau.id, { externalId: 'ov-t1-a', amount: 7790, amountEur: 4.51 });
    await seedOrder(chau.id, { externalId: 'ov-t1-b', amount: 20000, amountEur: 10 });
    await seedOrder(chau.id, { externalId: 'ov-t1-c', amount: 10000, amountEur: 5, status: 'refunded' });
    await seedOrder(reset.id, { externalId: 'ov-t1-d', amount: 7790, amountEur: 4.51 });

    const data = await overviewDay(DAY);

    expect(data.funnels).toHaveLength(2);
    expect(data.totals.sessions).toBe(5); // 3 + 2
    expect(data.totals.orders).toBe(3); // solo aprobadas
    expect(data.totals.ordersRefunded).toBe(1);
    expect(data.totals.refundedEur).toBe(5);
    // El neto del resumen es la suma EXACTA de los netos de los funnels
    // (4.51 + 10 − 5 de chau, 4.51 de reset).
    expect(data.totals.netEur).toBe(data.funnels[0]!.netEur + data.funnels[1]!.netEur);
    expect(data.totals.netEur).toBe(14.02);
    expect(data.totals.avgTicketEur).toBeCloseTo(14.02 / 3, 5);

    const c = data.funnels.find((f) => f.funnelId === chau.id)!;
    const r = data.funnels.find((f) => f.funnelId === reset.id)!;
    expect(c.netEur).toBe(9.51);
    expect(c.netOrig).toBe(17790); // 27790 aprobadas − 10000 devuelta
    expect(c.orders).toBe(2);
    expect(c.sessions).toBe(3);
    expect(r.netEur).toBe(4.51);
    expect(r.netOrig).toBe(7790);

    // Ordenadas por neto descendente (task §6.3).
    expect(data.funnels[0]!.funnelId).toBe(chau.id);
    expect(data.funnels[1]!.funnelId).toBe(reset.id);
  });

  it('2. un funnel sin datos en el rango pero activo → aparece con todo en 0, no desaparece', async () => {
    await seedSession(chau.id, DAY, 0);
    await seedOrder(chau.id, { externalId: 'ov-t2-a', amount: 7790, amountEur: 4.51 });

    const data = await overviewDay(DAY);
    expect(data.funnels).toHaveLength(2);

    const r = data.funnels.find((f) => f.funnelId === reset.id)!;
    expect(r.sessions).toBe(0);
    expect(r.quizStarted).toBe(0);
    expect(r.salesViews).toBe(0);
    expect(r.checkoutClicks).toBe(0);
    expect(r.orders).toBe(0);
    expect(r.ordersRefunded).toBe(0);
    expect(r.netEur).toBe(0);
    expect(r.netOrig).toBe(0);
    expect(r.avgTicketEur).toBe(0);
    expect(r.convSessionToSale).toBe(0);

    // Todo el JSON sin NaN ni Infinity: un resumen roto no puede salir al browser.
    const json = JSON.stringify(data);
    expect(json).not.toContain('NaN');
    expect(json).not.toContain('Infinity');
  });

  it('3. byDay cubre todos los días del rango, incluidos los sin ventas', async () => {
    await seedOrder(chau.id, { externalId: 'ov-t3-a', amount: 7790, amountEur: 4.51 });
    await seedSession(chau.id, DAY, 0);

    const data = await overviewDay(DAY, DAY_EMPTY);
    expect(data.byDay).toHaveLength(2);
    expect(data.byDay[0]!.day).toBe(DAY);
    expect(data.byDay[0]!.netEur).toBe(4.51);
    expect(data.byDay[0]!.orders).toBe(1);
    // El día sin datos existe con 0 — un hueco en el gráfico miente sobre la
    // continuidad del negocio.
    expect(data.byDay[1]!).toEqual({
      day: DAY_EMPTY,
      netEur: 0,
      orders: 0,
      sessions: 0,
      perFunnel: { [chau.slug]: 0, [reset.slug]: 0 },
    });
  });

  it('4. el neto del resumen coincide EXACTAMENTE con la suma de los netos de Ventas por funnel', async () => {
    // El test más importante del task (T08 §7): el rollup y las queries
    // base de T07 tienen que dar el mismo número, o hay dos verdades en el
    // panel. Mezcla de casos: devuelta con EUR, aprobada sin convertir
    // (amount_eur NULL → 0 en los dos lados, sin NaN).
    await seedOrder(chau.id, { externalId: 'ov-t4-a', amount: 7790, amountEur: 4.51 });
    await seedOrder(chau.id, { externalId: 'ov-t4-b', amount: 20000, amountEur: 10 });
    await seedOrder(chau.id, { externalId: 'ov-t4-c', amount: 10000, amountEur: 5, status: 'refunded' });
    await seedOrder(chau.id, { externalId: 'ov-t4-d', amount: 9900, amountEur: null });
    await seedOrder(reset.id, { externalId: 'ov-t4-e', amount: 7790, amountEur: 4.51 });
    await seedOrder(reset.id, { externalId: 'ov-t4-f', amount: 5000, amountEur: null, status: 'refunded' });

    const overview = await overviewDay(DAY);

    const salesChau = await getSalesData({ funnelId: chau.id, from: DAY, to: DAY });
    const salesReset = await getSalesData({ funnelId: reset.id, from: DAY, to: DAY });
    const sumVentas = salesChau.totals.netEur + salesReset.totals.netEur;

    // Igualdad estricta: ambos lados salen de la misma resta decimal en SQL
    // (gross − devuelto de los mismos amount_eur), así que no hay redondeo
    // de float que perdonar.
    expect(overview.totals.netEur).toBe(sumVentas);
    expect(overview.totals.netEur).toBe(14.02);
    // Y también funnel por funnel, no solo en el total.
    const c = overview.funnels.find((f) => f.funnelId === chau.id)!;
    const r = overview.funnels.find((f) => f.funnelId === reset.id)!;
    expect(c.netEur).toBe(salesChau.totals.netEur);
    expect(r.netEur).toBe(salesReset.totals.netEur);
  });

  it('5. rollup corrido dos veces → daily_metrics idéntica (recalcula, no acumula)', async () => {
    await seedSession(chau.id, DAY, 0);
    await seedSession(chau.id, DAY, 21, { hitos: 3 });
    await seedSession(reset.id, DAY, 5, { hitos: 1 });
    await seedOrder(chau.id, { externalId: 'ov-t5-a', amount: 7790, amountEur: 4.51 });
    await seedOrder(reset.id, { externalId: 'ov-t5-b', amount: 20000, amountEur: 10 });

    const read = () =>
      q(
        `SELECT funnel_id, day::text AS day, variant, sessions_count, quiz_started,
                sales_views, checkout_clicks, orders_count, orders_refunded,
                revenue_gross::text, revenue_refunded::text,
                revenue_gross_eur::text, revenue_refunded_eur::text
         FROM daily_metrics WHERE day = $1::date ORDER BY funnel_id, variant`,
        [DAY],
      );

    // computed_at se compara aparte: es un timestamp, cambia en cada corrida
    // POR DISEÑO (es lo que detecta el cron muerto). Las métricas no.
    const first = await rollupRange({ from: DAY, to: DAY });
    expect(first.rows).toBeGreaterThan(0);
    const rows1 = await read();
    const max1 = await q<{ computedAt: Date }>(
      `SELECT max(computed_at) AS "computedAt" FROM daily_metrics WHERE day = $1::date`,
      [DAY],
    );

    const second = await rollupRange({ from: DAY, to: DAY });
    expect(second.rows).toBe(first.rows);
    const rows2 = await read();
    const max2 = await q<{ computedAt: Date }>(
      `SELECT max(computed_at) AS "computedAt" FROM daily_metrics WHERE day = $1::date`,
      [DAY],
    );

    expect(rows2).toEqual(rows1);
    // La fila '*' es por (funnel, day): dos acá (chau y reset), y no es la
    // suma de las variantes en JS — es su propio count. Se suman las dos
    // para el total del día.
    const stars = rows1.filter((r) => r.variant === '*');
    expect(stars).toHaveLength(2);
    expect(stars.reduce((a, r) => a + r.sessions_count, 0)).toBe(3); // 2 de chau + 1 de reset
    expect(stars.reduce((a, r) => a + r.orders_count, 0)).toBe(2);
    expect(stars.reduce((a, r) => a + Number(r.revenue_gross_eur), 0)).toBe(14.51);
    // La fila por variante lleva las ventas en 0 (comentario en el script).
    const variantRow = rows1.find((r) => r.variant === 'default')!;
    expect(variantRow.orders_count).toBe(0);
    expect(variantRow.revenue_gross_eur).toBe('0.00');
    expect(max2[0]!.computedAt >= max1[0]!.computedAt).toBe(true);
  });

  it('6. funnel sin eventos en 8 h con eventos previos → alerta bad', async () => {
    // Funnel sintético: los funnels reales reciben datos frescos de otros
    // tests en paralelo y el assert no puede depender de eso.
    const caido = await seedFunnel('overview-test-caido', 'Test Caído');
    const lastSeen = new Date(Date.now() - 8 * 3600_000);
    const day = await localDay(lastSeen, caido.timezone);
    await seedSession(caido.id, day, 5, { lastSeenAt: lastSeen.toISOString() });

    const data = await getOverviewData({ from: DAY, to: DAY });
    const alert = data.alerts.find((a) => a.text.includes('Test Caído'));
    expect(alert).toBeDefined();
    expect(alert!.tone).toBe('bad');
    expect(alert!.text).toMatch(/no reporta desde las/);
  });

  it('7. funnel que nunca tuvo eventos → sin alerta (es nuevo, no está caído)', async () => {
    const nuevo = await seedFunnel('overview-test-nuevo', 'Test Nuevo');

    const data = await getOverviewData({ from: DAY, to: DAY });
    // Aparece en la lista con todo en 0 (activo), pero sin alerta.
    expect(data.funnels.some((f) => f.slug === nuevo.slug)).toBe(true);
    expect(data.alerts.some((a) => a.text.includes('Test Nuevo'))).toBe(false);
  });

  it('8. daily_metrics con computed_at de hace 45 min → staleRollup = true', async () => {
    // staleRollup mira el max(computed_at) GLOBAL: cualquier fila fresca en
    // la tabla (real o de los tests de arriba) lo haría falso, así que el
    // único aislamiento posible es borrarla entera. Es 100 % derivada: la
    // reconstruye scripts/rollup.ts, no se pierde nada.
    await q('DELETE FROM daily_metrics');
    await q(
      `INSERT INTO daily_metrics (funnel_id, day, variant, sessions_count, orders_count,
                                  revenue_gross_eur, revenue_refunded_eur, computed_at)
       VALUES ($1, $2::date, '*', 3, 1, 4.51, 0, now() - interval '45 minutes')`,
      [chau.id, DAY],
    );

    const stale = await getOverviewData({ from: DAY, to: DAY });
    expect(stale.staleRollup).toBe(true);
    expect(stale.lastRollupAt).not.toBeNull();
    expect(stale.alerts.some((a) => a.tone === 'bad' && a.text.includes('rollup'))).toBe(true);

    // El caso contrario: con el rollup recién corrido, nada de alertas.
    await q(
      `UPDATE daily_metrics SET computed_at = now()
       WHERE funnel_id = $1 AND day = $2::date AND variant = '*'`,
      [chau.id, DAY],
    );
    const fresh = await getOverviewData({ from: DAY, to: DAY });
    expect(fresh.staleRollup).toBe(false);
    expect(fresh.alerts.some((a) => a.tone === 'bad' && a.text.includes('rollup'))).toBe(false);
  });

  it('9. rango sin datos → los campos NUEVOS son null (no 0) y los viejos quedan en 0', async () => {
    // La convención de T02 §2.2: null = "no se puede calcular", 0 = "vale
    // cero". Un ROAS en 0 se lee como una campaña que no vende; null es
    // "no hay gasto cargado". Los campos viejos NO se tocan: las vistas de
    // T05/T06 los consumen y esperan number.
    const data = await overviewDay(DAY_EMPTY);
    const t = data.totals;

    // Campos nuevos de totals: ratios null, sumas en 0.
    expect(t.refundRate).toBeNull();
    expect(t.netMargin).toBeNull();
    expect(t.convSessionToSale).toBeNull();
    expect(t.convCheckoutToSale).toBeNull();
    expect(t.revPerSession).toBeNull();
    expect(t.cpa).toBeNull();
    expect(t.grossEur).toBe(0);
    expect(t.quizStarted).toBe(0);
    expect(t.salesViews).toBe(0);
    expect(t.checkoutClicks).toBe(0);
    // Campos viejos: siguen en 0 sin denominador.
    expect(t.roas).toBe(0);
    expect(t.avgTicketEur).toBe(0);
    expect(t.resultEur).toBe(0);

    // Lo mismo por funnel: los 7 ratios nuevos en null, los viejos en 0.
    for (const fn of data.funnels) {
      expect(fn.refundRate).toBeNull();
      expect(fn.netMargin).toBeNull();
      expect(fn.convCheckoutToSale).toBeNull();
      expect(fn.convSessionToQuiz).toBeNull();
      expect(fn.convQuizToSalesView).toBeNull();
      expect(fn.revPerSession).toBeNull();
      expect(fn.cpa).toBeNull();
      expect(fn.roas).toBe(0);
      expect(fn.convSessionToSale).toBe(0);
      expect(fn.avgTicketEur).toBe(0);
    }

    // Y prev tiene los dos campos nuevos, en 0 (período anterior vacío).
    expect(data.prev).not.toBeNull();
    expect(data.prev!.adSpendEur).toBe(0);
    expect(data.prev!.resultEur).toBe(0);

    // Sin NaN ni Infinity en el JSON.
    const json = JSON.stringify(data);
    expect(json).not.toContain('NaN');
    expect(json).not.toContain('Infinity');
  });

  it('10. con datos → los ratios nuevos valen lo que dicen sus fórmulas, en tanto por uno', async () => {
    // chau: 2 sesiones (una llega al checkout, la otra solo ve la venta),
    // 2 aprobadas y 1 devuelta.
    await seedSession(chau.id, DAY, 1, { hitos: 2 });
    await seedSession(chau.id, DAY, 5, { hitos: 1 });
    await seedOrder(chau.id, { externalId: 'ov-t10-a', amount: 7790, amountEur: 4.51 });
    await seedOrder(chau.id, { externalId: 'ov-t10-b', amount: 20000, amountEur: 10 });
    await seedOrder(chau.id, { externalId: 'ov-t10-c', amount: 10000, amountEur: 5, status: 'refunded' });

    const data = await overviewDay(DAY);
    const c = data.funnels.find((f) => f.funnelId === chau.id)!;
    const t = data.totals;

    expect(c.sessions).toBe(2);
    expect(c.quizStarted).toBe(2);
    expect(c.salesViews).toBe(2);
    expect(c.checkoutClicks).toBe(1);
    expect(c.orders).toBe(2);
    expect(c.ordersRefunded).toBe(1);
    expect(c.grossEur).toBe(14.51);
    expect(c.netEur).toBe(9.51);

    // Tanto por uno, sin multiplicar: la multiplicación es de la vista.
    expect(c.refundRate).toBeCloseTo(1 / 2, 10);
    expect(c.netMargin).toBeCloseTo(9.51 / 14.51, 10);
    expect(c.convCheckoutToSale).toBeCloseTo(2 / 1, 10);
    expect(c.convSessionToQuiz).toBeCloseTo(2 / 2, 10);
    expect(c.convQuizToSalesView).toBeCloseTo(2 / 2, 10);
    expect(c.revPerSession).toBeCloseTo(9.51 / 2, 10);
    // Sin gasto de ads cargado y con órdenes: 0, un valor real ("cada orden
    // costó 0 en publicidad"), no null.
    expect(c.cpa).toBeCloseTo(0, 10);

    // totals: mismos ratios con los totales del conjunto (acá el único funnel
    // con datos es chau, así que coinciden).
    expect(t.grossEur).toBe(14.51);
    expect(t.quizStarted).toBe(2);
    expect(t.salesViews).toBe(2);
    expect(t.checkoutClicks).toBe(1);
    expect(t.refundRate).toBeCloseTo(1 / 2, 10);
    expect(t.netMargin).toBeCloseTo(9.51 / 14.51, 10);
    expect(t.convSessionToSale).toBeCloseTo(2 / 2, 10);
    expect(t.convCheckoutToSale).toBeCloseTo(2 / 1, 10);
    expect(t.revPerSession).toBeCloseTo(9.51 / 2, 10);
    expect(t.cpa).toBeCloseTo(0, 10);

    // Los números que viajan son finitos de verdad: JSON.stringify(NaN) da
    // null, así que un NaN filtrado se disfraza de "no se puede calcular".
    // El assert mira el OBJETO, no el JSON (task §5.2).
    const totalsFields = [
      'sessions', 'orders', 'netEur', 'avgTicketEur', 'ordersRefunded', 'refundedEur',
      'adSpendEur', 'resultEur', 'roas', 'grossEur', 'quizStarted', 'salesViews',
      'checkoutClicks',
    ] as const;
    for (const k of totalsFields) {
      expect(Number.isFinite(t[k]), `totals.${k} tiene que ser finito`).toBe(true);
    }
    const funnelFields = [
      'sessions', 'quizStarted', 'salesViews', 'checkoutClicks', 'orders',
      'ordersRefunded', 'netEur', 'netOrig', 'adSpendEur', 'adSpendOrig',
      'resultEur', 'roas', 'grossEur', 'convSessionToSale', 'avgTicketEur',
    ] as const;
    for (const fn of data.funnels) {
      for (const k of funnelFields) {
        expect(Number.isFinite(fn[k]), `${fn.slug}.${k} tiene que ser finito`).toBe(true);
      }
    }
    // Con denominador presente, ninguno de los nuevos queda null.
    expect(c.refundRate).not.toBeNull();
    expect(c.netMargin).not.toBeNull();
    expect(c.convCheckoutToSale).not.toBeNull();
    expect(c.convSessionToQuiz).not.toBeNull();
    expect(c.convQuizToSalesView).not.toBeNull();
    expect(c.revPerSession).not.toBeNull();
    expect(c.cpa).not.toBeNull();
  });

  it('11. netMargin con grossEur = 0 y netEur ≠ 0 → null, no -Infinity', async () => {
    // Una devolución de una venta de otro mes: el bruto del rango es 0 pero
    // el neto es negativo. Es el caso raro del §3.1 de la task.
    await seedOrder(chau.id, { externalId: 'ov-t11-a', amount: 10000, amountEur: 5, status: 'refunded' });

    const data = await overviewDay(DAY);
    const c = data.funnels.find((f) => f.funnelId === chau.id)!;

    expect(c.grossEur).toBe(0);
    expect(c.netEur).toBe(-5);
    expect(c.netMargin).toBeNull();
    expect(c.refundRate).toBeNull(); // órdenes (aprobadas) = 0: sin denominador
    expect(data.totals.netMargin).toBeNull();
    expect(data.totals.grossEur).toBe(0);
    expect(data.totals.netEur).toBe(-5);
  });

  it('12. los ratios de totals NO son el promedio de los de cada funnel', async () => {
    // chau: 1 venta y 1 sesión. reset: 10 ventas, 2 devueltas y 20 sesiones.
    // El promedio de ratios pesa igual a los dos funnels y da números
    // distintos del ratio del conjunto, que es el correcto (task §3.2).
    await seedSession(chau.id, DAY, 1);
    await seedOrder(chau.id, { externalId: 'ov-t12-a', amount: 7790, amountEur: 5 });
    for (let i = 0; i < 20; i++) await seedSession(reset.id, DAY, 0);
    for (let i = 0; i < 10; i++) {
      await seedOrder(reset.id, { externalId: `ov-t12-b${i}`, amount: 1730, amountEur: 1 });
    }
    await seedOrder(reset.id, { externalId: 'ov-t12-c', amount: 1730, amountEur: 1, status: 'refunded' });
    await seedOrder(reset.id, { externalId: 'ov-t12-d', amount: 1730, amountEur: 1, status: 'refunded' });

    const data = await overviewDay(DAY);
    const c = data.funnels.find((f) => f.funnelId === chau.id)!;
    const r = data.funnels.find((f) => f.funnelId === reset.id)!;
    const t = data.totals;

    expect(c.orders).toBe(1);
    expect(r.orders).toBe(10);
    expect(t.orders).toBe(11);
    expect(t.sessions).toBe(21);

    // El ratio del conjunto sigue al grande, no al promedio de los dos.
    expect(t.convSessionToSale).toBeCloseTo(11 / 21, 10); // promedio sería (1 + 0.5)/2 = 0.75
    expect(t.convSessionToSale).not.toBeCloseTo((1 + 10 / 20) / 2, 10);
    expect(t.refundRate).toBeCloseTo(2 / 11, 10); // promedio sería (0 + 0.2)/2 = 0.1
    expect(t.refundRate).not.toBeCloseTo((0 + 2 / 10) / 2, 10);
    expect(t.netMargin).toBeCloseTo(13 / 15, 10); // promedio sería (1 + 0.8)/2 = 0.9
    expect(t.netMargin).not.toBeCloseTo((1 + 8 / 10) / 2, 10);
    // Sin clicks al checkout en ningún funnel: null, no 0.
    expect(t.convCheckoutToSale).toBeNull();
  });
});
