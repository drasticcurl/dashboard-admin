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

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;

  // `/` es la página de login: el middleware no redirige, la página decide
  // (autenticado → /resumen, si no → form).
  const authed = pathname === '/' || (await isAuthenticated(req));

  const res = authed
    ? NextResponse.next()
    : NextResponse.redirect(new URL('/', req.url));

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
