-- ═══════════════════════════════════════════════════════════════════════════
-- 041 — «Fijar el presupuesto en €X» como acción principal, y segunda franja
--       horaria por regla.
--
-- Pedido del usuario (2026-10-02), para el set de reglas por CPA:
--
-- 1. `action = 'budget_set'`: dejar el presupuesto diario en un importe exacto
--    («si el CPA > 3,85 y gastó > €10, bajarlo a €10»). `action_value` es el
--    importe en EUR y `action_unit` siempre 'fixed'. No lleva techo ni piso: el
--    importe ES el límite. Los frenos absolutos del motor (tope diario, tope
--    por tick, mínimo de la cuenta) aplican igual.
--
-- 2. `window2_start`/`window2_end`: una segunda ventana opcional. La regla
--    corre si la hora local cae en CUALQUIERA de las dos (2–6 y 13–24 para el
--    «surf»). Sin esto había que duplicar cada regla y mantener dos copias.
--
-- IDEMPOTENTE. Compatible hacia atrás: columnas nullable y un CHECK más ancho.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE ad_rules DROP CONSTRAINT IF EXISTS ad_rules_action_valida;
ALTER TABLE ad_rules ADD CONSTRAINT ad_rules_action_valida
  CHECK (action IN ('pause', 'activate', 'budget_increase', 'budget_decrease', 'budget_set'));

ALTER TABLE ad_rules DROP CONSTRAINT IF EXISTS ad_rules_budget_set_completo;
ALTER TABLE ad_rules ADD CONSTRAINT ad_rules_budget_set_completo CHECK (
  action <> 'budget_set'
  OR (action_value IS NOT NULL AND action_value > 0 AND action_unit = 'fixed' AND level <> 'ad')
);

ALTER TABLE ad_rules
  ADD COLUMN IF NOT EXISTS window2_start time,
  ADD COLUMN IF NOT EXISTS window2_end   time;

ALTER TABLE ad_rules DROP CONSTRAINT IF EXISTS ad_rules_ventana2_completa;
ALTER TABLE ad_rules ADD CONSTRAINT ad_rules_ventana2_completa CHECK (
  (window2_start IS NULL) = (window2_end IS NULL)
  -- La segunda sólo tiene sentido si hay una primera.
  AND (window2_start IS NULL OR window_start IS NOT NULL)
);

COMMENT ON COLUMN ad_rules.window2_start IS
  'Segunda ventana horaria opcional (041): la regla corre si la hora local cae en la primera O en esta.';
