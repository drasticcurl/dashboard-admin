/**
 * /api/config/stages (T07 §4) — las etapas del embudo por funnel (017).
 *
 * GET  → las etapas del funnel, en orden de `stage_order`.
 * POST → reemplaza TODAS las etapas del funnel con la lista que viene. La UI
 *        edita la lista (agregar, renombrar, reordenar, borrar) y guarda una
 *        sola vez: es la única forma de mantener `stage_order` sin huecos sin
 *        armar un protocolo de PATCH por fila.
 *
 * Las validaciones viven en `_etapas.ts` y NO se delegan en los CHECK de la
 * 017: un 500 de Postgres no es un mensaje usable. Todo inválido sale como
 * 400 con `detail` en castellano.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { q, tx } from '@/lib/db';
import { funnelExists, guard, json, parseJson } from '../_lib';
import { validarEtapas, type EtapaGuardada } from './_etapas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const slugRe = /^[a-z0-9_]+$/;

const etapaSchema = z.object({
  stageOrder: z.number().int().min(0),
  label: z.string().min(1).max(80),
  startsAtSlug: z.string().min(1).max(60).regex(slugRe).nullable().optional(),
  milestone: z.string().nullable().optional(),
});

const bodySchema = z.object({
  funnelId: z.number().int().positive(),
  stages: z.array(etapaSchema).max(50),
});

export async function GET(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return denied;

  const rawFunnelId = req.nextUrl.searchParams.get('funnelId');
  const funnelId = Number(rawFunnelId);
  if (!Number.isInteger(funnelId) || funnelId <= 0) {
    return json(400, { ok: false, error: 'invalid_funnel_id' });
  }

  const stages = await q<EtapaGuardada>(
    `SELECT funnel_id AS "funnelId", stage_order AS "stageOrder", label,
            starts_at_slug AS "startsAtSlug", milestone
     FROM funnel_stages
     WHERE funnel_id = $1
     ORDER BY stage_order`,
    [funnelId],
  );
  return json(200, { ok: true, stages });
}

export async function POST(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return denied;

  const raw = await parseJson(req);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return json(400, {
      ok: false,
      error: 'invalid_payload',
      detail: `el payload no tiene la forma esperada (${issue?.path.join('.') ?? 'body'}): revisá funnelId y la lista de stages.`,
    });
  }
  const { funnelId, stages } = parsed.data;

  if (!(await funnelExists(funnelId))) {
    return json(400, { ok: false, error: 'unknown_funnel' });
  }

  // Regla 5 del §4: el slug tiene que existir en los pasos del funnel.
  const slugs = await q<{ slug: string }>(
    'SELECT slug FROM funnel_steps WHERE funnel_id = $1',
    [funnelId],
  );
  const invalida = validarEtapas(
    new Set(slugs.map((s) => s.slug)),
    stages.map((s) => ({
      stageOrder: s.stageOrder,
      label: s.label,
      startsAtSlug: s.startsAtSlug ?? null,
      milestone: s.milestone ?? null,
    })),
  );
  if (invalida) {
    return json(400, { ok: false, error: invalida.error, detail: invalida.detail });
  }

  try {
    await tx(async (c) => {
      await c.query('DELETE FROM funnel_stages WHERE funnel_id = $1', [funnelId]);
      for (const s of stages) {
        await c.query(
          `INSERT INTO funnel_stages (funnel_id, stage_order, label, starts_at_slug, milestone)
           VALUES ($1, $2, $3, $4, $5)`,
          [funnelId, s.stageOrder, s.label.trim(), s.startsAtSlug ?? null, s.milestone ?? null],
        );
      }
    });
  } catch (err) {
    if (err instanceof Error && (err as { code?: string }).code === '23505') {
      return json(409, {
        ok: false,
        error: 'conflicto',
        detail: 'otro guardado pisó estas etapas a mitad de camino: recargá y reintentá.',
      });
    }
    throw err;
  }

  const stagesGuardadas = await q<EtapaGuardada>(
    `SELECT funnel_id AS "funnelId", stage_order AS "stageOrder", label,
            starts_at_slug AS "startsAtSlug", milestone
     FROM funnel_stages
     WHERE funnel_id = $1
     ORDER BY stage_order`,
    [funnelId],
  );
  return json(200, { ok: true, stages: stagesGuardadas });
}
