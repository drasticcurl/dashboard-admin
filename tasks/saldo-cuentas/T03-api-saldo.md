# T03 — API: cuentas, saldos del día, y `aporte` en movimientos

- **Depende de:** T01 (importa de `lib/queries/saldo.ts`).
- **Bloquea:** T06 (la pantalla llama a estos routes).
- **Se puede correr en paralelo con:** T02, T04, T05.
- **Archivos que este task puede tocar:** `app/api/finanzas/cuentas/route.ts` (crear),
  `app/api/finanzas/saldos/route.ts` (crear), sus `.test.ts`, y
  `app/api/finanzas/movimientos/route.ts` (**sólo** agregar `aporte`). **Nada más.**

Leé `00-PLAN-SALDO.md` completo y `lib/queries/saldo.ts` (T01), que es lo que vas a exponer por
HTTP. Antes de escribir, leé también `app/api/finanzas/movimientos/route.ts` y
`app/api/config/commissions/route.ts` completos: son el patrón de guard, validación y traducción de
errores del proyecto.

---

## 1. Objetivo

Cuando termines:

- `POST/PATCH/DELETE /api/finanzas/cuentas` administra las cuentas.
- `POST /api/finanzas/saldos` guarda los saldos de un día, todos juntos.
- El route de movimientos acepta `kind: 'aporte'`.
- Cada route tiene su guard de auth explícito y sus tests con auth mockeada.

**No tocás `lib/queries/saldo.ts` ni `lib/queries/finance.ts` ni ninguna pantalla.**

## 2. `POST /api/finanzas/saldos` — el más importante

Es el endpoint que el usuario va a usar todos los días. Recibe **el día y todas las cuentas de una
vez**, no una cuenta por llamada.

```ts
const saldosSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  saldos: z.array(z.object({
    accountId: z.number().int().positive(),
    // El valor ABSOLUTO que tipeó el usuario. El signo lo pone el kind de la
    // cuenta al leer (D4) — este route NO lo toca y no lo valida contra el kind.
    // null borra el saldo de esa cuenta ese día (§4 regla 2), y es distinto de 0.
    amountEur: z.number().nonnegative().nullable(),
    note: z.string().max(500).nullable().optional(),
  })).min(1),
});
```

**Una sola llamada con todas las cuentas, y no una por cuenta.** El motivo es §4 regla 1: es una
transacción, y si la tercera cuenta falla no puede quedar un día a medio guardar mientras el usuario
cree que guardó. Con un endpoint por cuenta esa garantía es imposible de dar desde el cliente.

`z.number().nonnegative()` y no `.positive()`: **un saldo de 0 es válido y significativo** (la cuenta
está vacía). Lo que no existe es "no cargué", y eso se expresa con `null`.

Errores que hay que traducir a 400 con mensaje legible, no dejar salir como 500:

| Qué pasó | Qué contesta |
|---|---|
| `SaldoInputError` de `saldo.ts` | 400 con `detail` = el mensaje de la excepción |
| Un `accountId` que no existe | 400, "esa cuenta no existe" |
| Un `accountId` de una cuenta cerrada antes de `day` | 400, "la cuenta X estaba cerrada el <día>" |
| Un monto negativo | 400 con el mensaje de P-02 del plan (cargala como cuenta de tipo deuda) |

El `detail` es el campo que la UI muestra: el helper `api()` de `FinanzasView.tsx` lee
`body.detail ?? body.error`, y `error` es un código estable. Poner el motivo legible sólo en `error`
hace que el banner rojo diga "invalid_payload" — ya pasó, está en `registro.md`.

## 3. `/api/finanzas/cuentas`

`GET` (con `?incluirCerradas=1`), `POST`, `PATCH`, `DELETE`. Firmas en el §4 del plan.

```ts
const cuentaSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['dinero', 'retenido', 'deuda']),
  openedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sortOrder: z.number().int().optional(),
});
```

Tres cosas específicas:

1. **El nombre duplicado sale como 400, no como 500.** El índice único es funcional sobre
   `lower(btrim(name))`, así que "Mercado Pago" y "  mercado pago " chocan (verificado en `#5`).
   Traducilo a "ya existe una cuenta con ese nombre": es el error que el usuario va a ver más seguido
   y el SQLSTATE 23505 no le dice nada.
2. **`PATCH` con `closedOn` es cerrar la cuenta.** No hace falta un endpoint aparte. Y `closedOn:
   null` la reabre. El `CHECK` de la base rechaza un `closedOn` anterior a `openedOn` (`#6`);
   traducilo.
3. **`DELETE` es destructivo y tiene que decirlo en la respuesta.** Se lleva los saldos en cascada y
   cambia el patrimonio histórico (D10, verificado en `#15`). Antes de borrar, contá los saldos y
   devolvelos en la respuesta: `{ ok: true, saldosBorrados: 47 }`. La confirmación en el cliente la
   hace T06, pero el número se lo tenés que dar.

**Cambiar el `kind` de una cuenta con historial reescribe el patrimonio de todos sus días.** Está
permitido (el usuario puede haberse equivocado al crearla) pero es exactamente igual de destructivo
que el `DELETE` y menos obvio. Devolvé también `saldosAfectados` cuando el PATCH cambia `kind`, para
que la UI pueda avisar.

## 4. `aporte` en `/api/finanzas/movimientos`

El cambio es chico y hay que hacerlo en **los dos** schemas, el del POST y el del PATCH:

- `kind` pasa a ser `z.enum(['gasto','retiro','ajuste','aporte'])`.
- La validación de combinación `kind`/`category`: `aporte` va en la rama de "no lleva categoría",
  junto con `retiro` y `ajuste`. Un `aporte` con categoría es 400.
- La validación de signo: el payload de `aporte` manda el valor **positivo**, igual que
  `gasto`/`retiro` mandan positivo. El signo lo pone `applySign` en `lib/queries/finance.ts` (T02),
  no este route.

**El bug que esto evita**, y ya pasó una vez con `ajuste`: el PATCH validaba el monto con
`kind = undefined` (porque `kind` no venía en el body), caía en la rama de gasto/retiro y exigía
positivo — así un ajuste negativo era imposible de editar y daba 400 siempre. Está en `registro.md`,
entrada del 2026-08-24. Si el PATCH no trae `kind`, hay que **leer el de la fila** antes de validar
el signo, no asumir uno.

## 5. Auth

Cada route repite el guard explícito (401 sin cookie), mismo patrón que los routes de finanzas que
ya existen. El middleware además redirige con **307** antes de llegar al route: es el comportamiento
heredado de todo el panel, ya documentado como **P-07 en `tasks/finanzas/00-PLAN-FINANZAS.md` §10**
(el plan del módulo viejo, no el de esta carpeta). **Por eso los tests mockean la auth y no dependen
de un curl sin cookie** — un curl te va a dar 307, no 401, y eso no es un bug tuyo.

## 6. Tests

Convención: un archivo de test junto a cada route, con extensión **`.test.ts`** (nunca la variante
con `x` al final: `vitest.config.ts` sólo incluye `.test.ts`). Auth mockeada.

1. Los 4 métodos de cada route contestan **401 sin cookie**, sin tocar la base.
2. `POST /saldos` con las 4 cuentas guarda las 4 y devuelve el `PatrimonioDia` con `completo: true`.
3. `POST /saldos` con 3 de 4 guarda las 3 y devuelve `completo: false` con `faltan` poblado. **No es
   un error:** guardar parcial está permitido, lo que no está permitido es que el total mienta.
4. `POST /saldos` con un monto negativo → 400 y el `detail` menciona "cuenta de tipo deuda".
5. `POST /saldos` con `amountEur: null` borra el saldo y el día vuelve a `completo: false`.
6. `POST /cuentas` con un nombre que ya existe en otra capitalización → 400, no 500.
7. `PATCH /cuentas` con `closedOn` anterior a `openedOn` → 400.
8. `DELETE /cuentas` devuelve `saldosBorrados` con el conteo real.
9. `POST /movimientos` con `kind: 'aporte'` y monto 3000 guarda +3000.
10. `POST /movimientos` con `kind: 'aporte'` y una `category` → 400.
11. `PATCH /movimientos` que sólo cambia la nota de un `aporte` no toca el signo del monto.

## 7. Verificación

```bash
npm test -- app/api/finanzas
# esperado: todos en verde

npx tsc --noEmit
# esperado: 0 errores en app/api/. Los de app/(panel)/finanzas/FinanzasView.tsx y
# page.tsx son de T06 y NO los arreglás.
#
# NO uses `npm run build`: está roto durante toda la ola B a propósito, porque T02
# saca `byMonth` del contrato y eso rompe FinanzasView.tsx (plan §8, "npm run build
# no da verde hasta T06"). Si lo corrés y falla por ese archivo, no es tu bug.
```

Y con el server de desarrollo levantado a mano y una cookie válida, un round-trip real:

```bash
# guardar los saldos de hoy y leer el patrimonio que devuelve
curl -s -X POST localhost:3000/api/finanzas/saldos \
  -H 'Content-Type: application/json' -b "$COOKIE" \
  -d '{"day":"2026-08-26","saldos":[{"accountId":1,"amountEur":8000},{"accountId":2,"amountEur":1500},{"accountId":3,"amountEur":700},{"accountId":4,"amountEur":1200}]}' | jq
# esperado: completo = true, totalEur = "9000.00"  (8000 + 1500 + 700 − 1200)
```

Pegá la salida real, no la esperada.

## 8. Cuándo parar y qué se anota

**Pará y avisá:**

- Si `saldo.ts` no existe o su firma no coincide con el §4. T01 no terminó.
- Si un `POST /saldos` con las 4 cuentas devuelve `completo: false`. Significa que hay una quinta
  cuenta vigente que no sabías, o que la vigencia (`opened_on`) no está haciendo lo que dice D6. Es
  el bug que rompe el gráfico entero.
- Si `POST /movimientos` con `aporte` da 500 con un error de constraint: la migración 028 no corrió
  o los tres `ALTER` no se aplicaron.

**Anotá y seguí:**

- Cualquier mensaje de error que no puedas traducir a algo legible sin tocar `saldo.ts`.
