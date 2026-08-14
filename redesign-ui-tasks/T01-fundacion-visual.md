# T01 — Fundación visual: tokens, fuente, primitivos, migración y contratos

- **Depende de:** nada.
- **Bloquea:** T02, T03, T04, T05, T06 y T07. Ninguna arranca antes de que esta termine y compile.
- **Corre sola.** No paralelizar con nada.
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos que este task puede tocar:** los de la fila T01 de §8 del plan. Nada más.

Leé `00-PLAN-REDISENO.md` completo antes de escribir una línea. El §3 apunta al schema canónico
(`_schema-017.sql`), que se copia tal cual, y los §4 y §5 son los contratos congelados que este task
tiene que dejar escritos porque **seis tasks los van a importar sin poder modificarlos**.

---

## 1. Objetivo

Dejar el proyecto en un estado en el que:

- la paleta vive en `tailwind.config.ts` como tokens y **la pantalla se ve igual que antes**,
- hay una fuente declarada (Geist) y los números son monoespaciados,
- `components/ui.tsx` tiene los primitivos que faltaban, **sin haber cambiado ninguna firma existente**,
- `lib/widgets/tipos.ts` existe con los dos contratos completos,
- la migración 017 está aplicada y es idempotente,
- `npx tsc --noEmit` y `npm run build` pasan, y las 8 pantallas siguen funcionando.

Este task **no rediseña ninguna pantalla**. No toca `app/(panel)/resumen`, `ventas`, `embudo`,
`config`, `leads` ni `anuncios`. Si te encontrás editando una vista, estás en el archivo equivocado.

## 2. Los tres paquetes, declarados de una vez

```bash
npm install geist@1.7.2 @phosphor-icons/react@^2.1.7 @dnd-kit/core@^6.3.1 @dnd-kit/sortable@^10.0.0
```

Verificado que las cuatro versiones existen en npm. **`@dnd-kit` sólo lo usa T03**, pero se declara
acá (D-R15): que dos agentes editen `package.json` es un conflicto garantizado.

**Ni una dependencia más.** Si te parece que falta un paquete, va a §10 del plan. En particular: **no
instales `react-grid-layout`** (D-R03: los tamaños son discretos) ni `clsx`/`tailwind-merge` (el kit
concatena con template strings y funciona).

## 3. `tailwind.config.ts` — los tokens

Hoy el archivo es 19 líneas con `theme: { extend: {} }` y **toda la paleta está hardcodeada** en
clases arbitrarias repetidas por todo el proyecto: `bg-[#0a0a0f]`, `bg-[#13131a]`,
`border-white/[0.06]`, `bg-[#1b1b24]`, más la sombra larga de `Card`.

Mové eso a tokens. Los valores son **exactamente los que ya están**, así que el día 1 no cambia nada
visualmente (D-R13). Eso es a propósito: es lo que hace que este cambio sea seguro de revisar.

Los nombres tienen que decir **qué es**, no de qué color es. `bg-surface` sobrevive a un cambio de
paleta; `bg-gris-oscuro` no.

```
canvas          #0a0a0f    el fondo de la página
surface         #13131a    tarjetas, tablas, widgets
surface-raised  #1b1b24    tooltips, menús, lo que flota
border-subtle   la que hoy es white/[0.06]
border-strong   la que hoy es white/10
```

Y los tonos semánticos que `ui.tsx` ya usa (`good` emerald, `warn` amber, `bad` rose, `info` sky):
llevalos a tokens también, porque los colores de los gráficos hoy son literales (`#10b981`,
`#f43f5e`) escritos a mano en dos vistas y así se pueden importar de un solo lugar.

**Exportá los tokens también como valores JS**, en `tailwind.config.ts` o al lado, para que recharts
los pueda usar. Es el motivo por el que hoy hay literales duplicados: recharts recibe strings, no
clases de Tailwind.

**No agregues colores nuevos.** Este task no cambia la paleta, la nombra.

**`components/RangePicker.tsx` también es tuyo, y sólo para tokens.** Lo comparten Resumen, Ventas,
Embudo y Leads, así que ninguna de esas tasks lo puede tocar sin chocar con las otras: por eso está en
tu fila de §8 del plan. Cambiale las clases arbitrarias por tokens y **nada más** — su API y su
comportamiento quedan iguales, igual que con `ui.tsx` (D-R10).

## 4. La fuente — Geist vía `next/font`

En `app/layout.tsx` (hoy 15 líneas):

```ts
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
```

y las variables en el `<html>`, con `GeistSans` como `font-sans` y `GeistMono` como `font-mono` en el
config de Tailwind.

Tres cosas:

**1. Va en `app/layout.tsx`, no en `app/(panel)/layout.tsx`.** El `<body>` de hoy no tiene ninguna
clase: el fondo oscuro se aplica en el div raíz del route group. Si la fuente se declara sólo en el
grupo `(panel)`, la pantalla de login queda con otra tipografía.

**2. `next/font` la auto-hospeda.** No agregues un `<link>` a Google Fonts: agrega una petición a un
tercero desde el panel y produce FOUT.

**3. Los números van en `font-mono`, y no es decorativo** (D-R12). En una tabla de importes con fuente
proporcional las columnas no alinean y comparar dos filas obliga a leerlas en vez de mirarlas. El kit
hoy usa `tabular-nums`, que ayuda pero no alcanza cuando el ancho de los glifos cambia. Aplicalo en
`StatCard`, en las celdas `align: 'right'` de `Table` y en los ejes de los gráficos.

## 5. `db/migrations/017_rediseno_ui.sql`

**Copiá `redesign-ui-tasks/_schema-017.sql` tal cual.** Ya se ejecutó contra un PostgreSQL 16 con las
migraciones 001-016 aplicadas: corre limpio, es idempotente, y sus comentarios son el contrato que T04
y T07 van a asumir. No lo reordenes, no le agregues columnas y no le saques CHECK.

Crea: la tabla `funnel_stages` con 3 CHECK y 2 índices únicos parciales, el seed de 8 etapas para cada
funnel que tenga los slugs conocidos, y 2 filas en `settings` para los layouts.

**La base local está atrasada.** Verificado: tiene aplicadas la 001 a la 010 y le faltan la 011 a la
016. Antes de probar la 017 hay que correr `npm run db:migrate`, que va a aplicar siete migraciones de
una. No te sorprendas.

**Después de migrar, corré `_verificacion-017.sql`** y **leé la salida**, no sólo el exit code: sólo
los bloques 1, 2, 3, 4 y 10 tiran excepción, los otros cinco imprimen y hay que comparar contra su
`\echo`.

```bash
docker exec -i panel-db-1 psql -U panel -d panel -v ON_ERROR_STOP=1 \
  < redesign-ui-tasks/_verificacion-017.sql
```

## 6. `lib/widgets/tipos.ts` — los contratos

**El archivo más importante del rediseño.** Contiene los contratos de §4 y §5 del plan, tal como están
escritos ahí. Seis tasks lo importan y **ninguna lo puede modificar**, así que tiene que quedar
completo aunque este task no use ni un tipo.

Copiá de §4: `WidgetSize`, `WidgetPlacement`, `WidgetLayout`, `WidgetDef`, `WidgetGrupo`,
`WidgetCatalogo`. De §5: `EmbudoEtapa` y `EmbudoPorEtapas`.

**Los tipos van completos, no con `{ /* ... */ }`.** Un tipo con el cuerpo elidido compila como `{}` y
acepta cualquier cosa: deja de ser un contrato y pasa a ser un comentario. Si un tipo del plan te
parece incompleto, va a §10 del plan; no lo completes por tu cuenta.

Y dejá en el archivo, como comentario, las cinco reglas de §4 del plan. Las que más se van a
malinterpretar:

1. **Un `id` no se renombra nunca**: es la clave del layout que el usuario ya guardó.
2. **Un widget nunca hace fetch**: recibe `data` por parámetro.
3. **`render` usa el `size`**: un widget en 2x2 muestra más, no lo mismo más grande.

## 7. `components/ui.tsx` — SÓLO AGREGAR

Lo importan las 8 pantallas, incluidas las tres de Anuncios que se desplegaron el 2026-08-13
(D-R10). **No cambies la firma** de `Card`, `StatCard`, `Badge`, `Banner`, `Table`, `Column`,
`BarRow`, `Spinner`, `EmptyState`, `Tone` ni de los cinco formateadores.

Lo único permitido en lo existente es **cambiar clases arbitrarias por tokens**: si `Card` pasa de
`bg-[#13131a]` a `bg-surface` y `surface` vale `#13131a`, no cambió nada.

Agregá:

```ts
/** La grilla de 4 columnas del plan (D-R03). Colapsa a 2 en md y 1 en móvil. */
export function Grid({ children, className }: { children: ReactNode; className?: string }): JSX.Element;

/**
 * El contenedor de un widget. Ocupa `w` × `h` celdas de la Grid.
 * `onEdit` es opcional: sin él el widget es de sólo lectura (modo normal);
 * con él muestra el asa de arrastre y el menú de tamaño (modo edición).
 */
export function Widget(props: {
  title?: string; hint?: string; w: 1 | 2; h: 1 | 2;
  children: ReactNode; className?: string;
}): JSX.Element;

/**
 * El marco de un gráfico: alto fijo, ResponsiveContainer y el Tooltip común.
 * Existe porque hoy el MISMO Tooltip está duplicado idéntico en ResumenView
 * L389-395 y VentasView L679-685, y cada vista define su propio fmtAxis.
 */
export function ChartFrame(props: { alto?: 'sm' | 'md' | 'lg'; children: ReactNode }): JSX.Element;

/** Esqueleto con la FORMA del contenido. Reemplaza al spinner centrado. */
export function Skeleton(props: { variant: 'kpi' | 'chart' | 'table' | 'text'; rows?: number }): JSX.Element;

/** La barra de acciones de una pantalla: título a la izquierda, controles a la derecha. */
export function Toolbar(props: { title: string; badge?: ReactNode; children?: ReactNode }): JSX.Element;

/** Un botón de sólo icono, con aria-label OBLIGATORIO en el tipo. */
export function IconButton(props: {
  label: string; onClick: () => void; children: ReactNode;
  tone?: Tone; disabled?: boolean;
}): JSX.Element;

/** El formateador de ejes que hoy está duplicado en dos vistas. */
export function fmtAxis(n: number): string;
```

Cinco reglas para los primitivos nuevos:

**1. `Skeleton` reemplaza al spinner y tiene la forma del contenido.** Un spinner centrado no dice
cuánto falta ni qué viene; un esqueleto con tres barras del alto de un KPI sí. El `Spinner` existente
**se queda** (lo usan las 8 pantallas para el estado "actualizando") pero las cargas iniciales pasan a
esqueleto.

**2. `IconButton` exige `label` en el tipo, no como recomendación.** Un botón de sólo icono sin
`aria-label` es invisible para un lector de pantalla. Que el tipo lo obligue es más barato que
revisarlo en cada llamador.

**3. `ChartFrame` centraliza el Tooltip y `fmtAxis`.** Hoy están duplicados y ya divergieron en
detalles. Al centralizarlos, los dos gráficos que existen tienen que seguir viéndose igual: mirá los
dos antes y después.

**4. `Widget` en modo normal no muestra ningún control.** El asa de arrastre y el menú de tamaño
aparecen sólo en modo edición. Un panel que siempre muestra sus asas parece un editor, no un panel.

**5. Nada de hooks.** El kit se importa desde server components (`app/(panel)/layout.tsx` lo hace).
Un `useState` en `ui.tsx` rompe las 8 pantallas con un error de RSC que no dice eso. `Widget` recibe
todo por props; el estado vive en `WidgetGrid` (T03).

## 8. `lib/widgets/catalogo-demo.tsx` — el catálogo de juguete

T03 necesita un catálogo para probar el `WidgetGrid` y los catálogos reales son de T05 y T06, que
corren después (§8 del plan, la única excepción a la exclusividad).

Tres widgets con datos hardcodeados: uno `1x1`, uno `2x1` y uno `2x2` con un gráfico. Con
`tamañosPermitidos` distintos entre ellos, para que T03 pueda probar que el menú de tamaño respeta el
catálogo.

**Primera línea del archivo:**

```tsx
// Catálogo de juguete: sirve para probar WidgetGrid en aislamiento (T03).
// NO SE BORRA al terminar el rediseño: es lo que permite aislar el runtime de
// los datos cuando algo se rompa. T05 y T06 tienen sus propios catálogos.
```

**No lo borres al final** y no lo llenes con los widgets reales.

## 9. Verificación

Nada de esto es opcional. Un task que no corre su verificación no está terminado, y "compila" no es
verificación.

```bash
cd ~/Desktop/funnel/dashboard-admin

# 1 — compila y los tests siguen pasando
npx tsc --noEmit && npm run build && npm test
# esperado: tsc y build en 0. Los tests siguen en 262 con base (o 208 sin
# DATABASE_URL, con 54 salteados). Si BAJÓ el número, rompiste algo.

# 2 — LA MIGRACIÓN se aplica y es idempotente
npm run db:migrate
npm run db:migrate                # la segunda: "0 aplicadas", exit 0

# 3 — la tabla y el seed
docker exec panel-db-1 psql -U panel -d panel -c \
  "SELECT f.slug, count(*) AS etapas,
          count(*) FILTER (WHERE st.starts_at_slug IS NOT NULL) AS de_paso,
          count(*) FILTER (WHERE st.milestone IS NOT NULL) AS de_hito
     FROM funnel_stages st JOIN funnels f ON f.id=st.funnel_id GROUP BY 1 ORDER BY 1;"
# esperado: una fila por funnel, 8 etapas, 5 de paso y 3 de hito

# 4 — la verificación lógica, y HAY QUE LEERLA
docker exec -i panel-db-1 psql -U panel -d panel -v ON_ERROR_STOP=1 \
  < redesign-ui-tasks/_verificacion-017.sql
# los 10 bloques tienen que dar lo que dice su \echo.
# Sólo 1, 2, 3, 4 y 10 tiran excepción: los otros cinco imprimen y hay que
# comparar. El §7 tiene que dar 0 pasos sin etapa en los DOS funnels.

# 5 — NINGUNA FIRMA EXISTENTE CAMBIÓ (D-R10). Es el criterio que protege
#     las 8 pantallas, incluidas las de Anuncios recién desplegadas.
grep -nE "^export (function|type|const) " components/ui.tsx | sed 's/(.*//' | sort
# Los 15 exports de antes tienen que seguir estando, con el mismo nombre:
#   Tone Card StatCard Badge Banner Column Table BarRow Spinner EmptyState
#   fmtInt fmtPct fmtMoney fmtDate fmtDateTime
# más los 7 nuevos: Grid Widget ChartFrame Skeleton Toolbar IconButton fmtAxis

# 6 — LAS 8 PANTALLAS SIGUEN ANDANDO. Esto no se saltea: es el único criterio
#     que atrapa un cambio de firma que tsc no vio porque el tipo era compatible.
npm run dev
# y abrí las ocho, mirando que no haya nada roto ni descolocado:
#   /resumen /embudo /ventas /leads /anuncios /anuncios/reglas
#   /anuncios/historial /config
# En particular: las tarjetas siguen con el mismo fondo, las tablas alinean, y
# los DOS gráficos que ya existían (Resumen "Neto por día", Ventas "Neto por
# día") se ven igual que antes de centralizar el Tooltip.

# 7 — la fuente cargó de verdad, y en TODA la app
#     En devtools → Network, filtrá por "font": tienen que aparecer los woff2 de
#     Geist. Y en Elements, el <html> tiene que tener las dos variables.
#     Mirá también la pantalla de LOGIN (fuera del route group (panel)): si ahí
#     la fuente es distinta, la declaraste en el layout equivocado (§4).

# 8 — los números son monoespaciados
#     En /ventas, mirá la columna de importes de "Últimas ventas": los dígitos
#     tienen que alinear verticalmente entre filas. Si bailan, falta font-mono.

# 9 — el token no cambió la paleta
#     Comparalo contra una captura previa, o más simple: no debería haber NINGÚN
#     cambio visual perceptible en esta task salvo la fuente.
grep -rn "#0a0a0f\|#13131a\|#1b1b24\|white/\[0.06\]" components/ui.tsx components/RangePicker.tsx | head
# esperado: CERO líneas. Si quedan literales, el token no se aplicó y el
# próximo cambio de color va a ser otro find-replace.

# 10 — no se tocó nada fuera de la fila T01 de §8 del plan
find . -newermt '-3 hours' -type f \
  -not -path './node_modules/*' -not -path './.next/*' -not -path './.git/*' \
  -not -name '*.log' -not -name 'tsconfig.tsbuildinfo' | sort
# `git diff` NO sirve acá: dashboard-admin no está trackeado en el repo del
# padre (~/Desktop/funnel sólo trackea .kiro y funnel-mate), así que el diff
# sale vacío y el criterio "sólo mis archivos" se cumple siempre. Verificado.
#
# esperado: tailwind.config.ts, app/globals.css, app/layout.tsx,
# components/ui.tsx, components/RangePicker.tsx, lib/widgets/tipos.ts,
# lib/widgets/catalogo-demo.tsx,
# db/migrations/017_rediseno_ui.sql, package.json, package-lock.json.
# Si aparece una vista de app/(panel)/, revertila: no es de este task.
```

## 10. Cuándo parar

**Bloqueante, pará y avisá:**

- **Una firma de `ui.tsx` cambió** (verificación 5) o una de las 8 pantallas se rompió
  (verificación 6). Seis tasks van a construir encima y tres pantallas están en producción.
- `npm run build` no pasa, o `npm test` devuelve menos tests que antes.
- La migración no es idempotente, o `_verificacion-017.sql` falla un bloque.
- **El seed dejó 0 etapas en algún funnel.** Significa que sus slugs no son los conocidos, y T04 se
  queda sin embudo por etapas. Anotá los slugs reales y avisá: hay que ajustar el seed, no el código.

**Anotalo en §10 del plan y seguí:**

- Un tipo del §4 o del §5 te parece incompleto. **No lo completes**: anotá qué falta. Cambiar
  `lib/widgets/tipos.ts` después de que arranque la ola A rompe tres tasks a la vez.
- Te falta un primitivo en `ui.tsx` que no está en la lista del §7. Anotalo con para qué lo querías:
  si lo agregás ahora, T05 y T06 no lo van a conocer.
- La paleta actual tiene un color que no encaja en ningún token (algo que no es `canvas`, `surface`,
  `surface-raised` ni un tono semántico). Anotá dónde estaba: probablemente sea un one-off que
  conviene unificar, y esa es una decisión del usuario.
