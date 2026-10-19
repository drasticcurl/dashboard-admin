-- ═══════════════════════════════════════════════════════════════════════════
-- 042 — Test A/B de la estética del chat de almagemela (desde 2026-10-19).
--
-- La mitad de las sesiones del funnel argentino ve el chat de siempre, como
-- WhatsApp, y la otra mitad el mismo chat con estética mística violeta y
-- dorada (nuevo-quiz-funnel/lib/chat-test.ts). Cada sesión viaja con
-- `experiment` = 'chat_whatsapp' | 'chat_mistico' desde el primer paso del quiz.
-- Se declara por lo mismo que la 035: un valor no declarado se guarda igual
-- pero suma `unknown_experiment` a `ingest_errors` en cada lote, y
-- `CardTestChat` aparece cuando el funnel declara algún `chat_*`.
-- almagemela-latam no corre el test.
--
-- IDEMPOTENTE: cada suma tiene su guarda.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE funnels
   SET experiments = array_cat(experiments, ARRAY['chat_whatsapp']::text[])
 WHERE slug = 'almagemela'
   AND NOT ('chat_whatsapp' = ANY(experiments));

UPDATE funnels
   SET experiments = array_cat(experiments, ARRAY['chat_mistico']::text[])
 WHERE slug = 'almagemela'
   AND NOT ('chat_mistico' = ANY(experiments));
