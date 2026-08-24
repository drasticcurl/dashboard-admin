# Registro de cambios

Qué se cambió, cuándo, y **por qué**. El "por qué" es el motivo por el que este
archivo existe: el commit dice qué se tocó, esto dice qué problema había y qué
decisiones se descartaron. Un `git log` contesta "qué cambió"; esto contesta
"por qué alguien tocó esto y qué pasa si lo vuelvo atrás".

Lo más nuevo va arriba. Las reglas de cómo se escribe una entrada están en
`.kiro/steering/registro.md`.

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
