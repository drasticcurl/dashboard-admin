/**
 * /api/config/shops (task T09 §B.3) — shop_map: dominio de tienda → funnel,
 * el último recurso de la resolución de D10.
 *
 * GET    → los mapas con el funnel resuelto.
 * POST   → upsert de un mapa (el dominio es la PK).
 * PATCH  → cambia el funnel de un dominio.
 * DELETE → borra (?shopDomain=..).
 *
 * Borrar un mapa no re-resuelve las órdenes que ya se atribuyeron por su
 * causa: la atribución pasada es un hecho registrado, y re-abrirla
 * reinterpretaría ventas ya cerradas. Si el usuario cambia de idea, remapea
 * el dominio a otro funnel y las ventas FUTURAS cambian.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { q } from '@/lib/db';
import { funnelExists, guard, json, listShopMappings, parseJson } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SHOP_DOMAIN_RE = /^[a-zA-Z0-9.-]+$/;

const schema = z.object({
  shopDomain: z.string().min(1).max(255).regex(SHOP_DOMAIN_RE),
  funnelId: z.number().int().positive(),
});

export async function GET() {
  const shops = await listShopMappings();
  return json(200, { ok: true, shops });
}

async function upsert(req: NextRequest): Promise<ReturnType<typeof json>> {
  const denied = await guard(req);
  if (denied) return denied;

  const raw = await parseJson(req);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return json(400, { ok: false, error: 'invalid_payload', detail: parsed.error.issues[0]?.message });
  }
  const { shopDomain, funnelId } = parsed.data;
  if (!(await funnelExists(funnelId))) {
    return json(400, { ok: false, error: 'unknown_funnel' });
  }

  await q(
    `INSERT INTO shop_map (shop_domain, funnel_id)
     VALUES ($1, $2)
     ON CONFLICT (shop_domain) DO UPDATE SET funnel_id = EXCLUDED.funnel_id`,
    [shopDomain, funnelId],
  );
  return json(200, { ok: true, shop: { shopDomain, funnelId } });
}

export async function POST(req: NextRequest) {
  return upsert(req);
}

export async function PATCH(req: NextRequest) {
  return upsert(req);
}

export async function DELETE(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return denied;

  const shopDomain = req.nextUrl.searchParams.get('shopDomain');
  if (!shopDomain) {
    return json(400, { ok: false, error: 'missing_params' });
  }

  const res = await q(
    `DELETE FROM shop_map WHERE shop_domain = $1 RETURNING shop_domain`,
    [shopDomain],
  );
  if (res.length === 0) {
    return json(404, { ok: false, error: 'unknown_mapping' });
  }
  return json(200, { ok: true, deleted: true });
}
