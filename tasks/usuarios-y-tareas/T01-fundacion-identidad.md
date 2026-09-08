# T01 — Fundación: identidad, permisos y el token con usuario

- **Depende de:** nada. Arranca ya.
- **Bloquea:** T02, T03, T04, T05, T06 y T07. **Las seis.**
- **Se puede correr en paralelo con:** nada. **Corre sola.**
- **Repo:** `dashboard-admin` (rama `main`).
- **Archivos que este task puede tocar:**
  - `db/migrations/030_usuarios.sql` (nuevo)
  - `db/migrations/031_tareas.sql` (nuevo)
  - `lib/auth.ts` · `lib/auth.test.ts`
  - `lib/permisos.ts` (nuevo) · `lib/permisos.test.ts` (nuevo)
  - `lib/queries/usuarios.ts` (nuevo) · `lib/queries/usuarios.test.ts` (nuevo)
  - `middleware.ts` · `middleware.test.ts`
  - `scripts/seed-usuarios.ts` (nuevo)
  - `package.json` · `.env.example`

  Nada más. **En particular no toques ningún `app/`**: los guards son de T03 y el login de T04.

---

## 1. Objetivo

Que el panel sepa **quién** entró, y que exista un lugar único donde preguntar **qué puede ver**.

Sos la compuerta del módulo entero: las seis tasks siguientes importan `lib/permisos.ts` y ninguna
compila sin él. El contrato de §4 del plan **no se negocia** — si algo de ahí no se puede implementar
como está escrito, **pará y avisá** antes de cambiarlo.

Y sos la task que puede romper el panel de producción para todo el mundo, porque cambiás el formato de
la cookie en dos archivos con dos primitivas de criptografía distintas. Leé D1, D2 y D10 del plan
completos antes de escribir la primera línea.

---

## 2. Antes de escribir, leé estos tres archivos completos

**`lib/auth.ts` (281 líneas).** Es el archivo que vas a reescribir, no uno que vas a copiar. Lo que
tiene que **sobrevivir intacto**:

- `PANEL_COOKIE_NAME`, `SESSION_TTL_SECONDS`, `sessionCookieOptions()`,
  `clearSessionCookieOptions()`, `getClientIp()`, `checkLoginRateLimit()`, `resetLoginRateLimit()`.
  Los importan `app/page.tsx` y `app/(panel)/layout.tsx`, que son de T04 y T03. Cambiarles la firma
  sin necesidad multiplica el diff de dos tasks ajenas.
- El patrón de **fallar cerrado**: sin secreto configurado, todos los checks devuelven `false`/`null`,
  con un `console.warn` una sola vez por proceso (`warnedMissing`). Copialo tal cual para el secreto
  nuevo.
- La comparación **timing-safe** en todo: `crypto.timingSafeEqual`, y el chequeo de longitud **antes**
  (que no es una optimización: `timingSafeEqual` tira si las longitudes difieren).
- El decoy de `verifyPassword` (`timingSafeEqual(b, b)` cuando los largos no matchean) para no filtrar
  la longitud por timing.

**`middleware.ts` (184 líneas).** Su docblock de las líneas 11-18 explica por qué reimplementa el
verify en vez de importar `lib/auth.ts`: corre en Edge y `node:crypto` no existe ahí. **Eso sigue
siendo cierto y no lo arregles.** Vas a tocar el parser del token en los dos lugares, con las dos
primitivas, y las dos tienen que dar el mismo resultado.

Lo que **no** cambia del middleware: el `config.matcher` (con `api/ingest` y `api/webhooks` afuera), la
bifurcación 401 JSON para `/api/*` vs 307 para páginas, `urlDeLogin()` completa, y los cuatro headers
de seguridad. Si tocás el matcher, el tracking y las ventas dejan de entrar y el panel muestra ceros
sin un solo error.

**`lib/queries/saldo.ts`.** Es el molde de la capa de datos: cómo tipa las filas, el mapeo
snake_case → camelCase **a mano** en un `.map()` explícito, los helpers `MONEY`/`MONEY_N`, y sobre todo
`SaldoInputError` — la clase de error de dominio que **traduce los SQLSTATE de Postgres a castellano
en la capa de queries, no en el route**. Necesitás el equivalente: `UsuarioInputError`, que traduce el
`23505` del usuario duplicado.

**Qué NO copiar de `lib/auth.ts`:** la idea de que la contraseña es la clave de firma. Es exactamente
lo que este task elimina (D1).

---

## 3. Las dos migraciones: copialas, no las escribas

```
tasks/usuarios-y-tareas/_schema-030.sql  →  db/migrations/030_usuarios.sql
tasks/usuarios-y-tareas/_schema-031.sql  →  db/migrations/031_tareas.sql
```

**Tal cual, sin retipear y sin "mejorar" los comentarios.** Ese DDL ya corrió contra una base scratch
con las 29 migraciones reales aplicadas y tiene 28 afirmaciones en verde. Cada CHECK está ahí por un
modo de falla concreto que está comentado al lado.

Tres cosas que hay que respetar:

- **No escribas `BEGIN` ni `COMMIT`.** `scripts/migrate.ts:34-37` ya envuelve cada archivo en su propia
  transacción junto con el registro en `schema_migrations`. Por la misma razón, `CREATE INDEX
  CONCURRENTLY` no entra por este runner (y no hace falta ninguno).
- **El prefijo va con tres dígitos.** El runner ordena alfabético (`scripts/migrate.ts:25`), así que
  `30_usuarios.sql` ordenaría entre la 003 y la 004.
- **Si `db/migrations/029_insights_ia.sql` no está en el árbol**, pará y avisá (§3 del plan): estaba sin
  commitear el 2026-09-08 y el plan asume que se queda.

---

## 4. `lib/auth.ts` — lo que cambia

### El secreto de firma

```ts
/** El secreto con el que se firma la cookie. Default: DASHBOARD_PASSWORD.
 *
 * El default NO es pereza. Las dos instancias (hilvanapp e infinix) deployan del
 * mismo origin/main y ninguna declara esta variable todavía: sin el default, el
 * próximo deploy las deja a las dos sin poder firmar una sesión. Es la regla de
 * `.kiro/steering/instancias.md` — el default es siempre el valor histórico de
 * hilvanapp. Y por eso NO va en el array REQUIRED de deploy/deploy.sh:177.
 *
 * Rotarlo invalida las sesiones de TODOS y es la única palanca que existe para
 * echar a alguien en el acto (plan P-02).
 */
function secretoDeFirma(): string | null
```

### El token

`` `${usuarioId}.${ts}.${hmac(secreto, `${usuarioId}.${ts}`)}` ``

```ts
export function signSessionToken(usuarioId: number, nowMs?: number): string | null;
export function verifySessionToken(token: string | undefined, nowMs?: number): { usuarioId: number } | null;
```

**Las cuatro cosas del parser que no son negociables** (las cuatro están afirmadas en
`_verificacion-sesion.mjs`, corrélo cuando termines):

1. **Exactamente 3 campos.** `split('.')` con `length !== 3` → `null`. Un token viejo tiene 2 y **tiene
   que rechazarse**, no malinterpretarse: si el parser leyera el `ts` como id, cualquiera con una
   cookie vieja entraría como el usuario cuyo id coincida con un timestamp.
2. **`/^\d+$/` en el id y en el ts, no `Number()`.** `Number('7e2')` es 700 y `Number(' 7')` es 7: dos
   strings distintos darían el mismo id con firmas distintas.
3. **El punto va DENTRO del payload firmado.** Sin separador, `id=1,ts=23` y `id=12,ts=3` firman igual.
4. **El mismo TTL de 12 h y el mismo skew de 60 s** que hoy, y el mismo rechazo de timestamps del
   futuro.

### El hash de claves (D7)

```ts
/** scrypt$<N>$<r>$<p>$<salt hex>$<derivada hex> — N=16384, r=8, p=1, 32 bytes. */
export function hashearClave(clave: string): Promise<string>;
export function verificarClave(clave: string, guardado: string): Promise<boolean>;
```

- **`crypto.scrypt` async, NO `scryptSync`.** Medido: 30 ms en régimen, 99 ms la primera del proceso.
  `scryptSync` bloquea el event loop de Next ese tiempo entero, y el login no es el único request en
  vuelo.
- **Los parámetros se leen de la fila que estás verificando**, no de la constante del módulo. Es lo que
  permite subir el costo más adelante sin invalidar los hashes viejos. Está afirmado (5).
- **`timingSafeEqual` sobre las derivadas**, con el chequeo de longitud antes.
- La validación de **mínimo 15 caracteres** va acá como constante exportada
  (`MIN_LARGO_CLAVE = 15`) y la aplica T04 en el cambio de clave. **No la apliques en
  `hashearClave`**: el seed tiene que poder sembrar `123456`, que son 6.

### `verifyPassword` se conserva, y sólo para el fallback

No lo borres. `lib/permisos.ts` lo usa para D10 (tabla vacía → `DASHBOARD_PASSWORD` vale como admin) y
`app/page.tsx` de T04 lo llama en esa rama.

---

## 5. `lib/permisos.ts` — el contrato congelado

Implementá **exactamente** lo que dice §4 del plan: ni un símbolo más ni uno menos. T03, T04, T05 y
T06 programaron contra esa lista.

### `MAPA_API` es una tabla explícita, ruta por ruta (D5)

**No lo generes con reglas por prefijo.** Verificado leyendo quién llama a cada endpoint: tres viven
bajo un prefijo que no es su sección.

```ts
export const MAPA_API: Record<string, readonly Seccion[] | 'admin' | 'publica'> = {
  '/api/data/overview':        ['resumen'],
  '/api/data/funnel':          ['embudo'],
  '/api/data/pitch':           ['embudo'],
  '/api/data/sales':           ['ventas'],
  '/api/data/leads':           ['leads'],
  '/api/data/ads':             ['anuncios'],
  '/api/data/ads/historial':   ['anuncios'],
  '/api/ads/acciones':         ['anuncios'],
  '/api/ads/interruptores':    ['anuncios'],
  '/api/ads/reglas':           ['anuncios'],
  '/api/ads/reglas/csv':       ['anuncios'],
  '/api/finanzas/cuentas':     ['finanzas'],
  // … el resto de finanzas
  '/api/tareas':               ['tareas'],
  // … el resto de tareas

  // ── LAS TRES QUE UN MAPA POR PREFIJO SE COMERÍA ─────────────────────────
  // Lo llama components/WidgetGrid.tsx:408, que se monta en Resumen y en Ventas.
  // Con 'config' acá, nahuel mueve un widget en Resumen y el POST le da 403 en un
  // fetch que nadie mira: el widget vuelve solo a su lugar y parece un bug de la UI.
  '/api/config/ui-layout':     ['resumen', 'ventas'],
  // Lo llama app/(panel)/anuncios/GestorAnuncios.tsx:1148. Vive bajo /api/config
  // por dónde guarda (settings.ads_vistas), no por qué pantalla lo usa.
  '/api/config/vistas-ads':    ['anuncios'],
  // Lo llama components/PanelInsight.tsx:75, montado en Resumen y en Finanzas.
  '/api/ia/insight':           ['resumen', 'finanzas'],

  // El resto de /api/config/* → ['config'], una por una, sin comodines.

  '/api/usuarios':             'admin',
  '/api/usuarios/clave':       'admin',   // T04 le agrega la excepción del propio usuario

  '/api/ingest':               'publica',
  '/api/webhooks/shopify':     'publica',
  '/api/webhooks/hotmart':     'publica',
};
```

Con `readonly Seccion[]`, el permiso pasa si el usuario tiene **cualquiera** de las de la lista.

### `sesionActual()` y la única query que corre en cada página

Una sola consulta con un `array_agg` de las secciones, no dos. `app/(panel)/layout.tsx` corre en
**cada** pantalla del panel y ya hace un `Promise.all` de dos queries: una tercera en serie se nota.

```sql
SELECT u.id, u.usuario, u.nombre, u.es_admin, u.debe_cambiar_clave,
       COALESCE(array_agg(s.seccion) FILTER (WHERE s.seccion IS NOT NULL), '{}') AS secciones
  FROM usuarios u
  LEFT JOIN usuario_secciones s ON s.usuario_id = u.id
 WHERE u.id = $1 AND u.activo
 GROUP BY u.id
```

`LEFT JOIN` y no `JOIN`: un usuario **sin ninguna sección otorgada** tiene que devolver una sesión con
la lista vacía, no `null`. Son cosas distintas — "no tiene permisos" manda a `/sin-acceso`, "no existe"
manda al login. Con un `JOIN` a secas, el usuario recién creado desaparece.

`AND u.activo`: desactivar a alguien le corta el acceso en el siguiente request. Es lo que hace que el
switch sea instantáneo (D3).

Si `es_admin`, devolvé `secciones: SECCIONES` (las 8) **ignorando lo que haya en la tabla** (D11).

### El fallback de D10

```ts
// Con la tabla usuarios VACÍA, DASHBOARD_PASSWORD sigue valiendo y esa sesión es
// admin. Es lo que hace que el deploy no deje a nadie afuera entre la migración y
// el `npm run usuarios:seed`, en las DOS instancias.
//
// Sólo con la tabla vacía. NO es "si la clave no matchea a ningún usuario, probá
// con la vieja" — eso sería una puerta de atrás permanente.
//
// Se apaga solo: en cuanto hay una fila, este camino no se toma más.
```

`esFallback: true` en esa sesión, y `usuarioId: 0`. **`0` y no `-1` ni `null`**: es el valor que T05 va
a poner en `creado_por` como `null` (la columna es nullable justo para esto) y que T06 muestra como
"—". Un id negativo se cuela en un `Number.isInteger(id) && id > 0` de alguna validación y se vuelve
un bug raro.

### `requerirSeccion()`: redirige a la primera permitida, no a un 403

Alguien que entra por un link viejo tiene que caer en una pantalla que **sí** puede usar. Un cartel de
"no tenés permiso" es correcto y es peor. Orden: sin sesión → `/`; `debeCambiarClave` →
`/cambiar-clave`; sin permiso pero con alguna → la primera de `SECCIONES` que tenga; sin ninguna →
`/sin-acceso`.

El orden importa: `debeCambiarClave` se chequea **antes** que el permiso. Si no, alguien con la clave
por defecto y sin secciones va a `/sin-acceso` y nunca puede cambiarla.

---

## 6. `lib/queries/usuarios.ts`

```ts
export type Usuario = { id, usuario, nombre, esAdmin, debeCambiarClave, activo, ultimoLoginAt, secciones };
export function listarUsuarios(): Promise<Usuario[]>;
export function usuarioPorNombre(usuario: string): Promise<(Usuario & { claveHash: string }) | null>;
export function usuarioPorId(id: number): Promise<Usuario | null>;
export function contarUsuarios(): Promise<number>;
export function crearUsuario(u: {...}): Promise<Usuario>;
export function actualizarUsuario(id: number, cambios: {...}): Promise<Usuario>;
export function cambiarClave(id: number, claveHash: string): Promise<void>;
export function fijarSecciones(id: number, secciones: Seccion[]): Promise<Usuario>;
export function marcarLogin(id: number): Promise<void>;
export class UsuarioInputError extends Error {}
```

Cuatro cosas:

1. **`claveHash` sale SÓLO de `usuarioPorNombre`**, que es lo único que la necesita (el login). Ni
   `listarUsuarios` ni `usuarioPorId` la devuelven. Un hash que viaja al cliente en un JSON es un hash
   ofrecido para romper offline.
2. **`fijarSecciones` es un reemplazo completo dentro de `tx()`**: `DELETE` de las que están y `INSERT`
   de las nuevas. La pantalla manda el estado final de los 8 switches, no un diff. Usá el `c` del
   callback de `tx`, **nunca `q()`** — `q()` toma otra conexión del pool y quedaría afuera de la
   transacción, con la transacción abierta esperando.
3. **`UsuarioInputError` traduce el `23505`** del índice `usuarios_usuario_uq` a "ya existe un usuario
   con ese nombre". El SQLSTATE no le dice nada a nadie. Es el patrón de `SaldoInputError`.
4. **`actualizarUsuario` no puede dejar al panel sin admin activo.** No se puede expresar con un CHECK
   (es una condición entre filas): va acá, con un `UsuarioInputError` que diga "es el único admin
   activo". Chequealo **dentro de la misma transacción** que el UPDATE, o dos pedidos simultáneos
   quitándose el admin lo pasan los dos.

---

## 7. `middleware.ts` — el mismo cambio, con la otra primitiva

Sólo el parser y el secreto. Todo lo demás queda **exactamente** como está.

- El payload que se firma y el orden de los chequeos, idénticos a `lib/auth.ts`. Si divergen, el panel
  deja pasar por una capa y rebota en la otra: **un bucle de redirects que no se ve en ningún test de
  un solo lado.**
- `safeEqualHex` con el XOR acumulado se queda: Web Crypto no expone `timingSafeEqual` y es lo mejor
  que hay en Edge. La verificación definitiva la hace el layout en Node.
- El secreto también con default a `DASHBOARD_PASSWORD`, y el middleware lee `process.env` directo
  (no puede importar `lib/auth.ts`).

---

## 8. `scripts/seed-usuarios.ts` (D9)

`npm run usuarios:seed`. Modelo: `scripts/set-ingest-key.ts`.

- Lee `PANEL_ADMIN_USUARIO` (default **`lucho`**) y `PANEL_ADMIN_NOMBRE` (default **`Lucho`**). El
  default es el valor de hilvanapp, siempre.
- Usuarios adicionales por argumento: `npm run usuarios:seed -- nahuel:Nahuel`.
- Clave inicial `123456` para todos, `debe_cambiar_clave = true`, y las 8 secciones **sólo** para el
  admin (que no necesita filas: `es_admin` implica todo). A los adicionales, **ninguna sección**: las
  otorga el admin desde la pantalla. Un usuario nuevo que nace viendo todo es lo contrario de lo que
  pide este módulo.
- **Idempotente**: si el usuario existe, lo saltea con un mensaje y **no le toca la clave**. Correrlo
  dos veces no puede resetearle la clave a alguien que ya la cambió.
- Imprime al final, en castellano y bien fuerte, que la clave es `123456` y que hay que cambiarla en
  el primer login.
- Cargá el `.env` con el patrón de `lib/queries/reconciliacion.integracion.test.ts:46-48`
  (`process.loadEnvFile` condicionado): `scripts/migrate.ts` no lo hace y es una molestia conocida.

## 9. `package.json` y `.env.example`

**Sos el único que los toca en todo el módulo** (§8 del plan). Agregá los **dos** scripts de una vez:

```json
"usuarios:seed": "tsx scripts/seed-usuarios.ts",
"tareas:archivar": "tsx scripts/archivar-tareas.ts"
```

`scripts/archivar-tareas.ts` lo escribe T07 y **todavía no existe**. Un script de npm que apunta a un
archivo inexistente no rompe el build; dos agentes editando el manifiesto sí.

En `.env.example`, con el estilo de comentario del archivo (qué es, cuál es el default, y qué pasa si
falta): `PANEL_SESSION_SECRET`, `PANEL_ADMIN_USUARIO`, `PANEL_ADMIN_NOMBRE`. Los tres con su default
anotado y con la frase de que **no** son requeridos por el deploy.

---

## 10. Tests

**Puros, sin base** (`lib/auth.test.ts`, `lib/permisos.test.ts`):

1. Un token firmado con un secreto no verifica con otro.
2. Token de 2 campos → `null` (la cookie vieja).
3. Token con 4 campos → `null`.
4. `id` o `ts` no numéricos, con espacios, con notación exponencial → `null`.
5. Firma de 63 o 65 hex → `null`.
6. Vencido (>12 h) → `null`. Del futuro (>60 s) → `null`.
7. Cambiarle el id al token invalida la firma.
8. `hashearClave` produce algo que matchea el CHECK de la 030, y dos llamadas con la misma clave dan
   hashes **distintos** (salt aleatorio).
9. `verificarClave` con un hash de `N` viejo sigue dando `true`.
10. `puedeVer` con `esAdmin: true` da `true` para las 8, aun con `secciones: []`.
11. **`SECCIONES` es exactamente el vocabulario del CHECK de la 030.** Leé el `.sql` con `readFileSync`
    y comparalo, como hace `components/ui.tokens.test.ts:26` con `ui.tsx`. Sin este test, agregar una
    sección al código y olvidarla en la migración da un `23514` en producción.
12. **Toda clave de `MAPA_API` empieza con `/api/` y no termina en `/`.** El chequeo va a hacer
    `MAPA_API[pathname]`, así que una barra final o un typo lo vuelve "no mapeado" → 403 silencioso.

**Con base** (`lib/queries/usuarios.test.ts`), con el patrón de
`lib/queries/reconciliacion.integracion.test.ts`: `process.loadEnvFile`, `describe.skipIf(!dbAvailable)`,
prefijo `test-usr-` en los nombres, `cleanup()` en `beforeEach` **y** `afterEach`.

13. Crear, leer, desactivar y volver a activar.
14. Usuario duplicado con otra capitalización → `UsuarioInputError` con mensaje en castellano.
15. `fijarSecciones` reemplaza (no acumula) y es idempotente.
16. `sesionActual()` de un usuario **sin secciones** devuelve una sesión con `secciones: []`, **no
    `null`**.
17. `sesionActual()` de un usuario `activo = false` devuelve `null`.
18. Quitarle el admin al único admin activo → `UsuarioInputError`.
19. Con la tabla vacía, `contarUsuarios()` es 0 y el camino del fallback se toma; con una fila, no.

---

## 11. Verificación

```bash
# 0. Base local con el esquema al día.
#    Si no tenés Postgres corriendo (el 2026-09-08 no había ninguno en esta
#    máquina), la receta del clúster efímero está en _verificacion-e2e.sh §0.
docker compose up -d && npm run db:migrate && npm run db:migrate
# esperado: la segunda corrida dice "2 aplicadas, 29 salteadas" y después
#           "0 aplicadas, 31 salteadas"

# 1. Las 28 afirmaciones del esquema
psql "$DATABASE_URL" -f tasks/usuarios-y-tareas/_verificacion-030-031.sql
# esperado: 28 PASA, cero FALLA, y los conteos del final IGUALES a los del principio

# 2. Sesión y hash — las 16 afirmaciones, incluida la que decide el diseño
node tasks/usuarios-y-tareas/_verificacion-sesion.mjs
# esperado: 16 PASA y exit 0.
# Si la 7 (node y Edge firman igual) FALLA → PARÁ EL PROYECTO. Todo apoya en eso.

# 3. Tus tests
npm test -- lib/auth lib/permisos lib/queries/usuarios middleware
# esperado: verde, sin describes salteados si hay DATABASE_URL

# 4. El seed, dos veces
npm run usuarios:seed -- nahuel:Nahuel
npm run usuarios:seed -- nahuel:Nahuel
# esperado: la primera crea 2 usuarios; la segunda dice que los dos ya existen y
#           NO toca ninguna clave
psql "$DATABASE_URL" -tAc "SELECT usuario, es_admin, debe_cambiar_clave, activo FROM usuarios ORDER BY id"
# esperado exactamente:
#   lucho|t|t|t
#   nahuel|f|t|t
psql "$DATABASE_URL" -tAc "SELECT count(*) FROM usuario_secciones"
# esperado: 0  (el admin no necesita filas y nahuel todavía no tiene permisos)

# 5. El admin de la otra instancia sale del env
PANEL_ADMIN_USUARIO=ivan PANEL_ADMIN_NOMBRE=Ivan npm run usuarios:seed
# esperado: crea 'ivan' como admin, sin tocar a lucho

# 6. Tipos
npm run build
# esperado: "Compiled successfully" y exit 0 para todo lib/ y middleware.ts.
#           Si tsc se queja de algo bajo app/, NO lo arregles: es de T03/T04.

# 7. Que no rompiste las rutas públicas
grep -n "matcher" middleware.ts
# esperado: el mismo patrón de antes, con api/ingest y api/webhooks afuera
git diff --stat -- app/ components/ db/migrations/0[0-2]*.sql
# esperado: VACÍO
```

---

## 12. Cuándo parar

Terminaste cuando los 7 pasos de §11 pasan y `lib/permisos.ts` exporta **exactamente** lo que dice §4
del plan.

**Pará y avisá** si:

- **La afirmación 7 de `_verificacion-sesion.mjs` falla.** `node:crypto` y `crypto.subtle` firmando
  distinto invalida el diseño entero (D2/D3) y no se arregla con un parche: habría que volver a
  discutir dónde vive la autorización.
- Algo del contrato de §4 no se puede implementar como está escrito. No lo cambies: T03, T04, T05 y T06
  ya están escribiendo contra él.
- `db/migrations/029_insights_ia.sql` no está en el árbol, o hay algo con prefijo `030`/`031`.
- Te encontrás necesitando editar algo de `app/`. Es de T03 y T04. Si el build se queja de `app/`, eso
  es lo esperado.
- El fallback de D10 te parece mal. Puede ser: es una decisión con costo y está en P-04. Pero es la
  única cosa que impide que el deploy deje el panel cerrado en las dos instancias, así que no lo saques
  por tu cuenta.

**Anotá y seguí** si:

- Encontrás un `process.env.DASHBOARD_PASSWORD` en algún lugar que no sea `lib/auth.ts:47` ni
  `middleware.ts:53`. Eran los dos únicos el 2026-09-08.
- El `MIN_PASSWORD_LENGTH = 24` de hoy (warning nomás) te parece que debería aplicar también a las
  claves de usuario, que tienen mínimo 15. Son dos cosas distintas y el mínimo lo pidió el usuario.
