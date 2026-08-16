/**
 * /api/finanzas/movimientos — GET / POST / PATCH / DELETE.
 *
 * Expone lib/queries/finance.ts por HTTP (T02). La aritmética y el signo los
 * decide la capa de queries (plan §4 regla 1): acá se valida el payload y se
 * traduce el CHECK de la base a un mensaje entendible — mismo patrón que
 * validarCombinacion en /api/config/commissions.
 *
 * Finanzas es SIEMPRE global: ningún payload de estos routes lleva funnel_id
 * (D del plan).
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { guard, json } from '@/app/api/config/_lib';
import { q1 } from '@/lib/db';
import {
  createMovement,
  deleteMovement,
  listMovements,
  updateMovement,
  type FinanceCategory,
  type FinanceMovementKind,
} from '@/lib/queries/finance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const kindEnum = z.enum(['gasto', 'retiro', 'ajuste']);
const categoryEnum = z.enum(['sueldos', 'herramientas', 'alquiler', 'impuestos', 'otros']);

const createSchema = z.object({
  kind: kindEnum,
  // Obligatoria en gasto, ausente en los otros dos — igual que currency en
  // commissions/route.ts (obligatoria en fixed, ausente en percent).
  category: categoryEnum.nullable().optional(),
  // Para gasto/retiro: el valor ABSOLUTO que tipeó el usuario (positivo).
  // Para ajuste: el valor con el signo que puso el usuario en el toggle +/−.
  amountEur: z.number().finite(),
  note: z.string().min(1).max(200),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const patchSchema = z.object({
  id: z.number().int().positive(),
  category: categoryEnum.nullable().optional(),
  amountEur: z.number().finite().optional(),
  note: z.string().min(1).max(200).optional(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/**
 * La validación semántica de la combinación kind/category corre ANTES de
 * llamar a createMovement, igual que validarCombinacion en comisiones: sin
 * esto, un `kind: 'retiro', category: 'otros'` llegaría directo al CHECK de
 * la base y el usuario vería el error crudo de Postgres.
 *
 * Un gasto SIN categoría y un retiro/ajuste CON categoría se rechazan acá
 * (T02 §6): la categoría es exclusiva del gasto.
 */
function validarCategoria(
  kind: string,
  category: FinanceCategory | null | undefined,
):
  | { ok: true; category: FinanceCategory | null }
  | { ok: false; error: string } {
  if (kind === 'gasto') {
    if (!category) return { ok: false, error: 'un gasto necesita categoría' };
    return { ok: true, category };
  }
  if (category !== undefined && category !== null) {
    return { ok: false, error: 'un retiro o ajuste no lleva categoría' };
  }
  return { ok: true, category: null };
}

/**
 * El monto de un gasto/retiro SIEMPRE es el valor absoluto (positivo) que
 * tipeó el usuario; el signo lo aplica la capa de queries. Un ajuste puede
 * ir en cualquier dirección pero tiene que mover algo.
 */
function validarMonto(kind: FinanceMovementKind | undefined, amountEur: number | undefined):
  | { ok: true }
  | { ok: false; error: string } {
  if (amountEur === undefined) return { ok: true };
  if (kind === 'ajuste') {
    return amountEur === 0 ? { ok: false, error: 'un ajuste tiene que mover algo' } : { ok: true };
  }
  return amountEur <= 0
    ? { ok: false, error: 'el monto de un gasto/retiro va en positivo' }
    : { ok: true };
}

export async function GET(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const sp = new URL(req.url).searchParams;
  const from = sp.get('from') ?? undefined;
  const to = sp.get('to') ?? undefined;
  const rawKind = sp.get('kind') ?? undefined;
  let kind: FinanceMovementKind | undefined;
  if (rawKind !== undefined) {
    const parsed = kindEnum.safeParse(rawKind);
    if (!parsed.success) {
      return json(400, { ok: false, error: 'invalid_payload', detail: 'kind inválido' });
    }
    kind = parsed.data;
  }

  return json(200, { ok: true, movements: await listMovements({ from, to, kind }) });
}

export async function POST(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(400, { ok: false, error: 'invalid_payload', detail: parsed.error.issues[0]?.message });
  }
  const d = parsed.data;

  const cat = validarCategoria(d.kind, d.category);
  if (!cat.ok) return json(400, { ok: false, error: 'invalid_payload', detail: cat.error });
  const monto = validarMonto(d.kind, d.amountEur);
  if (!monto.ok) return json(400, { ok: false, error: 'invalid_payload', detail: monto.error });

  const movement = await createMovement({
    kind: d.kind,
    category: cat.category,
    amountEur: d.amountEur,
    note: d.note,
    day: d.day,
  });
  return json(200, { ok: true, movement });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(400, { ok: false, error: 'invalid_payload', detail: parsed.error.issues[0]?.message });
  }
  const d = parsed.data;

  // El kind no se puede cambiar (no está en el schema del PATCH): el monto
  // nuevo se valida contra el kind que el movimiento ya tiene.
  const monto = validarMonto(undefined, d.amountEur);
  if (!monto.ok) return json(400, { ok: false, error: 'invalid_payload', detail: monto.error });

  try {
    const movement = await updateMovement(d.id, {
      category: d.category,
      amountEur: d.amountEur,
      note: d.note,
      day: d.day,
    });
    return json(200, { ok: true, movement });
  } catch (err) {
    if (err instanceof Error && err.message === 'movimiento no encontrado') {
      return json(404, { ok: false, error: 'unknown_movement' });
    }
    throw err;
  }
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return json(400, { ok: false, error: 'invalid_payload', detail: 'id inválido' });
  }

  // 404 si no existe, para que la UI pueda distinguir "ya no está" de "se
  // borró ahora".
  const fila = await q1<{ id: number }>('SELECT id FROM finance_movements WHERE id = $1', [id]);
  if (!fila) return json(404, { ok: false, error: 'unknown_movement' });

  await deleteMovement(id);
  return json(200, { ok: true });
}