/**
 * /api/data/ads/historial — la lista cronológica de `ad_actions` (T19), extendida
 * por gestion-campanas-anuncios (task 18.6): filtro por acción sobre el
 * Vocabulario_Acciones completo (R15 c7) y el detalle de descendientes de una
 * duplicación (R15 c6, D-08: una fila por Copia, con los creados adentro).
 *
 *   GET /api/data/ads/historial
 *       ?rule=7&source=rule|manual|system&accion=pause|...|schedule
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
import { ROTULO_ACCION } from '@/lib/ads/previsualizacion';

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

/** El Vocabulario_Acciones completo (migración 018 §1). La validación es contra
 *  ROTULO_ACCION: un valor sin rótulo en castellano no compila (R15 c8). */
const ACCIONES = Object.keys(ROTULO_ACCION);

export async function GET(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const sp = req.nextUrl.searchParams;
  const estado = sp.get('estado');
  const source = sp.get('source');
  const rule = sp.get('rule');
  const objeto = sp.get('objeto');
  const accion = sp.get('accion');
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
  if (accion && !ACCIONES.includes(accion)) {
    return json(400, {
      ok: false,
      error: 'invalid_params',
      detail: `acción inválida: las válidas son ${ACCIONES.join(', ')}`,
    });
  }

  const where: string[] = [];
  const params: unknown[] = [];
  const push = (v: unknown): number => {
    params.push(v);
    return params.length;
  };

  if (source) where.push(`source = $${push(source)}`);
  if (estado) where.push(`estado = $${push(estado)}`);
  if (accion) where.push(`action = $${push(accion)}`);
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

  // ── Detalle de descendientes de una duplicación (R15 c6, D-08) ────────────
  // Una fila por Copia: los objetos creados viven en metrics.creados y acá se
  // cruzan contra la jerarquía local para traer su tipo y su nombre. Queda
  // vacío cuando Meta no confirmó ninguno.
  const duplicadas = pagina.filter((f) => f.action === 'duplicate');
  if (duplicadas.length > 0) {
    const creados = new Set<string>();
    for (const f of duplicadas) {
      const ids = Array.isArray(f.metrics.creados) ? (f.metrics.creados as unknown[]) : [];
      for (const id of ids) {
        if (typeof id === 'string') creados.add(id);
      }
    }
    const porId = new Map<string, { nivel: 'campaign' | 'adset' | 'ad'; nombre: string | null }>();
    if (creados.size > 0) {
      const lista = Array.from(creados);
      const jerarquia = await q<{ id: string; nivel: string; nombre: string | null }>(
        `SELECT campaign_id AS id, 'campaign' AS nivel, name AS nombre FROM ad_campaigns WHERE campaign_id = ANY($1::text[])
         UNION ALL
         SELECT adset_id AS id, 'adset' AS nivel, name AS nombre FROM ad_sets WHERE adset_id = ANY($1::text[])
         UNION ALL
         SELECT ad_id AS id, 'ad' AS nivel, name AS nombre FROM ads WHERE ad_id = ANY($1::text[])`,
        [lista],
      );
      for (const j of jerarquia) {
        porId.set(j.id, { nivel: j.nivel as 'campaign' | 'adset' | 'ad', nombre: j.nombre });
      }
    }
    const descendientesPorFila = new Map<number, unknown[]>();
    for (const f of duplicadas) {
      const ids = Array.isArray(f.metrics.creados) ? (f.metrics.creados as unknown[]) : [];
      descendientesPorFila.set(
        f.id,
        ids.map((id) => ({
          id: String(id),
          nivel: porId.get(String(id))?.nivel ?? 'desconocido',
          nombre: porId.get(String(id))?.nombre ?? null,
        })),
      );
    }
    for (const f of pagina) {
      if (descendientesPorFila.has(f.id)) {
        Object.assign(f, { descendientes: descendientesPorFila.get(f.id) });
      }
    }
  }

  return json(200, { ok: true, filas: pagina, hayMas, limit });
}
