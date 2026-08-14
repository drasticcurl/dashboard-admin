/**
 * Reglas de comisión: GET / POST / PATCH / DELETE.
 *
 * Una regla es global (`funnelSlug` ausente) o de un funnel, y porcentual o
 * fija. A una venta se le aplican todas las activas que le corresponden.
 *
 * OJO: crear o editar una regla NO reescribe las ventas ya registradas, que
 * llevan su comisión congelada (migración 011/012). Para reexpresar un período
 * pasado hay que correr `npm run commissions:backfill`. Es a propósito: un
 * reporte de un mes cerrado no puede moverse porque hoy se tocó una pantalla.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { q, q1 } from '@/lib/db';
import { getFunnelBySlug } from '@/lib/funnels';
import { listCommissions } from '@/lib/commissions';
import { guard, json } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const base = {
  name: z.string().min(1).max(60),
  /** Ausente o null = global. */
  funnelSlug: z.string().min(2).max(40).nullable().optional(),
  kind: z.enum(['percent', 'fixed']),
  value: z.number().min(0).max(10_000_000),
  currency: z.string().length(3).regex(/^[A-Z]{3}$/).nullable().optional(),
  active: z.boolean().optional(),
};

const createSchema = z.object(base);
const patchSchema = z.object({
  id: z.number().int().positive(),
  name: base.name.optional(),
  funnelSlug: base.funnelSlug,
  kind: base.kind.optional(),
  value: base.value.optional(),
  currency: base.currency,
  active: base.active,
});

/**
 * Las mismas reglas que los CHECK de la tabla, verificadas antes de escribir
 * para poder devolver un mensaje entendible en vez de un error de Postgres.
 */
function validarCombinacion(kind: string, value: number, currency: string | null | undefined):
  | { ok: true; currency: string | null }
  | { ok: false; error: string } {
  if (kind === 'percent') {
    if (value > 100) return { ok: false, error: 'un porcentaje no puede pasar de 100' };
    // Se fuerza a null en lugar de rechazar: mandar moneda en una porcentual es
    // ruido del formulario, no un error del usuario.
    return { ok: true, currency: null };
  }
  if (!currency) return { ok: false, error: 'una comisión fija necesita moneda' };
  return { ok: true, currency };
}

export async function GET(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;
  return json(200, { ok: true, commissions: await listCommissions() });
}

export async function POST(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(400, { ok: false, error: 'invalid_payload', detail: parsed.error.issues[0]?.message });
  }
  const d = parsed.data;

  const comb = validarCombinacion(d.kind, d.value, d.currency);
  if (!comb.ok) return json(400, { ok: false, error: 'invalid_payload', detail: comb.error });

  let funnelId: number | null = null;
  if (d.funnelSlug) {
    const f = await getFunnelBySlug(d.funnelSlug);
    if (!f) return json(404, { ok: false, error: 'unknown_funnel' });
    funnelId = f.id;
  }

  const row = await q1<{ id: number }>(
    `INSERT INTO commissions (name, funnel_id, kind, value, currency, active)
     VALUES ($1, $2::smallint, $3, $4::numeric, $5, COALESCE($6, true))
     RETURNING id`,
    [d.name, funnelId, d.kind, d.value, comb.currency, d.active ?? null],
  );
  return json(200, { ok: true, id: row!.id });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(400, { ok: false, error: 'invalid_payload', detail: parsed.error.issues[0]?.message });
  }
  const d = parsed.data;

  const actual = await q1<{ kind: string; value: string; currency: string | null }>(
    'SELECT kind, value::text AS value, currency FROM commissions WHERE id = $1',
    [d.id],
  );
  if (!actual) return json(404, { ok: false, error: 'unknown_commission' });

  // La validación corre sobre el resultado de la edición, no sobre lo enviado:
  // cambiar solo `kind` de percent a fixed deja la regla sin moneda, y eso hay
  // que atajarlo acá y no con un error crudo del CHECK.
  const kind = d.kind ?? actual.kind;
  const value = d.value ?? Number(actual.value);
  const currency = d.currency !== undefined ? d.currency : actual.currency;
  const comb = validarCombinacion(kind, value, currency);
  if (!comb.ok) return json(400, { ok: false, error: 'invalid_payload', detail: comb.error });

  let funnelId: number | null | undefined;
  if (d.funnelSlug !== undefined) {
    if (d.funnelSlug === null) {
      funnelId = null; // pasa a global
    } else {
      const f = await getFunnelBySlug(d.funnelSlug);
      if (!f) return json(404, { ok: false, error: 'unknown_funnel' });
      funnelId = f.id;
    }
  }

  await q(
    `UPDATE commissions SET
       name      = COALESCE($2, name),
       funnel_id = CASE WHEN $3::boolean THEN $4::smallint ELSE funnel_id END,
       kind      = $5,
       value     = $6::numeric,
       currency  = $7,
       active    = COALESCE($8, active)
     WHERE id = $1`,
    [
      d.id,
      d.name ?? null,
      funnelId !== undefined,
      funnelId ?? null,
      kind,
      value,
      comb.currency,
      d.active ?? null,
    ],
  );
  return json(200, { ok: true });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return json(400, { ok: false, error: 'invalid_payload', detail: 'id inválido' });
  }
  // Borrar la regla NO toca las ventas que ya la tenían aplicada: su desglose
  // sigue nombrándola, que es justamente para lo que se congela.
  const res = await q<{ id: number }>('DELETE FROM commissions WHERE id = $1 RETURNING id', [id]);
  if (res.length === 0) return json(404, { ok: false, error: 'unknown_commission' });
  return json(200, { ok: true });
}
