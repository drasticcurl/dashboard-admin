# T05 — Resumen con widgets configurables

- **Depende de:** T01, **T02** (los campos nuevos) y **T03** (el `WidgetGrid`). Las tres terminadas.
- **Bloquea:** nada.
- **Paralelizable con:** T06. Ninguna de las dos toca los archivos de la otra.
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos que este task puede tocar:**
  `app/(panel)/resumen/**`, `lib/widgets/catalogo-resumen.tsx`. **Nada más.**

Leé `00-PLAN-REDISENO.md` completo, en especial **§4 (el contrato de widgets)** y **D-R04/D-R05**.

---

## 1. Objetivo

Convertir Resumen en una pantalla de widgets configurables: lista de widgets, agregar, sacar,
reordenar arrastrando, cambiar tamaño, guardar con botón.

**Resumen hoy es la pantalla que mejor está** (411 líneas, 4 StatCards, se lee bien) y es el modelo
que el plan usa como referencia de jerarquía. Así que este task es **menos destructivo que T06**: no
hay que arreglar un desastre, hay que hacer configurable algo que ya funciona.

**La consecuencia práctica: el layout por defecto tiene que verse como se ve hoy.** Un usuario que
entra después del rediseño y no toca nada tiene que encontrar la misma pantalla. Los widgets son para
quien los quiera cambiar, no un cambio forzado.

## 2. El catálogo — `lib/widgets/catalogo-resumen.tsx`

`WidgetCatalogo<OverviewData>`. Los datos entran una vez y bajan a cada widget: **ningún widget hace
fetch** (§4 regla 2 del plan).

### Antes que nada: `import type`, o `pg` entra al bundle

`lib/queries/overview.ts` importa `@/lib/db`, que importa `pg`. **Un client component no puede
importar ese módulo como valor**: arrastra el driver de Postgres al bundle del browser.

```ts
import type { OverviewData, FunnelSummary } from '@/lib/queries/overview';  // OK: se borra al compilar
import { getOverviewData } from '@/lib/queries/overview';                    // NO en un client component
```

`import type` es seguro porque TypeScript lo elimina en la compilación. Un import de valor no. Si
necesitás una fórmula de ese archivo en el cliente, reproducila inline: es lo que las vistas ya hacen
hoy, y hay un comentario en `sales.ts` que lo explica.

### Lo que hay disponible

De `OverviewData`: `totals`, `funnels` (un `FunnelSummary[]` ya ordenado por neto descendente),
`byDay`, `alerts`, `staleRollup`, `prev`, `lastRollupAt`.

**T02 agregó campos nuevos**: en `totals`, `grossEur`, `quizStarted`, `salesViews`, `checkoutClicks`,
`refundRate`, `netMargin`, `convSessionToSale`, `convCheckoutToSale`, `revPerSession`, `cpa`; en cada
`FunnelSummary`, `refundRate`, `netMargin`, `convCheckoutToSale`, `convSessionToQuiz`,
`convQuizToSalesView`, `revPerSession`, `cpa`; en `prev`, `adSpendEur` y `resultEur`.

**Leé T02 §2 antes de formatear un número.** Dos trampas:

1. **Las unidades están mezcladas en el mismo objeto.** `overview.ts` devuelve los ratios en **tanto
   por uno** y `fmtPct` **no multiplica**: el idioma es `fmtPct(x * 100)`. Un `*100` de más da 2800 %.
2. **Los campos nuevos son `number | null`; los viejos devuelven `0`.** `null` significa "no se puede
   calcular" y **se muestra como `—`, no como 0**. `fmtPct` y `fmtMoney` ya devuelven `'—'` para
   valores no finitos, así que el idioma es `fmtPct((x ?? NaN) * 100)`. No hace falta nada nuevo.

### Los widgets

Cubrí los seis grupos del contrato. Como referencia, no como lista cerrada:

- **`plata`**: neto, resultado (neto − ads), bruto, gasto en ads, devuelto, ticket promedio.
- **`volumen`**: sesiones, órdenes, quiz arrancado, vistas de la venta, clicks al checkout.
- **`eficiencia`**: ROAS, CPA, conversión sesión→venta, checkout→venta, ingreso por sesión, margen.
- **`calidad`**: tasa de devolución, órdenes sin tier, estado del rollup, alertas.
- **`graficos`**: neto por día, el apilado por funnel (`byDay.perFunnel`), sesiones por día.
- **`listas`**: la tabla de funnels, las alertas.

Reglas:

- **`id` estable y para siempre** (§4 regla 1): es la clave del layout guardado. Para cambiar el
  nombre visible se cambia `label`.
- **`hint` en todos los que sean un ratio.** "ROAS" sin explicación no dice nada; "bruto ÷ gasto en
  ads" sí. Es donde el panel deja de necesitar que alguien te lo explique.
- **`render` usa el `size`** (§4 regla 3): en 1x1 número + label; en 2x1 agrega el sub y el trend
  contra `prev`; en 2x2 agrega un sparkline de `byDay`. Un widget en 2x2 muestra **más**, no lo mismo
  más grande.
- **`tamañosPermitidos` honesto:** un gráfico **no** va en 1x1, la tabla de funnels **no** va en 1x1.
  Si un widget se ve mal en un tamaño, no lo ofrezcas.

### Los widgets que hoy existen se conservan

Los 4 StatCards actuales, el gráfico de neto por día, la tabla de funnels y el bloque de alertas
**tienen que estar en el catálogo** y **en el layout por defecto**. Ninguno se pierde (§9.5 del plan).

## 3. La pantalla — `app/(panel)/resumen/**`

El `WidgetGrid` de T03 reemplaza la grilla fija. Lo que **no** cambia de dueño:

- **el `RangePicker` y `?range=`**: siguen igual, arriba, fuera de los widgets;
- **el banner de `staleRollup`** y el pie con `lastRollupAt`: son estado del sistema, no un widget.
  Si el rollup está muerto, el aviso no puede depender de que el usuario tenga ese widget puesto;
- **los links de `alerts`** (`href` a `/ventas?f=…` y `/config`) siguen funcionando.

**El layout guardado se lee en el servidor**, en la página, y baja como prop. Si lo pedís con un fetch
desde el cliente, la pantalla se dibuja con el layout por defecto y **salta** al del usuario: es la
clase de parpadeo que hace que un panel se sienta roto.

**Los tres estados** (§9.10 del plan): cargando con `Skeleton` que tenga la forma de los widgets (no un
spinner centrado), vacío compuesto con qué hacer, y error con reintentar.

## 4. Verificación

```bash
cd ~/Desktop/funnel/dashboard-admin
npx tsc --noEmit && npm run build && npm test
npm run dev
```

```
# 1 — EL LAYOUT POR DEFECTO SE VE COMO ANTES (§1)
#     Con la fila de settings en null, /resumen tiene que mostrar los 4 KPIs,
#     el gráfico, la tabla de funnels y las alertas. Un usuario que no toca
#     nada no debería notar que cambió el sistema.
docker exec panel-db-1 psql -U panel -d panel -c \
  "UPDATE settings SET value=NULL WHERE key='ui_layout_resumen';"

# 2 — LOS NÚMEROS NO CAMBIARON (§9.4 del plan). El criterio más importante.
#     Anotá antes de empezar, con rango 30d: neto total, órdenes, gasto de ads.
#     Al terminar tienen que ser IDÉNTICOS. Un número movido es un bug de
#     cálculo disfrazado de rediseño.

# 3 — el ciclo completo de edición
#     editar → agregar de la lista → arrastrar → cambiar tamaño → sacar →
#     "cambios sin guardar" → Guardar → F5 → IGUAL.
#     Y: cambiar el rango NO resetea el layout.

# 4 — guardar vacío queda vacío (D-R04)
#     Sacá todos los widgets, Guardar, F5: la pantalla sigue vacía.
#     Si te vuelven los 4 KPIs, el bug está en T03 §2 — avisá, no lo parchees acá.

# 5 — LAS UNIDADES. El error de 100x, y el de null.
#     Con datos reales: la conversión sesión→venta ronda 1,4 % (no 140 %, no
#     0,014 %). Y sin ad_spend cargado, el CPA muestra "—" (campo nuevo, null),
#     mientras el ROAS muestra 0 (campo viejo). Esa diferencia en la misma
#     pantalla es la decisión de T02 §2.2, no un bug.

# 6 — NINGUNA FUNCIÓN SE PERDIÓ (§9.5). Uno por uno:
#     RangePicker · ?range= · banner de staleRollup · pie con lastRollupAt ·
#     alertas con sus links a /ventas?f= y /config · tabla de funnels ordenada
#     por neto · gráfico de neto por día.

# 7 — el banner de rollup NO depende de tener un widget puesto (§3)
docker exec panel-db-1 psql -U panel -d panel -c \
  "UPDATE daily_metrics SET computed_at = now() - interval '2 hours';"
#     recargá con la pantalla VACÍA de widgets: el aviso de rollup viejo TIENE
#     que verse igual. Después: npm run rollup para dejarlo sano.

# 8 — teclado (§9.8): Tab llega a todo con foco visible, el arrastre se hace
#     con teclado, y ningún control es un <div> con onClick.

# 9 — no se tocó nada fuera de la fila T05 de §8 del plan
find . -newermt '-3 hours' -type f \
  -not -path './node_modules/*' -not -path './.next/*' -not -path './.git/*' \
  -not -name '*.log' -not -name 'tsconfig.tsbuildinfo' | sort
# esperado: SÓLO app/(panel)/resumen/** y lib/widgets/catalogo-resumen.tsx.
# Si aparece components/ui.tsx o lib/widgets/tipos.ts, revertilo: son de T01.
```

## 5. Cuándo parar

**Bloqueante, pará y avisá:**

- **Un número cambió** (verificación 2).
- **El layout por defecto no reproduce la pantalla de hoy** (verificación 1): el rediseño le estaría
  cambiando la pantalla a alguien que no pidió cambiarla.
- **Guardar vacío devuelve los widgets por defecto**: es un bug de T03, avisá en lugar de parchearlo
  en el catálogo.
- **Se perdió una función** de la lista de la verificación 6.

**Anotalo en §10 del plan y seguí:**

- Te falta un campo para un widget que tiene sentido. **No agregues SQL ni toques
  `lib/queries/overview.ts`**: es de T02. Anotá el widget y el campo que le faltaba.
- Te falta un primitivo de `ui.tsx`. Es de T01: resolvelo local en el catálogo y anotalo.
- Un widget se ve mal en un tamaño que le permitiste. Sacale el tamaño de `tamañosPermitidos` (eso sí
  es tuyo) y anotalo si el caso es general.
- **Cuántos widgets pusiste en el layout por defecto.** Nadie midió 25 widgets con recharts en
  pantalla (§11.4 del plan). Si va lento, anotá con cuántos empezó a notarse.
