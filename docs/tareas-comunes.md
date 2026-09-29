# Cómo hacer tareas comunes

Recetas paso a paso para los cambios que más se repiten en el panel. Complementan
las convenciones ([README §8](../README.md#8-convenciones)) y los gotchas
([README §10](../README.md#10-gotchas-y-decisiones-no-obvias)): leelos antes.

Si una receta y el código no coinciden, manda el código. Corregí la receta en la
misma tanda y anotalo en `registro.md`.

- [Agregar un endpoint de API](#agregar-un-endpoint-de-api)
- [Agregar una migración](#agregar-una-migración)
- [Agregar una pestaña (sección)](#agregar-una-pestaña-sección)
- [Agregar un funnel](#agregar-un-funnel)
- [Cargar o rotar una ingest key](#cargar-o-rotar-una-ingest-key)
- [Imputar campañas de una cuenta compartida a otro funnel](#imputar-campañas-de-una-cuenta-compartida-a-otro-funnel)
- [Agregar una variable de entorno](#agregar-una-variable-de-entorno)
- [Agregar un cron](#agregar-un-cron)
- [Agregar un widget al Resumen o a Ventas](#agregar-un-widget-al-resumen-o-a-ventas)

---

## Agregar un endpoint de API

1. `app/api/<ruta>/route.ts` con el molde de
   [README §8 → API routes](../README.md#api-routes) (el ejemplo vivo es
   `app/api/creativos/route.ts`).
2. La lógica y el SQL en `lib/queries/<módulo>.ts`.
3. **La ruta exacta en `MAPA_API`** (`lib/permisos.ts`) con su sección, o
   `'admin'`. Sin esto responde 403 en producción y
   `app/api/rutas-mapeadas.test.ts` queda en rojo. No hay comodines por prefijo:
   hay rutas bajo `/api/config/` que son de otras secciones.
4. Si lo llama un sistema externo, tiene que quedar fuera del `matcher` de
   `middleware.ts` (hoy solo `api/ingest` y `api/webhooks/*` lo están), marcarse
   `'publica'` en el mapa y traer su propia auth. Consultalo antes.
5. Tests: `route.test.ts` al lado (ver `app/api/creativos/route.test.ts`) y los de
   integración de la query.
6. Entrada en `registro.md`.

## Agregar una migración

1. `db/migrations/NNN_descripcion.sql` con el próximo número libre: **al
   2026-09-29 es el 036**.
2. SQL plano **sin `BEGIN`/`COMMIT`**: `scripts/migrate.ts` envuelve cada archivo
   en su transacción. Por lo mismo, nada de `CREATE INDEX CONCURRENTLY`.
3. Idempotente (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, guards en
   `DO $$ … $$`) y con una cabecera que explique el porqué
   (`db/migrations/033_campania_por_funnel.sql` es un buen modelo). `COMMENT ON`
   en lo nuevo.
4. **Compatible hacia atrás**: el deploy migra antes de activar el código nuevo,
   así que por unos segundos el código viejo corre contra el schema nuevo.
   Agregar columnas nullable o con default, sí; borrar o renombrar algo que el
   código viejo lee, en dos deploys.
5. Corre en **las dos bases de producción** (una con años de datos, otra casi
   vacía). Si depende de datos existentes, contemplá la base vacía (la 021 no lo
   hizo).
6. Probala en una base scratch con todas las anteriores (armada como en
   [README §5](../README.md#paso-a-paso)), dos veces seguidas, y corré la suite
   contra esa base.
7. **Nunca edites una migración ya aplicada**: se registra por nombre de archivo
   en `schema_migrations` y no vuelve a correr.

## Agregar una pestaña (sección)

Siguiendo lo que hizo Creativos (commit `b0c44f6`):

1. Migración que extienda el CHECK `usuario_secciones_valida` (ver
   `db/migrations/034_creativos.sql`) y decida quién la ve:
   `usuario_secciones` es opt-in.
2. `lib/permisos.ts`: la sección en `SECCIONES` y sus rutas en `MAPA_API`.
3. `app/(panel)/config/sections/UsuariosSection.tsx`: tiene su propia copia del
   vocabulario de secciones.
4. `components/Nav.tsx` (`TABS`, con ícono de Phosphor) y `components/Shell.tsx`
   (`PANTALLAS`: subtítulo y qué filtros muestra; si falta, la pantalla sale sin
   subtítulo ni filtros).
5. `app/(panel)/<x>/`: `layout.tsx` con `requerirSeccion`, `page.tsx`,
   `loading.tsx` y `<X>View.tsx`.
6. Actualizar los tests que cuentan secciones: `lib/permisos.test.ts` y
   `lib/queries/usuarios.test.ts`.

## Agregar un funnel

Sin migración (resumen de `docs/runbook.md` §7):

1. Alta en `/config` → Funnels: slug, nombre, **TZ de la tienda** (la de su
   Shopify, no la de "dónde está el tráfico": ver `registro.md` 2026-09-22 (3)),
   moneda de venta, variantes y color. Nace con
   `ingest_key_hash = 'PENDING_SET_INGEST_KEY_<SLUG>'`: el ingest le responde
   401 hasta que tenga una key.
2. Ingest key: ver [Cargar o rotar una ingest key](#cargar-o-rotar-una-ingest-key).
   En el funnel van `PANEL_INGEST_URL=https://panel.hilvanapp.com/api/ingest` y
   `PANEL_INGEST_KEY=<key>`.
3. En el checkout del funnel, el cart attribute `funnel=<slug>`.
4. Mapear sus productos en `/config` → Productos (`product_map`). Sin eso, sus
   ventas caen en "ventas sin atribuir" con tier `unknown`.
5. Opcional: `SUPABASE_URL_<SLUG>` y `SUPABASE_SERVICE_KEY_<SLUG>` para Leads (el
   sufijo es el slug en mayúsculas, sin normalizar los guiones).
6. En el admin de su tienda (Configuración → Notificaciones → Webhooks), sin
   borrar las que ya existen: `orders/paid`, `orders/create`, `refunds/create` y
   `orders/cancelled` → `https://panel.hilvanapp.com/api/webhooks/shopify`. Y su
   secret sumado a `SHOPIFY_WEBHOOK_SECRETS`.
7. Si vende en una moneda nueva, `fetch-fx` la toma de `funnels.sell_currency`
   desde el día que corre; los días anteriores quedan `fx_stale`.
8. Si su publicidad corre en una cuenta compartida, mapear sus campañas (ver
   [Imputar campañas…](#imputar-campañas-de-una-cuenta-compartida-a-otro-funnel)).

Ojo: un funnel dado de alta así no existe en un clon limpio del repo (le pasó a
`gelatina` y `almagemela`).

## Cargar o rotar una ingest key

La key en claro vive en el `.env.production` de cada funnel; acá se guarda solo
su hash.

```bash
openssl rand -hex 32                        # generar
npm run db:ingest-key -- chauhinchazon <key>
npm run db:ingest-key -- reset <key>        # imprime solo el prefijo del hash
```

También se puede generar desde `/config`, que la muestra **una sola vez** y deja
inválida la anterior al instante. Mientras un funnel tenga el placeholder
`PENDING_SET_INGEST_KEY_*`, el ingest le devuelve 401 en vez de aceptar
cualquier cosa.

## Imputar campañas de una cuenta compartida a otro funnel

El gasto va al funnel de la cuenta publicitaria salvo que la campaña esté en
`ad_campaign_funnel` (migración 033). La cuenta `act_2501344510302910` la
comparten Chau Hinchazón, LATAM y Alma Gemela.

- **Por la UI**: `/config` → Publicidad → Campañas de la cuenta. El endpoint
  (`/api/config/ads/campanas`) mueve el gasto histórico y recalcula el rollup
  del rango en la misma request.
- **Por SQL** (como en `registro.md` 2026-09-25 y 2026-09-27): un `INSERT` en
  `ad_campaign_funnel`, un `UPDATE ad_spend SET funnel_id = …` para esas
  campañas y el `rollup.ts --from=… --to=…` del rango, todo por ID de campaña y
  **nunca por prefijo del nombre**.
- Es manual y se repite: cada tanda nueva de campañas de Alma Gemela en esa
  cuenta cae en Chau Hinchazón hasta que alguien la mapea.

## Agregar una variable de entorno

1. Leela con default al valor actual de hilvanapp, o con la feature apagada si
   es nueva.
2. Documentala en `.env.example` con el porqué, al estilo del archivo, y en la
   tabla de [README §6](../README.md#6-variables-de-entorno).
3. `NEXT_PUBLIC_` solo si no es secreta y el cliente la necesita. Se hornea en el
   build: cambiarla es un deploy.
4. Si tiene que ser obligatoria, sumala a `REQUIRED` en `deploy/deploy.sh`,
   sabiendo que el deploy aborta hasta que esté cargada en la VPS y que el
   deploy de la otra instancia (fuera del repo) no se entera.
5. En la VPS: `nano /srv/panel/shared/.env.production` y
   `/srv/panel/aplicar-env.sh` (recarga sin rebuild; si es `NEXT_PUBLIC_`,
   deploy).

## Agregar un cron

1. Script en `scripts/<x>.ts` que cierre el pool y salga con `1` si falla, y su
   alias en `package.json`.
2. La línea en `deploy/cron.panel` con el patrón

   ```
   cd /srv/panel/current && /usr/bin/node --env-file=.env.production ./node_modules/.bin/tsx scripts/<x>.ts >> /var/log/panel/<y>.log 2>&1
   ```

   y un comentario que explique la hora: hay cadenas (`fetch-fx` 05:10 →
   `rollup` 05:25 → `generar-insights` 05:45).
3. **Instalarla a mano** en el crontab de `deploy` en la VPS: `deploy.sh` no
   instala crontabs. Respaldá antes (`crontab -l > /tmp/cron.actual`) y no borres
   líneas ajenas: ese crontab también tiene las de otros proyectos. En la
   otra instancia, si corresponde, también a mano.
4. Las horas son del servidor (Europe/Berlin); "el día" del negocio es
   `DASHBOARD_TZ`. Leé el comentario de `fetch-fx` en `deploy/cron.panel` antes
   de mover una hora.

## Agregar un widget al Resumen o a Ventas

- Catálogos: `lib/widgets/catalogo-resumen.tsx` y `lib/widgets/catalogo-ventas.tsx`.
- Tipos, **congelados**: `lib/widgets/tipos.ts`.
- Layout por defecto: `app/(panel)/resumen/layout-por-defecto.ts`; lo que guarda
  cada usuario va por `/api/config/ui-layout`.
- Reglas de `tipos.ts`: el `id` de un widget **no se renombra nunca** (es la
  clave del layout guardado; para el nombre visible está `label`), un widget no
  hace fetch (recibe `data`), y `render` usa el `size`.
