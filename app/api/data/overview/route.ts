/**
 * GET /api/data/overview — el Resumen unificado de todos los funnels.
 *
 * A diferencia de /api/data/funnel y /api/data/sales, no recibe `f`: el
 * Resumen cruza todo, y el rango se resuelve con la TZ del dashboard (D19),
 * no con la de un funnel — no hay funnel que la defina.
 *
 * Guard de auth y no-store como todos los /api/data/* (plan §9): un curl sin
 * cookie tiene que recibir 401, nunca datos.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { today } from '@/lib/day';
import { ensureFreshAdSpend } from '@/lib/ads/live';
import { resolveFunnelRange } from '@/lib/queries/funnel';
import { getDashboardTimezone } from '@/lib/queries/sales';
import { getOverviewData } from '@/lib/queries/overview';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, { status });
}

export async function GET(req: NextRequest) {
  if (!isAuthenticated(req.cookies)) {
    return json(401, { ok: false, error: 'unauthorized' });
  }

  const sp = req.nextUrl.searchParams;
  const tz = getDashboardTimezone();
  let range: { from: string; to: string };
  try {
    range = await resolveFunnelRange(
      { preset: sp.get('range'), from: sp.get('from'), to: sp.get('to') },
      tz,
    );
  } catch {
    return json(400, { ok: false, error: 'invalid_range' });
  }

  // El mismo refresco en vivo que hace el render del server (resumen/page.tsx).
  // ESTE ROUTE NO LO TENÍA, y era el agujero: el Resumen refetchea por acá al
  // cambiar de rango y ahora también cada minuto por el polling, así que sin
  // esta línea el gasto se repintaba con el mismo valor viejo para siempre. Va
  // ANTES de getOverviewData porque `ensureFreshAdSpend` reconstruye el rollup
  // de daily_metrics, que es de donde lee esta pantalla; al revés, el número
  // fresco llegaría un pedido tarde.
  const hoy = await today(tz);
  const adsFreshness = await ensureFreshAdSpend(range.to, hoy);

  const data = await getOverviewData(range);

  return NextResponse.json({ ok: true, ...data, adsFreshness }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
