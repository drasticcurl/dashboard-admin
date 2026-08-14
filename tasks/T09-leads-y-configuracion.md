# T09 — Leads (desde Supabase) y Configuración

- **Depende de:** T01, T05.
- **Bloquea:** nada, pero **sin la parte de Configuración el panel no se puede operar**: es donde se
  cargan los `product_id` que resuelven el tier y el funnel de cada venta (D10, D11).
- **Paralelizable con:** T06, T07, T08, T10, T11.
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos:** `app/(panel)/leads/**`, `app/(panel)/config/**`, `lib/queries/leads.ts`,
  `lib/supabase-leads.ts`, `app/api/data/leads/route.ts`, `app/api/config/**`. **Nada más.**

---

## Parte A — Leads

### Por qué existe

T10 y T11 borran el `/admin` de cada funnel, y con él se va `/api/admin/leads-export`, que es lo que
el usuario usa para bajar el CSV de leads e importarlo a Shopify. **Esa función no se puede perder en
la mudanza.** Los leads siguen viviendo en Supabase (decisión del usuario: "para lo único que usaríamos
su base es para los registros"), así que esta sección los **lee de ahí**, sin copiarlos a Postgres.

### `lib/supabase-leads.ts`

Cliente de Supabase por funnel, **solo lectura**, con las credenciales en el env del dashboard:

```
SUPABASE_URL_CHAUHINCHAZON / SUPABASE_SERVICE_KEY_CHAUHINCHAZON
SUPABASE_URL_RESET         / SUPABASE_SERVICE_KEY_RESET
```

El sufijo es el `slug` del funnel en mayúsculas. Un funnel nuevo se agrega poniendo sus dos variables;
si faltan, esta sección muestra "no configurado" para ese funnel y **el resto del panel sigue
funcionando**. Nunca tires una excepción que tumbe la página por un funnel sin credenciales.

No agregues `@supabase/supabase-js` a las dependencias (T01 no la declaró y §8 del plan prohíbe tocar
`package.json`). Usá `fetch` contra la **API REST de PostgREST**, que es todo lo que hace falta para
leer una tabla:

```
GET {SUPABASE_URL}/rest/v1/clientes?select=email,nombre,created_at,compro&order=created_at.desc&limit=100
     apikey: {SERVICE_KEY}
     Authorization: Bearer {SERVICE_KEY}
     Range: 0-999            ← paginación; PostgREST corta en 1000 sin avisar
```

Ese último punto es un bug real que los funnels ya se comieron: `lib/admin/supabase-store.ts` pagina
de 1000 en 1000 justamente porque PostgREST trunca en silencio. Paginá con `Range` hasta que la
respuesta traiga menos filas que el tamaño de página.

Columnas de `clientes` que existen y sirven: `email`, `nombre`, `created_at`, `compro`,
`utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `tipo_hinchazon`, `severidad`. **Ojo:** el
resto de las columnas (`apertura`, `momento`, `sintomas`, …) son del quiz viejo y están casi todas en
`NULL`; no las muestres como si fueran datos.

### La pantalla

`/leads`, con el selector de funnel del shell:

1. `StatCard`: total de leads, leads del rango, últimas 24 h / 7 d / 30 d, y **no-compradores**.
2. Los no-compradores se calculan cruzando `clientes.email` con los emails de `orders` que tengan
   `status='approved'` en **Postgres** (la base nueva), no con `purchases` de Supabase. Es el mismo
   cruce que hacía `/api/admin/leads-stats`, pero contra la fuente de verdad nueva.
3. Tabla de los últimos 100, con email enmascarado (igual que T07 §5) y el completo tras un click.
4. **Export CSV**, que es la razón de ser de esta pantalla. Formato **idéntico** al de
   `/api/admin/leads-export` de los funnels, porque es lo que Shopify acepta hoy: leé ese archivo y
   copiá el formato exacto — cabecera
   `First Name,Last Name,Email,Accepts Email Marketing,Tags,Note`, BOM al principio (sin BOM, Excel
   rompe los acentos), y los tags `quiz-lead`, `no-comprador`, `tipo-N`. Filtro `?onlyNonBuyers=1`
   y `?since=YYYY-MM-DD`.

Si cambiás el formato del CSV, el import de Shopify falla y el usuario se queda sin poder mandar
mails. Copialo, no lo mejores.

---

## Parte B — Configuración

Es la pantalla que hace que el sistema sea operable sin entrar por SSH a escribir SQL.

### B.1 Funnels

Tabla de `funnels` con edición de: `name`, `timezone`, `sell_currency`, `color`, `variants`, `active`.
`slug` **no se edita** (es la clave que usan los cart attributes y las ingest keys).

Botón **"Regenerar ingest key"**: genera 32 bytes aleatorios en hex, guarda el hash, y muestra la key
en claro **una sola vez**, con la advertencia de que hay que copiarla al `.env.production` del funnel y
redesplegarlo. No la guardes en ningún lado en claro, no la vuelvas a mostrar, y no la loguees.

Alta de un funnel nuevo desde la UI: `slug`, `name`, `timezone`, `sell_currency`, y ya. Sin esto, cada
funnel nuevo necesita un `INSERT` a mano, que es exactamente lo que este proyecto vino a evitar.

### B.2 Pasos del quiz

Por funnel, la tabla `funnel_steps` en orden, editable: `label` y `kind`. `step_index` y `slug` se
pueden editar pero con una advertencia clara: **cambiar el `step_index` de un paso reinterpreta el
histórico**, porque `sessions.max_step_index` guarda números, no slugs. Mostrá ese texto al lado del
campo, no en un tooltip.

Botón **"Importar pasos"**: pegar un JSON `[{stepIndex, slug, label, kind}]` y reemplazar el catálogo
del funnel en una transacción. Es el camino práctico cuando se agrega una pregunta al quiz: se pega la
lista nueva y listo.

Arriba, un aviso si el ingest está viendo pasos que no están en el catálogo, leído de `ingest_errors`
(`reason='unknown_step'` o `'step_slug_mismatch'`) de los últimos 7 días, agrupado. Es el mecanismo de
autocorrección de D20: el sistema te dice qué le falta.

### B.3 Productos → funnel y tier

La tabla que hace funcionar la atribución de ventas (D10, D11). CRUD de `product_map`:
`shop_domain` (con `*` como default y explicado a la vista: "cualquier tienda"), `product_id`,
`funnel_id`, `tier`, `label`.

Lo que hace útil esta pantalla: **una lista de los `product_id` que ya aparecieron en ventas y todavía
no están mapeados**, con un botón para mapear cada uno en un click:

```sql
SELECT oi.shopify_product_id, min(oi.title) AS title, count(*)::int AS veces,
       max(o.purchased_at) AS ultima, o.shop_domain
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
WHERE oi.tier = 'unknown' AND oi.shopify_product_id IS NOT NULL
GROUP BY oi.shopify_product_id, o.shop_domain
ORDER BY veces DESC;
```

Al mapear, **re-resolvé las órdenes existentes** de ese producto: actualizá `order_items.tier`, y
`orders.tier`/`orders.funnel_id` de las que quedaron en `unknown`/`NULL`. Todo en una transacción, y
mostrá cuántas filas se corrigieron. Sin este re-proceso, mapear un producto solo arregla las ventas
futuras y las viejas quedan mal para siempre.

También CRUD de `shop_map` (dominio de tienda → funnel), que es el último recurso de D10.

### B.4 Ajustes y salud

- `settings`: `fx_source` (`oficial` / `blue`, con la advertencia de P-01), `default_currency_view`,
  `retention_days_events`.
- Últimas 20 cotizaciones de `fx_rates`, con la columna "pesos por euro" calculada (`1/rate`), que es
  como se lee. Y un formulario para **cargar una a mano** (`source='manual'`), que es la vía de escape
  de D13.
- Últimas 50 filas de `webhook_events` con su status, y las últimas 50 de `ingest_errors`. Filtrables
  por status. Sin esto, diagnosticar una venta que no apareció obliga a entrar por SSH.
- Estado del sistema: última sesión recibida por funnel, último rollup (`max(computed_at)` de
  `daily_metrics`), última cotización, cantidad de particiones de `events`.

## `app/api/config/**`

Un endpoint por recurso (`funnels`, `steps`, `products`, `shops`, `settings`, `fx`), con `GET` y
`POST`/`PATCH`/`DELETE` según haga falta.

Reglas para todos:

- **Guard de auth en cada uno.** Son endpoints de escritura: sin cookie válida, 401. No alcanza con el
  middleware.
- Validación con zod de todo lo que llega. `tier` solo puede ser uno de los seis valores del union
  `Tier`; `timezone` tiene que ser una TZ válida (probala con
  `Intl.DateTimeFormat(undefined,{timeZone:x})` dentro de un try/catch); `funnel_id` tiene que existir.
- Todos los cambios por parámetros de consulta preparados, nunca por concatenación.
- Los que tocan varias tablas (mapear un producto y re-resolver órdenes) van en `tx()`.

## Verificación

```bash
cd ~/Desktop/funnel/dashboard-admin
npx tsc --noEmit && npm run build && npm test

# 1 — leads: si no hay credenciales de Supabase, la página dice "no configurado" y NO explota
curl -sS 'http://127.0.0.1:3005/api/data/leads?f=chauhinchazon&range=30d' \
  -b "panel_token=$(cat /tmp/panel_token)" | python3 -m json.tool | head -20

# 2 — el CSV mantiene el formato exacto del panel viejo
curl -sS 'http://127.0.0.1:3005/api/data/leads?f=chauhinchazon&format=csv&onlyNonBuyers=1' \
  -b "panel_token=$(cat /tmp/panel_token)" | head -3
diff <(curl -sS '…&format=csv' -b "…" | head -1) \
     <(head -1 ~/Desktop/funnel/testfunnel/app/api/admin/leads-export/*.ts | grep -o 'First Name.*Note')
# la cabecera tiene que coincidir

# 3 — mapear un producto re-resuelve las órdenes viejas
docker compose exec db psql -U panel -d panel -c \
  "SELECT tier, count(*) FROM order_items GROUP BY 1;"
# mapear desde /config → volver a correr la query: 'unknown' baja

# 4 — sin cookie, los endpoints de config devuelven 401
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3005/api/config/products \
  -H 'Content-Type: application/json' -d '{"productId":"1","funnelId":1,"tier":"front"}'
# esperado: 401
```

A ojo: `/config` permite mapear un producto sin escribir SQL, la key regenerada se muestra una vez y
no vuelve a aparecer al recargar, y `/leads` baja un CSV que Shopify acepta.

## Cuándo parar

Si `clientes` en Supabase tiene columnas distintas a las que asume este task, **no adivines el mapeo
al CSV**: el formato del CSV es lo que Shopify espera y equivocarlo rompe el import. Anotá en §10 del
plan.

Si te falta `@supabase/supabase-js`: no la instales. La API REST alcanza y §8 del plan prohíbe tocar
`package.json`.
