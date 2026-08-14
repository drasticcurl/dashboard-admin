import { NextRequest, NextResponse } from 'next/server';
import { q } from '@/lib/db';
import { refundOrder } from '@/lib/orders/refund';
import type { ShopifyOrder, ShopifyRefund } from '@/lib/orders/types';
import { upsertOrder } from '@/lib/orders/upsert';
import { getWebhookSecrets, verifySignature } from '@/lib/orders/verify';

/**
 * /api/webhooks/shopify — webhook centralizado de ventas (plan §5, task T04).
 *
 * Registra TODAS las ventas de TODOS los funnels en orders/order_items, con
 * moneda original + conversión a EUR congelada (D12/D13).
 *
 * La firma se valida sobre el body crudo (los bytes exactos que llegaron:
 * parsear y re-serializar rompe el HMAC). Este endpoint es la fuente de
 * verdad de las ventas: sin secrets configurados se RECHAZA, no hay modo
 * permisivo como en los funnels (plan §5).
 *
 * Se responde 200 siempre que la firma sea válida, incluso si algo interno
 * falló: un 5xx hace que Shopify reintente el mismo pedido por horas; el
 * error tiene que quedar en webhook_events, que es donde se mira (D20).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type WebhookEntry = {
  shopDomain: string | null;
  topic: string | null;
  externalId: string | null;
  status: string;
  error?: string;
  payload?: unknown;
};

/**
 * Cada entrega de Shopify deja su fila en webhook_events (D20): es la red de
 * seguridad que permite responder "¿llegó? ¿qué pasó?" sin mirar logs. El
 * insert nunca puede tumbar el webhook: si falla, queda en el console y la
 * respuesta 200 se mantiene.
 */
async function logWebhookEvent(entry: WebhookEntry): Promise<void> {
  try {
    await q(
      `INSERT INTO webhook_events (source, shop_domain, topic, external_id, status, error, payload)
       VALUES ('shopify', $1, $2, $3, $4, $5, $6::jsonb)`,
      [
        entry.shopDomain,
        entry.topic,
        entry.externalId,
        entry.status,
        entry.error ?? null,
        entry.payload === undefined ? null : JSON.stringify(entry.payload),
      ],
    );
  } catch (err) {
    console.error('[shopify] no se pudo registrar el evento en webhook_events:', err);
  }
}

/** Healthcheck: existe el endpoint y el secret está configurado. Sin exponer secrets. */
export async function GET() {
  return NextResponse.json({ ok: true, configured: getWebhookSecrets().length > 0 });
}

export async function POST(req: NextRequest) {
  // 1. Body crudo: la firma se calcula sobre estos bytes exactos.
  const raw = await req.text();
  const hmac = req.headers.get('x-shopify-hmac-sha256');
  const topic = (req.headers.get('x-shopify-topic') ?? '').toLowerCase();
  const shop = req.headers.get('x-shopify-shop-domain');

  // 2. Firma. Sin secrets configurados también se rechaza, pero con log de
  // error aparte: no es un ataque, es una tienda que no se configuró.
  const verdict = verifySignature(raw, hmac);
  if (verdict === 'unconfigured') {
    console.error('[shopify] SHOPIFY_WEBHOOK_SECRETS no configurado: webhook RECHAZADO (modo no permisivo)');
    await logWebhookEvent({
      shopDomain: shop,
      topic,
      externalId: null,
      status: 'bad_signature',
      error: 'secrets_not_configured',
      payload: raw,
    });
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  if (verdict === 'invalid') {
    // Causa típica: la tienda está enviando pero su secret no está en la
    // lista. Síntoma: ventas que no aparecen en el panel. El payload se
    // guarda para diagnosticar.
    await logWebhookEvent({
      shopDomain: shop,
      topic,
      externalId: null,
      status: 'bad_signature',
      error: 'hmac_invalid',
      payload: raw,
    });
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  // Desde acá la firma es válida: pase lo que pase, la respuesta es 200.
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    // Shopify no manda JSON inválido; si pasa, que quede registrado y no
    // reintente para siempre.
    await logWebhookEvent({
      shopDomain: shop,
      topic,
      externalId: null,
      status: 'error',
      error: 'invalid_json',
      payload: raw,
    });
    return NextResponse.json({ ok: true, error: 'invalid_json' });
  }

  const shopDomain = shop ?? '*';

  switch (topic) {
    case 'orders/paid':
      return handleApproved(body as ShopifyOrder, shopDomain, topic);

    case 'orders/create': {
      // Fallback: solo se trata como compra si ya está pagada; una orden
      // pendiente que después se paga llega de nuevo como orders/paid.
      const order = body as ShopifyOrder;
      if ((order.financial_status ?? '').toLowerCase() !== 'paid') {
        await logWebhookEvent({
          shopDomain,
          topic,
          externalId: order.id != null ? `shopify_${order.id}` : null,
          status: 'ignored',
          error: 'not_paid',
        });
        return NextResponse.json({ ok: true, ignored: 'not_paid' });
      }
      return handleApproved(order, shopDomain, topic);
    }

    case 'refunds/create': {
      // El order_id está en refund.order_id, NO en refund.id: confundirlos
      // es el bug de este handler (task T04 §6).
      const refund = body as ShopifyRefund;
      return handleRefund(refund.order_id, shopDomain, topic);
    }

    case 'orders/cancelled': {
      const order = body as ShopifyOrder;
      return handleRefund(order.id, shopDomain, topic);
    }

    default:
      // Topics no manejados: fila 'ignored' y 200 para que Shopify no reintente.
      await logWebhookEvent({ shopDomain, topic, externalId: null, status: 'ignored' });
      return NextResponse.json({ ok: true, ignored: topic || 'no_topic' });
  }
}

async function handleApproved(
  order: ShopifyOrder,
  shopDomain: string,
  topic: string,
): Promise<NextResponse> {
  const externalId = order.id != null ? `shopify_${order.id}` : null;
  try {
    const { orderId, isNew, funnelId, warnings } = await upsertOrder(order, shopDomain, order);
    // unmatched_funnel NO es un error: la venta se guardó y el cajón "Ventas
    // sin atribuir" la muestra (D10). Las warnings (funnel desconocido,
    // conflicto de funnels) van en la columna error para que se vean.
    const status = isNew ? (funnelId === null ? 'unmatched_funnel' : 'ok') : 'duplicate';
    await logWebhookEvent({
      shopDomain,
      topic,
      externalId,
      status,
      error: warnings.length > 0 ? warnings.join('; ') : undefined,
    });
    return NextResponse.json({
      ok: true,
      topic,
      orderId: orderId ?? null,
      new: isNew,
      funnelId: funnelId ?? null,
    });
  } catch (err) {
    console.error('[shopify] error procesando la orden:', err);
    await logWebhookEvent({
      shopDomain,
      topic,
      externalId,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ ok: true, error: 'internal' });
  }
}

async function handleRefund(
  orderId: string | number | undefined,
  shopDomain: string,
  topic: string,
): Promise<NextResponse> {
  const externalId = orderId != null ? `shopify_${orderId}` : null;
  try {
    const { found } = await refundOrder(orderId);
    await logWebhookEvent({
      shopDomain,
      topic,
      externalId,
      status: found ? 'ok' : 'error',
      // Devolución de una orden anterior a este sistema: 200 igual.
      error: found ? undefined : 'order_not_found',
    });
    return NextResponse.json({ ok: true, topic, found });
  } catch (err) {
    console.error('[shopify] error procesando la devolución:', err);
    await logWebhookEvent({
      shopDomain,
      topic,
      externalId,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ ok: true, error: 'internal' });
  }
}
