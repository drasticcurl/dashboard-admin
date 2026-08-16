# T03 — Pantalla /finanzas + pestaña en el navbar

- **Depende de:** T01 (`lib/queries/finance.ts`, para los tipos vía `import type`).
- **Bloquea:** nada directamente. Para probar alta/edición/borrado end-to-end necesitás que T02
  esté funcionando, pero podés escribir toda la pantalla contra la FORMA de los tipos sin esperar.
- **Se puede correr en paralelo con:** T02.
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos que este task puede tocar:** `app/(panel)/finanzas/page.tsx`,
  `app/(panel)/finanzas/FinanzasView.tsx`, y **una sola línea** en `components/Nav.tsx` (agregar
  `{ href: '/finanzas', label: 'Finanzas' }` al array `TABS`). Nada más.

Leé `00-PLAN-FINANZAS.md` completo. Tu contrato es el §4 (los tipos de `lib/queries/finance.ts`) y
el §6 (el contrato de esta UI).

---

## 1. Objetivo

Cuando termines:

- `/finanzas` aparece como pestaña en el navbar, entre "Anuncios" y "Leads" (mismo orden relativo
  que en el plan — no importa mucho, pero mantené alguno consistente).
- La pantalla muestra: patrimonio total (grande, arriba), gráfico de evolución mensual (12 meses),
  banner de pagos atrasados si hay alguno, tabla de movimientos con alta/edición/borrado, y una
  sección de pagos programados con alta/edición/pausado/borrado.

**Este task no calcula nada.** Toda la aritmética (patrimonio, evolución mensual, qué está
atrasado) viene ya calculada de `getFinanceOverview()`. Si te parece que falta un cálculo, es una
pregunta para T01/§10 del plan, no algo que sumás en el componente.

## 2. Antes de escribir, leé tres archivos completos

1. **`app/(panel)/resumen/page.tsx` y `ResumenView.tsx`**: el patrón de server component que hace
   el fetch inicial + client component que mantiene estado y refetchea. Qué copiar: la estructura
   general y el uso de `StatCard`/`Card`/`Banner` de `components/ui.tsx`. Qué NO copiar: Resumen
   depende de `?range=` del `RangePicker` global — tu pantalla NO usa ese selector (plan §6: el
   patrimonio es de todo el histórico, no de un rango). Ignorá `searchParams.range` por completo.

2. **`app/(panel)/config/sections/ComisionesSection.tsx`**: el patrón de formulario de alta/edición
   con un objeto de estado (`comForm`), un `editCom: number | null` para saber si estás editando o
   creando, y el flujo `saveCommission` → `refetchCommissions` → limpiar el form. Tu
   `FinanzasView.tsx` usa el mismo patrón para movimientos y para pagos programados (dos forms
   independientes, mismo patrón cada uno).

3. **`lib/widgets/catalogo-resumen.tsx`**: cómo se usa Recharts dentro de un componente client sin
   romper el bundle del server. Tu gráfico de evolución mensual sigue el mismo patrón: vive
   enteramente en `FinanzasView.tsx` (`'use client'`), nunca se importa desde `page.tsx`.

## 3. `app/(panel)/finanzas/page.tsx`

```tsx
export const dynamic = 'force-dynamic';

export default async function FinanzasPage() {
  const [overview, movements, scheduledPayments] = await Promise.all([
    getFinanceOverview(),
    listMovements({}),               // sin filtro: los últimos N, ver abajo
    listScheduledPayments(),
  ]);
  return (
    <FinanzasView
      initialOverview={overview}
      initialMovements={movements}
      initialScheduledPayments={scheduledPayments}
    />
  );
}
```

Sin lectura de `searchParams` para rango de fechas global (a diferencia de Resumen/Ventas/Embudo).
`listMovements({})` sin filtro trae TODO el historial — si te preocupa el volumen, limitá a los
últimos 90 días por defecto en la propia función de T01 (es su decisión, no la tuya: si te parece
que hace falta, anotalo en §10 del plan en lugar de agregar un `LIMIT` de tu lado en el route).

## 4. `FinanzasView.tsx`

Estructura, de arriba a abajo:

1. **El patrimonio**, con `StatCard` grande (o un bloque custom si `StatCard` no alcanza para el
   tamaño que querés — mirá cómo Resumen resalta el neto). Tono `bad` si es negativo, igual que
   `resultEur` en Resumen (ver P-02 del plan, no bloqueante, es el default hasta que el usuario diga
   otra cosa).

2. **Banner de atrasados**, arriba y visible, tono `warn` (igual criterio que los banners de
   calidad de dato en Ventas — "no está roto, falta cargar/ejecutar"):
   ```
   "3 pagos programados atrasados: Alquiler, Sueldos, Hosting" [Ejecutar ahora]
   ```
   El botón "Ejecutar ahora" llama a `POST /api/finanzas/pagos-programados/ejecutar-ahora` (de
   T02) y refetchea todo. Si T02 todavía no existe cuando escribís esto, dejá el botón deshabilitado
   con un `disabled` y seguí — no es una dependencia de escritura de archivos, es de integración
   funcional (ver plan §7).

3. **Gráfico de evolución mensual**: `ChartFrame` con un `BarChart` (o `LineChart`) de Recharts, eje
   X = `month`, una serie `netEur` (la que importa) y opcionalmente `profitEur`/`movementsEur` como
   contexto. 12 puntos, siempre — vienen así de `getFinanceOverview().byMonth`, no filtres ni
   agrupes de nuevo en el cliente.

4. **Tabla de movimientos**: `Table<FinanceMovement>` de `components/ui.tsx`, columnas: fecha
   (`fmtDate`), tipo (`Badge` con tono distinto por `kind`: `gasto` neutral, `retiro` info, `ajuste`
   warn), categoría (o `—` si es null), nota, monto (`fmtMoney(amountEur, 'EUR')`, ya viene con
   signo — no le apliques `Math.abs`), acciones (editar/borrar). Filtro local por `kind` con un
   `<select>` simple (client-side, sobre los datos ya traídos — no hace falta un refetch al
   servidor para esto, a diferencia de cómo Ventas sí refetchea por filtro de servidor).

5. **Formulario de alta de movimiento**: mismo patrón que el form de comisiones. Un `<select>` de
   `kind` (gasto/retiro/ajuste). Si `kind === 'gasto'`, aparece el `<select>` de categoría
   (obligatorio). Si `kind === 'ajuste'`, aparece un toggle +/− al lado del campo de monto (dos
   botones o un segmented control simple) en vez de asumir el signo. El campo de monto SIEMPRE se
   tipea en positivo (el valor absoluto); es la UI la que decide qué signo mandarle al backend según
   `kind` y el toggle — el backend (T02) espera exactamente esto (ver su plan §3 regla 2).

6. **Sección de pagos programados**: `Table<ScheduledPayment>`, columnas: nombre, categoría, monto
   (siempre positivo, es la plantilla), día del mes, estado (`Badge`: activo/pausado, y si
   `atrasado === true` un `Badge tone="warn"` adicional que diga "Atrasado"), acciones
   (editar/pausar-activar/borrar). Formulario de alta con los mismos 4 campos
   (`name`/`category`/`amountEur`/`dayOfMonth`), sin toggle de signo (siempre positivo, plan §4 D5).

**Reglas de implementación:**

- **El monto de un movimiento se muestra con `fmtMoney(m.amountEur, 'EUR')` directo, sin
  `Math.abs()` ni lógica de signo en el render.** `fmtMoney` de `components/ui.tsx` ya maneja
  negativos correctamente (usa `Intl.NumberFormat`), y el signo es información: un gasto de −500 se
  tiene que VER negativo en la tabla, no como "500" con un ícono al lado. Ocultar el signo en la UI
  es exactamente el tipo de bug que D3 del plan (el `CHECK` de la base) previene en la escritura —
  no lo reintroduzcas en la lectura.
- **El toggle de signo del ajuste es EXCLUSIVAMENTE visual/de armado del payload**: el estado
  interno puede guardar el valor absoluto + un booleano `esNegativo`, y al armar el body del POST
  hacés `amountEur: esNegativo ? -Math.abs(valor) : Math.abs(valor)`. No mandes nunca `0`
  (deshabilitá el submit si el campo está vacío o es 0).
- **No agregues un selector de rango de fechas global a esta pantalla.** Si en algún momento
  parece necesario (por ejemplo, "ver movimientos sólo de este trimestre"), es un filtro LOCAL de la
  tabla de movimientos (con su propio estado, no con `?range=` del header), porque el patrimonio de
  arriba nunca depende de ningún rango (D1 del plan).
- **Accesibilidad**: los botones de sólo ícono (si usás alguno para editar/borrar en la tabla) usan
  `IconButton` de `components/ui.tsx`, que exige `label` en el tipo — no armes un `<button>` sin
  `aria-label` a mano.

## 5. `components/Nav.tsx`

Una sola línea, dentro del array `TABS` ya existente:

```ts
const TABS = [
  { href: '/resumen', label: 'Resumen' },
  { href: '/embudo', label: 'Embudo' },
  { href: '/ventas', label: 'Ventas' },
  { href: '/anuncios', label: 'Anuncios' },
  { href: '/finanzas', label: 'Finanzas' },   // ← la línea nueva
  { href: '/leads', label: 'Leads' },
  { href: '/config', label: 'Config' },
];
```

No toques nada más de ese archivo: ni el selector de funnel, ni la lógica de tab activa, ni los
estilos. Es un archivo que otras 6 pantallas importan.

## 6. Tests

Este proyecto no usa jsdom/testing-library (`vitest.config.ts`: `environment: 'node'`) — no hay
convención de testear componentes React en este repo. No agregues un framework nuevo para esto: si
querés cubrir algo de lógica de la pantalla (por ejemplo, el armado del payload del toggle +/−),
extraé esa función a un helper puro fuera del componente y testeala como función normal, siguiendo
el patrón de `lib/*.test.ts`. No es obligatorio para este task si toda la lógica queda simple
dentro del JSX.

## 7. Verificación

```bash
# 1 — build
npm run build                          # esperado: exit 0, sin warnings de "Recharts en un server component"

# 2 — arrancá el dev server y mirá en el browser
npm run dev
# abrí http://localhost:3005/finanzas (logueado)
```

Lo que hay que revisar a mano en el browser (esto no se verifica con curl):

- La pestaña "Finanzas" aparece en el navbar y navega bien, preservando el resto del query string
  (mismo comportamiento que las otras tabs — no debería requerir código extra, es gratis por cómo
  está armado `Nav.tsx`).
- El patrimonio se ve, con signo correcto si es negativo.
- El gráfico de evolución mensual muestra 12 puntos (podés sembrar un par de filas de prueba en
  `finance_daily_profit`/`finance_movements` a mano con `psql` para ver algo).
- Cargar un gasto, un retiro y un ajuste desde el formulario, y ver que aparecen en la tabla con el
  signo correcto sin recargar la página.
- Cargar un pago programado con un `day_of_month` de ayer, y confirmar que aparece en el banner de
  atrasados.
- Navegación con teclado: Tab a través del formulario y de las acciones de la tabla llega a todos
  los controles interactivos, con foco visible (mismo estándar que el resto del panel, heredado de
  `components/ui.tsx`).

## 8. Cuándo parar

**Bloqueante, pará y avisá:**
- Si `lib/queries/finance.ts` no tiene un campo que la pantalla necesita mostrar (por ejemplo,
  descubrís que hace falta paginar `listMovements` porque hay miles de filas). No le agregues un
  campo a mano ni pagines del lado del cliente descartando datos: anotalo en §10 del plan.

**Anotalo en §10 del plan y seguí:**
- Decisiones de estilo/layout no cubiertas acá (tamaño exacto del gráfico, orden de columnas de la
  tabla) — usá tu criterio siguiendo el lenguaje visual ya establecido por el resto del panel.
- **Necesitás modificar un archivo ajeno** (que no sea la línea de `Nav.tsx` ya autorizada) → nunca;
  anotalo.
