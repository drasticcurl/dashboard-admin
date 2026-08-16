/**
 * /api/finanzas/pagos-programados — GET / POST / PATCH / DELETE.
 *
 * Los pagos programados son la PLANTILLA (monto SIEMPRE positivo, D5): el
 * gasto que generan cada mes lo inserta runScheduledPayments con signo
 * negativo. Borrar un pago NO borra el historial de lo ya pagado (D9: los
 * movimientos quedan con scheduled_payment_id = NULL).
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { guard, json } from '@/app/api/config/_lib';
import { q1 } from '@/lib/db';
import {
  createScheduledPayment,
  deleteScheduledPayment,
  listScheduledPayments,
  updateScheduledPayment,
} from '@/lib/queries/finance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const categoryEnum = z.enum(['sueldos', 'herramientas', 'alquiler', 'impuestos', 'otros']);

const createSchema = z.object({
  name: z.string().min(1).max(80),
  category: categoryEnum, // siempre obligatoria: un pago programado siempre es un gasto
  amountEur: z.number().positive(), // SIEMPRE positivo: es la plantilla, no un movimiento (D5)
  dayOfMonth: z.number().int().min(1).max(28),
});

const patchSchema = z.object({
  id: z.number().int().positive(),
  name: createSchema.shape.name.optional(),
  category: createSchema.shape.category.optional(),
  amountEur: createSchema.shape.amountEur.optional(),
  dayOfMonth: createSchema.shape.dayOfMonth.optional(),
  active: z.boolean().optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;
  return json(200, { ok: true, scheduledPayments: await listScheduledPayments() });
}

export async function POST(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(400, { ok: false, error: 'invalid_payload', detail: parsed.error.issues[0]?.message });
  }
  const d = parsed.data;

  const scheduledPayment = await createScheduledPayment(d);
  return json(200, { ok: true, scheduledPayment });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(400, { ok: false, error: 'invalid_payload', detail: parsed.error.issues[0]?.message });
  }
  const d = parsed.data;

  try {
    const scheduledPayment = await updateScheduledPayment(d.id, {
      name: d.name,
      category: d.category,
      amountEur: d.amountEur,
      dayOfMonth: d.dayOfMonth,
      active: d.active,
    });
    return json(200, { ok: true, scheduledPayment });
  } catch (err) {
    if (err instanceof Error && err.message === 'pago programado no encontrado') {
      return json(404, { ok: false, error: 'unknown_scheduled_payment' });
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

  // Borrar el pago NO se bloquea por tener movimientos históricos (D9): se
  // desvinculan con SET NULL y la 404 acá solo distingue "no existe".
  const fila = await q1<{ id: number }>('SELECT id FROM finance_scheduled_payments WHERE id = $1', [id]);
  if (!fila) return json(404, { ok: false, error: 'unknown_scheduled_payment' });

  await deleteScheduledPayment(id);
  return json(200, { ok: true });
}