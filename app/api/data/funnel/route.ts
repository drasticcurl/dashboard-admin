/**
 * GET /api/data/funnel — los números del embudo de un funnel.
 *
 * Es uno de los pocos endpoints que saca datos de negocio hacia el browser
 * (el único lugar del proyecto, junto a /api/data/*): lleva guard de auth y
 * no-store, como todos los de su clase (plan §9).
 *
 * El cálculo vive en lib/queries/funnel.ts; acá solo se traducen los query
 * params a un FunnelFilters y se resuelve el rango en la TZ del funnel (D19).
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { getFunnelBySlug } from '@/lib/funnels';
import { getFunnelData, resolveFunnelRange } from '@/lib/queries/funnel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, { status });
}

export async function GET(req: NextRequest) {
  // Un curl sin cookie tiene que recibir 401 (nunca datos): es el guard que
  // el middleware no cubre si alguien le toca el matcher (plan §9).
  if (!isAuthenticated(req.cookies)) {
    return json(401, { ok: false, error: 'unauthorized' });
  }

  const sp = req.nextUrl.searchParams;
  const slug = sp.get('f') ?? '';

  const funnel = slug ? await getFunnelBySlug(slug) : null;
  if (!funnel) {
    return json(404, { ok: false, error: 'unknown_funnel' });
  }

  let range: { from: string; to: string };
  try {
    range = await resolveFunnelRange(
      { preset: sp.get('range'), from: sp.get('from'), to: sp.get('to') },
      funnel.timezone,
    );
  } catch {
    return json(400, { ok: false, error: 'invalid_range' });
  }

  const data = await getFunnelData({
    funnelId: funnel.id,
    from: range.from,
    to: range.to,
    base: sp.get('base') === 'start' ? 'start' : 'landing',
    variant: sp.get('variant') ?? undefined,
    utmCampaign: sp.get('campaign') ?? undefined,
    utmSource: sp.get('source') ?? undefined,
    country: sp.get('country') ?? undefined,
    // `exp` es la variante del A/B: recorta el embudo COMPLETO, no solo la card
    // del desglose. Sin validar contra funnels.experiments a propósito: un valor
    // que nadie sembró devuelve cero filas, que es la respuesta correcta y no un
    // 400. El valor va como parámetro de la query, nunca concatenado.
    experiment: sp.get('exp') ?? undefined,
  });

  return NextResponse.json({ ok: true, ...data }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
