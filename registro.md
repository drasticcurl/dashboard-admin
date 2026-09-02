# Registro de cambios

Qué se cambió, cuándo, y **por qué**. El "por qué" es el motivo por el que este
archivo existe: el commit dice qué se tocó, esto dice qué problema había y qué
decisiones se descartaron. Un `git log` contesta "qué cambió"; esto contesta
"por qué alguien tocó esto y qué pasa si lo vuelvo atrás".

Lo más nuevo va arriba. Las reglas de cómo se escribe una entrada están en
`.kiro/steering/registro.md`.

---

## 2026-09-02 — El Boton_Actualizar con sesión vencida mostraba un error de parseo en vez de "sesión vencida"

**Qué pasaba.** El usuario reportó, en Safari: «El refresco de gasto falló: The
string did not match the expected pattern — se muestran las filas guardadas».
En el log de Caddy de producción (`/var/log/caddy/panel.log`) apareció el
pedido exacto: `GET /api/data/ads?...&forzar=1` (el Boton_Actualizar) a las
2026-09-02 11:04:02 UTC, mismo User-Agent Safari, con `"status":307` y
`"Location":"https://panel.hilvanapp.com/"` — no un 401, no un 500: un
redirect a la página de login.

La cadena completa: la cookie de sesión (`panel_token`, TTL 12 h) había
vencido. `middleware.ts` redirige TODO lo que no matchea con un 307 a `/`, sin
distinguir una navegación de página de un `fetch` de un componente. `fetch`
sigue ese redirect solo, así que `leerFilas` (`GestorAnuncios.tsx:712`) recibe
el HTML de la pantalla de login donde esperaba JSON, y `res.json()` tira. El
mensaje que llegó a pantalla es el de ESE parseo fallido, no el problema real.
Confirmado con la documentación de WebKit (trackjs.com) y un issue idéntico en
`strapi/strapi#25274`: Safari tira `SyntaxError: The string did not match the
expected pattern` al parsear no-JSON como JSON; Chrome, para el mismo caso,
tira `Unexpected token '<'` (ya documentado en un comentario existente de
`cuerpoDeAcciones`, para el POST de acciones — este bug era el mismo problema
en el GET de lectura, que no pasa por esa función).

**Por qué se resolvió así.** Cada route de `/api/**` (salvo `ingest`/
`webhooks`, ya afuera del matcher) ya hace `isAuthenticated(...)` y devuelve
`401 { ok: false, error: 'unauthorized' }` — es el guard que varios comentarios
en esos routes describen como "el que cubre si alguien le toca el matcher al
middleware". Ese guard nunca corría: el middleware cortaba antes con el
redirect. El arreglo es que `middleware.ts`, para paths bajo `/api/`, conteste
él mismo ese mismo 401 JSON en vez de redirigir — la misma respuesta que el
route de abajo ya da, adelantada un paso.

Se descartó sacar `/api/*` del matcher para que cada route maneje su propio
401 sin intervención del middleware (que hubiera sido un cambio menor). Un
grep sobre todos los `route.ts` de `app/api/` mostró que varias rutas GET de
sólo lectura bajo `/api/config/*` (`funnels`, `products`, `shops`, `fx`) **no
tienen guard propio** — dependen exclusivamente del middleware para no
responder sin sesión. Sacarlas del matcher las hubiera dejado abiertas sin
cookie. La corrección tenía que mantener la protección para TODO bajo
`/api/`, y sólo cambiar la forma de la respuesta cuando corresponde.

También se descartó "arreglarlo" en el cliente (que `leerFilas` mirara
`res.redirected` o el content-type antes de parsear): hubiera tapado el
síntoma en un solo llamador y dejado el mismo problema en cualquier otro
`fetch` a `/api/*` que no pase por `leerFilas` — el POST de acciones ya tiene
su propio `cuerpoDeAcciones` para lo mismo, y agregar un tercer parche de
cliente en vez de arreglarlo una vez en el middleware hubiera sido la
definición de duplicar la regla.

**Qué se verificó.** `middleware.test.ts` tiene tests nuevos que fijan el
comportamiento: sin cookie o con cookie vencida, una ruta de API (`/api/data/
ads`) devuelve 401 con cuerpo JSON parseable y sin header `Location`; una
ruta de página (`/anuncios`) sigue devolviendo el 307 de siempre; con cookie
válida, la ruta de API deja pasar. Los 12 tests del archivo (6 nuevos + 6
existentes de `urlDeLogin`) pasan. `tsc --noEmit` limpio, `npm run build`
compila y los 1431 tests de la suite completa pasan en local (0 fallos, 46
skipped por falta de base). En el deploy, `npm test` corrió de nuevo contra la
base real de la VPS y también en verde.

Deployado a hilvanapp el mismo día (release `20260902152843`, commit
`800a594`; la anterior era `20260902095800`). **Confirmado contra producción,
no sólo en test**: `curl` sin cookie a `https://panel.hilvanapp.com/api/data/
ads` devuelve `401` con `content-type: application/json` y cuerpo
`{"ok":false,"error":"unauthorized"}` — antes de este deploy ese mismo pedido
daba `307` con `Location: /` y HTML, que es exactamente el caso que rompía
`res.json()` en el cliente. `curl` a `/` sigue en `200`, así que el login
normal no cambió. Sigue sin poder confirmarse el caso de un usuario real con
sesión vencida en el navegador (Safari o Chrome) viendo el aviso nuevo en vez
del error de parseo — para eso hace falta que alguien tenga el panel abierto
12 h y apriete Actualizar, que no se puede forzar desde acá.

---

## 2026-09-02 — Una cuenta sin gasto se quedaba con el error de sync pegado para siempre

Commit `90bc0c1`. Deployado a hilvanapp el 2026-09-02 10:07 (release
`20260902095800`; la anterior era `20260901234928`). Toca `lib/ads/sync.ts` y
`lib/ads/sync.creativo.test.ts`.

**Qué pasaba.** El panel mostraba «gasto sync con error — TypeError: fetch failed»
mientras al lado decía que la jerarquía estaba al día. El error era de la cuenta
`act_2120381458824082` («Protocolo reset»), con `last_sync_at` congelado en
**2026-09-01 14:27:38**: casi 10 horas antes, aunque el cron de gasto corre cada
hora y la otra cuenta estaba sincronizada hacía 0 minutos.

La clave está en esta línea de `syncAdSpend`:

```ts
if (dryRun || relevantes.length === 0) continue;
```

El `UPDATE ad_accounts SET last_sync_at = now(), last_sync_error = NULL` vive al
final del `tx` que escribe las filas, o sea **después** de ese `continue`. Una
cuenta que devuelve cero filas relevantes se va de la iteración sin marcar la
corrida, así que:

1. El 2026-09-01 a las 14:27 hubo un `TypeError: fetch failed` genuino y
   transitorio (error de red de undici). El `catch` escribió el error y la fecha.
2. Esa cuenta no tiene gasto desde el **2026-08-26** (0 filas en `ad_spend` de
   ayer u hoy, 32 filas históricas). Todas las corridas siguientes anduvieron
   bien y devolvieron cero filas.
3. Con cero filas nunca se limpió el error ni avanzó el reloj. El panel mostró
   un fallo de 10 horas atrás para un sync que funcionaba.

**Y no era sólo cosmético.** Las dos puertas de frescura del módulo miran
`min(last_sync_at)` de todas las cuentas activas —`live.ts:93` y `refrescarGasto`
en `run-ad-rules.ts:308`— y eso es deliberado: con `max` un fallo se vería como un
dato fresco. Pero con una cuenta clavada en el pasado ese mínimo nunca sube. Medido
en producción: el worker veía una edad de **35 491 segundos contra un TTL de 55**,
así que el TTL de insights estaba permanentemente vencido y **cada carga de pantalla
del panel disparaba un `syncAdSpend` completo contra Meta**.

**Por qué se resolvió así.**

**Cero filas es una corrida exitosa y se marca como tal.** Se separó el `continue`
del `dryRun` del de las filas, y el caso de cero filas ahora hace su propio
`UPDATE` (sin transacción: no hay nada que escribir junto).

**El `dryRun` sigue sin tocar el reloj**, y hay un test de esa mitad: una corrida
que no sincronizó nada no puede afirmar que la cuenta está fresca. Meterlos en el
mismo `if` fue justamente el origen del bug.

**No se tocó `min(last_sync_at)`.** La tentación era pasarlo a `max`, y sería peor:
el comentario de `live.ts:92` explica que con `max` un fallo de una cuenta se
esconde detrás del éxito de la otra. El mínimo está bien; lo que estaba mal era que
una cuenta no actualizara su fila.

**La jerarquía ya tenía esto resuelto** y sirvió de modelo: `anotarCorrida` se
llama en un punto donde convergen todos los desenlaces, y por eso
`last_hierarchy_sync_at` sí estaba al día. Era la asimetría que el usuario vio
desde el panel sin saber que era una asimetría.

**Lo que se decidió NO hacer:** no se limpió el error a mano en producción. Con el
arreglo deployado, la primera corrida de esa cuenta lo limpia sola; un `UPDATE`
manual taparía el síntoma sin dejar registro de que el arreglo funcionó.

**Qué se verificó.** El test nuevo falla sin el arreglo con exactamente el mensaje
que se veía en pantalla: `expected 'TypeError: fetch failed' to be null`. Con el
arreglo, los 6 de `sync.creativo.test.ts` pasan. `tsc --noEmit` limpio y 162 tests
de `lib/ads` + `lib/queries/ads.filtros` en verde.

**Y verificado en producción después del deploy**, sin ningún `UPDATE` manual:
`last_sync_error` quedó en NULL en las dos cuentas, y «Protocolo reset» —que sigue
sin gasto— pasó a sincronizar cada corrida (`last_sync_at` de hace 34 segundos).
El TTL de insights volvió a funcionar: la edad que ve el worker es **34 segundos
contra un TTL de 55**, cuando antes eran 35 491.

---

## 2026-09-02 — Confirmación en vivo del deploy anterior, y lo que sigue sin poder confirmarse

Sin cambios de código. Se registra porque cierra la verificación que el 2026-09-01
quedó abierta, y porque una de las dos cosas **sigue** abierta.

**Las reglas no se tocaron, y está medido.** El usuario pidió explícitamente no
tocarlas (ya estaban las 11 en real). Se sacó un checksum md5 de las 11 reglas con
sus condiciones antes del deploy y otro después: **`240b5d6188f120e75b47b5d69b5bc3f7`
en los dos**. Vale como método para la próxima: el deploy no toca `ad_rules` (no hay
migraciones nuevas y los tests corren contra `panel_test`), pero medirlo cuesta una
consulta y evita tener que creerlo.

**Lo que sí quedó confirmado.** El reseteo de las 00:00 hizo su trabajo la primera
noche: 1 corrida, 450 objetos evaluados, **36 conjuntos bajados a €25** desde €100 y
€75, 0 omitidas. Y la escalera arrancó: «Escalera 1» subió tres conjuntos de €10 a
€25 entre las 05:26 y las 07:30. Los peldaños 2 a 6 corrieron 20 veces cada uno con
0 objetos que cumplen, que es lo correcto a esa hora: los presupuestos estaban en
€10–€25 y ninguno había gastado la mitad todavía.

**Lo que sigue sin confirmarse, y por qué.** El bucle de pausas. Hoy hay **0 pausas
en todo el día** (antes eran 23 a 57 por conjunto), pero eso todavía no prueba nada:
la consulta que importa devolvió **0 conjuntos pausados con gasto de hoy**, y esa es
justamente la única situación que dispara el bucle. Los 24 conjuntos con gasto están
todos activos, porque el reseteo los dejó en €25 y ninguno llegó a gastar €5,50 sin
ventas.

O sea que el bucle no tuvo oportunidad de aparecer, igual que la noche anterior no
la tuvo por el cambio de día. **Lo que hay que mirar es el momento en que el
apagador pause a alguien**: con el bug, ese conjunto volvía a aparecer y se pausaba
otra vez cada 5 minutos; con el arreglo se pausa una sola vez. La consulta que lo
distingue es contar pausas **por objeto**, no en total:

```sql
SELECT object_id, count(*) FROM ad_actions
 WHERE action='pause' AND estado='confirmado' AND NOT dry_run
   AND created_at >= date_trunc('day', now())
 GROUP BY 1 HAVING count(*) > 1;
```

Cero filas = arreglado. Cualquier objeto con más de una pausa en el día = volvió.

Queda anotado también que la regla de apagar ahora corre **cada 5 minutos**
(el usuario la bajó de 15), así que si el bug estuviera vivo el bucle sería tres
veces más rápido que el que se midió.

---

## 2026-09-02 — Nota: el aviso de «revisar N importes» es un falso positivo esperado

Sin cambios de código. Se registra porque la pregunta va a volver.

El usuario preguntó por qué casi todas sus reglas muestran «revisar 1/2/3 importes
en acción y condición». Es `sospechasDeRegla` (`lib/ads/reglas/sospecha.ts`),
el detector del bug viejo de parseo donde `numeroDeTexto` leía `"1.000"` como `1`.
Marca **todo importe en EUR entre 0 y 100**, porque cualquiera de esos pudo haber
sido un número mil veces más grande, y el propio módulo declara que sus falsos
positivos son esperados y no se filtran.

Toda la operación de esta cuenta vive entre €4 y €100, o sea exactamente dentro de
la ventana del detector. De ahí que salte en casi todas.

**Se verificó que el caso peligroso NO existe en estas reglas**, y es el único de
esta familia que hace daño: un `budget_decrease` con `action_unit = 'percent'`
donde un `1.500` que quería decir 150% queda guardado como 1,5 y significa «bajá el
presupuesto al 1,5% del actual». El CHECK `ad_rules_percent_direccion` no lo atrapa
porque para bajar exige `< 100`. En producción los 5 porcentajes son todos
`budget_increase` con `action_value = 200`, y el reseteo usa importe fijo.

Si en algún momento molesta, la opción menos mala es filtrar por fecha: el parseo
ya está arreglado, así que una regla creada o editada después del arreglo no puede
tener valores corrompidos, y eso silenciaría las nuevas sin perder la detección en
las viejas. Bajar `UMBRAL_BAJO_EUR` de 100 a 10 también reduce el ruido, pero pierde
la familia de cinco dígitos (`25.000` → 25), que es justo la que este panel podría
tener.

---

## 2026-09-01 — Dos bugs del motor de reglas: la escalera clavada en €100 y el bucle de pausas

Commit `c1e73bb`. Deployado a hilvanapp el 2026-09-02 00:00 (release
`20260901234928`); la anterior era `20260829120140`. Toca
`lib/ads/reglas/repo.ts`, `lib/ads/reglas/motor.ts`,
`lib/ads/reglas/explicacion.ts`, `lib/ads/reglas/utmify.ts`, `lib/ads/tipos.ts`,
`lib/queries/ads.ts`, cinco archivos de test, y agrega
`docs/reglas-escalera-2026-09-01.csv`.

Son **dos bugs independientes** que salieron de la misma sesión, los dos
diagnosticados con consultas de lectura sobre la base de producción. El primero
explicaba el síntoma que el usuario reportó; el segundo apareció mirando el
historial y lo encontré antes de que se notara.

---

### Bug 1 — El cooldown lo movían filas que no eran acciones

**Qué pasaba.** El usuario reportó que sus reglas de subir presupuesto "siempre
llegan a 100 y no llegan a más". Era literal: la regla «Duplicar a $200 - Gasto
+$50 ROI +1.5» (id 63 en producción) tenía **0 acciones aplicadas desde el
2026-08-20**, con 142 corridas y 19 objetos que cumplieron las condiciones. Las 19
se omitieron, todas con `skipped_reason = 'cooldown'`.

No era el techo absoluto ni el cupo por objeto. Era esto, en
`repo.ts:historialDeHoy`:

```sql
count(*) FILTER (WHERE estado IN ('confirmado', 'indeterminado')) AS cuenta,
max(created_at)                                                  AS ultima_at,
```

El contador de cupo filtraba por estado y `max(created_at)` no. `ultima_at`
alimenta `ultimaAccionRealAt`, que es contra lo que `motor.ts` (paso 4) mide el
cooldown, y el cooldown existe para separar dos acciones **reales** sobre el mismo
objeto. Con ese `max` sin filtrar, **cualquier** fila del día reiniciaba el reloj,
incluidas las `omitido` — que no llaman a Meta, no consumen cupo y no son acciones.

La secuencia, dentro de un mismo tick:

1. Un conjunto llega a €100.
2. «Duplicar a $100» lo evalúa, ve que ya está en su techo y escribe una fila
   `omitido / techo_alcanzado`. No toca Meta.
3. «Duplicar a $200» corre después (el orden de `reglasActivas()` es `ORDER BY
   id`, y 60 < 63), pide el historial del objeto y recibe el timestamp de esa
   fila, de hace 0 segundos.
4. Cooldown de 30 minutos → omitida. Cada 30 minutos, para siempre.

Medido en la base de producción: las 19 omisiones por cooldown del peldaño de €200
en 3 días estaban precedidas, sobre el mismo objeto, por un `techo_alcanzado` del
peldaño de €100 escrito **entre 0 y 74 segundos antes — 19 de 19**, mientras la
última acción REAL de esos conjuntos era de **487 a 740 minutos antes** o no
existía en el día. La correlación cierra por el otro lado: los dos peldaños que en
producción tenían `cooldown_minutes = 0` (€50 y €100) aplicaron 52 y 9 veces; los
dos con cooldown 30 (€25 y €200) aplicaron 9 de 241 y 0 de 19.

El peldaño que ya había hecho su trabajo bloqueaba al siguiente. Agregar €400 y
€800 sólo habría agregado dos bloqueadores más.

**Por qué se resolvió así.**

**El arreglo es agregarle a `max(created_at)` el mismo FILTER que ya tenía
`cuenta`**, y no bajar el cooldown de las reglas. Bajar el cooldown a 0 era el
workaround que ya estaba aplicado a mano en dos peldaños de producción y es lo que
enmascaraba el bug: funcionaban por no tener cooldown, no porque el cooldown
funcionara. Además dejaba sin freno el caso real que el cooldown protege (dos
reglas peleándose por el mismo conjunto). El índice
`ad_actions_objeto_idx` de la 016 ya es parcial sobre
`estado IN ('confirmado','indeterminado')` y su comentario dice que la pregunta que
sostiene es «¿cuántas acciones REALES tuvo hoy **y cuándo fue la última**?»: el
FILTER que faltaba era el que hacía verdadera esa frase.

**`sin_cerrar` se dejó mirando TODAS las filas del día**, a propósito: una fila
`pendiente` es exactamente lo que no se puede ignorar. Sólo se filtró `ultima_at`.

**No se tocó la consulta de la columna «ÚLT. ACTUALIZACIÓN» del gestor**, que usa
`ad_actions_ultima_idx` (`WHERE NOT dry_run`, sin filtro de estado). Ahí "lo último
que pasó con este objeto" incluye legítimamente un intento omitido; el bug era
usar ese criterio para un freno.

**El tope por objeto del importador pasó de 4 a 10** (`FRENOS_POR_DEFECTO` en
`utmify.ts`). El comentario viejo decía «4 alcanza para la escalera
25→50→100→200». Alcanzaba justo, y por eso no alcanzaba: el cupo se cuenta **por
objeto y no por (regla, objeto)** —`historialDeHoy` filtra sólo por `object_id`—,
así que una pausa, una reactivación o una acción manual sobre el mismo conjunto le
come un peldaño. La escalera de 6 peldaños son 6 subidas, más el reseteo de las
00:00, más al menos una pausa: 10 deja todo eso con margen.
Subirlo no afloja el freno que acota la plata: eso lo hace
`ads_max_daily_budget_eur`, que **rechaza** (no recorta) cualquier presupuesto
calculado por encima suyo. Este tope acota la cantidad de ediciones por día, que es
protección contra reiniciar la fase de aprendizaje de Meta, no contra el gasto.

**El CSV nuevo pone una banda de presupuesto en cada peldaño** (`budget >= mitad` y
`budget < objetivo`) en vez de dejar que el techo haga sólo de tope. Con la banda,
`budget >= objetivo/2` implica que `×2 >= objetivo`, así que **cada peldaño aterriza
exacto en su objetivo** desde cualquier punto de su banda, y un conjunto que ya
llegó da `cumple = false`: no escribe fila. Eso elimina las **232 filas
`techo_alcanzado` en 3 días** que ensuciaban el historial y que eran el combustible
del bug de arriba. Es cinturón y tirantes: el arreglo de `repo.ts` solo ya bastaba,
pero un historial legible es lo que hizo diagnosticable esto.

**Los peldaños usan factor 2 y no 2.5 ni 5.** Los de producción tenían 2.5 y 5 con
el techo haciendo el recorte, o sea que el factor era decorativo y el nombre
"duplicar" era falso. Con la banda, 2 es exacto y el nombre dice la verdad.

**El peldaño de entrada (€25) mantiene el truco de `fixed` enorme** (€900,99 con
techo €25): tiene que **poner** el presupuesto en 25 desde donde esté (hay
conjuntos en €3 y €10), y un factor 2 sobre €3 da €6.

**Los dos «resetear presupuesto» de campaña se reemplazaron por UNO a nivel
conjunto.** El presupuesto de esta cuenta vive en el conjunto: 95 conjuntos con
`daily_budget` propio contra 3 campañas con presupuesto diario. A nivel campaña
esas reglas eran un no-op garantizado, y son el origen de los 66
`sin_presupuesto_en_este_nivel` del historial. El usuario además aclaró que el
diseño viejo (dos reglas a las 23:00 con condiciones de gasto y ROI, una a €15 y
otra a €25) no era lo que quería: quería **una sola regla, a las 00:00, que baje a
€25 todo conjunto que pase de €50**. Eso el sistema sí lo expresa, y es lo que
está en el CSV: `ReduceBudget` con el truco de `fixed` enorme (€900) y piso €25,
condición única `budget > €50`, `OncePerDay` a la hora 0. Lo que faltaba no era una
capacidad, era saber que "bajar a un valor fijo" se escribe como "restar un montón
con piso en ese valor".

**Lo que se decidió NO hacer en el bug 1:**

- **No se cambió ningún `setting` de producción.** La escalera a €400 y €800
  necesita subir `ads_max_daily_budget_eur` (hoy **200**) y
  `ads_max_delta_por_tick_eur` (hoy **300**, y un salto de €400→€800 es un delta de
  €400 que se rechazaría todos los ticks). El comentario de la 016 dice que ese
  techo se cambia con un acto consciente y no desde el mismo código que mueve
  presupuesto; queda pendiente de decisión del usuario. **Con los valores de hoy la
  escalera llega a €200 y el peldaño 5 sale `tope_absoluto`** — verificado abajo.
- **No se borró «ACTIVAR A LAS 00 CAMPAÑAS (copia)» aunque el nombre diga
  "(copia)".** No es una duplicada: la original es `campaign` y la "copia" es
  `adset`. Borrarla por el nombre se lleva la única regla que reactiva conjuntos.
  Esto es exactamente el tipo de cosa por la que existe este archivo.
- **No se tocaron los umbrales de las reglas de apagar.** Las dos cuentas tenían
  valores distintos para la misma regla (`roi<=1.2 / gasto>€7` en una,
  `roi<=1.1 / gasto>€9` en la otra) y no hay forma de saber cuál fue intencional.
  El CSV lleva los de la cuenta que opera (HIlvanapp), byte por byte. El usuario
  después confirmó que borró todo y que sólo quiere reglas en HIlvanapp, así que la
  divergencia deja de existir sola.

---

### Bug 2 — El bucle de pausas: un anti-join que preguntaba lo que no quería

**Qué pasaba.** La regla «Apagar - Gasto +$4 sin ventas» pausó los **mismos 15
conjuntos entre 23 y 57 veces por día** (202 pausas confirmadas en un día), con
intervalos de ~15 minutos y las `metrics` congeladas siempre idénticas
(`spendEur: 7.18, sales: 0`). Todas `confirmado`: pausar algo ya pausado es un
no-op que Meta acepta con 200.

La primera hipótesis —la del usuario y la mía— era que faltaba refrescar el estado
con un cron. **Es falsa: el cron ya existe** (`*/15 * * * *
scripts/sync-ads-jerarquia.ts`), corre sin errores, `last_hierarchy_sync_at` estaba
a 11 minutos y los 15 conjuntos figuraban `status='PAUSED'`, `vigente=true`. Vale
registrarlo porque es la respuesta que parece obvia y habría costado un cron nuevo
sin arreglar nada.

La causa está en `getMetricasAds` (`lib/queries/ads.ts`). El alcance de una regla
es la CTE `objetos`, que une la jerarquía con los objetos que **sólo** tienen gasto
en `ad_spend`. Esa segunda rama existe con buen motivo (gasto de un objeto sin fila
en la jerarquía no se puede esconder) y trae `NULL::text AS status`. El problema era
a quién le preguntaba el anti-join:

```sql
jerarquia_objetos AS (... WHERE vigencia AND s.status = 'ACTIVE'),  -- ← ya filtrada
objetos AS (
  SELECT * FROM jerarquia_objetos
  UNION ALL
  SELECT ..., NULL::text AS status, ... FROM gasto g
   WHERE NOT EXISTS (SELECT 1 FROM jerarquia_objetos h WHERE ...)   -- ← acá
)
```

Con el filtro de estado adentro de la CTE que el anti-join usa como referencia, la
pregunta deja de ser «¿este objeto no está en la jerarquía?» y pasa a ser «¿no está
entre los ACTIVOS?». Entonces:

1. El conjunto está ACTIVE, entra por la jerarquía, la regla lo pausa.
2. `ad_sets.status` pasa a PAUSED, así que sale de `jerarquia_objetos`.
3. El anti-join lo considera «no está en la jerarquía» y lo **reinyecta** por la
   rama de gasto, con `status = NULL`.
4. El paso 2 de `motor.ts` compara `fila.status === 'PAUSED'`. `null` no es
   `'PAUSED'`, así que no descarta nada y vuelve a pausar. Una vez por tick.

**La huella que lo prueba**, y es inequívoca: cada uno de los 15 conjuntos tiene
**exactamente UNA** fila de pausa con `before_value = 'ACTIVE'` (la legítima) y
entre **49 y 56** con `before_value = NULL` (`before_value` sale de `fila.status`,
`ejecutor.ts:457`). Y **cero** acciones `activate` en 48 horas, o sea que nada los
reactivaba.

**Por qué se resolvió así.**

**El filtro de estado se movió AFUERA de la jerarquía**, aplicado sobre la columna
ya proyectada, y el anti-join ahora apunta a una CTE `jerarquia_vigentes` sin
filtrar. Es una línea de SQL y deja las dos preguntas separadas: «¿existe en la
jerarquía?» y «¿tiene el estado que pedí?».

**No se borró la rama de solo-gasto**, que era la otra salida posible. Existe para
que el gasto de un objeto sin fila en la jerarquía no desaparezca del panel, hay
property tests de eso, y esconder plata gastada es peor que el bucle.

**Y se cerró también en el motor, con un motivo nuevo `estado_desconocido`.** Este
es el punto que el arreglo del SQL solo no cubre, y lo descubrí porque un test que
escribí falló: **la rama de solo-gasto es deliberadamente ciega al filtro de
estado**, así que una regla de pausar puede recibir un objeto con `status` en NULL
incluso pidiendo "activos" — legítimamente, cuando el objeto no está en la
jerarquía. Con `null !== 'PAUSED'` eso seguiría pasando de largo. Ahora el paso 2
no actúa con el estado en NULL, con el mismo criterio que el paso 1 aplica a las
métricas nulas: no se decide con "no sé". Los dos arreglos son mitades, no
alternativas.

El freno es **sólo para `pause`/`activate`**. Una regla de presupuesto sobre un
objeto de estado desconocido sigue actuando: el presupuesto no depende del estado y
bloquearla sería inventar un freno que nadie pidió. Hay un test de eso.

**Lo que se decidió NO hacer en el bug 2:**

- **No se agregó ningún cron.** El de la jerarquía ya corre cada 15 minutos y no
  era el problema. Un cron cada 5 minutos habría triplicado las llamadas a Meta
  para tapar un bucle que no se tapa con frescura: el conjunto reinyectado por la
  rama de gasto viene con `status` NULL **por construcción del SQL**, no por estar
  desactualizado.
- **No se le puso `COALESCE` a `actualizarJerarquia`**, que hace
  `SET status = $2` y puede escribir NULL encima de un ACTIVE si Meta omite el
  campo. Es una tercera puerta al mismo bucle y ahora la tapa el freno del motor.
  Cambiar el UPDATE a `COALESCE(status, $2)` mentiría en la otra dirección
  (conservar un estado viejo como si fuera fresco), y eso es peor. Queda anotado.
- **No se tocó `marcarJerarquiaVieja`**, que baja `synced_at` sin corregir el
  estado. Eso expulsa la fila de la ventana de vigencia (`SQL_VIGENTE`) y la manda
  también a la rama de solo-gasto. Misma tapa: el freno del motor.

**Qué se verificó (los dos bugs).**

- **Los cuatro tests de regresión fallan sin su arreglo.** Se restauró el
  `max(created_at)` viejo → los dos de `repo.test.ts` fallaron
  (`expected 2026-09-01T17:19:16.292Z to be null`). Se volvió a apuntar el
  anti-join a `jerarquia_objetos` → los dos nuevos de `ads.filtros.test.ts`
  fallaron. Con los arreglos puestos, pasan.
- Los timestamps del test de `repo.test.ts` se fijan contra
  `date_trunc('day', now())` y no contra `now()`: con `now() - interval '2 hours'`
  el test se rompe solo entre las 00:00 y las 02:00.
- **El CSV entra por el importador real**: 11 reglas, **0 errores**.
- **La escalera se simuló con `evaluar` de `motor.ts`**, no leyendo el CSV:
  - con `maxDailyBudgetEur = 900` y ROI 2.5 recorre
    `10 → 25 → 50 → 100 → 200 → 400 → 800` y para;
  - con el valor de producción (200) llega a 200 y el peldaño 5 sale
    `tope_absoluto`;
  - con **ROI 1.8 para en €100** (el peldaño 4 pide ROI>2) y con **ROI 1.6 para en
    €50** (el peldaño 3 pide ROI>1.7), que son los umbrales que pidió el usuario;
  - los 6 peldaños aterrizan **exacto** en su objetivo, y ninguno toca un conjunto
    que ya está en el objetivo ni por encima;
  - el reseteo deja €25 y €50 **sin tocar** y manda €51, €100, €200, €400 y €800 a
    €25.
- `npm test`: **1423 pasan**, 46 salteados. Una falla intermitente en
  `finance.test.ts` («Hook timed out in 10000ms») que pasa sola dos veces al
  correrla aislada y no toca nada de lo cambiado. `tsc --noEmit` limpio,
  `npm run build` OK.
**Qué pasó en el deploy (2026-09-02 00:00).**

Deploy limpio: 1470 tests en el server, 0 migraciones nuevas, `verificar-token-ads`
OK, `panel-3005` y `panel-reglas` recargados, health check 200.

Y se subieron los dos topes en `settings`, con el OK del usuario:
`ads_max_daily_budget_eur` **200 → 900** y `ads_max_delta_por_tick_eur`
**300 → 800**. Los 900 dejan margen sobre el peldaño de €800; los 800 del delta
son porque el salto €400→€800 son €400 de una sola vez y con 300 se rechazaba
todos los ticks. Se verificó que `jsonb_typeof(value) = 'number'` en los dos:
`repo.interruptores()` exige `typeof v === 'number'` y con cualquier otra cosa cae
al default **0**, que deja al módulo sin poder subir nada.

**La prueba del bug 2 sobre datos reales.** Se reprodujeron las dos versiones del
anti-join en SQL contra la cuenta de HIlvanapp, preguntando "activos": de **30
conjuntos con gasto en la ventana, el anti-join viejo reinyectaba los 30** con
`status = NULL`; el nuevo reinyecta **0**. Los 30 estaban PAUSADOS y con fila
vigente en la jerarquía.

**El tamaño real del bucle, que era peor de lo estimado:** **2746 pausas
confirmadas con `before_value` en NULL sobre 90 conjuntos desde el 2026-08-20**, la
última a las 23:53:21, cuatro minutos antes del deploy. En las 24 h previas fueron
349 de 354 pausas, o sea el **98,6 %** de lo que hacía el apagador. Cada una era un
POST a Meta que no cambiaba nada.

- **Sin verificar todavía, y por qué no se puede esta noche:** que el bucle no
  vuelva. El deploy cayó justo con el cambio de día en `Europe/Lisbon`, así que el
  gasto de "hoy" volvió a cero y las reglas de apagar piden `gasto > €4,50`: esta
  noche no se reproduce ni con el bug ni sin él. La primera corrida después del
  deploy es consistente («Apagar - Gasto +$4 sin ventas»: 125 objetos evaluados, 0
  que cumplen, 0 acciones) pero **no es concluyente por sí sola**. Lo concluyente
  es la comparación de anti-joins de arriba, más los tests. La confirmación en
  vivo es mañana: que `ad_actions` no acumule pausas con `before_value` en NULL
  cuando los conjuntos vuelvan a gastar.
- **Sin verificar:** que la escalera suba de verdad en Meta. Depende de que un
  conjunto gaste la mitad de su presupuesto con el ROI pedido, y de que el usuario
  importe el CSV nuevo — hasta entonces siguen corriendo las reglas viejas (24
  filas, 9 prendidas), cuyos techos son 25/50/100/200, así que el techo absoluto
  en 900 no les habilita nada que no pudieran hacer antes.
- El diagnóstico salió de consultas de **LECTURA** sobre la base de producción. Lo
  único que se escribió ahí fueron los dos `UPDATE settings` de más arriba.

---

## 2026-08-29 — Finanzas: la pantalla se calla, y el saldo del día persigue al usuario

Rediseño de `/finanzas` y un recordatorio nuevo en todo el panel. Sin commitear
todavía.

**Qué pasaba.** La pantalla mostraba las cuatro secciones abiertas al mismo
tiempo: patrimonio, formulario de carga, gráfico, tabla de movimientos con su
formulario, tabla de pagos programados con el suyo, y la de cuentas. Más de 2000
px de alto. Para ver el gráfico había que scrollear por arriba de un formulario, y
para cargar el saldo había que buscarlo entre dos tablas. **Lo que se mira todos
los días y lo que se administra una vez al mes tenían el mismo peso visual.**

Y el problema de fondo: el patrimonio se mide a mano una vez al día, así que si
hoy no se carga, **ese día se pierde para siempre**. No queda un dato peor: no
queda ninguno — el día no aparece en el gráfico y el número grande dice "sin
información". El único recordatorio era un banner dentro de `/finanzas`, o sea que
había que entrar a Finanzas para acordarse de entrar a Finanzas.

**Por qué se resolvió así.**

**La pantalla por defecto es el patrimonio y su gráfico, nada más.** Las otras
cuatro secciones se abren desde una botonera. Se eligió **reemplazar el contenido
con un modal** y no acordeones ni pestañas: un acordeón deja las secciones a un
click de volver a apilarse (el problema vuelve solo), y con pestañas el patrimonio
—que es el número que uno viene a ver— desaparecería al mirar cualquier otra cosa.

**El botón de cargar saldo no es un botón más.** Cuando falta el saldo del día se
pone amarillo y late; cuando ya está, se apaga a neutro con un ✓. El color pasa a
contestar "¿ya lo hice?", que es la pregunta con la que uno entra. Reemplaza al
banner: la señal vive en el control que la resuelve, no en un cartel al lado.

**El latido va por `box-shadow` y no por `opacity`.** Un botón que se desvanece y
vuelve se lee como "deshabilitado, intermitente" — es el mismo motivo por el que
el `Skeleton` de este panel ya había descartado `animate-pulse`. Un aro que se
expande alrededor de un botón sólido se lee como "acá, tocá esto". 2.4 s y no 1 s:
a un segundo el latido compite con el contenido y cansa. Se apaga solo con
`prefers-reduced-motion` (la regla de `@layer base` fuerza
`animation-iteration-count: 1`) y queda el amarillo quieto, que dice lo mismo.

**El aviso al entrar vive en el LAYOUT del panel, no en `/finanzas`.** Es lo que
lo hace servir para algo: aparece en Resumen, Ventas, Anuncios o donde sea que la
persona entre. Se descarta con «Después» y no vuelve hasta el día siguiente, con la
fecha como clave en `localStorage` — así mañana reaparece sin que nadie limpie
nada. Adentro de `/finanzas` no se muestra: el botón ya está latiendo y dos avisos
de lo mismo en la misma pantalla se anulan.

**El punto en la tab de Finanzas es además del aviso, no en su lugar**, porque los
dos duran distinto: el aviso se descarta, el punto se queda hasta que el saldo esté
cargado de verdad. Si el único recordatorio fuera descartable, "después" y "listo"
serían indistinguibles.

**Qué se decidió NO hacer.**

- **No se usó la API `Notification` del navegador**, aunque el pedido decía
  "notificación". Necesita un permiso explícito cuyo prompt aparece descolgado de
  todo contexto, y no sirve para este caso: una notificación del sistema tiene
  sentido con la pestaña cerrada, y este aviso sólo aplica cuando la persona ya
  está en el panel y a un click de resolverlo. Avisar con el panel cerrado sería el
  bot de Telegram que ya existe para anuncios, no esto.
- **No se reusó `DialogoConfirmacion`** de anuncios: recibe una previsualización de
  ads y trae su propio checkbox y sus botones Ejecutar/Cancelar. Es un diálogo de
  confirmación, no un contenedor. Del él se copió el envoltorio visual para que los
  dos modales del panel se vean como el mismo objeto.
- **No se usó el `<dialog>` nativo**, que habría dado el foco y el Escape gratis:
  su `::backdrop` no acepta las utilidades de Tailwind del panel y habría que
  escribir CSS suelto para el fondo, quedando un modal que no se parece al otro.
- **Los banners de "falta cargar" y de pagos atrasados se borraron**, no se
  escondieron: su información vive ahora en el color y el contador de los botones.
  El de atrasados va en rojo con el conteo justamente porque reemplaza a un banner
  — si no se mostrara ahí, un pago atrasado dejaría de avisar por completo.

**Un bug propio, del mismo tipo que ya me había pasado dos veces en este módulo.**
La primera versión del layout calculaba la fecha del aviso con
`new Date().toISOString().slice(0,10)`, que es **UTC**. La clave del "descartar por
hoy" se habría reseteado a la medianoche de Londres: en producción, con el panel en
Buenos Aires, hasta 5 horas antes de que cambiara el día del usuario — el aviso
reaparecería a las 21:00 diciendo que falta el saldo de un día que ya se cargó.
Ahora `faltanSaldosDeHoy()` devuelve también el día, resuelto en `DASHBOARD_TZ`,
porque es la única fecha correcta y la función ya la tenía para hacer la consulta.

**Consecuencia pendiente:** el layout del panel hace una consulta más en CADA
pantalla (Resumen, Embudo, Ventas, Anuncios, Leads, Config). Es una sola query
sobre un índice y va en el `Promise.all` con `listFunnels`, así que no suma
latencia en serie, pero ahora **todas** las pantallas del panel dependen de que
`finance_accounts` exista. Si algún día se revierte la migración 028 sin revertir
esto, el panel entero deja de cargar, no sólo Finanzas.

**Qué se verificó.**

- `tsc --noEmit` limpio, `npm run build` limpio, **1414 tests en verde**.
- **`lib/paleta.test.ts` en verde**, que es la guarda que importa acá: valida cada
  clase de color literal contra `tailwind.config.ts`. Todos los tonos usados
  (`warn-200/300/500`, `bad-200/300/500`) existen.
- **La animación emite CSS de verdad**, comprobado en el bundle construido:
  `@keyframes latido{0%,to{box-shadow:0 0 0 0 rgba(232,163,61,.45)}…}` y
  `.animate-latido{animation:latido 2.4s cubic-bezier(.4,0,.6,1) infinite}`. Este
  chequeo no es ceremonia: una clase que Tailwind no conoce no rompe la build, no
  emite una regla y el efecto simplemente no pasa — es exactamente el modo de
  falla que `paleta.test.ts` existe para atrapar.
- La estructura de la pantalla, contada sobre el JSX: cero `<Card>` abiertas de
  nivel 1, cero banners sueltos, cuatro modales que sólo se renderizan con `vista`
  puesta.

**Sin verificar, y esta vez pesa más que nunca:** toda la revisión visual y de
interacción. El modal tiene trampa de foco, Escape para cerrar, devolución del foco
al botón que lo abrió, cierre por click en el fondo (con `onMouseDown` y chequeo de
`target`, para que arrastrar una selección desde adentro y soltar afuera no cierre
y pierda lo tipeado) y bloqueo del scroll de atrás. **Nada de eso está cubierto por
un test**, porque en este repo no hay jsdom y los componentes no se renderizan.
Hay que probar a mano: abrir cada sección, cerrar con Escape, cerrar con el fondo,
tabular adentro del modal a ver que no se escape al header, y confirmar que el foco
vuelve al botón.

---

## 2026-08-29 — El sobre de la respuesta: `undefined is not an object` con los saldos ya guardados

Arregla un bug de runtime de `e422150` que apareció **en el primer uso real** de la
carga de saldos. Sin commitear todavía.

**Qué pasaba.** Cargaste los cuatro saldos, apretaste guardar, y la pantalla
mostró un banner rojo que decía **«No se pudo guardar — undefined is not an object
(evaluating 'n.faltan.join')»**.

**El cartel mentía en lo peor: los saldos SÍ se habían guardado.** Las cuatro
filas estaban en `finance_account_balances` para el 2026-08-29 (1941.89 + 0 + 95 −
477.71 = 1559.18, el mismo número que el formulario ya mostraba en el preview). El
error explotó DESPUÉS de que el `POST` contestara 200, armando el mensaje de éxito.

Y tuvo un segundo efecto peor que el cartel: el `throw` cortó antes del
`onGuardado()`, así que el `router.refresh()` nunca corrió y la pantalla no se
actualizó. O sea que quedó mostrando el estado viejo **y** un error: las dos
señales que tenía el usuario decían "no se guardó nada", y las dos eran falsas.

**La causa: un desajuste de contrato entre dos capas.** El route contesta el
sobre `{ ok: true, patrimonio: { totalEur, completo, faltan } }`, igual que el
resto de los routes del panel (`{ ok, movement }`, `{ ok, account }`). El
componente pedía `pedir<{ totalEur, completo, faltan }>`, o sea los campos un
nivel más arriba. `res.faltan` era `undefined` y `undefined.join(', ')` reventó.

**Por qué ninguna de las dos guardas del proyecto lo atrapó**, que es lo que
importa de este bug:

- **`tsc` no puede verlo.** `pedir<T>` hace `body as T`: el generic es una
  AFIRMACIÓN de forma, no una comprobación. Los dos lados compilan perfecto
  porque nadie está comparando la forma real contra la declarada.
- **Un test tampoco.** En este repo no hay jsdom (`vitest.config.ts` usa
  `environment: 'node'`) y `vitest.config.ts` sólo incluye `.test.ts`, así que los
  componentes no se pueden renderizar. El test del route probaba que la respuesta
  trae `patrimonio.faltan`; el componente leía `faltan`. Nadie miraba los dos.

Estaba anticipado y se me pasó igual: `T06-ensamblado.md` §8 dice literalmente
«Si `FinanceOverview` (T02) y lo que `GraficoSaldo`/`CargaDiaria` (T04) esperan no
encajan, PARÁ». La revisión que hice fue `tsc` + tests + build, y las tres pasaban.

**Por qué se resolvió así.** La lectura del sobre se saca del componente y pasa a
`leerPatrimonio()` en `app/(panel)/finanzas/serie.ts`: una función pura, con test.
Es el único lugar donde este tipo de bug se puede cubrir en este repo, porque es
lo único que se puede ejecutar sin un browser.

**Y falla fuerte, con un mensaje que dice la verdad.** La salida fácil era un
`res.faltan ?? []`: no habría crasheado, pero el usuario habría leído «el día
sigue incompleto: falta el saldo de » con la lista vacía —o sea que su día
completo se mostraría como incompleto— y el desajuste habría seguido ahí, invisible,
para siempre. El mensaje nuevo arranca con **«el servidor guardó los saldos pero
contestó algo inesperado»**, porque eso es exactamente lo que pasó y es lo que
había que decirle a alguien que acaba de ver un error rojo.

Se revisaron las otras cuatro llamadas de los componentes nuevos por el mismo
patrón. **`CuentasSection` está bien** y no por casualidad: lee `saldosAfectados`
y `saldosBorrados`, que sí viven en la raíz del sobre, y los dos con guarda
(`typeof === 'number'` y `?? 0`). `GraficoSaldo` no hace fetch.

**Qué NO se hizo.** No se unificó `pedir()` de `serie.ts` con la copia de `api()`
que tiene `FinanzasView.tsx`, ni se le puso validación de esquema a `pedir<T>`.
Lo segundo es la solución de fondo (un zod del lado del cliente, o que `pedir`
devuelva `unknown` y obligue a un lector por endpoint) y es un cambio que toca
todas las pantallas del panel: no entra como parche de un bug. Queda anotado.

**Qué se verificó.**

- Los 6 tests nuevos de `leerPatrimonio`, uno de ellos con **la forma exacta que
  causó el bug** (los campos en la raíz, sin sobre) confirmando que ahora se
  rechaza con un mensaje legible. `serie.test.ts` pasa de 32 a 38.
- `tsc --noEmit` limpio, `npm run build` limpio, suite completa en verde.
- Contra producción, con tus datos ya cargados: `patrimonio = 1559.18`,
  `desglose = {dinero 1941.89, retenido 95, deuda 477.71}`, día 2026-08-29
  completo, `serieDiaria` con 1 punto y el cierre de agosto en 1559.18. Las
  ganancias mensuales siguen en 0, que es lo correcto: hacen falta dos meses
  cerrados.

**Sin verificar:** sigue faltando la revisión visual en el browser. Este bug es
justamente el ejemplo de qué se escapa sin ella, así que la próxima carga de
saldos hay que hacerla mirando la pantalla.

---

## 2026-08-28 — Finanzas: el patrimonio se mide, no se calcula

**`e422150`**, deployada el 2026-08-28 (release `20260828153231`). El módulo entero
de `/finanzas` cambia de qué mide el número principal. Migración
`028_saldo_cuentas.sql`. **Tuvo un bug de runtime que salió en el primer uso: ver
la entrada de arriba.**

**Qué pasaba.** El pedido fue "que el de finanzas no se sincronice el saldo con
las cuentas publicitarias, que simplemente yo ponga cuánto saldo hay 1 vez al
día".

**No había ninguna sincronización con cuentas publicitarias que sacar.** Se buscó
`balance|saldo|spend_cap|amount_spent|funding|account_status` en todo el repo:
cero. No hay columna, ni fetch a Graph API, ni script. Los únicos hits eran
"balanceo" de load balancing en dos comentarios. **Esto queda anotado porque el
próximo que lea el pedido va a salir a buscar un fetch a Meta que nunca existió.**

Lo que sí había era la cadena `sync-ads.ts` → `daily_metrics.ad_spend_eur` →
`finance-rollup.ts` → `finance_daily_profit` → patrimonio. O sea: el patrimonio
**sí** dependía de lo que reportaba Meta, aunque nadie leyera el "saldo" de la
cuenta publicitaria. Lo que había que sacar era ese cálculo.

La evidencia de que el número calculado ya no cerraba estaba en la base de
producción: el **único** movimiento cargado en `finance_movements` era un `ajuste`
de **+689.00**. Alguien ya estaba corrigiendo a mano la diferencia entre el
cálculo y la realidad. Eso explica el pedido mejor que el pedido.

**El gráfico tampoco era "de velas", como decía el pedido: eran dos `<Bar>`
apiladas** (profit verde arriba, movimientos naranja abajo, mismo `stackId`), y su
altura visible **no era el neto** porque recharts apila los negativos hacia el
otro lado en vez de restarlos. El neto sólo se veía en el tooltip. Por eso se leía
raro.

**Por qué se resolvió así.**

`patrimonio = Σ dinero + Σ retenido − Σ deuda` sobre los saldos que el usuario
tipea, y **`finance_movements` deja de sumar al patrimonio**. La alternativa
—dejar el cálculo y sumarle el saldo manual— cuenta cada gasto dos veces: cuando
se paga el alquiler, el saldo del banco ya bajó. Esto **deroga el D1 del plan
viejo** (`tasks/finanzas/00-PLAN-FINANZAS.md`), que decía textualmente que el
patrimonio es una suma de dos tablas.

Cuatro decisiones que cuestan explicar y son las que evitan que el número mienta:

| Decisión | El bug que evita |
|---|---|
| Un día al que le falta UNA cuenta vale `null`, no un total parcial | Un total incompleto es un número **equivocado** que se ve igual de bien que uno correcto. `patrimonioTotalEur` es `number \| null` para que el compilador obligue a decidir, y **nadie puede escribir `?? 0`** |
| `opened_on` / `closed_on` participan de la aritmética | Sin `opened_on`, abrir una cuenta nueva hoy dejaba incompletos **todos** los días anteriores (esa cuenta no existía, nunca tuvo saldo) y el gráfico entero desaparecía al crear una cuenta |
| El monto se guarda siempre `>= 0` y el signo lo pone el `kind` al leer | Un `CHECK` no puede mirar `finance_accounts`: si la deuda se guardara en negativo, el signo dependería de que el código que inserta se acuerde |
| Se agregó el kind `aporte` | La ganancia del mes es `Δ patrimonio − retiros − aportes`. Sin el término de aportes, el mes en que se transfieren 3.000 propios el gráfico dice que el negocio ganó 3.000 que nadie ganó — y es el mes en que más se lo mira |

**El gráfico cambia de unidad con el toggle, a propósito:** *Diario (este mes)*
muestra el nivel de patrimonio, *Mensual* muestra la ganancia de cada mes. Son un
nivel y un flujo en el mismo control, así que el título de la card dice cuál está
activa. `connectNulls` va **prendido**: sin eso, un mes con dos cargas aisladas no
dibuja nada (recharts necesita dos puntos adyacentes para un segmento) y el
gráfico se ve roto en vez de escaso.

**Qué se decidió NO hacer**, que es lo que evita que alguien lo "arregle" de nuevo:

- **`finance_movements` no vuelve a sumar al patrimonio.** No es un bug: es la
  decisión. Los movimientos son el desglose de en qué se fue la plata.
- **`ajuste` queda sin función real y se deja igual.** Existía para corregir un
  patrimonio *calculado*; con el patrimonio medido no hay nada que ajustar. La
  fila de +689 de producción queda como registro. **Pendiente de decidir por el
  usuario:** si esos 689 eran plata que entró de afuera, conviene reetiquetarla
  como `aporte` y entonces cuenta bien en la ganancia; si era un descuadre del
  cálculo, `ajuste` es correcto.
- **Una cuenta `dinero` en descubierto no se puede tipear.** El `CHECK` es
  `>= 0`. Se modela como una cuenta `deuda` aparte, y el mensaje de error lo dice.
- **No se tocó `lib/ads/**` ni `scripts/sync-ads.ts`.** Verificado con
  `git diff --stat`.

**La migración es la 028 y no la 027**, que es donde casi se rompió algo: mientras
esto se escribía entraron 10 commits de otra sesión, y uno traía
`027_experimento_upsell.sql`. Dos archivos con el mismo número funcionan por
accidente (`scripts/migrate.ts` ordena alfabéticamente) pero rompen la convención.
La misma revisión encontró que **`app/(panel)/finanzas/monto.ts` había sido
borrado** (el parseo se consolidó en `lib/monto.ts`, commit `0e151e0`) y que
**`parsearMonto` rechaza el cero**: usarlo para un saldo habría hecho que una
cuenta vacía fuera imposible de cargar y que ese día nunca pudiera estar completo.
De ahí sale `parsearSaldo`, que es `parsearMonto` con `< 0` en vez de `<= 0`.

**Consecuencias pendientes.**

- **El patrimonio de producción va a saltar el día del deploy.** Valor viejo
  medido el 2026-08-28: **2487.44 EUR** (1798.44 de `finance_daily_profit`, 14
  filas del 2026-08-15 al 2026-08-28, más los 689.00 del ajuste). Después de
  migrar dice "sin información" hasta la primera carga. El export a CSV es
  obligatorio y está en `docs/runbook.md` §4.1.1.
- **`finance_daily_profit` se borra, con su script y su línea de cron.** Los tres
  van juntos: si la migración se deploya sin el crontab nuevo, el cron de las 5:35
  falla todas las noches con `relation "finance_daily_profit" does not exist`. Y
  el build tiene que ir en el mismo deploy que la migración: la versión vieja de
  `getFinanceOverview()` consulta esa tabla.
- **`scripts/finance-rollup.ts` vivía en el commit `7d37bba`.** Ese hash es el
  paso 3 de "cómo revertir" (`docs/runbook.md` §4.1.3); sin él es una búsqueda a
  ciegas.
- Las 4 cuentas sembradas (`Arq`, `Mercado Pago`, `Retenido en Mercado Pago`,
  `Deuda con Meta`) son una transcripción de cómo el usuario las nombró de
  palabra. Si alguna está mal escrita se renombra desde la UI, no en la migración.
- `db/migrations/026_funnel_latam.sql` quedó commiteada, pero **`npm run
  db:migrate` no carga `.env`** (quirk preexistente): hay que usar
  `node --env-file=.env ./node_modules/.bin/tsx scripts/migrate.ts`.

**Qué se verificó.**

- `_schema-028.sql` corrido **dos veces** sobre una base scratch con 001-027
  (salteando la 021, que no corre desde cero por un problema preexistente ya
  documentado): idempotente.
- **19 afirmaciones** de `_verificacion-028.sql` en verde, incluidas las que más
  importan: el patrimonio con el signo por tipo de cuenta, el mismo día con una
  cuenta faltante devolviendo `null`, que abrir una cuenta no rompe el historial,
  el cierre del mes tomando el último día **completo** (no el último con datos), y
  el reemplazo de los 3 `CHECK` de `finance_movements` **sobre una tabla con
  filas** — que es lo que va a pasar en producción y podía abortar la migración.
- **22 afirmaciones** del `_verificacion-e2e.sh`, entre ellas que un movimiento no
  mueve el patrimonio y que los pagos programados siguen siendo idempotentes.
- **1408 tests en 109 archivos, 0 fallos** (baseline previo: 1208 en 97). `tsc
  --noEmit` limpio y `npm run build` limpio.
- Producción: leída **sólo con SELECT**. VPS en `main`, working tree limpio,
  sirviendo `0b5a044`, HTTP 200.

**Dos errores propios que encontró la verificación y no una lectura:**

1. El CTE del patrimonio usaba un `JOIN` inner a `finance_accounts`, así que un
   día en el que no había **ninguna** cuenta vigente desaparecía de la serie en
   vez de venir como `null`: `serieDiaria()` de un mes anterior a la primera
   cuenta devolvía 0 filas en lugar de los 30 días. Lo encontró el test de "un mes
   sin ninguna carga". Se arregló con `LEFT JOIN` + `count(d.id)` en vez de
   `count(*)`, más un `d.id IS NOT NULL` en el `array_agg` de `faltan` (sin eso,
   un día sin cuentas devuelve `{NULL}`, un array con un elemento nulo que la UI
   imprimiría como una cuenta sin nombre).
2. El mensaje de zod salía **en inglés** (`Number must be greater than or equal to
   0`) y `detail` viaja tal cual al banner rojo del usuario. Ahora está en
   castellano y además dice qué hacer: cargala como cuenta de tipo deuda.

**Sin verificar:** la revisión visual en el browser. No hay jsdom en el proyecto
(`vitest.config.ts` usa `environment: 'node'`), así que no hay forma de renderizar
un componente en un test. Quedan a mano: el toggle del gráfico con teclado, que la
línea se dibuje entre dos cargas aisladas, y el aspecto de la card de patrimonio
con el desglose.

---

## 2026-08-27 — El interruptor de conjuntos: el umbral sin margen, el POST sin plazo, el control que no hablaba de la entrega y la relectura en el camino crítico

Spec `toggle-conjuntos-entrega` **completo, tareas 1 a 18**, en **`f23406b`**. El
padre es `7ddb963`, el commit que había dejado el spec escrito y sin implementar.

El commit son **31 archivos, +7448/−213** (17 modificados, 14 nuevos), y ese
+7448 no es código: **1368 líneas son esta entrada** —el checkpoint intermedio
había contado 962 y la entrada siguió creciendo mientras se escribía, y su
`--stat` tampoco sumaba los archivos nuevos: de ahí el +2416 que decía antes este
párrafo—, 515 son el `tasks.meta.json` del spec y +39/−39 su `tasks.md`. **De
código y tests son +5526/−174 en 28 archivos, 13 de ellos nuevos.** Los números
salen de `git show --numstat f23406b`.

**Lo que está en el mismo tree y NO es de este cambio**, dicho acá por lo que
costó el 2026-08-24: `tasks/finanzas/00-PLAN-FINANZAS.md` (+38) y las carpetas
nuevas `tasks/pitch-ab/` y `tasks/saldo-cuentas/` son planes de otras cosas y no
tienen una línea de código adentro.

**El mapa archivo → tanda**, porque son cuatro cortes verticales mezclados en un
tree y sin la lista hay que deducirlo leyendo diffs:

- **Tanda A, el margen del umbral** (tareas 1, 5, 9, 11): `lib/ads/frescura.ts`,
  `frescura.test.ts` y `frescura.cron.test.ts` (nuevos), `lib/ads/acciones.ts`,
  `lib/ads/acciones.margen.test.ts` (nuevo), y los tres consumidores que sólo
  cambian de dónde sale el default 900 (`app/api/data/ads/route.ts`,
  `app/(panel)/anuncios/page.tsx`, `GestorAnuncios.tsx`).
- **Tanda B1, el aviso al pausar** (tarea 12): `lib/ads/previsualizacion.ts` y su
  test, `app/api/ads/acciones/route.advertencia.test.ts`, y
  `lib/ads/mensajes.test.ts` como consecuencia de compilación (está en los
  pendientes, porque no figura en ninguna tarea del plan).
- **Tanda B2, el tercer estado y el link** (tareas 3, 7, 13): `celdas.tsx`,
  `TablaAds.tsx`, `ChipCascada.tsx`, `page.tsx`, `GestorAnuncios.tsx`,
  `cascadaUrl.ts`, `navegacionCampania.test.ts` y `senalEntrega.test.ts`
  (nuevos), `toggleEstado.test.ts`.
- **Tanda C, el refresco diferido** (tareas 4, 8, 14):
  `app/api/ads/acciones/route.ts`, `_diferir.ts`, `route.diferido.test.ts` y
  `route.preservacionC.test.ts` (nuevos), `route.frescura.test.ts`, y la señal de
  «en curso» en `GestorAnuncios.tsx`, `TablaAds.tsx` y `celdas.tsx`.
- **Tanda D, los plazos** (tareas 2, 6, 10, 15, 16): `lib/ads/plazos.ts` y
  `plazos.test.ts` (nuevos), `lib/ads/meta.ts`, `GestorAnuncios.tsx`,
  `togglePlazo.test.ts` (nuevo), `toggleEstado.test.ts`.

`GestorAnuncios.tsx` (+254/−50) y `toggleEstado.test.ts` (+301/−21) los tocan
**tres tandas cada uno**, y son los dos lugares donde un revert parcial no es un
`git checkout` de un archivo. Ésa es la razón por la que este mapa está escrito y
no deducible.

Las subsecciones van en el orden en que se ejecutó, que es el orden en que se
entiende: primero los tests que tenían que fallar, después los baselines de
preservación, después los cuatro arreglos. **Los pendientes y lo que quedó sin
verificar están consolidados al final de la entrada**, además de los que cada
tanda dejó en su propio contexto.

### Fase 0, tareas 1 a 4 — Cuatro tests que TENÍAN que fallar

**Los cuatro archivos de esta fase están hoy en VERDE**, y hay que leer esta
subsección con eso puesto: nacieron en rojo a propósito y los dieron vuelta las
tareas 11, 13, 14 y 16. **Si alguno vuelve a fallar, lo que se rompió es el
arreglo de su tanda, no el test.** `lib/ads/acciones.margen.test.ts`,
`app/(panel)/anuncios/togglePlazo.test.ts`,
`app/(panel)/anuncios/senalEntrega.test.ts` y
`app/api/ads/acciones/route.diferido.test.ts` son tests de exploración de bug
condition: se escriben ANTES del arreglo y **el fallo es el entregable**, porque
es lo que confirma que la causa es la que el diseño hipotetizó y no otra. El día
que se escribieron no había que arreglarlos ni ablandarlos: si alguno hubiera
pasado, la hipótesis de esa tanda estaba mal y había que volver al diseño antes
de escribir una línea de arreglo. Cada uno era un gate independiente: el que no
falla manda su tanda al diseño y no frena a las otras tres.

**Qué pasaba.** Dos números que tienen que estar relacionados con otro, y nada
que lo diga:

- `ads_frescura_umbral_segundos` vale 900 y el cron de la jerarquía corre cada 15
  minutos (`deploy/cron.panel:113`, `*/15` → 900 s). `causaDeRelectura` compara
  `edad > umbral`, así que un objeto que la última corrida sana confirmó hace 905 s
  —o sea cualquier objeto, porque la corrida siguiente todavía no pasó— mete una
  lectura a Meta en el camino crítico de un click. Textual:
  `synced_at de hace 905 s, umbral 900 → expected 'vieja' to be null`, y de la
  property: `Counterexample: [[908,89,909,"isoOffset"]]` con
  `umbral=908 período=900 duración=89 edad=909`.
- El `pedir` del toggle es `fetch(url, init)` pelado (`GestorAnuncios.tsx:1152`) y
  el `init` que arma `ejecutarToggle` no lleva `signal`:
  `expected undefined to be an instance of AbortSignal`. Un POST que no vuelve
  deja la fila pintada con un valor que nadie confirmó, el id en `enVuelo` para
  siempre —el segundo click se descarta, o sea que el control queda muerto hasta
  recargar— y **ningún aviso**. Verificado con una carrera contra un timer de
  50 ms: `expected 'colgado' not to be 'colgado'`. Y el plazo del lote es 60 s
  contra un peor caso de 64 s **por un solo objeto**:
  `expected 60000 to be greater than 64000`.

Y las dos de las tareas 3 y 4, que no son dos números sino un dato que no existe
y una espera que nadie necesita:

- **El interruptor no habla de la entrega.** `dibujoDeEstado`
  (`celdas.tsx:427`) devuelve una unión de dos ramas y la del interruptor tiene
  exactamente dos campos, `control` y `encendido`. Meta ya dijo en la MISMA fila
  que el objeto no entrega —está en `effective_status`— y el control no lo usa
  para nada: 92 de los 169 conjuntos de la cuenta se dibujan verdes, con
  `aria-checked="true"` y sin ninguna diferencia contra los 10 que sí entregan.
  Textual: `ACTIVE / CAMPAIGN_PAUSED: devuelto hoy
  {"control":"interruptor","encendido":true}, sin ningún campo de entrega:
  expected { control: 'interruptor', …(1) } to have property "entrega"`, y de la
  property `{ seed: -1649821117, path: "2:0" }`,
  `Counterexample: [{…,"status":"ACTIVE","effectiveStatus":null}]`, shrunk 1 vez.
- **La respuesta del endpoint de acciones espera la relectura de la jerarquía.**
  `await refrescarJerarquia(...)` en `route.ts:576`, o sea un GET a Meta con su
  propio `AbortSignal.timeout(30_000)` (`lib/ads/meta.ts:291`) adentro del tiempo
  que el usuario espera mirando un interruptor que ya se movió. Textual:
  `expected 'timer' to be 'respuesta'`. Y su mitad gemela: `refrescarJerarquia` es
  hoy el ÚNICO escritor del `status` que Meta confirmó, y su `return` temprano
  cuando `fetchObjeto` no trae el objeto deja la fila con el valor anterior, así
  que el refetch inmediato del cliente devuelve la posición vieja y el interruptor
  vuelve para atrás. Textual: `la base devuelve status="ACTIVE" después de un
  desenlace 'confirmado' de 'pause': expected 'ACTIVE' to be 'PAUSED'`.

**Por qué se resolvió así, y qué se descartó.**

- **El umbral se genera con `fc.integer`; el período NO se puede generar.** El
  umbral sale de `settings` en runtime, así que un test contra 900 no dice nada de
  otra base: por eso es una property y no unos casos. El período es otra cosa —no
  está en la firma de `causaDeRelectura` y el arreglo lo va a tomar de una
  constante de módulo—, y generarlo libremente volvería la mitad de 2.2 falsa POR
  CONSTRUCCIÓN después del arreglo: con un período generado de 300 s el margen
  seguiría saliendo del período real (450 s) y un objeto con edad 600 s no
  superaría `umbral + 450`. El test estaría afirmando algo sobre un sistema que no
  existe. Queda escrito en el encabezado del archivo: la Property 1 del diseño
  está escrita sobre pares (umbral, período) y lo cuantificable es el umbral.
- **El rango del umbral tiene sus dos cotas por un motivo cada una**, y no es
  cosmética: abajo `período` (la condición de la Property 1) y arriba
  `2 × período − margen`, que es lo que hace que la mitad de 2.2 sea satisfacible.
  Con un umbral mayor que dos corridas del cron la relectura no se dispararía ni
  hoy ni con el arreglo, y no sería un defecto: sería un operador que puso a
  propósito un umbral más largo.
- **La mitad de 2.2 pasa desde el principio y eso es correcto.** Es la cota
  superior del margen y está para detectar si el arreglo la rompe: un margen mayor
  o igual que el período haría que un objeto que se perdió una corrida dejara de
  dispararla, que es la razón por la que la relectura existe. Hoy: una mitad roja
  y una verde. Las dos rojas o las dos verdes son dos formas distintas de que algo
  esté mal.
- **Los tres timeouts se LEEN del código, no se copian.** `PRESUPUESTO_RELECTURA_MS`
  por import desde `lib/ads/acciones`, y los dos 30 s de `enviar` y `pedir` leyendo
  `lib/ads/meta.ts` y resolviendo el argumento de cada `AbortSignal.timeout` —hoy un
  literal, después de la tarea 10 una constante nombrada—. Con literales copiados,
  el test seguiría afirmando `64_000` el día que alguien baje un timeout, que es
  exactamente el modo de falla que este spec vino a arreglar.
- **El vencimiento del plazo contra el reloj real queda SIN TEST, y se dice en
  lugar de taparlo.** Ningún test de esta suite puede esperar 44 s y
  `AbortSignal.timeout` no respeta los fake timers de vitest: el timer vive en la
  plataforma. **Se descartó mockear `AbortSignal`**, que verificaría el mock. Por
  eso la carrera del caso (a) está condicionada a que el `init` no traiga `signal`:
  sin plazo, «esto no termina» es literal y para siempre; con plazo, quien corta es
  el `fetch`, y el desenlace del vencimiento lo prueba la forma `plazo` del
  generador de `toggleEstado.test.ts` (tareas 6 y 16.5).
- **`fila()` y `tabla()` están COPIADOS de `toggleEstado.test.ts`.** Ese archivo
  tiene otros dos editores en este plan (la 6 le agrega la forma `plazo`, la 13.2
  endurece sus `toEqual`) y su `pedir` no expone el `init`, que es el dato de este
  archivo. Extraerlos a un helper compartido es un refactor que ninguna de las tres
  tareas necesita.
- **Los dos archivos leen módulos que todavía no existen** (`lib/ads/frescura.ts`,
  `lib/ads/plazos.ts`) por un puente con `import()` de especificador computado:
  tsc no resuelve un `import()` cuyo argumento no es un literal, así que
  `npx tsc --noEmit` queda limpio en los dos mundos. Es el mismo criterio que el
  puente por `unknown` de `montoAmbiguo.test.ts`, aplicado a un módulo entero en
  lugar de a un export. Si el módulo aparece, el puente usa sus valores; si no,
  cae a los que el diseño declara.
- **Se agregó una property sobre `n` que la tarea 2 no pedía**, porque la
  Property 3 del diseño está cuantificada sobre `n >= 1` y los dos casos de la
  tarea sólo cubren `n = 1`. Falla igual y shrinkea a 1.
- **`statusArbitrario` está COPIADO en `senalEntrega.test.ts`, carácter por
  carácter**, por lo mismo que `fila()` y `tabla()`: `toggleEstado.test.ts` tiene
  otros dos editores en este plan. Lo que **no** se hizo fue escribir un generador
  más pobre: sus `null`, `''`, minúsculas y texto libre son justo los valores que a
  nadie se le ocurren, y son los que en su momento encontraron el badge en blanco
  de `celdas.tsx:432`.
- **El fallo de la tarea 3 es por CAMPO AUSENTE y no por valor equivocado, y eso
  cambia la forma del arreglo.** No hay ninguna expresión en el repo que derive mal
  la señal de entrega: no hay ninguna que la derive. Así que el arreglo no es
  cambiar una comparación sino agregar un dato al tipo (13.1), y ese cambio rompe a
  los llamadores que hoy comparan el dibujo entero con `toEqual` — los tres que la
  tarea 7 dejó inventariados. **Pasar esos `toEqual` a `toMatchObject` está
  prohibido**: aflojaría la aserción y dejaría de fijar que no hay campos de más.
- **La property de la tarea 3 shrinkea a `effectiveStatus: null`, no al caso de los
  92, y hay que leerlo bien.** El campo falta para TODO par, así que el
  contraejemplo mínimo es un `sin_senal`: fast-check encuentra la ausencia antes que
  la mentira. Son el mismo defecto de estructura pero pesan distinto — en los 92 la
  ausencia **miente**, porque el control afirma con su posición y su color algo que
  la fila desmiente; en los otros sólo impide afirmar que la señal está vacía a
  propósito. Por eso los cuatro `it` concretos están **además** de la property: fijan
  los casos que importan sin depender de por dónde shrinkee la semilla del día.
- **`PENDING_BILLING_INFO → sin_senal` queda fijado por un test y no por un
  comentario.** Esa fila tampoco entrega, y aun así el tercer estado NO se extiende
  ahí (decisión de alcance B2): `sin_senal` significa «Meta no dice que un
  ANTEPASADO lo tenga sin entregar», no «entrega». No hay ninguna fila de antepasado
  a la que llevar al usuario, que es la mitad del valor del tercer estado, y ya
  tiene su propio badge en `TablaAds.tsx:254`. Un comentario se borra sin que nada
  se rompa; el test no.
- **La relectura lenta de la tarea 4 se mide con un deferred, no con un
  `setTimeout` de 30 s.** Se descartó el `setTimeout` por dos motivos y el segundo
  es el que importa: ningún test de la suite puede esperar 30 s, y el deferred mide
  exactamente lo mismo —«la relectura no volvió»— **sin reloj**, o sea sin una
  ventana en la que la máquina lenta del día cambie el resultado.
- **El reloj de la gracia arranca cuando la relectura arranca, no con el POST.** El
  mock resuelve un segundo deferred al entrar, y la carrera es
  `POST` contra `entrada.then(esperar(250))`. Así lo que tarde Postgres en el
  preflight, en `abrirAccion` y en `cerrarAccion` queda fuera de la medición y lo
  único medido es lo que pasa entre «la relectura arrancó» y «la respuesta salió»,
  que es exactamente C₄. Corrido tres veces seguidas, mismo resultado.
- **Las filas de `route.diferido.test.ts` van FRESCAS y SIN marca, y es aislamiento
  y no descuido.** Las de `route.frescura.test.ts` están sembradas con `synced_at`
  de hace 3 días y `desaparecido_at` puesto, así que `causaDeRelectura` devuelve
  `'desaparecida'` y el PREFLIGHT también llama a `fetchObjeto`. Con el deferred eso
  mediría el preflight, y peor: la carrera igual la ganaría el timer —el preflight
  corta a los `PRESUPUESTO_RELECTURA_MS = 4_000`— así que el test fallaría por la
  razón equivocada y nadie lo notaría. Con la fila fresca la única llamada del
  request es la de `refrescarJerarquia`, y los dos casos lo afirman con un
  `toHaveBeenCalledTimes(1)` que es la guarda de que el armado mide lo que dice.
- **`fetchObjeto → null` en el caso (b) hace dos cosas, y la segunda sobrevive al
  arreglo.** Dispara el `return` temprano que deja la fila con el `status` anterior,
  y **aísla la medición del refresco diferido que la tarea 14 va a agregar**, porque
  un refresco que no ve la fila no escribe nada. O sea que después del arreglo esa
  aserción sigue midiendo la Escritura_Confirmada_Local y no la relectura.
- **Se verificó a mano que el caso (a) mide el `await` y no su propio plumbing**, y
  el resultado inverso es lo que más informa. Se cambió el `await` de `route.ts:576`
  por `void`, se corrió el archivo y se volvió el archivo atrás:
  `Tests 1 failed | 1 passed (2)`. O sea (a) **pasa** con el `await` sacado —lo que
  mide es el `await`— y (b) **sigue fallando**, que es la dependencia de 1.19 dicha
  por una corrida: sacar el `await` sin la Escritura_Confirmada_Local arregla la
  espera y mete la regresión del interruptor que vuelve para atrás. Por eso la
  tarea 14 tiene dos pasos y no uno. `route.ts` quedó **sin modificar**.
- **`route.frescura.test.ts` y `route.discrepancia.test.ts` no se tocaron.** La
  exploración de C₄ va en un archivo nuevo justamente porque esos dos son el
  baseline de preservación de la tarea 8, y su único editor autorizado es la 14.2
  (que les agrega el `await esperarRefrescosPendientes()`).

**Consecuencias pendientes.** El `export` de `causaDeRelectura`
(`lib/ads/acciones.ts:843`, la única precondición de producción de la tarea 1, sin
cambio de comportamiento) entró en `f23406b`, como el resto. **Es lo único de
producción que la fase 0 tocó:** las tareas 3 y 4 no cambiaron una línea de código
de producción, sólo agregaron dos archivos de test. Los cuatro archivos quedan en
rojo hasta las tareas 11.3, 16.2/16.3, 13.1/13.2 y 14.1/14.2. Dos puentes quedan
apuntando a cosas que todavía no existen y hay que sacarlos cuando existan: el
campo `entrega` de `DibujoEstado` (lo lee `senalEntrega.test.ts` por un cast a
`unknown`, y se puede limpiar en la 13.5) y el `esperarRefrescosPendientes()` de
`route.ts` (lo lee `route.diferido.test.ts` por el mismo mecanismo, y la 14.2 lo
crea). La aserción que liga `refrescoEnCaminoCritico()` con lo que el route hace de
verdad **no está todavía**: es la tarea 15, y va en `route.diferido.test.ts`. Las
ocho decisiones, las cuatro cosas no verificables y las dos correcciones al
material de entrada quedaron en las subsecciones de cada tanda y en las dos listas
consolidadas del final de esta entrada: eso es la tarea 18.

**Qué se verificó.** `npx tsc --noEmit` limpio con los cuatro archivos nuevos, que
es el motivo de los puentes: un test de exploración tiene que fallar por la
aserción y no por el typecheck. `npm test` con Postgres arriba en `127.0.0.1:5433`:
`Test Files 4 failed | 97 passed | 3 skipped (104)`,
`Tests 14 failed | 1211 passed | 46 skipped (1271)`, contra el baseline previo a la
fase 0 de `97 passed | 3 skipped (100)` y `1208 passed | 46 skipped (1254)`. Los 14
fallos son los cuatro archivos nuevos y nada más —3 de `acciones.margen`, 4 de
`togglePlazo`, 5 de `senalEntrega` y 2 de `route.diferido`—: los 1208 que pasaban
siguen pasando (1211 = 1208 + las 3 mitades que ya son verdes) y los 46 salteados
no se movieron. **Ni un solo test que existía antes cambió de estado**, que es lo
que hay que mirar antes de dar por bueno un archivo de exploración nuevo.

**Qué NO se verificó:** el vencimiento del plazo contra el reloj real, qué valor
tiene `ads_frescura_umbral_segundos` en la base de producción, cuánto tarda de
verdad una corrida de la jerarquía —la cota inferior del margen está elegida por
argumento, no por medición—, la latencia real de Meta (los 30 s son el timeout
declarado y no una medición: la base local no tiene filas de `ad_actions` con
tiempos de producción), y que el refresco diferido efectivamente corra después de
que la respuesta salió, que necesita el `esperarRefrescosPendientes()` de la 14.2 y
es un caso de la 14.4. Tampoco se verificó nada del render: `senalEntrega.test.ts`
prueba la función pura, y el cableado del JSX de `ToggleEstado` —el tono de la
pista, el `aria-describedby` y el link— sigue sin test, porque vitest corre en node
sin jsdom por decisión de todo el repo.

### Fase 1, tareas 5 y 6 — los dos baselines de preservación, vistos PASAR antes del arreglo

Misma tanda de trabajo, mismo commit `f23406b`. Va acá y no en una
entrada nueva porque es la otra mitad de la misma idea: la fase 0 dejó cuatro
tests rojos a propósito y la fase 1 deja los verdes que van a decir si el arreglo
rompió algo. Los dos son de la **ventana que no se recupera**: un test de
preservación que nunca se corrió antes del arreglo no prueba que el arreglo
preservó nada, prueba que el arreglo es consistente consigo mismo.

**Qué pasaba.** Dos comportamientos que el diseño declara intocables y que nadie
había ejecutado nunca:

- **3.15, dos de sus tres casos estaban verificados por LECTURA y no por
  ejecución.** El comentario de `causaDeRelectura` dice «un `synced_at` nulo o
  ilegible cuenta como viejo» y no había un solo test que lo corriera. Son justo
  los dos que el margen podía romper, porque los dos terminan en el mismo `if`
  que la tarea 11.3 va a tocar: `if (edad === null || edad > umbralSegundos)`.
  Con `edad === null` la segunda mitad del `||` no se evalúa, así que 3.15 se
  preserva **por la forma del código**; el día que alguien mueva la comparación
  arriba del `edad === null`, o meta el margen sobre la edad en lugar de sobre el
  umbral, los dos casos se rompen en silencio.
- **El desenlace de un plazo vencido no tenía test de ninguna clase.** La única
  forma que rompía la promesa del `pedir` en `formaArbitraria`
  (`toggleEstado.test.ts`) era `red`. El plazo que la tanda D va a poner es el
  **mismo desenlace por otra causa** —las dos caen en el mismo `catch` de
  `ejecutarToggle`, que ya revierte con la guarda condicional, ya avisa y ya
  libera el id en el `finally`— y sin ese caso en el generador, el día que el
  `signal` entre, nada diría si el desenlace siguió siendo el correcto.

**Por qué se resolvió así, y qué se descartó.**

- **La cuantificación sobre el margen se hace evaluando la función de HOY con
  `umbral + margen`.** La 11.3 cambia una línea y el número comparado pasa de
  `umbralSegundos` a `umbralSegundos + margen`: o sea que correr hoy
  `causaDeRelectura(o, umbral + margen, ahora)` es, término por término, la
  comparación de mañana. `conYSinMargen` corre las dos y afirma que dan lo mismo.
  **Se descartó fijar el margen en 450**, que habría dejado la afirmación en «con
  450 no se rompen» en lugar de «ningún margen los toca», que es lo que 3.15
  necesita. El margen generado va **a propósito más allá** de lo que un margen
  sano puede valer (la cota es `margen < período`): si alguno de los tres casos se
  rompiera con un margen absurdo, sería porque está mirando la edad.
- **`acciones.relectura.test.ts` no se tocó, ni un comentario.** Sus seis casos
  son el baseline y el diseño los declara «tienen que seguir pasando sin una línea
  de cambio»; editarlos, aunque fuera para anotar algo, sacaría la única evidencia
  de que pasan sin ayuda. Lo anotado vive en el docblock de la Property 2 de
  `acciones.margen.test.ts`, con los seis nombres textuales y su ✓.
- **Por qué ninguno de esos seis cambia con el margen, verificado y no supuesto.**
  El margen mueve el borde de 900 a 1350 s. Las fechas de esos archivos están dos
  órdenes de magnitud afuera: `VIEJO = 48 h = 172 800 s` y `FRESCO = 60 s` en
  `acciones.relectura.test.ts`, `VIEJO = 5 d = 432 000 s` y `now()` en
  `route.edad.test.ts`. Haría falta un margen de 171 900 s (casi dos días) para
  mover el `VIEJO`, y uno negativo para mover el `FRESCO`. **Si alguno de esos dos
  archivos falla después de la tarea 11, es una regresión del arreglo y no un caso
  esperado**, y lo primero a mirar es si el margen se colgó de `frescuraDeFila`
  —que no lleva margen, decisión A1— en lugar de sólo de `causaDeRelectura`.
- **El error del abort está MEDIDO, no supuesto.** Con Node v24.14.0, un `fetch`
  contra un servidor que no contesta y `signal: AbortSignal.timeout(30)` rechaza
  con `name = 'TimeoutError'`, `ctor = DOMException`,
  `message = 'The operation was aborted due to timeout'` y —lo que importa para
  hoy— `e instanceof Error === true`, que es la rama por la que el `catch`
  interpola `e.message`. El generador manda los dos nombres (`TimeoutError` de
  Node/undici y `AbortError` de algunos navegadores) porque el `esAbortoPorPlazo`
  de la 16.2 va a mirar ese campo, y cuatro mensajes distintos **ninguno en
  castellano**, que es la razón por la que la 16.2 deja de interpolarlos.
- **Lo que la tarea 6 NO afirma, y el motivo es la mitad de la decisión: el texto
  del aviso.** Hoy dice, textual: `El cambio de estado no se pudo completar: The
  operation was aborted due to timeout. La fila quedó como estaba; si el pedido
  llegó a Meta, el resultado se define cuando corra la reconciliación.` La 16.2 le
  cambia la primera oración. **Se descartó afirmarla**: un test de preservación
  que se pone rojo cuando entra el arreglo que lo acompaña no preserva, estorba, y
  el rojo dejaría de significar «algo se rompió». Se afirma sólo lo que vale en
  los dos mundos: el tono `error`, el aviso no vacío, y la segunda oración —que el
  diseño declara textual en las dos ramas (§D3)— buscando `La fila quedó como
  estaba` y `reconciliación`.
- **No se duplicaron los tests de 3.2, 3.3, 3.4 y 3.11 que ya existían.** Se
  corrieron como baseline y quedaron nombrados en una tabla dentro del archivo,
  con qué preservación fija cada uno, para que la tarea 16 sepa cuál mirar si algo
  se pone rojo. Lo que sí se agregó es lo que ninguno cubría: **esta causa**. Tres
  casos concretos, y el tercero es el único de todo el archivo que ejercita un
  pedido que se vence **estando en vuelo** (los dos que había rompen la promesa de
  entrada), que es la secuencia real de un plazo y la que hace más ancha la
  ventana en la que puede llegar una respuesta del endpoint de datos mientras el
  toggle espera.
- **La Property 2 se endureció con una aserción que vale para TODA forma**: el id
  ya no está en `enVuelo` cuando el toggle termina. Pasa hoy —lo hace el
  `finally`— y es la mitad de 3.11 que la property no estaba mirando: sin eso, un
  plazo vencido podría dejar la fila muerta hasta recargar la página y la property
  no se enteraría.

**Consecuencias pendientes.** `lib/ads/acciones.margen.test.ts` quedó con **dos
mitades de estado esperado distinto**: la Property 1 con su mitad de 2.1 en rojo a
propósito (tarea 1) y la Property 2 entera en verde (tarea 5). Está dicho en el
encabezado del archivo y en el docblock de cada mitad, porque leer «este archivo
tiene que fallar hoy» y ver la Property 2 roja sería exactamente el malentendido
que la nota evita. El aviso del plazo sigue en inglés hasta la 16.2.

**Qué se verificó.** `npx tsc --noEmit` limpio. `npm test` con Postgres arriba:
`Test Files 4 failed | 97 passed | 3 skipped (104)`,
`Tests 14 failed | 1219 passed | 46 skipped (1279)`. Los 8 tests nuevos —4 en
`acciones.margen.test.ts` y 4 en `toggleEstado.test.ts`— pasan (1211 → 1219), los
14 fallos son exactamente los mismos cuatro archivos de la fase 0 con los mismos
conteos (3 + 5 + 4 + 2) y **ningún test preexistente cambió de estado**. Los
baselines corridos aparte: `acciones.relectura.test.ts` 10 passed y
`route.edad.test.ts` 5 passed, los dos sin editar.

**Un flake que conviene tener anotado antes de que confunda a alguien:** en dos de
las tres corridas completas de esta tanda, `app/api/ads/reglas/route.test.ts` dio
1 fallo con el archivo tardando 46 s, y en la tercera pasó. Corrido solo, pasa
(10/10, ~3 s). No lo puede haber causado esta tanda —los dos archivos que se
tocaron son puros, sin base y sin red— y el mensaje del fallo **no quedó
capturado**, así que si reaparece hay que guardar la salida completa. Con
`fileParallelism: false` y todos los tests de integración contra las mismas
tablas, el sospechoso es la contención, no el código.

**Qué NO se verificó** (además de todo lo de la fase 0): que el vencimiento
dispare de verdad a los 44 s contra el reloj, que sigue sin test y con el motivo
escrito arriba; y el texto que el usuario va a leer cuando el plazo venza, que
todavía no existe.

### Fase 1, tareas 7 y 8 — los otros dos baselines, y el inventario de lo que la 13.2 va a romper

Cierra la fase 1: las tandas B y C. Misma tanda, mismo commit `f23406b`.

**Qué pasaba.** Dos cosas que el diseño declara intocables y que nadie había
ejecutado, más una que estaba cubierta a medias y no se veía:

- **La ortogonalidad de la posición del interruptor contra `effective_status` no
  tenía test.** `encendido` sale de `fila.status === 'ACTIVE'` (`celdas.tsx:443`)
  y hoy no hay ninguna expresión que mire el efectivo para decidirla, así que la
  afirmación es **trivialmente verdadera**. A partir de la 13.1 deja de serlo:
  `dibujoDeEstado` va a tener dos consumidores del mismo campo y uno no puede
  influir en el otro. Y el arreglo equivocado es corto de escribir: hacer que
  `encendido` mire el efectivo y dibujar apagados a los 92 conjuntos
  `ACTIVE / CAMPAIGN_PAUSED`. Eso pide `activate` sobre algo que ya está `ACTIVE`,
  el preflight lo omite por `ya_esta_en_ese_estado` y el control queda muerto en
  una dirección, que es el bug del spec anterior de nuevo.
- **3.9 estaba cubierta a medias, y la mitad que faltaba es justo la que la tanda
  C puede romper.** «Queda `confirmado`» ya estaba, dos veces: la Property de
  `route.test.ts` afirma una fila `manual` por objeto intentado, ninguna
  `pendiente` al terminar y el estado final de cada desenlace, y
  `route.discrepancia.test.ts` lo lee de la base para `pause`. «Se abre **ANTES**
  del POST» no estaba en ninguna parte. Lo más cerca eran dos observaciones
  indirectas —una acción omitida deja fila sin que `enviar` se llame, y una
  escritura `fallido` o `indeterminado` también deja fila— y las dos las pasaría
  igual un route que abriera la fila DESPUÉS del POST con el desenlace ya en mano.
- **Los números de línea del inventario del diseño estaban desactualizados**, y
  ése es el hallazgo con consecuencia práctica para la 13.2 (abajo).

**Por qué se resolvió así, y qué se descartó.**

- **La ortogonalidad se cuantifica sobre un PAR de `effectiveStatus`, y la
  premisa se afirma DENTRO de la rama del interruptor.** El cuantificador no es un
  detalle de forma: la guarda de `celdas.tsx:431` es
  `NO_TOGGLEABLE.has(status ?? '') || NO_TOGGLEABLE.has(effectiveStatus ?? '')` y
  mira **los dos** campos, así que «`encendido` no depende de `effective_status`»
  es **falso** dicho sobre el par entero —un `ACTIVE / ARCHIVED` no tiene
  `encendido` en absoluto— y verdadero sobre los pares que los dos dibujan
  interruptor. Dicho corto: el efectivo puede decidir **si hay** interruptor y no
  puede decidir **de qué lado** está. **Se descartó** afirmarlo sobre el par
  entero, que habría dado una property falsa, y **se descartó** afirmarlo sobre un
  solo `effectiveStatus`, que no dice nada sobre variar el campo.
- **Hay dos properties y no una, y el motivo es aritmético.** La general cubre el
  cuantificador tal como lo escribe el diseño, con contadores de no-vacuidad
  (~215 pares dentro de la rama del interruptor por corrida de 500, ~200 con los
  dos efectivos distintos, ~40 cruzando señal contra `sin_senal`). Pero el par que
  caza el arreglo equivocado —`status = 'ACTIVE'` con exactamente un lado en
  `CAMPAIGN_PAUSED`/`ADSET_PAUSED`— sale de esa mezcla unas **2 veces en 500**, así
  que afirmar su no-vacuidad ahí sería frágil. La segunda property lo genera **por
  construcción**, con el lado con señal en los dos órdenes, y afirma que al menos
  un par quedó encendido. **Se descartó** subir `numRuns` hasta que el caso
  aparezca seguido: cuesta tiempo de suite y no lo garantiza.
- **`efectivoDibujaInterruptor` le pregunta a `dibujoDeEstado` en lugar de copiar
  `NO_TOGGLEABLE`**, que no está exportado. Si mañana alguien agrega un estado a
  ese Set, el generador se entera solo; con la lista copiada quedaría
  desactualizada en silencio.
- **`toggleEstado.test.ts` no se tocó** (la 13.2 es su único editor para esto):
  se corrió como baseline, 29 passed. Su Property 1 ya cubre la mitad vieja —la
  fila apagada pide `activate` y la encendida `pause` para todo `status` incluidos
  `null`, `''`, minúsculas y desconocidos; el interruptor queda accionable en la
  otra dirección después de un confirmado; la fila que dibuja badge no tiene
  `encendido` y su texto nunca queda vacío—.
- **3.12 y 3.13 no se duplicaron.** `secuenciaPedidos.test.ts` (21 tests, verde)
  ya afirma que `conservarPintadoEnVuelo` conserva el `status` en pantalla de los
  ids en vuelo —incluido un `status` nulo— y su Property 7 («Monotonía del estado
  de pantalla») que una respuesta vieja no pisa una más nueva para todo orden de
  llegada. Escribirlo de nuevo habría agregado una copia que se desincroniza.
- **3.9 se observa DESDE ADENTRO del POST**, que es el único momento en el que el
  orden es visible: el mock de `enviar` consulta `ad_actions` y el test afirma que
  la fila ya existe en `pendiente`, y después que **es la misma fila** —se compara
  el `id`, no el estado— que queda `confirmado`, con una sola fila en total. Un
  route que abriera una fila nueva en el cierre dejaría también un `confirmado`,
  con la `pendiente` huérfana al lado. Funciona porque `abrirAccion` corre en
  autocommit (`q1` suelto, sin transacción abierta), así que la otra conexión ve
  la fila; si algún día eso se envuelve en una transacción el test se pone rojo, y
  hay que leerlo como lo que sería.
- **Se verificó a mano que ese test mide el orden y no su propio armado**, con el
  mismo criterio con el que la tarea 4 verificó su caso (a): se movió el bloque
  `abrirAccion` de `route.ts` a después del `try/catch` del `enviar` —el
  reordenamiento que 3.9 prohíbe, y el único cambio— y se corrió. Resultado
  textual: `Tests 1 failed (1)`, con `no había ninguna fila de ad_actions cuando
  enviar arrancó: la fila se abre DESPUÉS del POST y una escritura que ocurra en
  Meta puede quedar sin registrar: expected null not to be null`. `route.ts` quedó
  **sin modificar** (`git status` limpio para ese archivo). Sin esa comprobación el
  test sería una afirmación sobre sí mismo.
- **Por qué la tanda C no rompe los dos casos de `route.frescura.test.ts`, leído y
  no supuesto:** el segundo caso afirma `marca` y `sync`, **no `status`**, y la
  Escritura_Confirmada_Local escribe `status` y nada más. **Si después de la tarea
  14 ese caso falla, es que se escribió más de lo que la decisión C2 autoriza.**

**EL INVENTARIO, con las líneas verificadas contra el archivo y no contra el
diseño.** Los lugares que rompen cuando la 13.1 agregue el campo `entrega`:

1. `toggleEstado.test.ts:210` — `expect(dibujo).toEqual({ control: 'interruptor',
   encendido })`, dentro del loop de la tabla `DIRECCIONES` (8 filas). **La línea
   del diseño es correcta.**
2. `toggleEstado.test.ts:731` — `expect(dibujoDespues).toEqual({ control:
   'interruptor', encendido: !dibujo.encendido })`, el de «queda accionable en la
   otra dirección». **El diseño dice `:662` y está desactualizado en 69 líneas**:
   la tarea 6 agregó la forma `plazo` al generador y su caso en la Property 2, las
   dos arriba de esta línea. Buscar por `:662` no encuentra nada.
3. Los `toEqual({ control: 'badge', texto: s })` **no** rompen: la rama badge no
   lleva `entrega` y no tiene que llevarlo (3.10). Pero **son TRES y no dos**:
   `:230` (una línea), `:233`–`:236` y `:240`–`:243`. El diseño listó «`:230` y
   `:236`», que son la primera y el cierre de la segunda; el tercero —el del badge
   que no queda en blanco con `effective_status = ''`— no estaba nombrado. La
   conclusión no cambia; el conteo sí, y la 13.2 iba a encontrarse con uno más.

**Se buscó si hay más y no hay.** Los únicos consumidores de `dibujoDeEstado` en
todo el repo son `toggleEstado.test.ts`, `senalEntrega.test.ts` y el componente
`ToggleEstado` de `celdas.tsx:458`, que lee `dibujo.control`, `dibujo.texto` y
`dibujo.encendido` y no compara el objeto entero: **no rompe**. Los únicos lugares
que CONSTRUYEN un `DibujoEstado` son `celdas.tsx:441` y `:443`, que son de la
13.1. En `senalEntrega.test.ts` las comparaciones son sobre el campo
(`senalDeDibujo(dibujo)`), no sobre el dibujo: no rompen, empiezan a pasar.

**LA REGLA, y va acá y no en una nota al pie: la expectativa se ENDURECE, no se
afloja.** Cada `toEqual` se extiende con **el valor esperado de `entrega`** para
ese caso. Están **PROHIBIDOS** `toMatchObject`, `expect.objectContaining`, borrar
el campo antes de comparar y comparar `dibujo.encendido` en vez de `dibujo`:
aflojar la aserción dejaría de fijar que no hay campos de más, que es la mitad del
valor de ese test.

**Y el detalle que hay que mirar caso por caso antes de escribir el valor
esperado**, porque es la trampa de la tabla `DIRECCIONES`: `ADSET_PAUSED` y
`CAMPAIGN_PAUSED` aparecen ahí como valores de **`status`**, no de
`effectiveStatus`, y el helper `fila()` pone `effectiveStatus: status` por
default. O sea que esas dos filas van a llevar
`entrega: { estado: 'antepasado_apagado', … }` **por el efectivo que el helper
arma solo**, no por lo que se lee en la tabla; y las otras seis van a llevar
`sin_senal` por la misma razón. Escribirlo mirando la columna de `status` sin
mirar qué efectivo queda es el error fácil.

**Consecuencias pendientes.** `senalEntrega.test.ts` quedó, como
`acciones.margen.test.ts`, con **dos mitades de estado esperado distinto**: la
exploración de la tarea 3 en rojo a propósito (5 tests) y la ortogonalidad de la
tarea 7 en verde (9 tests). Está dicho en el encabezado del archivo y en el
docblock de cada mitad. La 14.2 es el único editor de `route.frescura.test.ts` y
le tiene que agregar el `await esperarRefrescosPendientes()`; **ojo con su primer
caso**, que sí afirma `status` (`expect(despues?.status).toBe('ACTIVE')`, «lo que
devolvió la relectura») y por eso pasa a depender de que el refresco diferido haya
corrido, mientras el segundo no.

**Un hueco que queda declarado y no tapado.** La mitad de 3.13 que dice
«presupuesto de espera propio» no tiene test ejecutable: `leerFilas`
(`GestorAnuncios.tsx:575`) hace un `fetch` real y no lo recibe por parámetro, así
que afirmarlo pediría mockear `globalThis.fetch`, que es más armado que lo que
compra. Sus tres llamadores le pasan 30 s (default de `pedirFilas`), 60 s (Botón
Actualizar, `:1064`) y `TOPES_ABORTO = 10_000` (refetch posterior a un lote,
`:1359`). La tanda C no toca `leerFilas` ni sus llamadores, así que el hueco no
crece con este spec.

**Qué se verificó.** `npx tsc --noEmit` limpio. `npm test` con Postgres arriba,
**tres corridas completas seguidas con el mismo resultado exacto**:
`Test Files 4 failed | 98 passed | 3 skipped (105)`,
`Tests 14 failed | 1229 passed | 46 skipped (1289)`. Los 10 tests nuevos —9 en
`senalEntrega.test.ts` y 1 en `route.preservacionC.test.ts`— pasan (1219 → 1229),
los 14 fallos son exactamente los mismos cuatro archivos con los mismos conteos
(3 + 5 + 4 + 2) y **ningún test preexistente cambió de estado**. Los baselines
corridos aparte y sin editar (`git status --porcelain` vacío para los tres):
`route.frescura.test.ts` 2 passed, `route.discrepancia.test.ts` 7 passed,
`secuenciaPedidos.test.ts` 21 passed, `toggleEstado.test.ts` 29 passed.

**El flake de la tarea 6 NO reapareció.** `app/api/ads/reglas/route.test.ts` pasó
en las tres corridas completas (10/10, entre 1,9 s y 2,0 s, contra los 46 s que
tardaba cuando falló). No hay salida que capturar. Queda anotado que sigue sin
diagnosticar: tres corridas verdes no lo descartan, y el sospechoso sigue siendo
la contención contra las mismas tablas y no el código.

**Qué NO se verificó.** Que el tercer estado se vea distinto en pantalla, que es
render y este repo no tiene jsdom: lo que se fija es el dato del dibujo, no el
tono ni el `aria`. Que el refresco diferido corra después de la respuesta, que
necesita el `esperarRefrescosPendientes()` de la 14.2. Y el presupuesto de espera
de la lectura de filas, con el motivo escrito arriba.

### Fase 2, tareas 9 y 10 — dos refactors mecánicos: el default 900 y los dos 30 000 de Meta

**Van aparte de su tanda porque se verifican distinto.** Un cambio de
comportamiento se verifica con un test nuevo; acá la verificación es **«el valor
no cambia y ningún test se edita»**, y eso sólo se puede afirmar con los tests que
ya estaban. Por eso son dos tareas propias y no un renglón adentro de las tandas
A y D.

**Qué pasaba, tarea 9.** El default del umbral de frescura estaba escrito como
literal suelto en cuatro archivos que tienen que decir lo mismo y en ninguno que
lo diga una vez: `lib/ads/acciones.ts:543` (dentro de `topesDeSettings`),
`app/api/data/ads/route.ts:301`, `app/(panel)/anuncios/page.tsx:223` y
`app/(panel)/anuncios/GestorAnuncios.tsx:112` (`const UMBRAL_FRESCURA_DEFAULT =
900`). Los cuatro con su propio comentario diciendo «el mismo 900 que seedeó la
025», que es la forma en que un valor copiado se ve cuando todavía nadie lo
desincronizó. Ahora sale de `UMBRAL_FRESCURA_DEFAULT_SEGUNDOS`, en
`lib/ads/frescura.ts`: es el mismo patrón que `TZ_DEFAULT` de `lib/ads/zona.ts`,
que existe por un bug real de tres copias del default de zona.

**Qué pasaba, tarea 10.** Los dos deadlines de Meta eran
`AbortSignal.timeout(30_000)` literales en `lib/ads/meta.ts:247` (`pedir`, el que
usa `fetchObjeto`) y `:291` (`enviar`). Ahora son `PLAZO_META_LECTURA_MS` y
`PLAZO_META_ESCRITURA_MS` de `lib/ads/plazos.ts`, junto a
`PRESUPUESTO_RELECTURA_MS` (4 000) y `HOLGURA_CLIENTE_MS` (10 000).

**Por qué la 10 no es cosmética, que es lo único que importa de ella.** El plazo
del cliente tiene que ser mayor que el peor caso del servidor (2.7), y ese peor
caso es una suma de esos tres números. Con los literales adentro de `meta.ts`,
cualquier cuenta del peor caso es una **copia** de los literales: la desigualdad
se verificaría contra un número que puede haber dejado de ser el que las llamadas
usan. Con las constantes nombradas, **si alguien baja el timeout de `enviar`, el
plazo del cliente baja con él.** Está escrito en el docblock del módulo y no sólo
acá.

**Qué NO se tocó, y cada cosa por su motivo.** Esto es la mitad del valor de las
dos tareas:

- **El seed de `db/migrations/025_ads_frescura.sql:144`** (`('ads_frescura_umbral_segundos',
  '900'::jsonb)`). El SQL de una migración no puede importar un módulo de
  TypeScript, así que **queda como quinta copia y eso está declarado en el
  docblock de `frescura.ts`, no olvidado.** Lo que compra el cambio es que la
  próxima vez sean **dos** lugares en vez de cinco.
- **Los `const UMBRAL = 900` de los tests** (`acciones.relectura.test.ts:60`,
  `frescuraFila.test.ts:27` «el que seedea la migración 025», y el `VIEJO` de
  `route.edad.test.ts`). Son el **valor esperado**, no la fuente: un test que
  importa la constante que está probando no prueba nada, prueba que la constante
  es igual a sí misma. Se evaluó hacerlos importar de `frescura.ts` y **se
  descartó** por eso.
- **El tercer `AbortSignal.timeout` de `meta.ts`**, el de `postForm`
  (`:519`, hoy `:526`): ése recibe `timeoutMs` por parámetro y su default vive con
  la función. No es una copia de nada.
- **`lib/ads/acciones.ts` RE-EXPORTA `PRESUPUESTO_RELECTURA_MS`** en lugar de que
  los llamadores cambien de path (`export { PRESUPUESTO_RELECTURA_MS }` en
  `:117`, importado de `./plazos` en `:47`). El re-export no es pereza: **`acciones.relectura.test.ts`
  y `togglePlazo.test.ts` lo importan desde `lib/ads/acciones`** y el primero lo
  interpola en el texto de «se agotó el presupuesto de N ms de la relectura», así
  que cambiarles el import sería **editar dos tests en una tarea cuya verificación
  es que ningún test se edita**.
- **`relecturaSelectiva`, `causaDeRelectura` y `frescuraDeFila`**: ninguna de las
  dos tareas las toca. El margen de la 11.3 y el signo de la suma son de la tanda
  A, no de acá.

**Los dos módulos nuevos son puros y no importan NADA**, verificado con grep: 0
imports en los dos. No es un detalle de estilo. `frescura.ts` lo leen un módulo de
servidor, dos endpoints y **dos archivos de cliente** (`page.tsx` y el
`'use client'` de `GestorAnuncios.tsx`); `plazos.ts` lo van a leer `meta.ts`
(servidor) y `GestorAnuncios.tsx` (cliente) cuando entre la 16. **Si alguno
importa `pg`, `lib/db` o `next/headers`, el bundle del cliente se rompe**, y va
escrito en el docblock de los dos.

**Los puentes de las tareas 1 y 2 NO movieron el conteo, y era lo primero a
mirar.** `acciones.margen.test.ts` y `togglePlazo.test.ts` leen esos dos módulos
con `import()` de especificador computado y caen a valores declarados cuando el
archivo no existe. Al crearlos, los puentes empiezan a usar los reales solos:

- `acciones.margen.test.ts` encuentra `frescura.ts`, pero la 9 sólo creó el
  default: `PERIODO_SYNC_JERARQUIA_SEGUNDOS` y `margenDeRelectura` los agrega la
  11.1, así que sigue cayendo a `PERIODO = 900` y `MARGEN = 450`. **3 fallos antes
  y 3 después.**
- `togglePlazo.test.ts` encuentra `plazos.ts` y ahora su `resolverPlazo` resuelve
  `PLAZO_META_ESCRITURA_MS` y `PLAZO_META_LECTURA_MS` **desde el módulo** en lugar
  de leer los literales de `meta.ts`. El peor caso sigue dando **64 000**
  (`expected 60000 to be greater than 64000`, idéntico), que es la prueba de que
  el reemplazo fue mecánico: si los hubiera resuelto mal, ese número se movía.
  `plazoClienteEstadoMs` y `refrescoEnCaminoCritico` todavía no existen (16.1 y
  15), así que el flag sigue cayendo a `true` y el plazo se sigue leyendo del
  ternario del lote. **4 fallos antes y 4 después.**

**Qué se verificó.** `npx tsc --noEmit` limpio después de cada una de las dos
tareas. `npm test` completo después de cada una, con Postgres arriba y **el mismo
resultado exacto que el baseline de la tanda anterior**:
`Test Files 4 failed | 98 passed | 3 skipped (105)`,
`Tests 14 failed | 1229 passed | 46 skipped (1289)`. Los 14 fallos son los mismos
cuatro archivos con los mismos conteos (3 + 5 + 4 + 2) y **ningún test cambió de
estado en ninguna dirección**: ni uno que fallaba pasó, ni uno que pasaba falló.
Los tres declarados por la 9 corridos aparte y en verde:
`frescuraFila.test.ts` 24 passed, `acciones.relectura.test.ts` 10 passed,
`route.edad.test.ts` 5 passed. Los dos de la 10, ídem: `meta.test.ts` 17 passed,
`acciones.relectura.test.ts` 10 passed. **`git diff --stat` sobre `*.test.ts`
sigue mostrando un solo archivo tocado, `toggleEstado.test.ts` con las mismas
248/3 líneas de la tarea 6:** las tareas 9 y 10 no editaron ningún test.
`grep -rn "AbortSignal.timeout(30_000)" lib/` devuelve **0 resultados** —hubo que
reescribir una frase del docblock de `plazos.ts` que citaba el literal, porque esa
cita sola hacía fallar la verificación—, y no queda ninguna otra copia suelta del
900 en `lib/` ni en `app/` fuera de tests.

**Qué quedó pendiente, y es por diseño.** `lib/ads/plazos.ts` tiene **sólo las
constantes**: `refrescoEnCaminoCritico()` lo agrega la 15 y las dos funciones del
peor caso la 16.1. `lib/ads/frescura.ts` tiene **sólo el default**: el período, el
margen y `umbralDeRelectura` los agrega la 11.1. Son dos commits distintos a
propósito —éste no cambia comportamiento y aquéllos sí—, y hasta que entren,
`HOLGURA_CLIENTE_MS` es una constante **sin ningún llamador**.

### Fase 3, tarea 11 — Tanda A: el umbral de relectura ahora tiene margen, y el margen se SUMA

**Qué pasaba.** `ads_frescura_umbral_segundos` vale **900** y el cron de la
jerarquía es `*/15` (`deploy/cron.panel:113`), o sea **900 s también**. La edad de
una fila sana recorre `[0, período + duración de la corrida]`, así que el umbral
estaba exactamente en la edad máxima que produce una corrida que anduvo bien:
cualquier varianza de la corrida, cualquier jitter del cron o cualquier objeto que
Meta no devolvió cruzaba el umbral y metía un `fetchObjeto` en el camino crítico
del click. Textual, corrido contra el código sin arreglar:

    synced_at de hace 905 s, umbral 900 → causaDeRelectura devolvió 'vieja'
    esperado: null

Y el contraejemplo de la property, que muestra que la ventana no era sólo la de
900: `Counterexample: [[908,89,909,"isoOffset"]]` — umbral 908, corrida de 89 s,
edad 909 → `expected 'vieja' to be null`. La ventana del defecto era
`(umbral, período + duración]` **para todo umbral**.

Ahora `causaDeRelectura` compara contra `umbralDeRelectura(umbral, período)`, que
es `umbral + período / 2`: el borde pasa de **900 a 1350 s**.

**El margen elegido, y por qué la mitad.** Las dos cotas están escritas en el
código y no sólo acá, porque son lo que hace elegible al número:

- **Abajo**: tiene que absorber la duración de la corrida más el jitter. Con 450 s
  la corrida tendría que tardar siete minutos y medio para que un objeto sano
  cruce; `deploy/cron.panel` declara la corrida barata (una llamada por cuenta y
  por nivel). **No medido**, elegido por argumento: está declarado como no
  verificable en el diseño.
- **Arriba**: tiene que ser **estrictamente menor que el período**, porque
  `2 × período > período + margen ⟺ margen < período`. Con `margen >= período` un
  objeto que se perdió una corrida (edad ≈ 1800 s) **dejaría de disparar la
  relectura**, que es justo el caso para el que la relectura existe. Ésa es la
  mitad de 2.2 del test de exploración, la que ya pasaba antes del arreglo y estaba
  ahí para agarrar un margen demasiado grande.

**EL SIGNO, que es la única parte del precedente que no se copió.**
`pisoDeFrescura` de `lib/ads/live.ts` **RESTA** su margen, y allá está bien: la
comparación es `edad < piso ⇒ está fresco, no sincronices`, así que bajar el piso
adelanta el sync. Acá la comparación es la inversa —`edad > umbral ⇒ releé`— y lo
que se quiere es que la relectura se dispare **después**. Copiando el precedente al
pie de la letra el umbral quedaba en **675 s** y la relectura se disparaba en MÁS
clicks que antes. El test lo fija con un `not.toBe(675)`, no sólo con un comentario.

**Las tres alternativas que se descartaron**, que es lo que le sirve al que venga:

- **Subir `ads_frescura_umbral_segundos` a 1800** (un múltiplo del período): mueve
  el borde de la **Marca_Frescura de la tabla** junto con el de la relectura. Son
  dos preguntas distintas sobre el mismo número: `frescuraDeFila` pregunta «¿esto
  se le tiene que ver viejo a una persona?» y su borde es un compromiso de
  producto, con el `>` y no `>=` documentado y testeado. Y **no arreglaba 1.4**:
  seguían siendo dos números en dos archivos sin nada que los relacione.
- **Derivar el umbral del período en runtime**: la app no puede leer el crontab.
  `deploy/cron.panel` se instala en el host con `crontab -e`, el proceso no lo lee
  nunca, y parsear sintaxis de cron para calcular un umbral es más máquina de la
  que el problema pide. Además borraría la perilla de `settings` que tres
  consumidores ya leen. Lo que se conservó de esta opción es su espíritu: **lo
  derivado es el margen**, no el umbral.
- **`max(umbral, período) + margen`**, para tapar el caso del umbral por debajo del
  período: **descartado**. Haría que el preflight ignore en silencio un valor que
  un operador puso a propósito. Con umbral 60 el umbral de relectura queda en 510 s
  —menor que el período— y la relectura se sigue disparando en la mayoría de los
  clicks: **queda como límite escrito y con test propio** (`not.toBe(1350)`), no
  como defensa silenciosa.

**El margen fraccionario NO se redondea, y la razón es verificable.** Con un
período impar el margen tiene medio segundo. La edad contra la que se compara sale
de un `Math.floor` (`edadEnSegundos`), o sea que el dominio real son los enteros de
segundos, y para enteros `edad > 1350.5` decide **exactamente igual** que
`edad > 1350`. El test lo recorre exhaustivo de 0 a 2000 en lugar de afirmarlo.
Redondear agregaría un paso que no cambia ni una decisión.

**La guarda del cron, provocada a mano y revertida.** `lib/ads/frescura.cron.test.ts`
lee `deploy/cron.panel`, busca la línea de `scripts/sync-ads-jerarquia.ts`, traduce
el schedule a segundos y lo compara con `PERIODO_SYNC_JERARQUIA_SEGUNDOS`. Se
cambió `*/15` por `*/30` en el archivo de verdad y la suite rompió con:

    × PERIODO_SYNC_JERARQUIA_SEGUNDOS contra deploy/cron.panel (R2.3)
      > el schedule de sync-ads-jerarquia.ts coincide con la constante
      → el crontab dice 1800 s y el código 900 s. La línea es: «*/30 * * * * cd
        /srv/panel/current && … scripts/sync-ads-jerarquia.ts …»
        expected 1800 to be 900

`git checkout -- deploy/cron.panel` después, y `git status` sobre ese archivo
vuelve vacío: **el archivo quedó idéntico al commit**. Sin esa provocación el test
era una afirmación sobre sí mismo.

**Lo que la provocación encontró y se corrigió en el camino:** la primera vez
rompieron **DOS** tests, y el segundo (el del filtro de comentarios) comparaba
contra la constante sin necesidad. Un guardián que se rompe en dos lugares con uno
de los dos mintiendo sobre qué se rompió no sirve; ese caso pasa a comparar contra
el archivo real y ahora la provocación deja **un solo test en rojo**, el que habla
del schedule.

**El caso de que la línea no exista también falla**, con el mensaje puesto: un test
que pasa porque no encontró nada es peor que no tenerlo. Y el traductor de
schedules **tira** con lo que no sabe traducir (una lista `0,30`, una cadencia
mensual, un schedule de 4 campos) en lugar de devolver un número inventado, que
haría pasar el test con un período equivocado.

**Lo que este test NO cubre, y sigue abierto:** compara contra el archivo del
**repo**, no contra `crontab -l`. Que el crontab instalado en el host sea
`deploy/cron.panel` es el hueco que ese mismo archivo ya advierte —la línea del
gasto de anuncios estaba viva en la VPS y no estaba en el repo— y la única forma de
cerrarlo es el `diff` a mano que ahí está documentado. Un test de la suite no tiene
el host. Queda declarado en el docblock del test, no olvidado.

**Qué NO se tocó, cada cosa por su motivo.**

- **`frescuraDeFila` (`celdas.tsx`) y la Marca_Frescura**: el margen movería el
  borde de la marca visual de 900 a 1350 s, un cambio de producto que nadie pidió.
  `frescuraFila.test.ts` pasa con sus 24 casos sin editarse, que es la evidencia de
  que el margen se colgó sólo del preflight.
- **`relecturaSelectiva`**: sigue secuencial, con tope 10, con el presupuesto de
  4 s del lote entero, sin bloquear la acción cuando falla y dejando anotado por qué
  no se pudo revalidar.
- **El valor de `settings`**: sigue en 900. El arreglo agrega una derivación, no
  cambia la perilla.
- **El orden de las tres líneas de `causaDeRelectura`**: la marca de desaparición
  devuelve arriba y el `edad === null` cortocircuita antes de la comparación. **3.15
  se preserva por la forma del código**, y quien lo vigila es la Property 2 de la
  tarea 5: si alguien mueve la comparación arriba del `edad === null`, esos tres
  casos se ponen rojos en la misma corrida.

**Qué se verificó.** `npx tsc --noEmit` limpio. `npm test` completo con Postgres
arriba: **`Test Files 3 failed | 101 passed | 3 skipped (107)`,
`Tests 11 failed | 1248 passed | 46 skipped (1305)`**, contra el
`4 failed / 14 failed | 1229 passed (105 / 1289)` con el que arrancó la tanda. La
cuenta cierra sin residuo: **−3 fallos** (los tres de `acciones.margen.test.ts`,
que ahora pasa 10/10 con las dos mitades en verde), **+2 archivos y +16 tests**
(`frescura.test.ts` 9, `frescura.cron.test.ts` 7), y `1229 + 3 + 16 = 1248`. Los 11
que quedan son los tres archivos de las tandas B2, C y D con los mismos conteos de
antes (5 + 2 + 4). **Ningún test cambió de estado en ninguna otra dirección.**

`git diff --stat` sobre `*.test.ts` sigue mostrando **un solo archivo tocado**,
`toggleEstado.test.ts` con las mismas 248/3 líneas de la tarea 6:
`acciones.relectura.test.ts` (10 passed) y `route.edad.test.ts` (5 passed) pasan
**sin una línea editada**, que es lo que la 11.5 pedía.

### Fase 3, tareas 12 y 13 — Tanda B: el aviso al pausar, el tercer estado del interruptor y el link a la campaña

**Qué pasaba.** Dos mitades del mismo defecto, y cada una se sentía distinto.

- **Al pausar uno de los 92 conjuntos `ACTIVE / CAMPAIGN_PAUSED`, el panel no
  decía nada.** `advertenciaPadreApagado` se sumaba sólo para `activate`
  (`previsualizacion.ts:415`), así que el usuario apagaba el conjunto creyendo que
  apagaba la entrega, y el aviso de que ese conjunto **no entregaba** le llegaba
  en el SEGUNDO click, cuando lo volvía a prender para ver qué pasaba.
- **El interruptor de esos 92 se dibujaba verde, con `aria-checked="true"` y sin
  ninguna diferencia contra los 10 que sí entregan.** `dibujoDeEstado` devolvía
  `{"control":"interruptor","encendido":true}` y nada más: Meta ya había dicho en
  la MISMA fila que no entrega —está en `effective_status`— y el control no lo
  usaba para nada. Y no había ninguna forma de llegar a la campaña que lo tenía
  apagado: había que ir a buscarla a mano a la vista de campañas.

**Los textos nuevos, que son otros y no los mismos.** Al activar, «no entrega» es
una advertencia sobre el FUTURO; al pausar es una aclaración sobre lo que se está
apagando, y va en PASADO. Reusar el de activar diría «queda activo» sobre una fila
que se está apagando:

- conjunto: `la campaña está pausada: el conjunto ya no estaba entregando, así que
  pausarlo no cambia la entrega`
- anuncio, las tres variantes: `la campaña está pausada: el anuncio ya no estaba
  entregando…`, `el conjunto está pausado: el anuncio ya no estaba entregando…`,
  `el conjunto y la campaña están pausados: el anuncio ya no estaba entregando…`

**Los cuatro de `activate` no cambiaron un carácter**, y ahora hay un test que los
compara con `toBe` contra literales escritos a mano —el único bloque del archivo
que los escribe así, porque preguntarle el texto esperado al productor no detecta
que el productor cambió de respuesta—.

**Por qué se resolvió así, y qué se descartó.**

- **`accion` es un parámetro EXPLÍCITO de `advertenciaPadreApagado`, sin default.**
  Se evaluó dejarlo opcional con default `'activate'` para no tocar los 5 llamados
  de `mensajes.test.ts`, y **se descartó**: la diferencia entre los dos textos es
  el tiempo verbal de un hecho que el usuario lee para decidir, y un default
  dejaría que la variante equivocada saliera en silencio. El costo fue agregar
  `, 'activate'` en 5 líneas de `mensajes.test.ts`, y `tsc` encontró las cinco
  (`Expected 3 arguments, but got 2` × 5). Ningún assert de ese archivo cambió.
- **El aviso al pausar se suma sólo cuando `fila.status === 'ACTIVE'`, y ésa es la
  mitad de la decisión.** Pausar algo que ya está `PAUSED` llega con
  `motivo: 'ya_esta_en_ese_estado'` y la aclaración no agrega nada. Con eso el
  aviso aparece exactamente sobre los **92** y no sobre los **67**, y el «ruido
  sobre la operación de lote más común» que temía el comentario anterior queda
  acotado a las filas que efectivamente se apagan. **La asimetría con `activate`
  —que sí se suma sobre `ya_esta_en_ese_estado`— se conserva y tiene motivo
  propio**: «ya está activo y sigue sin entregar» ES el síntoma reportado. Las dos
  mitades están afirmadas juntas en un test para que nadie las «unifique».
- **El tercer estado es un campo nuevo en la unión, no un booleano al lado.**
  `entrega: SenalEntrega` con dos casos (`sin_senal` / `antepasado_apagado` +
  `antepasado`), y vive **sólo en la rama `interruptor`**, por la misma razón por
  la que `encendido` vive sólo ahí: «togglear una fila que dibuja un badge» sigue
  siendo imposible por tipo. **Ninguno de los dos casos se llama `entrega`**:
  `sin_senal` es «Meta no dice que un antepasado lo tenga sin entregar», que NO es
  «entrega» —un `PENDING_BILLING_INFO` tampoco entrega y cae ahí—, y nombrarlo así
  haría que el próximo lector escriba una condición sobre una afirmación falsa. Un
  test fija ese caso, así la decisión de alcance no queda apoyada en un comentario.
- **`encendido` sigue siendo `fila.status === 'ACTIVE'`, la misma expresión, sin
  tocar.** El arreglo «obvio» era hacerlo mirar el efectivo y dibujar apagados a
  los 92; eso rompe la invariante que sostiene al control (la fila dibujada apagada
  pide `activate`) y los deja **muertos en una dirección**, porque el preflight
  omitiría ese `activate` como `ya_esta_en_ese_estado`. Es la clase de bug que el
  spec anterior vino a arreglar, y lo que impide reintroducirlo no es este párrafo:
  es la property de ortogonalidad de `senalEntrega.test.ts`, que ahora **sí es una
  afirmación con contenido** porque el dibujo ya lee `effective_status` para otra
  cosa.
- **`aria-checked` sigue booleano.** `aria-checked="mixed"` se evaluó —ARIA 1.2 lo
  admite en `role="switch"`— y **se descartó**: `mixed` significa «parcialmente
  encendido» y acá el interruptor está completamente encendido, el `status` ES
  `ACTIVE`; lo apagado es el padre. Decirlo con `mixed` sería mentirle al lector de
  pantalla sobre el control que va a accionar. El tercer estado va en el
  `aria-label` (`… (no entrega)`) y en un `aria-describedby` que apunta al texto
  que nombra al antepasado y lo enlaza. **Consecuencia declarada**: para un lector
  de pantalla el switch se sigue anunciando encendido y el «no entrega» llega por
  la descripción.
- **El tono cambia `bg-good-500` por `bg-warn-500` y sólo eso.** La pista apagada
  (`bg-overlay/12`) queda igual: una fila `PAUSED / CAMPAIGN_PAUSED` con el
  interruptor apagado no afirma nada falso. `warn-500` existe en
  `tailwind.config.ts`; **`warn-100` no existe** y no se usó. La posición
  (`translate-x-4`) no se tocó.
- **El link es NAVEGACIÓN, no cascada.** `subirACampania` es espejo de
  `bajarNivel`: pone el nivel de arriba con el `campaignId` de la fila como única
  cascada, escribe la URL y **no pasa por la máquina de `seleccion.ts`** (no tiene
  evento para subir, y `bajarNivel` tampoco pasa). **No hay SQL nuevo**: el filtro
  es `o."campaignId" = ANY($campaignIds)` en el `WHERE` de afuera y a nivel campaña
  el `SELECT` emite `c.campaign_id AS "campaignId"`. Descartadas y no se
  rediscuten: filtrar por `nombre` (es substring e insensible a mayúsculas, así que
  con dos campañas parecidas lleva a la fila equivocada o a dos) y cambiar de nivel
  resaltando sin filtrar (la tabla está paginada y ordenada por gasto, y una
  campaña pausada sin gasto puede no estar en la página o quedar escondida por
  `status=active` o `ocultarSinDatos`).
- **Las dos cosas que había que cerrar para que el link fuera compartible.**
  `page.tsx` ignoraba `campaignIds` en el nivel campaña, y el síntoma **no** era
  «el link no filtra»: la PRIMERA pintura sí venía filtrada, porque
  `getMetricasAds` recibe los ids del server component. Lo que fallaba era la
  segunda, porque `construirUrl` toma la cascada del ESTADO del cliente y ese
  estado arrancaba en `null`: el primer cambio de filtro, de página o de orden
  pedía la tabla entera y la campaña se perdía de vista. Un bug que aparece recién
  en la segunda interacción se reporta como «a veces no anda». Y `ChipCascada`
  diría «Conjuntos de "X"» sobre una tabla que muestra UNA campaña; ahora dice
  `La campaña "X"`, decidido con `nivelActivo === cascada.nivel` y no con
  `nivelActivo === 'campaign'`, porque lo que hace raro al rótulo no es la campaña
  sino que los dos niveles coincidan.

**Los `toEqual` de `toggleEstado.test.ts` se ENDURECIERON, no se aflojaron.** Los
dos que rompían al agregar el campo eran `:210` (el loop de `DIRECCIONES`) y
`:731` —**no `:662`**: la tarea 6 corrió el archivo 69 líneas—. Los TRES badges
(`:230`, `:233`, `:240`) no rompieron, porque la rama `badge` no lleva `entrega`.
`toMatchObject` **no se usó** y tampoco `expect.objectContaining` ni comparar
`dibujo.encendido` en vez de `dibujo`: aflojar habría puesto el archivo en verde
sin verificar nada y habría perdido lo que ese test compra, que es que el dibujo
no tenga campos de más.

**La trampa de `DIRECCIONES`, escrita porque cuesta cinco minutos y se pierde en
diez:** `ADSET_PAUSED` y `CAMPAIGN_PAUSED` aparecen ahí como valores de
**`status`**, no de efectivo. Lo que decide la señal es el efectivo, y el helper
`fila()` pone `effectiveStatus: status`, así que esas dos filas llevan
`antepasado_apagado` **por el efectivo que el helper arma solo** y las otras seis
`sin_senal`. Si alguien le cambia el default al helper, esas dos expectativas
cambian con él y eso es correcto. Las dos siguen dibujándose APAGADAS, que es la
mitad que importa. El segundo `toEqual` lleva `entrega: dibujo.entrega` —el dibujo
de ANTES, no una segunda llamada a `senalDeEntrega`— y con eso afirma algo con
contenido: la señal es la misma después de que el `status` se dio vuelta.

**El módulo nuevo `app/(panel)/anuncios/cascadaUrl.ts`, que no estaba en el plan y
por qué hubo que crearlo.** Las cuatro piezas puras del link (`cascadaDeCampania`,
`paramsDeNivel`, `cascadaDeSearchParams`, `cascadaInicial`) tienen que ser
exportadas para que el test de la ida y vuelta exista, y **no pueden vivir en
ninguno de sus dos llamadores**:

1. En `page.tsx` no: un `page` de Next no puede exportar nada más que el default y
   los campos de ruta. `tsc` lo dijo textual:
   `Property 'cascadaDeSearchParams' is incompatible with index signature. Type
   '(searchParams…) => …' is not assignable to type 'never'` en
   `.next/types/app/(panel)/anuncios/page.ts`.
2. En `GestorAnuncios.tsx` tampoco, y esto es lo que casi se fue así: ese archivo
   es `'use client'`, así que cuando un server component lo importa React
   reemplaza sus exports por referencias de cliente. `GestorAnuncios` se puede
   **renderizar** desde el server, pero una función suya **no se puede llamar**:
   tira «Attempted to call … from the server but … is on the client». **El error es
   de runtime y `tsc` no lo ve**, así que la única defensa es que la función no esté
   ahí. Se probó primero con la función en `GestorAnuncios.tsx`, `tsc` quedó limpio
   y los 17 tests pasaron: nada lo habría agarrado antes de abrir la página.

Un módulo sin directiva sirve a los dos lados. No importa `pg` ni `next/headers`,
por lo mismo que `lib/ads/plazos.ts`.

**Consecuencia pendiente, declarada y no olvidada: el link sólo aparece para
`antepasado: 'campaign'`.** Para un anuncio bajo un conjunto pausado
(`ADSET_PAUSED`) el tercer estado se dibuja igual —tono, `aria-label`,
`aria-describedby`— pero **sin link**, y el motivo es que no hay destino: el nivel
de conjuntos se filtra por `campaignIds`, así que llevar ahí mostraría TODOS los
conjuntos de la campaña y el usuario tendría que buscar el suyo en una tabla
paginada y ordenada por gasto. Eso es exactamente la alternativa que el diseño
descartó («cambiar de nivel y sólo resaltar sin filtrar»), y hacerla acá sería
reintroducirla por la puerta de atrás. Si algún día se quiere, lo que falta es un
filtro por `adsetIds` en el nivel conjunto, no un `if` en `celdas.tsx`.

**Lo que se decidió NO tocar.** El badge de `TablaAds.tsx:254` sigue dibujándose
cuando `effective_status` difiere de `status`: el tercer estado se **suma**, no lo
reemplaza. Los generadores de `ADVERTENCIAS` de `mensajes.test.ts` no ganaron las
variantes de `pause`: esas properties son sobre la forma del traductor y los
textos nuevos tienen la misma estructura que los de activar, así que agregarlos
ampliaría la superficie de un test de preservación en una tarea que no lo pidió.

**Qué se verificó.** `npx tsc --noEmit` limpio y **`npx next build` completo**
(`✓ Compiled successfully`, `/anuncios` 33.3 kB), que es la corrida que ejercita la
frontera server/cliente del punto 2 de arriba. `npm test` con Postgres arriba:
**`Test Files 2 failed | 103 passed | 3 skipped (108)`,
`Tests 6 failed | 1284 passed | 46 skipped (1336)`**, contra el
`3 failed / 11 failed (107 / 1305)` con el que arrancó la tanda. La cuenta cierra
sin residuo: **−5 fallos** (los 5 de `senalEntrega.test.ts`, que ahora pasa 18/18
incluido `PENDING_BILLING_INFO → sin_senal`), **+1 archivo** (`navegacionCampania.test.ts`,
17 tests) y **+36 passed** = 5 que se dieron vuelta + 4 nuevos de `senalDeEntrega`
+ 17 de navegación + 8 netos de `previsualizacion.test.ts` (9 nuevos menos el
`pausar NO lleva la advertencia`, que afirmaba el defecto de 1.12 y se reemplazó
por su inverso) + 2 de `route.advertencia.test.ts`. Los **6 que quedan son los de
las tandas C y D** con los mismos conteos de antes (2 + 4) y **no se tocaron**.

`npx next lint` **no se pudo correr**: el repo no tiene `.eslintrc`, así que el
comando se queda esperando la configuración interactiva. El paso de lint que sí
corrió es el de `next build` («Linting and checking validity of types»).

**Sin verificar contra un navegador**: el tono `bg-warn-500`, la posición del link
en la celda y qué anuncia un lector de pantalla. El repo corre vitest en node, sin
jsdom, así que lo que está bajo test es `dibujoDeEstado`, `senalDeEntrega`,
`rotuloCascada` y las cuatro funciones de `cascadaUrl.ts`; el JSX de `ToggleEstado`
que las consume, no.

### Fase 3, tarea 14 — Tanda C: el `status` confirmado se escribe local, y la relectura sale del camino crítico

**Qué pasaba.** El POST de acciones hacía `await refrescarJerarquia(...)` en
`route.ts:576`, justo después de `cerrarAccion(id, 'confirmado')`: un GET a Meta
con su propio `AbortSignal.timeout(30_000)` adentro del tiempo que el usuario pasa
mirando un interruptor que ya se movió, para traer un dato que la respuesta no
necesita —Meta ya confirmó— y que el comentario de esa misma función declara
best-effort, con un `catch {}` que se come el error a propósito.

Y la mitad que convierte al arreglo obvio en una regresión: `refrescarJerarquia`
era el **ÚNICO escritor** del `status` que Meta confirmó. Sacarle el `await` y
nada más deja el refetch inmediato del cliente devolviendo la posición vieja y el
interruptor volviendo para atrás, que es el síntoma que este spec vino a arreglar.
No es una deducción: está medido en la fase 0, cambiando el `await` por `void` y
corriendo el archivo — `Tests 1 failed | 1 passed (2)`, con (a) pasando y (b)
todavía en rojo. Por eso la tanda tiene dos pasos y no uno.

**Por qué se resolvió así, y qué se descartó.**

- **`escribirStatusConfirmado` escribe UNA columna**, con `campos.status` y no con
  `after`: `campos` es literalmente el cuerpo del POST, y elegir entre las dos
  copias del mismo hecho sería agregar una segunda derivación. Cada exclusión
  tiene motivo y ninguna es un olvido: `effective_status` **no lo sabemos**
  (pausar un conjunto cambia el efectivo de sus anuncios, activar uno bajo una
  campaña pausada lo deja en `CAMPAIGN_PAUSED`, y derivarlo sería reimplementar la
  resolución de Meta que este repo ya documentó dos veces como sutil: el estado
  propio gana sobre el del padre); los presupuestos **no** (la acción de estado no
  los toca); `synced_at` **no** (afirmaría que la fila ENTERA está fresca cuando
  lo confirmado es un campo, que es la misma frescura falsa que la tanda A arregla
  del otro lado); y `desaparecido_at` **la sigue limpiando sólo la relectura**, por
  la regla evidenciaria: una escritura confirmada MÁS una relectura que trajo la
  fila es evidencia directa de que el objeto existe, y la escritura sola es la
  mitad de esa evidencia.
- **Ese alcance ahora tiene guarda ejecutable y no sólo un comentario.** El caso
  (c) de `route.diferido.test.ts` afirma que `synced_at` se adelanta **después**
  del refresco diferido, así que si la escritura local lo adelantara, falla.
  Probado a mano. Es la diferencia entre que la decisión C2 esté escrita y que
  esté defendida.
- **Las dos consecuencias, declaradas.** R4.7 pedía limpiar `desaparecido_at` sin
  el atraso del cron y se sigue cumpliendo con el atraso del diferido: **segundos,
  no 15 minutos**. Es un debilitamiento acotado, no una regla aflojada. Y después
  de pausar uno de los 92, la fila queda `PAUSED` con
  `effective_status = CAMPAIGN_PAUSED` hasta que el diferido vuelva: dato
  atrasado, no afirmación falsa —no entrega de las dos formas—.
- **Las dos salidas descartadas, para que no se rediscutan.** *Devolver el estado
  nuevo en la respuesta*: el cliente YA tiene ese valor, es el que pintó
  optimistamente, así que sería un segundo lugar clasificando el mismo hecho, que
  es la forma del bug original. *Aceptar el refetch viejo con una guarda del estilo
  de `conservarPintadoEnVuelo`*: esa guarda sólo actúa mientras el id está en
  `enVuelo`, y el `refrescar()` dispara el GET **después** de que el `finally` lo
  sacó del set; mantenerlo adentro hasta que la lectura vuelva alargaría el tiempo
  en que la fila descarta clicks, o sea convertir un dato viejo en un control
  temporalmente muerto.
- **`esperarRefrescosPendientes` no podía vivir en `route.ts`, y el diseño lo
  ponía ahí.** Un `route.ts` de Next no puede exportar nada que no sea un método
  HTTP o una opción de segmento, y como `tsconfig.json` incluye `.next/types/**`,
  el rechazo aparece **también en `npx tsc --noEmit`**. Textual:

      error TS2344: Type 'OmitWithTag<typeof import(".../route"), …>' does not
      satisfy the constraint '{ [x: string]: never; }'.
        Property 'esperarRefrescosPendientes' is incompatible with index signature.
          Type '() => Promise<void>' is not assignable to type 'never'.

  De ahí sale `app/api/ads/acciones/_diferir.ts`, que es el mismo patrón que
  `_server.ts` y `_tipos.ts` al lado de la página de reglas. **Es la misma clase de
  hallazgo que hizo existir `cascadaUrl.ts` en la tanda B2**, y conviene leerlos
  juntos: son dos fronteras de Next que ningún test de este repo mira. La
  diferencia está en quién avisa. Acá avisa `tsc`, por `.next/types`. Allá —una
  función de un archivo `'use client'` llamada desde el server— **no avisa nadie**:
  se probó con la función adentro de `GestorAnuncios.tsx`, `tsc` quedó limpio, los
  17 tests pasaron, y el error habría aparecido recién al abrir la página. Si
  alguien mueve una de las dos «para que estén con su llamador», ése es el costo.
- **El registro de promesas no es adorno, y hay evidencia:
  `route.frescura.test.ts` pasaba igual SIN el `await esperarRefrescosPendientes()`.**
  Le ganaba la carrera al refresco diferido. O sea que sin el registro el test
  habría pasado ese día y fallado en la máquina cargada de otro, que es
  exactamente la flakiness que este helper vino a evitar y la forma más cara de
  romper una suite. Con el registro la espera es exacta: no hay ninguna gracia de
  reloj que la máquina lenta del día pueda invalidar.
- **Dos estructuras con dos trabajos en el cliente, y el reparto es la decisión.**
  El `Set` del `useRef` sigue siendo **la guarda** y tiene que ser síncrono (3.11:
  dos clicks en el mismo tick no pueden pasar los dos, y un `setState` es
  asíncrono); el `useState<ReadonlySet<string>>` nuevo es sólo **lo que se
  dibuja**. **No se reemplazó una por la otra.** El argumento del comentario
  original —«un `setState` por click volvería a renderizar la tabla entera»— no se
  perdió, se acotó: el camino del toggle ya renderiza la tabla entera porque el
  pintado optimista llama a `setData`, y lo que ese comentario evitaba era el
  render de consultar la guarda en CADA click, incluidos los descartados. Eso
  sigue saliendo del ref.

**Qué se verificó.** `route.diferido.test.ts` con sus cuatro casos en verde, y el
(a) **leído y no sólo visto**: ejercita el deferred bloqueado de verdad
—`fetchObjeto` se llama sincrónicamente antes de que el `await` suspenda— y las dos
guardas de armado, `toHaveBeenCalledTimes(1)` y
`toHaveBeenCalledWith(id, 'campaign')`, cierran el modo vacío, que es el test que
pasa porque no midió nada. `route.frescura.test.ts` pasa con **las aserciones
intactas** y su único cambio es la espera; en particular el caso 2 sigue afirmando
que `marca` y `sync` no se mueven, que es lo que prueba que la escritura local
escribió `status` y nada más. `route.discrepancia.test.ts`, sin editar.

### Fase 3, tarea 15 — La guarda del acoplamiento C↔D: un flag que afirma algo sobre otro archivo

**Qué pasaba.** El plazo que el cliente le da a un click tiene que ser mayor que
el peor caso del servidor (2.7), y ese peor caso **cambia cuando la tanda C
entra**: con la relectura en el camino crítico son `4 + 30 + 30 = 64 s` por
objeto, sin ella `34 s`. O sea que el número del plazo depende de un hecho que
vive en otro archivo, y no había nada que relacionara los dos.

**El escenario prohibido, escrito porque es el único que hace daño:** shippear D
con el número post-C mientras C **no está desplegado**. Un click cuyo servidor
tarda 64 s se abandonaría a los 44 s y produciría un `indeterminado` sobre un
pedido que estaba por confirmarse: es lo que 2.7 prohíbe y es peor que la espera
que este spec vino a bajar. **No alcanza con que el código de C esté en la rama**:
el número tiene que corresponder al servidor que le contesta al cliente. Los otros
dos órdenes son seguros y por eso no se prohíben: C→D calcula el plazo una sola vez
con 34 s (44 s para una fila), y D→C lo calcula con 64 s (74 s) y **baja solo**
cuando C entra, porque los dos números salen de la misma suma.

**Por qué la guarda es un test y no un comentario.** `refrescoEnCaminoCritico()`
de `lib/ads/plazos.ts` no es una perilla ni una preferencia: es una **afirmación
sobre otro archivo**. El caso (a) de `route.diferido.test.ts` mide si la respuesta
salió antes de que la relectura volviera y compara esa medición contra el flag, así
que ponerlo en `false` sin haber movido la llamada —o mover la llamada sin cambiar
el flag— deja la suite en rojo.

**Provocada a mano y revertida.** Con el flag en `true`:

    × (a) la respuesta sale ANTES de que `fetchObjeto` vuelva
      → refrescoEnCaminoCritico() dice true y el route NO espera la relectura
        expected true to be false
    Tests 1 failed | 3 passed (4)

**Rompe un solo test, el que mide**, y ese radio es parte de la evidencia: (b), (c)
y (d) quedan verdes. Es el mismo criterio con el que se corrigió la guarda del cron
en la 11.2, donde la primera provocación rompió dos tests y el segundo mentía sobre
qué se había roto: un guardián que se rompe en todos lados no dice qué pasó.

**El segundo parámetro `refrescoDentro` de `peorCasoEstadoMs` y
`plazoClienteEstadoMs` es un parámetro de test, y ningún llamador de producción lo
pasa.** Existe porque el flag está hardcodeado en `false`: sin junta, los números
del mundo pre-C quedaban escritos y **nunca ejecutados**. **`vi.spyOn` no servía**:
en ESM la llamada interna a `refrescoEnCaminoCritico()` es una referencia directa
dentro del módulo y no pasa por el namespace, así que el spy no la intercepta. Y
**pasarlo desde producción sería saltear la guarda**, porque el flag dejaría de ser
el único lugar donde vive el acoplamiento.

**Lo que esta guarda NO cubre, y va acá porque es donde se lee.** La cota es sobre
las llamadas a Meta y no sobre el request entero: el preflight, las consultas a la
base y `abrirAccion`/`cerrarAccion` no tienen deadline, así que un Postgres que se
arrastra puede pasarse de la cota. Lo único reservado para eso es
`HOLGURA_CLIENTE_MS = 10_000`, que **es una estimación y no una medición**: no hay
filas de producción con tiempos reales de clicks. Por eso 2.6 —el vencimiento es
`indeterminado` y nunca un fallo— no es opcional: este número puede quedar corto
sin que nada de la suite se entere.

### Fase 3, tarea 16 — Tanda D: el toggle sale con plazo, y el plazo del lote deja de ser 60 s

**Qué pasaba.** El `pedir` del toggle de una fila era `fetch(url, init)` pelado y
el `init` que armaba `ejecutarToggle` no llevaba `signal`
(`expected undefined to be an instance of AbortSignal`): un POST que no volvía
dejaba la fila pintada con un valor que nadie confirmó, el id en `enVuelo` para
siempre —el segundo click se descarta, o sea el control muerto hasta recargar— y
**ningún aviso**. El lote sí tenía plazo, pero era
`accion === 'duplicate' ? 300_000 : 60_000`, y 60 s es MENOR que el peor caso del
servidor para **un solo objeto** (`expected 60000 to be greater than 64000`)
cuando el lote hace ese camino por objeto en serie. Y cuando algo cortaba, el aviso
interpolaba `e.message`, que para un `AbortSignal.timeout` es `The operation was
aborted due to timeout`: una frase en inglés dentro de un aviso en castellano, que
además no dice cuánto se esperó.

**Por qué se resolvió así, y qué se descartó.**

- **El plazo entra en `ejecutarToggle` y NO en el `pedir` del componente.** `pedir`
  vive adentro del componente, o sea en la parte del archivo que ningún test de
  este repo puede tocar (vitest en node, sin jsdom): ahí el número quedaría sin
  verificar justamente en el camino que el usuario usa. En `ejecutarToggle` el
  `init` es observable, porque el `pedir` del test lo registra.
- **Por el mismo argumento `plazoDeLoteMs(accion, cantidad)` se extrajo como
  función pura exportada** en lugar de dejar un ternario de tres ramas adentro del
  `fetch` del handler: el número tiene que ser observable, y es lo que permite
  fijar por test que `duplicate` sigue en 300 s para 1, 20 y 100 objetos (3.14) y
  que las otras tres siguen en 60 s.
- **Las dos correcciones al material de entrada, con sus números.**
  `PRESUPUESTO_RELECTURA_MS` va **fuera** del `n ×`, porque `relecturaSelectiva`
  calcula su `limite` una sola vez antes del loop: el peor caso es `4 + n × 60` y
  no `n × 64`. Para un objeto da lo mismo —64 s de las dos formas, que es por qué
  el error no se veía— y para 20 la diferencia es `4 + 20 × 60 = 1204 s` contra
  `20 × 64 = 1280 s`. Y **el camino de lote SÍ tenía plazo**: lo que estaba mal era
  el número, `60 s` contra un peor caso de `64 s` para un solo objeto. El que no
  tenía plazo era el toggle de UNA fila.
- **El plazo crece linealmente con `n`, y eso es un piso que impone 2.7, no un
  objetivo de UX**: con 20 objetos son 614 s post-C. **El techo de 300 s está
  descartado por test y no por comentario**: `peorCasoEstadoMs(5) = 154 s` entra y
  `peorCasoEstadoMs(10) = 304 s` ya no, así que un techo devolvería la violación de
  2.7 a partir de 5 objetos. Un techo no acorta el servidor, sólo hace que el
  cliente deje de esperarlo.
- **`textoDeFalloDeToggle` cae al segundo texto cuando no reconoce el error: decir
  menos, no afirmar más.** `esAbortoPorPlazo` mira `error.name` —`TimeoutError` en
  Node/undici, `AbortError` en algunos navegadores, los dos medidos en la tarea 6—
  y cuando no reconoce nada devuelve `false`, porque interpolar el mensaje de un
  error desconocido informa más que una frase sobre un plazo que puede no haber
  sido la causa. La rama del plazo afirma algo concreto —«no confirmó en 44
  segundos»— y sólo se usa cuando eso es verdad.
- **Ninguna de las dos ramas puede decir que el cambio no ocurrió (3.1).** La
  segunda oración es textual en las dos y una property de **300 runs** prohíbe «no
  se aplicó», «no ocurrió» y «no se cambió» para cualquier error que el generador
  arme. Un POST cortado pudo haberse aplicado igual, y el plazo del cliente es una
  segunda instancia del criterio con el que `enviar` clasifica su propio timeout
  como `indeterminado`.

**Qué se verificó.** Los cuatro pares de números del módulo de plazos en los dos
mundos del flag (`64 s / 74 s` y `34 s / 44 s` para `n = 1`, `1204 s / 1214 s` y
`604 s / 614 s` para `n = 20`) y la desigualdad cuantificada sobre `n` con
`fast-check`; que el `init` del toggle sale con `plazoClienteEstadoMs(1)` y no con
un número escrito en el componente; las dos ramas del texto y la oración que
comparten; y el recorrido de punta a punta del plazo vencido —la fila vuelve a
`statusPrevio`, el id se libera, el aviso no afirma que el cambio no ocurrió—.

**Qué NO se verificó, y no se tapa: el vencimiento contra el reloj real.** Ningún
test de esta suite puede esperar 44 s y `AbortSignal.timeout` no respeta los fake
timers de vitest, porque el timer vive en la plataforma. **No se mockeó
`AbortSignal`**: eso verificaría el mock. Lo verificado es que el `signal` sale con
el plazo correcto y que un rechazo con nombre de timeout produce el desenlace
correcto.

**Y una aserción que quedó sin correr, a propósito.** El caso (a) de
`togglePlazo.test.ts` tenía la carrera del `'colgado'` condicionada a que el `init`
**no** trajera `signal`; ahora lo trae, así que ese `if` no entra nunca. Se dejó
igual para que el archivo diga la verdad en los dos mundos —sin plazo, «esto no
termina» es literal y para siempre; con plazo, quien corta es el `fetch`— y lo que
sigue corriendo de ese caso es todo el estado en vuelo: un solo pedido, la fila
pintada con el status optimista, el id en `enVuelo`, cero avisos, cero refrescos y
el segundo click descartado.

### Fase 4, tarea 17 — El checkpoint, con los números

`npx tsc --noEmit`: **cero líneas de salida, exit 0.**

`npm test` con Postgres arriba —`nc -z 127.0.0.1 5433` OK antes de arrancar, que
es lo primero a mirar antes de investigar un fallo en masa—:

    Test Files  106 passed | 3 skipped (109)
    Tests  1324 passed | 46 skipped (1370)
    Duration  96.95s

Contra el baseline de `e3e7e8b` —**86 archivos / 1041 tests**— son **+23 y +329**,
y los dos son los números más altos que la suite tuvo. Eso es lo que la tarea 17
pedía verificar y no es ceremonia: este plan agrega y no borra, así que un conteo
que baja significa que algo quedó en `skip` y hay que encontrar qué antes de
seguir.

**Los 46 salteados son los tres preexistentes fuera de alcance**, y quedan
nombrados para no volver a contarlos: `lib/ingest/apply.test.ts` (21),
`lib/queries/sales.test.ts` (17) y `lib/day.test.ts` (8). **Ningún
`skipIf(!dbAvailable)` de la tanda C se salteó**, que es la parte que importa: una
corrida sin Postgres saltea en silencio justamente los tests que verifican el
refresco diferido, o sea que da verde sin haber verificado la tanda.

`npx next build`: `✓ Compiled successfully`, con cero coincidencias de
`error|warn|failed|Attempted to call`. Ese último patrón está en la lista por la
frontera server/cliente de `cascadaUrl.ts`: es un error de runtime que `tsc` no ve.

**Las dos guardas rompen cuando se las provoca.** La del cron: con `*/30` en
`deploy/cron.panel`, `× … el schedule de sync-ads-jerarquia.ts coincide con la
constante → el crontab dice 1800 s y el código 900 s … expected 1800 to be 900`,
**1 fallo de 7**, y `git diff` sobre el archivo vuelve a 0 después de revertirlo.
La del acoplamiento C↔D está en la tarea 15, con su salida textual: **1 fallo de
4**, el que mide.

**El caso del deferred, corrido y leído** y no sólo visto en verde. Es el que hace
verdadera la afirmación del módulo de plazos, y por lo tanto el que sostiene el
acoplamiento C↔D: si ese test no midiera lo que dice, el término del refresco no
se podría sacar de la suma.

### Los pendientes de todo el spec, en un solo lugar

Cada subsección dejó los suyos en su contexto; ésta es la lista completa, que es
la que hay que leer si alguien toma este spec desde cero.

- **`budget_set`, `rename` y `schedule` siguen con los 60 s** del plazo de lote, y
  tienen la misma clase de defecto que este spec arregla para `pause`/`activate`:
  un plazo del cliente que nadie comparó contra el peor caso de su propio camino
  en el servidor. Quedan afuera porque 1.9 y 2.5–2.8 hablan de `pause`/`activate`
  y porque extenderlo pide medir el peor caso de cada una —`budget_set` tiene su
  propio `fetchMinimoPresupuesto` en el preflight—. **Pendiente con dueño
  conocido, escrito y no implícito en un `if`.**
- **La relectura del renombrado (`route.ts:1192` y `:1401`) sigue sincrónica y con
  su propia copia de la lógica.** La tanda C no la difirió: este spec no la
  reportó.
- **El seed de `db/migrations/025_ads_frescura.sql:144` queda como quinta copia del
  900**, porque el SQL de una migración no puede importar un módulo de TypeScript.
  Está declarado en el docblock de `frescura.ts`. Lo que compró la tarea 9 es que
  la próxima vez sean dos lugares y no cinco.
- **El motor de reglas sigue apagado y forzado a dry-run**
  (`ads_rules_enabled = false`, `ads_rules_force_dry_run = true`, 3.18). **Fuera
  de alcance de este spec y a confirmar si ese apagado es intencional**: nadie lo
  confirmó todavía.
- **`lib/ads/mensajes.test.ts` quedó modificado y no figura en la lista de archivos
  de ninguna tarea del plan.** No es una regresión: la tarea 12 le puso a
  `advertenciaPadreApagado` un tercer parámetro **obligatorio**
  (`accion: 'pause' | 'activate'`) y los 5 call sites de ese test tuvieron que
  pasar `'activate'` explícito para compilar —`tsc` encontró los cinco con
  `Expected 3 arguments, but got 2`—. Verificado que ninguna aserción se aflojó y
  que los cuatro textos de `activate` son idénticos carácter por carácter contra
  `git show HEAD:lib/ads/previsualizacion.ts`.
- **El link del tercer estado sólo aparece para `antepasado: 'campaign'`.** Un
  anuncio bajo un conjunto pausado dibuja el tercer estado igual —tono,
  `aria-label`, `aria-describedby`— pero sin link, porque no hay destino: lo que
  falta es un filtro por `adsetIds` en el nivel conjunto, no un `if` en
  `celdas.tsx`.
- **El dibujado de 2.15 —`aria-busy`, el atenuado y el `title`— queda sin test.**
  `vitest.config.ts` corre en node sin jsdom y su `include` sólo toma `.test.ts`.
  Lo que sí está fijado por test es el reparto ref/estado
  (`secuenciaPedidos.test.ts` y la guarda de 3.11 de `toggleEstado.test.ts`).
- **El caso (a) de `togglePlazo.test.ts` tiene una aserción que ya no corre**, el
  `if` del `'colgado'`, dejada a propósito y con el motivo en la tanda D.
- **`senalEntrega.test.ts` sigue leyendo el campo `entrega` por el puente de
  `unknown`** de la tarea 3, aunque el campo existe en `DibujoEstado` desde la
  13.1 y la 13.5 lo habilitaba a limpiarlo. Mientras el cast esté, un rename del
  campo lo agarra el runtime del test y no `tsc`.
- **El hueco del «presupuesto de espera propio» de 3.13 sigue sin test
  ejecutable**: `leerFilas` hace un `fetch` real y no lo recibe por parámetro, así
  que afirmarlo pediría mockear `globalThis.fetch`. Las tandas C y D no tocan
  `leerFilas` ni sus llamadores, así que el hueco no creció.
- **`HOLGURA_CLIENTE_MS = 10_000` es una estimación, no una medición.**
- **El flake de `app/api/ads/reglas/route.test.ts` sigue sin diagnosticar y sin
  salida capturada.** No reapareció en ninguna corrida posterior. Si vuelve, hay
  que guardar la salida completa; el sospechoso sigue siendo la contención contra
  las mismas tablas.

### Lo que NO se verificó, sin ablandarlo

- **Que el crontab instalado en el host sea `deploy/cron.panel`.** El test compara
  contra el archivo del **repo**, no contra `crontab -l`, y ese archivo ya advierte
  el hueco: la línea del gasto de anuncios estuvo viva en la VPS sin estar en el
  repo. La única forma de cerrarlo es el `diff` a mano que ahí está documentado.
- **Que `ads_frescura_umbral_segundos` valga 900 en la base de producción.** La
  Property 1 cubre cualquier valor, pero nadie verificó cuál está puesto: se mira
  con una consulta a mano.
- **Cuánto tarda una corrida de la jerarquía y cuánto jitter tiene el cron.** Es la
  cota inferior del margen y está elegida **por argumento, no por medición**: si
  una corrida tardara más de 450 s el margen queda corto, y el síntoma sería el de
  hoy pero más raro y más difícil de reproducir.
- **Los tiempos reales de los clicks.** `ad_actions` tiene **una** fila en la base
  local, un `pause` de campaña del 2026-08-21, y **no es de la base donde se
  clickeó**. Los plazos salen de los timeouts que el código declara, no de
  latencias medidas.
- **El vencimiento del plazo contra el reloj real.** Ningún test puede esperar
  44 s, `AbortSignal.timeout` no respeta los fake timers de vitest, y **no se
  mockeó `AbortSignal`** porque eso verificaría el mock.
- **Cualquier prueba a mano contra la cuenta real de Meta.** Nada de este cambio se
  ejercitó contra los 92 conjuntos de verdad: lo que hay es la suite, el
  `next build` y el reparto 92/67/10 leído de la base.

**`COMO-DEPLOYAR.md` no se toca:** este cambio no causó ninguna caída de deploy. Si
alguna vez la causa, va también en su §«Cosas que ya pasaron y no conviene
repetir».

---

## 2026-08-26 — Un solo parseo de plata: `1.000` no era mil en ninguno de los cuatro campos

Spec `parseo-montos-anuncios`, commiteado en `0e151e0` (Montos: un solo parseo de
plata, «1.000» ya no se lee como 1) sobre `8e07ff8`.

**Qué pasaba.** `parsearPresupuesto('1.000', 5000)` devolvía
`{"ok":true,"valor":1}`, y de ahí salía `campos: { daily_budget: '100' }` a la
campaña real de Meta. Un euro donde la persona quiso mil, sin error, sin borde
rojo y sin nada en ningún log.

El mismo agujero estaba en tres lugares más, los cuatro con `Number()`:
`numeroDeTexto` en Reglas (techo, piso, valor de la acción y umbrales de
condiciones) y el `Number()` crudo del límite de ejecuciones diarias en dos
puntos. Un techo de `1.000` quedaba en 1 y la regla no podía subir nada nunca; un
umbral «gasto > 1.000» se guardaba como «> 1», que en una regla de pausar pausa
casi todo — el mismo modo de falla que la entrada del 2026-08-24 describe para la
condición vacía, entrando por otra puerta.

`Number('1.000')` es 1 por spec de JavaScript: no había ningún bug dentro de las
funciones. El bug era usar `Number` como parseo de un campo de plata en
castellano. Y los cuatro campos eran tipeables: los de Reglas son texto libre con
`inputMode="decimal"`, y el del presupuesto era `type="number"`, donde `1.000` es
un float válido y 1 está dentro del rango, así que el browser tampoco protestaba.

**Por qué se resolvió así, y qué se descartó.**

- **Se comparte `parsearMonto` en vez de endurecer las tres copias.** Mientras
  hubiera cuatro implementaciones, arreglar una no arreglaba nada. La causa era de
  arquitectura, no de una línea. Se extrajo el núcleo `leerNumeroEscrito`, que
  dice **qué número dice un texto y nada más**; la política (rango, signo,
  cantidad de decimales, entero o no) se queda en cada pantalla.
- **`app/(panel)/finanzas/monto.ts` se movió a `lib/monto.ts` con su test y sin
  renombrar.** Descartado importarlo desde `app/`: ningún módulo de producción de
  `lib/` lo hace, los tres imports en esa dirección son de tests. Descartado
  re-exportarlo desde `lib/` dejando el archivo en `app/`, que es la misma
  dependencia invertida con un salto más. El nombre se conservó a propósito: el
  único import del test es `'./monto'`, así que mover los dos archivos juntos lo
  dejó **idéntico byte por byte**.
- **`1e3`, `0x10`, `0b11`, `0o17` y `+5` se dejaron de aceptar A PROPÓSITO.** Hoy
  devolvían 1000, 16, 3, 15 y 5. Es un cambio deliberado de comportamiento, no un
  descuido: el criterio de un campo de plata es «sólo números, coma o punto», y
  nadie tipea `0x10` en un presupuesto queriendo decir 16 euros. **Queda anotado
  acá para que nadie lo «arregle» de vuelta.** En la dirección contraria y también
  a propósito, `€5` y `1 000` (con espacio fino, duro o BOM, de un copy-paste de
  Excel) pasaron a aceptarse.
- **Son SIETE familias de excepción declaradas (a–g), no seis.** Son los únicos
  lugares donde el veredicto cambia, y la propiedad de preservación las tiene
  escritas como siete regex nombradas con su cláusula al lado. Si alguien ve un
  veredicto distinto al de antes y no está en esas siete, es un bug nuevo.
- **La familia (g) no la encontró nadie leyendo: la midió un test.** Se comparó
  los dos oráculos congelados contra una simulación del núcleo sobre **404.661
  combinaciones** (lado presupuesto) y **358.206 textos** (lado Reglas): 14.870 y
  6.915 flips, **todos declarados menos 64 y 56**, que son exactamente
  `^-\d+\.\d{3}$`. `parsearPresupuesto('-1.000', 100)` daba `bajo_el_minimo` y con
  el núcleo daba `ambiguo`. Se decidió que **el signo entra en la ambigüedad**
  (`-1.000` es −1000 o −1) y se descartó la salida fácil —que el núcleo no mire el
  signo— porque deja el bug vivo para los negativos: una condición
  «ganancia < -1.000» se seguiría guardando como −1.
- **En Reglas, un texto sin dígitos no es 0**, y esto también salió de medir. El
  núcleo resuelve `'.'` como 0 (familia (f), declarada y no corregida porque
  corregirla cambiaría el mensaje de `parsearMonto('.')`, que la cláusula 3.13
  congela). En el presupuesto es inocuo porque lo ataja `bajo_el_minimo`; **en
  Reglas no hay mínimo**, y en una condición el 0 es legítimo a propósito, así que
  «gasto > .» pasaba de bloquearse a guardarse como «gasto > 0». `numeroDeCampo`
  pone su propia política y lo rechaza, sin tocar el núcleo.
- **El tipo de retorno de Reglas cambió, y ese cambio ES el arreglo.**
  `numeroDeTexto` devolvía `number` con NaN como única señal, así que la
  validación no podía distinguir «vacío» de «ilegible» de «ambiguo» y sólo podía
  preguntarle `isFinite` al número **ya corrompido**: por eso `problemaAccion`
  aprobaba un techo de 1. `numeroDeCampo` devuelve tres estados y la validación
  mira el texto.
- **El campo del presupuesto dejó de ser `type="number"`** y pasó a texto con
  `inputMode="decimal"`. Los tres atributos de rango (`min`, `max`, `step`) se
  borraron en lugar de reemplazarse: `parsearPresupuesto` ya tiene los tres cortes
  equivalentes. Sin esto la decisión de aceptar la coma quedaba escrita y sin
  efecto, porque un `type="number"` se come la coma antes de que el parseo la vea.
- **El rechazo lleva su texto puesto** (`{ ok: false, motivo, texto }`). Antes el
  borde rojo del campo y el bloqueo del botón Ejecutar llamaban a `textoDeMotivo`
  por separado y la coherencia era una convención; ahora los dos leen el mismo
  campo del mismo objeto. Lo volvió necesario un motivo concreto: la explicación
  de `ambiguo` interpola el texto que se escribió, así que no puede salir de un
  `Record` fijo.
- **El token de Tailwind:** `hover:text-good-100` en `ChipCascada.tsx:53` no
  existía (la escala `good` va de 200 a 600), así que no emitía CSS y el hover no
  cambiaba de color. Pasó a `good-200`. Lo que vale registrar no es la línea sino
  la guarda: `lib/paleta.test.ts` barre las clases de color literales de `app/`,
  `components/` y `lib/` contra la paleta de `tailwind.config.ts` (805 usos, 67
  clases distintas, 260 archivos) y **se provocó a mano para verla romper**.

**Lo que quedó pendiente.**

- **Los datos ya guardados se señalan pero NO se corrigen.** Un `budget_max = 1`
  no se distingue con certeza de un techo de un euro puesto a propósito, así que
  la decisión es de una persona. La forma de encontrarlos es **`npm run
  ads:auditar-montos`** (`scripts/verificar-montos-reglas.ts`, sólo lectura, sin
  una sentencia de escritura en el archivo) más el badge «revisar N importes» en
  la celda «Acción y condición» de la lista de Reglas. Los dos usan el mismo
  predicado y el mismo umbral, así que no pueden discrepar. Contra la base local:
  **24 reglas, 50 condiciones, 32 valores sospechosos en 18 de 24 reglas (6 «muy
  probable», 26 «posible»)**. Son **casi todos falsos positivos esperados**: las
  reglas se llaman «Duplicar a $25 - Gasto -$10» y «Apagar - Gasto +$4 sin
  ventas», o sea que un techo de 25 y un umbral de 10 son los valores normales de
  esa cuenta. El número desnudo se lee mucho peor de lo que es, y por eso el
  script dice «sospechoso» y no «error» y sale siempre con 0.
- **`max_runs_per_day = 1` es NO DETECTABLE por decisión**: una ejecución diaria
  es legítimo y frecuente, indistinguible de un `1.000` corrompido. El script lo
  dice en voz alta para que la omisión sea visible.
- **El backend sigue sin ser una segunda línea de defensa**: el schema
  `presupuestoEur` recibe un `number` ya parseado, y quedó **pinneado con un test**
  que `budgetEur: 1` pasa sin chistar. La cláusula 3.5 pide que el endpoint acepte
  los mismos importes que el formulario, así que mover la validación al server
  quedó fuera de alcance: quien postee directo con curl puede seguir escribiendo 1.
- **Sin corte de decimales en las condiciones** (`numeric(16,4)` sigue redondeando
  en silencio) y sin corte por el tope de `smallint` en `max_runs_per_day` ni de
  `numeric(14,2)` en los importes de reglas: los rechaza la base con un error de
  Postgres. Es feo y es previo a este arreglo.
- **Dos defectos cosméticos con dueño conocido:** el mensaje de ambigüedad de un
  texto que empieza con 0 (`0.009` produce `"0.009" se puede leer de dos formas:
  escribí 0009 si querés decir 0009, o 0 si querés decir 0`), que no se limpió
  porque cambiaría un mensaje que 3.13 congela; y `textoDeImporte`, que sigue
  sembrando el campo con punto (`12.50`) en vez de coma.
- **`tasks/saldo-cuentas/` apunta al path viejo en cuatro lugares**
  (`T04-componentes-ui.md:117`, `00-PLAN-SALDO.md:436` y `:517`,
  `PROMPT-CLAUDE-CODE.md:126`), y uno de ellos dice «no escribas otro parseo de
  plata» señalando `app/(panel)/finanzas/monto.ts`, que ya no existe. Quien siga
  esa instrucción no encuentra el archivo y el riesgo concreto es que escriba una
  quinta copia. **No se editaron: son planes de otra feature.**
- **La entrada del 2026-08-24 de este archivo también nombra el path viejo**
  (`app/(panel)/finanzas/monto.ts`). Se deja **sin tocar**, como testimonio de
  dónde estaba el archivo entonces; el movimiento está registrado acá, que es
  donde corresponde. Reescribir una entrada vieja para que coincida con el
  presente es justamente lo que haría inútil este archivo.
- **`app/(panel)/anuncios/reglas/_formBase.ts` es nuevo y producción no lo
  importa**: es el fixture del formulario que estaba copiado en tres tests y que
  iba a ser la cuarta copia. Vale anotarlo porque alguien puede leerlo como
  «apareció un archivo en `app/` que nadie usa».

**Qué se verificó.**

- `npx tsc --noEmit`: **limpio, 0 bytes de salida**, dos veces.
- `npm test`: **`Test Files 97 passed | 3 skipped (100)`**, **`Tests 1208 passed |
  46 skipped (1254)`**, 0 fallos, **tres corridas idénticas** con semillas
  distintas de fast-check. Contra el baseline de 86 archivos / 1041 tests: los dos
  mayores. Ese baseline se midió en `e3e7e8b` y sigue comparable: los dos commits
  del medio (`ee804e4` del funnel LATAM y `8e07ff8` de la timezone y el allowlist)
  no tocaron ningún archivo de test — `git diff --stat e3e7e8b..HEAD -- '*.test.ts'
  '*.test.tsx'` sale vacío — así que todo el delta es de este spec.
- **La base estaba viva antes de correr**: `pg_isready` en `127.0.0.1:5433`
  aceptando conexiones, y `lib/queries/finance.test.ts` (8 tests) pasó en 341 ms,
  que es justo el archivo que se disfraza cuando Postgres está caído. **0 matches
  de `ECONNREFUSED` y 0 de `createScheduledPayment`.**
- `lib/monto.test.ts`: `shasum -a 1` da `ed58dc53c9fd77909eb7934c754c8a5ed8b617a2`
  y `git diff -M HEAD --stat` lo muestra como rename puro con **0 líneas**
  (`{app/(panel)/finanzas => lib}/monto.test.ts | 0`). Sus 12 tests pasan desde
  `lib/`.
- **La guarda de la paleta, provocada a mano**: con `hover:text-good-100` puesta a
  propósito rompe con un array de **exactamente un elemento**
  (`ChipCascada.tsx:53 → hover:text-good-100: la escala "good" no define el tono
  "100" (tiene: 200, 300, 400, 500, 600)`); restaurada, pasa 2/2.
- **El CSS compilado**: `.hover\:text-good-200:hover` aparece en la línea 3082 con
  cuerpo real, y `text-good-100` da **0 matches en cualquier forma**.
- `npm run ads:auditar-montos`: corre, imprime, **sale con 0**, y se verificó con
  `md5` de `ad_rules` y `ad_rule_conditions` antes y después que **no modificó
  ninguna fila**.
- **Qué quedó SIN verificar:** nada se probó a mano contra la cuenta real de Meta;
  el badge de Reglas no se vio renderizado en el browser (su lógica sí está
  testeada sin render); y la conversión `Math.round(eur * 100)` de
  `preparar`/`aplicarPresupuesto` se verificó **por equivalencia y no por import**,
  porque las dos funciones son privadas y llegar a ellas pide base y red.

**Un quirk previo que conviene dejar anotado:** los 46 tests salteados son de
`lib/ingest/apply.test.ts` (21), `lib/queries/sales.test.ts` (17) y
`lib/day.test.ts` (8). Saltean porque no cargan `.env` con `process.loadEnvFile`,
que sí tienen los otros tests de integración; sus `describe.skipIf` quedan
condicionados a una base que nunca ven. Es previo a este spec y está fuera de
alcance, pero son 46 tests que no corren y nadie lo dice en ningún lado.

**Dónde quedó cada cosa, y qué no se toca.** La lista de archivos la da `git show
0e151e0 --stat`; acá va sólo lo que el nombre del archivo no dice.

- **`lib/monto.ts`** es el núcleo compartido (`leerNumeroEscrito`) más la política
  de Finanzas (`parsearMonto`). Es el módulo que las tres pantallas comparten.
- **`lib/test/preservacion-montos.ts` no entra al bundle**: sólo lo importan tests.
  Tiene la Bug_Condition, las siete familias de excepción como siete regex
  nombradas, y los generadores. Está en un solo archivo a propósito: dos copias del
  predicado se ensancharían por separado, que es el mismo error que este spec
  arregló una escala más arriba.
- **`lib/ads/presupuesto.preservacion.test.ts` y
  `app/(panel)/anuncios/reglas/numeroDeCampo.preservacion.test.ts` tienen los dos
  parseos viejos copiados adentro a propósito**: son los oráculos de la
  refactorización y **no se actualizan nunca**. Si el arreglo los hace fallar, lo
  que se discute es el arreglo, no el oráculo. Cada uno lleva además una tabla de
  flips que exige que cada familia demuestre su cambio con los dos veredictos, y
  eso es lo que impide ensanchar el predicado para tapar un flip nuevo.
- **`app/(panel)/anuncios/montoAmbiguo.test.ts` se escribió para fallar** contra el
  código sin arreglar (9/9 en rojo), y es el que confirmó que la causa era la
  hipotetizada. Cruza el presupuesto y Reglas a propósito: es lo que hace de esto
  un bug y no cuatro.
- **`lib/ads/reglas/sospecha.ts`** es el predicado y los umbrales de los valores ya
  guardados. **Puro, sin `pg`**, porque lo importan un script de Node y un
  componente cliente. El umbral vive ahí y no en el SQL del script justamente para
  que los dos no puedan discrepar.
- **`scripts/verificar-montos-reglas.ts`** es el reporte de sólo lectura: que no
  haya una sola sentencia de escritura en el archivo es el contrato, no una
  promesa.
- **`lib/paleta.test.ts`** tiene su límite declarado adentro: sólo ve clases
  escritas completas, y una armada por interpolación le es invisible igual que al
  JIT de Tailwind.
- **`app/(panel)/anuncios/reglas/_formBase.ts`** (el fixture que se anota entre los
  pendientes de arriba) está en `app/` y no en `lib/test/` porque `FormEstado` es
  un tipo de esa pantalla.

Si este cambio llegara a causar una caída de deploy va también en
`COMO-DEPLOYAR.md` §«Cosas que ya pasaron y no conviene repetir». Hoy no aplica.

---

## 2026-08-24 — El revert de `/anuncios/reglas` era del IDE, no una decisión

Cierra el pendiente que dejó la entrada de abajo ("quedó sin commitear, intacto,
para que el dueño del cambio decida"). **Sin commit: el working tree volvió a
coincidir con HEAD, así que el repo no cambió.**

**Qué pasaba.** Los cuatro archivos de reglas parecían un revert deliberado de
cuatro features ya commiteadas. No lo era: fue el IDE deshaciendo las ediciones
de la sesión que había creado `d26cc05` (el menú de 3 puntos y el import/export
de CSV). Deshacer esas ediciones devolvió `ReglasView.tsx` a su contenido
*anterior*, que es el snapshot de `574510d`, y borró del disco los dos archivos
que esa sesión había **creado** — deshacer una creación es borrarla. El efecto
colateral, y el motivo de que pareciera intencional, es que el snapshot es
anterior a TODO: se llevó de paso los otros tres commits de reglas que vinieron
después (`224eefe`, `ab8a96d`, `b54a727`, `8396c63`).

La prueba de que era una copia vieja y no una decisión, para que nadie tenga que
repetir el diff de 1500 líneas:

- `ReglasView.tsx` en disco (1154 líneas) era **byte-idéntico** a
  `574510d:app/(panel)/anuncios/reglas/ReglasView.tsx`. Cero líneas propias.
- `utmify.ts` en disco (821 líneas) era **byte-idéntico** a
  `d26cc05:lib/ads/reglas/utmify.ts`, o sea la versión original sin las 12
  líneas de `motivoIncoherente` que se le agregaron después.

**Por qué se resolvió así.** `git checkout HEAD --` sobre los cuatro archivos, y
no rescatar nada del disco. La entrada de abajo dudaba en hacerlo porque "borra
trabajo sin commitear": esa premisa era falsa y los dos `diff` de arriba lo
demuestran — el disco era estrictamente más viejo que HEAD, byte por byte, así
que no había nada que rescatar. La alternativa (rehacer a mano las validaciones
sobre la copia vieja) habría reescrito código que ya estaba commiteado y
deployado.

Los dos scripts temporales de esa sesión (`scripts/tmp-cookie.ts`,
`scripts/tmp-roundtrip.ts`) se borraron. Servían para generar una cookie de
sesión y comprobar el round-trip del CSV a mano; nunca fueron para el repo y el
revert los había traído de vuelta.

**Qué se verificó.** `_nombres.test.ts` era el único test que fallaba y ahora
pasa: el error era `the given combination of arguments (null and string) is
invalid for this assertion` en la línea de la ventana horaria, o sea el test de
HEAD corriendo contra el `problema()` viejo que devolvía `null`. Después:
`npm run build` limpio con typecheck, y `npm test` completo en **1041 tests, 86
archivos, 0 fallos**.

Detalle que casi mandó al tacho la verificación: la primera corrida daba **79
tests fallando**, y no tenía nada que ver con esto. Colima estaba apagado
(máquina reiniciada) y Postgres no atendía: `connect ECONNREFUSED
127.0.0.1:5433` disfrazado de errores de `createScheduledPayment` en
`lib/queries/finance.ts:482`. Con la base arriba, verde. Si una corrida falla en
masa y los errores apuntan a queries, mirar primero si la base está viva.

---

## 2026-08-24 — Auditoría de Finanzas, logout y el rediseño

Sesión larga con tres cosas distintas. Se reporta como una sola porque las tres
salieron del mismo pedido ("finanzas no funciona") y se deployaron juntas.

### `d97dc05` Finanzas: el monto que se tipea, el PATCH y los pagos silenciosos

**Qué pasaba.** El botón "Cargar" de un movimiento no se habilitaba nunca. El
monto se parseaba con `Number()` crudo y en español la coma es el separador
decimal: `Number("100,50")` es `NaN`, así que el botón quedaba gris sin decir
por qué. La otra mitad del síntoma: la fecha arrancaba vacía y también
bloqueaba el botón, en silencio.

El caso espejo era peor porque no fallaba, mentía: `Number("1.000")` es `1`.
Guardaba un euro donde el usuario quiso mil y el patrimonio quedaba mal sin que
nada avisara.

**Por qué se resolvió así.** El parseo vive en
`app/(panel)/finanzas/monto.ts` con tests, y cuando la entrada es ambigua de
verdad **no elige**: `"1.000"` puede ser mil o uno-con-tres-decimales y no hay
forma de saberlo, así que devuelve un error que se muestra. La alternativa
(elegir la lectura más probable) es la que ya había fallado. Regla que quedó:
un campo de plata no adivina.

Los montos con más de 2 decimales también se rechazan, porque `numeric(14,2)`
los redondearía sin avisar.

El botón ya no se deshabilita por validación, sólo mientras hay un pedido en
vuelo, y al lado dice qué falta. Un botón gris sin motivo es un callejón sin
salida y era exactamente el síntoma reportado.

**El PATCH de movimientos tenía cuatro bugs, ninguno con test:**

| Qué | Por qué pasaba |
|---|---|
| Un ajuste negativo era imposible de editar (400 siempre) | El route validaba el monto con `kind=undefined`, caía en la rama de gasto/retiro y exigía positivo |
| Editar sólo la nota o la fecha daba 500 | Sin monto, `String(undefined)` llegaba a `amount_eur = $3::numeric` → 22P02 |
| Ponerle categoría a un retiro daba 500 con el nombre del constraint | El POST validaba la combinación kind/category, el PATCH no |
| Cambiar el Tipo se descartaba en silencio y decía "actualizado" | `kind` no estaba en `patchSchema` y `z.object` no es estricto |

El `UPDATE` dejó de usar `COALESCE` y resuelve los valores finales en JS contra
la fila que existe. Con `COALESCE($2, category)` era **imposible borrar la
categoría**: mandar `null` y no mandar nada eran lo mismo para la base.

Al cambiar el tipo, el signo se recalcula contra el kind final. Un ajuste de
+300 que pasa a gasto queda en −300: si no, un gasto sumaría al patrimonio.

**Los pagos programados tenían un `catch {}` vacío.** Un pago que fallaba no
generaba su gasto, seguía marcado como atrasado, y la respuesta era idéntica a
"no había nada que hacer": la pantalla mostraba un cartel **verde** que decía
"No hay pagos atrasados para ejecutar". Un gasto que falta en el patrimonio y
nadie ve es el peor resultado posible de este módulo. Ahora
`runScheduledPayments` devuelve `fallidos` con el motivo, la UI los muestra en
rojo y el cron los escribe en stderr con exit code 1.

**Los errores del backend no se leían.** El helper `api()` tomaba `body.error`
(el código estable) en vez de `body.detail` (el mensaje en castellano), así que
el banner rojo mostraba literalmente `invalid_payload` y todo el trabajo de
traducir los CHECK a español se perdía en esa línea.

**De paso:** la condición de "atrasado" estaba escrita en tres lugares y quedó
en uno (`COND_ATRASADO`) — tres copias de una regla de negocio son tres
oportunidades de que una quede vieja. `listScheduledPayments` pasó de `1+2N`
queries a 3 fijas. `tsconfig.json` declara `target: es2022`: sin él `tsc`
asumía ES5 y rechazaba el top-level await de los tests de finanzas (TS1378),
error que `next build` no mostraba y el editor sí.

### `b726342` Logout: el redirect va al dominio, no a localhost:3000

**Qué pasaba.** Al vencerse la sesión (12 h) o al apretar Salir, producción
mandaba al usuario a `http://localhost:3000/`. Ni siquiera es una dirección que
exista en la VPS: el proceso escucha en `127.0.0.1:3005`.

**Por qué.** El redirect se armaba con `new URL('/', req.url)`. En el build
standalone detrás de Caddy, `req.url` lo arma Next con la dirección donde
escucha el proceso, no con el Host que pidió el browser.

**Por qué el orden que quedó.** `urlDeLogin()` resuelve por
`NEXT_PUBLIC_SITE_URL` → `x-forwarded-host`/`x-forwarded-proto` → `req.nextUrl`.
La env var va **primero** porque es la única que no depende de headers que
puede escribir el cliente: si los headers fueran primero, cualquiera que llegue
sin pasar por el proxy podría decidir a dónde redirige el panel. Ya era
obligatoria en el guard de `deploy.sh` (§6) aunque el código no la leía en
ningún lado.

### `7e863c8` Anuncios: los fixtures de los tests llevan syncedAt y desaparecidoAt

La 025 (frescura de la jerarquía) agregó los dos campos a `MetricasObjeto` y los
constructores de filas de los tests del motor, el ejecutor y la explicación
quedaron sin ellos: 4 errores de `tsc` (3 TS2322 + 1 TS2741). `next build` no
los mostraba porque inyecta su propio typecheck, así que sólo se veían en el
editor. Los tests pasaban igual: el valor no participa de ninguna aserción.

### `fff55da` Rediseño "vidrio líquido"

Estaba sin commitear en el working tree. Se revisó, se verificó (tsc limpio,
1041/1041, build OK) y se mandó.

El cambio se concentra en `tailwind.config.ts` y `app/globals.css`, que son la
palanca: los call sites piden tokens semánticos (`surface`, `canvas`,
`border-subtle`) y no colores, así que la paleta se cambia en un archivo. Un
acento en lugar de dos, superficies en escala con luz consistente, y siete
clases en `@layer components` que no se pueden expresar como utilidades
(`.glass`, `.glass-bar`, `.sheen`, `.press`, `.aurora`, `.grain`, `.reveal`),
todas apagadas por `prefers-reduced-motion`.

`PanelLogo` salió de `Nav.tsx` a su propio componente porque el login también lo
usa y no tiene nav.

**Chequeo extra que se hizo y conviene repetir:** un token de Tailwind que falta
**no rompe el build**, deja el elemento sin estilo y nadie se entera. Se
verificó que ningún `shadow-*` ni token de color referenciado en el markup
quedara sin definir en el config.

### `674dd6e` y `dcdaae6` Dos consecuencias del rediseño

- El tooltip del gráfico de Finanzas volvió a `shadow-float`. Había quedado en
  `shadow-xl` porque cuando entró el arreglo de Finanzas el `tailwind.config`
  todavía no estaba commiteado y la clase habría quedado sin definir.
- `app/icon.svg` se sirve en `/icon.svg` y el matcher del middleware sólo
  excluía `favicon.ico`, así que sin cookie devolvía 307 y el ícono no cargaba
  **en el login**, la única pantalla donde se ve estando deslogueado. Se
  encontró verificando el deploy con `curl`, no en el build.

### Lo que se decidió NO mandar, y por qué

En el working tree había también cambios en `/anuncios/reglas` que **no** son
una mejora: son un revert de cuatro features ya commiteadas
(`8396c63`, `b54a727`, `224eefe`, `d26cc05`). `ReglasView.tsx` pasaba de 2406 a
1154 líneas.

Lo que se perdía no era decorativo: el nombre obligatorio, el chequeo de nombre
duplicado por cuenta (el UNIQUE de la 021), la validación de la ventana horaria,
y `numeroDeTexto` — que es **el mismo bug del monto que se acababa de arreglar
en Finanzas**, reintroducido en el módulo que pausa campañas y cambia
presupuestos. El comentario que se borraba lo decía: `Number('')` es cero, y con
el campo vacío la condición se guardaba como `> 0`, que para una regla de pausar
significa *pausá todo*.

`lib/ads/reglas/utmify.ts` también sacaba la validación de coherencia del import
de CSV, y `app/api/ads/reglas/csv/route.ts` + `lib/ads/reglas/utmify.test.ts`
estaban borrados del disco dejando `utmify.ts` como 34 KB de código muerto sin
test y sin llamadores.

Objetivamente tampoco se podía deployar: rompía `_nombres.test.ts` y
`deploy.sh` corre `npm test` y aborta.

**Este archivo existe por esto.** El working tree tenía tres cosas mezcladas
—un rediseño hacia adelante, un revert hacia atrás y scripts temporales— y no
había forma de saber cuál era intencional. Se separó a mano leyendo diffs y
comparando contra `git log`. Si cada cambio hubiera estado registrado, la
pregunta "¿esto se sacó a propósito?" se contestaba leyendo.

En la misma sesión se creó este archivo y `.kiro/steering/registro.md`, que hace
obligatorio anotar acá cada cambio con su motivo. Esta primera entrada está
escrita hacia atrás, sobre lo que ya se había hecho; de acá en adelante se
escribe en la misma tanda que el cambio.

Quedó sin commitear, intacto, para que el dueño del cambio decida:

```
 M app/(panel)/anuncios/reglas/ReglasView.tsx
 D app/api/ads/reglas/csv/route.ts
 D lib/ads/reglas/utmify.test.ts
 M lib/ads/reglas/utmify.ts
```

**Verificación de toda la sesión:** los bugs se reprodujeron primero contra un
Postgres real ejecutando los handlers de los routes (no leyendo el código), y
después se volvió a correr cada caso con el arreglo puesto. Antes de pushear se
armó un worktree en `main` limpio con sólo los archivos a commitear, para
confirmar que el commit se sostiene solo y no depende de otro cambio suelto del
working tree. Producción quedó verificada con `curl`: `/` en 200, `/icon.svg` en
200, las rutas protegidas en 307 y el redirect apuntando a
`https://panel.hilvanapp.com/`.
