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
  let range: { from: string; to: string };
  try {
    range = await resolveFunnelRange(
      { preset: sp.get('range'), from: sp.get('from'), to: sp.get('to') },
      getDashboardTimezone(),
    );
  } catch {
    return json(400, { ok: false, error: 'invalid_range' });
  }

  const data = await getOverviewData(range);

  return NextResponse.json({ ok: true, ...data }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
