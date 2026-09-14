/**
 * Siembra la fila de `product_map` que atribuye las ventas de
 * checkout-kashhhpay a un funnel (T02, plan panel-y-capi §5, D2).
 *
 * NO se agrega a package.json (regla no negociable de esta task): se corre
 * directo con tsx.
 *
 *   npx tsx scripts/seed-product-map-checkout-propio.ts <whopPlanId> <funnelSlug>
 *
 * Ejemplo real usado en la verificación de esta task (P-02, sin resolver
 * todavía — ver el comentario grande más abajo):
 *
 *   npx tsx scripts/seed-product-map-checkout-propio.ts plan_test123 chauhinchazon
 *
 * IDEMPOTENTE (criterio de aceptación 2 del plan): ON CONFLICT (shop_domain,
 * product_id) DO NOTHING. Correrlo dos veces con el mismo whopPlanId no
 * duplica la fila — necesario porque un deploy puede reintentar el paso
 * manual sin querer.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * P-02 (plan §10, sin resolver): qué funnel usar en producción para esta fila
 * NO es lo mismo que P-02 de autenticación (D4) — son dos preguntas
 * distintas que comparten número en el plan porque las dejó abiertas la
 * misma task. Esta es la de ATRIBUCIÓN (D2): a qué funnel de REPORTE
 * pertenece la venta. Este script no la resuelve — el `funnelSlug` es un
 * argumento explícito, no un valor hardcodeado, precisamente para no decidir
 * en silencio qué funnel usar en producción. Quien lo corra en el VPS real
 * elige el slug correcto (o crea un funnel dedicado a "checkout propio" si
 * se resuelve así) y lo pasa como argumento.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { getPool, q, q1 } from '../lib/db';

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

// Mismo centinela que resolveFunnel()/resolveTier() usan para esta fuente
// (D2 del plan) — ver PRODUCT_MAP_SHOP_DOMAIN en lib/orders/checkout-propio.ts.
// No se importa esa constante acá porque el script corre standalone con tsx,
// fuera del árbol de Next; se repite el literal a propósito, documentado.
const SHOP_DOMAIN = 'checkout_propio';

async function main(): Promise<void> {
  const [whopPlanId, funnelSlug] = process.argv.slice(2);
  if (!whopPlanId || !funnelSlug) {
    console.error(
      'uso: npx tsx scripts/seed-product-map-checkout-propio.ts <whopPlanId> <funnelSlug>',
    );
    process.exit(1);
  }

  const funnel = await q1<{ id: number; slug: string }>('SELECT id, slug FROM funnels WHERE slug = $1', [
    funnelSlug,
  ]);
  if (!funnel) {
    console.error(`no existe un funnel con slug '${funnelSlug}'. Funnels disponibles:`);
    const todos = await q<{ slug: string }>('SELECT slug FROM funnels ORDER BY slug');
    for (const f of todos) console.error(`  - ${f.slug}`);
    process.exit(1);
  }

  const rows = await q<{ id: number }>(
    `INSERT INTO product_map (shop_domain, product_id, funnel_id, tier, label)
     VALUES ($1, $2, $3, 'front', $4)
     ON CONFLICT (shop_domain, product_id) DO NOTHING
     RETURNING id`,
    [SHOP_DOMAIN, whopPlanId, funnel.id, `Checkout propio — ${whopPlanId} (valor de prueba, no definitivo)`],
  );

  if (rows.length > 0) {
    console.log(
      `creada: product_map(shop_domain='${SHOP_DOMAIN}', product_id='${whopPlanId}') → funnel_id=${funnel.id} ('${funnel.slug}')`,
    );
  } else {
    console.log(
      `ya existía: product_map(shop_domain='${SHOP_DOMAIN}', product_id='${whopPlanId}') — no se tocó (ON CONFLICT DO NOTHING)`,
    );
  }

  await getPool().end();
}

main().catch((err) => {
  console.error('seed-product-map-checkout-propio falló:', err instanceof Error ? err.message : err);
  process.exit(1);
});
