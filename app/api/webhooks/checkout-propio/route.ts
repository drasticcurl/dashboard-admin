import { createHash, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { ZodError, z } from 'zod';
import { q, q1 } from '@/lib/db';
import { getFunnelByIngestKey } from '@/lib/funnels';
import { upsertOrderCheckoutPropio } from '@/lib/orders/checkout-propio';
import type {
  PayloadVentaCheckoutPropio,
  RespuestaVentaCheckoutPropio,
} from '@/lib/orders/checkout-propio-tipos';

/**
 * /api/webhooks/checkout-propio — recibe la venta de checkout-kashhhpay y la
 * inserta en `orders` con source='checkout_propio' (T02, plan panel-y-capi).
 *
 * A diferencia de /api/webhooks/shopify: NO hay firma HMAC sobre bytes
 * crudos que verificar (D4 del plan). La autenticación es el MISMO mecanismo
 * de Bearer token que ya usa /api/ingest (app/api/ingest/route.ts líneas
 * 49-78): comparación directa por igualdad en SQL (getFunnelByIngestKey) y
 * después SHA-256 + timingSafeEqual contra funnels.ingest_key_hash. Reusar
 * el mecanismo evita inventar un segundo secreto que hay que rotar y
 * documentar aparte.
 *
 * Igual que Shopify: se responde 200 siempre que la auth sea válida, incluso
 * si algo interno falla — el error se registra en webhook_events y NO se
 * fuerza un reintento infinito del backoff que ya tiene el cron de salidas
 * de checkout-kashhhpay (D3).
 *
 * P-02 del plan (sin resolver): qué funnel/key exacta usar en producción
 * para autenticar checkout-kashhhpay. Esta ruta NO lo decide — usa el mismo
 * mecanismo genérico de /api/ingest (cualquier fila de `funnels` con
 * ingest_key_hash configurado sirve para autenticar). Quien despliegue esto
 * en producción decide qué funnel real usar y configura
 * CHECKOUT_PROPIO_INGEST_KEY_HINT si hace falta documentarlo — ver la
 * verificación de este archivo para el valor de prueba usado.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Mismo shape que el contrato A (checkout-propio-tipos.ts), pero como schema
// de zod: acá es donde se RECHAZA un payload que no cumple el contrato (400),
// no en upsertOrderCheckoutPropio (que asume que ya es válido).
const payloadSchema = z.object({
  cobroId: z.string().min(1),
  whopPlanId: z.string().min(1),
  email: z.string().nullable(),
  // numeric(10,2) como string (contrato A): no se valida el formato exacto
  // acá, Number.parseFloat en checkout-propio.ts ya tolera cualquier string
  // numérico y cae a 0 si no lo es — mismo criterio que upsert.ts de Shopify.
  monto: z.string().min(1),
  moneda: z.string().min(1),
  purchasedAt: z.string().min(1),
  utms: z.object({
    utm_source: z.string().optional(),
    utm_medium: z.string().optional(),
    utm_campaign: z.string().optional(),
    utm_content: z.string().optional(),
    utm_term: z.string().optional(),
  }),
  fbclid: z.string().optional(),
  sessionId: z.string().optional(),
  visitorId: z.string().optional(),
});

function json(status: number, body: RespuestaVentaCheckoutPropio): NextResponse<RespuestaVentaCheckoutPropio> {
  return NextResponse.json(body, { status });
}

type WebhookEntry = {
  externalId: string | null;
  status: string;
  error?: string;
  payload?: unknown;
};

/**
 * Registra el intento en webhook_events, igual que Shopify (D20): es la red
 * de seguridad que permite responder "¿llegó? ¿qué pasó?" sin mirar logs. El
 * insert nunca puede tumbar el webhook: si falla, queda en el console y la
 * respuesta ya decidida se mantiene.
 */
async function logWebhookEvent(entry: WebhookEntry): Promise<void> {
  try {
    await q(
      `INSERT INTO webhook_events (source, shop_domain, topic, external_id, status, error, payload)
       VALUES ('checkout_propio', NULL, 'purchase', $1, $2, $3, $4::jsonb)`,
      [
        entry.externalId,
        entry.status,
        entry.error ?? null,
        entry.payload === undefined ? null : JSON.stringify(entry.payload),
      ],
    );
  } catch (err) {
    console.error('[checkout-propio] no se pudo registrar el evento en webhook_events:', err);
  }
}

/**
 * Healthcheck, mismo patrón que shopify/route.ts: confirma que el endpoint
 * existe sin exponer secrets (no hay nada de env que mostrar, la key vive en
 * la fila de `funnels`, no en una env var propia de este endpoint).
 */
export async function GET() {
  return NextResponse.json({ ok: true });
}

export async function POST(req: NextRequest): Promise<NextResponse<RespuestaVentaCheckoutPropio>> {
  // 1. Bearer, mismo mecanismo que /api/ingest (app/api/ingest/route.ts
  // líneas 49-78). Sin header o mal formado → 401 sin fila: no hay ni funnel
  // para anotar en webhook_events, y guardar el intento acá permitiría a
  // cualquiera llenar la tabla mandando basura sin key.
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
  if (!match) {
    return json(401, { ok: false, error: 'unauthorized' });
  }
  const key = match[1].trim();

  const funnel = await getFunnelByIngestKey(key);
  if (!funnel) {
    return json(401, { ok: false, error: 'unauthorized' });
  }

  // Igual que /api/ingest: getFunnelByIngestKey ya matcheó por igualdad en
  // SQL (con cache de 60s), pero la comparación final es timing-safe contra
  // el hash recuperado — comparar por === sobre el string en claro sale
  // temprano en el primer byte distinto y filtra timing.
  const presented = Buffer.from(createHash('sha256').update(key).digest('hex'), 'utf8');
  const stored = await q1<{ hash: string }>(
    'SELECT ingest_key_hash AS hash FROM funnels WHERE id = $1',
    [funnel.id],
  );
  const storedHash = Buffer.from(stored?.hash ?? '', 'utf8');
  if (presented.length !== storedHash.length || !timingSafeEqual(presented, storedHash)) {
    return json(401, { ok: false, error: 'unauthorized' });
  }

  // Desde acá la auth es válida: pase lo que pase, se responde con 200/ok o
  // con un error que no es 401 (Shopify: "pase lo que pase, respuesta 200").
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    await logWebhookEvent({ externalId: null, status: 'error', error: 'invalid_json' });
    return json(400, { ok: false, error: 'invalid_json' });
  }

  let payload: PayloadVentaCheckoutPropio;
  try {
    payload = payloadSchema.parse(raw) as PayloadVentaCheckoutPropio;
  } catch (err) {
    if (!(err instanceof ZodError)) throw err;
    const first = err.issues[0];
    const detail = first ? `${first.path.join('.')}: ${first.message}` : 'payload inválido';
    // Regla 2 de la task: payload inválido → 400, se loguea con
    // status: 'error', error: 'payload_invalido'. Se guarda el raw para
    // diagnosticar (viene de un funnel ya autenticado, no es basura anónima).
    await logWebhookEvent({
      externalId: null,
      status: 'error',
      error: `payload_invalido: ${detail}`,
      payload: raw,
    });
    return json(400, { ok: false, error: 'payload_invalido' });
  }

  const externalId = `checkout_propio_${payload.cobroId}`;

  try {
    const { orderId, isNew, funnelId } = await upsertOrderCheckoutPropio(payload);

    if (!isNew) {
      // Reenvío del cron de salidas (mismo cobroId): D3, se dedupe por
      // UNIQUE(source, external_id) y NO se toca la fila existente.
      await logWebhookEvent({ externalId, status: 'duplicate' });
      return json(200, { ok: true, orderId: null, isNew: false });
    }

    // funnelId NULL no es un error (D10 del plan de orders, D2 de este
    // módulo): la venta se guardó igual, solo que sin atribución de funnel.
    await logWebhookEvent({
      externalId,
      status: funnelId === null ? 'unmatched_funnel' : 'ok',
    });
    return json(200, { ok: true, orderId: orderId as number, isNew: true, funnelId });
  } catch (err) {
    // Nunca un 5xx acá: un 500 solo hace que el cron de salidas reintente con
    // su backoff sin ganar nada, porque el error no es de red — el bug queda
    // en webhook_events, que es donde se mira (mismo criterio que Shopify).
    console.error('[checkout-propio] error procesando la venta:', err);
    await logWebhookEvent({
      externalId,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    return json(200, { ok: false, error: 'internal' });
  }
}
