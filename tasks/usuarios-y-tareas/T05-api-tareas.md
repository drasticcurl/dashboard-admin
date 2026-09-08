# T05 — API de tareas

- **Depende de:** T02 (`lib/queries/tareas.ts`, congelado — lo importás, no lo modificás) y T01
  (`guardSeccion`, el tipo `Sesion`).
- **Bloquea:** nada.
- **Se puede correr en paralelo con:** T06 y T07.
- **Repo:** `dashboard-admin` (rama `main`).
- **Archivos que este task puede tocar:**
  - `app/api/tareas/route.ts` · `route.test.ts` (nuevos)
  - `app/api/tareas/mover/route.ts` (nuevo)
  - `app/api/tareas/links/route.ts` (nuevo)
  - `app/api/tareas/comentarios/route.ts` (nuevo)

  Nada más. **No toques `lib/permisos.ts`** (T01) ni `lib/queries/tareas.ts` (T02) ni
  `app/api/config/_lib.ts` (T03).

---

## 1. Objetivo

Implementar el contrato congelado de **§6 del plan**, que T06 ya está programando en paralelo. La forma
de las respuestas **no se negocia**.

Y sos el único lugar donde vive **quién puede editar qué**: la capa de datos no conoce la sesión a
propósito (T02 §1) y el guard sólo sabe de secciones. La regla de autorización a nivel fila es tuya.

---

## 2. Antes de escribir, leé `app/api/finanzas/cuentas/route.ts` completo

Es el molde: 150 líneas con GET / POST / PATCH / DELETE. **No lo edites, copiale la forma.**

**Qué copiar:**

- El preámbulo: `export const runtime = 'nodejs'` y `export const dynamic = 'force-dynamic'` a nivel
  módulo (el `pg` no corre en Edge), y el guard como **primerísima línea de cada método, GET incluido**.
- **zod con `safeParse` sobre `await req.json().catch(() => null)`.** El `.catch(() => null)` es lo que
  convierte un body malformado en el mismo 400 que un campo inválido, en vez de un 500.
- El sobre: `{ ok:true, <recurso>: ... }` con 200 (**no 201**), y
  `{ ok:false, error:'<snake_case>', detail:'<castellano>' }` con el `detail` saliendo de
  `parsed.error.issues[0]?.message`.
- **Los errores de Postgres NO se traducen acá.** `if (err instanceof TareaInputError) return json(400,
  ...)`, y todo lo demás `throw err`. El mapeo del SQLSTATE vive en `lib/queries/tareas.ts` (T02).
- **`.nullable().optional()`** para distinguir "poné null" de "no lo toques" (líneas 46-48). Lo vas a
  necesitar en `notas` y en `venceEl`: mandar `null` es borrar la nota, no mandar el campo es dejarla.
  Con `.optional()` solo, no hay forma de borrar una nota.
- El patrón de **devolver el conteo de lo que una operación destructiva va a romper**, antes de
  romperlo, para que la UI pueda ponerlo en la confirmación.

**Qué NO copiar:** la lógica de `saldosAfectados` y `contarSaldosDe`. Acá el DELETE de una tarjeta se
lleva sus links y comentarios en cascada y eso es todo; el conteo que sí vale la pena devolver es el de
comentarios (borrar una tarjeta con 8 comentarios borra la conversación).

---

## 3. El guard y las dos capas de permiso

Cada método arranca con:

```ts
const g = await guardSeccion(req);
if ('respuesta' in g) return g.respuesta;
const { sesion } = g;
```

Eso resuelve **la sección** (`tareas`). Lo que **no** resuelve es la fila, y es lo de §4.

---

## 4. Quién puede editar qué

La regla, tal como se pidió:

| Acción | Admin | No admin |
|---|---|---|
| Ver (con el switch de persona o todas) | todas | **todas** |
| Crear | sí, asignando a cualquiera | **sí, asignando a cualquiera** |
| Editar / mover / borrar | todas | **sólo las que tiene asignadas** |
| Comentar | todas | **todas** |
| Agregar o borrar links | todas | sólo las asignadas a él |

**Las cinco cosas que hay que hacer bien:**

1. **La comprobación va DESPUÉS de leer la tarjeta y ANTES de escribir.** Necesitás el `asignado_a`
   actual, así que hay una lectura de por medio. No se puede hacer con un `WHERE asignado_a = $1` en el
   UPDATE: eso devolvería 0 filas y no hay forma de distinguir "no existe" de "no es tuya", que son un
   404 y un 403.
2. **Reasignar es editar.** Un no-admin puede cambiar el `asignadoA` de una tarjeta **que es suya** —
   incluso pasándosela a otro, y eso es correcto (delegar). Lo que no puede es tocar una que ya es de
   otro. Verificá contra el `asignado_a` **de la base**, nunca contra el que viene en el payload.
3. **Comentar no requiere ser el dueño**, a propósito: es la única forma que tiene el admin de pedir algo
   sobre una tarjeta ajena, y al revés. Y el `usuarioId` del comentario sale **de la sesión**, nunca del
   body. Un comentario firmable por el cliente es un comentario que se puede poner en boca de otro.
4. **`creado_por` sale de la sesión**, y va `null` cuando `sesion.esFallback` (la sesión del
   `DASHBOARD_PASSWORD` con la tabla vacía tiene `usuarioId: 0`, que no existe en `usuarios` y haría
   fallar el FK con un 23503). Es exactamente para eso que la columna es nullable.
5. **`mover` verifica el dueño de la tarjeta que se mueve, no de las de `orden`.** La lista de `orden`
   contiene toda la columna, incluidas tarjetas de otros; reordenar la columna es una consecuencia
   inevitable de mover la propia. Si exigieras ser dueño de todas, un no-admin no podría mover ninguna
   tarjeta a una columna compartida. **Comentalo en el archivo**, porque parece un agujero y no lo es:
   `posicion` es orden de presentación, no contenido.

El 403 devuelve `{ ok:false, error:'forbidden', detail:'esa tarea está asignada a otra persona' }`. El
`detail` con el motivo real: acá no hay nada que filtrar (el usuario ya ve la tarjeta y ya ve de quién
es), y un 403 mudo manda a alguien a mirar la consola.

---

## 5. Los cuatro routes

**`/api/tareas`** — GET (`?asignado=<id|todas>&archivadas=0|1`), POST, PATCH, DELETE.

- `asignado` acepta un id numérico o el literal `todas`. **Sin el parámetro, el default es `todas`**: es
  un tablero compartido y esconder por default es lo contrario de lo que se pidió.
- `asignado` inválido (no numérico y distinto de `todas`) → 400. **No lo trates como `todas`**: un typo
  en el cliente mostraría todo en silencio.
- DELETE devuelve `{ ok, comentariosBorrados }` para que la confirmación de T06 pueda decir el número.

**`/api/tareas/mover`** — POST `{ id, columna, orden: number[] }`.

- `orden` con `z.array(z.number().int().positive()).min(1)`, y validá que **contenga a `id`**.
- Un `orden` vacío o sin el `id` → 400 con el `detail` diciendo qué esperaba.

**`/api/tareas/links`** — POST `{ tareaId, url, etiqueta? }`, DELETE `?id=`.

- **Validá la URL con zod (`z.string().url()`) Y con una whitelist de protocolo `http`/`https`.**
  `z.string().url()` **acepta `javascript:alert(1)`** — es una URL válida según el WHATWG. El CHECK de la
  031 lo rechazaría igual, pero como un 500 en vez de un 400 legible. **Los dos chequeos, no uno.**
- `etiqueta` con `.max(80)`: es texto de un chip en una tarjeta.

**`/api/tareas/comentarios`** — POST `{ tareaId, cuerpo }`.

- `cuerpo` con `.trim().min(1).max(4000)`. Sin el `.trim()`, un cuerpo de espacios pasa el `min(1)` de
  zod y lo rechaza el CHECK de la base, otra vez como 500.
- Sin PATCH ni DELETE de comentarios: no se pidió, y un comentario editable en un tablero compartido es
  una conversación que cambia de significado después de leída. Anotalo si te parece que hace falta.

---

## 6. Tests — `app/api/tareas/route.test.ts`

Mockeá la sesión con el patrón de `app/api/data/ads/route.test.ts:82-85` (`vi.mock` con
`importOriginal`, sobreescribiendo lo justo) para no atar la suite a `DASHBOARD_PASSWORD`:

```ts
vi.mock('@/lib/permisos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/permisos')>();
  return { ...actual, guardSeccion: vi.fn(async () => ({ sesion: sesionDePrueba })) };
});
```

Con `sesionDePrueba` mutable entre tests, para poder cambiar de admin a no-admin sin remockear.

1. Sin sesión → 401 (mockeando `guardSeccion` para que devuelva la respuesta).
2. Sin la sección `tareas` → 403.
3. `debeCambiarClave` → 403 `clave_pendiente`, **no** `forbidden`. Son dos cosas y el cliente las
   distingue.
4. POST con lo mínimo → 200 y la tarjeta con los defaults.
5. POST sin título o sin asignado → 400 `invalid_payload` con el `detail` en castellano.
6. POST con un body que no es JSON → 400, **no 500** (es lo que prueba el `.catch(() => null)`).
7. **Un no-admin editando una tarjeta ajena → 403** con el `detail` explicando por qué.
8. **Un no-admin editando la suya → 200.**
9. **Un no-admin creando una tarjeta asignada a otro → 200** (crear no está restringido).
10. **Un no-admin reasignándole a otro una tarjeta suya → 200**; una ajena → 403.
11. Un admin editando cualquiera → 200.
12. Editar una tarjeta que no existe → **404**, no 403. El orden de los chequeos importa.
13. `notas: null` borra la nota; **sin el campo, no la toca.** Los dos casos, en dos afirmaciones.
14. `mover` con `orden` que no contiene el `id` → 400.
15. **Un link `javascript:alert(1)` → 400 `invalid_payload`, NO 500.** Es la afirmación que prueba que no
    te apoyaste sólo en `z.string().url()`.
16. Un comentario con `usuarioId` en el body → **se ignora**, y el comentario queda a nombre de la
    sesión.
17. `cuerpo: '   '` → 400, no 500.
18. `?asignado=pepe` → 400. `?asignado=todas` y sin el parámetro → los dos traen todas.

---

## 7. Verificación

```bash
# 1. Build y tests
npm run build && npm test -- app/api/tareas
# esperado: 18 tests verdes

# 2. El circuito real (npm run dev). Las cookies se fabrican, es más rápido que
#    copiarlas del devtools:
#      LUCHO=$(node tasks/usuarios-y-tareas/_cookie.mjs 1)
#      NAHUEL=$(node tasks/usuarios-y-tareas/_cookie.mjs 2)
curl -s -H "Cookie: panel_token=$LUCHO" 'http://127.0.0.1:3005/api/tareas' | head -c 120
# esperado: {"ok":true,"tareas":[...]}

curl -s -X POST -H "Cookie: panel_token=$LUCHO" -H 'content-type: application/json' \
  -d '{"titulo":"Probar el kanban","asignadoA":<id-nahuel>,"prioridad":"alta"}' \
  http://127.0.0.1:3005/api/tareas
# esperado: {"ok":true,"tarea":{...,"columna":"por_hacer","prioridad":"alta",...}}

# 3. LA AFIRMACIÓN QUE MÁS IMPORTA: nahuel no edita lo ajeno
curl -s -X PATCH -H "Cookie: panel_token=$NAHUEL" -H 'content-type: application/json' \
  -d '{"id":<una-de-lucho>,"titulo":"pisada"}' http://127.0.0.1:3005/api/tareas
# esperado: 403 {"ok":false,"error":"forbidden","detail":"esa tarea está asignada a otra persona"}
psql "$DATABASE_URL" -tAc "SELECT titulo FROM tareas WHERE id=<una-de-lucho>"
# esperado: el título ORIGINAL. Si dice "pisada", el 403 salió después de escribir.

# 4. La suya sí
curl -s -X PATCH -H "Cookie: panel_token=$NAHUEL" -H 'content-type: application/json' \
  -d '{"id":<la-de-nahuel>,"columna":"en_progreso"}' http://127.0.0.1:3005/api/tareas
# esperado: 200, y hecha_at sigue en null (no pasó a 'hecho')

# 5. El javascript: no llega a la base
curl -s -X POST -H "Cookie: panel_token=$LUCHO" -H 'content-type: application/json' \
  -d '{"tareaId":<id>,"url":"javascript:alert(1)"}' http://127.0.0.1:3005/api/tareas/links
# esperado: 400 invalid_payload. Si es 500, te apoyaste en el CHECK de la base.

# 6. hecha_at se pone y se saca solo
curl -s -X POST -H "Cookie: panel_token=$LUCHO" -H 'content-type: application/json' \
  -d '{"id":<id>,"columna":"hecho","orden":[<id>]}' http://127.0.0.1:3005/api/tareas/mover
psql "$DATABASE_URL" -tAc "SELECT columna, hecha_at IS NOT NULL FROM tareas WHERE id=<id>"
# esperado: hecho|t
#    y moviéndola de vuelta a en_progreso:
# esperado: en_progreso|f

# 7. Sin sesión, nunca datos
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3005/api/tareas
# esperado: 401

# 8. Que no tocaste lo ajeno
git diff --stat -- lib/ 'app/(panel)/' app/api/config middleware.ts
# esperado: VACÍO
```

---

## 8. Cuándo parar

Terminaste cuando los 8 pasos pasan y los cuatro routes tienen **exactamente** la forma de §6 del plan.
T06 programó contra eso.

El paso 3 es el que no se puede saltear: un 403 que sale **después** de escribir es peor que no tener
el chequeo, porque parece que funciona.

**Pará y avisá** si:

- Algo de §6 no se puede implementar como está escrito. T06 lo está usando.
- Necesitás que `lib/queries/tareas.ts` reciba un `usuarioId`. **No**: T02 §1 explica por qué la capa de
  datos no conoce la sesión, y meterlo ahí deja la autorización repartida en dos lugares.
- La regla de §4 te parece que tiene un agujero. Puede tenerlo — pero es la regla que se pidió, así que
  anotala en §11 del plan antes de cambiarla.

**Anotá y seguí** si:

- Te parece que los comentarios deberían poder editarse o borrarse.
- Te parece que `listarTareas` debería paginar (ya está anotado en T02 §8).
