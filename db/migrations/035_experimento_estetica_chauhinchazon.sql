-- ═══════════════════════════════════════════════════════════════════════════
-- 035 — Declarar los brazos del test A/B de ESTÉTICA del quiz en los dos
--       funnels de chauhinchazon (AR y LATAM).
--
-- El funnel (testfunnel, plan .kiro/specs/estetica-ritual-ab) reparte a quienes
-- entran a /quiz y /latam entre el quiz de siempre y el mismo quiz con la
-- estética "Ritual" (mismas preguntas, misma venta, mismo checkout; música,
-- sonidos y animaciones nuevas). Cada sesión viaja con `experiment` =
-- 'estetica_original' | 'estetica_ritual'.
--
-- Dos motivos para declararlos, los dos observables:
--  1. `lib/ingest/apply.ts` guarda igual un valor no declarado (D20: no se
--     descarta nada), pero suma un `unknown_experiment:estetica_ritual` a
--     `ingest_errors` en CADA lote: el banner del embudo gritaría con datos
--     sanos, que es exactamente lo que arregló la 027 para el pitch.
--  2. `CardTestEstetica` se muestra solo si el funnel DECLARA brazos
--     `estetica_*` (`debeMostrarCardEstetica`). Sin esto la card no aparece.
--
-- SE SUMAN, NO SE REEMPLAZAN: 'A', 'B', 'pitch_A' y 'pitch_B' se quedan (son
-- los valores de las sesiones históricas; mismo criterio que la 027).
--
-- IDEMPOTENTE: la guarda `NOT ('estetica_ritual' = ANY(experiments))` hace que
-- la segunda corrida no duplique. `array_cat` y no `||` con un literal
-- sin tipo, para que Postgres no tenga que adivinar el tipo del arreglo.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE funnels
   SET experiments = array_cat(experiments, ARRAY['estetica_original', 'estetica_ritual']::text[])
 WHERE slug IN ('chauhinchazon', 'chauhinchazon-latam')
   AND NOT ('estetica_ritual' = ANY(experiments));
