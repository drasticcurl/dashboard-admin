# T07 — Sección Ventas: por funnel, bruto/devuelto/neto, ARS y EUR

- **Depende de:** T01 (schema, `lib/fx.ts`), T05 (shell, `components/ui.tsx`).
- **Bloquea:** nada.
- **Paralelizable con:** T06, T08, T09, T10, T11.
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos:** `app/(panel)/ventas/**`, `lib/queries/sales.ts`, `lib/queries/sales.test.ts`,
  `app/api/data/sales/route.ts`. **Nada más.**

Decisiones: **D11** (tier manual), **D12** (EUR congelado en la fila, ARS es la verdad), **D13**
(cotización del día), **D10** (ventas sin funnel se muestran, no se esconden).

---

## 1. Lo que esta pantalla tiene que responder

Del funnel elegido, en el rango:

1. cuánto entró: bruto, devuelto y **neto**, en euros y en la moneda original;
2. cuántas órdenes, ticket promedio, y el desglose por **tier** (front / bump / upsell / upsell2 /
   downsell), que es lo que dice si los upsells están funcionando;
3. de qué campaña vino cada peso;
4. la lista de las últimas ventas, para poder mirar una en particular;
5. qué está mal: órdenes sin funnel, sin tier, o con cotización provisoria.

## 2. `lib/queries/sales.ts`

```ts
export type SalesFilters = {
  funnelId: number | null;      // null = "sin atribuir"
  from: string; to: string;
  tier?: string;
  utmCampaign?: string;
  utmSource?: string;
  status?: 'approved' | 'refunded' | 'chargeback' | 'all';   // default: 'all'
};

export type SalesTotals = {
  ordersApproved: number; ordersRefunded: number; ordersChargeback: number;
  grossEur: number;  refundedEur: number;  netEur: number;
  grossOrig: number; refundedOrig: number; netOrig: number; currency: string;
  avgTicketEur: number;   // neto / órdenes aprobadas
  fxStaleCount: number;   // órdenes con conversión provisoria
  unknownTierCount: number;
};

export type SalesData = {
  totals: SalesTotals;
  byTier:     { tier: string; orders: number; netEur: number; netOrig: number }[];
  byCampaign: { campaign: string; orders: number; netEur: number }[];
  bySource:   { source: string; orders: number; netEur: number }[];
  byDay:      { day: string; orders: number; netEur: number; refundedEur: number }[];
  recent:     OrderRow[];       // últimas 50
  unattributed: { orders: number; netEur: number };   // funnel_id IS NULL, del mismo rango
  generatedAt: string;
};

export async function getSalesData(f: SalesFilters): Promise<SalesData>;
```

**Definiciones, y hay que respetarlas al pie porque son plata:**

- **bruto** = suma de `amount` de las órdenes con `status = 'approved'`.
- **devuelto** = suma de `amount` de las que tienen `status IN ('refunded','chargeback')`.
- **neto** = bruto − devuelto.
- Una orden devuelta **sigue contando** en `ordersRefunded` y **no** se borra de la base (D10 del
  webhook). El panel viejo contaba las devueltas como ventas y nunca las restaba: eso es exactamente
  lo que se está arreglando.
- El día de una orden es `orders.day` (ya resuelto en la TZ del funnel al ingresarla), **no**
  `purchased_at::date`. Si recalculás la fecha acá con otra TZ, las ventas de la medianoche se mueven
  de día y el total del mes no cierra contra el de la semana.

El SQL es un solo `SELECT` con `FILTER` por status para los totales:

```sql
SELECT
  count(*) FILTER (WHERE status = 'approved')::int                        AS orders_approved,
  count(*) FILTER (WHERE status = 'refunded')::int                        AS orders_refunded,
  count(*) FILTER (WHERE status = 'chargeback')::int                      AS orders_chargeback,
  COALESCE(sum(amount)     FILTER (WHERE status = 'approved'), 0)         AS gross_orig,
  COALESCE(sum(amount_eur) FILTER (WHERE status = 'approved'), 0)         AS gross_eur,
  COALESCE(sum(amount)     FILTER (WHERE status <> 'approved'), 0)        AS refunded_orig,
  COALESCE(sum(amount_eur) FILTER (WHERE status <> 'approved'), 0)        AS refunded_eur,
  count(*) FILTER (WHERE fx_stale)::int                                   AS fx_stale_count,
  count(*) FILTER (WHERE tier = 'unknown')::int                           AS unknown_tier_count
FROM orders
WHERE ($1::smallint IS NULL OR funnel_id = $1) AND day BETWEEN $2 AND $3
  AND ($4::text IS NULL OR tier = $4)
  AND ($5::text IS NULL OR utm_campaign = $5);
```

Cuidado con `funnel_id`: `($1 IS NULL OR funnel_id = $1)` con `$1 = NULL` devuelve **todo**, no las
huérfanas. Para el cajón "sin atribuir" hace falta una rama explícita `funnel_id IS NULL`. Escribí
las dos ramas y un test para cada una; es el bug silencioso más probable de este archivo.

`COALESCE(sum(...), 0)`: sin eso, un rango sin ventas devuelve `null` y la UI muestra `NaN`.

`amount_eur` puede ser `NULL` (D12: venta sin cotización todavía). `sum` lo ignora, así que el total
en euros queda **corto** sin avisar. Por eso `fxStaleCount` existe y por eso la UI lo muestra: cuando
es mayor a 0, el total en euros lleva un asterisco.

## 3. `app/api/data/sales/route.ts`

`GET`, mismos parámetros que T06 más `tier` y `status`. Guard de auth → 401. `force-dynamic`,
`no-store`. `f=__unattributed__` como valor especial para el cajón de las huérfanas.

## 4. La pantalla

`app/(panel)/ventas/page.tsx` + `VentasView.tsx`.

1. **Toggle de moneda**, arriba a la derecha: `EUR` (default, de `settings.default_currency_view`) /
   `ARS`. Es un toggle de **visualización**: no recalcula nada, elige qué columna mostrar. Que se vea
   claro cuál está activa.
2. **Cinco `StatCard`**: Neto, Bruto, Devuelto, Órdenes, Ticket promedio. El Neto es el número grande;
   es el que importa.
3. **Desglose por tier**, tabla con: tier, órdenes, neto, % del neto total, y ticket promedio. Debajo,
   dos tasas derivadas que valen más que la tabla: **take rate del upsell**
   (órdenes de tier `upsell` ÷ órdenes de tier `front`) y **AOV real** (neto total ÷ órdenes de tier
   `front`, o sea cuánto vale cada comprador nuevo). Etiquetalas con esa definición a la vista: un
   número sin su definición al lado se malinterpreta a la semana.
4. **Gráfico por día** (recharts, ya está en las dependencias): barras del neto por día, con las
   devoluciones en negativo abajo. Un solo gráfico, sin leyenda decorativa.
5. **Tabla de campañas**: campaña, órdenes, neto, ticket. Top 20 + `'(otras)'`.
6. **Últimas 50 ventas**: fecha y hora, email (parcialmente enmascarado: `lu***@gmail.com`), tier,
   producto, monto original, monto EUR, status, y de dónde salió la atribución. Con el email completo
   detrás de un click, no impreso de entrada: es una pantalla que se comparte por captura.
7. **Banners de calidad de dato**, arriba y visibles:
   - `unknownTierCount > 0` → "N órdenes sin tier asignado", link a `/config`;
   - `fxStaleCount > 0` → "N órdenes con cotización provisoria", con el comando del backfill;
   - `unattributed.orders > 0` → "N ventas sin funnel asignado", link al cajón.

   Los tres son tono `warn`, no `bad`: no está roto, falta configurarlo.

## 5. Enmascarado de email y PII

El email se muestra enmascarado por defecto. En el CSV que se exporte (si lo hacés) va completo,
porque el CSV se usa para trabajar. Esto no es opcional ni estético: es una pantalla con datos
personales de compradores reales, abierta en un dominio público, que se saca por captura para
mostrarle a alguien.

## 6. Tests

1. tres órdenes aprobadas y una devuelta → bruto, devuelto y neto exactos, y `ordersApproved` es 3;
2. rango sin ventas → todos los totales en `0`, ningún `null` ni `NaN` en el JSON;
3. `funnel_id IS NULL` → aparece en `unattributed` y **no** en los totales del funnel elegido;
4. `f=__unattributed__` → devuelve solo las huérfanas;
5. una orden con `amount_eur IS NULL` → `fxStaleCount` la cuenta y el total en euros no explota;
6. orden con `tier='unknown'` → `unknownTierCount` la cuenta;
7. las órdenes de otro funnel en el mismo rango no contaminan (mismo test que T06 §6.8);
8. take rate del upsell con 10 front y 3 upsell → 30%; con 0 front → **0, no división por cero**;
9. una orden en el borde de la medianoche: `orders.day` manda, no `purchased_at::date` en UTC.

## 7. Verificación

```bash
cd ~/Desktop/funnel/dashboard-admin
npx tsc --noEmit && npm run build && npm test

# órdenes de prueba, directo a la base (el webhook ya lo probó T04)
docker compose exec db psql -U panel -d panel <<'SQL'
INSERT INTO orders (funnel_id, source, external_id, email, status, tier, amount, currency,
                    amount_eur, fx_rate, fx_day, purchased_at, day)
VALUES
 (1,'manual','t07-1','a@test.com','approved','front',  7790, 'ARS', 4.51,0.000578,CURRENT_DATE, now(), CURRENT_DATE),
 (1,'manual','t07-2','b@test.com','approved','upsell',24790, 'ARS',14.34,0.000578,CURRENT_DATE, now(), CURRENT_DATE),
 (1,'manual','t07-3','c@test.com','refunded','front',  7790, 'ARS', 4.51,0.000578,CURRENT_DATE, now(), CURRENT_DATE),
 (NULL,'manual','t07-4','d@test.com','approved','unknown',9900,'ARS',NULL,NULL,NULL, now(), CURRENT_DATE)
ON CONFLICT (source, external_id) DO NOTHING;
SQL

curl -sS 'http://127.0.0.1:3005/api/data/sales?f=chauhinchazon&range=today' \
  -b "panel_token=$(cat /tmp/panel_token)" | python3 -m json.tool
# esperado: ordersApproved 2 · grossOrig 32580 · refundedOrig 7790 · netOrig 24790
#           unattributed.orders 1 · unknownTierCount 0 (la unknown es la huérfana, otro cajón)

curl -sS 'http://127.0.0.1:3005/api/data/sales?f=__unattributed__&range=today' \
  -b "panel_token=$(cat /tmp/panel_token)" | python3 -m json.tool | head -20
```

A ojo, en el browser: el toggle EUR/ARS cambia los cinco números de arriba y la tabla, el banner de
las ventas sin atribuir aparece, y la fila devuelta se ve claramente como devuelta.

## 8. Cuándo parar

Si el neto en euros no cierra con el neto en ARS convertido a la cotización del día, **no lo
"arregles" recalculando en la query**: la diferencia es esperable (cada orden usa la cotización de
**su** día, D12) y explicarla es tarea de la UI, no del SQL. Si la diferencia es grande, hay una
cotización mal cargada y eso va a §10 del plan.
