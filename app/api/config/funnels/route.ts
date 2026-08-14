/**
 * /api/config/funnels (task T09 §B.1) — el catálogo de funnels.
 *
 * GET   → lista completa (incluidos inactivos: en config se ven todos).
 * POST  → alta de un funnel nuevo: sin esto, cada funnel nuevo necesita un
 *         INSERT a mano, que es exactamente lo que este proyecto vino a
 *         evitar (task T09 §B.1).
 * PATCH → edición de name/timezone/sell_currency/color/variants/active.
 *
 * Las comisiones NO se editan acá: son una lista de reglas propia, global o por
 * funnel, en /api/config/commissions (migración 012).
 *         `slug` NO se edita: es la clave que usan los cart attributes y
 *         las ingest keys.
 *
 * La ingest key no viaja por este route: se regenera en
 * /api/config/funnels/ingest-key y se muestra una sola vez.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { q } from '@/lib/db';
import { getFunnelBySlug, listFunnels } from '@/lib/funnels';
import { rollupRange } from '@/scripts/rollup';
import { runRecompute } from '@/scripts/recompute-days';
import { guard, isValidTimezone, json, parseJson } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const SLUG_MAX = 40;
const VARIANT_RE = /^[a-z0-9][a-z0-9_-]*$/;

const createSchema = z.object({
  slug: z.string().min(2).max(SLUG_MAX).regex(SLUG_RE),
  name: z.string().min(1).max(80),
  timezone: z.string().min(1).max(64),
  sellCurrency: z.string().length(3).regex(/^[A-Z]{3}$/),
});

const patchSchema = z
  .object({
    slug: z.string().min(2).max(SLUG_MAX).regex(SLUG_RE),
    name: z.string().min(1).max(80).optional(),
    timezone: z.string().min(1).max(64).optional(),
    sellCurrency: z.string().length(3).regex(/^[A-Z]{3}$/).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    variants: z.array(z.string().min(1).max(40).regex(VARIANT_RE)).min(1).max(20).optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 1, {
    message: 'no hay campos para actualizar',
  });

export async function GET() {
  const funnels = await listFunnels({ includeInactive: true });
  return json(200, { ok: true, funnels });
}

export async function POST(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return denied;

  const raw = await parseJson(req);
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return json(400, { ok: false, error: 'invalid_payload', detail: parsed.error.issues[0]?.message });
  }
  const { slug, name, timezone, sellCurrency } = parsed.data;
  if (!isValidTimezone(timezone)) {
    return json(400, { ok: false, error: 'invalid_timezone' });
  }

  try {
    const rows = await q<{ id: number }>(
      // ingest_key_hash se seedea con el placeholder que no matchea ninguna
      // key real (misma convención que 009_seed_funnels.sql): el funnel nuevo
      // queda inert hasta que se le setea una key desde la UI.
      `INSERT INTO funnels (slug, name, timezone, sell_currency, ingest_key_hash)
       VALUES ($1, $2, $3, $4, 'PENDING_SET_INGEST_KEY_' || upper($1))
       RETURNING id`,
      [slug, name, timezone, sellCurrency],
    );
    return json(200, { ok: true, funnel: { id: rows[0]!.id, slug, name } });
  } catch (err) {
    if (err instanceof Error && (err as { code?: string }).code === '23505') {
      return json(409, { ok: false, error: 'slug_exists' });
    }
    throw err;
  }
}

export async function PATCH(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return denied;

  const raw = await parseJson(req);
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    return json(400, { ok: false, error: 'invalid_payload', detail: parsed.error.issues[0]?.message });
  }
  const { slug, ...fields } = parsed.data;
  if (fields.timezone !== undefined && !isValidTimezone(fields.timezone)) {
    return json(400, { ok: false, error: 'invalid_timezone' });
  }

  // Se lee la zona ANTES del UPDATE: si cambia, hay que recalcular los días
  // guardados, y después del UPDATE ya no se sabe cuál era la anterior.
  const antes = fields.timezone === undefined ? null : await getFunnelBySlug(slug);

  const res = await q(
    `UPDATE funnels SET
       name            = COALESCE($2, name),
       timezone        = COALESCE($3, timezone),
       sell_currency   = COALESCE($4, sell_currency),
       color           = COALESCE($5, color),
       variants        = COALESCE($6, variants),
       active          = COALESCE($7, active)
     WHERE slug = $1
     RETURNING id, slug`,
    [
      slug,
      fields.name ?? null,
      fields.timezone ?? null,
      fields.sellCurrency ?? null,
      fields.color ?? null,
      fields.variants ?? null,
      fields.active ?? null,
    ],
  );
  if (res.length === 0) {
    return json(404, { ok: false, error: 'unknown_funnel' });
  }

  // Cambiar la zona horaria mueve el corte del día: `orders.day`,
  // `sessions.day` y `events.day` son columnas guardadas y se quedaron con el
  // corte anterior. Se recalculan acá, no en un script aparte, porque un panel
  // que dice "zona guardada" y sigue mostrando los días viejos es exactamente
  // el bug que esto viene a cerrar. El día es una función pura de (timestamp,
  // zona): recalcularlo no reescribe ninguna decisión del negocio, a diferencia
  // de una comisión.
  //
  // El rollup se reconstruye solo del rango afectado: el Resumen lee de
  // daily_metrics y sin esto seguiría agrupado por los días viejos.
  let diasRecalculados: { filas: number; from: string | null; to: string | null } | null = null;
  if (antes && fields.timezone && antes.timezone !== fields.timezone) {
    const r = await runRecompute({ slug, dryRun: false });
    diasRecalculados = { filas: r.totalMovidas, from: r.minDay, to: r.maxDay };
    if (r.minDay && r.maxDay) await rollupRange({ from: r.minDay, to: r.maxDay });
  }

  return json(200, { ok: true, funnel: res[0], diasRecalculados });
}
