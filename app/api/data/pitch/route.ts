/**
 * GET /api/data/pitch — los números del A/B del pitch del upsell.
 *
 * Es uno de los endpoints que saca datos de negocio hacia el browser, así que
 * lleva guard de auth y `no-store`, como todos los de `/api/data/*`.
 *
 * El cálculo vive en `lib/queries/pitch.ts`; acá solo se traducen los query
 * params y se resuelve el rango en la TZ del funnel.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { getFunnelBySlug } from '@/lib/funnels';
import { resolveFunnelRange } from '@/lib/queries/funnel';
import { getPitchData } from '@/lib/queries/pitch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, { status });
}

export async function GET(req: NextRequest) {
  // Un curl sin cookie tiene que recibir 401 y nunca datos: es el guard que el
  // middleware no cubre si alguien le toca el matcher.
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
    // `resolveFunnelRange` de `lib/queries/funnel.ts` y no una reimplementación:
    // esta ruta y la del embudo tienen que leer el MISMO query string igual, o la
    // card del test y el resto de la pantalla mostrarían rangos distintos.
    range = await resolveFunnelRange(
      { preset: sp.get('range'), from: sp.get('from'), to: sp.get('to') },
      funnel.timezone,
    );
  } catch {
    return json(400, { ok: false, error: 'invalid_range' });
  }

  const data = await getPitchData({
    funnelId: funnel.id,
    from: range.from,
    to: range.to,
  });

  // El cuerpo va ANIDADO bajo sus claves y no con un spread al nivel superior
  // (como hace `/api/data/funnel`): así se puede agregar un campo al payload más
  // adelante sin riesgo de colisionar con `ok`.
  return NextResponse.json(
    { ok: true, ...data },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
