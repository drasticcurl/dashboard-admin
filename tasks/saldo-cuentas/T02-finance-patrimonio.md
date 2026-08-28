# T02 — `lib/queries/finance.ts`: el patrimonio cambia de fuente

- **Depende de:** T01 (importa de `lib/queries/saldo.ts`).
- **Bloquea:** T06 (consume `FinanceOverview`).
- **Se puede correr en paralelo con:** T03, T04, T05.
- **Archivos que este task puede tocar:** `lib/queries/finance.ts`,
  `lib/queries/finance.test.ts`. **Nada más.**

Leé `00-PLAN-SALDO.md` completo. Tu contrato es el §4, sección "Lo que cambia en
`lib/queries/finance.ts`". Y leé también `lib/queries/saldo.ts`, que T01 ya escribió: es de donde
vas a sacar el patrimonio.

---

## 1. Objetivo

`getFinanceOverview()` deja de sumar dos tablas y pasa a devolver la foto que el usuario midió.

Cuando termines:

- `FinanceOverview` tiene la forma nueva del plan §4, con `patrimonioTotalEur: number | null`.
- `byMonth` y el tipo `MonthlyPoint` **ya no existen**.
- `applySign` maneja el kind `aporte`.
- `npm test` pasa, incluidos los tests viejos que tuviste que reescribir.

**No tocás `lib/queries/saldo.ts`** (es de T01, ya está congelado), ni ningún route, ni ninguna
pantalla.

## 2. Lo que se va

`byMonth`, `MonthlyPoint`, `BY_MONTH_SQL` y `PATRIMONIO_SQL` se borran del archivo.

`PATRIMONIO_SQL` es la línea que este módulo entero existe para derogar:

```sql
-- BORRAR. Es el D1 viejo: el patrimonio como suma de dos tablas.
SELECT (SELECT COALESCE(SUM(amount_eur),0) FROM finance_daily_profit) +
       (SELECT COALESCE(SUM(amount_eur),0) FROM finance_movements) AS patrimonio_total_eur
```

Las dos razones, y la segunda es la que importa: `finance_daily_profit` **ya no existe** (la 028 la
borró, así que esta query directamente falla), y sumarle `finance_movements` a un saldo medido cuenta
cada gasto dos veces (D1 del plan nuevo).

`byMonth` se va porque el gráfico ahora pide `serieDiaria()` / `serieMensual()` a `saldo.ts`. **No
lo reimplementes contra las tablas nuevas**: la serie mensual de este módulo no es una suma de
movimientos, es una ganancia calculada con deltas de patrimonio (D7), y vive en `saldo.ts`.

## 3. Lo que queda

`getFinanceOverview()` sigue existiendo con la misma firma (`Promise<FinanceOverview>`), pero el
cuerpo cambia: en vez de las dos queries de patrimonio, llama a `getSaldoOverview()` de `saldo.ts` y
arma su respuesta con eso.

```ts
export async function getFinanceOverview(): Promise<FinanceOverview> {
  const [saldo, scheduledRows] = await Promise.all([
    getSaldoOverview(),                 // de lib/queries/saldo.ts (T01)
    q<ScheduledRow>(LIST_SCHEDULED_SQL),
  ]);
  const atrasadoIds = await idsAtrasados(saldo.hoyStr);
  // patrimonioTotalEur / desglose / diaPatrimonio salen de saldo.ultimo, que es
  // el ÚLTIMO DÍA COMPLETO. Es null cuando nunca se completó uno (D3), y ese
  // null viaja hasta la pantalla sin convertirse en 0 en el camino.
  ...
}
```

**Lo que NO cambia y no hay que tocar:** `listMovements`, `listScheduledPayments`,
`createMovement`, `updateMovement`, `deleteMovement`, `createScheduledPayment`,
`updateScheduledPayment`, `deleteScheduledPayment`, `runScheduledPayments`, `COND_ATRASADO`,
`hoyEnTz`, `FinanceInputError`. Los pagos programados siguen generando su gasto igual que antes
(criterio de aceptación 9 del plan).

`hoyEnTz()` ahora está duplicada entre `finance.ts` y `saldo.ts`. **Dejala duplicada.** Moverla a
`lib/day.ts` sería lo correcto, pero `lib/day.ts` está en la lista de archivos que nadie toca (§8) y
una task de la ola B no puede cambiar un archivo que las otras tres leen. Si te molesta, va al §10
del plan.

## 4. `applySign` y el kind `aporte`

```ts
export type FinanceMovementKind = 'gasto' | 'retiro' | 'ajuste' | 'aporte';

/**
 * El signo lo pone esta función, no quien la llama. `aporte` es plata que entra
 * desde afuera del negocio: va POSITIVO, y el CHECK de la base lo exige (un
 * aporte negativo se rechaza — para eso está `retiro`).
 */
export function applySign(kind: FinanceMovementKind, amountEur: number): number {
  if (kind === 'ajuste') return amountEur;              // cualquier signo != 0
  if (kind === 'aporte') return Math.abs(amountEur);    // SIEMPRE positivo
  return -Math.abs(amountEur);                          // gasto | retiro
}
```

El orden de los `if` importa: `ajuste` primero porque es el único que respeta el signo que le pasan.

`updateMovement` ya lee el `kind` actual de la fila antes de aplicar el signo (y recalcula contra el
`kind` final si el PATCH lo cambia — está en `registro.md`, entrada del 2026-08-24). **Esa lógica
sirve tal cual para `aporte`**, siempre que uses `applySign` y no un `-Math.abs()` inline. Revisá que
no haya quedado ninguno suelto:

```bash
grep -n "Math.abs" lib/queries/finance.ts
# esperado: sólo dentro de applySign, y el de runScheduledPayments (que genera un
# gasto y por eso es -Math.abs correcto y explícito)
```

Un `ajuste` de +300 que se edita a `aporte` queda en +300; uno que se edita a `gasto` queda en −300.
Ese caso ya tiene un test en `finance.test.ts`: extendelo con `aporte` en vez de escribir otro.

## 5. Tests — `lib/queries/finance.test.ts`

Los tests existentes que asumen el patrimonio-suma **van a fallar, y eso es correcto**. Reescribilos,
no los borres: cada uno prueba una regla que sigue valiendo, sólo cambió de dónde sale el número.

Lo que tiene que quedar cubierto:

1. **`patrimonioTotalEur` es `null` cuando no hay ningún día completo cargado.** Sin saldos, la
   pantalla no puede mostrar 0.
2. **`patrimonioTotalEur` sale del último día COMPLETO**, no del último día con alguna carga. Cargá
   un día completo y después uno incompleto más nuevo: el patrimonio tiene que seguir siendo el del
   día completo, y `diaPatrimonio` tiene que decir ese día.
3. **Un movimiento NO cambia el patrimonio.** Es la regla nueva y la que más contradice lo que el
   archivo hacía: cargá un gasto de 500 y confirmá que `patrimonioTotalEur` no se movió. Si este
   test pasa, D1 está implementado.
4. `faltanCargarHoy` trae los nombres de las cuentas vigentes sin saldo hoy, y está vacío cuando
   están todas.
5. `applySign('aporte', 300) === 300` y `applySign('aporte', -300) === 300`.
6. Un `aporte` creado con `createMovement` queda positivo en la base; un `gasto`, negativo.
7. Los tests de pagos programados (idempotencia, pago pausado, `fallidos`) **siguen pasando sin
   cambios**. Si tuviste que tocarlos, algo se rompió que no debía.

## 6. Verificación

```bash
npm test -- lib/queries/finance.test.ts
# esperado: todos en verde, incluidos los de pagos programados sin modificar

npx tsc --noEmit
# esperado: 0 errores EN lib/. Los errores en app/(panel)/finanzas/FinanzasView.tsx
# y page.tsx por `byMonth` y por `patrimonioTotalEur` posiblemente null son
# ESPERADOS: los arregla T06. No los arregles vos, ese archivo no es tuyo.
#
# NO uses `npm run build`: SOS VOS quien lo rompe para el resto de la ola B, a
# propósito (plan §8, "npm run build no da verde hasta T06"). Es esperado y no hay
# que taparlo.

grep -rn "byMonth\|MonthlyPoint\|finance_daily_profit" lib/
# esperado: ninguna línea

npm test
# esperado: los tests de overview y sales pasan igual que antes (criterio 8 del plan)
```

## 7. Cuándo parar y qué se anota

**Pará y avisá:**

- Si `getSaldoOverview()` no existe o su forma no coincide con el §4 del plan. Significa que T01 no
  terminó o se desvió del contrato: no lo parchees desde acá.
- Si un test de `overview.ts` o `sales.ts` se rompe. Ninguna de sus queries se tocó, así que un
  fallo ahí es una consecuencia que nadie previó y hay que mirarla antes de seguir.

**Anotá y seguí:**

- La duplicación de `hoyEnTz()` entre `finance.ts` y `saldo.ts`.
- Los errores de tipos en `FinanzasView.tsx` (son de T06, esperados).
