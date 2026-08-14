# REDISEÑO DE LA UI DEL PANEL — documento maestro

**Todo agente lee este archivo completo antes de abrir su task.**

Rediseño de las 8 pantallas de `https://panel.hilvanapp.com`. Tres objetivos que el usuario pidió con
estas palabras: que esté **más organizado** (hoy "está inusable"), que los **widgets de Resumen y
Ventas se puedan modificar** (lista de widgets, agrandar, achicar, reordenar), y que **Embudo tenga
una gráfica de embudo literal por partes**.

**Esto no es un cambio de estilo. Es un cambio de jerarquía.** El diagnóstico está medido en §1: el
problema no es que el panel se vea mal, es que no decide qué importa.

---

## 0. Qué se construye y qué no

**Se construye**

1. Un sistema de **tokens** en Tailwind y una **fuente** de verdad, para que la paleta deje de estar
   hardcodeada en 9.800 líneas.
2. Los **primitivos que faltan**: grilla, contenedor de widget, marco de gráfico, esqueletos de carga.
3. Un **runtime de widgets** con catálogo, tamaños fijos (1x1, 1x2, 2x1, 2x2), reordenamiento
   arrastrando y **botón de guardar** que persiste en la VPS.
4. Las **métricas nuevas** que hoy no existen, más las que ya se calculan y nadie muestra.
5. Un **embudo literal por etapas configurables por funnel**, con la lista paso a paso al lado.
6. El rediseño de las **8 pantallas**, con Config partida en pedazos navegables.
7. Los **estados que faltan**: carga, vacío y error, que hoy están a medias en varias pantallas.

**No se construye** (explícito para que ningún agente lo invente)

- **Usuarios ni permisos.** La auth sigue siendo contraseña compartida. Consecuencia inevitable en
  D-R04: el layout de widgets es global.
- **Modo claro.** El panel es dark-only y sigue igual. Un toggle duplica el trabajo de cada pantalla
  y nadie lo pidió.
- **Drag-resize libre.** Los tamaños son cuatro combinaciones discretas (D-R03).
- **Widgets con datos nuevos de fuentes nuevas.** Todo widget sale de las tres queries que ya
  existen, extendidas (T02). Nada de integraciones nuevas.
- **Cambios en la ingesta, el rollup, ni las migraciones 001-016.**
- **Gráficos que no sean recharts.** Ya está instalado y alcanza (D-R06).
- **Tests de componentes.** No hay `@testing-library` en el proyecto y agregarlo es otro proyecto.
  La verificación de UI es manual y con checklist, y está escrita en cada task.

---

## 1. El diagnóstico, medido

No "se ve mal". Esto:

| Pantalla | Síntoma medido | Por qué es el problema |
|---|---|---|
| **Ventas** | **12 StatCards + 6 banners** en una grilla de 5 columnas, 746 líneas | Doce números del mismo tamaño no tienen jerarquía: no hay un dato principal, hay doce iguales. El usuario tiene que leerlos todos para encontrar uno |
| **Config** | **9 secciones en 1.528 líneas**, sin navegación interna | Es una sola página infinita. Para llegar a "Cotizaciones" hay que scrollear por Funnels, Publicidad, Comisiones, pasos del quiz y productos |
| **Embudo** | **22 y 27 pasos** en una lista de barras | La lista está bien para encontrar el peor paso, pero no hay ninguna vista que muestre la forma del embudo |
| **Todas** | `tailwind.config.ts` con `theme: { extend: {} }`, `globals.css` de 3 líneas | Cero tokens. `bg-[#13131a]` y `border-white/[0.06]` repetidos a mano en cada archivo: cambiar un color es un find-replace |
| **Todas** | Sin `next/font` | Cae en `system-ui`: SF en Mac, Segoe en Windows. El panel no se ve igual en dos máquinas |
| **Todas** | Sin librería de iconos | Los "iconos" son los caracteres `▾ ▲ ▼ ↓ ↑` y la letra `P` del logo |
| **Kit** | `components/ui.tsx` sin `Grid` ni wrapper de gráficos | Cada vista escribe su grilla a mano y **duplica el mismo Tooltip de recharts** (idéntico en `ResumenView` L389-395 y `VentasView` L679-685) |
| **Filtros** | `base`, `showEur`, orden de tablas viven en `useState` | No sobreviven a un refresh y no se pueden compartir por link |

Resumen, en cambio, tiene 4 StatCards y se lee bien. **Es la prueba de que el problema es de
jerarquía y no de estilo**, y es el modelo a seguir.

---

## 2. Decisiones cerradas

No hay nada que decidir. Si aparece algo que este documento no resuelve, se anota en §9 y **no se
decide en el código**.

**D-R01 — El alcance de la skill que se usó, dicho de frente.** El rediseño se planificó con
`redesign-existing-projects` (aplica entera) y con `design-taste-frontend` **parcialmente y a
propósito**: esa skill declara en su §13 que **no es para dashboards, tablas de datos ni UI de
producto densa**, y manda decirlo en lugar de aplicarla igual. De ahí se toman tipografía, color,
estados interactivos y la lista de AI tells. **No** se toman sus reglas de landing (hero, conteo de
eyebrows, marquees, densidad de copy): son para páginas de marketing y este es un panel de datos.

Consecuencia práctica que sí se adopta de ella: **`VISUAL_DENSITY` alto** (8-10 en su escala). Es un
cockpit de datos, así que los números van en fuente monoespaciada, las tarjetas se usan sólo cuando
la elevación comunica jerarquía, y en las tablas separan líneas de 1px, no contenedores.

**D-R02 — Se trabaja sobre el stack que hay. No se migra nada.** Tailwind `3.4.1`, Next `14.2.5`,
React 18, recharts `2.15.4`. Nada de Tailwind v4, nada de shadcn, nada de CSS-in-JS. La regla de
`redesign-existing-projects` es explícita y acá se cumple: mejorar lo que está, no reescribirlo.

**D-R03 — Cuatro tamaños de widget, no drag-resize libre.**

```
1x1   una columna, alto simple      (un KPI)
2x1   dos columnas, alto simple     (un KPI ancho o una lista corta)
1x2   una columna, alto doble       (una lista vertical)
2x2   dos columnas, alto doble      (un gráfico)
```

La grilla es de 4 columnas en `xl`, 2 en `md`, 1 en móvil. Los cuatro tamaños son las cuatro
combinaciones de `w ∈ {1,2}` × `h ∈ {1,2}`, así que **no hace falta un enum de tamaños aparte**: el
layout guarda `w` y `h` y con eso está dicho todo.

Por qué no drag-resize libre: `react-grid-layout` son ~30 kB, trae su propio CSS que pelea con
Tailwind, y en una grilla de 4 columnas los tamaños intermedios no existen. El usuario eligió
tamaños fijos.

**D-R04 — El layout se guarda en la VPS, con botón, y es GLOBAL. Hay que decirlo en la pantalla.**
Pedido explícito del usuario: en la base, con un botón de guardar (no autosave).

Va a `settings` como `ui_layout_resumen` y `ui_layout_ventas` (dos filas, no una: guardar Resumen no
puede pisar Ventas). Y acá está la consecuencia que **no se esconde**: el panel se autentica con una
contraseña compartida y **no hay usuarios**, así que el layout lo ven todos. Si dos personas usan el
panel, el que guarda último gana y el otro ve cambiar su pantalla sin haberla tocado.

No es un bug del rediseño, es el modelo de auth del panel. La barra de configuración lo dice con
estas palabras: **"este layout lo ven todos los que entran al panel"**.

Tres estados distintos y hay que distinguirlos:

| Valor en `settings` | Significa |
|---|---|
| fila con `null` | el usuario nunca guardó → **mostrar el layout por defecto** |
| `{"v":1,"widgets":[]}` | el usuario guardó una pantalla **sin widgets** → respetarlo, mostrar el vacío |
| `{"v":1,"widgets":[…]}` | el layout del usuario |

Tratar `null` y `[]` igual hace que "borré todos los widgets" se vea como "no configuré nada" y el
panel le devuelva los widgets por defecto al recargar. Verificado en `_verificacion-017.sql` §9.

**D-R05 — El botón de guardar es explícito, y hay que mostrar que hay cambios sin guardar.** Con
autosave, arrastrar un widget por accidente cambia la pantalla de todos para siempre. Con botón, la
barra muestra "cambios sin guardar" y un botón de descartar. Y al salir de la pantalla con cambios
pendientes, se avisa.

**D-R06 — La gráfica de embudo se hace con recharts, sin dependencia nueva.** `recharts 2.15.4` ya
exporta `Funnel`, `FunnelChart`, `LabelList` y `Trapezoid` (verificado: los cuatro existen en el
paquete instalado). Está instalado y ya en uso en dos pantallas.

**D-R07 — Las etapas del embudo son configurables POR FUNNEL, en su propia tabla.** Pedido explícito
del usuario ("tiene que ser individual por funnel").

Van en `funnel_stages` (migración 017) y **no en una columna de `funnel_steps`**, y el motivo no es
estético: `app/api/config/steps/route.ts` (el POST de "Importar pasos") hace

```sql
DELETE FROM funnel_steps WHERE funnel_id = $1;
INSERT INTO funnel_steps (funnel_id, step_index, slug, label, kind) VALUES ...
```

Cualquier columna que no esté en ese INSERT vuelve a su default en cada importación. **Ya le pasa a
`counts_in_funnel`**, que se resetea a `true` en silencio y que `lib/funnels.ts:60` sí lee: es un bug
preexistente y **T07 lo arregla**. Una columna `stage` ahí habría tenido el mismo destino, y el
síntoma habría sido "las etapas se borran solas cuando toco los pasos".

**Las etapas se referencian por SLUG, no por `step_index`.** El slug es estable; el índice no.
Reordenar el quiz cambia todos los índices y dejaría cada frontera apuntando al paso equivocado **sin
ningún error**: el embudo mostraría partes mal armadas y nadie sabría por qué. Con el slug, reordenar
mueve la frontera con su paso, y si un slug desaparece la etapa queda huérfana de forma **detectable**
(`_verificacion-017.sql` §6).

**D-R08 — Las 8 partes del embudo y las dos decisiones que el usuario delegó.** El seed de la 017
deja esto para los dos funnels (los dos comparten los slugs de contenido, verificado contra
producción):

| # | Etapa | Sale de |
|---|---|---|
| 0 | Landing | paso `landing_hook` |
| 1 | Preguntas | paso `edad` en adelante |
| 2 | Puente al experto | paso `expert_bridge` |
| 3 | Diagnóstico | paso `diagnosis_result` |
| 4 | Página de venta | paso `sales_page` |
| 5 | Vio la venta | hito `sales_view` |
| 6 | Clickeó comprar | hito `checkout_click` |
| 7 | Compró | hito `purchase` |

El usuario dijo "hacelo como vos veas", así que **quedan anotadas las dos decisiones que se tomaron
por él**, con cómo revertirlas:

- **`viral_news` ("Nota viral", paso 4) NO abre etapa propia: cuenta dentro de Preguntas.** Es un
  paso de contenido que cae en medio del quiz, entre la pregunta 3 y la 5. Si abriera etapa,
  "Contenido" agruparía el paso 4 (mucha gente) con los pasos 18-20 (poca) y la etapa tendría dos
  conteos posibles: el trapecio se ensancharía. Para separarlo hay que partir Preguntas en dos, y se
  hace agregando una etapa que arranque en `nombre` (paso 5) desde la UI de Config.
- **`loading_steps` ("Armando el plan") NO abre etapa propia: cuenta dentro de Diagnóstico.** Es una
  pantalla de carga donde casi nadie se cae, así que sumaría un trapecio que no informa. Para
  separarla, una fila más en Config.

**El conteo de una etapa es el de su ÚLTIMO paso**, no el del primero: una etapa se completó cuando
la sesión la atravesó entera. Tomar el primero daría una etapa que no cae nunca.

**D-R09 — EL EMBUDO NO ES MONÓTONO Y ESTÁ MEDIDO. El ancho se recorta, el número no.**

Los pasos salen del histograma de `max_step_index`; los hitos salen de columnas propias
(`sales_view_at`, `checkout_click_at`, `purchased_at`). Son fuentes distintas, así que un hito puede
tener **más** sesiones que el paso que lo precede. Medido en producción, `chauhinchazon`, 30 días:

```
Landing            4011
Preguntas          1086
Puente al experto  1027
Diagnóstico         880
Página de venta     820   ← del histograma de pasos
Vio la venta        821   ← de sales_view_at: UNA MÁS
Clickeó comprar     199
Compró               56
```

Una sesión tiene `sales_view_at` sin haber alcanzado el paso 21. No es un error de datos: las dos
columnas se escriben en momentos distintos y una sesión puede saltar.

**Cómo se dibuja:** el **ancho** del trapecio se recorta al de la etapa anterior, para que la figura
siga siendo un embudo. El **número** que se muestra es el real, y la etapa lleva una marca visible
con el motivo en un `title`. El número es la verdad; la figura es la ilustración. Recortar el número
escondería el dato; ensanchar el trapecio parecería un bug del gráfico.

**D-R10 — `components/ui.tsx` se toca, pero SÓLO AGREGANDO.** Lo importan las 8 pantallas, incluidas
las tres de Anuncios que se desplegaron el 2026-08-13. El plan de Anuncios lo declaró intocable
(D-A19) porque cuatro tasks lo importaban en paralelo; esa razón ya no aplica, pero la de no romper
producción sí.

Así que T01 **agrega** `Grid`, `Widget`, `ChartFrame`, `Skeleton`, `Toolbar`, `IconButton` y los
tokens, y **no cambia la firma** de `Card`, `StatCard`, `Badge`, `Banner`, `Table`, `Column`,
`BarRow`, `Spinner`, `EmptyState` ni de los cinco formateadores. Con eso las 8 pantallas siguen
compilando sin tocarse, y cada task rediseña la suya cuando le toca.

El único cambio de comportamiento permitido en lo existente es **visual y por tokens**: si
`Card` pasa de `bg-[#13131a]` a `bg-surface`, y `surface` vale `#13131a`, no cambió nada el día 1.

**D-R11 — Los iconos son de una sola librería y no se dibujan a mano.** Se agrega
`@phosphor-icons/react`. Motivo de elegir Phosphor y no Lucide: `design-taste-frontend` marca Lucide
como el default de LLM y pide diferenciar, y Phosphor tiene pesos (`thin`/`regular`/`bold`) que
sirven para la densidad alta de este panel. **`strokeWidth` uniforme en todo el proyecto**, y ningún
`<svg>` escrito a mano.

**D-R12 — La fuente es Geist vía `next/font`, con Geist Mono para los números.** Se agrega el paquete
`geist` (1.7.2). `next/font` la auto-hospeda: no hay `<link>` a Google Fonts, no hay FOUT y no hay
petición a un tercero desde el panel.

**Los números van en Geist Mono, y no es decorativo**: en una tabla de importes con fuente
proporcional las columnas no alinean y comparar dos filas obliga a leerlas. Hoy el kit usa
`tabular-nums`, que ayuda pero no alcanza cuando el ancho de los glifos cambia.

**D-R13 — Los tokens van en `tailwind.config.ts`, y el día 1 no cambia nada visualmente.** Se define
la paleta actual como tokens con nombre, se reemplazan las clases arbitrarias, y el resultado es
idéntico. Es el paso que hace posible todo lo demás: sin tokens, cada ajuste de color es un
find-replace en 9.800 líneas y siempre queda uno afuera.

**D-R14 — Los filtros de cada pantalla van al query string.** Hoy `base` (Embudo), `showEur`
(Ventas) y el orden de las tablas viven en `useState`: no sobreviven a un refresh y no se pueden
compartir por link. Pasan a `?base=`, `?cur=`, `?sort=`. El `range` y el `f` ya funcionan así.

**D-R15 — Cero dependencias más allá de estas.** Tres cosas, cuatro entradas en `package.json`:

```
geist@1.7.2                    la fuente (D-R12)
@phosphor-icons/react@^2.1.7   los iconos (D-R11)
@dnd-kit/core@^6.3.1           el arrastre (D-R03) — son dos paquetes
@dnd-kit/sortable@^10.0.0      del mismo proyecto
```

Las cuatro versiones existen en npm (verificado). **T01 las declara todas de una vez**, incluso
`@dnd-kit`, que sólo usa T03: que dos agentes editen `package.json` es un conflicto garantizado.

**D-R16 — El reordenamiento arrastrando lleva alternativa de teclado, no es opcional.** `@dnd-kit`
trae `KeyboardSensor` y se usa. Un drag sin teclado deja el panel inoperable para quien no puede usar
el mouse, y es la clase de cosa que no se agrega después.

---

## 3. Schema — fuente de verdad

**`_schema-017.sql` de esta carpeta es el DDL canónico y ya se ejecutó** contra un PostgreSQL 16 con
las migraciones 001-016 aplicadas: corre limpio y es idempotente (la segunda corrida no hace nada).
T01 lo copia a `db/migrations/017_rediseno_ui.sql` **tal cual**. Se copia, no se mejora.

**`_verificacion-017.sql` prueba las 10 afirmaciones** de las que dependen T03 y T04, y corrió en
verde: los CHECK que rechazan una etapa sin fuente de datos o con dos, el vocabulario de hitos, que
un slug no pueda arrancar dos etapas, que el seed deje 8 etapas por funnel sin huecos, que ninguna
etapa quede huérfana, que las fronteras cubran todos los pasos, **dónde está la frontera que rompe la
monotonía**, que los layouts nazcan en `null`, y que un layout guardado conserve el orden.

> **Cómo leer "corrió en verde".** Sólo los bloques 1, 2, 3, 4 y 10 tiran excepción si fallan. Los
> demás **imprimen** y su `\echo` dice qué se espera: hay que leer la salida y comparar. Un archivo
> que corre sin error no garantiza que los números impresos sean los esperados.

Lo que crea: la tabla `funnel_stages` con 3 CHECK y 2 índices únicos parciales, el seed de 8 etapas
por funnel, y 2 filas en `settings` para los layouts.

---

## 4. Contrato del catálogo de widgets — CONGELADO

Lo declara **T01** en `lib/widgets/tipos.ts`. Lo implementan T02 (las métricas), T03 (el runtime),
T05 y T06 (los catálogos de cada pantalla). **Seis tasks lo importan y ninguna lo modifica.**

```ts
/** Los cuatro tamaños de D-R03. `w` y `h` en celdas de la grilla. */
export type WidgetSize = { w: 1 | 2; h: 1 | 2 };

/** Una entrada del layout guardado. El ORDEN del array es el orden en pantalla. */
export type WidgetPlacement = { id: string; w: 1 | 2; h: 1 | 2 };

/** Lo que se guarda en settings.ui_layout_*. `v` permite migrar el formato. */
export type WidgetLayout = { v: 1; widgets: WidgetPlacement[] };

/**
 * La definición de un widget en el catálogo de una pantalla.
 *
 * `render` recibe los datos YA CARGADOS de la pantalla: un widget no hace su
 * propio fetch. Con 25 widgets, cada uno pidiendo lo suyo serían 25 requests
 * por cambio de rango y el panel se caería solo.
 */
export type WidgetDef<TData> = {
  id: string;               // estable y para siempre: es la clave del layout guardado
  label: string;            // el nombre en la lista de widgets
  hint?: string;            // qué significa la métrica, para el tooltip
  grupo: WidgetGrupo;       // para agrupar la lista de widgets
  tamañoPorDefecto: WidgetSize;
  /** Tamaños que este widget acepta. Un gráfico no tiene sentido en 1x1. */
  tamañosPermitidos: WidgetSize[];
  render: (data: TData, size: WidgetSize) => ReactNode;
};

export type WidgetGrupo = 'plata' | 'volumen' | 'eficiencia' | 'calidad' | 'graficos' | 'listas';

/** El catálogo de una pantalla. La clave es el `id`, para resolver el layout. */
export type WidgetCatalogo<TData> = Record<string, WidgetDef<TData>>;
```

**Reglas de implementación que no son negociables:**

1. **Un `id` no se renombra nunca.** Es la clave del layout que el usuario ya guardó. Si se renombra,
   el widget desaparece de su pantalla sin explicación. Para cambiar el nombre visible se cambia
   `label`, que es para eso.
2. **Un widget nunca hace fetch.** Recibe `data` por parámetro. Ver el comentario del tipo.
3. **`render` recibe el `size`** y lo usa: un widget en 2x2 no es el de 1x1 más grande, muestra más.
   Un KPI en 1x1 es número + label; en 2x1 agrega el sub y el trend; en 2x2 agrega un sparkline.
4. **Un `id` del layout que no está en el catálogo se ignora y se avisa.** Pasa cuando se borra un
   widget del código y alguien tenía un layout guardado con él. Se descarta esa entrada, se muestran
   los demás, y la barra dice "1 widget guardado ya no existe". **No se tira**: la pantalla no puede
   quedar en blanco por un layout viejo.
5. **`tamañosPermitidos` se respeta en la UI.** El menú de tamaño de un widget sólo ofrece los suyos.

---

## 5. Contrato del embudo por etapas — CONGELADO

Lo declara **T01** en `lib/widgets/tipos.ts`, lo implementa **T04** en `lib/queries/funnel.ts`.

```ts
/** Una parte del embudo: un grupo de pasos contiguos, o un hito. */
export type EmbudoEtapa = {
  stageOrder: number;
  label: string;
  /** Los pasos que la etapa contiene, en orden. Vacío para las etapas de hito. */
  slugs: string[];
  /** De dónde salió el conteo. La UI lo muestra: no es lo mismo un paso que un hito. */
  fuente: 'paso' | 'hito';
  /** Sesiones que completaron la etapa: el conteo de su ÚLTIMO paso (D-R08). */
  sessions: number;
  /** % sobre la etapa base (la primera). 0-100, ya multiplicado. */
  pctOfBase: number;
  /** % sobre la etapa anterior. 0-100. La primera etapa devuelve 100. */
  pctOfPrevious: number;
  /** Caída contra la anterior, en puntos. La primera devuelve 0. */
  dropFromPrevious: number;
  /**
   * ANCHO con el que se dibuja el trapecio, 0-100. Recortado al de la etapa
   * anterior cuando `sessions` la supera (D-R09). Distinto de `pctOfBase`
   * SÓLO en ese caso, y por eso son dos campos y no uno.
   */
  anchoDibujo: number;
  /**
   * true cuando `sessions` superó a la etapa anterior. La UI muestra una marca
   * visible: sin esto el usuario ve un número que no cierra con el dibujo.
   */
  inconsistente: boolean;
};

/** Se agrega a FunnelData sin tocar los campos que ya tiene. */
export type EmbudoPorEtapas = {
  etapas: EmbudoEtapa[];
  /** Etapas configuradas que apuntan a un slug que ya no existe (D-R07). */
  huerfanas: { stageOrder: number; label: string; slugFaltante: string }[];
};
```

**`anchoDibujo` y `pctOfBase` son dos campos a propósito.** Con uno solo hay que elegir entre un
dibujo correcto y un número correcto. Son dos cosas distintas y las dos se muestran.

---

## 6. Arquitectura del rediseño

```
                    tailwind.config.ts  ← tokens (D-R13)
                    app/layout.tsx      ← Geist vía next/font (D-R12)
                              │
                    components/ui.tsx   ← SÓLO AGREGA (D-R10)
                      Grid · Widget · ChartFrame · Skeleton · Toolbar · IconButton
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
  lib/widgets/tipos.ts   lib/queries/*.ts    components/WidgetGrid.tsx
  contratos §4 y §5      métricas (T02)      runtime + drag + guardar (T03)
        │                     │                     │
        └──────────┬──────────┴──────────┬──────────┘
                   ▼                     ▼
            catálogo de Resumen   catálogo de Ventas
              (T05)                 (T06)

  lib/queries/funnel.ts + funnel_stages  →  EmbudoChart (T04)
  app/(panel)/config/**  partido en secciones navegables  (T07)
```

La pieza que hace testeable el runtime es que **el catálogo es data y el render es puro**: un widget
es una función de `(data, size)` a JSX. No toca red, no toca la base, no tiene estado. El estado
(qué widgets, en qué orden, de qué tamaño) vive en un solo lugar, `WidgetGrid`.

---

## 7. Dependencias y olas de paralelismo

```
                    ┌──────────────────────────────────┐
                    │  T01  FUNDACIÓN VISUAL           │  ← sola, primero
                    │  tokens + fuente + primitivos    │
                    │  + migración 017 + contratos     │
                    └──┬───────────┬───────────┬───────┘
         ┌─────────────┘           │           └─────────────┐
         ▼                         ▼                         ▼
  ┌──────────────┐   ┌────────────────────┐   ┌──────────────────┐
  │ T02 MÉTRICAS │   │ T03 RUNTIME DE     │   │ T04 EMBUDO POR   │   OLA A
  │ NUEVAS       │   │ WIDGETS            │   │ ETAPAS           │   3 agentes
  └──────┬───────┘   └─────────┬──────────┘   └──────────────────┘
         └──────────┬──────────┘
                    ▼
         ┌──────────────────┐  ┌──────────────────┐
         │ T05 RESUMEN      │  │ T06 VENTAS       │                  OLA B
         └──────────────────┘  └──────────────────┘                  2 agentes
                    │
                    ▼
         ┌──────────────────────────────────────┐
         │ T07 CONFIG + LEADS + ANUNCIOS        │                    OLA C
         │ (las 5 pantallas que quedan)         │                    1 agente
         └──────────────────────────────────────┘
```

| Task | Depende para COMPILAR | Depende para VERIFICAR | En paralelo con |
|---|---|---|---|
| T01 | nada | nada | **nada, va sola** |
| T02 | T01 | T01 | T03, T04 |
| T03 | T01 | T01 | T02, T04 |
| T04 | T01 | T01 | T02, T03 |
| T05 | T01, T02, T03 | T01, T02, T03 | T06 |
| T06 | T01, T02, T03 | T01, T02, T03 | T05 |
| T07 | T01 | T01 | — (va al final por volumen, no por dependencia) |

**Las dos columnas no son una formalidad.** T05 y T06 importan el catálogo (T01), las métricas nuevas
(T02) y el `WidgetGrid` (T03): sin los tres no compilan, no sólo no verifican.

**Por qué T07 va sola al final:** son 5 pantallas y 1.528 líneas sólo de Config. No depende de T02 ni
T03 (no lleva widgets), así que podría ir en la ola A, pero es la más grande y conviene que el agente
que la tome no compita por atención con nada.

**Compuerta entre olas.** Una task que bloquea a otras **no está terminada hasta que su verificación
pasa**. T01 bloquea a las seis: si su verificación falla, no arranca nada.

**Si preferís ir de a uno:** T01 → T03 → T02 → T05 → T06 → T04 → T07. Ese orden deja ver el sistema
de widgets funcionando lo antes posible, que es lo que más se va a querer mirar.

---

## 8. Ownership de archivos — regla anti-colisión

**Cada task sólo escribe los archivos de su fila.** Si necesita algo de un archivo ajeno lo lee pero
no lo escribe; si cree que necesita escribirlo, va a §9.

| Task | Archivos que puede crear o modificar |
|---|---|
| **T01** | `tailwind.config.ts`, `app/globals.css`, `app/layout.tsx`, `components/ui.tsx`, `components/RangePicker.tsx`, `lib/widgets/tipos.ts`, `lib/widgets/catalogo-demo.tsx`, `db/migrations/017_rediseno_ui.sql`, `package.json`, `package-lock.json` |
| **T02** | `lib/queries/overview.ts`, `lib/queries/sales.ts`, `lib/queries/overview.test.ts`, `lib/queries/sales.test.ts` |
| **T03** | `components/WidgetGrid.tsx`, `lib/widgets/layout.ts`, `lib/widgets/layout.test.ts`, `app/api/config/ui-layout/route.ts` |
| **T04** | `lib/queries/funnel.ts`, `lib/queries/funnel.test.ts`, `components/EmbudoChart.tsx`, `app/(panel)/embudo/**`, `app/api/data/funnel/route.ts` |
| **T05** | `app/(panel)/resumen/**`, `lib/widgets/catalogo-resumen.tsx` |
| **T06** | `app/(panel)/ventas/**`, `lib/widgets/catalogo-ventas.tsx` |
| **T07** | `app/(panel)/config/**`, `app/(panel)/leads/**`, `app/(panel)/anuncios/**`, `components/Nav.tsx`, `app/(panel)/layout.tsx`, `app/api/config/steps/route.ts`, `app/api/config/stages/route.ts` |

**`lib/widgets/tipos.ts` es el archivo más importante del rediseño y lo escribe sólo T01.** Contiene
los contratos de §4 y §5. Seis tasks lo importan y **ninguna lo puede modificar**. T01 tiene que
dejarlo completo, con todos los tipos, aunque no use ninguno.

**`components/ui.tsx` lo escribe sólo T01, y sólo agregando** (D-R10). Las seis tasks restantes lo
importan y no lo tocan. Si a T06 le falta un primitivo, va a §9: **no lo agrega**.

**Los tres paquetes nuevos los declara T01** (D-R15), aunque `@dnd-kit` sólo lo use T03. Que dos
agentes editen `package.json` es un conflicto garantizado.

**Archivos que NADIE de este rediseño modifica**, y romper esto rompe producción:

```
lib/db.ts   lib/day.ts   lib/fx.ts   lib/funnels.ts   lib/types.ts
lib/ads/**  (todo el módulo de Anuncios, recién desplegado)
lib/queries/ads.ts        lib/queries/leads.ts
middleware.ts             lib/auth.ts
db/migrations/001..016    scripts/**
app/api/data/overview/route.ts    app/api/data/sales/route.ts
app/api/config/_lib.ts
```

Dos aclaraciones sobre esa lista:

- **`app/api/config/_lib.ts` no se toca y no hace falta.** `setSetting(key, value)` ya es genérico y
  acepta cualquier clave, así que T03 puede escribir los layouts importándolo. Lo único acotado es
  `getSettingsRecord()`, y T03 no lo usa: lee sus dos claves con su propia query.
- **`app/api/data/overview/route.ts` y `sales/route.ts` no se tocan** aunque T02 agregue campos a las
  queries: los routes devuelven el objeto entero, así que un campo nuevo viaja solo.

### La única excepción a la exclusividad: `lib/widgets/catalogo-*.tsx`

T03 (el runtime) necesita un catálogo para probar el `WidgetGrid`, y los catálogos reales son de T05
y T06, que corren después.

Se resuelve igual que lo resolvió el plan de Anuncios con `lib/queries/ads.ts`:

- **T01 crea `lib/widgets/catalogo-demo.tsx`**: tres widgets de juguete (un 1x1, un 2x1, un 2x2) con
  datos hardcodeados, que sirven para que T03 verifique el drag, el resize y el guardado sin depender
  de T05 ni T06.
- **T05 y T06 crean sus propios archivos** y no tocan el demo.
- **El demo NO se borra al final**: es lo que permite probar el runtime en aislamiento cuando algo se
  rompa dentro de seis meses. Queda con un comentario en la primera línea diciendo qué es.

---

## 9. Criterios de aceptación globales

1. `npx tsc --noEmit` y `npm run build` en cero. `npm test` pasa (hoy son 262 tests con base).
2. `npm run db:migrate` es idempotente: dos corridas seguidas, la segunda no aplica nada y sale 0.
3. `_verificacion-017.sql` corre en verde contra la base migrada, y **se leen los números impresos**.
4. **Los números no cambiaron.** Para un rango cerrado, Resumen y Ventas muestran exactamente los
   mismos importes que antes del rediseño. Anotá tres valores antes de empezar (neto total, órdenes,
   gasto de ads) y comparalos al final. Un rediseño que cambia un número es un bug de cálculo
   disfrazado de cambio visual.
5. **Ninguna pantalla perdió una función.** Cada task lista lo que su pantalla hacía antes y verifica
   que siga estando. Los filtros, los toggles, los links y las acciones se conservan.
6. **El layout se guarda y sobrevive un refresh y un cambio de rango.** Y con la fila en `null` la
   pantalla muestra el layout por defecto (D-R04).
7. **Un `id` de widget que no existe no rompe la pantalla**: se ignora, se avisa, el resto se muestra
   (§4 regla 4).
8. **Todo se puede usar con teclado.** Tab llega a cada control con foco visible, el reordenamiento
   tiene alternativa de teclado (D-R16), y ningún control interactivo es un `<div>` con `onClick`.
9. **Cero `window.alert`, cero `console.log` de debug, cero código comentado.**
10. **Las tres pantallas rediseñadas tienen sus tres estados**: cargando (esqueleto con la forma del
    contenido, no un spinner centrado), vacío (compuesto, con qué hacer) y error (con reintentar).
11. **Los números en fuente monoespaciada** en tablas y KPIs (D-R12).
12. Sin la cookie `panel_token`, `POST /api/config/ui-layout` devuelve 401 y no escribe nada.

**Nota práctica para verificar en el browser.** Varias verificaciones piden mirar la pantalla. El
panel corre en `http://localhost:3005` con `npm run dev`. Para los datos, la base local está en la
migración **010** y le faltan la 011 a la 017: corré `npm run db:migrate` antes. Y ojo, **la base
local casi no tiene datos** (2 órdenes, 0 sesiones), así que los estados vacíos se ven solos y los
llenos hay que probarlos contra un dump de producción o aceptando que se verifican en el deploy.

**Nota sobre `git diff`.** No sirve en este proyecto: `dashboard-admin` **no está trackeado** en el
repo git del padre (`~/Desktop/funnel` sólo trackea `.kiro` y `funnel-mate`), así que todos los
archivos son untracked y el diff sale vacío. Para verificar que no tocaste archivos ajenos:

```bash
find . -newermt '-3 hours' -type f \
  -not -path './node_modules/*' -not -path './.next/*' -not -path './.git/*' \
  -not -name '*.log' -not -name 'tsconfig.tsbuildinfo' | sort
```

---

## 10. Preguntas abiertas

Si aparece una decisión que este documento no resuelve, **se anota acá en lugar de decidirla en el
código**. Si bloquea, la task se detiene.

```
### P-RXX — <título corto>
- **Task:** T0X
- **Sección del plan:** §X
- **Qué falta:** <la pregunta concreta>
- **Bloquea:** sí / no
- **Resolución:** <la completa el usuario>
```

### P-R01 — ¿Qué métricas nuevas quiere el usuario, exactamente?
- **Task:** T02
- **Sección:** D-R15, §4
- **Qué falta:** El usuario dijo "sí esas y agregá algunas que no existan", sin lista. T02 propone las
  que son **derivables de lo que las queries ya devuelven** (sin SQL nuevo): tasa de devolución
  (`ordersRefunded / orders`), margen neto (`netEur / grossEur`), conversión checkout→compra
  (`orders / checkoutClicks`), ingreso por sesión (`netEur / sessions`), y las que ya se calculan y
  nadie muestra (`adSpendEur`, `resultEur`, `roas`, `grossEur`, `lastEventAt`). Las que necesitan SQL
  nuevo (cohortes, comparación contra el mismo día de la semana anterior, LTV) **no se hacen** sin que
  el usuario los pida por nombre.
- **Bloquea:** no. T02 implementa las derivables y anota la lista para que el usuario tache.
- **Resolución:** T02 implementó la lista completa de derivables (ver P-R11). Pendiente: que el
  usuario tache y pida por nombre lo que falte.

### P-R02 — El layout es global: ¿alcanza con avisarlo o hay que hacer usuarios?
- **Task:** ninguna. Es del modelo de auth del panel.
- **Sección:** D-R04
- **Qué falta:** Con contraseña compartida, el layout guardado lo ven todos y el último que guarda
  gana. Hoy el panel lo usa una persona, así que no molesta. El día que lo use un equipo, o se hacen
  usuarios (cambio en la auth de todo el panel) o el layout pasa a `localStorage` y deja de viajar
  entre dispositivos. Las dos son decisiones del usuario, no del rediseño.
- **Bloquea:** no. La barra dice "este layout lo ven todos" y listo.
- **Resolución:**

### P-R03 — ¿`viral_news` y `loading_steps` van como etapas propias?
- **Task:** T04, T07
- **Sección:** D-R08
- **Qué falta:** El usuario delegó la decisión ("hacelo como vos veas"). El seed las fusiona:
  `viral_news` dentro de Preguntas y `loading_steps` dentro de Diagnóstico, con el razonamiento en
  D-R08. Las dos se separan agregando una fila desde la UI de Config, sin migración.
- **Bloquea:** no. **Pero mostrale el embudo al usuario antes de dar el rediseño por terminado**: es
  la única decisión de este plan que cambia lo que él va a mirar todos los días.
- **Resolución:** implementado según el seed (fusionadas). Separarlas es una fila en Config → Etapas,
  sin migración. **El usuario lo vio y eligió dejarlo fusionado.**

### P-R04 — La base local no tiene datos para ver las pantallas llenas
- **Task:** T05, T06, T07
- **Qué falta:** La base local tiene 2 órdenes y 0 sesiones. Los estados vacíos se verifican solos,
  pero un widget de gráfico o una tabla de 50 filas no se pueden mirar. Las opciones son restaurar un
  dump de producción en local (`/srv/panel/backups/panel-*.sql.gz`, hay 14 días) o aceptar que esas
  verificaciones se hacen en el deploy.
- **Bloquea:** no, pero **anotá cuál de las dos elegiste**: "lo verifiqué con datos" y "lo verifiqué
  vacío" son afirmaciones muy distintas sobre una pantalla.
- **Resolución:** las tres tasks verificaron con los datos locales que hay (2 órdenes en `reset`,
  vacío en `chauhinchazon`) y con tests que usan los números de producción (caso 820→821). La vista
  LLENA con datos reales queda para verificar en el deploy o restaurando un dump.

### P-R05 — El bug de `counts_in_funnel` se arregla, ¿y qué se hace con los datos ya perdidos?
- **Task:** T07
- **Sección:** D-R07
- **Qué falta:** El import de pasos resetea `counts_in_funnel` a `true` desde que existe. T07 arregla
  el código, pero si alguien había marcado un paso como "no cuenta" y después importó, ese dato ya no
  está y no hay forma de recuperarlo. Hay que preguntarle al usuario si había alguno.
- **Bloquea:** no.
- **Resolución:** arreglado (leer y reinyectar por slug, lockeado por test). En la base LOCAL no hay
  ningún paso en `false` hoy, así que acá no se perdió nada. **El usuario confirmó que en producción
  nunca marcó ningún paso: no hay datos perdidos.**

---

## Anotaciones de las tasks (consolidadas al cierre, 2026-08-13)

### P-R06 — `Widget` lleva `onEdit?: () => void`, que la firma del §7 de T01 no mostraba
- **Task:** T01 (afecta a T03)
- **Sección:** T01 §7 / D-R10
- **Qué falta:** el §7 de la task muestra la firma sin `onEdit`, pero su doc comment y la regla 4 lo
  exigen (sin él no existe modo edición). T01 lo agregó y T03 lo usa.
- **Bloquea:** no
- **Resolución:** agregado.

### P-R07 — `components/ui.tsx` arranca con `'use client'`
- **Task:** T01
- **Sección:** D-R10
- **Qué falta:** ChartFrame monta `ResponsiveContainer` de recharts; un client component no puede
  renderizar un server component. El kit sigue sin hooks. Consecuencia: un server component que le
  pase props no serializables (funciones) fallaría el build; hoy no existe ese caso.
- **Bloquea:** no
- **Resolución:**

### P-R08 — ChartFrame inyecta el Tooltip común sólo si el chart no trae uno propio
- **Task:** T01
- **Sección:** T01 §7
- **Qué falta:** detección por `child.type === Tooltip`; el común formatea con `fmtInt` (la moneda no
  es deducible). Para importes, el caller pasa su Tooltip. Los charts de Resumen/Ventas no se tocaron.
- **Bloquea:** no
- **Resolución:**

### P-R09 — La base local estaba en la migración 016, no en la 010
- **Task:** T01
- **Sección:** §3 / §9 del plan
- **Qué falta:** el plan dice "migración 010", pero las 001-016 ya estaban aplicadas: `db:migrate`
  aplicó sólo la 017. Sin impacto; anotado para corregir el dato del plan.
- **Bloquea:** no
- **Resolución:** el orquestador lo corroboró (2ª corrida: "0 aplicadas, 17 salteadas").

### P-R10 — Dónde vive cada token y cómo se usa (referencia para futuras tasks)
- **Task:** T01
- **Sección:** D-R13
- **Qué falta:** tokens en `tailwind.config.ts` (canvas, surface, surface-raised, border-subtle/strong,
  overlay con alfa, escalas good/warn/bad/info 200-500, sombras); `panelColors` exportado para
  recharts; fuente por variables de `next/font` en el `<html>` raíz. `app/globals.css` intacto.
- **Bloquea:** no
- **Resolución:**

### P-R11 — Métricas nuevas: lista de lo implementado (para que el usuario tache)
- **Task:** T02 (resuelve P-R01 parcialmente)
- **Sección:** P-R01
- **Qué falta:** implementado sin SQL nuevo: `refundRate`, `netMargin`, `convCheckoutToSale`,
  `convSessionToQuiz`, `convQuizToSalesView`, `revPerSession`, `cpa` (por funnel); en totals además
  `grossEur`, `quizStarted`, `salesViews`, `checkoutClicks` + ratios del conjunto; `PrevTotals` con
  `adSpendEur`/`resultEur`; en Ventas `refundRate`, `netMargin`, `avgTicketOrig`, `commissionRate`,
  `costRate`. Quedan fuera por requerir SQL nuevo: cohortes/LTV, comparación contra el mismo día de la
  semana anterior, proyecciones, medias móviles.
- **Bloquea:** no
- **Resolución:** la completa el usuario (tachar / pedir por nombre).

### P-R12 — Correr `npm test` borra `daily_metrics` y deja el Resumen en ceros hasta el próximo rollup
- **Task:** T02
- **Sección:** §9.4
- **Qué falta:** el test 8 de `overview.test.ts` (preexistente) hace `DELETE FROM daily_metrics`. No es
  un bug de T02; el rollup lo repuebla (`npm run rollup`). Ojo al verificar números del Resumen justo
  después de correr tests.
- **Bloquea:** no
- **Resolución:**

### P-R13 — El menú de tamaño de widget vive en `WidgetGrid.tsx`, no en `ui.tsx`
- **Task:** T03
- **Sección:** D-R10, §8
- **Qué falta:** `ui.tsx` no tiene menú desplegable; T03 implementó `MenuTamaños` dentro de
  `WidgetGrid.tsx` (aria-haspopup/expanded, menuitemradio, backdrop). Si otra pantalla necesita un
  dropdown, reusar ese patrón o pedir que se promueva a primitivo.
- **Bloquea:** no
- **Resolución:**

### P-R14 — Sin cookie, los POST a `/api/config/*` dan 307 por HTTP, no 401
- **Task:** T03, T07 (afecta al criterio §9.12 del plan)
- **Sección:** §9.12, middleware.ts
- **Qué falta:** el middleware redirige a `/` todo `/api/*` sin cookie (menos ingest/webhooks) ANTES
  del route, igual que settings/commissions/steps desde siempre. El 401 de `guard()` existe y está
  testeado a nivel handler, y el invariante real (sin cookie no se escribe nada) se verificó contra la
  base. Cambiarlo implicaría tocar `middleware.ts`, fuera del ownership de todas las tasks.
- **Bloquea:** no
- **Resolución:**

### P-R15 — Los catálogos de widgets sólo se pueden importar desde componentes client
- **Task:** T03 (guía para T05/T06)
- **Sección:** §4, §6
- **Qué falta:** el catálogo importa recharts, que rompe en un server component. Patrón correcto:
  página server fetchea el layout guardado → View client importa el catálogo y arma el WidgetGrid.
  T05 y T06 lo siguieron.
- **Bloquea:** no
- **Resolución:**

### P-R16 — Unidades 0-1 vs 0-100 entre queries: anotado, no unificado
- **Task:** T04
- **Sección:** T04 §3
- **Qué falta:** `overview.ts` y `sales.ts` usan tanto por uno; `funnel.ts` usa 0-100. Cada archivo es
  consistente consigo mismo; unificar movería números en pantalla.
- **Bloquea:** no
- **Resolución:**

### P-R17 — `funnel.test.ts` usa días aleatorios para no chocar con `sales.test.ts`
- **Task:** T04
- **Sección:** —
- **Qué falta:** dos suites en paralelo contra la misma base se pisaban los conteos con días fijos.
  Movido a un rango histórico al azar por corrida. No volver a días fijos.
- **Bloquea:** no
- **Resolución:**

### P-R18 — "null" de D-R04 es JSON null: la columna `settings.value` es NOT NULL
- **Task:** T03, T05, T06
- **Sección:** D-R04
- **Qué falta:** el estado "nunca guardó" es `value='null'::jsonb` (así lo siembra la 017).
  `UPDATE settings SET value=NULL` tira por la constraint. El código distingue bien los tres estados.
- **Bloquea:** no
- **Resolución:**

### P-R19 — Widget "órdenes sin tier" no se hizo: el conteo no es un campo de OverviewData
- **Task:** T05
- **Sección:** T05 §2
- **Qué falta:** el número sólo existe como texto dentro de `alerts`. El widget `alertas` lo muestra
  con su link. Para un widget numérico habría que exponer `unknownTierCount` (sin SQL nuevo).
- **Bloquea:** no
- **Resolución:**

### P-R20 — Esqueleto de carga: overlay en Resumen, reemplazo en Ventas
- **Task:** T05, T06 — **decidieron distinto, para que el usuario elija**
- **Sección:** §9.10, D-R05
- **Qué falta:** T05 superpone el skeleton sin desmontar el WidgetGrid (un cambio de rango no pierde
  ediciones sin guardar); T06 reemplaza la grilla por el esqueleto (más fiel a §9.10, pero desmontar
  pierde cambios de layout sin guardar si el usuario estaba editando y cambia el rango/funnel).
  Elegir UNO y aplicar en las dos pantallas.
- **Bloquea:** no
- **Resolución:** el usuario eligió **Reemplazo (Ventas)**. Unificado: Resumen ahora reemplaza la
  grilla por el esqueleto durante el refetch, igual que Ventas.

### P-R21 — Layout por defecto de Resumen: 8 widgets
- **Task:** T05
- **Sección:** T05 §2/§5
- **Qué falta:** neto, ordenes, sesiones, ticket (1x1), alertas (2x1), funnels (2x2), neto-dia (2x2),
  tabla-funnels (2x2). Reproduce la pantalla de hoy. Catálogo completo: 24 widgets.
- **Bloquea:** no
- **Resolución:**

### P-R22 — Layout por defecto de Ventas: 10 widgets, y wrapper `VentasWidgetData`
- **Task:** T06
- **Sección:** T06 §2/§7
- **Qué falta:** Neto y Resultado grandes 2x1 arriba, ROAS/ROI/Órdenes/Ticket 1x1, Neto por día, Por
  campaña, Por tier y Últimas ventas 2x2. Los 12 StatCards y 6 banners de antes están todos como
  widget, gráfico o aviso fijo; revertir es cambiar `LAYOUT_VENTAS_POR_DEFECTO`. Además: el catálogo
  usa `VentasWidgetData = { sales; showEur; frescura? }` en vez de `WidgetCatalogo<SalesData>` a
  secas, porque el render necesita el toggle EUR/ARS sin convertir en el componente.
- **Bloquea:** no
- **Resolución:**

### P-R23 — Avisos fijos en Ventas: el §4 le ganó al §3
- **Task:** T06
- **Sección:** T06 §3/§4
- **Qué falta:** fxStaleCount, unknownTierCount y el cajón sin atribuir son avisos FIJOS (no widgets
  sacables); ordersSinComision/ordersSinCosto son widgets. Quedan 2 Banners: "Datos por revisar" y el
  de error con reintentar.
- **Bloquea:** no
- **Resolución:**

### P-R24 — Los filtros tier/campaña/fuente/status nunca tuvieron UI
- **Task:** T06
- **Sección:** T06 §5
- **Qué falta:** la API los acepta desde siempre y la verificación pide que funcionen: funcionan por
  query string (`?tier=front` filtra de verdad), pero no se inventaron controles. Si el usuario los
  quiere como UI es feature nueva.
- **Bloquea:** no
- **Resolución:**

### P-R25 — Arreglo de `counts_in_funnel`: forma 1 (leer y reinyectar), y por qué
- **Task:** T07
- **Sección:** T07 §2
- **Qué falta:** el UPSERT choca contra el UNIQUE `(funnel_id, slug)` cuando un reordenamiento
  intercambia índices a mitad de corrida. Leer y reinyectar en transacción es correcto; lockeado por
  `route.test.ts` con funnel propio aislado.
- **Bloquea:** no
- **Resolución:**

### P-R26 — Agrupamiento de las 9 secciones de Config
- **Task:** T07
- **Sección:** T07 §3
- **Qué falta:** Funnels (Funnels · Pasos · Etapas), Dinero (Comisiones · Productos · Cotizaciones),
  Fuentes (Publicidad · Tiendas), Sistema (Ajustes · Salud). La sección activa viaja en `?s=` y
  sobrevive F5. `ConfigView.tsx` 259 líneas; la sección más grande (Productos) 297.
- **Bloquea:** no
- **Resolución:**

### P-R27 — El editor de etapas rechaza borrar TODAS las etapas (mínimo una)
- **Task:** T07
- **Sección:** T07 §4
- **Qué falta:** una lista vacía es indistinguible de "nunca configuré" y el seed la rellenaría en la
  próxima migración. 400 `stages_vacio` en castellano. Borrar hasta dejar una sola, permitido.
- **Bloquea:** no
- **Resolución:**

### P-R28 — Iconos de texto residuales en archivos de otras tasks: resuelto al cierre
- **Task:** T07 (lo detectó), orquestador (lo resolvió)
- **Sección:** §8, D-R11
- **Qué falta:** quedaban `▲▼` en `ui.tsx` (StatCard trend), `▾` en `RangePicker.tsx` y `↓↑` en
  `EmbudoView.tsx` (orden de tabla). Como cada task no podía tocar archivos ajenos, el orquestador los
  reemplazó por iconos Phosphor (TrendUp/TrendDown, CaretDown, CaretUp) al cierre. El grep da cero.
- **Bloquea:** no
- **Resolución:** hecho. Verificado: `grep -rn "▾\|▲\|▼\|↓\|↑" app/ components/` → 0 resultados.


---

## 11. Lo que este rediseño NO resuelve, dicho de frente

Para que nadie construya encima creyendo que están cubiertas.

1. **Usuarios y layouts por persona** (P-R02). El layout es global.
2. **Modo claro.** El panel es dark-only.
3. **Tests de componentes.** No hay `@testing-library` y no se agrega. La verificación de UI es manual
   y con checklist.
4. **Rendimiento con muchos widgets.** El diseño evita el problema (un solo fetch por pantalla, §4
   regla 2) pero nadie midió 25 widgets en pantalla. Si va lento, el primer sospechoso es recharts
   montado varias veces.
5. **Responsive de verdad en móvil.** La grilla colapsa a una columna y las tablas scrollean
   horizontal, que es lo que hay hoy. Un panel de datos en un celular es otro diseño.
6. **Reordenar las pestañas del Nav** ni personalizar qué pantallas se ven.
7. **Exportar widgets** a imagen o CSV.
8. **Undo del layout.** Hay "descartar cambios" antes de guardar, y nada después. Para volver atrás se
   rearma a mano.
