-- ═══════════════════════════════════════════════════════════════════════════
-- 020 — Dimensión del experimento A/B del pop-up (spec ab-test-popup-descuento).
--
-- Columna SEPARADA de `variant`, no un valor nuevo dentro de ella: `variant`
-- significa país (ar/latam) y alimenta el selector de filtros y la card
-- `Variantes`. Meter A/B ahí duplicaría cada país y rompería ese filtro.
--
-- Nullable y SIN default, a propósito: NULL significa "esta sesión no
-- participó del experimento", y tiene que ser distinguible de cualquier valor
-- asignado. Con un default tipo 'default' (como hizo `variant`) las sesiones
-- históricas y las de los funnels que no testean entrarían al desglose como si
-- fueran una variante más.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS experiment text;

-- Conjunto de valores declarados por funnel, espejo de `funnels.variants`.
-- Vacío = no se valida nada (default permisivo, igual que PANEL_INGEST_HOSTS):
-- un funnel que no testea no tiene por qué empezar a gritar `unknown_experiment`.
ALTER TABLE funnels ADD COLUMN IF NOT EXISTS experiments text[] NOT NULL DEFAULT '{}';

UPDATE funnels SET experiments = ARRAY['A','B'] WHERE slug = 'chauhinchazon';

-- SIN índice nuevo. El desglose es un GROUP BY sobre el MISMO conjunto filtrado
-- que el resto del embudo ya escanea (funnel_id + rango de day), que
-- `sessions_funnel_day_idx` ya cubre. Un índice sobre (funnel_id, day,
-- experiment) solo pagaría si algún día se filtra POR experimento (un `?exp=`
-- en la vista); mientras el experimento sea una dimensión de salida y no de
-- entrada, sería un índice que se mantiene en cada insert y no se usa nunca.
