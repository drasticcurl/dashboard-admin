/**
 * /api/ads/interruptores — los dos interruptores globales se cambian DESDE LA
 * WEB (D-A12b), no en una variable de entorno.
 *
 *   GET  → { ok, habilitado, forzarSombra, ttlSegundos, backoffUntil,
 *            backoffReason, backoffFailures, workerLastTick,
 *            maxDailyBudgetEur, maxDeltaPorTickEur }          ← sólo lectura
 *   POST → { habilitado?, forzarSombra?, ttlSegundos? }       ← parcial
 *
 * Reglas (task §5b):
 *   1. `guard(req)` primero: es el endpoint que le da permiso a un cron para
 *      gastar plata.
 *   2. zod con dos booleanos opcionales: mandar uno solo cambia solo ese.
 *   3. escribe en `settings` con `setSetting` (no se duplica). `value` es jsonb:
 *      los booleanos van sin comillas.
 *   4. apagar `forzarSombra` queda registrado en `ad_actions` con la forma
 *      concreta (source='system', level='system', account_id='*', action='config').
 *   5. el GET devuelve el estado del worker para que el banner avise si está caído.
 *   6. nunca devuelve otras filas de settings (una de ellas es el token de Telegram).
 *
 * `maxDailyBudgetEur` y `maxDeltaPorTickEur` se DEVUELVEN pero el POST no los
 * acepta (D-A9c): el endpoint que mueve presupuesto no puede levantar su propio
 * techo. Si el POST los recibe, se ignoran.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { q } from '@/lib/db';
import { getClientIp } from '@/lib/auth';
import { guard, json, setSetting } from '@/app/api/config/_lib';
import { leerInterruptores } from '@/app/(panel)/anuncios/reglas/_server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const postSchema = z.object({
  habilitado: z.boolean().optional(),
  forzarSombra: z.boolean().optional(),
  ttlSegundos: z.number().int().min(10).max(3600).optional(),
  // maxDailyBudgetEur / maxDeltaPorTickEur no están declarados: si vienen, zod
  // los descarta (no-strict). No pueden escribirse desde acá (D-A9c).
});

export async function GET(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const e = await leerInterruptores();
  return json(200, { ok: true, ...e });
}

export async function POST(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(400, {
      ok: false,
      error: 'invalid_payload',
      detail: parsed.error.issues[0]?.message,
    });
  }
  const d = parsed.data;

  const actual = await leerInterruptores();

  // El cambio del modo simulación es el evento más importante del módulo y
  // queda registrado con fecha y hora, tanto al apagar como al prender (§5b.4).
  if (d.forzarSombra !== undefined && d.forzarSombra !== actual.forzarSombra) {
    await setSetting('ads_rules_force_dry_run', d.forzarSombra);
    await registrarEventoConfig(req, actual.forzarSombra, d.forzarSombra);
  }

  if (d.habilitado !== undefined) {
    await setSetting('ads_rules_enabled', d.habilitado);
  }

  if (d.ttlSegundos !== undefined) {
    // P-A02: subir el TTL de insights "desde el panel sin desplegar" cuando
    // Meta aprieta con la cadencia. Rango validado en zod (10..3600).
    await setSetting('ads_insights_ttl_seconds', d.ttlSegundos);
  }

  const nuevo = await leerInterruptores();
  return json(200, { ok: true, ...nuevo });
}

/**
 * El renglón de auditoría del cambio de modo simulación. Los tres centinelas
 * (source='system', level='system', account_id='*') son obligatorios: el CHECK
 * `ad_actions_config_coherente` rechaza un evento 'config' que no venga con
 * level='system' y account_id='*'. `actor_hint` lleva el rastro técnico (IP,
 * user-agent), no una identidad (P-A12).
 */
async function registrarEventoConfig(req: NextRequest, antes: boolean, despues: boolean): Promise<void> {
  const ip = getClientIp(req.headers);
  const ua = (req.headers.get('user-agent') ?? '').slice(0, 80);
  const explicacion = despues
    ? 'Manual: se activó el modo simulación global. Todas las reglas vuelven a registrar lo que habrían hecho sin tocar Meta.'
    : 'Manual: se desactivó el modo simulación global. Desde ahora las reglas marcadas como ACTIVA cambian estados y presupuestos en Meta de verdad.';
  await q(
    `INSERT INTO ad_actions
       (source, level, account_id, object_id, action, ok, estado, explicacion,
        actor_hint, before_value, after_value)
     VALUES ('system', 'system', '*', 'ads_rules_force_dry_run', 'config',
             true, 'confirmado', $1, $2, $3, $4)`,
    [explicacion, `ip=${ip} ua=${ua}`, String(antes), String(despues)],
  );
}
