/**
 * /api/config/vistas-ads — el Endpoint_Vistas (task 16.4 de
 * gestion-campanas-anuncios): lee y escribe el Repo_Vistas sobre
 * `settings.ads_vistas` (migración 018 §5), con la forma versionada del patrón
 * de `ui_layout_*` de la migración 017.
 *
 *   GET            → { ok, repo: RepoVistas | null }
 *   POST { repo }  → reemplazo COMPLETO del repo, validado con `repoVistasSchema`
 *
 * - `guard(req)` en LOS DOS métodos, incluido el GET (R3 c2, c14, R17 c14): a
 *   diferencia de `ui-layout`, acá una lectura sin cookie no puede devolver
 *   ninguna Vista ni parte de su contenido.
 * - El POST es reemplazo completo y no parche por Vista: `porDefecto` y la
 *   unicidad de nombres son invariantes DEL CONJUNTO, no de una Vista. Si la
 *   validación falla, se rechaza la escritura entera y el Repo_Vistas queda
 *   exactamente como estaba (R3 c15).
 * - `null` (nunca se guardó) y `{"v":1,"vistas":[],"porDefecto":null}` son dos
 *   estados distintos y se devuelven tal cual (R3 c9).
 */

import { NextRequest } from 'next/server';
import { q1 } from '@/lib/db';
import { parseRepoVistas, repoVistasSchema } from '@/lib/ads/vistas';
import type { RepoVistas } from '@/lib/ads/vistas';
import { guard, json, parseJson, setSetting } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CLAVE = 'ads_vistas';

export async function GET(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return denied;

  const row = await q1<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [CLAVE]);
  const repo: RepoVistas | null =
    row === null || row.value === null ? null : parseRepoVistas(row.value);
  return json(200, { ok: true, repo });
}

export async function POST(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return denied;

  const raw = await parseJson(req);
  const parsed = repoVistasSchema.safeParse(raw);
  if (!parsed.success) {
    return json(400, {
      ok: false,
      error: 'invalid_payload',
      detail: parsed.error.issues[0]?.message,
    });
  }

  await setSetting(CLAVE, parsed.data);
  return json(200, { ok: true, repo: parsed.data });
}
