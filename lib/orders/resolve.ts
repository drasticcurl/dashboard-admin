import { q1 } from '../db';
import { getFunnelBySlug } from '../funnels';
import type { Tier } from '../types';

/**
 * Resolución de funnel (D10) y de tier (D11) de una venta.
 *
 * D10 — tres pasos, en este orden, y una venta nunca se descarta:
 *   1. el cart attribute `funnel` (slug);
 *   2. `product_map` por (shop_domain, product_id), probando primero la fila
 *      exacta y después ('*', product_id);
 *   3. `shop_map` por dominio de la tienda.
 * Si los tres fallan → funnelId = null y la orden se guarda igual: aparece en
 * el panel en "Ventas sin atribuir". Perder plata en silencio no es una opción.
 *
 * D11 — el tier lo setea el usuario a mano en product_map. Sin fila →
 * 'unknown'. Prohibido adivinar por el nombre del producto: un "Protocolo 30
 * días" puede ser el front en un funnel y el upsell en otro, y una heurística
 * que acierta el 80% produce un AOV que parece bien y está mal.
 */

export type FunnelResolution = {
  funnelId: number | null;
  how: 'attribute' | 'product' | 'shop' | 'none';
  /**
   * Avisos no fatales que el caller debe registrar en webhook_events.error
   * (el slug del attribute no existe, ítems que mapean a funnels distintos).
   */
  warnings: string[];
};

/**
 * productIds tiene que venir ORDENADO por amount desc (con empate por
 * quantity desc y orden original): la resolución por producto devuelve el
 * primer match, y el contrato del task dice que si distintos ítems mapean a
 * funnels distintos gana "el del ítem más caro". El orden lo decide el caller
 * (upsert.ts), que es quien conoce los amounts de la orden.
 */
export async function resolveFunnel(input: {
  attrFunnel?: string;
  shopDomain: string;
  productIds: string[];
}): Promise<FunnelResolution> {
  const warnings: string[] = [];

  // Paso 1: cart attribute `funnel`. Lo escribe buildCheckoutAttribution del
  // funnel; si el slug no existe (funnel desregistrado), se sigue al paso 2
  // pero el aviso queda: la venta se atribuyó, solo que no como esperaba.
  if (input.attrFunnel) {
    const f = await getFunnelBySlug(input.attrFunnel);
    if (f) return { funnelId: f.id, how: 'attribute', warnings };
    warnings.push(`funnel_attribute_desconocido:${input.attrFunnel}`);
  }

  // Paso 2: product_map. El ORDER BY (shop_domain = $1) DESC hace que la fila
  // exacta de la tienda gane sobre la global ('*') en un solo query (plan
  // §3.6: primero la exacta, después la global).
  const byProduct = new Map<string, number>();
  for (const pid of input.productIds) {
    const row = await q1<{ funnel_id: number }>(
      `SELECT funnel_id FROM product_map
       WHERE product_id = $2 AND (shop_domain = $1 OR shop_domain = '*')
       ORDER BY (shop_domain = $1) DESC
       LIMIT 1`,
      [input.shopDomain, pid],
    );
    if (row) byProduct.set(pid, row.funnel_id);
  }

  const distinct = Array.from(new Set(byProduct.values()));
  if (distinct.length === 1) {
    return { funnelId: distinct[0], how: 'product', warnings };
  }
  if (distinct.length > 1) {
    // Distintos ítems mapean a funnels distintos: gana el del ítem más caro
    // (el primero del array ordenado) y el conflicto se ve en webhook_events.
    // No es un error fatal: el tier del ítem descolgado se guarda igual.
    const winner = byProduct.get(input.productIds[0])!;
    const others = distinct.filter((id) => id !== winner);
    warnings.push(
      `funnel_conflicto: los ítems mapean a funnels distintos (${[...distinct].join(', ')}); ` +
        `gana el del ítem más caro (funnel ${winner}); los demás (${others.join(', ')}) quedan descolgados`,
    );
    return { funnelId: winner, how: 'product', warnings };
  }

  // Paso 3: shop_map por dominio de la tienda.
  const shop = await q1<{ funnel_id: number }>(
    'SELECT funnel_id FROM shop_map WHERE shop_domain = $1',
    [input.shopDomain],
  );
  if (shop) return { funnelId: shop.funnel_id, how: 'shop', warnings };

  // Paso 4: nada. La venta se guarda con funnel_id NULL (D10) y el cajón
  // "Ventas sin atribuir" la muestra.
  return { funnelId: null, how: 'none', warnings };
}

/**
 * Tier de un ítem, SOLO desde product_map. Sin fila → 'unknown'. La misma
 * regla de precedencia que el funnel: fila exacta de la tienda, después la
 * global ('*').
 */
export async function resolveTier(
  shopDomain: string,
  productId: string | null,
): Promise<Tier> {
  if (!productId) return 'unknown';
  const row = await q1<{ tier: Tier }>(
    `SELECT tier FROM product_map
     WHERE product_id = $2 AND (shop_domain = $1 OR shop_domain = '*')
     ORDER BY (shop_domain = $1) DESC
     LIMIT 1`,
    [shopDomain, productId],
  );
  return row?.tier ?? 'unknown';
}
