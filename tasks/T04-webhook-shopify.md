# T04 — Webhook de Shopify centralizado: todas las ventas, todos los funnels

- **Depende de:** T01 (`orders`, `order_items`, `product_map`, `shop_map`, `webhook_events`,
  `lib/db.ts`, `lib/fx.ts`).
- **Bloquea:** T12 (importación del histórico usa el mismo resolvedor de tier).
- **Paralelizable con:** T02, T03, T05, T10, T11.
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos:** `app/api/webhooks/shopify/route.ts`, `lib/orders/*`, `lib/orders/*.test.ts`.

Contrato congelado en **§5 del plan**. Decisiones que lo gobiernan: **D8** (el webhook se suma, no se
muda), **D10** (resolución del funnel en 3 pasos, nunca se descarta una venta), **D11** (el tier lo
setea el usuario), **D12/D13** (conversión a EUR congelada).

**Antes de escribir nada, leé `~/Desktop/funnel/testfunnel/app/api/shopify-webhook/route.ts`
completo.** Ese archivo ya resolvió, en producción y con plata real, la verificación de HMAC contra
el body crudo, el ruteo por topic, la lectura de `note_attributes`, la herencia de UTMs y la
idempotencia. Este task es ese archivo **sin** Meta CAPI, **sin** Supabase y **con** el modelo de
datos nuevo. Copiar sus soluciones es lo correcto; reinventarlas es cómo se pierde una venta.

---

## 1. Estructura

```
app/api/webhooks/shopify/route.ts   handler: firma, topic, log, respuesta
lib/orders/verify.ts                HMAC multi-secret contra el body crudo
lib/orders/attribution.ts           note_attributes + landing_site → utms, sid, vid, funnel
lib/orders/resolve.ts               funnel (D10) y tier (D11)
lib/orders/upsert.ts                orders + order_items + link a sessions, en transacción
lib/orders/refund.ts                refunds/create y orders/cancelled
lib/orders/*.test.ts
```

## 2. `route.ts`

`runtime = 'nodejs'`, `dynamic = 'force-dynamic'`.

1. **Body crudo primero.** `const raw = await req.text()`. La firma se calcula sobre los bytes
   exactos que llegaron: si parseás y re-serializás, el HMAC no coincide nunca. Es el error clásico.
2. `verifySignature(raw, req.headers.get('x-shopify-hmac-sha256'))` contra cada secret de
   `SHOPIFY_WEBHOOK_SECRETS` (lista separada por comas), con `crypto.timingSafeEqual`.
   - Falla → fila en `webhook_events` con `status='bad_signature'` (guardá el payload: hace falta
     para diagnosticar) y **401**.
   - `SHOPIFY_WEBHOOK_SECRETS` vacío → **401 y log de error**. A diferencia del webhook de los
     funnels, acá **no hay modo permisivo**: este endpoint es la fuente de verdad de las ventas y una
     tienda no configurada tiene que fallar visiblemente, no aceptar todo.
3. Topic (`x-shopify-topic`):
   - `orders/paid` → aprobar;
   - `orders/create` → aprobar **solo si** `financial_status === 'paid'`;
   - `refunds/create`, `orders/cancelled` → devolución;
   - cualquier otro → fila con `status='ignored'` y **200**.
4. Ejecutá, registrá el resultado en `webhook_events` (`ok` | `duplicate` | `unmatched_funnel` |
   `error`) y respondé **200** siempre que la firma haya sido válida. Un 5xx hace que Shopify
   reintente el mismo pedido por horas; el error tiene que quedar en la base, que es donde se mira.
5. `GET` del mismo path: healthcheck que devuelve `{ ok: true, configured: <bool> }` sin exponer
   secrets. Sirve para comprobar desde el navegador que el endpoint existe antes de configurarlo en
   Shopify.

## 3. `lib/orders/attribution.ts`

Fuentes, en orden de confianza (igual que el webhook existente, `orderAttribution`):

1. **`note_attributes`** de la orden. Es el canal confiable: lo escribe
   `buildCheckoutAttribution()` del funnel. Claves esperadas: `funnel`, `sid`, `vid`, `utm_source`,
   `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `fbclid`, `fbc`, `fbp`, `src_host`.
   Las tres últimas no se usan acá (eran para CAPI) pero **no molestan**; ignoralas.
2. **Query string de `landing_site`**, para órdenes que no pasaron por nuestro checkout attribution.
3. **`inferUtmSource`**: sin `utm_source` pero con `fbclid` → `'facebook'`. Replicá la función de
   `testfunnel/lib/utm.ts`, no la reescribas de memoria.
4. **Herencia por email**: si después de todo eso no hay `utm_source`, tomá los UTMs de la compra
   anterior más reciente del mismo email que sí los tenga:

```sql
SELECT utm_source, utm_medium, utm_campaign, utm_content, utm_term
FROM orders
WHERE email = $1 AND utm_source <> '(directo)'
ORDER BY purchased_at DESC LIMIT 1
```

Esto es lo que atribuye un upsell abierto desde el mail en otro dispositivo. Sin esta regla, todos
los upsells figuran como tráfico directo.

Normalización de valores: **la misma función que usa T02** (`cleanUtmValue` de los funnels). Vacío →
`'(directo)'`. Si el dashboard normaliza distinto en el ingest y en el webhook, la campaña de una
sesión no matchea la de su venta y la atribución se parte en dos mitades que no se cruzan.

## 4. `lib/orders/resolve.ts`

**Funnel (D10), en orden, y nunca se descarta:**

```ts
export async function resolveFunnel(input: {
  attrFunnel?: string;          // note_attributes.funnel
  shopDomain: string;
  productIds: string[];
}): Promise<{ funnelId: number | null; how: 'attribute' | 'product' | 'shop' | 'none' }>;
```

1. `attrFunnel` → `getFunnelBySlug`. Si el slug no existe, seguí al paso 2 y anotá el warning.
2. `product_map` por cada `productId`: primero `(shopDomain, productId)`, después `('*', productId)`.
   Si distintos ítems mapean a **funnels distintos**, gana el del ítem más caro y se registra
   `status='ok'` con un `error` descriptivo (no es un error fatal, pero hay que verlo).
3. `shop_map` por `shopDomain`.
4. Nada → `funnelId = null`, `how = 'none'`, fila en `webhook_events` con
   `status='unmatched_funnel'`. **La orden se guarda igual.** Aparece en el panel como "Ventas sin
   atribuir".

**Tier (D11):**

```ts
export async function resolveTier(shopDomain: string, productId: string | null): Promise<Tier>;
```

Solo desde `product_map`. Sin fila → `'unknown'`. **Prohibido adivinar el tier por el nombre del
producto**: un "Protocolo 30 días" puede ser el front en un funnel y el upsell en otro, y una
heurística que acierta el 80% de las veces produce un AOV que parece bien y está mal.

`orders.tier` = el tier del ítem de mayor `amount`. Empate → el de mayor cantidad; si sigue empatado,
el primero.

## 5. `lib/orders/upsert.ts`

Todo en un `tx()`:

```ts
export async function upsertOrder(order: ShopifyOrder, shopDomain: string, raw: unknown):
  Promise<{ orderId: number; isNew: boolean; funnelId: number | null; warnings: string[] }>;
```

**a) Campos.** Mismo mapeo que el webhook existente, que ya está afinado:

| Columna | De dónde |
|---|---|
| `external_id` | `'shopify_' + order.id` |
| `order_number` | `order.order_number ?? order.name` |
| `email` | `order.email \|\| order.contact_email \|\| order.customer?.email`, en minúsculas y trim |
| `amount` | `parseFloat(order.total_price ?? order.current_total_price)` |
| `currency` | `order.currency ?? 'ARS'` |
| `purchased_at` | `order.processed_at \|\| order.created_at` |
| `country` | `billing_address?.country_code ?? shipping_address?.country_code` |
| `raw` | el payload completo |

**b) `day`** = `purchased_at` en la TZ del funnel resuelto. Si el funnel es `NULL`, usá
`DASHBOARD_TZ`. Calculalo en SQL, no en JS.

**c) EUR.** `toEur(amount, currency, day)` de `lib/fx.ts`. Si devuelve `null` (todavía no hay ninguna
cotización), guardá `amount_eur = NULL`, `fx_stale = true` y seguí. **Nunca falles una venta por
falta de cotización**: `scripts/backfill-fx.ts` (T03) la completa después.

**d) Idempotencia.** `INSERT … ON CONFLICT (source, external_id) DO NOTHING` + `RETURNING id`. Si no
vuelve nada, es un reenvío: `isNew = false`, no toques `order_items`, registrá
`status='duplicate'` y salí. Shopify manda `orders/create` y `orders/paid` para la misma compra: sin
esto, cada venta se cuenta dos veces.

**e) `order_items`.** Una fila por `line_items[]`, con su tier. Solo cuando `isNew`.

**f) Link a la sesión.** Si vino `sid` y es un uuid válido:

```sql
UPDATE orders SET session_id = $1, visitor_id = $2 WHERE id = $3;
UPDATE sessions SET purchased_at = LEAST(purchased_at, $2) WHERE id = $1 AND funnel_id = $3;
```

El `AND funnel_id` no es decorativo: sin él, un `sid` cruzado marcaría como compradora la sesión de
otro funnel. Si el `UPDATE` de `sessions` no afecta filas (sesión vieja ya purgada, o compra desde
otro dispositivo), **no es un error**: la orden queda con `session_id` guardado y listo.

## 6. `lib/orders/refund.ts`

```sql
UPDATE orders
SET status = 'refunded', refunded_at = COALESCE(refunded_at, now()), updated_at = now()
WHERE source = 'shopify' AND external_id = $1
```

- **No se borra la fila y no se resta de `orders_count`.** Bruto, devuelto y neto son tres números
  distintos y el panel muestra los tres (§ T07).
- `refunds/create` trae el `order_id` en `refund.order_id`, no en `refund.id`. Confundirlos es el bug
  de este handler: verificá contra el payload real.
- Si la orden no existe (devolución de algo anterior a este sistema): fila en `webhook_events` con
  `status='error'` y `error='order_not_found'`, y **200**.
- La sesión **no** se desmarca: `sessions.purchased_at` registra que la compra ocurrió, y ocurrió.

## 7. Tests

Con payloads de Shopify realistas (armá 4 fixtures en `lib/orders/__fixtures__/`: front con un ítem,
orden con front + bump, upsell sin UTMs pero con email de una compra previa, y un `refunds/create`).

1. firma válida → orden creada, `funnel_id` resuelto por atributo;
2. firma inválida → 401, cero filas en `orders`, una en `webhook_events`;
3. `SHOPIFY_WEBHOOK_SECRETS` vacío → 401 (no acepta);
4. `orders/create` + `orders/paid` de la misma orden → **una** fila, la segunda `duplicate`;
5. producto sin fila en `product_map` → `tier='unknown'`, la orden se guarda;
6. ningún camino resuelve el funnel → `funnel_id IS NULL`, `status='unmatched_funnel'`, orden
   guardada;
7. orden con front + bump → dos `order_items` con tiers distintos y `orders.tier` = el del más caro;
8. upsell sin UTMs, con una compra previa atribuida del mismo email → hereda la campaña;
9. sin cotización en `fx_rates` → `amount_eur IS NULL`, `fx_stale = true`, orden guardada;
10. `sid` válido → `sessions.purchased_at` marcado; `sid` de otro funnel → **no** marcado;
11. `refunds/create` → `status='refunded'`, la fila sigue existiendo;
12. `orders/create` con `financial_status='pending'` → ignorado, sin fila en `orders`.

## 8. Verificación

```bash
cd ~/Desktop/funnel/dashboard-admin
npx tsc --noEmit && npm run build && npm test

SECRET=$(grep '^SHOPIFY_WEBHOOK_SECRETS=' .env | cut -d= -f2 | cut -d, -f1)
BODY=$(cat lib/orders/__fixtures__/order-front.json)
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)

curl -sS -X POST http://127.0.0.1:3005/api/webhooks/shopify \
  -H "X-Shopify-Hmac-Sha256: $SIG" \
  -H 'X-Shopify-Topic: orders/paid' \
  -H 'X-Shopify-Shop-Domain: mitienda.myshopify.com' \
  -H 'Content-Type: application/json' --data "$BODY"

# repetilo: no puede duplicar
docker compose exec db psql -U panel -d panel -c \
  "SELECT external_id, funnel_id, tier, amount, currency, amount_eur, fx_stale, status
   FROM orders ORDER BY id DESC LIMIT 5;"
docker compose exec db psql -U panel -d panel -c \
  "SELECT status, count(*) FROM webhook_events GROUP BY 1;"

# firma inválida
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3005/api/webhooks/shopify \
  -H 'X-Shopify-Hmac-Sha256: bXVjaGFjaG8=' -H 'X-Shopify-Topic: orders/paid' \
  -H 'X-Shopify-Shop-Domain: mitienda.myshopify.com' --data "$BODY"
# esperado: 401
```

## 9. Nota para el deploy (la aplica el usuario, no este task)

En el admin de la tienda, **Configuración → Notificaciones → Webhooks**, se agregan las
suscripciones nuevas **sin borrar las existentes** (D8): `orders/paid`, `orders/create`,
`refunds/create` y `orders/cancelled` apuntando a
`https://panel.hilvanapp.com/api/webhooks/shopify`. Las creadas desde el admin firman con el secret
de la tienda, que es el mismo que ya está en el env de cada funnel: por eso
`SHOPIFY_WEBHOOK_SECRETS` del dashboard se copia de ahí.

Dejá esto escrito en `docs/` o en el README de tu módulo, porque es el paso manual sin el cual el
webhook nunca recibe nada.

## 10. Cuándo parar

Si aparece una tienda cuyo secret no está en `SHOPIFY_WEBHOOK_SECRETS`, o si el payload real difiere
del que asumís (por ejemplo, `refund.order_id` ausente): anotá en §10 del plan. No agregues un modo
permisivo "temporal" para salir del paso: un webhook de ventas que acepta cualquier firma es una
puerta abierta a que cualquiera te infle las ventas.
