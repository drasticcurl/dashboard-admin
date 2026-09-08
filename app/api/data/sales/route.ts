/**
 * GET /api/data/sales — los números de ventas de un funnel (task T07 §3).
 *
 * Mismos parámetros que /api/data/funnel (f, range o from+to) más `tier` y
 * `status`; `campaign` y `source` siguen existiendo como filtros. El valor
 * especial `f=__unattributed__` abre el cajón de ventas sin funnel: ahí no
 * hay funnel que defina la TZ del rango, así que se usa la del dashboard
 * (D19).
 *
 * Guard de auth y no-store como todos los /api/data/* (plan §9): un curl sin
 * cookie tiene que recibir 401, nunca datos.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getFunnelBySlug } from '@/lib/funnels';
import { guard } from '../../config/_lib';
import { today } from '@/lib/day';
import { ensureFreshAdSpend } from '@/lib/ads/live';
import { resolveFunnelRange } from '@/lib/queries/funnel';
import {
  getDashboardTimezone,
  getSalesData,
  UNATTRIBUTED_FUNNEL,
  type SalesStatus,
} from '@/lib/queries/sales';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, { status });
}

export async function GET(req: NextRequest) {
  // Un curl sin cookie tiene que recibir 401 (nunca datos) y quien no tiene la
  // pestaña Ventas un 403: es el guard que el middleware no cubre si alguien le
  // toca el matcher (plan §9), y ahora también hace cumplir el permiso (D5).
  const denied = await guard(req);
  if (denied) return denied;

  const sp = req.nextUrl.searchParams;
  const slug = sp.get('f') ?? '';

  let funnelId: number | null;
  let timezone: string;
  if (slug === UNATTRIBUTED_FUNNEL) {
    funnelId = null;
    timezone = getDashboardTimezone();
  } else {
    const funnel = slug ? await getFunnelBySlug(slug) : null;
    if (!funnel) {
      return json(404, { ok: false, error: 'unknown_funnel' });
    }
    funnelId = funnel.id;
    timezone = funnel.timezone;
  }

  let range: { from: string; to: string };
  try {
    range = await resolveFunnelRange(
      { preset: sp.get('range'), from: sp.get('from'), to: sp.get('to') },
      timezone,
    );
  } catch {
    return json(400, { ok: false, error: 'invalid_range' });
  }

  const rawStatus = sp.get('status');
  const status: SalesStatus =
    rawStatus === 'approved' || rawStatus === 'refunded' || rawStatus === 'chargeback'
      ? rawStatus
      : 'all';

  // El mismo refresco en vivo que hace el render del server: acá también, porque
  // cambiar de rango o de funnel en la pantalla NO recarga la página, y sin esto
  // el gasto solo se habría actualizado apretando F5.
  const hoy = await today(timezone);
  const adsFreshness = await ensureFreshAdSpend(range.to, hoy);

  const data = await getSalesData({
    funnelId,
    from: range.from,
    to: range.to,
    tier: sp.get('tier') ?? undefined,
    utmCampaign: sp.get('campaign') ?? undefined,
    utmSource: sp.get('source') ?? undefined,
    status,
  });

  return NextResponse.json({ ok: true, ...data, adsFreshness }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
