# T03 — Cotizaciones: fetcher diario ARS→EUR y backfill

- **Depende de:** T01 (tabla `fx_rates`, `lib/db.ts`, `lib/fx.ts` de lectura).
- **Bloquea:** nada. T04 usa `lib/fx.ts`, que ya existe desde T01; si no hay cotizaciones, guarda las
  ventas sin `amount_eur` y este task las completa después.
- **Paralelizable con:** T02, T04, T05, T10, T11.
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos:** `lib/fx-fetch.ts`, `scripts/fetch-fx.ts`, `scripts/backfill-fx.ts`,
  `lib/fx-fetch.test.ts`. **Nada más.** No toques `lib/fx.ts` (es de T01, solo lectura).

Contexto: D12 y D13 del plan, tabla en §3.7.

---

## 1. Objetivo

Que todos los días haya una fila en `fx_rates` con la cotización ARS→EUR, y que las ventas que se
guardaron sin cotización (o con una vieja) se corrijan solas cuando la cotización llega.

La regla de negocio, del §D12: **el monto en euros de una venta se congela en la fila el día de la
venta**. Este task no recalcula ventas viejas que ya tienen una cotización correcta; solo completa
las que quedaron con `fx_stale = true`.

## 2. Fuentes

**Primaria — `dolarapi.com`** (argentina, sin API key, verificada el 2026-08-11):

```
GET https://dolarapi.com/v1/cotizaciones/eur
→ {"moneda":"EUR","casa":"oficial","nombre":"Euro","compra":1714.5291,"venta":1728.6485,
   "fechaActualizacion":"2026-08-10T16:57:00.000Z"}
```

Devuelve **cuántos pesos vale un euro**. La tabla guarda lo inverso (`base='ARS'`, `quote='EUR'`,
`rate` = cuántos euros vale un peso), así que:

```
rate = 1 / venta
```

Se usa `venta`, no `compra` ni el promedio: es el valor al que se compran euros, que es la referencia
correcta para valuar ingresos en pesos.

`casa` sale de `settings.fx_source` (default `'oficial'`, ver P-01 del plan). Si el valor es
`'blue'`, el endpoint es `https://dolarapi.com/v1/dolares/blue` combinado con la paridad EUR/USD —
**no lo implementes en este task**: si `fx_source` es distinto de `'oficial'`, el fetcher tira un
error claro (`unsupported_fx_source`) y anota en `ingest_errors`. Que el usuario decida antes de que
alguien invente una fórmula de dos saltos.

**Respaldo — `open.er-api.com`** (sin API key, verificada el mismo día):

```
GET https://open.er-api.com/v6/latest/ARS
→ {"result":"success","time_last_update_unix":…,"base_code":"ARS","rates":{…,"EUR":0.000578,…}}
```

Acá `rates.EUR` **ya es** el `rate` que va a la tabla, sin invertir. Ojo con eso: es el error fácil
de este task. Escribí un test que compare las dos fuentes y afirme que difieren menos del 5%; si
difieren más, es señal de que una está invertida.

## 3. `lib/fx-fetch.ts`

```ts
export type FxFetchResult = { rate: number; source: 'dolarapi' | 'er-api'; asOf: Date };

/** Pide la cotización a la fuente primaria; si falla, a la de respaldo. */
export async function fetchRate(fxSource: string): Promise<FxFetchResult>;

/** Guarda (o pisa) la fila del día. */
export async function saveRate(day: string, rate: number, source: string): Promise<void>;

/** Sanidad: rechaza valores absurdos antes de escribir. */
export function assertPlausible(rate: number): void;
```

`assertPlausible` es la defensa que importa. Una API que devuelve `0`, `null`, un string o un número
con la coma corrida no puede escribir la tabla: con `rate = 0` **todas** las ventas del día valen
0 euros y el reporte queda mudo sin que nada falle. Rango aceptado para ARS→EUR:
`1e-6 < rate < 1e-2` (es decir, entre 100 y 1.000.000 pesos por euro). Si sale del rango, tirá con
el valor en el mensaje.

Además: si ya existe una fila del día con `source='manual'`, **no la pises**. Una cotización cargada
a mano es una decisión del usuario y le gana al cron. Verificalo antes del `INSERT`.

`fetch` con `AbortController` y timeout de 8 segundos. Sin reintentos en el proceso: si falla, el cron
del día siguiente y el `backfill` resuelven.

## 4. `scripts/fetch-fx.ts`

CLI que corre el cron.

- `--day=YYYY-MM-DD` (default: hoy en `DASHBOARD_TZ`).
- `--force`: pisa la fila del día incluso si existe (salvo `manual`).
- Lee `settings.fx_source`.
- Guarda, imprime una línea (`2026-08-11 ARS→EUR 0.000578 (dolarapi, 1 EUR = 1728.65 ARS)`), y al
  final llama al backfill de §5 para las ventas que estaban esperando esta cotización.
- Exit 0 si guardó, 1 si no pudo con ninguna de las dos fuentes. El código de salida es lo que hace
  que el cron avise.

## 5. `scripts/backfill-fx.ts`

Completa las ventas sin conversión o con conversión provisoria:

```sql
SELECT id, amount, currency, day FROM orders
WHERE currency <> 'EUR' AND (amount_eur IS NULL OR fx_stale = true)
ORDER BY day
```

Para cada una, `toEur(amount, currency, day)` (de `lib/fx.ts`). Si ahora existe la cotización exacta
del día, actualiza `amount_eur`, `fx_rate`, `fx_day` y pone `fx_stale = false`. Si sigue sin haberla,
la deja como está y la cuenta en el resumen final.

- `--limit=N` (default 5000) para no barrer 3 años de una.
- `--dry-run` que imprime lo que haría sin escribir. **Implementalo**: es un script que toca montos
  de ventas y hay que poder mirarlo antes.
- Imprime: cuántas actualizó, cuántas siguen stale, y el rango de días afectado.

## 6. Cron (el archivo, no la instalación)

Los artefactos de deploy los escribe T12, pero dejá documentado en el README de tu propio archivo (o
en un comentario arriba de `fetch-fx.ts`) qué línea de cron hace falta:

```cron
# Cotización ARS→EUR, todos los días a las 03:10 hora de Argentina
10 3 * * * cd /srv/panel/current && /usr/bin/node scripts/fetch-fx.js >> /var/log/panel/fx.log 2>&1
```

03:10 y no medianoche: `dolarapi` publica el valor del día hábil y a las 00:00 todavía puede tener el
de ayer. Además el día ya cerró en ART, así que la cotización se asocia al día correcto.

## 7. Tests

Puros, con `fetch` mockeado (`vi.stubGlobal('fetch', …)`). Sin red en los tests.

1. respuesta válida de `dolarapi` → `rate = 1/venta`, redondeo a 10 decimales;
2. `dolarapi` tira 500 → cae en `er-api` y **no invierte** el valor;
3. las dos fuentes fallan → `fetchRate` tira, el script sale 1;
4. `venta = 0` → `assertPlausible` tira;
5. `venta = 1.5` (coma corrida) → `assertPlausible` tira;
6. respuesta con `venta` como string `"1728.6485"` → se parsea o tira, pero **no** produce `NaN`
   silencioso;
7. existe fila `manual` del día → `saveRate` no la pisa;
8. coherencia entre fuentes: con los dos payloads de ejemplo del §2, los dos `rate` calculados
   difieren < 5%.

## 8. Verificación

```bash
cd ~/Desktop/funnel/dashboard-admin
npx tsc --noEmit && npm test

# 1 — trae la cotización de verdad
npm run fx:fetch
docker compose exec db psql -U panel -d panel -c \
  "SELECT day, base, quote, rate, source, 1/rate AS ars_por_eur FROM fx_rates ORDER BY day DESC LIMIT 3;"
# ars_por_eur tiene que dar un número creíble (orden de 1.700 en agosto 2026)

# 2 — idempotente
npm run fx:fetch      # segunda corrida, no duplica: la PK es (day, base, quote)

# 3 — respeta lo manual
docker compose exec db psql -U panel -d panel -c \
  "INSERT INTO fx_rates (day, base, quote, rate, source) VALUES (CURRENT_DATE,'ARS','EUR',0.0009,'manual')
   ON CONFLICT (day,base,quote) DO UPDATE SET rate=0.0009, source='manual';"
npm run fx:fetch
docker compose exec db psql -U panel -d panel -tAc \
  "SELECT source, rate FROM fx_rates WHERE day=CURRENT_DATE;"
# tiene que seguir diciendo manual | 0.0009000000

# 4 — backfill en seco
npm run fx:backfill -- --dry-run
```

## 9. Cuándo parar

Si `settings.fx_source` no es `'oficial'`: **pará** y anotá en §10 del plan (es P-01). No implementes
la conversión vía blue con dos saltos de moneda por tu cuenta: el resultado cambia todos los números
de ventas del panel y es una decisión del negocio, no del código.
