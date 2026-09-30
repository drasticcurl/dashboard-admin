# Prompts para Claude Code — rediseño iris

## Antes de arrancar

```
tasks/rediseno-iris/
├── 00-PLAN-REDISENO-IRIS.md            el documento maestro — leerlo primero, siempre
├── PROMPT-CLAUDE-CODE.md               este archivo
├── _verificacion-contraste.mjs         15 afirmaciones de contraste sobre la paleta de §4 — YA EN VERDE
├── T01-fundacion-tokens-shell.md       tokens + fuente + costura + ui.tsx + shell — BLOQUEA A LAS CUATRO
├── T02-anuncios.md                     app/(panel)/anuncios/**
├── T03-resumen-embudo-ventas.md        resumen, embudo, ventas + componentes de gráficos + lib/widgets
├── T04-finanzas-tareas-leads-creativos.md
└── T05-config-y-acceso.md              config + login + cambiar clave + sin acceso
```

**Qué se construye:** el panel pasa de casi-negro + esmeralda a "iris sobre tinta", con Bricolage Grotesque
para títulos y la costura como firma. Solo visual. El panel está **en producción en dos dominios**; los
agentes trabajan en local y nadie deploya.

### Lo que ya está verificado

- **La paleta de §4 cumple contraste** (texto apagado 4.68:1 sobre surface, botón primario 5.94–7.27:1,
  nav activo 13:1). `node tasks/rediseno-iris/_verificacion-contraste.mjs`.
- **Bricolage Grotesque existe en el `next/font/google` de Next 14.2.5** (variable, ejes opsz/wdth/wght).
- **`lib/paleta.test.ts` ya barre todas las clases de color** del repo contra la paleta resuelta: una
  `acento-N` que no existe falla la suite. Es la red gratis de la ola 2.
- **Línea base:** `tsc` 1 error (`tareas/tablero.test.ts(18,5)`), `vitest` 135 archivos / 1747 tests pasan.
- Hoy hay 117 usos de `good` en rol de interfaz (foco, selección, checkbox, glow).

### 4 cosas que hay que saber antes de largar el primer agente

**1. T01 va sola y primero**: declara `acento-*`, `font-display`, `.costura`. Sin eso, la ola 2 no compila
contra `lib/paleta.test.ts`.
**2. Si el build no puede bajar la fuente, se para**: no se cambia de fuente en silencio.
**3. Anuncios mueve plata en Meta**: T02 toca solo `className` en `GestorAnuncios.tsx` y `TablaAds.tsx`.
**4. El plan es el contrato**: §4 y §5 están congelados.

## El orden

```
Paso 1   T01                         1 agente, SOLO
Paso 2   T02 · T03 · T04 · T05       4 en paralelo
```

**Si preferís ir de a uno:** T01, T05, T04, T03, T02.

---

## Preámbulo (va al inicio de cada prompt)

> Repo: `/Users/lucho/Desktop/funnel/dashboard-admin`, un panel Next.js 14 + Tailwind en producción (acá se
> trabaja en local, nadie deploya). Rediseño solo visual: paleta "iris sobre tinta", fuente display y la
> costura como firma.
>
> Leé estos archivos completos antes de escribir código, en este orden:
> 1. `tasks/rediseno-iris/00-PLAN-REDISENO-IRIS.md`
> 2. `tasks/rediseno-iris/<TU-TASK>`
>
> Cargá la skill `frontend-design:frontend-design` con la herramienta Skill antes de diseñar: el plan ya fijó
> paleta, fuente y firma, así que la skill te sirve para el criterio (jerarquía, restricción, una sola cosa
> memorable), no para elegir otra dirección.
>
> Reglas que no se negocian:
> - **Solo escribís los archivos de tu fila en §7 del plan.** Otros agentes trabajan en paralelo.
> - **Hay una lista de archivos que NADIE toca** (§7): tests, `app/api/**`, `lib/**` (salvo lo asignado),
>   `package.json`, los `.ts` de lógica.
> - **No instalás dependencias.**
> - **No cambiás lógica, handlers, props, fetch ni textos visibles** (D3). Solo estilo y JSX presentacional.
> - **Si aparece una decisión que el plan no resuelve, no la decidís en el código:** va a PREGUNTAS del
>   reporte. Si bloquea, parás.
> - Comentarios en castellano rioplatense, con el estilo del repo: el porqué, no el qué.
> - **Al terminar, corré tu sección de Verificación COMPLETA y pegá la salida.** "Compila" no es verificación.

## Paso 1
### T01 — Fundación: paleta iris, fuente display, costura, kit de UI y shell
> [preámbulo, con `<TU-TASK>` = `T01-fundacion-tokens-shell.md`]
>
> Implementá la fundación: tokens de §4, clases de §5, fuente, `ui.tsx` y el shell.
>
> Atención: (1) los valores de §4 se copian exactos — el contraste ya está probado con esos; (2) el token se
> llama `acento`, no `accent`; (3) las firmas de `ui.tsx` no cambian y `ui.tokens.test.ts` tiene que quedar
> verde; (4) los `TONE_*` de `ui.tsx` son semánticos y siguen en good/warn/bad/info. Vos corrés sola: podés
> correr `npm run build`.

## Paso 2
**Antes de largar la ola 2:** la compuerta de la ola 1 en verde (build incluido).

### T02 — Anuncios en iris
> [preámbulo, con `<TU-TASK>` = `T02-anuncios.md`]
>
> Pasá Anuncios (tabla, barras, popovers, formularios, reglas, historial) a la paleta iris con D1.
>
> Atención: `BORDE_CELDA` de `TablaAds.tsx` no cambia; en `GestorAnuncios.tsx` solo `className`
> (`togglePlazo.test.ts` lee su fuente); pérdida/ganancia y estado de entrega siguen en good/bad/warn.

### T03 — Resumen, Embudo, Ventas y gráficos en iris
> [preámbulo, con `<TU-TASK>` = `T03-resumen-embudo-ventas.md`]
>
> Pasá Resumen, Embudo, Ventas y los componentes de gráficos a la paleta iris; series según D8.
>
> Atención: la costura del embudo (D7-3) es tuya y es la firma — un trazo por conector; no cambies el
> layout por defecto de widgets; cero hex en `lib/widgets/catalogo-*.tsx` (salen de `panelColors`).

### T04 — Finanzas, Tareas, Leads y Creativos en iris
> [preámbulo, con `<TU-TASK>` = `T04-finanzas-tareas-leads-creativos.md`]
>
> Pasá Finanzas, Tareas, Leads y Creativos a la paleta iris.
>
> Atención: el latido de «Cargar saldo de hoy» queda warn; prioridades de tareas quedan semánticas; el modal
> usa el backdrop de §5.

### T05 — Config y pantallas de acceso en iris
> [preámbulo, con `<TU-TASK>` = `T05-config-y-acceso.md`]
>
> Pasá Configuración, login, cambiar clave y sin acceso a la paleta iris.
>
> Atención: empezá por `config/kit.ts` (todas las secciones heredan de ahí); la costura va en el login y en
> ningún otro de tus archivos; los estados de `SaludSection` quedan semánticos.

---

## Compuertas entre olas

```bash
cd /Users/lucho/Desktop/funnel/dashboard-admin
# ── Compuerta de TODAS las olas ──
npx tsc --noEmit -p . 2>&1 | grep -c "error TS"          # esperado: 1
npx vitest --run 2>&1 | grep -E "Test Files|Tests "       # esperado: 0 failed
npm run build 2>&1 | grep -cE "Failed to compile|Type error"   # esperado: 0
git diff --stat -- app/api middleware.ts package.json package-lock.json next.config.mjs | wc -l   # esperado: 0
# ── Compuerta de la ola 1 ──
node tasks/rediseno-iris/_verificacion-contraste.mjs | tail -1    # esperado: todo en verde
grep -c "acento" tailwind.config.ts                      # esperado: > 0
grep -c "\.costura" app/globals.css                      # esperado: >= 2
# ── Compuerta de la ola 2 ──
grep -rnoE "(focus:ring|focus-visible:ring|focus:border|focus-visible:border|outline|accent|shadow-glow)-good|bg-good-900|bg-good-800" app components lib | wc -l   # esperado: 0
grep -rn "4,6,14\|4, 6, 14\|#08090d\|#111219\|#191b24\|#22c58a" app components lib tailwind.config.ts | wc -l   # esperado: 0
```

## Qué revisar cuando terminan

```bash
cd /Users/lucho/Desktop/funnel/dashboard-admin
# 1 — compila, buildea, tests
npx tsc --noEmit -p . 2>&1 | grep -c "error TS"          # esperado: 1
npx vitest --run 2>&1 | grep -E "Tests "                  # esperado: 0 failed
# 2 — nada fuera de lo visual cambió
git diff --stat -- app/api lib middleware.ts package.json | grep -v "lib/widgets/catalogo" | wc -l   # esperado: 1 (la línea de resumen) o 0
# 3 — revisión visual: levantar `npm run dev` y mirar /, /resumen, /embudo, /ventas, /anuncios, /anuncios/reglas,
#     /finanzas, /leads, /tareas, /creativos, /config a 1440px y 390px. Foco con Tab visible en acento.
# 4 — leé las preguntas abiertas que quedaron (§9 del plan)
```

Si la revisión visual muestra texto ilegible o un verde en rol de interfaz, se abre una task de corrección
sobre el archivo dueño; no se arregla desde el orquestador.
