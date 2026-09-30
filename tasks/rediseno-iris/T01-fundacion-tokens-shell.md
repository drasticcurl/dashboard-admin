# T01 — Fundación: paleta iris, fuente display, costura, kit de UI y shell

- **Depende de:** nada
- **Bloquea:** T02, T03, T04, T05 (declara las clases `acento-*`, `font-display`, `.costura`, `.costura-v`, `shadow-glow-acento`)
- **Se puede correr en paralelo con:** **Corre sola.** No paralelizar con nada.
- **Repo:** /Users/lucho/Desktop/funnel/dashboard-admin
- **Agente sugerido:** general-purpose — carga la skill `frontend-design:frontend-design` antes de tocar el kit y el shell.
- **Archivos que este task puede tocar:** la fila T01 de §7 del plan. Nada más.

Leé `00-PLAN-REDISENO-IRIS.md` completo. Tu contrato son §4 y §5: los valores se copian **exactos**, sin
"mejorarlos" (el contraste ya está verificado con esos números).

---

## 1. Objetivo

- `tailwind.config.ts` con la paleta de §4, la escala `acento`, las sombras con el hue `12,10,28`,
  `glow-acento`, y `fontFamily.display`.
- `app/layout.tsx` carga Bricolage Grotesque con `next/font/google` (variable, `subsets: ['latin']`,
  `variable: '--font-display'`, `display: 'swap'`) y la suma a las clases del `<html>`. `viewport.themeColor`
  pasa a `#0c0b14`.
- `app/globals.css`: `--sombra: 12 10 28`, `::selection` y `:focus-visible` en acento (`139 123 255`), los
  rgba del hue viejo reemplazados, `.glass` / `.glass-bar` con los valores de surface/canvas nuevos, `.aurora`
  con manchas de acento (iris) + una de info, y las recetas nuevas `.costura` / `.costura-v` (§5).
- `components/ui.tsx`: mismo API, aspecto nuevo: títulos de `Card` en `font-display`, foco y estados de
  interacción en `acento` (D1), `Skeleton`, `EmptyState`, `Toolbar`, `IconButton`, `Widget` y `ChartFrame` al
  día con la paleta. Los tonos semánticos (`TONE_*`) **siguen** en good/warn/bad/info.
- Shell: sidebar con el nombre del panel en `font-display`, ítem activo `bg-acento-900 text-acento-100` con
  `.costura-v` a la izquierda (reemplaza la barra `before:` de 2px), punto de saldo pendiente en acento,
  avatar en `acento-800`. Drawer y header móvil igual. `EncabezadoPagina`: `h1` en `font-display`
  (semibold, tracking apretado) con una `.costura` de 48px debajo; chip del funnel en acento.
- `PanelLogo` en degradado acento con `shadow-glow-acento`; `app/icon.svg` en los colores nuevos.
- `RangePicker`, `SwitchMoneda`, `AvisoSaldo`: `good` de interfaz → `acento` (D1). El latido del aviso de
  saldo es `warn` y se queda.
- El botón «Salir» del layout `(panel)` pasa a acento.

**Este task no** toca pantallas (`app/(panel)/<sección>/**`), no cambia firmas de `ui.tsx`, no agrega
animaciones (D9), no cambia textos.

## 2. `tailwind.config.ts`

Antes de escribir, leelo completo. **Copiá** su estilo: cada decisión con su comentario del porqué. **No
copies** los comentarios que describen el verde como acento: reescribilos para la decisión D1 (acento ≠ good).

- `panelColors`: los valores de §4, más `acento` y `acentoLight`. Las claves existentes no cambian de nombre
  (T03 las consume).
- `colors.acento` con los 9 pasos de §4. **El nombre es `acento`, no `accent`**: `accent-*` es la utilidad de
  `accent-color` de Tailwind y `accent-accent-500` sería ambiguo de leer.
- `fontFamily.display: ['var(--font-display)', 'var(--font-geist-sans)', 'system-ui', 'sans-serif']`.
- `boxShadow`: cambiar `rgba(4, 6, 14, …)` por `rgba(12, 10, 28, …)` manteniendo alfas; agregar `glow-acento`.

## 3. `app/globals.css`

- `.costura`: `height: 2px; background-image: repeating-linear-gradient(90deg, theme('colors.acento.500') 0 6px, transparent 6px 10px); border-radius: 9999px;`
  `.costura-v`: lo mismo en `180deg`, `width: 2px`. Con un comentario que explique el motivo (hilván) y
  que D7 limita dónde se usa.
- `.aurora`: el acento iris en las dos manchas grandes y `info` en la fría; alfas iguales o menores a las de
  hoy (0.09 / 0.07 / 0.035). Es luz, no decoración.
- Todo `rgb(34 197 138 …)` de interfaz (selection, focus) → `rgb(139 123 255 …)`.

## 4. Tests

`lib/paleta.test.ts` y `components/ui.tokens.test.ts` ya existen y son tus guardianes: el primero falla si
alguna clase `acento-N` que escribas no está en la escala, el segundo si el `Table` pierde sus bordes.
No agregues ni modifiques tests.

## 5. Verificación

```bash
cd /Users/lucho/Desktop/funnel/dashboard-admin
# 1 — contraste de la paleta congelada
node tasks/rediseno-iris/_verificacion-contraste.mjs            # esperado: "todo en verde"
# 2 — los valores de §4 están en el config
grep -c "#8b7bff\|#0c0b14\|#15141f\|#1d1c2b" tailwind.config.ts   # esperado: >= 4
grep -rn "4, 6, 14\|4,6,14\|#08090d\|#111219\|#22c58a" tailwind.config.ts app/globals.css app/layout.tsx components/ | wc -l   # esperado: 0
# 3 — la fuente
grep -n "Bricolage_Grotesque" app/layout.tsx                    # esperado: 1 import + 1 uso
# 4 — clases nuevas declaradas
grep -c "\.costura" app/globals.css                             # esperado: >= 2
# 5 — interfaz del shell sin verde
grep -rnoE "good-[0-9]+" components/Shell.tsx components/Nav.tsx components/PanelLogo.tsx components/EncabezadoPagina.tsx components/RangePicker.tsx components/SwitchMoneda.tsx "app/(panel)/layout.tsx" | wc -l   # esperado: 0
# 6 — tipos y tests
npx tsc --noEmit -p . 2>&1 | grep -c "error TS"                 # esperado: 1 (tablero.test.ts, línea base)
npx vitest --run lib/paleta.test.ts components/ui.tokens.test.ts   # esperado: todos pasan
# 7 — build (T01 corre sola, puede)
npm run build 2>&1 | tail -5                                    # esperado: sin "Failed to compile"; si falla por red al bajar la fuente, BLOQUEANTE
```

## 6. Cuándo parar

**Bloqueante, pará y avisá:**
- `next/font/google` no puede bajar Bricolage (sin red en el build): no la reemplaces por otra fuente.
- `lib/paleta.test.ts` o `ui.tokens.test.ts` fallan y la única forma de que pasen es cambiar el test.
- Necesitás cambiar la firma de un componente de `ui.tsx`.

**Anotalo en PREGUNTAS y seguí:**
- un `good` de `ui.tsx` que no sabés si es interfaz o semántica (aplicá la regla de duda de D1).
- necesitás modificar un archivo ajeno → nunca; anotalo.
