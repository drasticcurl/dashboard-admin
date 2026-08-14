/**
 * POST /api/config/funnels/ingest-key — regenera la ingest key de un funnel.
 *
 * Genera 32 bytes aleatorios en hex, guarda SOLO el hash (sha256) y devuelve
 * la key en claro una única vez: la UI la muestra con la advertencia de que
 * hay que copiarla al `.env.production` del funnel y redesplegarlo. La key
 * en claro no se guarda en ningún lado, no se vuelve a mostrar y no se
 * loguea — regenerarla invalida la anterior al instante.
 */

import { NextRequest } from 'next/server';
import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { q } from '@/lib/db';
import { guard, json, parseJson } from '../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ slug: z.string().min(1).max(40) });

export async function POST(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return denied;

  const raw = await parseJson(req);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return json(400, { ok: false, error: 'invalid_payload' });
  }
  const { slug } = parsed.data;

  const key = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(key).digest('hex');

  const res = await q(
    `UPDATE funnels SET ingest_key_hash = $2 WHERE slug = $1 RETURNING id, slug`,
    [slug, hash],
  );
  if (res.length === 0) {
    return json(404, { ok: false, error: 'unknown_funnel' });
  }
  return json(200, { ok: true, key, slug });
}
