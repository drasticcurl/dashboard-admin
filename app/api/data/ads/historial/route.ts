/**
 * /api/data/ads/historial — la lista cronológica de `ad_actions` (T19).
 *
 *   GET /api/data/ads/historial
 *       ?rule=7&source=rule|manual|system
 *       &estado=confirmado|simulado|omitido|fallido|indeterminado|pendiente
 *       &objeto=1201...&limit=100&before=<id>
 *
 * El filtro es por `estado`, que es una columna con vocabulario cerrado por el
 * CHECK `ad_actions_estado_valido`: el parámetro se valida contra esa lista y no
 * hay que traducir nada. `source=system` trae los eventos de configuración.
 *
 * Paginación por cursor (`before=<id>`), no por offset: la tabla crece rápido
 * con un tick por minuto y un OFFSET grande se pone lento y además saltea filas.
 */

import type { NextRequest } from 'next/server';
import { q } from '@/lib/db';
import { guard, json } from '@/app/api/config/_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ESTADOS = ['confirmado', 'simulado', 'omitido', 'fallido', 'indeterminado', 'pendiente'] as const;
const SOURCES = ['rule', 'manual', 'system'] as const;

type Fila = {
  id: number;
  run_id: number | null;
  rule_id: number | null;
  rule_name: string | null;
  source: string;
  actor_hint: string | null;
  account_id: string;
  level: string;
  object_id: string;
  object_name: string | null;
  action: string;
  before_value: string | null;
  after_value: string | null;
  dry_run: boolean;
  ok: boolean;
  estado: string;
  skipped_reason: string | null;
  explicacion: string;
  metrics: Record<string, unknown>;
  error: string | null;
  created_at: Date;
};

export async function GET(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const sp = req.nextUrl.searchParams;
  const estado = sp.get('estado');
  const source = sp.get('source');
  const rule = sp.get('rule');
  const objeto = sp.get('objeto');
  const before = sp.get('before');
  const limitRaw = sp.get('limit');

  if (estado && !(ESTADOS as readonly string[]).includes(estado)) {
    return json(400, {
      ok: false,
      error: 'invalid_params',
      detail: `estado inválido: los válidos son ${ESTADOS.join(', ')}`,
    });
  }
  if (source && !(SOURCES as readonly string[]).includes(source)) {
    return json(400, { ok: false, error: 'invalid_params', detail: 'source inválido' });
  }

  const where: string[] = [];
  const params: unknown[] = [];
  const push = (v: unknown): number => {
    params.push(v);
    return params.length;
  };

  if (source) where.push(`source = $${push(source)}`);
  if (estado) where.push(`estado = $${push(estado)}`);
  if (rule) {
    const rid = Number(rule);
    if (!Number.isInteger(rid) || rid <= 0) {
      return json(400, { ok: false, error: 'invalid_params', detail: 'rule tiene que ser un id' });
    }
    where.push(`rule_id = $${push(rid)}`);
  }
  if (objeto) where.push(`object_id = $${push(objeto)}`);
  if (before) {
    const b = Number(before);
    if (!Number.isInteger(b) || b <= 0) {
      return json(400, { ok: false, error: 'invalid_params', detail: 'before tiene que ser un id' });
    }
    where.push(`id < $${push(b)}`);
  }

  const limit = Math.min(Math.max(Number(limitRaw) || 100, 1), 200);
  // Se pide uno de más para saber si hay página siguiente sin un segundo SELECT.
  const limite = push(limit + 1);

  const filas = await q<Fila>(
    `SELECT id, run_id, rule_id, rule_name, source, actor_hint, account_id, level,
            object_id, object_name, action, before_value, after_value, dry_run, ok,
            estado, skipped_reason, explicacion, metrics, error, created_at
       FROM ad_actions
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id DESC
      LIMIT $${limite}`,
    params,
  );

  const hayMas = filas.length > limit;
  const pagina = filas.slice(0, limit).map((f) => ({
    ...f,
    created_at: f.created_at instanceof Date ? f.created_at.toISOString() : String(f.created_at),
  }));

  return json(200, { ok: true, filas: pagina, hayMas, limit });
}
