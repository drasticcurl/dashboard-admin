# Runbook del panel — operativo

Para leer con el panel caído a las 2 de la mañana. Nada de arquitectura: eso
vive en `tasks/00-PLAN.md`. El deploy es manual y toma el código de git
(`deploy.sh` hace `fetch` + `reset --hard origin/main`); los comandos de abajo
son los que se corren en la VPS.

**Antes de cualquier comando de `psql`, definí esto una vez por sesión de
shell.** Todos los comandos de este runbook lo dan por sentado:

```bash
PGURL="$(grep -E '^DATABASE_URL=' /srv/panel/shared/.env.production | cut -d= -f2- | tr -d '"')"
psql "$PGURL" -Atc 'select 1'      # tiene que imprimir 1
```

Corré esto como `deploy`: `shared/` es `700 deploy:deploy`, así que otro
usuario no puede leer el `.env.production` y `PGURL` queda vacío. Si sale
vacío, `psql` intenta conectar a una base con tu nombre de usuario y el error
que ves es `database "root" does not exist`, que no tiene nada que ver con el
problema real.

**Servidor:** VPS existente (la misma que corre los funnels y `finanzas`).
**App:** Next 14 standalone en PM2, `panel-3005`, escucha en `127.0.0.1:3005`.
**Base:** PostgreSQL 16, **paquete de Ubuntu** (`postgresql-16`, datos en
`/var/lib/postgresql/16/main`), escuchando solo en `127.0.0.1:5432` (D5).
En esta VPS **no hay Docker instalado**: el `docker-compose.yml` del repo es
solo para desarrollo local. Todo lo de abajo usa `psql` directo. **Caddy** sirve
`panel.hilvanapp.com` → `127.0.0.1:3005`.

---

## 1. Instalación desde cero

```bash
ssh root@VPS

# 1. Directorios. shared/ queda con chmod 700: guarda el .env.production.
mkdir -p /srv/panel/{repo,shared,backups,releases}
chmod 700 /srv/panel/shared /srv/panel/backups

# 2. Subir el código (desde la máquina de desarrollo, NO en la VPS):
rsync -a --exclude='node_modules' --exclude='.next' --exclude='.git' \
  --exclude='tasks' --exclude='.env' --exclude='.env.*' \
  ~/Desktop/funnel/dashboard-admin/ root@VPS:/srv/panel/repo/

# 3. El .env.production. Copiar deploy/.env.example a /srv/panel/shared/,
# completar y protegerlo:
#   POSTGRES_PASSWORD        → openssl rand -base64 32
#   DATABASE_URL             → postgres://panel:<password>@127.0.0.1:5432/panel
#   DASHBOARD_PASSWORD       → openssl rand -base64 24 (mín. 24 caracteres)
#   NEXT_PUBLIC_SITE_URL     → https://panel.hilvanapp.com
#   SHOPIFY_WEBHOOK_SECRETS  → los secrets de los funnels, separados por coma
#                              (ver §2)
#   SUPABASE_URL_*/_KEY_*    → opcionales, para los leads (T09)
install -m 600 /srv/panel/shared/.env.production /srv/panel/shared/.env.production
vim /srv/panel/shared/.env.production          # si recién lo creaste
chmod 600 /srv/panel/shared/.env.production

# 4. Puerto de Postgres. El 5432 de la VPS puede estar tomado (finanzas).
#    Si lo está, DB_PORT=5433 en el .env.production y el 5432→5433 acá abajo.
ss -tlnp | grep -E ':5432|:5433'

# 5. La base. Es el paquete de Ubuntu, no un contenedor: ya está corriendo
#    desde el boot. Solo hay que crear rol y base la primera vez.
sudo -u postgres createuser --pwprompt panel     # pegá el POSTGRES_PASSWORD
sudo -u postgres createdb -O panel panel
sudo -u postgres createdb -O panel panel_test    # los tests del deploy corren acá
pg_isready -h 127.0.0.1 -U panel -d panel        # accepting connections

# Que escuche SOLO en loopback. Si listen_addresses fuese '*', la base queda
# expuesta y la password es la única defensa.
sudo -u postgres psql -Atc 'show listen_addresses'   # esperado: localhost

# 6. Migrar. tsx no lee .env solo: se exporta DATABASE_URL para el comando.
set -a; . /srv/panel/shared/.env.production; set +a
npm ci --no-audit --no-fund
npm run db:migrate                 # idempotente: corrido dos veces no toca nada

# 7. Ingest keys (una por funnel, se generan y se cargan desde acá):
openssl rand -hex 32               # key de chauhinchazon
npm run db:ingest-key -- chauhinchazon <key>
openssl rand -hex 32               # key de reset
npm run db:ingest-key -- reset <key>

# 8. Caddy: agregar el bloque de deploy/Caddyfile.panel al final del
#    /etc/caddy/Caddyfile (el wildcard *.hilvanapp.com ya cubre el cert).
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy

# 9. Arrancar PM2 (la primera vez; después lo hace deploy.sh).
pm2 start /srv/panel/repo/deploy/ecosystem.config.js
pm2 save
pm2 startup                          # solo la primera vez: genera el unit

# 10. Cron. Instalar deploy/cron.panel (o volcarlo en /etc/cron.d/panel).
#     El backup usa pg_dump contra 127.0.0.1, no un contenedor:
which pg_dump                        # /usr/bin/pg_dump
crontab -e
```

Después de la instalación, la app **todavía muestra ceros** hasta hacer los
tres pasos manuales del §2. El deploy de una release (con su build y tests)
lo hace `deploy.sh` (§3), no esta guía.

## 2. Los tres pasos manuales sin los cuales el panel muestra ceros

El orden importa: primero el funnel tiene que poder mandar eventos, después
el webhook de Shopify tiene que poder entrar.

1. **En cada funnel** (`/srv/<funnel>/shared/.env.production`): agregar y
   redesplegar con `PANEL_INGEST_URL=https://panel.hilvanapp.com/api/ingest`
   y `PANEL_INGEST_KEY=<la key generada en §1 paso 7>`. Sin esto el tracking
   no llega y el embudo queda en cero.
2. **En el admin de Shopify** de cada tienda (Configuración → Notificaciones →
   Webhooks), agregar las 4 suscripciones **sin borrar las existentes** (D8:
   cada funnel conserva la suya, que es lo que alimenta los entitlements de
   la PWA):
   - `orders/paid` → `https://panel.hilvanapp.com/api/webhooks/shopify`
   - `orders/create` → `https://panel.hilvanapp.com/api/webhooks/shopify`
   - `refunds/create` → `https://panel.hilvanapp.com/api/webhooks/shopify`
   - `orders/cancelled` → `https://panel.hilvanapp.com/api/webhooks/shopify`
3. **`SHOPIFY_WEBHOOK_SECRETS`** en el `.env.production` del panel: los
   MISMOS secrets que ya están en el env de cada funnel (las suscripciones
   creadas desde el admin firman con el secret de la tienda). Si falta, el
   webhook responde 401 a todo.

## 3. Deploy de una versión nueva

```bash
# En la máquina de desarrollo: pushear. Es todo lo que hace falta.
git push origin main

# En la VPS, como deploy (nunca root: pm2 es por usuario):
sudo -u deploy bash /srv/panel/repo/deploy/deploy.sh
```

`deploy.sh` arranca con `fetch` + `reset --hard origin/main`, así que lo que
no esté pusheado no se despliega. Para probar una rama antes de mergear:

```bash
sudo -u deploy DEPLOY_BRANCH=mi-rama bash /srv/panel/repo/deploy/deploy.sh
```

Qué hace `deploy.sh` (en orden): flock → rsync del código a una release nueva
→ build (`npm ci` + `npm run build`) → tests → completa el standalone
(`public/`, `.next/static/`, `scripts/`, `lib/`, `.env.production`) → `npm
run db:migrate` → swap atómico del symlink `current` → `pm2 reload
panel-3005` + health check en `/` (acepta 200 o 307) → si el check falla,
vuelve solo a la release anterior → poda (deja las 5 más nuevas).

Qué mirar después de un deploy:

```bash
tail -40 /srv/panel/deploy.log
pm2 logs panel-3005 --lines 40 --nostream
curl -s -o /dev/null -w '%{http_code}\n' https://panel.hilvanapp.com/   # 200
psql "$PGURL" -c 'SELECT count(*) FROM orders;'
git -C /srv/panel/repo log --oneline -1        # qué commit quedó sirviendo
```

**Notas de arquitectura del deploy (para no sorprenderse):**

- `/srv/panel/repo` es un clon de git y **no es un workspace**: `deploy.sh`
  hace `reset --hard`, así que cualquier edición hecha a mano ahí se pierde en
  el próximo deploy. Los parches de urgencia van por commit.
- La deploy key de este repo es read-only y es propia: GitHub no permite usar
  la misma key en dos repositorios, así que hay una por proyecto
  (`~/.ssh/github-panel` acá, con el alias `github-panel` en `~/.ssh/config`).
- Los scripts de cron corren **con tsx** (no compilados a `.js`): el
  tsconfig no puede emitir ejecutables con plain node (P-18). `tsx` es una
  devDependency, por eso `deploy.sh` corre `npm ci` **sin** `--omit=dev`, y
  por eso el cron invoca
  `/usr/bin/node --env-file=.env.production ./node_modules/.bin/tsx …`.
- El standalone que sirve `current` incluye `scripts/`, `lib/` y un symlink
  de `node_modules` a la release completa: los crons corren desde ahí.

## 4. Diagnóstico

| Síntoma | Dónde mirar |
|---|---|
| el embudo está en cero | `ingest_errors`; ¿el funnel tiene `PANEL_INGEST_KEY`?; ¿el middleware está interceptando `/api/ingest`? |
| una venta no aparece | `webhook_events` filtrando por `status`; ¿la suscripción existe en Shopify?; ¿el secret está en el env? |
| ventas sin funnel | `/config` → productos sin mapear |
| los euros no cierran | `fx_rates` del día; `fx_stale` en `/ventas`; `npm run fx:backfill` |
| el Resumen está viejo | `max(computed_at)` de `daily_metrics`; ¿corre el cron del rollup? |
| sesiones infladas | `props->>'synthetic_sid'` en `events`: si aparece seguido, el `SessionBootstrap` no monta |

Queries de apoyo:

```bash
psql "$PGURL" <<'SQL'
SELECT status, count(*) FROM ingest_errors GROUP BY 1 ORDER BY 2 DESC LIMIT 10;
SELECT status, count(*) FROM webhook_events GROUP BY 1 ORDER BY 2 DESC;
SELECT max(computed_at) FROM daily_metrics;
SELECT * FROM fx_rates ORDER BY day DESC LIMIT 5;
SQL
```

Logs del cron (si el panel muestra ceros pero la app anda, el problema está
acá):

```bash
tail -50 /var/log/panel/fx.log
tail -50 /var/log/panel/rollup.log
tail -50 /var/log/panel/db.log
```

## 5. Restaurar un backup

El backup diario (cron de las 04:30) es la única copia de las ventas
históricas una vez que Supabase deja de ser la fuente de verdad.

```bash
# Listar backups disponibles:
ls -l /srv/panel/backups/

# Restaurar uno. Lo que hay que frenar son los ESCRITORES (el panel y el
# worker de reglas), no Postgres: psql necesita la base arriba para poder
# restaurar. El worker es el que más importa: si corre durante la restauración
# puede ejecutar acciones en Meta leyendo un estado a medio restaurar.
pm2 stop panel-3005 panel-reglas

gunzip -c /srv/panel/backups/panel-2026-08-11.sql.gz | psql "$PGURL"

pm2 start panel-3005 panel-reglas
```

Verificación mínima después de restaurar (el conteo es la prueba de que el
dump no llegó vacío o cortado):

```bash
psql "$PGURL" \
  -c 'SELECT (SELECT count(*) FROM orders) AS orders, (SELECT count(*) FROM sessions) AS sessions;'
```

## 6. Importar el histórico de ventas (una sola vez, antes del deploy)

Migra `purchases` de un Supabase a `orders` (D15: se migran las ventas, NO
`funnel_counts`). Se corre con las credenciales de Supabase a la vista — no
van al `.env.production` del panel, se pasan como variables del shell:

```bash
# En la máquina de desarrollo, contra la base local:
cd ~/Desktop/funnel/dashboard-admin
export SUPABASE_URL_CHAUHINCHAZON=https://<proyecto>.supabase.co
export SUPABASE_SERVICE_KEY_CHAUHINCHAZON=<service_key>
npm run import:purchases -- --funnel=chauhinchazon --dry-run   # primero, sin escribir
npm run import:purchases -- --funnel=chauhinchazon
npm run import:purchases -- --funnel=chauhinchazon             # idempotente: 0 nuevas
```

El criterio de éxito: el conteo y la suma por status de `orders` tienen que
coincidir con el `GROUP BY` de Supabase:

```bash
psql "$PGURL" -c \
  "SELECT f.slug, o.status, count(*), sum(o.amount) FROM orders o
   JOIN funnels f ON f.id = o.funnel_id WHERE o.source='import'
   GROUP BY 1,2 ORDER BY 1,2;"
```

```sql
-- en Supabase (SQL editor del proyecto):
SELECT status, count(*), sum(amount) FROM purchases GROUP BY 1;
```

**Si no coinciden, parar.** La causa más probable es la paginación de
PostgREST (corta en 1000 filas en silencio); el script la pagina y además
aborta si lo leído no coincide con el total declarado, así que una corrida
con truncamiento NO escribe nada.

Cosas que el script informa y que están bien que pasen:

- **`sin tier`**: el producto no está en `product_map` → queda `unknown` y se
  muestra como tal (D11, se completa en `/config`).
- **`sin cotización`**: `amount_eur = NULL`, `fx_stale = true`. `fx_rates`
  arranca hoy, los días viejos no tienen cotización y **no se inventa una
  retroactiva** (es lo honesto): el histórico se lee en ARS. Si querés el
  histórico en euros, cargá filas en `fx_rates` (a mano o con `npm run
  fx:fetch -- --day=YYYY-MM-DD`) y corré `npm run fx:backfill`, que completa
  las órdenes pendientes solas.
- **`refunded_at` es aproximado**: el dato real de la devolución no existe en
  `purchases` (el webhook viejo solo cambia `status`), así que las filas no
  aprobadas quedan con `refunded_at = purchased_at`.
- **`source = 'import'`** y no `'shopify'` a propósito: el único de `orders`
  es `(source, external_id)`. Con `'import'`, si mañana llega un webhook por
  la devolución de una compra vieja, entra como fila nueva en vez de chocar
  contra la importada. Una fila duplicada visible es mejor que un INSERT que
  falla en silencio.

## 7. Agregar un funnel nuevo

Seis pasos, ninguna migración (es la prueba de que D1 valió la pena):

1. **Alta en `/config`** (UI): slug, nombre, TZ, moneda, variantes, color.
   Con eso el funnel ya existe en `funnels` y `funnel_steps`.
2. **Ingest key**: `openssl rand -hex 32` y `npm run db:ingest-key -- <slug>
   <key>`. Después va al `.env.production` del funnel nuevo junto con
   `PANEL_INGEST_URL`.
3. **En el checkout del funnel nuevo**: el cart attribute `funnel=<slug>` (lo
   escribe `buildCheckoutAttribution`, igual que los funnels actuales).
4. **Mapear sus productos** en `/config` (product_map): sin eso, todas sus
   ventas caen en "Ventas sin atribuir" con tier `unknown`.
5. **Credenciales de Supabase** (`SUPABASE_URL_<SLUG>` /
   `SUPABASE_SERVICE_KEY_<SLUG>`) si querés sus leads en la sección Leads.
6. **Webhooks de su tienda**: las 4 suscripciones del §2 y el secret
   agregado a `SHOPIFY_WEBHOOK_SECRETS` (y al listado del webhook de la
   tienda, sin borrar las existentes).
