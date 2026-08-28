# T04 — Los tres componentes nuevos: gráfico, carga diaria, cuentas

- **Depende de:** T01, y **sólo de sus tipos** (`import type` desde `lib/queries/saldo.ts`).
- **Bloquea:** T06 (los monta).
- **Se puede correr en paralelo con:** T02, T03, T05.
- **Archivos que este task puede tocar (crear los 5):**
  `app/(panel)/finanzas/GraficoSaldo.tsx`, `CargaDiaria.tsx`, `CuentasSection.tsx`, `serie.ts`,
  `serie.test.ts`. **Nada más.**

Leé `00-PLAN-SALDO.md` completo, sobre todo el §5 (el gráfico) y el §6 (la UI).

**Los tres componentes que escribís no los importa nadie todavía.** T06 los monta en
`FinanzasView.tsx`. No es código muerto: es lo que permite escribir la pantalla y sus piezas al mismo
tiempo. **Cada archivo abre con un comentario en la primera línea diciendo que T06 lo monta**, para
que nadie lo borre creyendo que quedó suelto.

**No toques `FinanzasView.tsx` ni `page.tsx`.** Son de T06. Ni `monto.ts`, que ya existe y ya tiene
tests.

---

## 1. Antes de escribir, leé estos tres

- `app/(panel)/embudo/EmbudoView.tsx`, el bloque del `role="group"` (**hoy arranca en L274**; el
  archivo creció con el Pitch A/B, así que buscá `role="group"` en vez de confiar en el número) — el
  control segmentado con `aria-pressed` que es el patrón del panel para un toggle de dos posiciones.
  Copialo, no inventes.
- `lib/widgets/catalogo-resumen.tsx`, la función `Sparkline` — el único `AreaChart` con
  `type="monotone"` que existe en el repo. Es la base del gráfico nuevo.
- `app/(panel)/finanzas/FinanzasView.tsx` — de dónde salen `inputCls`/`btnCls`/`btnPrimary`/`btnGhost`
  (de `../config/kit`), cómo se importa el parseo de montos (`@/lib/monto`, no `./monto`: se movió en
  el commit `0e151e0`), y el `MovimientoTooltip` que vas a reemplazar por el tuyo. **Leelo pero no lo
  edites.**
- **`lib/paleta.test.ts`** — una guarda NUEVA que te aplica de lleno: barre las clases de color
  literales de `app/`, `components/` y `lib/` y las valida contra `tailwind.config.ts`. Un tono que la
  paleta no define (el caso real fue `hover:text-good-100`, y la escala `good` va de 200 a 600) **no
  rompe la build, no emite CSS y el efecto simplemente no pasa**. Tus tres componentes escriben clases
  de color nuevas: si inventás un tono, este test te lo dice. Corrélo.

## 2. `GraficoSaldo.tsx`

```tsx
export function GraficoSaldo({ diario, mensual }: {
  diario: PuntoDiario[];       // serieDiaria(mesActual): del 1 del mes a hoy, continuo
  mensual: PuntoMensual[];     // serieMensual(12)
}): JSX.Element;
```

Recibe **las dos series ya cargadas por props**. No hace fetch: el toggle no vuelve a pedir nada, y
así el componente es puro y T06 decide cuándo refrescar.

Lo que tiene que cumplir, del §5 del plan:

- **Toggle de dos posiciones**, `Diario (este mes)` / `Mensual`, con `role="group"` y `aria-pressed`.
  Arranca en **Diario** (P-04: el mensual va a estar vacío el primer mes).
- **`AreaChart` con `<Area type="monotone" connectNulls dot>`** dentro de `<ChartFrame alto="md">`.
  `connectNulls` **prendido**: sin eso, un mes con dos cargas aisladas no dibuja nada, porque
  recharts necesita dos puntos adyacentes para trazar un segmento (D12). El `dot` visible es lo que
  distingue el dato medido de la línea que une dos datos.
- **`domain={['auto','auto']}` en el `YAxis`.** Un patrimonio que se mueve entre 8.000 y 8.400 con el
  eje anclado en cero se ve como una recta.
- **Tooltip propio** con `fmtMoney(v,'EUR')`. El `ChartTip` compartido formatea con `fmtInt` y esto es
  plata. En un punto sin dato el tooltip dice **"sin información"**, nunca "0".
- **El eje Y cambia de significado con el toggle** (nivel de patrimonio vs ganancia del mes): el
  título de la card y el subtítulo tienen que decir cuál está activa. Que el botón esté resaltado no
  alcanza.
- **En la vista mensual, una ganancia negativa se dibuja bajo el cero, con el color `bad`.** Un mes en
  pérdida es exactamente lo que hay que ver. Agregá una `<ReferenceLine y={0}>` en esa vista: sin la
  línea del cero, un gráfico con valores negativos no se lee.
- **`EmptyState` en la vista mensual** cuando ningún punto tiene `gananciaEur` (P-04): "todavía no hay
  dos meses cerrados para comparar". Un gráfico en blanco sin explicación es el peor resultado.
- Los colores salen de `panelColors` de `@/tailwind.config` (`good`, `bad`, `axis`), como el resto.

**No dibujes los movimientos.** El pedido fue explícito: sólo saldo. El gráfico viejo tenía dos
barras apiladas (profit + movimientos) y su altura no era el neto; eso se va entero.

## 3. `serie.ts` + `serie.test.ts` — las funciones puras

Todo lo que se pueda calcular sin React va acá, con test sin base. Como mínimo:

```ts
/** '2026-08-05' → '05/08'. La etiqueta del eje en la vista diaria. */
export function etiquetaDia(day: string): string;

/** '2026-08' → '08/26'. La etiqueta del eje en la vista mensual. */
export function etiquetaMes(month: string): string;

/**
 * Qué mostrar cuando el valor es null. Devuelve el texto, no un 0.
 * Existe como función para que no haya dos componentes decidiendo distinto qué
 * dice un día sin carga.
 */
export function textoSinDato(): string;   // 'sin información'

/** La política de los saldos sobre leerNumeroEscrito. Ver §4: acepta el CERO. */
export function parsearSaldo(raw: string): { ok: true; valor: number } | { ok: false; error: string };
```

Los tests de estas cuatro van en `serie.test.ts`. **La extensión importa:** `vitest.config.ts` sólo
incluye `**/*.test.ts` — la variante con `x` al final no la levanta — y el entorno es `node` sin
jsdom, así que **en este repo no se testean componentes de React**.

El caso de `parsearSaldo` que no puede faltar es **`parsearSaldo('0')` → `{ ok: true, valor: 0 }`**,
que es exactamente el que `parsearMonto` rechaza. Más: `'-5'` rechazado por el signo, `'1.000'`
rechazado por ambiguo con las dos lecturas, `'100,50'` → `100.5`, y `'1,234'` rechazado por los 3
decimales.

Casos que no pueden faltar: `etiquetaDia('2026-01-01')` → `'01/01'` (no `'1/1'`), y
`etiquetaMes('2026-12')` → `'12/26'`.

## 4. `CargaDiaria.tsx`

```tsx
export function CargaDiaria({ cuentas, hoy, onGuardado }: {
  cuentas: AccountWithBalance[];   // las vigentes hoy, con el saldo de hoy si ya está
  hoy: string;                     // 'YYYY-MM-DD' en DASHBOARD_TZ, del server
  onGuardado: () => void;          // T06 pasa el router.refresh()
}): JSX.Element;
```

**Un formulario, una fila por cuenta, UN botón.** No cuatro formularios: el usuario carga una vez al
día y, por D5, cargar 3 de 4 no le sirve de nada. El botón manda **todas** las cuentas en un solo
`POST /api/finanzas/saldos` (§4 regla 1: es una transacción).

Detalles que no son cosméticos:

- **El día arranca en `hoy`**, que viene del server. No `new Date()`: un saldo cargado de noche
  quedaría con el día de mañana según la TZ del browser. Es el mismo bug que ya se arregló en el
  formulario de movimientos.
- **Se puede cambiar el día** con un `<input type="date">`, para cargar el saldo de un día que se
  olvidó. Sin límite hacia atrás.
- **El parseo del monto va sobre `leerNumeroEscrito` de `@/lib/monto`, NO sobre `parsearMonto`.**
  Esto es distinto de lo que dice el resto del panel y el motivo es un número: **`parsearMonto`
  rechaza el cero** (`if (n.valor <= 0) return { ok: false, error: 'el monto tiene que ser mayor que
  cero' }`, `lib/monto.ts` L~289). Para un movimiento eso está bien — un gasto de 0 no existe — pero
  **un saldo de 0 es un dato válido y frecuente** (la cuenta está vacía), y el `CHECK` de la base es
  `amount_eur >= 0`. Si usás `parsearMonto` tal cual, una cuenta en cero es imposible de cargar y por
  D5 ese día nunca puede estar completo: el gráfico pierde el punto y nada explica por qué.

  `leerNumeroEscrito` es el núcleo sin política (dice qué número dice un texto y nada más) y la
  política la pone cada pantalla — es exactamente la arquitectura que dejó el commit `0e151e0`
  ("un solo parseo de plata"). Escribí `parsearSaldo` en `serie.ts`, con la política de los saldos:

  ```ts
  /** Como parsearMonto pero acepta el CERO: un saldo de 0 es una cuenta vacía. */
  export function parsearSaldo(raw: string): { ok: true; valor: number } | { ok: false; error: string };
  ```

  Reusá de `parsearMonto` todo lo demás sin cambiarlo: rechazo del signo menos, `"1.000"` rechazado
  como ambiguo con las dos lecturas ofrecidas, y máximo 2 decimales (`numeric(14,2)` los redondearía
  sin avisar). El motivo de que `"1.000"` no se adivine está en `registro.md`, entradas del
  2026-08-24 y del commit `0e151e0`: `Number("1.000")` es `1` y guardaba un euro donde la persona
  quiso mil. **No escribas otro núcleo de parseo**, sólo la política.
- **Una cuenta `deuda` pide el número POSITIVO** ("cuánto debemos") y el `−` se muestra al lado del
  input, fuera de él. Nunca se le pide a la persona escribir un negativo (D4).
- **Un campo vacío es `null`, no 0.** Vaciar el campo de una cuenta ya cargada borra ese saldo. Y un
  `0` tipeado a propósito es un saldo de cero, que es un dato válido. La UI tiene que dejar clara la
  diferencia: el placeholder del campo vacío dice "sin cargar".
- **Al lado del botón, qué falta**, no un botón gris sin motivo. El botón se deshabilita **sólo**
  mientras hay un pedido en vuelo. Un botón gris sin explicación fue el síntoma que se reportó la
  última vez (`registro.md`, 2026-08-24).
- **Mostrá el total que va a quedar** mientras se tipea, con el signo de cada cuenta ya aplicado. Es
  la única forma de que el usuario note que puso un número de más antes de guardar.

## 5. `CuentasSection.tsx`

```tsx
export function CuentasSection({ cuentas, onCambio }: {
  cuentas: FinanceAccount[];       // todas, incluidas las cerradas
  onCambio: () => void;
}): JSX.Element;
```

Tabla con `<Table>` de `components/ui` + formulario de alta/edición, mismo patrón que
`CuentasSection` tiene que seguir de `ComisionesSection.tsx`.

- **La acción principal es CERRAR, no borrar** (D10). "Cerrar" es un `PATCH` con `closedOn`, no
  destruye nada, y la cuenta se puede reabrir.
- **El borrar existe pero detrás de una confirmación que dice qué se lleva:** el route devuelve
  `saldosBorrados`, así que el `confirm()` tiene que decir el número real — "borrar esta cuenta borra
  también sus 47 saldos cargados y cambia el patrimonio de todos esos días". Un `confirm()` genérico
  para una acción que reescribe el historial no alcanza.
- **Cambiar el `kind` de una cuenta con historial también reescribe el patrimonio** de todos sus
  días, y es menos obvio que borrar. El route devuelve `saldosAfectados`: avisalo igual.
- Las cerradas se muestran en la tabla con un `<Badge>` y su `closedOn`, no se esconden. Una cuenta
  que desaparece de la lista es una cuenta que el usuario cree que perdió.

## 6. Verificación

```bash
npx tsc --noEmit
# esperado: 0 errores en tus 5 archivos. Los de FinanzasView.tsx son de T06.

npm test -- app/\(panel\)/finanzas/serie.test.ts
# esperado: todos en verde
```

**No corras `npm run build`.** Está roto durante toda la ola B a propósito: T02 saca `byMonth` del
contrato y eso rompe `FinanzasView.tsx`, que sólo T06 puede tocar (plan §8, "`npm run build` no da
verde hasta T06"). Tus tres componentes sin llamadores **sí** compilan — Next no exige que un
componente esté importado — así que `tsc --noEmit` filtrado a tus archivos es la verificación que te
corresponde.

**Lo que NO podés verificar y tenés que decir que queda pendiente:** el aspecto real del gráfico, que
`connectNulls` haga lo que el plan dice, y la navegación con teclado del toggle. En este repo no hay
jsdom ni testing-library (`vitest.config.ts`: `environment: 'node'`), así que no hay forma de
renderizar un componente en un test. **Decilo explícitamente en tu resumen final como pendiente de
revisión visual; no lo saltees en silencio ni digas que está verificado.**

## 7. Cuándo parar y qué se anota

**Pará y avisá:**

- Si `PuntoDiario` / `PuntoMensual` / `AccountWithBalance` no existen en `lib/queries/saldo.ts` o su
  forma no coincide con el §4. T01 no terminó o se desvió.
- Si te falta un primitivo en `components/ui.tsx`. **No lo agregues:** ese archivo está en la lista
  de los que nadie toca (§8) y tres tasks lo están leyendo. Va al §10 del plan, y mientras tanto
  resolvelo con clases en tu propio archivo.

**Anotá y seguí:**

- Cualquier decisión visual que el plan no cierre (dónde exactamente va el total en vivo, el ancho de
  los inputs).
- Si el `EmptyState` de la vista mensual te parece que debería decir otra cosa.
