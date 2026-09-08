/**
 * GET /api/data/leads — stats y export de leads de un funnel (task T09 §A).
 *
 * Los leads viven en Supabase (`clientes`) y se leen por la API REST de
 * PostgREST (lib/supabase-leads.ts, sin `@supabase/supabase-js`). El cruce
 * de compradores es contra `orders` de Postgres, la fuente de verdad nueva.
 *
 * Params:
 *   - f=slug (obligatorio; cada funnel tiene sus propias credenciales)
 *   - range=… | from=…&to=…   → la ventana de los stats (JSON)
 *   - format=csv              → el export para Shopify (default: json)
 *   - onlyNonBuyers=0|1       → solo CSV; default 1, igual que el panel viejo
 *   - since=YYYY-MM-DD        → solo CSV; leads creados desde ese día
 *
 * Sin credenciales de Supabase para ese funnel responde 200 con
 * `configured: false`: la página muestra "no configurado" y el resto del
 * panel sigue funcionando (task T09 §A). Nunca 500 por un funnel sin env.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getFunnelBySlug } from '@/lib/funnels';
import { guard } from '../../config/_lib';
import { resolveFunnelRange } from '@/lib/queries/funnel';
import {
  emptyLeadsData,
  getLeadsCsv,
  getLeadsData,
} from '@/lib/queries/leads';
import { getLeadsEnv } from '@/lib/supabase-leads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function json(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, { status });
}

export async function GET(req: NextRequest) {
  // Un curl sin cookie tiene que recibir 401 (nunca datos) y quien no tiene la
  // pestaña Leads un 403: es el guard que el middleware no cubre si alguien le
  // toca el matcher (plan §9), y ahora también hace cumplir el permiso (D5).
  const denied = await guard(req);
  if (denied) return denied;

  const sp = req.nextUrl.searchParams;
  const slug = sp.get('f') ?? '';
  const funnel = slug ? await getFunnelBySlug(slug) : null;
  if (!funnel) {
    return json(404, { ok: false, error: 'unknown_funnel' });
  }

  const format = sp.get('format') === 'csv' ? 'csv' : 'json';

  // ── Sin credenciales: "no configurado", nunca un error que tumbe la UI ──
  if (!getLeadsEnv(funnel.slug)) {
    return json(200, {
      ok: true,
      configured: false,
      funnel: { slug: funnel.slug, name: funnel.name },
      generatedAt: new Date().toISOString(),
    });
  }

  if (format === 'csv') {
    const sinceRaw = sp.get('since');
    if (sinceRaw && !DATE_RE.test(sinceRaw)) {
      return json(400, { ok: false, error: 'invalid_since_format' });
    }
    // Default true, igual que el panel viejo: `onlyNonBuyers` se apaga solo
    // con el valor literal 'false'.
    const onlyNonBuyers = sp.get('onlyNonBuyers') !== 'false';
    try {
      const { csv, count } = await getLeadsCsv(funnel, {
        since: sinceRaw,
        onlyNonBuyers,
      });
      const dateStr = new Date().toISOString().slice(0, 10);
      return new NextResponse(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="shopify-leads-${dateStr}.csv"`,
          'Cache-Control': 'no-store, max-age=0',
          'X-Lead-Count': String(count),
        },
      });
    } catch (err) {
      console.error('[data/leads] export falló:', err);
      return json(502, {
        ok: false,
        error: 'supabase_error',
        detail: err instanceof Error ? err.message : 'error desconocido',
      });
    }
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

  try {
    const stats = await getLeadsData(funnel, range);
    return NextResponse.json(
      { ok: true, funnel: { slug: funnel.slug, name: funnel.name }, ...stats },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    // D20: un fetch a Supabase caído no es un dato. Se responde 200 con
    // error visible y ceros, y la UI muestra el banner.
    console.error('[data/leads] stats fallaron:', err);
    const degraded = emptyLeadsData({
      supabaseError: err instanceof Error ? err.message : 'error desconocido',
    });
    return json(200, {
      ok: true,
      funnel: { slug: funnel.slug, name: funnel.name },
      ...degraded,
    });
  }
}
