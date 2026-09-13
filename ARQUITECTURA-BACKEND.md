# Arquitectura del backend — Panel

Documento de referencia técnica de cómo funciona el backend: webhooks, ingest,
auth, rutas de API, motor de anuncios, base de datos y cron jobs. Escrito
leyendo el código fuente directamente (no es un resumen del README).

No reemplaza a:
- **`docs/runbook.md`** / **`docs/runbook-anuncios.md`** — qué comando correr
  cuando algo se rompe a las 2 de la mañana.
- **`.kiro/steering/instancias.md`** — por qué dos paneles distintos deployan
  de este mismo repo, y qué va por env var.
- **`registro.md`** — por qué se tomó cada decisión, y qué se descartó.
- Los `tasks/*/00-PLAN-*.md` — arquitectura de cada módulo en detalle
  (Finanzas, Saldo de cuentas, Usuarios y Tareas). El `tasks/00-PLAN.md` que
  menciona el README **no existe en el árbol actual** — no se encontró con
  una búsqueda exhaustiva; puede haberse dividido en los planes por módulo
  que sí existen.

Convención de este documento: cada afirmación no trivial cita `archivo:línea`
del código real. Donde no se pudo verificar algo leyendo el código, se dice
explícitamente en vez de inferir.

---

## 1. Mapa de entrada al sistema

Hay exactamente **tres puertas** por las que entra tráfico no autenticado con
cookie de sesión, y el middleware las deja pasar sin tocarlas:

```
middleware.ts:189 → matcher excluye /api/ingest, /api/webhooks, _next/*, favicon.ico, icon.svg
```

| Puerta | Quién le pega | Autenticación | Implementada |
|---|---|---|---|
| `POST /api/ingest` | Los funnels (testfunnel, reset-app) | Bearer key por funnel | Sí |
| `POST /api/webhooks/shopify` | Shopify | Firma HMAC-SHA256 sobre el body crudo | Sí |
| `POST /api/webhooks/hotmart` | Hotmart | — | **No.** Solo existe como entrada `'publica'` en `lib/permisos.ts:325` y como ruta declarada-pero-pendiente en `app/api/rutas-mapeadas.test.ts:66`. No hay `app/api/webhooks/hotmart/route.ts` en el árbol (confirmado: `glob **/hotmart*` no devuelve archivos). Es un módulo planeado, no código muerto ni bug. |

Todo lo demás bajo `/api/**` pasa por el middleware (cookie `panel_token`) y
después por `guardSeccion()` de `lib/permisos.ts`, que decide el permiso fino
por sección.

---

## 2. El webhook de Shopify — `POST /api/webhooks/shopify`

Es la fuente de verdad de las ventas del panel. Archivo: `app/api/webhooks/shopify/route.ts`.

### 2.1 Verificación de firma

La firma se calcula **sobre los bytes crudos del body**, nunca sobre el JSON
reparseado — parsear y reserializar cambia el HMAC
(`app/api/webhooks/shopify/route.ts:15-16`, `lib/orders/verify.ts:6-9`).

```
raw = await req.text()          // bytes exactos, ANTES de cualquier JSON.parse
hmac = header 'x-shopify-hmac-sha256'
```

`lib/orders/verify.ts:37-58` (`verifySignatureWithSecrets`): HMAC-SHA256 en
base64 contra cada secret de `SHOPIFY_WEBHOOK_SECRETS` (lista separada por
coma — multi-tienda, una entrada por funnel, `lib/orders/verify.ts:18-24`).
Comparación con `timingSafeEqual`, con chequeo de longitud **antes** porque
`timingSafeEqual` tira si los buffers difieren en tamaño
(`lib/orders/verify.ts:46-49`).

Tres resultados posibles (`HmacVerdict`, `lib/orders/verify.ts:14`):

- `'unconfigured'` — no hay ningún secret cargado. Se **rechaza igual** (a
  diferencia de los funnels, que sí tienen modo permisivo):
  `app/api/webhooks/shopify/route.ts:83-92`. No es un ataque, es una tienda
  sin configurar — se loguea distinto (`error: 'secrets_not_configured'`).
- `'invalid'` — hay secrets pero ninguno matchea la firma recibida:
  `app/api/webhooks/shopify/route.ts:93-101`. Síntoma típico: el secret de
  esa tienda no está en la lista → las ventas de esa tienda no aparecen.
- `'valid'` — a partir de acá la respuesta es **siempre 200**, pase lo que
  pase después. Un 5xx hace que Shopify reintente el mismo pedido por horas;
  el error tiene que quedar registrado, no propagarse
  (`app/api/webhooks/shopify/route.ts:22-23`).

### 2.2 Topics manejados

`app/api/webhooks/shopify/route.ts:134-172` (switch sobre `x-shopify-topic`):

| Topic | Qué hace |
|---|---|
| `orders/paid` | `handleApproved()` — siempre se procesa como compra |
| `orders/create` | Solo si `financial_status === 'paid'`; si no, se registra `ignored/not_paid` y no se toca `orders`. Existe porque una orden pendiente que se paga después llega de nuevo como `orders/paid` |
| `refunds/create` | `handleRefund(refund.order_id, ...)` — el `order_id` está en `refund.order_id`, **no** en `refund.id`. Confundirlos es "el bug de este handler" según el propio comentario (`route.ts:159-161`) |
| `orders/cancelled` | `handleRefund(order.id, ...)` |
| Cualquier otro | `status: 'ignored'`, 200, para que Shopify no reintente indefinidamente |

### 2.3 Procesamiento de una orden aprobada (`upsertOrder`)

`lib/orders/upsert.ts`. Todo el flujo, en orden:

1. **Resolución de line items** y su `productId`/`price`/`quantity`
   (`lib/orders/upsert.ts:36-45`).
2. **Tier principal**: el ítem de mayor `amount`; empate → mayor `quantity`;
   sigue empatado → el primero del array (`lib/orders/upsert.ts:53-71`, D11).
3. **Atribución completa** (`resolveAttribution`): `note_attributes` →
   `landing_site` → `fbclid` → herencia por email si nada de lo anterior dio
   resultado. La herencia por email consulta `orders` existentes, así que
   corre **fuera** de la transacción de escritura de esta orden
   (`lib/orders/upsert.ts:100-104`).
4. **Resolución de funnel** (`resolveFunnel`): por atribución, luego por
   `shop_domain`, luego por productos mapeados. Una venta **nunca se
   descarta**: si no resuelve a ningún funnel, `funnelId` queda `null` y la
   venta aparece en el cajón "Ventas sin atribuir" — es un resultado válido,
   no un error (`lib/orders/upsert.ts:107-111`, D10).
5. **Día local**: resuelto en SQL con la TZ del funnel (o la del dashboard si
   no hay funnel), nunca con aritmética de fechas en JS —
   `lib/day.ts` explica por qué eso corre un día distinto en horario de
   verano (`lib/orders/upsert.ts:113-122`).
6. **Conversión a moneda de reporte, congelada**: `toReportCurrency(amount,
   currency, day)` (`lib/fx.ts`). Si no hay cotización para ese día, la
   venta **no se rechaza**: queda `amount_eur = NULL`, `fx_stale = true`, y
   se completa después con backfill (`lib/orders/upsert.ts:124-127`, D12/D13).
7. **Comisión de pasarela** congelada con la cotización de **esta** orden,
   no la de hoy — si no, la comisión en moneda de reporte no cerraría contra
   su bruto (`lib/orders/upsert.ts:135-144`).
8. **Costo por producto** congelado con el mismo criterio: cambiar el costo
   mañana no reescribe una venta de la semana pasada
   (`lib/orders/upsert.ts:146-151`).
9. **Escritura transaccional** (`tx()`, `lib/orders/upsert.ts:153-234`):
   `INSERT INTO orders ... ON CONFLICT (source, external_id) DO NOTHING`. Si
   `rowCount === 0`, es un reenvío (Shopify manda `orders/create` **y**
   `orders/paid` de la misma compra, y reintenta lo que falle) — no se toca
   nada de la fila existente, el caller lo marca `duplicate`
   (`lib/orders/upsert.ts:194-198`).
   - `order_items` en un solo `INSERT` multi-row, misma transacción.
   - Si había sesión de tracking asociada (`att.sid`), se linkea `session_id`
     en `orders` y se actualiza `sessions.purchased_at` — con el filtro
     `AND funnel_id = $3` para que un `sid` cruzado no le marque la compra a
     la sesión de otro funnel (`lib/orders/upsert.ts:220-229`).

### 2.4 Auditoría — `webhook_events`

Cada entrega deja una fila (`logWebhookEvent`,
`app/api/webhooks/shopify/route.ts:44-61`), incluso si el insert falla (el
error se traga con `console.error`, nunca tumba el webhook). Es la tabla que
se mira en el runbook para diagnosticar "una venta no aparece"
(`docs/runbook.md`, sección 4).

Estados posibles: `ok`, `duplicate`, `unmatched_funnel`, `ignored`,
`bad_signature`, `error`.

---

## 3. El ingest de tracking — `POST /api/ingest`

Archivo: `app/api/ingest/route.ts`. Es el endpoint al que los funnels
(testfunnel, reset-app) mandan eventos de navegación (`step_view`,
`sales_view`, `purchase`, etc.) para armar el embudo.

### 3.1 Orden de validación (en este orden exacto, y el orden importa)

1. **Tamaño**, antes de parsear: `Content-Length` declarado y tamaño real del
   buffer, tope `64 KB` (`app/api/ingest/route.ts:16, 38-46`). Un JSON de
   10 MB no se parsea para después rechazarlo.
2. **Bearer token**. Sin header o mal formado → `401` sin dejar fila en
   `ingest_errors` (no hay ni funnel identificado para anotar,
   `app/api/ingest/route.ts:49-55`).
3. **Lookup del funnel** por `getFunnelByIngestKey(key)` — cacheado 60s en
   memoria, incluyendo el caso `null` (`lib/funnels.ts`, según lo reportado
   por el sub-agente que lo leyó completo).
4. **Verificación timing-safe del hash**: el hash SHA-256 de la key
   presentada se compara con `timingSafeEqual` contra el hash guardado en
   `funnels.ingest_key_hash`, ambos en hex (`app/api/ingest/route.ts:70-78`).
   La comparación por igualdad SQL del paso 3 ya filtró, pero esta segunda
   comparación es la que realmente importa contra timing attacks.
5. **JSON válido** → si no, `400 invalid_payload` (`route.ts:82-88`).
6. **Cantidad de eventos ≤ 50**, chequeado **antes** del schema de zod: si
   zod rechazara primero por `.max(50)`, el funnel vería `400
   invalid_payload` en vez del `413 too_large` que dicta el contrato
   (`app/api/ingest/route.ts:91-95`).
7. **Schema de zod** (`parseIngestPayload`, `lib/ingest/schema.ts`) — recién
   acá, si falla, el payload completo se guarda en `ingest_errors` (es un bug
   de un funnel ya autenticado, no basura de un atacante).

Cualquier excepción no controlada devuelve **200** con `{ok:false,
error:'internal'}`, nunca 5xx — el error queda en `ingest_errors`, un 500 no
arregla nada del lado del funnel (`app/api/ingest/route.ts:113-119`).

### 3.2 Qué valida el schema (`lib/ingest/schema.ts`)

- `sessionId`/`visitorId`: UUID.
- `variant`: string, máx 32, default `'default'`.
- `experiment`: opcional, máx 32, charset restringido
  (`^[A-Za-z0-9_\-\u00C0-\u024F]*$`) — es un token cerrado del funnel ('A'/'B'),
  no texto libre; el charset excluye el byte NUL que rompía el INSERT con
  `22021` en Postgres (`lib/ingest/schema.ts:69-76`).
- `events`: array de 1 a 50. Cada evento con `name`, `at` (ISO datetime),
  `stepIndex` opcional (0-200), `props` con tope de 4 KB serializados.
- `at` fuera de rango (más de 24h en el futuro o 30 días en el pasado) se
  **clampea** a `now()`, no se rechaza — un reloj mal puesto en el cliente no
  puede romper la partición mensual de `events` (`lib/ingest/schema.ts:38-40,
  124-131`).
- UTMs desconocidas (fuera de las 6 declaradas) se descartan en silencio por
  el propio `z.object()` de zod.
- Vacío en una UTM se normaliza al centinela `'(directo)'`
  (`lib/ingest/schema.ts:143-144`) — Postgres trata `NULL ≠ NULL`, así que un
  NULL nunca matchearía el `CASE` que decide si una UTM ya fue "ganada" por
  una sesión.

### 3.3 Aplicación del lote (`lib/ingest/apply.ts`)

Todo en una sola transacción (`applyBatch`):

- **Upsert de `sessions`** con `ON CONFLICT (id) DO UPDATE`, usando
  `LEAST`/`GREATEST` para que un lote que llega desordenado no pueda correr
  hacia atrás la hora de un hito ya registrado
  (`lib/ingest/apply.ts:73-93`). El `WHERE sessions.funnel_id = $2` en el DO
  UPDATE es la defensa: si la sesión ya existe con **otro** `funnel_id`, no
  se pisa (`session_funnel_mismatch`) — evita mezclar números de dos
  funnels distintos.
- Las UTMs solo se actualizan si la sesión existente todavía está en
  `'(directo)'` — la primera campaña real que llega "gana" y no se sobrescribe
  después.
- **Insert de `events`** en un solo `INSERT` multi-row (hasta 50 filas por
  request, para no hacer 50 round-trips).
- **`step_index` desconocido o `stepSlug` que no coincide con el catálogo**:
  se guarda igual, con un warning — "grita, no falla" (D20: nunca se
  descarta un evento).
- Cualquier problema detectado (`unknown_variant`, `unknown_experiment`,
  `unknown_event`, `unknown_step`, `step_slug_mismatch`,
  `session_funnel_mismatch`) deja una fila en `ingest_errors`, **en la misma
  transacción** que los eventos: si el batch se hace visible, sus avisos
  también se hacen visibles.

---

## 4. Autenticación del panel (usuarios humanos)

Dos capas que **tienen que firmar exactamente igual**, verificado en
`tasks/usuarios-y-tareas/_verificacion-sesion.mjs` (afirmación 7):

| Capa | Dónde corre | Qué valida | Archivo |
|---|---|---|---|
| Middleware | Edge (Web Crypto, sin `node:crypto`) | Firma + expiración únicamente. No puede leer permisos de la base (Edge no tiene acceso a Postgres desde aquí) | `middleware.ts` |
| `guardSeccion` | Node, en cada route de `/api/**` y cada layout | Firma + expiración + permiso de sección, leído de la base en cada request | `lib/permisos.ts:280-320` |

### 4.1 Formato del token

`panel_token` = `${usuarioId}.${ts}.${hmac}`. El HMAC se calcula sobre
`${usuarioId}.${ts}` **con el punto dentro del payload firmado** — sin eso,
`id=1,ts=23` y `id=12,ts=3` firmarían igual (`lib/auth.ts:132-145`, D2).
Secreto: `PANEL_SESSION_SECRET`, con default a `DASHBOARD_PASSWORD`
(`lib/auth.ts:88-101`) — es el patrón de default-al-valor-de-hilvanapp que
exige `.kiro/steering/instancias.md`.

TTL: 12 horas (`SESSION_TTL_SECONDS`, `lib/auth.ts:30`). Rotar el secreto de
firma invalida **todas** las sesiones activas — es la única palanca para
echar a alguien en el acto; no hay tabla de sesiones ni denylist.

### 4.2 Claves de usuario

Hasheadas con scrypt async (nunca `scryptSync`, que bloquearía el event loop
~30-99ms por login): formato `scrypt$<N>$<r>$<p>$<salt hex>$<derivada hex>`,
con los parámetros guardados en la fila para poder subir el costo sin
invalidar hashes viejos (`lib/auth.ts:160-181`).

### 4.3 Fallback D10

Con la tabla `usuarios` **vacía**, `DASHBOARD_PASSWORD` sigue valiendo como
sesión admin (`usuarioId=0`, `lib/permisos.ts` función `sesionFallback`). Es
lo que evita que un deploy deje a todos afuera entre migrar y correr el seed
de usuarios. Se apaga solo: en cuanto hay una fila en `usuarios`, este camino
deja de evaluarse.

### 4.4 Permisos por sección (`MAPA_API`)

`lib/permisos.ts:280-327`: mapa explícito y congelado de cada pathname de
`/api/**` a las secciones que lo habilitan (o `'admin'`, o `'publica'`). Una
ruta **no mapeada se niega por default** (falla cerrado). Hay un test
(`app/api/rutas-mapeadas.test.ts`) que recorre el árbol real de `app/api/**`
y **rompe el build** si aparece un `route.ts` nuevo sin entrada en el mapa —
así "me olvidé de mapear la ruta nueva" no puede convertirse en un 403
silencioso en producción.

---

## 5. Rutas de API — mapa completo

Todas bajo `/api/**` salvo ingest/webhooks pasan por `guardSeccion` (algunos
GET de catálogo quedan sin guard a propósito — ver tabla).

### 5.1 Lectura de datos (`/api/data/*`)

| Ruta | Sección | Nota |
|---|---|---|
| `GET /api/data/overview` | resumen | Cruza todos los funnels; llama `ensureFreshAdSpend` antes de leer, si no el gasto queda repintado viejo |
| `GET /api/data/funnel` | embudo | Rango resuelto en TZ del funnel |
| `GET /api/data/pitch` | embudo | Test A/B del upsell, prefijo `pitch_` en `sessions.experiment` |
| `GET /api/data/sales` | ventas | `f=__unattributed__` abre "ventas sin funnel" |
| `GET /api/data/leads` | leads | Fuente: Supabase por REST directo. Sin credenciales → `200 {configured:false}`, nunca error |
| `GET /api/data/ads` | anuncios | El más complejo: resuelve cuenta activa, refresca gasto/jerarquía solo si `forzar=1` |
| `GET /api/data/ads/historial` | anuncios | Paginación por cursor, no por offset |

### 5.2 Configuración (`/api/config/*`)

Todas escriben/leen tablas de catálogo. Ver detalle completo verificado en
`app/api/config/_lib.ts` (helpers: `guard`, `getSystemStatus`,
`listFxRates`, `getUnknownSteps`, etc.). Puntos no obvios:

- `funnels` POST: el funnel nuevo nace con `ingest_key_hash =
  'PENDING_SET_INGEST_KEY_...'` — queda inerte hasta que se le carga una key
  real desde `funnels/ingest-key` (POST, que muestra la key en claro **una
  sola vez** y nunca la vuelve a mostrar).
- `products` upsert (`upsertAndReResolve`): re-resuelve `order_items` y
  `orders` existentes en la misma transacción, y recalcula **todos** los
  costos de ese producto, no solo los pendientes. El DELETE, en cambio, no
  re-resuelve nada — solo borra la definición.
- `stages`/`steps`: reemplazo completo DELETE+INSERT (no hay UPDATE parcial)
  porque son catálogos, no datos con historial.
- `fx` POST: carga manual que pisa la fila del cron de ese día vía `ON
  CONFLICT`.
- `ads` (cuentas): al reasignar el `funnelId` de una cuenta, arrastra el
  gasto histórico de `ad_spend` al nuevo funnel.

### 5.3 Anuncios (`/api/ads/*`)

Ver sección 6 completa. Rutas: `acciones` (manuales, 1571 líneas),
`reglas` (CRUD + CSV de utmify), `interruptores` (kill switches globales).

### 5.4 Finanzas (`/api/finanzas/*`)

| Ruta | Nota |
|---|---|
| `cuentas` | PATCH permite cambiar `kind`, lo que reescribe el signo del patrimonio en **todos** los días pasados de esa cuenta; DELETE es destructivo (`ON DELETE CASCADE` sobre saldos) |
| `movimientos` | Finanzas es siempre global (nunca por funnel). `kind` editable en PATCH; el signo lo pone la capa de queries, no el request |
| `pagos-programados` | La plantilla del pago; monto siempre positivo. DELETE no bloquea con historial: `SET NULL` |
| `pagos-programados/ejecutar-ahora` | El botón manual, idempotente vía PK `(scheduled_payment_id, month)` |
| `saldos` | El usuario tipea el saldo de cada cuenta por día; `amountEur: null` **borra** el saldo de ese día (distinto de guardar 0) |

El patrimonio **no se calcula**, se mide: es la suma de saldos tipeados a
mano, no una derivación de `daily_metrics` ni de Meta (desde la migración
028). Un día al que le falta una cuenta da `null`, nunca un total parcial.

### 5.5 Tareas (`/api/tareas/*`) y Usuarios (`/api/usuarios/*`)

Kanban con autorización: ver/crear/comentar → cualquiera; editar/mover/
borrar/links → solo el dueño (`asignado_a` en la base, nunca el payload) o
admin. Usuarios: solo admin, con protección contra "quedarse sin ningún
admin activo" resuelta con `SELECT ... FOR UPDATE` dentro de una transacción
(no se puede expresar como CHECK porque es una condición entre filas).

### 5.6 IA (`/api/ia/insight`)

**Es la única ruta del panel que gasta dinero real** (llamadas a OpenAI). Por
eso: solo `POST` (nunca GET, para que un prefetch no dispare gasto), guard
de sección, y techo diario de generaciones (`OPENAI_INSIGHTS_MAX_DIA`,
default 20). Cachea por hash del contenido del brief: si los datos no
cambiaron, no se vuelve a llamar a OpenAI. `503` explícito si no hay
`OPENAI_API_KEY` configurada ("no está roto, está apagado").

---

## 6. Módulo de Anuncios (Meta Ads) — el más grande y riesgoso

**Apagado en la instancia infinix, sin worker** (ver
`.kiro/steering/instancias.md`). Todo lo de esta sección aplica a hilvanapp.

### 6.1 Cliente de Meta (`lib/ads/meta.ts`)

- Token: `META_ADS_TOKEN` (distinto del `META_CAPI_TOKEN` de los funnels).
  Siempre en header `Authorization: Bearer`, nunca en query string — un
  token con `ads_management` puede apagar facturación y las URLs con token
  quedan en logs.
- Versión de API: `META_API_VERSION`, default `v21.0`.
- Todas las lecturas con `cache: 'no-store'` explícito (el runtime de Next
  cachea GETs por defecto).
- Escrituras permitidas: solo `status` (`ACTIVE`/`PAUSED`, nunca
  `ARCHIVED`/`DELETED`) y `daily_budget` (nunca `lifetime`).
- El resultado de una escritura tiene tres estados: `'confirmado'`,
  `'fallido'`, `'indeterminado'` (timeout o 5xx sin cuerpo) — un
  `'indeterminado'` significa "pudo haberse aplicado", y evita reintentos
  ciegos que dupliquen una subida de presupuesto.
- Timeouts: 30s lectura, 30s escritura. Cortafuegos de 100 páginas en toda
  paginación.

### 6.2 Motor de reglas (`lib/ads/reglas/motor.ts` + `ejecutor.ts`)

Arquitectura en capas: `motor.ts` es puro (sin red ni base), `repo.ts` es
toda la E/S, `ejecutor.ts` orquesta.

**`debeCorrer`** (una vez por regla): `enabled` → ventana horaria (con
soporte de cruce de medianoche, en la TZ de la cuenta) → cadencia
(`everyMinutes`) → `maxRunsPerDay`.

**`evaluar`** (una vez por objeto), en 7 pasos: condiciones AND (una métrica
`null` nunca se trata como 0 — "el falso positivo más caro del motor") →
higiene idempotente (no repausa lo ya pausado, documentado con un incidente
real del 2026-09-01 de 23-57 pausas duplicadas sobre los mismos 15
conjuntos) → verificación de nivel de presupuesto escribible → cooldown
(solo sobre acciones reales, no simuladas) → tope de acciones por objeto por
día → cálculo de presupuesto contra techo/piso de la regla y **techo
absoluto** global → decisión final.

**Modo sombra (dry-run)**: doble llave — `regla.dryRun || switches.forzarSombra`.
En sombra, se registra la decisión con `estado: 'simulado'` y **nunca se
llama a Meta**. Toda regla nueva nace `enabled=false, dry_run=true` sin
importar lo que el payload pida.

**Reconciliación**: antes de cada tick, cierra filas `pendiente`/
`indeterminado` preguntándole a Meta el estado real. Si el interruptor
global está apagado, no llama a Meta y las deja sin cerrar.

**Orden de escritura**: la fila de auditoría se abre en `'pendiente'` **antes**
del POST a Meta, se cierra **después** con el resultado real.

### 6.3 Frenos de seguridad (ninguno es opcional)

| Freno | Qué limita |
|---|---|
| `ads_rules_enabled` (settings) | Interruptor global: en `false`, cero llamadas a Meta |
| `ads_rules_force_dry_run` (settings) | Fuerza modo sombra global; default `true` si la fila no existe |
| `ads_max_daily_budget_eur` (settings) | Techo absoluto por objeto — rechaza, no recorta |
| `ads_max_delta_por_tick_eur` (settings) | Tope agregado por tick, por cuenta activa |
| `cooldownMinutes` (por regla) | Espera mínima entre acciones reales sobre el mismo objeto |
| `maxActionsPerObjectPerDay` (por regla) | 0 = sin tope |
| `maxRunsPerDay` (por regla) | Corridas máximas de la regla por día |
| Backoff adaptativo por cuota | En el worker y en acciones manuales: escalones de `15 × 2^fallas` minutos (tope 60) ante error 17/613 de Meta |
| Lease de exclusión mutua | El worker toma un lease de 3 min antes de correr, para no duplicarse si hay dos procesos |

El endpoint que apaga/prende los interruptores (`/api/ads/interruptores`) **no
puede** subir los techos de presupuesto — el esquema de ese POST no declara
esos campos.

### 6.4 El worker `panel-reglas`

`scripts/run-ad-rules.ts`, corre en PM2 como proceso `panel-reglas`. Cadencia
base: 60s, con `setTimeout` recursivo (no `setInterval`) para que un tick
largo no se solape con el siguiente.

Orden del tick, fijo: leer interruptores → tomar lease → leer backoff →
reconciliar → refrescar gasto → correr motor de reglas → notificar por
Telegram → revisar uso de cuota y actualizar backoff → liberar lease →
marcar `ads_worker_last_tick`.

Un tick que falla no mata el proceso (el error se atrapa dentro del propio
tick, para no entrar en ciclo de reinicios de PM2). Modo `--health` (cron
cada 30 min) solo verifica que `ads_worker_last_tick` no esté vencido —
**no** ejecuta reglas.

---

## 7. Base de datos — tablas principales

PostgreSQL 16, paquete de Ubuntu en producción (no Docker). 31 migraciones en
`db/migrations/`. Fundacionales:

| Tabla | Migración | Qué guarda |
|---|---|---|
| `funnels` / `funnel_steps` | 001 | Catálogo de funnels y su árbol de pasos. La ingest key nunca se guarda en claro, solo su hash |
| `sessions` | 002 | Una fila por sesión (no por evento). `max_step_index` mide el embudo. UTMs con centinela `'(directo)'` en vez de NULL. `day` inmutable una vez fijado |
| `events` | 003 | Log crudo, particionado por mes sobre `occurred_at`. Retención 180 días vía DROP de partición |
| `orders` / `order_items` / `product_map` / `shop_map` | 004 | Ventas unificadas. UNIQUE `(source, external_id)` para idempotencia del webhook. `amount_eur`/`fx_rate`/`fx_day` congelados al insertar, nunca recalculados al leer |
| `fx_rates` | 005 | Cotización diaria, PK `(day, base, quote)`, editable a mano |

Resto (lista completa cronológica, ver `db/migrations/*.sql` para el DDL
exacto — no se leyó línea por línea el DDL completo de 016-031, solo
cabeceras):

`daily_metrics` (006, rollup recalculado por cron) · `ingest_errors` /
`webhook_events` / `settings` (007) · `ad_spend` (008, reemplazada en 014) ·
seeds de funnels y settings (009-010) · `commissions` (011→012) · costo por
producto (013) · `ad_accounts` + jerarquía de campañas (014, 016) · TZ por
cuenta (015) · etapas configurables + layouts de widgets (017) · gestor de
campañas / DSA (018) · `funnels.alias` (019) · `sessions.experiment` (020) ·
`ad_rules.account_id`, una cuenta por regla (021 — la que exige una cuenta
activa para poder migrar sobre una base vacía, ver
`.kiro/steering/instancias.md`) · Finanzas v1 (022, tablas eliminadas
después) · experimento como filtro (023) · sin tope de acciones (024) ·
frescura de jerarquía de ads (025) · funnel LATAM (026) · test A/B del
upsell (027) · **saldo de cuentas tipeado a mano, reemplaza el cálculo de
patrimonio de la 022** (028) · insights de IA cacheados (029) · `usuarios`
(030) · `tareas` kanban (031).

---

## 8. Cron jobs (`deploy/cron.panel`)

Todos corren como `deploy`, con `tsx` (no compilado), desde
`/srv/panel/current`:

| Horario | Script | Qué hace |
|---|---|---|
| `05:10` | `fetch-fx.ts` | Cotización del día |
| cada 10 min | `rollup.ts --days=3` | Recalcula `daily_metrics`, últimos 3 días |
| `05:25` | `rollup.ts --days=35` | Rollup nocturno completo (15 min después de fetch-fx, a propósito) |
| día 1 de cada mes, `04:00` | `ensure-partitions.ts` | Particiones de `events` con anticipación |
| `04:30` | `pg_dump` → gzip | Backup diario |
| `04:35` | `find ... -mtime +14 -delete` | Purga backups viejos |
| `05:40` | `finance-scheduled-payments.ts` | Único cron de Finanzas que queda tras la 028 |
| cada hora, minuto 7 | `sync-ads.ts` | Gasto de ads |
| cada 15 min | `sync-ads-jerarquia.ts` | Jerarquía de campañas/adsets/anuncios |
| cada 30 min | `run-ad-rules.ts --health` | Solo health-check del worker, no ejecuta reglas |
| `05:45` | `generar-insights.ts` | Insight de IA diario (Resumen + Finanzas) |
| `05:50` | `archivar-tareas.ts` | Archiva tarjetas del kanban con +2 días en "hecho" |

**Nota de instancias**: la línea de `archivar-tareas.ts` la instala el deploy
de hilvanapp; el deploy de infinix vive fuera del repo (`/srv/panel-infinix/deploy.sh`)
y no la incluye automáticamente.

---

## 9. Lo que quedó fuera de este documento

- El detalle completo línea por línea de `app/api/ads/acciones/route.ts`
  (1571 líneas, acciones manuales del gestor de campañas) — se documentaron
  sus frenos de seguridad en §6.3, pero no cada rama de su lógica interna.
- El DDL exacto de las migraciones 016-031 más allá de sus comentarios de
  cabecera.
- `lib/ads/copias.ts`, `lib/ads/previsualizacion.ts`, `lib/ads/errores.ts`,
  `lib/ads/vistas.ts`, `lib/commissions.ts`, `lib/costs.ts`,
  `lib/supabase-leads.ts` — se sabe que existen y para qué se importan, no
  se documentó su lógica interna.
- El módulo Hotmart, porque no existe código: solo referencias de
  planificación (§1).

Si necesitás precisión sobre alguna de estas áreas, conviene leer el archivo
puntual — este documento prioriza cobertura sobre profundidad exhaustiva.
