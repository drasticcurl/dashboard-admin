-- daily_metrics: rollup para el Resumen unificado (plan §3.8).
--
-- El Embudo y Ventas consultan las tablas base (son rápidas); el Resumen
-- cruza todos los funnels y todo el histórico, y por eso lee de acá,
-- recalculado por cron cada 10 minutos (3 días) y por noche (35 días).
--
-- variant usa '*' como centinela para "todas las variantes": forma parte de
-- la PK compuesta, y un NULL ahí dejaría filas duplicadas sin deduplicar (la
-- convención del proyecto: nunca NULL en columnas de índices únicos).

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
