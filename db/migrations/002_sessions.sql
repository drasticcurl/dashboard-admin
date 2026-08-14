-- sessions: el corazón del embudo (plan §3.3). Una fila por sesión, no por
-- evento.
--
-- El embudo se mide con max_step_index en vez de contar eventos: QuizProgress
-- se dispara en cada cambio de slide, incluido el ir-y-volver, y contar
-- eventos inflaba los números (D3). La métrica es "cuántas sesiones distintas
-- llegaron al paso N", que sale de la suma acumulada inversa sobre esta
-- columna.
--
-- Los UTMs usan '(directo)' como centinela en vez de NULL: el upsert solo
-- completa la atribución mientras siga en '(directo)' (CASE WHEN), y con NULL
-- ese CASE nunca matchearía. Los funnels ya se comieron dos veces el bug de
-- NULLs en valores que participan de comparaciones e índices (migraciones 008
-- y 009 de funnel_counts).
--
-- day se escribe una vez y nunca se actualiza: una sesión que cruza la
-- medianoche pertenece al día en que empezó. Si se recalculara, el embudo de
-- ayer cambiaría solo (D19).

CREATE TABLE IF NOT EXISTS sessions (
  id                 uuid        PRIMARY KEY,
  funnel_id          smallint    NOT NULL REFERENCES funnels(id),
  visitor_id         uuid        NOT NULL,
  variant            text        NOT NULL DEFAULT 'default',
  day                date        NOT NULL,
  started_at         timestamptz NOT NULL,
  last_seen_at       timestamptz NOT NULL,
  max_step_index     smallint    NOT NULL DEFAULT 0,
  -- hitos, fuera de la secuencia de slides
  sales_view_at      timestamptz,
  checkout_click_at  timestamptz,
  purchased_at       timestamptz,
  upsell_view_at     timestamptz,
  upsell_click_at    timestamptz,
  downsell_view_at   timestamptz,
  -- atribución: se congela con el primer valor no-directo que llega
  utm_source         text NOT NULL DEFAULT '(directo)',
  utm_medium         text NOT NULL DEFAULT '(directo)',
  utm_campaign       text NOT NULL DEFAULT '(directo)',
  utm_content        text NOT NULL DEFAULT '(directo)',
  utm_term           text NOT NULL DEFAULT '(directo)',
  fbclid             text,
  -- contexto
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
