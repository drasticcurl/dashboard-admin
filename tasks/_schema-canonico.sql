-- Validación del schema canónico de tasks/00-PLAN.md §3
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- §3.1
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

-- §3.2
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

-- §3.3
CREATE TABLE IF NOT EXISTS sessions (
  id                 uuid        PRIMARY KEY,
  funnel_id          smallint    NOT NULL REFERENCES funnels(id),
  visitor_id         uuid        NOT NULL,
  variant            text        NOT NULL DEFAULT 'default',
  day                date        NOT NULL,
  started_at         timestamptz NOT NULL,
  last_seen_at       timestamptz NOT NULL,
  max_step_index     smallint    NOT NULL DEFAULT 0,
  sales_view_at      timestamptz,
  checkout_click_at  timestamptz,
  purchased_at       timestamptz,
  upsell_view_at     timestamptz,
  upsell_click_at    timestamptz,
  downsell_view_at   timestamptz,
  utm_source         text NOT NULL DEFAULT '(directo)',
  utm_medium         text NOT NULL DEFAULT '(directo)',
  utm_campaign       text NOT NULL DEFAULT '(directo)',
  utm_content        text NOT NULL DEFAULT '(directo)',
  utm_term           text NOT NULL DEFAULT '(directo)',
  fbclid             text,
  country            text,
  device             text,
  referrer_host      text,
  landing_path       text,
  extra              jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS sessions_funnel_day_idx      ON sessions (funnel_id, day DESC);
CREATE INDEX IF NOT EXISTS sessions_funnel_day_step_idx ON sessions (funnel_id, day, max_step_index);
CREATE INDEX IF NOT EXISTS sessions_funnel_campaign_idx ON sessions (funnel_id, day, utm_campaign);
CREATE INDEX IF NOT EXISTS sessions_visitor_idx         ON sessions (visitor_id);
CREATE INDEX IF NOT EXISTS sessions_purchased_idx       ON sessions (funnel_id, purchased_at)
  WHERE purchased_at IS NOT NULL;

-- §3.4
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

-- §3.5
CREATE TABLE IF NOT EXISTS orders (
  id            bigserial   PRIMARY KEY,
  funnel_id     smallint    REFERENCES funnels(id),
  source        text        NOT NULL,
  shop_domain   text        NOT NULL DEFAULT '*',
  external_id   text        NOT NULL,
  order_number  text,
  email         text,
  status        text        NOT NULL DEFAULT 'approved',
  tier          text        NOT NULL DEFAULT 'unknown',
  amount        numeric(14,2) NOT NULL,
  currency      text        NOT NULL,
  amount_eur    numeric(14,2),
  fx_rate       numeric(20,10),
  fx_day        date,
  fx_stale      boolean     NOT NULL DEFAULT false,
  session_id    uuid,
  visitor_id    uuid,
  variant       text,
  utm_source    text NOT NULL DEFAULT '(directo)',
  utm_medium    text NOT NULL DEFAULT '(directo)',
  utm_campaign  text NOT NULL DEFAULT '(directo)',
  utm_content   text NOT NULL DEFAULT '(directo)',
  utm_term      text NOT NULL DEFAULT '(directo)',
  fbclid        text,
  country       text,
  purchased_at  timestamptz NOT NULL,
  day           date        NOT NULL,
  refunded_at   timestamptz,
  raw           jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS orders_funnel_day_idx   ON orders (funnel_id, day DESC);
CREATE INDEX IF NOT EXISTS orders_status_idx       ON orders (status);
CREATE INDEX IF NOT EXISTS orders_email_idx        ON orders (email);
CREATE INDEX IF NOT EXISTS orders_session_idx      ON orders (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_unattributed_idx ON orders (day DESC) WHERE funnel_id IS NULL;

CREATE TABLE IF NOT EXISTS order_items (
  id                 bigserial PRIMARY KEY,
  order_id           bigint  NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  shopify_product_id text,
  shopify_variant_id text,
  title              text,
  quantity           integer NOT NULL DEFAULT 1,
  amount             numeric(14,2),
  tier               text    NOT NULL DEFAULT 'unknown'
);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);

-- §3.6
CREATE TABLE IF NOT EXISTS product_map (
  id          smallserial PRIMARY KEY,
  shop_domain text     NOT NULL DEFAULT '*',
  product_id  text     NOT NULL,
  funnel_id   smallint NOT NULL REFERENCES funnels(id),
  tier        text     NOT NULL,
  label       text,
  UNIQUE (shop_domain, product_id)
);
CREATE TABLE IF NOT EXISTS shop_map (
  shop_domain text     PRIMARY KEY,
  funnel_id   smallint NOT NULL REFERENCES funnels(id)
);

-- §3.7
CREATE TABLE IF NOT EXISTS fx_rates (
  day        date          NOT NULL,
  base       text          NOT NULL,
  quote      text          NOT NULL,
  rate       numeric(20,10) NOT NULL,
  source     text          NOT NULL,
  fetched_at timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (day, base, quote)
);

-- §3.8
CREATE TABLE IF NOT EXISTS daily_metrics (
  funnel_id            smallint NOT NULL REFERENCES funnels(id),
  day                  date     NOT NULL,
  variant              text     NOT NULL DEFAULT '*',
  sessions_count       integer  NOT NULL DEFAULT 0,
  quiz_started         integer  NOT NULL DEFAULT 0,
  sales_views          integer  NOT NULL DEFAULT 0,
  checkout_clicks      integer  NOT NULL DEFAULT 0,
  orders_count         integer  NOT NULL DEFAULT 0,
  orders_refunded      integer  NOT NULL DEFAULT 0,
  revenue_gross        numeric(14,2) NOT NULL DEFAULT 0,
  revenue_refunded     numeric(14,2) NOT NULL DEFAULT 0,
  revenue_gross_eur    numeric(14,2) NOT NULL DEFAULT 0,
  revenue_refunded_eur numeric(14,2) NOT NULL DEFAULT 0,
  computed_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (funnel_id, day, variant)
);

-- §3.9
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

-- §3.10
CREATE TABLE IF NOT EXISTS settings (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- §3.11
CREATE TABLE IF NOT EXISTS ad_spend (
  funnel_id smallint NOT NULL REFERENCES funnels(id),
  day       date     NOT NULL,
  platform  text     NOT NULL DEFAULT 'meta',
  campaign  text     NOT NULL DEFAULT '(todas)',
  spend     numeric(14,2) NOT NULL,
  currency  text     NOT NULL,
  spend_eur numeric(14,2),
  source    text     NOT NULL DEFAULT 'manual',
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (funnel_id, day, platform, campaign)
);
