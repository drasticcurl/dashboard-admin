-- ═══════════════════════════════════════════════════════════════════════════
-- 021 — Una cuenta publicitaria por regla.
--
-- EL PROBLEMA QUE RESUELVE
-- `ad_rules.account_ids text[]` permite expresar un alcance sobre dos cuentas en
-- zonas horarias distintas, y ese alcance NO SE PUEDE EVALUAR: "hoy" no es uno
-- solo y la ventana horaria no tiene una hora local única. Las 6 reglas del seed
-- de la 016 quedaron con `account_ids = '{}'` ("todas las cuentas activas"),
-- alcanzan a act_2501344510302910 (Europe/Lisbon) y act_2120381458824082
-- (America/Argentina/Buenos_Aires), y por eso ninguna corría: getMetricasAds
-- tiraba 'zonas horarias mezcladas' y la corrida cerraba con 0 objetos.
--
-- POR QUÉ SE EXPANDE EN DATOS Y NO EN RUNTIME
-- Hacer que el ejecutor itere por cuenta obligaría a agregarle `account_id` a
-- `ad_rule_runs` y a redefinir `max_runs_per_day` y la cadencia, que hoy se
-- cuentan por `rule_id`. Con una cuenta por regla los tres frenos siguen
-- significando lo mismo y no se agrega ninguna columna de auditoría.
--
-- POR QUÉ DUPLICA Y CONSERVA EL NOMBRE
-- Elegir una cuenta por regla dejaría a la otra cuenta sin automatización, en
-- silencio. Y el nombre no se toca porque `ad_actions.rule_name` está
-- desnormalizado a propósito (016 §3): renombrar rompe la lectura de meses de
-- historial. Dos reglas pueden compartir nombre en cuentas distintas, y para eso
-- el único de `name` pasa a ser único de `(account_id, name)`.
--
-- LO QUE ESTA MIGRACIÓN NO HACE: no prende nada. Todas las reglas quedan en
-- `enabled = false` y `dry_run = true`, como cualquier regla recién creada
-- (D-A12). Prenderlas es un acto explícito desde el panel.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. La columna nueva, todavía nullable ─────────────────────────────────
-- Nullable primero porque la tabla tiene filas: un NOT NULL directo necesitaría
-- un DEFAULT, y un default de account_id sería una cuenta inventada.
ALTER TABLE ad_rules
  ADD COLUMN IF NOT EXISTS account_id text;

COMMENT ON COLUMN ad_rules.account_id IS
  'La ÚNICA cuenta publicitaria que esta regla alcanza. Una regla = una cuenta = una zona horaria.';

-- ── 2. El único de `name` se va ANTES del backfill ────────────────────────
-- El backfill inserta reglas que comparten `name` con su origen: con este índice
-- vivo, la primera duplicación falla. El único nuevo se crea en el paso 4.
DROP INDEX IF EXISTS ad_rules_name_unico;

-- ── 3. Backfill: una regla por cuenta, con las condiciones copiadas ───────
DO $backfill$
DECLARE
  r        ad_rules;
  destinos text[];
  huerfano record;
  nueva_id integer;
  i        integer;
BEGIN
  -- Guarda de idempotencia (R3 c1): si `account_ids` ya no existe, el backfill
  -- ya corrió. Nada de esto se repite, y en particular NO se vuelve a apagar lo
  -- que el usuario prendió después de migrar.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'ad_rules' AND column_name = 'account_ids'
  ) THEN
    RAISE NOTICE '021: ad_rules.account_ids ya no existe; el backfill ya corrió y no se repite';
    RETURN;
  END IF;

  -- R2 c9: sin cuentas activas no hay a qué cuenta asignar las reglas de alcance
  -- amplio. Se aborta la transacción completa y se nombra la condición faltante.
  -- OJO EN UNA BASE NUEVA: la 016 seedea 6 reglas con account_ids = '{}', así
  -- que hay que cargar las cuentas (Config → Publicidad, o scripts/sync-ads.ts)
  -- ANTES de migrar. Ver la secuencia de deploy del design.
  IF NOT EXISTS (SELECT 1 FROM ad_accounts WHERE active AND platform = 'meta') THEN
    RAISE EXCEPTION
      '021 abortada: no existe ninguna Cuenta_Activa (ad_accounts.active = true AND platform = ''meta''). '
      'Cargá las cuentas publicitarias antes de correr esta migración.';
  END IF;

  -- R2 c10: un id en account_ids que no existe en ad_accounts es un dato roto.
  -- Se aborta nombrando el id Y el name de la regla, que es lo que hace falta
  -- para arreglarlo a mano.
  FOR huerfano IN
    SELECT r2.name, x.account_id
      FROM ad_rules r2, unnest(r2.account_ids) AS x(account_id)
     WHERE NOT EXISTS (SELECT 1 FROM ad_accounts a WHERE a.account_id = x.account_id)
  LOOP
    RAISE EXCEPTION
      '021 abortada: la regla «%» tiene en account_ids el id «%», que no existe en ad_accounts',
      huerfano.name, huerfano.account_id;
  END LOOP;

  FOR r IN SELECT * FROM ad_rules WHERE account_id IS NULL ORDER BY id LOOP
    -- Las cuentas destino de ESTA regla, en orden alfabético:
    --   account_ids = '{}'  → todas las Cuenta_Activa
    --   account_ids = {…}   → esos ids (ya verificados existentes)
    SELECT array_agg(a.account_id ORDER BY a.account_id)
      INTO destinos
      FROM ad_accounts a
     WHERE (cardinality(r.account_ids) = 0 AND a.active AND a.platform = 'meta')
        OR a.account_id = ANY (r.account_ids);

    IF destinos IS NULL OR cardinality(destinos) = 0 THEN
      RAISE EXCEPTION '021 abortada: la regla «%» no resolvió ninguna cuenta destino', r.name;
    END IF;

    -- R2 c4 y c5: el `id` se conserva para el PRIMER destino en orden
    -- alfabético. Con un solo elemento en account_ids, es ese mismo. El orden
    -- alfabético hace el backfill determinista: "¿qué regla se quedó con el id
    -- 3?" tiene una respuesta que no depende del orden de un array.
    UPDATE ad_rules SET account_id = destinos[1] WHERE id = r.id;

    -- El resto: una fila nueva por cuenta, con TODA la configuración copiada sin
    -- modificación (R2 c1) y el mismo `name` (R2 c3).
    FOR i IN 2 .. cardinality(destinos) LOOP
      INSERT INTO ad_rules (
        name, enabled, dry_run, account_id, level, status_filter, name_filter,
        name_filter_mode, action, action_value, action_unit, budget_max, budget_min,
        period, metrics_level, every_minutes, window_start, window_end,
        max_runs_per_day, cooldown_minutes, max_actions_per_object_per_day
      ) VALUES (
        r.name, false, true, destinos[i], r.level, r.status_filter, r.name_filter,
        r.name_filter_mode, r.action, r.action_value, r.action_unit, r.budget_max, r.budget_min,
        r.period, r.metrics_level, r.every_minutes, r.window_start, r.window_end,
        r.max_runs_per_day, r.cooldown_minutes, r.max_actions_per_object_per_day
      )
      RETURNING id INTO nueva_id;

      -- R2 c2: las condiciones se copian con metric, op, value y position. Sin
      -- esto, una regla derivada sin condiciones «se aplica a todo».
      INSERT INTO ad_rule_conditions (rule_id, metric, op, value, position)
      SELECT nueva_id, c.metric, c.op, c.value, c.position
        FROM ad_rule_conditions c
       WHERE c.rule_id = r.id
       ORDER BY c.position;
    END LOOP;
  END LOOP;

  -- R2 c6: la migración no prende nada. Está DENTRO de la guarda a propósito:
  -- una segunda ejecución no puede apagar lo que el usuario prendió después.
  UPDATE ad_rules SET enabled = false, dry_run = true
   WHERE enabled OR NOT dry_run;
END
$backfill$;

-- ── 4. Las restricciones, después del backfill ────────────────────────────
-- SET NOT NULL es idempotente: si ya está, no hace nada.
ALTER TABLE ad_rules ALTER COLUMN account_id SET NOT NULL;

-- R1 c4: NOT NULL no alcanza; la cadena vacía también es un alcance inválido.
-- El FK igual la rechazaría (no hay cuenta ''), pero este CHECK falla antes y
-- con un nombre legible. DROP + ADD porque ADD CONSTRAINT no tiene IF NOT EXISTS.
ALTER TABLE ad_rules
  DROP CONSTRAINT IF EXISTS ad_rules_cuenta_no_vacia,
  ADD  CONSTRAINT ad_rules_cuenta_no_vacia CHECK (btrim(account_id) <> '');

-- R1 c5 y c6: la cuenta tiene que existir, y borrar una cuenta con reglas se
-- RECHAZA. No es CASCADE: borrar una cuenta no puede borrar en silencio la
-- automatización que la operaba. No es SET NULL: la columna es NOT NULL.
-- ON UPDATE CASCADE porque el account_id de Meta es la PK natural: si alguna vez
-- se corrige el prefijo de un id, las reglas lo siguen.
ALTER TABLE ad_rules
  DROP CONSTRAINT IF EXISTS ad_rules_cuenta_fk,
  ADD  CONSTRAINT ad_rules_cuenta_fk
       FOREIGN KEY (account_id) REFERENCES ad_accounts(account_id)
       ON UPDATE CASCADE ON DELETE RESTRICT;

-- R1 c2: el único pasa de (name) a (account_id, name). Dos reglas pueden
-- llamarse igual en cuentas distintas —el backfill depende de eso— y no pueden
-- llamarse igual dentro de la misma cuenta, que es lo que hace que
-- «¿qué pausó esto?» siga teniendo respuesta leyendo ad_actions.rule_name.
CREATE UNIQUE INDEX IF NOT EXISTS ad_rules_cuenta_name_unico ON ad_rules (account_id, name);

-- La lista del panel agrupa por cuenta y el ejecutor lee por cuenta.
CREATE INDEX IF NOT EXISTS ad_rules_cuenta_idx ON ad_rules (account_id);

-- ── 5. account_ids se va ──────────────────────────────────────────────────
-- R1 c3: information_schema no puede seguir devolviendo esta columna. Dejarla
-- "por si acaso" es dejar dos fuentes de verdad para el alcance de una regla, que
-- es exactamente el estado que causó el bug.
ALTER TABLE ad_rules DROP COLUMN IF EXISTS account_ids;
