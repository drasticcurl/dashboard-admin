-- ═══════════════════════════════════════════════════════════════════════════
-- 017 — Rediseño de la UI: etapas del embudo por funnel y layouts de widgets.
--
-- DDL canónico del rediseño, en un solo archivo. T01 lo copia a
-- `db/migrations/017_rediseno_ui.sql` tal cual. Se copia, no se mejora.
--
-- EJECUTADO Y VERIFICADO contra un PostgreSQL 16 con las migraciones 001-016
-- aplicadas: corre limpio y es idempotente (la segunda corrida no hace nada).
--
-- ESTA MIGRACIÓN CORRE SOBRE DATOS VIVOS
-- El panel está en producción con ventas reales. Todo acá es ADITIVO: una tabla
-- nueva y filas nuevas en `settings`. Ni un DROP, ni un ALTER que reescriba una
-- tabla, ni un cambio de tipo. No toca `funnel_steps`, y el §1 explica por qué
-- eso no es una comodidad sino el punto.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- 1. Etapas del embudo, configurables POR FUNNEL
-- ───────────────────────────────────────────────────────────────────────────
--
-- QUÉ PROBLEMA RESUELVE
-- El embudo literal necesita ~8 partes con conteos decrecientes. Los funnels
-- tienen 22 y 27 pasos de catálogo: un embudo de 25 trapecios mide 20 px por
-- segmento y no se lee. Las etapas agrupan pasos contiguos en partes legibles.
--
-- POR QUÉ UNA TABLA APARTE Y NO UNA COLUMNA EN `funnel_steps`
-- Porque el import de pasos la borraría. `app/api/config/steps/route.ts` (el
-- POST de "Importar pasos") hace DELETE de todos los pasos del funnel y los
-- re-INSERTa con cinco columnas:
--     DELETE FROM funnel_steps WHERE funnel_id = $1;
--     INSERT INTO funnel_steps (funnel_id, step_index, slug, label, kind) ...
-- Cualquier columna que no esté en ese INSERT vuelve a su default en cada
-- importación. Ya le pasa a `counts_in_funnel`, que se resetea a `true` en
-- silencio y que `lib/funnels.ts:60` sí lee: es un bug preexistente y T07 lo
-- arregla. Una columna `stage` ahí tendría el mismo destino.
--
-- POR QUÉ SE REFERENCIA POR SLUG Y NO POR step_index
-- El slug es estable, el índice no. Reordenar el quiz cambia todos los índices
-- y dejaría cada frontera de etapa apuntando al paso equivocado, sin error:
-- el embudo mostraría partes mal armadas y nadie sabría por qué. Con el slug,
-- reordenar mueve la frontera con su paso. Y si un slug desaparece, la etapa
-- queda huérfana de forma DETECTABLE (§3 de la verificación) en lugar de
-- apuntar a otra cosa.
--
-- CÓMO SE LEE
-- Una etapa arranca en `starts_at_slug` y termina donde arranca la siguiente.
-- El conteo de la etapa es el del ÚLTIMO paso que contiene, porque una etapa
-- se "completó" cuando la sesión la atravesó entera. Tomar el primero daría
-- una etapa que no cae nunca.
CREATE TABLE IF NOT EXISTS funnel_stages (
  funnel_id       smallint NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  -- Orden de la etapa en el embudo, 0 arriba. No tiene que coincidir con
  -- ningún step_index: es el orden de presentación.
  stage_order     smallint NOT NULL,
  label           text     NOT NULL,
  -- El slug del paso donde ARRANCA esta etapa. NULL sólo para las etapas de
  -- hitos (§ hitos abajo), que no salen del catálogo de pasos.
  starts_at_slug  text,
  -- Los tres hitos no son pasos del quiz: salen de columnas propias de
  -- `sessions` (sales_view_at, checkout_click_at, purchased_at). Se modelan
  -- como etapas para que el embudo sea una sola lista ordenada, con este
  -- campo diciendo de dónde sale el número.
  milestone       text,
  created_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (funnel_id, stage_order),
  -- Una etapa sale de un paso o de un hito, nunca de los dos ni de ninguno.
  -- Sin este CHECK una fila con los dos en NULL no tendría de dónde sacar el
  -- conteo y el embudo dibujaría un trapecio de ancho indefinido.
  CONSTRAINT funnel_stages_fuente_unica CHECK (
    (starts_at_slug IS NOT NULL AND milestone IS NULL)
    OR (starts_at_slug IS NULL AND milestone IS NOT NULL)
  ),
  CONSTRAINT funnel_stages_milestone_valido CHECK (
    milestone IS NULL OR milestone IN ('sales_view', 'checkout_click', 'purchase')
  ),
  CONSTRAINT funnel_stages_label_no_vacio CHECK (btrim(label) <> '')
);

-- Un slug no puede arrancar dos etapas del mismo funnel: sería una frontera
-- ambigua y la agrupación quedaría a merced del ORDER BY.
CREATE UNIQUE INDEX IF NOT EXISTS funnel_stages_slug_unico
  ON funnel_stages (funnel_id, starts_at_slug) WHERE starts_at_slug IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS funnel_stages_milestone_unico
  ON funnel_stages (funnel_id, milestone) WHERE milestone IS NOT NULL;


-- ───────────────────────────────────────────────────────────────────────────
-- 2. Seed de las etapas por defecto, una vez por funnel
-- ───────────────────────────────────────────────────────────────────────────
--
-- Las etapas son configurables por funnel (pedido explícito del usuario), así
-- que esto es un punto de partida editable desde Config, no una regla fija.
--
-- POR QUÉ ESTAS FRONTERAS
-- Los dos funnels comparten los slugs de contenido (verificado contra
-- producción: `landing_hook`, `viral_news`, `expert_bridge`,
-- `diagnosis_result`, `loading_steps`, `sales_page`), así que el mismo seed
-- sirve para los dos y para cualquier funnel nuevo que siga la convención.
--
-- DOS DECISIONES QUE EL USUARIO DELEGÓ, ANOTADAS PARA QUE SE PUEDAN REVERTIR:
--
--   · `viral_news` (paso 4) NO abre etapa propia: cuenta dentro de Preguntas.
--     Es un paso de contenido que cae en medio del quiz (después de la
--     pregunta 3 y antes de la 5). Si abriera etapa, "Contenido" agruparía el
--     paso 4 con los pasos 18-20 y la etapa tendría dos conteos posibles: el
--     del paso 4 (mucha gente) y el del 20 (poca). El trapecio se ensancharía.
--     Para separarlo hay que partir Preguntas en dos, y se hace agregando una
--     etapa que arranque en `nombre` (el paso 5).
--
--   · `loading_steps` ("Armando el plan") NO abre etapa propia: cuenta dentro
--     de Diagnóstico. Es una pantalla de carga donde casi nadie se cae, así
--     que sumaría un trapecio que no informa. Para separarla, una fila más.
INSERT INTO funnel_stages (funnel_id, stage_order, label, starts_at_slug, milestone)
SELECT f.id, v.stage_order, v.label, v.starts_at_slug, v.milestone
  FROM funnels f
  CROSS JOIN (VALUES
    (0, 'Landing',           'landing_hook',     NULL),
    -- Preguntas arranca en el primer paso del quiz y se come `viral_news`.
    (1, 'Preguntas',         'edad',             NULL),
    (2, 'Puente al experto', 'expert_bridge',    NULL),
    -- Diagnóstico se come `loading_steps`.
    (3, 'Diagnóstico',       'diagnosis_result', NULL),
    (4, 'Página de venta',   'sales_page',       NULL),
    (5, 'Vio la venta',      NULL,               'sales_view'),
    (6, 'Clickeó comprar',   NULL,               'checkout_click'),
    (7, 'Compró',            NULL,               'purchase')
  ) AS v(stage_order, label, starts_at_slug, milestone)
 -- Sólo para funnels que de verdad tengan ese paso: un funnel con otra
 -- convención de slugs no recibe una etapa que apunta a un paso inexistente.
 WHERE v.starts_at_slug IS NULL
    OR EXISTS (SELECT 1 FROM funnel_steps s
                WHERE s.funnel_id = f.id AND s.slug = v.starts_at_slug)
 -- Idempotente y no destructivo: si el funnel ya tiene etapas configuradas
 -- (porque el usuario las editó), este seed no las toca.
   AND NOT EXISTS (SELECT 1 FROM funnel_stages x WHERE x.funnel_id = f.id)
ON CONFLICT (funnel_id, stage_order) DO NOTHING;


-- ───────────────────────────────────────────────────────────────────────────
-- 3. Layouts de widgets
-- ───────────────────────────────────────────────────────────────────────────
--
-- El usuario pidió que el layout se guarde "en la VPS con un botón de
-- guardar", así que va a `settings` (jsonb) y no a localStorage.
--
-- CONSECUENCIA QUE HAY QUE DECIR EN LA UI, NO ESCONDER
-- El panel se autentica con una contraseña compartida: no hay usuarios. Un
-- layout en `settings` es GLOBAL. Si dos personas usan el panel, el que
-- guarda último gana y el otro ve cambiar su pantalla sin haberla tocado.
-- No es un bug del rediseño, es el modelo de auth del panel (P-R05). La barra
-- de configuración tiene que decir "este layout lo ven todos".
--
-- POR QUÉ UNA FILA POR PANTALLA Y NO UNA SOLA CON TODO
-- Guardar Resumen no puede pisar el layout de Ventas. Con una fila única, dos
-- pestañas abiertas guardando en distinto orden se sobreescriben entre sí.
--
-- FORMA DEL VALOR (la valida zod en el endpoint, T03):
--   {"v":1,"widgets":[{"id":"neto-total","w":1,"h":1},{"id":"por-dia","w":2,"h":2}]}
--
--   v        versión del formato. Un layout guardado con un catálogo viejo
--            puede referir widgets que ya no existen: el runtime los ignora y
--            avisa, en lugar de romper la pantalla.
--   widgets  ORDEN incluido: la posición en el array es la posición en la
--            grilla. Sin esto haría falta un campo `order` que se puede
--            desincronizar del array.
--   w, h     1 o 2. Los cuatro tamaños que pidió el usuario (1x1, 1x2, 2x1,
--            2x2) son las cuatro combinaciones, así que no hace falta un
--            enum de tamaños aparte.
--
-- El array vacío es un layout válido y significa "no mostrar nada". Es
-- distinto de la fila ausente, que significa "usá el layout por defecto".
INSERT INTO settings (key, value) VALUES
  ('ui_layout_resumen', 'null'::jsonb),
  ('ui_layout_ventas',  'null'::jsonb)
ON CONFLICT (key) DO NOTHING;
