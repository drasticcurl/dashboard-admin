-- La red de seguridad de D20: ningún dato se descarta por no entenderlo.
--
-- ingest_errors registra los pasos desconocidos, los payloads inválidos y las
-- keys que no matchean; webhook_events registra cada entrega de Shopify con
-- su resultado (ok | duplicate | bad_signature | …). Los dos se muestran en
-- la UI: el modo de falla aceptable es "aparece un warning", el inaceptable
-- es "el número está mal y nadie se enteró".
--
-- settings es jsonb a propósito: un setting nuevo (fx_source, retention,
-- vista por defecto…) no pide migración de schema.

CREATE TABLE IF NOT EXISTS ingest_errors (
  id          bigserial   PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  funnel_id   smallint,
  reason      text        NOT NULL,
  detail      text,
  payload     jsonb
);
CREATE INDEX IF NOT EXISTS ingest_errors_received_idx ON ingest_errors (received_at DESC);

CREATE TABLE IF NOT EXISTS webhook_events (
  id          bigserial   PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  source      text        NOT NULL,
  shop_domain text,
  topic       text,
  external_id text,
  status      text        NOT NULL,
  error       text,
  payload     jsonb
);
CREATE INDEX IF NOT EXISTS webhook_events_received_idx ON webhook_events (received_at DESC);
CREATE INDEX IF NOT EXISTS webhook_events_status_idx   ON webhook_events (status);

CREATE TABLE IF NOT EXISTS settings (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
