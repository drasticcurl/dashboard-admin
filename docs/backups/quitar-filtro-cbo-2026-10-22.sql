-- Saca el filtro «no contiene CBO» que el 2026-10-22 se les puso a las 68 filas
-- de ad_rules (las 23 reglas R01–R23, en Gelxiin, HIlvanapp y Tarot astro).
-- Antes de ese día ninguna regla filtraba por nombre: vuelven a name_filter NULL
-- y al modo por defecto. `ad_rules-2026-10-22.csv` es la foto completa de
-- ad_rules justo antes del cambio.
-- Uso: sudo -u postgres psql -d panel -v ON_ERROR_STOP=1 -f quitar-filtro-cbo-2026-10-22.sql
BEGIN;
UPDATE ad_rules
   SET name_filter = NULL, name_filter_mode = 'contains', updated_at = now()
 WHERE name_filter = 'CBO' AND name_filter_mode = 'not_contains';
SELECT name_filter, name_filter_mode, count(*) FROM ad_rules GROUP BY 1, 2;
COMMIT;
