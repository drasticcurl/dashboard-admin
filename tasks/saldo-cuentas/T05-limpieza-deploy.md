# T05 — Sacar el rollup de profit: script, cron, npm y runbook

- **Depende de:** T01 (necesitás que `db/migrations/028_saldo_cuentas.sql` exista para que tu `grep` de
  verificación dé lo que tiene que dar). No importás nada de su código TypeScript.
- **Bloquea:** nada. Pero **en el deploy va junto con la migración 028**, ver §4.
- **Se puede correr en paralelo con:** T02, T03, T04.
- **Archivos que este task puede tocar:** `scripts/finance-rollup.ts` (**borrar**),
  `scripts/finance-rollup.test.ts` (**borrar**), `package.json` (**sólo** quitar la línea
  `finance:rollup`), `deploy/cron.panel` (**sólo** quitar la línea de las 5:35),
  `docs/runbook.md` (reescribir la sección "Finanzas"). **Nada más.**

Leé `00-PLAN-SALDO.md` completo, sobre todo D11 y el §3 ("Cómo revertir").

---

## 1. Objetivo

`finance_daily_profit` ya no existe después de la 028. Todo lo que la escribía o la leía tiene que
irse en el mismo cambio, y el runbook tiene que explicar cómo se deploya sin romper nada.

**Sos la task más chica y la que puede romper producción de la forma más tonta:** si la migración se
deploya y tu parte no, el cron de las 5:35 falla todas las noches con
`relation "finance_daily_profit" does not exist`.

## 2. Lo que se borra

```bash
git rm scripts/finance-rollup.ts scripts/finance-rollup.test.ts
```

Y en `package.json`, la línea:

```json
"finance:rollup": "tsx scripts/finance-rollup.ts",
```

**No toques `finance:pagos`.** `scripts/finance-scheduled-payments.ts` sigue vivo y sigue corriendo
todos los días: los pagos programados no tienen nada que ver con el profit diario, siguen generando
su gasto igual que antes (criterio de aceptación 9 del plan). Confundir los dos scripts apagaría los
pagos automáticos sin que nadie lo note hasta que falte un alquiler en el historial.

En `deploy/cron.panel`, quitá **sólo** esta línea:

```
35 5 * * * cd /srv/panel/current && ... scripts/finance-rollup.ts >> /var/log/panel/finance.log 2>&1
```

La de las 5:40 (`finance-scheduled-payments.ts`) **se queda**. Los comentarios que hay alrededor
explican por qué el orden horario importa respecto del rollup de `daily_metrics` de las 5:25: si el
comentario que sacás menciona la dependencia entre los dos scripts de finanzas, reescribilo para que
siga teniendo sentido con uno solo — no dejes un comentario huérfano hablando de un archivo que
borraste.

Confirmá que no quedó nada:

```bash
grep -rn "finance-rollup\|finance:rollup\|finance_daily_profit" \
  --include="*.ts" --include="*.json" --include="*.sql" --include="*.md" \
  . | grep -v node_modules | grep -v "^./tasks/"
# esperado: sólo db/migrations/022_finanzas.sql (la migración histórica, NO se edita)
#           y db/migrations/028_saldo_cuentas.sql (el DROP)
```

Si aparece algo en `lib/` o en `app/`, **no lo arregles**: `lib/queries/finance.ts` es de T02 y las
pantallas son de T06. Avisá y seguí.

## 3. `docs/runbook.md` — la sección "Finanzas"

Reescribila. Tiene que contestar cuatro cosas:

1. **Que el patrimonio ya no se calcula.** Quien lea el runbook en seis meses buscando "por qué el
   número no coincide con Resumen" tiene que encontrar acá que son dos preguntas distintas: Resumen
   dice cuánto se vendió, Finanzas dice cuánta plata hay, y ya no comparten fuente.
2. **Que ya no hay ningún cron de profit** y que el único de finanzas es el de pagos programados
   (5:40).
3. **El paso obligatorio antes de migrar en producción.** Textual, para copiar y pegar:

```bash
# ANTES de correr db:migrate con la 028 en producción
psql "$DATABASE_URL" -c "\copy finance_daily_profit TO 'finance_daily_profit_pre028.csv' CSV HEADER"
psql "$DATABASE_URL" -c "SELECT
  (SELECT COALESCE(SUM(amount_eur),0) FROM finance_daily_profit) +
  (SELECT COALESCE(SUM(amount_eur),0) FROM finance_movements) AS patrimonio_viejo;"
# Guardá ese número. Es el único que va a explicar el salto que el usuario ve en
# pantalla el día del deploy (P-03 del plan).
#
# MEDIDO EL 2026-08-28 contra producción: patrimonio_viejo = 2487.44 EUR
#   = 1798.44 de finance_daily_profit (14 filas, 2026-08-15 a 2026-08-28)
#   +  689.00 de un único movimiento, un `ajuste`
# Si el número que te da es muy distinto de 2487.44, pasaron días y entraron más
# filas: es normal. Si es IGUAL A CERO, la tabla ya se borró y estás corriendo
# esto después de la migración, no antes.
```

   El motivo no es que el dato sea irrecuperable — `finance_daily_profit` es 100 % derivada de
   `daily_metrics` y el script la regeneraba entera con `--all`. El motivo es que después del deploy
   el patrimonio pasa a "sin información" hasta la primera carga, y sin ese número nadie va a poder
   comparar.

4. **Cómo se revierte**, con los 5 pasos del §3 del plan. **Incluí que el paso 3 depende de un hash
   de commit que T06 anota en `registro.md`**: sin eso, "recuperá el script del git log" es una
   búsqueda a ciegas en un repo con cientos de commits.

## 4. Orden del deploy — escribilo en el runbook

```
1. git pull en la VPS
2. npm ci && npm run build
3. el export CSV + el patrimonio viejo (§3 de este task)
4. npm run db:migrate            ← acá desaparece finance_daily_profit
5. instalar el crontab nuevo     ← acá desaparece la línea de las 5:35
6. pm2 reload
```

**Los pasos 4 y 5 no se pueden separar por más de un ciclo de cron.** Si el 4 corre a las 23:00 y el
5 al día siguiente, a las 5:35 el cron falla. Y si el 5 corre antes que el 4 no pasa nada malo (el
script simplemente deja de correr un día antes de que la tabla desaparezca), así que **si vas a
separarlos, hacelo en ese orden: primero el crontab, después la migración.** Dejalo escrito así en el
runbook, porque es el error que se comete al revés.

## 5. Verificación

```bash
# 1 — los archivos se fueron
ls scripts/finance-rollup.ts 2>&1
# esperado: No such file or directory

# 2 — package.json sigue siendo JSON válido y finance:pagos sigue ahí
node -e "const p=require('./package.json');
  console.log('rollup:', p.scripts['finance:rollup'] ?? 'BORRADO');
  console.log('pagos:', p.scripts['finance:pagos'] ?? 'FALTA <-- BUG');"
# esperado exactamente:
#   rollup: BORRADO
#   pagos: tsx scripts/finance-scheduled-payments.ts

# 3 — el cron: una sola línea de finanzas, la de los pagos
grep -c finance deploy/cron.panel
# esperado exactamente: 1
grep finance deploy/cron.panel
# esperado: la línea de las 40 5 con finance-scheduled-payments.ts

# 4 — el script que queda sigue siendo ejecutable
npm run finance:pagos
# esperado: corre sin error (o dice que no hay pagos atrasados). Si tira
# "Cannot find module", borraste el archivo equivocado.

# 5 — nada quedó referenciando la tabla borrada (ver el grep del §2)

# 6 — tipos
npx tsc --noEmit
# NO uses `npm run build`. Está roto durante toda la ola B, a propósito y no por
# tu culpa: T02 saca `byMonth` del contrato y eso rompe FinanzasView.tsx, que sólo
# T06 puede tocar (plan §8, "npm run build no da verde hasta T06").
# esperado: 0 errores fuera de app/(panel)/finanzas/FinanzasView.tsx y page.tsx.
# Si aparece un error en scripts/ o en package.json, ESE sí es tuyo.
```

## 6. Cuándo parar y qué se anota

**Pará y avisá:**

- Si `npm run finance:pagos` deja de funcionar. Borraste o rompiste el script equivocado, y ese es el
  que carga los alquileres y los sueldos automáticos.
- Si el `grep` del §2 encuentra `finance_daily_profit` en un archivo que no es tuyo y que tampoco es
  de T02 ni de T06. Significa que hay un consumidor que el plan no listó.
- Si `deploy/cron.panel` tiene más de una línea de finanzas después de tu cambio, o cero.

**Anotá y seguí:**

- Si el comentario que rodeaba la línea del cron explicaba algo que ahora no aplica y no sabés cómo
  reescribirlo sin inventar.
- El hash del commit donde vivía `scripts/finance-rollup.ts` (`git log --oneline -1 --
  scripts/finance-rollup.ts`): pasáselo a T06, que es quien escribe `registro.md`.
