/**
 * /api/ads/preview — el preview oficial de Meta de UN anuncio, para el popup
 * «Ver anuncio» del menú de la fila.
 *
 *   GET ?adId=…&accountId=act_…&formato=CREATIVO
 *     → { ok: true, creativo }       video/imagen + copy armados por el panel
 *                                    (sin el iframe de Meta ni su cartel de cookies)
 *   GET ?adId=120249316436200617&formato=MOBILE_FEED_STANDARD
 *     → { ok: true, src }            el iframe de Meta a mostrar
 *     → { ok: false, error, detail } Meta no lo pudo armar (formato no apto,
 *                                    anuncio borrado, token sin permiso)
 *
 * Es sólo lectura y no pasa por el Endpoint_Acciones. No se cachea: el `src`
 * lleva un token de Meta que vence, y el popup se abre a mano, de a uno.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { guard, json } from '@/app/api/config/_lib';
import {
  FORMATOS_PREVIEW,
  MetaAdsError,
  fetchCreativo,
  fetchPreview,
  type FormatoPreview,
} from '@/lib/ads/meta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  adId: z.string().regex(/^\d{1,32}$/, 'adId inválido'),
  accountId: z.string().regex(/^(act_)?\d{1,32}$/, 'accountId inválido').optional(),
  formato: z
    .enum(['CREATIVO', ...FORMATOS_PREVIEW] as unknown as ['CREATIVO', ...FormatoPreview[]])
    .default('MOBILE_FEED_STANDARD'),
});

export async function GET(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const sp = req.nextUrl.searchParams;
  const parsed = querySchema.safeParse({
    adId: sp.get('adId') ?? undefined,
    accountId: sp.get('accountId') ?? undefined,
    formato: sp.get('formato') ?? undefined,
  });
  if (!parsed.success) {
    return json(400, { ok: false, error: 'invalid_query', detail: parsed.error.issues[0]?.message });
  }

  const { adId, formato } = parsed.data;
  try {
    if (formato === 'CREATIVO') {
      const raw = parsed.data.accountId;
      if (!raw) return json(400, { ok: false, error: 'invalid_query', detail: 'falta accountId' });
      const accountId = raw.startsWith('act_') ? raw : `act_${raw}`;
      const creativo = await fetchCreativo(adId, accountId);
      if (!creativo) {
        return json(200, { ok: false, error: 'sin_creativo', detail: 'Meta no devolvió el creativo de este anuncio' });
      }
      return json(200, { ok: true, creativo });
    }
    const src = await fetchPreview(adId, formato);
    if (!src) {
      return json(200, { ok: false, error: 'sin_preview', detail: 'Meta no devolvió preview para este formato' });
    }
    return json(200, { ok: true, src });
  } catch (e) {
    // El mensaje de MetaAdsError nunca lleva la URL ni el token (ver meta.ts),
    // así que se puede mostrar tal cual: suele ser el motivo real («el creativo
    // no es apto para esta ubicación»).
    const detail = e instanceof MetaAdsError ? e.message : 'error pidiendo el preview a Meta';
    return json(502, { ok: false, error: 'meta_error', detail });
  }
}
