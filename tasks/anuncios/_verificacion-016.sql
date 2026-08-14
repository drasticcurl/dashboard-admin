-- ═══════════════════════════════════════════════════════════════════════════
-- Verificación lógica del módulo de Anuncios.
--
-- Prueba las 14 afirmaciones que el plan hace y de las que dependen T14, T15,
-- T16 y T18. Se corrió completo contra un PostgreSQL 16 con las migraciones
-- 001-015 + `_schema-016.sql` aplicadas, y todo dio lo que dicen los \echo.
-- Rehecho después de la revisión técnica del 2026-08-12.
--
-- Correlo DESPUÉS de migrar:
--   docker exec -i panel-db-1 psql -U panel -d panel -v ON_ERROR_STOP=1 \
--     < tasks/anuncios/_verificacion-016.sql
--
-- Si algo no da lo que dice su \echo, el problema está en tu migración o en tu
-- query, no en el plan. No ajustes el plan para que cierre: encontrá la causa.
--
-- OJO CON QUÉ PRUEBA ESTE ARCHIVO Y QUÉ NO.
-- Los bloques 1, 2, 3, 10, 12 y 13 tiran una excepción si fallan, así que "corrió
-- sin error" es una afirmación real sobre ellos. Los demás sólo IMPRIMEN, y su
-- `\echo` dice qué se espera: hay que LEER la salida y compararla. Un archivo que
-- "corre en verde" no garantiza que los números impresos sean los esperados, y
-- ése es exactamente el agujero por el que la versión anterior de este archivo
-- tuvo durante semanas un §7 que contradecía a D-A9 sin que nadie lo notara.
-- ═══════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
BEGIN;

\echo '═══ 1. Una regla de subir presupuesto SIN techo tiene que ser rechazada ═══'
\echo 'Sin techo, "escalar al 250% cada minuto" son 24 duplicaciones en media hora'
\echo 'y €25 se vuelven €4.000 mientras dormís.'
\echo 'esperado: ERROR ad_rules_techo_obligatorio'
-- El action_value es 250 y no 20 a propósito: con 20 el que salta primero es el
-- CHECK de dirección (un factor menor a 100 BAJA el presupuesto) y esta prueba
-- pasaría por el motivo equivocado, dejando sin cubrir el techo obligatorio.
-- Cada bloque tiene que violar UN solo constraint.
DO $$
BEGIN
  INSERT INTO ad_rules (name, level, action, action_value, action_unit)
  VALUES ('sin techo', 'adset', 'budget_increase', 250, 'percent');
  RAISE EXCEPTION 'FALLO: la base aceptó una regla de subir presupuesto sin budget_max';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'OK — rechazada: %', SQLERRM;
END $$;

\echo ''
\echo '═══ 2. Una regla de presupuesto a nivel ANUNCIO tiene que ser rechazada ═══'
\echo 'esperado: ERROR ad_rules_ad_sin_presupuesto (en Meta los anuncios no tienen presupuesto)'
DO $$
BEGIN
  INSERT INTO ad_rules (name, level, action, action_value, action_unit, budget_max)
  VALUES ('presupuesto en un anuncio', 'ad', 'budget_increase', 250, 'percent', 100);
  RAISE EXCEPTION 'FALLO: la base aceptó una regla de presupuesto a nivel ad';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'OK — rechazada: %', SQLERRM;
END $$;

\echo ''
\echo '═══ 3. Una ventana horaria a medias tiene que ser rechazada ═══'
\echo 'esperado: ERROR ad_rules_ventana_completa'
DO $$
BEGIN
  INSERT INTO ad_rules (name, level, action, window_start)
  VALUES ('media ventana', 'adset', 'pause', '22:00');
  RAISE EXCEPTION 'FALLO: la base aceptó una ventana con solo window_start';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'OK — rechazada: %', SQLERRM;
END $$;

\echo ''
\echo '═══ 4. Una regla válida nace APAGADA y en MODO SOMBRA ═══'
\echo 'esperado exactamente: f | t'
INSERT INTO ad_rules (name, level, action) VALUES ('regla de prueba', 'adset', 'pause');
SELECT enabled, dry_run FROM ad_rules WHERE name = 'regla de prueba';

\echo ''
\echo '═══ 5. Extracción del id de Meta desde el UTM ═══'
\echo 'Los funnels mandan `nombre|id`. El id es lo único estable: renombrar la'
\echo 'campaña en Meta no puede partir la serie histórica.'
\echo 'La tolerancia a espacios alrededor del pipe NO es decorativa: un nombre de'
\echo 'campaña que termina en " | 12021..." se pierde entero sin ella, y se pierde'
\echo 'en silencio (la venta no desaparece, solo deja de estar atribuida).'
\echo 'esperado: las 6 filas con el id que dice la columna `espera`'
WITH casos(caso, utm, espera) AS (VALUES
  ('normal',            'PXN JEAN VAQUERO 11/08 - Copia|120210000123456', '120210000123456'),
  ('pipes y espacios',  'PXN | RARO | 120210000999',                      '120210000999'),
  ('centinela orders',  '(directo)',                                      '(null)'),
  ('nombre sin id',     'PXN SIN ID',                                     '(null)'),
  ('solo el id',        '120210000777',                                   '120210000777'),
  ('campaña "2026"',    '2026',                                           '(null)')
)
SELECT caso,
       COALESCE(
         CASE
           WHEN utm ~ '\|\s*[0-9]{6,}\s*$' THEN btrim(substring(utm from '[0-9]+\s*$'))
           WHEN utm ~ '^\s*[0-9]{9,}\s*$'  THEN btrim(utm)
           ELSE NULL
         END, '(null)') AS extraido,
       espera,
       COALESCE(
         CASE
           WHEN utm ~ '\|\s*[0-9]{6,}\s*$' THEN btrim(substring(utm from '[0-9]+\s*$'))
           WHEN utm ~ '^\s*[0-9]{9,}\s*$'  THEN btrim(utm)
           ELSE NULL
         END, '(null)') = espera AS ok
FROM casos ORDER BY caso;

\echo ''
\echo '═══ 6. EL BUG MÁS CARO DEL MÓDULO: el día no es el mismo en las dos zonas ═══'
\echo '`ad_spend.day` viene en la zona de la CUENTA de Meta (Lisboa) y'
\echo '`orders.day` está congelado en la zona del FUNNEL (Buenos Aires). Una venta'
\echo 'de las 21:30 de Buenos Aires es del DÍA SIGUIENTE en Lisboa. Cruzar'
\echo 'orders.day con ad_spend.day mete esa venta en el día equivocado y el ROI'
\echo 'del día se calcula contra el gasto de otro día.'
\echo 'esperado: dia_funnel = 2026-08-12  ·  dia_cuenta = 2026-08-13  ·  distintos = t'
SELECT
  ('2026-08-12 21:30:00-03'::timestamptz AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS dia_funnel,
  ('2026-08-12 21:30:00-03'::timestamptz AT TIME ZONE 'Europe/Lisbon')::date                  AS dia_cuenta,
  ('2026-08-12 21:30:00-03'::timestamptz AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
    <> ('2026-08-12 21:30:00-03'::timestamptz AT TIME ZONE 'Europe/Lisbon')::date             AS distintos;

\echo ''
\echo '═══ 7. La aritmética del presupuesto en unidades mínimas ═══'
\echo 'Meta acepta ENTEROS en la unidad mínima: 2500 son €25,00.'
\echo ''
\echo 'EL PORCENTAJE ES UN FACTOR, NO UN INCREMENTO (D-A9):'
\echo '    nuevo = actual x (p / 100)'
\echo '    250 -> x2,5     100 -> sin cambio     50 -> la mitad'
\echo 'Así que 250% sobre €10,00 son €25,00. NO €35,00.'
\echo ''
\echo 'Está verificado contra el export real del usuario (_reglas-utmify.csv):'
\echo 'Utmify guarda actionPercentInfo = 2.5 y muestra "250%", y el techo de la'
\echo 'regla de €75 es exactamente el borde superior de su condición de'
\echo 'presupuesto por 2,5 (€30,00 x 2,5 = €75,00 al céntimo). Con la lectura de'
\echo 'incremento (x3,5) daría €105 y el techo cortaría en todas las corridas.'
\echo 'El bloque 11 vuelve a probar esa aritmética contra las reglas seedeadas.'
\echo ''
\echo 'Con unit = fixed el valor es un importe en EUR y EL SIGNO LO PONE LA'
\echo 'ACCION: increase suma, decrease resta. El valor siempre es positivo.'
\echo ''
\echo 'El redondeo se hace UNA sola vez, con round() y no truncando: dos'
\echo 'redondeos encadenados hacen que un factor de 133% sobre 2500 dé 3324 y'
\echo 'Meta lo acepte con un céntimo de menos cada vez, que a las 200 corridas'
\echo 'ya se nota.'
\echo 'esperado: 2500 | 2500 | 2500 | 3325 | 2600 | 2400 | 100'
SELECT
  -- El caso exacto de la regla «Duplicar a $25» del usuario: un conjunto en
  -- €10,00 con la condición budget < €11,00.
  round(1000 * (250 / 100.0))::bigint                   AS factor_250_sobre_10eur,
  -- Un factor de 100 no cambia nada, y es el caso que hace obvio que es un
  -- factor: con la lectura de incremento daría 5000.
  round(2500 * (100 / 100.0))::bigint                   AS factor_100_no_cambia,
  -- Recorte contra el techo de la regla: €11,00 x 2,5 = €27,50, techo €25,00.
  least(round(1100 * (250 / 100.0)), 2500)::bigint       AS con_techo_25eur,
  round(2500 * (133 / 100.0))::bigint                   AS factor_133_un_redondeo,
  (2500 + round(1.00 * 100))::bigint                    AS fija_mas_1eur,
  -- decrease con unit=fixed RESTA. Que la fórmula sumara igual era un bug real
  -- del plan: una regla de bajar €1 subía €1.
  (2500 - round(1.00 * 100))::bigint                    AS fija_menos_1eur,
  -- Piso duro: Meta rechaza presupuestos por debajo del mínimo de la cuenta y
  -- del objetivo. Un factor de 40% sobre €2,00 daría 80 céntimos y el POST falla,
  -- así que se recorta contra el mínimo conocido de €1,00.
  greatest(round(200 * (40 / 100.0)), 100)::bigint       AS factor_40_con_minimo_1eur;

\echo ''
\echo 'Y esto es lo que daría la lectura EQUIVOCADA (incremento). Está acá para'
\echo 'que se vea la diferencia, no porque el módulo la use.'
\echo 'esperado: 3500 (la lectura correcta da 2500) | 5000 (la correcta da 2500)'
SELECT
  round(1000 * (1 + 250 / 100.0))::bigint AS incremento_250_sobre_10eur,
  round(2500 * (1 + 100 / 100.0))::bigint AS incremento_100_sobre_25eur;

\echo ''
\echo '═══ 8. El cooldown y el máximo por objeto se cuentan sobre acciones REALES ═══'
\echo 'Las simuladas (dry_run) NO consumen cupo: si consumieran, un día en modo'
\echo 'sombra dejaría la regla sin acciones disponibles justo cuando se prende.'
\echo ''
\echo 'Las INDETERMINADAS sí consumen cupo, y esto es lo importante: una acción'
\echo 'cuyo POST se cortó por timeout puede haberse aplicado en Meta igual. Si no'
\echo 'consumiera cupo, el tick siguiente la reintentaría y una subida de'
\echo 'presupuesto se aplicaría dos veces. Ante la duda, el freno se aplica.'
\echo ''
\echo 'Las FALLIDAS no consumen cupo: no pasó nada en Meta y reintentar es sano.'
\echo 'esperado exactamente: cuentan = 2 · la última hace 5 min · simuladas = 3 · fallidas = 1'
INSERT INTO ad_actions (source, account_id, level, object_id, action, dry_run, ok, estado, explicacion, created_at)
VALUES
  ('rule', 'act_1', 'adset', 'AS_1', 'pause',           false, true,  'confirmado',    'real vieja',    now() - interval '90 min'),
  ('rule', 'act_1', 'adset', 'AS_1', 'budget_increase', false, false, 'indeterminado', 'timeout',       now() - interval '5 min'),
  ('rule', 'act_1', 'adset', 'AS_1', 'pause',           false, false, 'fallido',       'Meta dijo 100', now() - interval '4 min'),
  ('rule', 'act_1', 'adset', 'AS_1', 'pause',           true,  true,  'simulado',      'simulada 1',    now() - interval '3 min'),
  ('rule', 'act_1', 'adset', 'AS_1', 'pause',           true,  true,  'simulado',      'simulada 2',    now() - interval '2 min'),
  ('rule', 'act_1', 'adset', 'AS_1', 'pause',           true,  true,  'simulado',      'simulada 3',    now() - interval '1 min');

SELECT
  count(*) FILTER (WHERE NOT dry_run AND estado IN ('confirmado', 'indeterminado')) AS cuentan_para_el_freno,
  round(EXTRACT(EPOCH FROM (now() - max(created_at)
    FILTER (WHERE NOT dry_run AND estado IN ('confirmado', 'indeterminado')))) / 60) AS ultima_hace_min,
  count(*) FILTER (WHERE dry_run)                            AS simuladas,
  count(*) FILTER (WHERE estado = 'fallido')                 AS fallidas
FROM ad_actions
WHERE object_id = 'AS_1' AND created_at >= date_trunc('day', now());

\echo ''
\echo '═══ 9. Borrar una regla NO borra su historial NI sus corridas ═══'
\echo 'Las dos FK hacia ad_rules son ON DELETE SET NULL y rule_name está'
\echo 'desnormalizado en las dos tablas: el historial sigue siendo legible después'
\echo 'de borrar la regla que lo causó.'
\echo ''
\echo 'ad_rule_runs era ON DELETE CASCADE y eso era un bug: borrar una regla desde'
\echo 'la pantalla de configuración borraba la evidencia de cuántos objetos vio y'
\echo 'cuántos cumplieron, y dejaba las filas de ad_actions apuntando a un run_id'
\echo 'inexistente. Una tabla de auditoría no se borra desde un formulario.'
\echo 'esperado exactamente: acciones 1 con rule_id (null) · corridas 1 con rule_id (null)'
INSERT INTO ad_rules (id, name, level, action) VALUES (9001, 'Apagar sin ventas', 'adset', 'pause');
INSERT INTO ad_rule_runs (id, rule_id, rule_name, dry_run, objetos_evaluados, objetos_que_cumplen)
VALUES (9001, 9001, 'Apagar sin ventas', false, 42, 1);
INSERT INTO ad_actions (run_id, rule_id, rule_name, source, account_id, level, object_id, action, ok, estado, explicacion)
VALUES (9001, 9001, 'Apagar sin ventas', 'rule', 'act_1', 'adset', 'AS_9', 'pause', true, 'confirmado', 'se pausó');
DELETE FROM ad_rules WHERE id = 9001;
SELECT 'acciones' AS tabla, count(*) AS sigue, coalesce(max(rule_id)::text, '(null)') AS rule_id,
       max(rule_name) AS rule_name
  FROM ad_actions WHERE object_id = 'AS_9'
UNION ALL
SELECT 'corridas', count(*), coalesce(max(rule_id)::text, '(null)'), max(rule_name)
  FROM ad_rule_runs WHERE id = 9001;

\echo ''
\echo '═══ 10. El lease del worker: exclusión mutua CON DUEÑO ═══'
\echo 'Un `pm2 reload` durante un deploy deja dos procesos solapados unos'
\echo 'segundos. Dos motores en el mismo tick duplican cada acción (dos subidas'
\echo 'de presupuesto seguidas). El UPDATE condicional es la exclusión mutua.'
\echo ''
\echo 'EL BUG QUE ESTE BLOQUE AHORA DETECTA Y ANTES NO.'
\echo 'La versión anterior guardaba sólo el timestamp de la toma y renovaba con'
\echo '"vencido o vacío". Con vencimiento de 3 minutos y cadencia de 1 minuto, el'
\echo 'PROPIO worker no puede renovar: su lease todavía no venció, así que el'
\echo 'UPDATE no matchea y el tick se descarta. No hay error ni log raro: la'
\echo 'cadencia real pasa de 1 a 3 minutos, en silencio y para siempre. La prueba'
\echo 'anterior no lo veía porque sólo probaba dos UPDATE consecutivos.'
\echo ''
\echo 'Con dueño: el dueño actual renueva siempre, otro sólo entra si venció, y'
\echo 'nadie puede liberar el lease de otro.'
\echo 'esperado exactamente: A_toma=1 B_falla=0 A_renueva=1 B_no_libera=0 A_libera=1 B_toma=1 A_tras_vencer=0'
DO $$
DECLARE
  -- Tomar o renovar. $1 es el owner del proceso que lo intenta.
  tomar constant text := $q$
    UPDATE settings
       SET value = jsonb_build_object('owner', $1::text,
                                      'expires_at', (now() + interval '3 minutes')::text)
     WHERE key = 'ads_worker_lease'
       AND (   value->>'owner' IS NULL                          -- libre
            OR value->>'owner' = $1::text                       -- soy el dueño: renuevo
            OR (value->>'expires_at')::timestamptz < now())      -- ajeno y vencido
  $q$;
  -- Liberar: compare-and-set por dueño.
  liberar constant text := $q$
    UPDATE settings SET value = '{}'::jsonb
     WHERE key = 'ads_worker_lease' AND value->>'owner' = $1::text
  $q$;
  A constant text := 'worker-A';
  B constant text := 'worker-B';
  a_toma int; b_falla int; a_renueva int; b_no_libera int; a_libera int; b_toma int; a_tras_vencer int;
BEGIN
  UPDATE settings SET value = '{}'::jsonb WHERE key = 'ads_worker_lease';

  EXECUTE tomar   USING A;  GET DIAGNOSTICS a_toma      = ROW_COUNT;  -- A lo toma
  EXECUTE tomar   USING B;  GET DIAGNOSTICS b_falla     = ROW_COUNT;  -- B queda afuera
  EXECUTE tomar   USING A;  GET DIAGNOSTICS a_renueva   = ROW_COUNT;  -- A renueva su propio lease
  EXECUTE liberar USING B;  GET DIAGNOSTICS b_no_libera = ROW_COUNT;  -- B no puede liberar el de A
  EXECUTE liberar USING A;  GET DIAGNOSTICS a_libera    = ROW_COUNT;  -- A libera al terminar
  EXECUTE tomar   USING B;  GET DIAGNOSTICS b_toma      = ROW_COUNT;  -- B entra en el tick siguiente

  -- Y el caso del proceso que murió sin liberar: su lease vence y otro entra,
  -- pero el muerto ya no puede pisarlo si vuelve tarde con el lease de B vigente.
  UPDATE settings
     SET value = jsonb_build_object('owner', B, 'expires_at', (now() + interval '3 min')::text)
   WHERE key = 'ads_worker_lease';
  EXECUTE tomar USING A;    GET DIAGNOSTICS a_tras_vencer = ROW_COUNT;  -- 0: el de B está vigente

  RAISE NOTICE 'A_toma=% B_falla=% A_renueva=% B_no_libera=% A_libera=% B_toma=% A_tras_vencer=%',
    a_toma, b_falla, a_renueva, b_no_libera, a_libera, b_toma, a_tras_vencer;
  IF a_toma <> 1 OR b_falla <> 0 OR a_renueva <> 1 OR b_no_libera <> 0
     OR a_libera <> 1 OR b_toma <> 1 OR a_tras_vencer <> 0 THEN
    RAISE EXCEPTION 'FALLO: el lease con dueño no cumple la exclusión mutua';
  END IF;

  -- Y ahora sí, que un lease AJENO Y VENCIDO se pueda tomar.
  UPDATE settings
     SET value = jsonb_build_object('owner', B, 'expires_at', (now() - interval '1 min')::text)
   WHERE key = 'ads_worker_lease';
  EXECUTE tomar USING A;    GET DIAGNOSTICS a_tras_vencer = ROW_COUNT;
  IF a_tras_vencer <> 1 THEN
    RAISE EXCEPTION 'FALLO: un lease vencido tiene que poder tomarse (dio %)', a_tras_vencer;
  END IF;

  RAISE NOTICE 'OK — el dueño renueva, el ajeno vigente no entra, el vencido se recupera';
END $$;

\echo ''
\echo '═══ 11. Las seis reglas del usuario se tradujeron bien del export de Utmify ═══'
\echo 'Son las reglas que van a correr sobre plata real. Los tres puntos que más'
\echo 'fácil se rompen al traducir: el porcentaje como FACTOR (250, no 2.5 ni 350),'
\echo 'los montos en EUR y no en céntimos (10.00, no 1000), y que las seis nazcan'
\echo 'apagadas y en sombra.'
\echo 'esperado exactamente: 6 reglas · 15 condiciones · 6 apagadas y en sombra · 0 en céntimos'
-- Se cuenta SOLO el seed, por nombre: los bloques 1-9 de este archivo dejaron
-- reglas de prueba en la misma transacción y contarlas todas daría 7.
WITH seed AS (
  SELECT id FROM ad_rules WHERE name IN (
    'Activar todas a las 0 horas a ver como rinden',
    'Duplicar a $25 - Gasto -$10 +2 ventas ROI +1.3',
    'Duplicar a $75 - Gasto +$15 ROI +1.3',
    'Duplicar a $150 - Gasto +$50 ROI +1.3',
    'Apagar - Gasto +$10 ROI -1.10',
    'Apagar - Gasto +$4 sin ventas')
)
SELECT
  (SELECT count(*) FROM seed)                                              AS reglas,
  (SELECT count(*) FROM ad_rule_conditions WHERE rule_id IN (SELECT id FROM seed)) AS condiciones,
  (SELECT count(*) FROM ad_rules WHERE id IN (SELECT id FROM seed)
     AND NOT enabled AND dry_run)                                          AS apagadas_y_en_sombra,
  -- Si algún monto quedó en céntimos, "gasto > €4" se volvió "gasto > €400" y la
  -- regla no se dispara nunca. Ningún umbral de plata de estas seis pasa de 150.
  (SELECT count(*) FROM ad_rule_conditions
    WHERE rule_id IN (SELECT id FROM seed)
      AND metric IN ('spend','revenue','net','profit','budget','cpa','cpc')
      AND value > 150)                                                     AS en_centimos;

\echo ''
\echo 'La escalera: cada techo tiene que ser el borde superior de su propia condición'
\echo 'de presupuesto por 2,5. Es la prueba aritmética de que el porcentaje es un'
\echo 'factor y no un incremento (D-A9).'
\echo 'esperado: la fila de €75 da techo = por_factor = 75.00'
SELECT r.budget_max AS techo,
       r.action_value AS pct,
       (SELECT c.value FROM ad_rule_conditions c
         WHERE c.rule_id = r.id AND c.metric = 'budget' AND c.op = '<') AS cond_budget_menor,
       round((SELECT c.value FROM ad_rule_conditions c
               WHERE c.rule_id = r.id AND c.metric = 'budget' AND c.op = '<')
             * r.action_value / 100, 2) AS por_factor
  FROM ad_rules r
 WHERE r.action = 'budget_increase'
 ORDER BY r.budget_max;

\echo ''
\echo 'La regla de las 0 horas: ventana 00:00-00:59, una corrida por día, 7d sin hoy.'
\echo 'esperado exactamente: 00:00:00 | 00:59:00 | 1440 | 1 | 7d_excl_today'
SELECT window_start, window_end, every_minutes, max_runs_per_day, period
  FROM ad_rules WHERE action = 'activate';

\echo ''
\echo 'Y la condición que se corrigió (P-A05): el export decía `approvedSales < 0`,'
\echo 'que con ventas enteras no se puede cumplir nunca. Se cargó como `= 0`.'
\echo 'esperado exactamente: = | 0.0000'
SELECT c.op, c.value FROM ad_rule_conditions c
  JOIN ad_rules r ON r.id = c.rule_id
 WHERE r.name = 'Apagar - Gasto +$4 sin ventas' AND c.metric = 'sales';

\echo ''
\echo '═══ 12. Una regla no puede hacer lo CONTRARIO de lo que dice su nombre ═══'
\echo 'Con unit=percent el valor es un factor, así que un factor menor a 100 BAJA'
\echo 'el presupuesto. Un budget_increase con 50 no es "subir poco": parte el'
\echo 'presupuesto al medio cada 15 minutos, y el techo obligatorio no lo frena'
\echo 'porque el resultado siempre queda por debajo. Al revés igual: un'
\echo 'budget_decrease con 250 multiplica por 2,5 una regla que se llama "bajar".'
\echo 'esperado: las dos rechazadas por ad_rules_percent_direccion'
DO $$
BEGIN
  INSERT INTO ad_rules (name, level, action, action_value, action_unit, budget_max)
  VALUES ('subir al 50 por ciento', 'adset', 'budget_increase', 50, 'percent', 100);
  RAISE EXCEPTION 'FALLO: la base aceptó un budget_increase con factor < 100';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'OK — increase con 50%% rechazado: %', SQLERRM;
END $$;
DO $$
BEGIN
  INSERT INTO ad_rules (name, level, action, action_value, action_unit, budget_min)
  VALUES ('bajar al 250 por ciento', 'adset', 'budget_decrease', 250, 'percent', 5);
  RAISE EXCEPTION 'FALLO: la base aceptó un budget_decrease con factor > 100';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'OK — decrease con 250%% rechazado: %', SQLERRM;
END $$;

\echo ''
\echo '═══ 13. Techo y piso incoherentes se rechazan ═══'
\echo 'Con techo €10 y piso €25 no hay ningún valor que satisfaga los dos, y el'
\echo 'recorte del motor (min(max(x, piso), techo)) devolvería el techo siempre,'
\echo 'en silencio. Y un límite en 0 o negativo no significa nada: son importes.'
\echo 'esperado: las dos rechazadas'
DO $$
BEGIN
  INSERT INTO ad_rules (name, level, action, action_value, action_unit, budget_max, budget_min)
  VALUES ('techo bajo el piso', 'adset', 'budget_increase', 250, 'percent', 10, 25);
  RAISE EXCEPTION 'FALLO: la base aceptó budget_max < budget_min';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'OK — techo < piso rechazado: %', SQLERRM;
END $$;
DO $$
BEGIN
  INSERT INTO ad_rules (name, level, action, action_value, action_unit, budget_max)
  VALUES ('techo en cero', 'adset', 'budget_increase', 250, 'percent', 0);
  RAISE EXCEPTION 'FALLO: la base aceptó un techo en 0';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'OK — techo 0 rechazado: %', SQLERRM;
END $$;

\echo ''
\echo '═══ 14. Lo que el schema NO deja hacer todavía, y el evento global que SÍ ═══'
\echo 'metrics_level = parent está declarado en el plan pero nadie definió su'
\echo 'semántica (cómo se resuelve el padre, si se deduplica, a qué objeto se le'
\echo 'aplica la acción). Una regla que el schema acepta y el motor no sabe'
\echo 'evaluar decide con el nivel equivocado. Hasta que se implemente, la base la'
\echo 'rechaza en lugar de dejar que falle en runtime.'
\echo 'esperado: parent rechazado'
DO $$
BEGIN
  INSERT INTO ad_rules (name, level, action, metrics_level)
  VALUES ('metricas del padre', 'ad', 'pause', 'parent');
  RAISE EXCEPTION 'FALLO: la base aceptó metrics_level = parent sin implementación';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'OK — parent rechazado: %', SQLERRM;
END $$;

\echo ''
\echo 'Y el evento de configuración global, que T19 necesita para registrar el'
\echo 'apagado del modo simulación. Antes era imposible de insertar: account_id es'
\echo 'NOT NULL y el CHECK de level sólo aceptaba campaign|adset|ad. Ahora existe'
\echo 'level = system con el centinela account_id = *.'
\echo 'esperado exactamente: system | * | config | t'
INSERT INTO ad_actions (source, level, object_id, action, ok, estado, explicacion, actor_hint)
VALUES ('system', 'system', 'ads_rules_force_dry_run', 'config', true, 'confirmado',
        'Manual: se desactivó el modo simulación global. Desde ahora las reglas marcadas como ACTIVA cambian estados y presupuestos en Meta de verdad.',
        'ip=192.0.2.10 req=abc123');
SELECT level, account_id, action, (actor_hint IS NOT NULL) AS con_rastro
  FROM ad_actions WHERE object_id = 'ads_rules_force_dry_run';

\echo ''
\echo 'Y que un evento de config NO pueda disfrazarse de acción sobre un objeto:'
\echo 'esperado: rechazado por ad_actions_config_coherente'
DO $$
BEGIN
  INSERT INTO ad_actions (source, account_id, level, object_id, action, ok, explicacion)
  VALUES ('manual', 'act_1', 'adset', 'AS_5', 'config', true, 'config sobre un conjunto');
  RAISE EXCEPTION 'FALLO: la base aceptó un evento config a nivel adset';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'OK — rechazado: %', SQLERRM;
END $$;

\echo ''
\echo '═══ Todo lo de arriba corrió dentro de una transacción. Se descarta. ═══'
ROLLBACK;
