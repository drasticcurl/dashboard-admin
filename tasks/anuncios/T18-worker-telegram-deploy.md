# T18 — Worker de un minuto, avisos por Telegram y deploy

- **Depende de, para COMPILAR:** T13 (contratos y `ultimoUso()`) y T16 (`correrTodas`).
- **Depende de, para VERIFICAR: además de T14 y T15.** Tu tick llama a `correrTodas()`, que llama a
  `getMetricasAds` (T15) y decide sobre objetos que tienen que existir en la jerarquía (T14). Compila sin
  ellos porque el stub de `lib/queries/ads.ts` está tipado, pero **de la verificación 2 en adelante no
  corre nada**, y la verificación es lo que decide si el task terminó. Un worker "listo" cuyo tick nunca se
  probó de punta a punta es la pieza que no querés descubrir en producción a la 1 de la mañana.
- **Bloquea:** nada. Es la última pieza que se despliega.
- **Se puede correr en paralelo con:** T17 y T19.
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos que este task puede tocar:** `lib/ads/notificar.ts`, `lib/ads/notificar.test.ts`,
  `scripts/run-ad-rules.ts`, `scripts/telegram-setup.ts`, `deploy/ecosystem.config.js`,
  `deploy/deploy.sh`, `deploy/cron.panel` y `docs/runbook-anuncios.md`. Nada más.

Leé `00-PLAN-ANUNCIOS.md` completo, y **leé `deploy/ecosystem.config.js`, `deploy/deploy.sh` y
`deploy/cron.panel` enteros antes de editarlos.** Están en producción y sus comentarios explican
decisiones que ya costaron un incidente.

**El panel corre en la VPS con ventas reales. Este task modifica el deploy de un sistema vivo.**

---

## 1. Objetivo

Que el motor de T16 corra solo cada minuto, sin pasarse de los límites de la API de Meta, sin duplicar
acciones si hay dos procesos, y avisando por Telegram cuando hace algo.

Más los artefactos de deploy y un runbook. **Este task no ejecuta el deploy**: lo hace el usuario
después, con el runbook en la mano.

## 2. `scripts/run-ad-rules.ts` — el worker

Dos modos en el mismo archivo:

```
npm run ads:reglas                    # un tick y sale. Para probar a mano y para el cron de respaldo
npm run ads:reglas -- --daemon        # loop infinito. Es el que corre bajo PM2
npm run ads:reglas -- --regla=7       # una sola regla, un tick. Para debuggear
npm run ads:reglas -- --dry-run       # fuerza sombra en este tick, sin tocar settings
```

### El tick

```
1. LEER LOS INTERRUPTORES    → si !ads_rules_enabled: log y SALIR.
                               Sin sync, sin insights, sin mutaciones. Cero llamadas.
2. tomar el lease            → si no lo consigue, log y salir (§3)
3. leer el backoff           → si ads_backoff_until está en el futuro, log y salir (§4)
4. reconciliar()             → cerrar las mutaciones que quedaron colgadas (T16 §6b)
5. refrescar el gasto        → syncAdSpend de hoy y ayer, con TTL (§5)
6. correrTodas()             → T16 hace todo el trabajo
7. notificar                 → Telegram, solo lo que amerita (§6)
8. revisar el uso de la API  → ultimoUso(cuenta), y escribir el backoff si hace falta (§4)
9. liberar el lease          → compare-and-set por dueño (§3)
10. marcar ads_worker_last_tick + loguear contadorLlamadas()
```

### El paso 1 va PRIMERO, y antes no era así

El plan promete en su §9.7 que con `ads_rules_enabled = false` el worker no hace "ni una llamada a Meta".
El orden anterior de este tick era: lease → backoff → **`syncAdSpend`** → `correrTodas()`, y
`correrTodas()` es el primero que consulta los interruptores. O sea: **con las reglas apagadas, el worker
igual salía a pedirle insights a Meta cada minuto.**

Eso es peor que un bug de eficiencia. Un operador apaga las reglas creyendo que aisló Meta —porque es lo
que dice el plan— y el tráfico sigue. El criterio de aceptación era literalmente imposible de cumplir con
el orden documentado.

Se lee una **instantánea** al principio del tick y se pasa hacia abajo. No se vuelve a consultar en el
medio: si alguien apaga el interruptor a mitad de tick, el tick en curso termina y el siguiente no arranca,
que es el comportamiento predecible.

**`ads_rules_force_dry_run` NO corta el tick**: corta sólo las escrituras, y de eso se encarga T16 con
`dryRunEfectivo`. Son dos semánticas distintas y por eso son dos interruptores (D-A12):

| Interruptor | Qué corta |
|---|---|
| `ads_rules_enabled = false` | **todo**: ni sync, ni insights, ni escrituras |
| `ads_rules_force_dry_run = true` | **sólo las escrituras**: lee, evalúa y registra |

### Y el paso 10 imprime el contador de llamadas

`contadorLlamadas()` de T13 §6 devuelve cuántas veces se llamó a Meta en el tick, por cuenta. Imprimirlo
al final es lo que convierte el criterio §9.7 del plan en **un número que se mira** en lugar de una promesa
que se lee en el código. Con el interruptor apagado tiene que decir `0`.

**El worker no decide nada sobre las reglas.** No evalúa condiciones, no calcula presupuestos y no
llama a Meta para escribir: todo eso es de `lib/ads/reglas/ejecutor.ts`. Este archivo es cadencia,
exclusión mutua, backoff y avisos. Si te encontrás escribiendo lógica de reglas acá, está en el archivo
equivocado.

### El loop de `--daemon`

`setTimeout` recursivo, **no `setInterval`**: con `setInterval`, un tick que tarda 90 segundos se
solapa con el siguiente. Con `setTimeout` al final del tick, la próxima corrida arranca N segundos
**después de que terminó** la anterior.

Y el `catch` va **adentro del loop**: una excepción no manejada mata el proceso, PM2 lo reinicia, y si
el error es determinístico entrás en un ciclo de reinicios que llena el disco de logs. Un tick que
falla loguea y espera el siguiente.

Manejá `SIGTERM` y `SIGINT`: terminá el tick en curso, liberá el lease y salí con 0. Un `pm2 reload`
que mata el proceso a mitad de una escritura a Meta deja el `ad_actions` sin la fila y la campaña
cambiada.

## 3. El lease: dos motores no pueden correr juntos

El caso real: `pm2 reload` durante un deploy deja dos procesos solapados unos segundos, y **dos motores
en el mismo tick duplican cada acción** (dos subidas de presupuesto seguidas sobre el mismo conjunto).

### El bug de la versión anterior, que no se ve leyéndolo

El diseño anterior guardaba sólo el timestamp de la toma y usaba este `UPDATE` para tomar **y** renovar:

```sql
-- ESTO ESTÁ MAL. No lo implementes.
UPDATE settings SET value = to_jsonb(now()::text)
 WHERE key = 'ads_worker_lease'
   AND (value #>> '{}' = '' OR (value #>> '{}')::timestamptz < now() - interval '3 minutes')
```

Con vencimiento de 3 minutos y cadencia de 1 minuto, **el propio worker no puede renovar en el tick
siguiente**: su lease todavía no venció, así que el `WHERE` no matchea ninguna fila y el tick se descarta.

No hay excepción, ni log raro, ni nada que investigar: **la cadencia real pasa de 1 a 3 minutos, en
silencio y para siempre**. Y la prueba anterior no lo detectaba porque sólo hacía dos `UPDATE`
consecutivos, que es exactamente el caso que sí funciona.

### El lease con dueño

El valor de `settings.ads_worker_lease` es un objeto, y `{}` significa libre:

```json
{ "owner": "<pid>-<random>", "expires_at": "2026-08-12T14:32:10.123Z" }
```

El `owner` se genera **una vez al arrancar el proceso** (`${process.pid}-${randomUUID()}`) y vive en
memoria: es la identidad de esta instancia. El `randomUUID` no es paranoia, es para que un PID reciclado
después de un restart no herede el lease de un proceso muerto.

**Tomar o renovar** — la misma sentencia sirve para las dos cosas, y ahí está la diferencia:

```sql
UPDATE settings
   SET value = jsonb_build_object('owner', $1::text,
                                  'expires_at', (now() + interval '3 minutes')::text)
 WHERE key = 'ads_worker_lease'
   AND (   value->>'owner' IS NULL                        -- libre
        OR value->>'owner' = $1::text                     -- soy el dueño: renuevo
        OR (value->>'expires_at')::timestamptz < now())     -- ajeno y vencido
```

**Liberar** — compare-and-set por dueño, así un proceso no puede liberar el lease de otro:

```sql
UPDATE settings SET value = '{}'::jsonb
 WHERE key = 'ads_worker_lease' AND value->>'owner' = $1::text
```

Si el `rowCount` del primero es 1, tenés el lease. Si es 0, otro proceso vigente lo tiene y este tick no
corre.

**Se libera al terminar un tick normal, no sólo en `SIGTERM`.** Con el `owner` no sería estrictamente
necesario (el dueño puede renovar siempre), pero liberar hace que un `pm2 reload` no tenga que esperar el
vencimiento y que la fila sirva para ver desde el panel si hay un tick en curso.

**No lo hagas más corto que 3 minutos**: un tick lento con un sync de Meta adentro puede pasar el minuto, y
un lease que vence mientras el tick corre reintroduce exactamente el problema que resuelve. Con el `owner`
el vencimiento sólo importa para el caso del proceso muerto.

**El lease envuelve el tick completo, incluido el sync.** Si el sync quedara afuera, dos procesos podrían
escribir `ad_spend` a la vez y el motor decidiría sobre una foto a medias.

**Por qué esto y no `pg_try_advisory_lock`:** el lock de sesión de PostgreSQL vive atado a la conexión,
y `lib/db.ts` sólo expone `getPool`, `q`, `q1` y `tx` — no hay `getClient` ni `withClient`, así que no hay
dónde sostenerlo. La variante transaccional obligaría a tener un `BEGIN` abierto durante las llamadas a
Meta —que pueden tardar 30 segundos— y una transacción larga bloquea el autovacuum. Además, la fila se
puede mirar desde el panel para saber si el worker está vivo, y un lock no.

Las tres operaciones están probadas en `_verificacion-016.sql` §10, que ahora cubre renovación del propio
dueño, liberación ajena rechazada, liberación propia y recuperación de un lease vencido.

## 4. El backoff adaptativo: un minuto es agresivo

Con la cadencia que pidió el usuario son ~1.440 lecturas de insights por cuenta por día (P-A02). Los
límites de Meta son por cuenta publicitaria y por hora, y dependen del tier de la app. No se puede
saber de antemano si aguanta: **se mide y se afloja solo.**

`ultimoUso(accountId)` (lo dejó T13) devuelve `callCount`, `totalTime`, `totalCPUTime` —los tres son
porcentajes de 0 a 100— y `regainAccessAt`, del header `x-business-use-case-usage`.

**Lleva `accountId` y hay que usarlo así.** La versión anterior era `ultimoUso()` sin argumento, un `let`
global con "la última respuesta". Con dos cuentas eso rompe el backoff de la forma más silenciosa posible:
la cuenta A está al 92%, después llega una respuesta sana de la cuenta B, el valor se sobrescribe con el
12% de B, y el worker concluye que hay cuota de sobra y sigue golpeando a A hasta que Meta la corta. El
síntoma es "el backoff no funciona" y la causa está a tres archivos de distancia. **Consultá el uso por
cada cuenta que se tocó en el tick y tomá el peor.**

La política:

| Situación | Qué hace |
|---|---|
| cualquiera de los tres ≥ 75% en cualquier cuenta | el intervalo se multiplica por 5 (1 min → 5 min) |
| cualquiera ≥ 95% | se para 15 minutos |
| `regainAccessAt` viene con valor | se para hasta ese momento, sin discutir |
| error `17 / 2446079` o `613 / 1487742` | se para 15 min y se duplica en cada reincidencia, hasta 60 |
| dos ticks limpios seguidos por debajo del 50% | vuelve al intervalo normal |

### Esa política necesita CUATRO filas, no dos

"Se duplica en cada reincidencia hasta 60 minutos y se vuelve al intervalo normal después de dos ticks
limpios" **no cabe en un `until` y un `reason`**: al reiniciar PM2 se pierde en qué escalón del castigo
estaba y cuántos ticks limpios lleva, que es justo el estado que el backoff necesita recordar. Con dos
filas, la política documentada es inimplementable después del primer restart.

```
ads_backoff_until        hasta cuándo está frenado (timestamp o "")
ads_backoff_reason       el motivo, en castellano, para mostrar en el panel
ads_backoff_failures     reincidencias consecutivas → duración del castigo
ads_backoff_clean_ticks  ticks seguidos por debajo del 50% de cuota
```

El castigo se calcula desde `failures`, no desde un contador en memoria:

```ts
const minutos = Math.min(15 * 2 ** failures, 60);
```

Y `clean_ticks` se incrementa cuando el tick cierra por debajo del 50%, se resetea a 0 con cualquier
señal de saturación, y al llegar a 2 baja `failures` y vuelve el intervalo normal.

**Todo persistido, nada en memoria.** Un restart de PM2 con el estado en memoria borra el castigo y vuelve
a golpear la API en frío, que es exactamente cómo se pasa de "throttled un rato" a "bloqueado una hora".

### Distinguir los errores de cuota necesita el subcódigo

La tabla de arriba dice `17 / 2446079` y `613 / 1487742`: eso es `code / error_subcode`. **El subcódigo hay
que leerlo**, y `MetaAdsError` lo conserva a partir de T13 §4b (antes se descartaba). Sin él, un `17` de
cuota de usuario y otro `17` de cualquier otra cosa son indistinguibles, y el backoff castiga o perdona al
azar. Lo mismo con `is_transient`: es la diferencia entre "esperar y reintentar" y "parar y avisar".

`ads_backoff_reason` se escribe **en castellano**, porque se muestra en el panel:

```
Meta avisó 87% de uso de cuota en la cuenta act_1234567. Pausado hasta las 14:32.
```

## 5. El refresco del gasto: reusar, no reimplementar

El motor decide con las métricas del día, así que el gasto tiene que estar fresco. **Usá
`syncAdSpend` de `lib/ads/sync.ts` tal cual está.** Es idempotente por diseño (el upsert matchea la
clave única de `ad_spend`), ya maneja los errores por cuenta y ya congela la conversión a EUR.

**No la modifiques y no escribas otra.** Está en la lista de archivos que nadie de este módulo toca
(§8 del plan): es el camino por el que hoy entra el gasto de Resumen y de Ventas.

El TTL sale de `settings.ads_insights_ttl_seconds` (default 55). Con un tick de 60 segundos, eso es una
llamada por tick; si Meta aprieta, el usuario sube el TTL **desde el panel, sin desplegar**, y el worker
empieza a reusar el gasto de la base entre ticks.

**Sincronizá hoy y ayer**, como hace `lib/ads/live.ts`: Meta ajusta el gasto de ayer después del cierre,
y cuando la zona de la cuenta no es la de la tienda el "hoy" de Meta puede ser el ayer de acá.

Y **corré `rollupRange`** después, igual que `live.ts`: sin eso el gasto queda fresco en Anuncios y
viejo en Resumen, que lee de `daily_metrics`.

Nota que vale la pena dejar en un comentario: con el worker refrescando cada minuto,
`ensureFreshAdSpend` del render casi siempre va a encontrar el gasto fresco y no va a llamar a Meta.
Los dos caminos se ayudan en lugar de duplicarse.

## 6. `lib/ads/notificar.ts` — Telegram

```ts
export type MensajeAviso = { texto: string; urgente: boolean };

/** Arma el mensaje de un tick. null = no hay nada que avisar. */
export function armarAviso(resultados: ResultadoCorrida[]): MensajeAviso | null;

/** Manda por Telegram. Nunca tira: un aviso que falla no puede tumbar el worker. */
export async function avisar(m: MensajeAviso): Promise<{ enviado: boolean; error: string | null }>;
```

**`armarAviso` es pura** y por eso se puede testear. `avisar` habla con la red.

### Qué se avisa y qué no

Con un tick por minuto, avisar todo son 1.440 mensajes por día y el usuario silencia el chat en dos
horas. La regla: **se avisa lo que cambió algo o lo que falló.**

| Situación | ¿Avisa? |
|---|---|
| una acción real ejecutada | **sí** |
| una acción que falló (`ok: false`) | **sí**, urgente |
| el backoff se activó | **sí**, urgente, una vez (no en cada tick) |
| acciones simuladas (modo sombra) | **sí, pero agrupadas**: un resumen por hora, no por tick |
| ningún objeto cumplió | no |
| la regla no le tocaba correr | no |

El modo sombra agrupado es importante: es el día que el usuario va a usar para decidir si prende el
módulo, y quiere ver el resumen sin que le vibre el teléfono cada minuto.

### El mensaje

Texto plano o `MarkdownV2` con **el escapeado hecho bien** (los nombres de campaña traen `-`, `.`, `|`,
`(`, `)`, que en MarkdownV2 hay que escapar o la API devuelve 400 y el aviso se pierde). Si dudás, usá
texto plano: se lee igual y no se rompe nunca.

Reusá las `explicacion` que ya escribió T16 (§5 de ese task): **el panel y Telegram tienen que decir
exactamente lo mismo.** No armes un texto paralelo.

```
Panel · reglas · 14:32

✅ Apagar - Gasto +€4 sin ventas
Conjunto «PXN JEAN VAQUERO 11/08 - Copia» (act_1234567): gastó €4,37 hoy con 0
ventas → se pausó. Condición: gasto > €4,00 y ventas = 0. Estado anterior: ACTIVE.

⚠️ Duplicar a $75 - Gasto +$15 ROI +1.3
Conjunto «PXN BIDCAP» (act_1234567): no se pudo subir el presupuesto.
Meta: "Ad set budget is below the minimum" (code 100).
```

### `avisar` nunca tira

Un error de Telegram no puede tumbar el worker ni abortar un tick. Se captura, se loguea y se sigue.
Timeout de 10 segundos: la API de Telegram colgada no puede retrasar la próxima evaluación.

Si `ads_telegram_enabled` es `false` o falta el token o el chat id, devolvé
`{ enviado: false, error: null }` sin llamar a nada. **No es un error**: es la configuración por
defecto (D-A12).

## 7. `scripts/telegram-setup.ts` — la configuración sin editar archivos

El usuario pidió poner el bot token y el chat id con un script y que funcione. Interactivo:

```
npm run ads:telegram
```

1. Pide el **bot token** (el que da @BotFather). Lo lee **sin eco en la terminal** para que no quede en
   el historial de la shell.
2. Valida contra `GET /bot<token>/getMe`. Si no valida, lo pide de nuevo: no guarda un token roto.
3. Ofrece **descubrir el chat id solo**: le dice al usuario "mandale cualquier mensaje al bot ahora" y
   hace polling de `getUpdates` hasta que aparece un chat. Muestra el nombre del chat y pide confirmar.
   Esto es lo que hace que el script valga: buscar el chat id a mano es la parte molesta.
4. Permite pegarlo a mano como alternativa (para grupos o canales, donde `getUpdates` puede no verlo).
5. Guarda las tres filas en `settings` (`ads_telegram_bot_token`, `ads_telegram_chat_id`,
   `ads_telegram_enabled = true`) con el `setSetting` que ya existe en `app/api/config/_lib.ts`, o con
   el mismo `INSERT ... ON CONFLICT DO UPDATE`. **Ojo: `settings.value` es `jsonb`**, así que los
   strings van con `JSON.stringify`.
6. **Manda un mensaje de prueba** y no termina hasta que el usuario confirme que lo recibió. Un setup
   que dice "listo" sin haber entregado nada no sirve.
7. `--test` solo manda el mensaje de prueba con lo que ya está guardado.
8. **Nunca imprime el token**, ni parcial. Y si algún endpoint devuelve el valor de
   `ads_telegram_bot_token`, enmascaralo: es un secreto en una tabla que el panel puede leer.

### El tradeoff de guardar el token en Postgres, dicho de frente

D-A15 decidió `settings` y no el env porque el usuario pidió configurarlo con un script y porque cambiar
`.env.production` obliga a reiniciar PM2. La decisión se mantiene, pero **hay que escribir la consecuencia
en el runbook en lugar de dejarla implícita**: el token queda en texto plano en la base, así que **también
queda en los dumps de `pg_dump`** que el cron hace todas las noches a `/srv/panel/backups` y que se
retienen 14 días.

No se cifra en esta versión (una clave de cifrado que viva en el mismo servidor que la base no agrega
mucho, y una que viva afuera es otro sistema de gestión de secretos). Lo que sí se hace, y va en el §11:

- **rotación documentada**: cómo revocar el bot en @BotFather y volver a correr `npm run ads:telegram`;
- **enmascarado obligatorio** en cualquier endpoint y en cualquier log (el punto 8);
- **quién puede leer la base**: los backups no se copian fuera de la VPS sin cifrar.

Es un token de bot de Telegram, no el token de ads: el peor caso es que alguien mande mensajes al chat, no
que mueva presupuesto. Que el riesgo sea acotado es la razón por la que la decisión se mantiene; que esté
escrito es la razón por la que nadie se sorprende después.

## 8. `deploy/ecosystem.config.js` — el segundo proceso

Se **agrega** una app al array. La de `panel-3005` no se toca.

```js
{
  name: 'panel-reglas',
  // Mismo patrón que el cron: tsx NO lee .env solo, el flag de Node inyecta
  // las variables desde el .env.production que deploy.sh copió en current.
  script: './node_modules/.bin/tsx',
  args: 'scripts/run-ad-rules.ts --daemon',
  interpreter: 'node',
  node_args: '--env-file=.env.production',
  cwd: '/srv/panel/current',
  exec_mode: 'fork',
  instances: 1,          // NUNCA más de una. Ver el lease del §3.
  autorestart: true,
  // Sin esto, un bug determinístico en el primer tick produce un ciclo de
  // reinicios que llena /var/log/pm2 en horas.
  max_restarts: 10,
  min_uptime: '30s',
  restart_delay: 5000,
  max_memory_restart: '400M',
  out_file: '/var/log/pm2/panel-reglas.out.log',
  error_file: '/var/log/pm2/panel-reglas.err.log',
  time: true,
}
```

`instances: 1` no es una preferencia: con dos, los dos ticks se pelean por el lease y uno de cada dos
tick se pierde. Poné el porqué en un comentario, como el resto del archivo.

## 9. `deploy/cron.panel` — dos líneas

**No la del worker**: el worker es un proceso de PM2 (D-A13), no una línea de cron. Se agregan:

```cron
# Jerarquía de anuncios (T14). Cada 15 min: los nombres, estados y presupuestos
# cambian cuando el usuario toca el administrador de anuncios, y el gestor tiene
# que reflejarlo sin esperar al día siguiente. Es una llamada por cuenta y por
# nivel, así que 15 min es barato.
*/15 * * * * cd /srv/panel/current && /usr/bin/node --env-file=.env.production ./node_modules/.bin/tsx scripts/sync-ads-jerarquia.ts >> /var/log/panel/ads.log 2>&1

# Respaldo del worker: si PM2 quedó caído, esto avisa en el log. NO corre las
# reglas (eso duplicaría acciones): solo verifica el último tick.
*/30 * * * * cd /srv/panel/current && /usr/bin/node --env-file=.env.production ./node_modules/.bin/tsx scripts/run-ad-rules.ts --health >> /var/log/panel/ads.log 2>&1
```

Respetá el patrón que ya está en el archivo y que tiene su explicación arriba:
`cd /srv/panel/current && /usr/bin/node --env-file=.env.production ./node_modules/.bin/tsx`. `tsx` no
lee `.env` solo; el flag de Node inyecta las variables.

**El `--health` no corre reglas.** Solo mira `settings.ads_worker_last_tick` y, si tiene más de 5
minutos, loguea y manda un aviso por Telegram. Si corriera las reglas, tendrías dos motores y el lease
del §3 haría que uno se descarte, pero el diseño quedaría confuso: un solo lugar corre las reglas.

## 10. `deploy/deploy.sh` — sobre un sistema vivo

Leelo completo antes de tocarlo. Los cambios:

1. **`npm run db:migrate` antes de activar la release: YA ESTÁ HECHO, no lo agregues de nuevo.** Leé el
   script: el paso 4 migra y corre los tests contra `panel_test`, y el paso 6 ("Migración — ANTES de
   activar") migra producción antes del `mv -Tf` que mueve el symlink `current`. La versión anterior de
   este task presentaba esa secuencia como si fuera nueva, y el riesgo real de "agregarla" es duplicar la
   migración o moverla de lugar y perder la propiedad que ya tenés.

   Lo que sí hay que hacer es **preservar** ese orden y meter lo nuevo alrededor, no en el medio.

2. **`META_ADS_TOKEN` va en la lista `REQUIRED` del paso 3.** Hoy son cuatro variables (`DATABASE_URL`,
   `DASHBOARD_PASSWORD`, `NEXT_PUBLIC_SITE_URL`, `SHOPIFY_WEBHOOK_SECRETS`) y el token de ads no está: un
   deploy con la variable ausente pasa el guard y el worker falla en cada tick con un error de
   credenciales. T13 lo documentó en `.env.example` y te dejó la nota; el archivo es tuyo.

3. **`npm run ads:token` después de migrar y antes de arrancar el worker, CON EL ENTORNO INYECTADO.**
   Sale con 1 si el token no puede escribir (T13 §8), así que el deploy se detiene ahí en lugar de dejar un
   worker que va a fallar en cada tick.

   **Ojo con cómo se invoca: `tsx` no lee `.env.production` solo.** Un `npm run ads:token` pelado corre sin
   `META_ADS_TOKEN` y falla siempre, por la variable vacía y no por el permiso — el mismo modo de falla que
   el `.env` local. Seguí el patrón del cron:

   ```bash
   ( cd "$RELEASE" && /usr/bin/node --env-file=.env.production ./node_modules/.bin/tsx \
       scripts/verificar-token-ads.ts ) || { echo "el token no puede escribir"; exit 1; }
   ```

4. **`pm2 startOrReload`, no `pm2 reload`.** `pm2 reload panel-reglas` **falla si el proceso no existe**, y
   en el primer deploy no existe: el deploy se cae en el paso final por una razón que no tiene nada que ver
   con el código. La operación tiene que ser idempotente:

   ```bash
   pm2 startOrReload deploy/ecosystem.config.js --only panel-reglas --update-env
   ```

   `startOrReload` lo crea si falta y lo recarga si está. `--update-env` es lo que hace que un cambio en
   `.env.production` tome efecto. Y `reload` (no `restart`) para que el `SIGTERM` del §2 le dé al worker la
   chance de terminar el tick y liberar el lease.

5. **El worker se PARA durante la migración y se levanta después del health check.** Si el worker sigue
   corriendo mientras la migración aplica y el symlink se mueve, un tick puede quedar a mitad de camino
   entre dos schemas o ejecutando código viejo contra una release nueva. El orden es:

   ```
   pm2 stop panel-reglas   (si existe; ignorá el error si no)
     → migrar
     → activar la release (mv del symlink)
     → pm2 reload panel-3005 + health check
     → si el health check pasa:  pm2 startOrReload ... --only panel-reglas
     → si NO pasa:               rollback de la release Y el worker NO se levanta
   ```

   **El worker apagado durante un rollback es lo correcto**, no un efecto colateral: es un proceso que
   puede gastar plata, y ante un deploy dudoso el lado seguro es que no corra.

6. **El rollback tiene que cubrir los DOS procesos y la release como una unidad.** El `deploy.sh` actual
   revierte el symlink y recarga `panel-3005` cuando el health check falla. Con el worker en el ecosystem,
   ese mismo camino tiene que dejarlo parado o recargarlo apuntando a la release vieja. Un rollback que
   revierte la app y deja el worker corriendo código nuevo contra el schema o los archivos anteriores es
   peor que no tener rollback, porque el que gasta plata es el worker.

7. **El worker arranca apagado y eso es correcto.** `ads_rules_enabled` nace en `false` (D-A12): el
   proceso levanta, ve el interruptor apagado, loguea que está apagado y no hace **ni una llamada a Meta**
   (§2 paso 1). El usuario lo prende desde el panel cuando quiera. **No lo prendas en el deploy.**

8. **Probá el primer deploy, no sólo el redeploy.** Los dos casos que hay que ejercitar y que la versión
   anterior de este task no cubría: `panel-reglas` no existe todavía, y el health check falla. Están en la
   verificación 10b.

## 11. `docs/runbook-anuncios.md`

Corto y operativo, no un ensayo. El molde es `docs/runbook.md`, que ya existe. Seis secciones:

1. **Cómo prender el módulo por primera vez.** El orden importa y es el argumento de venta de todo el
   diseño:
   ```
   0. verificar el techo absoluto          → ads_max_daily_budget_eur, que arranca
                                             en €200. Si tus reglas necesitan más,
                                             subilo A PROPÓSITO con un UPDATE, no
                                             descubras el rechazo en producción
   1. npm run ads:token                    → confirmar que el token escribe
   2. npm run ads:jerarquia                → cargar campañas, conjuntos y anuncios
   3. npm run ads:telegram                 → configurar el bot (opcional)
   4. crear las reglas en /anuncios/reglas → nacen apagadas y en sombra
   5. prender ads_rules_enabled            → el worker empieza a evaluar
   6. DEJAR ads_rules_force_dry_run EN true POR 24 HORAS
   7. leer /anuncios/historial             → ver qué HABRÍA hecho
   8. recién ahí, apagar force_dry_run     → el módulo empieza a actuar
   ```

   El paso 0 es nuevo y evita el escenario más frustrante: prender todo, ver que la escalera no sube nada, y
   tardar en darse cuenta de que las decisiones salen omitidas con `tope_absoluto`. El default de €200 es
   deliberadamente bajo (D-A9c) y la regla «Duplicar a $150» del seed entra justo abajo.
2. **Cómo apagar todo, ya.** Un `UPDATE` de una línea sobre `ads_rules_enabled`, y el `pm2 stop
   panel-reglas` como plan B. Que esté escrito y se pueda copiar y pegar a las 3 de la mañana.
3. **Qué mirar cuando algo raro pasa:** `ad_rule_runs`, `ad_actions` con `ok = false`,
   `ad_rules.last_run_error`, `ads_backoff_reason`, `ads_worker_last_tick`, y
   `pm2 logs panel-reglas`. En ese orden.
4. **Los errores de Meta que se van a ver** y qué significan: `190` token vencido, `200` sin permiso,
   `17`/`613` cuota, `100` presupuesto inválido o bajo el mínimo.
5. **Cómo revertir una acción de una regla.** No hay "undo": se lee la `explicacion` y el
   `before_value` de `ad_actions` y se restaura a mano desde el gestor. Decilo explícito.

   Y el caso que hay que saber leer: una fila con `estado = 'indeterminado'` significa que el POST cortó
   por timeout y **no se sabe si se aplicó**. No la revirtas a ciegas: el reconciliador le pregunta a Meta
   en el tick siguiente y la cierra. Si tenés que actuar antes, mirá el objeto en el administrador de
   anuncios, no en el panel.

6. **Los límites conocidos:** el gasto tiene el lag de Meta, las ventas el del webhook de Shopify, y el
   día se corta en la zona de la cuenta y no en la del funnel (D-A10), así que los números de Anuncios
   no coinciden exactamente con los de Ventas. Escribilo para no volver a investigarlo.

   Agregá los que salieron de la revisión técnica, con su número de pregunta abierta:

   - **el gasto que Meta corrige a la baja no se limpia** (P-A07): `syncAdSpend` filtra `spend > 0` y nunca
     pone en cero una fila que dejó de venir, así que las reglas con período de 7 días pueden ver plata que
     ya no existe. T15 dejó medido cuánto es;
   - **una regla no puede abarcar cuentas en zonas horarias distintas** (P-A09): se omite con un motivo
     explícito en lugar de calcular mal;
   - **sólo cuentas en EUR y sólo presupuesto diario** (D-A10): los objetos con presupuesto total se ven
     pero no se automatizan;
   - **un lote no es atómico** (§6c del plan): si 3 de 10 fallan, 7 quedaron aplicadas;
   - **el panel no sabe quién hizo cada cosa** (P-A12): contraseña compartida, sin roles. `actor_hint`
     guarda IP y request id, que no es una identidad;
   - **la versión de la Graph API** (P-A10): `v21.0` muere alrededor de principios de 2027 y la fecha exacta
     no está confirmada. Se cambia con `META_API_VERSION`, y subirla NO es cambiar el prefijo de la URL.

7. **Rotación del bot token de Telegram** (§7). Está en la base en texto plano, así que también está en los
   dumps de `pg_dump` de `/srv/panel/backups`. Cómo revocarlo en @BotFather y volver a correr
   `npm run ads:telegram`.

## 12. Verificación

Nada de esto es opcional. **Todo se prueba en local antes de tocar la VPS.**

```bash
cd ~/Desktop/funnel/dashboard-admin
export PSQL="docker exec panel-db-1 psql -U panel -d panel"

# 1 — compila y los tests pasan
npx tsc --noEmit && npm run build && npm test

# 2 — EL FRENO GENERAL: con el interruptor apagado, CERO LLAMADAS A META.
#     No alcanza con que no escriba filas: el criterio §9.7 del plan dice "ni una
#     llamada", y con el orden anterior del tick el worker igual pedía insights.
$PSQL -c "UPDATE settings SET value='false'::jsonb WHERE key='ads_rules_enabled';"
npm run ads:reglas 2>&1 | tee /tmp/tick-apagado.log
$PSQL -tAc "SELECT count(*) FROM ad_actions WHERE created_at > now() - interval '2 min';"
# esperado exactamente: 0
grep -i "apagad" /tmp/tick-apagado.log      # el log tiene que decir que está apagado
grep -iE "llamadas a meta: *0|contadorLlamadas.*0" /tmp/tick-apagado.log
# EL NÚMERO TIENE QUE SER 0. Es el paso 10 del §2: el tick imprime
# contadorLlamadas() de T13. Si dice cualquier otra cosa, el interruptor NO se está
# leyendo antes del sync y el criterio del plan no se cumple.
$PSQL -tAc "SELECT value FROM settings WHERE key='ads_worker_lease';"
# esperado: {} — un tick que sale por el interruptor no se queda con el lease

# 3 — EL LEASE: dos ticks simultáneos, solo uno corre
$PSQL -c "UPDATE settings SET value='{}'::jsonb WHERE key='ads_worker_lease';"
$PSQL -c "UPDATE settings SET value='true'::jsonb WHERE key='ads_rules_enabled';"
(npm run ads:reglas & npm run ads:reglas & wait) 2>&1 | grep -ci "lease"
# uno de los dos tiene que decir que no consiguió el lease y salir.
# Si los dos corren, el §3 no está implementado y las acciones se van a duplicar.

# 3b — EL BUG QUE ESTA VERIFICACIÓN ANTES NO VEÍA: que el propio worker RENUEVE.
#      Con el lease sin dueño y vencimiento de 3 minutos, el mismo proceso no podía
#      renovar en el tick siguiente y la cadencia real pasaba de 1 a 3 minutos, en
#      silencio. Dos ticks consecutivos del MISMO proceso tienen que correr los dos.
$PSQL -c "UPDATE settings SET value='{}'::jsonb WHERE key='ads_worker_lease';"
npm run ads:reglas 2>&1 | grep -c "tick" ; sleep 5 ; npm run ads:reglas 2>&1 | grep -c "tick"
# los DOS tienen que reportar que corrieron. Si el segundo dice que no consiguió el
# lease, estás con el diseño viejo.
#
# Y el lease tiene que tener dueño y vencimiento, no un timestamp pelado:
$PSQL -tAc "SELECT value FROM settings WHERE key='ads_worker_lease';"
# esperado: {} después de un tick que terminó bien (se libera, §3), o
#           {"owner":"1234-uuid","expires_at":"..."} durante un tick en curso.
# Si es un string con una fecha suelta, el §3 no está implementado.

# 3c — nadie puede liberar el lease de otro
$PSQL -c "UPDATE settings SET value='{\"owner\":\"otro-proceso\",\"expires_at\":\"2099-01-01T00:00:00Z\"}'::jsonb WHERE key='ads_worker_lease';"
npm run ads:reglas 2>&1 | grep -ci "lease"
$PSQL -tAc "SELECT value->>'owner' FROM settings WHERE key='ads_worker_lease';"
# esperado: otro-proceso — el tick no consiguió el lease Y NO lo pisó ni lo liberó
$PSQL -c "UPDATE settings SET value='{}'::jsonb WHERE key='ads_worker_lease';"

# 4 — el backoff se respeta
$PSQL -c "UPDATE settings SET value=to_jsonb((now() + interval '10 min')::text)
           WHERE key='ads_backoff_until';"
$PSQL -c "UPDATE settings SET value='\"prueba manual\"'::jsonb WHERE key='ads_backoff_reason';"
npm run ads:reglas 2>&1 | tee /tmp/tick-backoff.log
# esperado: sale sin llamar a Meta y dice hasta cuándo está frenado
grep -iE "llamadas a meta: *0" /tmp/tick-backoff.log    # también acá tiene que ser 0
$PSQL -c "UPDATE settings SET value='\"\"'::jsonb WHERE key='ads_backoff_until';"

# 4b — EL CASTIGO SOBREVIVE A UN RESTART, incluido el ESCALÓN (§4)
#      Es lo que las dos filas viejas no podían: "se duplica en cada reincidencia y
#      vuelve al normal después de dos ticks limpios" necesita recordar en qué
#      escalón estaba y cuántos ticks limpios lleva.
$PSQL -c "SELECT key, value FROM settings WHERE key LIKE 'ads_backoff%' ORDER BY key;"
# esperado 4 filas: ads_backoff_clean_ticks, ads_backoff_failures,
#                   ads_backoff_reason, ads_backoff_until
# Si sólo hay dos (until y reason), la política del §4 no se puede implementar y
# después de cada `pm2 restart` el backoff arranca de cero y golpea la API en frío.

# Simulá una reincidencia y verificá que el castigo crece:
$PSQL -c "UPDATE settings SET value='2'::jsonb WHERE key='ads_backoff_failures';"
# Con failures=2 el castigo tiene que ser min(15 * 2^2, 60) = 60 min, no 15.
# Provocá un error de cuota o forzalo desde un test y mirá ads_backoff_until.
$PSQL -c "UPDATE settings SET value='0'::jsonb WHERE key='ads_backoff_failures';"
$PSQL -c "UPDATE settings SET value='0'::jsonb WHERE key='ads_backoff_clean_ticks';"

# 4c — el uso de cuota se lee POR CUENTA, no "la última respuesta" (§4)
npx tsx -e "
  import('./lib/ads/meta').then(async (m) => {
    // Tocá las dos cuentas y verificá que cada una tiene su propio uso.
    const cuentas = process.env.CUENTAS!.split(',');
    for (const c of cuentas) { await m.fetchCampaigns(c); }
    for (const c of cuentas) { console.log(c, JSON.stringify(m.ultimoUso(c))); }
  });
"
# Cada cuenta tiene que devolver su propio objeto, NO el mismo valor las dos.
# Con un `let` global, la respuesta sana de la segunda cuenta tapa la saturación de
# la primera y el worker sigue golpeándola hasta que Meta la corta.

# 5 — el health check detecta un worker parado
$PSQL -c "UPDATE settings SET value=to_jsonb((now() - interval '20 min')::text)
           WHERE key='ads_worker_last_tick';"
npm run ads:reglas -- --health
# esperado: avisa que el último tick fue hace 20 minutos, y exit != 0

# 6 — el daemon corre, hace más de un tick, y muere limpio
#     `timeout` es de GNU coreutils. En esta máquina está (viene de homebrew) pero no
#     es parte de macOS base, así que el fallback está al lado por si falta.
if command -v timeout >/dev/null; then
  timeout 150 npx tsx scripts/run-ad-rules.ts --daemon 2>&1 | tail -20
else
  npx tsx scripts/run-ad-rules.ts --daemon 2>&1 | tail -20 & P=$!; sleep 150; kill -TERM $P; wait $P
fi
$PSQL -tAc "SELECT value FROM settings WHERE key='ads_worker_last_tick';"
# esperado: al menos 2 ticks en 150 s, y last_tick actualizado.
# Que un tick que falla NO mate el proceso es lo que se está probando.
#
# Y ojo con el número: son 150 s para ver DOS ticks de 60 s. Si ves uno solo, mirá
# el lease (verificación 3b) antes de culpar al setTimeout: con el diseño viejo la
# cadencia efectiva era de 3 minutos y en 150 s entraba un tick.

# 6b — el SIGTERM libera el lease (§2 y §3)
npx tsx scripts/run-ad-rules.ts --daemon & P=$!
sleep 20 && kill -TERM $P && wait $P
$PSQL -tAc "SELECT value FROM settings WHERE key='ads_worker_lease';"
# esperado: {} — si quedó con owner, un `pm2 reload` deja el lease tomado y el
# proceso nuevo pierde hasta 3 minutos esperando el vencimiento.

# 7 — Telegram: el setup valida y entrega
npm run ads:telegram
# seguí el flujo completo. TIENE que llegarte el mensaje de prueba al teléfono.
npm run ads:telegram -- --test
# esperado: un segundo mensaje

# 8 — el token NO quedó en ningún log ni en el historial de la shell
$PSQL -tAc "SELECT key FROM settings WHERE key LIKE 'ads_telegram%';"   # las 3 filas
history | grep -i "bot[0-9]" || echo "el token no quedó en el historial: OK"

# La versión anterior de esta verificación tenía un bug de shell: empezaba con
# `$(($PSQL ...`, y `$((` abre una EXPANSIÓN ARITMÉTICA, así que la línea moría con
# un error de sintaxis en lugar de buscar nada. Se arregla usando una variable:
PREFIJO=$($PSQL -tAc "SELECT left(value #>> '{}', 10) FROM settings WHERE key='ads_telegram_bot_token'")
if [ -n "$PREFIJO" ]; then
  grep -rF "$PREFIJO" /var/log 2>/dev/null | head -3 \
    && echo "MAL: el token aparece en los logs" \
    || echo "no aparece en los logs: OK"
else
  echo "no hay token configurado todavía: salteado"
fi
# `grep -F` y no `grep -r` pelado: un token puede contener caracteres que se
# interpretan como regex.

# 9 — avisar() no tira cuando está mal configurado
$PSQL -c "UPDATE settings SET value='false'::jsonb WHERE key='ads_telegram_enabled';"
npx tsx -e "
  import('./lib/ads/notificar').then(async (m) => {
    const r = await m.avisar({ texto: 'prueba', urgente: false });
    console.log('deshabilitado →', JSON.stringify(r));  // { enviado: false, error: null }
  });
"
$PSQL -c "UPDATE settings SET value='\"token-roto\"'::jsonb WHERE key='ads_telegram_bot_token';"
$PSQL -c "UPDATE settings SET value='true'::jsonb WHERE key='ads_telegram_enabled';"
npx tsx -e "
  import('./lib/ads/notificar').then(async (m) => {
    const r = await m.avisar({ texto: 'prueba', urgente: true });
    console.log('token roto →', JSON.stringify(r));     // enviado:false con error, SIN tirar
  });
"
# después volvé a correr npm run ads:telegram para dejar el token bueno

# 10 — los artefactos de deploy son válidos
node -e "const c=require('./deploy/ecosystem.config.js');
  console.log('apps:', c.apps.map(a=>a.name).join(', '));
  const w=c.apps.find(a=>a.name==='panel-reglas');
  console.log('instances:', w.instances, '(tiene que ser 1)');
  console.log('node_args:', w.node_args);"
bash -n deploy/deploy.sh && echo "deploy.sh: sintaxis OK"

# `crontab -T` es de algunas distros de Linux y NO existe en macOS (verificado:
# "illegal option -- T"). El awk es el chequeo portable y siempre corre.
awk 'NF && $1 !~ /^#/ { if (NF < 6) print "MAL " $0 }' deploy/cron.panel \
  | grep . && echo "cron.panel: hay líneas mal formadas" \
  || echo "cron.panel: todas las líneas tienen 5 campos de tiempo + comando"

# 10b — LOS CAMBIOS DE deploy.sh, revisados a mano contra el §10
grep -n "META_ADS_TOKEN" deploy/deploy.sh
# tiene que estar en la lista REQUIRED del paso 3 (§10.2). Sin eso, un deploy sin
# la variable pasa el guard y el worker falla en cada tick.

grep -nE "pm2 (startOrReload|reload|stop) .*panel-reglas" deploy/deploy.sh
# TIENE que decir `startOrReload`, no `reload` pelado (§10.4): `pm2 reload` FALLA si
# el proceso no existe, y en el primer deploy no existe. El deploy se caería en el
# último paso por algo que no tiene nada que ver con el código.

grep -n "ads:token\|verificar-token-ads" deploy/deploy.sh
# tiene que invocarse con --env-file=.env.production (§10.3): `tsx` no lee el .env
# solo, así que un `npm run ads:token` pelado corre sin META_ADS_TOKEN y falla
# SIEMPRE, por la variable vacía y no por el permiso.

grep -n "db:migrate" deploy/deploy.sh
# tienen que seguir siendo DOS (el de panel_test en el paso 4 y el de producción en
# el paso 6, antes del `mv -Tf`). Si aparece una tercera, la duplicaste: el script
# YA migraba antes de activar y este task sólo tiene que preservarlo (§10.1).

# 10c — el primer deploy y el rollback, que son los dos casos que faltaban (§10.8)
#       Esto se prueba EN LA VPS y con cuidado. Leé el runbook antes.
#   a) primer deploy: `pm2 delete panel-reglas` (si existe) y deploy completo.
#      El deploy NO tiene que fallar por el proceso inexistente.
#   b) health check en rojo: rompé el health check a propósito (por ejemplo apuntá
#      el chequeo a un puerto equivocado en una copia del script) y verificá que
#      el rollback revierte el symlink Y DEJA EL WORKER PARADO.
#      Un rollback que revierte la app y deja el worker corriendo código nuevo
#      contra la release vieja es peor que no tener rollback: el que gasta plata es
#      el worker.
pm2 list
# después de un rollback: panel-3005 online, panel-reglas stopped.

# 11 — el runbook está completo
grep -c "^## " docs/runbook-anuncios.md      # esperado: 6
grep -n "ads_rules_force_dry_run" docs/runbook-anuncios.md   # el paso 6 del §11 tiene que estar

# 12 — dejar todo en el lado seguro
$PSQL -c "UPDATE settings SET value='false'::jsonb WHERE key='ads_rules_enabled';"
$PSQL -c "UPDATE settings SET value='true'::jsonb  WHERE key='ads_rules_force_dry_run';"
$PSQL -c "UPDATE settings SET value='{}'::jsonb    WHERE key='ads_worker_lease';"
$PSQL -c "UPDATE settings SET value='\"\"'::jsonb   WHERE key='ads_backoff_until';"
$PSQL -c "UPDATE settings SET value='0'::jsonb     WHERE key='ads_backoff_failures';"
$PSQL -c "UPDATE settings SET value='0'::jsonb     WHERE key='ads_backoff_clean_ticks';"
$PSQL -c "DELETE FROM ad_actions WHERE rule_name LIKE 'PRUEBA%';"
# El lease vuelve a '{}' (objeto vacío), NO a '""': el formato nuevo es un objeto
# con owner y expires_at (§3).

# 13 — no se tocó nada de lo existente
# `git diff` NO SIRVE en este proyecto: `dashboard-admin` no esta trackeado
# en el repo git del padre (~/Desktop/funnel solo trackea .kiro y funnel-mate),
# asi que TODOS los archivos son untracked y el diff sale vacio o inutil.
# Verificado. El chequeo que si funciona es por fecha de modificacion:
find . -newermt '-3 hours' -type f \
  -not -path './node_modules/*' -not -path './.next/*' -not -path './.git/*' \
  -not -name '*.log' -not -name 'tsconfig.tsbuildinfo' | sort
```

## 13. Cuándo parar

**Bloqueante, pará y avisá:**

- **La verificación 3 muestra los dos ticks corriendo.** Sin el lease, un `pm2 reload` duplica cada
  acción. Es plata, dos veces.
- **La verificación 3b muestra que el segundo tick del mismo proceso no consiguió el lease.** Estás con el
  diseño sin dueño: la cadencia real es de 3 minutos y no de 1, sin ningún error que lo diga.
- **La verificación 2 llama a Meta con el interruptor apagado** (el contador no da 0). El criterio §9.7 del
  plan es lo que le permite al usuario creer que apagar las reglas aísla Meta. Si no se cumple, hay que
  arreglarlo o cambiar lo que el plan promete: lo que no se puede es prometer una cosa y hacer otra.
- La verificación 6: el daemon muere en el primer tick con error, o no hace un segundo tick.
- **La verificación 10b muestra `pm2 reload panel-reglas` en lugar de `startOrReload`.** El primer deploy
  se va a caer en el último paso por un proceso que todavía no existe.
- **El `find` de la verificación 13 lista `lib/ads/sync.ts` o `lib/ads/live.ts`.** Son el camino por el que hoy entra el gasto de
  Resumen y Ventas: si los rompés, se rompen dos pantallas que hoy funcionan.
- `npm run ads:token` falla. No dejes un worker desplegado apuntando a un token que no puede escribir.
  **Y antes de concluir que falla, verificá que el entorno esté inyectado** (§10.3): un `npm run ads:token`
  sin `--env-file` corre sin `META_ADS_TOKEN` y falla siempre, por la variable vacía y no por el permiso.

**Anotalo en §10 del plan y seguí:**

- **Cuánta cuota consume un tick.** Corré el daemon 10 minutos y anotá los tres porcentajes de
  `ultimoUso()`. Es el dato que decide si un minuto es sostenible (P-A02) y no lo tenemos.
- Meta responde `17` o `613` durante las pruebas. Anotá a los cuántos ticks pasó: es la respuesta
  empírica a P-A02 y probablemente haya que subir `ads_insights_ttl_seconds`.
- Un tick tarda más de 60 segundos. Anotá cuánto y con cuántas reglas: el `setTimeout` del §2 lo
  absorbe, pero la cadencia efectiva ya no es de un minuto y el usuario tiene que saberlo.
- `getUpdates` no encuentra el chat (pasa con grupos y canales). El script tiene que dejar pegarlo a
  mano; anotá el caso en el runbook.
- El `crontab -T` no existe en macOS (verificado: `illegal option -- T`). La verificación 10 ya usa el
  `awk` portable directamente; si estás en Linux y `crontab -T` existe, corrélo además.
- **Cuántas veces `reconciliar()` encontró filas para cerrar** (§2 paso 4). Si es siempre 0, el camino de
  escritura está sano. Si aparece seguido, hay timeouts contra Meta y conviene mirar la latencia antes de
  subir la cadencia.
- **Cuántas filas escribe un tick en `ad_actions`.** Es el insumo del plan de retención que el módulo
  todavía no tiene (§11 del plan): la tabla crece sin purga.
