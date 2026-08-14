-- Ventas: orders, order_items y los dos mapas de atribución (plan §3.5, §3.6).
--
-- UNIQUE (source, external_id) es la idempotencia del webhook: un reenvío de
-- Shopify entra como 'duplicate' en webhook_events y no duplica la fila.
--
-- El tier va por ítem porque una compra de Shopify trae front + bump en la
-- misma orden; orders.tier es el del ítem de mayor precio (el "principal").
--
-- funnel_id es NULLeable a propósito (D10): una venta que no se puede
-- atribuir se guarda igual y aparece en el cajón "Ventas sin atribuir" de la
-- UI. Perder plata en silencio no es una opción.
--
-- amount_eur/fx_rate/fx_day se congelan en el momento de la ingesta (D12):
-- un reporte de marzo no puede cambiar porque hoy se movió el dólar.
--
-- shop_domain usa '*' como centinela y nunca es NULL: en un índice único
-- PostgreSQL trata NULL ≠ NULL y el ON CONFLICT dejaría de deduplicar. Los
-- funnels ya se comieron ese bug dos veces (migraciones 008 y 009 de
-- funnel_counts).

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

-- La resolución del funnel de una venta (D10) prueba primero la fila exacta
-- (shop_domain, product_id) y después ('*', product_id); por eso el centinela
-- existe y el UNIQUE incluye las dos columnas: sin él, un mapa de una tienda
-- específica y uno global para el mismo producto convivirían pero el segundo
-- quedaría sin deduplicar.
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
