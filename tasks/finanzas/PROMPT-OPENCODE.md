# Prompts para OpenCode CLI — Finanzas

Equivalente a `PROMPT-CLAUDE-CODE.md`, adaptado a la sintaxis real de `opencode run` (verificada
contra la versión instalada: `opencode 1.14.20`, comando `opencode run --help`). Mismo plan, mismas
4 tasks (`T01` a `T04`), mismo orden de olas — sólo cambia cómo se invoca el agente.

## Antes de arrancar

```
tasks/finanzas/
├── 00-PLAN-FINANZAS.md         el documento maestro — leerlo primero, siempre
├── PROMPT-CLAUDE-CODE.md       la versión para Claude Code
├── PROMPT-OPENCODE.md          este archivo
├── _schema-022.sql             el DDL canónico, YA CORRIDO y verificado (T01 lo copia tal cual)
├── _verificacion-022.sql       21 afirmaciones, YA EN VERDE contra una base scratch
├── T01-fundacion-finanzas.md   esquema + queries + cron — VA SOLA Y PRIMERO
├── T02-api-finanzas.md         rutas de API
├── T03-ui-finanzas.md          pantalla + navbar
└── T04-cron-deploy.md          cron de producción + runbook — VA SOLA Y AL FINAL
```

**El resto del contexto (qué ya está verificado, las 5 cosas que hay que saber antes de largar el
primer agente, el orden y las compuertas entre olas) es idéntico a `PROMPT-CLAUDE-CODE.md` — no se
repite acá. Leélo si no lo leíste, en particular la sección "5 cosas que hay que saber".**

## Cómo se invoca cada task

`opencode run [message..]` corre un prompt de una sola pasada, sin abrir la TUI, e imprime la
respuesta a stdout. Corré cada comando desde la raíz del repo (`cd
~/Desktop/funnel/dashboard-admin`).

**Aviso de permisos:** `opencode run` pide confirmación de cada acción (escribir un archivo, correr
un comando) salvo que uses `--dangerously-skip-permissions`. Ese flag es exactamente lo que dice:
sin red de seguridad. Para T01-T03 (que sólo tocan los archivos de su fila en un repo con git) es
razonable si vas a revisar el diff después con `git diff`. Para T04 (que además corre contra tu
Postgres local) usalo con la misma confianza. **No lo necesitás**: podés arrancar sin el flag y
aprobar a mano cada acción — más lento, más control.

Usá un heredoc con el delimitador entre comillas simples (`<<'PROMPT_EOF'`) para que los backticks,
el `$` y las comillas que aparecen dentro de los prompts (hay muchos nombres de archivo y de tipos
citados) lleguen literales y no se interpreten como sintaxis de tu shell:

```bash
opencode run "$(cat <<'PROMPT_EOF'
[el texto del prompt de la task]
PROMPT_EOF
)" --dangerously-skip-permissions
```

**Cada task es una sesión nueva** (no uses `-c/--continue`): T01, T02, T03 y T04 se escriben con
contexto propio y no dependen de que el modelo recuerde el turno anterior — todo lo que cada una
necesita saber está en el plan y en su propio archivo de task, que el prompt le indica leer primero.
Si necesitás retomar una task que se cortó a la mitad, usá `opencode session list` para encontrar su
`sessionID` y `opencode run --session <id> "seguí donde quedaste"`.

---

## Paso 1 — T01, sola

```bash
opencode run "$(cat <<'PROMPT_EOF'
Este repo es un dashboard de Next.js 14 (App Router) + Postgres crudo (sin ORM, `pg` con SQL
parametrizado) para un negocio de funnels de venta. Es un proyecto YA EN PRODUCCIÓN
(panel.hilvanapp.com), aunque vas a trabajar contra la base LOCAL de desarrollo.

Leé estos archivos COMPLETOS antes de escribir código, en este orden:
1. tasks/finanzas/00-PLAN-FINANZAS.md
2. tasks/finanzas/T01-fundacion-finanzas.md

El resto del panel (Resumen, Ventas, Embudo, Anuncios, Leads, Config) ya funciona y no se toca.

Reglas que no se negocian:
- Solo escribís los archivos de tu fila en el §8 del plan: db/migrations/022_finanzas.sql,
  lib/queries/finance.ts, lib/queries/finance.test.ts, scripts/finance-rollup.ts,
  scripts/finance-scheduled-payments.ts, scripts/finance-rollup.test.ts, y package.json (sólo
  agregar 2 entradas a "scripts", nunca a "dependencies"). Nada más.
- Hay una lista de archivos que NADIE toca (§8 del plan): lib/db.ts, lib/day.ts,
  lib/queries/overview.ts, lib/queries/sales.ts, scripts/rollup.ts, components/ui.tsx.
- El esquema de tasks/finanzas/_schema-022.sql NO se retipea: ya corrió dos veces contra una base
  scratch y las 21 afirmaciones de tasks/finanzas/_verificacion-022.sql dieron el resultado
  documentado. Copialo tal cual como db/migrations/022_finanzas.sql.
- Si aparece una decisión que el plan no resuelve, no la decidís en el código: se anota en el §10
  del plan (agregala vos mismo a esa sección) y seguís si no bloquea, o parás si bloquea.
- Todo el SQL con parámetros ($1, $2), nunca concatenación de strings.
- Código, comentarios, nombres de componentes y mensajes de usuario en español, como el resto del
  repo.

Tu tarea: implementar T01 completa — el esquema, lib/queries/finance.ts con las firmas exactas del
§4 del plan, los dos scripts de cron, y los tests de la sección 5 de tu propio archivo de task.

Atención especial:
- El signo de un movimiento lo pone tu función (createMovement/updateMovement), no el que la llama.
  createMovement recibe siempre el valor absoluto para gasto/retiro y le aplica -Math.abs(); para
  ajuste, respeta el signo que ya viene. updateMovement sigue la MISMA regla (leé el kind actual de
  la fila antes de aplicar el signo nuevo) — hay un test específico para esto en la sección 5 de tu
  task, no lo omitas.
- byMonth tiene que devolver 12 meses SIEMPRE, con generate_series, aunque algún mes no tenga
  ninguna fila. Es el test 4 de tu propia sección de tests.

Al terminar, corré la sección "6. Verificación" de T01-fundacion-finanzas.md COMPLETA y mostrame la
salida real de cada paso, en particular las 21 afirmaciones de _verificacion-022.sql. Si algo falla,
arreglalo antes de decir que terminaste. "Compila" no es verificación.
PROMPT_EOF
)" --dangerously-skip-permissions
```

**No sigas al paso 2 hasta que la verificación completa de T01 (incluidas las 21 afirmaciones) haya
dado el resultado documentado.** Es la compuerta de ola del plan §7: T02 y T03 importan tipos y
funciones que sólo existen después de esto.

---

## Paso 2 — T02 y T03, en paralelo

Son dos sesiones independientes de `opencode run`. Podés abrir dos pestañas de terminal y lanzarlas
a la vez, o correrlas una después de la otra si preferís ir más tranquilo — las dos son válidas
porque ninguna escribe en el archivo de la otra (ver el §8 del plan).

### T02 — rutas de API

```bash
opencode run "$(cat <<'PROMPT_EOF'
Este repo es un dashboard de Next.js 14 (App Router) + Postgres crudo (sin ORM) para un negocio de
funnels de venta. Proyecto en producción; trabajás contra la base LOCAL de desarrollo.

Leé estos archivos COMPLETOS antes de escribir código, en este orden:
1. tasks/finanzas/00-PLAN-FINANZAS.md
2. tasks/finanzas/T02-api-finanzas.md

T01 ya escribió lib/queries/finance.ts con el contrato del §4 del plan — leelo también antes de
escribir los routes, es lo que vas a exponer por HTTP.

Reglas que no se negocian:
- Solo escribís los archivos de tu fila en el §8 del plan: app/api/finanzas/movimientos/route.ts,
  app/api/finanzas/pagos-programados/route.ts, y sus .test.ts. Nada más. No tocás
  lib/queries/finance.ts aunque te parezca que le falta algo — eso va al §10 del plan.
- Todo el SQL con parámetros, nunca concatenación. Código y comentarios en español.
- Si aparece una decisión que el plan no resuelve, se anota en el §10 del plan, no se decide en el
  código.

Tu tarea: implementar T02 completa — los dos routes con guard de auth, validación de zod, y los
tests de la sección 5 de tu propio archivo de task.

Atención especial:
- Un gasto sin category, o un retiro/ajuste CON category, se rechazan ANTES de llegar a la base con
  un mensaje legible — igual que validarCombinacion en app/api/config/commissions/route.ts (leelo
  como referencia).
- El monto que manda el formulario para gasto/retiro es SIEMPRE positivo en el payload
  (z.number().positive()) — es lib/queries/finance.ts el que le pone el signo negativo, no el route.
- No le agregues a estos routes ningún concepto de funnel_id: Finanzas es siempre global.

Al terminar, corré la sección "6. Verificación" de T02-api-finanzas.md COMPLETA (incluidos los
curls de ejemplo contra tu servidor de desarrollo levantado) y mostrame la salida real.
PROMPT_EOF
)" --dangerously-skip-permissions
```

### T03 — pantalla + navbar

```bash
opencode run "$(cat <<'PROMPT_EOF'
Este repo es un dashboard de Next.js 14 (App Router) + Postgres crudo (sin ORM) para un negocio de
funnels de venta. Proyecto en producción; trabajás contra la base LOCAL de desarrollo.

Leé estos archivos COMPLETOS antes de escribir código, en este orden:
1. tasks/finanzas/00-PLAN-FINANZAS.md
2. tasks/finanzas/T03-ui-finanzas.md

T01 ya escribió lib/queries/finance.ts con los tipos del contrato del §4 del plan — importalos con
"import type", nunca en runtime desde un client component.

Reglas que no se negocian:
- Solo escribís los archivos de tu fila en el §8 del plan: app/(panel)/finanzas/page.tsx,
  app/(panel)/finanzas/FinanzasView.tsx, y UNA SOLA LÍNEA aditiva en components/Nav.tsx (agregar
  { href: '/finanzas', label: 'Finanzas' } al array TABS). Nada más de ese archivo.
- Otro agente (T02) está escribiendo en paralelo app/api/finanzas/**: podés escribir la pantalla
  completa contra la FORMA de los tipos sin esperar a que esos routes existan; para probar
  alta/edición/borrado end-to-end sí los vas a necesitar funcionando.
- Código, comentarios y textos de UI en español, como el resto del panel.
- Si aparece una decisión que el plan no resuelve, se anota en el §10 del plan, no se decide en el
  código.

Tu tarea: implementar T03 completa — page.tsx, FinanzasView.tsx, y la línea en Nav.tsx.

Atención especial:
- Esta pantalla NO usa el ?range= del RangePicker global: el patrimonio es de todo el histórico por
  definición (D1 del plan). Ignorá ese query param.
- El monto de un movimiento se muestra con su signo real en la tabla, sin Math.abs() en el render —
  un gasto tiene que verse negativo.
- Antes de escribir, leé completos: app/(panel)/resumen/page.tsx, ResumenView.tsx, y
  app/(panel)/config/sections/ComisionesSection.tsx — son los patrones de referencia que tu propia
  task (sección 2) te pide seguir.

Al terminar, corré npm run build y confirmá que compila. La revisión visual en el browser
(navegación con teclado, carga de un gasto/retiro/ajuste/pago programado) la hago yo a mano después
— mencionámela como pendiente en tu resumen final, no la saltees en silencio.
PROMPT_EOF
)" --dangerously-skip-permissions
```

**No sigas al paso 3 hasta que T02 Y T03 hayan corrido su verificación completa.**

---

## Paso 3 — T04, sola, al final

```bash
opencode run "$(cat <<'PROMPT_EOF'
Este repo es un dashboard de Next.js 14 (App Router) + Postgres crudo (sin ORM) para un negocio de
funnels de venta, YA EN PRODUCCIÓN (panel.hilvanapp.com, PM2 + Caddy en una VPS).

Leé estos archivos COMPLETOS antes de escribir código, en este orden:
1. tasks/finanzas/00-PLAN-FINANZAS.md
2. tasks/finanzas/T04-cron-deploy.md
3. deploy/cron.panel completo (los comentarios existentes explican por qué el orden horario importa)

Reglas que no se negocian:
- Solo tocás: deploy/cron.panel (agregar 2 líneas, no tocar ninguna existente), docs/runbook.md
  (agregar una sección), tasks/finanzas/_verificacion-e2e.sh (crearlo). Nada más.
- No instalás nada nuevo en el crontab de producción de verdad: sólo editás el ARCHIVO del repo
  que después alguien instala a mano en la VPS (ver docs/runbook.md §1 para el contexto de cómo se
  instala).
- Código y comentarios en español.

Tu tarea: implementar T04 completa — las 2 líneas de cron en el orden horario correcto respecto al
rollup de daily_metrics, la sección "Finanzas" en el runbook, y el script de verificación
end-to-end de la sección 5 de tu propio archivo de task.

Atención especial:
- El orden horario respecto al rollup de daily_metrics no es arbitrario: leé el comentario existente
  sobre fetch-fx y el rollup nocturno en deploy/cron.panel antes de elegir la hora.
- Tu script end-to-end TIENE que probar que correr finance-scheduled-payments.ts dos veces el mismo
  día no duplica el gasto. Es la prueba más importante de todo el módulo.

Al terminar, corré tu propio script _verificacion-e2e.sh contra la base local y pegame la salida
real completa, más el bloque final de "Qué revisar cuando terminan" del archivo
tasks/finanzas/PROMPT-CLAUDE-CODE.md (es el mismo checklist final, independiente de qué agente
implementó cada task). Si el script muestra un pago duplicado en cualquier corrida, PARÁ y decímelo
en lugar de seguir documentando un cron que duplica gastos.
PROMPT_EOF
)" --dangerously-skip-permissions
```

---

## Si algo se corta a mitad de camino

```bash
opencode session list                              # encontrar el sessionID de la task que se cortó
opencode run --session <sessionID> "seguí donde quedaste, revisá qué archivos ya escribiste antes de continuar"
```

No relances el prompt completo de la task desde cero sin revisar primero qué se llegó a escribir:
podrías duplicar trabajo o, peor, hacer que el agente "corrija" algo que ya estaba bien.

## Verificación final del módulo completo

Igual que en `PROMPT-CLAUDE-CODE.md`, sección "Qué revisar cuando terminan" — no se repite acá
porque es idéntica sin importar qué CLI ejecutó las tasks. Los comandos de esa sección corren contra
el estado del repo, no contra el agente que lo escribió.
