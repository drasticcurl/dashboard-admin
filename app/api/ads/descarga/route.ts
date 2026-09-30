/**
 * /api/ads/descarga — baja el video (o la imagen) de UN anuncio como archivo.
 *
 *   GET ?adId=…&accountId=act_…&nombre=…  → el .mp4 / .jpg con
 *                                           Content-Disposition: attachment
 *
 * Pasa por el panel y no es un `<a download>` directo al CDN porque `download`
 * se ignora entre orígenes: el navegador abriría el video de fbcdn.net en otra
 * pestaña en lugar de guardarlo. Se hace streaming (no se bufferea el video
 * entero en memoria) y sólo desde hosts de Meta.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { guard, json } from '@/app/api/config/_lib';
import { MetaAdsError, fetchCreativo } from '@/lib/ads/meta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  adId: z.string().regex(/^\d{1,32}$/, 'adId inválido'),
  accountId: z.string().regex(/^(act_)?\d{1,32}$/, 'accountId inválido'),
  nombre: z.string().max(300).optional(),
});

const EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Nombre de archivo seguro a partir del nombre del anuncio. */
function nombreArchivo(nombre: string | undefined, adId: string, ext: string): string {
  const base = (nombre ?? '')
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 120);
  return `${base || `anuncio_${adId}`}.${ext}`;
}

function esHostMeta(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)(fbcdn\.net|facebook\.com)$/.test(u.hostname);
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const sp = req.nextUrl.searchParams;
  const parsed = querySchema.safeParse({
    adId: sp.get('adId') ?? undefined,
    accountId: sp.get('accountId') ?? undefined,
    nombre: sp.get('nombre') ?? undefined,
  });
  if (!parsed.success) {
    return json(400, { ok: false, error: 'invalid_query', detail: parsed.error.issues[0]?.message });
  }
  const { adId, nombre } = parsed.data;
  const accountId = parsed.data.accountId.startsWith('act_') ? parsed.data.accountId : `act_${parsed.data.accountId}`;

  let url: string | null;
  try {
    const c = await fetchCreativo(adId, accountId);
    // Un video sin `source` legible NO baja la miniatura en su lugar: bajar una
    // foto cuando se pidió el video es peor que decir que no se puede.
    url = c ? (c.tipo === 'video' ? c.videoUrl : c.imagenUrl) : null;
  } catch (e) {
    const detail = e instanceof MetaAdsError ? e.message : 'error pidiendo el creativo a Meta';
    return json(502, { ok: false, error: 'meta_error', detail });
  }
  if (!url || !esHostMeta(url)) {
    return json(404, { ok: false, error: 'sin_archivo', detail: 'Meta no devolvió un archivo descargable para este anuncio' });
  }

  const upstream = await fetch(url, { cache: 'no-store' }).catch(() => null);
  if (!upstream || !upstream.ok || !upstream.body) {
    return json(502, { ok: false, error: 'cdn_error', detail: `el CDN de Meta respondió ${upstream?.status ?? 'sin respuesta'}` });
  }

  const tipo = (upstream.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim();
  const archivo = nombreArchivo(nombre, adId, EXT[tipo] ?? (tipo.startsWith('video/') ? 'mp4' : 'jpg'));
  const headers = new Headers({
    'Content-Type': tipo,
    'Content-Disposition': `attachment; filename="${archivo}"; filename*=UTF-8''${encodeURIComponent(archivo)}`,
    'Cache-Control': 'no-store',
  });
  const largo = upstream.headers.get('content-length');
  if (largo) headers.set('Content-Length', largo);
  return new Response(upstream.body, { status: 200, headers });
}
