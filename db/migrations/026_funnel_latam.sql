-- ═══════════════════════════════════════════════════════════════════════════
-- 026 — El funnel LATAM pasa a ser un EMBUDO PROPIO.
--
-- CORRE SOBRE DATOS VIVOS. Aditiva e idempotente: no toca ni una fila del
-- funnel `chauhinchazon` ni del histórico.
--
-- QUÉ CAMBIA
-- `testfunnel` sirve DOS funnels en el mismo deploy, el mismo dominio y la misma
-- cuenta publicitaria: el de Argentina (`/quiz`, ARS, Shopify) y el de LATAM
-- (`/latam`, USD, Hotmart, español neutro). Hasta ahora el panel los contaba como
-- UN embudo con dos valores de `variant` ('ar' y 'latam'), porque los dos
-- reportaban con la misma ingest key. Eso alcanza para desglosar, pero no para
-- lo que hace falta: los dos embudos tienen precios, moneda, checkout y copy
-- distintos, así que sus tasas de conversión no son comparables y promediarlas en
-- una sola pantalla no describe a ninguno de los dos.
--
-- Desde acá LATAM es una fila propia en `funnels`, con su catálogo de pasos y sus
-- etapas. Aparece solo en el selector del header (`?f=chauhinchazon-latam`), en la
-- MISMA pestaña de Embudo: no hay pantalla nueva ni panel aparte.
--
-- CÓMO SE SEPARAN LOS DATOS, Y QUÉ FALTA PARA QUE EMPIECE A ENTRAR
-- El panel resuelve el funnel por el sha256 del Bearer del ingest, no por un
-- campo del payload (el contrato está congelado). O sea: la separación la hace la
-- KEY. Esta migración deja el funnel creado pero INERTE, con el placeholder de
-- 009 en `ingest_key_hash` — un valor imposible de matchear, así que hasta que se
-- le genere una key el ingest devuelve 401 en lugar de aceptar cualquier cosa.
--
-- Los tres pasos que faltan, en este orden:
--   1. Config → Funnels → generar la ingest key de `chauhinchazon-latam`
--      (POST /api/config/funnels/ingest-key). El panel la muestra UNA sola vez.
--      Alternativa por CLI: `npm run db:ingest-key chauhinchazon-latam <key>`.
--   2. Cargarla en el env del funnel como PANEL_INGEST_KEY_LATAM
--      (/srv/chauhinchazon/shared/.env.production) ANTES de deployar: `deploy.sh`
--      copia ese archivo al release, así el código nuevo y la key entran juntos y
--      no queda una ventana en la que LATAM reporte al funnel de AR.
--   3. Verificar en el Embudo del funnel nuevo que entren sesiones.
--
-- ⚠️ Y EL PASO QUE NO ES OBVIO Y DECIDE SI ESTE EMBUDO RECIBE ALGO:
-- LOS ANUNCIOS DE LATAM TIENEN QUE APUNTAR AL HOST QUE REPORTA.
-- El mismo deploy sirve tres hostnames, pero `PANEL_INGEST_HOSTS` (en el env del
-- funnel) es un allowlist de cuáles reportan al panel, y hoy vale
-- `ritual.hilvanapp.org` a secas. `chauhinchazon.hilvanapp.com` está EXCLUIDO a
-- propósito: quedó como puerta de la PWA y su tráfico ensuciaría el embudo con
-- gente que no viene de un anuncio.
--
-- O sea que la campaña tiene que ir a `https://ritual.hilvanapp.org/latam`. Con
-- `chauhinchazon.hilvanapp.com/latam` el funnel anda perfecto, la visitante compra,
-- y el embudo del panel queda en cero — sin ningún error a la vista. El único
-- rastro es un warning en los logs de PM2:
--   [panel] host '<host>' no está en PANEL_INGEST_HOSTS (...) — sus eventos NO se
--   reportan al panel
-- Si hace falta habilitar otro host, se agrega a `PANEL_INGEST_HOSTS` separado por
-- comas y se recarga PM2; no hay que tocar código.
--
-- Mientras el paso 2 no esté hecho, `ingestKeyFor` (testfunnel/lib/panel-ingest.ts)
-- cae a la key de AR y LATAM sigue contando dentro de `chauhinchazon` con
-- `variant='latam'`, igual que hasta hoy. La ventana entre el deploy y la key
-- cargada no pierde datos.
--
-- EL HISTÓRICO NO SE MUEVE, A PROPÓSITO
-- Las sesiones LATAM que ya existen quedan donde están (`chauhinchazon`,
-- `variant='latam'`). Migrarlas sería un UPDATE masivo de `sessions` + `events` +
-- `orders` que reescribe números que alguien ya leyó y comparó, y no hay forma de
-- revertirlo con confianza. El corte es por fecha: el embudo nuevo arranca vacío
-- el día que se carga la key, y el viejo conserva todo lo anterior. Por eso
-- `chauhinchazon` MANTIENE 'latam' en su array de `variants`: sacarlo pondría a
-- llenar `ingest_errors` con `unknown_variant` durante la ventana del fallback.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 1. El funnel
-- ───────────────────────────────────────────────────────────────────────────
--
-- variants = ['latam'] Y NADA MÁS: este embudo no tiene dimensión de país, es
--   el país. Un evento que llegue acá con variant='ar' es un bug de ruteo, y
--   declarar solo 'latam' hace que el ingest lo anote en `ingest_errors` como
--   `unknown_variant` y el banner del embudo lo grite. Con ARRAY['ar','latam']
--   ese mismo bug entraría sin que nada avise.
--
-- sell_currency = 'USD' porque el checkout es Hotmart en dólares
--   (PRICING_LATAM en testfunnel/lib/quiz-v2/config-latam.ts).
--
-- timezone = 'Europe/Lisbon', la zona de quien MIRA el panel, no la del público
--   al que se le vende. Es una decisión pedida explícitamente y vale la pena
--   dejar anotado qué implica, porque no es neutral:
--
--   · El día del panel es el día de Lisboa. Lisboa es UTC+0 en invierno (WET) y
--     UTC+1 en verano (WEST) — no UTC-1. El nombre IANA es el que va acá:
--     guardar un offset fijo rompería el corte dos veces al año.
--
--   · QUEDA ALINEADO CON AR. `chauhinchazon` ya estaba en 'Europe/Lisbon' (lo
--     movieron desde Config en algún momento después del seed de la 009, que lo
--     había creado en 'America/Argentina/Buenos_Aires'). Así que los dos embudos
--     comparten el corte del día y se pueden comparar día contra día en el
--     selector, que es lo que hace falta para decidir dónde poner la plata.
--     `reset` sigue en Buenos_Aires: ese sí tiene otro corte.
--
--   · El gasto de Meta entra en la zona de la CUENTA PUBLICITARIA. Si esa cuenta
--     no está en Lisboa, el ROAS diario del funnel LATAM mezcla ingresos de un
--     corte con gasto de otro. Es un desfasaje de un día en los bordes, no un
--     error acumulativo, pero explica diferencias que si no se buscan en el lugar
--     equivocado.
--
--   Cambiarla después NO pierde datos: el PATCH de /api/config/funnels recalcula
--   `sessions.day`, `events.day` y `orders.day` con la zona nueva y reconstruye
--   el rollup del rango afectado.
--
-- color distinto del violeta de AR para que se distingan en los gráficos del
--   Resumen, que cruza todos los funnels.
INSERT INTO funnels (slug, name, timezone, sell_currency, ingest_key_hash, variants, color, active)
VALUES
  ('chauhinchazon-latam', 'Chau Hinchazón LATAM', 'Europe/Lisbon', 'USD',
   'PENDING_SET_INGEST_KEY_CHAUHINCHAZON_LATAM', ARRAY['latam'], '#0ea5e9', true)
ON CONFLICT (slug) DO NOTHING;


-- ───────────────────────────────────────────────────────────────────────────
-- 2. Catálogo de pasos · 22 · testfunnel/lib/quiz-v2/data-latam.ts
-- ───────────────────────────────────────────────────────────────────────────
--
-- Los `slug` y el ORDEN son idénticos a los de `chauhinchazon`, y no por
-- casualidad: `lib/quiz-v2/data-sync.test.ts` es un guard que falla si
-- `slidesV3` y `slidesV3Latam` divergen en longitud, `id`, `type` u
-- `optionValues`. O sea que los dos catálogos no pueden separarse sin que el
-- build del funnel lo avise. Se seedea igual y no se comparte la fila porque
-- `funnel_steps` tiene `funnel_id` en la PK y el embudo del panel lee el
-- catálogo del funnel que está mirando.
--
-- Los `label` son los que se ven en el panel. Se mantienen iguales a los del AR
-- salvo "barriga", que es la palabra que la pregunta usa de verdad en el quiz
-- neutro: los dos embudos se leen en paralelo, así que conviene que las filas se
-- llamen igual excepto donde el contenido cambió.
INSERT INTO funnel_steps (funnel_id, step_index, slug, label, kind)
SELECT f.id, v.step_index, v.slug, v.label, v.kind
FROM (VALUES
  (0,  'landing_hook',       'Landing',                     'landing'),
  (1,  'edad',               'Edad',                         'question'),
  (2,  'tipo_cuerpo',        'Tipo de cuerpo',               'question'),
  (3,  'donde_acumula',      'Dónde acumula',                'question'),
  (4,  'viral_news',         'Nota viral',                   'content'),
  (5,  'nombre',             'Nombre',                       'question'),
  (6,  'como_afecta',        'Cómo le afecta',               'question'),
  (7,  'conforme_panza',     'Conforme con la barriga',      'question'),
  (8,  'impide_deshincharse','Qué le impide deshincharse',   'question'),
  (9,  'no_es_tu_culpa',     'No es tu culpa',               'question'),
  (10, 'que_queres_lograr',  'Qué quiere lograr',            'question'),
  (11, 'peso_actual',        'Peso actual',                  'question'),
  (12, 'altura',             'Altura',                       'question'),
  (13, 'peso_deseado',       'Peso deseado',                 'question'),
  (14, 'embarazos',          'Embarazos',                    'question'),
  (15, 'rutina_diaria',      'Rutina diaria',                'question'),
  (16, 'horas_sueno',        'Horas de sueño',               'question'),
  (17, 'agua_dia',           'Agua por día',                 'question'),
  (18, 'expert_bridge',      'Puente al experto',            'content'),
  (19, 'diagnosis_result',   'Diagnóstico',                  'content'),
  (20, 'loading_steps',      'Armando el plan',              'content'),
  (21, 'sales_page',         'Página de venta',              'sales')
) AS v(step_index, slug, label, kind)
JOIN funnels f ON f.slug = 'chauhinchazon-latam'
ON CONFLICT (funnel_id, step_index) DO NOTHING;


-- ───────────────────────────────────────────────────────────────────────────
-- 3. Etapas del embudo · las mismas 8 fronteras que el AR
-- ───────────────────────────────────────────────────────────────────────────
--
-- El seed de la 017 no las crea: era un CROSS JOIN sobre los funnels que
-- existían el día que esa migración corrió, y ya está registrada en
-- `schema_migrations`, así que no vuelve a ejecutarse. Un funnel nuevo sin
-- etapas dibuja el embudo por pasos pero deja la vista por etapas vacía.
--
-- Se repiten las fronteras del AR (mismos slugs, mismo criterio) para que las
-- dos pantallas se puedan comparar barra contra barra. Las dos decisiones que la
-- 017 dejó anotadas siguen valiendo acá: `viral_news` cuenta dentro de Preguntas
-- y `loading_steps` dentro de Diagnóstico, porque abrir etapa propia para un paso
-- de contenido en medio del quiz le da a la etapa dos conteos posibles y
-- ensancha el trapecio.
--
-- Los WHERE son los mismos guards de la 017: la etapa de paso solo se crea si el
-- funnel tiene ese slug, y nada se toca si el funnel ya tiene etapas
-- configuradas a mano.
INSERT INTO funnel_stages (funnel_id, stage_order, label, starts_at_slug, milestone)
SELECT f.id, v.stage_order, v.label, v.starts_at_slug, v.milestone
  FROM funnels f
  CROSS JOIN (VALUES
    (0, 'Landing',           'landing_hook',     NULL),
    (1, 'Preguntas',         'edad',             NULL),
    (2, 'Puente al experto', 'expert_bridge',    NULL),
    (3, 'Diagnóstico',       'diagnosis_result', NULL),
    (4, 'Página de venta',   'sales_page',       NULL),
    (5, 'Vio la venta',      NULL,               'sales_view'),
    (6, 'Clickeó comprar',   NULL,               'checkout_click'),
    (7, 'Compró',            NULL,               'purchase')
  ) AS v(stage_order, label, starts_at_slug, milestone)
 WHERE f.slug = 'chauhinchazon-latam'
   AND (v.starts_at_slug IS NULL
        OR EXISTS (SELECT 1 FROM funnel_steps s
                    WHERE s.funnel_id = f.id AND s.slug = v.starts_at_slug))
   AND NOT EXISTS (SELECT 1 FROM funnel_stages x WHERE x.funnel_id = f.id)
ON CONFLICT (funnel_id, stage_order) DO NOTHING;
