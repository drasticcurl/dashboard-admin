# T01 — Esquema + queries + cron: la base del módulo Finanzas

- **Depende de:** nada.
- **Bloquea:** T02, T03 (los dos importan `lib/queries/finance.ts`).
- **Se puede correr en paralelo con:** nada. **Corre sola.**
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos que este task puede tocar:** `db/migrations/022_finanzas.sql`,
  `lib/queries/finance.ts`, `lib/queries/finance.test.ts`, `scripts/finance-rollup.ts`,
  `scripts/finance-scheduled-payments.ts`, `scripts/finance-rollup.test.ts`. Nada más.

Leé `00-PLAN-FINANZAS.md` completo antes de arrancar. Tu contrato es el §4 (los tipos y firmas de
`lib/queries/finance.ts`): lo copiás tal cual, no lo "mejorás" — T02 y T03 se escriben contra esa
forma exacta en paralelo con vos.

---

## 1. Objetivo

Cuando termines:

- `db/migrations/022_finanzas.sql` existe, corre limpio y es idempotente sobre una base con
  001-020 aplicadas (ver la nota sobre la 021 en el plan §3 — no es tu problema, no lo arregles).
- `lib/queries/finance.ts` expone exactamente las funciones y tipos del plan §4, con la aritmética
  ya verificada en fase 3.
- Los dos scripts de cron existen, siguen el patrón de `scripts/rollup.ts`, y `npm run
  finance:rollup` / `npm run finance:pagos` (agregalos a `package.json`) los ejecutan.
- `npm test` corre los tests nuevos y pasan.

**Este task no escribe ningún route de API ni ninguna pantalla.** Eso es T02 y T03. No toques
`app/api/**` ni `app/(panel)/**`.

## 2. El esquema — `db/migrations/022_finanzas.sql`

Copiá el contenido de `_schema-022.sql` (en esta misma carpeta) **tal cual, sin retipearlo** — ya
está corrido dos veces contra una base scratch (idempotencia) y las 21 afirmaciones de
`_verificacion-022.sql` dieron el resultado esperado. Es tu fuente de verdad, no la reescribas
"prolijita": cualquier cambio de una coma en un `CHECK` invalida la verificación ya hecha.

La única adaptación que hacés: el archivo de origen no tiene el número de migración en el nombre.
Al copiarlo a `db/migrations/022_finanzas.sql`, el contenido no cambia — sólo el nombre de archivo.

Correlo contra tu base local:

```bash
npm run db:migrate
```

Si tu base local ya tiene 001-021 aplicadas (con `ad_accounts` poblada, que es el caso normal de
cualquier entorno que ya sincronizó anuncios alguna vez), la 022 corre sin problema. Si estás
levantando una base 100% nueva y la 021 aborta por falta de `ad_accounts`, no es un bug de tu
migración — es P-01 del plan, anotado y fuera de tu alcance.

## 3. `lib/queries/finance.ts`

Antes de escribir, **leé `lib/queries/overview.ts` completo** y decí qué patrón copiar: el estilo
de `SUMMARY_SQL` con `COALESCE(SUM(...), 0)` para que un período sin filas dé 0 y no `null`; el
`MONEY()` helper para convertir el `numeric` de vuelta de string a number; el criterio de nunca usar
floats de JS para sumar plata cuando la suma se puede hacer en SQL. Lo que NO copiar: `overview.ts`
resuelve por rango de fechas variable (`?range=`) porque Resumen sí lo necesita — Finanzas no tiene
ese concepto para el patrimonio total (D1: es todo el histórico), así que no le agregues un
parámetro de rango a `getFinanceOverview()`.

Las firmas exactas están en el plan §4. Implementá con estas queries de referencia (ya verificadas
en fase 3):

```sql
-- getFinanceOverview: patrimonio total (verificado #9, #21)
SELECT
  (SELECT COALESCE(SUM(amount_eur), 0) FROM finance_daily_profit) +
  (SELECT COALESCE(SUM(amount_eur), 0) FROM finance_movements) AS patrimonio_total_eur;

-- byMonth: últimos 12 meses, CONTINUOS (verificado #20)
WITH meses AS (
  SELECT generate_series(
    date_trunc('month', now() - interval '11 months'),
    date_trunc('month', now()),
    interval '1 month'
  )::date AS mes
),
profit_mes AS (
  SELECT date_trunc('month', day)::date AS mes, SUM(amount_eur) AS profit
  FROM finance_daily_profit GROUP BY 1
),
mov_mes AS (
  SELECT date_trunc('month', day)::date AS mes, SUM(amount_eur) AS movimientos
  FROM finance_movements GROUP BY 1
)
SELECT to_char(m.mes, 'YYYY-MM') AS month,
       COALESCE(p.profit, 0) AS "profitEur",
       COALESCE(mv.movimientos, 0) AS "movementsEur"
FROM meses m
LEFT JOIN profit_mes p ON p.mes = m.mes
LEFT JOIN mov_mes mv ON mv.mes = m.mes
ORDER BY m.mes;

-- atrasados: pagos activos, día ya pasado, sin run este mes (verificado #16-19)
SELECT sp.*
FROM finance_scheduled_payments sp
WHERE sp.active
  AND sp.day_of_month <= EXTRACT(DAY FROM $1::date)::smallint
  AND NOT EXISTS (
    SELECT 1 FROM finance_scheduled_payment_runs r
    WHERE r.scheduled_payment_id = sp.id AND r.month = to_char($1::date, 'YYYY-MM')
  );
```

**Reglas con el bug que evitan** (además de las 5 numeradas del plan §4):

- `netEur` de cada `MonthlyPoint` se calcula en JS (`profitEur + movementsEur`), NO en SQL: son dos
  CTEs distintas con LEFT JOIN, sumarlas en SQL directamente arrastraría `NULL` si alguna de las dos
  no tiene fila ese mes (el `COALESCE` ya resuelve eso ANTES de sumar, así que sumar en JS después
  del mapeo es más simple y no repite lógica de nulos en dos lugares).
- `createMovement`: el monto que llega del formulario es el valor absoluto que tipeó el usuario
  (nunca negativo desde la UI, ver plan §4 regla 1). La función aplica el signo:
  ```ts
  const signedAmount = input.kind === 'ajuste' ? input.amountEur : -Math.abs(input.amountEur);
  ```
  Para `ajuste`, la UI manda el signo ya puesto (con su propio toggle +/−) porque un ajuste puede
  ir en cualquier dirección y no hay un "valor absoluto" que tenga sentido forzar.
- El `INSERT` de `createMovement` deja que el `CHECK` de la base sea la validación final: si igual
  llega algo con el signo mal (un bug en la UI, un test raro), Postgres lo rechaza con
  `check_violation` y la función traduce ese error a un mensaje legible en vez de dejar pasar el
  error crudo de pg — mismo patrón que `validarCombinacion` en
  `app/api/config/commissions/route.ts`, pero como esta capa es de queries y no de route, el
  mensaje se arma en el `catch` y se relanza como `Error('el monto de un gasto/retiro tiene que ser negativo')`.
- `updateMovement` aplica la MISMA conversión de signo que `createMovement` (plan §4 regla nueva):
  si `input.amountEur` está presente, primero hace `SELECT kind FROM finance_movements WHERE id =
  $1` (el `kind` no se puede editar — el schema de PATCH de T02 ni siquiera lo acepta — así que el
  de la fila existente es el que corresponde), y aplica `input.kind === 'ajuste' ? amountEur :
  -Math.abs(amountEur)` con ESE `kind` antes de armar el `UPDATE`. El formulario de edición de T03
  pide el valor absoluto igual que el de alta: si `updateMovement` no hiciera esta conversión,
  editar un gasto de −500 a "600" (que el usuario tipea pensando en el valor absoluto) lo dejaría en
  +600 en la base, invirtiendo el signo sin que nadie lo note hasta que el patrimonio no cierre.
- `runScheduledPayments(today)`: itera los atrasados UNO POR UNO en un `try/catch` individual (regla
  4 del plan §4). Cada ejecución exitosa hace, dentro de una transacción (`tx()` de `lib/db.ts`):
  1. `INSERT INTO finance_movements (...) VALUES (...) RETURNING id`
  2. `INSERT INTO finance_scheduled_payment_runs (scheduled_payment_id, month, movement_id) VALUES (...)`
  Las dos van juntas en la misma transacción: si el proceso muere entre el paso 1 y el 2, la
  próxima corrida vería el pago como "no ejecutado" (no hay run) e insertaría el movimiento de
  nuevo, duplicando el gasto. Con `tx()`, o se hacen las dos o ninguna.

## 4. Los dos scripts de cron

**Antes de escribir, leé `scripts/rollup.ts` completo.** Copiá: la estructura de `main()` con
parseo de argumentos simple, el `process.loadEnvFile` del principio, el patrón `isMain` con
`pathToFileURL` para que el archivo sea importable desde un test sin disparar la CLI, y el
`.finally(() => getPool().end())`. NO copies la lógica de `--days=` / `--from=` / `--to=`: tus
scripts son más simples (no necesitan rango arbitrario, ver abajo).

```ts
// scripts/finance-rollup.ts
// Sin argumentos: recalcula ayer y hoy (2 días, plan §5 — el profit de "hoy"
// sigue cambiando durante el día).
// Con --all: recalcula desde el primer día que exista en daily_metrics.
export async function financeRollupRange(opts: { from: string; to: string }): Promise<{ rows: number }>;
```

```ts
// scripts/finance-scheduled-payments.ts
// Sin argumentos: ejecuta runScheduledPayments(await today(DASHBOARD_TZ)) y logea el resultado.
// No tiene argumentos de rango: los pagos programados son siempre "a partir de hoy", no hay
// un --from/--to que tenga sentido acá.
```

Agregá a `package.json`:

```json
"finance:rollup": "tsx scripts/finance-rollup.ts",
"finance:pagos": "tsx scripts/finance-scheduled-payments.ts"
```

**No agregues las líneas al crontab** (`deploy/cron.panel`) — eso es T04, que además decide el
orden horario exacto contra el rollup de `daily_metrics` y `fetch-fx`.

## 5. Tests — `lib/queries/finance.test.ts`, `scripts/finance-rollup.test.ts`

Seguí el patrón de `lib/commissions.test.ts` / `lib/costs.test.ts` para las funciones puras, y el de
los tests de integración con `skipIf` cuando no hay `DATABASE_URL` (buscá `skipIf` en el repo para
ver el patrón exacto usado).

Los que importan, con los valores concretos:

1. **El signo se aplica bien en `createMovement`**: `kind: 'gasto', amountEur: 500` → la fila queda
   con `amount_eur = -500.00`. Mismo test para `retiro`. Para `ajuste`, `amountEur: -50` → queda
   `-50.00` tal cual (no se le aplica `Math.abs`).
1b. **El signo se aplica igual en `updateMovement`**: creá un gasto con `amountEur: 500` (queda en
   `-500.00`), después llamá `updateMovement(id, { amountEur: 600 })` y confirmá que la fila queda
   en `-600.00`, NO en `600.00`. Es el test que fija la regla nueva del plan §4 — sin él, un
   refactor futuro que "simplifique" `updateMovement` para que actualice los campos tal cual vienen
   invierte el signo al editar sin que ningún otro test lo note.
2. **`createMovement` con `kind: 'gasto'` y `category: null` falla** con un mensaje entendible (el
   `CHECK` de la base lo rechaza, la función lo traduce). Es el caso borde de D4: sin categoría no
   hay gasto válido.
3. **El caso del `CHECK` de signo violado desde código, no desde SQL crudo**: intentar
   `createMovement({ kind: 'retiro', category: 'otros', ... })` (un retiro con categoría) tiene que
   fallar — es la regla D4 vista desde la capa de TypeScript, no sólo desde el `_verificacion-022.sql`.
4. **`byMonth` con un mes sin ninguna fila en el medio del rango**: sembrá `finance_daily_profit`
   en junio y agosto, nada en julio, y confirmá que `byMonth` devuelve 3 entradas (jun, jul, ago)
   con julio en `profitEur: 0`, no que devuelve 2 entradas. Éste es el test que fija la decisión que
   se verificó en fase 3 (#20) y que un refactor futuro podría romper sin querer si cambia el
   `LEFT JOIN` por un `JOIN`.
5. **`runScheduledPayments` no ejecuta un pago `active: false`** aunque su día ya pasó: sembrá un
   pago pausado con `day_of_month` de hace una semana, corré `runScheduledPayments(hoy)`, confirmá
   `finance_movements` sigue en 0 filas para ese pago.
6. **`runScheduledPayments` ejecutado dos veces el mismo día no duplica el gasto**: corré la función
   dos veces seguidas con el mismo `today`, confirmá que `finance_movements` tiene exactamente 1
   fila para ese pago (no 2) y que la segunda corrida no tira una excepción sin capturar hacia quien
   llama (el resultado puede reportarlo como "ya ejecutado" o simplemente omitirlo de
   `ejecutados`, pero no debe reventar el proceso).
7. **Un pago con un tercer pago activo en el medio que falla no bloquea a los demás**: sembrá 3
   pagos atrasados, hacé que el segundo tenga una `category` que ya no pasa el `CHECK` (forzalo
   insertando directo en la tabla si hace falta, saltando la validación de la función), corré
   `runScheduledPayments` y confirmá que el 1° y el 3° generaron su movimiento igual.

Los que necesitan `DATABASE_URL` se saltean con `skipIf` sin romper el build, igual que el resto del
proyecto — no se borran para que pase el build en un entorno sin Postgres.

## 6. Verificación

Nada de esto es opcional. "Compila" no es verificación.

```bash
# 1 — el esquema corre limpio y dos veces sin romper (idempotencia)
npm run db:migrate
npm run db:migrate                     # esperado: "022_finanzas.sql" NO aparece en la lista de aplicadas la 2da vez

# 2 — build y tests
npm run build                          # esperado: exit 0
npm test                               # esperado: todos los tests nuevos en verde

# 3 — el cron de profit corre a mano y termina con exit 0
npm run finance:rollup
echo "exit: $?"
psql "$DATABASE_URL" -c "SELECT * FROM finance_daily_profit ORDER BY day DESC LIMIT 3;"
# esperado: exit: 0, y 2 filas (ayer y hoy) con amount_eur (puede ser 0.00 si no hay ventas en tu base local)

# 4 — el cron de pagos programados corre a mano y termina con exit 0
npm run finance:pagos
echo "exit: $?"
# esperado: exit: 0, y en stdout algo equivalente a "0 pagos ejecutados" si tu base
# todavía no tiene ningún finance_scheduled_payments cargado (es la primera corrida)

# 5 — las 21 afirmaciones de fase 3 siguen en verde (repetible en cualquier momento)
docker exec panel-db-1 psql -U panel -d postgres -c "DROP DATABASE IF EXISTS panel_finanzas_check;"
docker exec panel-db-1 psql -U panel -d postgres -c "CREATE DATABASE panel_finanzas_check;"
for f in db/migrations/0*.sql; do
  [[ "$f" == *021_reglas_por_cuenta.sql ]] && continue   # ver plan §3 / P-01
  docker exec -i panel-db-1 psql -U panel -d panel_finanzas_check -q -v ON_ERROR_STOP=1 < "$f" || echo "FALLO $f"
done
docker exec -i panel-db-1 psql -U panel -d panel_finanzas_check -v ON_ERROR_STOP=1 < tasks/finanzas/_verificacion-022.sql
docker exec panel-db-1 psql -U panel -d postgres -c "DROP DATABASE panel_finanzas_check;"
# esperado: las 21 secciones imprimen "OK" o el valor exacto documentado en el propio archivo, ninguna imprime "NO DEBERIA LLEGAR ACA"
```

## 7. Cuándo parar

**Bloqueante, pará y avisá:**
- Si alguna de las 21 afirmaciones de `_verificacion-022.sql` no da el resultado documentado: es
  evidencia de que copiaste el esquema distinto a como está, o que tu base scratch tiene un estado
  raro. No sigas: T02 y T03 van a asumir esa aritmética sin volver a chequearla.
- Si necesitás cambiar una firma del contrato §4 del plan porque "no alcanza": pará, anotalo en §10
  del plan, y avisá — cambiarlo en silencio rompe a T02 y T03 que se escriben en paralelo contra lo
  que dejaste congelado.

**Anotalo en §10 del plan y seguí:**
- Cualquier decisión menor de implementación no cubierta acá (nombre exacto de una variable interna,
  por ejemplo) que no cambie ninguna firma pública.
- **Necesitás modificar un archivo ajeno** → nunca; anotalo.
