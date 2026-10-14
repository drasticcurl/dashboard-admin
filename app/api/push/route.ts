/**
 * /api/push — suscripciones a los avisos del profit (PWA).
 *
 *  · GET    → la clave pública VAPID (el navegador la necesita para suscribirse)
 *             y si los avisos están configurados en esta instancia.
 *  · POST   → guarda la suscripción del navegador (UPSERT por endpoint: el mismo
 *             celular reactivando no duplica avisos).
 *  · DELETE → la borra (el botón «Desactivar»).
 *
 * El guard es el de siempre (`guardSeccion`, mapeado a 'resumen' en MAPA_API).
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { guardSeccion } from '@/lib/permisos';
import { json } from '@/app/api/config/_lib';
import { q } from '@/lib/db';
import { leerVapid } from '@/lib/push/enviar';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const suscripcionSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(500),
    auth: z.string().min(1).max(500),
  }),
});

const borrarSchema = z.object({ endpoint: z.string().url().max(2000) });

export async function GET(req: NextRequest) {
  const g = await guardSeccion(req);
  if ('respuesta' in g) return g.respuesta;
  const vapid = leerVapid();
  return json(200, { ok: true, configurado: Boolean(vapid), publicKey: vapid?.publicKey ?? null });
}

export async function POST(req: NextRequest) {
  const g = await guardSeccion(req);
  if ('respuesta' in g) return g.respuesta;
  // El fallback de DASHBOARD_PASSWORD (usuarioId 0) no existe en `usuarios` y
  // rompería el FK.
  if (g.sesion.esFallback) return json(400, { ok: false, error: 'sin_usuario' });

  const parsed = suscripcionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, { ok: false, error: 'suscripcion_invalida' });
  const { endpoint, keys } = parsed.data;

  await q(
    `INSERT INTO push_suscripciones (usuario_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE
       SET usuario_id = EXCLUDED.usuario_id,
           p256dh     = EXCLUDED.p256dh,
           auth       = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent`,
    [g.sesion.usuarioId, endpoint, keys.p256dh, keys.auth, req.headers.get('user-agent')?.slice(0, 300) ?? null],
  );
  return json(200, { ok: true });
}

export async function DELETE(req: NextRequest) {
  const g = await guardSeccion(req);
  if ('respuesta' in g) return g.respuesta;
  const parsed = borrarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json(400, { ok: false, error: 'endpoint_invalido' });
  await q('DELETE FROM push_suscripciones WHERE endpoint = $1 AND usuario_id = $2', [
    parsed.data.endpoint,
    g.sesion.usuarioId,
  ]);
  return json(200, { ok: true });
}
