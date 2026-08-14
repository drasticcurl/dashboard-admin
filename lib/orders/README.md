# lib/orders — webhook de ventas de Shopify

Endpoint: `POST /api/webhooks/shopify` (plan §5). Registra **todas** las ventas de
**todos** los funnels en `orders`/`order_items`, en su moneda original y convertidas
a EUR congelado en la fila (D12/D13).

```
lib/orders/
  verify.ts        HMAC multi-secret contra el body crudo
  attribution.ts   note_attributes + landing_site → utms, sid, vid, funnel; herencia por email
  resolve.ts       funnel (D10: attribute → product_map → shop_map) y tier (D11)
  upsert.ts        orders + order_items + link a sessions, en una transacción
  refund.ts        refunds/create y orders/cancelled → status='refunded'
  types.ts         payload de Shopify (parcial)
  __fixtures__/    payloads realistas para los tests
```

## Setup manual en la tienda (sin esto el webhook nunca recibe nada)

En el admin de Shopify: **Configuración → Notificaciones → Webhooks**, agregar las
suscripciones **sin borrar las existentes** (D8: cada funnel conserva la suya, que es
lo que alimenta los entitlements de la PWA):

| Topic | URL |
|---|---|
| `orders/paid` | `https://panel.hilvanapp.com/api/webhooks/shopify` |
| `orders/create` | `https://panel.hilvanapp.com/api/webhooks/shopify` |
| `refunds/create` | `https://panel.hilvanapp.com/api/webhooks/shopify` |
| `orders/cancelled` | `https://panel.hilvanapp.com/api/webhooks/shopify` |

Las suscripciones creadas desde el admin firman con el secret de la tienda, que es el
mismo que ya está en el env de cada funnel. Por eso `SHOPIFY_WEBHOOK_SECRETS` del
dashboard se copia de ahí y admite varios secrets separados por coma (una tienda por
funnel).

## Comportamiento

- **Firma**: HMAC-SHA256 del body crudo contra cada secret de la lista, con
  `timingSafeEqual`. Firma inválida → 401 y fila `bad_signature` en `webhook_events`.
  Sin secrets configurados → **401 igual** (no hay modo permisivo: este endpoint es
  la fuente de verdad de las ventas).
- **Respuesta**: 200 siempre que la firma sea válida, pase lo que pase adentro. Un 5xx
  hace que Shopify reintente por horas; el error queda en `webhook_events`, que es
  donde se mira (D20).
- **Idempotencia**: `UNIQUE (source, external_id)` con `external_id = 'shopify_' +
  order.id`. `orders/create` + `orders/paid` de la misma compra → una sola fila; el
  reenvío entra como `duplicate`.
- **`orders/create`** solo se procesa con `financial_status === 'paid'`; si no,
  `ignored`.
- **Devoluciones**: `refunds/create` (el order_id está en `refund.order_id`, no en
  `refund.id`) y `orders/cancelled` → `status='refunded'`, `refunded_at = now()`. La
  fila no se borra: bruto, devuelto y neto son tres números distintos. Devolución de
  una orden anterior a este sistema → 200 con `order_not_found` en `webhook_events`.
- **Funnel de la venta (D10)**: cart attribute `funnel` → `product_map` por
  `(shop_domain, product_id)` (fila exacta, después `'*'`) → `shop_map`. Si nada
  resuelve, la orden se guarda con `funnel_id NULL` y aparece en "Ventas sin
  atribuir": una venta nunca se descarta.
- **Tier (D11)**: solo desde `product_map`; sin fila → `unknown`. `orders.tier` es el
  del ítem de mayor precio; empate → mayor cantidad; si sigue → el primero.
- **Atribución**: `note_attributes` (canal confiable, lo escribe
  `buildCheckoutAttribution` del funnel) → query de `landing_site` → `fbclid` sin
  `utm_source` → "facebook" → herencia de los UTMs de la compra previa del mismo
  email (así un upsell abierto desde el mail no figura como tráfico directo).
- **Sesión**: si viene `sid` válido, se escribe `orders.session_id` y se marca
  `sessions.purchased_at` (solo si la sesión es del funnel resuelto). Una sesión que
  ya no existe no es un error.

## Verificación rápida

```bash
SECRET=$(grep '^SHOPIFY_WEBHOOK_SECRETS=' .env | cut -d= -f2 | cut -d, -f1)
BODY=$(cat lib/orders/__fixtures__/order-front.json)
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)
curl -sS -X POST http://127.0.0.1:3005/api/webhooks/shopify \
  -H "X-Shopify-Hmac-Sha256: $SIG" -H 'X-Shopify-Topic: orders/paid' \
  -H 'X-Shopify-Shop-Domain: mitienda.myshopify.com' -H 'Content-Type: application/json' \
  --data "$BODY"
```

Repetir el mismo curl no duplica la orden; con otra firma devuelve 401.
