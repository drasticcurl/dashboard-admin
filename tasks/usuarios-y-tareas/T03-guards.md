# T03 — Los guards: dónde se hace cumplir el permiso

- **Depende de:** T01 (`lib/permisos.ts` completo y congelado). **No arranques antes de que su
  verificación esté en verde.**
- **Bloquea:** nada.
- **Se puede correr en paralelo con:** T02 y T04.
- **Repo:** `dashboard-admin` (rama `main`).
- **Archivos que este task puede tocar:**
  - `app/(panel)/layout.tsx`
  - `app/(panel)/resumen/layout.tsx`, `embudo/`, `ventas/`, `finanzas/`, `leads/`, `config/`,
    `tareas/layout.tsx` (siete nuevos)
  - `app/(panel)/anuncios/layout.tsx` (tres líneas adentro del que ya existe)
  - `app/api/config/_lib.ts`
  - Las **siete** routes que hoy hacen `isAuthenticated(req.cookies)` inline:
    `app/api/data/{pitch,funnel,overview,sales,leads,ads}/route.ts` y
    `app/api/ads/acciones/route.ts`
  - `app/api/rutas-mapeadas.test.ts` (nuevo)
  - `components/Nav.tsx`

  Nada más. **No toques ningún `page.tsx`** — por eso el guard va en layouts nuevos (D4). Y no toques
  `lib/permisos.ts`: es de T01.

---

## 1. Objetivo

Que un usuario sin permiso **no pueda** ver una sección ni por la URL ni por un `fetch`, y que
olvidarse de mapear una ruta nueva rompa el build en vez de producir un 403 en producción.

Sos la task de la seguridad de verdad. El filtro del nav que también hacés es cosmético (D6): si te
quedara sin hacer, nadie ve datos que no debe; si te quedara sin hacer el guard, sí.

---

## 2. Antes de escribir, leé estos tres

**`app/(panel)/layout.tsx` (151 líneas).** El guard actual está en la línea 46 y es
`if (!isAuthenticated(cookies())) redirect('/')`. Fijate en el patrón que ya establece y que vas a
seguir: **carga en el server con `Promise.all` y baja props al `<Nav/>` client** (`funnels`,
`saldoPendiente`). `seccionesPermitidas` va exactamente ahí. Y **leé el comentario de las líneas
120-133** antes de tocar nada: explica por qué la clase `reveal` no puede ir en los items
arrastrables. No te afecta directo pero es de tu archivo.

**`app/api/config/_lib.ts` (líneas 28-34).** Son las seis líneas de `guard()` que usan 23 routes. Es tu
palanca: cambiando eso, 23 endpoints quedan gateados sin que abras ninguno.

**`components/Nav.tsx` (181 líneas).** El array `TABS` de las líneas 20-28 es el único lugar donde se
listan las pestañas. Leé el comentario largo del `<ul>`: el "truco del grid" de los dos labels apilados
existe para que la tab no cambie de ancho al activarse. **Un `filter` no lo rompe** (cada tab sigue
midiendo lo que mide su semibold), pero el `<ul>` entero se encoge, y eso es lo esperado.

**Qué NO copiar:** la idea de que el middleware alcanza. Su docblock dice que es "la primera línea" y es
cierto, pero no puede consultar Postgres (D3). Todo lo tuyo corre en Node.

---

## 3. Los layouts (D4)

Siete archivos nuevos, cada uno de esta forma:

```tsx
/**
 * Guard de permiso de /finanzas.
 *
 * Va en un layout y no en el page.tsx por dos razones (D4 del plan): es un archivo
 * NUEVO, así que no toca las diez pantallas que ya funcionan, y cubre las
 * sub-rutas gratis.
 */
import type { ReactNode } from 'react';
import { requerirSeccion } from '@/lib/permisos';

export default async function FinanzasLayout({ children }: { children: ReactNode }) {
  await requerirSeccion('finanzas');
  return <>{children}</>;
}
```

Cuatro cosas:

1. **`<>{children}</>` y nada más.** Un layout que agrega un `<div>` cambia la cascada de CSS de la
   pantalla que envuelve. Diez pantallas con márgenes ajustados a mano no se pueden permitir un wrapper.
2. **Ni `export const dynamic` ni metadata.** Ya los declara el layout de `(panel)` y las páginas.
3. **`app/(panel)/anuncios/layout.tsx` ya existe** (tiene el `<h1>` y el `<SubNav/>` en un `Suspense`).
   Ahí van tres líneas: el `await requerirSeccion('anuncios')` al principio de la función. No lo
   reescribas.
4. **`app/(panel)/tareas/layout.tsx` lo escribís vos** aunque la pantalla la haga T06. Es el guard, no
   la pantalla. T06 no lo toca.

En `app/(panel)/layout.tsx`, el guard general pasa de `isAuthenticated` a `sesionActual()`:

```tsx
const sesion = await sesionActual();
if (!sesion) redirect('/');
if (sesion.debeCambiarClave) redirect('/cambiar-clave');
```

**El chequeo de `debeCambiarClave` va acá, en el layout general, y no en los siete de sección.** Si
estuviera en cada uno, alguien con la clave por defecto y **sin** secciones caería en `/sin-acceso` y
nunca podría cambiarla (D8).

Y la sesión baja al Nav: `<Nav funnels={funnels} saldoPendiente={...} seccionesPermitidas={sesion.secciones} nombre={sesion.nombre} />`.

`/cambiar-clave` y `/sin-acceso` los escribe T04 y **están fuera del grupo `(panel)`** a propósito: si
estuvieran adentro, el layout las protegería y el redirect sería un bucle infinito. Hasta que T04
mergee, esos dos redirects dan 404. Es esperado (§7 del plan).

---

## 4. `guard()` y las siete routes inline (D5)

`guard(req)` conserva la firma `Promise<NextResponse | null>` — 23 routes hacen
`const denied = await guard(req); if (denied) return denied;` y **ninguna se toca**. Lo que cambia es
lo que hace adentro: delega en `guardSeccion(req)` de `lib/permisos.ts`.

Las siete inline pasan de

```ts
if (!isAuthenticated(req.cookies)) return json(401, { ok: false, error: 'unauthorized' });
```

a

```ts
const denied = await guard(req);
if (denied) return denied;
```

**Cuatro cosas que no se negocian:**

1. **Una ruta que no está en `MAPA_API` devuelve 403.** No 200, no 401. Falla cerrado.
2. **El 403 de "no tenés permiso" y el de "tenés que cambiar la clave" son códigos distintos**
   (`forbidden` vs `clave_pendiente`). El cliente los tiene que poder distinguir: uno es definitivo y el
   otro se resuelve cambiando la clave.
3. **El comentario que ya tienen las siete routes se conserva**, adaptado. Dice *"Un curl sin cookie
   tiene que recibir 401 (nunca datos): es el guard que el middleware no cubre si alguien le toca el
   matcher"*, y sigue siendo la razón por la que existe. Ahora además cubre el permiso.
4. **No agregues el guard a `app/api/ingest` ni a `app/api/webhooks/*`.** Están declaradas `'publica'`
   en el mapa y tienen su propia auth (Bearer + sha256, HMAC de Shopify). Meterles la cookie del panel
   corta el tracking y las ventas, y el panel muestra ceros sin un solo error visible.

Y una excepción que T04 va a necesitar: **`/api/usuarios/clave` está en el mapa como `'admin'`, pero
cualquiera tiene que poder cambiar SU propia clave.** Dejá el mapa como está y que el route de T04
maneje la excepción adentro; no le inventes un tercer tipo al mapa por un caso.

---

## 5. `app/api/rutas-mapeadas.test.ts` — el test que hace que olvidarse rompa el build

Es lo que convierte "falla cerrado" en una garantía en vez de una intención.

```ts
// Recorre app/api/** buscando route.ts y exige que TODOS estén en MAPA_API.
// Sin esto, agregar un endpoint y olvidarse del mapa da un 403 en producción que
// se ve como "la pantalla no carga" y no como "falta una línea en un mapa".
```

- Caminá el directorio con `readdirSync(..., { recursive: true })` o un walk propio, filtrando
  `route.ts`. El 2026-09-08 había **33**.
- Convertí la ruta del archivo a pathname: `app/api/data/ads/historial/route.ts` →
  `/api/data/ads/historial`. Cuidado en Windows con el separador — usá `path.sep` o normalizá con
  `split(path.sep).join('/')`.
- Afirmá que **cada** pathname es una clave de `MAPA_API`, y que el mensaje de error diga **cuál** falta
  y qué hacer. Un `expect(x).toBe(true)` que dice "expected false to be true" no ayuda a nadie a las
  once de la noche.
- Afirmá también **al revés**: que ninguna clave de `MAPA_API` apunte a una ruta que no existe. Una
  entrada de más es una ruta que alguien borró y un mapa que quedó mintiendo.
- **No mockees el filesystem.** Este test tiene que leer el árbol de verdad; es todo su valor.

---

## 6. `components/Nav.tsx` (D6)

Dos cambios:

1. Agregá la pestaña: `{ href: '/tareas', label: 'Tareas' }`. Ponela **antes de Config**: Config es la
   última porque es configuración, y Tareas es una pantalla de uso diario.
2. `seccionesPermitidas?: readonly Seccion[]` como prop, y filtrá `TABS`. **`?` con default a todas**:
   así el componente sigue funcionando si alguien lo monta sin la prop, y el default es el
   comportamiento de hoy.

Y agregá el nombre del usuario al header, al lado del botón Salir. Con dos personas usando el mismo
panel, saber **con cuál de las dos estás logueado** deja de ser un detalle: es lo que evita crear una
tarea con el dueño equivocado. Texto chico, `text-neutral-400`, mismo tamaño que "Salir".

**El docblock del archivo dice "las seis tabs" y ya estaba desactualizado** (son siete). Arreglalo:
van a ser ocho.

Lo que **no** hacés: esconder el `<select>` de funnel ni el `RangePicker`. Nahuel ve Resumen y
Finanzas, y las dos usan el rango. El selector de funnel no aplica a ninguna de las dos y molesta, pero
esconderlo por permiso es una decisión de diseño que el plan no tomó: **anotalo en §11, no lo decidas**.

---

## 7. Verificación

```bash
# 1. Build y tests
npm run build
# esperado: exit distinto de 0 con EXACTAMENTE estos dos grupos de errores pendientes:
#           app/(panel)/tareas/page.tsx faltante (es de T06) y las
#           referencias a /cambiar-clave y /sin-acceso (son de T04).
npm test -- app/api/rutas-mapeadas
# esperado: verde, con las 33 rutas del 2026-09-08 cubiertas

# 2. El test hace su trabajo: rompelo a propósito
#    Comentá una entrada de MAPA_API en lib/permisos.ts y corré:
npm test -- app/api/rutas-mapeadas
# esperado: FALLA, y el mensaje NOMBRA la ruta que falta.
#    Descomentala. Si pasa en verde con una entrada comentada, el test no sirve.

# 3. Preparate una sesión de nahuel SIN pasar por el login.
#    El login con usuario y clave lo construye T04, que corre en paralelo con vos.
#    Así que la cookie se fabrica, y los permisos se ponen con psql.
npm run usuarios:seed -- nahuel:Nahuel      # ya lo dejó listo T01; es idempotente
psql "$DATABASE_URL" -qc "
  INSERT INTO usuario_secciones (usuario_id, seccion)
  SELECT id, s FROM usuarios, unnest(ARRAY['resumen','finanzas','tareas']) s
   WHERE usuario='nahuel' ON CONFLICT DO NOTHING;"
psql "$DATABASE_URL" -tAc "SELECT id, usuario FROM usuarios ORDER BY id"
# esperado: 1|lucho y 2|nahuel
NAHUEL=$(node tasks/usuarios-y-tareas/_cookie.mjs 2)
LUCHO=$(node tasks/usuarios-y-tareas/_cookie.mjs 1)
# Para el browser: devtools → Application → Cookies → panel_token = ese valor.

# 4. El guard de las PANTALLAS, con la cookie de nahuel puesta en el browser
#      http://127.0.0.1:3005/config      → redirige a /resumen, NO muestra Config
#      http://127.0.0.1:3005/anuncios    → redirige a /resumen
#      http://127.0.0.1:3005/finanzas    → CARGA (tiene permiso)
#      el nav muestra 3 pestañas + Tareas, no 8

# 5. El 403 de la API, que es lo que un filtro de nav no cubre
curl -s -o /dev/null -w 'config    %{http_code}\n' -H "Cookie: panel_token=$NAHUEL" \
  http://127.0.0.1:3005/api/config/settings
# esperado: 403
curl -s -H "Cookie: panel_token=$NAHUEL" http://127.0.0.1:3005/api/finanzas/cuentas | head -c 80
# esperado: {"ok":true,...   (finanzas sí la tiene)
curl -s -o /dev/null -w 'config/lucho %{http_code}\n' -H "Cookie: panel_token=$LUCHO" \
  http://127.0.0.1:3005/api/config/settings
# esperado: 200 (el admin ve todo sin filas en usuario_secciones — D11)

# 6. Las tres rutas de la tabla de D5 — las que un mapa por prefijo se comería
curl -s -o /dev/null -w 'ui-layout %{http_code}\n' -H "Cookie: panel_token=$NAHUEL" \
  'http://127.0.0.1:3005/api/config/ui-layout?pantalla=resumen'
# esperado: 200. Si da 403, la mapeaste a 'config' y le rompiste los widgets de
#           Resumen a nahuel, que es el bug silencioso que D5 existe para evitar.
curl -s -o /dev/null -w 'vistas-ads %{http_code}\n' -H "Cookie: panel_token=$NAHUEL" \
  http://127.0.0.1:3005/api/config/vistas-ads
# esperado: 403 (es de Anuncios, que nahuel NO tiene). Con el mismo mapa que la
#           anterior, una de las dos tiene que estar mal: son la prueba cruzada.
curl -s -o /dev/null -w 'insight %{http_code}\n' -X POST -H "Cookie: panel_token=$NAHUEL" \
  'http://127.0.0.1:3005/api/ia/insight?ambito=resumen'
# esperado: 200 (o el error propio de la feature de IA, pero NO 403)

# 7. Sin cookie ninguna: 401, no 403 y no datos
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3005/api/finanzas/cuentas
# esperado: 401

# 8. Las rutas públicas siguen abiertas
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3005/api/webhooks/shopify
# esperado: 200 (es el healthcheck del GET). Si da 401 o 403, le pusiste el guard a
#           una pública y las ventas dejan de entrar.

# 9. Que no tocaste lo que no es tuyo
git diff --stat -- 'app/(panel)/*/page.tsx' lib/ components/ui.tsx
# esperado: VACÍO menos components/Nav.tsx
```

---

## 8. Cuándo parar

Terminaste cuando los 9 pasos pasan. El paso 2 (romper el test a propósito) **no es opcional**: un test
de cobertura que pasa siempre es peor que no tenerlo, porque da confianza falsa.

**Pará y avisá** si:

- Una de las 33 routes no encaja en ninguna sección. Es una decisión del plan (§4/§5), no tuya: anotala
  en §11 y **no la declares `'publica'` para desbloquearte** — eso abre un endpoint del panel a
  internet.
- `guard()` no puede leer `req.nextUrl.pathname` en alguna route. El plan apoya en que sí (D5).
- Descubrís una octava route que hace su propio `isAuthenticated` inline y no está en la lista de §0.
  Eran siete el 2026-09-08.
- El redirect de `requerirSeccion` te deja en un bucle. Casi seguro es una sección puesta adentro del
  grupo `(panel)` que no debería, o `/sin-acceso` faltando: no lo parchees con un `try/catch`.

**Anotá y seguí** si:

- Te parece que el `<select>` de funnel o el `RangePicker` deberían esconderse para quien no ve Embudo
  ni Ventas. Es razonable y el plan no lo decidió (§6).
- Encontrás un `page.tsx` que hace su propia lectura de `cookies()`. No debería haber ninguno.
