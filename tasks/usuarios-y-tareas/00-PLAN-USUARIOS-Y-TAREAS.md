# Usuarios con permisos por pestaña + tablero de tareas — plan maestro

**Documento maestro del módulo. Todo agente lee este archivo completo antes de abrir su task.**

El panel se autentica hoy con **una contraseña compartida** (`DASHBOARD_PASSWORD`) y la cookie no
lleva identidad. Este módulo le da identidad: usuarios con su propia clave, un admin que decide qué
pestañas ve cada uno con un switch, y un tablero kanban de tareas asignadas por persona.

Son dos cosas que llegan juntas porque el kanban necesita saber quién es quién, y no se pueden
separar: `tareas.asignado_a` es un FK a `usuarios`.

---

## 0. Qué se construye y qué no

### Se construye

1. **Tabla `usuarios`** con clave propia hasheada con scrypt, más `usuario_secciones`: una fila por
   permiso otorgado. Migraciones 030 y 031.
2. **La cookie pasa a llevar el id del usuario**: `${usuarioId}.${ts}.${sig}`, firmada con un secreto
   independiente de las claves. Se verifica igual en el server (`node:crypto`) y en Edge
   (`crypto.subtle`).
3. **Login con usuario + clave.** Primera entrada obliga a cambiar la clave (mínimo 15 caracteres).
4. **Permisos por pestaña, hechos cumplir en tres capas**: el layout de cada sección, el `guard()` de
   las API routes, y el filtro del nav (que es cosmético, ver D6).
5. **Pantalla de Usuarios** en Config → Sistema: crear, activar/desactivar, resetear clave y los 8
   switches de secciones.
6. **Pestaña Tareas**: kanban de 4 columnas con drag & drop, prioridad por color, asignado, notas,
   links y comentarios. Switch de "las de una persona" / "todas".
7. **Cron que archiva** lo que lleva más de 2 días en la columna "hecho".
8. **ROI general en Resumen**, como múltiplo (`1.25×`).

### No se construye

- **No se toca el mecanismo de las rutas públicas.** `/api/ingest` y `/api/webhooks/*` siguen fuera
  del matcher del middleware y con su propia auth (Bearer + sha256, HMAC de Shopify). Si el
  middleware los interceptara, el tracking y las ventas dejan de entrar y el panel muestra ceros sin
  un solo error visible.
- **No se apagan las sub-pestañas de Anuncios ni las 10 secciones de Config por separado.** El
  permiso es la pestaña madre entera (respuesta 1 de la entrevista).
- **No se aprovecha esto para apagar Anuncios en la instancia infinix.** Pedido explícito: no se
  toca. Ver P-05.
- **No se hace `settings.ui_layout_*` por usuario.** Sigue siendo global y el layout de widgets se
  comparte. Ver P-01.
- **No hay revocación de sesiones vivas.** Desactivar un usuario le corta el acceso en el siguiente
  request (porque el permiso se lee de la base, D3), pero no existe una tabla de sesiones ni un
  denylist. Ver P-02.
- **No se borran usuarios.** Se desactivan. Ver D8.
- **No hay pantalla de "mi perfil"**, ni foto, ni email, ni recuperación por mail. La clave la
  resetea el admin.

---

## 1. Decisiones cerradas

Todo lo que dice "medido" o "verificado" acá se corrió de verdad el **2026-09-08**: el DDL contra una
base scratch con las 29 migraciones reales aplicadas (Postgres 16.14), y la criptografía con Node
v24.14.0. Los dos archivos que lo prueban están en esta carpeta y están en verde.

Las dieciséis, para poder encontrarlas sin scrollear:

**D1** — La contraseña dejó de ser la clave de firma; el secreto se separa con default a la vieja.
**D2** — El token es `${usuarioId}.${ts}.${sig}` y el punto va dentro del payload firmado.
**D3** — El permiso se lee de la base en cada request, no viaja en la cookie.
**D4** — Un `layout.tsx` por sección, no un header inyectado desde el middleware.
**D5** — `guard()` gatea 23 endpoints sin tocarlos, con un mapa explícito de ruta a sección.
**D6** — Filtrar el nav es cosmético; la seguridad es el guard.
**D7** — scrypt de `node:crypto`, con los parámetros guardados en la fila.
**D8** — La clave por defecto es `123456` y es un riesgo aceptado, no un descuido.
**D9** — El seed va en un script, no en la migración.
**D10** — Con la tabla vacía, `DASHBOARD_PASSWORD` sigue valiendo y esa sesión es admin.
**D11** — Los permisos son una fila por permiso otorgado; el admin no tiene filas.
**D12** — El orden del tablero es `posicion integer` reescrita entera, no índice fraccionario.
**D13** — `hecha_at` es una columna propia y no se deriva de `updated_at`.
**D14** — El CHECK `(columna = 'hecho') = (hecha_at IS NOT NULL)` no es adorno.
**D15** — Links y comentarios son tablas hijas, no columnas `jsonb`.
**D16** — El ROI del Resumen es `neto / gasto`, con equilibrio en 1.00×.

### D1 — La contraseña dejó de ser la clave de firma. El secreto se separa, con default a la contraseña vieja.

`lib/auth.ts:82-89` firma la cookie con `DASHBOARD_PASSWORD` **como clave HMAC**. Con varios usuarios
eso no cierra: cada uno tiene su clave, así que habría varias claves de firma válidas y la cookie no
dice cuál firmó.

El secreto de firma pasa a ser `PANEL_SESSION_SECRET`, **con default a `DASHBOARD_PASSWORD`**. El
default no es pereza: es lo que hace que las dos instancias sigan entrando sin declarar una variable
nueva, y es la regla del proyecto (`.kiro/steering/instancias.md`: el default es siempre el valor
histórico de hilvanapp). Por eso **no se agrega a `REQUIRED` de `deploy/deploy.sh:177`**.

Descartado: dejar la contraseña como secreto de firma y meter el id del usuario sin firmar. Cualquiera
edita una cookie y entra como el admin.

### D2 — El token es `${usuarioId}.${ts}.${sig}`, y el punto va DENTRO del payload firmado.

Verificado (afirmaciones 7 a 12 de `_verificacion-sesion.mjs`):

- `node:crypto` y `crypto.subtle` producen **el mismo hex** para el mismo payload. Eso es lo que
  permite que el middleware Edge verifique la identidad sin poder importar `lib/auth.ts` ni consultar
  Postgres.
- El payload firmado es `` `${id}.${ts}` `` **con el punto adentro**. Sin separador, `id=1, ts=23` y
  `id=12, ts=3` firmarían igual.
- El parser exige **exactamente 3 campos**, los dos primeros `/^\d+$/` y el tercero 64 hex. `Number()`
  a secas no alcanza: `Number('7e2')` es 700 y `Number(' 7')` es 7, así que dos cookies distintas
  darían el mismo id con firmas distintas.

**CONSECUENCIA QUE HAY QUE DECIR, NO ESCONDER: en el deploy se cortan todas las sesiones vivas.** El
token viejo tiene 2 campos y el parser nuevo lo rechaza (afirmación 9). Todo el mundo vuelve a entrar.
Es el fallo seguro y no hay forma de evitarlo sin aceptar tokens sin identidad, que es justo lo que
este módulo elimina.

### D3 — El permiso se lee de la BASE en cada request, no viaja en la cookie.

La alternativa era meter las secciones firmadas en el token: el middleware las leería en Edge y el
chequeo sería más rápido.

Se descartó por una razón concreta: **apagarle una pestaña a alguien no tendría efecto hasta que se le
venza la sesión**, o sea hasta 12 h con un switch que dice "off" y no está off. El switch tiene que
ser instantáneo o no es un switch.

El costo que se acepta: el middleware ya no puede bloquear por permiso (no puede consultar Postgres,
corre en Edge — su propio docblock lo explica en `middleware.ts:11-18`), así que sigue validando sólo
firma y expiración. El bloqueo por permiso lo hace el layout de cada sección y el `guard()` de las
routes, los dos en Node. Para el usuario es idéntico: un redirect en vez de un 307.

### D4 — Un `layout.tsx` por sección, y NO un header inyectado desde el middleware.

`app/(panel)/layout.tsx:46` es el guard de todos los server components del panel, pero **no sabe qué
página está renderizando**: recibe `children` y nada más.

Las dos salidas eran inyectar el pathname en un header desde el middleware, o poner un
`layout.tsx` por sección. Gana el segundo: son archivos **nuevos** de 10 líneas, no depende de un
header que hay que recordar que existe, y cubre las sub-rutas gratis (`/anuncios/reglas` hereda el
guard de `/anuncios`). Y no toca ni una línea de los 10 `page.tsx` que ya funcionan.

La excepción es `app/(panel)/anuncios/layout.tsx`, que ya existe: ahí van 3 líneas adentro.

### D5 — `guard()` gatea 23 endpoints sin tocarlos, con un mapa EXPLÍCITO de ruta a sección.

`guard(req)` en `app/api/config/_lib.ts:29` ya recibe el `NextRequest`, así que puede leer
`req.nextUrl.pathname` y chequear el permiso adentro. Los 23 routes que lo llaman no cambian ni una
línea. Los otros 7 hacen `isAuthenticated(req.cookies)` inline y **hay que migrarlos** (T03).

**El mapa es explícito, ruta por ruta, y NO una regla por prefijo.** Verificado leyendo quién llama a
cada endpoint, porque tres de ellos viven bajo un prefijo que no es su sección:

| Endpoint | Vive bajo | Lo llama | Sección real |
|---|---|---|---|
| `/api/config/ui-layout` | `config` | `components/WidgetGrid.tsx:408` | `resumen`, `ventas` |
| `/api/config/vistas-ads` | `config` | `app/(panel)/anuncios/GestorAnuncios.tsx:1148` | `anuncios` |
| `/api/ia/insight` | `ia` | `components/PanelInsight.tsx:75` | `resumen`, `finanzas` |

Un `/api/config/* → config` le rompería a nahuel mover un widget en Resumen, con un 403 en un `fetch`
que nadie mira. Por eso el mapa es una tabla y por eso **el default de una ruta que no está en el mapa
es NEGAR**, con un test que recorre `app/api/**/route.ts` y falla si aparece una sin mapear (T03 §5).
"Me olvidé de una" tiene que romper el build, no producir un 403 en producción.

### D6 — Filtrar el nav es cosmético. La seguridad es el guard.

`components/Nav.tsx:20-28` es el único lugar donde se listan las pestañas. Filtrar ese array esconde
los links, pero la URL escrita a mano sigue llegando y las `/api/**` siguen respondiendo.

Se hacen las dos cosas y en ese orden de importancia: el guard es la garantía, el filtro es para que
nadie vea una pestaña que le va a dar un redirect. **Entre la ola 2 y la ola 3 el nav va a mostrar una
pestaña "Tareas" que da 404.** Es esperado y está en §7.

### D7 — scrypt de `node:crypto`, con los parámetros guardados EN la fila.

Sin dependencias nuevas: `bcrypt` y `argon2` son módulos nativos y `deploy/deploy.sh:210` corre
`npm ci` **sin** `--omit=dev`, así que se compilarían en la VPS en cada deploy.

Formato: `scrypt$<N>$<r>$<p>$<salt hex>$<derivada hex>`. Los parámetros van en la fila y no en una
constante del código porque es lo único que permite subir el costo más adelante **sin invalidar los
hashes que ya están**: el verify lee N, r y p de la fila que está comprobando. Verificado
(afirmación 5): un hash con `N=1024` sigue verificando después de que el código pase a `N=16384`.

Medido: 30 ms por verificación en régimen, 99 ms la primera del proceso. El login prueba **un** hash
(busca por usuario primero), y el rate limit de 5 intentos / 15 min por IP ya existe
(`lib/auth.ts:214-267`).

Y **no** es un `sha256` pelado como `funnels.ingest_key_hash`: esa key son 32 bytes aleatorios, una
clave que elige una persona no.

### D8 — La clave por defecto es `123456` y esto es un riesgo aceptado, no un descuido.

Pedido explícito (respuesta 6). Lo que hay que saber:

- **Mientras nadie la cambie, el panel está abierto con `123456`.** No hay forma de que no lo esté: una
  clave por defecto conocida es una clave por defecto conocida. La ventana de exposición es desde que
  corre el seed hasta el primer login.
- Mitigación que sí se construye: `debe_cambiar_clave` nace en `true` y **una sesión en ese estado no
  sirve para nada que no sea cambiar la clave**. El layout redirige a `/cambiar-clave` y `guard()`
  devuelve 403 `clave_pendiente` en todo lo demás. Verificado en el esquema (afirmación 7).
- Lo que yo habría hecho y no se hace: sembrar un centinela imposible de producir (el precedente del
  repo es `PENDING_SET_INGEST_KEY_*` en `funnels.ingest_key_hash`, que fuerza un 401) y obligar a
  correr un script una vez. Queda anotado porque es una decisión de conveniencia con costo, no una
  técnica.
- **Cambiá las dos claves el mismo día del deploy.** Está en el checklist de T07.

Mínimo 15 caracteres al cambiarla, validado en el server. El `123456` del seed no lo viola porque el
mínimo aplica a la **entrada** del cambio, no al hash sembrado.

### D9 — El seed va en un script, no en la migración.

Dos razones y las dos son duras:

1. **El admin es distinto por instancia**: hilvanapp → `lucho`, infinix → `Ivan`. Una migración SQL no
   lee env vars. El precedente del repo es `scripts/set-ingest-key.ts`, y no hay ni un secreto
   entrando por un `.sql` en las 29 migraciones.
2. Un hash de clave dentro de un archivo commiteado es una credencial en git, para siempre.

`scripts/seed-usuarios.ts` (`npm run usuarios:seed`) lee `PANEL_ADMIN_USUARIO` (default `lucho`) y
`PANEL_ADMIN_NOMBRE` (default `Lucho`), y es idempotente: si el usuario ya existe, no lo toca.

### D10 — Con la tabla vacía, el panel sigue aceptando `DASHBOARD_PASSWORD` y esa sesión es admin.

Es el fallback que hace que el deploy no deje a nadie afuera. La migración corre en las dos
instancias; entre la migración y el seed hay una ventana, y sin el fallback esa ventana es un panel
cerrado en producción.

Se apaga **solo**, en cuanto hay una fila en `usuarios`. Y sólo aplica con la tabla **vacía**: no es
"si la clave no matchea a ningún usuario, probá con la vieja".

Es además lo que hace que infinix no se entere de nada hasta que alguien corra su seed, que es la
regla de instancias.

### D11 — Los permisos son una fila por permiso otorgado. No 8 columnas ni un `text[]`.

Con columnas o con array, agregar una pestaña el año que viene obliga a decidir un default para todos
los usuarios existentes, y el default cómodo es `true`: una sección nueva nace visible para todos sin
que nadie lo pidiera. Con filas, **"no hay fila" ES "no lo ve"**: falla cerrado por construcción.

Es además el modelo al que el repo ya migró una vez — `021_reglas_por_cuenta.sql` deshizo
`ad_rules.account_ids text[]` para pasar a una fila por cuenta.

**El admin no tiene filas: `es_admin` implica las 8.** Si sus permisos fueran filas, un click
equivocado en la pantalla de Usuarios lo dejaría afuera de Config, que es justo donde se arregla.

### D12 — El orden del tablero es `posicion integer` reescrita entera, no índice fraccionario.

Al soltar una tarjeta el cliente manda **la lista ordenada de ids de la columna afectada** y el server
reescribe `posicion` como 10, 20, 30… en una transacción.

Descartado el índice fraccionario (insertar en el punto medio entre los dos vecinos): existe para
listas de miles de items con varios editores simultáneos. Acá son dos o tres personas y decenas de
tarjetas, y el fraccionario trae una historia de precisión que no hace falta tener.

### D13 — `hecha_at` es una columna propia y no se deriva de `updated_at`.

El cron archiva lo que lleva más de 2 días en "hecho". Si el reloj fuera `updated_at`, **agregar un
comentario a una tarea terminada le reiniciaría el reloj** (lo mueve el trigger) y una tarjeta con
conversación activa no se archivaría nunca.

Y hay un dato de Postgres que descubrí verificando esto y que el plan tiene que decir: **`now()` es
la hora de inicio de la transacción**, constante hasta el COMMIT. Consecuencias reales:

- Dos filas escritas en la misma transacción comparten `updated_at` al milisegundo (afirmación 24).
  Por eso el orden del tablero vive en `posicion` y no se deriva de `updated_at`: la reescritura de
  D12 es **una** transacción y les daría a todas la misma marca.
- `updated_at` **no se puede escribir** desde la aplicación: el trigger es `BEFORE UPDATE` y pisa
  cualquier valor que le manden. Sembrar una fila con fecha vieja sólo se puede en el `INSERT`.
- Y un aviso para quien escriba el test: comparar `updated_at` antes y después de un UPDATE **dentro
  de la misma transacción** da FALLA con el trigger perfectamente instalado. Me pasó, dos veces. La
  forma correcta está en la afirmación 23.

### D14 — El CHECK `(columna = 'hecho') = (hecha_at IS NOT NULL)` no es adorno.

Sin la bicondicional, sacar una tarjeta de "hecho" de vuelta a "en progreso" sin limpiar `hecha_at` la
deja archivándose a los dos días mientras alguien la está trabajando. Verificado en las dos
direcciones (afirmaciones 19 y 20).

### D15 — Links y comentarios son tablas hijas, no columnas `jsonb`.

Los dos se editan de a uno desde la UI. Con un array `jsonb`, cada alta o baja es un
read-modify-write de la fila entera: **dos personas mirando la misma tarjeta al mismo tiempo — que es
literalmente lo que un tablero compartido provoca — se pisan y el segundo borra el link del primero
sin que nada falle.** Con filas, cada link es un INSERT o un DELETE que no toca a los demás.

El `jsonb` del repo (`ai_insights.cuerpo`, `orders.raw`) es para payloads opacos que se escriben una
vez y no se editan.

Y el CHECK `url ~* '^https?://.'`: un `javascript:` guardado ahí sale renderizado en un `<a href>` del
panel y se ejecuta con la sesión de quien lo abra. El CHECK es la defensa que queda si alguien se
olvida de validar en el server. Verificado (afirmaciones 25 y 26).

### D16 — El ROI del Resumen es `neto / gasto`, con equilibrio en 1.00×.

`lib/queries/overview.ts:438` ya expone `roas = brutoTotal / adSpend`, con el **bruto** (antes de
devoluciones, comisiones y costos).

El ROI nuevo usa el **neto**, que es lo que lo hace un número distinto y mejor. Equilibrio en 1.00×,
así que `1.25×` se lee de un vistazo como "25% arriba".

Descartado `resultEur / adSpendEur`, que también es "retorno sobre la inversión": su equilibrio cae en
0.00× y un múltiplo cuyo cero es el break-even no se lee. Además la ganancia en plata ya la dice el
widget de Resultado. La relación entre las dos lecturas es `roi = 1 + resultEur/gasto` y está afirmada
(afirmación 16) para que el comentario del código no tenga que mentir.

**`null` sin gasto cargado, nunca 0 ni Infinity.** Es la regla que `overview.ts:58-62` ya fija para
todos los campos nuevos: "no se puede calcular" y "vale cero" son cosas distintas. Los campos viejos
devuelven 0 por compatibilidad y **no se unifican**.

---

## 2. Arquitectura

```
                       ┌─────────────────────────────────────────────┐
  cookie panel_token   │ middleware.ts        (EDGE, sin base)       │
  ${id}.${ts}.${sig}   │  · firma + TTL 12 h                         │
        ─────────────► │  · NO chequea permisos (D3)                 │
                       │  · /api/** sin sesión → 401 JSON            │
                       │  · página sin sesión → 307 al login         │
                       └──────────────────┬──────────────────────────┘
                                          │
              ┌───────────────────────────┴────────────────────────────┐
              │                                                        │
   ┌──────────▼───────────────────────┐        ┌────────────────────────▼─────────┐
   │ app/(panel)/<seccion>/layout.tsx │        │ app/api/config/_lib.ts · guard() │
   │  requerirSeccion('finanzas')     │        │  mapa EXPLÍCITO ruta → sección   │
   │  (NODE, lee la base)             │        │  default: NEGAR (D5)             │
   └──────────┬───────────────────────┘        └────────────────────────┬─────────┘
              │                                                        │
              └────────────────────┬───────────────────────────────────┘
                                   ▼
                    ┌──────────────────────────────┐
                    │ lib/permisos.ts   CONGELADO  │
                    │  SECCIONES · MAPA_API        │
                    │  sesionActual()              │
                    │  requerirSeccion()           │
                    │  guardSeccion()              │
                    └──────────────┬───────────────┘
                                   ▼
                    ┌──────────────────────────────┐
                    │ lib/queries/usuarios.ts      │
                    │  usuarios + usuario_secciones│
                    └──────────────────────────────┘
```

El kanban es una pantalla más del panel y sigue el patrón que ya usan las diez existentes: server
component con `force-dynamic` que hace el fetch inicial, un único `XView` client que recibe
`initial={...}`, y las mutaciones por `fetch` a `/api/**`. Cero server actions para mutar datos (las
únicas dos del repo son el login y el logout).

---

## 3. Esquema — fuente de verdad

**El DDL canónico está en `_schema-030.sql` y `_schema-031.sql` de esta carpeta, ya ejecutado contra
una base real. T01 los copia tal cual a `db/migrations/030_usuarios.sql` y
`db/migrations/031_tareas.sql`. No se retipean.**

Cinco tablas nuevas, ningún `ALTER`, ningún `DROP`: el panel está en producción en los dos dominios y
las migraciones son aditivas.

```
usuarios              id · usuario · nombre · clave_hash · es_admin · debe_cambiar_clave
                      activo · ultimo_login_at · created_at · updated_at
usuario_secciones     (usuario_id, seccion)  ← PK compuesta, una fila por permiso
tareas                id · titulo · asignado_a → usuarios (RESTRICT) · notas · vence_el
                      creado_por → usuarios (RESTRICT) · columna · prioridad · posicion
                      hecha_at · archivada_at · created_at · updated_at
tarea_links           id · tarea_id → tareas (CASCADE) · url · etiqueta · posicion
tarea_comentarios     id · tarea_id → tareas (CASCADE) · usuario_id → usuarios (RESTRICT) · cuerpo
```

### El número de la migración depende de si commiteás la 029

`db/migrations/029_insights_ia.sql` **está sin commitear** en el árbol de trabajo (medido el
2026-09-08, junto con `lib/ia/`, `app/api/ia/`, el webhook de Hotmart y `tasks/pitch-ab/`). El plan
asume que la 029 se queda y las nuevas son **030 y 031**. Si por algún motivo se descarta, T01 tiene
que renumerar las dos y **parar y avisar**, no elegir solo: el runner ordena por nombre alfabético
(`scripts/migrate.ts:25`) y un hueco no rompe nada, pero dos archivos con el mismo prefijo sí.

### Los ON DELETE están elegidos uno por uno

| FK | Acción | Por qué |
|---|---|---|
| `usuario_secciones.usuario_id` | CASCADE | Un permiso no tiene vida propia. |
| `tareas.asignado_a` | **RESTRICT** | La columna es `NOT NULL`: una tarjeta sin dueño no es una tarea. Consecuencia: no se puede borrar un usuario con tarjetas. |
| `tareas.creado_por` | RESTRICT | Idem, y además es el rastro de quién la puso. |
| `tarea_links.tarea_id` | CASCADE | Parte de la tarjeta. |
| `tarea_comentarios.tarea_id` | CASCADE | Idem. |
| `tarea_comentarios.usuario_id` | RESTRICT | El comentario dice quién lo escribió y eso no puede quedar en NULL. |

Los tres RESTRICT juntos son lo que hace que **los usuarios se desactiven y no se borren** (D8 del
esquema). No hay endpoint de DELETE de usuarios; `activo = false` es el camino, igual que cerrar una
cuenta de finanzas en vez de borrarla (028 D10).

---

## 4. Contrato de `lib/permisos.ts` — CONGELADO

Lo declara T01 **completo**. T03, T04, T05 y T06 lo importan y **nadie más lo modifica**: es lo que
permite que las tres tasks de la ola 2 se escriban al mismo tiempo.

```ts
/** Las 8 pestañas del header. El vocabulario tiene que ser IGUAL al CHECK
 *  `usuario_secciones_valida` de la 030 — hay un test que lo compara. */
export const SECCIONES = ['resumen','embudo','ventas','anuncios','finanzas','leads','config','tareas'] as const;
export type Seccion = (typeof SECCIONES)[number];

/** Lo que el layout y las routes necesitan saber del que entró. */
export type Sesion = {
  usuarioId: number;
  usuario: string;
  nombre: string;
  esAdmin: boolean;
  debeCambiarClave: boolean;
  /** Las 8 si es admin (D11). Vacío si no se le otorgó nada. */
  secciones: readonly Seccion[];
  /** true = entró por el fallback de DASHBOARD_PASSWORD con la tabla vacía (D10). */
  esFallback: boolean;
};

/** Lee la cookie, valida la firma y CONSULTA LA BASE. null si no hay sesión
 *  usable (sin cookie, firma inválida, vencida, o usuario inactivo/borrado). */
export function sesionActual(): Promise<Sesion | null>;

export function puedeVer(sesion: Sesion, seccion: Seccion): boolean;

/** Para el layout de cada sección. NO devuelve: redirige.
 *   · sin sesión           → redirect('/')
 *   · debeCambiarClave     → redirect('/cambiar-clave')
 *   · sin permiso          → redirect(<la primera sección que sí puede ver>)
 *   · sin NINGUNA sección  → redirect('/sin-acceso')
 *  El redirect a la primera permitida y no un 403: alguien que entra por un link
 *  viejo tiene que caer en una pantalla que sí puede usar, no en un cartel. */
export function requerirSeccion(seccion: Seccion): Promise<Sesion>;

/** Mapa EXPLÍCITO de ruta de API a lo que hace falta para llamarla (D5).
 *  Las claves son pathnames exactos, sin barra final. */
export const MAPA_API: Record<string, readonly Seccion[] | 'admin' | 'publica'>;

/** El reemplazo de `guard(req)` para las routes. 401 sin sesión, 403
 *  `clave_pendiente` si debe cambiar la clave, 403 `forbidden` sin permiso,
 *  403 `forbidden` si la ruta NO está en MAPA_API (falla cerrado). */
export function guardSeccion(req: NextRequest): Promise<{ sesion: Sesion } | { respuesta: NextResponse }>;
```

`lib/auth.ts` conserva `PANEL_COOKIE_NAME`, `sessionCookieOptions`, `clearSessionCookieOptions`,
`getClientIp`, `checkLoginRateLimit`, `resetLoginRateLimit` **con la misma firma** — los importa
`app/page.tsx` y el layout, y cambiarlos sin necesidad multiplica el diff. Lo que cambia:
`signSessionToken(usuarioId)`, `verifySessionToken(token) → { usuarioId } | null`, y aparece
`hashearClave` / `verificarClave`. `verifyPassword` se conserva **sólo** para el fallback de D10.

## 5. Contrato de `lib/queries/tareas.ts` — CONGELADO

Lo declara T02. T05 y T06 lo importan.

```ts
export type Columna = 'por_hacer' | 'en_progreso' | 'en_revision' | 'hecho';
export type Prioridad = 'alta' | 'media' | 'baja';

export type Tarea = {
  id: number; titulo: string; notas: string | null;
  columna: Columna; prioridad: Prioridad; posicion: number;
  asignadoA: number; asignadoNombre: string;
  creadoPor: number | null; creadoPorNombre: string | null;
  venceEl: string | null;          // YYYY-MM-DD
  hechaAt: string | null;          // ISO
  createdAt: string; updatedAt: string;
  links: TareaLink[]; comentarios: TareaComentario[];
};
export type TareaLink = { id: number; url: string; etiqueta: string | null; posicion: number };
export type TareaComentario = { id: number; usuarioId: number; usuarioNombre: string; cuerpo: string; createdAt: string };

/** `asignadoA: null` = todas (el switch de "todas las tareas"). */
export function listarTareas(f: { asignadoA?: number | null; archivadas?: boolean }): Promise<Tarea[]>;
export function crearTarea(t: {...}, creadoPor: number | null): Promise<Tarea>;
export function editarTarea(id: number, cambios: {...}): Promise<Tarea>;
export function moverTarea(id: number, a: Columna, ordenDeLaColumna: number[]): Promise<void>;
export function reordenarColumna(columna: Columna, ordenDeIds: number[]): Promise<void>;
export function borrarTarea(id: number): Promise<void>;
export function agregarLink(...): Promise<TareaLink>;
export function borrarLink(id: number): Promise<void>;
export function comentar(tareaId: number, usuarioId: number, cuerpo: string): Promise<TareaComentario>;
/** Lo que corre el cron. Devuelve cuántas archivó. */
export function archivarHechasViejas(diasDeGracia?: number): Promise<number>;

export class TareaInputError extends Error {}
```

`moverTarea` y `reordenarColumna` reciben **la lista completa de ids** y reescriben `posicion` como
10, 20, 30… dentro de `tx()` (D12). Van con el `c` del callback de `tx`, **nunca con `q()`**: `q()`
toma otra conexión del pool y quedaría afuera de la transacción, con la transacción abierta
esperando — camino directo a un deadlock.

Quién puede editar qué **no se decide acá**: lo decide el route (T05 §4), porque la capa de datos no
conoce la sesión. La regla es: un no-admin puede **crear** cualquier tarea y **editar sólo las que
tiene asignadas**; el admin edita todas. Comentar puede cualquiera en cualquier tarjeta.

## 6. Contrato de las routes de tareas — CONGELADO

Lo declara T05. T06 programa contra esto sin esperarlo.

```
GET    /api/tareas?asignado=<id|todas>&archivadas=0|1   → { ok, tareas: Tarea[] }
POST   /api/tareas                                       → { ok, tarea }
PATCH  /api/tareas                { id, ...cambios }     → { ok, tarea }
DELETE /api/tareas?id=<id>                               → { ok }
POST   /api/tareas/mover  { id, columna, orden: number[] } → { ok }
POST   /api/tareas/links  { tareaId, url, etiqueta? }    → { ok, link }
DELETE /api/tareas/links?id=<id>                         → { ok }
POST   /api/tareas/comentarios { tareaId, cuerpo }        → { ok, comentario }
```

Sobre de error, igual que el resto del panel:
`{ ok:false, error:'unauthorized'|'forbidden'|'clave_pendiente'|'invalid_payload'|'unknown_tarea', detail?: string }`
con 401 / 403 / 400 / 404. Éxito siempre 200, **no 201** (es la convención del repo, ver
`app/api/finanzas/cuentas/route.ts`).

---

## 7. Dependencias y olas de paralelismo

```
OLA 1  (UNA sola task, corre sola)
  └── T01  Fundación de identidad     migraciones + auth + permisos + queries/usuarios
                                      + middleware + seed + package.json
        ▲ COMPUERTA: la ola 2 no arranca hasta que la verificación de T01 pasa.

OLA 2  (tres agentes, cero archivos en común)
  ├── T02  Capa de datos de tareas    lib/queries/tareas.ts
  ├── T03  Los guards                 layouts + guard() + las 7 routes inline + Nav
  └── T04  Login, cambio de clave y pantalla de Usuarios

OLA 3  (tres agentes)
  ├── T05  API de tareas              app/api/tareas/**
  ├── T06  UI del kanban              app/(panel)/tareas/**
  └── T07  ROI + cron + deploy + registro.md
```

| Task | Depende de | Bloquea | Paralelo con |
|---|---|---|---|
| T01 | nada | **todas** | nada. Corre sola. |
| T02 | T01 (tabla `usuarios`, tipo `Sesion`) | T05, T06, T07 | T03, T04 |
| T03 | T01 (`lib/permisos.ts` completo) | nada | T02, T04 |
| T04 | T01 (`lib/queries/usuarios.ts`, `hashearClave`) | nada | T02, T03 |
| T05 | T02 (importa el contrato de §5) | nada | T06, T07 |
| T06 | T02 (importa los tipos) · §6 congelado | nada | T05, T07 |
| T07 | T01 (el seed, para el deploy) | nada | T05, T06 |

**T01 es una compuerta de verdad, no una formalidad.** Cambia el formato de la cookie en dos archivos
con dos primitivas distintas. Si su verificación no pasa, el panel no deja entrar a nadie y las cinco
tasks siguientes se escriben contra un cimiento roto. **Si la afirmación 7 de
`_verificacion-sesion.mjs` falla en el ambiente del agente (los dos runtimes firmando distinto), pará
el proyecto y avisá**: el diseño entero apoya en eso.

**T05 y T06 son paralelas aunque T06 le pegue al endpoint de T05**, porque §6 congela el contrato. Si
T06 termina antes, su refetch da 404 hasta que T05 mergee y la primera pintura (que viene del server)
funciona igual — es el mismo razonamiento que usó el plan de pitch-ab.

**`npm run build` no da verde hasta que la ola 3 esté completa, y eso es esperado.** T03 agrega la
pestaña Tareas al nav apuntando a `/tareas`, que no existe hasta T06. No hay que "arreglarlo".

**No deployes entre olas.** Entre la 2 y la 3 hay una pestaña que da 404 y el kanban a medias.

---

## 8. Ownership de archivos — regla anti-colisión

**Un archivo tiene exactamente un dueño.** Si un task necesita cambiar un archivo de otro, para y
avisa: no lo edita.

| Task | Archivos que puede crear o modificar |
|---|---|
| T01 | `db/migrations/030_usuarios.sql`, `db/migrations/031_tareas.sql`, `lib/auth.ts`, `lib/auth.test.ts`, `lib/permisos.ts`, `lib/permisos.test.ts`, `lib/queries/usuarios.ts`, `lib/queries/usuarios.test.ts`, `middleware.ts`, `middleware.test.ts`, `scripts/seed-usuarios.ts`, `package.json`, `.env.example` |
| T02 | `lib/queries/tareas.ts`, `lib/queries/tareas.test.ts` |
| T03 | `app/(panel)/layout.tsx`, `app/(panel)/resumen/layout.tsx`, `app/(panel)/embudo/layout.tsx`, `app/(panel)/ventas/layout.tsx`, `app/(panel)/finanzas/layout.tsx`, `app/(panel)/leads/layout.tsx`, `app/(panel)/config/layout.tsx`, `app/(panel)/tareas/layout.tsx`, `app/(panel)/anuncios/layout.tsx`, `app/api/config/_lib.ts`, `app/api/data/pitch/route.ts`, `app/api/data/funnel/route.ts`, `app/api/data/overview/route.ts`, `app/api/data/sales/route.ts`, `app/api/data/leads/route.ts`, `app/api/data/ads/route.ts`, `app/api/ads/acciones/route.ts`, `app/api/rutas-mapeadas.test.ts`, `components/Nav.tsx` |
| T04 | `app/page.tsx`, `app/cambiar-clave/page.tsx`, `app/sin-acceso/page.tsx`, `app/api/usuarios/route.ts`, `app/api/usuarios/route.test.ts`, `app/api/usuarios/clave/route.ts`, `app/(panel)/config/ConfigView.tsx`, `app/(panel)/config/sections/UsuariosSection.tsx` |
| T05 | `app/api/tareas/route.ts`, `app/api/tareas/route.test.ts`, `app/api/tareas/mover/route.ts`, `app/api/tareas/links/route.ts`, `app/api/tareas/comentarios/route.ts` |
| T06 | `app/(panel)/tareas/page.tsx`, `app/(panel)/tareas/TableroView.tsx`, `app/(panel)/tareas/Columna.tsx`, `app/(panel)/tareas/TarjetaTarea.tsx`, `app/(panel)/tareas/DetalleTarea.tsx`, `app/(panel)/tareas/prioridad.ts`, `app/(panel)/tareas/prioridad.test.ts`, `app/(panel)/tareas/tablero.test.ts` |
| T07 | `lib/queries/overview.ts`, `lib/widgets/catalogo-resumen.tsx`, `scripts/archivar-tareas.ts`, `deploy/cron.panel`, `deploy/deploy.sh`, `COMO-DEPLOYAR.md`, `registro.md` |

Tres aclaraciones sobre esa tabla:

- **`app/(panel)/anuncios/layout.tsx` ya existe** y T03 le agrega tres líneas adentro. Es el único de los
  ocho layouts de sección que no es un archivo nuevo.
- **`app/(panel)/tareas/layout.tsx` es de T03, no de T06.** Es el guard, no la pantalla.
- **El modal NO se muda.** T06 importa `Modal` desde `@/app/(panel)/finanzas/Modal` tal como está.
  Mudarlo a `components/` obligaría a editar `FinanzasView.tsx` y sus secciones, que no son de nadie en
  este módulo y además están sin commitear. Queda anotado en P-07.

**Nadie toca**: `lib/queries/funnel.ts`, `lib/queries/sales.ts`, `lib/queries/saldo.ts`,
`lib/queries/finance.ts`, `lib/ingest/*`, `lib/orders/*`, `lib/ads/*`, `lib/fx*.ts`,
`components/ui.tsx`, `tailwind.config.ts`, `app/globals.css`, `app/api/ingest/`,
`app/api/webhooks/*`, `db/migrations/001` a `029`, y nada de `testfunnel`.

### Las dos excepciones declaradas

**1. `package.json` lo toca sólo T01**, y agrega los dos scripts de una vez —
`usuarios:seed` **y** `tareas:archivar` — aunque `scripts/archivar-tareas.ts` lo escribe T07 y todavía
no exista. Un script de npm que apunta a un archivo inexistente no rompe el build; dos agentes
editando el manifiesto sí.

**2. `components/Nav.tsx` y `app/(panel)/layout.tsx` los toca la MISMA task (T03)**, aunque el nav sea
presentación y el layout sea el guard. El layout le pasa `seccionesPermitidas` al Nav y el Nav lo
consume: si fueran dos dueños, el primero que mergee deja el build en rojo con un prop que el otro no
acepta.

### El árbol de trabajo ya está sucio antes de empezar

Medido el **2026-09-08**. `git status` muestra sin commitear, entre otras cosas:

- `db/migrations/029_insights_ia.sql`, `lib/ia/`, `app/api/ia/`, `components/PanelInsight.tsx`,
  `scripts/generar-insights.ts` — el módulo de insights de IA, completo pero sin commit.
- `app/api/webhooks/hotmart/`, `lib/orders/hotmart.ts` — el puente de Hotmart.
- `lib/queries/reconciliacion.ts` y sus dos tests.
- `tasks/pitch-ab/` entera.
- **`lib/queries/overview.ts` y `lib/widgets/catalogo-resumen.tsx` modificados**, y son los dos
  archivos que T07 tiene que editar para el ROI.
- `package.json`, `deploy/cron.panel`, `.env.example`, `registro.md` modificados — los tres primeros
  son de T01/T07.

**Antes de largar T01, commiteá o guardá todo eso.** No es una recomendación de higiene: T01 edita
`package.json` y `.env.example`, y T07 edita `overview.ts` y `catalogo-resumen.tsx`, los cuatro con
cambios ajenos encima. Si algo sale mal no hay forma limpia de revertir sólo lo del agente.

---

## 9. Criterios de aceptación globales

Un task no está listo hasta que todo esto pasa.

1. **`npm run build` sin errores.** TypeScript en `strict: true`. (Salvo el hueco declarado de §7
   entre olas.)
2. **`npm test` verde.** Los tests que necesitan base se saltan solos sin `DATABASE_URL`; eso cuenta
   como verde, pero el dueño de un task con SQL **tiene que correrlos con base** al menos una vez.
3. **Ninguna query concatena valores.** Todo va como `$1, $2`.
4. **Nada de permisos se decide en el cliente.** Un `fetch` desde la consola del browser con la cookie
   de nahuel a `/api/config/settings` tiene que dar **403**. Está en el checklist de T07 como `curl`.
5. **El default de una ruta sin mapear es NEGAR**, y hay un test que enumera
   `app/api/**/route.ts` y falla si aparece una que no esté en `MAPA_API` ni declarada pública.
6. **Una clave nunca viaja en un query param** ni se loguea. Ni la vieja ni la nueva ni el hash.
7. **El mensaje de error del login es genérico**, como hoy: no distingue "no existe ese usuario" de
   "clave mala" de "rate limit". `app/page.tsx:141-154` explica por qué y ese razonamiento no cambia
   porque ahora haya usuarios.
8. **Denominador 0 devuelve `null` en los campos nuevos**, nunca `NaN` ni `Infinity`. Vale para el ROI
   y para cualquier tasa del kanban.
9. **Cero literales de color.** Sólo tokens (`bad-500`, `warn-500`, `neutral-700`…). Hay un test que
   lo vigila (`components/ui.tokens.test.ts`) y `components/ui.tsx` no se toca.
10. **Las tarjetas arrastrables no llevan animación CSS de `transform`.** Lo explica
    `app/(panel)/layout.tsx:120-133`: las animaciones ganan a los estilos inline en la cascada y
    pisarían el `transform` de dnd-kit. La clase `reveal` va a nivel de página, nunca en los items.
11. **Idioma castellano** en comentarios, nombres de UI y mensajes. Los comentarios explican **por
    qué**, con la alternativa descartada cuando la hubo.
12. **Migraciones aditivas.** Sin `DROP`, sin cambios de tipo, sin reescrituras. Está en producción en
    dos dominios.

### Verificación de que el módulo entero funciona

```bash
# 1. Migraciones aplicadas e idempotentes
npm run db:migrate && npm run db:migrate
psql "$DATABASE_URL" -f tasks/usuarios-y-tareas/_verificacion-030-031.sql
# esperado: 28 PASA, cero FALLA, y los conteos del final iguales a los del principio

# 2. Sesión, hash y aritmética del ROI
node tasks/usuarios-y-tareas/_verificacion-sesion.mjs
# esperado: 16 PASA y exit 0

# 3. Build y tests
npm run build && npm test

# 4. El circuito completo, con una base EFÍMERA (no toca tu base de desarrollo)
bash tasks/usuarios-y-tareas/_verificacion-e2e.sh
# esperado: los 9 pasos en PASA.
# Antes de que T01 exista, los pasos 0 a 5 dan PASA y los 6 a 9 dicen N/A con el
# motivo — a propósito NO dicen PASA. Ese es el estado verificado hoy.

# 5. Para probar los 403 sin depender del login del browser (T03 y T05 lo usan):
node tasks/usuarios-y-tareas/_cookie.mjs 2
# esperado: un token de 3 campos `2.<13 dígitos>.<64 hex>`
```

---

## 10. Estado real del sistema, para que nadie se sorprenda

Medido el **2026-09-08**.

- **El panel está en producción en dos dominios** desde el mismo `origin/main`:
  `panel.hilvanapp.com` (`/srv/panel`, base `panel`, EUR) y `panel.infinixapp.com`
  (`/srv/panel-infinix`, base `panel_infinix`, USD). El deploy hace `git reset --hard origin/main`,
  así que **nada se arregla a mano en una instancia**: el próximo deploy lo revierte.
- **El deploy de infinix vive FUERA del repo** (`/srv/panel-infinix/deploy.sh`). No lo puede editar
  ninguna task. Consecuencia declarada: el `npm run usuarios:seed` de esa instancia hay que correrlo
  **a mano**. Está en el checklist de T07.
- **No hay Postgres corriendo en esta máquina.** colima está apagado y `postgresql@16` de Homebrew
  está instalado sin arrancar. El DDL de este plan se verificó con un clúster efímero
  (`initdb` en `/tmp`, puerto 55432) al que se le aplicaron las 29 migraciones reales. Para
  reproducirlo, la receta está en `_verificacion-e2e.sh` §0.
- **La migración 021 aborta en una base nueva** si no hay una cuenta publicitaria activa
  (`021 abortada: no existe ninguna Cuenta_Activa`). Para armar la base scratch hay que insertar un
  placeholder en `ad_accounts` entre la 020 y la 021. No afecta a las migraciones de este módulo, pero
  sí a cualquiera que quiera reproducir la verificación.
- **`@dnd-kit/core 6.3.1` y `@dnd-kit/sortable 10.0.0` ya están instalados** y exportan
  `useDroppable`, `DragOverlay`, `closestCorners` y `pointerWithin`: todo lo que necesita un kanban de
  varias columnas, sin instalar nada. Lo que el repo usa hoy (`components/WidgetGrid.tsx`,
  `ConfiguradorColumnas.tsx`, `TablaAds.tsx`) es sólo `useSortable` dentro de **un** contenedor, así
  que arrastrar **entre** columnas es terreno nuevo en este repo.
- **El logout no revoca nada.** Borra la cookie (`maxAge: 0`) y nada más. Un token robado vale hasta
  que se venza el TTL de 12 h, con o sin logout. No cambia con este módulo. Ver P-02.
- **El rate limit del login es in-memory** (`globalThis.__panelRateLimit`), 5 intentos / 15 min por
  IP. Con una sola instancia de PM2 alcanza; si algún día se balancea, el límite efectivo se
  multiplica. Sigue igual.

---

## 11. Preguntas abiertas

### P-01 — El layout de widgets sigue siendo global y ahora sí se va a notar

`settings.ui_layout_resumen` y `ui_layout_ventas` son **una fila para todo el panel**. La migración
017 lo anotó cuando todavía era teórico (`017_rediseno_ui.sql:149-155`): *"si dos personas usan el
panel, el que guarda último gana y el otro ve cambiar su pantalla sin haberla tocado"*.

**Decisión: se deja así en esta tanda** (pedido explícito). Con dos usuarios de verdad esto pasa de
nota al pie a algo que va a aparecer. Hacerlo por usuario es cambiar la clave de esas dos filas a
`ui_layout_resumen:<usuarioId>` y migrar el valor existente al del admin — un módulo chico y aparte.

Lo que **sí** hace este plan: T04 pone la advertencia en la pantalla de Usuarios, porque es donde
alguien se va a preguntar por qué.

### P-02 — Desactivar un usuario no mata su sesión en el acto

El permiso se lee de la base en cada request (D3), así que **quitarle una pestaña es instantáneo** y
**desactivarlo también** (`sesionActual()` devuelve `null` si `activo = false`). Eso cubre el caso
real.

Lo que NO existe es revocación de un token robado: no hay tabla de sesiones ni denylist, y el logout
sólo borra la cookie. Si hace falta echar a alguien de verdad y ya, la única herramienta es **rotar
`PANEL_SESSION_SECRET`**, que invalida las sesiones de todos y obliga a que todos vuelvan a entrar.

**Decisión: se acepta y no se construye nada.** Está documentado acá y en el docblock de
`lib/auth.ts` para que quien lo necesite sepa cuál es la palanca.

### P-03 — El segundo usuario de infinix no está definido

hilvanapp: `lucho` (admin) + `nahuel`. infinix: `Ivan` (admin) + **falta decidir**.

`scripts/seed-usuarios.ts` crea el admin desde `PANEL_ADMIN_USUARIO` y acepta usuarios adicionales por
argumento. Si no se le pasa ninguno, crea sólo el admin. **No bloquea nada**: se agrega desde la
pantalla de Usuarios cuando se sepa.

### P-04 — La clave por defecto `123456` es una ventana de exposición real

Ver D8. **No es una pregunta técnica, es un riesgo aceptado a pedido.** Queda acá para que quede
escrito: el día del deploy, las dos claves se cambian en el primer login y no "cuando se pueda". Si
pasan días, cualquiera que sepa el usuario entra.

La alternativa que se descartó (un centinela imposible de producir + un script obligatorio, como
`PENDING_SET_INGEST_KEY_*`) sigue disponible y es media hora de trabajo si se cambia de opinión.

### P-05 — Este módulo deja gratis el mecanismo para apagar Anuncios en infinix, y no se usa

Hoy **no existe** ningún feature flag en el repo: la pestaña `/anuncios` se renderiza igual en las dos
instancias y lo único que no corre en infinix es el worker `panel-reglas` (lo decide su `deploy.sh`,
que vive fuera del repo).

Con `usuario_secciones`, no darle `anuncios` a nadie en infinix apaga la pestaña de hecho.

**Decisión: no se toca** (pedido explícito, respuesta 12). Y hay una razón además del pedido: mezclar
"permisos por persona" con "módulos por instancia" en la misma tabla es lo que después deja a alguien
sin poder contestar por qué una pestaña está apagada. Si algún día se quiere, va por su propio
mecanismo.

### P-07 — El único modal accesible del panel sigue viviendo bajo `finanzas/`

`app/(panel)/finanzas/Modal.tsx` es el único modal del repo con focus trap, Escape, scroll lock y
devolución de foco. T06 lo importa desde ahí para el detalle de una tarjeta, así que pasa a ser un
componente compartido que vive en la carpeta de otra sección.

**Decisión: se deja donde está en esta tanda.** Mudarlo a `components/Modal.tsx` obliga a editar
`FinanzasView.tsx` y sus secciones para actualizar el import, y esos archivos no son de ninguna task de
este módulo **y están modificados sin commitear** (medido el 2026-09-08). Un agente tocando imports de
una sección ajena con cambios de otro encima es el escenario que la regla de ownership existe para
evitar.

Cuando `finanzas/` esté limpio, la mudanza son tres líneas de import y una de `git mv`.

### P-06 — El ROI se agrega al widget, pero nadie decidió si reemplaza al ROAS

Van a quedar los dos números en Resumen: `ROAS` (bruto ÷ gasto, ya existe) y `ROI` (neto ÷ gasto,
nuevo). Son distintos a propósito (D16) y el `hint` de cada widget dice su fórmula.

Queda anotado que **dos múltiplos parecidos en la misma pantalla se pueden confundir**. Si después de
usarlo un par de semanas el ROAS no se mira, sacarlo es borrar un widget del catálogo. No se decide
ahora.
