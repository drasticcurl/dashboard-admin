-- ═══════════════════════════════════════════════════════════════════════════
-- 038 — El test de estética de chauhinchazon cambia de brazo B: sale "Ritual"
--       (perdió, apagado el 2026-09-30) y entra "Original +" (el quiz de siempre
--       con efectos al tocar; plan testfunnel/.kiro/specs/estetica-original-plus).
--
-- Cada sesión de /quiz viaja con `experiment` = 'estetica_original' | 'estetica_plus'.
-- Mismos dos motivos que la 035 para declararlo:
--  1. Un valor no declarado se guarda igual pero suma `unknown_experiment` a
--     `ingest_errors` en cada lote (el banner del embudo gritaría con datos sanos).
--  2. `CardTestEstetica` arma sus brazos con los `estetica_*` DECLARADOS: si
--     'estetica_ritual' siguiera declarado, la card mostraría tres brazos y
--     avisaría "muestra chica" para siempre por el brazo muerto.
--
-- Por eso en chauhinchazon se SACA 'estetica_ritual' y se SUMA 'estetica_plus'.
-- Las sesiones históricas de Ritual quedan en la base: `apply.ts` no revalida lo
-- ya guardado, y la card las muestra como fila fuera del test si el rango las toca.
-- chauhinchazon-latam ya no recibe tráfico: solo se le saca 'estetica_ritual'.
--
-- IDEMPOTENTE: array_remove no falla si no está, y la suma tiene su guarda.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE funnels
   SET experiments = array_remove(experiments, 'estetica_ritual')
 WHERE slug IN ('chauhinchazon', 'chauhinchazon-latam');

UPDATE funnels
   SET experiments = array_cat(experiments, ARRAY['estetica_plus']::text[])
 WHERE slug = 'chauhinchazon'
   AND NOT ('estetica_plus' = ANY(experiments));
