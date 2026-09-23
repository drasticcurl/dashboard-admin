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

---

## 2026-09-23 10:00 – 11:30 · Rediseño v3, segunda pasada (bug del modal + igualar las capturas)

Rama: `rediseno-panel-v3`. Tres commits: `0f80cbe`, `fd986c5`, `ad5f708`.

Disparador: el usuario reportó que el modal de saldos «se ve la mitad del cuadrado
y no se puede bajar ni subir», que lo mismo pasa al editar un anuncio, y que en
mobile «no tiene una interfaz real, es la misma que la web». Además pasó cuatro
capturas del prototipo y pidió no parar hasta que el panel se parezca.

### Lo que hizo la diferencia: medir en vez de deducir del CSS

La primera pasada se verificó con `npm run build` y grep del CSS emitido. Eso
alcanza para saber que una clase existe, y NO alcanza para saber qué se ve. Esta
vez se levantó un panel local de verdad:

- Base `panel_rediseno_local` en el Postgres de Homebrew (127.0.0.1:5432), 34
  migraciones. **La 021 aborta en una base vacía** («no existe ninguna
  Cuenta_Activa»): hay que insertar una `ad_accounts` placeholder, migrar el
  resto, y recién después seguir. Está documentado en
  `.kiro/steering/instancias.md` y se confirmó tal cual.
- Usuario `lucho` / `123456`, con `debe_cambiar_clave=false` a mano (si no,
  redirige a /cambiar-clave y no se puede ver el panel).
- Datos sembrados: cuentas y 340 saldos con un hueco de 3 días, 4 campañas con
  nombres largos de Meta, jerarquía completa, 45 filas de `ad_spend`, 6 tareas y
  14.000 sesiones con un histograma de `max_step_index` que le da forma al embudo.
- Playwright (`playwright-core` instalado en `/tmp`, NO en el proyecto, más el
  chromium ya cacheado en `~/Library/Caches/ms-playwright`).

**Decisión que conviene repetir:** las lecturas de captura se cortan por tamaño,
así que lo que sirvió fue MEDIR con `page.evaluate` y comparar números. Tres
scripts, en `/tmp/capsenv/`:
- `caps.js` — capturas + desborde horizontal por pantalla y ancho.
- `medir.js` — densidad (a qué altura arranca la primera fila), ancho de la
  columna del nombre, proporciones del modal, si el popover entra.
- `culpable.js` — sube el árbol buscando ancestros con transform/filter/
  backdrop-filter/will-change/contain. **Éste es el que encontró el bug.**

### La causa raíz del modal (lo importante de esta entrada)

`.reveal > *` animaba con `animation: rise-in ... both`. El `fill-mode: both` deja
el último keyframe aplicado para siempre; ese keyframe dice `transform: none`, y
el valor **computado** de eso es `matrix(1, 0, 0, 1, 0, 0)`. Una matriz identidad
crea containing block igual que cualquier otro transform.

El comentario de `tailwind.config.ts` afirmaba lo contrario, con todas las letras.
O sea: había una mitigación documentada, con su razonamiento escrito, que no
hacía nada. Es el tipo de error que no se encuentra leyendo el código —el
comentario te convence— y sí se encuentra midiendo.

Medido: overlay `top: 195, height: 1965` con viewport 844. Después del fix:
`top: 0, height: 844`.

Arreglado por dos lados: `both` → `backwards`, y `components/Portal.tsx` para los
overlays. Los dos, porque el primero arregla el síntoma y el segundo es lo que
evita que vuelva con cualquier `filter` futuro en una tarjeta.

### Decisiones propias de esta pasada

1. **El Shell monta el encabezado de página** (título + subtítulo + filtros) para
   las nueve pantallas, derivando el título de `TABS` y el subtítulo de un mapa
   `PANTALLAS`. La alternativa era pasar `funnels` a nueve server components.
   Costo: si una pantalla nueva no está en el mapa, no muestra subtítulo ni
   filtros (falla en silencio hacia el lado seguro).
2. **Las columnas por defecto de Anuncios se deciden en la pantalla**
   (`COLUMNAS_V3` en `GestorAnuncios`), no en `lib/ads/catalogo.ts`. El `base` del
   catálogo tiene tests y vistas guardadas de usuarios detrás; el set de arranque
   es una decisión de presentación.
3. **La casilla de selección se queda en desktop y se va en mobile.** La
   referencia no la muestra, pero habilita las acciones en lote, que tienen su
   propia cadena de tests. Sacarla del todo sería borrar una función para que
   coincida una captura.
4. **«Total de por vida» sigue deshabilitado** (D-A10) y la marca de frescura pasó
   a un punto de 6px: el badge con texto medía ~110px dentro de la celda del
   nombre y lo recortaba a «CH-ES-ABO-VI…» en todas las filas a la vez.
5. **Se quitó el segundo segmentado del embudo** («% sobre el total / % sobre la
   anterior») que la pasada anterior había agregado: la vista ya trae el suyo y la
   referencia tiene uno solo. Dos segmentados apilados hablando de "la base del
   porcentaje" se leen como el mismo control duplicado.
6. **`clamp()` para el patrimonio** en vez de `overflow-wrap`. Un número cortado
   al medio («EUR 132.472,5» / «7») es peor que uno más chico.

### Verificado

- `npm run build` OK y `tsc` sin errores nuevos después de cada commit.
- 372 tests en verde (287 de anuncios, 38 de finanzas/serie, 37 de widgets/layout,
  embudo, paleta, ui.tokens).
- Desborde horizontal 0 en las 14 combinaciones pantalla × ancho (antes:
  /anuncios 879px a 390 y 268 a 1440; /finanzas 117).
- Modal `entra: true` en 390 y 1440, cuerpo 78 % del alto y scrollea.
- Popover `entra: true` en los dos anchos, z-index 45 en desktop y 50 en la hoja.
- Densidad de Anuncios: primera fila en y=592 y 65px de alto (antes ~1500 y 140).
- Cero ancestros creando containing block.

### Sin verificar

- Nada en un dispositivo táctil real. Quedan el arrastre de la hoja de mobile, el
  `env(safe-area-inset-bottom)` y el drag & drop del kanban con `scroll-snap`.
- El embudo se verificó con datos sembrados, no con el histograma real de
  producción.
