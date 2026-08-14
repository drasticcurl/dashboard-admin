import { q1 } from '../db';
import { cleanUtmValue, DIRECT_LABEL } from '../ingest/schema';
import type { ShopifyNoteAttribute, ShopifyOrder } from './types';

/**
 * Atribución de una venta, en el mismo orden de confianza que el webhook de
 * producción (testfunnel/app/api/shopify-webhook/route.ts):
 *
 *   1. note_attributes de la orden (lo escribe buildCheckoutAttribution del
 *      funnel: canal confiable).
 *   2. query string de landing_site (órdenes que no pasaron por nuestro
 *      checkout).
 *   3. inferUtmSource: sin utm_source pero con fbclid → 'facebook'.
 *   4. herencia por email: la compra previa del mismo email que sí tenga
 *      atribución (así un upsell abierto desde el mail queda atribuido al
 *      mismo canal que el front, y no figura como tráfico directo).
 *
 * La normalización de valores usa la MISMA función que el ingest
 * (lib/ingest/schema.ts → testfunnel/lib/utm.ts:cleanUtmValue): si el
 * dashboard normalizara distinto en los dos caminos, la campaña de una
 * sesión y la de su venta no matchearían y la atribución se parte en dos
 * mitades que no se cruzan.
 */

export type OrderUtms = {
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
};

export type OrderAttribution = {
  utms: OrderUtms;
  fbclid: string | null;
  /** sid/vid solo si traen forma de uuid: un valor basura no entra a la base. */
  sid: string | null;
  vid: string | null;
  /** el cart attribute `funnel`: slug a resolver contra `funnels` (D10 paso 1). */
  funnel: string | null;
};

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Valor de un cart attribute por nombre (case-insensitive). */
export function noteAttr(order: ShopifyOrder, name: string): string | undefined {
  const v = order.note_attributes?.find((a) => a?.name?.toLowerCase() === name)?.value;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asUuid(v: string | undefined): string | null {
  return v && UUID_RE.test(v) ? v.toLowerCase() : null;
}

/** Email del comprador, normalizado igual que en el webhook de producción. */
export function buyerEmail(order: ShopifyOrder): string {
  return (order.email || order.contact_email || order.customer?.email || '')
    .trim()
    .toLowerCase();
}

function pickUtms(params: URLSearchParams): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const k of UTM_KEYS) {
    const v = params.get(k);
    if (v) out[k] = v;
  }
  // fbclid también viaja en el link de checkout: se captura para poder inferir
  // source="facebook" cuando el anuncio NO trae utm_source (caso típico: solo
  // se taggeó utm_campaign → el source caía en "(directo)").
  const fbclid = params.get('fbclid');
  if (fbclid) out.fbclid = fbclid;
  return Object.keys(out).length ? out : undefined;
}

/** UTMs del landing_site de la orden. Suele venir como "/cart/123:1?utm_source=...". */
export function parseUtmsFromLandingSite(
  landingSite?: string,
): Record<string, string> | undefined {
  if (!landingSite) return undefined;
  const qIndex = landingSite.indexOf('?');
  if (qIndex === -1) return undefined;
  try {
    return pickUtms(new URLSearchParams(landingSite.slice(qIndex + 1)));
  } catch {
    return undefined;
  }
}

/**
 * UTMs pasados como cart/note attributes (name = "utm_*" o "fbclid"). Las
 * claves que el funnel deja para Meta CAPI (fbc, fbp, src_host) NO se usan
 * acá pero no molestan: se ignoran en silencio.
 */
export function parseUtmsFromNoteAttributes(
  attrs?: ShopifyNoteAttribute[],
): Record<string, string> | undefined {
  if (!attrs?.length) return undefined;
  const out: Record<string, string> = {};
  for (const a of attrs) {
    const name = a?.name?.toLowerCase();
    if (!name || typeof a.value !== 'string' || a.value.length === 0) continue;
    if (name.startsWith('utm_') || name === 'fbclid') {
      out[name] = a.value;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** UTMs de la orden: note_attributes (más confiable) con fallback a landing_site. */
export function orderUtms(order: ShopifyOrder): Record<string, string> | undefined {
  return (
    parseUtmsFromNoteAttributes(order.note_attributes) ??
    parseUtmsFromLandingSite(order.landing_site)
  );
}

/**
 * Réplica exacta de testfunnel/lib/utm.ts:inferUtmSource (no una reescritura
 * de memoria: si el funnel y el dashboard infirieran distinto, la misma venta
 * se atribuiría a fuentes distintas en cada lado).
 */
export function inferUtmSource(utms?: Record<string, string> | null): string {
  const src = cleanUtmValue(utms?.utm_source);
  if (src) return src;
  if (cleanUtmValue(utms?.fbclid)) return 'facebook';
  return '';
}

/**
 * Atribución FINAL de la orden, normalizada y lista para guardar. Vacío →
 * '(directo)' en las 5 utm_* (el centinela con el que matchean los upserts);
 * fbclid vacío → NULL (es un token opaco, la columna es nullable y no tiene
 * centinela — misma regla que P-08 del ingest).
 */
export function orderAttribution(order: ShopifyOrder): OrderAttribution {
  const raw = orderUtms(order) ?? {};
  return {
    utms: {
      utm_source: inferUtmSource(raw) || DIRECT_LABEL,
      utm_medium: cleanUtmValue(raw.utm_medium) || DIRECT_LABEL,
      utm_campaign: cleanUtmValue(raw.utm_campaign) || DIRECT_LABEL,
      utm_content: cleanUtmValue(raw.utm_content) || DIRECT_LABEL,
      utm_term: cleanUtmValue(raw.utm_term) || DIRECT_LABEL,
    },
    fbclid: cleanUtmValue(raw.fbclid) || null,
    sid: asUuid(noteAttr(order, 'sid')),
    vid: asUuid(noteAttr(order, 'vid')),
    funnel: noteAttr(order, 'funnel') ?? null,
  };
}

/**
 * Herencia por email (paso 4): los UTMs de la compra anterior más reciente
 * del mismo email que sí tenga atribución. Es lo que atribuye un upsell
 * abierto desde el mail en otro dispositivo.
 */
export async function inheritUtmsByEmail(email: string): Promise<OrderUtms | null> {
  return q1<OrderUtms>(
    `SELECT utm_source, utm_medium, utm_campaign, utm_content, utm_term
     FROM orders
     WHERE email = $1 AND utm_source <> '(directo)'
     ORDER BY purchased_at DESC LIMIT 1`,
    [email],
  );
}

/**
 * Atribución completa: normaliza lo que trae la orden y, si quedó sin
 * utm_source, la hereda de la compra previa del mismo email. La herencia
 * reemplaza las 5 columnas (misma semántica que el webhook de producción),
 * así el upsell queda atribuido al mismo canal que el front.
 */
export async function resolveAttribution(order: ShopifyOrder): Promise<OrderAttribution> {
  const base = orderAttribution(order);
  if (base.utms.utm_source !== DIRECT_LABEL) return base;

  const email = buyerEmail(order);
  if (!email) return base;

  const prior = await inheritUtmsByEmail(email);
  if (!prior) return base;

  return { ...base, utms: prior };
}
