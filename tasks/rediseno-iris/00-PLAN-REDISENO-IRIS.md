# REDISEÑO IRIS — el panel pasa de "casi-negro + esmeralda" a "iris sobre tinta", con tipografía display y la costura como firma

**Documento maestro del módulo. Todo agente lee este archivo completo antes de abrir su task.**

El panel ya tiene un sistema de tokens limpio (`tailwind.config.ts` + `app/globals.css`, "vidrio líquido" v3):
cero colores de Tailwind crudos (`emerald`, `slate`, etc.), casi cero literales hex en las vistas, y un test
(`lib/paleta.test.ts`) que falla si una clase de color apunta a un tono que no existe. Eso hace que un cambio
de paleta sea barato: **cambiar un token repinta las nueve pantallas**.

El problema de hoy no es de ejecución sino de identidad: casi-negro azulado con UN acento verde esmeralda es
el look por defecto de cualquier dashboard oscuro, y encima el verde es a la vez el acento (botones, foco, tab
activa, fila seleccionada) y la semántica "esto está bien" (ganancia, activo). Un botón y una ganancia se ven
iguales. Este rediseño separa las dos cosas y le da al panel una voz propia.

Decidido con el usuario el 2026-09-30: paleta **"Iris sobre tinta"** (oscuro con fondo violáceo, acento iris),
**Bricolage Grotesque** como display, y la **costura** (la puntada del hilván: "Hilvan" es el nombre del panel)
como único motivo de firma.

**Este módulo es solo visual.** No toca datos, APIs, queries, lógica ni textos. Un agente que cambia un
`onClick`, un `useEffect`, un nombre de prop o un texto visible está fuera del plan.

## 0. Qué se construye y qué no

**Se construye**
1. Paleta nueva en tokens: canvas/surfaces con tinte tinta-violeta, `neutral` retinteado al mismo hue, y una
   escala nueva **`acento`** (iris) separada de `good`.
2. `good` / `warn` / `bad` / `info` recalibrados a la paleta nueva (mismos nombres, mismos pasos).
3. Tipografía: Bricolage Grotesque (`font-display`) para títulos de pantalla, de tarjeta y de sección.
4. La costura: `.costura` y `.costura-v` en `globals.css`, usadas en 4 lugares (nav activo, encabezado de
   pantalla, conectores del embudo, tarjeta de login). En ningún otro.
5. Migración de todos los usos "de interfaz" de `good-*` a `acento-*` en las nueve pantallas (§1 D1).
6. Pulido por pantalla: jerarquía, espaciado, estados vacíos y de carga, tablas, formularios — dentro de los
   archivos de cada task y sin cambiar comportamiento.

**No se construye**
- Tema claro (se evaluó y se descartó: ~840 usos de `neutral` y ~190 de `overlay` están pensados para oscuro).
- Cambios de copy / microcopy (hay tests que leen textos; y no es lo que se pidió).
- Cambios de layout que muevan columnas, filtros, orden de widgets o datos (el layout del Resumen lo guarda el
  usuario en la base: moverlo lo pisa).
- Íconos nuevos, librerías nuevas (salvo la fuente, que es `next/font/google`, ya incluido en Next 14.2.5).
- Modo claro/oscuro conmutable.

## 1. Decisiones cerradas

**D1 — `acento` para la interfaz, `good` solo para "esto está bien".** Regla para cada `good-*` que encuentres:
- **Pasa a `acento-*` con el MISMO número de paso** (`bg-good-900` → `bg-acento-900`, `text-good-400` →
  `text-acento-400`, `focus:ring-good-500/50` → `focus:ring-acento-500/50`, `accent-good-500` →
  `accent-acento-500`, `shadow-glow-good` → `shadow-glow-acento`): botones primarios, foco (ring, outline,
  border de foco), fila/ítem/tab/segmento seleccionado o activo, checkboxes y switches, links y hover de
  links, chips de filtro elegido, selección de fecha, asas de arrastre, indicadores de "pendiente de cargar",
  el logo, el avatar.
- **Queda en `good-*`**: ganancia ≥ 0, tendencia a favor, estado "activo / entregando / ok / sano", toast o
  banner de una acción que salió bien, un "Sí" de conversión, el tono `good` de `Badge`/`StatCard`/`BarRow`.
- **Duda** (no encaja claro): elegí `acento` si el color dice "acá estás / esto elegiste / tocá esto", y `good`
  si dice "esto es un buen resultado". Anotalo en NOTAS del reporte.
  *Bug que evita:* hoy un botón "Guardar" y una celda de ganancia son del mismo verde; el ojo no puede separar
  "acción" de "resultado", que es la lectura principal de un panel de plata.

**D2 — Mismo número de paso = mismo rol.** La escala `acento` usa la convención que `good` ya tenía: 100/200 =
texto fuerte sobre relleno oscuro del tono, 300/400 = texto del tono sobre surface, 500 = base sólida,
600 = base más oscura (fondo de degradado, hover), 700 = borde del tono, 800 = relleno medio (avatar),
900 = relleno oscuro (fila/ítem activo). *Bug que evita:* la migración de D1 es un reemplazo de palabra, no una
re-decisión de contraste en 117 lugares; el contraste se prueba una vez en §4.

**D3 — Solo `className`, estilos y JSX presentacional.** Se permite: cambiar clases, envolver en un `div` de
layout, reordenar clases, agregar `aria-hidden` a decoración, cambiar un ícono de peso. **No** se permite:
tocar handlers, estado, efectos, props, firmas, fetch, textos visibles, `key`s, ni archivos `.ts` de lógica.
*Bug que evita:* Anuncios mueve plata en Meta; un rediseño que cambia un `onClick` puede pausar campañas.

**D4 — Firmas de `components/ui.tsx` congeladas.** T01 puede cambiar el aspecto de `Card`, `StatCard`, `Table`,
`Badge`, etc., pero no sus props. Las tasks de la ola 2 no tocan `ui.tsx`. `components/ui.tokens.test.ts`
tiene que seguir en verde (el `Table` conserva `border-b border-border-subtle` y `border-b border-overlay/4`).

**D5 — Cero literales de color en las vistas.** Un color que no es clase de token sale de `panelColors`
(`tailwind.config.ts`). Las sombras arbitrarias con `rgba(4,6,14,…)` (el hue viejo) se reemplazan por los
tokens de sombra (`shadow-card`, `shadow-float`, etc.) o por `rgb(var(--sombra)/…)`. *Bug que evita:* un
literal del hue viejo queda azul-gris sobre el canvas violáceo nuevo: se ve "sucio", que es el defecto que v3
ya había corregido con los grises.

**D6 — Tipografía.** `font-display` (Bricolage Grotesque, variable, subset latin) solo en: `h1` de pantalla,
títulos de `Card`, títulos de sección/modal/drawer, el nombre del panel en el sidebar y el título del login.
Cuerpo = Geist Sans; números = Geist Mono (`font-mono` + `num`), sin cambios. Nunca `font-display` en tablas,
números ni botones. *Bug que evita:* los números de Bricolage no son tabulares y las columnas bailarían.

**D7 — La costura, en 4 lugares y ninguno más.** (1) ítem activo del nav (reemplaza la barra de 2px), (2) bajo
el `h1` del encabezado de pantalla, (3) conector entre pasos del embudo, (4) tarjeta del login. *Bug que
evita:* un motivo repetido en todas partes deja de ser firma y pasa a ser ruido.

**D8 — Series de gráficos.** El dato principal sin juicio (ventas, gasto, leads, cantidad) va en
`panelColors.acento`; lo que expresa ganancia/pérdida sigue en `good`/`bad`; las series secundarias usan
`info`, `infoLight`, `acentoLight`, `muted`. *Bug que evita:* un gráfico de ventas en verde se lee como "todo
bien" aunque se esté perdiendo plata.

**D9 — Movimiento: nada nuevo salvo lo que ya existe.** `reveal`, `lift`, `press`, `latido`, `shimmer` se
quedan. No se agregan animaciones. `prefers-reduced-motion` ya está cubierto en `globals.css`.

## 2. Arquitectura

```
tailwind.config.ts  ── colores/escala acento/sombras/fontFamily ──┐
app/globals.css     ── .glass .aurora .costura .costura-v focus ──┤  T01 (ola 1, sola)
app/layout.tsx      ── Bricolage via next/font → --font-display ──┤
components/ui.tsx + Shell/Nav/Encabezado/RangePicker/... ─────────┘
          │  (contratos §4-§5, congelados)
          ▼
 ola 2, 4 en paralelo, cada una SOLO sus archivos:
   T02 Anuncios · T03 Resumen/Embudo/Ventas+gráficos · T04 Finanzas/Tareas/Leads/Creativos · T05 Config+acceso
```

La razón por la que la ola 2 puede correr en paralelo: todas consumen **clases** que T01 declaró; ninguna
escribe un archivo que otra lee.

## 3. Datos

No hay. Ni esquema, ni migraciones, ni endpoints.

## 4. Contrato de paleta — CONGELADO (lo declara T01)

Verificado en fase 3 con `node tasks/rediseno-iris/_verificacion-contraste.mjs` (15/15 en verde).

`panelColors` (mismos nombres que hoy, valores nuevos, más dos claves nuevas):

| clave | valor | | clave | valor |
|---|---|---|---|---|
| canvas | `#0c0b14` | | good | `#34d39a` |
| surface | `#15141f` | | warn | `#f0b04a` |
| surfaceRaised | `#1d1c2b` | | bad | `#ff6b72` |
| surfaceOverlay | `#252437` | | info | `#5cb8ff` |
| axis | `#9894ab` | | infoLight | `#7cc5ff` |
| ink | `#0c0b14` | | badLight | `#ff8388` |
| inkOnDark | `#d8d6e4` | | **acento** (nueva) | `#8b7bff` |
| muted | `#3e3b4f` | | **acentoLight** (nueva) | `#b0a6ff` |
| grid | `rgba(255,255,255,0.05)` | | axisLine | `rgba(255,255,255,0.10)` |
| cursor | `rgba(139,123,255,0.08)` | | | |

Escalas de Tailwind:

```
neutral: 50 #f7f7fb 100 #ecebf3 200 #d8d6e4 300 #b6b3c7 400 #9894ab 500 #827e98
         600 #5c5870 700 #3e3b4f 800 #2a2839 900 #1b1a26 950 #0f0e17
acento:  100 #e6e2ff 200 #cbc4ff 300 #b0a6ff 400 #9d8fff 500 #8b7bff
         600 #6f5ef0 700 #5242c4 800 #352a85 900 #1e1848
good:    100 #d3f8ea 200 #a9f0d6 300 #74e4bd 400 #4fdba9 500 #34d39a
         600 #1fa877 700 #17805b 800 #10553d 900 #0a2e22
warn:    200 #fbe3b8 300 #f7cf8a 400 #f3bf66 500 #f0b04a 600 #c98b2a
bad:     200 #ffc8cb 300 #ff9ea3 400 #ff8388 500 #ff6b72 600 #d94a52
info:    200 #cbe7ff 300 #9fd3ff 400 #7cc5ff 500 #5cb8ff 600 #3592db
```

`overlay` sigue `#ffffff`; `border-subtle` .06, `border-strong` .10, `divider` .08 (sin cambios). Las escalas de
opacidad, `zIndex`, `screens`, `borderRadius`, `transitionTimingFunction` y `keyframes` **no cambian**.

Sombras: `--sombra` pasa a `12 10 28` (hue de la tinta). Todas las sombras de `boxShadow` que hoy usan
`rgba(4, 6, 14, …)` pasan a `rgba(12, 10, 28, …)` con el mismo alfa. Se agrega
`'glow-acento': '0 6px 20px -6px rgba(139, 123, 255, 0.45)'` y `glow-good` se queda.

## 5. Contrato de clases nuevas — CONGELADO (lo declara T01)

| clase | qué es | dónde se usa |
|---|---|---|
| `font-display` | Bricolage Grotesque (`var(--font-display)`, fallback `var(--font-geist-sans)`) | D6 |
| `.costura` | línea horizontal punteada de 2px en `acento-500`: trazo 6px, hueco 4px, extremos redondeados | D7 (2), (3), (4) |
| `.costura-v` | la misma, vertical, 2px de ancho, llena el alto de su caja | D7 (1), (3) |
| `bg-acento-*`, `text-acento-*`, `ring-acento-*`, `border-acento-*`, `from/to-acento-*`, `accent-acento-*`, `outline-acento-*` | la escala de §4 | D1 |
| `shadow-glow-acento` | halo del acento | botones primarios, logo |

**Botón primario del panel** (la receta que todas las tasks copian, ya validada en contraste 7.27:1 arriba y
5.94:1 abajo): `bg-gradient-to-b from-acento-400 to-acento-500 text-canvas shadow-glow-acento hover:brightness-110`.
**Foco**: `focus-visible:ring-2 focus-visible:ring-acento-500/60` o el `:focus-visible` global (que T01 pasa a
acento). **Seleccionado**: `bg-acento-900 text-acento-100` + `border-acento-700` si lleva borde.
**Backdrop de modal**: `bg-canvas/75 backdrop-blur-sm` (no `bg-neutral-900/70`).

`app/(panel)/config/kit.ts` exporta `btnPrimary` e `inputCls`; T05 lo actualiza con esta receta.

## 6. Dependencias y olas

```
Paso 1   T01                         1 agente, SOLO  (tokens, globals, fuente, ui.tsx, shell)
Paso 2   T02 · T03 · T04 · T05       4 en paralelo
```

| Task | Depende de | Se puede correr junto con |
|---|---|---|
| T01 | — | **nada, va sola** |
| T02 | T01 | T03, T04, T05 |
| T03 | T01 | T02, T04, T05 |
| T04 | T01 | T02, T03, T05 |
| T05 | T01 | T02, T03, T04 |

- T02–T05 dependen de T01 porque usan clases (`acento-*`, `font-display`, `.costura`) que no existen hasta que
  T01 las declara: sin T01, `lib/paleta.test.ts` falla en todas.
- **Árbol compartido**: en la ola 2 ninguna task corre `npm run build`, `next dev` ni `next lint` (comparten
  `.next/`). `tsc` y `vitest` sí se pueden correr, pero pueden mostrar errores de archivos de otra task: se
  anotan y decide la compuerta. El build y la revisión visual los hace el orquestador en la compuerta.
- T01 corre sola y **sí** puede buildear.

## 7. Ownership de archivos — regla anti-colisión

**Cada task solo escribe los archivos de su fila.** Si necesita algo de un archivo ajeno, lo lee pero no lo
escribe; si cree que necesita escribirlo, va a PREGUNTAS del reporte.

| Task | Archivos que puede crear o modificar |
|---|---|
| **T01** | `tailwind.config.ts`, `app/globals.css`, `app/layout.tsx`, `app/(panel)/layout.tsx`, `app/icon.svg`, `components/ui.tsx`, `components/Shell.tsx`, `components/Nav.tsx`, `components/PanelLogo.tsx`, `components/EncabezadoPagina.tsx`, `components/RangePicker.tsx`, `components/SwitchMoneda.tsx`, `components/AvisoSaldo.tsx`, `components/Portal.tsx` |
| **T02** | `app/(panel)/anuncios/AsaRedimension.tsx`, `app/(panel)/anuncios/BarraFiltros.tsx`, `app/(panel)/anuncios/BarraFrescura.tsx`, `app/(panel)/anuncios/BarraPrimaria.tsx`, `app/(panel)/anuncios/BarraSeleccion.tsx`, `app/(panel)/anuncios/celdas.tsx`, `app/(panel)/anuncios/ChipCascada.tsx`, `app/(panel)/anuncios/ConfiguradorColumnas.tsx`, `app/(panel)/anuncios/ControlVistas.tsx`, `app/(panel)/anuncios/DialogoConfirmacion.tsx`, `app/(panel)/anuncios/EncabezadoOrdenable.tsx`, `app/(panel)/anuncios/FormularioDuplicar.tsx`, `app/(panel)/anuncios/FormularioPresupuesto.tsx`, `app/(panel)/anuncios/FormularioProgramar.tsx`, `app/(panel)/anuncios/FormularioRenombrar.tsx`, `app/(panel)/anuncios/FranjaTotales.tsx`, `app/(panel)/anuncios/GestorAnuncios.tsx`, `app/(panel)/anuncios/historial/HistorialView.tsx`, `app/(panel)/anuncios/layout.tsx`, `app/(panel)/anuncios/loading.tsx`, `app/(panel)/anuncios/Paginacion.tsx`, `app/(panel)/anuncios/PopoverFila.tsx`, `app/(panel)/anuncios/Previsualizacion.tsx`, `app/(panel)/anuncios/reglas/ReglasView.tsx`, `app/(panel)/anuncios/ResultadosLote.tsx`, `app/(panel)/anuncios/SubNav.tsx`, `app/(panel)/anuncios/TablaAds.tsx`, `app/(panel)/anuncios/TabsNivel.tsx` |
| **T03** | `app/(panel)/resumen/ResumenView.tsx`, `app/(panel)/resumen/loading.tsx`, `app/(panel)/embudo/CardPitch.tsx`, `app/(panel)/embudo/CardTestEstetica.tsx`, `app/(panel)/embudo/EmbudoView.tsx`, `app/(panel)/embudo/loading.tsx`, `app/(panel)/ventas/VentasView.tsx`, `app/(panel)/ventas/loading.tsx`, `components/VentasPorHora.tsx`, `components/WidgetGrid.tsx`, `components/FunnelsElegidos.tsx`, `components/EmbudoChart.tsx`, `components/PanelInsight.tsx`, `lib/widgets/catalogo-resumen.tsx`, `lib/widgets/catalogo-ventas.tsx`, `lib/widgets/catalogo-demo.tsx` |
| **T04** | `app/(panel)/finanzas/CargaDiaria.tsx`, `app/(panel)/finanzas/CuentasSection.tsx`, `app/(panel)/finanzas/FinanzasView.tsx`, `app/(panel)/finanzas/GraficoSaldo.tsx`, `app/(panel)/finanzas/Modal.tsx`, `app/(panel)/finanzas/loading.tsx`, `app/(panel)/tareas/Columna.tsx`, `app/(panel)/tareas/DetalleTarea.tsx`, `app/(panel)/tareas/NuevaTarea.tsx`, `app/(panel)/tareas/TableroView.tsx`, `app/(panel)/tareas/TarjetaTarea.tsx`, `app/(panel)/tareas/loading.tsx`, `app/(panel)/leads/LeadsView.tsx`, `app/(panel)/leads/loading.tsx`, `app/(panel)/creativos/CreativosView.tsx`, `app/(panel)/creativos/loading.tsx` |
| **T05** | `app/(panel)/config/ConfigView.tsx`, `app/(panel)/config/kit.ts`, `app/(panel)/config/loading.tsx`, `app/(panel)/config/sections/AjustesSection.tsx`, `app/(panel)/config/sections/ComisionesSection.tsx`, `app/(panel)/config/sections/CotizacionesSection.tsx`, `app/(panel)/config/sections/EtapasSection.tsx`, `app/(panel)/config/sections/FunnelsSection.tsx`, `app/(panel)/config/sections/PasosSection.tsx`, `app/(panel)/config/sections/ProductosSection.tsx`, `app/(panel)/config/sections/PublicidadSection.tsx`, `app/(panel)/config/sections/SaludSection.tsx`, `app/(panel)/config/sections/TiendasSection.tsx`, `app/(panel)/config/sections/UsuariosSection.tsx`, `app/page.tsx`, `app/cambiar-clave/page.tsx`, `app/sin-acceso/page.tsx` |

**Archivos que NADIE toca** (romperlos rompe producción o los guardianes):
```
todo *.test.ts / *.test.tsx          (incluidos components/ui.tokens.test.ts y lib/paleta.test.ts)
todo app/api/**                       lib/** salvo lib/widgets/catalogo-*.tsx (T03)
middleware.ts   next.config.mjs   package.json   package-lock.json
los page.tsx / layout.tsx de sección (server: guards y queries) salvo los listados arriba
app/(panel)/anuncios/*.ts, reglas/_*.ts, cascadaUrl.ts, zonaHoraria.ts   (lógica)
app/(panel)/resumen/layout-por-defecto.ts, app/(panel)/tareas/prioridad.ts, finanzas/serie.ts, creativos/rendimiento.ts
tasks/rediseno-iris/**   (el plan: lo escribe solo el orquestador)
```

## 8. Criterios de aceptación globales

1. `npx tsc --noEmit -p .` → exactamente **1** error, el mismo de la línea base (`tareas/tablero.test.ts(18,5) TS2783`).
2. `npx vitest --run` → 0 failed (línea base: 135 archivos pasan, 1747 tests).
3. `npm run build` termina OK (incluye la descarga de Bricolage por `next/font/google`).
4. Usos de interfaz de `good` en cero:
   `grep -rnoE "(focus:ring|focus-visible:ring|focus:border|focus-visible:border|outline|accent|shadow-glow)-good|bg-good-900|bg-good-800" app components lib | wc -l` → **0** (línea base 117 aprox. con `border-good-700`).
5. Literales del hue viejo en cero: `grep -rn "4,6,14\|4, 6, 14\|#08090d\|#111219\|#191b24\|#22c58a" app components lib tailwind.config.ts | wc -l` → **0**.
6. `git diff --stat -- app/api lib middleware.ts package.json` → vacío salvo `lib/widgets/catalogo-*.tsx`.
7. Revisión visual (orquestador): las 9 pantallas + login a 1440px y 390px, sin texto ilegible, sin elementos
   con el verde en rol de interfaz, foco visible con Tab.

## 9. Preguntas abiertas

Si aparece una decisión que este documento no resuelve, **se anota acá en lugar de decidirla en el código**.

### P-01 — Switch de estado de anuncios: ¿acento o good?
- **Task:** T02
- **Sección del plan:** §1 D1
- **Qué falta:** el toggle ON/OFF de campañas/conjuntos/anuncios es un control (acento) que además dice
  "está entregando" (good). Default: **acento** (es un control; el estado de entrega ya tiene su propia
  etiqueta/punto en `celdas.tsx`, que queda en good).
- **Bloquea:** no
- **Resolución:**

### P-02 — Keyframe `latido` con el warn viejo
- **Task:** T01
- **Sección del plan:** §4
- **Archivo:** tailwind.config.ts
- **Qué falta:** `latido` sigue en `rgba(232,163,61,…)` (warn viejo); el nuevo es `240,176,74`. Mientras tanto queda el viejo (diferencia casi invisible).
- **Bloquea:** no
- **Resolución:**

### P-03 — Valor de `glow-good`
- **Task:** T01
- **Sección del plan:** §4
- **Archivo:** tailwind.config.ts
- **Qué falta:** T01 lo recalibró a `rgba(52,211,154,0.45)`. Confirmar.
- **Bloquea:** no
- **Resolución:**

### P-04 — Color por defecto de los funnels nuevos
- **Task:** T05
- **Sección del plan:** §1 D3 / D8
- **Archivo:** app/(panel)/config/sections/FunnelsSection.tsx
- **Qué falta:** el formulario arranca con `color: panelColors.good`, que se guarda en la base y colorea las series del funnel. Por D8 sería `panelColors.acento`, pero es estado (D3). Mientras tanto queda good (el verde nuevo).
- **Bloquea:** no
- **Resolución:**

### P-05 — «Cuentas» con título doble en el modal
- **Task:** T04
- **Archivo:** app/(panel)/finanzas/CuentasSection.tsx
- **Qué falta:** la `Card` «Cuentas» vive dentro de un `Modal` también titulado «Cuentas». Sacar uno es quitar texto visible (D3). Queda como está.
- **Bloquea:** no
- **Resolución:**

### P-06 — `StatCard` «No-compradores» en tono good
- **Task:** T04
- **Archivo:** app/(panel)/leads/LeadsView.tsx
- **Qué falta:** no comprar no es un buen resultado; propuesta `neutral` o `info`. Es una prop (D3): queda good.
- **Bloquea:** no
- **Resolución:**

### P-07 — Número del KPI «Neto» en verde
- **Task:** T03
- **Archivo:** lib/widgets/catalogo-resumen.tsx, lib/widgets/catalogo-ventas.tsx
- **Qué falta:** el neto (ventas antes de ads) se pinta siempre `good` aunque el resultado sea negativo; su sparkline ya es acento. Propuesta `neutral`. Queda good.
- **Bloquea:** no
- **Resolución:**

### P-08 — Badge del tier «Front» en verde
- **Task:** T03
- **Archivo:** lib/widgets/catalogo-ventas.tsx (`TIER_TONE.front`)
- **Qué falta:** es categoría, no resultado; `Badge` no acepta acento. Queda good.
- **Bloquea:** no
- **Resolución:**
