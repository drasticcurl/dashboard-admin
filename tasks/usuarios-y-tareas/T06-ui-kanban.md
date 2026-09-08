# T06 — La pantalla del kanban

- **Depende de:** T01 (el tipo `Sesion` y `listarUsuarios`, que usa tu `page.tsx`), T02 (los tipos de
  `lib/queries/tareas.ts`) y §6 del plan (el contrato de las routes, congelado). **No depende de que T05
  esté mergeada**: programás contra §6 y si terminás antes, tu refetch da 404 hasta que T05 entre. La
  primera pintura, que viene del server, funciona igual.
- **Bloquea:** nada.
- **Se puede correr en paralelo con:** T05 y T07.
- **Repo:** `dashboard-admin` (rama `main`).
- **Archivos que este task puede tocar:**
  - `app/(panel)/tareas/page.tsx` (nuevo)
  - `app/(panel)/tareas/TableroView.tsx` (nuevo)
  - `app/(panel)/tareas/Columna.tsx` (nuevo)
  - `app/(panel)/tareas/TarjetaTarea.tsx` (nuevo)
  - `app/(panel)/tareas/DetalleTarea.tsx` (nuevo)
  - `app/(panel)/tareas/prioridad.ts` (nuevo) · `prioridad.test.ts` (nuevo)
  - `app/(panel)/tareas/tablero.test.ts` (nuevo)
  Y **no** `components/Modal.tsx`: el modal se reusa donde está, ver §3.

  Nada más. **`app/(panel)/tareas/layout.tsx` es de T03** (es el guard, no la pantalla): no lo escribas.
  **`components/Nav.tsx` es de T03**: la pestaña la agrega él. **`components/ui.tsx` no lo toca nadie.**

---

## 1. Objetivo

Un tablero de cuatro columnas con drag & drop, prioridad por color, el switch de "las de una persona /
todas", y un modal de detalle con notas, links y comentarios.

---

## 2. Antes de escribir, leé estos tres

**`components/WidgetGrid.tsx` (630 líneas).** Es el único dnd-kit completo del repo y es tu molde para
la parte de arrastre. Lo que copiar, con línea:

- Los sensores (`:377`): `PointerSensor` con `activationConstraint: { distance: 8 }` y `KeyboardSensor`
  con `sortableKeyboardCoordinates`. **La restricción de distancia no es opcional**: sin ella, un click
  en un botón de la tarjeta se interpreta como el inicio de un arrastre.
- Los `announcements` (`:385`) y el `screenReaderInstructions` (`:578`), **en castellano**. Un tablero
  drag & drop sin anuncios es un tablero que no se puede usar con teclado ni con lector de pantalla.
- **El asa es un `<button>` propio con `aria-label`**, no la tarjeta entera. `WidgetGrid` usa
  `DotsSixVertical size={14} weight="bold"` con `touch-none cursor-grab active:cursor-grabbing`. Si el
  arrastre fuera toda la tarjeta, no se podría seleccionar el título ni clickear el link de adentro.

**`app/(panel)/finanzas/Modal.tsx` (171 líneas).** Es el **único** modal accesible del repo: Escape,
click en el fondo por `onMouseDown` con chequeo de `target`, foco que entra y **vuelve** al botón que lo
abrió, trampa de foco con Tab/Shift+Tab, scroll del fondo bloqueado, `role="dialog" aria-modal`. Su
docblock explica por qué **no** usa el `<dialog>` nativo (su `::backdrop` no acepta las utilidades de
Tailwind del panel) y por qué `DialogoConfirmacion.tsx` no sirve como contenedor.

**`app/(panel)/config/sections/ProductosSection.tsx`.** El molde de formulario: un objeto de estado por
form, `<label className="flex flex-col gap-1 text-xs text-neutral-500">` envolviendo el input,
`type="button"` en todo, `try/catch/finally` con `busy`. Y los estilos de `app/(panel)/config/kit.ts`
(`inputCls`, `btnPrimary`, `btnGhost`).

**Qué NO copiar de `WidgetGrid`:** su persistencia. Guarda un layout entero en `settings` con debounce.
Acá cada movimiento es un POST a `/api/tareas/mover` con la lista de la columna (D12).

---

## 3. El modal se REUSA donde está. No lo mudes.

Importá `Modal` desde `@/app/(panel)/finanzas/Modal`, con un comentario que diga por qué está ahí.

Sí, es un import feo: un componente compartido viviendo bajo `finanzas/`. Y sí, la mudanza a
`components/Modal.tsx` es lo correcto **a la larga**. No se hace en esta task por dos razones concretas:

1. **Mudarlo obliga a editar `app/(panel)/finanzas/FinanzasView.tsx` y sus secciones** para actualizar
   el import, y esos archivos **no son tuyos** (no figuran en la tabla de §8 del plan). Un agente
   editando archivos de una sección que no le toca es exactamente lo que la regla de ownership evita.
2. **`FinanzasView.tsx` está modificado sin commitear** en el árbol de trabajo (medido el 2026-09-08).
   Tocar los imports de un archivo con cambios ajenos encima no se puede revertir de forma limpia.

**No copies el archivo.** Dos modales con focus trap propio divergen en tres meses y uno de los dos
queda sin la corrección del otro — y este trae cinco decisiones que son cinco bugs que ya pasaron (el
`onMouseDown` en vez de `onClick` porque arrastrar para seleccionar texto y soltar afuera cerraba el
modal y perdía lo tipeado; el `?.` en el `focus()` de vuelta porque el botón que lo abrió pudo
desaparecer del DOM). Leé su docblock antes de usarlo.

**Anotá la deuda en §11 del plan**: mudarlo a `components/Modal.tsx` es un cambio de tres líneas de
import cuando `finanzas/` esté limpio y sin nadie trabajando ahí.

---

## 4. `prioridad.ts` — los colores, en funciones puras y testeadas

```ts
export const PRIORIDADES = ['alta', 'media', 'baja'] as const;
export function tonoDePrioridad(p: Prioridad): Tone;      // 'bad' | 'warn' | 'neutral'
export function etiquetaDePrioridad(p: Prioridad): string; // 'Alta' | 'Media' | 'Baja'
export function ordenDePrioridad(p: Prioridad): number;    // alta=0, media=1, baja=2
```

El mapeo pedido: **alta → rojo, media → naranja, baja → gris.**

```
alta  → bad     (#ec5a63)  urgente / crítico
media → warn    (#e8a33d)  naranja
baja  → neutral (neutral-700 / panelColors.muted)
```

**`neutral` y no `good` para la baja, aunque se ofreció "verde o gris".** En este panel `good` es **el**
color de acento: es el underline de la pestaña activa, el botón primario y el `shadow-glow-good`. Una
tarjeta de prioridad baja pintada de verde compite visualmente con los controles del panel y se lee como
"esta está bien" cuando lo que dice es "esta puede esperar". El gris es el ausente de severidad, que es
exactamente lo que significa. `panelColors.muted` está documentado como *"el relleno sin severidad"* en
`tailwind.config.ts`.

**Cero literales de color.** Sólo tokens, y `Tone` importado de `components/ui.tsx` (que se lee, no se
toca). Hay un test que vigila los literales.

**Y el color no puede ser la única señal.** Una franja de color a la izquierda de la tarjeta **más** la
etiqueta en texto: quien no distingue rojo de naranja tiene que poder leer "Alta". Es el mismo criterio
que las tres señales de la pestaña activa del nav.

`prioridad.test.ts`: las tres prioridades dan tres tonos distintos, `ordenDePrioridad` ordena
alta→media→baja, y **ningún valor devuelto es un literal de color** (que empiece con `#` o con `rgb`).

---

## 5. La pantalla

`page.tsx` es un server component, con el patrón de las diez pantallas que ya existen —
`app/(panel)/anuncios/reglas/page.tsx` es el ejemplo más limpio (23 líneas):

```tsx
export const dynamic = 'force-dynamic';

export default async function TareasPage({ searchParams }) {
  const [tareas, usuarios] = await Promise.all([listarTareas({...}), listarUsuarios()]);
  return <TableroView initial={{ tareas, usuarios }} yo={...} />;
}
```

- **El fetch inicial en el server**, para que la primera pintura ya tenga las tarjetas.
- **`yo`** (id, nombre, esAdmin) baja como prop desde el server. El cliente **no** decide permisos: los
  usa para no ofrecer botones que van a dar 403, que es distinto.
- El filtro del switch viaja en `?asignado=`, como `?s=` en Config: sobrevive al refresh y se puede
  compartir por link. **Default `todas`.**

### El switch de "de quién"

Un `<select>` con el `SELECT_HEADER` que exporta `components/Nav.tsx` — es el mismo control que el de
funnel y el de rango, y cuando divergen el header se ve desalineado. Opciones: **Todas** primero, después
cada usuario activo, con el propio marcado (`Nahuel (yo)`).

**El switch es igual para todos**, admin o no: los dos ven todas las tarjetas. Lo que cambia es qué
pueden editar, y eso es de T05.

### El tablero

- Cuatro `Columna`, cada una un `useDroppable`. **`closestCorners` como `collisionDetection`, no
  `closestCenter`.** `closestCenter` es lo que usa `WidgetGrid` porque ahí todos los items son del mismo
  tamaño en una grilla; en un kanban las columnas tienen distinta altura y `closestCenter` hace que
  soltar cerca del borde inferior de una columna corta caiga en la de al lado. `closestCorners` es la
  recomendada para listas de varios contenedores.
- **Una columna vacía tiene que ser un destino válido.** Es el bug clásico del kanban con dnd-kit: si la
  zona droppable es sólo la lista de items, una columna sin tarjetas no tiene superficie y no se puede
  soltar nada en ella. La zona tiene que ser el contenedor con una **altura mínima**, y con un texto de
  vacío que no intercepte el puntero.
- **`DragOverlay`** para lo que se arrastra. Sin él, dnd-kit mueve el nodo original y la tarjeta se
  deforma dentro de una columna más angosta.
- **Al soltar, actualizá el estado local primero y después mandá el POST** (optimista). Si el POST falla,
  **volvé al estado anterior y mostrá el error**. Una tarjeta que se queda donde la soltaste y en la base
  está en otro lado es el peor resultado posible: el siguiente refresh la mueve sola y parece un fantasma.
- El POST manda `{ id, columna, orden }` con **la lista completa de ids de la columna destino en su orden
  final**, incluido el `id` que se movió (§6 del plan, D12).

### 🔴 La trampa del `reveal`

`app/(panel)/layout.tsx:120-133` lo dice y va a morder acá:

> los hijos de esa grilla son los widgets arrastrables y llevan un `transform` inline de dnd-kit que una
> animación CSS pisaría, porque en la cascada las animaciones ganan a los estilos inline.

**Nada de `reveal`, `animate-rise-in` ni ninguna animación de `transform` en las tarjetas ni en las
columnas.** La clase `reveal` ya la pone el `<main>` del layout a nivel de página. Transiciones de
`background-color` y de `box-shadow` sí: no tocan el transform.

### La tarjeta

Título, franja de prioridad, etiqueta de prioridad, avatar/inicial del asignado, y **contadores** de
comentarios y links si hay (un número al lado de un icono de Phosphor, `weight="bold"`). `vence_el` como
fecha corta, y en `bad` si ya pasó — un vencimiento que no se distingue de una fecha cualquiera no sirve
de nada.

Click en la tarjeta (que no sea el asa) abre el `DetalleTarea` en el `Modal`.

### El detalle

Título y notas editables, selects de asignado / prioridad / columna, `vence_el`, la lista de links con
un "agregar" y una cruz por link, y los comentarios con el nombre y la fecha de cada uno más un campo
para escribir.

- **Si `!puedeEditar`, los campos van `disabled` y hay una línea que dice por qué** ("esta tarea está
  asignada a Lucho"). Deshabilitados y visibles, no escondidos: escondidos parece que la tarjeta está
  rota. `puedeEditar = yo.esAdmin || tarea.asignadoA === yo.id`.
- **El campo de comentario queda habilitado siempre**, incluso sin permiso de edición: comentar puede
  cualquiera (T05 §4).
- **`notas` vacía se manda como `null`, no como `''`.** El PATCH de T05 distingue "borrar" de "no tocar"
  con `null` vs ausente.
- Borrar la tarjeta: confirmación con el número de comentarios que se van (lo devuelve el DELETE de T05).

---

## 6. Tests

`tablero.test.ts` — funciones puras extraídas del View, **sin jsdom** (no hay testing-library en el
repo y `vitest.config.ts` usa `environment: 'node'`):

1. `agruparPorColumna` reparte en las 4 y devuelve las 4 claves aunque alguna esté vacía.
2. Dentro de cada columna, el orden es `posicion` y **desempata por `id`**.
3. `nuevoOrdenAlSoltar(ids, desde, hasta)` produce la lista final correcta: al principio, al final, al
   medio, y **de una columna a otra**.
4. Soltar una tarjeta **en el mismo lugar** devuelve la lista sin cambios (no dispara un POST inútil).
5. Soltar en una columna **vacía** devuelve `[id]`.
6. `puedeEditar` da `true` para el admin sobre cualquiera, `true` para el dueño, `false` para el resto.
7. Una tarjeta con `venceEl` de ayer se marca vencida; con la de hoy, **no**. El límite es "hoy no está
   vencido" y hay que fijarlo o alguien lo cambia sin darse cuenta.
8. El contador de links y comentarios es 0 (no `undefined`) con las listas vacías.

Y una propiedad con `fast-check` (ya está instalado, `4.9.0`), que es donde de verdad se rompe esto:

9. **Para cualquier lista de ids y cualquier par (desde, hasta) válido, `nuevoOrdenAlSoltar` devuelve una
   permutación de la entrada**: mismo largo, mismos elementos, sin duplicados y sin perder ninguno.
   Perder un id ahí significa **una tarjeta que desaparece del tablero** y aparece de vuelta en el
   siguiente refresh en un lugar impredecible. Es el bug más caro de este task y el más fácil de no ver
   con tres tests a mano.

---

## 7. Verificación

```bash
# 1. Tests y build
npm test -- app/\(panel\)/tareas
# esperado: verde, incluida la propiedad de fast-check con 100 iteraciones
npm run build
# esperado: "Compiled successfully" y exit 0

# 2. El tablero, a ojo (npm run dev, con el seed y los permisos de T04 puestos)
#    http://127.0.0.1:3005/tareas
#      · las 4 columnas: Por hacer · En progreso · En revisión · Hecho
#      · el switch en "Todas"
#      · una tarjeta de prioridad alta con la franja roja Y la palabra "Alta"

# 3. Arrastrar — los cuatro casos que rompen
#    a) mover entre dos columnas con tarjetas    → queda donde la soltaste
#    b) mover A UNA COLUMNA VACÍA                → entra. Si no se puede soltar,
#       la zona droppable es la lista y no el contenedor (§5).
#    c) mover al final de una columna larga      → queda última, no penúltima
#    d) refrescar la página (F5) después de cada movimiento
#       esperado: el orden es EXACTAMENTE el que dejaste. Si cambia, el POST manda
#                 una lista incompleta o el optimista no coincide con el server.
psql "$DATABASE_URL" -tAc "SELECT columna, posicion, titulo FROM tareas WHERE archivada_at IS NULL ORDER BY columna, posicion"
# esperado: dentro de cada columna, posicion en 10, 20, 30… sin repetidos

# 4. Con teclado, sin tocar el mouse
#    Tab hasta el asa de una tarjeta → Espacio → flechas → Espacio
# esperado: se mueve, y el lector de pantalla anuncia en castellano.
#           Si el asa no es alcanzable con Tab, no es un <button>.

# 5. El rollback del optimista
#    Devtools → Network → Offline, y arrastrá una tarjeta
# esperado: vuelve sola a su lugar y aparece un aviso de error.
#           Si se queda donde la soltaste, el estado local y la base divergieron.

# 6. Los permisos, desde la UI (logueado como nahuel)
#    abrir una tarjeta de lucho
# esperado: los campos deshabilitados, la línea que dice de quién es, y el campo de
#           comentario HABILITADO
#    abrir una propia → todo editable

# 7. La trampa del reveal
grep -rn "reveal\|animate-rise-in" app/\(panel\)/tareas/
# esperado: NADA. Si hay algo, el drag va a parpadear o a no moverse.

# 8. Cero literales de color
grep -rnE "#[0-9a-fA-F]{3,6}|rgb\(" app/\(panel\)/tareas/
# esperado: NADA

# 9. Que no tocaste lo ajeno
git diff --stat -- components/ 'app/(panel)/finanzas/' 'app/(panel)/tareas/layout.tsx' lib/ app/api/
# esperado: VACÍO. En particular finanzas/: si aparece, mudaste el Modal (ver §3).
```

---

## 8. Cuándo parar

Terminaste cuando los 9 pasos pasan. El 3d y el 5 son los que no se pueden saltear: los dos son la
misma pregunta — **¿lo que veo en pantalla es lo que hay en la base?** — y las dos formas de que la
respuesta sea "no" se ven perfectas hasta el siguiente refresh.

**Pará y avisá** si:

- Una columna vacía no acepta que le suelten nada y no lográs que la zona droppable sea el contenedor.
  Es el problema conocido de dnd-kit con varios contenedores y es bloqueante: sin eso el tablero no
  funciona para el caso más común (la primera tarjeta de una columna).
- La propiedad 9 de `fast-check` encuentra un contraejemplo que no sabés arreglar. **Pegá el
  contraejemplo y el seed**: perder una tarjeta al reordenar es peor que no tener drag & drop.
- Necesitás cambiar algo de §6 del plan (los routes). Está congelado y T05 lo está implementando ahora.
- La mudanza de `Modal.tsx` te pisa con otro agente. La salida sin conflicto está en §3.

**Anotá y seguí** si:

- Te parece que el tablero necesita filtro por prioridad o por vencimiento, o una vista de lista.
- Te parece que hace falta paginar la columna "Hecho" (el cron de T07 la va a mantener corta: archiva a
  los 2 días).
- Descubrís que `SELECT_HEADER` de `Nav.tsx` no alcanza para tu select. **No lo edites**: `Nav.tsx` es de
  T03. Copiá las clases con un comentario que diga de dónde salieron y anotalo.
