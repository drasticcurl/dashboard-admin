-- ad_spend se crea vacía con su contrato documentado (plan §3.11).
--
-- La va a escribir otra app (gasto de ads desde la API de Meta) y NINGUNA
-- pantalla la consume todavía: crearla hoy evita que esa app necesite una
-- migración después.
--
-- Contrato de inserción: INSERT ... ON CONFLICT (funnel_id, day, platform,
-- campaign) DO UPDATE SET spend = EXCLUDED.spend, spend_eur = EXCLUDED.spend_eur,
-- synced_at = now().
--
-- campaign usa '(todas)' como centinela para el gasto a nivel cuenta, la
-- misma convención que los UTMs de sessions/orders: el gasto agregado no se
-- puede mezclar con una campaña que se llame 'todas'.

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
