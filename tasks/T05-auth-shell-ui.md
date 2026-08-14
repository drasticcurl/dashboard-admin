# T05 — Auth, shell de la app y kit de UI compartido

- **Depende de:** T01.
- **Bloquea:** T06, T07, T08 y T09. Las cuatro importan `components/ui.tsx` y viven dentro del
  layout que crea este task.
- **Paralelizable con:** T02, T03, T04, T10, T11.
- **Repo:** `~/Desktop/funnel/dashboard-admin`
- **Archivos:** `lib/auth.ts`, `lib/auth.test.ts`, `app/layout.tsx`, `app/page.tsx`,
  `app/(panel)/layout.tsx`, `components/ui.tsx`, `components/Nav.tsx`, `components/RangePicker.tsx`,
  `middleware.ts`, `tailwind.config.ts` (solo la paleta). **Nada más.** No crees páginas de secciones:
  son de T06-T09.

Decisión que gobierna este task: **D16** del plan.

---

## 1. Objetivo

Que exista un panel con login, navegación entre las cuatro secciones, selector de rango global, y un
kit de componentes que las cuatro secciones usen sin volver a inventar una tarjeta de métrica.

## 2. `lib/auth.ts` — copiar, no reinventar

**Copiá `~/Desktop/funnel/testfunnel/lib/admin/auth.ts`** y adaptá los nombres. Ese archivo ya
resolvió: HMAC del timestamp con la password como clave (la password nunca viaja en la cookie),
comparación con `crypto.timingSafeEqual`, tolerancia de 60 s para relojes desfasados, TTL de 12 h y
rate limit en memoria de 5 intentos / 15 min por IP con GC oportunista.

Cambios respecto del original:

| Original | Acá |
|---|---|
| `ADMIN_PASSWORD` | `DASHBOARD_PASSWORD` |
| cookie `admin_token` | cookie `panel_token` |
| `path: '/'` | `path: '/'` (dejalo así; el docstring del original dice `/admin` y el código dice `/`, y `/` es lo correcto para este proyecto) |

API que tiene que exportar:

```ts
export function isConfigured(): boolean;
export function verifyPassword(input: string): boolean;
export function signSessionToken(): string;
export function verifySessionToken(token: string | undefined): boolean;
export function isAuthenticated(cookies: { get(name: string): { value: string } | undefined }): boolean;
export function sessionCookieOptions(): { httpOnly: true; sameSite: 'lax'; secure: boolean; path: string; maxAge: number };
export function checkLoginRateLimit(ip: string): { allowed: boolean; retryAfterSeconds?: number };
```

Si falta `DASHBOARD_PASSWORD`, **todo** falla cerrado: `isConfigured()` en `false` y el login rechaza
siempre. Nunca "si no hay password, entra cualquiera".

Warning en consola si la password tiene menos de 24 caracteres. Es un panel con las ventas de todos
los funnels en un subdominio público: una password corta es la única cosa entre eso e internet.

Portá también los tests de `lib/admin/auth.test.ts` si existen en el repo original; si no existen,
escribí: token válido pasa, token vencido no, token del futuro no, token con firma de otra password
no, formato inválido no, y el rate limit corta al 6º intento y se resetea al éxito.

## 3. `middleware.ts`

Un middleware corto, y **el matcher es la parte que importa**:

```ts
export const config = {
  matcher: ['/((?!api/ingest|api/webhooks|_next/static|_next/image|favicon.ico).*)'],
};
```

`/api/ingest` y `/api/webhooks/*` **tienen que quedar afuera**: los llaman los funnels y Shopify, que
no tienen la cookie del panel. Si el middleware los intercepta, el tracking y las ventas dejan de
entrar y el panel muestra ceros sin ningún error visible. Es el modo de falla más difícil de
diagnosticar de todo el proyecto.

Lo que hace: si la ruta no es `/` y no está autenticado → redirect a `/`. Y en todas las respuestas:

```
Cache-Control: no-store, must-revalidate
X-Robots-Tag: noindex, nofollow
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
```

## 4. `app/layout.tsx` y `app/page.tsx`

`app/layout.tsx` reemplaza el placeholder de T01: `<html lang="es">`, fuente del sistema o una de
Google si querés (una sola, sin variantes), `globals.css`, y
`metadata = { title: 'Panel', robots: { index: false, follow: false } }`.

`app/page.tsx` (server component):

- Si está autenticado → `redirect('/resumen')`.
- Si no → el formulario de login, con **server action**: valida el rate limit por IP (la IP sale de
  `x-real-ip`, que es la que setea Caddy con `{client_ip}`), verifica la password, setea la cookie y
  redirige. El mensaje de error es genérico (`'Contraseña incorrecta'`), sin distinguir "password
  mala" de "rate limit", y sin decir si la password está configurada.
- El logout es otra server action en `app/(panel)/layout.tsx` que borra la cookie.

Este es el patrón exacto de `app/admin/page.tsx` de los funnels. Leelo.

## 5. `app/(panel)/layout.tsx`

Route group para que las cuatro secciones compartan el shell sin que la URL diga `(panel)`.

- Guard: `if (!isAuthenticated(cookies())) redirect('/')`. El middleware ya cubre esto, pero el guard
  en el layout es la defensa que queda si alguien toca el matcher.
- `export const dynamic = 'force-dynamic'`. Un panel de métricas cacheado no sirve para nada.
- Contenido: `<Nav/>`, el `<RangePicker/>`, el botón de logout, y `{children}`.

## 6. `components/Nav.tsx`

Cuatro tabs, en este orden, porque es el orden en que se mira un panel:

| Tab | Ruta | Qué es |
|---|---|---|
| Resumen | `/resumen` | unificado de todos los funnels (T08) |
| Embudo | `/embudo` | paso a paso, por funnel (T06) |
| Ventas | `/ventas` | por funnel (T07) |
| Leads | `/leads` | desde Supabase (T09) |
| Config | `/config` | funnels, pasos, productos (T09) |

Marcá la activa con `usePathname()`. Los links a rutas que todavía no existen (T06-T09 corren después
o en paralelo) **no rompen el build**: Next resuelve `href` en runtime.

Al lado de las tabs va el **selector de funnel**, un `<select>` con los funnels activos, que persiste
en el query string (`?f=<slug>`). Vive acá y no en cada sección porque Embudo y Ventas lo comparten:
cambiar de funnel no puede perder el rango elegido, y viceversa.

## 7. `components/RangePicker.tsx`

Presets del `RangePreset` de `lib/day.ts` (T01): hoy, ayer, 7 días, 14 días, 30 días, mes actual,
todo. Escribe `?range=` en la URL sin recargar (`useRouter().replace`, `scroll: false`).

Copiá el comportamiento de `components/admin/RangePicker.tsx` de los funnels, que ya está probado, y
sacale lo que no aplique.

## 8. `components/ui.tsx` — el kit compartido

Este archivo es la razón por la que T06-T09 pueden correr en paralelo sin pisarse. Exportá **todo lo
que las cuatro secciones van a necesitar**, aunque este task no lo use:

```ts
export function Card(props: { title?: string; hint?: string; children: ReactNode; className?: string }): JSX.Element;
export function StatCard(props: { label: string; value: string; sub?: string; tone?: Tone; trend?: number }): JSX.Element;
export function Badge(props: { children: ReactNode; tone?: Tone }): JSX.Element;
export function Banner(props: { tone: Tone; title?: string; children: ReactNode }): JSX.Element;
export function Table<T>(props: { rows: T[]; columns: Column<T>[]; empty?: string }): JSX.Element;
export function BarRow(props: { label: string; pct: number; count: number; tone?: Tone; highlight?: boolean }): JSX.Element;
export function Spinner(): JSX.Element;
export function EmptyState(props: { title: string; hint?: string }): JSX.Element;

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';

// formateadores — uno solo por concepto, para que las cuatro secciones no formateen distinto
export function fmtInt(n: number): string;                       // 12.345
export function fmtPct(n: number, decimals?: number): string;     // 12,3 %
export function fmtMoney(n: number, currency: string): string;    // € 1.234,56 · $ 1.234,56
export function fmtDate(iso: string): string;                     // 11 ago
export function fmtDateTime(iso: string): string;                 // 11 ago 14:03
```

`fmtInt`, `fmtPct` y `fmtMoney` usan `Intl.NumberFormat('es-AR')`. **No agregues `date-fns`**: no está
en las dependencias que declaró T01 y no hace falta, `Intl.DateTimeFormat` alcanza.

`BarRow` es la barra horizontal del embudo: label a la izquierda, barra proporcional, porcentaje y
conteo a la derecha, y un modo `highlight` para marcar el peor paso. Es el componente que hace que el
embudo se lea de un vistazo, así que dedicale atención: alto fijo por fila, sin animaciones de
entrada, contraste suficiente para leerlo de lejos.

**Accesibilidad, no opcional:** las barras llevan `role="img"` con `aria-label` que dice el label, el
porcentaje y el conteo (un lector de pantalla no ve el ancho de un div); los colores nunca son el
único portador de información (el peor paso lleva además un texto, no solo rojo); todo control
interactivo es un `<button>` o `<a>` real, alcanzable con Tab y con foco visible.

## 9. Paleta

Tema **oscuro**, como el `/admin` de los funnels. En `tailwind.config.ts` definí solo lo que uses:
fondo, superficie, superficie elevada, borde, texto primario, texto atenuado, y los cinco tonos
(`neutral`, `good`, `warn`, `bad`, `info`). Nada de una escala de 50 a 950 por color: es un panel
interno de cinco pantallas.

Cada funnel tiene su `color` en la tabla `funnels` (§3.1): usalo para el punto de color que
identifica al funnel en el Resumen, y **para nada más**. No pintes toda la UI según el funnel
elegido.

## 10. Verificación

```bash
cd ~/Desktop/funnel/dashboard-admin
npx tsc --noEmit && npm run build && npm test

npm run dev

# 1 — sin cookie, cualquier ruta cae en el login
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' http://127.0.0.1:3005/resumen
# esperado: 307 http://127.0.0.1:3005/

# 2 — el ingest y el webhook NO pasan por el middleware
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3005/api/ingest \
  -H 'Authorization: Bearer nope' -d '{}'
# esperado 401 (del propio endpoint), NUNCA 307. Si redirige, el matcher está mal.

# 3 — headers
curl -sSI http://127.0.0.1:3005/ | grep -iE 'cache-control|x-robots-tag'
# no-store · noindex

# 4 — login a mano en el browser: password mala 6 veces seguidas → corta por rate limit
```

Y a ojo, en el browser: las cinco tabs navegan (las que todavía no existen dan 404 de Next, que es lo
esperado hasta que corran T06-T09), el rango y el funnel elegidos sobreviven al cambio de tab, y el
logout vuelve al login.

## 11. Cuándo parar

Si `DASHBOARD_PASSWORD` no está seteada, el login tiene que rechazar todo: eso es correcto, no es un
bug que haya que puentear con un modo dev. Si te encontrás escribiendo un `if (dev) skipAuth()`,
pará: T06-T09 pueden trabajar logueados igual que en producción.
