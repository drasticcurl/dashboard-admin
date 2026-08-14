-- events: log crudo, particionado por mes (plan §3.4, D2).
--
-- Son ~80.000 eventos/día: la retención (180 días) tiene que ser un DROP de
-- partición, instantáneo, no un DELETE de millones de filas. El embudo NO se
-- calcula desde acá (lo hace sessions); events es el respaldo y el drill-down.
--
-- La PK incluye occurred_at porque es la clave de partición: sin ella
-- Postgres no permite crear la tabla particionada.
--
-- No hay índice único sobre event_uid: en una tabla particionada tendría que
-- incluir occurred_at y no serviría para deduplicar. La deduplicación real la
-- hacen sessions (por su PK) y orders (UNIQUE source + external_id).
--
-- events_default existe para que un evento con fecha fuera de rango —un reloj
-- desviado en un funnel— no haga fallar el INSERT y se pierda (D20). La
-- retención de un mes viejo se hace DROP TABLE events_YYYY_MM: por eso la
-- migración crea 12 particiones desde el mes en curso y el cron mensual
-- (scripts/ensure-partitions.ts) crea las que falten.

CREATE TABLE IF NOT EXISTS events (
  id          bigserial,
  funnel_id   smallint    NOT NULL,
  session_id  uuid        NOT NULL,
  visitor_id  uuid,
  name        text        NOT NULL,
  step_index  smallint,
  step_slug   text,
  variant     text        NOT NULL DEFAULT 'default',
  occurred_at timestamptz NOT NULL,
  day         date        NOT NULL,
  value_cents bigint,
  currency    text,
  event_uid   text,
  props       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX IF NOT EXISTS events_session_idx    ON events (session_id);
CREATE INDEX IF NOT EXISTS events_funnel_day_idx ON events (funnel_id, day);

-- Las 12 particiones mensuales que arrancan en el mes en curso.
DO $$
DECLARE m date := date_trunc('month', now())::date; i int;
BEGIN
  FOR i IN 0..11 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS events_%s PARTITION OF events FOR VALUES FROM (%L) TO (%L)',
      to_char(m + (i || ' month')::interval, 'YYYY_MM'),
      (m + (i || ' month')::interval)::date,
      (m + ((i+1) || ' month')::interval)::date);
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS events_default PARTITION OF events DEFAULT;
