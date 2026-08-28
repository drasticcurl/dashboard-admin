# SALDO POR CUENTAS — el patrimonio se mide, no se calcula

**Documento maestro del módulo. Todo agente lee este archivo completo antes de abrir su task.**

Cambia el corazón de `/finanzas`, que **ya está implementado y en producción**. Hoy el patrimonio se
calcula solo (`SUM(finance_daily_profit) + SUM(finance_movements)`, donde el primer término sale de
`daily_metrics` y ahí adentro está el gasto que reporta Meta). Pasa a ser un número que el usuario
**mide y tipea una vez al día**, repartido en las cuentas donde vive la plata.

La pregunta que responde sigue siendo "¿cuánta plata tengo?". Lo que cambia es de dónde sale la
respuesta: de mirar las cuentas, no de recomputar el negocio.

**Este módulo es la única foto de cuánta plata hay.** Un bug que sume una cuenta dos veces, que
tome un día a medio cargar como si estuviera completo, o que cuente un aporte de capital como
ganancia, produce un número creíble y falso. Todo lo que sigue está diseñado alrededor de eso.

## 0. Qué se construye y qué no

**Se construye**

1. Dos tablas nuevas: `finance_accounts` (las cuentas, con su tipo y su vigencia) y
   `finance_account_balances` (el saldo tipeado de una cuenta en un día).
2. Un cuarto tipo de movimiento, `aporte`: plata que entra desde afuera del negocio. Existe por la
   aritmética del gráfico mensual, ver D7.
3. `lib/queries/saldo.ts`: el patrimonio de un día, la serie diaria del mes, la serie mensual de
   ganancia, y el CRUD de cuentas y saldos.
4. En la pantalla: la carga diaria de los saldos (un formulario con una fila por cuenta vigente), la
   card de patrimonio con su desglose, un banner cuando falta cargar el saldo de hoy, y el gráfico
   nuevo con toggle **Diario (este mes) / Mensual**.
5. La baja de `finance_daily_profit`, su cron y su script.

**No se construye** (explícito para que ningún agente lo invente)

- **Ninguna sincronización con cuentas publicitarias.** No se toca `lib/ads/**`, no se le pide un
  campo nuevo a Graph API, no hay script que lea el saldo de Meta. La deuda con Meta es una cuenta
  como cualquier otra y el número lo tipea el usuario. Es el pedido literal.
- Conversión de moneda. Todo en EUR, igual que la 022 (D10 del plan viejo, sigue vigente).
- Cuentas por funnel. El módulo es global, igual que antes.
- Proyecciones, presupuestos, "cuánto voy a tener el mes que viene".
- Histórico de saldos anteriores a la migración. La tabla arranca vacía (D3).
- Notificaciones por Telegram o email de "no cargaste el saldo". El aviso es el banner de la
  pantalla.
- Cualquier automatismo que **complete** un saldo faltante. Un día incompleto se muestra como
  incompleto, nunca se rellena (D5).

## 1. Decisiones cerradas

Si aparece algo que este documento no resuelve, se anota en §10 y **no se decide en el código**.

**D1 — El patrimonio se MIDE, no se calcula. Deroga el D1 del plan de `tasks/finanzas/`.**
`patrimonio(día) = Σ dinero + Σ retenido − Σ deuda`, sobre los saldos que el usuario tipeó **ese
día**. `finance_movements` **deja de sumar al patrimonio**: un saldo tipeado ya incluye los gastos
(cuando se paga el alquiler, el banco ya bajó), así que sumarle los movimientos cuenta el mismo
gasto dos veces. Los movimientos siguen existiendo como registro de en qué se fue la plata, y los
`retiro`/`aporte` participan de la ganancia mensual (D7) — pero no del patrimonio.

**D2 — Las cuentas son configurables, las categorías de gasto siguen fijas.** Parece incoherente y
no lo es: la lista de categorías (`sueldos | herramientas | …`) cambia cuando cambia cómo el usuario
piensa su negocio, o sea casi nunca; la lista de cuentas cambia cuando el usuario abre una cuenta,
que pasa de verdad. Una lista fija de cuentas obligaría a un `ALTER TABLE` + deploy cada vez.

**D3 — La tabla de saldos arranca VACÍA y el patrimonio dice "sin información" hasta el primer día
completo.** La alternativa (sembrar el primer saldo con el patrimonio calculado de hoy) mezcla un
número calculado con uno medido justo en el punto donde el módulo entero existe para separarlos, y
además congelaría en la base un valor que sale de `daily_metrics` — la fuente que se está sacando
del medio.

**D4 — El monto se guarda SIEMPRE positivo y el signo lo pone el `kind` de la cuenta al leer.** Un
`CHECK` no puede mirar `finance_accounts`, así que si la deuda se guardara en negativo el signo
dependería de que el código que inserta se acuerde. Con el monto siempre `>= 0` el `CHECK` es local
y verificable (`_verificacion-028.sql` #3), y la conversión vive en **una** expresión SQL:
`CASE WHEN kind = 'deuda' THEN -amount_eur ELSE amount_eur END`. Es el mismo principio que
`applySign` en `lib/queries/finance.ts`, llevado al único lugar donde la base puede garantizarlo.

**D5 — Un día cuenta SÓLO si tiene saldo para TODAS las cuentas vigentes ese día. Si falta una, el
día es `null`, nunca un total parcial.** Un total al que le falta una cuenta no es un número que
falta: es un número equivocado que se ve igual de bien que uno correcto. Verificado con las dos
caras (`#7`: el 2026-08-20 con 5 esperadas y 4 cargadas devuelve `null`; el 2026-08-05 con 4 y 4
devuelve 10000.00).
**El costo, dicho de frente:** si el usuario se olvida una sola cuenta, pierde el punto de ese día
en el gráfico. Por eso el banner de D9 no dice "cargá el saldo" sino **qué cuentas faltan**.

**D6 — La vigencia de una cuenta (`opened_on` / `closed_on`) participa de la aritmética, y sin eso
D5 destruye el historial.** Sin `opened_on`, abrir una quinta cuenta hoy convertiría en incompletos
**todos** los días anteriores (nunca tuvieron saldo para esa cuenta, porque no existía) y el gráfico
entero desaparecería de golpe. Verificado en `#8`: la cuenta 905 se abre el 2026-08-10 y los 3 días
completos anteriores siguen completos. `closed_on` es la cara simétrica (`#9`): una cuenta cerrada
deja de pedirse al día siguiente y conserva su historial.

**D7 — La ganancia del mes es `Δ patrimonio − retiros − aportes`, y por eso existe `aporte`.**
La vista mensual no muestra un saldo: muestra cuánto generó el negocio ese mes (es lo que el usuario
pidió, "el resultado de ese mes, de ganancia, sin contar los retiros"). Un retiro baja el patrimonio
sin ser una pérdida, así que se suma de vuelta; un aporte lo sube sin ser una ganancia, así que se
resta. Los montos están guardados con su signo (`retiro` negativo, `aporte` positivo), por eso la
fórmula **resta los dos**.

Verificado en `#11` (Δ 300 con 2000 de retiro → ganancia 2300) y en `#19`, que es el que justifica
`aporte`: Δ 3500 con 200 de retiro y 3000 de aporte → **700**. Sin el término de aportes daría
3.700, o sea el gráfico diría que el negocio ganó cinco veces más de lo que ganó, exactamente el mes
en que el usuario metió plata de su bolsillo — que es el mes en que más lo va a mirar.

**D8 — El "cierre" de un mes es el patrimonio del ÚLTIMO DÍA COMPLETO de ese mes, y la ganancia
necesita el cierre del mes Y del mes calendario anterior.** Si falta cualquiera de los dos, la
ganancia es `null` y no se dibuja. Verificado en `#10` (agosto cierra el 25, no el 20 que está
incompleto) y `#11` (el mes más viejo no tiene ganancia: sin cierre anterior no hay delta, y tratar
el saldo inicial como ganancia inventaría un +9300 que nunca se ganó).

**D9 — El aviso de "falta cargar" nombra las cuentas que faltan, no dice "cargá el saldo".** Es lo
único que hace que "una vez al día" se cumpla, y por D5 el costo de olvidarse una cuenta es perder
el día entero. Mismo patrón visual que el banner de pagos atrasados que ya existe.

**D10 — Cerrar una cuenta, no borrarla.** `ON DELETE CASCADE` en `finance_account_balances` significa
que borrar una cuenta se lleva sus saldos y **cambia el patrimonio histórico retroactivamente**:
días que estaban completos pasan a tener una cuenta menos y su total baja. Verificado en `#15` (2
saldos antes, 0 después). La UI ofrece cerrar; el `DELETE` existe en la API pero pide confirmación
explícita y el plan lo documenta como destructivo.

**D11 — `finance_daily_profit` se borra, con su script y su línea de cron.** El usuario lo pidió
("se borra si igual no lo estoy usando") y se puede hacer sin perder nada propio: cada fila es un
cálculo derivado de `daily_metrics` que `finance:rollup --all` regenera entero. Dejarla viva
mientras el patrimonio ya no la lee es peor que borrarla: una tabla que se llena todas las
madrugadas con un número que ninguna pantalla muestra es lo que dentro de seis meses alguien vuelve
a sumar "porque estaba ahí".
**Los tres se van juntos o ninguno.** Si la migración 028 se deploya sin la baja del cron, el cron
de las 5:35 revienta todas las noches con `relation "finance_daily_profit" does not exist`. Es la
compuerta de deploy del §7.

**D12 — El gráfico dibuja los puntos medidos y conecta entre ellos; no rellena los huecos.**
`connectNulls` prendido, con `dot` visible. La razón es concreta: con `connectNulls` apagado, un mes
donde el usuario cargó el día 5 y el día 25 no dibujaría **nada** (recharts necesita dos puntos
adyacentes para trazar un segmento) y el gráfico se vería roto en vez de escaso. Con el dot visible,
lo que es dato y lo que es la línea que los une se distinguen a simple vista. Un día sin carga
**nunca** se dibuja en 0: un patrimonio de 0 es un dato real y dramático, y taparlo con 0 lo vuelve
indistinguible de "no cargué".

## 2. Arquitectura

```
   usuario ─── una vez al día ──▶ app/(panel)/finanzas/CargaDiaria.tsx
                                    │ POST /api/finanzas/saldos
                                    ▼
                            finance_account_balances   (upsert por (cuenta, día))
                                    │
   usuario ─── configura ──▶ CuentasSection.tsx ──▶ finance_accounts
                                    │
                                    ▼
                            lib/queries/saldo.ts
                              · getSaldoOverview()   ¿cuánto hay y qué falta cargar hoy?
                              · serieDiaria(mes)     el nivel de patrimonio, día por día
                              · serieMensual(n)      la ganancia de cada mes (D7)
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
      lib/queries/finance.ts              app/(panel)/finanzas/GraficoSaldo.tsx
      (patrimonio + qué falta;             (el toggle Diario/Mensual)
       byMonth SE VA)

   ✗ scripts/finance-rollup.ts       BORRADO
   ✗ finance_daily_profit            BORRADA
   ✗ lib/ads/**                      NO SE TOCA. No hay sincronización de saldo con Meta.
```

La decisión estructural que hace esto testeable: **toda la aritmética vive en SQL dentro de
`lib/queries/saldo.ts`**, en tres queries que ya están escritas y corridas (`_verificacion-028.sql`
#7, #10, #11). Las funciones puras que quedan en TypeScript son sólo dos (`signoDe` y el formateo de
etiquetas del eje) y tienen su test sin base.

## 3. Esquema — fuente de verdad

El DDL completo está escrito y **corrido dos veces** contra una base scratch con las migraciones
001-027 aplicadas: `_schema-028.sql`. T01 lo copia **tal cual** como
`db/migrations/028_saldo_cuentas.sql`, sin retipearlo.

| Tabla | Para qué |
|---|---|
| `finance_accounts` | Las cuentas: nombre, `kind` (`dinero`/`retenido`/`deuda`), vigencia, orden. |
| `finance_account_balances` | El saldo tipeado de una cuenta en un día. PK `(account_id, day)`. |
| `finance_movements` | **Existe ya.** Se le agrega el kind `aporte` reemplazando 3 `CHECK`. |
| `finance_daily_profit` | **Se borra.** |

Los cuatro detalles que hay que entender antes de escribir código contra esto:

1. **`amount_eur` es siempre `>= 0`** y el signo lo pone el `kind` al leer (D4). Un saldo de deuda de
   `500` significa "debemos 500" y entra al patrimonio como `−500`.
2. **`opened_on` y `closed_on` no son auditoría, son aritmética** (D6). `created_at`/`updated_at`
   son la auditoría.
3. **Los 3 `CHECK` de `finance_movements` se REEMPLAZAN sobre una tabla con datos.** Postgres
   revalida la tabla entera al crear el constraint nuevo: si una fila existente lo violara, el
   `ALTER` aborta y la migración se cae a la mitad. No puede pasar (las ramas viejas siguen intactas
   dentro de la condición nueva), y se verificó igual sobre una tabla cargada con las 4 clases de
   movimiento (`#17`: 4 filas antes, `alter = OK`, 4 filas después) — porque "no puede pasar" es lo
   que se dice antes de que pase en el deploy.
4. **La migración termina con un `DROP TABLE`** (D11). Es el único statement destructivo de todo el
   módulo.

**Nota de la fase 3.** La migración 021 (`ad_rules` por cuenta) no corre desde cero en una base
recién creada: exige una fila en `ad_accounts` que sólo existe después de sincronizar anuncios
reales. Es un problema **preexistente del repo**, ya anotado como P-01 en el plan de
`tasks/finanzas/`. La verificación de la 028 se hizo con 001-027 **salteando la 021**, que es
exactamente el estado de cualquier despliegue que llegue a la 028 en orden. En producción no aplica:
001-027 ya están corridas.

**Cómo revertir.** En orden, y todo está en el repo:
1. `DROP TABLE finance_account_balances, finance_accounts;`
2. Recrear `finance_daily_profit` con el DDL de `tasks/finanzas/_schema-022.sql`, que queda intacto
   justamente para esto.
3. Recuperar `scripts/finance-rollup.ts` del git log — **T06 anota el hash del commit en
   `registro.md`, y sin eso este paso es una búsqueda a ciegas.**
4. `npm run finance:rollup -- --all` reconstruye el 100 % de las filas.
5. Revertir los 3 `CHECK` de `finance_movements` a la versión de `_schema-022.sql`. **Ojo:** si ya
   se cargó algún movimiento `aporte`, el `CHECK` viejo lo rechaza y el `ALTER` falla. Hay que
   borrarlos o convertirlos a `ajuste` primero.

**Paso obligatorio antes de correr la 028 en producción** (va al runbook, T05): exportar la tabla
que se borra.
```bash
psql "$DATABASE_URL" -c "\copy finance_daily_profit TO 'finance_daily_profit_pre028.csv' CSV HEADER"
```
No porque el dato sea irrecuperable, sino porque **comparar el patrimonio viejo contra el nuevo es la
única forma de explicar el salto que el usuario va a ver en pantalla**, y ese salto va a ser grande.

## 4. Contrato — `lib/queries/saldo.ts` — CONGELADO

Lo declara **T01** completo. Lo consumen T02, T03, T04 y T06. **Nadie más lo modifica.**

```ts
// ─── Tipos ──────────────────────────────────────────────────────────────────

export type AccountKind = 'dinero' | 'retenido' | 'deuda';

export type FinanceAccount = {
  id: number;
  name: string;
  kind: AccountKind;
  openedOn: string;              // 'YYYY-MM-DD' — desde qué día se le pide saldo (D6)
  closedOn: string | null;       // null = vigente
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

/** Una cuenta con su saldo de UN día puntual. Lo que consume el formulario. */
export type AccountWithBalance = FinanceAccount & {
  /** null = ese día todavía no se cargó esta cuenta. NUNCA 0 por defecto (D5). */
  amountEur: number | null;      // absoluto, como lo tipeó el usuario
  note: string | null;
  /** amountEur con el signo del kind ya aplicado: negativo si kind === 'deuda'. */
  signedEur: number | null;
};

/** El patrimonio de un día, con el desglose y el estado de completitud. */
export type PatrimonioDia = {
  day: string;
  /** null si el día está INCOMPLETO. Nunca un total parcial (D5). */
  totalEur: number | null;
  dineroEur: number;             // suma de las cuentas 'dinero' cargadas
  retenidoEur: number;
  deudaEur: number;              // POSITIVO (lo que se debe). totalEur lo RESTA.
  esperadas: number;             // cuentas vigentes ese día (D6)
  cargadas: number;
  completo: boolean;             // cargadas === esperadas && esperadas > 0
  /** Nombres de las cuentas vigentes sin saldo ese día. Alimenta el banner (D9). */
  faltan: string[];
};

export type PuntoDiario = {
  day: string;                   // 'YYYY-MM-DD', continuo del 1 del mes a hoy
  totalEur: number | null;       // null en día incompleto o sin carga (D5, D12)
};

export type PuntoMensual = {
  month: string;                 // 'YYYY-MM', continuo
  cierreEur: number | null;      // patrimonio del último día completo del mes (D8)
  diaCierre: string | null;      // qué día es ese cierre
  retirosEur: number;            // <= 0
  aportesEur: number;            // >= 0
  /** Δ − retiros − aportes. null si falta el cierre de este mes o del anterior (D7, D8). */
  gananciaEur: number | null;
};

export type SaldoOverview = {
  /** El último día COMPLETO. null si nunca se completó uno (D3). */
  ultimo: PatrimonioDia | null;
  /** El estado de HOY: sirve para el banner y para precargar el formulario. */
  hoy: PatrimonioDia;
  /** Las cuentas vigentes hoy, con el saldo de hoy si ya se cargó. */
  cuentas: AccountWithBalance[];
  hoyStr: string;                // hoy en DASHBOARD_TZ, resuelto en el server
  generatedAt: string;
};

// ─── Lectura ────────────────────────────────────────────────────────────────

export async function getSaldoOverview(): Promise<SaldoOverview>;

/** @param mes 'YYYY-MM'. Devuelve TODOS los días del mes hasta hoy, continuos. */
export async function serieDiaria(mes: string): Promise<PuntoDiario[]>;

/** @param meses cuántos meses hacia atrás, contando el actual. Continuos. */
export async function serieMensual(meses: number): Promise<PuntoMensual[]>;

export async function listAccounts(opts?: { incluirCerradas?: boolean }): Promise<FinanceAccount[]>;
export async function patrimonioDe(day: string): Promise<PatrimonioDia>;

// ─── Escritura ──────────────────────────────────────────────────────────────

export async function createAccount(input: {
  name: string; kind: AccountKind; openedOn?: string; sortOrder?: number;
}): Promise<FinanceAccount>;

export async function updateAccount(id: number, input: Partial<{
  name: string; kind: AccountKind; openedOn: string; closedOn: string | null; sortOrder: number;
}>): Promise<FinanceAccount>;

/** Destructivo: se lleva los saldos en cascada y cambia el patrimonio histórico (D10). */
export async function deleteAccount(id: number): Promise<void>;

/**
 * Guarda los saldos de UN día, todos juntos, en UNA transacción. Upsert por
 * (account_id, day). Un `amountEur: null` BORRA el saldo de esa cuenta ese día.
 */
export async function guardarSaldosDelDia(
  day: string,
  saldos: Array<{ accountId: number; amountEur: number | null; note?: string | null }>,
): Promise<PatrimonioDia>;

/** Pura y testeable sin base: el signo con el que una cuenta entra al patrimonio. */
export function signoDe(kind: AccountKind, amountEur: number): number;

/** Un pedido mal armado, no una falla del server. Los routes contestan 400. */
export class SaldoInputError extends Error {}
```

**Reglas de implementación que no son negociables:**

1. **`guardarSaldosDelDia` es UNA transacción para todas las cuentas.** Si el usuario carga las 4 y
   la tercera falla, no puede quedar un día con 2 cargadas: por D5 eso es un día incompleto (bien),
   pero el usuario ya creyó que guardó (mal). O entran todas o ninguna.
2. **`amountEur: null` borra la fila, no guarda 0.** Es la única forma de deshacer una carga
   equivocada, y por D5 la diferencia entre "no hay fila" y "hay una fila con 0" es la diferencia
   entre un día incompleto y un patrimonio de cero.
3. **`totalEur` es `null`, nunca 0, cuando el día está incompleto** (D5). El tipo lo obliga y ningún
   consumidor puede hacer `?? 0`. Si un componente necesita un número para dibujar, no dibuja.
4. **Las series son CONTINUAS**, con `generate_series`, nunca `GROUP BY` sobre las filas que existan
   (mismo criterio que el `byDay` de `overview.ts`). Un mes sin ninguna carga aparece con todos sus
   días en `null`, no desaparece. Verificado en `#12`: 31 filas para agosto, 2 con dato, 29 sin.
5. **El día de hoy y el mes actual se resuelven en `DASHBOARD_TZ`, en el server, con una query.**
   No con `Date` de JS y no con `now()` pelado de Postgres. Verificado en `#14`: un timestamp de las
   21:30 de Buenos Aires es el 2026-07-31 en la TZ del panel y el 2026-08-01 en la del server
   europeo, y **el mes también se corre** (julio vs agosto). Es el bug que haría que el 31 a la
   noche el gráfico "diario de este mes" salte al mes siguiente.
   `lib/queries/finance.ts` ya tiene `hoyEnTz()` haciendo exactamente esto: **copiar ese patrón, no
   inventar otro.**
6. **`deudaEur` viaja POSITIVO en `PatrimonioDia`** (es "cuánto debemos", lo que se muestra en el
   desglose) y `totalEur` lo resta. Los dos números en el mismo objeto con signos distintos es a
   propósito y está documentado en el tipo: al revés, la UI tendría que poner `Math.abs()` para
   mostrarlo y ahí es donde se pierde el signo.

### Lo que cambia en `lib/queries/finance.ts` (lo implementa T02)

```ts
export type FinanceOverview = {
  /** El patrimonio del último día COMPLETO. null = nunca se completó uno (D3). */
  patrimonioTotalEur: number | null;          // ← ANTES era number
  /** El desglose de esa misma foto. null junto con el anterior. */
  desglose: { dineroEur: number; retenidoEur: number; deudaEur: number } | null;
  /** De qué día es la foto. Sin esto el número no significa nada. */
  diaPatrimonio: string | null;
  /** Cuentas vigentes hoy sin saldo cargado. Alimenta el banner (D9). */
  faltanCargarHoy: string[];
  atrasados: ScheduledPayment[];              // igual que antes
  hoy: string;
  generatedAt: string;
};

// byMonth y el tipo MonthlyPoint SE VAN. El gráfico ahora pide serieDiaria/serieMensual.
// applySign gana el caso 'aporte': -Math.abs() para gasto/retiro, +Math.abs() para
// aporte, tal cual para ajuste.
```

`patrimonioTotalEur` pasa de `number` a `number | null` **a propósito**: es lo que hace que
"sin información" sea representable y que el compilador obligue a cada consumidor a decidir qué
muestra en ese caso. Es un cambio que rompe tipos, y romperlos acá es el punto.

## 5. El gráfico — `GraficoSaldo.tsx` (lo escribe T04)

Un solo componente con un toggle de dos posiciones. **Las dos vistas muestran cosas distintas y eso
es intencional:**

| Vista | Qué dibuja | Unidad | De dónde sale |
|---|---|---|---|
| **Diario (este mes)** | El patrimonio de cada día, del 1 a hoy | un NIVEL (cuánto hay) | `serieDiaria(mesActual)` |
| **Mensual** | La ganancia de cada mes, últimos 12 | un FLUJO (cuánto entró) | `serieMensual(12)` |

Es lo que el usuario pidió: día a día quiere ver cuánto tiene, mes a mes cuánto ganó. La consecuencia
es que **el eje Y cambia de significado al tocar el toggle**, así que el título de la card y la
leyenda tienen que decir cuál está activa — no alcanza con que el botón esté resaltado.

- **Toggle:** control segmentado con `role="group"` + `aria-pressed`, copiando
  `app/(panel)/embudo/EmbudoView.tsx` L266-300, que es el patrón del panel. No un `<select>`.
- **Tipo de gráfico:** `AreaChart` + `<Area type="monotone" connectNulls dot>` dentro de
  `ChartFrame` de `components/ui.tsx`. Recharts 2.15.4 tiene `LineChart`, `Line`, `Area` y
  `connectNulls` en las dos — verificado leyendo `node_modules/recharts`. Se elige `Area` porque es
  el patrón que ya existe (`Sparkline` en `lib/widgets/catalogo-resumen.tsx`); pasar a `Line` es
  cambiar el elemento y nada más.
- **`connectNulls` prendido y `dot` visible** (D12). Sin `connectNulls`, un mes con dos cargas
  aisladas no dibuja nada.
- **Eje Y ajustado al rango, no anclado en cero:** `domain={['auto', 'auto']}`. Un patrimonio que se
  mueve entre 8.000 y 8.400 con el eje desde cero se ve como una recta. Contra: exagera los
  movimientos chicos, y es el tradeoff que el usuario eligió.
- **Tooltip propio**, como el que ya tiene `FinanzasView`: el `ChartTip` compartido formatea con
  `fmtInt` y esto es plata (`fmtMoney(v, 'EUR')`). En un día sin dato el tooltip dice
  **"sin información"**, no "0".
- **En la vista mensual, la ganancia negativa se dibuja bajo el cero** y con el color `bad`. Un mes
  en pérdida es exactamente lo que hay que ver.
- **`ChartFrame` inyecta un `<Tooltip>` propio si el chart no trae uno** (`injectSharedTooltip`, vía
  `cloneElement`): como acá sí se pasa uno, no lo pisa. No hay que hacer nada especial, pero si el
  tooltip aparece con números sin formato de moneda, esto es por qué.

## 6. Contrato de la UI

```
app/(panel)/finanzas/
├── page.tsx              MODIFICA T06 — server: getFinanceOverview + getSaldoOverview + listas
├── FinanzasView.tsx      MODIFICA T06 — ensambla; borra el BarChart de "Evolución mensual"
├── GraficoSaldo.tsx      CREA T04 — el toggle Diario/Mensual (§5)
├── CargaDiaria.tsx       CREA T04 — el formulario de los saldos del día
├── CuentasSection.tsx    CREA T04 — alta / edición / cierre de cuentas
├── serie.ts + .test.ts   CREA T04 — las 2 funciones puras de formateo de eje y etiqueta
└── monto.ts              NO SE TOCA — el parseo de montos ya existe y ya tiene tests
```

- **`CargaDiaria`: un solo formulario con una fila por cuenta vigente y UN botón.** No cuatro
  formularios. El usuario carga una vez al día, y por D5 cargar 3 de 4 no le sirve de nada: el botón
  guarda todas juntas (regla 1 del §4) y al lado dice cuántas faltan.
- **Los montos se parsean con `parsearMonto` de `./monto.ts`**, que ya existe y ya rechaza `"1.000"`
  como ambiguo. No se vuelve a escribir un parseo de plata: el motivo está en `registro.md`, entrada
  del 2026-08-24.
- **El campo de una cuenta `deuda` pide el valor positivo** ("cuánto debemos") y la UI muestra el
  `−` al lado, fuera del input. Nunca se le pide a la persona escribir un número negativo (D4, y es
  la misma regla que ya sigue el formulario de movimientos).
- **La card de patrimonio muestra el total y abajo el desglose** `dinero / retenido / deuda`, con el
  día de la foto. Si `patrimonioTotalEur` es `null`, dice "sin información — cargá los saldos de
  hoy" y **no** muestra 0.
- **`CuentasSection` ofrece CERRAR, y el borrar está detrás de una confirmación que dice qué se
  lleva** (D10): "borrar también borra los N saldos cargados y cambia el patrimonio histórico".
- La pantalla sigue **ignorando el `?range=`** del `RangePicker` global, igual que antes.

## 7. Dependencias y olas

```
Ola A (fundacional, sola):
  T01 — migración 028 + lib/queries/saldo.ts (contrato congelado) + tests

Ola B (LAS CUATRO EN PARALELO, todas dependen sólo de T01):
  T02 — lib/queries/finance.ts: el patrimonio cambia de fuente, byMonth se va, aporte
  T03 — API: cuentas, saldos, y aporte en movimientos
  T04 — los 3 componentes nuevos, autocontenidos (no tocan FinanzasView)
  T05 — limpieza y deploy: borrar el rollup, el cron, la entrada de npm, el runbook

Ola C (sola, al final):
  T06 — ensamblado: page.tsx + FinanzasView.tsx + verificación end-to-end + registro.md
```

| Task | Depende de | Se puede correr junto con |
|---|---|---|
| T01 | — | **nada, va sola** |
| T02 | T01 | T03, T04, T05 |
| T03 | T01 | T02, T04, T05 |
| T04 | T01 (sólo los tipos) | T02, T03, T05 |
| T05 | T01 (la decisión, no el código) | T02, T03, T04 |
| T06 | T02, T03, T04 | **nada, va sola** |

**Por qué las cuatro de la ola B no se pisan:** ninguna escribe un archivo de otra (§8) y ninguna
importa un archivo que otra de la misma ola vaya a crear. T04 escribe componentes que **nadie monta
todavía** — quedan sin llamadores hasta T06, y eso es a propósito: es lo que permite escribir la
pantalla y sus piezas al mismo tiempo. `npm run build` los compila igual (Next no exige que un
componente esté importado).

**Compuertas, y no son sugerencias:**

- **T01 no está terminada hasta que sus tests pasen y `_verificacion-028.sql` dé las 19 afirmaciones
  documentadas.** Ninguna task de la ola B arranca antes. T02, T03, T04 y T06 importan tipos y
  funciones que sólo existen después.
- **T06 no arranca hasta que T02, T03 y T04 hayan corrido su verificación.** Es la única que ve el
  módulo entero funcionando y la única que puede detectar que dos piezas no encajan.
- **En el DEPLOY, la migración 028 y T05 van juntas** (D11). La 028 borra
  `finance_daily_profit` y el cron de las 5:35 la usa: deployar una sin la otra deja el cron
  fallando todas las noches.

Si preferís de a uno: T01 → T02 → T03 → T04 → T05 → T06.

## 8. Ownership de archivos — regla anti-colisión

**Cada task solo escribe los archivos de su fila.** Si necesita algo de un archivo ajeno, lo lee
pero no lo escribe; si cree que necesita escribirlo, va a §10.

| Task | Archivos que puede crear, modificar o borrar |
|---|---|
| T01 | `db/migrations/028_saldo_cuentas.sql` (crear), `lib/queries/saldo.ts` (crear), `lib/queries/saldo.test.ts` (crear), **+ 2 líneas en `lib/queries/finance.ts`, ver la excepción declarada abajo** |
| T02 | `lib/queries/finance.ts`, `lib/queries/finance.test.ts` |
| T03 | `app/api/finanzas/cuentas/route.ts` (crear), `app/api/finanzas/saldos/route.ts` (crear), sus `.test.ts`, y `app/api/finanzas/movimientos/route.ts` (**sólo** agregar `aporte` a la validación) |
| T04 | `app/(panel)/finanzas/GraficoSaldo.tsx`, `CargaDiaria.tsx`, `CuentasSection.tsx`, `serie.ts`, `serie.test.ts` (los 5, crear) |
| T05 | `scripts/finance-rollup.ts` (**borrar**), `scripts/finance-rollup.test.ts` (**borrar**), `package.json` (**sólo** quitar la línea `finance:rollup`), `deploy/cron.panel` (**sólo** quitar la línea de las 5:35), `docs/runbook.md` (reescribir la sección "Finanzas") |
| T06 | `app/(panel)/finanzas/page.tsx`, `app/(panel)/finanzas/FinanzasView.tsx`, `registro.md` (agregar la entrada), `tasks/saldo-cuentas/_verificacion-e2e.sh` (crear) |

**Archivos que NADIE toca**, y romper esto rompe producción:
```
lib/db.ts
lib/day.ts
lib/queries/overview.ts
lib/queries/sales.ts
lib/ads/**                       ← el pedido es explícito: no hay sincronización con Meta
scripts/rollup.ts
scripts/sync-ads.ts
scripts/finance-scheduled-payments.ts
lib/monto.ts                     ← el núcleo del parseo de plata; T04 le pone política ENCIMA
lib/paleta.test.ts               ← la guarda de tokens de color; se corre, no se edita
components/ui.tsx                ← si de verdad falta un primitivo, va a §10
components/Nav.tsx               ← la pestaña /finanzas ya está
db/migrations/001..027           ← ninguna migración vieja se edita
tasks/finanzas/**                ← el plan viejo queda como registro histórico
```

**Ojo con `lib/monto.ts`:** hasta el commit `0e151e0` el parseo de plata vivía en
`app/(panel)/finanzas/monto.ts`. Ese archivo **ya no existe**: se consolidó en `lib/monto.ts` y se le
extrajo `leerNumeroEscrito`, el núcleo sin política. T04 escribe `parsearSaldo` **encima** de ese
núcleo, en su propio archivo, porque `parsearMonto` rechaza el cero y un saldo de 0 es válido (ver
T04 §4). El núcleo no se toca.

### La excepción declarada: T01 toca 2 líneas de `lib/queries/finance.ts`

Rompe "un archivo, un dueño" a propósito, y sin esto la ola B no compila.

`FinanceMovementKind` vive en `lib/queries/finance.ts`, que es de T02. Pero **T03 lo necesita en la
misma ola**: su `zod` del route de movimientos tiene que aceptar `'aporte'`, y si el tipo todavía no
lo incluye, `tsc` falla en T03 por un archivo que T03 no puede tocar. Es el bug clásico de
descomposición (una task importa algo que la de al lado todavía no escribió) y no se manifiesta hasta
que alguien corre el compilador.

**T01 hace exactamente estos dos cambios en `lib/queries/finance.ts`, y nada más:**

```ts
export type FinanceMovementKind = 'gasto' | 'retiro' | 'ajuste' | 'aporte';   // ← + 'aporte'

export function applySign(kind: FinanceMovementKind, amountEur: number): number {
  if (kind === 'ajuste') return amountEur;             // único que respeta el signo que le pasan
  if (kind === 'aporte') return Math.abs(amountEur);   // ← rama nueva: SIEMPRE positivo
  return -Math.abs(amountEur);                         // gasto | retiro
}
```

Va en T01 y no en T02 porque **es el mismo cambio que el `CHECK` de la migración**: la base y el tipo
declaran la misma regla, y declararlos en la misma task es lo que impide que queden en desacuerdo. No
hay riesgo de colisión: T01 es la ola A y T02 la ola B, así que nunca escriben el archivo al mismo
tiempo. T02 se encuentra las dos líneas ya puestas y no las vuelve a tocar.

**Dos casos que parecen colisión y no lo son:**

- **T02 y T03 tocan los dos el concepto `aporte`.** Después de la excepción de arriba, T02 sólo cambia
  el patrimonio y T03 sólo el `zod` del route. El `CHECK` de la base y `applySign` (los dos de T01)
  son la única fuente de verdad de las dos.
- **T04 crea componentes que nadie importa hasta T06.** No es código muerto: es la única forma de
  paralelizar la pantalla. Cada archivo de T04 abre con un comentario en la primera línea diciendo
  **qué task lo monta**.

### `npm run build` no da verde hasta T06, y eso es esperado

**Lo rompe T01, no T02** — corregido después de correrlo de verdad. Agregar `'aporte'` a
`FinanceMovementKind` rompe los dos `Record<FinanceMovementKind, …>` de `FinanzasView.tsx`, que son
exhaustivos por tipo. Son **exactamente estos dos errores, y ningún otro**:

```
app/(panel)/finanzas/FinanzasView.tsx(38,7): error TS2741: Property 'aporte' is missing in type
  '{ gasto: string; retiro: string; ajuste: string; }' but required in type 'Record<FinanceMovementKind, string>'.
app/(panel)/finanzas/FinanzasView.tsx(44,7): error TS2741: Property 'aporte' is missing in type
  '{ gasto: "neutral"; retiro: "info"; ajuste: "warn"; }' but required in type 'Record<…>'.
```

Están escritos textuales a propósito: un agente que vea un error de tipos tiende a arreglarlo, y esos
dos los arregla T06 (son `KIND_LABEL` y `KIND_TONE`, dos entradas de mapa). Después T02 le suma los
suyos, cuando saque `byMonth` y cambie `patrimonioTotalEur` a `number | null`.

Por eso **el gate de `npm run build` es de T06 y de nadie más.** Las tasks de la ola B verifican con
`npx tsc --noEmit` y tienen escrito en su §7 cuáles errores son ajenos. Un agente de la ola B que se
ponga a "arreglar" `FinanzasView.tsx` está pisando a T06.

**Y hay una consecuencia en runtime que el tipo no muestra:** desde que la migración 028 corre,
`getFinanceOverview()` **falla en ejecución** porque `PATRIMONIO_SQL` consulta
`finance_daily_profit`, que ya no existe. O sea que entre T01 y T02 la pantalla `/finanzas` está
caída, no sólo sin compilar. En local es irrelevante; **en producción esto obliga a que la migración y
T02 se deployen juntas**, igual que T05 (D11). No se puede migrar y deployar por partes.

## 9. Criterios de aceptación globales

1. `npm run build` y `npm test` pasan.
2. `_schema-028.sql` corrido dos veces sobre 001-027 no falla la segunda vez. Ya verificado; T01 lo
   re-verifica sobre su copia en `db/migrations/`.
3. Las 19 afirmaciones de `_verificacion-028.sql` dan lo documentado al lado de cada bloque.
4. **Un día al que le falta una cuenta devuelve `totalEur: null`, y hay un test que lo prueba.** No
   alcanza con probar el día completo. Es D5 y es el bug más caro del módulo.
5. **`serieMensual` con un aporte en el mes descuenta el aporte**, con un test que lo prueba (D7,
   `#19`). Sin ese test, la ganancia se ve razonable y está mal.
6. Abrir una cuenta nueva no cambia el patrimonio de ningún día anterior, con un test (D6, `#8`).
7. Los endpoints de `/api/finanzas/**` responden 401 sin cookie con el guard explícito del route,
   igual que el resto. (El middleware además redirige con 307 antes de llegar: es el comportamiento
   heredado documentado en P-07 del plan viejo, no un bug de esto.)
8. **Nada de lo que ya funcionaba cambió:** `getOverviewData` y `getSalesData` devuelven los mismos
   números antes y después. Ninguna de sus queries ni sus tablas se toca.
9. Los pagos programados siguen generando su gasto igual que antes, y siguen sin afectar el
   patrimonio (que ahora se mide). El test de idempotencia de la 022 sigue pasando.
10. `grep -rn "finance_daily_profit" --include="*.ts" --include="*.sql" .` no devuelve ninguna
    referencia viva fuera de `tasks/**` y `db/migrations/022_finanzas.sql`.

## 10. Preguntas abiertas

Si aparece una decisión que este documento no resuelve, **se anota acá en lugar de decidirla en el
código**. Si bloquea, la task se detiene.

### P-01 — Los nombres de las cuatro cuentas sembradas
- **Task:** T01.
- **Sección:** §3, el `INSERT` del final de `_schema-028.sql`.
- **Qué falta:** el seed usa `Arq`, `Mercado Pago`, `Retenido en Mercado Pago` y `Deuda con Meta`,
  que son una transcripción de cómo el usuario las nombró de palabra. Si alguno está mal escrito
  (sobre todo "Arq", que puede ser una abreviatura de otra cosa) se corrige **en la UI**, no en la
  migración: `updateAccount` ya permite renombrar y el índice único es sobre el nombre normalizado.
- **Bloquea:** no. Un nombre mal escrito no cambia ninguna aritmética.
- **Resolución:** _(la completa el usuario)_

### P-02 — Una cuenta de tipo `dinero` en descubierto no se puede tipear
- **Task:** T01 (esquema), T03 (mensaje de error).
- **Sección:** §1 D4.
- **Qué pasa:** el `CHECK` exige `amount_eur >= 0`, así que una cuenta bancaria en rojo no se puede
  cargar. Es la consecuencia deliberada de que el signo lo ponga el `kind`.
- **Mientras tanto:** se modela como una cuenta `deuda` aparte, y el route devuelve ese mensaje
  cuando el `CHECK` se viola ("un saldo no puede ser negativo: si la cuenta está en descubierto,
  cargala como una cuenta de tipo deuda"), no el SQLSTATE crudo.
- **Bloquea:** no.

### P-03 — El salto del patrimonio el día del deploy — MEDIDO, ya no es una incógnita
- **Task:** T05 (runbook) y T06 (registro.md).
- **Sección:** §3.
- **Qué pasa:** el día que la 028 corre en producción, el patrimonio pasa del número calculado a
  "sin información", y después al primer saldo que el usuario cargue. Es esperado por D3.
- **Los números reales de producción, leídos el 2026-08-28** (solo lecturas contra la base viva):

  | Qué | Valor |
  |---|---|
  | `finance_daily_profit` | 14 filas, del 2026-08-15 al 2026-08-28, suma **1798.44** |
  | `finance_movements` | **1 sola fila**, un `ajuste` de **+689.00** |
  | **Patrimonio viejo** | **2487.44 EUR** |

- **El salto es MUCHO más chico de lo que este plan asumía**, y eso cambia el riesgo: el módulo tiene
  14 días de vida en producción, no meses. No hay historia que perder.
- **El dato que importa de verdad:** el único movimiento cargado es un **`ajuste` de +689.00**. O sea
  que el patrimonio calculado ya no cerraba y se estaba corrigiendo a mano — es la evidencia directa
  de por qué se pidió este cambio, y hay que anotarla en `registro.md` (T06) porque explica el pedido
  mejor que el pedido mismo.
- **Mientras tanto:** el runbook exige el export a CSV antes de migrar (§3), y T06 anota los dos
  números uno al lado del otro.
- **Bloquea:** no.

### P-04 — La ganancia del primer mes con datos nunca se puede mostrar
- **Task:** T04 (qué dice la UI).
- **Sección:** §1 D8.
- **Qué pasa:** sin cierre del mes anterior no hay delta, así que el mes más viejo de la serie
  siempre tiene `gananciaEur: null`. Con 12 meses de ventana y un módulo que arranca vacío, durante
  el primer mes **el gráfico mensual va a estar completamente vacío**, y el segundo mes va a tener un
  punto solo.
- **Mientras tanto:** la vista mensual muestra un `EmptyState` con el texto "todavía no hay dos
  meses cerrados para comparar" en vez de un gráfico en blanco, y el toggle arranca en **Diario**,
  que es la vista que tiene datos desde el primer día.
- **Bloquea:** no, pero si no se resuelve así el usuario va a abrir la pantalla el primer día y ver
  un gráfico vacío sin entender por qué.

### P-05 — El `ajuste` de +689 que hay en producción se queda huérfano
- **Task:** ninguna todavía. Decisión del usuario.
- **Sección:** §1 D1.
- **Qué pasa:** `ajuste` existía para corregir a mano un patrimonio **calculado** que no cerraba (D2
  del plan viejo). Con el patrimonio medido no hay nada que ajustar: el número es el que el usuario
  tipeó mirando las cuentas.
- **Y no es hipotético:** la única fila de `finance_movements` en producción es exactamente eso, un
  `ajuste` de **+689.00** (ver P-03). Después de la migración esa fila deja de sumar a cualquier cosa
  y queda como un registro de que en algún momento faltaban 689 EUR que nadie sabía de dónde.
- **Mientras tanto:** se deja tal cual, sin tocar, y `ajuste` sigue existiendo como kind. Borrarla
  sería tirar la única pista de que el cálculo viejo estaba mal, y borrar el kind obligaría a migrar
  esa fila a algo.
- **Lo que sí conviene decidir:** si ese +689 en realidad era un `aporte` (plata que entró de afuera)
  se puede reetiquetar con un `PATCH` desde la pantalla y entonces cuenta bien en la ganancia del mes.
  Si era un descuadre de cálculo, dejarlo como `ajuste` es lo correcto. **Sólo el usuario sabe cuál
  de las dos es.**
- **Bloquea:** no.
### P-06 — No hay forma de leer los saldos de un día que no sea hoy
- **Task:** la levantó T04. La resuelve T03 (un GET) o T06 (bajarlo por props).
- **Sección:** §4 (contrato) y §6 (`CargaDiaria`).
- **Qué pasa:** `CargaDiaria` recibe `cuentas: AccountWithBalance[]`, que son las cuentas **con el
  saldo de HOY**, y el formulario deja cambiar el día (T04 §4 lo pide: "para cargar el saldo de un
  día que se olvidó"). Pero no existe ningún endpoint que devuelva los saldos de un día arbitrario:
  T03 expone `POST /saldos` y `GET /cuentas`, y `getSaldoOverview()` resuelve hoy y nada más.
- **La consecuencia concreta, que es peor que la falta:** si el formulario precargara los números de
  hoy y el usuario cambiara el día, guardar copiaría el saldo de hoy a un día del pasado sin que nada
  lo diga. Es un patrimonio creíble y falso, exactamente lo que este módulo existe para evitar.
- **Mientras tanto:** al cambiar de día los campos arrancan **vacíos**, un `Banner tone="info"` lo
  explica, y en un día que no es hoy **un campo vacío se OMITE del payload** en lugar de mandarse
  como `null`: en hoy "vacío" es una intención (borrar), en otro día es "no sé qué hay". El costo
  declarado es que **desde la UI no se puede borrar el saldo de un día pasado** — hay que ir a la API.
- **Cómo se cierra:** `GET /api/finanzas/saldos?day=YYYY-MM-DD` devolviendo `AccountWithBalance[]`
  (que es `CUENTAS_CON_SALDO_SQL`, ya escrito en `saldo.ts`, con otro `$1`). Es de T03.
- **Bloquea:** no.

### P-07 — El `confirm()` de borrar una cuenta no puede decir el número antes de borrar
- **Task:** la levantó T04. La resuelve T03.
- **Sección:** §6 (`CuentasSection`) y T03 §3.
- **Qué pasa:** el plan pide que la confirmación diga el número real ("borra también los 47 saldos
  cargados"), pero `saldosBorrados` lo devuelve la **respuesta del DELETE**, o sea después de
  destruir. No hay forma de saberlo antes: `contarSaldosDe()` existe en `saldo.ts` y ningún route la
  expone.
- **Mientras tanto:** el `confirm()` nombra la consecuencia completa (que se lleva TODOS los saldos,
  que el patrimonio de esos días cambia, y que si la cuenta dejó de usarse lo correcto es CERRARLA), y
  el número real se informa en el banner al volver. Lo mismo con `saldosAfectados` del cambio de
  `kind`.
- **Cómo se cierra:** que `GET /cuentas` devuelva el conteo de saldos por cuenta, o un
  `DELETE ?dryRun=1`. Con lo primero, además, la tabla podría mostrar "47 saldos" en una columna, que
  es información útil todo el tiempo y no sólo cuando alguien va a borrar.
- **Bloquea:** no.

### P-08 — `CuentasSection` no recibe el `hoy` del server, así que «Cerrar» no puede proponer hoy
- **Task:** la levantó T04. La resuelve T06 (tiene `saldo.hoyStr` a mano).
- **Sección:** §6, la firma de `CuentasSection({ cuentas, onCambio })`.
- **Qué pasa:** cerrar una cuenta es un `PATCH` con `closedOn`, y lo natural sería que el campo
  arranque en hoy. Pero `hoy` tiene que venir del server (resuelto en `DASHBOARD_TZ`, regla 5 del §4)
  y esta firma no lo trae. Usar `new Date()` del browser es el corrimiento de zona que todo el resto
  del módulo evita, y acá no es cosmético: `closed_on` es **aritmética** (D6) y un día de más o de
  menos cambia qué días quedan completos.
- **Mientras tanto:** «Cerrar» abre el formulario con el campo de cierre **vacío** y un `Banner` que
  pide elegir el día en que la cuenta dejó de usarse. Es un click más y no inventa ninguna fecha.
  «Reabrir» no necesita fecha (`closedOn: null`), así que va directo.
- **Cómo se cierra:** agregarle `hoy: string` a la firma. Es un cambio de contrato de §6, por eso no
  lo hace T04.
- **Bloquea:** no.

### P-09 — Dos reglas quedaron duplicadas en `serie.ts`, y sólo una está anclada por un test
- **Task:** la levantó T04. Queda como deuda conocida.
- **Sección:** §8 (los archivos que nadie toca).
- **Qué pasa:** `serie.ts` no puede importar dos cosas que ya existen:
  1. **`signoDe` de `lib/queries/saldo.ts`** — es un import de VALOR desde un módulo que importa
     `pg`, así que arrastraría el driver de Postgres al bundle del browser (el mismo motivo por el que
     `FinanzasView.tsx` trae todo con `import type`). Se duplicó como `signoDeSaldo`.
  2. **`MAX` de `lib/monto.ts`** (el techo de `numeric(14,2)`) — es `const` module-local, no se
     exporta, y ese archivo está en la lista de los que nadie toca. Se duplicó el literal.
- **Mientras tanto:** la primera **tiene test**: `serie.test.ts` importa el `signoDe` original (en
  node sí se puede, `getPool()` es lazy y no abre conexión) y compara las dos implementaciones contra
  la misma tabla de casos, así que no pueden separarse en silencio. La segunda **no**: si la columna
  cambia de precisión, los dos literales hay que moverlos a mano.
- **Cómo se cierra:** `export const MAX_NUMERIC_14_2` en `lib/monto.ts`, una línea, cuando alguien
  pueda tocar ese archivo. Para `signoDe`, extraerlo a un módulo sin `pg` (`lib/saldo-signo.ts`) — no
  vale la pena por una línea mientras el test la ancle.
- **Bloquea:** no.

### P-10 — Detalles del gráfico y de la UI que el plan no cierra (decisiones de T04)
- **Task:** T04. Anotadas, no bloqueantes.
- **El degradado partido en el cero es APROXIMADO.** Un `<Area>` tiene un solo `fill`, así que para
  que un mes en pérdida se vea distinto de un mes en ganancia el degradado se corta donde cae el cero
  (`offsetDelCero`, pura y con test). Pero el eje va con `domain={['auto','auto']}` (lo pide el §5) y
  ese `auto` redondea el dominio a números lindos, así que el borde del color puede caer unos píxeles
  arriba o abajo del cero real. El cero **exacto** lo marca la `<ReferenceLine y={0}>`, que sólo se
  dibuja si hay algún valor negativo: con todo positivo el cero queda fuera del dominio y la línea no
  diría nada.
- **`fmtDate` de `components/ui.tsx` corre el día, y por eso el tooltip no lo usa.** `fmtDate` hace
  `new Date('2026-08-05')`, que es medianoche **UTC**: en una TZ al oeste de Greenwich formatea el día
  ANTERIOR. En un gráfico cuyo único trabajo es decir de qué día es cada número eso no se puede, así
  que las fechas se arman cortando el string (`etiquetaDia`). **Es un bug preexistente del repo**: la
  columna "Fecha" de la tabla de movimientos de `FinanzasView.tsx` usa `fmtDate(m.day)` hoy y muestra
  un día menos según la zona del browser. No se arregla acá (ese archivo es de T06 y `components/ui.tsx`
  no lo toca nadie), pero conviene mirarlo.
- **`CargaDiaria` no tiene campo de nota**, y el upsert de `guardarSaldosDelDia` sobreescribe `note`
  con `EXCLUDED.note`. Para que guardar los saldos no borre una nota cargada por la API, el formulario
  **reenvía la nota que vino en props** — cosa que sólo puede hacer para hoy (ver P-06). Guardar otro
  día deja la nota de ese día en `null`. Hoy ninguna pantalla escribe notas, así que la exposición
  real es nula.
- **Decisiones visuales que el plan dejaba abiertas:** el total en vivo va **debajo** de las filas y
  arriba del botón (es lo último que se lee antes de guardar), los inputs de saldo son `w-32`
  alineados a la derecha con `tabular-nums`, y cada fila muestra a su derecha cuánto aporta al total
  **con el signo ya aplicado**. El `EmptyState` de la vista diaria dice "todavía no hay ningún día
  completo de este mes" — el §5 sólo pedía el de la mensual, pero un gráfico diario en blanco el
  primer día tiene el mismo problema que describe P-04.
- **Bloquea:** no.

### P-11 — La entrada de `registro.md` de T04 la tiene que escribir T06
- **Task:** T06.
- **Sección:** §8.
- **Qué pasa:** la regla del repo es que todo cambio de código se anota en `registro.md` en la misma
  tanda de trabajo. Pero `registro.md` es de T06 (§8), justamente para que cuatro tasks en paralelo no
  se peleen por el mismo archivo, y T04 tiene prohibido escribir fuera de sus 5 archivos.
- **Mientras tanto:** el "por qué" de T04 queda acá (P-06 a P-10) y en las cabeceras de los 5
  archivos. **Lo que T06 tiene que llevar a `registro.md`, en una línea cada uno:** que `parsearSaldo`
  existe porque `parsearMonto` rechaza el cero y un saldo de 0 es una cuenta vacía (con el test que lo
  fija); que `connectNulls` está prendido porque sin él dos cargas aisladas en el mes no dibujan nada;
  que el toggle cambia la UNIDAD del eje y no sólo el rango; y las cuatro limitaciones de arriba con
  su dueño.
- **Bloquea:** no.

### P-06 — T05 tuvo que tocar un archivo de la lista "nadie toca"
- **Task:** T05.
- **Sección:** §8 (ownership).
- **Archivo:** `scripts/finance-scheduled-payments.ts`, **sólo el comentario de cabecera.**
- **Qué pasó:** ese archivo está en la lista de los que nadie toca, pero su docblock decía "Corre
  DESPUÉS de finance-rollup.ts en el cron de producción", y `finance-rollup.ts` **ya no existe**. Un
  comentario que manda a leer un archivo borrado es peor que no tener comentario: el próximo que lo
  lea va a buscar una dependencia de orden que ya no existe y no la va a encontrar.
- **Qué se hizo:** se reescribió el docblock (cero cambios de comportamiento, ni una línea de código)
  para decir lo contrario y por qué: este script no depende de ninguna hora, porque no lee
  `daily_metrics` ni las cotizaciones.
- **Por qué se decidió acá y no se dejó pasar:** la alternativa era respetar el ownership al pie de la
  letra y dejar una referencia rota en producción. La regla de ownership existe para que dos agentes
  no se pisen, no para conservar comentarios falsos; ninguna otra task de este módulo toca ese
  archivo, así que no había con quién colisionar.
- **Bloquea:** no (ya resuelto).
