-- ═══════════════════════════════════════════════════════════════════════════
-- 013 — Costo por producto.
--
-- DÓNDE VIVE Y POR QUÉ
-- En `product_map`, que ya es la tabla que dice a qué funnel y a qué tier
-- pertenece cada `product_id`. El costo es un atributo del producto, así que
-- ponerlo en otra tabla obligaría a mantener dos listas de productos en sincro.
--
-- CÓMO SE APLICA
-- Por ÍTEM de la orden y multiplicado por la cantidad: una orden puede traer
-- front + bump, y cada uno tiene su costo. El total se congela en la orden junto
-- con el desglose, igual que las comisiones (razón en la 011).
--
-- POR QUÉ EL COSTO NO SE TOPEA AL MONTO DE LA VENTA
-- Las comisiones sí se topean, porque una comisión mayor a la venta sólo puede
-- ser un error de tipeo. Un costo mayor a la venta es un caso real: significa
-- que ese producto se está vendiendo a pérdida, y esconderlo detrás de un tope
-- ocultaría justamente lo que hay que ver.
--
-- El neto queda:  bruto − devoluciones − comisiones − costos
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE product_map
  ADD COLUMN IF NOT EXISTS cost          numeric(14,2) NOT NULL DEFAULT 0,
  -- La moneda es obligatoria en cuanto el costo es distinto de 0: un "100" sin
  -- moneda no significa nada, y un costo en otra moneda que la venta no se
  -- puede aplicar sin inventar una conversión.
  ADD COLUMN IF NOT EXISTS cost_currency text;

ALTER TABLE product_map
  ADD CONSTRAINT product_map_cost_moneda
  CHECK (cost = 0 OR cost_currency IS NOT NULL);

COMMENT ON COLUMN product_map.cost IS
  'Costo unitario del producto, en cost_currency. Se multiplica por la cantidad del ítem.';

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS cost_amount     numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_amount_eur numeric(14,2),
  ADD COLUMN IF NOT EXISTS cost_breakdown  jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN orders.cost_breakdown IS
  'Costos aplicados: [{productId, title, unitCost, quantity, currency, amount}]. Congelado al registrar.';

-- Para el aviso de "ventas sin costo cargado": encontrar las aprobadas en 0
-- tiene que ser barato aunque la tabla crezca.
CREATE INDEX IF NOT EXISTS orders_sin_costo_idx
  ON orders (funnel_id, day DESC)
  WHERE status = 'approved' AND cost_amount = 0;

-- El Resumen lee del rollup: necesita sus propias columnas.
ALTER TABLE daily_metrics
  ADD COLUMN IF NOT EXISTS costs     numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS costs_eur numeric(14,2) NOT NULL DEFAULT 0;
