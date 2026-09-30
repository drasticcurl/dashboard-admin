-- ═══════════════════════════════════════════════════════════════════════════
-- 037 — Reglas generales: una regla, varias cuentas. Y chau modo sombra.
--
-- CORRE SOBRE DATOS VIVOS. Qué cambia de comportamiento: sólo lo del punto 2.
--
-- ── 1. EL GRUPO ────────────────────────────────────────────────────────────
-- Pedido del usuario (2026-09-30): "que las reglas sean generales y dentro de
-- cada regla tenga un «aplicar a x cuentas publicitarias»".
--
-- La 021 dejó UNA cuenta por fila a propósito, y eso NO se deshace: el ejecutor
-- evalúa una regla en la zona horaria de SU cuenta, y `max_runs_per_day`, la
-- cadencia y `ad_rule_runs` se cuentan por `rule_id`. Reescribir el ejecutor
-- (`lib/ads/**`, la zona que mueve plata en Meta) para que itere cuentas es el
-- camino caro y riesgoso.
--
-- En cambio: una regla general es un GRUPO de filas, una por cuenta, con la
-- misma configuración. El ejecutor sigue viendo lo que veía (filas con una
-- cuenta) y la pantalla y el API manejan el grupo como una sola regla. Cada
-- cuenta conserva su historial y sus frenos, que es justo lo que se quiere:
-- "1 corrida por día" es por cuenta, no "1 entre las dos".
--
-- Cada fila existente queda en un grupo propio (el DEFAULT volátil se evalúa
-- por fila al agregar la columna). Unir las reglas que hoy están duplicadas por
-- cuenta es un paso de datos aparte, anotado en registro.md.
--
-- ── 2. SIN MODO SOMBRA ─────────────────────────────────────────────────────
-- "Todas las reglas prendidas ya corren, no hay más modo sombra." Las columnas
-- y la opción del ejecutor se quedan (el "ver qué haría ahora" de la pantalla
-- sigue usando `forzarSombra` para no tocar Meta), pero ninguna regla vuelve a
-- estar en sombra y el interruptor global queda apagado.
--
-- OJO: una regla que estaba PRENDIDA y en sombra pasa a actuar de verdad.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE ad_rules
  ADD COLUMN IF NOT EXISTS grupo uuid NOT NULL DEFAULT gen_random_uuid();

COMMENT ON COLUMN ad_rules.grupo IS
  'La regla general a la que pertenece esta fila. Una fila por cuenta; todas las filas de un grupo comparten configuración (la escribe /api/ads/reglas).';

-- Una cuenta aparece una sola vez por regla general.
CREATE UNIQUE INDEX IF NOT EXISTS ad_rules_grupo_cuenta_unico ON ad_rules (grupo, account_id);

UPDATE ad_rules SET dry_run = false WHERE dry_run;
ALTER TABLE ad_rules ALTER COLUMN dry_run SET DEFAULT false;

UPDATE settings SET value = 'false'::jsonb WHERE key = 'ads_rules_force_dry_run';
