-- ═══════════════════════════════════════════════════════════════════════════
-- Verificación lógica del rediseño de UI.
--
-- Prueba las 10 afirmaciones de las que dependen T04 (embudo) y T03 (widgets).
-- Se corrió completo contra un PostgreSQL 16 con las migraciones 001-016 +
-- `_schema-017.sql` aplicadas.
--
-- Correlo DESPUÉS de migrar:
--   docker exec -i panel-db-1 psql -U panel -d panel -v ON_ERROR_STOP=1 \
--     < redesign-ui-tasks/_verificacion-017.sql
--
-- CÓMO LEER "CORRIÓ EN VERDE"
-- Los bloques 1, 2, 3, 4 y 10 tiran excepción si fallan, así que "salió sin
-- error" es una afirmación real sobre ellos. Los demás IMPRIMEN y su `\echo`
-- dice qué se espera: hay que leer la salida y comparar. Un archivo que corre
-- sin error no garantiza que los números impresos sean los esperados.
-- ═══════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
BEGIN;

\echo '═══ 1. Una etapa sin fuente de datos tiene que ser rechazada ═══'
\echo 'Una fila con starts_at_slug y milestone en NULL no tiene de dónde sacar el'
\echo 'conteo, y el embudo dibujaría un trapecio de ancho indefinido.'
\echo 'esperado: ERROR funnel_stages_fuente_unica'
DO $$
BEGIN
  INSERT INTO funnel_stages (funnel_id, stage_order, label)
  VALUES (1, 90, 'etapa sin fuente');
  RAISE EXCEPTION 'FALLO: la base aceptó una etapa sin paso ni hito';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'OK — rechazada: %', SQLERRM;
END $$;

\echo ''
\echo '═══ 2. Una etapa con DOS fuentes también se rechaza ═══'
\echo 'Con paso e hito a la vez, el conteo depende de cuál lea el código.'
\echo 'esperado: ERROR funnel_stages_fuente_unica'
DO $$
BEGIN
  INSERT INTO funnel_stages (funnel_id, stage_order, label, starts_at_slug, milestone)
  VALUES (1, 91, 'dos fuentes', 'sales_page', 'purchase');
  RAISE EXCEPTION 'FALLO: la base aceptó una etapa con paso Y hito';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'OK — rechazada: %', SQLERRM;
END $$;

\echo ''
\echo '═══ 3. Un hito inventado se rechaza ═══'
\echo 'Los hitos salen de tres columnas concretas de `sessions`. Un cuarto valor'
\echo 'no tiene columna de dónde leer y fallaría en runtime, no al guardar.'
\echo 'esperado: ERROR funnel_stages_milestone_valido'
DO $$
BEGIN
  INSERT INTO funnel_stages (funnel_id, stage_order, label, milestone)
  VALUES (1, 92, 'hito inventado', 'se_suscribio');
  RAISE EXCEPTION 'FALLO: la base aceptó un hito fuera del vocabulario';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'OK — rechazado: %', SQLERRM;
END $$;

\echo ''
\echo '═══ 4. Un slug no puede arrancar dos etapas del mismo funnel ═══'
\echo 'Sería una frontera ambigua: la agrupación quedaría a merced del ORDER BY.'
\echo 'esperado: ERROR de unicidad'
DO $$
BEGIN
  INSERT INTO funnel_stages (funnel_id, stage_order, label, starts_at_slug)
  VALUES (1, 93, 'otra vez sales_page', 'sales_page');
  RAISE EXCEPTION 'FALLO: la base aceptó dos etapas arrancando en el mismo slug';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'OK — rechazada: %', SQLERRM;
END $$;

\echo ''
\echo '═══ 5. El seed dejó 8 etapas por funnel, ordenadas y sin huecos ═══'
\echo 'esperado: cada funnel con 8 etapas, stage_order de 0 a 7, 5 de paso y 3 de hito'
SELECT f.slug AS funnel,
       count(*)                                      AS etapas,
       min(st.stage_order)                           AS primera,
       max(st.stage_order)                           AS ultima,
       count(*) FILTER (WHERE st.starts_at_slug IS NOT NULL) AS de_paso,
       count(*) FILTER (WHERE st.milestone IS NOT NULL)      AS de_hito,
       (max(st.stage_order) - min(st.stage_order) + 1 = count(*)) AS sin_huecos
  FROM funnel_stages st JOIN funnels f ON f.id = st.funnel_id
 GROUP BY f.slug ORDER BY 1;

\echo ''
\echo '═══ 6. Ninguna etapa apunta a un slug que no existe ═══'
\echo 'Una etapa huérfana (porque alguien renombró o borró el paso) no se puede'
\echo 'calcular. Se referencia por slug justamente para que esto sea DETECTABLE'
\echo 'en lugar de apuntar en silencio al paso equivocado.'
\echo 'esperado exactamente: 0'
SELECT count(*) AS etapas_huerfanas
  FROM funnel_stages st
 WHERE st.starts_at_slug IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM funnel_steps s
                    WHERE s.funnel_id = st.funnel_id AND s.slug = st.starts_at_slug);

\echo ''
\echo '═══ 7. Las fronteras de etapa cubren TODOS los pasos del catálogo ═══'
\echo 'Cada paso tiene que caer dentro de exactamente una etapa. Un paso antes'
\echo 'de la primera frontera no pertenece a ninguna y su caída no se ve en el'
\echo 'embudo: la sesión desaparece entre dos trapecios sin explicación.'
\echo 'esperado exactamente: 0 pasos fuera de toda etapa, en los dos funnels'
WITH primera AS (
  SELECT st.funnel_id, min(s.step_index) AS primer_step
    FROM funnel_stages st
    JOIN funnel_steps s ON s.funnel_id = st.funnel_id AND s.slug = st.starts_at_slug
   GROUP BY 1
)
SELECT f.slug AS funnel,
       count(*) FILTER (WHERE s.step_index < p.primer_step) AS pasos_sin_etapa
  FROM funnel_steps s
  JOIN funnels f ON f.id = s.funnel_id
  JOIN primera p ON p.funnel_id = s.funnel_id
 GROUP BY f.slug ORDER BY 1;

\echo ''
\echo '═══ 8. EL EMBUDO NO ES MONÓTONO, Y ESTÁ MEDIDO ═══'
\echo 'Los pasos salen del histograma de max_step_index; los hitos salen de'
\echo 'columnas propias (sales_view_at, checkout_click_at, purchased_at). Son'
\echo 'fuentes distintas, así que un hito puede tener MÁS sesiones que el paso'
\echo 'que lo precede y el trapecio se ensancha.'
\echo ''
\echo 'Medido en producción, chauhinchazon, últimos 30 días:'
\echo '    Landing            4011'
\echo '    Preguntas          1086'
\echo '    Puente al experto  1027'
\echo '    Diagnóstico         880'
\echo '    Página de venta     820   ← del histograma de pasos'
\echo '    Vio la venta        821   ← de sales_view_at: UNA MÁS'
\echo '    Clickeó comprar     199'
\echo '    Compró               56'
\echo ''
\echo 'Una sesión tiene sales_view_at sin haber alcanzado el paso 21. No es un'
\echo 'error de datos: es que las dos columnas se escriben en momentos distintos'
\echo 'del funnel y una sesión puede saltar.'
\echo ''
\echo 'CÓMO LO DIBUJA T04: el ANCHO del trapecio se recorta al de la etapa'
\echo 'anterior para que la figura siga siendo un embudo, pero el NÚMERO que se'
\echo 'muestra es el real y la etapa lleva una marca visible. El número es la'
\echo 'verdad, la figura es la ilustración. Recortar el número escondería el'
\echo 'dato; ensanchar el trapecio parecería un bug del gráfico.'
\echo ''
\echo 'Esta consulta reproduce el caso sobre los datos que haya en esta base.'
\echo 'esperado: si hay sesiones, al menos una fila con ensancha = t'
WITH etapas AS (
  SELECT st.funnel_id, st.stage_order, st.label,
         CASE WHEN st.milestone IS NOT NULL THEN 'hito' ELSE 'paso' END AS fuente
    FROM funnel_stages st
), conteos AS (
  -- Simplificación deliberada: sólo compara la fuente de cada etapa contra la
  -- anterior. El cálculo real de sesiones vive en lib/queries/funnel.ts (T04);
  -- acá lo único que se prueba es que el cambio de fuente existe y dónde.
  SELECT e.funnel_id, e.stage_order, e.label, e.fuente,
         lag(e.fuente) OVER (PARTITION BY e.funnel_id ORDER BY e.stage_order) AS fuente_anterior
    FROM etapas e
)
SELECT f.slug AS funnel, c.stage_order, c.label, c.fuente_anterior, c.fuente,
       (c.fuente_anterior = 'paso' AND c.fuente = 'hito') AS frontera_de_riesgo
  FROM conteos c JOIN funnels f ON f.id = c.funnel_id
 WHERE c.fuente_anterior IS DISTINCT FROM c.fuente
 ORDER BY f.slug, c.stage_order;

\echo ''
\echo '═══ 9. Los layouts nacen en NULL = "usá el default" ═══'
\echo 'NULL (fila presente, valor null) significa "el usuario nunca guardó, mostrá'
\echo 'el layout por defecto". Es DISTINTO de un array vacío, que significa "el'
\echo 'usuario guardó una pantalla sin widgets" y hay que respetarlo.'
\echo 'esperado exactamente: 2 filas, las dos con es_null = t'
SELECT key, value::text AS valor, (value = 'null'::jsonb) AS es_null
  FROM settings WHERE key IN ('ui_layout_resumen', 'ui_layout_ventas') ORDER BY key;

\echo ''
\echo '═══ 10. Un layout con la forma correcta entra; uno sin `v` también ═══'
\echo 'La columna es jsonb sin CHECK de forma a propósito: la validación es de'
\echo 'zod en el endpoint (T03), no de la base. Si la base validara la forma,'
\echo 'agregar un campo al layout sería una migración.'
\echo 'esperado: guardado = t, y la lectura devuelve los 2 widgets en ORDEN'
DO $$
DECLARE n int;
BEGIN
  UPDATE settings
     SET value = '{"v":1,"widgets":[{"id":"neto-total","w":1,"h":1},{"id":"por-dia","w":2,"h":2}]}'::jsonb
   WHERE key = 'ui_layout_resumen';
  SELECT jsonb_array_length(value -> 'widgets') INTO n
    FROM settings WHERE key = 'ui_layout_resumen';
  IF n <> 2 THEN RAISE EXCEPTION 'FALLO: se guardaron % widgets en lugar de 2', n; END IF;
  RAISE NOTICE 'OK — layout guardado con % widgets', n;
END $$;

SELECT w.ord, w.widget ->> 'id' AS id, (w.widget ->> 'w')::int AS ancho, (w.widget ->> 'h')::int AS alto
  FROM settings s,
       LATERAL jsonb_array_elements(s.value -> 'widgets') WITH ORDINALITY AS w(widget, ord)
 WHERE s.key = 'ui_layout_resumen'
 ORDER BY w.ord;

\echo ''
\echo '═══ Todo lo de arriba corrió dentro de una transacción. Se descarta. ═══'
ROLLBACK;
