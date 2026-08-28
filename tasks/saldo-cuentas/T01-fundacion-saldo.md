# T01 — Migración 028 + `lib/queries/saldo.ts`: la base del módulo

- **Depende de:** nada.
- **Bloquea:** T02, T03, T04, T05 y T06. **Las cinco.**
- **Se puede correr en paralelo con:** nada. **Corre sola.**
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos que este task puede tocar:** `db/migrations/028_saldo_cuentas.sql` (crear),
  `lib/queries/saldo.ts` (crear), `lib/queries/saldo.test.ts` (crear), y **exactamente 2 líneas de
  `lib/queries/finance.ts`** (la excepción declarada del plan §8, ver la sección 3.4 de acá abajo).
  **Nada más.**

Por qué bloqueás a las cinco: T02, T03, T04 y T06 importan de `lib/queries/saldo.ts`; T05 necesita que
`db/migrations/028_saldo_cuentas.sql` exista para que su verificación (el `grep` de
`finance_daily_profit`) dé lo que tiene que dar.

Leé `00-PLAN-SALDO.md` completo antes de arrancar. Tu contrato es el §4: lo copiás **tal cual**, no
lo mejorás. T02, T03 y T04 se escriben contra esa forma exacta al mismo tiempo que vos, y si le
cambiás un nombre de campo las tres se rompen.

---

## 1. Objetivo

Cuando termines:

- `db/migrations/028_saldo_cuentas.sql` existe, corre limpio y es idempotente.
- `lib/queries/saldo.ts` expone **exactamente** los tipos y firmas del plan §4.
- `npm test` corre tus tests y pasan.
- `_verificacion-028.sql` da las 19 afirmaciones documentadas contra una base scratch.

**Este task no escribe ningún route ni ninguna pantalla, y no toca `lib/queries/finance.ts`.** Ese
archivo es de T02, incluso si te parece que le falta algo: eso va al §10 del plan.

## 2. La migración — `db/migrations/028_saldo_cuentas.sql`

Copiá `_schema-028.sql` (en esta misma carpeta) **tal cual, sin retipearlo**. Ya corrió dos veces
contra una base scratch con 001-027 aplicadas y las 19 afirmaciones de `_verificacion-028.sql`
dieron el resultado documentado. Cambiar una coma en un `CHECK` invalida esa verificación.

Tres cosas del archivo que vas a querer "mejorar" y **no**:

1. **El `DROP TABLE finance_daily_profit` del final va ahí.** Es D11 del plan. No lo saques ni lo
   muevas a otra migración.
2. **Los tres `ALTER TABLE finance_movements ... DROP CONSTRAINT / ADD CONSTRAINT` reescriben
   constraints que ya existen**, sobre una tabla que en producción tiene datos. El `DROP ... IF
   EXISTS` seguido de `ADD` es lo que los hace idempotentes; un `ADD CONSTRAINT IF NOT EXISTS` no
   existe en Postgres.
3. **El seed de las 4 cuentas usa `ON CONFLICT DO NOTHING` sin target.** Es a propósito: el índice
   único es funcional (`lower(btrim(name))`), y un `ON CONFLICT (name)` no lo matchea. Verificado en
   `#16`.

```bash
npm run db:migrate            # contra tu base LOCAL
```

## 3. `lib/queries/saldo.ts`

Antes de escribir, **leé `lib/queries/finance.ts` completo**. Lo que hay que copiar de ahí:

- El helper `MONEY = (v: string) => Number(v)` y el `::text` en el SQL. `numeric` vuelve como string
  de `node-pg`; sin el casteo explícito los montos llegan como string y `a + b` los concatena.
- `hoyEnTz()`: la resolución de "hoy" en `DASHBOARD_TZ` con **una query a Postgres**, no con `Date`.
  Copiá esa función, no inventes otra (§4 regla 5).
- El patrón de escribir cada SQL como una `const` con nombre arriba del archivo, y la condición de
  negocio **una sola vez** (el comentario de `COND_ATRASADO` explica por qué: tres copias de una
  regla son tres oportunidades de que una quede vieja).
- `Number(r.id)` en cada conversión: `bigserial` llega como string y comparar contra un `number` da
  siempre `false`.

Lo que **no** copiar: `finance.ts` suma dos tablas para el patrimonio. Eso es exactamente lo que este
módulo deroga (D1).

### 3.1 La query central: patrimonio por día

Es la misma en las tres funciones de lectura, cambia sólo el rango. **Escribila una vez** como una
`const` y reusala. Está verificada en `#7`, `#8`, `#9` y `#12`:

```sql
WITH dias AS (
  SELECT generate_series($1::date, $2::date, interval '1 day')::date AS day
),
vigentes AS (
  -- La vigencia es lo que impide que abrir una cuenta hoy deje incompleto todo
  -- el historial (D6). Sin estas dos condiciones, el gráfico entero desaparece
  -- la primera vez que el usuario crea una cuenta nueva.
  SELECT d.day, a.id, a.kind, a.name
  FROM dias d
  JOIN finance_accounts a
    ON a.opened_on <= d.day
   AND (a.closed_on IS NULL OR d.day <= a.closed_on)
),
cargados AS (
  SELECT v.day, v.kind, v.name, b.amount_eur
  FROM vigentes v
  LEFT JOIN finance_account_balances b
    ON b.account_id = v.id AND b.day = v.day
)
SELECT day::text,
       count(*)::int          AS esperadas,
       count(amount_eur)::int AS cargadas,
       -- El total es NULL, no un parcial, cuando falta una cuenta (D5).
       CASE WHEN count(*) = count(amount_eur) AND count(amount_eur) > 0
            THEN SUM(CASE WHEN kind = 'deuda' THEN -amount_eur ELSE amount_eur END)
            ELSE NULL END::text AS total_eur,
       COALESCE(SUM(amount_eur) FILTER (WHERE kind = 'dinero'),   0)::text AS dinero_eur,
       COALESCE(SUM(amount_eur) FILTER (WHERE kind = 'retenido'), 0)::text AS retenido_eur,
       -- POSITIVO a propósito (§4 regla 6): es "cuánto debemos" para el desglose.
       COALESCE(SUM(amount_eur) FILTER (WHERE kind = 'deuda'),    0)::text AS deuda_eur,
       COALESCE(array_agg(name) FILTER (WHERE amount_eur IS NULL), '{}')   AS faltan
FROM cargados
GROUP BY day
ORDER BY day
```

`count(amount_eur)` cuenta los no-null: es lo que distingue "cargada" de "vigente pero sin cargar".

### 3.2 Cierre mensual y ganancia

Verificada en `#10` y `#11`. El `DISTINCT ON` es lo que toma el último día **completo** del mes, no
el último con datos — en el escenario de prueba agosto cierra el 25 y no el 20, que está incompleto.

```sql
completos AS (          -- filtra los días con total no-null de la query 3.1
  ... HAVING count(*) = count(amount_eur) AND count(amount_eur) > 0
),
cierres AS (
  SELECT DISTINCT ON (date_trunc('month', day))
         date_trunc('month', day)::date AS mes, day AS dia_cierre, total_eur
  FROM completos ORDER BY date_trunc('month', day), day DESC
),
retiros AS (
  SELECT date_trunc('month', day)::date AS mes, SUM(amount_eur) AS retiros_eur
  FROM finance_movements WHERE kind = 'retiro' GROUP BY 1
),
aportes AS (
  SELECT date_trunc('month', day)::date AS mes, SUM(amount_eur) AS aportes_eur
  FROM finance_movements WHERE kind = 'aporte' GROUP BY 1
)
-- ganancia = Δ − retiros − aportes.  Los retiros están guardados NEGATIVOS, así
-- que restarlos los suma de vuelta; los aportes están POSITIVOS, así que
-- restarlos los descuenta. Es D7 y es lo que hace que el número no mienta el mes
-- en que el usuario mete plata de su bolsillo.
SELECT CASE WHEN c.total_eur IS NULL OR cp.total_eur IS NULL THEN NULL
            ELSE c.total_eur - cp.total_eur
                 - COALESCE(r.retiros_eur, 0) - COALESCE(ap.aportes_eur, 0)
       END AS ganancia_eur
FROM meses m
LEFT JOIN cierres c  ON c.mes = m.mes
LEFT JOIN cierres cp ON cp.mes = (m.mes - interval '1 month')::date    -- el mes ANTERIOR (D8)
LEFT JOIN retiros r  ON r.mes = m.mes
LEFT JOIN aportes ap ON ap.mes = m.mes
```

El `LEFT JOIN cierres cp` es contra el **mes calendario anterior**, no contra el cierre previo que
exista: si julio no tiene ningún día completo, la ganancia de agosto es `null` y no se calcula
contra junio. Medir dos meses y llamarlo uno es peor que no mostrar nada.

### 3.3 `guardarSaldosDelDia`

Una transacción para todas las cuentas (§4 regla 1), con `tx()` de `lib/db.ts`. Cada saldo es un
upsert:

```sql
INSERT INTO finance_account_balances (account_id, day, amount_eur, note)
VALUES ($1, $2::date, $3::numeric, $4)
ON CONFLICT (account_id, day)
DO UPDATE SET amount_eur = EXCLUDED.amount_eur, note = EXCLUDED.note
```

Y `amountEur: null` **borra** la fila (`DELETE FROM finance_account_balances WHERE account_id = $1
AND day = $2`), no guarda 0 (§4 regla 2). Por D5, "no hay fila" y "hay una fila en 0" son dos cosas
completamente distintas: la primera es un día incompleto, la segunda es un patrimonio de cero.

Un `CHECK` violado (monto negativo) tiene que salir como `SaldoInputError` con el mensaje de P-02
del plan, **no** como el SQLSTATE crudo. Copiá el patrón de `isCheckViolation` /
`movementErrorMessage` que ya está en `lib/queries/finance.ts`.

### 3.4 Las 2 líneas en `lib/queries/finance.ts` — la excepción declarada

Es el único archivo ajeno que tocás, está autorizado en el §8 del plan, y **el límite es literal: dos
cambios y nada más.**

```ts
export type FinanceMovementKind = 'gasto' | 'retiro' | 'ajuste' | 'aporte';   // ← + 'aporte'

export function applySign(kind: FinanceMovementKind, amountEur: number): number {
  if (kind === 'ajuste') return amountEur;             // el único que respeta el signo que le pasan
  if (kind === 'aporte') return Math.abs(amountEur);   // ← rama nueva: SIEMPRE positivo
  return -Math.abs(amountEur);                         // gasto | retiro
}
```

El orden de los `if` importa: `ajuste` primero, porque es el único que no fuerza el signo.

**Dejá este comentario pegado a los dos cambios**, para que T02 (que es el dueño del archivo) sepa
por qué hay dos líneas que no escribió:

```ts
// Estas dos líneas las escribió T01, no T02: son la excepción declarada del plan
// §8. Van con el CHECK de la migración 028 porque declaran la MISMA regla (un
// aporte es positivo) y separarlas es cómo quedan en desacuerdo. T03 necesita
// este tipo en su misma ola para el zod del route de movimientos.
```

**Por qué esto es tuyo y no de T02:** es la misma regla que el `CHECK` de tu migración. La base dice
que un `aporte` es positivo y el tipo dice lo mismo; declararlos en la misma task es lo que impide que
queden en desacuerdo. Y sobre todo: **T03 necesita ese tipo en su misma ola** — su `zod` tiene que
aceptar `'aporte'`, y si el tipo todavía no lo incluye, `tsc` le falla por un archivo que no puede
tocar.

**No toques nada más de ese archivo.** El patrimonio, `byMonth`, `getFinanceOverview` y los tests son
de T02. Si ves que `PATRIMONIO_SQL` quedó apuntando a una tabla que tu migración borró, **dejalo
así**: T02 lo saca y hasta entonces es un error de tipos esperado.

## 4. Tests — `lib/queries/saldo.test.ts`

Seguí la convención de `lib/queries/finance.test.ts`: `process.loadEnvFile` a mano (vitest no carga
`.env` solo), `describe.skipIf(!dbAvailable)`, día fijo lejos de los datos reales, y aislamiento por
**prefijo en el nombre de la cuenta** (`test-saldo-`) con un `afterEach` que borra por ese prefijo.

Los que no pueden faltar. Los cinco primeros son los que prueban que el módulo no miente:

1. **Un día completo suma con el signo del kind.** 4 cuentas (2 dinero, 1 retenido, 1 deuda) →
   `totalEur = dinero + retenido − deuda`. Usá los números de `#7` para no inventar otro escenario.
2. **Un día al que le falta UNA cuenta devuelve `totalEur: null`** y `faltan` con el nombre de esa
   cuenta. Criterio de aceptación 4 del plan. **Este test es el módulo entero.**
3. **Abrir una cuenta nueva no cambia el patrimonio de los días anteriores** (D6, `#8`). Cargá 3 días
   completos con 4 cuentas, creá una quinta con `openedOn` de hoy, y confirmá que los 3 días siguen
   con el mismo `totalEur`.
4. **`serieMensual` descuenta los aportes** (D7, `#19`): Δ 3500 con 200 de retiro y 3000 de aporte
   → `gananciaEur = 700`, no 3700. Criterio de aceptación 5.
5. **El mes más viejo de la serie tiene `gananciaEur: null`** (D8): sin cierre anterior no hay delta.
6. `guardarSaldosDelDia` con `amountEur: null` borra la fila y el día vuelve a estar incompleto.
7. Un saldo negativo tira `SaldoInputError` con el mensaje de P-02, no un error de Postgres.
8. `serieDiaria` de un mes sin ninguna carga devuelve **todos** los días del mes con `totalEur: null`
   (no un array vacío).
9. `signoDe` (pura, sin base): `signoDe('deuda', 500) === -500`, `signoDe('dinero', 500) === 500`,
   `signoDe('retenido', 500) === 500`.

## 5. Verificación

**No es opcional y "compila" no es verificación.** Corré todo esto y pegá la salida real.

```bash
# 1 — la migración, sobre tu base local
npm run db:migrate
# esperado: la 028 aplicada sin error

# 2 — que finance_daily_profit ya no exista
docker exec panel-db-1 psql -U panel -d panel -tAc \
  "SELECT to_regclass('finance_daily_profit') IS NULL;"
# esperado exactamente: t

# 3 — las 4 cuentas sembradas
docker exec panel-db-1 psql -U panel -d panel -tAc \
  "SELECT count(*) FROM finance_accounts;"
# esperado exactamente: 4

# 4 — idempotencia + las 19 afirmaciones, contra una base SCRATCH (nunca la local con datos)
docker exec panel-db-1 psql -U panel -d postgres -q \
  -c "DROP DATABASE IF EXISTS panel_scratch;" -c "CREATE DATABASE panel_scratch;"
for f in db/migrations/*.sql; do
  [ "$(basename "$f")" = "021_reglas_por_cuenta.sql" ] && continue   # plan §3, preexistente
  docker exec -i panel-db-1 psql -U panel -d panel_scratch -q -v ON_ERROR_STOP=1 < "$f" || echo "FALLO $f"
done
docker exec -i panel-db-1 psql -U panel -d panel_scratch -q -v ON_ERROR_STOP=1 < db/migrations/028_saldo_cuentas.sql
docker exec -i panel-db-1 psql -U panel -d panel_scratch -q -v ON_ERROR_STOP=1 < db/migrations/028_saldo_cuentas.sql
# esperado: las dos corridas sin error (la 2da sólo con NOTICE "already exists, skipping")

docker exec -i panel-db-1 psql -U panel -d panel_scratch -v ON_ERROR_STOP=1 \
  < tasks/saldo-cuentas/_verificacion-028.sql
# esperado: las 19 afirmaciones con los valores escritos al lado de cada bloque.
# Los que más importan:
#   7.  2026-08-20 → patrimonio vacío (null);  2026-08-25 → 11250.00
#   8.  dias_completos_antes_del_10 = 3
#   11. 2026-07 ganancia 2300.00 | 2026-08 ganancia 2150.00 | 2026-06 vacío
#   17. alter = OK, 4 filas antes y 4 después
#   19. ganancia 700.00

docker exec panel-db-1 psql -U panel -d postgres -q -c "DROP DATABASE panel_scratch;"

# 5 — tests y build
npm test -- lib/queries/saldo.test.ts
npm run build
```

## 6. Cuándo parar y qué se anota

**Pará y avisá:**

- Si la migración 028 falla sobre tu base local (que ya tiene datos reales de finanzas). Sobre todo
  si falla en uno de los tres `ALTER ... ADD CONSTRAINT`: significa que hay una fila en
  `finance_movements` que viola el `CHECK` nuevo, y eso es un dato inesperado que hay que mirar
  antes de seguir. **No la arregles borrando la fila.**
- Si alguna de las afirmaciones 7, 8, 11, 17 o 19 da distinto de lo documentado. Son la aritmética
  del módulo: si una falla, el plan está mal y hay que corregir el plan, no el test.
- Si `to_regclass('finance_daily_profit')` sigue devolviendo algo después de migrar.

**Anotá en el §10 del plan y seguí:**

- Un nombre de cuenta del seed que te parezca mal escrito (es P-01, ya está anotado).
- Cualquier función que sientas que le falta al contrato del §4. **No la agregues:** T02/T03/T04
  están escribiendo contra la lista exacta y una función de más no rompe nada, pero una firma
  distinta sí.
