# Registro de cambios

Qué se cambió, cuándo, y **por qué**. El "por qué" es el motivo por el que este
archivo existe: el commit dice qué se tocó, esto dice qué problema había y qué
decisiones se descartaron. Un `git log` contesta "qué cambió"; esto contesta
"por qué alguien tocó esto y qué pasa si lo vuelvo atrás".

Lo más nuevo va arriba. Las reglas de cómo se escribe una entrada están en
`.kiro/steering/registro.md`.

---

## 2026-08-26 — Un solo parseo de plata: `1.000` no era mil en ninguno de los cuatro campos

Spec `parseo-montos-anuncios`. Todavía **sin commitear**: el trabajo está sobre
`8e07ff8`, que es HEAD hoy.

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
