-- Catálogo: funnels y su árbol de pasos (plan §3.1, §3.2).
--
-- La key de ingesta nunca se guarda en claro, solo su hash (sha256 hex): el
-- funnel se identifica por ese hash en el ingest y la key real vive en el
-- .env del propio funnel. Una fuga de la base no filtra credenciales.
--
-- funnel_steps es un catálogo por funnel (D1): los paneles no tienen las
-- mismas preguntas, y el funnel N+1 aparece con un INSERT en esta tabla, sin
-- migración de schema ni UNIONs a mano. step_index es 0-based porque es el
-- índice real del array de slides en el código del quiz.

CREATE TABLE IF NOT EXISTS funnels (
  id              smallserial  PRIMARY KEY,
  slug            text         NOT NULL UNIQUE,
  name            text         NOT NULL,
  timezone        text         NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
  sell_currency   text         NOT NULL DEFAULT 'ARS',
  ingest_key_hash text         NOT NULL UNIQUE,
  variants        text[]       NOT NULL DEFAULT ARRAY['default'],
  color           text         NOT NULL DEFAULT '#8b5cf6',
  active          boolean      NOT NULL DEFAULT true,
  created_at      timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS funnel_steps (
  funnel_id        smallint NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  step_index       smallint NOT NULL,
  slug             text     NOT NULL,
  label            text     NOT NULL,
  kind             text     NOT NULL DEFAULT 'question',
  counts_in_funnel boolean  NOT NULL DEFAULT true,
  PRIMARY KEY (funnel_id, step_index),
  UNIQUE (funnel_id, slug)
);
