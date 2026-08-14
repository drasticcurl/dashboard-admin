-- ═══════════════════════════════════════════════════════════════════════════
-- 012 — Comisiones como LISTA DE REGLAS, no como dos campos del funnel.
--
-- La 011 puso `commission_percent` y `commission_fixed` en `funnels`. Eso solo
-- alcanza para una comisión por funnel, y la realidad son varias a la vez:
-- Mercado Pago cobra un porcentaje, la pasarela puede sumar un fijo por
-- transacción, y puede haber un cargo que aplique a TODOS los funnels por igual.
--
-- Este modelo lo resuelve con una fila por comisión:
--   · `funnel_id NULL`  → global, aplica a todos los funnels
--   · `funnel_id = N`   → solo a ese funnel
--   · `kind = 'percent'`→ porcentaje del monto de la venta (ej. 5 %)
--   · `kind = 'fixed'`  → monto fijo por venta (ej. 100 ARS)
--
-- Las columnas de la 011 SE ELIMINAN en lugar de quedar como respaldo: dos
-- lugares donde definir lo mismo es cómo se llega a un neto que no coincide con
-- ningún otro número del panel. Se pueden borrar sin migrar datos porque nunca
-- se cargó un valor distinto de 0 (se verificó antes de escribir esto).
--
-- Lo que NO cambia: la comisión se sigue congelando en la orden al registrarla
-- (razón en la 011), y sigue contando solo en las aprobadas.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS commissions (
  id         smallserial   PRIMARY KEY,
  -- Para qué es. Aparece en el desglose de cada venta, así que conviene el
  -- nombre real del cargo ('Mercado Pago', 'IVA sobre comisión', 'Shopify').
  name       text          NOT NULL,
  -- NULL = global. La FK con ON DELETE CASCADE evita reglas huérfanas
  -- apuntando a un funnel borrado.
  funnel_id  smallint      REFERENCES funnels(id) ON DELETE CASCADE,
  kind       text          NOT NULL,
  value      numeric(14,4) NOT NULL,
  -- Solo para las fijas: un fijo de "100" no significa nada sin moneda, y una
  -- regla global fija no puede aplicarse a un funnel que cobra en otra moneda.
  -- Las porcentuales no llevan moneda porque son relativas al monto.
  currency   text,
  active     boolean       NOT NULL DEFAULT true,
  created_at timestamptz   NOT NULL DEFAULT now(),
  updated_at timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT commissions_kind_valido CHECK (kind IN ('percent', 'fixed')),
  CONSTRAINT commissions_value_positivo CHECK (value >= 0),
  -- Un porcentaje fuera de 0-100 no es un porcentaje. Sin este check, tipear
  -- 629 en vez de 6.29 daría un neto negativo sin explicación visible.
  CONSTRAINT commissions_percent_rango CHECK (
    kind <> 'percent' OR (value <= 100 AND currency IS NULL)
  ),
  CONSTRAINT commissions_fixed_moneda CHECK (
    kind <> 'fixed' OR currency IS NOT NULL
  )
);

COMMENT ON TABLE commissions IS
  'Reglas de comisión. funnel_id NULL = global. Se congelan en cada orden al registrarla.';

-- La query del webhook es "todas las activas globales + las de este funnel".
CREATE INDEX IF NOT EXISTS commissions_lookup_idx
  ON commissions (funnel_id, active);

-- La función del trigger se crea acá: esta base no la tenía. Venía del schema de
-- Supabase de los funnels, y asumirla presente hizo fallar esta migración en el
-- primer intento (el deploy la descartó sin activar la release, como debe ser).
CREATE OR REPLACE FUNCTION update_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER commissions_updated_at
  BEFORE UPDATE ON commissions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Desglose auditable de lo que se le aplicó a cada venta: qué reglas, con qué
-- valor y cuánto salió cada una. Sin esto, un monto congelado es un número sin
-- procedencia y no se puede explicar seis meses después.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS commission_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN orders.commission_breakdown IS
  'Reglas aplicadas: [{id, name, kind, value, currency, amount}]. Congelado al registrar.';

-- Fuera las columnas de la 011: una sola fuente de verdad.
ALTER TABLE funnels
  DROP COLUMN IF EXISTS commission_percent,
  DROP COLUMN IF EXISTS commission_fixed;

ALTER TABLE orders
  DROP COLUMN IF EXISTS commission_percent,
  DROP COLUMN IF EXISTS commission_fixed;
