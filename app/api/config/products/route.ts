/**
 * /api/config/products (task T09 §B.3) — product_map: producto → funnel y
 * tier, la tabla que hace funcionar la atribución de ventas (D10, D11).
 *
 * GET    → los mapas existentes + los product_id que ya aparecieron en
 *          ventas y todavía no tienen mapa (el "mapeáme en un click").
 * POST   → crea (upsert) un mapa.
 * PATCH  → edita un mapa — mismo upsert, identificado por (shop_domain,
 *          product_id), que es la PK del schema.
 * DELETE → borra un mapa (?shopDomain=..&productId=..).
 *
 * POST y PATCH re-resuelven las órdenes EXISTENTES de ese producto en la
 * misma transacción: mapear solo serviría para el futuro si no se tocara el
 * histórico, y las ventas viejas quedarían mal para siempre. El re-proceso:
 *   1. order_items.tier de los ítems de ese producto que quedaron 'unknown'.
 *   2. orders.tier (el del ítem de mayor precio, §3.5) y orders.funnel_id
 *      de las órdenes que quedaron 'unknown' / NULL.
 * La atribución existente no se pisa: una orden con funnel_id ya resuelto
 * por cart attribute (D10 paso 1) conserva su funnel.
 *
 * Regla de alcance del mapa (misma que la resolución del webhook, §3.6):
 * la fila exacta (shop_domain, product_id) gana sobre la global
 * ('*', product_id). Un re-proceso con un mapa global no toca órdenes de
 * tiendas que tienen su propia fila exacta: ese filtro es el NOT EXISTS.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { tx } from '@/lib/db';
import { applyCosts, costsForShop } from '@/lib/costs';
import { TIERS } from '@/lib/types';
import {
  funnelExists,
  guard,
  json,
  listProductMappings,
  listUnmappedProducts,
  parseJson,
} from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// `*` es el centinela del schema para "cualquier tienda" (plan §3.6): el
// regex tiene que dejarlo pasar o el formulario default de la UI no valida.
const SHOP_DOMAIN_RE = /^[a-zA-Z0-9.*-]+$/;

const mapSchema = z.object({
  shopDomain: z.string().min(1).max(255).regex(SHOP_DOMAIN_RE).default('*'),
  productId: z.string().min(1).max(255),
  funnelId: z.number().int().positive(),
  tier: z.enum(TIERS),
  // El `label` es además el título con el que se enganchan los ítems que
  // llegaron sin product_id (ver paso 0 del re-proceso): es el mismo uso que
  // ya le da el importador de CSV.
  label: z.string().max(255).nullable().optional(),
  // Costo unitario del producto (migración 013). La moneda es obligatoria en
  // cuanto el costo es distinto de 0: un "100" sin moneda no significa nada.
  cost: z.number().min(0).max(100_000_000).optional(),
  costCurrency: z.string().length(3).regex(/^[A-Z]{3}$/).nullable().optional(),
});

export async function GET() {
  const [mappings, unmapped] = await Promise.all([
    listProductMappings(),
    listUnmappedProducts(),
  ]);
  return json(200, { ok: true, mappings, unmapped });
}

export async function POST(req: NextRequest) {
  return upsertAndReResolve(req);
}

export async function PATCH(req: NextRequest) {
  return upsertAndReResolve(req);
}

async function upsertAndReResolve(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return denied;

  const raw = await parseJson(req);
  const parsed = mapSchema.safeParse(raw);
  if (!parsed.success) {
    return json(400, { ok: false, error: 'invalid_payload', detail: parsed.error.issues[0]?.message });
  }
  const { shopDomain, productId, funnelId, tier, label } = parsed.data;
  const cost = parsed.data.cost ?? 0;
  const costCurrency = cost > 0 ? (parsed.data.costCurrency ?? null) : null;
  if (cost > 0 && !costCurrency) {
    return json(400, { ok: false, error: 'invalid_payload', detail: 'un costo necesita moneda' });
  }

  if (!(await funnelExists(funnelId))) {
    return json(400, { ok: false, error: 'unknown_funnel' });
  }

  const result = await tx(async (c) => {
    await c.query(
      `INSERT INTO product_map (shop_domain, product_id, funnel_id, tier, label, cost, cost_currency)
       VALUES ($1, $2, $3, $4, $5, $6::numeric, $7)
       ON CONFLICT (shop_domain, product_id)
       DO UPDATE SET funnel_id = EXCLUDED.funnel_id,
                     tier      = EXCLUDED.tier,
                     label     = EXCLUDED.label,
                     cost      = EXCLUDED.cost,
                     cost_currency = EXCLUDED.cost_currency`,
      [shopDomain, productId, funnelId, tier, label ?? null, cost, costCurrency],
    );

    // 0) Enganchar por TÍTULO los ítems que llegaron sin product_id.
    //
    //    POR QUÉ HACE FALTA
    //    El export de órdenes de Shopify no trae product_id ni SKU en las
    //    líneas, así que todo lo importado por CSV que no matcheó un
    //    `product_map.label` quedó con shopify_product_id NULL. Los pasos 1, 2
    //    y 3 enganchan por `oi.shopify_product_id = $1`, así que sobre esos
    //    ítems no hacían nada: el botón decía "re-resolver" y re-resolvía 0.
    //
    //    Se les estampa el product_id de este mapa y a partir de ahí los pasos
    //    siguientes los tratan como cualquier otro ítem. El enganche es por
    //    igualdad EXACTA de `label` contra el título del ítem: es la misma
    //    regla que ya usa el importador de CSV (`Lineitem name` contra
    //    `product_map.label`), no un criterio nuevo. Al ser igualdad exacta, un
    //    label aproximado no engancha nada — falla en no hacer nada, no en
    //    mapear la venta equivocada.
    //
    //    Solo toca ítems con el ID en NULL: uno que ya tiene ID conserva el
    //    suyo, aunque el título coincida.
    let stampedByTitle = 0;
    if (label) {
      const stamped = await c.query(
        `UPDATE order_items oi
         SET shopify_product_id = $1
         FROM orders o
         WHERE o.id = oi.order_id
           AND oi.shopify_product_id IS NULL
           AND oi.title = $3
           AND ($2 = '*' OR o.shop_domain = $2)`,
        [productId, shopDomain, label],
      );
      stampedByTitle = stamped.rowCount ?? 0;
    }

    // 1) Re-resolver el tier de los ítems históricos de ese producto. Solo
    //    los que quedaron 'unknown', y solo si el mapa cambia algo: un mapa
    //    con tier 'unknown' no toca nada. El NOT EXISTS es la precedencia de
    //    §3.6 aplicada a lo que NO es esta fila (pm.shop_domain <> $2): si la
    //    tienda tiene su propia fila exacta, el mapa global no la pisa; si la
    //    fila exacta es la que se está escribiendo, sus ítems sí se
    //    re-resuelven.
    const items = await c.query(
      `UPDATE order_items oi
       SET tier = $3
       FROM orders o
       WHERE o.id = oi.order_id
         AND oi.shopify_product_id = $1
         AND oi.tier = 'unknown'
         AND oi.tier IS DISTINCT FROM $3
         AND ($2 = '*' OR o.shop_domain = $2)
         AND NOT EXISTS (
           SELECT 1 FROM product_map pm
           WHERE pm.product_id = oi.shopify_product_id
             AND pm.shop_domain = o.shop_domain
             AND pm.shop_domain <> $2
         )`,
      [productId, shopDomain, tier],
    );

    // 2) Re-resolver orders.tier y orders.funnel_id. Solo órdenes que
    //    quedaron sin resolver ('unknown' / NULL): la atribución existente
    //    es la verdad (D10). El nuevo orders.tier es el del ítem de mayor
    //    precio (§3.5), que puede ser otro producto todavía sin mapear: en
    //    ese caso la orden sigue 'unknown' y no cuenta como corregida.
    const orders = await c.query(
      `WITH touched AS (
         SELECT DISTINCT oi2.order_id AS id
         FROM order_items oi2
         JOIN orders o2 ON o2.id = oi2.order_id
         WHERE oi2.shopify_product_id = $1
           AND ($2 = '*' OR o2.shop_domain = $2)
           AND NOT EXISTS (
             SELECT 1 FROM product_map pm
             WHERE pm.product_id = oi2.shopify_product_id
               AND pm.shop_domain = o2.shop_domain
               AND pm.shop_domain <> $2
           )
       ),
       newvals AS (
         SELECT o.id,
                COALESCE(
                  (SELECT oi.tier FROM order_items oi
                   WHERE oi.order_id = o.id
                   ORDER BY oi.amount DESC NULLS LAST, oi.id
                   LIMIT 1),
                  o.tier) AS new_tier,
                COALESCE(o.funnel_id, $3::smallint) AS new_funnel
         FROM orders o
         JOIN touched t ON t.id = o.id
       )
       UPDATE orders o
       SET tier      = nv.new_tier,
           funnel_id = nv.new_funnel
       FROM newvals nv
       WHERE o.id = nv.id
         AND (o.tier = 'unknown' OR o.funnel_id IS NULL)
         AND (o.tier      IS DISTINCT FROM nv.new_tier
           OR o.funnel_id IS DISTINCT FROM nv.new_funnel)`,
      [productId, shopDomain, funnelId],
    );

    // 3) Recalcular el COSTO de las órdenes que tienen este producto.
    //
    //    POR QUÉ ESTO ESTÁ ACÁ Y NO SOLO EN EL SCRIPT DE BACKFILL
    //    El botón dice "Mapear y re-resolver órdenes". Cargar un costo y ver que
    //    las ventas siguen en 0 es exactamente lo que reportó el usuario, y con
    //    razón: si la pantalla ofrece re-resolver, tiene que re-resolver todo lo
    //    que depende del mapa, no solo el tier.
    //
    //    A diferencia del tier y del funnel, acá NO se filtra por "las que
    //    quedaron sin resolver": el costo se recalcula siempre para las órdenes
    //    de este producto. Cambiar el costo de un producto es justamente pedir
    //    que se reexprese lo que lo contiene. La comisión no se toca: no depende
    //    del mapa de productos.
    //
    //    Se recalcula el costo COMPLETO de cada orden (todos sus ítems), no solo
    //    la parte de este producto: una orden puede traer front + bump y el
    //    total es la suma.
    const afectadas = await c.query<{
      id: string;
      currency: string;
      shopDomain: string;
      fxRate: string | null;
      items: Array<{ productId: string | null; title: string | null; quantity: number }> | null;
    }>(
      `SELECT o.id::text AS id, o.currency, o.shop_domain AS "shopDomain",
              o.fx_rate::text AS "fxRate",
              (SELECT json_agg(json_build_object(
                        'productId', oi.shopify_product_id,
                        'title', oi.title,
                        'quantity', oi.quantity))
                 FROM order_items oi WHERE oi.order_id = o.id) AS items
       FROM orders o
       WHERE EXISTS (
         SELECT 1 FROM order_items oi2
         WHERE oi2.order_id = o.id AND oi2.shopify_product_id = $1
       )
       AND ($2 = '*' OR o.shop_domain = $2)`,
      [productId, shopDomain],
    );

    let costosActualizados = 0;
    if (afectadas.rows.length > 0) {
      // Los costos se leen una vez por tienda, no una por orden.
      const porTienda = new Map<string, Awaited<ReturnType<typeof costsForShop>>>();
      const ids: string[] = [];
      const montos: number[] = [];
      const montosEur: Array<number | null> = [];
      const desgloses: string[] = [];

      for (const o of afectadas.rows) {
        let costos = porTienda.get(o.shopDomain);
        if (!costos) {
          costos = await costsForShop(o.shopDomain);
          porTienda.set(o.shopDomain, costos);
        }
        const k = applyCosts({
          items: o.items ?? [],
          currency: o.currency,
          shopDomain: o.shopDomain,
          costs: costos,
          fxRate: o.fxRate === null ? null : Number(o.fxRate),
        });
        ids.push(o.id);
        montos.push(k.amount);
        montosEur.push(k.amountEur);
        desgloses.push(JSON.stringify(k.breakdown));
      }

      const upd = await c.query(
        `UPDATE orders AS o SET
           cost_amount     = u.amount,
           cost_amount_eur = u.amount_eur,
           cost_breakdown  = u.breakdown,
           updated_at      = now()
         FROM UNNEST($1::bigint[], $2::numeric[], $3::numeric[], $4::jsonb[])
              AS u(id, amount, amount_eur, breakdown)
         WHERE o.id = u.id
           AND (o.cost_amount IS DISTINCT FROM u.amount
             OR o.cost_breakdown IS DISTINCT FROM u.breakdown)`,
        [ids, montos, montosEur, desgloses],
      );
      costosActualizados = upd.rowCount ?? 0;
    }

    return {
      correctedItems: items.rowCount ?? 0,
      correctedOrders: orders.rowCount ?? 0,
      correctedCosts: costosActualizados,
      stampedByTitle,
    };
  });

  return json(200, {
    ok: true,
    mapping: { shopDomain, productId, funnelId, tier, label: label ?? null },
    correctedItems: result.correctedItems,
    correctedOrders: result.correctedOrders,
    correctedCosts: result.correctedCosts,
    stampedByTitle: result.stampedByTitle,
  });
}

export async function DELETE(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return denied;

  const shopDomain = req.nextUrl.searchParams.get('shopDomain');
  const productId = req.nextUrl.searchParams.get('productId');
  if (!shopDomain || !productId) {
    return json(400, { ok: false, error: 'missing_params' });
  }

  const res = await tx(async (c) => {
    return c.query(
      `DELETE FROM product_map WHERE shop_domain = $1 AND product_id = $2 RETURNING id`,
      [shopDomain, productId],
    );
  });
  if (res.rowCount === 0) {
    return json(404, { ok: false, error: 'unknown_mapping' });
  }
  // Las órdenes ya re-resueltas conservan su tier/funnel a propósito: el
  // DELETE borra la definición, no re-adivina el pasado. Si el usuario
  // quiere re-abrir el tier, remapea el producto con otro valor.
  return json(200, { ok: true, deleted: true });
}
