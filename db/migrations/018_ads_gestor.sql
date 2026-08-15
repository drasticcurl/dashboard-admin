-- ═══════════════════════════════════════════════════════════════════════════
-- 018 — Gestor de campañas: acciones nuevas, métricas de creativo,
--       métricas de rango, datos de DSA y programación, y Vistas.
--
-- CORRE SOBRE DATOS VIVOS. El panel está en producción con ventas reales y con
-- el motor de reglas escribiendo en ad_actions. Todo acá es ADITIVO: ninguna
-- columna se borra, ninguna tabla se reescribe, ningún tipo cambia. La segunda
-- corrida no hace nada.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Vocabulario_Acciones: tres valores nuevos (R15 c2)
-- ───────────────────────────────────────────────────────────────────────────
-- El CHECK se reemplaza por un SUPERCONJUNTO: las filas que ya existen validan
-- contra la lista nueva, así que el ALTER no puede fallar por datos previos.
-- Se hace en dos pasos y con IF EXISTS para que sea idempotente.
ALTER TABLE ad_actions DROP CONSTRAINT IF EXISTS ad_actions_action_valida;
ALTER TABLE ad_actions ADD  CONSTRAINT ad_actions_action_valida CHECK (action IN (
  'pause', 'activate', 'budget_increase', 'budget_decrease', 'budget_set', 'config',
  'duplicate', 'rename', 'schedule'
));

-- El filtro por acción del Historial (R15 c7) y la columna "Últ. actualización"
-- sobre todo el vocabulario (R15 c9).
CREATE INDEX IF NOT EXISTS ad_actions_accion_idx
  ON ad_actions (action, created_at DESC);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Métricas de video en ad_spend (R7 c4)
-- ───────────────────────────────────────────────────────────────────────────
-- NULLABLE Y SIN DEFAULT, a propósito. NULL significa "la Marketing API no
-- devolvió el campo para esta fila" y se dibuja `—`; 0 significa "devolvió
-- cero" y se dibuja `0`. Con NOT NULL DEFAULT 0 los dos casos serían el mismo
-- número y R7 c8 / c14 pedirían distinguir lo indistinguible.
--
-- Los seis son CONTEOS ADITIVOS entre días: se suman por período (R7 c4). Esa
-- es la diferencia con el alcance, que tiene tabla propia (§4).
ALTER TABLE ad_spend
  ADD COLUMN IF NOT EXISTS video_plays    bigint,
  ADD COLUMN IF NOT EXISTS video_thruplay bigint,
  ADD COLUMN IF NOT EXISTS video_p25      bigint,
  ADD COLUMN IF NOT EXISTS video_p50      bigint,
  ADD COLUMN IF NOT EXISTS video_p75      bigint,
  ADD COLUMN IF NOT EXISTS video_p100     bigint;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. DSA y programación en la jerarquía (P-G01, R11 c8)
-- ───────────────────────────────────────────────────────────────────────────
-- dsa_payor / dsa_beneficiary los llena una lectura BEST-EFFORT separada de
-- fetchAdSets: si esos campos no son legibles en la versión configurada de la
-- API, el sync de la jerarquía no puede caerse por eso (la jerarquía es el
-- inventario). dsa_checked_at NULL = nunca se pudo verificar, y el preflight
-- lo informa como inconcluso en lugar de afirmar que falta el dato.
ALTER TABLE ad_sets
  ADD COLUMN IF NOT EXISTS start_time      timestamptz,
  ADD COLUMN IF NOT EXISTS end_time        timestamptz,
  ADD COLUMN IF NOT EXISTS dsa_payor       text,
  ADD COLUMN IF NOT EXISTS dsa_beneficiary text,
  ADD COLUMN IF NOT EXISTS dsa_checked_at  timestamptz;

-- Una campaña también puede llevar inicio programado.
ALTER TABLE ad_campaigns
  ADD COLUMN IF NOT EXISTS start_time timestamptz,
  ADD COLUMN IF NOT EXISTS end_time   timestamptz;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Metricas_Rango: alcance y frecuencia (P-G07, R7 c5, c6)
-- ───────────────────────────────────────────────────────────────────────────
-- POR QUÉ NO VA EN ad_spend
-- El alcance NO ES ADITIVO entre días: sumar el alcance de dos días cuenta dos
-- veces a la misma persona. ad_spend guarda una fila por día, así que ahí el
-- alcance sería un número que siempre miente. Acá el RANGO es parte de la
-- clave, y la pantalla sólo puede mostrar un número cuando pide exactamente el
-- rango que está guardado. Si no coincide, muestra `—`. Preferimos una columna
-- que a veces dice `—` antes que una que siempre miente.
--
-- POR QUÉ level ESTÁ EN LA CLAVE
-- El alcance de una campaña TAMPOCO es la suma del de sus conjuntos: las mismas
-- personas pueden estar alcanzadas por dos conjuntos. Cada nivel se pide y se
-- guarda por separado.
CREATE TABLE IF NOT EXISTS ad_alcance (
  platform    text NOT NULL DEFAULT 'meta',
  account_id  text NOT NULL REFERENCES ad_accounts(account_id) ON DELETE CASCADE,
  level       text NOT NULL,
  object_id   text NOT NULL,
  date_from   date NOT NULL,
  date_to     date NOT NULL,
  reach       bigint,
  impressions bigint,
  -- La frecuencia que informa Meta para el rango. Se guarda además de
  -- derivarla de impresiones/alcance porque los dos números pueden diferir en
  -- el último decimal y el que vale es el de Meta.
  frequency   numeric(12,4),
  synced_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, account_id, level, object_id, date_from, date_to),
  CONSTRAINT ad_alcance_level_valido CHECK (level IN ('campaign', 'adset', 'ad')),
  CONSTRAINT ad_alcance_rango_valido CHECK (date_from <= date_to)
);

-- El JOIN de la query de métricas: por cuenta, nivel y rango exacto.
CREATE INDEX IF NOT EXISTS ad_alcance_rango_idx
  ON ad_alcance (account_id, level, date_from, date_to);

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Settings nuevos
-- ───────────────────────────────────────────────────────────────────────────
-- ads_vistas: el Repo_Vistas. 'null' y {"v":1,"vistas":[],"porDefecto":null}
-- son DOS ESTADOS DISTINTOS: null es "nunca se guardó" y dispara el fallback de
-- R3 c9; el array vacío es "se guardó sin ninguna Vista" y se respeta. Misma
-- lección que ui_layout_* de la 017.
--
-- ads_max_objetos_cuenta: el tope de objetos por cuenta publicitaria, para el
-- preflight de duplicación (P-G06). null = DESCONOCIDO, no "sin límite": el
-- límite real depende del tier de la cuenta y no está medido. Con null el
-- preflight informa 'desconocido' y la autoridad es el rechazo de Meta.
INSERT INTO settings (key, value) VALUES
  ('ads_vistas',             'null'::jsonb),
  ('ads_max_objetos_cuenta', 'null'::jsonb)
ON CONFLICT (key) DO NOTHING;
