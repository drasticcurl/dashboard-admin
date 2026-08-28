# T06 — Ensamblar la pantalla + verificación end-to-end + registro

- **Depende de:** T01 (`getSaldoOverview`, `serieDiaria`, `serieMensual` en `page.tsx`), T02
  (`FinanceOverview`), T03 (los routes que llama la pantalla), T04 (los tres componentes que monta).
  **Las cuatro.**
- **Bloquea:** nada. Es la última.
- **Se puede correr en paralelo con:** nada. **Corre sola y al final.**
- **Archivos que este task puede tocar:** `app/(panel)/finanzas/page.tsx`,
  `app/(panel)/finanzas/FinanzasView.tsx`, `registro.md` (agregar la entrada),
  `tasks/saldo-cuentas/_verificacion-e2e.sh` (crear). **Nada más.**

Leé `00-PLAN-SALDO.md` completo. Sos la única task que ve el módulo entero funcionando, así que sos
la única que puede detectar que dos piezas no encajan. **Si encontrás que no encajan, decilo en vez
de parchearlo desde acá:** un `as any` en `FinanzasView.tsx` para tapar una diferencia entre lo que
T02 devuelve y lo que T04 espera esconde el problema en el peor lugar posible.

---

## 1. Objetivo

Cuando termines, la pantalla `/finanzas` muestra:

1. El **patrimonio medido** con su desglose (`dinero / retenido / deuda`) y de qué día es la foto.
2. Un **banner** cuando faltan cargar saldos hoy, nombrando las cuentas que faltan.
3. El **formulario de carga diaria** (`CargaDiaria` de T04).
4. El **gráfico nuevo** con el toggle Diario/Mensual (`GraficoSaldo` de T04).
5. La **sección de cuentas** (`CuentasSection` de T04).
6. Los movimientos y los pagos programados **igual que antes**, más el tipo `aporte`.

Y el `BarChart` de "Evolución mensual" **ya no existe**.

## 2. `page.tsx`

```tsx
const [overview, movements, scheduled, saldo, diario, mensual] = await Promise.all([
  getFinanceOverview(),        // lib/queries/finance.ts  (T02)
  listMovements({}),
  listScheduledPayments(),
  getSaldoOverview(),          // lib/queries/saldo.ts    (T01)
  serieDiaria(mesActual),      // mesActual = overview.hoy.slice(0, 7)
  serieMensual(12),
]);
```

**`mesActual` sale de `overview.hoy`, que el server resolvió en `DASHBOARD_TZ`.** No de
`new Date().toISOString().slice(0,7)`: el 31 a la noche, en la TZ del browser, eso devuelve el mes
siguiente y el gráfico "diario de este mes" aparecería vacío (§4 regla 5, verificado en `#14`).

Seguí `export const dynamic = 'force-dynamic'`, que ya está, e **ignorá el `?range=`** del
`RangePicker` global, igual que hoy.

## 3. `FinanzasView.tsx` — lo que se borra

- El `import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts'` **entero**. Este
  archivo deja de importar recharts: el gráfico vive en `GraficoSaldo.tsx` (T04).
- El componente `MovimientoTooltip` local.
- La `<Card title="Evolución mensual">` completa con su `BarChart` de dos `<Bar>` apiladas.
- El `import type { MonthlyPoint }`, que T02 ya borró del contrato.

## 4. `FinanzasView.tsx` — lo que se agrega

### 4.1 La card de patrimonio

Reemplaza la que está (la del `div` a mano con `fmtMoney(patrimonioTotalEur,'EUR')`).

- **`patrimonioTotalEur` ahora puede ser `null`.** Cuando lo es, la card dice
  **"sin información — cargá los saldos de hoy"** y **no muestra 0** (D3, D5). El compilador te va a
  obligar a manejar el caso; no lo tapes con `?? 0`, que es exactamente el bug que el tipo previene.
- **Debajo del total, el desglose** `dinero / retenido / deuda`. `deudaEur` viene **positivo** (§4
  regla 6): mostralo con el `−` adelante en la UI, sin `Math.abs()` sobre el total.
- **Decí de qué día es la foto** (`diaPatrimonio`). Un patrimonio sin fecha no significa nada, y si el
  usuario no cargó en tres días, ver "9.300 EUR · al 23/08" es la diferencia entre confiar en el
  número y confiar de más.
- El tono rojo si es negativo, igual que hoy.

### 4.2 El banner de "falta cargar"

Cuando `faltanCargarHoy.length > 0`, un `<Banner tone="warn">` con **los nombres de las cuentas que
faltan** (D9), no un "cargá el saldo" genérico. Por D5, olvidarse una sola cuenta hace perder el punto
del día entero en el gráfico: el banner es lo único que lo evita, así que tiene que ser accionable.

Va **arriba** del banner de pagos atrasados, que sigue igual.

### 4.3 Montar los tres componentes de T04

```tsx
<CargaDiaria cuentas={saldo.cuentas} hoy={saldo.hoyStr} onGuardado={() => router.refresh()} />
<GraficoSaldo diario={diario} mensual={mensual} />
<CuentasSection cuentas={cuentasTodas} onCambio={() => router.refresh()} />
```

Los tres reciben todo por props y avisan con un callback; el `router.refresh()` y los tres
`useEffect` que adoptan las props frescas ya están en el archivo, seguí ese patrón.

### 4.4 `aporte` en el formulario de movimientos

- `KIND_LABEL` gana `aporte: 'Aporte'`; `KIND_TONE`, un tono (`good` es el que corresponde: es plata
  que entra).
- En el `<select>` de tipo y en el filtro de la tabla.
- **`aporte` no lleva categoría**: el campo desaparece al elegirlo, igual que ya pasa con `retiro` y
  `ajuste`.
- **El monto se tipea positivo**, sin el toggle `+/−` del ajuste. El signo lo pone `applySign` en el
  server.
- Al lado de la opción, una ayuda de una línea: **"plata que entra desde afuera del negocio; se
  descuenta de la ganancia del mes"**. Sin eso nadie va a saber cuándo usar `aporte` en vez de
  `ajuste`, y elegir mal rompe la ganancia mensual (D7) sin que nada avise.

## 5. `_verificacion-e2e.sh`

Un script bash que corre contra la base **local** y prueba el flujo completo. Tiene que probar, como
mínimo, estas cinco (las tres primeras son las que ninguna task anterior pudo probar sola):

1. **Cargar las 4 cuentas de un día → el patrimonio del día es la suma con el signo de la deuda.**
   Con números concretos y el esperado escrito al lado.
2. **Borrar el saldo de UNA cuenta → el patrimonio de ese día pasa a `null`** y el banner de faltantes
   la nombra. Es D5 end-to-end.
3. **Cargar dos meses cerrados + un retiro + un aporte → la ganancia del segundo mes descuenta los
   dos.** Reusá los números de `#19` del archivo de verificación (Δ 3500, retiro 200, aporte 3000 →
   **700**), así el esperado ya está probado.
4. **Correr `npm run finance:pagos` dos veces el mismo día no duplica el gasto.** El módulo viejo
   sigue teniendo que funcionar; es criterio de aceptación 9.
5. **`getOverviewData` y `getSalesData` devuelven los mismos números que antes del módulo.** Criterio
   8. Guardá los valores antes de tocar nada y comparalos.

Cada bloque cierra con `# esperado exactamente: <valor concreto>` — un número, un conteo o un string
textual. Una expectativa en prosa no se puede chequear y no cuenta como verificación.

## 6. `registro.md` — la entrada

Va **arriba**, con la fecha y el hash del commit. Las tres preguntas de
`.kiro/steering/registro.md`, y cuatro cosas que **no pueden faltar** porque son las que nadie va a
poder reconstruir después:

1. **Que no había ninguna sincronización de saldo con cuentas publicitarias que sacar.** Lo que había
   era `finance_daily_profit` calculándose desde `daily_metrics`, que incluye `ad_spend_eur` de Meta.
   Sin esto anotado, el próximo que lea "no sincronizar el saldo con las cuentas publicitarias" va a
   salir a buscar un fetch a Graph API que nunca existió.
2. **El patrimonio viejo y el primero nuevo, los dos números, uno al lado del otro** (P-03). Es el
   único registro de por qué la pantalla saltó de un número a "sin información". El valor viejo lo
   saca el runbook antes de migrar (T05 §3).
3. **El hash del commit donde vivía `scripts/finance-rollup.ts`** (te lo pasa T05). Sin ese hash, el
   paso 3 de "cómo revertir" del plan §3 es una búsqueda a ciegas.
4. **Qué se decidió NO hacer:** que `finance_movements` deja de sumar al patrimonio a propósito (no es
   un bug), que `ajuste` queda sin función real y se dejó igual (P-05), y que una cuenta `dinero` en
   descubierto no se puede tipear a propósito (P-02). Los tres son cosas que alguien va a querer
   "arreglar" dentro de tres meses.

También anotá que el **gráfico viejo no era de velas**: eran dos `<Bar>` apiladas cuya altura no era
el neto, y por eso se leía raro. Es la clase de detalle que explica el pedido original.

## 7. Verificación

```bash
npx tsc --noEmit
# esperado: 0 errores en TODO el repo. Sos la última task: si acá queda algo, queda roto.

npm test
# esperado: la suite completa en verde. El BASELINE contra el que comparás es
# 1208 passed | 46 skipped en 97 archivos (el del commit 0e151e0). Si el total de
# passed BAJA, algo que funcionaba dejó de funcionar; que suba es lo esperado
# (los tests nuevos de este módulo).

npm test -- lib/paleta.test.ts
# esperado: verde. Es la guarda de tokens de color: valida las clases literales de
# app/, components/ y lib/ contra tailwind.config.ts. Los 3 componentes de T04
# escribieron clases nuevas, y un tono inexistente (como el hover:text-good-100
# que se encontró) no rompe la build ni emite CSS — sólo lo ve este test.

npm run build

bash tasks/saldo-cuentas/_verificacion-e2e.sh
# esperado: cada bloque con el valor documentado al lado

grep -rn "recharts" app/\(panel\)/finanzas/FinanzasView.tsx
# esperado: ninguna línea (el gráfico vive en GraficoSaldo.tsx)

grep -rn "byMonth\|MonthlyPoint\|Evolución mensual" app/ lib/
# esperado: ninguna línea
```

**Revisión visual en el browser: la hace el usuario a mano.** Levantá el server, dejale la lista de
qué mirar y **decí que queda pendiente** — no la declares hecha:

- Cargar los 4 saldos y ver el patrimonio con su desglose.
- Borrar uno y ver que el patrimonio dice "sin información" y el banner nombra la cuenta.
- El toggle del gráfico con teclado (Tab + Enter), y que el título diga cuál vista está activa.
- Un mes con dos cargas aisladas: que la línea se dibuje entre los dos puntos y no desaparezca (D12).
- Cargar un `aporte` y ver que la ganancia del mes **no** sube por eso.

## 8. Cuándo parar y qué se anota

**Pará y avisá:**

- Si `FinanceOverview` (T02) y lo que `GraficoSaldo`/`CargaDiaria` (T04) esperan no encajan. **No
  adaptes con `as any` ni con un mapeo silencioso:** es una diferencia entre dos tasks y hay que
  decidirla, no taparla.
- Si el punto 5 del e2e falla, o sea si `getOverviewData`/`getSalesData` cambiaron. Ninguna de sus
  queries se tocó: un cambio ahí es un efecto colateral que nadie previó y es el criterio de
  aceptación 8.
- Si al cargar un `aporte` la ganancia del mes sube en vez de quedar igual. La fórmula está al revés
  en algún lado y es el bug que `aporte` existe para evitar.
- Si `patrimonioTotalEur` llega como `0` en vez de `null` con la base vacía. Alguien puso un `?? 0`.

**Anotá y seguí:**

- Detalles visuales que el plan no cierra.
- Lo que no pudiste verificar sin un browser (que es todo el punto anterior de revisión visual).
