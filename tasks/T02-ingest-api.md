# T02 — Ingest API: `POST /api/ingest`

- **Depende de:** T01 (schema, `lib/db.ts`, `lib/funnels.ts`, `lib/types.ts`).
- **Bloquea:** nada directamente, pero sin esto el embudo no tiene datos.
- **Paralelizable con:** T03, T04, T05, T10, T11.
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos:** `app/api/ingest/route.ts`, `lib/ingest/*`, `lib/ingest/*.test.ts`. **Nada más.**

El contrato está congelado en **§4 del plan** y el vocabulario de eventos en **§6**. No los cambies:
T10 y T11 se están escribiendo en paralelo contra esa especificación exacta.

---

## 1. Objetivo

Un endpoint que recibe lotes de eventos de cualquier funnel, autenticado con una key por funnel, y
que mantiene `sessions` como agregado exacto y `events` como log crudo. Tiene que ser imposible que
un dato raro tumbe el endpoint o desaparezca sin dejar rastro.

## 2. Estructura

```
app/api/ingest/route.ts      handler HTTP: auth, límites, respuesta. Delgado.
lib/ingest/schema.ts         el schema de zod del payload (§4 del plan)
lib/ingest/apply.ts          la lógica: upsert de sessions + insert de events, en una transacción
lib/ingest/device.ts         user-agent → 'mobile' | 'desktop' | 'tablet' | 'unknown'
lib/ingest/apply.test.ts     tests de la lógica
lib/ingest/device.test.ts    tests del parser
```

`route.ts` no tiene lógica de negocio: valida, delega, responde. Todo lo testeable vive en `lib/`.

## 3. `route.ts`

`export const runtime = 'nodejs'` y `export const dynamic = 'force-dynamic'`.

Orden de las verificaciones, y **este orden importa** porque cada una es más caro que la anterior:

1. **Tamaño.** Leé el body como texto y cortá con 413 si pasa 64 KB. Antes de parsear: un JSON de
   10 MB no se parsea para después rechazarlo.
2. **Bearer.** `Authorization: Bearer <key>`. Sin header o mal formado → 401.
   `getFunnelByIngestKey(key)` → si es `null`, 401 y una fila en `ingest_errors` con
   `reason='unauthorized'` y **sin el payload** (podría traer basura de un atacante) ni la key.
   Compará el hash con `crypto.timingSafeEqual`, no con `===`: el `===` de strings sale temprano en
   el primer byte distinto y filtra información por tiempo. Como `getFunnelByIngestKey` busca por
   igualdad en SQL, la comparación timing-safe va sobre el hash ya recuperado, contra el hash
   calculado.
3. **JSON.** Parseo con try/catch → 400 `invalid_payload`.
4. **Schema** (zod, §4). Si falla → 400 con el `detail` del primer issue, y fila en `ingest_errors`
   con `reason='invalid_payload'` **y** el payload (acá sí: viene de un funnel autenticado, es
   nuestro bug).
5. **Cantidad.** Más de 50 eventos → 413.
6. `applyBatch(funnel, payload)` → responde 200 con `{ ok, accepted, warnings }`.

Cualquier excepción no prevista: `console.error`, fila en `ingest_errors` con `reason='error'`, y
respuesta **200** `{ ok: false, error: 'internal' }`. Un 500 hacia el funnel no arregla nada y
ensucia sus logs; el error tiene que quedar en la base, que es donde se mira.

## 4. `lib/ingest/schema.ts`

Zod, exactamente el §4 del plan. Detalles que no se pueden aflojar:

- `sessionId` y `visitorId`: `z.string().uuid()`. **Obligatorios.** Si un funnel manda basura acá, la
  PK de `sessions` se llena de porquería y el embudo miente. Que falle fuerte.
- `events`: `z.array(eventSchema).min(1).max(50)`.
- `at`: `z.string().datetime()` y se convierte a `Date`. Rechazá fechas más de 24 h en el futuro o
  más de 30 días en el pasado (un reloj mal puesto en el cliente puede meter eventos en 2035 y
  romper la partición): fuera de rango se **clampea a `now()`** y se suma un warning
  `clamped_at`, no se descarta el evento.
- `stepIndex`: `z.number().int().min(0).max(200)`.
- `variant`: `z.string().max(32)`, default `'default'`.
- `props`: `z.record(z.unknown())`, con un tope de 4 KB serializado.
- `context.utms`: solo las 6 claves conocidas (`utm_source`, `utm_medium`, `utm_campaign`,
  `utm_content`, `utm_term`, `fbclid`); cualquier otra se ignora en silencio.
- `context.country`: `z.string().length(2)`, se guarda en mayúsculas.

Los valores de UTM se normalizan con la misma regla que ya usan los funnels
(`testfunnel/lib/utm.ts:cleanUtmValue`): decodificar `%XX` y `+`, colapsar espacios, trim, y si queda
vacío → `'(directo)'`. **Leé ese archivo y replicá la función**; no la reinventes, porque si el
dashboard normaliza distinto que el checkout, la campaña de una sesión y la de su venta no van a
matchear y la atribución se parte.

## 5. `lib/ingest/apply.ts`

La única función que escribe. Firma:

```ts
export async function applyBatch(
  funnel: Funnel,
  payload: IngestPayload,
): Promise<{ accepted: number; warnings: string[] }>;
```

Pasos, todo dentro de un `tx()`:

**a) Derivar el estado de la sesión desde el lote.** Recorré los eventos una vez y armá:
`minAt`, `maxAt`, `maxStepIndex`, y el primer `at` de cada hito según la tabla del §6 del plan.
Un lote puede traer eventos desordenados: no asumas orden.

**b) Resolver el día.** `day = (minAt AT TIME ZONE funnel.timezone)::date`, calculado en SQL:

```sql
SELECT ($1::timestamptz AT TIME ZONE $2)::date AS day
```

No lo calcules en JS.

**c) Upsert de `sessions`** con el `INSERT … ON CONFLICT (id) DO UPDATE` **literal del §3.3 del
plan**. Está escrito ahí entero por una razón: la semántica de `LEAST`/`GREATEST` con NULL y el
`CASE` de la atribución son sutiles y ya están resueltos.

Un detalle que no está en el SQL y sí importa: si la sesión ya existe con **otro `funnel_id`**
(colisión de uuid o un funnel mal configurado), **no la sobrescribas**. Anotá
`reason='session_funnel_mismatch'` en `ingest_errors`, sumá el warning, y seguí insertando los
eventos (que llevan su propio `funnel_id`). Pisar el funnel de una sesión existente movería números
de dos funnels a la vez.

**d) Validar los pasos contra el catálogo.** Traé `listSteps(funnel.id)` una vez.
Para cada `step_view`:

- si `stepIndex` existe en el catálogo y el `stepSlug` coincide → normal;
- si existe pero el slug **no** coincide → warning `step_slug_mismatch:<idx>:<slug>` y fila en
  `ingest_errors`. **Se guarda igual**, usando el `stepIndex`, que es lo que mide el embudo. Este
  caso significa que alguien cambió el orden de las preguntas y no actualizó el catálogo: tiene que
  gritar, no fallar;
- si el `stepIndex` no existe en el catálogo → warning `unknown_step:<idx>`, fila en
  `ingest_errors`, y **se guarda igual**.

**e) Insertar en `events`.** Un solo `INSERT` con múltiples `VALUES` (no un insert por evento en un
loop: son hasta 50 round-trips por request). `day` de cada evento se calcula con su propio `at` en la
TZ del funnel. `name` desconocido → se guarda tal cual y suma warning `unknown_event:<name>`.

**f) `accepted`** = cantidad de eventos insertados en `events` (siempre igual al largo del array, por
D20).

**Idempotencia.** Reenviar el mismo lote no puede mover un solo número de `sessions`: `GREATEST` y
`LEAST` son idempotentes y `day`/`variant` no se actualizan. Escribí un test que corra `applyBatch`
dos veces con el mismo payload y afirme que la fila de `sessions` queda **byte por byte igual**.
En `events` sí se duplica, y eso es correcto: es el log crudo.

## 6. `lib/ingest/device.ts`

Parser mínimo de user-agent. No agregues una dependencia para esto:

- `/iPad|Tablet|PlayBook|Silk/i` → `tablet`
- `/Mobi|Android|iPhone|iPod|Windows Phone/i` → `mobile`
- string no vacío → `desktop`
- vacío o ausente → `unknown`

El orden importa: un iPad manda `Mobile` en su UA, así que tablet se evalúa primero. Test con 8 UAs
reales, incluido uno de iPad y uno de iPhone.

## 7. Tests (`vitest`, `environment: 'node'`)

Necesitan Postgres. Si no hay `DATABASE_URL`, los de integración se saltan con `it.skip` en lugar de
fallar (así el build de CI no depende de la base). Los de `device.ts` y del schema son puros y corren
siempre.

Casos que tienen que estar:

1. lote nuevo → crea la sesión con `day` correcto y `max_step_index` = el mayor del lote;
2. el mismo lote dos veces → `sessions` idéntica (idempotencia);
3. lote con eventos desordenados → `started_at` es el mínimo y `last_seen_at` el máximo;
4. segundo lote con `max_step_index` **menor** → no baja el valor guardado;
5. sesión que llega primero sin UTMs y después con UTMs → la atribución se completa;
6. sesión que llega primero **con** UTMs y después con otras → **no** se sobrescribe;
7. `step_view` con `stepIndex` fuera del catálogo → 200, warning, fila en `ingest_errors`, evento
   guardado;
8. `at` en el año 2035 → se clampea a now, warning `clamped_at`, evento guardado;
9. key inválida → 401 y `sessions` sin filas nuevas;
10. body de 100 KB → 413 sin parsear.

## 8. Verificación

```bash
cd ~/Desktop/funnel/dashboard-admin
npx tsc --noEmit && npm run build && npm test

# key de prueba
KEY=$(openssl rand -hex 32)
npm run db:ingest-key chauhinchazon "$KEY"
npm run dev &   # o next start

SID=$(uuidgen | tr 'A-Z' 'a-z'); VID=$(uuidgen | tr 'A-Z' 'a-z')

# 1 — lote válido
curl -sS -X POST http://127.0.0.1:3005/api/ingest \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$SID\",\"visitorId\":\"$VID\",\"variant\":\"ar\",
       \"events\":[
         {\"name\":\"step_view\",\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"stepIndex\":0,\"stepSlug\":\"landing_hook\"},
         {\"name\":\"step_view\",\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"stepIndex\":3,\"stepSlug\":\"donde_acumula\"}],
       \"context\":{\"utms\":{\"utm_campaign\":\"test-t02\"},\"country\":\"AR\",\"path\":\"/quiz\"}}"
# esperado: {"ok":true,"accepted":2,"warnings":[]}

# 2 — el mismo comando otra vez → sessions no se mueve
docker compose exec db psql -U panel -d panel -c \
  "SELECT id, max_step_index, utm_campaign, day, country FROM sessions WHERE id='$SID';"

# 3 — key inválida
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3005/api/ingest \
  -H "Authorization: Bearer nope" -H 'Content-Type: application/json' -d '{}'
# esperado: 401

# 4 — paso desconocido: 200 con warning y fila en ingest_errors
curl -sS -X POST http://127.0.0.1:3005/api/ingest \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$SID\",\"visitorId\":\"$VID\",
       \"events\":[{\"name\":\"step_view\",\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"stepIndex\":99,\"stepSlug\":\"chirimbolo\"}]}"
docker compose exec db psql -U panel -d panel -c \
  "SELECT reason, detail FROM ingest_errors ORDER BY id DESC LIMIT 3;"
```

## 9. Cuándo parar

Si el §4 del plan te parece insuficiente para un caso real (por ejemplo: un funnel que necesita
mandar un hito que no está en el §6), **no extiendas el contrato**: anotalo en §10 del plan. T10 y
T11 están escribiendo el cliente contra esa especificación al mismo tiempo que vos; un cambio
unilateral rompe el otro lado sin que nadie se entere hasta el deploy.
