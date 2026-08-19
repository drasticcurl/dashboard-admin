-- ═══════════════════════════════════════════════════════════════════════════
-- 023 — El experimento pasa a ser dimensión de ENTRADA (filtro del embudo).
--
-- La 020 dejó anotado por qué NO creaba este índice: mientras el experimento
-- fuera una dimensión de salida (un GROUP BY de una card), el desglose escaneaba
-- el MISMO conjunto que el resto del embudo ya escanea y
-- `sessions_funnel_day_idx` alcanzaba. Un índice más habría sido mantenimiento
-- en cada insert del ingest a cambio de nada.
--
-- Eso cambió: ahora `experiment` entra al WHERE compartido del embudo, así que
-- elegir una variante recorta el histograma de pasos, las etapas, las campañas,
-- los países y los dispositivos. Son seis queries por pintura, todas con el
-- mismo filtro, y esa es la condición que la 020 puso para que el índice pague.
--
-- Parcial (WHERE experiment IS NOT NULL) a propósito: las sesiones que no
-- participan del test son la mayoría histórica y no se filtran nunca por esta
-- columna. Indexarlas engordaría el índice sin que ninguna consulta lo use.
--
-- OJO con el otro camino del filtro: pedir "(sin asignar)" resuelve por
-- `experiment IS NULL`, que este índice NO cubre. Es deliberado — ese caso cae
-- en `sessions_funnel_day_idx`, que ya sirve, y es una consulta de diagnóstico,
-- no la que se mira todos los días.
-- ═══════════════════════════════════════════════════════════════════════════

-- CREATE INDEX sin CONCURRENTLY porque el runner (scripts/migrate.ts) envuelve
-- cada migración en una transacción y CONCURRENTLY no puede correr dentro de
-- una. Eso implica un ShareLock sobre `sessions` mientras se construye: los
-- SELECT del panel siguen andando, los INSERT del ingest esperan. El ingest es
-- fire-and-forget con timeout de 2 s del lado del funnel, así que una
-- construcción larga se traduce en eventos perdidos, no en visitantes
-- esperando. Conviene correrla en un rato de poco tráfico.
CREATE INDEX IF NOT EXISTS sessions_funnel_day_experiment_idx
  ON sessions (funnel_id, day, experiment)
  WHERE experiment IS NOT NULL;

-- El desglose suma la plata de cada sesión con una subconsulta correlacionada
-- por `orders.session_id`. `orders_session_idx` (migración 004) ya la cubre y es
-- parcial sobre session_id IS NOT NULL, que es exactamente el subconjunto que se
-- consulta: no hace falta ningún índice nuevo del lado de orders.
