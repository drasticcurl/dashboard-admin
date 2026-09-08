# Prompts para Claude Code — usuarios con permisos + tablero de tareas

## Antes de arrancar

```
tasks/usuarios-y-tareas/
├── 00-PLAN-USUARIOS-Y-TAREAS.md   el documento maestro — leerlo primero, siempre
├── PROMPT-CLAUDE-CODE.md          este archivo
├── _schema-030.sql                DDL de usuarios — YA EJECUTADO, se copia tal cual
├── _schema-031.sql                DDL de tareas — YA EJECUTADO, se copia tal cual
├── _verificacion-030-031.sql      28 afirmaciones sobre el esquema — YA EN VERDE
├── _verificacion-sesion.mjs       16 afirmaciones sobre el token, el hash y el ROI — YA EN VERDE
├── _verificacion-e2e.sh           9 pasos del módulo entero, con base efímera
├── _cookie.mjs                    fabrica una cookie de sesión válida sin pasar por el login
├── T01-fundacion-identidad.md     migraciones + auth + permisos + queries — BLOQUEA A LAS SEIS
├── T02-capa-de-datos-tareas.md    lib/queries/tareas.ts — BLOQUEA A T05 Y T06
├── T03-guards.md                  layouts + guard() + las 7 routes inline + Nav
├── T04-login-y-usuarios.md        login, cambio de clave y la pantalla de Usuarios
├── T05-api-tareas.md              app/api/tareas/**
├── T06-ui-kanban.md               app/(panel)/tareas/**
└── T07-roi-cron-deploy.md         ROI en Resumen + cron + deploy + registro.md
```

**Qué se construye:** el panel se autentica hoy con **una contraseña compartida** y la cookie no lleva
identidad. Este módulo le da usuarios con clave propia, un admin que decide qué pestañas ve cada uno con
un switch, y un tablero kanban de tareas asignadas por persona. Está **en producción en dos dominios**
(`panel.hilvanapp.com` y `panel.infinixapp.com`, mismo `origin/main`), pero los agentes trabajan contra
su base LOCAL.

### Lo que ya está verificado, y por qué eso ahorra trabajo

Todo lo de abajo se corrió de verdad el **2026-09-08**: el DDL contra un Postgres 16.14 efímero con las
**29 migraciones reales aplicadas**, y la criptografía con Node v24.14.0. Ningún agente tiene que
redescubrir nada.

- **El DDL de las dos migraciones ya corrió, es idempotente, y sus 28 afirmaciones están en verde.** T01
  copia `_schema-030.sql` y `_schema-031.sql` tal cual. No los retipea.
- **`node:crypto` y `crypto.subtle` firman el MISMO hex.** Es lo que hace posible todo el diseño: el
  middleware corre en Edge, no puede importar `lib/auth.ts` ni consultar Postgres, y así puede verificar
  la identidad igual. Afirmación 7.
- **scrypt de `node:crypto` alcanza**: 30 ms en régimen, 99 ms la primera del proceso. Sin instalar nada
  (`bcrypt` y `argon2` son nativos y `deploy/deploy.sh:210` corre `npm ci` sin `--omit=dev`).
- **Un hash con parámetros viejos sigue verificando** después de que el código suba el costo, porque N, r
  y p se leen de la fila. Afirmación 5.
- **El token viejo de 2 campos se rechaza**, no se malinterpreta. Afirmación 9. Consecuencia: en el
  deploy se cortan todas las sesiones vivas y todos vuelven a entrar. Es esperado.
- **Tres endpoints viven bajo un prefijo que NO es su sección** y un mapa por prefijo se los comería:
  `/api/config/ui-layout` es de Resumen y Ventas, `/api/config/vistas-ads` es de Anuncios, y
  `/api/ia/insight` es de Resumen y Finanzas. Verificado leyendo quién llama a cada uno.
- **`@dnd-kit/core 6.3.1` ya exporta `useDroppable`, `DragOverlay` y `closestCorners`**: el kanban de
  varias columnas se hace sin instalar nada.

### 7 cosas que hay que saber antes de largar el primer agente

**1. T01 es una compuerta de verdad.** Cambia el formato de la cookie en dos archivos con dos primitivas
de criptografía distintas. Si su verificación no pasa, **el panel no deja entrar a nadie** y las seis
tasks siguientes se escriben contra un cimiento roto. Y si la **afirmación 7** falla en el ambiente del
agente (los dos runtimes firmando distinto), **hay que parar el proyecto**, no parchear: el diseño entero
apoya en eso.

**2. Commiteá lo que tenés sin commitear ANTES de largar T01.** El árbol tiene el módulo de insights de
IA completo sin commit, el puente de Hotmart, `tasks/pitch-ab/` entera, y — lo que importa —
**`package.json`, `.env.example`, `lib/queries/overview.ts` y `lib/widgets/catalogo-resumen.tsx`
modificados**. Los cuatro son archivos que T01 y T07 tienen que editar. Si un agente trabaja sobre
cambios ajenos y algo sale mal, no hay forma limpia de revertir sólo lo suyo. Está en §8 del plan.

**3. La clave inicial es `123456` para todos y eso es un agujero real, aceptado a pedido.** Mientras
nadie la cambie, cualquiera que sepa el nombre de usuario entra. La mitigación que sí se construye:
`debe_cambiar_clave` nace en `true` y **una sesión en ese estado no sirve para nada que no sea cambiar la
clave**. Y las dos claves se cambian **el mismo día del deploy**, no "cuando se pueda" (D8, P-04).

**4. Esto lo deployan DOS paneles del mismo `origin/main`, y el de infinix vive fuera del repo.**
`/srv/panel-infinix/deploy.sh` no lo puede editar ninguna task, así que su `npm run usuarios:seed` y su
línea de cron **hay que correrlos a mano**. Por eso `PANEL_SESSION_SECRET` tiene default a
`DASHBOARD_PASSWORD` y **no** va en el array `REQUIRED` del deploy: sin ese default, el próximo push
rompe los dos paneles. La regla completa está en `.kiro/steering/instancias.md`.

**5. El permiso se hace cumplir en TRES capas y ninguna sobra.** El middleware valida firma y expiración
(no puede consultar la base, corre en Edge). El `layout.tsx` de cada sección bloquea la pantalla. El
`guard()` de las API routes bloquea los datos. **Filtrar el nav es cosmético**: esconde los links, pero
la URL escrita a mano llega igual y las `/api/**` responden igual.

**6. `npm run build` no da verde hasta que la ola 3 esté completa, y eso es esperado.** T03 agrega la
pestaña Tareas apuntando a `/tareas`, que no existe hasta T06, y redirige a `/cambiar-clave`, que la
escribe T04. **No lo "arreglen".** Y **no deployen entre olas**.

**7. El plan es el contrato.** El `00-PLAN-USUARIOS-Y-TAREAS.md` completo, en especial §1 (las 16
decisiones cerradas), §4, §5 y §6 (los contratos congelados) y §8 (ownership), no lo modifica ningún
agente. Si algo no cierra, va a §11 (preguntas abiertas).

## El orden

```
Ola 1   T01                  UNA sola. Compuerta: nada arranca hasta que su verificación pasa.
Ola 2   T02 · T03 · T04      3 en paralelo, cero archivos en común
Ola 3   T05 · T06 · T07      3 en paralelo, contra los contratos congelados
```

**La ola 2 no arranca hasta que `lib/permisos.ts` de T01 esté mergeado y sus 7 pasos de verificación en
verde.** Las tres lo importan y sin él no compilan.

**T05 y T06 son paralelas aunque T06 le pegue al endpoint de T05**, porque §6 del plan congela el
contrato de las routes. Si T06 termina primero, su refetch da 404 hasta que T05 mergee y la primera
pintura —que viene del server— funciona igual.

**Si preferís ir de a uno:** T01 → T03 → T04 → T02 → T05 → T06 → T07. Poner T03 segunda tiene sentido:
es la que puede descubrir que una de las 33 routes no encaja en ninguna sección.

---

## Preámbulo (va al inicio de cada prompt)

> Este repo es un dashboard de Next.js 14 (App Router) + Postgres crudo (sin ORM, `pg` con SQL
> parametrizado) para un negocio de funnels de venta. Es un proyecto YA EN PRODUCCIÓN, y en DOS
> instancias que deployan del mismo `origin/main` (`panel.hilvanapp.com` y `panel.infinixapp.com`),
> aunque vas a trabajar contra tu base LOCAL de desarrollo.
>
> Leé estos archivos completos antes de escribir código, en este orden:
> 1. `tasks/usuarios-y-tareas/00-PLAN-USUARIOS-Y-TAREAS.md`
> 2. `tasks/usuarios-y-tareas/<TU-TASK>.md`
> 3. `.kiro/steering/instancias.md` y `.kiro/steering/registro.md`
>
> El resto del panel (Resumen, Embudo, Ventas, Anuncios, Finanzas, Leads, Config) ya funciona. Los
> patrones a seguir ya están establecidos: server component con `force-dynamic` que hace el fetch
> inicial + un `XView` client que refetchea contra `/api/**`, funciones puras en `lib/queries/`,
> primitivas de `components/ui.tsx`, SQL siempre parametrizado. Tu task te dice exactamente qué archivo
> existente leer como referencia antes de escribir el equivalente nuevo.
>
> Reglas que no se negocian:
> - **Solo escribís los archivos de tu fila en §8 del plan.** Otros agentes trabajan en paralelo. Si
>   creés que necesitás tocar uno ajeno, anotalo en §11 del plan y NO lo edites.
> - **Hay archivos que NADIE toca** (§8): `lib/queries/funnel.ts`, `lib/queries/sales.ts`,
>   `lib/queries/saldo.ts`, `lib/queries/finance.ts`, `lib/ingest/*`, `lib/orders/*`, `lib/ads/*`,
>   `lib/fx*.ts`, `components/ui.tsx`, `tailwind.config.ts`, `app/globals.css`, `app/api/ingest/`,
>   `app/api/webhooks/*`, `db/migrations/001` a `029`.
> - **No instalás dependencias ni editás `package.json`.** Ya está todo: `pg`, `zod`, `recharts`,
>   `vitest`, `fast-check`, `@phosphor-icons/react`, `@dnd-kit/core`, `@dnd-kit/sortable`. El hash de
>   claves usa `scrypt` de `node:crypto`, que no es una dependencia. (La única excepción es T01, que
>   agrega DOS scripts de npm y nada más.)
> - **No cambiás los contratos de §4, §5 y §6 del plan** una vez declarados. Están congelados porque
>   otro agente se está escribiendo contra ellos al mismo tiempo.
> - **Si aparece una decisión que el plan no resuelve, no la decidís en el código:** va a §11 del plan.
>   Si te bloquea, parás y avisás en vez de suponer.
> - **Todo el SQL con parámetros (`$1`, `$2`), nunca concatenación.** Lo único interpolable en un
>   template literal son constantes del propio módulo.
> - **Nada de autorización se decide en el cliente.** Esconder un botón no es un permiso. El permiso lo
>   niega el server o no existe.
> - **Falla cerrado, siempre.** Sin sesión, sin permiso, o ante una ruta que no está en el mapa: se
>   niega. Nunca "por defecto dejá pasar".
> - **Una clave nunca viaja en un query param, nunca se loguea, y un hash nunca sale en un JSON.**
> - **Denominador 0 devuelve `null` en los campos nuevos, con chequeo explícito. Nunca `|| 1`, nunca
>   `NaN`, nunca `Infinity`.**
> - **Cero literales de color.** Sólo tokens (`bad-500`, `warn-500`, `neutral-700`…). Hay un test que
>   lo vigila y `components/ui.tsx` no se toca.
> - **Código, comentarios, nombres de UI y mensajes en castellano.** Los comentarios explican POR QUÉ,
>   con la alternativa descartada cuando la hubo, como el resto del repo.
> - **Al terminar, corré tu sección de Verificación COMPLETA y pegá la salida real.** Si algo falla,
>   arreglalo antes de decir que terminaste. "Compila" no es verificación.

## Ola 1

### T01 — Fundación de identidad
> [preámbulo, con `<TU-TASK>` = `T01-fundacion-identidad.md`]
>
> Copiá las dos migraciones de `_schema-*.sql` a `db/migrations/`, reescribí `lib/auth.ts` para que la
> cookie lleve el id del usuario, escribí `lib/permisos.ts` con las firmas exactas de §4 del plan,
> `lib/queries/usuarios.ts` y `scripts/seed-usuarios.ts`, y adaptá el parser de `middleware.ts`.
>
> Atención especial:
> - **Copiá el DDL de `_schema-030.sql` y `_schema-031.sql` TAL CUAL, sin retipear y sin "mejorar" los
>   comentarios.** Ese SQL ya corrió contra una base con las 29 migraciones reales aplicadas y tiene 28
>   afirmaciones en verde. Cada CHECK está ahí por un modo de falla concreto que está comentado al lado.
> - **No escribas `BEGIN` ni `COMMIT` en las migraciones.** `scripts/migrate.ts:34-37` ya envuelve cada
>   archivo en su propia transacción junto con el registro en `schema_migrations`. Por lo mismo,
>   `CREATE INDEX CONCURRENTLY` no entra por ese runner (y no necesitás ninguno).
> - **El parser del token exige EXACTAMENTE 3 campos y `/^\d+$/` en los dos primeros.** Con `Number()` a
>   secas, `Number('7e2')` es 700 y `Number(' 7')` es 7: dos cookies distintas darían el mismo id con
>   firmas distintas. Y un token de 2 campos (el viejo) tiene que **rechazarse**, no leerse como si el
>   `ts` fuera el id — si no, cualquiera con una cookie vieja entra como el usuario cuyo id coincida con
>   un timestamp.
> - **El punto va DENTRO del payload firmado** (`` `${id}.${ts}` ``). Sin separador, `id=1,ts=23` y
>   `id=12,ts=3` firman igual. Está afirmado (10).
> - **`crypto.scrypt` async, NO `scryptSync`.** `scryptSync` bloquea el event loop de Next 30-99 ms, y el
>   login no es el único request en vuelo.
> - **Los parámetros de scrypt se leen de la FILA que estás verificando**, no de la constante del módulo.
>   Es lo único que permite subir el costo después sin invalidar los hashes viejos (afirmación 5).
> - **`MAPA_API` es una tabla explícita, ruta por ruta.** NO lo generes con reglas por prefijo: tres
>   endpoints viven bajo un prefijo que no es su sección y están en la tabla de D5. Un
>   `/api/config/* → config` le rompe a nahuel mover un widget en Resumen con un 403 que nadie mira.
> - **`sesionActual()` usa LEFT JOIN, no JOIN.** Un usuario sin ninguna sección otorgada tiene que
>   devolver una sesión con la lista vacía, **no `null`**: son cosas distintas ("no tiene permisos" va a
>   `/sin-acceso`, "no existe" va al login). Con un JOIN a secas, el usuario recién creado desaparece.
> - **En `requerirSeccion`, `debeCambiarClave` se chequea ANTES que el permiso.** Si no, alguien con la
>   clave por defecto y sin secciones cae en `/sin-acceso` y nunca puede cambiarla.
> - **El seed es idempotente y NO le toca la clave a un usuario que ya existe.** El deploy lo va a correr
>   en cada push: si no lo es, cada deploy le devuelve `123456` a quien ya la cambió.
> - **Cuando termines, corré `_verificacion-030-031.sql` y `_verificacion-sesion.mjs`.** Si la afirmación
>   7 falla, PARÁ EL PROYECTO y avisá: node y Edge firmando distinto invalida el diseño entero.

## Ola 2

### T02 — Capa de datos de tareas
> [preámbulo, con `<TU-TASK>` = `T02-capa-de-datos-tareas.md`]
>
> Escribí `lib/queries/tareas.ts` con las firmas exactas de §5 del plan, y su archivo de tests.
>
> Atención especial:
> - **Los links y los comentarios salen por subconsultas correlacionadas con `jsonb_agg`, NUNCA con un
>   `JOIN` plano.** Una tarjeta con 3 links y 2 comentarios saldría 6 veces con un join, y cualquier
>   `count` o `LIMIT` de la query pasa a mentir. Es el mismo razonamiento que `lib/queries/funnel.ts:542-577`.
> - **`COALESCE(..., '[]'::jsonb)`.** Sin eso, una tarjeta sin links devuelve `NULL` y el `.map()` del
>   cliente tira.
> - **`Number()` en los ids.** `tareas.id` es `bigserial` y `pg` devuelve `bigint` como **string**: sin el
>   `Number()`, un `id === 7` del cliente no matchea nunca.
> - **`ORDER BY posicion, id`**, con el desempate. Dos tarjetas pueden compartir `posicion` mientras una
>   reescritura está a mitad de camino, y sin el desempate el orden cambia entre dos refrescos.
> - **`moverTarea` y `reordenarColumna` van dentro de UN `tx()` y con el `c` del callback, nunca con
>   `q()`.** `q()` toma otra conexión del pool y queda fuera de la transacción, con la transacción
>   abierta esperando: deadlock.
> - **Reordenar una tarjeta que YA estaba en `hecho` no puede tocarle `hecha_at`.** Son dos días desde que
>   se terminó, no desde el último manoseo. El CHECK `(columna='hecho') = (hecha_at IS NOT NULL)` te va a
>   rechazar los otros dos casos si te olvidás.
> - **`make_interval(days => $1)`, no `interval '$1 days'`.** Lo segundo no compila y la tentación de
>   resolverlo concatenando es exactamente lo que §9.3 del plan prohíbe.
> - **Validá que `ordenDeLaColumna` contenga el `id` y que todos pertenezcan a la columna destino.** Una
>   lista incompleta deja a las que faltan con la posición vieja, intercaladas de forma impredecible.

### T03 — Los guards
> [preámbulo, con `<TU-TASK>` = `T03-guards.md`]
>
> Escribí los siete `layout.tsx` de sección, adaptá `app/(panel)/layout.tsx` y `anuncios/layout.tsx`,
> metele el chequeo de permiso a `guard()` en `app/api/config/_lib.ts`, migrá las siete routes que hacen
> `isAuthenticated` inline, escribí `app/api/rutas-mapeadas.test.ts` y filtrá el nav.
>
> Atención especial:
> - **El guard va en layouts NUEVOS, no en los `page.tsx`.** Son archivos de 10 líneas que no tocan
>   ninguna de las diez pantallas que ya funcionan, y cubren las sub-rutas gratis (`/anuncios/reglas`
>   hereda el de `/anuncios`).
> - **El layout devuelve `<>{children}</>` y nada más.** Un `<div>` de más cambia la cascada de CSS de la
>   pantalla que envuelve, y hay diez con márgenes ajustados a mano.
> - **`debeCambiarClave` se chequea en el layout GENERAL, no en los siete de sección.** Si estuviera en
>   cada uno, alguien con la clave por defecto y sin secciones cae en `/sin-acceso` y nunca la cambia.
> - **NO le pongas el guard a `/api/ingest` ni a `/api/webhooks/*`.** Están declaradas `'publica'` en el
>   mapa y tienen su propia auth. Meterles la cookie del panel corta el tracking y las ventas, y el panel
>   muestra ceros sin un solo error visible.
> - **Una ruta que no está en `MAPA_API` devuelve 403.** Falla cerrado. Y el test que recorre
>   `app/api/**/route.ts` es lo que convierte eso en una garantía: **rompelo a propósito** (comentá una
>   entrada del mapa) y comprobá que falla nombrando la ruta. Un test de cobertura que pasa siempre es
>   peor que no tenerlo.
> - **`/api/usuarios/clave` queda como `'admin'` en el mapa** y la excepción del propio usuario la maneja
>   T04 adentro del route. No le inventes un tercer tipo al mapa por un caso.
> - **Agregá el nombre del usuario al header.** Con dos personas en el mismo panel, saber con cuál estás
>   logueado es lo que evita crear una tarea con el dueño equivocado.

### T04 — Login, cambio de clave y pantalla de Usuarios
> [preámbulo, con `<TU-TASK>` = `T04-login-y-usuarios.md`]
>
> Agregá el campo de usuario al login, escribí `/cambiar-clave` y `/sin-acceso`, los routes de
> `/api/usuarios`, y la sección Usuarios en Config → Sistema.
>
> Atención especial:
> - **El mensaje de error del login sigue siendo el MISMO para las cuatro causas** (usuario inexistente,
>   clave mala, campo vacío, rate limit). El comentario de `app/page.tsx:143-148` explica por qué, y ahora
>   hay una razón más: un login que dice "ese usuario no existe" es un enumerador de usuarios gratis.
> - **`/cambiar-clave` y `/sin-acceso` van FUERA del grupo `(panel)`.** Adentro, el layout las protegería
>   y el redirect sería un bucle infinito.
> - **`/cambiar-clave` pide la clave ACTUAL** aunque la sesión ya esté validada: sin eso, una máquina
>   desbloqueada te deja afuera de tu propio panel.
> - **La nueva no puede ser igual a la actual.** Sin eso, "cambiar la clave" se satisface con `123456`
>   otra vez y `debe_cambiar_clave` pasa a `false` con la clave por defecto puesta — el agujero de D8
>   quedándose abierto para siempre.
> - **El mínimo de 15 caracteres se valida en el SERVER.** El `minLength` del input es una comodidad; un
>   POST directo lo ignora.
> - **Si `debeCambiarClave`, la pantalla no tiene salida**: nada de link a `/resumen` ni de botón
>   "después". Un escape anula la mitigación.
> - **El fallback de `DASHBOARD_PASSWORD` se chequea SÓLO si `contarUsuarios() === 0`.** No es "si no
>   encontré el usuario, probá con la vieja": eso sería una puerta de atrás permanente.
> - **Normalizá el usuario con `.trim().toLowerCase()` antes de buscar.** El CHECK de la 030 exige la
>   columna en minúsculas sin espacios, así que sin normalizar, quien escriba "Lucho" no entra y no hay
>   ningún error que lo explique.
> - **`secciones` en el PATCH es el estado FINAL de los 8 switches, no un diff**, y se valida con
>   `z.enum` contra `SECCIONES` — no contra un array escrito a mano.
> - **La fila del admin muestra los 8 switches en on y DESHABILITADOS**, con el motivo escrito.
>   Deshabilitados y no escondidos: escondidos parece un bug.
> - **No hay botón de borrar usuarios**, hay "Desactivar". Los tres FK son RESTRICT y un DELETE fallaría
>   igual, pero con un 500.

## Ola 3

### T05 — API de tareas
> [preámbulo, con `<TU-TASK>` = `T05-api-tareas.md`]
>
> Escribí los cuatro routes de `app/api/tareas/**` con la forma exacta de §6 del plan.
>
> Atención especial:
> - **La comprobación de dueño va DESPUÉS de leer la tarjeta y ANTES de escribir.** No se puede hacer con
>   un `WHERE asignado_a = $1` en el UPDATE: devolvería 0 filas y no hay forma de distinguir "no existe"
>   de "no es tuya", que son un 404 y un 403.
> - **Verificá el dueño contra el `asignado_a` DE LA BASE, nunca contra el que viene en el payload.**
> - **`z.string().url()` ACEPTA `javascript:alert(1)`** — es una URL válida según el WHATWG. Necesitás
>   los dos chequeos: zod **y** la whitelist de protocolo. El CHECK de la 031 lo rechazaría igual, pero
>   como un 500 en vez de un 400 legible.
> - **El `usuarioId` de un comentario sale de la SESIÓN, nunca del body.** Un comentario firmable por el
>   cliente es un comentario que se puede poner en boca de otro.
> - **`creado_por` va `null` cuando la sesión es la del fallback** (`usuarioId: 0` no existe en `usuarios`
>   y el FK tiraría un 23503). La columna es nullable justo para eso.
> - **`mover` verifica el dueño de la tarjeta que se mueve, NO de las de `orden`.** La lista contiene toda
>   la columna, incluidas tarjetas de otros; exigir ser dueño de todas dejaría a un no-admin sin poder
>   mover ninguna. Comentalo, porque parece un agujero y no lo es: `posicion` es orden de presentación.
> - **`.nullable().optional()`** para `notas` y `venceEl`: `null` borra, ausente no toca. Con
>   `.optional()` solo, no hay forma de borrar una nota.
> - **Sin el parámetro `asignado`, el default es `todas`.** Es un tablero compartido. Y un `asignado`
>   inválido es un 400, **no** un `todas` silencioso.
> - **El paso 3 de tu verificación no es opcional**: después del 403, releé el título desde psql. Un 403
>   que sale **después** de escribir es peor que no tener el chequeo, porque parece que funciona.

### T06 — UI del kanban
> [preámbulo, con `<TU-TASK>` = `T06-ui-kanban.md`]
>
> Escribí `app/(panel)/tareas/**` (menos el `layout.tsx`, que es de T03): el tablero de 4 columnas con
> drag & drop, las tarjetas, el modal de detalle y el switch de asignado.
>
> Atención especial:
> - **NADA de `reveal` ni de animaciones de `transform` en las tarjetas.**
>   `app/(panel)/layout.tsx:120-133` lo explica: en la cascada las animaciones ganan a los estilos
>   inline y pisarían el `transform` de dnd-kit. La clase ya la pone el `<main>` a nivel de página.
> - **`closestCorners`, no `closestCenter`.** `WidgetGrid` usa `closestCenter` porque todos sus items son
>   del mismo tamaño en una grilla; en un kanban las columnas tienen distinta altura y `closestCenter`
>   hace que soltar cerca del borde inferior caiga en la columna de al lado.
> - **Una columna VACÍA tiene que aceptar que le suelten algo.** Es el bug clásico: si la zona droppable
>   es la lista de items, una columna sin tarjetas no tiene superficie. La zona es el contenedor, con
>   altura mínima.
> - **El asa es un `<button>` con `aria-label`, no la tarjeta entera** (como `WidgetGrid`), y el
>   `PointerSensor` va con `activationConstraint: { distance: 8 }` — sin eso, un click en un botón de la
>   tarjeta arranca un arrastre.
> - **Optimista con rollback.** Si el POST falla, la tarjeta **vuelve** a su lugar y aparece el error.
>   Una tarjeta que se queda donde la soltaste mientras en la base está en otro lado es el peor resultado:
>   el siguiente refresh la mueve sola y parece un fantasma. Probalo con el Network en Offline.
> - **La propiedad de `fast-check` (afirmación 9) no es opcional**: para cualquier lista y cualquier par
>   (desde, hasta), `nuevoOrdenAlSoltar` devuelve una **permutación** de la entrada. Perder un id ahí es
>   una tarjeta que desaparece del tablero, y es el bug más fácil de no ver con tres tests a mano.
> - **Prioridad baja va en `neutral` (gris), NO en `good` (verde)**, aunque el verde estaba ofrecido: en
>   este panel `good` es EL color de acento (la pestaña activa, el botón primario), y una tarjeta verde
>   compite con los controles y se lee como "esta está bien" cuando dice "puede esperar".
> - **El color no puede ser la única señal**: franja de color **más** la palabra "Alta".
> - **Los campos deshabilitados si no podés editar, pero el de comentario SIEMPRE habilitado**, y con la
>   línea que dice de quién es la tarea.

### T07 — ROI, cron, deploy y registro
> [preámbulo, con `<TU-TASK>` = `T07-roi-cron-deploy.md`]
>
> Agregá el ROI a `lib/queries/overview.ts` y su widget al catálogo, escribí
> `scripts/archivar-tareas.ts` y su línea de cron, ajustá el deploy, documentá en `COMO-DEPLOYAR.md` y
> escribí la entrada de `registro.md` del módulo entero.
>
> Atención especial:
> - **ANTES DE TOCAR NADA: `lib/queries/overview.ts` y `lib/widgets/catalogo-resumen.tsx` están
>   modificados sin commitear** con cambios de otro trabajo. Commiteá o guardá eso primero; si trabajás
>   encima y hay que revertir, no hay forma limpia de revertir sólo lo tuyo.
> - **El ROI usa el NETO, no el bruto.** El `roas` que ya existe (línea 438) usa el bruto: si usás el
>   bruto te va a dar el mismo número y vas a haber agregado un duplicado.
> - **`null` sin gasto, no 0.** Es la regla que el propio archivo fija en las líneas 58-62 para los
>   campos nuevos, y dice explícitamente **no unificar** con los viejos sin cambiar las dos vistas a la
>   vez. En el widget, `null` se muestra como `—`, no como `0.00×`.
> - **Se calcula con los TOTALES, nunca promediando los de cada funnel** (líneas 420-427: un promedio de
>   ratios no significa nada).
> - **No metas el widget en el layout por defecto de Resumen.** Entra al catálogo; si aparece lo decide el
>   layout guardado, que es del usuario — y por P-01 es **compartido**, así que reordenarlo se lo
>   reordena a los dos.
> - **`PANEL_SESSION_SECRET` NO va en el array `REQUIRED` de `deploy/deploy.sh:177`.** Tiene default a
>   `DASHBOARD_PASSWORD` justo para que el deploy no falle en ninguna de las dos instancias. Meterla ahí
>   rompe los dos deploys en el próximo push.
> - **El fallo del seed no puede abortar el deploy.** Si falla, el panel sigue por el fallback de D10.
>   Loguealo fuerte y seguí. (El precedente en contra, `verificar-token-ads.ts`, es de una feature que
>   gasta plata real.)
> - **Verificá que el seed sea idempotente comparando el hash antes y después** (paso 6). Si no lo es,
>   cada deploy le resetea la clave a `123456` a quien ya la cambió, y nadie se entera hasta que alguien
>   no puede entrar.
> - **`COMO-DEPLOYAR.md` tiene que decir que el seed y el cron de infinix son MANUALES**, porque
>   `/srv/panel-infinix/deploy.sh` vive fuera del repo y ninguna task lo puede editar.
> - **La entrada de `registro.md` cubre las siete tasks**, con las alternativas descartadas y su motivo,
>   y con lo que se decidió NO hacer (el layout global de P-01, el flag de Anuncios de P-05, que los
>   usuarios no se borran). El detalle de qué tiene que decir está en tu §6.

---

## Qué revisar cuando terminan

```bash
# 1 — el esquema, con base
npm run db:migrate && npm run db:migrate
psql "$DATABASE_URL" -f tasks/usuarios-y-tareas/_verificacion-030-031.sql
# esperado: 28 PASA, 0 FALLA, y los conteos del final IGUALES a los del principio

# 2 — sesión, hash y ROI
node tasks/usuarios-y-tareas/_verificacion-sesion.mjs
# esperado: 16 PASA y exit 0

# 3 — el módulo entero, con base efímera (no toca tu base de desarrollo)
bash tasks/usuarios-y-tareas/_verificacion-e2e.sh
# esperado: los 9 pasos en PASA

# 4 — build y suite completa
npm run build && npm test
# esperado: todo verde. Acá ya no hay huecos esperados.

# 5 — el test de cobertura de rutas hace su trabajo
#     comentá una entrada de MAPA_API en lib/permisos.ts y corré:
npm test -- app/api/rutas-mapeadas
# esperado: FALLA, y el mensaje NOMBRA la ruta que falta. Descomentala.
#           Si pasa en verde con una entrada comentada, el test no sirve.

# 6 — nadie tocó lo que no era suyo
git diff --stat main -- lib/queries/funnel.ts lib/queries/sales.ts lib/queries/saldo.ts \
  lib/ingest lib/orders lib/ads components/ui.tsx tailwind.config.ts app/globals.css \
  app/api/ingest app/api/webhooks
# esperado: VACÍO. Cualquier línea acá es una violación de §8 del plan.
git diff --stat main -- db/migrations/ | grep -v '03[01]_'
# esperado: VACÍO. Las 29 migraciones viejas no se tocan.

# 7 — las rutas públicas siguen abiertas (si esto falla, dejan de entrar las ventas)
curl -s -o /dev/null -w 'shopify %{http_code}\n' http://127.0.0.1:3005/api/webhooks/shopify
curl -s -o /dev/null -w 'hotmart %{http_code}\n' http://127.0.0.1:3005/api/webhooks/hotmart
# esperado: 200 los dos (son sus healthchecks). Un 401 o un 403 acá es una caída silenciosa.
grep -n "matcher" middleware.ts
# esperado: api/ingest y api/webhooks todavía afuera

# 8 — los permisos de verdad. Las cookies se fabrican con el helper de la carpeta:
#     LUCHO=$(node tasks/usuarios-y-tareas/_cookie.mjs 1)
#     NAHUEL=$(node tasks/usuarios-y-tareas/_cookie.mjs 2)
#     como lucho:  las 8 pestañas, Config entra, Usuarios se ve
#     como nahuel: 3 pestañas; /config y /anuncios redirigen; /finanzas carga
curl -s -o /dev/null -w 'config   %{http_code}\n' -H "Cookie: panel_token=$NAHUEL" \
  http://127.0.0.1:3005/api/config/settings
# esperado: 403
curl -s -o /dev/null -w 'uilayout %{http_code}\n' -H "Cookie: panel_token=$NAHUEL" \
  'http://127.0.0.1:3005/api/config/ui-layout?pantalla=resumen'
# esperado: 200. Un 403 acá significa que se mapeó por prefijo y le rompieron los
#           widgets de Resumen — es el bug silencioso que D5 existe para evitar.
curl -s -o /dev/null -w 'sin cookie %{http_code}\n' http://127.0.0.1:3005/api/finanzas/cuentas
# esperado: 401

# 9 — el kanban, a ojo, en el browser
# http://127.0.0.1:3005/tareas
#   las 4 columnas, el switch en "Todas", una tarjeta alta con la franja roja Y la palabra
#   arrastrar entre columnas, A UNA COLUMNA VACÍA, y al final de una columna larga
#   refrescar (F5) después de CADA movimiento → el orden es el que dejaste
#   Network en Offline y arrastrar → la tarjeta vuelve sola y aparece el error
#   Tab hasta el asa → Espacio → flechas → Espacio
#   como nahuel, abrir una tarjeta de lucho → campos deshabilitados, comentario habilitado

# 10 — el cron
psql "$DATABASE_URL" -c "UPDATE tareas SET columna='hecho', hecha_at=now()-interval '3 days' WHERE id=<una>"
npm run tareas:archivar && npm run tareas:archivar
# esperado: la primera dice 1 archivada, la segunda 0

# 11 — el registro quedó escrito
head -20 registro.md
# esperado: la entrada del módulo arriba de todo
```

**Dos cosas que, si fallan, el módulo NO está listo por más que todos los tests estén verdes.**

La primera es el paso 8: si un `curl` con la cookie de nahuel devuelve datos de una sección que no
tiene, el switch de la pantalla de Usuarios es un adorno. Esconder una pestaña no es un permiso, y este
módulo existe para dar permisos.

La segunda es el paso 6 de T07 (el hash del seed antes y después). Un seed que no es idempotente
convierte cada deploy en un reseteo de claves silencioso: el panel sigue funcionando, nadie ve un error,
y la próxima vez que alguien quiera entrar su clave no sirve y no hay nada en ningún log que lo explique.
