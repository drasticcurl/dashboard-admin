# Prompts para Claude Code — módulo de Anuncios

Cómo correr las 7 tasks. Un prompt por task, listo para pegar.

---

## Antes de arrancar

```bash
cd ~/Desktop/funnel/dashboard-admin/tasks/anuncios && ls
# 00-PLAN-ANUNCIOS.md   ← el documento maestro
# T13 … T19             ← las siete tasks
# _schema-016.sql       ← el DDL completo, YA probado contra PostgreSQL 16
# _verificacion-016.sql ← 10 pruebas de lógica, YA corridas y en verde
```

```bash
# y el origen de las reglas que trae el seed:
# _reglas-utmify.csv    ← el export real de las 6 reglas del usuario en Utmify
```

Los dos `.sql` no son documentación: son ejecutables. El DDL del módulo **ya se corrió** contra un
Postgres 16 con las migraciones 001-015 aplicadas (limpio e idempotente), y las 11 afirmaciones de las
que depende el diseño **ya están verificadas**: que los `CHECK` rechacen una regla de subir presupuesto
sin techo, que una regla nazca apagada y en sombra, la extracción del id de Meta desde el UTM con y sin
espacios, **que el día no sea el mismo en la zona del funnel y en la de la cuenta**, la aritmética del
presupuesto en céntimos, que las acciones simuladas no consuman el cooldown, que borrar una regla no
borre su historial, que el lease del worker sea atómico, y **que las seis reglas del usuario se hayan
traducido bien del export de Utmify**. T13 los usa como punto de partida en lugar de tipear el DDL de
nuevo.

### Cinco cosas que hay que saber antes de largar el primer agente

**1. T13 va sola y primero.** Crea el schema y `lib/ads/tipos.ts`, que es el archivo que importan las
otras seis y que ninguna puede modificar. Si arrancás otra en paralelo con T13, va a escribir contra
tipos que no existen.

**2. Lo primero que hace T13 puede detener el proyecto entero.** El `META_ADS_TOKEN` tiene `ads_read`
demostrado, pero **`ads_management` no está verificado** (P-A01). Escribir en Meta es otro permiso y
además el usuario del sistema tiene que tener la cuenta asignada como administrador, no como analista.
T13 §2 lo prueba con una escritura que no cambia nada: poner en `PAUSED` una campaña **que ya está
pausada**. Si eso falla, **pará todo**: no tiene sentido construir seis tasks encima de una escritura
que no se puede hacer.

**3. El panel está en producción con ventas reales, en la VPS.** La migración es aditiva a propósito: ni
un `DROP`, ni un `ALTER` que reescriba una tabla. Cada task tiene en su verificación un paso que
compara los conteos de `ad_spend` y `orders` antes y después. Si cambian, se revierte.

**4. Este módulo escribe en la cuenta publicitaria.** Puede subir presupuestos y puede apagar la
facturación. Todos los defaults están del lado seguro (`ads_rules_enabled = false`,
`ads_rules_force_dry_run = true`, cada regla nace apagada y en sombra) y **hay tres verificaciones
distintas que prueban que el modo sombra no toca Meta**: T16 §8.4(e), T19 §7.7 y el criterio 6 del §9
del plan. Ninguna es opcional.

**4b. La migración trae cargadas las seis reglas reales del usuario**, traducidas 1:1 de su export de
Utmify. Nacen apagadas y en sombra. Tres cosas que se rompen fácil al traducir y que el SQL **ya
resolvió** (no las "arreglen"): los montos van en **EUR y no en céntimos** (Utmify guarda 1000 para
€10,00), el porcentaje es **250 con semántica de factor ×2,5** y no de incremento (D-A9), y la condición
`approvedSales < 0` del export —que con ventas enteras no se puede cumplir nunca— se cargó como
`sales = 0` (P-A05).

**4c. Los cuatro interruptores se cambian desde la web, ninguno es un env var** (D-A12b, pedido
explícito del usuario). Los dos globales van en `settings` y los dos por regla en `ad_rules`; T19 escribe
la UI y el endpoint `/api/ads/interruptores`. El worker los lee **en cada tick**, así que apagar las
reglas toma efecto en la corrida siguiente sin reiniciar nada.

**5. El plan es el contrato.** `00-PLAN-ANUNCIOS.md` §3 (schema), §4 (métricas), §5 (motor), §6
(escritura a Meta) y §8 (qué archivos puede tocar cada task) son lo que evita que tres agentes en
paralelo produzcan piezas que no encajan. Ningún agente lo modifica; si necesita algo que no está, lo
anota en §10.

## El orden

```
Paso 1   T13                      1 agente, SOLO
Paso 2   T14 · T15 · T16          3 agentes en paralelo
Paso 3   T17 · T18 · T19          3 agentes en paralelo
```

**El límite no es la cantidad de agentes, son las dependencias.** Con 5 slots disponibles y máximo 3
tareas paralelas por ola, hay margen de sobra. **No fuerces un cuarto agente en una ola:** lo único que
se consigue es un task que no puede correr su verificación, y un task sin verificación corrida no está
terminado.

**Por qué se puede paralelizar sin que se pisen:** §8 del plan le asigna a cada task un conjunto de
archivos exclusivo, y **T13 declara todos los scripts de `package.json`** de una sola vez (apuntando a
archivos que T14, T16 y T18 crean después), así que nadie más toca ese archivo. Ni una dependencia nueva
de npm en todo el módulo.

**Por qué T16 no depende de T15 aunque use sus métricas:** T13 declara el tipo `MetricasObjeto` y la
firma de `getMetricasAds` en `lib/ads/tipos.ts`. T16 evalúa contra el **tipo** y sus tests construyen
las filas a mano. Es el mismo truco por el que T04 pudo importar `lib/fx.ts` mientras T03 lo
implementaba.

**Por qué T17 sí depende de T15:** una pantalla que muestra métricas no se puede verificar sin las
métricas.

**Si preferís ir de a uno:** `T13` → `T15` → `T16` → `T14` → `T17` → `T19` → `T18`. Ese orden deja para
el final todo lo que escribe en Meta sin supervisión.

**Lo que no se puede:** dos tasks del mismo paso escribiendo el mismo archivo. Si un agente te dice que
necesita editar algo que no está en su fila de §8, la respuesta es no: que lo anote en §10.

---

## Preámbulo (va al inicio de cada prompt)

> Trabajás en `~/Desktop/funnel/dashboard-admin`, un panel de tracking y ventas que **ya está en
> producción** en `https://panel.hilvanapp.com`, con PostgreSQL propio en una VPS y ventas reales
> entrando por webhook. Estás agregando un módulo de **Anuncios**: gestor de campañas de Meta y motor de
> reglas de automatización.
>
> Leé estos archivos completos antes de escribir código, en este orden:
> 1. `tasks/anuncios/00-PLAN-ANUNCIOS.md` — el documento maestro. §3 es el schema, §4 §5 y §6 son
>    contratos congelados, §8 dice qué archivos podés tocar, §10 es donde se anotan las dudas.
> 2. `tasks/anuncios/<TU-TASK>.md` — tu tarea.
>
> Contexto que te ahorra tiempo: **ya existe una integración con la Marketing API de Meta, de solo
> lectura y funcionando en producción** (`lib/ads/meta.ts`, `lib/ads/sync.ts`, `lib/ads/live.ts`, tablas
> `ad_accounts` y `ad_spend`). Este módulo la extiende a lectura+escritura. No la reescribas.
>
> Reglas que no se negocian:
> - **Solo escribís los archivos de tu fila en §8 del plan.** Otros agentes están trabajando en
>   paralelo sobre los otros archivos. Si creés que necesitás tocar uno ajeno, no lo toques: anotalo en
>   §10 del plan con el formato que está ahí.
> - **Hay una lista de archivos que NADIE toca** (§8 del plan): `components/ui.tsx`, `lib/ads/sync.ts`,
>   `lib/ads/live.ts`, `lib/queries/sales.ts`, `lib/db.ts`, `middleware.ts`, `app/api/config/**` y las
>   migraciones 001-015. Son caminos que hoy funcionan con plata real.
> - **No instalás dependencias ni editás `package.json`.** T13 declaró todo lo necesario. Si te falta un
>   paquete, va a §10.
> - **No cambiás el schema ni los contratos** de §4, §5 y §6. Están congelados porque otras tasks se
>   escriben contra ellos al mismo tiempo. `lib/ads/tipos.ts` es de T13 y nadie más lo modifica.
> - **Si aparece una decisión que el plan no resuelve, no la decidís en el código**: la anotás en §10.
>   Si bloquea, parás y me avisás.
> - Todo el SQL va con parámetros (`$1`, `$2`), nunca concatenando valores.
> - Todo en castellano: comentarios, UI, mensajes. Locale `es-AR` en los `Intl`.
> - Los comentarios explican **por qué**, no qué. El estilo de referencia son las migraciones del
>   proyecto y `lib/ads/live.ts`: explican el bug que la decisión evita.
> - **Al terminar, corré la sección de Verificación de tu task COMPLETA y pegame la salida.** Si algo
>   falla, arreglalo antes de decir que terminaste. "Compila" no es verificación.

---

## Paso 1 — una sola, y puede detener todo

### T13 — Fundación de anuncios

> [preámbulo, con `<TU-TASK>` = `T13-fundacion-anuncios.md`]
>
> Ejecutá T13 completa: la migración 016 (copiando `_schema-016.sql` tal cual), `lib/ads/tipos.ts` con
> los tres contratos, la extensión de `lib/ads/meta.ts` con la lectura de jerarquía y la escritura de
> estado y presupuesto, `scripts/verificar-token-ads.ts`, y los scripts de `package.json`.
>
> **Empezá por §2 y no escribas nada hasta resolverlo.** El `META_ADS_TOKEN` tiene `ads_read`
> demostrado, pero `ads_management` **no está verificado**. La prueba es una escritura que no cambia
> nada: poner en `PAUSED` una campaña que ya está pausada. Si devuelve el error 200 (Missing
> Permissions) o el 190, **pará, anotá en P-A01 y avisame**: el diseño de las reglas puede tener que
> cambiar y no tiene sentido construir seis tasks encima.
>
> Cuatro cosas con atención especial:
> - **`lib/ads/tipos.ts` lo van a importar seis tasks y ninguna lo va a poder modificar.** Tiene que
>   quedar completo, con todas las firmas de §4, §5 y §6 del plan, aunque este task no use ninguna.
> - **No te olvides del stub de `lib/queries/ads.ts`** (§4 del task). Es la única excepción a la
>   exclusividad de archivos del plan: sin él, T16 no compila porque importa una función de un archivo
>   que T15 todavía no escribió. El cuerpo tiene que **tirar** un Error, no devolver un array vacío.
> - **El token de escritura va en el header `Authorization: Bearer`, no en el query string.** El código
>   de lectura actual lo pone en la URL; para las llamadas que apagan campañas no alcanza, porque las
>   URLs terminan en logs de acceso y en mensajes de error.
> - **La migración corre sobre datos vivos.** Es aditiva: ni un DROP. La verificación 9 compara los
>   conteos de `ad_spend` y `orders` antes y después: anotalos ANTES de migrar.

---

## Paso 2 — tres en paralelo

### T14 — Sync de la jerarquía
> [preámbulo, `<TU-TASK>` = `T14-sync-jerarquia.md`]
>
> Llená `ad_campaigns`, `ad_sets` y `ads` desde la Marketing API, de forma idempotente. El modelo es
> `lib/ads/sync.ts`, que ya hace esto para el gasto y está probado en producción: **leelo completo y
> copiá su patrón** (upsert por `UNNEST`, un error por cuenta no detiene a las otras). No lo modifiques.
>
> El error que más importa evitar es el silencioso: **si la paginación se corta, media jerarquía queda
> sin sincronizar y no falla nada.** La verificación 5 compara el conteo de anuncios de la base contra
> el `summary.total_count` que devuelve Meta. Tienen que coincidir.
>
> Y `budget_level` (§4): Meta no tiene un campo que diga si el presupuesto es de campaña o de conjunto,
> se infiere de si la campaña trae `daily_budget`. Es el dato que decide a qué id se le pega cuando una
> regla cambia el presupuesto, y adivinarlo mal es la primera causa de acciones fallidas.

### T15 — Métricas por objeto
> [preámbulo, `<TU-TASK>` = `T15-metricas-por-objeto.md`]
>
> Implementá `getMetricasAds` según el §4 del plan: gasto, ventas, ingresos, neto, ganancia, ROI, ROAS y
> CPA por campaña, conjunto y anuncio. **Si estos números están mal, el motor pausa campañas
> rentables.** Todo lo demás del módulo es plomería.
>
> Tres cosas, en orden de cuánto cuestan si se hacen mal:
> - **El día no es el mismo en las dos zonas.** `ad_spend.day` viene en la zona de la cuenta de Meta
>   (Lisboa) y `orders.day` está congelado en la del funnel (Buenos Aires). Una venta de las 21:30 de
>   Buenos Aires es del día siguiente en Lisboa: ya está verificado en `_verificacion-016.sql` §6. Se
>   agrupa por `(purchased_at AT TIME ZONE cuenta.timezone)::date` y **nunca** por `orders.day`.
> - **`null` y no `0` cuando el denominador es cero.** Un conjunto con €0 de gasto no tiene ROI. Si
>   devolvés `0`, la condición `ROI < 1.1` se cumple y el motor pausa un conjunto que todavía no gastó
>   nada. Es el falso positivo más caro del sistema y se previene en cuatro líneas.
> - **Leé `lib/queries/sales.ts` completo primero, por dos razones opuestas:** para copiar su convención
>   de qué `status` contribuye a cada término del neto (o las dos secciones van a mostrar números
>   distintos), y para **no** copiar su `roi`, que significa otra cosa (`resultado / gasto_total`). Acá
>   `roi = neto / gasto_ads`. Los umbrales del usuario (1.1 a 1.3) están en esta escala.

### T16 — Motor de reglas
> [preámbulo, `<TU-TASK>` = `T16-motor-de-reglas.md`]
>
> El motor: evaluar condiciones, ejecutar acciones, modo sombra, cooldown, techos y auditoría en
> castellano. **Es el task que puede gastar plata.**
>
> No dependés de T15 aunque uses sus métricas: evaluás contra el tipo `MetricasObjeto` de
> `lib/ads/tipos.ts` y tus tests construyen las filas a mano.
>
> Cuatro cosas:
> - **`motor.ts` y `explicacion.ts` son PUROS**: no importan `lib/db`, no importan `lib/ads/meta` y no
>   leen `process.env`. La verificación 2 es un `grep` que tiene que dar cero líneas. Sin esa frontera,
>   probar "qué pasa si el ROI es 1,29 y el conjunto ya está en el techo" requiere una cuenta de Meta.
> - **La verificación 4(e) es la que decide si este módulo se puede prender:** con el modo sombra
>   activo, se lee el estado de un conjunto en Meta antes y después de una corrida y **tiene que ser
>   idéntico**. Si cambió, pará todo: es el único bug de este módulo que se paga con plata sin aviso, y
>   el usuario va a dejarlo corriendo toda la noche creyendo que simula.
> - **`explicacion` se escribe siempre, incluso cuando la acción se omite**, y en castellano con los
>   números adentro. El usuario lo pidió explícitamente. El §5 del task tiene los cuatro formatos.
>   Escribí el `switch` sobre `MotivoOmision` con `const _: never` en el default, para que agregar un
>   motivo sin su texto rompa la compilación.
> - **El orden de los siete chequeos de `evaluar` no es arbitrario** (§4 del task) y hay un test que lo
>   fija. Va de "esta acción no tiene sentido" a "no está permitida ahora" a "se pasaría de un límite".

---

## Paso 3 — tres en paralelo

### T17 — UI del gestor
> [preámbulo, `<TU-TASK>` = `T17-ui-gestor.md`]
>
> La pantalla `/anuncios` con la tabla de la primera captura, el toggle de estado, el presupuesto
> editable y las acciones en lote. **Antes de escribir una línea de UI leé
> `app/(panel)/ventas/page.tsx`, `app/(panel)/ventas/VentasView.tsx` y `components/ui.tsx` enteros:**
> esta pantalla es la hermana de Ventas y usa el mismo esqueleto y los mismos componentes.
>
> `components/ui.tsx` no se modifica (cuatro tasks lo importan): el toggle y el campo de presupuesto
> viven dentro de `AnunciosView.tsx`.
>
> Cuatro detalles que definen si la pantalla es confiable:
> - **`null` se dibuja como `—`, nunca como `0,00`.** Mostrar `0,00` hace creer que se está perdiendo
>   plata cuando todavía no se gastó nada.
> - **Si `effectiveStatus` no coincide con `status`, mostralo.** Un conjunto `ACTIVE` con
>   `CAMPAIGN_PAUSED` no entrega, y sin el badge el usuario no tiene forma de entender por qué.
> - **El presupuesto solo es editable donde vive** (`budgetLevel === level`). En un conjunto de una
>   campaña CBO va en gris; en un anuncio va siempre `—`.
> - **El toggle es optimista pero revierte si el POST falla.** Un toggle que se queda en la posición
>   nueva después de fallar es una mentira sobre algo que está gastando.
>
> Creás `SubNav.tsx` con los tres links (Campañas, Reglas, Historial) aunque dos rutas las escriba T19
> después: Next resuelve `href` en runtime y no rompe el build.

### T18 — Worker, Telegram y deploy
> [preámbulo, `<TU-TASK>` = `T18-worker-telegram-deploy.md`]
>
> El worker que corre el motor cada minuto bajo PM2, el backoff contra los límites de Meta, los avisos
> por Telegram con su script de configuración, y los artefactos de deploy. **No ejecutás el deploy**:
> eso lo hace el usuario después, con el runbook en la mano.
>
> **Leé `deploy/ecosystem.config.js`, `deploy/deploy.sh` y `deploy/cron.panel` enteros antes de
> editarlos.** Están en producción y sus comentarios explican decisiones que ya costaron un incidente
> (por qué `instances: 1`, por qué `HOSTNAME: 127.0.0.1`, por qué `tsx` necesita
> `node --env-file=.env.production`).
>
> Cuatro cosas:
> - **El lease (§3) es lo que evita que un `pm2 reload` duplique cada acción.** Es un `UPDATE`
>   condicional sobre `settings.ads_worker_lease`, ya verificado como atómico en
>   `_verificacion-016.sql` §10. La verificación 3 lanza dos ticks a la vez: uno tiene que descartarse.
> - **`setTimeout` recursivo, no `setInterval`**, y el `catch` adentro del loop. Con `setInterval` un
>   tick lento se solapa con el siguiente; sin el catch, un error determinístico entra en un ciclo de
>   reinicios de PM2 que llena el disco de logs.
> - **Un minuto es agresivo** (~1.440 lecturas de insights por cuenta por día, P-A02). El backoff lee
>   `ultimoUso()` y guarda el castigo en `settings`, no en memoria: un restart con el estado en memoria
>   borra el castigo y vuelve a golpear la API en frío, que es cómo se pasa de "throttled un rato" a
>   "bloqueado una hora". Anotá en §10 cuánta cuota consume un tick real: no lo sabemos y es el dato que
>   decide si un minuto es sostenible.
> - **Usá `syncAdSpend` de `lib/ads/sync.ts` tal cual.** Está en la lista de archivos que nadie toca: es
>   el camino por el que hoy entra el gasto de Resumen y Ventas.
>
> El runbook (§11) importa más de lo que parece: la primera sección es el orden de encendido, y el
> paso 6 dice **dejar el modo sombra global prendido 24 horas** antes de que el módulo actúe de verdad.

### T19 — UI de reglas e historial
> [preámbulo, `<TU-TASK>` = `T19-ui-reglas-historial.md`]
>
> Las pantallas `/anuncios/reglas` y `/anuncios/historial`, con el formulario de la tercera captura.
> Importás `SubNav.tsx` de T17 y no lo modificás; si todavía no existe, escribí el import igual.
>
> Cinco cosas:
> - **El porcentaje es un FACTOR y la etiqueta lo tiene que decir.** `250%` significa `actual × 2,5`:
>   **€10,00 pasan a €25,00**. Verificado contra el export real del usuario (Utmify guarda `2.5` y
>   muestra "250%"). La etiqueta **no puede decir "aumentar un X%"**, porque en castellano eso se lee
>   como +250% (×3,5) y es lo contrario: dice **"escalar al ___% del presupuesto actual"**, con el
>   resultado calculado al lado mientras se escribe.
> - **Los dos interruptores globales son switches de verdad, no etiquetas** (D-A12b). El usuario pidió
>   explícitamente que el switch de simulación a real esté en la web y no en un env var. Van con su
>   endpoint propio, `/api/ads/interruptores`, y apagar el modo sombra **queda registrado en el
>   historial**: es el evento más importante que puede pasar en este módulo.
> - **Una regla nueva se guarda con `enabled = false` y `dry_run = true`, forzado en el server**,
>   ignorando lo que venga en el payload. La verificación 3 manda `enabled: true, dryRun: false` a
>   propósito y espera `f|t`. Si sale `t|f`, una regla puede nacer actuando sobre plata real.
> - **"Correr ahora" y `preview=1` corren siempre en sombra.** La verificación 7 lee el estado de un
>   conjunto en Meta antes y después del preview: tiene que ser idéntico. Un botón de "probar" que actúa
>   es peor que no tenerlo.
> - **El banner de los interruptores globales tiene que ser imposible de ignorar.** El usuario pidió el
>   switch para "testear tranquilo y ver qué hubiera hecho": la pantalla tiene que hacer imposible
>   confundir el mundo simulado con el real.
>
> En el historial, la columna que importa es `explicacion`, con el ancho máximo y sin truncar. Y el
> badge de resultado sale de **tres** campos (`dry_run`, `skipped_reason`, `ok`), no solo de `ok`: mirar
> solo `ok` haría que una acción simulada exitosa se muestre como "hecha".

---

## Qué revisar cuando terminan

En este orden, porque cada uno depende del anterior.

```bash
cd ~/Desktop/funnel/dashboard-admin
export PSQL="docker exec panel-db-1 psql -U panel -d panel"

# 1 — compila, buildea y los tests pasan
npx tsc --noEmit && npm run build && npm test

# 2 — el token puede escribir (si esto falla, nada más importa)
npm run ads:token

# 3 — las 10 verificaciones lógicas siguen en verde contra la base migrada
docker exec -i panel-db-1 psql -U panel -d panel < tasks/anuncios/_verificacion-016.sql

# 4 — NADA DE LO QUE YA FUNCIONABA CAMBIÓ.
#     Anotá estos números ANTES de empezar el módulo y compará al final:
$PSQL -tAc "SELECT count(*), coalesce(sum(spend_eur),0) FROM ad_spend;"
$PSQL -tAc "SELECT count(*), coalesce(sum(amount_eur),0) FROM orders;"
#     Y abrí /resumen y /ventas con un rango CERRADO (no hoy): los números
#     tienen que ser idénticos a los de antes.

# 5 — los cinco endpoints nuevos dan 401 sin cookie
for U in '/api/data/ads?level=campaign' '/api/data/ads/historial' '/api/ads/reglas'; do
  curl -s -o /dev/null -w "$U → %{http_code}\n" "http://localhost:3005$U"
done
curl -s -o /dev/null -w "POST acciones → %{http_code}\n" -X POST \
  'http://localhost:3005/api/ads/acciones' -H 'content-type: application/json' -d '{}'
curl -s -o /dev/null -w "POST reglas → %{http_code}\n" -X POST \
  'http://localhost:3005/api/ads/reglas' -H 'content-type: application/json' -d '{}'
# los cinco tienen que dar 401

# 6 — EL PUNTO QUE DECIDE SI ESTO SE PUEDE PRENDER: el modo sombra no toca Meta.
#     Está en tres tasks distintas y hay que verlo funcionar de punta a punta:
#     · crear una regla que seguro se cumpla, sobre un conjunto PAUSADO
#     · dejar ads_rules_force_dry_run en true
#     · prender ads_rules_enabled y correr el worker un par de ticks
#     · el historial se llena, TODO con dry_run = true
#     · el status del conjunto en Meta, leído por curl, NO cambió
#     Si cambió: no se despliega. Es el único bug de este módulo que se paga con
#     plata sin ningún aviso.

# 7 — el circuito completo, a mano y en el browser
#     · /anuncios lista los tres niveles con la plata al lado
#     · pausar algo a mano desde el gestor queda en el historial con source='manual'
#     · el ROI de una campaña coincide con el cálculo a mano en psql (T15 §8.4)
#     · el worker hace más de un tick y sobrevive a un tick que falla
#     · llega un mensaje de Telegram

# 8 — el estado final tiene que ser el seguro
$PSQL -tAc "SELECT key||' = '||value::text FROM settings
             WHERE key IN ('ads_rules_enabled','ads_rules_force_dry_run') ORDER BY key;"
# esperado: ads_rules_enabled = false · ads_rules_force_dry_run = true
# El módulo se despliega apagado. Lo prende el usuario, con el runbook.

# 9 — §10 del plan: leé las preguntas abiertas que quedaron anotadas.
#     P-A02 (cuánta cuota consume un tick) es la que más importa: es el dato
#     que decide si la cadencia de un minuto es sostenible.
```

Si el punto 6 no da, **no se prende el módulo**. Que el gestor y las reglas se vean bien no sirve de
nada si el modo sombra no es de fiar: es lo único que separa "probar una regla" de "dejar que un cron
gaste plata toda la noche".
