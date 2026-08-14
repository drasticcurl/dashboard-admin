# T07 — Config partida en secciones, Leads, Anuncios, Nav y el editor de etapas

- **Depende de:** T01 (terminada y compilando). **No** depende de T02, T03 ni T04.
- **Bloquea:** nada.
- **Corre sola**, al final. No por dependencia, sino por volumen: son 5 pantallas y 1.528 líneas sólo
  de Config.
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos que este task puede tocar:**
  `app/(panel)/config/**`, `app/(panel)/leads/**`, `app/(panel)/anuncios/**`, `components/Nav.tsx`,
  `app/(panel)/layout.tsx`, `app/api/config/steps/route.ts`, `app/api/config/stages/route.ts`.
  **Nada más.**

Leé `00-PLAN-REDISENO.md` completo, en especial **D-R07** (por qué las etapas van por slug, y el bug
que lo motivó) y **D-R11** (iconos).

Es el task más grande del rediseño. Está ordenado por importancia: **§2 es un bug de producción**, §3
es la queja textual del usuario, y §6 es un cambio cosmético sobre código recién desplegado.

---

## 1. Objetivo

Las cinco pantallas que quedan, más dos arreglos de backend:

1. **Arreglar el bug de `counts_in_funnel`** (§2). Es un bug real, en producción, que borra datos en
   silencio.
2. **Partir Config en secciones navegables** (§3). El usuario: *"todo, más que nada la de config que es
   una verga"*.
3. **El editor de etapas del embudo** (§4), que es lo que hace configurable lo que T04 dibuja.
4. **Leads** (§5) y **Anuncios** (§6) con los tokens y los estados nuevos.
5. **Nav e iconos** (§7).

## 2. El bug: `counts_in_funnel` se resetea solo

**Esto está pasando en producción hoy.** `app/api/config/steps/route.ts` (el POST de "Importar pasos")
hace, en las líneas 146-152:

```sql
DELETE FROM funnel_steps WHERE funnel_id = $1;
INSERT INTO funnel_steps (funnel_id, step_index, slug, label, kind) VALUES ...
```

`funnel_steps` tiene **seis** columnas: `funnel_id`, `step_index`, `slug`, `label`, `kind`
(default `'question'`) y **`counts_in_funnel` (default `true`)**. El INSERT no la incluye, así que
cada importación de pasos la devuelve a `true` para todos los pasos del funnel.

**Y sí se usa:** `lib/funnels.ts:60` la lee. Así que si alguien marcó un paso como "no cuenta en el
embudo" y después importó los pasos, ese ajuste se perdió sin ningún aviso, y el embudo cambió de
números sin que nadie lo tocara.

**El arreglo:** preservar el valor a través del DELETE+INSERT. Dos formas, cualquiera sirve:

- leer los `counts_in_funnel` actuales por slug antes del DELETE y reinyectarlos en el INSERT, o
- reemplazar el DELETE+INSERT por un `INSERT ... ON CONFLICT (funnel_id, step_index) DO UPDATE` que
  actualice sólo `slug`, `label` y `kind`, más un DELETE de los pasos que ya no vienen.

**La segunda es mejor** (no destruye y recrea filas que no cambiaron), pero cuidado con los dos únicos
de la tabla: PK `(funnel_id, step_index)` y UNIQUE `(funnel_id, slug)`. Un reordenamiento del quiz
puede chocar contra el UNIQUE a mitad del upsert si dos pasos intercambian índices. Si te complica,
hacé la primera: es fea pero correcta.

**El test que hace falta:** marcá un paso con `counts_in_funnel = false`, importá los pasos, y
verificá que **sigue en `false`**. Sin ese test, el bug vuelve en el próximo refactor.

**P-R05 del plan:** el bug existe desde siempre, así que si el usuario había marcado algún paso, ese
dato ya no está y no se puede recuperar. Preguntale si había alguno.

## 3. Config, partida en secciones

Hoy son **1.528 líneas y 9 secciones sin ninguna navegación interna**. Es una página infinita: para
llegar a "Cotizaciones" hay que scrollear por Funnels, Publicidad, Comisiones, los pasos del quiz y
los productos.

Las nueve, con dónde están hoy:

| Sección | Línea aprox. |
|---|---|
| Funnels | 589 |
| Publicidad | 720 |
| Comisiones | 906 |
| Pasos del quiz | 1060 |
| Productos → funnel/tier | 1163 |
| Tiendas → funnel | 1343 |
| Ajustes | 1383 |
| Cotizaciones | 1413 |
| Salud del sistema | 1443 |

**Más una nueva: Etapas del embudo** (§4).

### Cómo se parte

Navegación interna con la sección en el query string (`?s=funnels`), del mismo modo que el resto del
panel maneja sus filtros (D-R14). Que el estado esté en la URL es lo que hace que una sección se pueda
compartir por link y sobreviva a un refresh.

**Y `app/(panel)/config/ConfigView.tsx` se parte en archivos, uno por sección.** Un archivo de 1.528
líneas no se puede revisar, y dejarlo en uno solo con pestañas arriba resuelve la navegación pero no el
mantenimiento. `app/(panel)/config/**` es todo tuyo, así que la estructura la elegís vos.

**Agrupá las nueve en pocos grupos.** Nueve pestañas en una fila es la misma pared que nueve secciones
apiladas. Un agrupamiento que se sostiene:

- **Funnels**: funnels, pasos del quiz, etapas del embudo
- **Dinero**: comisiones, productos, cotizaciones
- **Fuentes**: publicidad, tiendas
- **Sistema**: ajustes, salud del sistema

No es la única forma. Si elegís otra, que el criterio sea "qué busca el usuario cuando entra", no "qué
tabla toca cada sección".

### Lo que no se puede perder

Config es la pantalla con más acciones del panel y la más fácil de romper: **cada sección tiene
formularios que escriben en la base**. Antes de tocar, listá todas las acciones de las nueve secciones
(cada botón de guardar, cada alta, cada baja, cada toggle) y **verificá una por una** al terminar.
§9.5 del plan aplica con más fuerza acá que en cualquier otra pantalla.

## 4. El editor de etapas — `app/api/config/stages/route.ts` (nuevo)

Es lo que hace **configurable por funnel** el embudo que dibuja T04, que era el pedido explícito del
usuario: *"tiene que ser individual por funnel"*.

**Leé `_schema-017.sql` antes de escribir el route.** La tabla `funnel_stages` tiene 3 CHECK y 2
índices únicos parciales, y están comentados: son el contrato.

Lo que la UI tiene que permitir, por funnel:

- ver las etapas en orden (`stage_order`);
- **agregar** una etapa de paso (eligiendo un slug de los pasos del funnel) o de hito (eligiendo uno
  de los tres `milestone`);
- **renombrar** el `label`;
- **reordenar** y **borrar**.

### Las reglas que el route tiene que respetar

Los CHECK de la 017 ya rechazan lo imposible en la base, pero un 500 de Postgres no es un mensaje de
error usable. **Validá antes y devolvé 400 con un motivo en castellano:**

1. **Una etapa es de paso o de hito, nunca las dos ni ninguna.** `starts_at_slug` xor `milestone`.
2. **`milestone` sólo puede ser `sales_view`, `checkout_click` o `purchase`.**
3. **Un slug no puede arrancar dos etapas del mismo funnel** (índice único parcial).
4. **`stage_order` sin huecos ni repetidos** dentro del funnel.
5. **El slug tiene que existir** en los `funnel_steps` de ese funnel. Si no, la etapa nace huérfana y
   T04 la va a mostrar como tal: mejor rechazarla acá.

Seguí el patrón de los routes que ya existen (`app/api/config/settings/route.ts` es el modelo):
`guard(req)` primero, `parseJson`, `safeParse` de zod, `json(400, { ok: false, error: 'invalid_payload',
detail })`. **`guard` va antes de leer el body**, y sin la cookie devuelve 401 sin escribir nada.

### Lo que la UI tiene que decir

**Que separar `viral_news` y `loading_steps` es agregar una etapa acá** (D-R08 y P-R03 del plan). El
seed las dejó fusionadas —`viral_news` dentro de Preguntas, `loading_steps` dentro de Diagnóstico— por
una decisión que el usuario delegó. Es la única decisión del plan que cambia lo que él va a mirar todos
los días, y esta pantalla es donde se revierte, sin migración.

## 5. Leads

Aplicá los tokens de T01, los iconos, y los tres estados (§9.10 del plan): `Skeleton` con la forma del
contenido, vacío compuesto, error con reintentar.

**El orden de la tabla va al query string** (`?sort=`, D-R14). Hoy vive en `useState`.

No la rediseñes más allá de eso: es una tabla y funciona.

## 6. Anuncios — cambio cosmético, nada más

**Las tres pantallas de Anuncios se desplegaron el 2026-08-13 y están en producción**, con un worker
PM2 que puede escribir en Meta. Así que acá el alcance es **estrictamente visual**:

**Sí:** tokens de T01, iconos Phosphor, los tres estados, `Skeleton` en lugar de spinner, y consolidar
los avisos si están apilados.

**No, y esto no es negociable:**

- **no cambies la lógica de las acciones** (toggles, presupuesto, lote);
- **no toques `lib/ads/**` ni `lib/queries/ads.ts`** — están en la lista de archivos que nadie toca
  (§8 del plan);
- **no cambies los payloads** que las pantallas mandan a `/api/ads/acciones`, `/api/ads/reglas` ni
  `/api/ads/interruptores`;
- **no toques el estado seguro**: `ads_rules_enabled=false` y `ads_rules_force_dry_run=true` se quedan
  como están. Si tu cambio los mueve, lo hiciste mal.

El módulo tiene su propio runbook (`docs/runbook-anuncios.md`) y su propia verificación. Este task le
cambia los colores, no el comportamiento.

## 7. Nav, layout e iconos

**`components/Nav.tsx`**: los tokens, y **el logo deja de ser la letra `P`**. Hoy los "iconos" del
panel son los caracteres `▾ ▲ ▼ ↓ ↑` y esa `P`.

**Reemplazá todos por Phosphor** (D-R11). `@phosphor-icons/react` ya está instalado (T01 lo declaró).
Tres reglas:

- **una sola librería**, sin mezclar con caracteres ni con `<svg>` a mano;
- **peso uniforme** en todo el proyecto (elegí uno y respetalo);
- **todo icono que sea un botón lleva `aria-label`.** El `IconButton` de T01 lo obliga en el tipo, así
  que usalo en lugar de armar botones a mano.

**`app/(panel)/layout.tsx`**: los tokens del fondo. **Y no declares la fuente acá**: va en
`app/layout.tsx` y es de T01 (D-R12). Si la ves declarada en los dos lados, sacá la de acá.

**El Nav superior se queda.** El usuario lo eligió, y un sidebar come ancho en las tablas.

## 8. Verificación

```bash
cd ~/Desktop/funnel/dashboard-admin
npx tsc --noEmit && npm run build && npm test
npm run dev
```

```
# 1 — EL BUG DE counts_in_funnel, ARREGLADO (§2). Lo más importante del task.
docker exec panel-db-1 psql -U panel -d panel -c \
  "UPDATE funnel_steps SET counts_in_funnel=false
    WHERE slug='viral_news'
      AND funnel_id=(SELECT id FROM funnels WHERE slug='chauhinchazon');"
#     Ahora entrá a Config → Pasos del quiz → Importar pasos, y reimportá.
docker exec panel-db-1 psql -U panel -d panel -c \
  "SELECT slug, counts_in_funnel FROM funnel_steps
    WHERE slug='viral_news'
      AND funnel_id=(SELECT id FROM funnels WHERE slug='chauhinchazon');"
#     esperado: counts_in_funnel = f (SIGUE en false).
#     Si volvió a t, el bug NO está arreglado. Es un bug de producción que
#     borra datos en silencio: no sigas sin resolverlo.
#     Después dejalo como estaba: UPDATE ... SET counts_in_funnel=true.

# 2 — CADA ACCIÓN DE CONFIG SIGUE FUNCIONANDO (§3, §9.5 del plan).
#     Las nueve secciones, una por una, probando de verdad cada guardar/alta/
#     baja/toggle. Es la pantalla con más escrituras del panel y la más fácil
#     de romper al partirla en archivos:
#       Funnels · Publicidad · Comisiones · Pasos del quiz · Productos ·
#       Tiendas · Ajustes · Cotizaciones · Salud del sistema
#     Marcá cada una a medida que la probás. Un formulario que quedó
#     desconectado no da error de compilación: simplemente no guarda.

# 3 — la navegación interna está en la URL (§3, D-R14)
#     Entrá a una sección, mirá que la URL tenga ?s=..., apretá F5: sigue ahí.
#     Copiá el link a otra pestaña: abre en la misma sección.

# 4 — ConfigView SE PARTIÓ de verdad
wc -l app/\(panel\)/config/*.tsx
#     Antes: ConfigView.tsx con 1528 líneas. Si sigue habiendo un archivo de
#     ~1500, agregaste pestañas pero no partiste nada.

# 5 — EL EDITOR DE ETAPAS y sus validaciones (§4)
TOKEN=$(grep PANEL_PASSWORD .env | cut -d= -f2)
#     Sin cookie: 401 y no escribe
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3005/api/config/stages \
  -H 'content-type: application/json' -d '{}'
#     esperado: 401
#     Los cinco casos inválidos del §4 → 400 con motivo, NO 500:
for BODY in '{"funnelId":1,"stages":[{"stageOrder":0,"label":"X","startsAtSlug":"landing_hook","milestone":"purchase"}]}' \
            '{"funnelId":1,"stages":[{"stageOrder":0,"label":"X"}]}' \
            '{"funnelId":1,"stages":[{"stageOrder":0,"label":"X","milestone":"otra_cosa"}]}' \
            '{"funnelId":1,"stages":[{"stageOrder":0,"label":"A","startsAtSlug":"landing_hook"},{"stageOrder":1,"label":"B","startsAtSlug":"landing_hook"}]}' \
            '{"funnelId":1,"stages":[{"stageOrder":0,"label":"A","startsAtSlug":"no_existe"}]}'; do
  curl -s -o /dev/null -w "%{http_code} " -X POST http://localhost:3005/api/config/stages \
    -b "panel_token=$TOKEN" -H 'content-type: application/json' -d "$BODY"
done; echo
#     esperado: 400 400 400 400 400. Un 500 significa que dejaste que el CHECK
#     de Postgres haga la validación, y el usuario ve un error ilegible.

# 6 — LAS ETAPAS EDITADAS LLEGAN AL EMBUDO (el circuito completo)
#     Agregá desde Config una etapa que arranque en 'nombre' (paso 5) para
#     chauhinchazon: eso separa viral_news de Preguntas (D-R08, P-R03).
#     Abrí /embudo: el embudo tiene una parte MÁS y los números se recalculan.
#     Volvé a borrarla si no la querés dejar.

# 7 — la verificación SQL sigue en verde después de editar etapas a mano
docker exec -i panel-db-1 psql -U panel -d panel -v ON_ERROR_STOP=1 \
  < redesign-ui-tasks/_verificacion-017.sql
#     §5 (xor y vocabulario), §6 (huérfanas) y §7 (cobertura de pasos) son los
#     que tu editor puede romper. Leé la salida, no sólo el exit code.

# 8 — ANUNCIOS: NADA DE LÓGICA CAMBIÓ (§6). Está en producción.
docker exec panel-db-1 psql -U panel -d panel -c \
  "SELECT key, value FROM settings
    WHERE key IN ('ads_rules_enabled','ads_rules_force_dry_run');"
#     esperado: false y true. El estado seguro no se movió.
#     Y probá las tres pantallas: /anuncios, /anuncios/reglas, /anuncios/historial.
#     Los toggles, el presupuesto y el lote siguen haciendo lo mismo.

# 9 — CERO iconos de texto y cero svg a mano (§7, D-R11)
grep -rn "▾\|▲\|▼\|↓\|↑" app/ components/ --include=*.tsx
#     esperado: sin resultados.
grep -rn "<svg" app/ components/ --include=*.tsx
#     esperado: sin resultados (los iconos son de Phosphor).

# 10 — la fuente NO está declarada dos veces (§7, D-R12)
grep -rn "GeistSans\|GeistMono\|next/font" app/layout.tsx app/\(panel\)/layout.tsx
#     esperado: sólo en app/layout.tsx.

# 11 — ?sort= de Leads sobrevive al refresh (§5, D-R14)

# 12 — accesibilidad y limpieza (§9.8 y §9.9 del plan)
grep -rn "window.alert\|console.log" app/\(panel\)/config/ app/\(panel\)/leads/ \
  app/\(panel\)/anuncios/ components/Nav.tsx
#     esperado: sin resultados.
#     Y a mano: Tab llega a cada control con foco visible, todo botón de icono
#     tiene aria-label, ningún control es un <div> con onClick.

# 13 — no se tocó nada fuera de la fila T07 de §8 del plan
find . -newermt '-3 hours' -type f \
  -not -path './node_modules/*' -not -path './.next/*' -not -path './.git/*' \
  -not -name '*.log' -not -name 'tsconfig.tsbuildinfo' | sort
# esperado: app/(panel)/config/**, app/(panel)/leads/**, app/(panel)/anuncios/**,
# components/Nav.tsx, app/(panel)/layout.tsx, app/api/config/steps/route.ts,
# app/api/config/stages/route.ts.
# Si aparece lib/ads/** o components/ui.tsx, revertilo: no son de este task.
```

## 9. Cuándo parar

**Bloqueante, pará y avisá:**

- **`counts_in_funnel` sigue reseteándose** (verificación 1). Es un bug de producción que borra datos
  en silencio y es la razón número uno de este task.
- **Una acción de Config dejó de guardar** (verificación 2). Es la pantalla con más escrituras del
  panel: un formulario desconectado no da error de compilación.
- **El editor de etapas devuelve 500** en lugar de 400 en los casos inválidos, o deja crear una etapa
  que rompe `_verificacion-017.sql`.
- **Algo de la lógica de Anuncios cambió**, o `ads_rules_enabled` / `ads_rules_force_dry_run` se
  movieron. Ese módulo puede escribir en Meta.
- **`ConfigView.tsx` sigue siendo un archivo de ~1.500 líneas** (verificación 4): la queja del usuario
  no se resolvió.

**Anotalo en §10 del plan y seguí:**

- **P-R05: si el usuario había marcado algún paso con `counts_in_funnel = false`** antes de una
  importación, ese dato ya se perdió y no se puede recuperar. Preguntale si había alguno.
- **Cómo agrupaste las nueve secciones** y por qué. Es una decisión de navegación que el usuario va a
  querer opinar: fue su queja más fuerte.
- Te falta un primitivo de `ui.tsx` (un tab bar, un modal). Es de T01: resolvelo local y anotalo.
- Encontrás otro bug preexistente como el de §2. **No lo arregles de paso**: anotalo. Un arreglo no
  pedido dentro de un task de rediseño es imposible de revisar y puede mover números.
- Si el upsert del §2 choca contra el UNIQUE `(funnel_id, slug)` al reordenar, anotá que quedó con la
  primera forma (leer y reinyectar) y por qué.
