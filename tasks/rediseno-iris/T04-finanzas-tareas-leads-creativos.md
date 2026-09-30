# T04 — Finanzas, Tareas, Leads y Creativos en iris

- **Depende de:** T01 (las clases `acento-*`, `font-display`, `.costura`, `.costura-v`, `shadow-glow-acento`)
- **Bloquea:** nada
- **Se puede correr en paralelo con:** T02, T03, T05
- **Repo:** /Users/lucho/Desktop/funnel/dashboard-admin
- **Agente sugerido:** general-purpose — cargá la skill `frontend-design:frontend-design` antes de empezar.
- **Archivos que este task puede tocar:** la fila T04 de §7 del plan. Nada más.

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

- Finanzas: `GraficoSaldo.tsx` con el saldo/patrimonio en `panelColors.acento` (D8) y variaciones en
  good/bad; sus 2 literales de color pasan a `panelColors` (D5). `Modal.tsx`: backdrop con la receta de §5,
  superficie `surface-overlay`, título en `font-display`. `CargaDiaria.tsx`: el botón que late
  (`animate-latido`, warn) **se queda warn**: es un recordatorio, no una acción primaria.
- Tareas (kanban): columnas con encabezado en `font-display` pequeño, tarjetas con `lift`, tarjeta
  arrastrándose / en foco en acento. Las prioridades son semánticas (alta = bad, media = warn…): quedan.
  `prioridad.ts` no se toca.
- Leads: filtros y botón «exportar»/primario en acento con la receta de §5; «Sí» de conversión queda good.
- Creativos: ranking de rendimiento — bueno/malo quedan en good/bad; selección y controles en acento.

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
F=("app/(panel)/finanzas/CargaDiaria.tsx" "app/(panel)/finanzas/CuentasSection.tsx" "app/(panel)/finanzas/FinanzasView.tsx" "app/(panel)/finanzas/GraficoSaldo.tsx" "app/(panel)/finanzas/Modal.tsx" "app/(panel)/finanzas/loading.tsx" "app/(panel)/tareas/Columna.tsx" "app/(panel)/tareas/DetalleTarea.tsx" "app/(panel)/tareas/NuevaTarea.tsx" "app/(panel)/tareas/TableroView.tsx" "app/(panel)/tareas/TarjetaTarea.tsx" "app/(panel)/tareas/loading.tsx" "app/(panel)/leads/LeadsView.tsx" "app/(panel)/leads/loading.tsx" "app/(panel)/creativos/CreativosView.tsx" "app/(panel)/creativos/loading.tsx")
# 1 — interfaz sin verde en tus archivos
grep -noE "(focus:ring|focus-visible:ring|focus:border|focus-visible:border|outline|accent|shadow-glow)-good[-/0-9a-z]*|bg-good-900[/0-9]*|bg-good-800|border-good-700[/0-9]*" "${F[@]}" | wc -l   # esperado: 0
# 2 — sin hue viejo ni literales hex en tus archivos
grep -nE "4, ?6, ?14|#[0-9a-fA-F]{6}\b" "${F[@]}" | wc -l      # esperado: 0
# 3 — usaste el acento
grep -c "acento-" "${F[@]}" | awk -F: '{s+=$2} END {print s}'   # esperado: > 0
# 4 — la paleta: toda clase existe
npx vitest --run lib/paleta.test.ts components/ui.tokens.test.ts   # esperado: 0 failed
# 5 — tus tests
npx vitest --run "app/(panel)/finanzas" "app/(panel)/tareas" "app/(panel)/creativos"   # esperado: 0 failed
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
