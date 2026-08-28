# Prompts para Claude Code — Saldo por cuentas

## Antes de arrancar

```
tasks/saldo-cuentas/
├── 00-PLAN-SALDO.md            el documento maestro — leerlo primero, siempre
├── PROMPT-CLAUDE-CODE.md       este archivo
├── PROMPT-OPENCODE.md          la versión para opencode run
├── _schema-028.sql             el DDL canónico, YA CORRIDO 2 veces (T01 lo copia tal cual)
├── _verificacion-028.sql       19 afirmaciones, YA EN VERDE contra una base scratch
├── T01-fundacion-saldo.md      migración + lib/queries/saldo.ts — VA SOLA Y PRIMERO
├── T02-finance-patrimonio.md   lib/queries/finance.ts: el patrimonio cambia de fuente
├── T03-api-saldo.md            routes de cuentas, saldos, y aporte en movimientos
├── T04-componentes-ui.md       gráfico + carga diaria + cuentas (3 componentes nuevos)
├── T05-limpieza-deploy.md      borrar el rollup de profit, el cron, el runbook
└── T06-ensamblado.md           page.tsx + FinanzasView.tsx + e2e — VA SOLA Y AL FINAL
```

**Lo que ya está verificado, y por qué eso ahorra trabajo.** `_schema-028.sql` corrió dos veces
contra una base scratch con las migraciones 001-027 aplicadas (idempotencia confirmada), y las 19
afirmaciones de `_verificacion-028.sql` dieron el resultado documentado al lado de cada bloque:

- los 4 `CHECK` (saldo negativo, kind inventado, nombre duplicado con otra capitalización, vigencia
  imposible);
- **el patrimonio de un día con el signo puesto por el tipo de cuenta**, y el mismo día con una
  cuenta faltante devolviendo `null` en vez de un total parcial;
- que **abrir una cuenta nueva no convierte en incompletos los días anteriores** (es el bug que haría
  desaparecer el gráfico entero);
- que una cuenta cerrada deja de pedirse y conserva su historial;
- **el cierre de cada mes tomando el último día COMPLETO**, no el último con datos;
- **la fórmula de la ganancia mensual**, en dos escenarios: con retiro (Δ 300 + retiro 2000 → 2300) y
  con retiro y aporte (Δ 3500 − retiro 200 − aporte 3000 → **700**);
- el corte de día y de mes por zona horaria, con un timestamp concreto;
- que reemplazar los 3 `CHECK` de `finance_movements` **sobre una tabla con filas** no pierde ninguna.

Ninguna task tiene que redescubrir estas reglas: sólo implementarlas.

**Y una corrección de la fase 3 que conviene saber:** los valores esperados de las afirmaciones 7, 10
y 11 estaban MAL en la primera escritura del archivo (sumé a mano y me comí el signo de la deuda). La
query estaba bien. Se corrigieron contra la salida real y quedó anotado dentro del propio archivo. Si
no se hubiera corrido, las tasks habrían llevado "esperado 3400" y un agente habría salido a cazar un
bug que no existe.

### 6 cosas que hay que saber antes de largar el primer agente

**1. Esto NO es un módulo nuevo: es cambiarle el corazón a uno que está en producción.** `/finanzas`
ya funciona. El patrimonio hoy se calcula solo y pasa a medirse a mano. Cinco de las seis tasks
modifican o borran código que hoy corre.

**2. No hay ninguna sincronización de saldo con cuentas publicitarias que sacar.** Se buscó en todo
el repo: cero código. Lo que hay es `finance_daily_profit` calculándose desde `daily_metrics`, que
incluye el `ad_spend_eur` que baja `scripts/sync-ads.ts` de Meta. **Ningún agente toca `lib/ads/**`.**
Si un agente empieza a buscar cómo leer el saldo de Meta, se desvió.

**3. El bug más caro del módulo es un día a medio cargar que se muestre como si estuviera completo.**
Un total al que le falta una cuenta no es un número que falta: es un número equivocado que se ve
igual de bien que uno correcto. La defensa es el tipo (`totalEur: number | null`) y está en el
contrato: **ningún agente puede escribir `?? 0` sobre ese valor.** Si un componente necesita un
número para dibujar, no dibuja.

**4. El segundo bug más caro es que un aporte de capital se cuente como ganancia.** La ganancia
mensual es `Δ patrimonio − retiros − aportes`. Sin el término de aportes, el mes en que el usuario
transfiere 3.000 propios el gráfico dice que el negocio ganó 3.000 que nadie ganó — y es el mes en
que más lo va a mirar. Está verificado (`#19` → 700, no 3700) y tiene un test obligatorio.

**5. La migración 028 tiene el único statement destructivo del módulo: un `DROP TABLE`.** Borra
`finance_daily_profit`, que es 100 % derivada de `daily_metrics` y por eso se puede borrar. **Antes de
correrla en producción hay un paso obligatorio del runbook** (exportar a CSV y guardar el patrimonio
viejo): no porque el dato sea irrecuperable, sino porque es lo único que va a explicar el salto que el
usuario ve en pantalla. Contra tu base LOCAL, aplicala sin problema.

**6. El plan es el contrato.** `00-PLAN-SALDO.md`, en especial §1 (decisiones cerradas), §4 (el
contrato congelado) y §8 (ownership), no lo modifica ningún agente. Lo que no cierra va a §10.

**7. Tres cosas del repo cambiaron DESPUÉS de que se escribió la primera versión de este plan**, y
las tres están ya corregidas acá adentro. Se listan porque un agente que haya leído una versión vieja
de algún archivo se va a confundir:

- **La migración es la 028, no la 027.** La 027 se la llevó `027_experimento_upsell.sql` (commit
  `5542221`, del Pitch A/B), que ya está aplicada en producción. Dos archivos con el mismo número
  funcionan por accidente (`scripts/migrate.ts` ordena alfabéticamente) pero rompen la convención.
- **`app/(panel)/finanzas/monto.ts` NO EXISTE.** El parseo de plata se consolidó en `lib/monto.ts`
  (commit `0e151e0`) y se le extrajo `leerNumeroEscrito`, el núcleo sin política. **Y `parsearMonto`
  rechaza el cero**, así que no sirve tal cual para un saldo: T04 escribe `parsearSaldo` encima del
  núcleo. Si un agente usa `parsearMonto` para los saldos, una cuenta vacía queda imposible de cargar
  y por D5 ese día nunca puede estar completo.
- **Existe `lib/paleta.test.ts`**, una guarda nueva que valida cada clase de color literal contra
  `tailwind.config.ts`. T04 escribe clases nuevas y tiene que correrla: un tono que la paleta no
  define no rompe la build, no emite CSS, y sin este test nadie se enteraría.

## El orden

```
Paso 1   T01                            1 agente, SOLO
Paso 2   T02 · T03 · T04 · T05          4 en paralelo
Paso 3   T06                            1 agente, SOLO
```

**T01 no está terminada hasta que sus tests pasen Y las 19 afirmaciones de `_verificacion-028.sql`
den lo documentado.** El paso 2 no arranca antes: las cuatro importan tipos y funciones que sólo
existen después de T01.

**Por qué las cuatro del paso 2 no se pisan:** ninguna escribe un archivo de otra (§8 del plan) y
ninguna importa un archivo que otra de la misma ola vaya a crear. T04 escribe tres componentes que
**nadie monta hasta T06** — quedan sin llamadores a propósito, y es lo que permite escribir la
pantalla y sus piezas al mismo tiempo. `npm run build` los compila igual: Next no exige que un
componente esté importado.

**T06 va sola al final** porque es la única que ve el módulo entero funcionando, y la única que puede
detectar que dos piezas no encajan. Si encuentra que no encajan, **para y avisa** en vez de adaptar
con un `as any`.

**Si preferís ir de a uno:** T01 → T02 → T03 → T04 → T05 → T06.

---

## Paso 1 — T01, sola

```
Este repo es un dashboard de Next.js 14 (App Router) + Postgres crudo (sin ORM, `pg` con SQL
parametrizado) para un negocio de funnels de venta. Está EN PRODUCCIÓN (panel.hilvanapp.com) y la
sección /finanzas que vas a modificar YA FUNCIONA con datos reales. Vas a trabajar contra la base
LOCAL de desarrollo (Docker, contenedor `panel-db-1`, usuario y base `panel`).

Leé estos archivos COMPLETOS antes de escribir código, en este orden:
1. tasks/saldo-cuentas/00-PLAN-SALDO.md
2. tasks/saldo-cuentas/T01-fundacion-saldo.md
3. lib/queries/finance.ts  (el módulo que ya existe: de ahí copiás los patrones)

Contexto de por qué existe este cambio: hoy el patrimonio de /finanzas se calcula solo desde
daily_metrics, que incluye el gasto que reporta Meta. El usuario quiere medirlo a mano: carga una vez
al día cuánto saldo hay en cada cuenta (dos cuentas de dinero, una de saldo retenido, una de deuda
con Meta) y el patrimonio es la suma con el signo de cada tipo.

Reglas que no se negocian:
- Solo escribís los archivos de tu fila en el §8 del plan: db/migrations/028_saldo_cuentas.sql,
  lib/queries/saldo.ts, lib/queries/saldo.test.ts. Nada más. NO tocás lib/queries/finance.ts (es de
  T02) ni ningún route ni ninguna pantalla.
- Hay una lista de archivos que NADIE toca (§8): lib/db.ts, lib/day.ts, lib/queries/overview.ts,
  lib/queries/sales.ts, lib/ads/**, scripts/rollup.ts, scripts/sync-ads.ts,
  scripts/finance-scheduled-payments.ts, app/(panel)/finanzas/monto.ts, components/ui.tsx,
  components/Nav.tsx, y las migraciones 001 a 027.
- El esquema de tasks/saldo-cuentas/_schema-028.sql NO se retipea: ya corrió dos veces contra una
  base scratch y las 19 afirmaciones de _verificacion-028.sql dieron el resultado documentado.
  Copialo TAL CUAL como db/migrations/028_saldo_cuentas.sql.
- El contrato del §4 del plan (los tipos y firmas de lib/queries/saldo.ts) se copia exacto. T02, T03,
  T04 y T06 se escriben contra esa forma en paralelo con vos: si le cambiás un nombre de campo, las
  cuatro se rompen.
- Si aparece una decisión que el plan no resuelve, no la decidís en el código: la agregás al §10 del
  plan y seguís si no bloquea, o parás si bloquea.
- Todo el SQL con parámetros ($1, $2), nunca concatenación de strings.
- Código, comentarios y mensajes de usuario en español, como el resto del repo.

Tu tarea: implementar T01 completa — la migración, lib/queries/saldo.ts con las firmas exactas del §4
del plan, y los tests de la sección 4 de tu propio archivo de task.

Atención especial:
- Un día cuenta SÓLO si tiene saldo para TODAS las cuentas vigentes ese día. Si falta una, totalEur
  es null, NUNCA un total parcial y NUNCA 0. Es el test 2 de tu task y es el módulo entero.
- La vigencia (opened_on / closed_on) participa de la aritmética: sin opened_on, crear una cuenta
  nueva deja incompletos todos los días anteriores y el gráfico entero desaparece. Es el test 3.
- La ganancia mensual es Δ patrimonio − retiros − aportes. Los retiros están guardados negativos y
  los aportes positivos, por eso la fórmula RESTA los dos. Es el test 4, con los números ya
  verificados: Δ 3500 − (−200) − 3000 = 700.
- El día de hoy se resuelve en DASHBOARD_TZ con una query a Postgres, no con Date de JS. Copiá
  hoyEnTz() de lib/queries/finance.ts, no inventes otra.

Al terminar, corré la sección "5. Verificación" de T01-fundacion-saldo.md COMPLETA y mostrame la
salida REAL de cada paso, en particular las 19 afirmaciones de _verificacion-028.sql. Si alguna de
las afirmaciones 7, 8, 11, 17 o 19 da distinto de lo documentado, PARÁ y decímelo en vez de ajustar
el test para que pase. "Compila" no es verificación.
```

**No sigas al paso 2 hasta que la verificación completa de T01 haya dado el resultado documentado.**

---

## Paso 2 — T02, T03, T04 y T05, en paralelo

Cuatro sesiones independientes. Ninguna escribe en el archivo de otra (§8 del plan).

**El preámbulo es el mismo para las cuatro** (cambia sólo el bloque final):

```
Este repo es un dashboard de Next.js 14 (App Router) + Postgres crudo (sin ORM) para un negocio de
funnels de venta. Está EN PRODUCCIÓN y la sección /finanzas que vas a modificar YA FUNCIONA con datos
reales. Trabajás contra la base LOCAL de desarrollo.

T01 ya escribió db/migrations/028_saldo_cuentas.sql y lib/queries/saldo.ts con el contrato del §4 del
plan. Leelo antes de escribir: es tu fuente de verdad y no lo modificás.

Leé estos archivos COMPLETOS antes de escribir código, en este orden:
1. tasks/saldo-cuentas/00-PLAN-SALDO.md
2. tasks/saldo-cuentas/<TU-TASK>.md
3. lib/queries/saldo.ts

Contexto: el patrimonio de /finanzas pasó de calcularse solo (desde daily_metrics, que incluye el
gasto de Meta) a medirse a mano — el usuario carga una vez al día el saldo de cada cuenta. NO hay
ninguna sincronización con cuentas publicitarias, ni la había: si te encontrás buscando cómo leer el
saldo de Meta, te desviaste. lib/ads/** no se toca.

Reglas que no se negocian:
- Solo escribís los archivos de tu fila en el §8 del plan. Nada más, aunque te parezca que a un
  archivo ajeno le falta algo: eso va al §10 del plan.
- Hay tres agentes más trabajando en paralelo con vos, en otros archivos. No "arregles" un error de
  tipos en un archivo que no es tuyo, incluso si el build se queja: el §7 de tu task dice cuáles son
  esperados y de quién son.
- El valor `totalEur` de un día incompleto es null, y NUNCA se convierte en 0 con `?? 0`. Es la
  defensa central del módulo.
- Todo el SQL con parámetros, nunca concatenación. Código, comentarios y textos de UI en español.
- Si aparece una decisión que el plan no resuelve, se anota en el §10 del plan, no se decide en el
  código.
```

Y el cierre de cada una:

**T02** — `Tu tarea: implementar T02 completa. Atención especial: patrimonioTotalEur pasa de number a
number | null a propósito, y el null tiene que llegar hasta la pantalla sin convertirse en 0 en el
camino. Los tests viejos que asumen el patrimonio-suma van a fallar: reescribilos, no los borres. Los
tests de pagos programados tienen que seguir pasando SIN modificar. Al terminar, corré la sección 6
de tu task y pegá la salida real.`

**T03** — `Tu tarea: implementar T03 completa. Atención especial: POST /api/finanzas/saldos recibe el
día y TODAS las cuentas de una vez, no una por llamada, porque es una transacción. amountEur null
BORRA el saldo y es distinto de 0. Un nombre de cuenta duplicado en otra capitalización sale 400 con
mensaje legible, no 500 con el SQLSTATE. Al terminar, corré la sección 7 de tu task incluido el curl
de round-trip, y pegá la salida real.`

**T04** — `Tu tarea: implementar T04 completa — los 3 componentes y las funciones puras. Atención
especial: connectNulls PRENDIDO (sin eso, un mes con dos cargas aisladas no dibuja nada), dot visible,
domain auto en el eje Y, y un punto sin dato dice "sin información", nunca 0. Los tres componentes no
los importa nadie todavía: T06 los monta, y cada archivo abre con un comentario que lo dice. En este
repo no hay jsdom, así que NO podés testear componentes: al terminar decí explícitamente qué queda
pendiente de revisión visual, no lo declares verificado.`

**T05** — `Tu tarea: implementar T05 completa. Atención especial: borrás scripts/finance-rollup.ts y
su entrada de npm, pero scripts/finance-scheduled-payments.ts y finance:pagos SE QUEDAN — son los
pagos programados y siguen corriendo. Confundirlos apagaría los alquileres automáticos sin que nadie
lo note. El runbook tiene que incluir el export a CSV antes de migrar y el orden del deploy (crontab
antes que migración, no al revés). Al terminar, corré la sección 5 de tu task y pegá la salida real.`

**No sigas al paso 3 hasta que las cuatro hayan corrido su verificación.**

---

## Paso 3 — T06, sola, al final

```
Este repo es un dashboard de Next.js 14 (App Router) + Postgres crudo, EN PRODUCCIÓN. Sos la última
task de un módulo que escribieron 5 agentes antes que vos.

Leé estos archivos COMPLETOS antes de escribir código, en este orden:
1. tasks/saldo-cuentas/00-PLAN-SALDO.md
2. tasks/saldo-cuentas/T06-ensamblado.md
3. lib/queries/saldo.ts, lib/queries/finance.ts (T01 y T02)
4. app/(panel)/finanzas/GraficoSaldo.tsx, CargaDiaria.tsx, CuentasSection.tsx (T04)
5. .kiro/steering/registro.md  (las reglas de cómo se escribe la entrada de registro.md)

Reglas que no se negocian:
- Solo escribís: app/(panel)/finanzas/page.tsx, app/(panel)/finanzas/FinanzasView.tsx, registro.md
  (agregar la entrada arriba), y tasks/saldo-cuentas/_verificacion-e2e.sh (crear). Nada más.
- Sos la única que ve el módulo entero funcionando. Si dos piezas no encajan (lo que T02 devuelve y
  lo que T04 espera, por ejemplo), PARÁ Y DECÍMELO. No lo adaptes con un `as any` ni con un mapeo
  silencioso: es una diferencia entre dos tasks y hay que decidirla, no taparla.
- patrimonioTotalEur puede ser null y la card dice "sin información", nunca 0.
- Código, comentarios y textos de UI en español.

Tu tarea: implementar T06 completa — page.tsx, FinanzasView.tsx (borrando el BarChart de "Evolución
mensual" y montando los 3 componentes de T04), el script _verificacion-e2e.sh, y la entrada de
registro.md.

Atención especial:
- mesActual sale de overview.hoy (que el server resolvió en DASHBOARD_TZ), no de new Date(): el 31 a
  la noche, la TZ del browser devuelve el mes siguiente y el gráfico diario aparecería vacío.
- La entrada de registro.md tiene 4 cosas que no pueden faltar, listadas en la sección 6 de tu task.
  La más importante: que NO había ninguna sincronización con cuentas publicitarias que sacar, porque
  el próximo que lea el pedido original va a salir a buscar un fetch a Graph API que nunca existió.
- El e2e tiene que probar que cargar un aporte NO sube la ganancia del mes. Es el bug que el kind
  `aporte` existe para evitar.

Al terminar: corré la sección 7 de tu task completa (tsc, npm test, npm run build, el e2e y los tres
greps) y pegá la salida REAL. La revisión visual en el browser la hago yo: dejame la lista de qué
mirar y decí que queda pendiente, no la declares hecha.
```

## Qué revisar cuando terminan las seis

```bash
# 1 — la suite completa y el build
npm test && npm run build

# 2 — que no quedó nada del módulo viejo
grep -rn "finance_daily_profit\|finance-rollup\|byMonth\|MonthlyPoint" \
  --include="*.ts" --include="*.tsx" --include="*.json" lib/ app/ scripts/ deploy/ package.json
# esperado: ninguna línea

# 3 — que nadie tapó el null del patrimonio
grep -rn "patrimonioTotalEur ?? 0\|totalEur ?? 0\|totalEur || 0" lib/ app/
# esperado: ninguna línea. Si aparece una, el módulo puede mostrar 0 donde no hay dato.

# 4 — que nadie tocó las cuentas publicitarias
git diff --stat main -- lib/ads/ scripts/sync-ads.ts
# esperado: sin cambios

# 5 — que los pagos programados siguen vivos
grep finance deploy/cron.panel && npm run finance:pagos
# esperado: una sola línea (la de las 5:40) y el script corre

# 6 — el e2e
bash tasks/saldo-cuentas/_verificacion-e2e.sh
```

Y a mano en el browser, que es lo que ningún agente pudo verificar: cargar los 4 saldos, borrar uno y
ver que el patrimonio dice "sin información", el toggle del gráfico con teclado, y que un `aporte` no
suba la ganancia del mes.
