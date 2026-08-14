# T06 — Ventas: jerarquía real y widgets configurables

- **Depende de:** T01, **T02** (los campos nuevos) y **T03** (el `WidgetGrid`). Las tres terminadas.
- **Bloquea:** nada.
- **Paralelizable con:** T05. Ninguna de las dos toca los archivos de la otra.
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos que este task puede tocar:**
  `app/(panel)/ventas/**`, `lib/widgets/catalogo-ventas.tsx`. **Nada más.**

Leé `00-PLAN-REDISENO.md` completo, en especial **§1 (el diagnóstico medido)**, **§4 (el contrato de
widgets)** y **D-R04/D-R05/D-R14**.

---

## 1. Objetivo

Ventas es **la pantalla que motivó el rediseño**. Medido: `VentasView.tsx` son **746 líneas** con
**12 StatCards** en una grilla `lg:grid-cols-5` y **6 Banners**.

Doce números del mismo tamaño no tienen jerarquía. No hay un dato principal: hay doce iguales, y el
usuario tiene que leerlos todos para encontrar el que buscaba. Seis banners apilados arriba tampoco
son seis avisos: son una pared que se deja de leer.

Entonces, dos cosas:

1. **Jerarquía real.** Unos pocos números grandes arriba, el resto disponible como widgets. La grilla
   de 5 columnas se va.
2. **Widgets configurables**, igual que Resumen: lista, agregar, sacar, arrastrar, cambiar tamaño,
   guardar con botón.

**El objetivo NO es esconder los doce números.** Todos siguen disponibles en el catálogo. Lo que
cambia es que el usuario elige cuáles ve arriba, y por defecto ve pocos y grandes en lugar de doce
chicos y todos iguales.

## 2. El detalle técnico que rompe el build si lo pasás por alto

`lib/queries/sales.ts` importa `@/lib/db`, que importa `pg`. **Un client component no puede importar
ese módulo**: arrastra el driver de Postgres al bundle del browser.

El propio archivo lo dice, arriba de `upsellTakeRate`:

> *La pantalla las reproduce inline: importar este archivo desde un client component arrastraría pg al
> bundle del browser.*

Así que en `catalogo-ventas.tsx` y en cualquier componente cliente:

```ts
import type { SalesData, SalesTotals, TierRow } from '@/lib/queries/sales';   // OK: se borra al compilar
import { upsellTakeRate } from '@/lib/queries/sales';                          // NO: arrastra pg
```

**`import type` es seguro** porque TypeScript lo elimina en la compilación. **Un import de valor no.**
Si necesitás `upsellTakeRate` o `realAov` en el cliente, reproducí la fórmula inline, que es lo que la
vista ya hace hoy.

**Y ojo con la unidad de esas dos:** `upsellTakeRate` devuelve **0-100** (hace `* 100` adentro),
mientras el resto de los ratios de `sales.ts` van en tanto por uno. Es la única excepción del archivo
(T02 §2.1). Si la reproducís inline, reproducí también la unidad, o el número sale 100 veces más
chico.

## 3. El catálogo — `lib/widgets/catalogo-ventas.tsx`

`WidgetCatalogo<SalesData>`. Los datos entran una vez y bajan a cada widget: **ningún widget hace
fetch** (§4 regla 2 del plan).

### Lo que hay disponible

De `SalesData`: `totals` (un `SalesTotals` con **más de 30 campos**), `byTier`, `byCampaign`,
`bySource`, `byDay`, `recent` (las últimas 50 órdenes), `unattributed`.

**Casi todos los widgets ya existen como número calculado.** `SalesTotals` trae `grossOrig/grossEur`,
`refundedOrig/refundedEur`, `netOrig/netEur`, `commissionsOrig/commissionsEur`,
`costsOrig/costsEur`, `adSpendOrig/adSpendEur`, `resultOrig/resultEur`, `roas/roasEur`, `cpa/cpaEur`,
`spendTotalOrig/spendTotalEur`, `roi/roiEur`, `avgTicketEur`, `ordersApproved`, `ordersRefunded`,
`ordersChargeback`, `ordersSinComision`, `ordersSinCosto`, `fxStaleCount`, `unknownTierCount`.

**T02 agregó**: `refundRate`, `netMargin`, `avgTicketOrig`, `commissionRate`, `costRate`.

Dos trampas, las mismas que en T05 (leé T02 §2):

1. **Unidades mezcladas.** Los ratios de `sales.ts` van en **tanto por uno** (`roi` de 0,035 son
   3,5 %) y `fmtPct` **no multiplica**: el idioma es `fmtPct(x * 100)`. Más la excepción de
   `upsellTakeRate`, que ya viene en 0-100 (§2).
2. **Los campos nuevos son `number | null`; los viejos devuelven `0`.** `null` se muestra **`—`, no
   0**. `fmtPct` y `fmtMoney` ya dan `'—'` para valores no finitos: `fmtPct((x ?? NaN) * 100)`.

### El toggle EUR/ARS y los pares de moneda

Esta pantalla tiene un toggle de moneda, y por eso **casi todos los importes vienen en dos versiones**
(`netOrig`/`netEur`). El widget elige según el toggle, y `totals.currency` es la moneda del funnel.

**No convertias nada en el componente.** Cada día se convirtió con su propia cotización, así que
dividir un total en euros por una cotización del día de hoy da un número distinto al que la query ya
calculó. Los pares existen para eso.

Hay un comentario en `sales.ts` que explica por qué `roas` y `roasEur` no son idénticos (1,196 contra
1,189): son ratios calculados en monedas distintas, no un error de redondeo.

### Los grupos

- **`plata`**: neto, resultado, bruto, devuelto, comisiones, costos, gasto en ads, gasto total,
  ticket promedio.
- **`volumen`**: órdenes aprobadas, devueltas, chargebacks, sin atribuir.
- **`eficiencia`**: ROAS, ROI, CPA, margen neto, tasa de comisión, tasa de costo, take rate del
  upsell, AOV real.
- **`calidad`**: tasa de devolución, órdenes sin comisión cargada, sin costo cargado, con FX
  provisoria, sin tier.
- **`graficos`**: neto por día, devuelto por día, el mix por tier.
- **`listas`**: últimas ventas, por campaña (con su gasto y ROAS), por fuente, por tier.

Reglas del contrato que se aplican igual que en T05: **`id` estable para siempre** (es la clave del
layout guardado), **`hint` obligatorio en los ratios** (nadie sabe qué es el ROI acá sin leer el
comentario de la query), **`render` usa el `size`**, y **`tamañosPermitidos` honesto** (la tabla de
últimas 50 ventas no va en 1x1).

## 4. Los 6 banners

Hoy son seis, apilados. No se borran: se **consolidan**.

La diferencia entre un aviso y un widget es si el usuario puede **elegir no verlo**. Los que dicen
"tus datos están mal" no pueden ser un widget que alguien saque sin querer:

- **Quedan como aviso fijo** (fuera de los widgets): FX provisoria (`fxStaleCount`), órdenes sin tier
  (`unknownTierCount`), y el cajón sin atribuir (`unattributed.orders`) — ese último tiene link al
  filtro y es cómo se llega ahí.
- **Pasan a widgets del grupo `calidad`**: los que son métricas de completitud de la config
  (`ordersSinComision`, `ordersSinCosto`).

**Consolidá los que quedan fijos en un solo bloque**, no seis cajas apiladas. Un bloque con tres
líneas se lee; seis banners no.

**Todos conservan su link.** El de sin atribuir apunta a `?f=__unattributed__` (la constante
`UNATTRIBUTED_FUNNEL`), y es la única forma de ver ese cajón.

## 5. La pantalla — `app/(panel)/ventas/**`

El `WidgetGrid` de T03 reemplaza la grilla de 12 StatCards. Lo que **no** cambia de dueño:

- **el selector de funnel** (incluido el cajón `__unattributed__`) y el `RangePicker`;
- **los filtros** de tier, campaña, fuente y status, con sus valores en el query string;
- **el toggle EUR/ARS**;
- **la tabla de últimas ventas** con su orden y sus estados;
- **los avisos fijos del §4.**

**`?cur=` va al query string** (D-R14). Hoy `showEur` vive en `useState`: no sobrevive a un refresh y
no se puede compartir por link. Y ojo, el valor inicial sale de `getDefaultCurrencyView()`
(`settings.default_currency_view`), así que el orden es: query string si está, si no el setting, si no
EUR. **No pierdas el setting**: es configurable desde Config y alguien lo eligió.

**El layout guardado se lee en el servidor** y baja como prop. Un fetch desde el cliente dibuja el
layout por defecto y después salta al del usuario.

**Los tres estados** (§9.10 del plan): `Skeleton` con la forma de los widgets, vacío compuesto, error
con reintentar.

## 6. Verificación

```bash
cd ~/Desktop/funnel/dashboard-admin
npx tsc --noEmit && npm run build && npm test
npm run dev
```

```
# 1 — EL BUNDLE NO TIENE pg (§2). Es el error que rompe el build o infla el
#     bundle sin decir por qué.
npm run build 2>&1 | grep -iE "pg|Module not found|Can't resolve" || echo "OK: sin rastro de pg"
grep -rn "from '@/lib/queries/sales'" lib/widgets/catalogo-ventas.tsx app/\(panel\)/ventas/
#     esperado: TODOS los imports de ese módulo en componentes cliente son
#     `import type`. Un import de valor arrastra el driver de Postgres.

# 2 — LOS NÚMEROS NO CAMBIARON (§9.4 del plan). El criterio más importante.
#     Anotá antes de empezar, con rango 30d y un funnel fijo: neto, órdenes
#     aprobadas, gasto de ads, ROI. Al terminar tienen que ser IDÉNTICOS.

# 3 — LA JERARQUÍA CAMBIÓ DE VERDAD (§1). No es cosmético:
grep -ro '<StatCard' app/\(panel\)/ventas/ | wc -l
#     Medido antes de esta task: 12 instancias, en lg:grid-cols-5.
#     (Usá grep -o y no grep -c: grep -c cuenta LÍNEAS con match e incluye la
#     del import, así que da 13 y no 12.)
#     Si sigue habiendo 12 tarjetas iguales arriba, el task no cumplió su
#     objetivo: sólo le cambió el envoltorio.
grep -ro '<Banner' app/\(panel\)/ventas/ | wc -l
#     Medido antes: 6. Los de datos malos quedan (consolidados en un bloque),
#     los de config pasan a widgets (§4).

# 4 — el ciclo completo de edición
#     editar → agregar de la lista → arrastrar → cambiar tamaño → sacar →
#     "cambios sin guardar" → Guardar → F5 → IGUAL.
#     Y: cambiar el rango, el funnel o la moneda NO resetea el layout.

# 5 — guardar vacío queda vacío (D-R04)
docker exec panel-db-1 psql -U panel -d panel -tAc \
  "SELECT value FROM settings WHERE key='ui_layout_ventas';"
#     Sacá todos los widgets, Guardar, F5: sigue vacía, y la fila dice
#     {"v": 1, "widgets": []} — no null. Si te vuelven los widgets por
#     defecto, es un bug de T03 §2: avisá, no lo parchees acá.

# 6 — EL LAYOUT DE VENTAS NO PISA EL DE RESUMEN (D-R04, son dos filas)
#     Guardá un layout en Ventas, abrí Resumen: el de Resumen intacto.
docker exec panel-db-1 psql -U panel -d panel -c \
  "SELECT key, value IS NULL AS vacio FROM settings WHERE key LIKE 'ui_layout%';"

# 7 — ?cur= SOBREVIVE AL REFRESH Y NO PISA EL SETTING (§5, D-R14)
#     a) tocá el toggle → la URL tiene ?cur=ARS → F5 → sigue en ARS
#     b) SIN ?cur= en la URL, la moneda inicial es la de settings:
docker exec panel-db-1 psql -U panel -d panel -c \
  "UPDATE settings SET value='\"ARS\"'::jsonb WHERE key='default_currency_view';"
#     abrí /ventas sin ?cur= → tiene que arrancar en ARS. Después volvelo a EUR.

# 8 — LAS DOS MONEDAS SON CONSISTENTES (§3)
#     Con el toggle en ARS, ningún importe puede mostrar el número en euros con
#     el símbolo de peso. Chequeá especialmente el ticket promedio: hasta T02
#     sólo existía avgTicketEur y era el caso roto.

# 9 — las unidades: el error de 100x
#     Con datos reales, el ROI ronda 3,5 % (no 0,035 %, no 350 %) y el take
#     rate del upsell usa su propia unidad 0-100 (§2).

# 10 — NINGUNA FUNCIÓN SE PERDIÓ (§9.5). Uno por uno:
#      selector de funnel · el cajón __unattributed__ y su link · RangePicker ·
#      filtros de tier, campaña, fuente y status · toggle EUR/ARS ·
#      tabla de últimas ventas · avisos de FX provisoria y sin tier ·
#      tabla por campaña con su gasto y ROAS · por fuente · por tier.

# 11 — el cajón sin atribuir sigue alcanzable
#      Abrí /ventas?f=__unattributed__: tiene que cargar. Es el único camino a
#      esas órdenes y es fácil de romper al rehacer el selector.

# 12 — teclado (§9.8) y cero window.alert / console.log (§9.9)
grep -rn "window.alert\|console.log" app/\(panel\)/ventas/ lib/widgets/catalogo-ventas.tsx
#      esperado: sin resultados.

# 13 — no se tocó nada fuera de la fila T06 de §8 del plan
find . -newermt '-3 hours' -type f \
  -not -path './node_modules/*' -not -path './.next/*' -not -path './.git/*' \
  -not -name '*.log' -not -name 'tsconfig.tsbuildinfo' | sort
# esperado: SÓLO app/(panel)/ventas/** y lib/widgets/catalogo-ventas.tsx.
# Si aparece lib/queries/sales.ts, revertilo: es de T02.
```

## 7. Cuándo parar

**Bloqueante, pará y avisá:**

- **Un número cambió** (verificación 2).
- **`pg` entró al bundle** o un componente cliente importa un valor de `lib/queries/sales.ts` (§2).
- **Siguen habiendo 12 tarjetas iguales arriba** (verificación 3): el task no cumplió su objetivo.
- **El cajón `__unattributed__` dejó de ser alcanzable** (verificación 11).
- **Un importe se muestra en la moneda equivocada** con el toggle en ARS (verificación 8).
- **Guardar vacío devuelve los widgets por defecto**: bug de T03, avisá.

**Anotalo en §10 del plan y seguí:**

- **Cuántos y cuáles widgets pusiste en el layout por defecto**, y por qué esos. Es la decisión de
  jerarquía que este task toma y la que el usuario va a querer discutir: fue su queja original.
- Te falta un campo para un widget. **No toques `lib/queries/sales.ts`**: es de T02. Anotá el widget y
  el campo.
- Un banner que dejaste fijo debería ser widget, o al revés. El criterio del §4 es "¿puede el usuario
  elegir no verlo?": si te parece que uno cae del otro lado, anotalo.
- Si va lento con muchos widgets (§11.4 del plan), anotá con cuántos empezó.
