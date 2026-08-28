/**
 * /api/finanzas/saldos — POST.
 *
 * El endpoint que el usuario usa TODOS LOS DÍAS: recibe un día y los saldos de
 * todas sus cuentas de una sola vez.
 *
 * ES UNA SOLA LLAMADA CON TODAS LAS CUENTAS, y no una por cuenta, porque
 * `guardarSaldosDelDia` es una transacción (plan SALDO §4 regla 1): si la
 * tercera cuenta falla, no puede quedar un día a medio guardar mientras el
 * usuario ya cree que guardó. Con un endpoint por cuenta esa garantía es
 * imposible de dar desde el cliente.
 *
 * El signo NO se toca acá: el monto viaja siempre positivo y el signo lo pone el
 * `kind` de la cuenta al leer (D4). Este route no sabe ni le importa si una
 * cuenta es de deuda.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { guard, json } from '@/app/api/config/_lib';
import { SaldoInputError, guardarSaldosDelDia, patrimonioDe } from '@/lib/queries/saldo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const saldosSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'la fecha va en formato YYYY-MM-DD'),
  saldos: z
    .array(
      z.object({
        accountId: z.number().int().positive(),
        /**
         * `nonnegative()` y NO `positive()`: **un saldo de 0 es válido y
         * frecuente** (la cuenta está vacía), y el CHECK de la base es
         * `amount_eur >= 0`. Rechazar el cero acá haría que una cuenta vacía sea
         * imposible de cargar y, por D5, que ese día nunca pueda estar completo.
         *
         * `null` BORRA el saldo de esa cuenta ese día, y es distinto de 0: por D5
         * "no hay fila" es un día incompleto y "hay una fila en 0" es un
         * patrimonio de cero. Las dos cosas tienen que poder decirse.
         */
        amountEur: z
          .number()
          .finite()
          // El mensaje va en castellano porque VIAJA A LA PANTALLA: el helper
          // `api()` de FinanzasView muestra `detail` tal cual en el banner rojo,
          // así que el default de zod ("Number must be greater than or equal to
          // 0") se le mostraría al usuario en inglés. Y además dice qué hacer:
          // el saldo negativo es el caso de la cuenta en descubierto (P-02).
          .nonnegative(
            'un saldo no puede ser negativo: si la cuenta está en descubierto, cargala como una cuenta de tipo deuda',
          )
          .nullable(),
        note: z.string().max(500).nullable().optional(),
      }),
    )
    .min(1, 'no hay ningún saldo para guardar'),
});

export async function POST(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const parsed = saldosSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(400, {
      ok: false,
      error: 'invalid_payload',
      detail: parsed.error.issues[0]?.message,
    });
  }
  const d = parsed.data;

  try {
    const patrimonio = await guardarSaldosDelDia(d.day, d.saldos);
    // Se devuelve el PatrimonioDia completo, no un `{ok:true}` pelado: la UI
    // necesita saber si el día quedó completo y qué cuentas faltan para poder
    // decirlo sin pedir de nuevo. Guardar parcial NO es un error — lo que no
    // está permitido es que el total mienta, y por eso `totalEur` viene en null.
    return json(200, { ok: true, patrimonio });
  } catch (err) {
    // Un pedido mal armado (cuenta que no existe, cuenta no vigente ese día,
    // cuenta repetida, saldo negativo) es 400 con el motivo legible, no un 500
    // con el SQLSTATE crudo. El mensaje del saldo negativo explica la salida:
    // cargalo como una cuenta de tipo deuda.
    if (err instanceof SaldoInputError) {
      return json(400, { ok: false, error: 'invalid_payload', detail: err.message });
    }
    throw err;
  }
}

/** El patrimonio de un día puntual, para releer sin pasar por toda la pantalla. */
export async function GET(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const day = new URL(req.url).searchParams.get('day');
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return json(400, { ok: false, error: 'invalid_payload', detail: 'day inválido (YYYY-MM-DD)' });
  }

  return json(200, { ok: true, patrimonio: await patrimonioDe(day) });
}
