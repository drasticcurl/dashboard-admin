# T08 — Resumen unificado: todos los funnels en una pantalla

- **Depende de:** T01 (schema, `daily_metrics`), T05 (shell, `components/ui.tsx`).
- **Bloquea:** nada.
- **Paralelizable con:** T06, T07, T09, T10, T11.
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos:** `app/(panel)/resumen/**`, `lib/queries/overview.ts`, `lib/queries/overview.test.ts`,
  `app/api/data/overview/route.ts`, `scripts/rollup.ts`. **Nada más.**

Esta es la pantalla que justifica todo el proyecto: *"mi finalidad es tirar varios funnels pero tener
la información acoplada en un solo lugar"*. Es la página de inicio del panel (`/` redirige acá).

Decisiones: **D12** (todo en EUR para poder sumar), **D19** (el Resumen usa `DASHBOARD_TZ`), **§3.8**
(lee de `daily_metrics`, no de las tablas base).

---

## 1. Lo que esta pantalla tiene que responder, en cinco segundos

1. cuánto entró **en total**, sumando todos los funnels, en euros;
2. cuánto puso cada funnel, y cuál está creciendo o cayendo;
3. la evolución día por día del conjunto;
4. las métricas de embudo de cada funnel, lado a lado y comparables;
5. si hay algo roto: un funnel que dejó de reportar, ventas sin atribuir, cotizaciones faltantes.

**Por qué en euros:** un funnel cobra en ARS y el próximo puede cobrar en USD. Sumar monedas
distintas es sumar peras con manzanas, y el euro es la moneda de referencia que eligió el usuario
(D12). Cada tarjeta de funnel muestra además su moneda original.

## 2. Por qué esta pantalla lee de un rollup

El Embudo y Ventas consultan las tablas base porque filtran un funnel y un rango corto. El Resumen
cruza **todos** los funnels y puede pedir "todo el histórico": con N funnels creciendo, eso es un
escaneo completo de `sessions` y `orders` en cada carga. `daily_metrics` (§3.8 del plan) tiene una
fila por funnel/día y hace que la pantalla cargue igual de rápido con 2 funnels o con 12.

## 3. `scripts/rollup.ts`

Recalcula `daily_metrics` para un rango de días. **Recalcula, no acumula**: un `INSERT … ON CONFLICT
DO UPDATE` que pisa el valor con el resultado de contar de nuevo. Un rollup que suma incrementos se
desincroniza a la primera corrida doble y nadie se entera hasta que los números no cierran.

```
npm run rollup                 # últimos 3 días (lo que corre cada 10 minutos)
npm run rollup -- --days=35    # último mes (lo que corre de noche)
npm run rollup -- --from=2026-01-01 --to=2026-08-11
npm run rollup -- --all        # reconstruye todo desde el primer dato
```

Por cada `(funnel_id, day)` escribe **dos** filas: una con `variant = '*'` (todas) y una por cada
variante que ese funnel tenga con datos ese día. La fila `'*'` no es la suma de las otras calculada
en JS: es su propio `count` sin filtro de variante, porque una sesión con variante nula o desconocida
tiene que contar en el total.

Las métricas salen de dos queries por día, las mismas definiciones que T06 y T07 (si difieren, el
Resumen y las secciones muestran números distintos para lo mismo, que es la peor forma de perder la
confianza en un panel):

```sql
-- sesiones e hitos
SELECT count(*)::int,
       count(*) FILTER (WHERE max_step_index >= 1)::int,
       count(*) FILTER (WHERE sales_view_at IS NOT NULL)::int,
       count(*) FILTER (WHERE checkout_click_at IS NOT NULL)::int
FROM sessions WHERE funnel_id = $1 AND day = $2 AND ($3::text IS NULL OR variant = $3);

-- ventas
SELECT count(*) FILTER (WHERE status = 'approved')::int,
       count(*) FILTER (WHERE status <> 'approved')::int,
       COALESCE(sum(amount)     FILTER (WHERE status = 'approved'), 0),
       COALESCE(sum(amount)     FILTER (WHERE status <> 'approved'), 0),
       COALESCE(sum(amount_eur) FILTER (WHERE status = 'approved'), 0),
       COALESCE(sum(amount_eur) FILTER (WHERE status <> 'approved'), 0)
FROM orders WHERE funnel_id = $1 AND day = $2;
```

`orders` no tiene columna `variant` poblada de forma confiable (viene del cart attribute y puede
faltar), así que la fila por variante lleva las ventas en 0 y solo la fila `'*'` tiene los montos.
**Escribí eso como comentario en el script**, porque si no, alguien va a mirar la fila `ar` y creer
que ese funnel no vendió nada.

Imprimí cuántas filas escribió y cuánto tardó. Exit 0.

**Cron** (el archivo lo instala T12, acá solo documentalo):

```cron
*/10 * * * *  cd /srv/panel/current && node scripts/rollup.js --days=3   >> /var/log/panel/rollup.log 2>&1
25   3 * * *  cd /srv/panel/current && node scripts/rollup.js --days=35  >> /var/log/panel/rollup.log 2>&1
```

El nocturno a las 03:25 va **después** del `fetch-fx` de las 03:10 (T03), para que el rollup del día
cerrado use la cotización buena. Ese orden no es casual: invertirlo deja los euros del día anterior
calculados con la cotización de antes de ayer.

## 4. `lib/queries/overview.ts`

```ts
export type OverviewFilters = { from: string; to: string };   // en DASHBOARD_TZ

export type FunnelSummary = {
  funnelId: number; slug: string; name: string; color: string;
  sellCurrency: string; timezone: string;
  sessions: number; quizStarted: number; salesViews: number; checkoutClicks: number;
  orders: number; ordersRefunded: number;
  netEur: number; netOrig: number;
  convSessionToSale: number;    // orders / sessions
  avgTicketEur: number;
  lastEventAt: string | null;   // para detectar un funnel que dejó de reportar
};

export type OverviewData = {
  totals: { sessions: number; orders: number; netEur: number; avgTicketEur: number;
            ordersRefunded: number; refundedEur: number };
  funnels: FunnelSummary[];
  byDay: { day: string; netEur: number; orders: number; sessions: number;
           perFunnel: Record<string, number> }[];     // netEur por slug, para el gráfico apilado
  alerts: Alert[];
  generatedAt: string;
  staleRollup: boolean;         // true si el rollup más nuevo tiene más de 30 min
};

export type Alert = { tone: 'warn' | 'bad'; text: string; href?: string };
```

`alerts` se calcula acá y es la mitad del valor de la pantalla:

| Condición | Alerta |
|---|---|
| un funnel activo sin ningún evento en las últimas 6 h (y con eventos antes) | `bad` — "chauhinchazon no reporta desde las 14:20" |
| ventas con `funnel_id IS NULL` en el rango | `warn` — "N ventas sin funnel asignado" → `/ventas?f=__unattributed__` |
| órdenes con `fx_stale` | `warn` — "N órdenes con cotización provisoria" |
| órdenes con `tier='unknown'` | `warn` — "N órdenes sin tier" → `/config` |
| filas en `ingest_errors` en las últimas 24 h | `warn` — "N eventos con problemas" → `/config` |
| `daily_metrics` más nuevo con más de 30 min | `bad` — "el rollup no corre desde …" |

La primera y la última son las que importan: un funnel que dejó de mandar eventos, o un cron muerto,
hacen que el panel muestre ceros creíbles. Sin estas alertas, el usuario se entera cuando compara
contra Shopify una semana después.

La ventana de 6 h evita falsos positivos de madrugada. Si el funnel **nunca** reportó, no alertes:
es un funnel nuevo, no uno caído.

## 5. `app/api/data/overview/route.ts`

`GET` con `range` o `from`+`to`. Guard de auth → 401. `force-dynamic`, `no-store`.
Rango resuelto con `DASHBOARD_TZ` (D19).

## 6. La pantalla

`app/(panel)/resumen/page.tsx` + `ResumenView.tsx`.

1. **Los alerts arriba de todo**, antes de cualquier número. Si algo está roto, el usuario tiene que
   verlo antes de leer una cifra que puede estar mal.
2. **Cuatro `StatCard` grandes**: Neto total (EUR), Órdenes, Sesiones, Ticket promedio. Con la
   comparación contra el período anterior de igual largo (7 días vs los 7 anteriores), como `trend`
   del `StatCard`. La comparación es lo que convierte un número en información.
3. **Una tarjeta por funnel**, en grilla: punto de color del funnel, nombre, neto en EUR, neto en su
   moneda, órdenes, sesiones, conversión, ticket. Cada una linkea a `/embudo?f=<slug>` y
   `/ventas?f=<slug>`. Ordenadas por neto descendente.
4. **Gráfico apilado por día**: neto en EUR, una banda por funnel con su color. Es el gráfico que
   muestra si el conjunto crece o si un funnel tapa la caída de otro.
5. **Tabla comparativa**: una fila por funnel, columnas de sesiones → quiz → venta → checkout →
   compra, con las tasas. Comparar el embudo de dos funnels con preguntas distintas solo tiene sentido
   a este nivel de hitos, no paso por paso: **no** pongas los pasos del quiz acá.
6. **Pie**: `generatedAt` y, si `staleRollup`, cuándo fue el último rollup.

Estado vacío: un `EmptyState` que diga que todavía no hay datos y liste los tres pasos que faltan
(cargar las ingest keys, agregar el webhook en Shopify, correr el rollup). Un panel vacío sin
explicación parece roto.

## 7. Tests

1. dos funnels con datos → `totals` es la suma exacta y `funnels` tiene las dos filas;
2. un funnel sin datos en el rango pero activo → aparece con todo en 0, **no** desaparece de la lista;
3. `byDay` cubre todos los días del rango, incluidos los sin ventas (con 0, no ausentes: si faltan
   días el gráfico miente sobre la continuidad);
4. `netEur` del resumen coincide **exactamente** con la suma de `netEur` de las secciones de ventas de
   cada funnel para el mismo rango. Es el test que garantiza que el rollup y las queries base no se
   desincronizaron;
5. rollup corrido dos veces → `daily_metrics` idéntica (recalcula, no acumula);
6. funnel sin eventos en 8 h con eventos previos → alerta `bad`;
7. funnel que nunca tuvo eventos → **sin** alerta;
8. `daily_metrics` con `computed_at` de hace 45 min → `staleRollup = true`.

El 4 es el más importante de todo el task. Si falla, hay dos verdades en el panel.

## 8. Verificación

```bash
cd ~/Desktop/funnel/dashboard-admin
npx tsc --noEmit && npm run build && npm test

npm run rollup -- --days=3
npm run rollup -- --days=3      # idempotente
docker compose exec db psql -U panel -d panel -c \
  "SELECT funnel_id, day, variant, sessions_count, orders_count, revenue_gross_eur
   FROM daily_metrics ORDER BY day DESC, funnel_id LIMIT 10;"

curl -sS 'http://127.0.0.1:3005/api/data/overview?range=7d' \
  -b "panel_token=$(cat /tmp/panel_token)" | python3 -m json.tool | head -50

# el test 4, a mano: los dos números tienen que ser idénticos
curl -sS 'http://127.0.0.1:3005/api/data/overview?range=7d' -b "panel_token=$(cat /tmp/panel_token)" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('resumen:', d['funnels'][0]['netEur'])"
curl -sS 'http://127.0.0.1:3005/api/data/sales?f=chauhinchazon&range=7d' -b "panel_token=$(cat /tmp/panel_token)" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('ventas :', d['totals']['netEur'])"
```

## 9. Cuándo parar

Si el test 4 no pasa, **no ajustes uno de los dos lados hasta que coincidan**. Encontrá por qué
difieren (lo más probable: distinta definición de neto, o el rollup usando `purchased_at::date` en vez
de `orders.day`) y arreglá la causa. Un panel con dos totales distintos para lo mismo no se usa más.

Si te falta el gasto de ads para calcular ROAS: **no lo agregues**. `ad_spend` existe pero está fuera
de alcance (§0 del plan), la va a llenar otra app.
