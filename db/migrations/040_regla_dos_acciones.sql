-- ═══════════════════════════════════════════════════════════════════════════
-- 040 — Reglas con dos acciones: pausar/activar Y fijar el presupuesto.
--
-- Pedido del usuario (2026-10-02): «Reactivar conjuntos a las 00 - ROI 7 días
-- > 1.5» tiene que resetear el presupuesto a €10 y prenderlos, en la misma
-- regla.
--
-- `set_budget_eur` es la SEGUNDA acción, opcional: además de la acción
-- principal (pause/activate), fijar el presupuesto diario del objeto en ese
-- importe exacto. NULL = la regla tiene una sola acción, como hasta ahora.
--
-- Sólo con pause/activate: las de presupuesto ya tocan el presupuesto, y
-- combinar «subir 20%» con «fijar en €10» no significa nada. Y nunca a nivel
-- anuncio (en Meta los anuncios no tienen presupuesto).
--
-- El ejecutor manda las dos cosas en UN POST (`status` + `daily_budget`), así
-- que Meta aplica las dos o ninguna; en `ad_actions` quedan dos filas (una
-- `activate`/`pause` y una `budget_set`) para que el historial y el
-- reconciliador sigan leyendo un valor por fila.
--
-- IDEMPOTENTE.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE ad_rules
  ADD COLUMN IF NOT EXISTS set_budget_eur numeric(14,2);

COMMENT ON COLUMN ad_rules.set_budget_eur IS
  'Segunda acción opcional: además de pausar/activar, fijar el presupuesto diario en este importe (EUR). NULL = sin segunda acción.';

ALTER TABLE ad_rules DROP CONSTRAINT IF EXISTS ad_rules_set_budget_valido;
ALTER TABLE ad_rules ADD CONSTRAINT ad_rules_set_budget_valido CHECK (
  set_budget_eur IS NULL
  OR (set_budget_eur > 0 AND action IN ('pause', 'activate') AND level <> 'ad')
);
