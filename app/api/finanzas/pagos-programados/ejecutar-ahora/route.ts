/**
 * POST /api/finanzas/pagos-programados/ejecutar-ahora — el "botón manual"
 * del plan §4: llama a runScheduledPayments(await today(DASHBOARD_TZ)).
 *
 * Sin argumentos en el body: siempre ejecuta contra el día de hoy, nunca un
 * día arbitrario — evitar que alguien dispare la ejecución de un pago
 * "atrasado" de una fecha inventada. La idempotencia la garantiza la PK
 * (scheduled_payment_id, month) de finance_scheduled_payment_runs, así que
 * corriendo dos veces el mismo día el resultado es el mismo gasto una sola
 * vez.
 */

import type { NextRequest } from 'next/server';
import { guard, json } from '@/app/api/config/_lib';
import { today } from '@/lib/day';
import { runScheduledPayments } from '@/lib/queries/finance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const tz = process.env.DASHBOARD_TZ ?? 'America/Argentina/Buenos_Aires';
  const res = await runScheduledPayments(await today(tz));
  // Los fallidos viajan al cliente. Antes se descartaban y la UI mostraba
  // "No hay pagos atrasados para ejecutar" en verde aunque el gasto no se
  // hubiera generado.
  return json(200, { ok: true, ejecutados: res.ejecutados, fallidos: res.fallidos });
}