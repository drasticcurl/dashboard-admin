# T12 — Migración del histórico de ventas, artefactos de deploy y runbook

- **Depende de:** T01 (schema), T04 (`lib/orders/resolve.ts` para el tier).
- **Bloquea:** nada, pero es lo último que se corre.
- **Paralelizable con:** T06, T07, T08, T09.
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos:** `scripts/import-purchases.ts`, `deploy/**`, `docs/runbook.md`. **Nada más.**

Decisión que gobierna la primera parte: **D15** — se migra `purchases` (son ventas reales y están
limpias), **no** `funnel_counts` (tiene basura documentada: el día centinela `2000-01-01`,
`quiz_version='v1'` que es LATAM mal etiquetado e inseparable, y ventas infladas por el backfill
manual del panel viejo). El embudo arranca de cero.

Este task **no ejecuta el deploy**: escribe los archivos que el deploy necesita. La instalación en la
VPS y el DNS los hace el usuario (o el asistente en el paso siguiente).

---

## Parte A — `scripts/import-purchases.ts`

Importa `purchases` de un Supabase a `orders`.

```
npm run import:purchases -- --funnel=chauhinchazon --dry-run
npm run import:purchases -- --funnel=chauhinchazon
npm run import:purchases -- --funnel=reset --since=2026-01-01
```

**Origen.** Las credenciales salen del env, con el mismo esquema que T09:
`SUPABASE_URL_<SLUG>` y `SUPABASE_SERVICE_KEY_<SLUG>`. Leé por la API REST de PostgREST con
paginación por `Range` de 1000 en 1000 — PostgREST **trunca en silencio** al llegar al límite, y si no
paginás te faltan ventas sin ningún error.

```
GET {URL}/rest/v1/purchases?select=*&order=purchased_at.asc
```

**Mapeo:**

| `orders` | de `purchases` |
|---|---|
| `funnel_id` | el del `--funnel` |
| `source` | `'import'` |
| `external_id` | `hotmart_transaction` (ya viene con el prefijo `shopify_` cuando corresponde) |
| `email`, `amount`, `currency`, `status`, `purchased_at` | igual |
| `tier` | `resolveTier(shop_domain='*', product_id)` de T04. Sin fila en `product_map` → `'unknown'` |
| `utm_*` | igual; `NULL` → `'(directo)'` (la columna es `NOT NULL DEFAULT '(directo)'`) |
| `day` | `purchased_at` en la TZ del funnel, resuelto en SQL |
| `raw` | la fila original completa |
| `refunded_at` | `purchased_at` si `status <> 'approved'`, porque el dato real no existe. **Comentalo en el código**: es un dato aproximado y alguien lo va a mirar |
| `session_id`, `visitor_id` | `NULL`. No existían |

**`source = 'import'` y no `'shopify'`, a propósito.** El único de `orders` es
`(source, external_id)`: con `'import'`, si mañana llega un webhook de Shopify por una devolución de
una compra vieja, entra como fila nueva en vez de chocar contra la importada. Prefiero una fila
duplicada visible a un `INSERT` que falla en silencio. Documentalo en el script y en el runbook.

**EUR.** `toEur(amount, currency, day)`. Para días viejos no hay cotización (la tabla arranca hoy), así
que casi todas van a quedar con `amount_eur = NULL` y `fx_stale = true`. **Está bien y es lo honesto**:
inventar una cotización retroactiva es peor. El histórico se lee en ARS. Si el usuario quiere el
histórico en euros, carga filas manuales en `fx_rates` y corre `npm run fx:backfill`. Decilo en el
runbook.

**Reglas del script:**

- `--dry-run` obligatorio de implementar: imprime cuántas importaría, cuántas ya están, el rango de
  fechas y el desglose por tier, sin escribir nada. Es un script que toca plata.
- `ON CONFLICT (source, external_id) DO NOTHING`: correrlo dos veces no duplica.
- Inserta en lotes de 500 dentro de una transacción por lote.
- Al final imprime: importadas, salteadas por duplicado, sin tier, sin cotización, y el total en la
  moneda original. Ese total es lo que el usuario compara contra Shopify.
- **No** crea `order_items`: `purchases` no tiene líneas de detalle. Comentalo.

**Verificación de la importación** (esta es la que importa de verdad):

```bash
npm run import:purchases -- --funnel=chauhinchazon --dry-run
npm run import:purchases -- --funnel=chauhinchazon
npm run import:purchases -- --funnel=chauhinchazon      # idempotente: 0 importadas

docker compose exec db psql -U panel -d panel -c \
  "SELECT f.slug, o.status, count(*), sum(o.amount) FROM orders o
   JOIN funnels f ON f.id = o.funnel_id WHERE o.source='import'
   GROUP BY 1,2 ORDER BY 1,2;"
```

El conteo y la suma tienen que coincidir con lo que dice Supabase:

```sql
SELECT status, count(*), sum(amount) FROM purchases GROUP BY 1;
```

**Si no coinciden, el task no está terminado.** La causa más probable es la paginación.

---

## Parte B — Artefactos de deploy

### `deploy/docker-compose.override.example.yml`
Nada. El `docker-compose.yml` de T01 ya sirve tal cual en la VPS. Solo documentá en el runbook que
antes de levantarlo hay que verificar el puerto:

```bash
ss -tlnp | grep -E ':5432|:5433'   # si 5432 está tomado, DB_PORT=5433 en .env
```

### `deploy/ecosystem.config.js`

PM2, una sola instancia. Copiá el de `~/Desktop/funnel/testfunnel/deploy/ecosystem.config.js` y
adaptalo. Los dos detalles que **no** se pueden cambiar:

```js
exec_mode: 'fork',              // no cluster
env: {
  NODE_ENV: 'production',
  PORT: '3005',
  HOSTNAME: '127.0.0.1',        // el server.js del standalone bindea 0.0.0.0 por default
},
```

`HOSTNAME: '127.0.0.1'` es obligatorio: sin él, el panel queda escuchando en todas las interfaces y
accesible salteando a Caddy. Es un panel con las ventas de todos los funnels: dejalo explícito y con
el comentario que explique por qué.

Una sola instancia y no dos, a diferencia de los funnels: el rate limit del login es in-memory y con
dos instancias el límite efectivo se duplica.

### `deploy/Caddyfile.panel`

El bloque para agregar al `/etc/caddy/Caddyfile` de la VPS. **No** uses el snippet `(funnel)` de los
funnels: ese proxea a dos puertos, sirve `/media/*` y pinnea `/admin`, y nada de eso aplica.

```caddyfile
panel.hilvanapp.com {
	# El wildcard *.hilvanapp.com ya cubre este host: no hace falta emitir un cert nuevo.
	tls /etc/caddy/certs/panel.pem /etc/caddy/certs/panel.key

	encode zstd gzip

	# Un panel de métricas cacheado no sirve. Y con datos de ventas adentro,
	# menos. El `defer` NO es opcional: sin él Caddy setea el header antes de
	# correr el proxy y la respuesta sale con DOS Cache-Control.
	header {
		defer
		Cache-Control "no-store, must-revalidate"
		X-Robots-Tag "noindex, nofollow"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
	}

	reverse_proxy 127.0.0.1:3005 {
		header_up X-Real-IP {client_ip}
	}

	log {
		output file /var/log/caddy/panel.log {
			roll_size 20mb
			roll_keep 7
			roll_keep_for 168h
		}
	}
}
```

`X-Real-IP` con `{client_ip}` no es decorativo: es la IP que usa el rate limit del login (T05), y sin
el header todos los intentos parecen venir de Cloudflare y comparten el mismo balde.

### `deploy/deploy.sh`

Más simple que el de los funnels, porque **no hay git**: el usuario sube la carpeta por `rsync`.

```
1. flock para que no corran dos deploys a la vez
2. verifica que existe /srv/panel/shared/.env.production
3. rsync de lo subido a /srv/panel/releases/<timestamp>/, excluyendo node_modules, .next, .git, tasks/
4. instala el .env.production en la release
5. npm ci && npm run build && npm test
6. completa el standalone: copia public/ y .next/static/ adentro (Next no los copia)
7. npm run db:migrate  ← después del build, antes de mover el symlink
8. mv -T del symlink current  (atómico)
9. pm2 reload panel-3005 y health check contra /
10. si el health check no da 200 o 307, rollback al release anterior
11. poda: deja las 5 releases más nuevas
```

Los pasos 6, 8 y 10 son los que hacen que un deploy fallido no deje el panel caído; están copiados del
`deploy.sh` de los funnels, que ya los resolvió. El paso 7 va **antes** de mover el symlink: si la
migración falla, el panel sigue sirviendo la versión anterior con el schema anterior.

`tasks/` se excluye del rsync: son estos documentos, no hacen falta en producción.

### `deploy/cron.panel`

```cron
# Cotización ARS→EUR (T03). 03:10 y no medianoche: dolarapi publica el valor del
# día hábil, y a esa hora el día ya cerró en Argentina.
10 3 * * * cd /srv/panel/current && node scripts/fetch-fx.js >> /var/log/panel/fx.log 2>&1

# Rollup del Resumen (T08). Cada 10 min los últimos 3 días.
*/10 * * * * cd /srv/panel/current && node scripts/rollup.js --days=3 >> /var/log/panel/rollup.log 2>&1

# Rollup nocturno del último mes. DESPUÉS del fetch-fx, para que los euros del
# día cerrado usen la cotización correcta. Invertir el orden deja los euros de
# ayer calculados con la cotización de antes de ayer.
25 3 * * * cd /srv/panel/current && node scripts/rollup.js --days=35 >> /var/log/panel/rollup.log 2>&1

# Particiones de events con 3 meses de anticipación (T01).
0 4 1 * * cd /srv/panel/current && node scripts/ensure-partitions.js >> /var/log/panel/db.log 2>&1

# Backup de la base. Se guarda comprimido y se retienen 14 días.
30 4 * * * docker exec panel-db-1 pg_dump -U panel panel | gzip > /srv/panel/backups/panel-$(date +\%F).sql.gz
35 4 * * * find /srv/panel/backups -name 'panel-*.sql.gz' -mtime +14 -delete
```

El backup no es opcional. Es la única copia de las ventas históricas una vez que Supabase deja de ser
la fuente de verdad. Verificá en el runbook que el nombre del contenedor
(`docker compose ps --format '{{.Name}}'`) coincide con el del cron.

Los scripts se invocan como `.js` porque en producción corren compilados o vía `tsx`; resolvé eso de
forma consistente y **documentá cuál elegiste** (si es `tsx`, tiene que estar en `dependencies`, no en
`devDependencies`, porque `npm ci --omit=dev` en el server no lo instalaría).

---

## Parte C — `docs/runbook.md`

Operativo, para leer con el panel caído a las 2 de la mañana. Nada de arquitectura: eso está en
`tasks/00-PLAN.md`.

1. **Instalación desde cero**: crear `/srv/panel/{releases,shared,backups}`, el `.env.production`,
   verificar el puerto de Postgres, `docker compose up -d`, `npm run db:migrate`, generar y cargar las
   dos ingest keys, agregar el bloque de Caddy, `caddy validate` + `systemctl reload caddy`, arrancar
   PM2, `pm2 save`, instalar el cron.
2. **Los tres pasos manuales sin los cuales el panel muestra ceros**, con esa advertencia arriba:
   - cargar `PANEL_INGEST_URL` y `PANEL_INGEST_KEY` en el `.env.production` de **cada** funnel y
     redesplegarlo;
   - agregar las 4 suscripciones de webhook en el admin de Shopify **sin borrar las existentes**
     (D8), apuntando a `https://panel.hilvanapp.com/api/webhooks/shopify`;
   - copiar los `SHOPIFY_WEBHOOK_SECRETS` del env de los funnels al del panel.
3. **Deploy de una versión nueva**: rsync + `deploy.sh` + qué mirar.
4. **Diagnóstico**, en forma de tabla síntoma → dónde mirar:

   | Síntoma | Dónde mirar |
   |---|---|
   | el embudo está en cero | `ingest_errors`; ¿el funnel tiene `PANEL_INGEST_KEY`?; ¿el middleware está interceptando `/api/ingest`? |
   | una venta no aparece | `webhook_events` filtrando por `status`; ¿la suscripción existe en Shopify?; ¿el secret está en el env? |
   | ventas sin funnel | `/config` → productos sin mapear |
   | los euros no cierran | `fx_rates` del día; `fx_stale` en `/ventas`; `npm run fx:backfill` |
   | el Resumen está viejo | `max(computed_at)` de `daily_metrics`; ¿corre el cron del rollup? |
   | sesiones infladas | `props->>'synthetic_sid'` en `events`: si aparece seguido, el `SessionBootstrap` no monta |
5. **Restaurar un backup**, con el comando completo y probado.
6. **Agregar un funnel nuevo**: alta en `/config`, generar la ingest key, `attributes[funnel]` en el
   checkout del funnel nuevo, mapear sus productos, cargar sus credenciales de Supabase si querés sus
   leads. Seis pasos, ninguna migración. Es la prueba de que D1 valió la pena.

## Cuándo parar

Si los totales importados no coinciden con Supabase: **pará**. Un panel de ventas que arranca con el
histórico mal es peor que uno que arranca vacío, porque el error queda enterrado y contamina todas las
comparaciones contra el pasado.

Si el `pg_dump` del cron falla (nombre del contenedor, permisos del directorio de backups): **pará**.
Es la única copia de los datos.
