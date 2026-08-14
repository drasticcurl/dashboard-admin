import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verificación HMAC del webhook de Shopify, copiada del archivo que ya lo
 * resolvió en producción (testfunnel/app/api/shopify-webhook/route.ts).
 *
 * La firma se calcula sobre los bytes EXACTOS del body crudo: si se parsea y
 * re-serializa, el HMAC no coincide nunca. Es el error clásico de este
 * endpoint y por eso verifySignature recibe el texto tal como llegó.
 */

export type HmacVerdict = 'valid' | 'invalid' | 'unconfigured';

/**
 * Lista de secrets configurados (multi-tienda, separados por coma). Es la
 * MISMA variable que ya está en el env de cada funnel: las suscripciones que
 * se crean desde el admin de la tienda firman con el secret de la tienda
 * (plan D8), así que el dashboard acepta con cualquiera de la lista.
 */
export function getWebhookSecrets(): string[] {
  const raw = process.env.SHOPIFY_WEBHOOK_SECRETS ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Núcleo puro (testeable sin env): devuelve 'valid' si alguna de las secrets
 * coincide, 'invalid' si hay secrets configuradas pero ninguna coincide, y
 * 'unconfigured' si no hay ninguna.
 */
export function verifySignatureWithSecrets(
  rawBody: string,
  hmacHeader: string | null,
  secrets: string[],
): HmacVerdict {
  if (secrets.length === 0) return 'unconfigured';
  if (!hmacHeader) return 'invalid';

  const headerBuf = Buffer.from(hmacHeader, 'utf8');

  for (const secret of secrets) {
    const digest = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
    const digestBuf = Buffer.from(digest, 'utf8');
    // timingSafeEqual tira si las longitudes difieren: el chequeo de longitud
    // previo no es optimización, es lo que hace que la comparación sea segura.
    if (headerBuf.length === digestBuf.length && timingSafeEqual(headerBuf, digestBuf)) {
      return 'valid';
    }
  }
  return 'invalid';
}

/**
 * Verdict sobre el env real. 'unconfigured' ≠ 'invalid' a propósito: el
 * endpoint los trata distinto (plan §5: sin secrets configuradas se RECHAZA,
 * no hay modo permisivo como en los funnels; la razón se loguea aparte).
 */
export function verifySignature(rawBody: string, hmacHeader: string | null): HmacVerdict {
  return verifySignatureWithSecrets(rawBody, hmacHeader, getWebhookSecrets());
}
