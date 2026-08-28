/**
 * /api/finanzas/cuentas — GET / POST / PATCH / DELETE.
 *
 * Las cuentas donde vive (o falta) la plata. Configurables desde la UI, a
 * diferencia de las 5 categorías de gasto que son fijas en código: la lista de
 * cuentas cambia cuando el usuario abre una cuenta, que pasa de verdad (plan
 * SALDO D2).
 *
 * Dos operaciones de acá REESCRIBEN EL PATRIMONIO HISTÓRICO y las dos devuelven
 * el conteo de saldos afectados para que la UI pueda avisar antes:
 *   · DELETE — el ON DELETE CASCADE se lleva los saldos (D10).
 *   · PATCH que cambia `kind` — el signo de esa cuenta cambia en TODOS sus días.
 * La segunda es menos obvia que la primera y por eso está declarada igual.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { guard, json } from '@/app/api/config/_lib';
import {
  SaldoInputError,
  contarSaldosDe,
  createAccount,
  deleteAccount,
  listAccounts,
  updateAccount,
} from '@/lib/queries/saldo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const kindEnum = z.enum(['dinero', 'retenido', 'deuda']);
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'la fecha va en formato YYYY-MM-DD');

const createSchema = z.object({
  name: z.string().trim().min(1, 'la cuenta necesita un nombre').max(120),
  kind: kindEnum,
  openedOn: fecha.optional(),
  sortOrder: z.number().int().optional(),
});

const patchSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().trim().min(1).max(120).optional(),
  kind: kindEnum.optional(),
  openedOn: fecha.optional(),
  // `null` REABRE la cuenta y `undefined` no la toca: son dos intenciones
  // distintas y `.nullable().optional()` es lo que las distingue.
  closedOn: fecha.nullable().optional(),
  sortOrder: z.number().int().optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const incluirCerradas = new URL(req.url).searchParams.get('incluirCerradas') === '1';
  return json(200, { ok: true, accounts: await listAccounts({ incluirCerradas }) });
}

export async function POST(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(400, {
      ok: false,
      error: 'invalid_payload',
      detail: parsed.error.issues[0]?.message,
    });
  }

  try {
    return json(200, { ok: true, account: await createAccount(parsed.data) });
  } catch (err) {
    // El nombre duplicado sale 400, no 500: el índice único es funcional sobre
    // lower(btrim(name)), así que "Mercado Pago" y "  mercado pago " chocan. Es
    // el error que el usuario va a ver más seguido y el SQLSTATE 23505 no le
    // dice nada. La traducción está en lib/queries/saldo.ts.
    if (err instanceof SaldoInputError) {
      return json(400, { ok: false, error: 'invalid_payload', detail: err.message });
    }
    throw err;
  }
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(400, {
      ok: false,
      error: 'invalid_payload',
      detail: parsed.error.issues[0]?.message,
    });
  }
  const { id, ...cambios } = parsed.data;

  // Cambiar el `kind` de una cuenta con historial reescribe el patrimonio de
  // TODOS sus días: una cuenta de dinero que pasa a deuda invierte su signo
  // hacia atrás. Está permitido (el usuario puede haberse equivocado al
  // crearla) pero es igual de destructivo que un DELETE y mucho menos obvio,
  // así que el conteo viaja en la respuesta para que la UI pueda decirlo.
  const saldosAfectados = cambios.kind !== undefined ? await contarSaldosDe(id) : 0;

  try {
    const account = await updateAccount(id, cambios);
    return json(200, { ok: true, account, saldosAfectados });
  } catch (err) {
    if (err instanceof SaldoInputError) {
      // Incluye "esa cuenta no existe" y el CHECK de vigencia (un closedOn
      // anterior al openedOn), los dos traducidos en la capa de queries.
      const code = err.message.includes('no existe') ? 404 : 400;
      return json(code, { ok: false, error: 'invalid_payload', detail: err.message });
    }
    throw err;
  }
}

/**
 * DESTRUCTIVO. Se lleva los saldos en cascada y con eso el patrimonio histórico
 * cambia retroactivamente: días que estaban completos pasan a tener una cuenta
 * menos y su total baja (D10).
 *
 * El conteo se lee ANTES de borrar y se devuelve, porque es lo único que le
 * permite a la UI poner un número real en la confirmación ("borrar también borra
 * sus 47 saldos"). Un confirm() genérico para una acción que reescribe el
 * historial no alcanza. La acción que la UI ofrece de primera es CERRAR la
 * cuenta (PATCH con closedOn), que no destruye nada.
 */
export async function DELETE(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return json(400, { ok: false, error: 'invalid_payload', detail: 'id inválido' });
  }

  const cuentas = await listAccounts({ incluirCerradas: true });
  if (!cuentas.some((c) => c.id === id)) {
    return json(404, { ok: false, error: 'unknown_account' });
  }

  const saldosBorrados = await contarSaldosDe(id);
  await deleteAccount(id);
  return json(200, { ok: true, saldosBorrados });
}
