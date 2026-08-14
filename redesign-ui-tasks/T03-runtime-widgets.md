# T03 — Runtime de widgets: grilla, arrastre, tamaños y guardado

- **Depende de:** T01 (terminada y compilando).
- **Bloquea:** T05 y T06 (las dos montan sus pantallas sobre `WidgetGrid`).
- **Paralelizable con:** T02 y T04.
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos que este task puede tocar:**
  `components/WidgetGrid.tsx`, `lib/widgets/layout.ts`, `lib/widgets/layout.test.ts`,
  `app/api/config/ui-layout/route.ts`. **Nada más.**

Leé `00-PLAN-REDISENO.md` completo, en especial **§4 (el contrato de widgets, congelado)** y **D-R04
y D-R05** (dónde se guarda el layout y por qué el botón es explícito).

---

## 1. Objetivo

Un componente `WidgetGrid` que:

- toma un **catálogo** (§4 del plan) y un **layout**, y renderiza los widgets en una grilla de 4
  columnas con los cuatro tamaños de D-R03;
- en **modo edición** deja **agregar** widgets de una lista, **sacarlos**, **reordenarlos
  arrastrando** y **cambiarles el tamaño**;
- guarda el layout en la VPS **con un botón** (D-R05), mostrando cuándo hay cambios sin guardar;
- **no se cae** con un layout viejo que referencia un widget que ya no existe.

**Este task no rediseña Resumen ni Ventas.** Se verifica con `lib/widgets/catalogo-demo.tsx`, que T01
creó justamente para eso (§8 del plan, la excepción de ownership). Si te encontrás editando
`app/(panel)/resumen/` o `ventas/`, estás en el archivo equivocado: esas pantallas son de T05 y T06.

## 2. `lib/widgets/layout.ts` — la lógica pura, separada del componente

Todo lo que se puede probar sin React va acá. Es lo que hace que este task tenga tests de verdad sin
`@testing-library` (que no existe en el proyecto y no se instala).

```ts
/** Valida y normaliza lo que vino de la base. NUNCA tira: la pantalla no puede
 *  quedar en blanco por un layout guardado mal. */
export function parseLayout(raw: unknown): WidgetLayout | null;

/**
 * Cruza el layout con el catálogo. Devuelve qué se puede renderizar y qué se
 * descartó, para que la UI lo pueda avisar (§4 regla 4 del plan).
 */
export function resolveLayout<T>(
  layout: WidgetLayout | null,
  catalogo: WidgetCatalogo<T>,
  porDefecto: WidgetPlacement[],
): { placements: WidgetPlacement[]; desconocidos: string[] };

/** Mueve un widget de `from` a `to`. Devuelve un array nuevo. */
export function reorder(placements: WidgetPlacement[], from: number, to: number): WidgetPlacement[];

/** Cambia el tamaño de un widget, RESPETANDO tamañosPermitidos del catálogo. */
export function resize<T>(
  placements: WidgetPlacement[], id: string, size: WidgetSize, catalogo: WidgetCatalogo<T>,
): WidgetPlacement[];

/** true si el layout difiere del guardado. Alimenta el "cambios sin guardar". */
export function hasChanges(actual: WidgetPlacement[], guardado: WidgetPlacement[] | null): boolean;
```

### Los tres estados de `parseLayout` y `resolveLayout` (D-R04)

Esto es lo que más fácil se implementa mal, y el síntoma es horrible: el usuario borra todos sus
widgets, guarda, recarga, y **le vuelven los widgets por defecto**.

| Lo que vino de la base | `parseLayout` devuelve | `resolveLayout` devuelve |
|---|---|---|
| fila con `null` (nunca guardó) | `null` | `porDefecto` |
| `{"v":1,"widgets":[]}` (guardó vacío) | `{v:1,widgets:[]}` | `[]` — **respeta el vacío** |
| `{"v":1,"widgets":[…]}` | el objeto | los placements resueltos |
| basura, o `v` desconocido | `null` | `porDefecto` |

**`layout === null` y `layout.widgets.length === 0` NO son lo mismo.** Si tu código hace
`if (!layout?.widgets?.length) return porDefecto`, colapsaste los dos casos y produjiste el bug de
arriba. Es la razón por la que `_verificacion-017.sql` §9 y §10 existen.

### Reglas de `resolveLayout`

1. **Un `id` que no está en el catálogo se descarta y se reporta en `desconocidos`.** No se tira, no
   se reemplaza por otro widget, no se deja un hueco (§4 regla 4 del plan).
2. **Si el `w`/`h` guardado no está en `tamañosPermitidos`, se cae al `tamañoPorDefecto`** del
   catálogo. Pasa cuando un widget pierde un tamaño que antes aceptaba. Nunca se renderiza un tamaño
   que el widget no soporta: el layout guardado no manda sobre el catálogo.
3. **El orden del array es el orden en pantalla.** No hay campo de posición: reordenar es mover
   elementos del array (§4 del plan).
4. **Un `id` repetido en el layout se queda con la primera aparición.** Dos widgets con la misma
   clave rompen el `key` de React y producen un bug de render que no dice eso.

### `parseLayout` valida con zod

`zod` ya está en el proyecto (`^3.23.8`). El esquema es el de `WidgetLayout`: `v` literal `1`,
`widgets` array de `{ id: string, w: 1|2, h: 1|2 }`.

**Poné un tope al array** (por ejemplo 100 entradas). El endpoint es autenticado, pero un layout con
50.000 widgets se guarda una vez y después la pantalla no abre nunca más: la validación es el único
lugar donde eso se puede frenar.

## 3. `app/api/config/ui-layout/route.ts`

Copiá el patrón de los routes que ya existen. `app/api/config/settings/route.ts` es el modelo exacto:

```ts
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { guard, json, parseJson, setSetting } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
```

- **`GET ?pantalla=resumen|ventas`** → `{ ok: true, layout: WidgetLayout | null }`.
- **`POST`** con `{ pantalla, layout }` → guarda y devuelve lo guardado.

Cinco cosas:

**1. `guard(req)` primero, antes de leer el body.** El patrón es literal:

```ts
const denied = await guard(req);
if (denied) return denied;
```

Sin la cookie `panel_token`, esto devuelve 401 y **no escribe nada** (§9.12 del plan). No lo reescribas
a mano ni lo pongas después del `parseJson`.

**2. `setSetting` ya sirve y NO hay que tocar `_lib.ts`.** Es genérico (`setSetting(key, value)`, upsert
con `ON CONFLICT (key) DO UPDATE`) y `_lib.ts` está en la lista de archivos que nadie toca (§8 del
plan).

Para **leer**, no uses `getSettingsRecord()`: tiene una whitelist cerrada de tres claves
(`fx_source`, `default_currency_view`, `retention_days_events`) y los layouts no están ahí. Hacé tu
propia query de una línea sobre `settings`. Tocar la whitelist significaría editar `_lib.ts`, que es
de nadie.

**3. `pantalla` se mapea a la clave, y el mapeo es cerrado.** `'resumen'` → `ui_layout_resumen`,
`'ventas'` → `ui_layout_ventas`. Un `z.enum(['resumen','ventas'])`, **no** una interpolación
`ui_layout_${pantalla}`: con interpolación, cualquier string se convierte en una clave nueva de
`settings` y el endpoint pasa a ser un escritor arbitrario de la tabla de configuración.

**4. Son dos filas y no una** (D-R04): guardar Resumen no puede pisar Ventas. La 017 ya creó las dos
en `null`.

**5. Los errores siguen la forma de los routes existentes:** `json(400, { ok: false, error:
'invalid_payload', detail: ... })` con `safeParse`. No inventes otro formato de error.

## 4. `components/WidgetGrid.tsx`

Un client component (`'use client'`). Es el único lugar del rediseño con estado de layout.

```tsx
export function WidgetGrid<T>(props: {
  pantalla: 'resumen' | 'ventas';
  catalogo: WidgetCatalogo<T>;
  data: T;                       // los datos YA cargados de la pantalla
  porDefecto: WidgetPlacement[];
  layoutGuardado: WidgetLayout | null;
}): JSX.Element;
```

**`data` entra una vez y baja a cada widget.** Ningún widget hace fetch (§4 regla 2 del plan): con 25
widgets pidiendo lo suyo serían 25 requests por cambio de rango.

### Modo normal y modo edición

**En modo normal no se ve ningún control de edición.** Ni asas, ni cruces, ni menús: sólo los widgets
y un botón para entrar a editar. Un panel que siempre muestra sus asas parece un editor a medio
terminar.

**En modo edición** aparece: el asa de arrastre y el menú de tamaño en cada widget, un botón para
sacarlo, la lista de widgets para agregar, y la barra de guardado.

### La barra de guardado (D-R05)

Cuatro cosas, y las cuatro se ven:

1. **"Guardar"**, deshabilitado si no hay cambios.
2. **"Cambios sin guardar"** cuando `hasChanges()` da true.
3. **"Descartar"**, que vuelve al layout guardado.
4. **El aviso de que el layout es global.** Con estas palabras o parecidas: *"este layout lo ven todos
   los que entran al panel"*. No es decoración: el panel se autentica con una contraseña compartida y
   no hay usuarios (D-R04 y P-R02 del plan). Si el usuario no lo sabe, va a creer que es suyo.

**Y al salir con cambios pendientes, se avisa.** Un `beforeunload` cubre cerrar la pestaña y recargar.
La navegación del router de Next **no dispara `beforeunload`**, así que si sólo ponés eso, hacer clic
en otra pestaña del Nav pierde los cambios en silencio. Cubrilo también en la navegación interna, o
—si te complica— dejá el `beforeunload` y **anotalo en §10 del plan**: es mejor una limitación
conocida que una que nadie escribió.

### El menú de tamaño

Ofrece **sólo** los `tamañosPermitidos` de ese widget (§4 regla 5 del plan): un gráfico no va en 1x1.
Etiquetas legibles, no `w:2,h:1`. Y el actual marcado.

Los cuatro tamaños son `w ∈ {1,2}` × `h ∈ {1,2}` (D-R03). No hay enum aparte: `w` y `h` lo dicen todo.

### La lista de widgets

Es lo que el usuario pidió por nombre ("agregá una lista de widgets"). Agrupada por `grupo` del
catálogo (`plata`, `volumen`, `eficiencia`, `calidad`, `graficos`, `listas`), con el `hint` de cada
uno visible o a un hover, y **los que ya están en pantalla marcados o deshabilitados**: agregar dos
veces el mismo widget produce un `id` repetido, que es el caso 4 del §2.

### El arrastre, con `@dnd-kit`

Ya está instalado (T01 lo declaró). `DndContext` + `SortableContext` con `verticalListSortingStrategy`
o `rectSortingStrategy`.

**`KeyboardSensor` es obligatorio, no opcional** (D-R16 del plan):

```tsx
const sensors = useSensors(
  useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
);
```

Tres detalles:

- **`activationConstraint`** con distancia: sin eso, un clic en un botón dentro del widget arranca un
  arrastre y el botón deja de funcionar.
- **El asa de arrastre es un elemento propio** con `aria-label`, no todo el widget. Si el widget
  entero es el asa, no se puede seleccionar texto ni clickear nada adentro.
- **Anunciá el resultado del movimiento.** `@dnd-kit` trae `announcements` para el lector de
  pantalla. Un reordenamiento silencioso es invisible para quien no ve la pantalla.

## 5. Los tests — `lib/widgets/layout.test.ts`

`vitest` ya está (`^2.1.8`). **Estos tests no necesitan base ni DOM**: son funciones puras, y por eso
la lógica está separada del componente.

No opcionales:

1. **Los tres estados de D-R04**, uno por caso: `null` → `porDefecto`; `{v:1,widgets:[]}` → `[]`;
   con widgets → esos widgets. **El del medio es el que importa**: es el bug de "borré todo y me
   volvieron los widgets".
2. **Un `id` desconocido se descarta, aparece en `desconocidos`, y los demás se renderizan.** Nunca
   una excepción (§4 regla 4).
3. **Basura no tira**: `parseLayout(undefined)`, `parseLayout('{}')`, `parseLayout({v:99})`,
   `parseLayout({v:1,widgets:'x'})`, `parseLayout({v:1,widgets:[{id:'a',w:3,h:1}]})` → todos `null` o
   descartando la entrada inválida, **ninguno lanza**.
4. **`resize` a un tamaño no permitido no lo aplica** (regla 2 del §2).
5. **Un `w`/`h` guardado que ya no está permitido cae al `tamañoPorDefecto`.**
6. **`reorder` conserva la cantidad y el contenido**, sólo cambia el orden. Probá mover el primero al
   final y el último al principio, y que un índice fuera de rango no destruya el array.
7. **`id` repetido se queda con el primero** (regla 4 del §2).
8. **`hasChanges`**: mismo layout → false; distinto orden con los mismos ids → **true** (el orden es
   parte del layout); `guardado === null` con placements → true.

## 6. Verificación

```bash
cd ~/Desktop/funnel/dashboard-admin

# 1 — compila y los tests suben
npx tsc --noEmit && npm run build && npm test
# esperado: 0 y 0, y el total de tests SUBE (los 8 grupos del §5).

# 2 — el endpoint EXIGE auth y no escribe sin ella (§9.12 del plan)
npm run dev
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3005/api/config/ui-layout \
  -H 'content-type: application/json' -d '{"pantalla":"resumen","layout":{"v":1,"widgets":[]}}'
# esperado: 401.
# OJO: el middleware del panel redirige (307) las páginas a /login, pero los
# route handlers devuelven 401. Si ves 307, mirá que estés pegándole a /api/.
docker exec panel-db-1 psql -U panel -d panel -tAc \
  "SELECT value IS NULL FROM settings WHERE key='ui_layout_resumen';"
# esperado: t — el 401 NO escribió nada.

# 3 — el payload inválido se rechaza con 400, no con 500
#     (con la cookie puesta; sacala de .env)
TOKEN=$(grep PANEL_PASSWORD .env | cut -d= -f2)
for BODY in '{"pantalla":"otra","layout":{"v":1,"widgets":[]}}' \
            '{"pantalla":"resumen","layout":{"v":99,"widgets":[]}}' \
            '{"pantalla":"resumen","layout":{"v":1,"widgets":[{"id":"x","w":3,"h":1}]}}'; do
  curl -s -o /dev/null -w "$BODY → %{http_code}\n" -X POST http://localhost:3005/api/config/ui-layout \
    -b "panel_token=$TOKEN" -H 'content-type: application/json' -d "$BODY"
done
# esperado: los tres 400. Un 500 significa que la validación no está antes del
# acceso a la base. Y el 'pantalla':'otra' es el que prueba el §3 punto 3: si
# da 200, estás interpolando la clave y podés escribir cualquier fila de settings.
docker exec panel-db-1 psql -U panel -d panel -c \
  "SELECT key FROM settings WHERE key LIKE 'ui_layout%';"
# esperado: EXACTAMENTE 2 filas (resumen y ventas). Si aparece ui_layout_otra,
# el mapeo no es cerrado.

# 4 — GUARDAR Y RECARGAR, con el catálogo demo.
#     Montá WidgetGrid con catalogo-demo en una página de prueba temporal (o
#     un route de dev), porque /resumen y /ventas son de T05 y T06.
#     a) entrá a modo edición, agregá los 3 widgets, movelos, cambiá tamaños
#     b) la barra dice "cambios sin guardar"
#     c) Guardar → recargá (F5) → EL LAYOUT ESTÁ IGUAL
#     d) cambiá el rango del filtro → el layout NO se resetea
#     e) Descartar después de mover → vuelve al guardado

# 5 — EL CASO QUE SE IMPLEMENTA MAL: guardar vacío (D-R04)
#     Sacá TODOS los widgets, Guardar, recargar.
#     esperado: la pantalla sigue VACÍA.
#     Si te vuelven los widgets por defecto, colapsaste null con [] (§2).
docker exec panel-db-1 psql -U panel -d panel -tAc \
  "SELECT value FROM settings WHERE key='ui_layout_resumen';"
# esperado: {"v": 1, "widgets": []} — no null.

# 6 — un widget que ya no existe no rompe la pantalla (§4 regla 4)
docker exec panel-db-1 psql -U panel -d panel -c \
  "UPDATE settings SET value='{\"v\":1,\"widgets\":[{\"id\":\"no_existe\",\"w\":1,\"h\":1},{\"id\":\"demo_kpi\",\"w\":1,\"h\":1}]}'::jsonb WHERE key='ui_layout_resumen';"
# recargá: esperado → se ve demo_kpi, NO se ve un hueco, y la barra avisa que
# 1 widget guardado ya no existe. La pantalla NO queda en blanco y no hay
# excepción en la consola.

# 7 — TECLADO (D-R16). No es opcional y es lo primero que se saltea.
#     Sin tocar el mouse: Tab hasta el asa de un widget, Espacio para tomarlo,
#     flechas para moverlo, Espacio para soltarlo.
#     esperado: el widget se movió, cada parada de Tab tiene foco VISIBLE, y
#     el orden nuevo se puede guardar.
#     Revisá también que ningún control sea un <div> con onClick: los botones
#     son <button> (§9.8 del plan).

# 8 — la verificación SQL del layout sigue en verde
docker exec -i panel-db-1 psql -U panel -d panel -v ON_ERROR_STOP=1 \
  < redesign-ui-tasks/_verificacion-017.sql
# los bloques §9 y §10 son los de los layouts. Leé la salida, no sólo el exit.

# 9 — dejá la base como estaba, si tocaste settings a mano
docker exec panel-db-1 psql -U panel -d panel -c \
  "UPDATE settings SET value=NULL WHERE key LIKE 'ui_layout%';"

# 10 — no se tocó nada fuera de la fila T03 de §8 del plan
find . -newermt '-3 hours' -type f \
  -not -path './node_modules/*' -not -path './.next/*' -not -path './.git/*' \
  -not -name '*.log' -not -name 'tsconfig.tsbuildinfo' | sort
# esperado: components/WidgetGrid.tsx, lib/widgets/layout.ts,
# lib/widgets/layout.test.ts, app/api/config/ui-layout/route.ts.
# Si dejaste una página de prueba para la verificación 4, BORRALA
# (§9.9 del plan: cero código muerto) y que no quede en el listado.
```

## 7. Cuándo parar

**Bloqueante, pará y avisá:**

- **Guardar vacío devuelve los widgets por defecto** (verificación 5). Es el bug que D-R04 previene
  y hay que arreglarlo antes de seguir: T05 y T06 heredan el problema.
- **El POST sin cookie escribe algo**, o un payload inválido da 500.
- **`'pantalla':'otra'` devuelve 200 o crea una fila en `settings`.** El endpoint se convirtió en un
  escritor arbitrario de la configuración del panel.
- **Un `id` desconocido tira una excepción** o deja la pantalla en blanco.
- **El arrastre no funciona con teclado** (D-R16).

**Anotalo en §10 del plan y seguí:**

- **`beforeunload` no cubre la navegación interna del router** y no encontraste una forma limpia.
  Anotá qué queda sin cubrir: perder cambios en silencio es peor que saber que puede pasar.
- Te falta un primitivo de `ui.tsx` (por ejemplo un menú desplegable). **No lo agregues a `ui.tsx`**:
  es de T01 y T05/T06 no van a saber que existe. Resolvelo dentro de `WidgetGrid.tsx` y anotalo.
- El contrato de §4 del plan te queda corto (por ejemplo, querés `minSize` o un widget que ocupe 4
  columnas). **No cambies `lib/widgets/tipos.ts`**: lo importan seis tasks. Anotalo.
- `@dnd-kit` se porta raro con la grilla de CSS (los tamaños 2x2 son los candidatos). Anotá qué viste:
  si hay que cambiar la estrategia de sorting, T05 y T06 lo tienen que saber.
