/**
 * Middleware del panel — guard de auth + headers de seguridad.
 *
 * El matcher es la parte que importa: `/api/ingest` y `/api/webhooks/*` tienen
 * que quedar AFUERA. Los llaman los funnels y Shopify con su propia auth
 * (Bearer key / firma HMAC), sin la cookie del panel: si el middleware los
 * interceptara, el tracking y las ventas dejarían de entrar y el panel
 * mostraría ceros sin ningún error visible.
 *
 * POR QUÉ este archivo reimplementa el verify del token en vez de importar
 * `lib/auth.ts`: el middleware de Next 14 corre en Edge, y `lib/auth.ts` usa
 * `node:crypto` (`createHmac`, `timingSafeEqual`), que no existe ahí. Es el
 * mismo formato de token (ts.sig, HMAC-SHA256 con DASHBOARD_PASSWORD como
 * clave), el mismo TTL de 12 h y el mismo skew de 60 s; solo cambia la
 * primitiva (Web Crypto). La verificación timing-safe de verdad vive en
 * `lib/auth.ts` (server); esta es la primera línea.
 */

import { NextResponse, type NextRequest } from 'next/server';

const COOKIE_NAME = 'panel_token';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 h, igual que lib/auth.ts
const CLOCK_SKEW_MS = 60_000;

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Web Crypto no expone timingSafeEqual: la comparación constante en tiempo es
// lo mejor disponible en Edge; la verificación definitiva (node:crypto) la
// hace el layout en el server.
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function isAuthenticated(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) return false;

  const pass = process.env.DASHBOARD_PASSWORD;
  if (!pass) return false;

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return false;

  const ts = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || tsNum <= 0) return false;

  const now = Date.now();
  if (now - tsNum > SESSION_TTL_MS) return false;
  if (tsNum - now > CLOCK_SKEW_MS) return false;

  const expected = await hmacSha256Hex(pass, ts);
  return safeEqualHex(sig, expected);
}

/**
 * La URL del login, en el dominio POR EL QUE ENTRÓ el visitante.
 *
 * NO se usa `new URL('/', req.url)`. En el build standalone detrás de Caddy,
 * `req.url` lo arma Next con la dirección donde escucha el proceso, no con el
 * Host que pidió el browser: el redirect salía a `http://localhost:3000/` y
 * sacaba al usuario del panel cada vez que se le vencía la sesión (12 h) o
 * apretaba Salir. Con PM2 el proceso escucha en 127.0.0.1:3005, así que ese
 * `localhost:3000` no es ni siquiera una dirección que exista.
 *
 * El orden es a propósito:
 *  1. `NEXT_PUBLIC_SITE_URL` — el valor canónico, y `deploy/deploy.sh` (§6) ya
 *     aborta el deploy si falta. Es el único que no depende de headers que
 *     puede escribir el cliente.
 *  2. `x-forwarded-host` + `x-forwarded-proto` — lo que manda Caddy. Sólo se
 *     usa si no hay (1), porque un header de estos es texto libre para quien
 *     llegue sin pasar por el proxy.
 *  3. `req.nextUrl` — dev local sin proxy, donde el host sí es el real.
 */
export function urlDeLogin(req: NextRequest): URL {
  const canonica = process.env.NEXT_PUBLIC_SITE_URL;
  if (canonica) {
    try {
      return new URL('/', canonica);
    } catch {
      // Una env var mal escrita no puede dejar el panel sin redirect: se cae a
      // los headers de abajo.
    }
  }

  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (host) {
    // Caddy termina el TLS, así que el proto real viaja en el header; sin él,
    // asumir https en cualquier host que no sea local es lo correcto para este
    // panel (el HTTP de producción lo redirige Caddy igual).
    const proto =
      req.headers.get('x-forwarded-proto') ??
      (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');
    try {
      return new URL('/', `${proto}://${host}`);
    } catch {
      // idem
    }
  }

  const local = req.nextUrl.clone();
  local.pathname = '/';
  local.search = '';
  return local;
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  // `/` es la página de login: el middleware no redirige, la página decide
  // (autenticado → /resumen, si no → form).
  const authed = pathname === '/' || (await isAuthenticated(req));

  const res = authed
    ? NextResponse.next()
    : NextResponse.redirect(urlDeLogin(req));

  // Panel con datos de ventas en un subdominio público (D16): nada cacheable,
  // nada indexable.
  res.headers.set('Cache-Control', 'no-store, must-revalidate');
  res.headers.set('X-Robots-Tag', 'noindex, nofollow');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  return res;
}

export const config = {
  matcher: ['/((?!api/ingest|api/webhooks|_next/static|_next/image|favicon.ico).*)'],
};
