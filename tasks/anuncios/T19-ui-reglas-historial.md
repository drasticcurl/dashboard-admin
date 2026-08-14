# T19 — UI de reglas y pantalla de historial

- **Depende de:** T13 (contratos) y T16 (el motor, para el preview y el "correr ahora").
- **Bloquea:** nada.
- **Se puede correr en paralelo con:** T17 y T18.
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos que este task puede tocar:** `app/(panel)/anuncios/reglas/**`,
  `app/(panel)/anuncios/historial/**`, `app/api/ads/reglas/route.ts`,
  `app/api/ads/interruptores/route.ts` y `app/api/data/ads/historial/route.ts`. Nada más.

Leé `00-PLAN-ANUNCIOS.md` completo. El **§5** es el contrato de las reglas y **D-A9 y D-A12** son las
dos decisiones que esta pantalla tiene que comunicar bien o el módulo se vuelve peligroso.

**Importás `app/(panel)/anuncios/SubNav.tsx` (lo crea T17) y no lo modificás.** Si todavía no existe
cuando arrancás, escribí las pantallas con el import puesto: va a aparecer.

---

## 1. Objetivo

Dos pantallas y dos endpoints:

- **`/anuncios/reglas`** — la lista de reglas con su switch de estado y su switch de modo sombra, más
  el formulario de crear y editar.
- **`/anuncios/historial`** — todo lo que el motor hizo o habría hecho, en castellano, filtrable.

La referencia visual es la segunda y la tercera captura del usuario: la tabla con **estado · nombre ·
aplicado a · acción y condición · frecuencia y período**, y el formulario con **nombre · cuentas ·
aplicar regla a · filtrar por nombre · acción · porcentaje · límite máximo de presupuesto · nivel de
las condiciones · condiciones · período de cálculo · frecuencia · intervalo de ejecución · límite de
ejecuciones diarias**.

Este task **no evalúa reglas ni llama a Meta**: eso lo hace T16, y esta pantalla lo invoca.

## 2. El patrón de pantalla — el mismo que el resto del panel

`page.tsx` server component con `dynamic = 'force-dynamic'` → fetch inicial → `View.tsx` con
`'use client'`. Todo con el kit de `components/ui.tsx` (`Card`, `Badge`, `Banner`, `Table<T>`,
`EmptyState`, `fmtMoney`, `fmtDateTime`, el tipo `Tone`). **`components/ui.tsx` no se modifica**
(D-A19): los switches y el constructor de condiciones viven dentro de tus propios archivos.

Leé `app/(panel)/config/ConfigView.tsx` antes de empezar: es la pantalla del panel que más se parece a
esta (formularios de escritura, listas editables, confirmaciones) y ya resolvió el patrón.

## 3. `/anuncios/reglas` — la lista

Las columnas de la captura, traducidas a los campos del §5 del plan:

| Columna | De dónde sale |
|---|---|
| ESTADO | switch sobre `enabled` |
| MODO | `Badge`: **SOMBRA** (tono `info`) o **ACTIVA** (tono `warn`), desde `dryRun` |
| NOMBRE | `name` |
| APLICADO A | `level` + `statusFilter` + `accountIds` → "Conjuntos activos · todas las cuentas" |
| ACCIÓN Y CONDICIÓN | `action` + las condiciones en una línea → "Pausar conjuntos · si ROI < 1,10 y gasto > €10,00" |
| FRECUENCIA Y PERÍODO | `everyMinutes` + `period` + la ventana → "Cada 15 min · hoy · 22:00-06:00" |
| ÚLTIMA CORRIDA | `lastRunAt` con `fmtDateTime`, y `lastRunError` como `Badge` rojo si hay |
| ⋮ | editar · duplicar · correr ahora · borrar |

Cuatro cosas que esta pantalla tiene que dejar obvias:

**1. El modo sombra se ve de lejos y se cambia desde acá.** Un `Badge` **SOMBRA** o **ACTIVA** por fila,
y arriba un `Banner` con **dos switches de verdad, no dos etiquetas**: `ads_rules_enabled` y
`ads_rules_force_dry_run`.

**Esto es un pedido explícito del usuario (D-A12b): el switch para pasar de simulación a real vive en
la web, no en una variable de entorno.** Los cuatro interruptores del módulo se cambian desde el panel:

| Interruptor | Dónde se cambia | Endpoint |
|---|---|---|
| `ads_rules_enabled` | switch arriba de la lista | `POST /api/ads/interruptores` |
| `ads_rules_force_dry_run` | switch arriba de la lista | `POST /api/ads/interruptores` |
| `enabled` de cada regla | switch en su fila | `POST /api/ads/reglas` |
| `dry_run` de cada regla | switch en su fila | `POST /api/ads/reglas` |

Ninguno de los cuatro es un env var, y no hay que reiniciar nada: el worker los lee en cada tick, así
que el cambio toma efecto en la corrida siguiente (T18 §2).

Cuando `ads_rules_force_dry_run` está prendido, el banner dice, en grande:

> Modo simulación global activo. Ninguna regla está tocando Meta: todas registran lo que **habrían**
> hecho. Revisá el historial y apagá este interruptor cuando quieras que actúen de verdad.

Y cuando está apagado, el banner cambia a tono `warn`:

> Las reglas marcadas como ACTIVA están cambiando estados y presupuestos en Meta de verdad.

El usuario pidió esto explícitamente: "que sea un switch, así mañana testeo tranquilo y veo qué hubiera
hecho". La pantalla tiene que hacer imposible confundir los dos mundos.

**2. Prender `dryRun = false` pide confirmación escrita.** No un "¿estás seguro?": un diálogo que
diga qué regla, qué acción y sobre cuántos objetos se aplicaría **ahora mismo** (usá el preview del §5).
Es la única acción de todo el panel que le da a un cron permiso para gastar plata.

**3. "Correr ahora" siempre corre en sombra.** El botón llama a `correrRegla` con
`{ forzarSombra: true }` y muestra el resultado sin escribir en Meta. Un botón de "probar" que actúa de
verdad no es un botón de probar. Si el usuario quiere que actúe, prende la regla.

**4. Una regla sin condiciones se marca en rojo.** Se aplica a **todos** los objetos que pasaron el
filtro de alcance. El motor la obedece (T16 no la bloquea, por diseño), así que el aviso va acá:
`Badge` con tono `bad` y el texto "sin condiciones: se aplica a todo".

## 4. El formulario

Los campos de la captura, en el mismo orden, con los tipos del §5:

```
Nombre de la regla          text, requerido
Cuentas de anuncios         multi-select → accountIds ([] = todas)
Aplicar regla a             level × statusFilter
                            "Campañas activas" | "Campañas pausadas" | "Cualquier campaña"
                            "Conjuntos activos" | ... | "Anuncios activos" | ...
Filtrar por nombre          nameFilter + nameFilterMode (contiene | no contiene)
Acción                      pause | activate | budget_increase | budget_decrease
Valor + unidad              actionValue + actionUnit (% | €)     ← solo para presupuesto
Límite máximo               budgetMax                            ← obligatorio si sube
Límite mínimo               budgetMin                            ← obligatorio si baja
Nivel de las condiciones    metricsLevel (del objeto | del padre)
Condiciones                 chips: métrica + operador + valor, combinadas con Y
Período de cálculo          period (hoy | ayer | 7 días | 7 días sin hoy)
Frecuencia                  everyMinutes (1 | 5 | 15 | 30 | 60 | 1440)
Intervalo de ejecución      windowStart + windowEnd (vacío = cualquier hora)
Límite de ejecuciones       maxRunsPerDay (vacío = sin límite)
Cooldown por objeto         cooldownMinutes
Máx. acciones por objeto    maxActionsPerObjectPerDay
```

### Las cinco cosas que el formulario tiene que resolver bien

**1. El porcentaje es un FACTOR y la etiqueta lo tiene que decir.** Es la ambigüedad más cara del
módulo (D-A9): `250%` significa `nuevo = actual × 2,5`, o sea **€10,00 → €25,00**. Verificado contra el
export real del usuario, donde Utmify guarda `2.5` y muestra "250%".

**La etiqueta NO puede decir "aumentar un X%"**, porque en castellano eso se lee como un incremento
(+250% = ×3,5) y es lo contrario de lo que hace. El select de unidad tiene dos opciones y las dos dicen
qué hacen:

```
Escalar al  [250] %  del presupuesto actual        ← action_unit = 'percent'
Sumar       [ 10] €  al presupuesto actual         ← action_unit = 'fixed'
```

Con `100%` marcado como "sin cambio" en el propio campo. Y el preview en vivo al lado, mientras escribe:

> Un conjunto con €10,00 pasaría a €25,00. Con el límite de €25,00, queda en €25,00.

Tomá un presupuesto real de los objetos que la regla alcanzaría, no un número inventado. Si el usuario
ve el resultado, la ambigüedad desaparece sin explicar nada.

**La dirección se valida en los dos sentidos, y la base también la valida** (`CHECK
ad_rules_percent_direccion`):

| Acción | `action_unit` | `action_value` permitido | Qué advierte la UI si está mal |
|---|---|---|---|
| `budget_increase` | `percent` | **> 100** | "un factor menor a 100 BAJA el presupuesto; para subir al doble va 200%" |
| `budget_decrease` | `percent` | **> 0 y < 100** | "para bajar a la mitad va 50%; 250% multiplica por 2,5" |

Un `budget_increase` con `50` no es "subir poco": **parte el presupuesto al medio cada 15 minutos**, y el
techo obligatorio no lo frena porque el resultado siempre queda por debajo. Es el error más caro que el
formulario puede dejar pasar, y por eso lo bloquean los dos lados.

Con `action_unit = 'fixed'` el valor es un importe positivo y **el signo lo pone la acción** (D-A9b):
`budget_increase` suma, `budget_decrease` resta. La UI no ofrece signos ni valores negativos.

**2. Las condiciones son chips y se combinan con Y**, como en la captura (`Ventas > 2`, `ROI > 1.3`,
`Gasto < €10.00`). **No hay O**: dos reglas separadas expresan lo mismo y se pueden prender y apagar
por separado. Poné el porqué en un `title` del botón de agregar, para que nadie pregunte.

Las métricas disponibles son las 13 del `CHECK` de la base: `sales`, `revenue`, `spend`, `net`,
`profit`, `roi`, `roas`, `cpa`, `budget`, `impressions`, `clicks`, `ctr`, `cpc`. Mostralas con nombre en
castellano y con la unidad al lado: **ROI** (múltiplo), **Gasto** (€), **Ventas** (cantidad).

**3. El tooltip del ROI es obligatorio.** El panel tiene dos definiciones distintas (D-A7) y esta
pantalla es donde el usuario elige el umbral:

> **ROI** = neto ÷ gasto de ads. El neto ya tiene restadas las comisiones y el costo de producto.
> ROI 1,30 significa que el neto es 1,3 veces lo gastado en ads.
> **ROAS** = ingresos brutos ÷ gasto, sin restar nada.
> El ROI de la sección Ventas se calcula distinto: no los compares.

**4. Los campos se deshabilitan según la acción.** Con `pause`/`activate`, el valor, la unidad y los
límites de presupuesto no aplican: deshabilitados y vacíos, no escondidos (que desaparezcan hace que el
formulario salte). Con `level = 'ad'`, las dos acciones de presupuesto **no están en el select**: en
Meta los anuncios no tienen presupuesto (D-A5) y hay un `CHECK` en la base que lo rechaza.

**5. Validá en el cliente lo mismo que la base valida.** Los **18** `CHECK` de `ad_rules` están para que
ni un `psql` a mano pueda guardar una regla peligrosa, pero el usuario no tiene que descubrirlos por un
error 500. Los que importan:

- techo obligatorio al subir, piso obligatorio al bajar, `actionValue > 0`;
- **coherencia de dirección del factor** (`ad_rules_percent_direccion`, punto 1 de arriba);
- **`budgetMax >= budgetMin`** (`ad_rules_techo_sobre_piso`): con techo €10 y piso €25 no hay ningún valor
  que satisfaga los dos, y el recorte del motor devolvería el techo siempre, en silencio;
- **límites positivos** (`ad_rules_limites_positivos`): un techo en 0 no significa nada;
- la ventana horaria completa o vacía, `everyMinutes` entre 1 y 1440;
- **`metricsLevel` sólo acepta `'object'`** (`ad_rules_mlevel_valido`). Ver el punto 6.

**6. El select de "nivel de las condiciones" NO ofrece "del padre" en esta versión.** `metricsLevel =
'parent'` está en el diseño pero **sin semántica definida**: nadie dijo cómo se resuelve el id del padre, si
se deduplican dos anuncios del mismo conjunto, a qué objeto se le aplica la acción ni qué se congela en
`metrics`. El motor no lo implementa y la base lo rechaza.

Así que el campo se muestra fijo en **"del objeto"** con un `title` que diga que las métricas del padre
llegan en una versión próxima. **No lo ofrezcas deshabilitado con la opción visible**: una opción que se ve
y no se puede elegir genera la pregunta cada vez. Y sobre todo, no lo ofrezcas habilitado: una regla que el
formulario acepta y el motor no sabe evaluar decide con el nivel equivocado, y eso se paga con plata.

**7. El techo absoluto se MUESTRA pero no se edita desde acá** (D-A9c). El formulario informa "el máximo
absoluto por objeto es €200" al lado del campo de techo, y valida contra él. Pero
`ads_max_daily_budget_eur` **no se cambia desde este formulario ni desde `/api/ads/interruptores`**: si el
mismo endpoint que mueve presupuesto puede levantar su propio techo, no es un techo. Se cambia con un
`UPDATE` a mano.

## 5. `app/api/ads/reglas/route.ts`

```
GET    /api/ads/reglas            lista con condiciones
POST   /api/ads/reglas            crear o actualizar (id opcional)
DELETE /api/ads/reglas?id=7       borrar
POST   /api/ads/reglas?preview=1  evaluar sin ejecutar (el §4 punto 1 y el "correr ahora")
```

El molde es `app/api/config/ads/route.ts`. Siete reglas:

1. **`guard(req)` en todos los métodos.** Es escritura y es la convención del proyecto: el middleware ya
   cubre la ruta, pero no alcanza como única defensa.
2. **`zod` para todo el payload**, con la misma forma de error que el resto:
   `{ ok: false, error: 'invalid_payload', detail: issues[0]?.message }` y status 400.
3. **El schema de zod replica los `CHECK` de la base** con `refine`: techo obligatorio al subir, piso al
   bajar, `level !== 'ad'` para acciones de presupuesto, ventana completa o vacía. Que la base también
   lo valide es defensa en profundidad, no una excusa para no validar acá: el error de zod dice **qué**
   campo está mal, el de Postgres dice el nombre de un constraint.
4. **La regla y sus condiciones se guardan en UNA transacción** (`tx()` de `lib/db.ts`): `INSERT ... ON
   CONFLICT DO UPDATE` en `ad_rules`, `DELETE` de las condiciones viejas, `INSERT` de las nuevas. Sin la
   transacción, un fallo a mitad deja una regla con las condiciones de otra versión, y esa regla corre
   cada minuto.
5. **`updated_at = now()`** en cada update. Es la columna que explica "¿por qué esta regla se comporta
   distinto que la semana pasada?".
6. **Una regla nueva se guarda con `enabled = false` y `dry_run = true`**, ignorando lo que venga en el
   payload. El default seguro se fuerza en el server, no se confía en el formulario (D-A12). Prenderla
   es un segundo POST explícito.
7. **`preview=1` no escribe nada en Meta.** Llama a `correrRegla` con `{ forzarSombra: true }` y
   devuelve las decisiones. Registrar las filas de `ad_actions` con `dry_run: true` está bien —es el
   comportamiento de T16— pero **no se toca la API de Meta**.

## 5b. `app/api/ads/interruptores/route.ts` — el switch de simulación a real

Es el endpoint que hace realidad D-A12b. Chico y con una responsabilidad:

```
GET  /api/ads/interruptores   → { ok, habilitado, forzarSombra, ttlSegundos,
                                  backoffUntil, backoffReason, backoffFailures,
                                  workerLastTick,
                                  maxDailyBudgetEur, maxDeltaPorTickEur }   ← sólo lectura
POST /api/ads/interruptores   { "habilitado": true, "forzarSombra": false, "ttlSegundos": 120 }
```

**`ttlSegundos` está acá porque el plan prometía que se podía cambiar desde el panel y no había dónde.**
P-A02 dice que si Meta aprieta con la cadencia de un minuto, la salida es subir `ads_insights_ttl_seconds`
"desde el panel sin desplegar" — y ningún endpoint ni ninguna pantalla lo permitía. Es un control de una
línea que evita un deploy justo en el momento en que la API te está cortando el servicio. Validalo en un
rango sensato (10 a 3600) y mostralo en el banner con el estado del worker.

**`maxDailyBudgetEur` y `maxDeltaPorTickEur` se DEVUELVEN pero el POST no los acepta** (D-A9c). El
formulario los necesita para validar y para mostrar el máximo al lado del campo, pero un endpoint que mueve
presupuesto no puede levantar su propio techo. Si el POST los recibe, se ignoran en silencio o se rechaza
con 400: lo que no puede pasar es que los escriba.

Existe como ruta propia y **no** como un parámetro de `/api/config/settings` porque ese archivo está en
la lista de los que nadie de este módulo toca (§8 del plan).

Seis reglas:

1. **`guard(req)` primero.** Este endpoint le da permiso a un cron para gastar plata: es el más
   sensible de todo el módulo.
2. **`zod` con dos booleanos opcionales.** Mandar solo uno cambia solo ese: el usuario va a querer
   apagar el modo sombra sin tocar el interruptor general.
3. **Escribe en `settings` con el `setSetting` que ya existe** en `app/api/config/_lib.ts` (importalo,
   no lo dupliques), o con el mismo `INSERT ... ON CONFLICT DO UPDATE`. **`settings.value` es `jsonb`**:
   los booleanos van sin comillas para que `value = 'true'::jsonb` funcione.
4. **Apagar `forzarSombra` queda registrado, y la fila tiene una forma concreta.** Es el evento más
   importante que puede pasar en este módulo y tiene que estar en el historial con fecha y hora. Cuando se
   vuelve a prender, también.

   ```sql
   INSERT INTO ad_actions
     (source, level, account_id, object_id, action, ok, estado, explicacion, actor_hint,
      before_value, after_value)
   VALUES
     ('system', 'system', '*', 'ads_rules_force_dry_run', 'config', true, 'confirmado',
      'Manual: se desactivó el modo simulación global. Desde ahora las reglas marcadas como ACTIVA cambian estados y presupuestos en Meta de verdad.',
      'ip=... req=...', 'true', 'false');
   ```

   **Los tres valores centinela no son decorativos y antes esta fila era imposible de insertar.** El
   `account_id` es `NOT NULL` y el `CHECK` de `level` sólo aceptaba `campaign|adset|ad`, así que un evento
   global —que no pertenece a ninguna cuenta ni es un objeto de Meta— chocaba contra el schema y este punto
   del task no se podía cumplir. La 016 lo resuelve con `level = 'system'`, `account_id = '*'` y
   `source = 'system'`, y el `CHECK ad_actions_config_coherente` obliga a que los tres vayan juntos: un
   evento de configuración no puede disfrazarse de acción sobre un conjunto.

   `actor_hint` lleva el rastro técnico de la petición (IP, request id). **No es una identidad**: el panel
   se autentica con una contraseña compartida, así que esta fila dice "alguien con la contraseña apagó el
   modo simulación a las 14:32", y eso es todo lo que se puede afirmar (P-A12).
5. **El GET devuelve también el estado del worker** (`ads_worker_last_tick`, `ads_backoff_until`,
   `ads_backoff_reason`), para que el banner pueda avisar "las reglas están prendidas pero el worker no
   reporta desde hace 20 minutos". Prender el interruptor con el worker caído es la falla silenciosa de
   este módulo.
6. **Nunca devuelvas otras filas de `settings`.** Una de ellas es el bot token de Telegram. Este
   endpoint lee las cinco claves que necesita, por nombre, y nada más.

## 6. `/anuncios/historial` y su endpoint

```
GET /api/data/ads/historial?rule=7&source=rule|manual|system
                           &estado=confirmado|simulado|omitido|fallido|indeterminado|pendiente
                           &objeto=1201...&limit=100&before=<id>
```

El filtro es por `estado` y no por un `resultado` inventado: la columna existe en la base y su vocabulario
está cerrado por un `CHECK`, así que el parámetro se valida contra esa lista y no hay que traducir nada.
`source=system` es el que trae los eventos de configuración (§5b.4).

La pantalla es una lista cronológica de `ad_actions`, y **la columna que importa es `explicacion`**: es
el renglón en castellano que escribió T16 y que el usuario pidió explícitamente ("que logee en texto
bien escrito").

| Columna | Cómo se muestra |
|---|---|
| CUÁNDO | `fmtDateTime(created_at)` |
| QUÉ PASÓ | `explicacion` — **el ancho máximo de la tabla**, sin truncar |
| REGLA | `rule_name` (desnormalizado: sigue legible aunque la regla ya no exista) |
| RESULTADO | `Badge` derivado de `estado`. Ver el punto 1 |
| DETALLE | `before_value` → `after_value`, y `error` si hay |

Cuatro cosas:

**1. El `Badge` de resultado sale de `estado`, que es una columna explícita.** La versión anterior lo
derivaba de tres campos (`dry_run`, `skipped_reason`, `ok`) y eso no alcanzaba para representar el caso que
importa: una mutación cuyo resultado **no se conoce**. La 016 tiene la columna:

| `estado` | Badge | Tono | Qué pasó |
|---|---|---|---|
| `confirmado` | **hecho** | `good` | Meta aceptó el cambio |
| `simulado` | **simulado** | `info` | modo sombra: nunca se llamó a Meta |
| `omitido` | **omitido** | `neutral` | cumplió la condición pero un freno lo detuvo |
| `fallido` | **error** | `bad` | Meta rechazó el pedido. El motivo está en `error` |
| `indeterminado` | **sin confirmar** | `warn` | timeout: **no se sabe** si se aplicó |
| `pendiente` | **en curso** | `warn` | se está intentando ahora, o el proceso murió a mitad |

**`indeterminado` y `pendiente` son los dos que no existían y son los que hay que mostrar bien.** Un POST
que corta por timeout puede haberse aplicado igual; mostrarlo como "error" hace que el usuario crea que no
pasó nada y lo vuelva a hacer a mano, duplicando el cambio. El texto del badge tiene que decir que **no se
sabe**, y el tooltip que el reconciliador lo va a resolver en el tick siguiente.

Poné la derivación en una función con un `switch` exhaustivo sobre `estado` (con `const _: never` en el
`default`), así agregar un estado rompe la compilación en lugar de producir un badge vacío.

**1b. Y un chip rápido de "sin confirmar"**, además del de errores. Es la lista que hay que mirar cuando algo
no cuadra entre el panel y el administrador de anuncios de Meta.

**2. `metrics` se muestra, expandible.** Son las métricas congeladas con las que se decidió. Un
`<details>` con los números formateados. Es lo que responde "¿por qué se pausó esto el martes?" cuando
el gasto de ese día ya cambió y recalcular no reproduce la decisión.

**3. Filtro por defecto: los últimos 100, todo incluido.** Y un chip rápido de "solo errores", que es
lo que se busca el 90% de las veces. Los omitidos son mayoría en volumen (una regla que corre cada
minuto omite mucho): que el filtro de errores esté a un click.

**4. Paginación por cursor (`before=<id>`), no por offset.** La tabla crece rápido con un tick por
minuto, y un `OFFSET 5000` sobre una tabla que recibe inserciones constantes se pone lento y además
saltea filas. El índice `ad_actions_fecha_idx` ya está para esto.

## 7. Verificación

Nada de esto es opcional.

```bash
cd ~/Desktop/funnel/dashboard-admin
export PSQL="docker exec panel-db-1 psql -U panel -d panel"
export CK="-b panel_token=$(cat /tmp/panel_token)"

# 1 — compila y los tests pasan
npx tsc --noEmit && npm run build && npm test

# 2 — SIN COOKIE, 401 EN LOS CUATRO ENDPOINTS (§9.5 del plan)
curl -s -o /dev/null -w "reglas GET:%{http_code}\n" 'http://localhost:3005/api/ads/reglas'
curl -s -o /dev/null -w "reglas POST:%{http_code}\n" -X POST 'http://localhost:3005/api/ads/reglas' \
  -H 'content-type: application/json' -d '{"name":"x","level":"adset","action":"pause"}'
curl -s -o /dev/null -w "historial:%{http_code}\n" 'http://localhost:3005/api/data/ads/historial'
curl -s -o /dev/null -w "interruptores:%{http_code}\n" -X POST \
  'http://localhost:3005/api/ads/interruptores' -H 'content-type: application/json' \
  -d '{"forzarSombra":false}'
# esperado exactamente: 401 · 401 · 401 · 401
# El último es el más importante de los cuatro: es el que le da permiso a un cron
# para gastar plata.

# 2b — LAS SEIS REGLAS DEL SEED ESTÁN Y SE LEEN BIEN
curl -s $CK 'http://localhost:3005/api/ads/reglas' \
  | python3 -c "import sys,json;d=json.load(sys.stdin);
[print(r['name'],'|',r['action'],'|',r.get('actionValue'),r.get('actionUnit'),
       '| techo',r.get('budgetMax'),'|',len(r['conditions']),'cond') for r in d['reglas']]"
# esperado: 6 reglas, las tres de escalado con actionValue 250 y unit percent,
# techos 25/75/150, y 4+4+2 condiciones respectivamente.
# SI actionValue ES 2.5 EN LUGAR DE 250, la conversión del seed quedó a medias.

# 2c — EL SWITCH DE SIMULACIÓN A REAL FUNCIONA DESDE LA WEB (D-A12b)
curl -s $CK 'http://localhost:3005/api/ads/interruptores' | python3 -m json.tool
curl -s $CK -X POST 'http://localhost:3005/api/ads/interruptores' \
  -H 'content-type: application/json' -d '{"forzarSombra":false}'
$PSQL -tAc "SELECT value FROM settings WHERE key='ads_rules_force_dry_run';"   # esperado: false
$PSQL -c "SELECT source, level, account_id, action, estado, actor_hint, explicacion
            FROM ad_actions WHERE object_id='ads_rules_force_dry_run'
           ORDER BY id DESC LIMIT 1;" -P expanded=on
# esperado exactamente: source=system · level=system · account_id=* · action=config
#                       estado=confirmado · actor_hint NO nulo
#                       explicacion = la frase del §5b.4
#
# Los tres centinelas son obligatorios: el CHECK ad_actions_config_coherente
# rechaza un evento 'config' que no venga con level='system' y account_id='*'.
# Antes de la 016 corregida esta fila era IMPOSIBLE de insertar (account_id es NOT
# NULL y el CHECK de level sólo aceptaba campaign|adset|ad), así que este punto del
# task no se podía cumplir.

# 2c2 — el TTL de insights se puede cambiar desde la web (P-A02, §5b)
curl -s $CK -X POST 'http://localhost:3005/api/ads/interruptores' \
  -H 'content-type: application/json' -d '{"ttlSegundos":120}'
$PSQL -tAc "SELECT value FROM settings WHERE key='ads_insights_ttl_seconds';"   # esperado: 120
curl -s $CK -X POST 'http://localhost:3005/api/ads/interruptores' \
  -H 'content-type: application/json' -d '{"ttlSegundos":99999}'
# esperado: 400 — fuera del rango 10..3600
$PSQL -c "UPDATE settings SET value='55'::jsonb WHERE key='ads_insights_ttl_seconds';"
# El plan prometía en P-A02 que si Meta aprieta se sube el TTL "desde el panel sin
# desplegar", y no había ningún endpoint que lo permitiera.

# 2c3 — EL TECHO ABSOLUTO SE LEE PERO NO SE ESCRIBE DESDE ACÁ (D-A9c, §5b)
curl -s $CK 'http://localhost:3005/api/ads/interruptores' \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("max por objeto:",d.get("maxDailyBudgetEur"),"· max por tick:",d.get("maxDeltaPorTickEur"))'
# esperado: 200 y 300 — el formulario los necesita para validar y para mostrarlos
curl -s $CK -X POST 'http://localhost:3005/api/ads/interruptores' \
  -H 'content-type: application/json' -d '{"maxDailyBudgetEur":100000}'
$PSQL -tAc "SELECT value FROM settings WHERE key='ads_max_daily_budget_eur';"
# esperado: 200 — SIN CAMBIOS.
# Si quedó en 100000, el endpoint que le da permiso a un cron para gastar plata
# puede levantar su propio techo, y entonces no es un techo.
curl -s $CK -X POST 'http://localhost:3005/api/ads/interruptores' \
  -H 'content-type: application/json' -d '{"forzarSombra":true}'
$PSQL -tAc "SELECT value FROM settings WHERE key='ads_rules_force_dry_run';"   # vuelve a true

# 2d — el endpoint NO filtra el token de Telegram (§5b.6)
curl -s $CK 'http://localhost:3005/api/ads/interruptores' | grep -ci "token" \
  && echo "MAL: aparece un token en la respuesta" || echo "OK: no filtra el token"

# 3 — UNA REGLA NUEVA NACE APAGADA Y EN SOMBRA, aunque el payload diga lo contrario (§5.6)
curl -s $CK -X POST 'http://localhost:3005/api/ads/reglas' -H 'content-type: application/json' \
  -d '{"name":"PRUEBA T19","level":"adset","statusFilter":"active","action":"pause",
       "enabled":true,"dryRun":false,"period":"today","everyMinutes":15,
       "conditions":[{"metric":"spend","op":">","value":4},{"metric":"sales","op":"=","value":0}]}'
$PSQL -tAc "SELECT enabled, dry_run FROM ad_rules WHERE name='PRUEBA T19';"
# esperado exactamente: f|t
# SI SALE t|f, el §5.6 no está implementado y una regla puede nacer actuando sobre plata real.

# 4 — las condiciones se guardaron y son 2
$PSQL -tAc "SELECT count(*) FROM ad_rule_conditions c JOIN ad_rules r ON r.id=c.rule_id
             WHERE r.name='PRUEBA T19';"
# esperado exactamente: 2

# 5 — los 18 CHECK de la base se replican en zod y devuelven 400, NO 500
curl -s $CK -X POST 'http://localhost:3005/api/ads/reglas' -H 'content-type: application/json' \
  -d '{"name":"sin techo","level":"adset","action":"budget_increase","actionValue":250,"actionUnit":"percent"}'
# esperado: 400 invalid_payload mencionando el techo (§4.5). Si es 500, el error de
# Postgres se está filtrando al usuario en lugar de validarse.
# (actionValue 250 y no 20: con 20 el que salta primero es el CHECK de dirección y
#  esta prueba pasaría por el motivo equivocado)
curl -s $CK -X POST 'http://localhost:3005/api/ads/reglas' -H 'content-type: application/json' \
  -d '{"name":"presupuesto en anuncio","level":"ad","action":"budget_increase",
       "actionValue":250,"actionUnit":"percent","budgetMax":50}'
# esperado: 400 (en Meta los anuncios no tienen presupuesto)
curl -s $CK -X POST 'http://localhost:3005/api/ads/reglas' -H 'content-type: application/json' \
  -d '{"name":"media ventana","level":"adset","action":"pause","windowStart":"22:00"}'
# esperado: 400

# 5b — LOS TRES CHECK NUEVOS. Son los que impiden que una regla haga lo contrario
#      de lo que dice su nombre, y el más importante es el primero.
curl -s $CK -X POST 'http://localhost:3005/api/ads/reglas' -H 'content-type: application/json' \
  -d '{"name":"subir al 50","level":"adset","action":"budget_increase",
       "actionValue":50,"actionUnit":"percent","budgetMax":100}'
# esperado: 400 explicando que un factor menor a 100 BAJA el presupuesto.
# Sin esto, "subir al 50%" parte el presupuesto al medio cada 15 minutos y el techo
# no lo frena nunca porque el resultado siempre queda por debajo.
curl -s $CK -X POST 'http://localhost:3005/api/ads/reglas' -H 'content-type: application/json' \
  -d '{"name":"bajar al 250","level":"adset","action":"budget_decrease",
       "actionValue":250,"actionUnit":"percent","budgetMin":5}'
# esperado: 400 — bajar multiplicando por 2,5
curl -s $CK -X POST 'http://localhost:3005/api/ads/reglas' -H 'content-type: application/json' \
  -d '{"name":"techo bajo el piso","level":"adset","action":"budget_increase",
       "actionValue":250,"actionUnit":"percent","budgetMax":10,"budgetMin":25}'
# esperado: 400 — con techo €10 y piso €25 no hay valor que satisfaga los dos
curl -s $CK -X POST 'http://localhost:3005/api/ads/reglas' -H 'content-type: application/json' \
  -d '{"name":"metricas del padre","level":"ad","action":"pause","metricsLevel":"parent"}'
# esperado: 400 — 'parent' no está implementado (§4.6) y la base lo rechaza.
# El formulario no lo tiene que ofrecer; si el payload lo trae, zod lo corta.

# 6 — ACTUALIZAR NO DUPLICA CONDICIONES (§5.4)
export RID=$($PSQL -tAc "SELECT id FROM ad_rules WHERE name='PRUEBA T19';")
curl -s $CK -X POST 'http://localhost:3005/api/ads/reglas' -H 'content-type: application/json' \
  -d "{\"id\":$RID,\"name\":\"PRUEBA T19\",\"level\":\"adset\",\"action\":\"pause\",
       \"period\":\"today\",\"everyMinutes\":15,
       \"conditions\":[{\"metric\":\"spend\",\"op\":\">\",\"value\":9}]}"
$PSQL -tAc "SELECT count(*), max(value) FROM ad_rule_conditions WHERE rule_id=$RID;"
# esperado exactamente: 1|9.0000  (una condición, la nueva. Si son 3, faltó el DELETE)

# 7 — EL PREVIEW NO TOCA META (§5.7)
export T=$(grep -m1 '^META_ADS_TOKEN=' .env | cut -d= -f2-)
[ -n "$T" ] || { echo "FALTA META_ADS_TOKEN en .env — agregalo antes de seguir"; exit 1; }
export V="${META_API_VERSION:-v21.0}"
export AS_ID=$($PSQL -tAc "SELECT adset_id FROM ad_sets WHERE status='ACTIVE' LIMIT 1")
# Token en el HEADER, no en el query string (D-A3).
curl -sG "https://graph.facebook.com/$V/$AS_ID" \
  --data-urlencode "fields=status" -H "Authorization: Bearer $T"   # anotá el status
curl -s $CK -X POST "http://localhost:3005/api/ads/reglas?preview=1" \
  -H 'content-type: application/json' -d "{\"id\":$RID}"
curl -sG "https://graph.facebook.com/$V/$AS_ID" \
  --data-urlencode "fields=status" -H "Authorization: Bearer $T"
# EL STATUS TIENE QUE SER IDÉNTICO. Si cambió, el preview está actuando de verdad.

# 8 — el historial devuelve las explicaciones y el badge sale de `estado`
curl -s $CK 'http://localhost:3005/api/data/ads/historial?limit=5' \
  | python3 -m json.tool | head -40
# cada fila tiene que traer explicacion, estado, dry_run, ok, skipped_reason y
# actor_hint. El badge sale de `estado` (§6.1), que es una columna explícita: es
# lo único que puede representar 'indeterminado' (un POST que cortó por timeout y
# NO SE SABE si se aplicó). Con los tres campos viejos ese caso se mostraba como
# "error", el usuario creía que no pasó nada, lo hacía a mano, y el cambio se
# aplicaba dos veces.

# 8b — el filtro por estado acepta los seis valores y rechaza cualquier otro
for E in confirmado simulado omitido fallido indeterminado pendiente; do
  curl -s -o /dev/null -w "$E:%{http_code}\n" $CK \
    "http://localhost:3005/api/data/ads/historial?estado=$E&limit=1"
done
curl -s -o /dev/null -w "inventado:%{http_code}\n" $CK \
  'http://localhost:3005/api/data/ads/historial?estado=cualquiera&limit=1'
# esperado: 200 en los seis y 400 en el inventado. El vocabulario está cerrado por
# el CHECK ad_actions_estado_valido, así que el parámetro se valida contra esa
# lista y no hay que traducir nada.

# 8c — los eventos de configuración se pueden filtrar y se ven
curl -s $CK 'http://localhost:3005/api/data/ads/historial?source=system&limit=5' \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);[print(f["created_at"],f["action"],f["explicacion"][:70]) for f in d["filas"]]'
# esperado: el apagado y el prendido del modo simulación de la verificación 2c.
# Es el evento más importante del módulo y tiene que ser encontrable.

# 9 — la paginación es por cursor y no saltea (§6.4)
curl -s $CK 'http://localhost:3005/api/data/ads/historial?limit=2' \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print([f["id"] for f in d["filas"]])'
# tomá el último id y pedí la página siguiente con before=<ese id>:
# los ids no se tienen que repetir ni saltear

# 10 — borrar la regla NO borra su historial
$PSQL -c "INSERT INTO ad_actions (rule_id, rule_name, source, account_id, level, object_id,
                                  action, ok, explicacion)
          VALUES ($RID, 'PRUEBA T19', 'rule', 'act_x', 'adset', 'AS_X', 'pause', true,
                  'prueba de historial huérfano');"
curl -s $CK -X DELETE "http://localhost:3005/api/ads/reglas?id=$RID"
$PSQL -tAc "SELECT rule_id IS NULL, rule_name FROM ad_actions WHERE object_id='AS_X';"
# esperado: t|PRUEBA T19  (rule_id en NULL, el nombre sigue legible)
$PSQL -c "DELETE FROM ad_actions WHERE object_id='AS_X';"

# 11 — REVISALAS EN EL BROWSER. Esto no se verifica con curl:
#   · con force_dry_run prendido, el banner grande de simulación se ve arriba (§3.1)
#   · al apagarlo, el banner cambia a tono warn
#   · el badge SOMBRA/ACTIVA por fila se distingue de un vistazo
#   · escribir 250% en el formulario muestra "€10,00 pasaría a €25,00" (§4.1)
#     — €25,00 es lo CORRECTO: el porcentaje es un FACTOR (×2,5), no un incremento.
#     Si dice €35,00, está aplicando actual × (1 + p/100) y D-A9 está mal
#     implementado: toda la escalera del usuario haría más de lo que él configuró.
#     La evidencia está en su export: Utmify guarda actionPercentInfo = 2.5, y el
#     techo de la regla de €75 es exactamente €30,00 × 2,5 al céntimo.
#   · escribir 100% dice "sin cambio" (con la lectura de incremento diría que duplica)
#   · con el límite de €25,00, el preview dice que queda en €25,00
#   · elegir nivel "Anuncios" saca las acciones de presupuesto del select
#   · elegir "Pausar" deshabilita valor, unidad y límites (no los esconde)
#   · escribir 50% en una regla de SUBIR se advierte en el momento y no se puede
#     guardar, explicando que un factor menor a 100 baja el presupuesto (§4.1)
#   · escribir 250% en una regla de BAJAR se advierte igual
#   · el "nivel de las condiciones" está fijo en "del objeto": 'parent' no se
#     ofrece, ni siquiera deshabilitado con la opción visible (§4.6)
#   · al lado del techo se lee "el máximo absoluto por objeto es €200" (§4.7)
#   · una regla sin condiciones se muestra con el badge rojo (§3.4)
#   · prender dryRun=false pide confirmación con el detalle de qué haría (§3.2)
#   · "correr ahora" muestra resultados y dice que fue simulado
#   · en el historial, las explicaciones se leen como frases, no como campos
#   · los badges de "sin confirmar" (indeterminado) y "en curso" (pendiente) se
#     distinguen de "error", y el tooltip dice que NO SE SABE si se aplicó
#   · los chips de "solo errores" y "sin confirmar" filtran
#   · con el teclado solo: se llega a los switches y se activan, con foco visible

# 12 — limpieza y estado seguro
$PSQL -c "DELETE FROM ad_rules WHERE name LIKE 'PRUEBA T19%';"
$PSQL -c "DELETE FROM ad_actions WHERE rule_name LIKE 'PRUEBA T19%';"
$PSQL -c "UPDATE settings SET value='true'::jsonb  WHERE key='ads_rules_force_dry_run';"
$PSQL -c "UPDATE settings SET value='false'::jsonb WHERE key='ads_rules_enabled';"
$PSQL -c "UPDATE settings SET value='55'::jsonb    WHERE key='ads_insights_ttl_seconds';"
$PSQL -c "UPDATE settings SET value='200'::jsonb   WHERE key='ads_max_daily_budget_eur';"
# Las filas de config que dejaron las pruebas (object_id='ads_rules_force_dry_run')
# SE DEJAN: son auditoría real de que el switch funciona.

# 13 — no se tocó nada de lo existente
# `git diff` NO SIRVE en este proyecto: `dashboard-admin` no esta trackeado
# en el repo git del padre (~/Desktop/funnel solo trackea .kiro y funnel-mate),
# asi que TODOS los archivos son untracked y el diff sale vacio o inutil.
# Verificado. El chequeo que si funciona es por fecha de modificacion:
find . -newermt '-3 hours' -type f \
  -not -path './node_modules/*' -not -path './.next/*' -not -path './.git/*' \
  -not -name '*.log' -not -name 'tsconfig.tsbuildinfo' | sort
```

## 8. Cuándo parar

**Bloqueante, pará y avisá:**

- **La verificación 3 devuelve `t|f`.** Una regla que nace prendida y actuando es la forma más directa
  de que este módulo gaste plata sin que nadie lo haya decidido.
- **La verificación 7 muestra que el preview cambió el estado en Meta.** Un botón de "probar" que actúa
  es peor que no tenerlo.
- La verificación 6 duplica condiciones. Una regla con las condiciones de dos versiones distintas corre
  cada minuto y hace algo que nadie configuró.
- **El preview del porcentaje muestra €35,00 en lugar de €25,00 para "250% sobre €10,00".** El porcentaje
  es un FACTOR (`actual × 2,5`), no un incremento (`actual × 3,5`): D-A9, verificado contra el export real
  del usuario. Si el preview dice €35,00, la implementación usa `1 + p/100` y toda la escalera del usuario
  va a subir más de lo que él configuró, con los techos cortando en cada corrida.

  > La versión anterior de este task pedía exactamente lo contrario acá y en la verificación 11 ("si dice
  > €25,00, D-A9 está mal implementado"), contradiciendo su propio §4.1 y el plan. Era una de las cuatro
  > apariciones de esa contradicción y está resuelta a favor del factor, que es lo que dice la evidencia.

- **El `find` de la verificación 13 lista `SubNav.tsx`, `Nav.tsx` o `components/ui.tsx`.** `git diff` no
  te lo va a decir: `dashboard-admin` no está trackeado en el repo del padre y el diff sale vacío.

**Anotalo en §10 del plan y seguí:**

- `SubNav.tsx` todavía no existe porque T17 no terminó. Escribí el import igual y anotalo; no hagas tu
  propia copia (§8 del plan: un archivo, un dueño).
- Necesitás una métrica de condición que no está en las 13 del `CHECK`. **No modifiques la migración**
  (es de T13): anotá cuál y por qué.
- El preview no encuentra ningún objeto que la regla alcance, así que no podés mostrar un ejemplo con un
  presupuesto real. Usá €10,00 como ejemplo y aclará que es un ejemplo. Anotalo.
- El formulario te queda largo y difícil de navegar con el teclado. Anotá qué campos agruparías: la
  reorganización no está en el alcance de este task, pero el dato sirve.
