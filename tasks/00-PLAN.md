# PANEL — Dashboard de tracking unificado multi-funnel

**Documento maestro. Todo agente lee este archivo completo antes de abrir su task.**

Proyecto nuevo: `~/Desktop/funnel/dashboard-admin` → se sirve en `https://panel.hilvanapp.com`.
Base de datos nueva: **PostgreSQL 16 en la VPS**, en Docker. Supabase deja de ser la base de
tracking y queda **solo para registros** (leads de `clientes` y usuarios de las PWA).

Repos que se modifican, además del nuevo:

| Repo | Ruta | Rol |
|---|---|---|
| `testfunnel` | `~/Desktop/funnel/testfunnel` | funnel **chauhinchazon** (anti-hinchazón), AR + LATAM |
| `reset-app` | `~/Desktop/funnel/reset-app` | funnel **reset** (Protocolo Reset+), hombres 40+ |

---

## 0. Qué se construye y qué no

**Se construye**

1. Un Postgres propio en la VPS con el modelo de datos del tracking y de las ventas.
2. Un endpoint de ingesta HTTP con una key por funnel. Los funnels le mandan eventos
   server-to-server; la base nunca sale de `127.0.0.1`.
3. Un webhook de Shopify centralizado que registra **todas** las ventas de **todos** los funnels
   en un solo lugar, con moneda original y conversión a euros.
4. Una app Next.js con cuatro secciones: **Embudo** (por funnel, paso a paso), **Ventas** (por
   funnel), **Resumen** (unificado de todos los funnels) y **Leads + Configuración**.
5. La instrumentación de los dos funnels actuales para que alimenten ese ingest.
6. El borrado de los dos paneles `/admin` que hoy vive dentro de cada funnel.

**No se construye** (queda fuera de alcance, explícito para que ningún agente lo invente)

- Ingreso de gasto de ads ni cálculo de ROAS. La tabla `ad_spend` **se crea vacía** y su contrato de
  inserción queda documentado (§3.11), porque el usuario va a escribirla desde otra app más
  adelante. Ninguna pantalla la consume todavía.
- Cambios en el copy, el diseño, las preguntas o los precios de los funnels.
- Cambios en Meta CAPI. El valor fijo que se le manda a Meta (`META_PURCHASE_VALUE = 4.4 EUR`)
  **no se toca**. Romper CAPI es la peor forma de fallar esta tarea.
- Cambios en las PWA, en Supabase Auth ni en los entitlements, salvo lo que dice D9.
- Tests A/B. No existen más (decisión del usuario). El código muerto de `ab_entry_*` / `af_*` /
  `sp_*` se borra junto con `lib/admin/`.

---

## 1. Decisiones cerradas

No hay nada que decidir. Si aparece algo que este documento no resuelve, se anota en §10 y **no se
decide en el código**.

**D1 — Una sola tabla de eventos y de sesiones para todos los funnels, con catálogo de pasos por
funnel.** El usuario había planteado una tabla por funnel. Se descartó: obliga a una migración de
schema y a código nuevo cada vez que se larga un funnel, y toda consulta unificada pasa a ser un
`UNION` editado a mano. Lo que da el mismo seguimiento individual es `funnels` + `funnel_steps`
(el catálogo de pasos, distinto por funnel) + `sessions.funnel_id`. Se elige el funnel en la UI y
se ve su embudo con **sus** preguntas y **sus** nombres. El funnel N+1 aparece solo.

**D2 — Eventos crudos con sesión, no contadores agregados.** Con 5.000-10.000 visitas diarias, el
volumen es de ~80.000 eventos/día (~4,4 GB/año, sobre 96 GB de disco). El modelo agregado actual
(`funnel_counts`) no permite deduplicar, ni medir visitantes únicos, ni cruzar una visita con su
venta. La tabla `events` va **particionada por mes** para que la retención sea un `DROP PARTITION`
y no un `DELETE` de millones de filas.

**D3 — El embudo se mide por sesión única, no por evento.** Hoy `QuizProgress` se dispara cada vez
que cambia el slide, incluido el ir-y-volver, así que los counts están inflados. La métrica pasa a
ser "cuántas sesiones distintas llegaron al paso N", calculada como
`count(sessions) WHERE max_step_index >= N`. Es exacta porque los dos quizzes son **estrictamente
lineales** (el motor nunca saltea ni ramifica). Esa suposición está anotada en §3.4 y hay que
revisarla el día que exista un funnel con ramas.

**D4 — El denominador del porcentaje se conserva igual que hoy.** El 100% es el paso 0
(`landing_hook`), con toggle a "desde la 1ª pregunta" (paso 1). Es exactamente el comportamiento de
`FunnelView.tsx:203-241` del panel viejo, que el usuario quiere mantener.

**D5 — Los funnels no hablan con Postgres. Hablan HTTP.** Un funnel futuro puede vivir en Vercel o
en otra máquina y tiene que funcionar igual. La base se publica solo en `127.0.0.1` y el único
proceso que la toca es el dashboard.

**D6 — El browser sigue posteando a `/api/track` del propio funnel; el relay al ingest lo hace el
servidor del funnel.** Así la ingest key nunca llega al browser, no hay CORS, no aparece un dominio
tercero que los bloqueadores puedan cortar, y la lógica de Meta CAPI queda intacta. El relay es
**fire-and-forget**: si el dashboard está caído, el funnel no se entera y el visitante no espera.

**D7 — Dos ids, los dos first-party.** `vid` (visitante, cookie de 365 días) y `sid` (sesión,
cookie de 30 minutos con renovación deslizante). El embudo se mide por `sid`. La venta se ata a la
sesión por el cart attribute `sid`, con fallback a `vid` y, último recurso, la herencia de UTMs por
email que ya existe. **Las dos cookies no son `httpOnly`** a propósito: las crea el cliente y las
lee el servidor del mismo origen en cada `/api/track`, así que **ningún emisor de eventos necesita
cambiar su payload**. Es el diff más chico posible.

**D8 — El webhook de Shopify se SUMA, no se muda.** Shopify entrega el mismo topic a dos URLs si
existen dos suscripciones (verificado en la documentación de Shopify). El dashboard recibe una copia
para reportar; **cada funnel conserva la suya** porque es lo que alimenta `purchases` en Supabase, y
`purchases` es lo que habilita el contenido del upsell en la PWA
(`lib/pwa/upsell-access.ts: product_id === UPSELL_PRODUCT_ID`). Mudar el webhook dejaba ese chequeo
ciego y a los compradores del upsell sin acceso. Las dos suscripciones se crean desde el admin de la
tienda, así que **firman con el mismo secret** que ya está en el env de cada funnel.

**D9 — Del webhook de cada funnel se saca el tracking y se deja el resto.** Sigue escribiendo
`purchases` en Supabase (entitlements) y sigue mandando `Purchase` a Meta CAPI. Se le saca
únicamente el `getStore().track(...)` y todo lo que cuelgue de `lib/admin/`.

**D10 — El funnel de una venta se resuelve en tres pasos, en este orden**, y nunca se descarta una
venta: (1) el cart attribute `funnel`, (2) la tabla `product_map` por `(shop_domain, product_id)`,
(3) la tabla `shop_map` por dominio de la tienda. Si los tres fallan, la orden se guarda con
`funnel_id = NULL` y aparece en el dashboard en un cajón visible **"Ventas sin atribuir"**. Perder
plata en silencio no es una opción.

**D11 — El tier de producto lo setea el usuario a mano** en `product_map`
(`front | bump | upsell | upsell2 | downsell`). Sin eso no hay AOV real ni tasa de upsell. Un
`product_id` no mapeado entra como `unknown` y se muestra como tal, no se adivina por el nombre.

**D12 — Las ventas se guardan en su moneda original (ARS) y además convertidas a EUR.** La
conversión se hace **en el momento de la ingesta**, con la cotización del día, y se **congela** en
la fila (`amount_eur`, `fx_rate`, `fx_day`). Un reporte de marzo no puede cambiar porque hoy se
movió el dólar. La UI muestra EUR por defecto y tiene un toggle a moneda original.

**D13 — La cotización la trae un cron 1 vez por día** desde `dolarapi.com` (`/v1/cotizaciones/eur`,
casa **oficial**, campo `venta`), con `open.er-api.com/v6/latest/ARS` como respaldo. Las dos
responden sin API key (verificado). La tabla `fx_rates` es editable a mano: insertar una fila para
un día pisa la del cron, para el caso de querer usar blue o una cotización propia. Si al ingresar
una venta no hay cotización del día, se usa la más reciente disponible y la fila queda marcada
`fx_stale = true`; un backfill la corrige cuando llega la del día.

**D14 — A Meta se le sigue mandando el monto fijo.** Nada de este proyecto toca eso.

**D15 — Se migra el histórico de `purchases`, no el de `funnel_counts`.** Las ventas son plata y
están limpias. `funnel_counts` tiene basura conocida y documentada por sus propias migraciones: el
día centinela `2000-01-01`, `quiz_version='v1'` que es LATAM mal etiquetado e inseparable, y ventas
infladas por el backfill manual del panel viejo. El embudo arranca de cero el día del deploy.

**D16 — Auth: una sola password + cookie firmada con HMAC.** Se copia el mecanismo que ya está
probado en `lib/admin/auth.ts` de cualquiera de los dos funnels (HMAC-SHA256 del timestamp con la
password como clave, TTL 12 h, `timingSafeEqual`, rate limit por IP de 5 intentos / 15 min). No se
reinventa. Al ser un panel con datos de ventas en un subdominio público, además va `noindex`,
bypass total de cache en Cloudflare y `no-store` en todas las respuestas.

**D17 — Postgres corre en Docker; el dashboard corre en PM2.** Docker ya está en la VPS (lo usa
`finanzas` con `postgres:16`), así que la base va en su propio proyecto de Compose (`name: panel`),
con volumen propio (`panel_pgdata`) y publicada **solo** en `127.0.0.1`. La app va en PM2 + Next
standalone + Caddy, igual que los funnels, porque es el flujo que el usuario ya opera todos los
días y no obliga a buildear una imagen en cada deploy.

**D18 — Acceso a la base con `pg` y SQL a mano.** Sin ORM. Los archivos de `db/migrations/*.sql` son
la fuente de verdad del schema y se aplican con un runner propio.

**D19 — La zona horaria es por funnel.** Columna `funnels.timezone`, default
`America/Argentina/Buenos_Aires`. El corte del día de una sesión se calcula con la TZ de su funnel.
El Resumen unificado usa la TZ del dashboard (`DASHBOARD_TZ`, misma default) para no mezclar días.

**D20 — Ningún dato se descarta por no entenderlo.** Un evento con un paso desconocido, una venta
sin funnel, un webhook con firma inválida: todo queda registrado (`ingest_errors`, `webhook_events`,
`funnel_id NULL`) y visible en la UI. El modo de falla aceptable es "aparece un warning"; el
inaceptable es "el número está mal y nadie se enteró".

---

## 2. Arquitectura

```
                    ┌─ browser del funnel ──────────────────────────┐
                    │  cookies first-party: <p>_vid (365d)          │
                    │                       <p>_sid (30 min)        │
                    │  POST /api/track  (mismo origen, sin cambios) │
                    └───────────────────┬───────────────────────────┘
                                        │
              ┌─────────────────────────▼─────────────────────────┐
              │ funnel (Next, PM2)  /api/track                    │
              │   1. Meta CAPI            ← NO SE TOCA            │
              │   2. relay al ingest      ← NUEVO, fire&forget    │
              │   3. funnel_counts        ← SE BORRA              │
              └─────────────────────────┬─────────────────────────┘
                                        │ POST /api/ingest
                                        │ Authorization: Bearer <ingest key>
                                        ▼
   Shopify ──────────────────────┐  ┌───────────────────────────────┐
     · webhook al funnel  (PWA)  │  │ panel.hilvanapp.com           │
     · webhook al panel  (NUEVO) ├──▶ Next 14, PM2 :3005            │
                                 │  │  /api/ingest                  │
   dolarapi.com ─── cron 1×día ──┘  │  /api/webhooks/shopify        │
                                    │  /  /embudo  /ventas  /leads  │
                                    └──────────────┬────────────────┘
                                                   │ pg, 127.0.0.1
                                    ┌──────────────▼────────────────┐
                                    │ PostgreSQL 16 (Docker)        │
                                    │ volumen panel_pgdata          │
                                    └───────────────────────────────┘

   Supabase (se queda, solo registros): clientes (leads) · auth.users (PWA) · purchases (entitlement)
```

**Puertos y hosts.** El dashboard escucha en `127.0.0.1:3005`, una sola instancia (no necesita
balanceo, y el rate limit del login es in-memory). Postgres en `127.0.0.1:5432` si está libre,
`5433` si no; se verifica con `ss -tlnp` antes de instalar. `panel.hilvanapp.com` entra en el
wildcard Origin CA `*.hilvanapp.com` que ya existe, así que no hace falta certificado nuevo.

---

## 3. Schema — fuente de verdad

Esto es **canónico**. T01 lo copia a `db/migrations/` tal cual. Ningún otro task modifica el
schema; si uno cree que necesita una columna nueva, va a §10.

Convenciones heredadas del proyecto, y **no son estéticas**:

- **Nunca `NULL` en una columna que participe de un índice único.** PostgreSQL trata `NULL ≠ NULL`,
  así que un único con NULLs no deduplica nada. Los funnels ya se comieron ese bug dos veces
  (migraciones 008 y 009 de `funnel_counts` existen solo para arreglarlo). Se usan centinelas:
  `'(directo)'` para UTMs, `'*'` para "cualquiera".
- Los índices únicos van sobre **columnas planas**, no sobre expresiones, para que el `onConflict`
  de los drivers matchee.
- Todo timestamp es `timestamptz`. El día local se guarda aparte, en una columna `date`, ya
  resuelto con la TZ del funnel.

### 3.1 `funnels`

```sql
CREATE TABLE funnels (
  id              smallserial  PRIMARY KEY,
  slug            text         NOT NULL UNIQUE,          -- 'chauhinchazon' | 'reset'
  name            text         NOT NULL,                 -- 'Chau Hinchazón' | 'Protocolo Reset+'
  timezone        text         NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
  sell_currency   text         NOT NULL DEFAULT 'ARS',
  ingest_key_hash text         NOT NULL UNIQUE,          -- sha256 hex de la key en claro
  variants        text[]       NOT NULL DEFAULT ARRAY['default'],
  color           text         NOT NULL DEFAULT '#8b5cf6',
  active          boolean      NOT NULL DEFAULT true,
  created_at      timestamptz  NOT NULL DEFAULT now()
);
```

La key en claro vive en el `.env.production` del funnel. El dashboard nunca la guarda: hashea la que
le presentan y busca por hash. Así la key **identifica** al funnel, no hace falta mandar el slug.

### 3.2 `funnel_steps`

El catálogo de pasos, distinto por funnel. Es la tabla que resuelve "los paneles no tienen las
mismas preguntas".

```sql
CREATE TABLE funnel_steps (
  funnel_id        smallint NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  step_index       smallint NOT NULL,       -- 0-based, el orden real del quiz
  slug             text     NOT NULL,       -- el id del slide en el código: 'edad', 'donde_acumula'
  label            text     NOT NULL,       -- lo que se muestra: 'Edad', 'Dónde acumula'
  kind             text     NOT NULL DEFAULT 'question',  -- landing|question|content|sales
  counts_in_funnel boolean  NOT NULL DEFAULT true,
  PRIMARY KEY (funnel_id, step_index),
  UNIQUE (funnel_id, slug)
);
```

### 3.3 `sessions` — el corazón del embudo

Una fila por sesión. Es la tabla que se consulta para dibujar el embudo, y es chica
(~10.000 filas/día, ~3,6 M/año).

```sql
CREATE TABLE sessions (
  id                 uuid        PRIMARY KEY,        -- el sid que generó el browser
  funnel_id          smallint    NOT NULL REFERENCES funnels(id),
  visitor_id         uuid        NOT NULL,
  variant            text        NOT NULL DEFAULT 'default',   -- 'ar' | 'latam' | 'default'
  day                date        NOT NULL,           -- día local del funnel, del PRIMER evento
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
  country            text,        -- ISO-2, de CF-IPCountry
  device             text,        -- mobile | desktop | tablet | unknown
  referrer_host      text,
  landing_path       text,
  extra              jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX sessions_funnel_day_idx      ON sessions (funnel_id, day DESC);
CREATE INDEX sessions_funnel_day_step_idx ON sessions (funnel_id, day, max_step_index);
CREATE INDEX sessions_funnel_campaign_idx ON sessions (funnel_id, day, utm_campaign);
CREATE INDEX sessions_visitor_idx         ON sessions (visitor_id);
CREATE INDEX sessions_purchased_idx       ON sessions (funnel_id, purchased_at)
  WHERE purchased_at IS NOT NULL;
```

**`day` se escribe una sola vez y no se actualiza nunca.** Una sesión que cruza la medianoche
pertenece al día en que empezó. Si se recalculara, el embudo de ayer cambiaría solo.

**El upsert tiene que ser idempotente y no depender del orden de llegada.** `LEAST` y `GREATEST` en
PostgreSQL **ignoran los NULL** (devuelven NULL solo si todo es NULL), que es exactamente lo que se
necesita para los hitos:

```sql
INSERT INTO sessions (id, funnel_id, visitor_id, variant, day, started_at, last_seen_at,
                      max_step_index, sales_view_at, checkout_click_at, /* … */
                      utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid,
                      country, device, referrer_host, landing_path)
VALUES ($1, $2, /* … */)
ON CONFLICT (id) DO UPDATE SET
  started_at        = LEAST(sessions.started_at, EXCLUDED.started_at),
  last_seen_at      = GREATEST(sessions.last_seen_at, EXCLUDED.last_seen_at),
  max_step_index    = GREATEST(sessions.max_step_index, EXCLUDED.max_step_index),
  sales_view_at     = LEAST(sessions.sales_view_at, EXCLUDED.sales_view_at),
  checkout_click_at = LEAST(sessions.checkout_click_at, EXCLUDED.checkout_click_at),
  purchased_at      = LEAST(sessions.purchased_at, EXCLUDED.purchased_at),
  upsell_view_at    = LEAST(sessions.upsell_view_at, EXCLUDED.upsell_view_at),
  upsell_click_at   = LEAST(sessions.upsell_click_at, EXCLUDED.upsell_click_at),
  downsell_view_at  = LEAST(sessions.downsell_view_at, EXCLUDED.downsell_view_at),
  -- la atribución solo se completa si todavía estaba en '(directo)'
  utm_source   = CASE WHEN sessions.utm_source   = '(directo)' THEN EXCLUDED.utm_source   ELSE sessions.utm_source   END,
  utm_medium   = CASE WHEN sessions.utm_medium   = '(directo)' THEN EXCLUDED.utm_medium   ELSE sessions.utm_medium   END,
  utm_campaign = CASE WHEN sessions.utm_campaign = '(directo)' THEN EXCLUDED.utm_campaign ELSE sessions.utm_campaign END,
  utm_content  = CASE WHEN sessions.utm_content  = '(directo)' THEN EXCLUDED.utm_content  ELSE sessions.utm_content  END,
  utm_term     = CASE WHEN sessions.utm_term     = '(directo)' THEN EXCLUDED.utm_term     ELSE sessions.utm_term     END,
  fbclid        = COALESCE(sessions.fbclid, EXCLUDED.fbclid),
  country       = COALESCE(sessions.country, EXCLUDED.country),
  device        = COALESCE(sessions.device, EXCLUDED.device),
  referrer_host = COALESCE(sessions.referrer_host, EXCLUDED.referrer_host),
  landing_path  = COALESCE(sessions.landing_path, EXCLUDED.landing_path);
  -- day y variant NO se actualizan
```

### 3.4 `events` — crudo, particionado

Es el respaldo y el drill-down: permite reprocesar, auditar y responder "qué pasó exactamente en
esta sesión". El embudo **no** se calcula desde acá.

```sql
CREATE TABLE events (
  id          bigserial,
  funnel_id   smallint    NOT NULL,
  session_id  uuid        NOT NULL,
  visitor_id  uuid,
  name        text        NOT NULL,     -- vocabulario cerrado, §6
  step_index  smallint,
  step_slug   text,
  variant     text        NOT NULL DEFAULT 'default',
  occurred_at timestamptz NOT NULL,
  day         date        NOT NULL,
  value_cents bigint,
  currency    text,
  event_uid   text,                     -- el eventId del cliente, para rastrear duplicados
  props       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)         -- la PK tiene que incluir la clave de partición
) PARTITION BY RANGE (occurred_at);

CREATE INDEX events_session_idx ON events (session_id);
CREATE INDEX events_funnel_day_idx ON events (funnel_id, day);
```

- La migración crea las particiones de los **12 meses** que arrancan en el mes en curso, más una
  `events_default` para que **nunca** se pierda una fila por falta de partición.
- `scripts/ensure-partitions.ts` crea las que falten y se corre por cron mensual.
- Retención: 180 días. Se hace con `DROP TABLE events_YYYY_MM`, que es instantáneo.
- **No hay índice único sobre `event_uid`**: en una tabla particionada tendría que incluir
  `occurred_at` y no serviría para deduplicar. La deduplicación real la hacen `sessions` (por su PK)
  y `orders` (por `(source, external_id)`).

### 3.5 `orders` y `order_items`

```sql
CREATE TABLE orders (
  id            bigserial   PRIMARY KEY,
  funnel_id     smallint    REFERENCES funnels(id),   -- NULL = sin atribuir (D10), visible en la UI
  source        text        NOT NULL,                 -- shopify | hotmart | import | manual
  shop_domain   text        NOT NULL DEFAULT '*',
  external_id   text        NOT NULL,                 -- 'shopify_1234'
  order_number  text,
  email         text,
  status        text        NOT NULL DEFAULT 'approved',  -- approved|refunded|chargeback|pending
  tier          text        NOT NULL DEFAULT 'unknown',   -- front|bump|upsell|upsell2|downsell|unknown
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
  day           date        NOT NULL,       -- día local del funnel de la compra
  refunded_at   timestamptz,
  raw           jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);

CREATE INDEX orders_funnel_day_idx   ON orders (funnel_id, day DESC);
CREATE INDEX orders_status_idx       ON orders (status);
CREATE INDEX orders_email_idx        ON orders (email);
CREATE INDEX orders_session_idx      ON orders (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX orders_unattributed_idx ON orders (day DESC) WHERE funnel_id IS NULL;

CREATE TABLE order_items (
  id                 bigserial PRIMARY KEY,
  order_id           bigint  NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  shopify_product_id text,
  shopify_variant_id text,
  title              text,
  quantity           integer NOT NULL DEFAULT 1,
  amount             numeric(14,2),
  tier               text    NOT NULL DEFAULT 'unknown'
);
CREATE INDEX order_items_order_idx ON order_items (order_id);
```

Una orden de Shopify puede traer front + bump en la misma compra: por eso el tier va **por ítem**, y
`orders.tier` es el del ítem de mayor precio (el "principal").

### 3.6 `product_map` y `shop_map`

```sql
CREATE TABLE product_map (
  id          smallserial PRIMARY KEY,
  shop_domain text     NOT NULL DEFAULT '*',   -- '*' = cualquier tienda
  product_id  text     NOT NULL,
  funnel_id   smallint NOT NULL REFERENCES funnels(id),
  tier        text     NOT NULL,
  label       text,
  UNIQUE (shop_domain, product_id)
);

CREATE TABLE shop_map (
  shop_domain text     PRIMARY KEY,
  funnel_id   smallint NOT NULL REFERENCES funnels(id)
);
```

`shop_domain` es `NOT NULL DEFAULT '*'` y no nullable, justamente por la regla de los NULL en
índices únicos. La resolución prueba primero la fila exacta `(shop_domain, product_id)` y después
`('*', product_id)`.

### 3.7 `fx_rates`

```sql
CREATE TABLE fx_rates (
  day        date          NOT NULL,
  base       text          NOT NULL,      -- 'ARS'
  quote      text          NOT NULL,      -- 'EUR'
  rate       numeric(20,10) NOT NULL,     -- 1 base = rate quote
  source     text          NOT NULL,      -- 'dolarapi' | 'er-api' | 'manual'
  fetched_at timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (day, base, quote)
);
```

`rate` se guarda como **1 unidad de base en quote**. Con 1 EUR = 1728,6485 ARS, la fila es
`base='ARS', quote='EUR', rate = 1/1728.6485 = 0.0005785…`. Un `INSERT … ON CONFLICT DO UPDATE`
permite pisar el día a mano con `source='manual'`.

### 3.8 `daily_metrics` — rollup para el Resumen

El Embudo y Ventas consultan las tablas base (son rápidas). El **Resumen unificado** cruza todos los
funnels y todo el histórico, así que lee de acá. Lo recalcula un cron cada 10 minutos para los
últimos 3 días, y una vez por noche para los últimos 35.

```sql
CREATE TABLE daily_metrics (
  funnel_id            smallint NOT NULL REFERENCES funnels(id),
  day                  date     NOT NULL,
  variant              text     NOT NULL DEFAULT '*',   -- '*' = todas
  sessions_count       integer  NOT NULL DEFAULT 0,
  quiz_started         integer  NOT NULL DEFAULT 0,     -- max_step_index >= 1
  sales_views          integer  NOT NULL DEFAULT 0,
  checkout_clicks      integer  NOT NULL DEFAULT 0,
  orders_count         integer  NOT NULL DEFAULT 0,
  orders_refunded      integer  NOT NULL DEFAULT 0,
  revenue_gross        numeric(14,2) NOT NULL DEFAULT 0,   -- moneda del funnel
  revenue_refunded     numeric(14,2) NOT NULL DEFAULT 0,
  revenue_gross_eur    numeric(14,2) NOT NULL DEFAULT 0,
  revenue_refunded_eur numeric(14,2) NOT NULL DEFAULT 0,
  computed_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (funnel_id, day, variant)
);
```

### 3.9 `ingest_errors` y `webhook_events` — la red de seguridad de D20

```sql
CREATE TABLE ingest_errors (
  id          bigserial   PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  funnel_id   smallint,
  reason      text        NOT NULL,   -- unknown_step|invalid_payload|unauthorized|unknown_event
  detail      text,
  payload     jsonb
);
CREATE INDEX ingest_errors_received_idx ON ingest_errors (received_at DESC);

CREATE TABLE webhook_events (
  id          bigserial   PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  source      text        NOT NULL,   -- 'shopify'
  shop_domain text,
  topic       text,
  external_id text,
  status      text        NOT NULL,   -- ok|duplicate|bad_signature|unmatched_funnel|error|ignored
  error       text,
  payload     jsonb
);
CREATE INDEX webhook_events_received_idx ON webhook_events (received_at DESC);
CREATE INDEX webhook_events_status_idx   ON webhook_events (status);
```

Retención de las dos: 30 días, por cron.

### 3.10 `settings`

```sql
CREATE TABLE settings (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

Para lo que se configura desde la UI y no justifica una tabla: `fx_source` (`oficial` | `blue`),
`default_currency_view` (`EUR` | `ARS`), `retention_days_events`.

### 3.11 `ad_spend` — se crea vacía, contrato documentado

El usuario va a escribirla desde otra app con la API de Meta. **Ninguna pantalla la consume en este
proyecto.** Se crea ahora para que esa app no necesite una migración después.

```sql
CREATE TABLE ad_spend (
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
```

Contrato de inserción: `INSERT … ON CONFLICT (funnel_id, day, platform, campaign) DO UPDATE SET
spend = EXCLUDED.spend, spend_eur = EXCLUDED.spend_eur, synced_at = now()`. `campaign` usa
`'(todas)'` como centinela para el gasto a nivel cuenta, misma convención que los UTMs.

### 3.12 Seeds

Los dos funnels y sus catálogos de pasos. **Las listas de abajo hay que verificarlas contra el
código antes de escribirlas** (§ verificación de T01): son el orden real de `slidesV3` en cada repo
al momento de escribir este plan.

`chauhinchazon` → `testfunnel/lib/quiz-v2/data.ts`, 22 pasos, variants `{ar, latam}`:

| idx | slug | kind | label |
|---|---|---|---|
| 0 | `landing_hook` | landing | Landing |
| 1 | `edad` | question | Edad |
| 2 | `tipo_cuerpo` | question | Tipo de cuerpo |
| 3 | `donde_acumula` | question | Dónde acumula |
| 4 | `viral_news` | content | Nota viral |
| 5 | `nombre` | question | Nombre |
| 6 | `como_afecta` | question | Cómo le afecta |
| 7 | `conforme_panza` | question | Conforme con la panza |
| 8 | `impide_deshincharse` | question | Qué le impide deshincharse |
| 9 | `no_es_tu_culpa` | question | No es tu culpa |
| 10 | `que_queres_lograr` | question | Qué quiere lograr |
| 11 | `peso_actual` | question | Peso actual |
| 12 | `altura` | question | Altura |
| 13 | `peso_deseado` | question | Peso deseado |
| 14 | `embarazos` | question | Embarazos |
| 15 | `rutina_diaria` | question | Rutina diaria |
| 16 | `horas_sueno` | question | Horas de sueño |
| 17 | `agua_dia` | question | Agua por día |
| 18 | `expert_bridge` | content | Puente al experto |
| 19 | `diagnosis_result` | content | Diagnóstico |
| 20 | `loading_steps` | content | Armando el plan |
| 21 | `sales_page` | sales | Página de venta |

`reset` → `reset-app/lib/quiz-v2/data.ts`, 27 pasos, variants `{default}`:

| idx | slug | kind | label |
|---|---|---|---|
| 0 | `landing_hook` | landing | Landing |
| 1 | `edad` | question | Edad |
| 2 | `tipo_cuerpo` | question | Tipo de cuerpo |
| 3 | `donde_acumula` | question | Dónde acumula |
| 4 | `viral_news` | content | Nota viral |
| 5 | `nombre` | question | Nombre |
| 6 | `probo_antes` | question | Probó antes |
| 7 | `desayuno_tipo` | question | Tipo de desayuno |
| 8 | `hora_desayuno` | question | Hora del desayuno |
| 9 | `como_afecta` | question | Cómo le afecta |
| 10 | `conforme_panza` | question | Conforme con la panza |
| 11 | `que_te_frena` | question | Qué lo frena |
| 12 | `no_es_tu_culpa` | question | No es tu culpa |
| 13 | `que_queres_lograr` | question | Qué quiere lograr |
| 14 | `peso_actual` | question | Peso actual |
| 15 | `altura` | question | Altura |
| 16 | `peso_deseado` | question | Peso deseado |
| 17 | `cinturon` | question | Cinturón |
| 18 | `cerveza_semana` | question | Alcohol por semana |
| 19 | `actividad_fisica` | question | Actividad física |
| 20 | `horas_sentado` | question | Horas sentado |
| 21 | `horas_sueno` | question | Horas de sueño |
| 22 | `agua_dia` | question | Agua por día |
| 23 | `expert_bridge` | content | Puente al experto |
| 24 | `diagnosis_result` | content | Diagnóstico |
| 25 | `loading_steps` | content | Armando el plan |
| 26 | `sales_page` | sales | Página de venta |

Las ingest keys **no van en el seed**. Se generan al desplegar (`openssl rand -hex 32`), se guardan
en el `.env.production` de cada funnel y su hash se carga con
`scripts/set-ingest-key.ts <slug> <key>`.

---

## 4. Contrato del ingest — CONGELADO

Lo implementa T02; lo consumen T10 y T11. **Nadie lo cambia sin pasar por §10.**

```
POST https://panel.hilvanapp.com/api/ingest
Authorization: Bearer <INGEST_KEY del funnel>
Content-Type: application/json
```

```jsonc
{
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",   // uuid v4, obligatorio
  "visitorId": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",   // uuid v4, obligatorio
  "variant":   "ar",                                      // opcional, default 'default'
  "events": [                                             // 1..50
    {
      "name": "step_view",                                // vocabulario cerrado, §6
      "at":   "2026-08-11T14:03:11.000Z",                 // ISO-8601 UTC, obligatorio
      "stepIndex": 3,                                     // solo en step_view
      "stepSlug":  "donde_acumula",                       // solo en step_view
      "value":     7790,                                  // opcional
      "currency":  "ARS",                                 // opcional
      "eventUid":  "b0b1…",                               // opcional
      "props":     {}                                     // opcional, jsonb libre
    }
  ],
  "context": {                                            // opcional pero recomendado
    "utms": { "utm_source": "facebook", "utm_medium": "cpc", "utm_campaign": "…",
              "utm_content": "…", "utm_term": "…", "fbclid": "…" },
    "country":  "AR",
    "device":   "mobile",
    "referrer": "https://www.facebook.com/",
    "path":     "/quiz"
  }
}
```

Respuestas:

| Código | Cuerpo | Cuándo |
|---|---|---|
| 200 | `{"ok":true,"accepted":3,"warnings":[]}` | procesado |
| 200 | `{"ok":true,"accepted":3,"warnings":["unknown_step:foo"]}` | procesado con avisos (D20) |
| 401 | `{"ok":false,"error":"unauthorized"}` | falta el Bearer o el hash no matchea |
| 400 | `{"ok":false,"error":"invalid_payload","detail":"…"}` | falló el schema |
| 413 | `{"ok":false,"error":"too_large"}` | body > 64 KB o más de 50 eventos |

Reglas que el ingest **tiene** que cumplir:

1. **Nunca 5xx por un dato raro.** Un paso desconocido, un nombre de evento fuera del vocabulario o
   un `variant` no declarado se guardan igual, se anotan en `ingest_errors` y salen en `warnings`.
2. Todo el batch va en **una transacción**: primero el upsert de `sessions`, después el insert de
   `events`.
3. `day` de la sesión = `(min(events.at) AT TIME ZONE funnels.timezone)::date`.
4. Idempotente: reenviar el mismo batch no puede mover ningún número de `sessions`. Sí duplica filas
   en `events`, y eso es aceptable (es el log crudo, no la métrica).
5. `runtime = 'nodejs'`.

## 5. Contrato del webhook — CONGELADO

Lo implementa T04.

```
POST https://panel.hilvanapp.com/api/webhooks/shopify
X-Shopify-Hmac-Sha256: <base64>
X-Shopify-Topic: orders/paid | orders/create | refunds/create | orders/cancelled
X-Shopify-Shop-Domain: mitienda.myshopify.com
```

- Firma: HMAC-SHA256 **del body crudo** contra cada secret de `SHOPIFY_WEBHOOK_SECRETS` (lista
  separada por comas). Si ninguno matchea → 401 y fila en `webhook_events` con
  `status='bad_signature'`. Si la variable no está configurada, **rechaza**: acá, a diferencia del
  webhook de los funnels, no hay modo permisivo.
- Resolución del funnel: los tres pasos de D10.
- Resolución del tier: `product_map` por ítem; `orders.tier` = tier del ítem más caro.
- Atribución: cart attributes / `note_attributes` primero (`funnel`, `sid`, `vid`, `utm_*`, `fbc`,
  `fbp`), después el query de `landing_site`, y si no hay `utm_source` pero sí `fbclid` → `facebook`
  (misma regla que `lib/utm.ts:inferUtmSource`). Último recurso: heredar los UTMs de la compra
  anterior del mismo email, que es cómo se atribuyen los upsells abiertos desde el mail.
- Si viene `sid`: se escribe `orders.session_id` **y** se marca `sessions.purchased_at`.
- Idempotencia por `UNIQUE (source, external_id)` con `external_id = 'shopify_' || order.id`. Un
  reenvío entra como `status='duplicate'` en `webhook_events` y no duplica la orden.
- Conversión a EUR al momento de la ingesta, congelada en la fila (D12/D13).
- `refunds/create` y `orders/cancelled` → `status='refunded'`, `refunded_at = now()`. **No se borra
  la fila**: el bruto y el neto son dos números distintos y los dos se muestran.
- Responde **200 siempre que la firma sea válida**, incluso si algo interno falló (así Shopify no
  reintenta para siempre); el error queda en `webhook_events`.

## 6. Vocabulario de eventos — CERRADO

| `name` | Qué es | Efecto en `sessions` |
|---|---|---|
| `step_view` | vio un paso del quiz | `max_step_index = GREATEST(…, stepIndex)` |
| `sales_view` | llegó a la página de venta | `sales_view_at` |
| `checkout_click` | clickeó comprar en la venta | `checkout_click_at` |
| `upsell_view` | vio la oferta del upsell | `upsell_view_at` |
| `upsell_click` | clickeó comprar en el upsell | `upsell_click_at` |
| `downsell_view` | vio el downsell | `downsell_view_at` |
| `lead` | dejó el email | ninguno (solo `events`) |
| `purchase` | compró | `purchased_at` — normalmente lo escribe el webhook, no el ingest |

**Mapeo desde los eventos que los funnels ya emiten** (esto es lo que T10 y T11 implementan en
`/api/track`):

| Evento actual | Condición | `name` nuevo |
|---|---|---|
| `QuizProgress` | siempre | `step_view` con `stepIndex = custom.slide`, `stepSlug = custom.question_id` |
| `ViewContent` | `contentName` empieza con `'Sales Page'` | `sales_view` |
| `ViewContent` | `contentCategory === 'Upsell'` | `upsell_view` |
| `InitiateCheckout` | desde la sales page | `checkout_click` |
| `InitiateCheckout` | desde upsell / upsell2 / downsell | `upsell_click` |
| `Lead` | siempre | `lead` |
| `Purchase` | desde `/api/track` (puente Tienda Nube) | `purchase` |

Nota del downsell: hoy el downsell emite `ViewContent` con `contentCategory:'Upsell'`, igual que el
upsell, así que hay que distinguirlos por `contentName` (`downsell_view` si lo nombra, `upsell_view`
si no). Su `InitiateCheckout` entra como `upsell_click`: no hay hito `downsell_click` en `sessions`
porque el downsell es la segunda oferta del mismo momento post-compra y separarlo no cambia ninguna
decisión. Si el `contentName` no alcanza para distinguir la vista, va a §10 antes de adivinar.

Cualquier otro nombre se guarda en `events` tal cual y no toca `sessions`.

---

## 7. Dependencias y olas de paralelismo

```
                              ┌──────────────────────────┐
                              │  T01  FUNDACIÓN          │  ← sola, primero
                              │  schema + docker + libs  │
                              └───┬──────────────────┬───┘
             ┌────────────────────┤                  ├────────────────────┐
             ▼                    ▼                  ▼                    ▼
   ┌──────────────┐     ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
   │ T02  INGEST  │     │ T03  FX      │    │ T04 WEBHOOK  │    │ T05 AUTH+UI  │   OLA A
   └──────────────┘     └──────────────┘    └──────────────┘    └──────┬───────┘
                                                                       │
                        ┌───────────────┬───────────────┬──────────────┤
                        ▼               ▼               ▼              ▼
                 ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌──────────────┐
                 │T06 EMBUDO │  │T07 VENTAS │  │T08 RESUMEN│  │T09 LEADS+CFG │  OLA B
                 └───────────┘  └───────────┘  └───────────┘  └──────────────┘

   En paralelo con todo, desde que existe §4 y §6 (o sea, desde ya):
   ┌────────────────────────┐   ┌────────────────────────┐
   │ T10  testfunnel        │   │ T11  reset-app         │   OLA C (repos distintos)
   └────────────────────────┘   └────────────────────────┘

   Al final, cuando T01+T04 están:
   ┌──────────────────────────────────────────┐
   │ T12  histórico + deploy + runbook        │
   └──────────────────────────────────────────┘
```

| Task | Depende de | Se puede correr junto con |
|---|---|---|
| T01 | — | **nada**, va sola |
| T02 | T01 | T03, T04, T05, T10, T11 |
| T03 | T01 | T02, T04, T05, T10, T11 |
| T04 | T01 | T02, T03, T05, T10, T11 |
| T05 | T01 | T02, T03, T04, T10, T11 |
| T06 | T01, T05 | T07, T08, T09, T10, T11 |
| T07 | T01, T05 | T06, T08, T09, T10, T11 |
| T08 | T01, T05 | T06, T07, T09, T10, T11 |
| T09 | T01, T05 | T06, T07, T08, T10, T11 |
| T10 | §4 y §6 de este doc | todo excepto T11 en el mismo repo (son repos distintos: sí, en paralelo) |
| T11 | §4 y §6 de este doc | ídem |
| T12 | T01, T04 | T06, T07, T08, T09 |

Configuración recomendada: **1 agente para T01**, después **4 en paralelo** (T02, T03, T04, T05) más
**2 más** en los repos de los funnels (T10, T11), después **4 en paralelo** (T06-T09) y por último
T12.

## 8. Ownership de archivos — regla anti-colisión

Con varios agentes escribiendo el mismo repo, dos que toquen el mismo archivo se pisan. **Cada task
solo escribe los archivos de su fila.** Si un task necesita algo de un archivo ajeno, lo lee pero no
lo escribe; si cree que necesita escribirlo, va a §10.

| Task | Archivos que puede crear o modificar |
|---|---|
| **T01** | `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.mjs`, `postcss.config.mjs`, `tailwind.config.ts`, `.gitignore`, `.env.example`, `docker-compose.yml`, `README.md`, `db/migrations/*.sql`, `lib/db.ts`, `lib/fx.ts`, `lib/funnels.ts`, `lib/types.ts`, `lib/day.ts`, `scripts/migrate.ts`, `scripts/ensure-partitions.ts`, `scripts/set-ingest-key.ts`, `app/globals.css`, `vitest.config.ts` |
| **T02** | `app/api/ingest/route.ts`, `lib/ingest/*`, `lib/ingest/*.test.ts` |
| **T03** | `lib/fx-fetch.ts`, `scripts/fetch-fx.ts`, `scripts/backfill-fx.ts`, `lib/fx-fetch.test.ts` |
| **T04** | `app/api/webhooks/shopify/route.ts`, `lib/orders/*`, `lib/orders/*.test.ts` |
| **T05** | `lib/auth.ts`, `lib/auth.test.ts`, `app/layout.tsx`, `app/page.tsx` (login + redirect), `app/(panel)/layout.tsx`, `components/ui.tsx`, `components/Nav.tsx`, `components/RangePicker.tsx`, `middleware.ts` |
| **T06** | `app/(panel)/embudo/**`, `lib/queries/funnel.ts`, `lib/queries/funnel.test.ts`, `app/api/data/funnel/route.ts` |
| **T07** | `app/(panel)/ventas/**`, `lib/queries/sales.ts`, `lib/queries/sales.test.ts`, `app/api/data/sales/route.ts` |
| **T08** | `app/(panel)/resumen/**`, `lib/queries/overview.ts`, `lib/queries/overview.test.ts`, `app/api/data/overview/route.ts`, `scripts/rollup.ts` |
| **T09** | `app/(panel)/leads/**`, `app/(panel)/config/**`, `lib/queries/leads.ts`, `lib/supabase-leads.ts`, `app/api/data/leads/route.ts`, `app/api/config/**` |
| **T10** | solo dentro de `~/Desktop/funnel/testfunnel` |
| **T11** | solo dentro de `~/Desktop/funnel/reset-app` |
| **T12** | `scripts/import-purchases.ts`, `deploy/**`, `docs/runbook.md` |

`app/page.tsx` lo crea T05 y hace el login más el redirect a `/resumen`. Las cuatro secciones viven
bajo el route group `app/(panel)/`, cada una en su carpeta, sin tocarse.

**La única excepción a la exclusividad: `app/layout.tsx`.** T01 lo crea como placeholder de 10 líneas
porque sin él `npm run build` no pasa, y T05 lo **reemplaza completo**. T01 tiene que dejarle el
comentario `// T05 reemplaza este archivo completo.` en la primera línea. Ningún otro archivo se
comparte entre tasks.

**Todas las dependencias de npm las declara T01.** Ningún otro task corre `npm install` ni edita
`package.json`. Si a un task le falta un paquete, va a §10.

## 9. Criterios de aceptación globales

1. `npx tsc --noEmit` en cero, en los tres repos.
2. `npm run build` termina en 0 en los tres repos.
3. `npm test` pasa en los tres. En `testfunnel` y `reset-app`, los tests que existen hoy **se
   actualizan a mano, nunca se borran** para que pase el build. Si uno falla por algo que este plan
   no anticipó, eso es información: va a §10.
4. `npm run db:migrate` es idempotente: corrido dos veces seguidas, la segunda no hace nada y sale 0.
5. Un `curl` al ingest con una key válida crea la sesión y los eventos; con una key inválida devuelve
   401 y no escribe ni una fila en `sessions`.
6. Un `curl` al webhook con firma válida crea la orden; repetido, no la duplica; con firma inválida
   devuelve 401 y deja la fila en `webhook_events`.
7. En los dos funnels: **Meta CAPI sigue funcionando**. Se verifica con el Test Events del
   Administrador de eventos de Meta, o al menos con el log de `sendCapiEvent` mostrando
   `events_received: 1`. Este punto no se da por cumplido sin evidencia.
8. En los dos funnels, estos barridos dan **cero**:
   ```bash
   grep -rn "lib/admin"        app components lib middleware.ts next.config.mjs
   grep -rn "getStore\|FUNNEL_STORE\|funnel_counts" app components lib
   find app components lib -path '*admin*'
   ```
9. `/quiz` de los dos funnels renderiza sin errores en consola y el embudo del dashboard muestra
   movimiento en el paso 0 dentro de los 10 segundos.

**Nota práctica para verificar con `curl`.** Varias tasks usan
`-b "panel_token=$(cat /tmp/panel_token)"`. Ese archivo no lo crea nada automáticamente: se logueás en
el browser, copiás el valor de la cookie `panel_token` desde las devtools y lo guardás:

```bash
printf '%s' '<el valor de la cookie>' > /tmp/panel_token
```

Los endpoints `/api/data/*` y `/api/config/*` **tienen** que devolver 401 sin esa cookie: si un `curl`
sin cookie te devuelve datos, hay un guard faltante y eso es un bug, no una comodidad.

## 10. Preguntas abiertas

Si aparece una decisión que este documento no resuelve, **se anota acá en lugar de decidirla en el
código**. Si bloquea, la task se detiene y no sigue con suposiciones.

```
### P-XX — <título corto>
- **Task:** T0X
- **Sección del plan:** §3.5
- **Archivo:** lib/orders/resolve.ts
- **Qué falta:** <la pregunta concreta>
- **Bloquea:** sí / no
- **Resolución:** <la completa el usuario>
```

Ya hay dos anotadas de entrada, las dos **no bloqueantes**:

### P-01 — Cotización oficial o blue
- **Task:** T03
- **Sección:** §3.7, D13
- **Qué falta:** `dolarapi.com` devuelve `oficial` y `blue`. Para el reporte en euros la diferencia
  no es chica. El default elegido es **oficial**, guardado en `settings.fx_source`.
- **Bloquea:** no. Se implementa con oficial y se cambia con una fila en `settings`.
- **Resolución:**

### P-02 — Qué pasa con `funnel_counts` en Supabase
- **Task:** T10, T11
- **Qué falta:** Las tasks dejan de escribirla. La tabla y sus dos RPC quedan en Supabase sin uso.
  Borrarlas es una migración de una línea, pero mientras existan son el único respaldo del histórico
  viejo.
- **Bloquea:** no. Se dejan quietas. Se decide dentro de 30 días de operación estable.
- **Resolución:**

### P-03 — Error pre-existente de `tsc` en `lib/pwa/planner-pdf.test.ts` (archivo NO-tocar de T10)
- **Task:** T10
- **Sección del plan:** §9 criterio 1 (`npx tsc --noEmit` en cero)
- **Archivo:** `testfunnel/lib/pwa/planner-pdf.test.ts:99`
- **Qué falta:** `@ts-expect-error` sin usar (TS2578). Existe en el árbol limpio de T10
  (verificado con `git stash`): no lo causó la task. La línea está en un archivo de la lista
  cerrada "no se toca" (`lib/pwa/**`), así que T10 no puede corregirla sin violar su propio
  alcance. El fix es quitar la directiva (un comentario, no cambia el runtime de la PWA).
  T10 sí corrigió el otro error pre-existente del mismo tipo (`lib/pwa/vip-content.test.ts`,
  flag `u` con target ES5) agregando `"target": "ES2017"` a `tsconfig.json`, sin tocar `lib/pwa`.
- **Bloquea:** no. `npm run build` y `npm test` pasan (296 tests); el `tsc` pelado queda con 1
  error en un archivo ajeno al task.
- **Resolución:** aplicada al cierre del proyecto (toda la orquestación terminada, sin
  paralelismo pendiente): se quitó la directiva `@ts-expect-error` sin uso. `npx tsc --noEmit`
  hoy da cero en `testfunnel`.

### P-04 — `deploy.sh` exige `ADMIN_PASSWORD` y `FUNNEL_STORE` que ya no se usan
- **Task:** T10
- **Sección del plan:** task T10 §E (envs que se sacan)
- **Archivo:** `testfunnel/deploy/deploy.sh` (lista `REQUIRED`, líneas ~137-155)
- **Qué falta:** T10 saca `FUNNEL_STORE` y `ADMIN_PASSWORD` de `.env.example` y el resumen
  documenta sacarlas del `.env.production`, pero el guard de `deploy.sh` las sigue exigiendo:
  si el usuario las borra del `.env.production` sin tocar `REQUIRED`, el próximo deploy aborta
  con "env vars faltantes". T10 no tocó `deploy.sh` porque su task solo lo autoriza para
  `PURGE_PATHS`.
- **Bloquea:** no. Mientras las vars sigan presentes en el `.env.production` (como hoy), el
  deploy pasa igual.
- **Resolución:**

### P-20 — `tailwind.config.ts` queda intacto (T01)
> Renumerada de P-03 a P-20 al cierre: T10 y T05 corrieron en paralelo y las dos anotaron un P-03 y
> un P-04 sin verse. Los IDs se referencian desde afuera del documento, así que la colisión importa.
- **Task:** T05
- **Sección del plan:** §8
- **Archivo:** tailwind.config.ts
- **Qué falta:** El task T05 lo lista en sus archivos ("solo la paleta"), pero §8 del plan se lo
  asigna a T01 y el propio archivo (comentario de T01) lo declara suyo. No se tocó: la paleta se
  resolvió con los tokens default de Tailwind (`neutral`/`emerald`/`amber`/`rose`/`sky`) y valores
  arbitrarios (`#0a0a0f`, `#13131a`), el mismo patrón que el `/admin` de los funnels. Si el día de
  mañana se quiere una token custom, la define T01.
- **Bloquea:** no
- **Resolución:**

### P-21 — Middleware Edge: verificación del token con Web Crypto
> Renumerada de P-04 a P-21 al cierre, por la misma colisión que P-20.
- **Task:** T05
- **Sección del plan:** D16
- **Archivo:** middleware.ts
- **Qué falta:** `lib/auth.ts` usa `node:crypto` (`createHmac`, `timingSafeEqual`) y el middleware
  de Next 14 corre en Edge, donde ese módulo no existe. `middleware.ts` no puede importar `lib/auth`.
  Se reimplementó ahí el verify con `crypto.subtle` (HMAC-SHA256): mismo formato de token
  (`ts.sig`), misma password, mismo TTL de 12 h y mismo skew de 60 s; la verificación timing-safe
  definitiva la hace el guard del layout en el server.
- **Bloquea:** no
- **Resolución:**

### P-05 — `lib/clientIp.ts` no existe en este repo
- **Task:** T05
- **Sección del plan:** §8
- **Archivo:** lib/auth.ts
- **Qué falta:** El original (`testfunnel/lib/admin/auth.ts`) importa `@/lib/clientIp`; T01 no lo
  creó en `dashboard-admin` y ningún task lo posee en §8. La lógica (cf-connecting-ip →
  x-real-ip → último token de x-forwarded-for, el orden de confianza que explica su docstring)
  quedó inline en `lib/auth.ts`. Si algún día lo necesita otro módulo, conviene extraerlo a su
  propio archivo (lo haría T01).
- **Bloquea:** no
- **Resolución:**

### P-06 — `signSessionToken()` retorna `string | null`, no `string`
- **Task:** T05
- **Sección del plan:** D16
- **Archivo:** lib/auth.ts
- **Qué falta:** La lista de API del task declara `signSessionToken(): string`, pero el original
  (y el requisito de fail-closed "si falta DASHBOARD_PASSWORD todo rechaza") necesita el `null`
  cuando no hay password configurada. Se conservó el contrato del original; el login trata el
  `null` como rechazo.
- **Bloquea:** no
- **Resolución:**

### P-07 — El chequeo de cantidad (413) corre antes que el schema en `/api/ingest`
- **Task:** T02
- **Sección del plan:** §4 (tabla de respuestas)
- **Archivo:** app/api/ingest/route.ts
- **Qué falta:** El task T02 ordena los chequeos del route como "schema → cantidad", pero su
  propio spec del schema (§4 del task) exige `z.array(eventSchema).max(50)`, que rechazaría un
  lote de 51 eventos con 400 `invalid_payload`. El contrato congelado del §4 del plan exige 413
  `too_large` para más de 50 eventos, y es la autoridad superior (T10/T11 escriben contra él).
  Se resolvió moviendo el chequeo de cantidad después del parseo de JSON y antes del zod: es un
  chequeo O(1) y encaja con la lógica de costos del orden (cada chequeo más caro que el anterior).
  El `.max(50)` del schema queda como defensa en profundidad para llamadas directas.
- **Bloquea:** no
- **Resolución:**

### P-08 — `fbclid` vacío se guarda como NULL, no como `'(directo)'`
- **Task:** T02
- **Sección del plan:** §3.3, task T02 §4
- **Archivo:** lib/ingest/schema.ts
- **Qué falta:** El task dice que los valores de `context.utms` se normalizan con la regla de
  `cleanUtmValue` y que si queda vacío → `'(directo)'`. `fbclid` no es una UTM: es un token
  opaco de Meta, la columna `sessions.fbclid` es nullable (no tiene centinela) y el upsert la
  actualiza con `COALESCE`, que distingue NULL de un valor. Guardar `'(directo)'` en fbclid
  contaminaría la columna con un valor que los queries de Meta no esperan. Se resuelve: las 5
  `utm_*` vacías → `'(directo)'`; `fbclid` vacío → `undefined` → NULL.
- **Bloquea:** no
- **Resolución:**

### P-09 — `orders.variant` no se setea desde el webhook
- **Task:** T04
- **Sección del plan:** §3.5, §5
- **Archivo:** lib/orders/upsert.ts
- **Qué falta:** La columna `orders.variant` existe, pero el mapa de campos del task (T04 §5a) no
  la incluye y el SQL de link a sesión del §5f solo escribe `session_id`/`visitor_id`. La única
  fuente natural es `sessions.variant` de la sesión linkeada por `sid`. Se dejó NULL en vez de
  decidirlo en el código; si T07 (Ventas) necesita agrupar por variant, se completa con una
  lectura de la sesión en el link.
- **Bloquea:** no
- **Resolución:**

### P-10 — El downsell de `reset-app` no nombra 'Downsell' en su contentName
- **Task:** T11
- **Sección del plan:** §6 (nota del downsell)
- **Archivo:** components/upsell/UpsellPageTracker.tsx, app/api/track/route.ts
- **Qué falta:** En `reset-app` el downsell no emite su propio ViewContent (a diferencia de
  `testfunnel`, donde `DownsellOffer` manda `'Programa 30 Dias Downsell'` con
  `contentCategory:'Downsell'`): `/downsell` usa `UpsellPageTracker page="checkout"` con
  `contentName 'Upsell Checkout 30 Dias'`. El mapeo de `/api/track` aplica la regla del plan
  ("`downsell_view` si lo nombra, `upsell_view` si no"): la vista del downsell entra como
  `upsell_view`, que es el fallback que el propio §6 prescribe. No se adivinó nada: el hito
  `downsell_view` queda sin emisor en este funnel.
- **Bloquea:** no
- **Resolución:**

### P-11 — Evidencia de CAPI en `reset-app` (T11, punto 4 de verificación)
- **Task:** T11
- **Sección del plan:** §9 criterio 7
- **Archivo:** app/api/track/route.ts, lib/tracking.ts
- **Qué falta:** `reset-app` no tiene `META_PIXEL_ID`/`META_CAPI_TOKEN` configurados en ningún
  lado (ni `.env.local` ni la VPS: el funnel no está desplegado — la VPS solo corre
  chauhinchazon) y está pre-lanzamiento. No se generó el evento real: usar las credenciales de
  producción de `testfunnel` habría mandado tráfico de reset-app al pixel de chauhinchazon
  (contaminar un funnel que vende). Evidencia parcial conseguida: `lib/tracking.ts` con diff
  cero contra HEAD, el bloque `sendCapiEvent` de `/api/track` byte-idéntico a HEAD, y la ruta
  ejecutándose (el log muestra `[tracking] CAPI skip: META_PIXEL_ID o META_CAPI_TOKEN no
  configurados` y responde 200). Falta: repetir la verificación cuando exista el pixel y el
  token del funnel (`add-meta-pixel.sh`), y confirmar `events_received: 1`.
- **Bloquea:** no
- **Resolución:**

### P-12 — `deploy.sh` de `reset-app` exige `ADMIN_PASSWORD` y `FUNNEL_STORE` que ya no se usan
- **Task:** T11
- **Sección del plan:** task T11 §E (envs que se sacan)
- **Archivo:** reset-app/deploy/deploy.sh (REQUIRED, líneas ~153-154) y deploy/README.md
- **Qué falta:** Igual que P-04 en `testfunnel`: T11 saca `FUNNEL_STORE`/`ADMIN_PASSWORD` de
  `.env.local.example` y documenta sacarlas del `.env.production`, pero el guard de `deploy.sh`
  las sigue exigiendo y el README las lista entre las 12 requeridas. T11 no toca `deploy.sh`
  (su task solo lo autoriza para `PURGE_PATHS`), así que se deja igual que en testfunnel.
- **Bloquea:** no. Mientras las vars sigan presentes en el `.env.production`, el deploy pasa.
- **Resolución:**

### P-13 — El filtro de dispositivo no está en el contrato de T06
- **Task:** T06
- **Sección del plan:** task T06 §2 (`FunnelFilters`), §4 (query params del API) vs §5 (filtros de
  pantalla)
- **Archivo:** `lib/queries/funnel.ts`, `app/api/data/funnel/route.ts`
- **Qué falta:** La pantalla (§5) lista "dispositivo" entre los filtros que recortan el embudo,
  pero `FunnelFilters` (§2) no tiene campo `device` y el API (§4) no declara el param `device`.
  Se implementó el contrato canónico: el filtro por dispositivo no existe, pero el breakdown de
  dispositivos sí se muestra como tabla en la pantalla. Si el usuario lo quiere como filtro, se
  agrega el param `device` al route y el campo `device` a `FunnelFilters` (cambio aditivo, no
   rompe nada).
- **Bloquea:** no
- **Resolución:**

### P-14 — `OverviewData` lleva dos campos que el tipo canónico de T08 no lista
- **Task:** T08
- **Sección del plan:** task T08 §4 (tipo `OverviewData`) vs §6.2 y §6.6 (la pantalla)
- **Archivo:** `lib/queries/overview.ts`
- **Qué falta:** El tipo canónico no tiene de dónde salir el `trend` de las StatCards
  (comparación contra el período anterior de igual largo) ni la fecha del último rollup que el
  pie pide cuando `staleRollup`. Se agregaron dos campos aditivos: `prev: PrevTotals | null`
  (totales del período anterior; `null` cuando no hay período posible, el rango 'all' arranca en
  el centinela 2000-01-01) y `lastRollupAt: string | null`. Ningún otro archivo depende de la
  forma exacta.
- **Bloquea:** no
- **Resolución:**

### P-15 — Las alertas de `fx_stale` y `tier unknown` no llevan filtro de rango
- **Task:** T08
- **Sección del plan:** task T08 §4 (tabla de alertas)
- **Archivo:** `lib/queries/overview.ts`
- **Qué falta:** La tabla de alertas acota "en el rango" solo a las ventas sin funnel; las de
  cotización provisoria y tier desconocido se implementaron SIN filtro de rango (alarmas del
  sistema, no del período mirado): una orden sin convertir de hace dos semanas sigue haciendo
  que el total en EUR esté corto hoy. La lectura literal del task; si se quiere que el número
  coincida con el del cajón de Ventas del mismo rango, se les agrega `day BETWEEN …`.
- **Bloquea:** no
- **Resolución:**

### P-16 — Cómo se verificó el export de leads sin credenciales de Supabase
- **Task:** T09
- **Sección del plan:** task T09 §Verificación (puntos 1 y 2), task T09 §Cuándo parar
- **Archivo:** `lib/queries/leads.ts`, `app/api/data/leads/route.ts`
- **Qué falta:** El `.env` local no tiene `SUPABASE_URL_*` / `SUPABASE_SERVICE_KEY_*` (ni los
  reales, que el usuario no entregó a este task). La verificación en vivo del punto 1 (la página
  "no configurado" y que no explota) se hizo así: sin las keys, `/api/data/leads?f=chauhinchazon`
  responde 200 con `{ok:true, configured:false, ...}` y las páginas `/leads` y `/config`
  renderizan 200 con el banner "Funnel sin configurar". El punto 2 (formato del CSV) se verificó
  sin Supabase ejercitando `buildLeadsCsv()` directamente (módulo puro): la cabecera es
  byte-idéntica a `First Name,Last Name,Email,Accepts Email Marketing,Tags,Note` (comparada
  contra el array del route viejo rescatado de `backups xdd/Copia de testfunnel`), con BOM
  inicial, CRLF, `quiz-lead,no-comprador,tipo-N,severidad-{baja|media|alta}` y la nota
  `Tipo hinchazon N — severidad N/10 — quiz YYYY-MM-DD` idénticos. El diff del punto 2 contra
  el route viejo no es ejecutable: T10/T11 ya borraron `testfunnel/app/api/admin/leads-export`.
- **Bloquea:** no
- **Resolución:** queda la comparación contra el archivo del backup.

### P-17 — Sin cookie, los endpoints `/api/data/*` y `/api/config/*` devuelven 307, no 401
- **Task:** T09
- **Sección del plan:** §9 (nota práctica) y task T09 §Verificación punto 4
- **Archivo:** `middleware.ts` (T05), `app/api/config/*/route.ts`, `app/api/data/leads/route.ts`
- **Qué falta:** El matcher del middleware de T05 cubre TODO menos `api/ingest`, `api/webhooks`,
  `_next/*` y favicon, y sin cookie redirige (307) a `/` antes de que llegue al guard de los
  routes. Verificado: `POST /api/config/products` sin cookie da 307, idéntico a
  `/api/data/sales` (T07) y a los otros `/api/data/*`. Los guards de 401 existen en cada route
  (defensa en profundidad, mismos que T06-T08), pero son inalcanzables sin cookie mientras el
  middleware no   los excluya. El dato importante se cumple: sin cookie no se sirve NINGÚN dato.
- **Bloquea:** no
- **Resolución:**

### P-18 — Cómo corren los scripts de cron en producción: tsx, no `.js` compilado
- **Task:** T12
- **Sección del plan:** task T12 §Parte B (cron), §8
- **Archivo:** `deploy/cron.panel`, `deploy/deploy.sh`
- **Qué falta:** El template del cron invoca `node scripts/fetch-fx.js`, pero el repo no tiene
  forma de producir esos `.js`: `tsconfig.json` (T01) tiene `noEmit: true` con `module: esnext` y
  `moduleResolution: bundler`, y los scripts existentes (fetch-fx, backfill-fx, rollup) usan
  `import.meta.url` en su guard `isMain`, que rompe la compilación a CommonJS (TS1343) y que la
  salida ESM de tsc no resuelve (imports sin extensión). Se eligió `tsx`: es devDependency de T01
  (no se puede mover a dependencies sin tocar `package.json`), por eso `deploy.sh` corre `npm ci`
  **sin** `--omit=dev` (igual que los funnels), el standalone linkea el `node_modules` completo de
  la release (el suyo es solo prod y no trae tsx), y el cron invoca
  `/usr/bin/node --env-file=.env.production ./node_modules/.bin/tsx scripts/<name>.ts` — tsx no
  lee `.env` solo, el `--env-file` de Node 20.20 es el que inyecta las variables.
- **Bloquea:** no
- **Resolución:**

### P-19 — Filas de `purchases` sin `hotmart_transaction`, `amount` o `currency` se saltean
- **Task:** T12
- **Sección del plan:** task T12 §Parte A (mapeo)
- **Archivo:** `scripts/import-purchases.ts`
- **Qué falta:** El mapeo da `external_id ← hotmart_transaction`, `amount ← amount` y
  `currency ← currency`, pero los webhooks viejos escriben `?? null` en los tres y las columnas de
  destino lo prohíben: `external_id` participa del UNIQUE (source, external_id) — con NULL la
  idempotencia muere (NULL ≠ NULL en índices únicos, la regla de §3) y la segunda corrida duplica
  plata — y `amount`/`currency` son NOT NULL. No se decidió en el código ningún id ni monto
  sintético: las filas incompletas se cuentan y se saltean (el resumen final las lista por causa),
  y la comparación de sumas contra Supabase queda explícita. Si aparecen en la importación real,
  se revisan una por una.
- **Bloquea:** no
- **Resolución:**
