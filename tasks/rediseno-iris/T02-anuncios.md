# T02 — Anuncios: tabla, barras, popovers, formularios, reglas e historial en iris

- **Depende de:** T01 (las clases `acento-*`, `font-display`, `.costura`, `.costura-v`, `shadow-glow-acento`)
- **Bloquea:** nada
- **Se puede correr en paralelo con:** T03, T04, T05
- **Repo:** /Users/lucho/Desktop/funnel/dashboard-admin
- **Agente sugerido:** general-purpose — cargá la skill `frontend-design:frontend-design` antes de empezar.
- **Archivos que este task puede tocar:** la fila T02 de §7 del plan. Nada más.

Leé `00-PLAN-REDISENO-IRIS.md` completo. Tus contratos son §1 (D1–D9), §4 y §5: usás las clases que T01
ya declaró, no inventás tonos ni recetas nuevas.

---

## 1. Objetivo

- Todo `good-*` de interfaz en tus archivos pasa a `acento-*` con el mismo número de paso (D1, D2). Lo
  semántico queda en `good`.
- Cero literales de color y cero sombras con el hue viejo en tus archivos (D5).
- Títulos de tarjeta/sección/modal en `font-display` (D6), nunca en números ni tablas.
- Pulido de la pantalla: jerarquía, espaciado, estados vacíos y de carga (`loading.tsx` con `Skeleton`),
  consistencia de controles. Mirá la pantalla como alguien que la usa todos los días: menos ruido, lo
  importante más grande, lo secundario más callado.

**Este task no** cambia lógica, handlers, estado, props, fetch ni textos visibles (D3), no toca
`components/ui.tsx` ni el shell (son de T01), y no agrega animaciones (D9).

## 2. Qué mirar en esta pantalla

- La tabla (`TablaAds.tsx`) es la pantalla más densa del panel: el objetivo es que se lea más rápido, no
  que tenga más adornos. Encabezado con `bg-surface-raised`, fila abierta/seleccionada `bg-acento-900` (y la
  columna fija de esa fila igual), hover neutro `bg-overlay/2`, checkboxes `accent-acento-500`.
- **`BORDE_CELDA` de `TablaAds.tsx` se queda como está** (`border-overlay/4`): lo exige
  `components/ui.tokens.test.ts` para que la grilla de Anuncios coincida con la tabla compartida.
- `celdas.tsx`: ganancia/pérdida y estado de entrega quedan en `good`/`bad`/`warn` (semántica); el switch de
  estado pasa a acento (P-01 del plan, default acento).
- `PopoverFila`, `DialogoConfirmacion`, `Formulario*`, `ResultadosLote`: superficie `bg-surface-overlay`
  `shadow-popover`, backdrop con la receta de §5, títulos de diálogo en `font-display`, botón primario con la
  receta de §5. Las acciones destructivas (pausar, borrar) siguen en `bad`.
- `ReglasView.tsx` (2593 líneas): es sobre todo formularios. Unificá inputs/selects con el mismo tratamiento
  que usa `app/(panel)/config/kit.ts` **leyéndolo, sin importarlo si hoy no lo importa** (no agregues imports
  nuevos entre secciones). Sus 3 clases arbitrarias con color literal pasan a tokens (D5).
- `SubNav`, `TabsNivel`, `ControlVistas`, `ChipCascada`, `BarraFiltros`, `BarraSeleccion`, `Paginacion`:
  estado activo/elegido en acento (D1).
- **Este archivo mueve plata en Meta.** `GestorAnuncios.tsx` tiene 2225 líneas de lógica de pedidos y
  `togglePlazo.test.ts` lee su fuente (los `AbortSignal.timeout`): tocá SOLO `className` ahí.

## 3. Cómo trabajar

1. **Antes de escribir, leé** `tailwind.config.ts` y `app/globals.css` (ya con la paleta nueva de T01) y
   `components/ui.tsx`: copiá su tratamiento de foco, botón primario y superficies. **No copies** clases de
   ahí que sean `good` de semántica creyendo que son de interfaz.
2. Barré tus archivos con `grep -nE "good-" <archivo>` y decidí cada uso con D1. Los dudosos, a NOTAS.
3. Después el pulido visual, archivo por archivo.
4. No corras `npm run build`, `next dev` ni `next lint`: compartís `.next/` con otras tres tasks. El build y
   la revisión visual los corre el orquestador en la compuerta.

## 4. Tests

No agregás ni modificás tests. Los tuyos (y `lib/paleta.test.ts`, que barre todas las clases de color) son
la red.

## 5. Verificación

```bash
cd /Users/lucho/Desktop/funnel/dashboard-admin
F=("app/(panel)/anuncios/AsaRedimension.tsx" "app/(panel)/anuncios/BarraFiltros.tsx" "app/(panel)/anuncios/BarraFrescura.tsx" "app/(panel)/anuncios/BarraPrimaria.tsx" "app/(panel)/anuncios/BarraSeleccion.tsx" "app/(panel)/anuncios/celdas.tsx" "app/(panel)/anuncios/ChipCascada.tsx" "app/(panel)/anuncios/ConfiguradorColumnas.tsx" "app/(panel)/anuncios/ControlVistas.tsx" "app/(panel)/anuncios/DialogoConfirmacion.tsx" "app/(panel)/anuncios/EncabezadoOrdenable.tsx" "app/(panel)/anuncios/FormularioDuplicar.tsx" "app/(panel)/anuncios/FormularioPresupuesto.tsx" "app/(panel)/anuncios/FormularioProgramar.tsx" "app/(panel)/anuncios/FormularioRenombrar.tsx" "app/(panel)/anuncios/FranjaTotales.tsx" "app/(panel)/anuncios/GestorAnuncios.tsx" "app/(panel)/anuncios/historial/HistorialView.tsx" "app/(panel)/anuncios/layout.tsx" "app/(panel)/anuncios/loading.tsx" "app/(panel)/anuncios/Paginacion.tsx" "app/(panel)/anuncios/PopoverFila.tsx" "app/(panel)/anuncios/Previsualizacion.tsx" "app/(panel)/anuncios/reglas/ReglasView.tsx" "app/(panel)/anuncios/ResultadosLote.tsx" "app/(panel)/anuncios/SubNav.tsx" "app/(panel)/anuncios/TablaAds.tsx" "app/(panel)/anuncios/TabsNivel.tsx")
# 1 — interfaz sin verde en tus archivos
grep -noE "(focus:ring|focus-visible:ring|focus:border|focus-visible:border|outline|accent|shadow-glow)-good[-/0-9a-z]*|bg-good-900[/0-9]*|bg-good-800|border-good-700[/0-9]*" "${F[@]}" | wc -l   # esperado: 0
# 2 — sin hue viejo ni literales hex en tus archivos
grep -nE "4, ?6, ?14|#[0-9a-fA-F]{6}\b" "${F[@]}" | wc -l      # esperado: 0
# 3 — usaste el acento
grep -c "acento-" "${F[@]}" | awk -F: '{s+=$2} END {print s}'   # esperado: > 0
# 4 — la paleta: toda clase existe
npx vitest --run lib/paleta.test.ts components/ui.tokens.test.ts   # esperado: 0 failed
# 5 — tus tests
npx vitest --run "app/(panel)/anuncios"                      # esperado: 0 failed
# 6 — tipos: ningún error en tus archivos
npx tsc --noEmit -p . 2>&1 | grep "error TS" | grep -v "tareas/tablero.test.ts" | wc -l   # esperado: 0 (si aparece uno de un archivo ajeno, anotalo: decide la compuerta)
# 7 — solo cambios presentacionales: revisá a mano cada línea que imprime esto
git diff -U0 -- "${F[@]}" | grep -E "^[-+][^-+]" | grep -vE "className|class=|^[-+]\s*(//|\*|/\*)|^[-+]\s*['\"`][^'\"`]*['\"`],?$" | head -40   # esperado: solo wrappers de layout / aria-hidden / constantes de clases; nada de lógica
```

## 6. Cuándo parar

**Bloqueante, pará y avisá:**
- una clase que necesitás (`acento-N`, `font-display`, `.costura`) no existe: T01 no terminó bien.
- para lograr el diseño tenés que cambiar lógica, props, textos o un archivo ajeno.
- un test de tus archivos falla y la única forma de que pase es tocar el test.

**Anotalo en PREGUNTAS y seguí:**
- usos de `good` dudosos (qué elegiste y por qué).
- algo del kit (`ui.tsx`) o del shell que se vería mejor distinto: es de T01; describilo.
