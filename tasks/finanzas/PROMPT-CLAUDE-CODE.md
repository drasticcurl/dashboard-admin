# Prompts para Claude Code — Finanzas

## Antes de arrancar

```
tasks/finanzas/
├── 00-PLAN-FINANZAS.md         el documento maestro — leerlo primero, siempre
├── PROMPT-CLAUDE-CODE.md       este archivo
├── _schema-022.sql             el DDL canónico, YA CORRIDO y verificado (T01 lo copia tal cual)
├── _verificacion-022.sql       21 afirmaciones, YA EN VERDE contra una base scratch
├── T01-fundacion-finanzas.md   esquema + queries + cron — VA SOLA Y PRIMERO
├── T02-api-finanzas.md         rutas de API
├── T03-ui-finanzas.md          pantalla + navbar
└── T04-cron-deploy.md          cron de producción + runbook — VA SOLA Y AL FINAL
```

**Lo que ya está verificado y por qué eso ahorra trabajo:** el esquema (`_schema-022.sql`) corrió
dos veces contra una base con las migraciones 001-020 aplicadas (idempotencia confirmada), y las 21
afirmaciones de `_verificacion-022.sql` — los 4 `CHECK` de signo/categoría, la aritmética del
patrimonio como suma de dos tablas, la continuidad de los 12 meses sin huecos, la detección de
pagos atrasados en sus 4 variantes (atrasado/futuro/ya pagado/pausado), y la idempotencia
estructural de `finance_scheduled_payment_runs` — dieron el resultado exacto documentado. T01 no
tiene que redescubrir ninguna de estas reglas, sólo implementarlas.

### 5 cosas que hay que saber antes de largar el primer agente

**1. T01 va sola y primero.** Declara `db/migrations/022_finanzas.sql` y `lib/queries/finance.ts`
(el contrato congelado del plan §4), que T02 y T03 importan. Nadie más los toca.

**2. Este módulo registra plata real, incluidos retiros a la cuenta personal del usuario.** El
signo de cada movimiento lo garantiza un `CHECK` en la base, no el código — así que ningún agente
tiene margen para "arreglarlo desde la aplicación" si algo no cierra: si el `CHECK` rechaza un
INSERT, el bug está en cómo se armó el dato, no en el constraint.

**3. Estado del sistema:** vas a trabajar contra tu base LOCAL (Docker, `panel-db-1`). El esquema
ya se verificó contra una scratch, nunca contra la base real de producción ni contra tu base de
desarrollo con datos — las migraciones son aditivas (sólo `CREATE TABLE`, nada de `ALTER` sobre
tablas existentes con datos), así que aplicarlas en tu base de desarrollo es seguro y no borra nada.

**4. El riesgo de este módulo y sus defensas:** un gasto cargado con el signo equivocado, o un pago
programado que se ejecuta dos veces, corrompen la única cifra de "cuánta plata hay". Las defensas
ya están en el esquema (los `CHECK` y el `PRIMARY KEY` compuesto de
`finance_scheduled_payment_runs`) y verificadas — la tarea de cada agente es no darles la vuelta
por el costado (por ejemplo, insertando directo con SQL crudo en un route en vez de pasar por
`lib/queries/finance.ts`).

**5. El plan es el contrato.** El `00-PLAN-FINANZAS.md` completo, en especial §1 (decisiones
cerradas), §4 (el contrato de `lib/queries/finance.ts`) y §8 (ownership de archivos), no se
modifica por ningún agente. Si algo no cierra, va a §10 (preguntas abiertas) del plan.

## El orden

```
Paso 1   T01                  1 agente, SOLO
Paso 2   T02 · T03            2 en paralelo
Paso 3   T04                  1 agente, SOLO
```

**T01 no está terminada hasta que su verificación (sección 6 de su archivo) pasa completa,
incluidas las 21 afirmaciones de `_verificacion-022.sql`.** El paso 2 no arranca antes: T02 y T03
importan tipos y funciones que sólo existen después de T01.

T02 y T03 pueden escribirse en paralelo porque los dos consumen el **tipo** que T01 congeló
(`FinanceOverview`, `FinanceMovement`, `ScheduledPayment`), no la implementación interna de cada
función — T03 puede armar toda la pantalla contra la forma de esos tipos sin que
`getFinanceOverview` esté "terminada" en el sentido de optimizada, sólo tiene que existir con esa
firma. Para probar la pantalla end-to-end (que un alta desde la UI de verdad llegue a la base) sí
hace falta que T02 esté funcionando, pero eso es integración, no una dependencia de archivos.

T04 va sola al final porque instala el cron de producción y escribe el runbook — necesita que T02 y
T03 ya estén verificadas, no tiene sentido documentar un circuito que todavía puede cambiar.

**Si preferís ir de a uno:** T01 → T02 → T03 → T04. Es más lento pero cada paso está
completamente probado antes de arrancar el siguiente.

---

## Preámbulo (va al inicio de cada prompt)

> Este repo es un dashboard de Next.js 14 (App Router) + Postgres crudo (sin ORM, `pg` con SQL
> parametrizado) para un negocio de funnels de venta. Es un proyecto YA EN PRODUCCIÓN
> (`panel.hilvanapp.com`), aunque vas a trabajar contra tu base LOCAL de desarrollo.
>
> Leé estos archivos completos antes de escribir código, en este orden:
> 1. `tasks/finanzas/00-PLAN-FINANZAS.md`
> 2. `tasks/finanzas/<TU-TASK>.md`
>
> El resto del panel (Resumen, Ventas, Embudo, Anuncios, Leads, Config) ya funciona y no se toca.
> Los patrones de código a seguir (server component + client component + funciones puras en
> `lib/queries/`, componentes de UI en `components/ui.tsx`, SQL siempre parametrizado) ya están
> establecidos — tu task te dice exactamente qué archivo existente leer como referencia antes de
> escribir el equivalente nuevo.
>
> Reglas que no se negocian:
> - **Solo escribís los archivos de tu fila en §8 del plan.** Otros agentes trabajan en paralelo.
>   Si creés que necesitás tocar uno ajeno, anotalo en §10 del plan y NO lo edites.
> - **Hay una lista de archivos que NADIE toca** (§8 del plan): `lib/db.ts`, `lib/day.ts`,
>   `lib/queries/overview.ts`, `lib/queries/sales.ts`, `scripts/rollup.ts`,
>   `components/ui.tsx` (salvo consulta explícita).
> - **No instalás dependencias ni editás `package.json`** más allá de los dos scripts npm que T01
>   agrega (`finance:rollup`, `finance:pagos`). Si falta una librería, va a §10 del plan.
> - **No cambiás el esquema del §3 del plan ni el contrato del §4** una vez que T01 los declaró.
>   Están congelados porque otro agente se escribe contra ellos al mismo tiempo.
> - **Si aparece una decisión que el plan no resuelve, no la decidís en el código:** va a §10 del
>   plan. Si bloquea tu trabajo, parás y avisás en vez de suponer.
> - **Todo el SQL con parámetros (`$1`, `$2`), nunca concatenación de strings.** Este proyecto
>   recibe payloads de formularios y no hay una segunda capa de defensa contra inyección.
> - **Código, comentarios, nombres de componentes y mensajes de usuario en español**, como el
>   resto del repo. Los identificadores técnicos de infraestructura (`numeric`, `timestamptz`, SQL
>   en general) quedan en inglés donde ya es el estándar.
> - **Al terminar, corré tu sección de Verificación COMPLETA y pegá la salida real.** Si algo
>   falla, arreglalo antes de decir que terminaste. "Compila" no es verificación.

## Paso 1

### T01 — Esquema + queries + cron
> [preámbulo, con `<TU-TASK>` = `T01-fundacion-finanzas.md`]
>
> Copiá `_schema-022.sql` como la migración `022_finanzas.sql`, escribí `lib/queries/finance.ts`
> con las firmas exactas del plan §4, los dos scripts de cron, y los tests.
>
> Atención especial:
> - **El `_schema-022.sql` NO se retipea.** Ya está verificado con 21 afirmaciones en
>   `_verificacion-022.sql`. Cambiar una coma de un `CHECK` invalida esa verificación sin que te
>   des cuenta hasta que un test falle de forma confusa más adelante.
> - **El signo de un movimiento lo pone tu función, no el que la llama.** `createMovement` recibe
>   siempre el valor absoluto para gasto/retiro y le aplica `-Math.abs()`; para ajuste, respeta el
>   signo que ya viene. Si esto queda invertido, todo lo que se cargue desde la UI (T03) suma en
>   vez de restar sin que ningún test de UI lo detecte, porque el bug está en tu capa.
> - **`byMonth` tiene que devolver 12 meses SIEMPRE, con `generate_series`, aunque algún mes no
>   tenga ninguna fila.** Es el test 4 de tu propia sección de tests: un mes que desaparece del
>   gráfico en vez de aparecer en 0 es exactamente el bug que la verificación de fase 3 (#20) ya
>   descartó — no lo reintroduzcas con un `GROUP BY` directo sin el `LEFT JOIN` contra
>   `generate_series`.

### T02 — Rutas de API
> [preámbulo, con `<TU-TASK>` = `T02-api-finanzas.md`]
>
> Escribí `app/api/finanzas/movimientos/route.ts` y `app/api/finanzas/pagos-programados/route.ts`
> exponiendo por HTTP las funciones que T01 ya dejó en `lib/queries/finance.ts`, con guard de auth
> y validación de `zod`.
>
> Atención especial:
> - **Un gasto sin categoría, o un retiro/ajuste CON categoría, se rechazan ANTES de llegar a la
>   base**, con un mensaje legible — igual que `validarCombinacion` en
>   `app/api/config/commissions/route.ts`. No dejes que el usuario vea el texto crudo de un
>   `check_violation` de Postgres.
> - **El monto que manda el formulario para gasto/retiro es SIEMPRE positivo** (`z.number().positive()`
>   en el schema) — es `lib/queries/finance.ts` (de T01) el que le pone el signo negativo, no vos.
> - **No le agregues a estos routes ningún concepto de `funnel_id`.** Finanzas es siempre global
>   (decisión explícita del usuario, plan §0 y §1) — a diferencia de casi todo el resto del panel,
>   que sí filtra por funnel.

### T03 — Pantalla + navbar
> [preámbulo, con `<TU-TASK>` = `T03-ui-finanzas.md`]
>
> Escribí `app/(panel)/finanzas/page.tsx` y `FinanzasView.tsx`, y agregá la pestaña "Finanzas" al
> array `TABS` de `components/Nav.tsx` (una sola línea).
>
> Atención especial:
> - **Esta pantalla NO usa el `?range=` del `RangePicker` global.** El patrimonio es de todo el
>   histórico por definición — ignorá ese query param por completo, a diferencia de Resumen/Ventas/
>   Embudo que sí lo usan.
> - **El monto de un movimiento se muestra con su signo real, sin `Math.abs()` en el render.** Un
>   gasto tiene que verse negativo en la tabla. Es el mismo principio de "no tapar datos malos" que
>   ya sigue el resto del panel (ver `lib/costs.ts`: "el margen negativo se muestra").
> - **Tocás `components/Nav.tsx` en UNA sola línea aditiva.** Ese archivo lo importan las otras 6
>   pantallas del panel — cualquier otro cambio ahí es una colisión que no te corresponde.

## Paso 3

### T04 — Cron de producción + runbook
> [preámbulo, con `<TU-TASK>` = `T04-cron-deploy.md`]
>
> Agregá las 2 líneas de cron a `deploy/cron.panel` (después del rollup nocturno de
> `daily_metrics`, con la separación horaria que tu task explica), documentá la sección "Finanzas"
> en `docs/runbook.md`, y escribí y corré la verificación end-to-end.
>
> Atención especial:
> - **El orden horario respecto al rollup de `daily_metrics` no es arbitrario**: leé el comentario
>   existente sobre `fetch-fx` y el rollup nocturno en `deploy/cron.panel` antes de elegir la hora
>   — es el mismo tipo de dependencia (tu profit diario necesita que `daily_metrics` ya esté
>   actualizado, o suma datos viejos).
> - **Tu script end-to-end tiene que probar que correr `finance-scheduled-payments.ts` DOS veces el
>   mismo día no duplica el gasto.** Es la prueba más importante de todo el módulo en producción:
>   un reinicio del proceso a mitad de una corrida de cron es normal, no una excepción.

---

## Qué revisar cuando terminan

```bash
# 1 — compila, buildea, tests
npm run build && npm test

# 2 — la migración corre limpia dos veces (idempotencia)
npm run db:migrate && npm run db:migrate

# 3 — las 21 afirmaciones lógicas de fase 3 siguen en verde
#     (comando completo en la sección 6 de T01-fundacion-finanzas.md)

# 4 — NADA DE LO QUE YA FUNCIONABA CAMBIÓ
#     comparar antes/después: conteos de orders, daily_metrics, commissions
psql "$DATABASE_URL" -c "SELECT count(*) FROM orders;" -c "SELECT count(*) FROM daily_metrics;"
# esperado: los mismos números que antes de instalar este módulo — ninguna task de Finanzas
# toca esas tablas

# 5 — los endpoints nuevos rechazan sin credencial
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3005/api/finanzas/movimientos      # 401
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3005/api/finanzas/pagos-programados # 401

# 6 — el punto que decide si el módulo funciona de punta a punta
bash tasks/finanzas/_verificacion-e2e.sh
# esperado: llega al final sin duplicar ningún pago programado

# 7 — el circuito completo, a mano, en el browser
# http://localhost:3005/finanzas — cargar un gasto, un retiro, un ajuste, un pago programado
# atrasado, confirmar que el patrimonio y el banner reaccionan sin recargar

# 8 — el estado final es el seguro
# ningún movimiento se generó solo excepto los que vengan de un pago programado
# realmente atrasado — revisar finance_movements.scheduled_payment_id de las filas nuevas

# 9 — leé las preguntas abiertas que quedaron
# tasks/finanzas/00-PLAN-FINANZAS.md §10 — P-01 (preexistente, no bloquea), P-02, P-03
```

Si el paso 6 (el script end-to-end) muestra un pago duplicado, el módulo no está listo para
producción sin importar qué tan bien se vea la pantalla: es la única cosa que este plan trata como
no negociable, porque un gasto contado dos veces corrompe la cifra que todo el módulo existe para
mostrar.
