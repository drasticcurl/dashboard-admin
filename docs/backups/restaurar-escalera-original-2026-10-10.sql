-- Vuelve R07–R10 (HIlvanapp y Tarot astro) a la vara de gasto ORIGINAL
-- (antes del 2026-10-10): 16 / 32 / 64 / 136. El resto de las reglas no cambió.
-- Los CSV de esta carpeta son la foto completa de ad_rules y ad_rule_conditions
-- del 2026-10-10 (ya con la vara en 8/16/32/68, el paso intermedio).
-- Uso: psql "$PGURL" -v ON_ERROR_STOP=1 -f restaurar-escalera-original-2026-10-10.sql
BEGIN;
UPDATE ad_rule_conditions c SET value = v.original
FROM (VALUES (139,16),(140,16),(142,32),(143,32),(145,64),(146,64),(148,136),(149,136)) v(rule_id,original)
WHERE c.rule_id = v.rule_id AND c.metric = 'spend';
UPDATE ad_rules r SET name = regexp_replace(r.name, 'gasto>=\d+', 'gasto>=' || v.original), updated_at = now()
FROM (VALUES (139,16),(140,16),(142,32),(143,32),(145,64),(146,64),(148,136),(149,136)) v(id,original)
WHERE r.id = v.id;
SELECT r.id, r.name, c.value FROM ad_rules r JOIN ad_rule_conditions c ON c.rule_id = r.id AND c.metric = 'spend'
WHERE r.id IN (139,140,142,143,145,146,148,149) ORDER BY r.id;
COMMIT;
