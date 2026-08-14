/**
 * Cuentas publicitarias: GET / POST (alta o edición) / DELETE.
 *
 * GET devuelve además `descubiertas`: las cuentas que el token puede leer y que
 * todavía no están dadas de alta. Así no hay que ir a buscar el `act_...` a
 * mano en Meta.
 *
 * Si el token no está configurado o no tiene permisos, GET NO falla: devuelve
 * `tokenError` con el mensaje de Meta. El panel tiene que poder abrirse y
 * explicar qué falta, no tirar un 500.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { q } from '@/lib/db';
import { listAccounts } from '@/lib/ads/meta';
import { guard, isValidTimezone, json } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  // Meta usa el prefijo 'act_'. Se acepta sin él y se normaliza, porque el id
  // que se ve en el administrador de anuncios viene pelado.
  accountId: z.string().min(3).max(64).regex(/^(act_)?\d+$/),
  name: z.string().max(120).nullable().optional(),
  currency: z.string().length(3).regex(/^[A-Z]{3}$/).nullable().optional(),
  funnelId: z.number().int().positive().nullable().optional(),
  // Zona horaria con la que Meta reporta los días de la cuenta. Editable
  // porque el token puede no tener permiso para leerla, y sin ella no hay
  // forma de saber si el gasto y las ventas están hablando del mismo día.
  timezone: z.string().min(1).max(64).nullable().optional(),
  active: z.boolean().optional(),
});

type Row = {
  accountId: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
  funnelId: number | null;
  funnelName: string | null;
  /** Zona de la tienda del funnel: si no coincide con la de la cuenta, el día no es el mismo. */
  funnelTimezone: string | null;
  active: boolean;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  spendRows: number;
};

export async function GET(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const cuentas = await q<Row>(
    `SELECT a.account_id AS "accountId", a.name, a.currency, a.timezone,
            a.funnel_id AS "funnelId", f.name AS "funnelName",
            f.timezone AS "funnelTimezone",
            a.active, a.last_sync_at AS "lastSyncAt", a.last_sync_error AS "lastSyncError",
            (SELECT count(*) FROM ad_spend s WHERE s.account_id = a.account_id)::int AS "spendRows"
     FROM ad_accounts a
     LEFT JOIN funnels f ON f.id = a.funnel_id
     ORDER BY a.account_id`,
  );

  // El descubrimiento es best-effort: si el token no está o no alcanza, se
  // informa el error y el resto de la pantalla sigue funcionando.
  let descubiertas: Array<{
    accountId: string;
    name: string | null;
    currency: string | null;
    timezone: string | null;
  }> = [];
  let tokenError: string | null = null;
  try {
    const yaEstan = new Set(cuentas.map((c) => c.accountId));
    descubiertas = (await listAccounts())
      .filter((a) => !yaEstan.has(a.accountId))
      .map((a) => ({
        accountId: a.accountId,
        name: a.name,
        currency: a.currency,
        timezone: a.timezone,
      }));
  } catch (e) {
    tokenError = e instanceof Error ? e.message : String(e);
  }

  return json(200, { ok: true, accounts: cuentas, descubiertas, tokenError });
}

export async function POST(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(400, { ok: false, error: 'invalid_payload', detail: parsed.error.issues[0]?.message });
  }
  const d = parsed.data;
  const accountId = d.accountId.startsWith('act_') ? d.accountId : `act_${d.accountId}`;
  if (d.timezone && !isValidTimezone(d.timezone)) {
    return json(400, { ok: false, error: 'invalid_timezone' });
  }

  await q(
    `INSERT INTO ad_accounts (account_id, platform, name, currency, timezone, funnel_id, active)
     VALUES ($1, 'meta', $2, $3, $6, $4::smallint, COALESCE($5, true))
     ON CONFLICT (account_id) DO UPDATE SET
       name      = COALESCE(EXCLUDED.name, ad_accounts.name),
       currency  = COALESCE(EXCLUDED.currency, ad_accounts.currency),
       timezone  = COALESCE(EXCLUDED.timezone, ad_accounts.timezone),
       funnel_id = EXCLUDED.funnel_id,
       active    = COALESCE($5, ad_accounts.active)`,
    [accountId, d.name ?? null, d.currency ?? null, d.funnelId ?? null, d.active ?? null, d.timezone ?? null],
  );

  // Reasignar la cuenta a otro funnel tiene que arrastrar el gasto ya guardado:
  // si no, el histórico queda imputado al funnel anterior y los dos totales
  // quedan mal sin ninguna señal.
  const upd = await q<{ id: string }>(
    `UPDATE ad_spend SET funnel_id = $2::smallint
     WHERE account_id = $1 AND funnel_id IS DISTINCT FROM $2::smallint
     RETURNING id`,
    [accountId, d.funnelId ?? null],
  );

  return json(200, { ok: true, accountId, reasignadas: upd.length });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const accountId = req.nextUrl.searchParams.get('accountId');
  if (!accountId) return json(400, { ok: false, error: 'missing_params' });

  // El gasto histórico NO se borra: es plata gastada y sigue siendo parte del
  // resultado de esos días. Solo se da de baja la cuenta para que no se
  // sincronice más.
  const res = await q<{ account_id: string }>(
    'DELETE FROM ad_accounts WHERE account_id = $1 RETURNING account_id',
    [accountId],
  );
  if (res.length === 0) return json(404, { ok: false, error: 'unknown_account' });
  return json(200, { ok: true });
}
