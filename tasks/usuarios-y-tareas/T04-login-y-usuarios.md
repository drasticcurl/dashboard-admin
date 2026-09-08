# T04 — Login con usuario, cambio de clave y la pantalla de Usuarios

- **Depende de:** T01 (`lib/queries/usuarios.ts`, `hashearClave`, `MIN_LARGO_CLAVE`, `verifyPassword`
  para el fallback). **No arranques antes de que su verificación esté en verde.**
- **Bloquea:** nada.
- **Se puede correr en paralelo con:** T02 y T03.
- **Repo:** `dashboard-admin` (rama `main`).
- **Archivos que este task puede tocar:**
  - `app/page.tsx` (el login)
  - `app/cambiar-clave/page.tsx` (nuevo)
  - `app/sin-acceso/page.tsx` (nuevo)
  - `app/api/usuarios/route.ts` · `app/api/usuarios/route.test.ts` (nuevos)
  - `app/api/usuarios/clave/route.ts` (nuevo)
  - `app/(panel)/config/ConfigView.tsx`
  - `app/(panel)/config/sections/UsuariosSection.tsx` (nuevo)

  Nada más. **No toques `app/(panel)/layout.tsx`** (es de T03, y es quien redirige a tus dos páginas
  nuevas) ni `lib/`.

---

## 1. Objetivo

Que alguien pueda entrar con su usuario y su clave, que la primera vez esté obligado a cambiarla, y que
el admin pueda crear gente y prender o apagar sus 8 pestañas con un switch.

---

## 2. Antes de escribir, leé estos tres

**`app/page.tsx` (159 líneas).** Es el login que vas a modificar. Lo que **no** cambia y por qué:

- **El mensaje de error es genérico a propósito** y sigue siéndolo. El comentario de las líneas 143-148
  lo explica: no distingue clave mala de rate limit para no filtrar en qué estado está el login. Ahora
  hay una razón **más**: tampoco puede distinguir "no existe ese usuario". Un login que dice "usuario
  inexistente" es un enumerador de usuarios gratis. Mismo `?error=1` para las cuatro causas.
- El orden del server action: rate limit → verificar → firmar → set-cookie → redirect. Con el mismo
  `getClientIp` y el mismo `checkLoginRateLimit`.
- La `redirect('/?error=1')` para todo lo que falla, y **la clave nunca en un query param** (línea 116
  en adelante: es un POST de server action).
- El diseño de la tarjeta de vidrio y los tokens. **No inventes colores** — el comentario de la línea 66
  cuenta que esta pantalla ya fue una foto vieja del panel con hex crudos y se arregló.

**`app/(panel)/config/sections/ProductosSection.tsx` (297 líneas).** Es el molde de una sección de
Config: un solo objeto de estado por formulario (`useState({...})` con spread), `<label className="flex
flex-col gap-1 text-xs text-neutral-500">` envolviendo el input, `busy`/`setBusy` y
`show('good'|'bad', texto)` del `ConfigShell`, `type="button"` en todos los botones, `try/catch/finally`.
**No hay react-hook-form ni zod en el cliente** y no es el lugar para introducirlos.

**`app/(panel)/config/kit.ts`.** `inputCls`, `btnPrimary`, `btnGhost` y los tipos `Flash` y
`ConfigShell`. Usalos: son las clases exactas que hacen que tu sección se vea igual que las otras diez.

**Qué NO copiar:** de `app/page.tsx`, la idea de que la contraseña es la clave de firma. `signSessionToken`
ahora recibe un `usuarioId` (T01, D1).

---

## 3. El login

```
1. rate limit por IP                        → falla: redirect('/?error=1')
2. usuarioPorNombre(usuario.toLowerCase())
   2a. si contarUsuarios() === 0 →          FALLBACK D10: verifyPassword(clave)
                                            → ok: signSessionToken(0), sesión admin
3. verificarClave(clave, fila.claveHash)    → falla: redirect('/?error=1')
4. signSessionToken(fila.id) + set-cookie
5. marcarLogin(fila.id)
6. redirect(fila.debeCambiarClave ? '/cambiar-clave' : '/resumen')
```

**Las cinco cosas:**

1. **El campo de usuario se normaliza con `.trim().toLowerCase()` antes de buscar.** El CHECK de la 030
   exige la columna en minúsculas sin espacios, así que sin normalizar acá, alguien que escribe "Lucho"
   no entra y no hay ningún error que lo explique.
2. **El fallback de D10 se chequea SÓLO si `contarUsuarios() === 0`.** No es "si no encontré el usuario,
   probá con `DASHBOARD_PASSWORD`" — eso sería una puerta de atrás permanente. Y el orden importa: no
   llames a `contarUsuarios()` en cada login, sólo cuando `usuarioPorNombre` no encontró nada.
3. **`resetLoginRateLimit(ip)` sólo después de un login exitoso**, como hoy.
4. **El redirect final depende de `debeCambiarClave`.** Si mandás a `/resumen`, el layout de T03 lo va a
   rebotar a `/cambiar-clave` de todos modos, pero con un salto visible de más.
5. **`autoComplete="username"` en el campo nuevo** y `"current-password"` en el que ya está. Sin eso los
   gestores de contraseñas guardan basura y la gente termina anotando la clave en un papel, que es peor
   que cualquier cosa que este módulo arregle.

Y una cosa de UX que **sí** importa: el campo de usuario va **arriba** del de clave y el `autoFocus`
pasa a él. Hoy el `autoFocus` está en la clave.

---

## 4. `/cambiar-clave` y `/sin-acceso`

**Las dos van FUERA del grupo `(panel)`**, como `app/page.tsx`. Si estuvieran adentro, el layout las
protegería y el redirect de T03 sería un bucle infinito.

`/cambiar-clave`:

- Server action. Pide **clave actual**, nueva y repetición.
- **Pide la actual aunque la sesión ya esté validada.** Sin eso, una sesión robada o una máquina
  desbloqueada cambia la clave y te deja afuera de tu propio panel. Es la misma razón por la que
  cualquier sitio la pide.
- **Mínimo `MIN_LARGO_CLAVE` (15), validado en el SERVER.** El `minLength` del input es una comodidad,
  no una validación: un POST directo lo ignora.
- La nueva no puede ser igual a la actual. Sin eso, "cambiar la clave" se satisface con `123456` otra
  vez y `debe_cambiar_clave` pasa a `false` con la clave por defecto puesta — que es exactamente el
  agujero de D8 quedándose abierto para siempre.
- Al terminar: `debe_cambiar_clave = false` y **re-firmar la cookie** (el `ts` nuevo renueva las 12 h).
- Un contador de caracteres visible. 15 es más de lo que la gente espera y sin el contador la mitad de
  los intentos van a fallar sin saber por qué.
- Si `debeCambiarClave` es `true`, la pantalla **no tiene salida**: nada de link a `/resumen` ni de
  botón "después". Es la mitigación de D8 y un link de escape la anula. El botón Salir sí queda.

`/sin-acceso`: una pantalla, un párrafo — "tu usuario no tiene ninguna sección asignada, pedile al admin
que te habilite" — y el botón de Salir. **Sin links a nada del panel**, porque no puede entrar a nada.

---

## 5. `app/api/usuarios`

```
GET    /api/usuarios                          → { ok, usuarios: Usuario[] }
POST   /api/usuarios  { usuario, nombre }     → { ok, usuario }   (clave inicial 123456)
PATCH  /api/usuarios  { id, nombre?, esAdmin?, activo?, secciones? } → { ok, usuario }
POST   /api/usuarios/clave { claveActual, claveNueva }              → { ok }         (el propio)
POST   /api/usuarios/clave { id, resetear: true }                   → { ok }         (sólo admin)
```

Con `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`, `guard(req)` como **primera línea de cada
método**, zod con `safeParse` sobre `await req.json().catch(() => null)`, y el sobre
`{ ok:true, ... }` / `{ ok:false, error, detail }`. Éxito 200, **no 201**. Es el contrato de
`app/api/finanzas/cuentas/route.ts` y no se innova.

**Las seis cosas:**

1. **`claveHash` no sale nunca en un JSON.** `listarUsuarios` de T01 ya no la devuelve; no la vuelvas a
   agregar "para el debug".
2. **`/api/usuarios/clave` está mapeada como `'admin'` (T03) y necesita una excepción**: cualquiera
   cambia **su propia** clave. Manejala **adentro del route**, comparando el `usuarioId` de la sesión —
   y sólo para la forma `{ claveActual, claveNueva }`. La forma `{ id, resetear }` es admin y nada más.
   No le agregues un tipo nuevo al mapa por un caso.
3. **Un admin no puede quitarse el admin ni desactivarse si es el único activo.** La validación está en
   `actualizarUsuario` de T01 y devuelve `UsuarioInputError` → 400 con el `detail` en castellano. Vos
   sólo lo traducís al status.
4. **`resetear: true` vuelve la clave a `123456` y `debe_cambiar_clave` a `true`.** Es la única forma que
   tiene el admin de desbloquear a alguien (no hay recuperación por mail; está en §0 del plan, «No se construye»). La respuesta **tiene que decir la clave en
   texto** para que el admin la pueda pasar: es información que él ya tiene el derecho de saber y
   esconderla sólo genera una llamada.
5. **`secciones` en el PATCH es el estado FINAL de los 8 switches**, no un diff. `fijarSecciones` de T01
   reemplaza dentro de una transacción. Un diff obliga al cliente a llevar estado y a los dos lados a
   ponerse de acuerdo sobre el orden.
6. **Validá `secciones` contra `SECCIONES` con zod** (`z.enum`), no contra un array escrito a mano. Si
   divergen, el `INSERT` explota con un `23514` que el usuario ve como un 500.

Tests (`route.test.ts`): mockeá el guard con el patrón de `app/api/data/ads/route.test.ts:82-85`
(`vi.mock` de `lib/auth` con `importOriginal`, sobreescribiendo lo justo) para no atar la suite a
`DASHBOARD_PASSWORD`, que en CI no está.

---

## 6. `UsuariosSection.tsx` en Config → Sistema

En `ConfigView.tsx`, agregá `{ id: 'usuarios', label: 'Usuarios' }` al grupo **Sistema** (donde ya
están "Ajustes" y "Salud del sistema"), su entrada en el tipo `SeccionId` y el render. El `GRUPOS` de las
líneas 80-121 y el `SECCIONES_VALIDAS` derivado ya hacen el resto: la sección activa viaja en `?s=`.

La sección:

- **Tabla** con las columnas: Usuario · Nombre · Rol · Estado · Último ingreso · Secciones. Usá el
  `Table` de `components/ui.tsx` (que **no** se toca) y `Badge` para el rol y el estado.
- **Los 8 switches por usuario**, con el `Tone` que corresponde. Usá checkboxes de verdad
  (`accent-good-500`, como el de `DialogoConfirmacion.tsx`), no divs con `onClick`: un switch que no es
  un `<input type="checkbox">` no lo lee un lector de pantalla ni lo alcanza el Tab.
- **La fila del admin muestra los 8 en on y deshabilitados**, con un `title`/`aria-describedby` que
  diga por qué ("el admin ve todo; si pudiera apagarse una se quedaría afuera de esta pantalla" —
  D11). Deshabilitados y no escondidos: escondidos parece un bug.
- **Guardar es explícito**, con un botón. No auto-guardes al togglear: ocho requests mientras alguien
  configura a una persona, y ninguna forma de arrepentirse.
- **Un `Banner` con la advertencia de P-01**: el layout de widgets de Resumen y Ventas es **compartido**,
  así que si dos personas lo mueven, el último gana. Va acá porque es acá donde alguien se va a
  preguntar por qué le cambió la pantalla. Tono `info`.
- **Un `Banner` de tono `warn` si alguien todavía tiene `debe_cambiar_clave`.** Es D8 hecho visible: el
  agujero de la clave por defecto tiene que estar a la vista hasta que se cierre.
- **No hay botón de borrar.** Hay "Desactivar" (D8 del esquema). Si aparece la tentación de agregar un
  DELETE: los tres FK son RESTRICT y fallaría igual, pero con un 500.

---

## 7. Verificación

```bash
# 1. Build y tests
npm run build && npm test -- app/api/usuarios
# esperado: verde

# 2. El circuito de la primera vez (npm run dev, con el seed de T01 corrido)
#    a) http://127.0.0.1:3005/ → login con usuario `lucho` y clave `123456`
#       esperado: entra y va DIRECTO a /cambiar-clave, no a /resumen
#    b) probar una clave nueva de 14 caracteres
#       esperado: la rechaza y dice el mínimo. Con 15, la acepta.
#    c) probar `123456` como clave nueva
#       esperado: la rechaza ("no puede ser la misma")
#    d) después de cambiarla: entra a /resumen y ya no vuelve a /cambiar-clave
#    e) salir y entrar con la clave VIEJA
#       esperado: rechazada, con el mensaje genérico

# 3. El mensaje genérico no filtra nada — las cuatro causas dan lo mismo
#    usuario inexistente · usuario ok con clave mala · usuario vacío · 6 intentos
#    esperado: las cuatro muestran "No pudimos validar esa contraseña. Probá de
#              nuevo." No puede haber ninguna diferencia entre ellas.

# 4. La clave nunca en la URL ni en los logs
#    Devtools → Network → el POST del login → Payload
# esperado: la clave en el body del form data, y la URL SIN query params.
grep -rn "console.log" app/page.tsx app/cambiar-clave app/api/usuarios
# esperado: ningún console.log con una clave

# 5. La pantalla de Usuarios (como lucho)
#    Config → Sistema → Usuarios
#      · las 2 filas, con `lucho` en admin y sus 8 switches en on y deshabilitados
#      · el Banner warn mientras nahuel siga con la clave por defecto
#      · el Banner info del layout compartido
#      · prender resumen + finanzas + tareas a nahuel y Guardar
psql "$DATABASE_URL" -tAc "SELECT seccion FROM usuario_secciones s JOIN usuarios u ON u.id=s.usuario_id WHERE u.usuario='nahuel' ORDER BY 1"
# esperado exactamente:
#   finanzas
#   resumen
#   tareas

# 6. Que el reemplazo es reemplazo y no acumulación
#    Apagá `tareas` y Guardar
psql "$DATABASE_URL" -tAc "SELECT count(*) FROM usuario_secciones s JOIN usuarios u ON u.id=s.usuario_id WHERE u.usuario='nahuel'"
# esperado: 2

# 7. El admin no se puede autoencerrar
#    Intentá quitarte el admin siendo el único admin activo
# esperado: 400 con un mensaje en castellano que dice que sos el único

# 8. El reset de clave
#    Resetear la de nahuel → entrar como nahuel con 123456
# esperado: entra y cae en /cambiar-clave

# 9. El fallback de D10 (base sin usuarios)
psql "$DATABASE_URL" -c "BEGIN; DELETE FROM usuario_secciones; DELETE FROM usuarios; COMMIT;"
#    entrar con CUALQUIER usuario y la DASHBOARD_PASSWORD del .env
# esperado: entra como admin, ve las 8 pestañas
#    volvé a correr `npm run usuarios:seed` para dejarlo como estaba
# esperado: con una fila en usuarios, la DASHBOARD_PASSWORD ya NO entra

# 10. Que no tocaste lo ajeno
git diff --stat -- lib/ middleware.ts 'app/(panel)/layout.tsx' components/
# esperado: VACÍO
```

---

## 8. Cuándo parar

Terminaste cuando los 10 pasos pasan. El paso 3 y el 9 **no son opcionales**: el 3 es la única cosa que
impide enumerar usuarios y el 9 es la que prueba que la puerta del fallback se cierra sola.

**Pará y avisá** si:

- El redirect a `/cambiar-clave` entra en bucle. Casi seguro pusiste la página **adentro** del grupo
  `(panel)` — §4 explica por qué no puede estar ahí.
- Necesitás cambiar la firma de algo de `lib/queries/usuarios.ts` o de `lib/auth.ts`. Están congelados
  (T01) y T03 los está usando al mismo tiempo.
- El fallback de D10 no se cierra al haber una fila. Es una puerta abierta y es bloqueante.
- Descubrís que `verificarClave` acepta la clave vacía o el hash vacío. La 030 tiene un CHECK contra el
  hash vacío, pero la clave la valida el código.

**Anotá y seguí** si:

- Te parece que hace falta un log de intentos de login fallidos por usuario. Sería útil y el plan no lo
  pidió; el rate limit es por IP y sigue igual.
- Te parece que el reset debería generar una clave aleatoria en vez de `123456`. **Tenés razón** y es lo
  que yo haría — pero `123456` lo pidió el usuario explícitamente (D8, P-04). Anotalo, no lo cambies.
