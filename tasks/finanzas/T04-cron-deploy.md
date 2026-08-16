# T04 — Cron en producción, runbook y verificación end-to-end

- **Depende de:** T02, T03 (los dos tienen que estar terminados y con su verificación en verde).
- **Bloquea:** nada (es la última task del módulo).
- **Se puede correr en paralelo con:** nada. **Corre sola, al final.**
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos que este task puede tocar:** `deploy/cron.panel` (agregar 2 líneas), `docs/runbook.md`
  (agregar una sección), `tasks/finanzas/_verificacion-e2e.sh`. Nada más.

Leé `00-PLAN-FINANZAS.md` completo, en particular §5 (el orden horario del cron) y §9 (criterios de
aceptación globales).

---

## 1. Objetivo

Cuando termines:

- `deploy/cron.panel` tiene las 2 líneas nuevas, en el orden correcto respecto al rollup existente.
- `docs/runbook.md` tiene una sección "Finanzas" con el mismo nivel de detalle operativo que el
  resto del runbook (qué mirar si algo falla, no arquitectura).
- Un script de verificación end-to-end corrido y con su salida documentada, que prueba el circuito
  completo: cron de profit → cron de pagos → lectura de la pantalla.

## 2. Antes de escribir, leé `deploy/cron.panel` completo

Fijate en particular el bloque comentado de `fetch-fx` (05:10) y los dos rollups (05:10 y 05:25):
el comentario explica POR QUÉ la hora exacta importa (la diferencia de zona horaria entre el
servidor en Europa y `DASHBOARD_TZ` en Argentina) y por qué los 15 minutos de separación entre
`fetch-fx` y el rollup nocturno son una dependencia real, no un espaciado arbitrario.

## 3. Las líneas nuevas en `deploy/cron.panel`

Van DESPUÉS del rollup nocturno de `daily_metrics` (que corre a las 05:25), con la misma separación
de 5-10 minutos que ya usa el resto del archivo entre pasos dependientes:

```cron
# Finanzas: profit diario (T01/T04). DESPUÉS del rollup nocturno de daily_metrics
# (05:25): el profit del día se calcula agregando daily_metrics de TODOS los
# funnels, así que si corriera antes, sumaría datos de hasta 24 h viejos.
# Recalcula ayer y hoy (plan §5): el profit de "hoy" sigue moviéndose durante
# el día, así que la corrida de la madrugada corrige el de ayer una vez más.
35 5 * * * cd /srv/panel/current && /usr/bin/node --env-file=.env.production ./node_modules/.bin/tsx scripts/finance-rollup.ts >> /var/log/panel/finance.log 2>&1

# Finanzas: pagos programados (T01/T04). DESPUÉS del profit diario de arriba,
# para que si alguien mira /finanzas a las 5:40 de la mañana vea los dos ya
# actualizados juntos. No depende funcionalmente del profit (son tablas
# distintas), es sólo para que la foto sea consistente.
40 5 * * * cd /srv/panel/current && /usr/bin/node --env-file=.env.production ./node_modules/.bin/tsx scripts/finance-scheduled-payments.ts >> /var/log/panel/finance.log 2>&1
```

**No toques ninguna línea existente del archivo.** Sólo agregás estas dos, al final del bloque de
crons relacionados a `daily_metrics`/rollup (antes del bloque "─── Anuncios ───", para mantener el
archivo agrupado por tema).

## 4. La sección nueva en `docs/runbook.md`

Agregá, después de la sección "4. Diagnóstico" y antes de "5. Restaurar un backup" (o al final, si
te resulta más natural — es una decisión menor, no bloqueante), algo con esta forma:

```markdown
## 4.1 Finanzas

**Qué hace:** `finance-rollup.ts` calcula el profit diario (todos los funnels, agregado) desde
`daily_metrics`, 1 vez al día. `finance-scheduled-payments.ts` genera el gasto de cualquier pago
programado activo cuyo día ya pasó este mes.

| Síntoma | Dónde mirar |
|---|---|
| el patrimonio no se mueve de un día para otro | `SELECT * FROM finance_daily_profit ORDER BY day DESC LIMIT 3;` — ¿corrió el cron anoche? |
| un pago programado activo no generó su gasto | `finance_scheduled_payment_runs` para ese `scheduled_payment_id` y el mes actual; si no hay fila, revisar `/var/log/panel/finance.log` |
| un pago se ejecutó dos veces (no debería poder pasar) | el `PRIMARY KEY (scheduled_payment_id, month)` de `finance_scheduled_payment_runs` lo impide a nivel de base; si esto pasa, es un bug — reportarlo, no hay procedimiento de "arreglar a mano" documentado |

Correr a mano, si hace falta:

\`\`\`bash
cd /srv/panel/current
node --env-file=.env.production ./node_modules/.bin/tsx scripts/finance-rollup.ts
node --env-file=.env.production ./node_modules/.bin/tsx scripts/finance-scheduled-payments.ts
\`\`\`
```

Ajustá el formato exacto al resto del runbook (mirá cómo están armadas las tablas de la sección 4
ya existente) — la forma no es rígida, el contenido operativo sí tiene que estar.

## 5. Verificación end-to-end — `tasks/finanzas/_verificacion-e2e.sh`

Un script que prueba el circuito completo contra tu base LOCAL (nunca contra producción — ver el
límite duro del plan de verificación, mismo principio que ya siguió T01 en fase 3). Estructura:

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "1. Sembrando un pago programado atrasado de prueba..."
# INSERT directo vía psql con day_of_month = día de ayer (o cualquiera <= hoy)

echo "2. Corriendo finance-rollup..."
npm run finance:rollup

echo "3. Corriendo finance-scheduled-payments..."
npm run finance:pagos

echo "4. Verificando que el gasto se generó..."
# SELECT sobre finance_movements con scheduled_payment_id = el sembrado
# esperado: 1 fila

echo "5. Corriendo finance-scheduled-payments OTRA VEZ (no debe duplicar)..."
npm run finance:pagos

echo "6. Verificando que sigue habiendo 1 sola fila..."
# esperado: sigue siendo 1, no 2

echo "7. Limpiando los datos de prueba..."
# DELETE de lo sembrado en el paso 1 (cascada a finance_movements y
# finance_scheduled_payment_runs vía las FK con ON DELETE)
```

Escribilo completo (no dejes comentarios "TODO", son placeholders de esta task para que lo
completes), corrélo, y pegá la salida real como comentario al final del archivo o en tu mensaje de
cierre — es tu evidencia de que el circuito end-to-end funciona con los tres módulos (T01, T02
indirectamente vía los scripts que no pasan por HTTP, T03 no se prueba acá porque es UI).

## 6. Verificación

```bash
# 1 — el cron nuevo no rompe la sintaxis del archivo (no hay un linter de crontab
#     instalado en este repo; la verificación es visual + que las rutas de los
#     scripts existen)
ls scripts/finance-rollup.ts scripts/finance-scheduled-payments.ts
# esperado: los dos archivos existen (los escribió T01)

# 2 — el script end-to-end corre limpio
bash tasks/finanzas/_verificacion-e2e.sh
# esperado: llega al paso 7 sin ningún error, y el paso 6 confirma "1 fila" las dos veces

# 3 — build final del módulo completo
npm run build
npm test
```

## 7. Cuándo parar

**Bloqueante, pará y avisá:**
- Si T02 o T03 todavía no pasan su propia verificación: no arranques esta task. Es la compuerta
  del plan §7 — la ola C no arranca hasta que la ola B esté en verde.
- Si el script end-to-end del paso 5 muestra que un pago SE DUPLICÓ: es el bug más caro de todo el
  módulo (plata que se cuenta dos veces). Pará y avisá, no sigas documentando un cron que duplica
  gastos.

**Anotalo en §10 del plan y seguí:**
- El formato exacto de la sección nueva del runbook, si difiere un poco de lo sugerido.
- **Necesitás modificar un archivo ajeno** → nunca; anotalo.
