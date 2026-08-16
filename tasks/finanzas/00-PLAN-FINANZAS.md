# FINANZAS — patrimonio del negocio, todo en EUR

**Documento maestro del módulo. Todo agente lee este archivo completo antes de abrir su task.**

Una sección nueva del panel, pestaña propia en el navbar junto a Resumen/Embudo/Ventas/Anuncios/
Leads/Config. Muestra el **patrimonio** del negocio (cuánta plata hay, acumulada desde siempre) y
los **gastos** (operativos, retiros, ajustes), con pagos programados que avisan cuando están
atrasados.

No es una vista más de lo que ya existe: Resumen ya calcula `resultEur` (neto − ads) por rango de
fechas, pero ese número se pierde apenas cambiás el rango. Finanzas es la ACUMULACIÓN de esos
resultados día a día, más lo que pasa fuera de las ventas — sueldos, herramientas, retiros para el
usuario — que hoy no tiene ningún lugar en el panel. La pregunta que responde es "¿cuánta plata
tengo?", no "¿cómo vendí este mes?" (esa la sigue respondiendo Resumen).

**Este módulo registra movimientos de dinero real del usuario, incluidos retiros a su cuenta
personal.** Un bug que duplique un gasto o pierda un pago programado corrompe la única foto que
existe de cuánta plata hay. Todo lo que sigue está diseñado alrededor de esa frase: los signos los
garantiza la base (no el código que llama), los pagos automáticos son idempotentes por estructura
(un UNIQUE, no un `if`), y nada se borra en cascada sin querer.

## 0. Qué se construye y qué no

**Se construye**

1. Dos tablas nuevas: `finance_daily_profit` (el profit de cada día, recalculado solo, 1 vez al
   día) y `finance_movements` (gasto / retiro / ajuste, cargados a mano). Más
   `finance_scheduled_payments` y `finance_scheduled_payment_runs` para los pagos programados.
2. Un cron (`scripts/finance-rollup.ts`) que UNA VEZ AL DÍA calcula el profit del día anterior desde
   `daily_metrics` (todos los funnels) y lo guarda. No hay refresco en vivo como `lib/ads/live.ts`:
   el usuario pidió explícitamente "una vez al día", y el número de Finanzas es acumulativo, no
   necesita estar al segundo.
3. Un cron (`scripts/finance-scheduled-payments.ts`) que corre después y genera el gasto de
   cualquier pago programado activo cuyo día ya pasó y no se ejecutó este mes.
4. La sección `/finanzas`: patrimonio total, evolución mensual (gráfico), tabla de movimientos con
   alta/edición/borrado, pagos programados con alta/edición/pausado, y un banner de atrasados.
5. Un botón de "Ajuste" en la UI: un movimiento con signo libre, para cuando algo no cierra y hay
   que corregir a mano (D2 de la entrevista con el usuario).

**No se construye** (fuera de alcance, explícito para que ningún agente lo invente)

- Conversión de moneda. Todo entra en EUR directo, tipeado por el usuario. No hay `currency` ni
  `fx_rate` en ninguna tabla de este módulo — a diferencia de `orders`/`commissions`, que sí
  convierten. Si en el futuro hace falta cargar en ARS, es una task nueva y una migración nueva.
- Gasto por funnel. El usuario fue explícito: "siempre global, me interesa saber cuánta plata
  tengo y ya". `finance_movements` no tiene `funnel_id`. (Difiere de lo que yo había recomendado en
  la ronda de preguntas — quedó anotado y descartado a propósito.)
- Categorías configurables desde la UI. La lista es fija en código y en un `CHECK`:
  `sueldos | herramientas | alquiler | impuestos | otros`. Agregar una categoría es un `ALTER
  TABLE` + un deploy, no una pantalla de configuración.
- Cualquier tipo de proyección o presupuesto ("¿cuánto voy a gastar este mes?"). Es sólo lo que ya
  pasó.
- Multi-usuario o permisos por rol. El panel entero es un solo password-gate (`lib/auth.ts`); este
  módulo no le agrega una capa nueva.
- Notificaciones (Telegram, email) de pagos atrasados. El aviso es un banner dentro de la pantalla,
  igual que las alertas de Resumen (`getOverviewData().alerts`). Si en el futuro se quiere avisar
  por Telegram, ya existe el bot de anuncios (`scripts/telegram-setup.ts`) y sería una task de
  extenderlo, no de este módulo.

## 1. Decisiones cerradas

No hay nada que decidir. Si aparece algo que este documento no resuelve, se anota en §10 y **no se
decide en el código**.

**D1 — El patrimonio es una SUMA, nunca una columna acumulada.** `patrimonio_total =
SUM(finance_daily_profit.amount_eur) + SUM(finance_movements.amount_eur)`, calculado en cada
lectura. La alternativa (guardar un `running_total` que se actualiza con cada INSERT) se descartó
por lo mismo que `daily_metrics` se recalcula y no se acumula (`scripts/rollup.ts`): un bug en un
UPDATE deja el total desincronizado de sus partes, y no hay forma de darse cuenta hasta que alguien
suma a mano y no cierra. Verificado en fase 3 (`_verificacion-022.sql` #9, #21): sumar siempre las
dos tablas da el número correcto sin importar el orden de las cargas.

**D2 — Profit diario y movimientos manuales son DOS tablas, no una.** El profit se recalcula solo
todos los días desde una fuente que cambia (`daily_metrics`, que Meta puede corregir días después,
igual que ya advierte `lib/ads/live.ts`); vive en una tabla con PK `(day)` y se pisa con `ON
CONFLICT`. Un gasto o un retiro son hechos que el usuario carga una vez y no cambian solos; viven en
su tabla con `id` propio y se editan libremente (D9 de la entrevista: a diferencia de una comisión,
que es una regla que afecta ventas futuras y por eso se congela, un gasto es un hecho ya ocurrido y
lo natural es poder corregirlo si se tipeó mal).

**D3 — El signo lo garantiza la base, no el código que llama.** `finance_movements` tiene un
`CHECK` que obliga: `gasto` y `retiro` siempre negativos, `ajuste` cualquier signo salvo cero. Mismo
principio que ya usa el proyecto en comisiones (`commissions_percent_rango`, migración 012): la
aplicación nunca es la única defensa. Sin este `CHECK`, un gasto cargado sin el signo por error SUMA
al patrimonio en vez de restar, y nada lo avisa — es el bug más caro que puede tener este módulo, y
por eso se prueba explícitamente en fase 3 (`_verificacion-022.sql` #1 a #8).

**D4 — Solo el `gasto` lleva categoría.** Un retiro o un ajuste no son "gasto operativo", así que
`category` queda `NULL` para esos dos y es obligatoria (una de las 5 fijas) para `gasto`. Un
`CHECK` lo garantiza (`finance_movements_categoria_solo_gasto`), para que el desglose por categoría
de gastos no se mezcle con retiros o ajustes.

**D5 — Los pagos programados son una PLANTILLA (sin signo), el movimiento que generan SÍ lo
tiene.** `finance_scheduled_payments.amount_eur` es positivo (es "cuánto es el alquiler", no un
movimiento); el gasto que el cron genera cada mes es un `finance_movements` con signo negativo,
como cualquier otro gasto. Separar las dos cosas es lo que permite editar el monto de un pago
programado sin tocar el historial de lo ya pagado.

**D6 — `day_of_month` se limita a 1-28.** Nadie pidió resolver qué pasa con un pago del día 31 en
un febrero de 28 días. Limitando el rango, el pago cae siempre en un día que TODOS los meses
tienen, sin inventar la regla de "se corre al último día del mes" para una diferencia de 1 a 3 días
que no importa en un pago mensual. Verificado en fase 3 (#11).

**D7 — Un pago programado no puede ejecutarse dos veces el mismo mes, y la garantía es
ESTRUCTURAL.** `finance_scheduled_payment_runs` tiene PK compuesta `(scheduled_payment_id, month)`.
No es una condición `WHERE NOT EXISTS` en el script (que también existe, como optimización): es un
`UNIQUE` que rechaza el segundo INSERT aunque el script tenga un bug o corra dos veces por un
reinicio de proceso a mitad de corrida. Mismo patrón que ya usa el proyecto contra los `ad_rules`
solapados. Verificado en fase 3 (#14).

**D8 — Un pago "atrasado" es: activo, con `day_of_month` ya pasado este mes, sin fila en
`finance_scheduled_payment_runs` para el mes actual.** No depende de que el cron haya corrido
puntual: si el server estuvo caído tres días, al volver el cron ve el pago igual de atrasado y lo
ejecuta esa misma corrida (D-anuncios ya tiene este patrón con `ads:reglas --health`). La consulta
exacta está verificada en fase 3 (#16 a #19) contra cuatro casos: atrasado, futuro, ya pagado,
pausado.

**D9 — Borrar un pago programado no borra el historial de lo que ya pagó.** `ON DELETE SET NULL`
en `finance_movements.scheduled_payment_id`. Es la misma razón por la que borrar una regla de
comisión no reescribe las ventas que la tenían aplicada (migración 012): el historial es un hecho
pasado y no depende de que la configuración que lo generó siga existiendo. Verificado en fase 3
(#13).

**D10 — Todo en EUR, sin excepción.** A diferencia de `orders`, que guarda la moneda original y
la convierte, acá no hay conversión: el usuario tipea el número en euros directo. Es la decisión
explícita del usuario ("eur siempre") y simplifica todo el módulo — sin `fx_rate`, sin `fx_stale`,
sin el problema de qué cotización usar para un gasto.

**D11 — El profit diario se calcula 1 vez al día, sin refresco en vivo.** A diferencia de
`lib/ads/live.ts` (que refresca el gasto de ads en cada render si el rango llega a hoy), Finanzas
no tiene ese mecanismo: el usuario pidió explícitamente "1 vez al día" y el patrimonio es un número
acumulado de largo plazo, no algo que se mire minuto a minuto. El cron corre después del rollup
nocturno de `daily_metrics` (que a su vez corre después de `fetch-fx`, ver la cadena horaria del
§7).

## 2. Arquitectura

```
                     ┌─────────────────────────┐
   03:XX  cron ──────▶ scripts/finance-rollup.ts│──▶ finance_daily_profit
          (después          (lee daily_metrics  │    (upsert por día)
           del rollup        de TODOS los       │
           de daily_metrics) funnels)           │
                     └─────────────────────────┘
                                                          │
   03:XX  cron ──────▶ scripts/finance-scheduled-payments.ts
          (después          (lee finance_scheduled_payments +
           del rollup        finance_scheduled_payment_runs) │
           de arriba)                                        ▼
                                                    finance_movements (INSERT kind='gasto')
                                                    finance_scheduled_payment_runs (INSERT)

   usuario ──────────▶ app/(panel)/finanzas/page.tsx ──▶ lib/queries/finance.ts ──▶ Postgres
   (UI, carga manual)  FinanzasView.tsx (client)          (funciones puras +
                        │                                  queries de lectura)
                        ▼
                  app/api/finanzas/movimientos/route.ts    (POST/PATCH/DELETE, mutación)
                  app/api/finanzas/pagos-programados/route.ts
```

La decisión estructural que hace testeable el módulo: **la aritmética de "cuánto es el patrimonio",
"qué pagos están atrasados" y "cómo se ve la evolución mensual" vive en funciones puras dentro de
`lib/queries/finance.ts`** que reciben filas ya leídas (mismo patrón que `applyCommissions` /
`applyCosts`), separadas de las funciones que hacen `SELECT`. Los tests de esas funciones no tocan
la base.

## 3. Esquema — fuente de verdad

El DDL completo ya está escrito y CORRIDO contra una base scratch con las migraciones 001-020
aplicadas: `_schema-022.sql`. T01 lo copia tal cual como `db/migrations/022_finanzas.sql`, sin
retipearlo.

**Nota de la verificación (fase 3):** la migración 021 (`ad_rules` por cuenta) no corre desde cero
en una base recién creada — exige que ya exista una fila en `ad_accounts` con
`active=true, platform='meta'`, y eso sólo pasa después de sincronizar anuncios reales. No tiene
relación con este esquema: se verificó 022 aplicando 001-020 + 022 a mano en la scratch, salteando
la 021. **Esto es un problema preexistente del repo** (no introducido por este módulo) y queda
anotado en §10 para que el usuario lo sepa, no para que T01 lo arregle.

| Tabla | Para qué |
|---|---|
| `finance_daily_profit` | Un valor por día: el profit de TODOS los funnels ese día, recalculable. |
| `finance_movements` | Gasto, retiro o ajuste. La tabla que la UI lista, edita y borra. |
| `finance_scheduled_payments` | La plantilla de un pago recurrente mensual (nombre, categoría, monto, día). |
| `finance_scheduled_payment_runs` | Qué pago ya se ejecutó en qué mes. Existe solo para la idempotencia. |

Los tres detalles del esquema que hay que entender antes de escribir código contra él:

1. **`finance_daily_profit.amount_eur` puede ser negativo** (un día que se gastó más en ads de lo
   que entró) y eso se muestra tal cual — mismo criterio que `resultEur` en `overview.ts`, que
   "puede quedar negativo: gastar más de lo que entra es lo que hay que ver".
2. **El signo de `finance_movements` no lo eligen los routes de la API, lo garantiza el `CHECK`.**
   Un `POST` de gasto o retiro tiene que mandar el monto ya en negativo (o el route lo normaliza
   con `-Math.abs()`, ver §4) — si se manda en positivo, la base lo rechaza con un error de
   constraint, y el route lo tiene que traducir a un mensaje entendible (mismo patrón que
   `validarCombinacion` en `app/api/config/commissions/route.ts`).
3. **`finance_scheduled_payments.amount_eur` es POSITIVO** (es la plantilla, "el alquiler es 400"),
   pero el movimiento que genera es negativo. No son el mismo número con el mismo signo.

**Cómo revertir (regla 10 del SKILL: producción viva, siempre hay que decirlo).** Las 4 tablas son
enteramente nuevas y ninguna tabla existente las referencia (no hay FK entrante desde `orders`,
`daily_metrics` ni ninguna otra): revertir el esquema es `DROP TABLE
finance_scheduled_payment_runs, finance_scheduled_payments, finance_movements,
finance_daily_profit;` sin ningún efecto sobre el resto del panel. Si el problema es un dato
puntual mal cargado (no el esquema), no hace falta revertir nada: D9 ya permite editar o borrar
cualquier movimiento libremente desde la UI o con un `DELETE` directo.

## 4. Contrato — `lib/queries/finance.ts` — CONGELADO

Lo declara T01 completo. Lo consumen T02 (rutas de API) y T03 (UI). Nadie más lo modifica.

```ts
// ─── Lectura ────────────────────────────────────────────────────────────────

export type FinanceMovementKind = 'gasto' | 'retiro' | 'ajuste';
export type FinanceCategory = 'sueldos' | 'herramientas' | 'alquiler' | 'impuestos' | 'otros';

export type FinanceMovement = {
  id: number;
  kind: FinanceMovementKind;
  category: FinanceCategory | null;
  amountEur: number;              // negativo en gasto/retiro, cualquier signo != 0 en ajuste
  note: string;
  day: string;                    // 'YYYY-MM-DD'
  scheduledPaymentId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type ScheduledPayment = {
  id: number;
  name: string;
  category: FinanceCategory;
  amountEur: number;              // SIEMPRE positivo: es la plantilla, no un movimiento
  dayOfMonth: number;              // 1-28
  active: boolean;
  /** true si ya pasó su día este mes y todavía no generó el gasto (D8). */
  atrasado: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MonthlyPoint = {
  month: string;                  // 'YYYY-MM'
  profitEur: number;              // SUM(finance_daily_profit) del mes, 0 si no hay filas
  movementsEur: number;           // SUM(finance_movements) del mes, 0 si no hay filas
  netEur: number;                 // profitEur + movementsEur
};

export type FinanceOverview = {
  /** SUM(finance_daily_profit) + SUM(finance_movements) de TODO el histórico (D1). */
  patrimonioTotalEur: number;
  /** Los últimos 12 meses, SIEMPRE continuos: un mes sin filas aparece en 0, no se saltea (D-verificado #20). */
  byMonth: MonthlyPoint[];
  /** Pagos programados con atrasado=true. Se muestra como banner. */
  atrasados: ScheduledPayment[];
  generatedAt: string;
};

export async function getFinanceOverview(): Promise<FinanceOverview>;

export type MovementsFilters = { from?: string; to?: string; kind?: FinanceMovementKind };
export async function listMovements(f: MovementsFilters): Promise<FinanceMovement[]>;
export async function listScheduledPayments(): Promise<ScheduledPayment[]>;

// ─── Escritura (usadas por los routes de T02) ──────────────────────────────

export async function createMovement(input: {
  kind: FinanceMovementKind;
  category: FinanceCategory | null;
  amountEur: number;              // el valor ABSOLUTO tipeado por el usuario; esta función pone el signo
  note: string;
  day: string;
}): Promise<FinanceMovement>;

export async function updateMovement(id: number, input: Partial<{
  category: FinanceCategory | null; amountEur: number; note: string; day: string;
}>): Promise<FinanceMovement>;

export async function deleteMovement(id: number): Promise<void>;

export async function createScheduledPayment(input: {
  name: string; category: FinanceCategory; amountEur: number; dayOfMonth: number;
}): Promise<ScheduledPayment>;

export async function updateScheduledPayment(id: number, input: Partial<{
  name: string; category: FinanceCategory; amountEur: number; dayOfMonth: number; active: boolean;
}>): Promise<ScheduledPayment>;

export async function deleteScheduledPayment(id: number): Promise<void>;

/** Genera el gasto de cada pago atrasado. La usan el cron Y un botón manual "Ejecutar ahora". */
export async function runScheduledPayments(today: string): Promise<{ ejecutados: string[] }>;
```

**Reglas de implementación que no son negociables:**

1. **`createMovement` recibe el monto SIEMPRE positivo del formulario y ella misma le pone el
   signo** según `kind` (`gasto`/`retiro` → `-Math.abs(amountEur)`, `ajuste` → tal cual lo tipeó el
   usuario, que puede ser positivo o negativo con un toggle +/− en la UI). Así el formulario nunca
   le pide al usuario "escribí el número en negativo", que es como se cargan gastos en positivo por
   error.
   **`updateMovement` sigue la MISMA regla, no una distinta**: si el `input` trae `amountEur`, la
   función primero lee el `kind` actual de la fila (un `SELECT` antes del `UPDATE` — el `kind` no es
   editable, así que siempre es el mismo que ya tiene la fila) y le aplica la misma conversión de
   signo que `createMovement`. El formulario de EDICIÓN muestra y pide el valor absoluto, igual que
   el de alta — nunca le pide al usuario "reescribí el número con el signo que ya tenía". Sin esta
   regla explícita, T02 (que llama a `updateMovement` desde el PATCH) y T03 (que construye el
   formulario de edición) podrían asumir cada uno una convención distinta de signo, y el bug sólo
   aparecería al editar un gasto ya cargado — el caso que menos se prueba a mano.
2. **`byMonth` cubre SIEMPRE los últimos 12 meses completos, con `generate_series`, nunca
   `GROUP BY` directo sobre las filas que existan.** Un mes sin `finance_daily_profit` (el cron
   estuvo caído) tiene que aparecer en el gráfico con profit 0, no desaparecer — verificado en fase
   3 (#20), mismo criterio que `byDay` en `overview.ts`.
3. **El día de un movimiento es el que tipea el usuario (`day`), no `created_at`.** Un gasto de
   julio cargado en agosto (porque el usuario se olvidó) tiene que contar en julio.
4. **`runScheduledPayments` es idempotente por CADA pago, no aborta todo si uno falla.** Si hay 3
   pagos atrasados y el segundo tira una excepción (un `category` que ya no es válido, por ejemplo),
   los otros 2 se ejecutan igual y el error del segundo se devuelve en el resultado. Un cron que
   aborta entero por un pago roto deja los otros 2 sin ejecutar sin que nadie se entere hasta que
   alguien mire el patrimonio y no cierre.
5. **`patrimonioTotalEur` nunca se cachea ni se guarda: se calcula en cada llamada** (D1). Es una
   suma de dos `SELECT SUM(...)`, no una tabla con millones de filas — no hay problema de
   rendimiento que justifique cachearlo, y cachearlo es la puerta de entrada al bug que D1 evita.

## 5. Cron — `scripts/finance-rollup.ts` y `scripts/finance-scheduled-payments.ts`

Siguen el patrón exacto de `scripts/rollup.ts`: CLI con `main()`, `tsx`, `process.loadEnvFile`, y
`isMain` para poder importarse desde un test sin ejecutar la CLI.

```ts
// scripts/finance-rollup.ts
/** Recalcula finance_daily_profit para un rango. Query real en T01 §5. */
export async function financeRollupRange(opts: { from: string; to: string }): Promise<{ rows: number }>;
```

```ts
// scripts/finance-scheduled-payments.ts
import { runScheduledPayments } from '@/lib/queries/finance';
// El CLI llama a runScheduledPayments(await today(DASHBOARD_TZ)) y loguea el resultado.
```

**Reglas:**

- `financeRollupRange` sin argumentos recalcula **ayer y hoy** (2 días, no 1): el profit de "hoy"
  puede seguir cambiando durante el día (una venta que entra a las 23:50), así que el cron de la
  madrugada tiene que corregir el hoy-que-ya-fue y de paso refrescar el de ayer una vez más, mismo
  motivo que el rollup de `daily_metrics` toma `--days=3` por defecto y no 1.
- La query de `financeRollupRange` es la misma aritmética que ya usa `overview.ts` (bruto − devuelto
  − comisiones − costos − ads), agregada por día SIN filtrar por funnel — es la suma de TODOS.
  Verificada en fase 3 (#15).
- El orden en el cron importa: `finance-rollup.ts` corre DESPUÉS del rollup nocturno de
  `daily_metrics` (que a su vez corre después de `fetch-fx`). Si corriera antes, el profit del día
  se calcularía con datos de `daily_metrics` de la corrida anterior (hasta 24 h vieja). Mismo tipo
  de dependencia horaria que ya documenta `deploy/cron.panel` entre `fetch-fx` y `rollup`.
- `scripts/finance-scheduled-payments.ts` corre DESPUÉS de `finance-rollup.ts` (aunque no depende
  de sus datos, mantener el orden de "profit antes que gastos del día" hace que la UI, si alguien la
  mira a las 5:26 de la mañana, vea los dos ya actualizados juntos y no a medias).

## 6. Contrato de la UI — `app/(panel)/finanzas/**`

```
app/(panel)/finanzas/
├── page.tsx              server component — getFinanceOverview() + listMovements() + listScheduledPayments()
├── FinanzasView.tsx      client — patrimonio, gráfico mensual, tabla de movimientos, pagos programados
```

- **No usa `?range=` del `RangePicker` global.** El patrimonio es de TODO el histórico por
  definición (D1); el selector de rango del header no aplica a esta pantalla, igual que Resumen
  ignora el `?f=` del funnel. La tabla de movimientos sí tiene su propio filtro de fecha, local a la
  pantalla (en el query string propio, `?from=&to=`, D-R14 del resto del panel).
- **El gráfico de evolución mensual usa `Widget`/`ChartFrame` de `components/ui.tsx`**, con
  Recharts, mismo patrón que `catalogo-resumen.tsx`: NO se importa desde `page.tsx` (arrastra
  Recharts al server bundle), sólo desde `FinanzasView.tsx` (client).
- **Categorías**: un `<select>` con las 5 fijas, igual patrón que `kind` en
  `ComisionesSection.tsx` — no una tabla de configuración.
- **Ajuste**: un botón separado en el formulario de alta, no una opción dentro de "gasto". Al
  elegirlo, el campo de categoría desaparece (D4) y el campo de monto muestra un toggle +/− en vez
  de asumir negativo.

## 7. Dependencias y olas de paralelismo

```
Ola A (fundacional, sola):
  T01 — esquema + lib/queries/finance.ts + los dos scripts de cron

Ola B (en paralelo entre sí, las dos dependen de T01):
  T02 — rutas de API (app/api/finanzas/**)
  T03 — UI (app/(panel)/finanzas/** + Nav.tsx)

Ola C (sola, depende de T02 y T03):
  T04 — deploy: cron.panel, runbook.md, verificación end-to-end
```

| Task | Depende de | Se puede correr junto con |
|---|---|---|
| T01 | — | **nada, va sola** |
| T02 | T01 | T03 |
| T03 | T01 | T02 |
| T04 | T02, T03 | nada, va sola |

- T02 y T03 pueden arrancar los dos apenas T01 termina, porque los dos consumen el **tipo**
  `FinanceOverview`/`FinanceMovement` que T01 congela en §4, no la implementación interna de cada
  función. T03 puede escribir `FinanzasView.tsx` contra la forma de `FinanceOverview` sin que
  `getFinanceOverview` esté optimizada todavía.
- T03 SÍ necesita que T02 exista para poder probar la pantalla end-to-end (alta/edición/borrado
  llaman a los routes), pero puede escribirse en paralelo y probarse al final de la ola B — no hay
  una dependencia de escritura de archivos entre las dos, sólo de integración funcional.
- Si preferís ir de a uno: T01 → T02 → T03 → T04. El orden alternativo more conservador es T01 → T03
  (con los routes mockeados) → T02 → T04.

## 8. Ownership de archivos — regla anti-colisión

**Cada task solo escribe los archivos de su fila.** Si necesita algo de un archivo ajeno, lo lee
pero no lo escribe; si cree que necesita escribirlo, va a §10.

| Task | Archivos que puede crear o modificar |
|---|---|
| T01 | `db/migrations/022_finanzas.sql`, `lib/queries/finance.ts`, `lib/queries/finance.test.ts`, `scripts/finance-rollup.ts`, `scripts/finance-scheduled-payments.ts`, `scripts/finance-rollup.test.ts`, `package.json` (sólo agregar las 2 entradas `finance:rollup`/`finance:pagos` a `scripts`; no toca `dependencies` — regla 4 del SKILL) |
| T02 | `app/api/finanzas/movimientos/route.ts`, `app/api/finanzas/pagos-programados/route.ts`, `app/api/finanzas/pagos-programados/route.test.ts` (o `.test.ts` junto a cada route) |
| T03 | `app/(panel)/finanzas/page.tsx`, `app/(panel)/finanzas/FinanzasView.tsx`, `components/Nav.tsx` (**una sola línea**: agregar `{ href: '/finanzas', label: 'Finanzas' }` al array `TABS`) |
| T04 | `deploy/cron.panel` (agregar 2 líneas), `docs/runbook.md` (agregar una sección "Finanzas"), `tasks/finanzas/_verificacion-e2e.sh` |

**Archivos que NADIE toca**, y romper esto rompe producción:
```
lib/db.ts
lib/day.ts
lib/queries/overview.ts
lib/queries/sales.ts
scripts/rollup.ts
components/ui.tsx (salvo que T03 encuentre que de verdad falta un primitivo — entonces va a §10, no se agrega por su cuenta)
```

**El caso que parece colisión y no lo es:** T03 edita `components/Nav.tsx`, que en teoría "es de
todos". No colisiona porque el cambio es una sola línea aditiva al final del array `TABS`, y ninguna
otra task de este módulo toca ese archivo. Si en el momento de implementar otra rama del repo
también está tocando `Nav.tsx`, es una colisión con un cambio FUERA de este plan, no entre T01-T04.

## 9. Criterios de aceptación globales

1. `npm run build` y `npm test` pasan.
2. La migración `022_finanzas.sql` corrida dos veces en una base con 001-020 aplicadas no falla la
   segunda vez (idempotente). No se puede probar contra 001-021 completas por la limitación de la
   021 descrita en §3 — probarla contra 001-020 es la verificación disponible y ya se hizo.
3. Los cuatro `CHECK` de signo y categoría (§1 D3, D4) tienen al menos un test que prueba que
   rechazan el caso inválido — no alcanza con probar el caso válido.
4. Los endpoints de `/api/finanzas/**` rechazan sin cookie (401), igual que el resto de
   `/api/config/**` y `/api/data/**` — el middleware ya los cubre, pero cada route repite el guard
   explícito, mismo patrón que `_lib.ts`.
5. **Nada de lo que ya funcionaba cambió**: `getOverviewData` y `getSalesData` devuelven los mismos
   números antes y después de este módulo (no se tocó ninguna de sus queries ni sus tablas).
6. Un pago programado marcado `active=false` nunca genera un movimiento, verificado con un test que
   corre `runScheduledPayments` sobre un pago pausado y confirma que `finance_movements` sigue vacío.
7. Correr `runScheduledPayments` dos veces el mismo día para el mismo mes genera el gasto **una
   sola vez** (la segunda corrida no tira excepción visible al usuario: la detecta y la saltea en
   silencio, lo mismo que ya hace `rollupRange` con el `ON CONFLICT`).

## 10. Preguntas abiertas

Si aparece una decisión que este documento no resuelve, **se anota acá en lugar de decidirla en el
código**. Si bloquea, la task se detiene y no sigue con suposiciones.

### P-01 — La migración 021 no corre desde cero en una base nueva
- **Task:** ninguna de este módulo — es un hallazgo de la fase 3, preexistente al repo.
- **Sección del plan:** §3.
- **Archivo:** `db/migrations/021_reglas_por_cuenta.sql`.
- **Qué falta:** decidir si se documenta como "requiere seed manual de `ad_accounts` antes de
  migrar" en el runbook general del repo, o si se ajusta la migración para no abortar en una base
  sin cuentas. No es parte del alcance de Finanzas, pero como se detectó verificando el esquema
  022, queda registrado para que no se pierda.
- **Bloquea:** no (a este módulo). Sí bloquea a cualquiera que intente levantar una base 100 %
  nueva desde `npm run db:migrate` sin haber sincronizado anuncios primero — que hoy ya es el
  comportamiento real, este plan no lo cambia ni lo empeora.
- **Mientras tanto:** T01 aplica y verifica su esquema sobre 001-020 (sin la 021), que es
  exactamente lo que corre en cualquier despliegue que llegue a la 022 en orden — la 021 tiene que
  haber pasado (con las cuentas ya cargadas) antes de que exista una base con la 022 encima. En la
  base real de producción esto no aplica: las migraciones 001-021 ya están corridas.

### P-02 — Qué pasa si el patrimonio queda negativo
- **Task:** T03.
- **Sección del plan:** §6.
- **Archivo:** `FinanzasView.tsx`.
- **Qué falta:** el usuario no especificó si un patrimonio negativo necesita un tratamiento visual
  distinto (rojo, alerta) o simplemente se muestra el número tal cual, como ya hace `resultEur` en
  Resumen. Mientras tanto, se implementa igual que Resumen: el número se muestra con su signo, en
  tono `bad` si es negativo (mismo criterio que `StatCard tone="bad"` ya usa el resto del panel).
- **Bloquea:** no.
- **Resolución:** _(la completa el usuario si quiere algo distinto)_

### P-03 — Retención/borrado de pagos programados con historial
- **Task:** T02.
- **Sección del plan:** §4, D9.
- **Archivo:** `app/api/finanzas/pagos-programados/route.ts`.
- **Qué falta:** confirmar que borrar un pago programado (DELETE) está permitido en cualquier
  momento, incluso con `finance_movements` históricos apuntándole (que van a `scheduled_payment_id
  = NULL`, D9). El usuario no lo prohibió explícitamente, y es consistente con "9. sí" (edición
  libre). Mientras tanto: se implementa sin confirmación adicional más allá de un `confirm()` en el
  cliente, igual que `deleteCommission` en `ComisionesSection.tsx`.
- **Bloquea:** no.
- **Resolución:** _(la completa el usuario si quiere restringirlo)_

### P-04 — El CHECK de categoría del esquema canónico tenía un hueco NULL (corregido por T01)

- **Task:** T01.
- **Sección del plan:** §3, D4.
- **Archivo:** `db/migrations/022_finanzas.sql` / `tasks/finanzas/_schema-022.sql`.
- **Qué pasó:** el `CHECK finance_movements_categoria_solo_gasto` original era
  `(kind = 'gasto' AND category IN (...)) OR (kind <> 'gasto' AND category IS NULL)`.
  Un gasto con `category = NULL` lo pasaba: `NULL IN (...)` evalúa a `NULL`, no a
  `false`, y el `CHECK` completo quedaba `NULL` (= se aprueba). La verificación de
  fase 3 no lo cubría (ninguna de las 21 afirmaciones prueba "gasto sin categoría"),
  pero el test 2 de T01 sí, y lo descubrió. D4 dice explícitamente que la categoría
  es "obligatoria (una de las 5 fijas) para `gasto`", así que era un bug del esquema,
  no del test.
- **Fix aplicado:** se agregó `AND category IS NOT NULL` a la rama del gasto, en la
  migración Y en el esquema canónico (quedan iguales). Las 21 afirmaciones de
  `_verificacion-022.sql` siguen en verde (ninguna ejercita ese caso); se re-corrieron
  después del cambio para confirmarlo.
- **Bloquea:** no (ya resuelto por T01).

### P-06 — T02 necesita un archivo más que la fila del §8: `ejecutar-ahora/route.ts`

- **Task:** T02.
- **Sección del plan:** §8 (ownership) y T02 §4.
- **Archivo:** `app/api/finanzas/pagos-programados/ejecutar-ahora/route.ts`.
- **Qué pasó:** el `POST /api/finanzas/pagos-programados/ejecutar-ahora` del §4
  no puede vivir en el mismo `route.ts` que GET/POST/PATCH/DELETE (un route de
  Next 14 maneja UN solo path): se creó un sub-route aparte. Es un archivo que
  la fila del §8 no lista literalmente, pero que el §4 del propio task exige.
- **Bloquea:** no (ya resuelto por T02).

### P-07 — Sin cookie, el middleware responde 307 y no 401 (comportamiento del resto del panel)

- **Task:** T02 (verificación §6).
- **Sección del plan:** §9 criterio 4 y T02 §6 paso 2.
- **Archivo:** `middleware.ts` (no se tocó).
- **Qué pasó:** la verificación de T02 esperaba `401` en el curl sin cookie,
  pero el middleware de Next redirige TODO (incluido `/api/*`, excepto
  `api/ingest` y `api/webhooks`) a `/` con 307 cuando no hay cookie válida —
  es el comportamiento real de `/api/config/**` y `/api/data/**` existentes.
  El guard explícito de cada route (el `401` que documenta el plan §9) está y
  responde si el middleware se saltea; lo lockean los tests de T02 con auth
  mockeada (los 4 métodos → 401 sin tocar la base).
- **Bloquea:** no (es comportamiento heredado, idéntico al resto del panel).

### P-05 — La verificación de fase 3 tiene un leak de estado entre la afirmación 14 y la 16-19

- **Task:** T01 (verificación).
- **Sección del plan:** §3 (verificación `_verificacion-022.sql`).
- **Qué pasó:** corrido el archivo completo de punta a punta, la afirmación
  16-19 devolvió 2 filas ("Atrasado" + "Herramientas SaaS") en vez de la única
  fila documentada. La causa es interna al propio archivo: no es de la fase 3
  original — al capturar la `unique_violation` del segundo INSERT, el bloque
  `DO` de la afirmación 14 ROLLBACKEA también la corrida que ya había
  insertado en ese bloque (semántica del `EXCEPTION` de PL/pgSQL), dejando al
  pago 'Herramientas SaaS' (día 10, activo) sin run para 2026-08 → atrasado a
  los ojos de la query 16-19. Nada del esquema cambió para que esto pase.
- **Fix aplicado:** un `DELETE FROM finance_scheduled_payments WHERE name =
  'Herramientas SaaS'` al inicio de la afirmación 16-19, con comentario en el
  propio archivo. La afirmación vuelve a probar exactamente los 4 casos de D8
  y el resto de las 21 no se tocó.
- **Bloquea:** no (ya resuelto por T01).
