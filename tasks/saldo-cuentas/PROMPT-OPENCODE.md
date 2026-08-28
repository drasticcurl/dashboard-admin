# Prompts para OpenCode CLI — Saldo por cuentas

Equivalente a `PROMPT-CLAUDE-CODE.md`, adaptado a la sintaxis de `opencode run`. Mismo plan, mismas
6 tasks (`T01` a `T06`), mismo orden de olas — sólo cambia cómo se invoca el agente.

**El contexto (qué está verificado, las 6 cosas que hay que saber antes de largar el primer agente, el
orden y las compuertas entre olas) es idéntico a `PROMPT-CLAUDE-CODE.md` y no se repite acá. Leélo si
no lo leíste, en particular la sección "6 cosas que hay que saber" y el texto completo de los prompts,
que es el mismo.**

## Cómo se invoca cada task

Corré cada comando desde la raíz del repo (`cd ~/Desktop/funnel/dashboard-admin`).

Usá un heredoc con el delimitador entre comillas simples (`<<'PROMPT_EOF'`) para que los backticks,
el `$` y las comillas que aparecen dentro de los prompts lleguen literales y no los interprete tu
shell:

```bash
opencode run "$(cat <<'PROMPT_EOF'
[el texto del prompt de la task, copiado de PROMPT-CLAUDE-CODE.md]
PROMPT_EOF
)" --dangerously-skip-permissions
```

**Aviso de permisos:** sin `--dangerously-skip-permissions`, `opencode run` pide confirmación de cada
acción. Con el flag, no hay red de seguridad. Para T01-T05 (que sólo tocan los archivos de su fila en
un repo con git) es razonable si vas a revisar el diff después. **Para T01 tené en cuenta que su
migración corre un `DROP TABLE finance_daily_profit` contra tu base local** — es la única acción
destructiva del módulo y es reversible (la tabla es 100 % derivada de `daily_metrics`), pero
merece que sepas que va a pasar.

**Cada task es una sesión nueva** (no uses `-c/--continue`): las seis se escriben con contexto propio
y todo lo que necesitan está en el plan y en su archivo de task. Si una se corta a la mitad, usá
`opencode session list` para encontrar su `sessionID` y
`opencode run --session <id> "seguí donde quedaste, revisá qué archivos ya escribiste antes de continuar"`.

---

## Paso 1 — T01, sola

```bash
opencode run "$(cat <<'PROMPT_EOF'
# ↓ copiá acá el bloque completo del "Paso 1 — T01, sola" de PROMPT-CLAUDE-CODE.md
PROMPT_EOF
)" --dangerously-skip-permissions
```

**No sigas al paso 2 hasta que las 19 afirmaciones de `_verificacion-028.sql` hayan dado el resultado
documentado.** Es la compuerta del plan §7: las cuatro tasks del paso 2 importan tipos y funciones que
sólo existen después de T01.

## Paso 2 — T02, T03, T04 y T05, en paralelo

Cuatro sesiones independientes de `opencode run`. Podés abrir cuatro pestañas de terminal y lanzarlas
a la vez, o correrlas de a una si preferís ir más tranquilo: las dos formas son válidas porque ninguna
escribe en el archivo de otra (§8 del plan).

```bash
# en cuatro terminales, o de a una
opencode run "$(cat <<'PROMPT_EOF'
# ↓ el preámbulo común + el cierre de T02 (o T03 / T04 / T05) de PROMPT-CLAUDE-CODE.md
PROMPT_EOF
)" --dangerously-skip-permissions
```

Lo único que cambia entre las cuatro es la línea `2. tasks/saldo-cuentas/<TU-TASK>.md` del preámbulo y
el párrafo de cierre. Están los cuatro escritos en `PROMPT-CLAUDE-CODE.md`, paso 2.

**Si las lanzás a la vez, ojo con una cosa que no es del plan sino de tu máquina:** las cuatro pueden
querer correr `npm test` contra la MISMA base local al mismo tiempo. `vitest.config.ts` tiene
`fileParallelism: false`, que serializa los archivos **dentro de una corrida**, pero no coordina
cuatro procesos distintos. T02 y T03 son las dos que tocan la base en sus tests: si ves fallos raros
de datos que aparecen y desaparecen, corré esas dos de a una. T04 y T05 no tocan la base y pueden ir
en paralelo con cualquiera sin riesgo.

**No sigas al paso 3 hasta que las cuatro hayan corrido su verificación.**

## Paso 3 — T06, sola, al final

```bash
opencode run "$(cat <<'PROMPT_EOF'
# ↓ el bloque completo del "Paso 3 — T06" de PROMPT-CLAUDE-CODE.md
PROMPT_EOF
)" --dangerously-skip-permissions
```

## Verificación final del módulo completo

Igual que en `PROMPT-CLAUDE-CODE.md`, sección "Qué revisar cuando terminan las seis". No se repite
acá porque los comandos corren contra el estado del repo, no contra el agente que lo escribió.
