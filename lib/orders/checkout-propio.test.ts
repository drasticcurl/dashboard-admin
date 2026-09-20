import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { PayloadVentaCheckoutPropio } from './checkout-propio-tipos';

/**
 * Tests de upsertOrderCheckoutPropio (T02 §7 del plan panel-y-capi).
 *
 * Sin acceso a una base real (mismo caso que P-01), este archivo mockea la
 * capa de datos (@/lib/db, @/lib/funnels) y los helpers de negocio que YA
 * tienen sus propios tests puros en otro lado (resolveFunnel/resolveTier en
 * resolve.ts, applyCommissions/applyCosts en commissions.ts/costs.ts) — acá
 * no se re-testea SU lógica interna, se testea que checkout-propio.ts los
 * llama con los argumentos correctos y arma la fila de `orders` como pide el
 * contrato A. La integración real contra Postgres (equivalente a
 * lib/orders/webhook.test.ts para Shopify) queda pendiente de un entorno con
 * DATABASE_URL — no se puede correr en esta sesión (ver la Verificación).
 *
 * Se mockea `tx` capturando el SQL/params del INSERT real en vez de mockear
 * upsertOrderCheckoutPropio entero: así el test SÍ verifica el contrato de
 * columnas (centinela de UTMs, fbclid NULL, external_id con prefijo) contra
 * el código de producción, no contra una copia de la lógica en el test.
 */

type CapturedInsert = {
  sql: string;
  params: unknown[];
};

type CapturedSessionsUpdate = {
  sql: string;
  params: unknown[];
};

function estadoInicial() {
  return {
    funnelResolution: { funnelId: null as number | null, how: 'none', warnings: [] as string[] },
    tier: 'unknown',
    fxResult: { amountEur: 27.5, rate: 0.92, fxDay: '2026-09-13', stale: false } as {
      amountEur: number;
      rate: number;
      fxDay: string;
      stale: boolean;
    } | null,
    existingRows: new Map<string, number>(),
    nextId: 1,
    lastInsert: null as CapturedInsert | null,
    // T02 bugfix (2026-09-20): captura el UPDATE sessions.purchased_at, el
    // mismo patrón que ya usa lib/orders/upsert.ts (Shopify) y que faltaba
    // en este flujo — ver comentario en checkout-propio.ts junto al fix.
    sessionsUpdates: [] as CapturedSessionsUpdate[],
  };
}

let e = estadoInicial();

vi.mock('../db', () => ({
  q: vi.fn(async () => []),
  q1: vi.fn(async (sql: string, params?: unknown[]) => {
    // upsertOrderCheckoutPropio pide el día vía SQL (AT TIME ZONE): se
    // devuelve un día fijo derivado de purchasedAt para no reimplementar TZ
    // en el mock.
    if (sql.includes('AT TIME ZONE')) {
      const purchasedAt = String(params?.[0] ?? '2026-09-13T12:00:00Z');
      return { day: purchasedAt.slice(0, 10) };
    }
    return null;
  }),
  tx: vi.fn(async (fn: (c: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number; rows: { id: number }[] }> }) => Promise<unknown>) => {
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('INSERT INTO orders')) {
          e.lastInsert = { sql, params };
          const externalId = params[2] as string; // $3 = external_id
          const existing = e.existingRows.get(externalId);
          if (existing !== undefined) {
            // ON CONFLICT DO NOTHING: cero filas afectadas, como en Postgres real.
            return { rowCount: 0, rows: [] };
          }
          const id = e.nextId++;
          e.existingRows.set(externalId, id);
          return { rowCount: 1, rows: [{ id }] };
        }
        if (sql.includes('UPDATE sessions')) {
          e.sessionsUpdates.push({ sql, params });
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      }),
    };
    return fn(client);
  }),
}));

vi.mock('../funnels', () => ({
  getFunnelById: vi.fn(async () => null),
}));

vi.mock('../fx', () => ({
  toReportCurrency: vi.fn(async () => e.fxResult),
}));

vi.mock('../commissions', () => ({
  applyCommissions: vi.fn(() => ({ amount: 0, amountEur: null, breakdown: [], warnings: [] })),
  rulesForFunnel: vi.fn(async () => []),
}));

vi.mock('../costs', () => ({
  applyCosts: vi.fn(() => ({ amount: 0, amountEur: null, breakdown: [], warnings: [] })),
  costsForShop: vi.fn(async () => []),
}));

vi.mock('./resolve', () => ({
  resolveFunnel: vi.fn(async () => e.funnelResolution),
  resolveTier: vi.fn(async () => e.tier),
}));

// Import DESPUÉS de los mocks.
import { upsertOrderCheckoutPropio, PRODUCT_MAP_SHOP_DOMAIN } from './checkout-propio';
import { resolveFunnel } from './resolve';

function payload(over: Partial<PayloadVentaCheckoutPropio> = {}): PayloadVentaCheckoutPropio {
  return {
    cobroId: '11111111-1111-1111-1111-111111111111',
    whopPlanId: 'plan_test123',
    email: 'test@example.com',
    monto: '29.90',
    moneda: 'usd',
    purchasedAt: '2026-09-13T12:00:00Z',
    utms: {},
    ...over,
  };
}

// Índices de columnas en el INSERT de checkout-propio.ts (VALUES en el mismo
// orden que la lista de columnas del SQL). Si el SQL cambia de orden, estos
// índices tienen que actualizarse junto con él — es intencional que el test
// dependa de la posición, porque es la misma fragilidad que tendría un bug
// real de "columna desalineada".
const COL = {
  funnelId: 0,
  shopDomain: 1,
  externalId: 2,
  email: 3,
  tier: 4,
  amount: 5,
  currency: 6,
  utmSource: 13,
  utmMedium: 14,
  utmCampaign: 15,
  utmContent: 16,
  utmTerm: 17,
  fbclid: 18,
};

beforeEach(() => {
  e = estadoInicial();
  vi.clearAllMocks();
});

describe('upsertOrderCheckoutPropio', () => {
  it('1. UTMs en formato nombre|id → se guardan exactamente como llegaron, sin modificar', async () => {
    const utmCampaign = 'Black Friday|120211112223330';
    const res = await upsertOrderCheckoutPropio(payload({ utms: { utm_campaign: utmCampaign } }));

    expect(res.isNew).toBe(true);
    expect(e.lastInsert).not.toBeNull();
    // El string se guarda tal cual: el parseo del id (regex de lib/queries/ads.ts)
    // corre en la capa de reportes, no acá — esta fuente no lo transforma.
    expect(e.lastInsert!.params[COL.utmCampaign]).toBe(utmCampaign);
  });

  it('2. payload sin ninguna UTM → las 5 columnas quedan en (directo), nunca NULL', async () => {
    await upsertOrderCheckoutPropio(payload({ utms: {} }));

    expect(e.lastInsert!.params[COL.utmSource]).toBe('(directo)');
    expect(e.lastInsert!.params[COL.utmMedium]).toBe('(directo)');
    expect(e.lastInsert!.params[COL.utmCampaign]).toBe('(directo)');
    expect(e.lastInsert!.params[COL.utmContent]).toBe('(directo)');
    expect(e.lastInsert!.params[COL.utmTerm]).toBe('(directo)');
  });

  it('3. fbclid vacío ("") → columna fbclid queda NULL, no string vacío', async () => {
    await upsertOrderCheckoutPropio(payload({ fbclid: '' }));
    expect(e.lastInsert!.params[COL.fbclid]).toBeNull();
  });

  it('3b. fbclid con valor → se guarda crudo, sin transformar a fbc (D6: eso lo hace capi.ts, no acá)', async () => {
    await upsertOrderCheckoutPropio(payload({ fbclid: 'IwARtest123' }));
    expect(e.lastInsert!.params[COL.fbclid]).toBe('IwARtest123');
  });

  it('4. dos llamadas con el mismo cobroId → la segunda devuelve isNew:false, orderId:null', async () => {
    const p = payload({ cobroId: 'cobro-duplicado' });

    const first = await upsertOrderCheckoutPropio(p);
    expect(first.isNew).toBe(true);
    expect(first.orderId).not.toBeNull();

    const second = await upsertOrderCheckoutPropio(p);
    expect(second.isNew).toBe(false);
    expect(second.orderId).toBeNull();
  });

  it('5. whopPlanId sin fila en product_map → funnelId null, la venta se inserta igual (no tira excepción)', async () => {
    e.funnelResolution = { funnelId: null, how: 'none', warnings: [] };
    const res = await upsertOrderCheckoutPropio(payload({ whopPlanId: 'plan_sin_mapa' }));

    expect(res.funnelId).toBeNull();
    expect(res.isNew).toBe(true);
    expect(res.orderId).not.toBeNull();
    expect(e.lastInsert!.params[COL.funnelId]).toBeNull();
  });

  it('external_id lleva el prefijo checkout_propio_ (mismo patrón que shopify_ de Shopify)', async () => {
    await upsertOrderCheckoutPropio(payload({ cobroId: 'abc-123' }));
    expect(e.lastInsert!.params[COL.externalId]).toBe('checkout_propio_abc-123');
  });

  it('orders.shop_domain se guarda como "*", NUNCA como "checkout_propio" (son dos columnas distintas — regla 1 de la task)', async () => {
    await upsertOrderCheckoutPropio(payload());
    expect(e.lastInsert!.params[COL.shopDomain]).toBe('*');
  });

  it('resolveFunnel se llama con shopDomain=PRODUCT_MAP_SHOP_DOMAIN y sin attrFunnel (D2: esta fuente no tiene cart attribute)', async () => {
    await upsertOrderCheckoutPropio(payload({ whopPlanId: 'plan_xyz' }));
    expect(resolveFunnel).toHaveBeenCalledWith({
      shopDomain: PRODUCT_MAP_SHOP_DOMAIN,
      productIds: ['plan_xyz'],
    });
    expect(PRODUCT_MAP_SHOP_DOMAIN).toBe('checkout_propio');
  });

  it('email se guarda directo del payload (esta fuente no arbitra entre múltiples campos como Shopify)', async () => {
    await upsertOrderCheckoutPropio(payload({ email: 'compradora@example.com' }));
    expect(e.lastInsert!.params[COL.email]).toBe('compradora@example.com');
  });

  it('email null (payload sin email) se guarda como NULL, no como string', async () => {
    await upsertOrderCheckoutPropio(payload({ email: null }));
    expect(e.lastInsert!.params[COL.email]).toBeNull();
  });

  // Antes esperaba 'usd' (se guardaba `.toLowerCase()` para espejar lo que hace
  // `armarPayloadIngest` del checkout). El espejo era cosmético y costaba plata:
  // `funnels.sell_currency` es 'USD' y las queries de gasto de Ventas y del
  // rollup unen `fx_rates.base = f.sell_currency`, así que la moneda en
  // minúscula no matcheaba ninguna cotización. Ver lib/fx.ts:getRate.
  it('moneda se guarda en MAYÚSCULAS, como funnels.sell_currency y fx_rates.base', async () => {
    await upsertOrderCheckoutPropio(payload({ moneda: 'usd' }));
    expect(e.lastInsert!.params[COL.currency]).toBe('USD');
  });

  it('moneda que ya viene en mayúsculas se guarda igual (idempotente)', async () => {
    await upsertOrderCheckoutPropio(payload({ moneda: 'USD' }));
    expect(e.lastInsert!.params[COL.currency]).toBe('USD');
  });

  it('monto llega como string decimal y se guarda como number', async () => {
    await upsertOrderCheckoutPropio(payload({ monto: '29.90' }));
    expect(e.lastInsert!.params[COL.amount]).toBe(29.9);
  });

  // T02 bugfix (2026-09-20, encontrado en producción): 6 ventas reales de
  // Alma Gemela llegaron con sessionId válido y existente en `sessions`,
  // pero "Compraron" del embudo seguía en 0 porque este flujo nunca
  // actualizaba sessions.purchased_at (a diferencia de lib/orders/upsert.ts
  // de Shopify, que sí lo hace). La venta quedaba bien guardada en `orders`
  // pero invisible para el embudo.
  it('6. sessionId presente → actualiza sessions.purchased_at (mismo patrón que Shopify)', async () => {
    e.funnelResolution = { funnelId: 5, how: 'product_map', warnings: [] };
    await upsertOrderCheckoutPropio(
      payload({ sessionId: '11111111-1111-1111-1111-111111111111', purchasedAt: '2026-09-20T12:00:00Z' }),
    );

    expect(e.sessionsUpdates).toHaveLength(1);
    const [sid, purchasedAt, funnelId] = e.sessionsUpdates[0]!.params;
    expect(sid).toBe('11111111-1111-1111-1111-111111111111');
    expect(purchasedAt).toBe('2026-09-20T12:00:00Z');
    expect(funnelId).toBe(5);
  });

  it('7. sin sessionId en el payload → no se toca sessions (nada que actualizar)', async () => {
    await upsertOrderCheckoutPropio(payload({ sessionId: undefined }));
    expect(e.sessionsUpdates).toHaveLength(0);
  });

  it('8. reenvío duplicado (mismo cobroId) → el UPDATE de sessions NO se repite en la segunda llamada', async () => {
    const p = payload({ cobroId: 'cobro-dup-sesion', sessionId: '22222222-2222-2222-2222-222222222222' });

    await upsertOrderCheckoutPropio(p);
    expect(e.sessionsUpdates).toHaveLength(1);

    await upsertOrderCheckoutPropio(p);
    // ON CONFLICT DO NOTHING → rowCount 0 → se sale antes del UPDATE de sessions.
    expect(e.sessionsUpdates).toHaveLength(1);
  });
});
