-- ═══════════════════════════════════════════════════════════════════════════
-- 019 — Alias de funnel: nombre para mostrar en el selector del panel.
--
-- CORRE SOBRE DATOS VIVOS. Aditiva e idempotente: la segunda corrida no hace
-- nada.
--
-- NULLABLE Y SIN DEFAULT, a propósito. NULL significa "sin alias, mostrar el
-- name real". Con NOT NULL DEFAULT '' la cadena vacía y "sin alias" serían el
-- mismo valor y no habría forma de distinguir "no configurado" de "configurado
-- en blanco".
--
-- El alias es SOLO presentación: `slug` sigue siendo la identidad del funnel en
-- las URLs, en el ingest y en las FKs. Cambiar un alias no puede romper un link.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE funnels
  ADD COLUMN IF NOT EXISTS alias text;
