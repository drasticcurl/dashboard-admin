-- ═══════════════════════════════════════════════════════════════════════════
-- Verificación del estado que deja la migración 021 (una cuenta por regla).
--
-- Se corre DESPUÉS de aplicar la 021, en la base de descarte del ensayo
-- (task 13.3 de la spec reglas-anuncios-por-cuenta) y en producción para la
-- verificación en caliente:
--   docker exec -i panel-db-1 psql -U panel -d panel -v ON_ERROR_STOP=1 \
--     < tasks/anuncios/_verificacion-021.sql
--
-- Sirve para las DOS corridas de la 021 del ensayo (la segunda tiene que dar
-- exactamente lo mismo que la primera) y para verificar la re-ejecución de la
-- 016: corré este archivo, re-corré `psql -f db/migrations/016_ads_gestion.sql`
-- y corré este archivo de nuevo.
--
-- OJO CON QUÉ PRUEBA ESTE ARCHIVO Y QUÉ NO.
-- Los bloques 1 a 5 tiran una excepción si fallan, así que "corrió sin error
-- hasta el ROLLBACK" es una afirmación real sobre ellos. Los bloques 6 y 7 sólo
-- IMPRIMEN, y su \echo dice qué se espera: hay que LEER la salida y compararla.
--
-- El bloque 8 es el caso preparado del modo (b) de la 016: una regla homónima
-- SIN condiciones en la otra cuenta que tiene que seguir sin condiciones
-- después de re-correr la 016. Su preparación (8a) BORRA condiciones y corre
-- FUERA del ROLLBACK, o sea que PERSISTE: usala SOLO en la base de descarte y
-- SOLO con `-v PREPARAR_MODO_B=1`. JAMÁS en producción.
-- ═══════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

-- El interruptor de la preparación del modo (b). Vale 0 salvo que lo pases con
-- `-v PREPARAR_MODO_B=1` al psql.
\if :{?PREPARAR_MODO_B}
\else
  \set PREPARAR_MODO_B 0
\endif

BEGIN;

\echo '═══ 1. account_ids desapareció de information_schema ═══'
\echo 'R1 c3: la columna vieja de alcance no puede seguir existiendo. Dejarla'
\echo '"por si acaso" es dejar dos fuentes de verdad para el alcance de una regla.'
\echo 'esperado: 0 filas'
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name = 'ad_rules' AND column_name = 'account_ids';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FALLO: ad_rules.account_ids sigue existiendo (% filas en information_schema.columns)', n;
  END IF;
  RAISE NOTICE 'OK — ad_rules.account_ids no existe en information_schema (0 filas)';
END $$;

\echo ''
\echo '═══ 2. account_id es NOT NULL y rechaza la cadena vacía ═══'
\echo 'R1 c1 y c4: la cuenta es obligatoria. NOT NULL no alcanza: la cadena vacía'
\echo 'también es un alcance inválido, y el CHECK ad_rules_cuenta_no_vacia la'
\echo 'rechaza con un nombre legible antes de que lo haga el FK.'
\echo 'esperado: NOT NULL + CHECK ad_rules_cuenta_no_vacia presentes'
DO $$
DECLARE
  not_null integer;
  chk      integer;
BEGIN
  SELECT count(*) INTO not_null FROM information_schema.columns
   WHERE table_name = 'ad_rules' AND column_name = 'account_id' AND is_nullable = 'NO';
  IF not_null <> 1 THEN
    RAISE EXCEPTION 'FALLO: ad_rules.account_id no es NOT NULL (filas que cumplen: %)', not_null;
  END IF;

  SELECT count(*) INTO chk
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid AND t.relname = 'ad_rules'
   WHERE c.contype = 'c' AND c.conname = 'ad_rules_cuenta_no_vacia';
  IF chk <> 1 THEN
    RAISE EXCEPTION 'FALLO: falta el CHECK ad_rules_cuenta_no_vacia';
  END IF;

  RAISE NOTICE 'OK — account_id es NOT NULL y el CHECK ad_rules_cuenta_no_vacia está';
END $$;

\echo ''
\echo '═══ 3. El FK apunta a ad_accounts y con ON DELETE RESTRICT ═══'
\echo 'R1 c5 y c6: la cuenta tiene que existir, y borrar una cuenta con reglas se'
\echo 'RECHAZA (RESTRICT, no CASCADE: borrar una cuenta no puede borrar en silencio'
\echo 'la automatización que la operaba). ON UPDATE CASCADE porque el account_id de'
\echo 'Meta es la PK natural: si se corrige el prefijo de un id, las reglas lo siguen.'
\echo 'esperado: FK sobre account_id con confdeltype = r y confupdtype = c'
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid AND t.relname = 'ad_rules'
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attname = 'account_id'
   WHERE c.contype = 'f'
     AND c.confrelid = to_regclass('ad_accounts')
     AND c.confdeltype = 'r'
     AND c.confupdtype = 'c'
     AND a.attnum = ANY (c.conkey);
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALLO: el FK de ad_rules.account_id a ad_accounts con ON DELETE RESTRICT y ON UPDATE CASCADE no existe (coincidencias: %)', n;
  END IF;
  RAISE NOTICE 'OK — el FK existe, apunta a ad_accounts y borrar una cuenta con reglas se rechaza';
END $$;

\echo ''
\echo '═══ 4. El único (account_id, name) está; el único (name) no ═══'
\echo 'R1 c2: dos reglas pueden llamarse igual en cuentas distintas (el backfill'
\echo 'depende de eso) y no pueden llamarse igual dentro de la misma cuenta, que es'
\echo 'lo que hace que "qué pausó esto?" siga teniendo respuesta leyendo'
\echo 'ad_actions.rule_name. También se verifica el índice de soporte por cuenta.'
\echo 'esperado: ad_rules_cuenta_name_unico UNIQUE sobre (account_id, name),'
\echo '          ad_rules_name_unico inexistente, ad_rules_cuenta_idx presente'
DO $$
DECLARE
  nuevo   integer;
  cols    integer;
  viejo   integer;
  soporte integer;
BEGIN
  SELECT count(*) INTO nuevo
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid AND t.relname = 'ad_rules'
   WHERE i.indisunique
     AND i.indexrelid = to_regclass('ad_rules_cuenta_name_unico');
  IF nuevo <> 1 THEN
    RAISE EXCEPTION 'FALLO: el índice ad_rules_cuenta_name_unico no existe o no es UNIQUE (filas: %)', nuevo;
  END IF;

  SELECT count(*) INTO cols
    FROM pg_attribute a
   WHERE a.attrelid = to_regclass('ad_rules_cuenta_name_unico')
     AND a.attnum > 0
     AND a.attname IN ('account_id', 'name');
  IF cols <> 2 THEN
    RAISE EXCEPTION 'FALLO: ad_rules_cuenta_name_unico no cubre exactamente (account_id, name) (columnas: %)', cols;
  END IF;

  SELECT count(*) INTO viejo FROM pg_class WHERE relname = 'ad_rules_name_unico';
  IF viejo <> 0 THEN
    RAISE EXCEPTION 'FALLO: el único viejo ad_rules_name_unico sigue existiendo';
  END IF;

  SELECT count(*) INTO soporte
    FROM pg_class t
   WHERE t.relname = 'ad_rules_cuenta_idx'
     AND t.relkind = 'i';
  IF soporte <> 1 THEN
    RAISE EXCEPTION 'FALLO: falta el índice de soporte ad_rules_cuenta_idx';
  END IF;

  RAISE NOTICE 'OK — único (account_id, name) presente y (name) ausente';
END $$;

\echo ''
\echo '═══ 5. Los conteos del backfill: 12 reglas, 30 condiciones ═══'
\echo 'R2 c8: las 6 del seed se duplicaron en las 2 Cuenta_Activa, y sus 15'
\echo 'condiciones quedaron en 30. Si preparaste el modo (b) del bloque 8, el'
\echo 'esperado de condiciones es 28 (la regla preparada quedó sin las suyas).'
\echo 'esperado: 12 reglas · 30 condiciones (o 28 con el modo (b) preparado)'
DO $$
DECLARE
  reglas      integer;
  condiciones integer;
  esperadas   integer;
BEGIN
  SELECT count(*) INTO reglas FROM ad_rules;
  SELECT count(*) INTO condiciones FROM ad_rule_conditions;

  IF reglas <> 12 THEN
    RAISE EXCEPTION 'FALLO: se esperaban 12 reglas (6 del seed × 2 cuentas) y hay %', reglas;
  END IF;

  esperadas := 30;
  IF EXISTS (
    SELECT 1 FROM ad_rules
     WHERE last_run_error = '021-verif: regla preparada para el modo (b) de la 016'
  ) THEN
    esperadas := 28;
  END IF;

  IF condiciones <> esperadas THEN
    RAISE EXCEPTION 'FALLO: se esperaban % condiciones y hay %', esperadas, condiciones;
  END IF;

  RAISE NOTICE 'OK — % reglas y % condiciones (esperado: 12 y %)', reglas, condiciones, esperadas;
END $$;

\echo ''
\echo '═══ 6. Nada quedó prendido ni fuera de sombra ═══'
\echo 'R2 c6: la migración no prende nada. Este bloque IMPRIME y no tira excepción'
\echo 'a propósito: en la segunda corrida del ensayo el paso 13.3 te pide prender'
\echo 'una regla a mano para probar que la 021 no la apaga, y entonces acá tiene'
\echo 'que verse 1 en la columna prendidas.'
\echo 'esperado: 0 | 0 recién migrado. Con una regla prendida a mano entre las dos'
\echo 'corridas de la 021: prendidas = 1, y esa regla TIENE que seguir prendida'
\echo 'después de la segunda corrida.'
SELECT
  count(*) FILTER (WHERE enabled)     AS prendidas,
  count(*) FILTER (WHERE NOT dry_run) AS fuera_de_sombra
FROM ad_rules;

\echo ''
\echo '═══ 7. ad_actions y ad_rule_runs no cambiaron ═══'
\echo 'R2 c7: la 021 no toca estas dos tablas. Compará los dos números contra los'
\echo 'conteos de referencia N y M que anotaste en el paso 13.1: tienen que ser'
\echo 'IGUALES en las dos corridas del ensayo y en la verificación en caliente.'
\echo 'esperado: N y M del paso 13.1, sin cambios'
SELECT
  (SELECT count(*) FROM ad_actions)   AS ad_actions,
  (SELECT count(*) FROM ad_rule_runs) AS ad_rule_runs;

\echo ''
\echo '═══ Todo lo de arriba corrió dentro de una transacción. Se descarta. ═══'
ROLLBACK;

\echo ''
\echo '═══ 8. El modo (b) de la 016: una regla homónima SIN condiciones ═══'
\echo 'Después de la 021, el bloque de condiciones del seed de la 016 matchea por'
\echo 'c.rule_name = r.name, y ese join alcanza a MÁS de una regla cuando dos'
\echo 'comparten nombre en cuentas distintas. Hoy la protege el NOT EXISTS del seed'
\echo 'y, sobre todo, la guarda de la 016; sin la guarda, una regla creada desde el'
\echo 'panel con el nombre de una del seed y SIN condiciones recibiría las del seed'
\echo 'al re-correr la 016. Este bloque lo prueba sobre la regla duplicada.'
\echo ''

\if :PREPARAR_MODO_B
\echo '── 8a. Preparación (pasa SOLO con -v PREPARAR_MODO_B=1) ──'
\echo 'OJO: este DO borra condiciones y corre FUERA del ROLLBACK de arriba:'
\echo 'PERSISTE. Es para la base de descarte del ensayo. JAMÁS en producción.'
DO $prepara$
DECLARE
  objetivo record;
  marcada  integer;
  borradas integer;
BEGIN
  -- La regla duplicada de ese nombre: el backfill conservó el id original para
  -- la primera cuenta (orden alfabético) y creó una copia nueva para la otra,
  -- así que la copia es la de id más alto.
  SELECT r.id, r.name, r.account_id INTO objetivo
    FROM ad_rules r
   WHERE r.name = 'Apagar - Gasto +$4 sin ventas'
   ORDER BY r.id DESC
   LIMIT 1;

  IF objetivo.id IS NULL THEN
    RAISE EXCEPTION '8a: no existe la regla «Apagar - Gasto +$4 sin ventas»; esta base no es la del ensayo';
  END IF;

  -- La marca en last_run_error es lo que les permite a los bloques 5 y 8b
  -- distinguir el estado preparado del estado limpio aunque la 016 (sin guarda)
  -- devuelva las condiciones que se le quitaron acá: sin la marca, un seed roto
  -- deja la base idéntica a la limpia y nada lo delata.
  SELECT count(*) INTO marcada FROM ad_rules
   WHERE last_run_error = '021-verif: regla preparada para el modo (b) de la 016';

  IF marcada > 0 THEN
    RAISE NOTICE '8a: ya hay una regla preparada; no hago nada.';
  ELSE
    DELETE FROM ad_rule_conditions WHERE rule_id = objetivo.id;
    GET DIAGNOSTICS borradas = ROW_COUNT;
    UPDATE ad_rules
       SET last_run_error = '021-verif: regla preparada para el modo (b) de la 016'
     WHERE id = objetivo.id;
    RAISE NOTICE '8a: la regla «%» (id %, cuenta %) quedó sin condiciones (% borradas). Este cambio PERSISTE.',
      objetivo.name, objetivo.id, objetivo.account_id, borradas;
  END IF;
END $prepara$;

\echo ''
\echo 'AHORA, AFUERA DE ESTE ARCHIVO, corré en la MISMA base:'
\echo '  psql -f db/migrations/016_ads_gestion.sql'
\echo 'Tiene que terminar con el NOTICE de la guarda (seed salteado) y sin error.'
\echo 'Y después volvé a correr ESTE archivo SIN -v PREPARAR_MODO_B=1: el bloque'
\echo '8b afirma que la regla preparada sigue sin condiciones.'
\else
\echo '── 8a. Preparación salteada (PREPARAR_MODO_B=0) ──'
\echo 'Para preparar el caso del modo (b), corré este archivo con:'
\echo '  -v PREPARAR_MODO_B=1'
\endif

-- 8b. La verificación del modo (b). Corre siempre: si existe la regla marcada
-- por 8a, afirma que sigue sin condiciones; si no existe, avisa y no afirma.
DO $modo_b$
DECLARE
  objetivo record;
  n        integer;
BEGIN
  SELECT r.id, r.name, r.account_id INTO objetivo
    FROM ad_rules r
   WHERE r.last_run_error = '021-verif: regla preparada para el modo (b) de la 016'
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE NOTICE '8b: no hay regla preparada; nada que afirmar acá.';
    RETURN;
  END IF;

  SELECT count(*) INTO n FROM ad_rule_conditions WHERE rule_id = objetivo.id;

  IF n <> 0 THEN
    RAISE EXCEPTION 'FALLO modo (b): la regla «%» (cuenta %) recibió % condiciones al re-correr la 016; la guarda no está haciendo su trabajo',
      objetivo.name, objetivo.account_id, n;
  END IF;

  RAISE NOTICE 'OK modo (b): la regla «%» (cuenta %) sigue con 0 condiciones después de re-correr la 016',
    objetivo.name, objetivo.account_id;
END $modo_b$;
