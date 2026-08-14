/**
 * /api/config/steps (task T09 §B.2) — el catálogo de pasos de un funnel.
 *
 * GET   → pasos del funnel + los que el ingest vio y el catálogo no conoce.
 * PATCH → edición de un paso. `step_index` y `slug` se pueden editar, pero
 *         mover el índice reinterpreta el histórico: sessions.max_step_index
 *         guarda números, no slugs. El aviso se muestra en la UI al lado del
 *         campo, no en un tooltip. Si el índice de destino está ocupado →
 *         409, y la salida es "Importar pasos" (reemplazo completo).
 * POST  → "Importar pasos": reemplaza el catálogo completo en una
 *         transacción — el camino práctico cuando el quiz agrega preguntas.
 *
 * El reemplazo del POST es DELETE + INSERT en tx y NO un UPSERT fila a fila
 * a propósito: los `funnel_steps` son el catálogo, no datos; el histórico
 * (sessions.max_step_index, events.step_index) no tiene FK a esta tabla, así
 * que borrar y reinsertar no puede dejar huérfanas. Un upsert dejaría pasos
 * viejos que el quiz ya no tiene, y el embudo los mostraría para siempre.
 *
 * `counts_in_funnel` NO es parte del catálogo: es un ajuste por paso que
 * lib/funnels.ts lee para el embudo. El INSERT no puede dejarlo en default
 * (bug de producción corregido): se lee el valor actual por slug antes del
 * DELETE y se reinyecta. Un paso nuevo nace en `true`.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { q, q1 } from '@/lib/db';
import { listSteps } from '@/lib/funnels';
import { funnelExists, getUnknownSteps, guard, json, parseJson, STEP_KINDS } from '../_lib';
import { reemplazarCatalogo } from './_reemplazo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const funnelIdParam = z.coerce.number().int().positive();
const slugRe = /^[a-z0-9_]+$/;

const patchSchema = z.object({
  funnelId: z.number().int().positive(),
  stepIndex: z.number().int().min(0),
  slug: z.string().min(1).max(60).regex(slugRe).optional(),
  label: z.string().min(1).max(120).optional(),
  kind: z.enum(STEP_KINDS).optional(),
  newStepIndex: z.number().int().min(0).optional(),
});

const importStepSchema = z.object({
  stepIndex: z.number().int().min(0),
  slug: z.string().min(1).max(60).regex(slugRe),
  label: z.string().min(1).max(120),
  kind: z.enum(STEP_KINDS),
});

const importSchema = z.object({
  funnelId: z.number().int().positive(),
  steps: z.array(importStepSchema).min(1).max(200),
});

export async function GET(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return denied;

  const rawFunnelId = req.nextUrl.searchParams.get('funnelId');
  const funnelId = funnelIdParam.safeParse(rawFunnelId);
  if (!funnelId.success) {
    return json(400, { ok: false, error: 'invalid_funnel_id' });
  }

  const [steps, unknownSteps] = await Promise.all([
    listSteps(funnelId.data),
    getUnknownSteps(funnelId.data),
  ]);
  return json(200, { ok: true, steps, unknownSteps });
}

export async function PATCH(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return denied;

  const raw = await parseJson(req);
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    return json(400, { ok: false, error: 'invalid_payload', detail: parsed.error.issues[0]?.message });
  }
  const { funnelId, stepIndex, slug, label, kind, newStepIndex } = parsed.data;

  if (!(await funnelExists(funnelId))) {
    return json(400, { ok: false, error: 'unknown_funnel' });
  }

  if (newStepIndex !== undefined && newStepIndex !== stepIndex) {
    const occupied = await q1<{ slug: string }>(
      `SELECT slug FROM funnel_steps WHERE funnel_id = $1 AND step_index = $2`,
      [funnelId, newStepIndex],
    );
    if (occupied) {
      return json(409, {
        ok: false,
        error: 'step_index_occupied',
        detail: `el paso ${newStepIndex} ya existe ('${occupied.slug}'). Moverlo a un índice ocupado reinterpretaría el histórico de las dos filas: usá "Importar pasos" para reordenar.`,
      });
    }
  }

  try {
    const res = await q(
      `UPDATE funnel_steps SET
         step_index = COALESCE($3, step_index),
         slug       = COALESCE($4, slug),
         label      = COALESCE($5, label),
         kind       = COALESCE($6, kind)
       WHERE funnel_id = $1 AND step_index = $2
       RETURNING step_index AS "stepIndex", slug, label, kind`,
      [funnelId, stepIndex, newStepIndex ?? null, slug ?? null, label ?? null, kind ?? null],
    );
    if (res.length === 0) {
      return json(404, { ok: false, error: 'unknown_step' });
    }
    return json(200, { ok: true, step: res[0] });
  } catch (err) {
    if (err instanceof Error && (err as { code?: string }).code === '23505') {
      return json(409, { ok: false, error: 'slug_exists', detail: 'ese slug ya existe en este funnel' });
    }
    throw err;
  }
}

export async function POST(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return denied;

  const raw = await parseJson(req);
  const parsed = importSchema.safeParse(raw);
  if (!parsed.success) {
    return json(400, { ok: false, error: 'invalid_payload', detail: parsed.error.issues[0]?.message });
  }
  const { funnelId, steps } = parsed.data;

  if (!(await funnelExists(funnelId))) {
    return json(400, { ok: false, error: 'unknown_funnel' });
  }

  // Duplicados dentro del payload: un índice o slug repetido rompería el
  // INSERT (UNIQUE de la tabla) a mitad de la tx y el mensaje sería confuso.
  const indexes = new Set(steps.map((s) => s.stepIndex));
  const slugs = new Set(steps.map((s) => s.slug));
  if (indexes.size !== steps.length || slugs.size !== steps.length) {
    return json(400, { ok: false, error: 'duplicated_steps' });
  }

  await reemplazarCatalogo(funnelId, steps);

  return json(200, { ok: true, count: steps.length });
}
