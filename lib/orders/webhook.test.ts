import { createHmac, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from '../../app/api/webhooks/shopify/route';
import { q, q1 } from '../db';
import { getFunnelBySlug, type Funnel } from '../funnels';
import type { ShopifyOrder, ShopifyRefund } from './types';
import orderBump from './__fixtures__/order-bump.json';
import orderFront from './__fixtures__/order-front.json';
import orderUpsell from './__fixtures__/order-upsell-no-utms.json';
import refundFixture from './__fixtures__/refund.json';

// vitest no carga .env solo (mismo patrón que scripts/*.ts): en dev el env
// vive en el archivo, en producción viene de PM2. Cargarlo acá hace que la
// suite corra contra la base real en vez de saltarse en silencio.
if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

/**
 * Integración con Postgres real del webhook completo (task T04 §7). Este
 * archivo es el DUEÑO exclusivo de la mutación de SHOPIFY_WEBHOOK_SECRETS:
 * los otros tests del módulo (verify.test.ts) solo prueban el núcleo puro,
 * para que dos archivos en paralelo no se pisen el env compartido.
 */
describe.skipIf(!dbAvailable)('webhook shopify (integración)', () => {
  const SECRET = 't04-test-secret';
  const SHOP = 'mitienda.myshopify.com';
  let originalSecret: string | undefined;
  let chau: Funnel;
  let reset: Funnel;
  let baseline = 0;
  const createdOrders: string[] = [];
  const createdSids: string[] = [];

  beforeAll(async () => {
    originalSecret = process.env.SHOPIFY_WEBHOOK_SECRETS;
    process.env.SHOPIFY_WEBHOOK_SECRETS = SECRET;

    const c = await getFunnelBySlug('chauhinchazon');
    const r = await getFunnelBySlug('reset');
    if (!c || !r) throw new Error('faltan los funnels del seed: corré npm run db:migrate');
    chau = c;
    reset = r;

    // Los mapas de prueba. 8123456789014 (el ítem del fixture de upsell) NO
    // está mapeado a propósito: es el caso tier 'unknown'. 8123456789015
    // mapea a reset para el caso de conflicto de funnels.
    await q(
      `INSERT INTO product_map (shop_domain, product_id, funnel_id, tier) VALUES
       ('*', '8123456789012', $1, 'front'),
       ('*', '8123456789013', $1, 'bump'),
       ('*', '8123456789015', $2, 'upsell')`,
      [chau.id, reset.id],
    );
    await q('INSERT INTO shop_map (shop_domain, funnel_id) VALUES ($1, $2)', [SHOP, chau.id]);

    // Cotizaciones para los días de los fixtures (processed_at del 11 y 12 de
    // agosto de 2026; el del 12 a las 01:15Z cae el 11 en hora argentina).
    //
    // Sin esto el test 1 depende de que OTRA corrida haya dejado cotizaciones en
    // la base: en una base limpia `toEur` no encuentra ninguna, `amount_eur`
    // queda NULL y el test falla sin que nada esté roto. Se detectó justo así,
    // corriendo la suite contra una base de test recién creada.
    //
    // `source='test'` para poder borrar solo estas en el afterAll, y
    // `DO NOTHING` para no pisar una cotización real en una base de desarrollo.
    await q(
      `INSERT INTO fx_rates (day, base, quote, rate, source)
       SELECT d::date, 'ARS', 'EUR', 0.0005785, 'test'
       FROM generate_series('2026-08-10'::date, '2026-08-13'::date, '1 day') AS d
       ON CONFLICT (day, base, quote) DO NOTHING`,
    );

    const row = await q1<{ max: number }>('SELECT COALESCE(MAX(id), 0) AS max FROM webhook_events');
    baseline = row?.max ?? 0;
  });

  afterAll(async () => {
    await q('DELETE FROM product_map WHERE product_id = ANY($1::text[])', [
      ['8123456789012', '8123456789013', '8123456789015'],
    ]);
    await q('DELETE FROM shop_map WHERE shop_domain = $1', [SHOP]);
    await q("DELETE FROM fx_rates WHERE source = 'test'");
    process.env.SHOPIFY_WEBHOOK_SECRETS = originalSecret;
  });

  afterEach(async () => {
    const exts = createdOrders.splice(0);
    if (exts.length) await q('DELETE FROM orders WHERE external_id = ANY($1::text[])', [exts]);
    const sids = createdSids.splice(0);
    if (sids.length) await q('DELETE FROM sessions WHERE id = ANY($1::uuid[])', [sids]);
    await q('DELETE FROM webhook_events WHERE id > $1', [baseline]);
  });

  function signBody(body: string, secret: string): string {
    return createHmac('sha256', secret).update(body, 'utf8').digest('base64');
  }

  function postReq(body: string, secret: string, topic: string, shop: string = SHOP): NextRequest {
    return new NextRequest('http://127.0.0.1:3005/api/webhooks/shopify', {
      method: 'POST',
      headers: {
        'x-shopify-hmac-sha256': signBody(body, secret),
        'x-shopify-topic': topic,
        'x-shopify-shop-domain': shop,
        'content-type': 'application/json',
      },
      body,
    });
  }

  function postOrder(order: ShopifyOrder, topic: string, secret: string = SECRET, shop: string = SHOP) {
    return POST(postReq(JSON.stringify(order), secret, topic, shop));
  }

  const ORDER_COLS = `id, funnel_id, status, tier, amount::text AS amount, currency,
    amount_eur::text AS amount_eur, fx_stale, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    fbclid, country, session_id::text AS session_id, visitor_id::text AS visitor_id,
    day::text AS day, purchased_at, refunded_at, email`;

  type OrderRow = {
    id: number;
    funnel_id: number | null;
    status: string;
    tier: string;
    amount: string;
    currency: string;
    amount_eur: string | null;
    fx_stale: boolean;
    utm_source: string;
    utm_medium: string;
    utm_campaign: string;
    utm_content: string;
    utm_term: string;
    fbclid: string | null;
    country: string | null;
    session_id: string | null;
    visitor_id: string | null;
    day: string;
    purchased_at: Date;
    refunded_at: Date | null;
    email: string | null;
  };

  function readOrder(externalId: string): Promise<OrderRow | null> {
    return q1<OrderRow>(`SELECT ${ORDER_COLS} FROM orders WHERE external_id = $1`, [externalId]);
  }

  type EventRow = {
    status: string;
    error: string | null;
    topic: string | null;
    external_id: string | null;
    has_payload: boolean;
  };

  function webhookEvents(): Promise<EventRow[]> {
    return q<EventRow>(
      `SELECT status, error, topic, external_id, payload IS NOT NULL AS has_payload
       FROM webhook_events WHERE id > $1 ORDER BY id`,
      [baseline],
    );
  }

  async function expectedDay(at: string): Promise<string> {
    const row = await q1<{ day: string }>(
      'SELECT ($1::timestamptz AT TIME ZONE $2)::date::text AS day',
      [at, chau.timezone],
    );
    return row!.day;
  }

  async function createSession(sid: string, funnelId: number): Promise<void> {
    createdSids.push(sid);
    await q(
      `INSERT INTO sessions (id, funnel_id, visitor_id, variant, day, started_at, last_seen_at)
       VALUES ($1::uuid, $2::smallint, $3::uuid, 'default',
               (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, now(), now())`,
      [sid, funnelId, randomUUID()],
    );
  }

  it('GET → healthcheck con configured sin exponer secrets', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; configured: boolean };
    expect(body.ok).toBe(true);
    expect(body.configured).toBe(true);
  });

  it('1. firma válida → orden creada y funnel resuelto por el cart attribute', async () => {
    createdOrders.push('shopify_9001000001');
    const res = await postOrder(orderFront as ShopifyOrder, 'orders/paid');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; new: boolean; funnelId: number | null };
    expect(json.ok).toBe(true);
    expect(json.new).toBe(true);
    expect(json.funnelId).toBe(chau.id);

    const o = (await readOrder('shopify_9001000001'))!;
    expect(o.funnel_id).toBe(chau.id);
    expect(o.status).toBe('approved');
    expect(o.tier).toBe('front');
    expect(o.amount).toBe('7790.00');
    expect(o.currency).toBe('ARS');
    expect(o.amount_eur).not.toBeNull();
    expect(o.fx_stale).toBe(false);
    // note_attributes ganan sobre landing_site: medium no vino por ahí.
    expect(o.utm_source).toBe('facebook');
    expect(o.utm_campaign).toBe('AOV NUEVO');
    expect(o.utm_medium).toBe('(directo)');
    expect(o.fbclid).toBeNull();
    expect(o.country).toBe('AR');
    // session_id se guarda aunque la sesión no exista (compra desde otro
    // dispositivo): el UPDATE de sessions no afecta filas y no es un error.
    expect(o.session_id).toBe('11111111-2222-4333-8444-555555555555');
    expect(o.visitor_id).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(o.day).toBe(await expectedDay('2026-08-11T19:02:11Z'));

    const items = await q<{ tier: string; amount: string }>(
      'SELECT tier, amount::text AS amount FROM order_items WHERE order_id = $1',
      [o.id],
    );
    expect(items).toHaveLength(1);
    expect(items[0].tier).toBe('front');

    const events = await webhookEvents();
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('ok');
    expect(events[0].topic).toBe('orders/paid');
    expect(events[0].external_id).toBe('shopify_9001000001');
  });

  it('2. firma inválida → 401, cero filas en orders y una en webhook_events', async () => {
    const bad = structuredClone(orderFront) as ShopifyOrder;
    bad.id = 9001000202;
    const res = await POST(postReq(JSON.stringify(bad), 'firma-incorrecta', 'orders/paid'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'unauthorized' });
    expect(await readOrder('shopify_9001000202')).toBeNull();

    const events = await webhookEvents();
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('bad_signature');
    expect(events[0].error).toBe('hmac_invalid');
    expect(events[0].has_payload).toBe(true); // el payload queda para diagnosticar
  });

  it('3. SHOPIFY_WEBHOOK_SECRETS vacío → 401 (no hay modo permisivo)', async () => {
    process.env.SHOPIFY_WEBHOOK_SECRETS = '';
    try {
      const bad = structuredClone(orderFront) as ShopifyOrder;
      bad.id = 9001000303;
      // La firma está bien calculada, pero sin secrets configuradas el
      // endpoint no puede aceptar nada: falla visiblemente, no acepta todo.
      const res = await POST(postReq(JSON.stringify(bad), SECRET, 'orders/paid'));
      expect(res.status).toBe(401);
      expect(await readOrder('shopify_9001000303')).toBeNull();

      const events = await webhookEvents();
      expect(events[0].status).toBe('bad_signature');
      expect(events[0].error).toBe('secrets_not_configured');

      const get = await GET();
      expect((await get.json()).configured).toBe(false);
    } finally {
      process.env.SHOPIFY_WEBHOOK_SECRETS = SECRET;
    }
  });

  it('4. orders/create + orders/paid de la misma orden → una fila, la segunda duplicate', async () => {
    const o = structuredClone(orderFront) as ShopifyOrder;
    o.id = 9001000004;
    createdOrders.push('shopify_9001000004');

    const first = await postOrder(o, 'orders/paid');
    expect((await first.json()).new).toBe(true);

    const second = await postOrder(o, 'orders/create'); // financial_status 'paid'
    expect((await second.json()).new).toBe(false);

    expect(await readOrder('shopify_9001000004')).not.toBeNull();
    const events = await webhookEvents();
    expect(events.map((e) => e.status).sort()).toEqual(['duplicate', 'ok']);
  });

  it('5. producto sin fila en product_map → tier unknown, la orden se guarda igual', async () => {
    createdOrders.push('shopify_9001000003');
    const res = await postOrder(orderUpsell as ShopifyOrder, 'orders/paid');
    const json = (await res.json()) as { funnelId: number | null };
    expect(json.funnelId).toBe(chau.id); // resuelto por shop_map, no por producto

    const o = (await readOrder('shopify_9001000003'))!;
    expect(o.funnel_id).toBe(chau.id);
    expect(o.tier).toBe('unknown');
    // Sin UTMs propios y sin compra previa atribuida todavía: directo.
    expect(o.utm_source).toBe('(directo)');

    const items = await q<{ tier: string }>('SELECT tier FROM order_items WHERE order_id = $1', [o.id]);
    expect(items).toHaveLength(1);
    expect(items[0].tier).toBe('unknown');
  });

  it('6. ningún camino resuelve el funnel → funnel_id NULL, unmatched_funnel, orden guardada', async () => {
    const o: ShopifyOrder = {
      id: 9001000006,
      order_number: 1046,
      email: 'sin.mapa@example.com',
      financial_status: 'paid',
      total_price: '15000.00',
      currency: 'ARS',
      processed_at: '2026-08-11T19:40:00Z',
      line_items: [{ product_id: 9999999999999, title: 'Producto sin mapa', price: '15000.00', quantity: 1 }],
    };
    createdOrders.push('shopify_9001000006');
    const res = await postOrder(o, 'orders/paid', SECRET, 'tienda-sin-mapa.myshopify.com');
    const json = (await res.json()) as { new: boolean; funnelId: number | null };
    expect(json.new).toBe(true);
    expect(json.funnelId).toBeNull();

    const row = (await readOrder('shopify_9001000006'))!;
    expect(row.funnel_id).toBeNull();
    expect(row.tier).toBe('unknown');
    // Sin funnel: day con la TZ del dashboard (DASHBOARD_TZ del .env).
    expect(row.day).toBe(await expectedDay('2026-08-11T19:40:00Z'));

    const events = await webhookEvents();
    expect(events[0].status).toBe('unmatched_funnel');
  });

  it('7. front + bump → dos order_items con tiers distintos y orders.tier = el más caro', async () => {
    createdOrders.push('shopify_9001000002');
    const res = await postOrder(orderBump as ShopifyOrder, 'orders/paid');
    expect((await res.json()).new).toBe(true);

    const o = (await readOrder('shopify_9001000002'))!;
    expect(o.tier).toBe('front'); // 7790 > 3990

    const items = await q<{ title: string; tier: string; amount: string }>(
      'SELECT title, tier, amount::text AS amount FROM order_items WHERE order_id = $1 ORDER BY id',
      [o.id],
    );
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.tier)).toEqual(['front', 'bump']);
    expect(items.map((i) => i.amount)).toEqual(['7790.00', '3990.00']);
  });

  it('8. upsell sin UTMs con compra previa atribuida del mismo email → hereda la campaña', async () => {
    await q(
      `INSERT INTO orders (source, external_id, email, status, tier, amount, currency,
                           utm_source, utm_campaign, purchased_at, day)
       VALUES ('import', 'prior_8', $1, 'approved', 'front', 7790, 'ARS',
               'facebook', 'campaña-previa', $2::timestamptz, $3::date)`,
      ['upsell.vuelve@example.com', '2026-08-10T19:00:00Z', '2026-08-10'],
    );
    createdOrders.push('prior_8');

    const o = structuredClone(orderUpsell) as ShopifyOrder;
    o.id = 9001000008;
    createdOrders.push('shopify_9001000008');
    const res = await postOrder(o, 'orders/paid');
    expect((await res.json()).new).toBe(true);

    const row = (await readOrder('shopify_9001000008'))!;
    expect(row.utm_source).toBe('facebook');
    expect(row.utm_campaign).toBe('campaña-previa');
    expect(row.utm_medium).toBe('(directo)');
  });

  it('9. sin cotización en fx_rates → amount_eur NULL, fx_stale true, orden guardada', async () => {
    const fxRows = await q<{ day: string; base: string; quote: string; rate: string; source: string }>(
      'SELECT day::text AS day, base, quote, rate::text AS rate, source FROM fx_rates',
    );
    await q('DELETE FROM fx_rates');
    try {
      const o = structuredClone(orderFront) as ShopifyOrder;
      o.id = 9001000009;
      createdOrders.push('shopify_9001000009');
      const res = await postOrder(o, 'orders/paid');
      expect((await res.json()).new).toBe(true);

      const row = (await readOrder('shopify_9001000009'))!;
      expect(row.amount_eur).toBeNull();
      expect(row.fx_stale).toBe(true);
    } finally {
      for (const r of fxRows) {
        await q(
          'INSERT INTO fx_rates (day, base, quote, rate, source) VALUES ($1::date, $2, $3, $4::numeric, $5)',
          [r.day, r.base, r.quote, r.rate, r.source],
        );
      }
    }
  });

  it('10. sid válido → sessions.purchased_at marcado; sid de otro funnel → NO marcado', async () => {
    const sidChau = randomUUID();
    const sidReset = randomUUID();
    await createSession(sidChau, chau.id);
    await createSession(sidReset, reset.id);

    const a = structuredClone(orderFront) as ShopifyOrder;
    a.id = 9001000010;
    a.note_attributes = [
      { name: 'funnel', value: 'chauhinchazon' },
      { name: 'sid', value: sidChau },
    ];
    createdOrders.push('shopify_9001000010');
    await postOrder(a, 'orders/paid');

    const b = structuredClone(orderFront) as ShopifyOrder;
    b.id = 9001000011;
    b.note_attributes = [
      { name: 'funnel', value: 'chauhinchazon' },
      { name: 'sid', value: sidReset },
    ];
    createdOrders.push('shopify_9001000011');
    await postOrder(b, 'orders/paid');

    const s1 = await q1<{ purchased_at: Date | null }>('SELECT purchased_at FROM sessions WHERE id = $1', [sidChau]);
    expect(s1!.purchased_at).not.toBeNull();

    // El sid de la sesión de OTRO funnel no la marca (AND funnel_id), pero la
    // orden igual queda con session_id guardado.
    const s2 = await q1<{ purchased_at: Date | null }>('SELECT purchased_at FROM sessions WHERE id = $1', [sidReset]);
    expect(s2!.purchased_at).toBeNull();
    const ob = (await readOrder('shopify_9001000011'))!;
    expect(ob.session_id).toBe(sidReset);
  });

  it('11. refunds/create → status refunded, la fila sigue existiendo', async () => {
    const o = structuredClone(orderFront) as ShopifyOrder;
    o.id = 9001000111;
    createdOrders.push('shopify_9001000111');
    await postOrder(o, 'orders/paid');

    const refund = structuredClone(refundFixture) as ShopifyRefund;
    refund.order_id = 9001000111;
    const res = await POST(postReq(JSON.stringify(refund), SECRET, 'refunds/create'));
    expect(res.status).toBe(200);

    const row = (await readOrder('shopify_9001000111'))!;
    expect(row.status).toBe('refunded');
    expect(row.refunded_at).not.toBeNull();

    const events = await webhookEvents();
    expect(events[events.length - 1].status).toBe('ok');
  });

  it('11b. refunds/create de una orden inexistente → 200 con error order_not_found', async () => {
    const refund = structuredClone(refundFixture) as ShopifyRefund;
    refund.order_id = 9001999999;
    const res = await POST(postReq(JSON.stringify(refund), SECRET, 'refunds/create'));
    expect(res.status).toBe(200);

    const events = await webhookEvents();
    const last = events[events.length - 1];
    expect(last.status).toBe('error');
    expect(last.error).toBe('order_not_found');
  });

  it('12. orders/create con financial_status pending → ignorado, sin fila en orders', async () => {
    const o = structuredClone(orderFront) as ShopifyOrder;
    o.id = 9001000012;
    o.financial_status = 'pending';
    const res = await postOrder(o, 'orders/create');
    expect(res.status).toBe(200);
    expect((await res.json()).ignored).toBe('not_paid');
    expect(await readOrder('shopify_9001000012')).toBeNull();

    const events = await webhookEvents();
    const last = events[events.length - 1];
    expect(last.status).toBe('ignored');
    expect(last.error).toBe('not_paid');
  });

  it('bonus: ítems que mapean a funnels distintos → gana el más caro y el conflicto queda visible', async () => {
    const o: ShopifyOrder = {
      id: 9001000013,
      order_number: 1053,
      email: 'conflicto@example.com',
      financial_status: 'paid',
      total_price: '11780.00',
      currency: 'ARS',
      processed_at: '2026-08-11T20:00:00Z',
      line_items: [
        { product_id: 8123456789012, title: 'Front Chau', price: '7790.00', quantity: 1 },
        { product_id: 8123456789015, title: 'Upsell Reset', price: '3990.00', quantity: 1 },
      ],
    };
    createdOrders.push('shopify_9001000013');
    const res = await postOrder(o, 'orders/paid');
    const json = (await res.json()) as { funnelId: number | null };
    expect(json.funnelId).toBe(chau.id); // el front (7790) es más caro que el upsell (3990)

    const row = (await readOrder('shopify_9001000013'))!;
    expect(row.funnel_id).toBe(chau.id);
    expect(row.tier).toBe('front');

    const events = await webhookEvents();
    const last = events[events.length - 1];
    expect(last.status).toBe('ok'); // no es un error fatal
    expect(last.error).toContain('funnel_conflicto');
  });

  it('bonus: attribute funnel desconocido → cae al product_map con warning', async () => {
    const o = structuredClone(orderFront) as ShopifyOrder;
    o.id = 9001000014;
    o.note_attributes = [{ name: 'funnel', value: 'funnel-inexistente' }];
    createdOrders.push('shopify_9001000014');
    const res = await postOrder(o, 'orders/paid');
    const json = (await res.json()) as { funnelId: number | null };
    expect(json.funnelId).toBe(chau.id); // resuelto por product_map (8123456789012)

    const events = await webhookEvents();
    const last = events[events.length - 1];
    expect(last.status).toBe('ok');
    expect(last.error).toContain('funnel_attribute_desconocido:funnel-inexistente');
  });
});
