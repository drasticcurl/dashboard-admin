-- ═══════════════════════════════════════════════════════════════════════════
-- 014 — Gasto de publicidad, por cuenta y hasta nivel de anuncio.
--
-- POR QUÉ SE REEMPLAZA `ad_spend` EN LUGAR DE EXTENDERLA
-- La tabla de la 008 se creó vacía como reserva, con clave
-- (funnel_id, day, platform, campaign): solo alcanza para gasto por nombre de
-- campaña. Los UTMs de los funnels traen los IDs de Meta —
-- `{{campaign.name}}|{{campaign.id}}` en utm_campaign, adset en utm_medium y ad
-- en utm_content — así que el gasto se puede cruzar con las ventas por ID
-- exacto en tres niveles, y eso es lo que permite ROAS por anuncio en vez de por
-- nombre aproximado. Se puede reemplazar sin migrar datos porque nunca se
-- escribió una fila (verificado antes de escribir esto).
--
-- POR QUÉ EL GASTO NO ENTRA EN `orders.cost_amount`
-- El costo de producto y la comisión son POR VENTA: se congelan en la orden. El
-- gasto de ads es POR DÍA y existe aunque no haya ninguna venta. Meterlo en la
-- orden obligaría a repartirlo entre las ventas del día, que es una decisión
-- arbitraria y rompería el neto en cuanto llegue una venta más. Se suma a nivel
-- agregado y produce una línea nueva:
--
--   Neto       = bruto − devoluciones − comisiones − costos     (por venta)
--   Resultado  = Neto − Ads                                     (por día)
-- ═══════════════════════════════════════════════════════════════════════════

-- Cuentas publicitarias y a qué funnel pertenece cada una.
CREATE TABLE IF NOT EXISTS ad_accounts (
  -- El id que usa Meta, con el prefijo: 'act_123456789'.
  account_id text        PRIMARY KEY,
  platform   text        NOT NULL DEFAULT 'meta',
  name       text,
  currency   text,
  -- A qué funnel se le imputa el gasto de esta cuenta. NULL = sin asignar: el
  -- gasto se registra igual y aparece como "sin asignar", nunca se descarta.
  funnel_id  smallint    REFERENCES funnels(id) ON DELETE SET NULL,
  active     boolean     NOT NULL DEFAULT true,
  last_sync_at timestamptz,
  last_sync_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

DROP TABLE IF EXISTS ad_spend;

CREATE TABLE ad_spend (
  id         bigserial   PRIMARY KEY,
  platform   text        NOT NULL DEFAULT 'meta',
  account_id text        NOT NULL,
  funnel_id  smallint    REFERENCES funnels(id) ON DELETE SET NULL,
  day        date        NOT NULL,
  -- Hasta dónde baja la fila. Se guarda un nivel por vez (hoy 'ad', el más
  -- granular): agregar por campaña o por día es un GROUP BY, pero desagregar lo
  -- que se guardó agregado es imposible.
  level      text        NOT NULL DEFAULT 'ad',
  -- Centinela '' y no NULL: PostgreSQL trata NULL ≠ NULL, así que un índice
  -- único con NULLs no deduplica y el sync insertaría la misma fila cada vez.
  -- Es la misma lección de las migraciones 008/009 de los funnels.
  campaign_id   text NOT NULL DEFAULT '',
  campaign_name text,
  adset_id      text NOT NULL DEFAULT '',
  adset_name    text,
  ad_id         text NOT NULL DEFAULT '',
  ad_name       text,
  spend      numeric(14,2) NOT NULL DEFAULT 0,
  currency   text        NOT NULL,
  -- Convertido con la cotización del día del gasto y congelado, igual que las
  -- ventas: un reporte de marzo no puede moverse porque hoy se movió el euro.
  spend_eur  numeric(14,2),
  fx_rate    numeric(20,10),
  impressions bigint NOT NULL DEFAULT 0,
  clicks      bigint NOT NULL DEFAULT 0,
  synced_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ad_spend_level_valido CHECK (level IN ('account', 'campaign', 'adset', 'ad'))
);

-- Columnas planas en el único (no expresiones): así el ON CONFLICT del sync
-- matchea sin ambigüedad.
CREATE UNIQUE INDEX IF NOT EXISTS ad_spend_unico
  ON ad_spend (platform, account_id, day, level, campaign_id, adset_id, ad_id);

CREATE INDEX IF NOT EXISTS ad_spend_funnel_day_idx ON ad_spend (funnel_id, day DESC);
CREATE INDEX IF NOT EXISTS ad_spend_campaign_idx   ON ad_spend (campaign_id) WHERE campaign_id <> '';
CREATE INDEX IF NOT EXISTS ad_spend_sin_funnel_idx ON ad_spend (day DESC) WHERE funnel_id IS NULL;

-- El Resumen lee del rollup.
ALTER TABLE daily_metrics
  ADD COLUMN IF NOT EXISTS ad_spend     numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ad_spend_eur numeric(14,2) NOT NULL DEFAULT 0;
