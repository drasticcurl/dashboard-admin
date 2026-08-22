-- ═══════════════════════════════════════════════════════════════════════════
-- 025 — Frescura de la Jerarquía: la marca de desaparición y el reloj del sync.
--
-- EL PROBLEMA QUE RESUELVE
-- La Sync_Jerarquia de `lib/ads/jerarquia.ts` ya CUENTA los objetos que Meta
-- dejó de devolver (`r.desaparecidos`), pero no los marca: las filas quedan con
-- su `synced_at` viejo, intactas, y la tabla del gestor las dibuja igual que a
-- las que Meta acaba de confirmar. Medido contra producción: 34 de 326
-- conjuntos, 13 de 216 campañas y 38 de 505 anuncios no se refrescan desde hace
-- más de 20 minutos, y el más viejo tiene 5 días y 17 horas. Son objetos sobre
-- los que el panel muestra estado y presupuesto como si fueran de ahora.
--
-- POR QUÉ UNA COLUMNA NUEVA Y NO `synced_at`
-- Son dos hechos distintos. `synced_at` responde "cuándo lo vimos por última
-- vez"; `desaparecido_at` responde "desde cuándo Meta no lo devuelve". Con una
-- sola columna, un objeto que desapareció hace cinco días y uno cuyo sync falló
-- hace cinco días serían el mismo dato, y son dos problemas con dos respuestas
-- opuestas: el primero no se va a arreglar solo, el segundo sí.
--
-- Lo mismo del lado de la cuenta: `last_sync_at` es el reloj del Sync_Gasto y
-- `last_hierarchy_sync_at` el de la Sync_Jerarquia. Son dos sincronizaciones con
-- costos y cadencias distintas que se atrasan por separado (R4.5), así que
-- compartir la columna haría que un gasto fresco tape una jerarquía atrasada.
--
-- CORRE SOBRE DATOS VIVOS Y ES ADITIVO
-- Tres columnas nullable sin default, dos en `ad_accounts` y una fila de
-- `settings`. No hay DROP, ni cambio de tipo, ni reescritura de tabla: un
-- `ADD COLUMN` nullable sin default es sólo catálogo, no toca las filas. La
-- segunda corrida no hace nada.
--
-- NO HACE FALTA BACKFILL
-- En `desaparecido_at`, `NULL` significa "presente en la última corrida", que es
-- exactamente el estado correcto de todas las filas que ya existen: las que de
-- verdad desaparecieron se marcan solas en la próxima Sync_Jerarquia (T6.1). Un
-- backfill que marcara algo acá tendría que adivinar desde cuándo, y la fecha
-- inventada sería el dato que la pantalla muestra.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 1. La marca de desaparición en los tres niveles de la Jerarquía
-- ───────────────────────────────────────────────────────────────────────────
-- NULLABLE Y SIN DEFAULT, a propósito, igual que las métricas de video de la
-- 018: acá el NULL es un valor con significado ("Meta lo sigue devolviendo"), no
-- un dato ausente. Con `NOT NULL DEFAULT now()` toda la Jerarquía nacería
-- desaparecida.
--
-- Nada se borra cuando un objeto desaparece (R3.5): puede tener gasto histórico
-- atribuido en `ad_spend` — que no tiene FK hacia acá justamente por eso — y la
-- desaparición puede ser transitoria. Cuando el objeto vuelve, la columna se
-- pone en NULL y la marca se va (R3.6).

ALTER TABLE ad_campaigns
  ADD COLUMN IF NOT EXISTS desaparecido_at timestamptz;

ALTER TABLE ad_sets
  ADD COLUMN IF NOT EXISTS desaparecido_at timestamptz;

ALTER TABLE ads
  ADD COLUMN IF NOT EXISTS desaparecido_at timestamptz;

COMMENT ON COLUMN ad_campaigns.desaparecido_at IS
  'Cuándo la Sync_Jerarquia detectó que Meta dejó de devolver esta campaña. NULL = presente en la última corrida. No es lo mismo que synced_at, que dice cuándo se la vio por última vez: un objeto desaparecido hace 5 días y uno cuyo sync falló hace 5 días tienen el mismo synced_at y problemas opuestos.';

COMMENT ON COLUMN ad_sets.desaparecido_at IS
  'Cuándo la Sync_Jerarquia detectó que Meta dejó de devolver este conjunto. NULL = presente en la última corrida. Ver el comentario de ad_campaigns.desaparecido_at.';

COMMENT ON COLUMN ads.desaparecido_at IS
  'Cuándo la Sync_Jerarquia detectó que Meta dejó de devolver este anuncio. NULL = presente en la última corrida. Ver el comentario de ad_campaigns.desaparecido_at.';

-- ┌─────────────────────────────────────────────────────────────────────────┐
-- │ POR QUÉ NO SE CREA UN ÍNDICE PARCIAL POR `desaparecido_at IS NOT NULL`. │
-- └─────────────────────────────────────────────────────────────────────────┘
-- Estaba previsto en el plan y se descartó midiendo, no por gusto.
--
-- 1. NINGUNA CONSULTA DEL SPEC FILTRA POR ESTA COLUMNA COMO PREDICADO PRINCIPAL.
--    · El conteo de desactualizados de la barra (R3.3) lo hace el cliente sobre
--      las filas que ya recibió; no hay un `SELECT count(*) ... WHERE
--      desaparecido_at IS NOT NULL` por pantalla.
--    · El UPDATE de la marca (T6.1) arranca por `account_id`, que ya tiene su
--      índice (`ad_campaigns_account_idx` y compañía) desde la 016.
--    · El preflight (T14.1) mira la columna de objetos que ya trajo por id.
--
-- 2. Y AUNQUE ALGUNA FILTRARA, NO PAGARÍA. Estas tablas son de cientos de filas:
--    hoy 8, 13 y 23 páginas (`relpages` de ad_campaigns, ad_sets y ads), unos
--    35 en el peor caso con el volumen de producción. Un seq scan de 23 páginas
--    es una lectura de memoria; el planner elegiría el scan igual y el índice
--    quedaría sin usar.
--
-- 3. LO QUE SÍ COSTARÍA. La Sync_Jerarquia hace upsert de las tres tablas
--    completas cada 15 minutos por cron, y con este spec también cada vez que
--    alguien aprieta Actualizar (T8). Cada índice de más es mantenimiento en
--    cada una de esas escrituras, para responder una consulta que nadie hace.
--
-- Si con volumen real aparece una consulta que cuente desaparecidos en el
-- servidor y `EXPLAIN (ANALYZE, BUFFERS)` la muestre como cuello de botella, el
-- índice correcto es éste y va en una migración medida, no acá a ciegas:
--   CREATE INDEX ad_sets_desaparecidos_idx
--     ON ad_sets (account_id) WHERE desaparecido_at IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. El reloj de la Sync_Jerarquia, por cuenta
-- ───────────────────────────────────────────────────────────────────────────
-- `last_sync_at` / `last_sync_error` (014) son del Sync_Gasto y los escribe
-- `syncAdSpend`. Estas dos son el par equivalente para la Sync_Jerarquia, y se
-- llenan con el mismo criterio: se escriben TAMBIÉN cuando la corrida falla, con
-- el error al lado, para que un fallo no se vea como un dato fresco (R4.4).
--
-- `last_hierarchy_sync_error` en NULL = la última corrida terminó bien. Es lo que
-- deja a la pantalla decir "la Jerarquía puede estar atrasada" con el motivo, en
-- lugar de mostrar una hora que no significa nada.

ALTER TABLE ad_accounts
  ADD COLUMN IF NOT EXISTS last_hierarchy_sync_at    timestamptz,
  ADD COLUMN IF NOT EXISTS last_hierarchy_sync_error text;

COMMENT ON COLUMN ad_accounts.last_hierarchy_sync_at IS
  'Fin de la última corrida de Sync_Jerarquia de esta cuenta, exitosa o no. Distinta de last_sync_at, que es del Sync_Gasto: son dos sincronizaciones que se atrasan por separado.';

COMMENT ON COLUMN ad_accounts.last_hierarchy_sync_error IS
  'El error de la última corrida de Sync_Jerarquia, o NULL si terminó bien. Se escribe junto con last_hierarchy_sync_at para que una corrida fallida no se lea como un dato fresco.';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. El umbral de frescura
-- ───────────────────────────────────────────────────────────────────────────
-- A partir de cuántos segundos una Frescura_Objeto se considera vieja y la fila
-- se marca en pantalla (R3.1), y a partir de cuándo el preflight relee el objeto
-- contra Meta antes de decidir una omisión (R6.2).
--
-- 900 = 15 minutos, que es la cadencia del cron de la Sync_Jerarquia. Con un
-- umbral más bajo, todas las filas se verían viejas justo antes de cada corrida
-- y la marca no distinguiría nada; con uno más alto, los 5 días del objeto más
-- viejo de producción tardarían más en ser visibles. El valor está en `settings`
-- y no en el env porque es un criterio de lectura que se ajusta desde el panel,
-- sin deploy.
--
-- `settings.value` es jsonb (007): el número va sin comillas, como el `180` de
-- `retention_days_events` que seedeó la 010, para que se lea con `value::int` y
-- no haya que sacarle comillas primero.
--
-- ON CONFLICT DO NOTHING, como todos los seeds de este proyecto: si el valor ya
-- está —porque la migración corrió antes o porque alguien lo ajustó desde el
-- panel— re-correrla no se lo puede pisar.
INSERT INTO settings (key, value) VALUES
  ('ads_frescura_umbral_segundos', '900'::jsonb)
ON CONFLICT (key) DO NOTHING;
