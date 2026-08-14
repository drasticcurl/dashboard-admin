# T11 — Instrumentar `reset-app` (reset) y borrar su `/admin`

- **Depende de:** solo §4 y §6 del plan. **No espera a T02.**
- **Bloquea:** nada.
- **Paralelizable con:** todo, incluido T10 (es otro repo).
- **Repo:** `~/Desktop/funnel/reset-app` — **este task no escribe ni un archivo fuera de ahí.**

## Cómo se usa este documento

**Leé `T10-instrumentar-testfunnel.md` completo y ejecutalo en este repo.** Los dos funnels son forks
del mismo código: las cinco partes (A cookies, B relay, C cart attributes, D borrar `/admin`, E dejar
de escribir `funnel_counts`), sus razones y su verificación son idénticas.

Acá están **solo las diferencias**. Son nueve y todas importan.

---

## Las diferencias

**1. El slug es `reset`.**

`attributes[funnel] = 'reset'` en `buildCheckoutAttribution()`. Tiene que coincidir exactamente con
`funnels.slug` del panel.

**2. Los nombres de las cookies siguen el prefijo de este repo.**

En `testfunnel` las claves de `STORAGE_KEYS` son legacy (`anti-hinchazon-utms`); acá todas usan el
prefijo `reset_` (`reset_quiz_state`, `reset_utms`, `reset_diary_logs`…). Respetalo:

```ts
/** Id de sesión de tracking. Cookie de 30 min con renovación deslizante. */
sessionId: 'reset_sid',
/** Id de visitante de tracking. Cookie de 365 días. */
visitorId: 'reset_vid',
```

**3. Hay un solo quiz: `variant` es siempre `'default'`.**

No existe `/latam` ni `data-latam.ts` en este repo, y `selectSlides()` devuelve siempre `slidesV3`.
`normalizeQuizVersion` existe pero devuelve `'ar'` para todo. **Mandá `variant: 'default'`** al ingest,
que es lo que el seed declaró en `funnels.variants` para este funnel (§3.12 del plan). No mandes
`'ar'`: el panel filtraría por una variante que este funnel no declara.

**4. Son 27 pasos, no 22.**

`slidesV3` va de 0 a 26 y `total_slides` es 27. No hardcodees ningún largo: el `stepIndex` sale de
`custom.slide`, que ya viaja correcto.

**5. Los precios son otros.**

`lib/quiz-v2/config.ts`: `PRICING.front` **7790**, `upsell` **14900**, `downsell` **9900** ARS. No
existe `upsell2`. El mapeo de `InitiateCheckout` → `checkout_click` / `upsell_click` se hace leyendo
`PRICING`, igual que en T10, nunca con números literales.

**6. Hay menos emisores.**

Solo tres archivos postean a `/api/track`: `components/quiz-v2/QuizContainerV2.tsx`,
`components/quiz-v2/SlideSalesPageV3.tsx` y `components/upsell/UpsellPageTracker.tsx`. No hay
`QuizContainerLatam`, `SlideSalesPageV3B`, `SlideSalesPageLatam`, `Upsell2Offer`. **No necesitás
tocar ninguno** (D7: el servidor lee las cookies), pero leelos para confirmar qué eventos salen.

**7. `/api/submit-quiz` existe pero nadie lo llama.**

Este quiz no captura email, así que `clientes` en Supabase está prácticamente vacío. No lo toques y no
te sorprenda que la sección Leads del panel muestre 0 para este funnel: es correcto.

**8. El entitlement de la PWA es la razón por la que el webhook se queda.**

`lib/pwa/upsell-access.ts` chequea `purchases` con `product_id === UPSELL_PRODUCT_ID` para habilitar
el contenido del upsell, y `/api/pwa/entitlements` lo expone. Ese camino tiene que seguir intacto: por
eso `app/api/shopify-webhook/route.ts` **se queda** y solo se le saca el `getStore().track(...)`
(D8/D9 del plan). Si al terminar el task un comprador del upsell perdería el acceso, el task está mal.

**9. La PWA es grande y no se toca.**

`app/pwa/**`, `lib/pwa/**`, `middleware.ts` en la parte que protege `/pwa/*` con Supabase Auth: nada
de eso entra en este task. **Cuidado con el `middleware.ts`**: en este repo hace tres cosas
(geo-block, redirect de `/`, y guard de sesión de la PWA). Al sacar cualquier referencia a `/admin`,
no rompas el guard de la PWA. Corré `/pwa/login` y una ruta protegida después de tocarlo.

---

## Verificación

La misma de T10, con estos ajustes:

```bash
cd ~/Desktop/funnel/reset-app

npx tsc --noEmit && npm run build && npm test

grep -rn "lib/admin\|components/admin\|/api/admin" app components lib middleware.ts next.config.mjs
grep -rn "getStore\|FUNNEL_STORE\|funnel_counts\|increment_funnel_count" app components lib
find app components lib -path '*admin*'
# las tres: cero

# la sesión llega con variant 'default' y llega a 27 pasos como máximo
docker compose -f ~/Desktop/funnel/dashboard-admin/docker-compose.yml exec db \
  psql -U panel -d panel -c \
  "SELECT s.id, s.variant, s.max_step_index FROM sessions s
   JOIN funnels f ON f.id = s.funnel_id AND f.slug = 'reset'
   ORDER BY s.started_at DESC LIMIT 3;"
# variant = 'default' · max_step_index entre 0 y 26

# el checkout lleva el slug correcto
# en /quiz → sales page → comprar: attributes[funnel]=reset

# CAPI sigue andando (evidencia, no suposición)

# la PWA sigue entera: esto es propio de este repo
# · /pwa/login carga
# · una ruta protegida sin sesión redirige a /pwa/login?next=…
# · con sesión, /api/pwa/entitlements responde y hasUpsell no cambió de comportamiento
```

## Cuándo parar

Todo lo de T10, más: si al tocar `middleware.ts` el guard de la PWA cambia de comportamiento, **pará
y revertí ese archivo**. Dejar `/admin` mencionado en el middleware es un costo cosmético; romper el
acceso a la PWA de gente que pagó, no.
