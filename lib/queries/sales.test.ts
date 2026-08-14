import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { q } from '../db';
import { getFunnelBySlug, type Funnel } from '../funnels';
import {
  getSalesData,
  realAov,
  upsellTakeRate,
  type SalesFilters,
  type SalesStatus,
} from './sales';

/**
 * Integración con Postgres real: bruto/devuelto/neto son plata, y la
 * matemática de los FILTER por status no se puede testear sin datos de
 * verdad. Sin DATABASE_URL se salta, igual que los otros tests de
 * integración.
 *
 * Aislamiento por día: los días de prueba son fijos y viven lejos de los
 * datos reales (que caen en el día de hoy), así que el cleanup es un DELETE
 * por día y un run anterior muerto a mitad de camino no deja filas fantasma.
 * El FK de order_items es ON DELETE CASCADE: borrar las órdenes limpia los
 * ítems.
 */
const dbAvailable = Boolean(process.env.DATABASE_URL);

const DAY = '2026-08-01';
const DAY_EMPTY = '2026-08-02';
const DAY_PREV = '2026-07-31';

describe.skipIf(!dbAvailable)('getSalesData (integración)', () => {
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
    await q('DELETE FROM orders WHERE day IN ($1::date, $2::date, $3::date)', [
      DAY,
      DAY_EMPTY,
      DAY_PREV,
    ]);
  });

  /** Una orden de prueba. `funnelId: null` = huérfana (D10). */
  async function seedOrder(
    funnelId: number | null,
    o: {
      externalId: string;
      amount: number;
      amountEur: number | null;
      tier?: string;
      status?: string;
      currency?: string;
      day?: string;
      purchasedAt?: string;
      campaign?: string;
      utmSource?: string;
      fxStale?: boolean;
      email?: string;
      commission?: number;
      commissionEur?: number | null;
      cost?: number;
      costEur?: number | null;
    },
  ): Promise<void> {
    await q(
      `INSERT INTO orders (funnel_id, source, external_id, email, status, tier, amount, currency,
                           amount_eur, fx_rate, fx_day, fx_stale, utm_source, utm_campaign, purchased_at, day,
                           commission_amount, commission_amount_eur,
                           cost_amount, cost_amount_eur)
       VALUES ($1::smallint, 'manual', $2, $3, $4, $5, $6::numeric, $7,
               $8::numeric, NULL, NULL, $9, $10, $11, $12::timestamptz, $13::date,
               $14::numeric, $15::numeric, $16::numeric, $17::numeric)
       ON CONFLICT (source, external_id) DO NOTHING`,
      [
        funnelId,
        o.externalId,
        o.email ?? null,
        o.status ?? 'approved',
        o.tier ?? 'front',
        o.amount,
        o.currency ?? 'ARS',
        o.amountEur,
        o.fxStale ?? false,
        o.utmSource ?? '(directo)',
        o.campaign ?? '(directo)',
        o.purchasedAt ?? `${o.day ?? DAY}T12:00:00Z`,
        o.day ?? DAY,
        o.commission ?? 0,
        o.commissionEur ?? null,
        o.cost ?? 0,
        o.costEur ?? null,
      ],
    );
  }

  function filters(over: Partial<SalesFilters> = {}): SalesFilters {
    return { funnelId: chau.id, from: DAY, to: DAY, ...over };
  }

  it('tres aprobadas y una devuelta → bruto, devuelto y neto exactos, ordersApproved = 3', async () => {
    await seedOrder(chau.id, { externalId: 'sales-t-1', amount: 10000, amountEur: 5, tier: 'front' });
    await seedOrder(chau.id, { externalId: 'sales-t-2', amount: 20000, amountEur: 10, tier: 'upsell' });
    await seedOrder(chau.id, { externalId: 'sales-t-3', amount: 30000, amountEur: 15, tier: 'front' });
    await seedOrder(chau.id, {
      externalId: 'sales-t-4',
      amount: 10000,
      amountEur: 5,
      tier: 'front',
      status: 'refunded',
    });

    const data = await getSalesData(filters());
    const t = data.totals;

    expect(t.ordersApproved).toBe(3);
    expect(t.ordersRefunded).toBe(1);
    expect(t.ordersChargeback).toBe(0);
    expect(t.grossOrig).toBe(60000);
    expect(t.refundedOrig).toBe(10000);
    expect(t.netOrig).toBe(50000);
    expect(t.grossEur).toBe(30);
    expect(t.refundedEur).toBe(5);
    expect(t.netEur).toBe(25);
    expect(t.avgTicketEur).toBeCloseTo(25 / 3, 5);
    expect(t.currency).toBe('ARS');
    expect(t.fxStaleCount).toBe(0);
    expect(t.unknownTierCount).toBe(0);

    // Métricas nuevas (T02), en tanto por uno sin multiplicar.
    expect(t.refundRate).toBeCloseTo(1 / 4, 10); // (1 devuelta + 0 chargebacks) / (3 + 1 + 0)
    expect(t.netMargin).toBeCloseTo(25 / 30, 10);
    expect(t.avgTicketOrig).toBeCloseTo(50000 / 3, 5); // en pesos: el par de avgTicketEur
    // Sin comisiones ni costos cargados y con bruto: 0 es un valor real
    // ("la pasarela no cobró nada"), no null.
    expect(t.commissionRate).toBeCloseTo(0, 10);
    expect(t.costRate).toBeCloseTo(0, 10);

    // La devuelta sigue contando en la lista (D10: no se borra) y el neto
    // del tier front ya descuenta su plata.
    expect(data.recent).toHaveLength(4);
    const front = data.byTier.find((r) => r.tier === 'front')!;
    expect(front.orders).toBe(3);
    expect(front.netEur).toBe(15); // 5 + 15 aprobadas − 5 devuelta

    // TODOS los desgloses llevan el monto en moneda original además del de
    // euros. Sin esto el toggle EUR/ARS de la pantalla cambia el símbolo y deja
    // el número igual, que es cómo se ve un bug de "€ 7.790" para una venta de
    // 7790 pesos. Se verifica en los tres desgloses, no solo en byTier, porque
    // el bug original estaba justamente en los que faltaban.
    expect(front.netOrig).toBe(30000); // 10000 + 30000 − 10000
    const camp = data.byCampaign[0]!;
    expect(camp.netOrig).toBe(50000);
    expect(camp.netEur).toBe(25);
    const src = data.bySource[0]!;
    expect(src.netOrig).toBe(50000);
    const dia = data.byDay.find((d) => d.orders > 0)!;
    expect(dia.netOrig).toBe(50000);
    expect(dia.refundedOrig).toBe(10000);
    // Y un día sin ventas rellena en 0 los cuatro campos, sin undefined que
    // termine como NaN en el gráfico.
    const vacio = data.byDay.find((d) => d.orders === 0);
    if (vacio) {
      expect(vacio.netOrig).toBe(0);
      expect(vacio.refundedOrig).toBe(0);
    }
  });

  it('rango sin ventas → todos los totales en 0 y ningún null ni NaN en el JSON', async () => {
    const data = await getSalesData(filters({ from: DAY_EMPTY, to: DAY_EMPTY }));
    const t = data.totals;
    expect(t.ordersApproved).toBe(0);
    expect(t.ordersRefunded).toBe(0);
    expect(t.ordersChargeback).toBe(0);
    expect(t.grossEur).toBe(0);
    expect(t.refundedEur).toBe(0);
    expect(t.netEur).toBe(0);
    expect(t.grossOrig).toBe(0);
    expect(t.refundedOrig).toBe(0);
    expect(t.netOrig).toBe(0);
    expect(t.avgTicketEur).toBe(0); // neto 0 ÷ órdenes 0 → 0, no NaN
    expect(t.fxStaleCount).toBe(0);
    expect(t.unknownTierCount).toBe(0);
    // Campos VIEJOS: siguen devolviendo 0 sin denominador (§2.2 de T02).
    expect(t.roas).toBe(0);
    expect(t.roasEur).toBe(0);
    expect(t.cpa).toBe(0);
    expect(t.cpaEur).toBe(0);
    expect(t.roi).toBe(0);
    expect(t.roiEur).toBe(0);
    // Campos NUEVOS: null = "no se puede calcular", no 0.
    expect(t.refundRate).toBeNull();
    expect(t.netMargin).toBeNull();
    expect(t.avgTicketOrig).toBeNull();
    expect(t.commissionRate).toBeNull();
    expect(t.costRate).toBeNull();
    expect(data.byDay).toHaveLength(1);
    // Los cuatro campos de plata en 0, no dos: los de moneda original se
    // agregaron para que el toggle EUR/ARS cambie el número y no solo el
    // símbolo. `toEqual` exacto a propósito, para que agregar un campo nuevo
    // obligue a decidir su valor por defecto en lugar de dejarlo en undefined.
    expect(data.byDay[0]).toEqual({
      day: DAY_EMPTY,
      orders: 0,
      netEur: 0,
      netOrig: 0,
      refundedEur: 0,
      refundedOrig: 0,
    });
    expect(data.recent).toHaveLength(0);

    const json = JSON.stringify(data);
    expect(json).not.toContain('NaN');
    expect(json).not.toContain('Infinity');
  });

  it('las órdenes pending no entran al refundRate, en ninguno de los dos lados', async () => {
    // Una orden pendiente nunca fue una venta: no suma al numerador
    // (devoluciones + chargebacks) ni al denominador (aprobadas + devueltas +
    // chargebacks). Es la decisión que el comentario del tipo deja escrita.
    await seedOrder(chau.id, { externalId: 'sales-t-p1', amount: 10000, amountEur: 5 });
    await seedOrder(chau.id, { externalId: 'sales-t-p2', amount: 10000, amountEur: 5 });
    await seedOrder(chau.id, { externalId: 'sales-t-p3', amount: 10000, amountEur: 5, status: 'refunded' });
    await seedOrder(chau.id, { externalId: 'sales-t-p4', amount: 10000, amountEur: 5, status: 'chargeback' });
    await seedOrder(chau.id, { externalId: 'sales-t-p5', amount: 10000, amountEur: 5, status: 'pending' });

    const t = (await getSalesData(filters())).totals;
    expect(t.ordersApproved).toBe(2);
    expect(t.ordersRefunded).toBe(1);
    expect(t.ordersChargeback).toBe(1);
    // (1 devuelta + 1 chargeback) / (2 + 1 + 1). La pending no está en ningún lado.
    expect(t.refundRate).toBeCloseTo(2 / 4, 10);
    expect(t.refundRate).not.toBeCloseTo(2 / 5, 10);
    expect(t.refundRate).not.toBeCloseTo(3 / 5, 10);
    // La pending tampoco entra al bruto (solo aprobadas). OJO: el devuelto de
    // la pantalla es todo lo que no está aprobado — semántica PREEXISTENTE que
    // incluye la pending —, pero el refundRate es el que define su propio
    // denominador y ahí la pending queda fuera de los dos lados.
    expect(t.grossEur).toBe(10);
    expect(t.refundedEur).toBe(15); // devuelta + chargeback + pending
  });

  it('una devolución sin ninguna aprobada → grossEur 0, netEur negativo y netMargin null', async () => {
    // El caso raro de la task: devolución de una venta de otro mes. El
    // denominador de netMargin es el bruto, y bruto 0 con neto ≠ 0 es
    // null, no -Infinity.
    await seedOrder(chau.id, { externalId: 'sales-t-r0', amount: 10000, amountEur: 5, status: 'refunded' });

    const t = (await getSalesData(filters())).totals;
    expect(t.grossEur).toBe(0);
    expect(t.netEur).toBe(-5);
    expect(t.netMargin).toBeNull();
    expect(t.avgTicketOrig).toBeNull(); // sin aprobadas no hay denominador
  });

  it('una orden con funnel_id NULL aparece en unattributed y NO en los totales del funnel', async () => {
    await seedOrder(chau.id, { externalId: 'sales-t-5', amount: 7790, amountEur: 4.51, tier: 'front' });
    await seedOrder(null, { externalId: 'sales-t-6', amount: 9900, amountEur: null, tier: 'unknown' });

    const data = await getSalesData(filters());
    expect(data.totals.grossOrig).toBe(7790);
    expect(data.totals.ordersApproved).toBe(1);
    expect(data.unattributed.orders).toBe(1);
  });

  it('funnelId = null (el cajón "sin atribuir") devuelve SOLO las huérfanas', async () => {
    await seedOrder(chau.id, { externalId: 'sales-t-7', amount: 7790, amountEur: 4.51, tier: 'front' });
    await seedOrder(null, { externalId: 'sales-t-8', amount: 9900, amountEur: 5, tier: 'unknown' });

    const data = await getSalesData(filters({ funnelId: null }));
    expect(data.totals.grossOrig).toBe(9900);
    expect(data.totals.ordersApproved).toBe(1);
    expect(data.totals.currency).toBe('ARS');
    expect(data.recent).toHaveLength(1);
    expect(data.recent[0]!.id).toBeGreaterThan(0);
    // El cajón no puede arrastrar las ventas atribuidas del mismo rango.
    expect(data.recent.every((r) => r.tier === 'unknown')).toBe(true);
  });

  it('una orden con amount_eur NULL cuenta en fxStaleCount y el total en euros no explota', async () => {
    // fx_stale en false a propósito: la definición de fxStaleCount es "la
    // conversión no está completa" (T07 §2), no solo el flag. El webhook
    // setea ambos, pero un insert directo con NULL no puede quedar mudo.
    await seedOrder(chau.id, { externalId: 'sales-t-9', amount: 9900, amountEur: null, tier: 'front' });
    await seedOrder(chau.id, { externalId: 'sales-t-10', amount: 10000, amountEur: 5, tier: 'front' });

    const t = (await getSalesData(filters())).totals;
    expect(t.fxStaleCount).toBe(1);
    expect(t.grossEur).toBe(5); // el NULL se ignora, no rompe la suma
    expect(t.netEur).toBe(5);
    expect(Number.isFinite(t.grossEur)).toBe(true);
  });

  it('una orden con tier unknown cuenta en unknownTierCount y se muestra en byTier', async () => {
    await seedOrder(chau.id, { externalId: 'sales-t-11', amount: 5000, amountEur: 2.5, tier: 'unknown' });
    await seedOrder(chau.id, { externalId: 'sales-t-12', amount: 10000, amountEur: 5, tier: 'front' });

    const data = await getSalesData(filters());
    expect(data.totals.unknownTierCount).toBe(1);
    expect(data.byTier.find((r) => r.tier === 'unknown')?.orders).toBe(1);
  });

  it('las órdenes de otro funnel en el mismo rango no contaminan', async () => {
    await seedOrder(chau.id, { externalId: 'sales-t-13', amount: 10000, amountEur: 5, tier: 'front' });
    await seedOrder(reset.id, { externalId: 'sales-t-14', amount: 99999, amountEur: 50, tier: 'front' });

    const data = await getSalesData(filters());
    expect(data.totals.grossOrig).toBe(10000);
    expect(data.totals.ordersApproved).toBe(1);
    expect(data.recent).toHaveLength(1);
    expect(data.unattributed.orders).toBe(0);
  });

  it('take rate del upsell: 10 front y 3 upsell → 30 %; sin front → 0, no división por cero', async () => {
    for (let i = 0; i < 10; i++) {
      await seedOrder(chau.id, { externalId: `sales-t-f${i}`, amount: 10000, amountEur: 5, tier: 'front' });
    }
    for (let i = 0; i < 3; i++) {
      await seedOrder(chau.id, { externalId: `sales-t-u${i}`, amount: 20000, amountEur: 10, tier: 'upsell' });
    }
    const data = await getSalesData(filters());
    expect(upsellTakeRate(data.byTier)).toBeCloseTo(30, 5);
    expect(realAov(data.byTier, data.totals.netEur)).toBeCloseTo(8, 5); // 80 net ÷ 10 front

    // Solo upsells (funnel reset): el front=0 tiene que dar 0, nunca NaN.
    for (let i = 0; i < 2; i++) {
      await seedOrder(reset.id, { externalId: `sales-t-r${i}`, amount: 20000, amountEur: 10, tier: 'upsell' });
    }
    const onlyUpsell = await getSalesData({ funnelId: reset.id, from: DAY, to: DAY });
    expect(upsellTakeRate(onlyUpsell.byTier)).toBe(0);
    expect(realAov(onlyUpsell.byTier, onlyUpsell.totals.netEur)).toBe(0);
    expect(Number.isNaN(upsellTakeRate(onlyUpsell.byTier))).toBe(false);
  });

  it('el borde de la medianoche: orders.day manda, no purchased_at::date en UTC', async () => {
    // En UTC es 31/07 23:30, pero la compra fue 01/08 00:30 en la TZ del
    // funnel: la fila vive en 2026-08-01 y un rango "ayer" no la puede ver.
    await seedOrder(chau.id, {
      externalId: 'sales-t-mid',
      amount: 10000,
      amountEur: 5,
      tier: 'front',
      day: DAY,
      purchasedAt: `${DAY_PREV}T23:30:00Z`,
    });

    const inRange = await getSalesData(filters());
    expect(inRange.totals.ordersApproved).toBe(1);
    expect(inRange.recent[0]!.purchasedAt).toBe(`${DAY_PREV}T23:30:00.000Z`);

    const prevDay = await getSalesData({ funnelId: chau.id, from: DAY_PREV, to: DAY_PREV });
    expect(prevDay.totals.ordersApproved).toBe(0);

    // Y el gráfico diario completa el rango de dos días sin huecos.
    const twoDays = await getSalesData({ funnelId: chau.id, from: DAY_PREV, to: DAY });
    expect(twoDays.byDay).toHaveLength(2);
    expect(twoDays.byDay[0]!.orders).toBe(0);
    expect(twoDays.byDay[1]!.orders).toBe(1);
  });

  it('el filtro de status recorta los breakdowns y la lista, pero no los totales', async () => {
    await seedOrder(chau.id, { externalId: 'sales-t-s1', amount: 10000, amountEur: 5, tier: 'front' });
    await seedOrder(chau.id, {
      externalId: 'sales-t-s2',
      amount: 5000,
      amountEur: 2.5,
      tier: 'front',
      status: 'refunded',
    });

    const status: SalesStatus = 'refunded';
    const data = await getSalesData(filters({ status }));
    // Los totales siguen siendo los tres números completos (T07 §2: el SQL
    // de totales no lleva status en el WHERE, lo resuelve con FILTER).
    expect(data.totals.ordersApproved).toBe(1);
    expect(data.totals.ordersRefunded).toBe(1);
    expect(data.totals.netEur).toBe(2.5);
    // La lista y el desglose por día muestran solo devueltas.
    expect(data.recent).toHaveLength(1);
    expect(data.recent[0]!.status).toBe('refunded');
    expect(data.byDay[0]!.orders).toBe(1);
    expect(data.byDay[0]!.netEur).toBe(-2.5); // neto de solo devueltas
  });

  it('el neto descuenta las comisiones, y solo las de las órdenes aprobadas', async () => {
    // Dos aprobadas y una devuelta, todas con comisión cargada. La comisión de la
    // devuelta NO se cuenta: la pasarela reintegra el cargo, así que no es un
    // costo real (migración 011).
    await seedOrder(chau.id, {
      externalId: 'com-1', amount: 10000, amountEur: 5.79, commission: 629, commissionEur: 0.36,
    });
    await seedOrder(chau.id, {
      externalId: 'com-2', amount: 20000, amountEur: 11.57, commission: 1258, commissionEur: 0.73,
    });
    await seedOrder(chau.id, {
      externalId: 'com-3', amount: 10000, amountEur: 5.79, commission: 629, commissionEur: 0.36,
      status: 'refunded',
    });

    const t = (await getSalesData(filters())).totals;

    expect(t.grossOrig).toBe(30000);
    expect(t.refundedOrig).toBe(10000);
    expect(t.commissionsOrig).toBe(1887); // 629 + 1258, sin la devuelta
    expect(t.netOrig).toBe(30000 - 10000 - 1887);
    expect(t.commissionsEur).toBeCloseTo(1.09, 2);
    expect(t.netEur).toBeCloseTo(5.79 + 11.57 - 5.79 - 1.09, 2);
    // Tasa de comisión (T02): solo sobre el bruto aprobado, en tanto por uno.
    expect(t.commissionRate).toBeCloseTo(1.09 / 17.36, 5);
    // Todas tienen comisión, así que no hay que avisar nada.
    expect(t.ordersSinComision).toBe(0);
  });

  it('una aprobada con comisión en 0 se cuenta en ordersSinComision', async () => {
    // Es el aviso que evita que el neto mienta en silencio cuando la comisión
    // del funnel todavía no se cargó.
    await seedOrder(chau.id, { externalId: 'com-4', amount: 5000, amountEur: 2.9 });
    const t = (await getSalesData(filters())).totals;
    expect(t.ordersSinComision).toBe(1);
    expect(t.commissionsOrig).toBe(0);
    expect(t.netOrig).toBe(5000); // sin comisión, el neto es el bruto
  });

  it('el neto descuenta comisiones Y costos de producto', async () => {
    await seedOrder(chau.id, {
      externalId: 'cst-1', amount: 10000, amountEur: 5.79,
      commission: 660, commissionEur: 0.38, cost: 2000, costEur: 1.16,
    });
    await seedOrder(chau.id, {
      externalId: 'cst-2', amount: 20000, amountEur: 11.57,
      commission: 1320, commissionEur: 0.76, cost: 2000, costEur: 1.16,
    });
    // La devuelta no aporta ni comisión ni costo: la pasarela reintegra el cargo
    // y el producto vuelve (o al menos no se cuenta dos veces).
    await seedOrder(chau.id, {
      externalId: 'cst-3', amount: 10000, amountEur: 5.79, status: 'refunded',
      commission: 660, commissionEur: 0.38, cost: 2000, costEur: 1.16,
    });

    const t = (await getSalesData(filters())).totals;
    expect(t.grossOrig).toBe(30000);
    expect(t.refundedOrig).toBe(10000);
    expect(t.commissionsOrig).toBe(1980);
    expect(t.costsOrig).toBe(4000);
    expect(t.netOrig).toBe(30000 - 10000 - 1980 - 4000);
    expect(t.ordersSinCosto).toBe(0);
    // Tasa de costo (T02): solo sobre el bruto aprobado, en tanto por uno.
    expect(t.costRate).toBeCloseTo(2.32 / 17.36, 5);
  });

  it('una aprobada sin costo cargado se cuenta en ordersSinCosto', async () => {
    await seedOrder(chau.id, { externalId: 'cst-4', amount: 5000, amountEur: 2.9 });
    const t = (await getSalesData(filters())).totals;
    expect(t.ordersSinCosto).toBe(1);
    expect(t.costsOrig).toBe(0);
  });

  it('un costo mayor a la venta da neto negativo, no 0', async () => {
    // Vender a pérdida es un resultado real y el panel lo tiene que mostrar.
    await seedOrder(chau.id, {
      externalId: 'cst-5', amount: 1000, amountEur: 0.58, cost: 5000, costEur: 2.9,
    });
    const t = (await getSalesData(filters())).totals;
    expect(t.netOrig).toBeLessThan(0);
  });
});
