# T10 — Instrumentar `testfunnel` (chauhinchazon) y borrar su `/admin`

- **Depende de:** solo §4 y §6 del plan (el contrato del ingest y el vocabulario de eventos), que ya
  están congelados. **No espera a T02.**
- **Bloquea:** nada.
- **Paralelizable con:** todo, incluido T11 (es otro repo, no hay riesgo de colisión).
- **Repo:** `~/Desktop/funnel/testfunnel` — **este task no escribe ni un archivo fuera de ahí.**

Este es el task más riesgoso del proyecto: toca un funnel que está vendiendo. La regla que ordena
todas las decisiones de acá: **Meta CAPI no se toca y no se rompe.** Si al final del task hay una
duda sobre si CAPI sigue andando, el task no está terminado.

Antes de empezar, leé en este repo: `app/api/track/route.ts`, `lib/cookies.ts`, `lib/utm.ts`,
`lib/constants.ts`, `app/api/shopify-webhook/route.ts` y `components/quiz-v2/QuizContainerV2.tsx`.

---

## 1. Las cinco cosas que hay que hacer

| # | Qué | Por qué |
|---|---|---|
| A | Cookies de sesión y visitante | sin ellas el embudo no puede medir personas |
| B | Relay de `/api/track` al ingest del panel | es el que alimenta todo |
| C | `sid`, `vid` y `funnel` en los cart attributes | es lo que ata una venta a su sesión y a su funnel |
| D | Borrar `/admin` y todo `lib/admin/` | decisión del usuario: todo se ve desde el panel |
| E | Dejar de escribir `funnel_counts` | Supabase deja de ser la base de tracking |

Lo que **no** se toca, lista cerrada: `lib/tracking.ts` (CAPI), el pixel del browser,
`app/api/submit-quiz/route.ts`, la escritura de `purchases` en Supabase (D8/D9: alimenta el
entitlement de la PWA), todo `app/pwa/**` y `lib/pwa/**`, el copy, los precios, las preguntas.

---

## A. Cookies de sesión y visitante

`lib/constants.ts` — dos claves nuevas en `STORAGE_KEYS`, respetando el estilo del archivo (los
valores son los nombres reales de las cookies):

```ts
/** Id de sesión de tracking. Cookie de 30 min con renovación deslizante. */
sessionId: 'ah_sid',
/** Id de visitante de tracking. Cookie de 365 días. */
visitorId: 'ah_vid',
```

`lib/session-ids.ts` — archivo nuevo, cliente:

```ts
'use client';
/**
 * Los dos ids que identifican una visita, del lado del browser.
 *
 * NO son httpOnly a propósito: los crea el cliente y los lee el servidor del
 * mismo origen en cada POST a /api/track. Gracias a eso, ningún emisor de
 * eventos necesita cambiar su payload (§D7 del plan del panel).
 *
 * sid dura 30 minutos y se renueva en cada evento: una visita es una sesión.
 * vid dura un año: sirve para atar la compra del upsell que se abre al día
 * siguiente desde el mail.
 */
export function ensureTrackingIds(): { sessionId: string; visitorId: string };
```

- `crypto.randomUUID()`, con un fallback manual si no existe (browsers viejos).
- Cookies con `path=/`, `SameSite=Lax`, `Secure` si el protocolo es https, y `domain` desde
  `NEXT_PUBLIC_COOKIE_DOMAIN` **si está seteada** (es lo que hace `lib/cookies.ts` para los UTMs;
  seguí exactamente ese patrón para que las cookies valgan también en el subdominio del checkout).
- Espejo en `localStorage`: si la cookie no está pero el valor sí está en `localStorage`, se
  reescribe la cookie. Safari borra cookies puestas por JS a los 7 días.
- **Idempotente**: si las cookies ya existen, las devuelve sin regenerarlas y solo refresca el
  vencimiento del `sid`.

`components/SessionBootstrap.tsx` — client component de 10 líneas que llama a `ensureTrackingIds()`
en un `useEffect` vacío y no renderiza nada. Montalo en `app/layout.tsx` dentro del `<body>`. Un
client component se puede renderizar desde un layout de servidor sin convertirlo en cliente.

**Renovación del `sid` desde el servidor.** El cliente lo crea; `/api/track` lo **renueva** en cada
respuesta con un `Set-Cookie` de 30 minutos más. Es más confiable que depender de que el cliente lo
haga, y no cuesta nada.

## B. Relay al ingest

`lib/panel-ingest.ts` — archivo nuevo, **solo servidor**:

```ts
/**
 * Manda eventos al panel de tracking. Fire-and-forget: si el panel está caído,
 * el funnel no se entera y el visitante no espera.
 */
export type PanelEvent = {
  name: string; at: string; stepIndex?: number; stepSlug?: string;
  value?: number; currency?: string; eventUid?: string; props?: Record<string, unknown>;
};
export function sendToPanel(payload: {
  sessionId: string; visitorId: string; variant?: string;
  events: PanelEvent[];
  context?: { utms?: Record<string,string>; country?: string; device?: string;
              referrer?: string; path?: string };
}): void;
```

Reglas, todas obligatorias:

- Env: `PANEL_INGEST_URL` (ej. `https://panel.hilvanapp.com/api/ingest`) y `PANEL_INGEST_KEY`. Si
  falta cualquiera de las dos, la función **no hace nada y no loguea en cada request** (loguea una
  vez, la primera). Un funnel sin panel configurado tiene que funcionar igual.
- `void fetch(...)` con `.catch(() => {})` **explícito**. Una promesa rechazada sin catch en Node
  puede tumbar el proceso: acá eso sería tirar abajo el funnel por un panel caído.
- `AbortSignal.timeout(2000)`. Nunca se espera al panel para responder al cliente.
- **No se hace `await`** dentro del handler antes de responder. El relay arranca y el handler sigue.
- El payload es exactamente el §4 del plan. Nada más, nada menos.

`app/api/track/route.ts` — los cambios, en orden:

1. Después de resolver `email`, `ip` y `userAgent` (que ya se resuelven), leé
   `req.cookies.get('ah_sid')` y `ah_vid`.
2. **Si no hay `sid`**, no inventes uno del lado del servidor: mandá el evento con un `sid` derivado
   y marcalo. Concretamente: generá un uuid y agregá `props: { synthetic_sid: true }`. Un `sid` nuevo
   por request infla las sesiones, así que tiene que ser visible en los datos que eso pasó. Si aparece
   seguido, es que el `SessionBootstrap` no está montando.
3. Mapeá el evento con la tabla del §6 del plan:

   | Entra | Sale |
   |---|---|
   | `QuizProgress` | `step_view`, `stepIndex = custom.slide`, `stepSlug = custom.question_id` |
   | `ViewContent` con `contentName` que empieza con `'Sales Page'` | `sales_view` |
   | `ViewContent` con `contentCategory === 'Upsell'` y `contentName` que **no** contenga `'Downsell'` | `upsell_view` |
   | `ViewContent` con `contentName` que contenga `'Downsell'` | `downsell_view` |
   | `InitiateCheckout` con `value === PRICING.front.amount` | `checkout_click` |
   | `InitiateCheckout` con cualquier otro `value` | `upsell_click` |
   | `Lead` | `lead` |
   | `Purchase` | `purchase` |
   | cualquier otro | se manda con el mismo nombre; el panel lo guarda sin tocar `sessions` |

   El criterio del `InitiateCheckout` por monto es frágil pero es el único disponible hoy sin tocar
   los emisores: los precios están en `lib/quiz-v2/config.ts` (`PRICING.front` 7790,
   `upsell` 24790, `upsell2` 9970, `downsell` 14790 ARS). Escribí el mapeo **leyendo `PRICING`**, no
   con números literales en el código. Si dos tiers comparten precio, anotá en §10 del plan.

4. `country` de `req.headers.get('cf-ipcountry')` (Cloudflare lo pone en todos los requests).
   `device` no hace falta: el panel lo deriva del user-agent, pero mandá el UA en el contexto si te
   resulta más simple.
5. `variant`: `normalizeQuizVersion(custom.quiz_version)` ya existe en este repo y devuelve
   `'ar' | 'latam'`. Usalo tal cual.
6. Los UTMs salen de `custom.utms` (que ya viaja) o del puente por email que el handler ya hace para
   `Purchase`.
7. **Borrá** el bloque de `getStore().track(...)` y todos los imports de `lib/admin/`.
8. `sendCapiEvent(...)` y todo el corte de `ab_entry_*` / `af_*`: el corte se puede simplificar
   (ya no existen esos eventos, D del plan), pero **la llamada a CAPI y su payload no se tocan**.

Al final, `/api/track` sigue respondiendo **siempre 200** al cliente, como hoy.

## C. Cart attributes

`lib/cookies.ts`, en `buildCheckoutAttribution()`: sumá tres pares, con el mismo formato
`attributes[k]=v` que ya usa para `fbc`, `fbp` y `src_host`:

```
attributes[funnel] = 'chauhinchazon'
attributes[sid]    = <ah_sid>
attributes[vid]    = <ah_vid>
```

El slug **tiene que ser exactamente** `chauhinchazon`, igual que en `funnels.slug` del panel. Si no
coincide, el webhook del panel no resuelve el funnel por atributo y cae al mapeo por producto.

Esto es lo que permite que una venta diga de qué sesión salió. Sin esto, la conversión por campaña se
calcula solo por herencia de UTMs y se pierde el cruce sesión→venta.

No toques el resto de `buildCheckoutAttribution`: los UTMs duplicados como query **y** como
attribute están así a propósito.

## D. Borrar el panel viejo

```bash
git rm -r app/admin components/admin lib/admin app/api/admin
```

Después, y esto es lo que suele quedar colgado:

- `grep -rn "lib/admin\|components/admin\|/api/admin" app components lib middleware.ts next.config.mjs`
  → tiene que dar **cero**.
- `middleware.ts`: si el matcher o alguna rama nombra `/admin`, sacalo.
- `next.config.mjs`: si hay headers o redirects para `/admin`, sacalos.
- `deploy/deploy.sh`: si `PURGE_PATHS` incluye `/admin`, sacalo.
- `deploy/Caddyfile`: sacá el bloque `handle /admin* { … }` del snippet `(funnel)`. Con `/admin`
  borrado, pinnear una instancia no tiene sentido. **Sacá también el `/admin` del matcher
  `@sin-cache`** (dejá `/api/*`, `/pwa` y `/pwa/*`). Ese archivo lo aplica el usuario en la VPS, no
  vos: dejalo commiteado y mencionalo en el resumen final.
- Tests que importen de `lib/admin/`: **actualizalos o borralos junto con el código que probaban**,
  nunca los dejes fallando ni los comentes.
- `lib/vsl-events.ts` **se queda**: es el player del VSL, no es analytics.

## E. Dejar de escribir `funnel_counts`

Con `lib/admin/` borrado no queda quién escriba. Verificá que no quedó ningún llamado:

```bash
grep -rn "getStore\|FUNNEL_STORE\|funnel_counts\|increment_funnel_count" app components lib
```

`app/api/shopify-webhook/route.ts`: sacá el `getStore().track('Purchase', …)` y los tracks de
variantes (`ab_entry_*`, `sp_*`, `af_*`). **Todo lo demás de ese archivo queda intacto**: la
verificación de HMAC, el upsert en `purchases` de Supabase, la herencia de UTMs y la llamada a CAPI
con el valor fijo en EUR. Ese webhook sigue existiendo por D8.

La tabla y sus RPC quedan en Supabase sin uso (P-02 del plan). No las borres.

Env que quedan sin uso y hay que sacar de `.env.example` y documentar en el resumen:
`FUNNEL_STORE`, `ADMIN_PASSWORD`. Env nuevas: `PANEL_INGEST_URL`, `PANEL_INGEST_KEY`.

---

## Verificación

Cero opcional. El punto 4 es el que decide si este task se puede desplegar.

```bash
cd ~/Desktop/funnel/testfunnel

# 1 — compila y los tests pasan
npx tsc --noEmit && npm run build && npm test

# 2 — no quedó nada del panel viejo
grep -rn "lib/admin\|components/admin\|/api/admin" app components lib middleware.ts next.config.mjs
grep -rn "getStore\|FUNNEL_STORE\|funnel_counts\|increment_funnel_count" app components lib
find app components lib -path '*admin*'
# las tres: cero resultados

# 3 — el relay llega. Levantá el panel en 3005 y el funnel en 3000:
npm run dev
# en el browser: abrí /quiz, avanzá 4 preguntas, y en el panel:
docker compose -f ~/Desktop/funnel/dashboard-admin/docker-compose.yml exec db \
  psql -U panel -d panel -c \
  "SELECT id, max_step_index, utm_campaign, country, device, variant
   FROM sessions ORDER BY started_at DESC LIMIT 3;"
# tiene que haber UNA fila con max_step_index creciendo, no una por evento

# 4 — CAPI SIGUE ANDANDO. No se da por cumplido sin evidencia:
#     · el log del server tiene que mostrar el events_received de sendCapiEvent, o
#     · el evento aparece en Test Events del Administrador de eventos de Meta
#     Probalo con QuizProgress, ViewContent e InitiateCheckout.

# 5 — los cart attributes viajan
# En /quiz, llegá a la sales page, click en comprar y mirá la URL del checkout:
# tiene que traer attributes[funnel]=chauhinchazon, attributes[sid]=… y attributes[vid]=…

# 6 — sin panel configurado, el funnel funciona igual
unset PANEL_INGEST_URL PANEL_INGEST_KEY   # o comentalas en .env.local
npm run dev
# /quiz funciona, no hay errores en consola, y CAPI sigue saliendo
```

## Cuándo parar

- Si al mapear `InitiateCheckout` resulta que dos tiers comparten el mismo precio: **pará** y anotá
  en §10. Con precios iguales no hay forma de distinguir el checkout del front del de un upsell sin
  tocar los emisores, y tocarlos es un cambio de alcance.
- Si un test existente falla por algo que este documento no anticipó: es información, va a §10. **No
  aflojes la aserción y no borres el test.**
- Si para que compile te hace falta editar algo dentro de `~/Desktop/funnel/dashboard-admin`: pará.
  Ese repo es de otros tasks y estás pisando trabajo ajeno.
