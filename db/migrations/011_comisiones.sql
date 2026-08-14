-- ═══════════════════════════════════════════════════════════════════════════
-- 011 — Comisiones de la pasarela de pago (Mercado Pago vía Shopify).
--
-- POR QUÉ SE CONGELAN EN LA ORDEN Y NO SE CALCULAN AL LEER
-- Misma razón que la cotización (§D12 del plan): un reporte de marzo no puede
-- cambiar porque hoy se renegoció la comisión. El porcentaje vigente vive en
-- `funnels`, se aplica en el momento de ingresar la venta, y el monto resultante
-- queda escrito en la fila junto con el porcentaje y el fijo que se usaron. Así
-- la fila es auditable sola: se puede reconstruir de dónde salió el número sin
-- saber qué configuración había ese día.
--
-- POR QUÉ SOLO SOBRE LAS APROBADAS
-- En una devolución la pasarela normalmente reintegra el cargo, así que la
-- comisión de una orden devuelta no es un costo real. Las queries la suman con
-- `FILTER (WHERE status = 'approved')`, igual que el bruto.
--
-- DEFAULT EN CERO A PROPÓSITO
-- Sin configurar, la comisión es 0 y ningún número del panel cambia. Recién
-- cuando se carga el porcentaje en /config empieza a descontarse, y solo para
-- las ventas que entren desde ese momento (las viejas las corrige
-- `scripts/backfill-commissions.ts`, que es explícito y tiene --dry-run).
-- ═══════════════════════════════════════════════════════════════════════════

-- Configuración vigente, por funnel: cada uno puede cobrar por otra pasarela.
ALTER TABLE funnels
  ADD COLUMN IF NOT EXISTS commission_percent numeric(6,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS commission_fixed   numeric(14,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN funnels.commission_percent IS
  'Porcentaje que retiene la pasarela, 0-100. Ej: 6.29 para 6,29 %.';
COMMENT ON COLUMN funnels.commission_fixed IS
  'Monto fijo por transacción, en la moneda del funnel (sell_currency).';

-- Lo aplicado a cada venta, congelado.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS commission_amount     numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS commission_amount_eur numeric(14,2),
  ADD COLUMN IF NOT EXISTS commission_percent    numeric(6,3)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS commission_fixed      numeric(14,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN orders.commission_amount IS
  'Comisión en la moneda de la orden: amount * percent/100 + fixed. Congelada al ingresar.';
COMMENT ON COLUMN orders.commission_amount_eur IS
  'La misma comisión convertida con la cotización de la orden. NULL si no había cotización.';

-- Índice parcial para el aviso de "ventas sin comisión configurada": encontrar
-- las aprobadas con comisión en 0 tiene que ser barato aunque la tabla crezca.
CREATE INDEX IF NOT EXISTS orders_sin_comision_idx
  ON orders (funnel_id, day DESC)
  WHERE status = 'approved' AND commission_amount = 0;

-- El Resumen lee del rollup, así que necesita su propia columna.
ALTER TABLE daily_metrics
  ADD COLUMN IF NOT EXISTS commissions     numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS commissions_eur numeric(14,2) NOT NULL DEFAULT 0;
