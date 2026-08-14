# T06 — Sección Embudo: el paso a paso, por funnel

- **Depende de:** T01 (schema, `lib/day.ts`, `lib/funnels.ts`), T05 (shell, `components/ui.tsx`).
- **Bloquea:** nada.
- **Paralelizable con:** T07, T08, T09, T10, T11.
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos:** `app/(panel)/embudo/**`, `lib/queries/funnel.ts`, `lib/queries/funnel.test.ts`,
  `app/api/data/funnel/route.ts`. **Nada más.**

Decisiones que gobiernan este task: **D3** (se mide por sesión única) y **D4** (el 100% es el paso 0,
con toggle al paso 1).

Esta es la pantalla que reemplaza al `/admin/funnel` de cada funnel. **Leé
`~/Desktop/funnel/testfunnel/app/admin/funnel/FunnelView.tsx` antes de empezar**, sobre todo las
líneas 203-244: ahí está la matemática que el usuario quiere conservar y la lógica del "peor paso".
Lo que cambia es de dónde salen los números; lo que se ve tiene que resultarle familiar.

---

## 1. Lo que esta pantalla tiene que responder

De cada funnel, por separado, en el rango elegido:

1. cuántas sesiones entraron;
2. qué porcentaje llegó a **cada paso**, con el nombre real de la pregunta;
3. dónde está la peor caída;
4. cuántos llegaron a la venta, cuántos clickearon comprar y cuántos compraron;
5. lo mismo filtrado por campaña y por variante (`ar` / `latam`).

Esta pantalla **no muestra plata**. Las ventas son T07. Acá "Compraron" es un conteo y una tasa de
conversión, nada más. El usuario pidió explícitamente que embudo y ventas fueran secciones aparte.

## 2. `lib/queries/funnel.ts`

```ts
export type FunnelFilters = {
  funnelId: number;
  from: string;            // 'YYYY-MM-DD' en la TZ del funnel
  to: string;
  variant?: string;        // undefined = todas
  utmCampaign?: string;
  utmSource?: string;
  country?: string;
};

export type FunnelStepRow = {
  stepIndex: number; slug: string; label: string; kind: string;
  sessions: number;        // sesiones que llegaron a este paso o más allá
  pctOfBase: number;       // vs el paso base (0 o 1)
  pctOfPrevious: number;   // vs el paso anterior
  dropFromPrevious: number;
};

export type FunnelData = {
  totalSessions: number;
  quizStarted: number;     // max_step_index >= 1
  salesViews: number;
  checkoutClicks: number;
  purchases: number;
  steps: FunnelStepRow[];
  campaigns: { campaign: string; sessions: number; purchases: number }[];
  variants:  { variant: string; sessions: number; purchases: number }[];
  countries: { country: string; sessions: number }[];
  devices:   { device: string; sessions: number }[];
  generatedAt: string;
};

export async function getFunnelData(f: FunnelFilters): Promise<FunnelData>;
```

**La consulta central son dos queries, no veintisiete.** El error a evitar es hacer un `count` por
paso: con 27 pasos son 27 escaneos de la misma tabla.

```sql
-- 1) histograma del paso máximo alcanzado
SELECT max_step_index, count(*)::int AS n
FROM sessions
WHERE funnel_id = $1 AND day BETWEEN $2 AND $3
  AND ($4::text IS NULL OR variant      = $4)
  AND ($5::text IS NULL OR utm_campaign = $5)
  AND ($6::text IS NULL OR utm_source   = $6)
  AND ($7::text IS NULL OR country      = $7)
GROUP BY 1;

-- 2) totales y hitos, de una sola pasada
SELECT count(*)::int                                                     AS total,
       count(*) FILTER (WHERE max_step_index >= 1)::int                   AS quiz_started,
       count(*) FILTER (WHERE sales_view_at     IS NOT NULL)::int         AS sales_views,
       count(*) FILTER (WHERE checkout_click_at IS NOT NULL)::int         AS checkout_clicks,
       count(*) FILTER (WHERE purchased_at      IS NOT NULL)::int         AS purchases
FROM sessions
WHERE /* mismos filtros */;
```

Después, en TypeScript: `sessions` de un paso N = **suma acumulada inversa** del histograma
(`Σ n` donde `max_step_index >= N`). Es exacto porque los dos quizzes son estrictamente lineales
(D3), y esa suposición está anotada en el plan.

El patrón `($4::text IS NULL OR col = $4)` permite un solo SQL para todas las combinaciones de
filtro. **Los valores siempre van como parámetros**; nada de armar el `WHERE` concatenando strings.

Los breakdowns (campañas, variantes, países, dispositivos) son un `GROUP BY` cada uno sobre la misma
`WHERE`. Cuatro queries más, todas indexadas. Corré las seis en paralelo con `Promise.all`.

Ordená campañas por sesiones descendente y cortá en 20, con una fila `'(otras)'` que sume el resto:
sin eso, una cuenta con 300 campañas hace una tabla ilegible.

## 3. El cálculo de porcentajes — igual que el panel viejo

```ts
const baseIndex = baseMode === 'landing' ? 0 : 1;
const baseRef   = (stepSessions[baseIndex] ?? totalSessions) || 1;   // el || 1 evita dividir por cero
// para cada paso desde baseIndex:
pctOfBase       = step.sessions / baseRef * 100;
pctOfPrevious   = prev > 0 ? step.sessions / prev * 100 : 0;
dropFromPrevious = prev > 0 ? 100 - pctOfPrevious : 0;
```

Los tres hitos (`Llegaron a la venta`, `Clickearon comprar`, `Compraron`) se agregan como filas al
final de la lista, con el mismo `baseRef`. Son parte del embudo aunque no sean pasos del quiz.

**El peor paso** es el de mayor `dropFromPrevious` entre pasos consecutivos, excluyendo el base. Se
marca con `highlight` en el `BarRow` **y** con un texto ("mayor caída"), nunca solo con color.

## 4. `app/api/data/funnel/route.ts`

`GET` con query params: `f` (slug del funnel), `range` (preset) o `from`+`to`, `variant`, `campaign`,
`source`, `country`, `base` (`landing` | `start`).

- Guard de auth con `isAuthenticated(req.cookies)` → 401. **Todos** los endpoints de `/api/data/*`
  llevan guard; es el único lugar del proyecto donde salen datos de negocio hacia el browser.
- Resuelve el rango con `resolveRange(preset, funnel.timezone)` — la TZ es **la del funnel**, no la
  del dashboard (D19).
- `dynamic = 'force-dynamic'`, `Cache-Control: no-store`.
- Si el slug no existe → 404 `{ ok: false, error: 'unknown_funnel' }`.

## 5. La pantalla

`app/(panel)/embudo/page.tsx` (server component) resuelve el funnel del query string, hace el fetch
inicial en el server y le pasa los datos a un client component `EmbudoView.tsx` que maneja los
filtros locales sin recargar.

Estructura, de arriba abajo:

1. **Cuatro `StatCard`**: Sesiones, Empezaron el quiz (con el % sobre sesiones), Llegaron a la venta,
   Compraron (con la tasa sesión→compra).
2. **El toggle de base**, con el texto que el usuario ya conoce:
   `% de personas que llegan a cada paso, medido desde <la landing (entrada) | el inicio del quiz (1ª pregunta)>`.
   Al lado, el dato de landing→inicio como número suelto: es la caída más grande de todo el embudo y
   merece estar visible.
3. **La lista de pasos**, un `BarRow` por paso, con: label real (de `funnel_steps.label`), barra,
   porcentaje sobre la base, conteo, y el delta contra el paso anterior. Los pasos con
   `kind = 'content'` (nota viral, diagnóstico, loading) se muestran con un matiz visual distinto:
   no son preguntas y la caída ahí significa otra cosa.
4. **Filtros**: variante (solo si el funnel declara más de una en `funnels.variants`), campaña,
   país, dispositivo. Cada uno recorta el embudo completo.
5. **Tabla de campañas**: campaña, sesiones, compras, conversión. Ordenable por cualquier columna.
6. **Warnings**: si hay filas recientes en `ingest_errors` para este funnel, un `Banner` de tono
   `warn` que diga cuántas y de qué tipo, con link a `/config`. Es la contracara de D20: los datos
   raros se registran **y se muestran**, no se esconden.

Estado vacío: si `totalSessions === 0`, un `EmptyState` que diga que no hay datos en el rango y
recuerde que el embudo arranca de cero el día del deploy (D15) — sin eso, el usuario va a pensar que
algo está roto cuando mire un rango anterior a la migración.

## 6. Tests

`lib/queries/funnel.test.ts`, con la base (skip si no hay `DATABASE_URL`):

1. seedeá 100 sesiones con `max_step_index` repartido y verificá que la suma acumulada inversa es
   exacta en el paso 0, en uno del medio y en el último;
2. `pctOfBase` con `baseMode='landing'` da 100% en el paso 0;
3. `pctOfBase` con `baseMode='start'` da 100% en el paso 1 y el paso 0 no se lista;
4. cero sesiones → todo en 0 y **no** hay división por cero ni `NaN` en el JSON;
5. filtro por campaña → los totales bajan y siguen siendo coherentes (ningún paso mayor que el
   anterior);
6. el peor paso es el de mayor caída, verificado con un histograma armado a mano;
7. una sesión con `max_step_index = 5` cuenta en los pasos 0 a 5 y **no** en el 6;
8. sesiones de **otro** funnel en el mismo rango no contaminan el resultado.

El 8 no es paranoia: es el bug que aparece cuando alguien olvida el `funnel_id` en un `WHERE`, y con
dos funnels en la misma tabla los números quedan verosímiles pero mal.

## 7. Verificación

```bash
cd ~/Desktop/funnel/dashboard-admin
npx tsc --noEmit && npm run build && npm test

# datos de prueba: 3 sesiones que llegan a distinta profundidad
KEY=$(openssl rand -hex 32); npm run db:ingest-key chauhinchazon "$KEY"
for depth in 0 3 21; do
  SID=$(uuidgen | tr 'A-Z' 'a-z'); VID=$(uuidgen | tr 'A-Z' 'a-z')
  EV=$(python3 - "$depth" <<'PY'
import json,sys,datetime
d=int(sys.argv[1]); now=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')
print(json.dumps([{"name":"step_view","at":now,"stepIndex":i,"stepSlug":"x"} for i in range(d+1)]))
PY
)
  curl -sS -X POST http://127.0.0.1:3005/api/ingest -H "Authorization: Bearer $KEY" \
    -H 'Content-Type: application/json' \
    -d "{\"sessionId\":\"$SID\",\"visitorId\":\"$VID\",\"variant\":\"ar\",\"events\":$EV}" > /dev/null
done

curl -sS 'http://127.0.0.1:3005/api/data/funnel?f=chauhinchazon&range=today' \
  -b "panel_token=$(cat /tmp/panel_token)" | python3 -m json.tool | head -40
# esperado: totalSessions 3 · paso 0 = 3 (100%) · paso 3 = 2 · paso 21 = 1
```

Y a ojo: `/embudo` con los dos funnels seleccionados uno tras otro muestra **22 filas** para
chauhinchazon y **27** para reset, con los nombres de sus propias preguntas. Ese es el criterio de que
el catálogo por funnel funcionó.

## 8. Cuándo parar

Si te hace falta un dato que `sessions` no tiene (por ejemplo el tiempo entre pasos, o la respuesta
elegida en cada pregunta), **no lo agregues al schema**: va a §10 del plan. Las respuestas del quiz no
están en este modelo a propósito; viven en Supabase y son otra pregunta.
