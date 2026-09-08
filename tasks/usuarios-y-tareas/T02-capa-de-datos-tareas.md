# T02 — Capa de datos del tablero de tareas

- **Depende de:** T01 (la tabla `usuarios`, la migración 031 y el tipo `Sesion`). **No arranques antes
  de que la verificación de T01 esté en verde.**
- **Bloquea:** T05 (importa las funciones), T06 (importa los tipos) y T07 (su cron llama a
  `archivarHechasViejas`).
- **Se puede correr en paralelo con:** T03 y T04.
- **Repo:** `dashboard-admin` (rama `main`).
- **Archivos que este task puede tocar:**
  - `lib/queries/tareas.ts` (nuevo)
  - `lib/queries/tareas.test.ts` (nuevo)

  Nada más. **No toques `lib/permisos.ts` ni `lib/queries/usuarios.ts`**: son de T01 y están
  congelados.

---

## 1. Objetivo

Implementar el contrato congelado de **§5 del plan maestro**. Sos de quien dependen las dos tasks de la
ola 3, así que ese contrato **no se negocia**: si algo no se puede implementar como está escrito, pará
y avisá.

Lo que esta capa **no** hace: decidir quién puede editar qué. Eso lo decide el route (T05 §4), porque
acá no hay sesión. La regla es que un no-admin crea cualquier tarea y edita sólo las suyas, y la
tentación va a ser meter un `usuarioId` de parámetro "por si acaso". No lo hagas: una capa de datos que
a veces filtra por usuario y a veces no es una capa que nadie puede razonar.

---

## 2. Antes de escribir, leé `lib/queries/saldo.ts` completo

Es el molde. No lo edites, copiale la forma.

**Qué copiar:**

- **`SaldoInputError` y cómo traduce los SQLSTATE de Postgres a castellano.** El route sólo hace
  `if (err instanceof ...)` y le pone un status; el mapeo del código vive acá. Vos necesitás
  `TareaInputError` para el `23514` (los CHECK de `columna`, `prioridad` y la bicondicional de
  `hecha_at`), el `23503` (asignar a un usuario que no existe) y el `23505`.
- Los helpers de conversión (`MONEY`, `MONEY_N`) y **`Number()` en los ids**: `pg` devuelve `bigint`
  como **string**, así que `tareas.id` llega como `"7"`. Sin el `Number()`, un `id === 7` del cliente
  no matchea nunca y las comparaciones de `posicion` hacen concatenación de strings.
- El mapeo snake_case → camelCase **a mano** en un `.map()` explícito. No hay mapper genérico en el
  repo y no es el lugar para inventarlo.
- El uso de `tx()` de `lib/db.ts` para lo multi-tabla.

**Qué NO copiar:**

- La idea de congelar valores al insertar (`toReportCurrency` y compañía). Acá no hay plata ni
  conversión: no hay nada que congelar.
- Los `::float8` de los agregados. `posicion` es `integer` y `pg` devuelve `int4` como número: casteo
  innecesario.

---

## 3. `listarTareas` — una query, tres tablas

El tablero necesita la tarjeta **con** sus links y sus comentarios. Tres queries separadas y un merge
en JS también funciona, pero son 3 round-trips por cada carga de pantalla y el `page.tsx` es
`force-dynamic`.

Hacelo con dos subconsultas correlacionadas que devuelvan `jsonb`:

```sql
SELECT t.*, ua.nombre AS asignado_nombre, uc.nombre AS creado_por_nombre,
       (SELECT COALESCE(jsonb_agg(jsonb_build_object(...) ORDER BY l.posicion, l.id), '[]'::jsonb)
          FROM tarea_links l WHERE l.tarea_id = t.id) AS links,
       (SELECT COALESCE(...) FROM tarea_comentarios c JOIN usuarios ... WHERE c.tarea_id = t.id) AS comentarios
  FROM tareas t
  JOIN usuarios ua ON ua.id = t.asignado_a
  LEFT JOIN usuarios uc ON uc.id = t.creado_por
 WHERE ...
```

**Las cuatro decisiones que hay que comentar en el archivo:**

**1. Subconsultas correlacionadas y NO un `JOIN` plano a `tarea_links`.** Una tarjeta con 3 links y 2
comentarios saldría 6 veces con un join, y cualquier `count` o cualquier `LIMIT` de la query pasa a
mentir. Es el mismo razonamiento que `lib/queries/funnel.ts:542-577`, y podés citarlo.

**2. `COALESCE(..., '[]'::jsonb)`.** Sin eso, una tarjeta sin links devuelve `NULL` y el `.map()` del
cliente tira. Una lista vacía es una lista, no la ausencia de una.

**3. `JOIN usuarios ua` (inner) para el asignado y `LEFT JOIN` para el creador.** `asignado_a` es
`NOT NULL` con FK, así que el inner join no puede perder filas — y si algún día perdiera una, es un
dato roto que **tiene que desaparecer de la pantalla en vez de mostrarse a medias**. `creado_por` sí es
nullable (las tarjetas del fallback de D10 y las de scripts), así que ahí `LEFT JOIN` y
`creadoPorNombre: null`.

**4. El `ORDER BY` es `posicion, id`** y no sólo `posicion`. Dos tarjetas pueden compartir `posicion`
mientras una reescritura está a mitad de camino, y sin el desempate el orden que ve el usuario cambia
entre dos refrescos sin que nadie haya tocado nada.

Filtros: `archivada_at IS NULL` salvo que pidan las archivadas, y `asignado_a = $1` si viene. El SQL
dinámico se arma empujando a un array de params y usando su `.length` para el número del placeholder
— **nunca** con template strings de valores.

---

## 4. `moverTarea` y `reordenarColumna` — la parte que se puede romper en silencio

Las dos reciben **la lista completa y ordenada de ids** de la columna afectada y reescriben `posicion`
como 10, 20, 30… (D12).

```ts
export function moverTarea(id: number, a: Columna, ordenDeLaColumna: number[]): Promise<void>;
```

**Las cinco cosas:**

1. **Todo dentro de un solo `tx()`**, y con el `c` del callback. **Nunca `q()` adentro de `tx`**: toma
   otra conexión del pool y queda fuera de la transacción, con la transacción abierta esperando —
   camino directo a un deadlock.
2. **`hecha_at` se maneja acá, no en el route.** Pasar a `hecho` → `hecha_at = now()`. Salir de `hecho`
   → `hecha_at = NULL`. El CHECK `(columna = 'hecho') = (hecha_at IS NOT NULL)` te va a rechazar el
   UPDATE si te olvidás de cualquiera de las dos (afirmaciones 19 y 20 de la verificación), así que el
   error va a salir — pero como un `23514` feo en vez de funcionar.
3. **Si ya estaba en `hecho` y se mueve dentro de la misma columna, `hecha_at` NO se toca.** Reordenar
   una tarjeta terminada no puede reiniciarle el reloj del archivado: son dos días desde que se
   terminó, no desde el último manoseo (D13).
4. **Validá que `ordenDeLaColumna` contenga a `id`** y que todos los ids existan y pertenezcan a la
   columna destino. Un cliente que manda una lista incompleta dejaría a las que faltan con la
   `posicion` vieja, o sea intercaladas de forma impredecible. `TareaInputError` con un mensaje que
   diga cuántos ids esperaba y cuántos llegaron.
5. **`UPDATE ... FROM unnest($1::bigint[]) WITH ORDINALITY`** en una sola sentencia, no un UPDATE por
   tarjeta en un loop. Con 30 tarjetas son 30 round-trips dentro de una transacción abierta.

---

## 5. `archivarHechasViejas`

Lo que corre el cron de T07. Un `UPDATE` y devuelve el conteo:

```sql
UPDATE tareas SET archivada_at = now()
 WHERE archivada_at IS NULL AND hecha_at IS NOT NULL
   AND hecha_at < now() - make_interval(days => $1)
```

- **El default es 2 días** y es un parámetro, no una constante embutida: el test necesita poder pasar 0
  para no esperar dos días.
- **`make_interval(days => $1)` y no `interval '$1 days'`.** Lo segundo no compila: un placeholder no
  se puede interpolar dentro de un literal de intervalo, y la tentación de resolverlo con
  concatenación de strings es exactamente lo que §9.3 del plan prohíbe.
- Devolvé `rowCount`. El cron lo loguea, y un cron que no dice cuántas tocó no se puede auditar.
- **Idempotente por el `archivada_at IS NULL`**: correrlo dos veces el mismo día archiva 0 la segunda.

---

## 6. Tests — `lib/queries/tareas.test.ts`

Con base, patrón de `lib/queries/reconciliacion.integracion.test.ts`: `process.loadEnvFile`,
`describe.skipIf(!dbAvailable)`, prefijo `test-tarea-` en los títulos, `cleanup()` en `beforeEach`
**y** `afterEach` (una corrida interrumpida deja basura y la siguiente lee de más).

Los usuarios de prueba se crean con `crearUsuario` de T01 y prefijo `test-usr-`. Borralos en el
cleanup **después** de las tareas: el FK es RESTRICT.

1. Crear con lo mínimo (título + asignado) → defaults `por_hacer` / `media`, resto `null`.
2. `listarTareas({})` trae `asignadoNombre` resuelto y `links: []`, `comentarios: []`.
3. Una tarjeta con 3 links y 2 comentarios aparece **una sola vez** y con las dos listas completas
   (la afirmación que prueba que no hay join plano).
4. `listarTareas({ asignadoA: X })` trae sólo las de X; con `null` trae todas.
5. Las archivadas no aparecen salvo `archivadas: true`.
6. Mover a `hecho` puebla `hecha_at`; sacarla lo limpia.
7. Reordenar dentro de `hecho` **no** cambia `hecha_at`.
8. `reordenarColumna` con la lista dada a mano deja las posiciones en 10, 20, 30 y el
   `listarTareas` en ese orden exacto.
9. Reordenar con un id que no es de esa columna → `TareaInputError`.
10. Reordenar con la lista incompleta → `TareaInputError`, y **las posiciones no cambiaron** (probá que
    la transacción hizo ROLLBACK, no que sólo devolvió el error).
11. Asignar a un usuario inexistente → `TareaInputError` (FK 23503), no un 500.
12. Columna o prioridad inválidas → `TareaInputError` (CHECK 23514).
13. `archivarHechasViejas(0)` archiva las que están en `hecho`; correrlo de nuevo archiva 0.
14. `archivarHechasViejas` **no** toca las que no están en `hecho`.
15. Borrar una tarjeta se lleva links y comentarios (CASCADE) y **no** toca al usuario.
16. Un link con `javascript:` → `TareaInputError`. (El CHECK está, pero el mensaje tiene que ser legible
    y esto prueba que la traducción existe.)
17. Dos tarjetas creadas en la misma transacción comparten `updated_at`: es el recordatorio de que
    `updated_at` **no ordena** nada (D13). Si esta afirmación te resulta rara, leé D13 completo.

---

## 7. Verificación

```bash
# 1. Sin base (no debería haber nada puro acá, pero que no explote al importar)
npm test -- lib/queries/tareas
# esperado: verde. Si dice "skipped" el describe, falta DATABASE_URL.

# 2. Con base — obligatorio al menos una vez
npm run db:migrate
npm test -- lib/queries/tareas
# esperado: 17 tests verdes, sin describes salteados

# 3. Las posiciones quedan como dice D12, a ojo
psql "$DATABASE_URL" -tAc "SELECT columna, posicion, titulo FROM tareas WHERE archivada_at IS NULL ORDER BY columna, posicion, id"
# esperado: dentro de cada columna, posicion en 10, 20, 30… sin repetidos ni huecos

# 4. Que la base quedó limpia después de los tests
psql "$DATABASE_URL" -tAc "SELECT count(*) FROM tareas t JOIN usuarios u ON u.id=t.asignado_a WHERE u.usuario LIKE 'test-usr-%'"
# esperado: 0

# 5. Tipos
npm run build
# esperado: exit 0 para lib/. Los errores de app/api/tareas y app/(panel)/tareas son
#           esperados hasta la ola 3.
```

---

## 8. Cuándo parar

Terminaste cuando los 5 pasos pasan y el archivo exporta **exactamente** lo que dice §5 del plan: ni un
símbolo más ni uno menos. T05 y T06 programaron contra esa lista.

**Pará y avisá** si:

- Algo del contrato de §5 no se puede implementar como está. No lo cambies por tu cuenta.
- El CHECK `tareas_hecha_at_coherente` te bloquea una operación que te parece legítima. Es el guardián
  del reloj del archivado (D14) y bloquea a propósito; si hay un caso de uso real que no entra, es una
  decisión del plan y no tuya.
- `make_interval` no está disponible. Es de PG 9.4+ y la base es 16, así que si pasa, el ambiente no es
  el que dice el plan.

**Anotá y seguí** si:

- Se te ocurre que `listarTareas` debería paginar. Con decenas de tarjetas no hace falta y agregarlo
  ahora obliga a T06 a manejar un cursor que no necesita. Anotalo en §11 del plan.
