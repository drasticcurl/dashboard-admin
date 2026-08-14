/**
 * GET /api/config/system (task T09 §B.4) — el estado de salud del sistema.
 *
 * Última sesión recibida por funnel, último rollup, última cotización,
 * cantidad de particiones de `events`, y las dos tablas de diagnóstico
 * (webhook_events e ingest_errors, últimas 50, filtrables por status y por
 * reason). Sin esto, diagnosticar una venta que no apareció obliga a
 * entrar por SSH — esta pantalla es la puerta de entrada.
 */

import { NextRequest } from 'next/server';
import { getSystemStatus, guard, json } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return denied;

  const sp = req.nextUrl.searchParams;
  const status = await getSystemStatus({
    wstatus: sp.get('wstatus'),
    reason: sp.get('reason'),
  });
  return json(200, { ok: true, ...status });
}
