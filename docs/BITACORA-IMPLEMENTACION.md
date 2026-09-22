# Bitácora de implementación

Qué se implementó, en qué estado quedó, y **qué decisiones se tomaron por cuenta
propia** cuando el pedido no las especificaba. El "por qué" de cada decisión es
lo que más importa acá: es lo que evita que la próxima sesión (o la próxima
persona) tenga que deducirlo leyendo el código.

Orden cronológico, lo más nuevo AL FINAL. Las entradas viejas no se editan: si
algo se corrige, se agrega una entrada nueva que lo aclare.

---

## 2026-09-23 00:06 – 00:45 · Rediseño v3 del panel (`design_handoff_panel_rediseno`)

Rama: `rediseno-panel-v3`. Un commit por punto del pedido, seis en total, en el
orden en que se listan abajo.

Fuente: `~/Downloads/design_handoff_panel_rediseno/README.md`. El prototipo
`Panel v3.dc.html` se usó como referencia y **no** se copió: todo se recreó con
los componentes, los datos y las server actions que ya tenía el proyecto.

### Estado por punto

| # | Punto | Estado | Commit |
|---|---|---|---|
| 4 | Tokens de la paleta | hecha | `0569cad` |
| 1 | Popover anclado a la fila en Anuncios | hecha | `dcfebf5` |
| 2 | Modal «Corregir saldos» de Finanzas | hecha | `b481846` |
| 3 | Responsive < 760px | hecha | `9456405` |
| 5 | Pantallas nuevas | hecha (ver nota) | `c0edfd8` |
| 6 | Ajustes de Resumen y Ventas | hecha | `0e5e957` |

Los tokens se hicieron primero aunque el pedido los listaba cuartos: los otros
cinco puntos usan `good-900`, el breakpoint `panel` y la clase `.num`, así que
sin ellos los cinco commits siguientes habrían improvisado literales.

### Lo que ya existía y NO se rehízo

Esto es la mitad del trabajo y conviene que quede escrito, porque leer el
handoff sin mirar el repo sugiere que había cinco pantallas por construir:

- **Embudo literal.** Ya era un embudo de trapecios en SVG, horizontal, con el %
  adentro y nombre/conteo/caída debajo. Faltaban sólo el selector de base y la
  vista de mobile.
- **Reglas en Anuncios.** `app/(panel)/anuncios/reglas/ReglasView.tsx` ya existe
  (2.659 líneas). **No se tocó nada**, por pedido explícito: ese módulo pausa y
  reactiva campañas de Meta con plata real.
- **Kanban de Tareas.** Ya existía con dnd-kit, columnas, prioridad, responsable
  y sheet de edición. Cambió el layout (grilla → fila con scroll-snap).
- **Config agrupada.** Ya estaba en Funnels / Dinero / Fuentes / Sistema, con
  exactamente las mismas secciones que pide el handoff (T07 §3). Sólo cambiaron
  el chip activo y la escala de la etiqueta de grupo.
- **Gráfico de patrimonio con huecos.** `GraficoSaldo` ya modelaba el día sin
  datos como `null` y nunca como `0`.

### Decisiones propias (no estaban en el handoff)

1. **El popover NO manda el POST.** Guardar un presupuesto o un nombre llama al
   mismo `onEditarPresupuesto` / `onRenombrarFila` de antes, que abre el
   `DialogoConfirmacion` con la `Previsualizacion`. Motivo: toda la validación de
   montos (el techo de `maxPresupuesto`, `presupuesto.preservacion.test.ts`,
   `acciones.margen.test.ts`) vive en esa cadena. Un popover que escribiera por
   su cuenta se saltearía las cuatro validaciones y el primer aviso sería el
   importe ya aplicado en Meta. **Si alguien "simplifica" esto conectando el
   popover directo al endpoint, rompe la única red que hay sobre la plata.**

2. **«Total de por vida» va deshabilitado con el motivo en el `title`.** El
   handoff pide el segmentado Diario/Total, pero el módulo no escribe
   presupuestos `lifetime` en ningún nivel (D-A10). Se dibujan los dos y se
   bloquea el segundo, en lugar de mostrar sólo «Diario»: un segmentado de una
   opción no comunica nada, y con los dos visibles queda claro que el panel sabe
   que existe el otro modo y que deliberadamente no lo toca.

3. **La columna «⋯» va en el `<colgroup>` y no en `lib/ads/catalogo.ts`.** El
   catálogo define las columnas que se pueden ocultar, reordenar y redimensionar.
   Si «⋯» estuviera ahí sería ocultable, y quien la oculta pierde el acceso a
   duplicar y renombrar sin ninguna forma de darse cuenta.

4. **El marco del popover es un div nuevo por fuera del scroller horizontal.**
   `overflow-x:auto` con el otro eje en `visible` hace que el navegador compute
   `overflow-y:auto`, así que un popover absoluto adentro del scroller queda
   recortado. Los dos no pueden ser el mismo elemento.

5. **`CargaDiaria` monta su propio `<Modal>`** en vez de recibirlo como
   envoltorio desde `FinanzasView`. El pie fijo necesita el `total` y el
   `guardar()` del formulario, y pasarlos para arriba obligaba a duplicar el
   estado del formulario en la vista.

6. **El breakpoint se llama `panel` y vale 760px**, agregado en `extend.screens`
   para no perder sm/md/lg/xl (los usan ~300 clases que ya existen). No se usó
   `md` (768): el handoff define el shell contra 760, y con dos números distintos
   quedan 8px de viewport con el header mobile y el sidebar montados a la vez.

7. **Los neutrales NO se cambiaron a los valores del handoff.** El handoff lista
   una escala `neutral-200…900`; la del proyecto es un grafito frío del mismo
   hue que el canvas, con el motivo documentado en `tailwind.config.ts`
   (decisión 2: mezclar un gris puro con un canvas azulado es lo que hacía ver la
   UI "sucia"). Cambiarla habría repintado ~500 usos de `text-neutral-*` para
   volver atrás una decisión tomada a propósito. El resto de la paleta del
   handoff ya coincidía con la del proyecto (`bg`, `surface`, `accent`).

8. **El título de la sección NO se duplicó en el header de mobile.** El handoff
   pide "header sticky con hamburguesa + título de la sección", pero las nueve
   pantallas ya renderizan su propio `<h1>` justo debajo. Se dejó el `<h1>` como
   único título (subido a la escala del handoff, 22px en mobile / 26 en desktop) y
   el header sticky lleva sólo la hamburguesa y los filtros. Poner los dos se veía
   como un bug.

9. **La `Grid` pasó a `auto-fill` en lugar de breakpoints.** Es lo que pide el
   handoff para Resumen, y arrastra a Ventas porque comparten el primitivo. Los
   spans de ancho doble pasaron de `md:`/`xl:` a `panel:` para que coincidan con
   el punto donde la grilla deja de tener una sola columna.

10. **El hito del embudo en mobile se distingue con `brightness` y no con el
    borde punteado** que usa la vista de desktop: el trapecio de mobile se
    dibuja con `clip-path`, que recorta el borde y lo haría desaparecer.

### Qué quedó verificado

- `npm run build` → `✓ Compiled successfully`, después de cada punto.
- `npx tsc --noEmit` → sin errores nuevos.
- 287 tests de `app/(panel)/anuncios`, 38 de `finanzas/serie`, 37 de
  `widgets/layout`, 30 de tareas + embudo, y `paleta` + `ui.tokens`.
- 6 tests nuevos en `app/(panel)/anuncios/popoverFila.test.ts` para la aritmética
  de posición del popover (se abre arriba si abajo no entra; `left` acotado a los
  dos cantos del marco, que es el caso de la columna «⋯» pegada a la derecha).
- **Contra el CSS emitido**, que las clases nuevas existen y no son clases
  muertas: `min-width:760px`, `.tap` bajo `@media (max-width:759px)`,
  `max-panel:h-11`, `bg-good-900`, `width:220px`, `max-width:1320px`,
  `w-[min(84%,300px)]`, `-webkit-line-clamp:2`, `panel:col-span-2` y los
  `font-size` de 22/28/56px. Esta verificación no es paranoia: el repo ya se comió
  58 clases que no emitían CSS (la escala de `opacity`, documentado en
  `tailwind.config.ts`) sin que la build avisara.

### Qué NO quedó verificado

- **Nada se probó en un dispositivo táctil real**, sólo con el emulador de ancho
  del navegador. Queda por mirar en pantalla: el arrastre de la hoja de mobile
  del popover, y el `env(safe-area-inset-bottom)` del pie del modal y del drawer
  (el emulador no lo simula).
- **El drag & drop del kanban dentro del contenedor con `scroll-snap`.** dnd-kit
  y `scroll-snap-type` conviven mal en algunos navegadores; el agrupado por
  columna tiene tests (20 en `tablero.test.ts`, en verde) pero el gesto no.
- Los 46 archivos de test en rojo del repo son de integración y piden Postgres en
  `127.0.0.1:5433`, que no está levantado en esta máquina. No los toca este
  trabajo.

### Bloqueador encontrado (preexistente, ajeno a este rediseño)

`lib/orders/attribution.test.ts` falla en el working tree: el test «sin sid/vid,
cae a sessionId/visitorId (convención del funnel Alma Gemela)» espera
`'11111111-2222-4333-8444-555555555555'` y recibe `null`. Viene de un cambio
**sin commitear** en `lib/orders/attribution.ts` que ya estaba en el árbol antes
de empezar (el fallback de `sid`/`vid` para Alma Gemela). Se verificó que en
`main` limpio ese archivo pasa 13/13, así que no es de este trabajo y no se tocó
—el pedido era sólo visual—. **Queda pendiente para quien retome ese cambio.**

### Datos de backend que el handoff pedía y NO hizo falta crear

El pedido original preguntaba si había que proponer esquema para reglas, estado
del kanban y serie de patrimonio. No: los tres ya existen.

- Reglas → `db/migrations/016_ads_gestion.sql` + `021_reglas_por_cuenta.sql`.
- Estado del kanban → `db/migrations/031_tareas.sql` (columna, prioridad,
  responsable, fecha).
- Serie de patrimonio → `db/migrations/028_saldo_cuentas.sql`, leída por
  `lib/queries/saldo.ts` y `finanzas/serie.ts`.
- El selector de base del embudo tampoco necesitó nada: `pctOfBase` y
  `pctOfPrevious` ya venían los dos en `EmbudoEtapa`.

**Ninguna tabla nueva, ninguna migración nueva.** El rediseño es 100% de
presentación.
