/**
 * Costo por producto: lectura y aplicación.
 *
 * El costo vive en `product_map` (migración 013), que ya es la lista de
 * productos. Se aplica por ÍTEM de la orden y por cantidad, así que una compra
 * de front + bump suma los dos costos.
 *
 * Diferencia importante con las comisiones: el costo NO se topea al monto de la
 * venta. Una comisión mayor a la venta sólo puede ser un error de tipeo; un
 * costo mayor a la venta es un caso real —se está vendiendo a pérdida— y
 * taparlo con un tope escondería justamente lo que hay que ver. El margen
 * negativo se muestra.
 */

import { q } from './db';

export type ProductCost = {
  shopDomain: string;
  productId: string;
  cost: number;
  currency: string | null;
};

export type OrderItemForCost = {
  productId: string | null;
  title: string | null;
  quantity: number;
};

export type AppliedCost = {
  productId: string;
  title: string | null;
  unitCost: number;
  quantity: number;
  currency: string | null;
  amount: number;
};

export type CostResult = {
  amount: number;
  amountEur: number | null;
  breakdown: AppliedCost[];
  warnings: string[];
};

/**
 * Costos de los productos de una tienda. Se traen todos de una: son pocos y así
 * el webhook no hace una consulta por ítem.
 */
export async function costsForShop(shopDomain: string): Promise<ProductCost[]> {
  return q<ProductCost>(
    `SELECT shop_domain AS "shopDomain", product_id AS "productId",
            -- ::float8: pg devuelve numeric como string y acá se multiplica.
            cost::float8 AS cost, cost_currency AS currency
     FROM product_map
     WHERE cost > 0 AND (shop_domain = $1 OR shop_domain = '*')`,
    [shopDomain],
  );
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Busca el costo de un producto. La fila exacta de la tienda le gana a la
 * comodín `'*'`, igual que la resolución de tier (plan §3.6).
 */
function findCost(costs: ProductCost[], shopDomain: string, productId: string): ProductCost | null {
  return (
    costs.find((c) => c.shopDomain === shopDomain && c.productId === productId) ??
    costs.find((c) => c.shopDomain === '*' && c.productId === productId) ??
    null
  );
}

/** Función pura: recibe los costos ya leídos, para testear sin base. */
export function applyCosts(input: {
  items: OrderItemForCost[];
  currency: string;
  shopDomain: string;
  costs: ProductCost[];
  /** Cotización ya aplicada a esta orden (1 unidad de `currency` en euros). */
  fxRate?: number | null;
}): CostResult {
  const breakdown: AppliedCost[] = [];
  const warnings: string[] = [];
  let total = 0;

  for (const item of input.items) {
    if (!item.productId) continue;
    const pc = findCost(input.costs, input.shopDomain, item.productId);
    if (!pc) continue;

    if (!Number.isFinite(pc.cost) || pc.cost <= 0) continue;

    if (pc.currency && pc.currency !== input.currency) {
      warnings.push(
        `costo de '${item.title ?? item.productId}' está en ${pc.currency} y la venta es en ${input.currency}: se ignoró`,
      );
      continue;
    }

    const qty = Number.isFinite(item.quantity) && item.quantity > 0 ? Math.floor(item.quantity) : 1;
    const monto = round2(pc.cost * qty);
    breakdown.push({
      productId: item.productId,
      title: item.title,
      unitCost: pc.cost,
      quantity: qty,
      currency: pc.currency,
      amount: monto,
    });
    total += monto;
  }

  total = round2(total);
  const rate = input.fxRate;
  const amountEur =
    typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? round2(total * rate) : null;

  return { amount: total, amountEur, breakdown, warnings };
}
