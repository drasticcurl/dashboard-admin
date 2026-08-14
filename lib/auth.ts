/**
 * Auth del panel — password-gate simple, copiado de
 * `testfunnel/lib/admin/auth.ts` (D16 del plan: "se copia el mecanismo que ya
 * está probado", no se reinventa).
 *
 * Modelo de seguridad:
 *  - Password en env `DASHBOARD_PASSWORD` (única fuente de verdad).
 *  - Cookie `panel_token` = `${ts}.${hmac}` con HMAC-SHA256 sobre `${ts}`
 *    usando DASHBOARD_PASSWORD como secret. La cookie NUNCA contiene el password
 *    en plano y NO se puede forjar sin conocerlo.
 *  - Verificación timing-safe (`crypto.timingSafeEqual`) tanto del password
 *    en el login como del HMAC en cada request → evita timing attacks que
 *    bruteforcean caracter por caracter.
 *  - Rate limit por IP: 5 intentos / 15 min. Después 401 + Retry-After.
 *  - TTL de sesión: 12 h (configurable). Renovación = re-login.
 *  - Cookie `httpOnly`, `sameSite=lax`, `secure` en prod, `path=/`.
 *
 * Reglas operativas:
 *  - DASHBOARD_PASSWORD requerido. Si falta, TODOS los checks fallan (no abre
 *    el panel "por accidento"). Logueamos warning una sola vez.
 *  - El password debe tener al menos 24 chars. Si es más corto, logueamos
 *    warning pero no bloqueamos (deploy realista).
 *  - La password NUNCA viaja en query params, solo POST body.
 *
 * Este modulo es server-only (importa `node:crypto`): NO se importa desde
 * middleware.ts, que corre en Edge y tiene su propia copia del verify con
 * Web Crypto (ver §10).
 */

import crypto from 'node:crypto';

// ─── Constantes públicas ───────────────────────────────────────────────────

export const PANEL_COOKIE_NAME = 'panel_token';
export const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 h

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 min
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const MIN_PASSWORD_LENGTH = 24;

// ─── Warnings de configuración (una sola vez por proceso) ──────────────────

let warnedMissing = false;
let warnedShort = false;

function getPanelPassword(): string | null {
  const pass = process.env.DASHBOARD_PASSWORD;
  if (!pass) {
    if (!warnedMissing) {
      console.warn(
        '[auth] DASHBOARD_PASSWORD no configurado — todo el panel queda bloqueado.',
      );
      warnedMissing = true;
    }
    return null;
  }
  if (pass.length < MIN_PASSWORD_LENGTH && !warnedShort) {
    console.warn(
      `[auth] DASHBOARD_PASSWORD tiene ${pass.length} chars — recomendado >= ${MIN_PASSWORD_LENGTH}.`,
    );
    warnedShort = true;
  }
  return pass;
}

/** `true` solo si hay una password configurada. Todo lo demás cierra en `false`. */
export function isConfigured(): boolean {
  return getPanelPassword() !== null;
}

// ─── HMAC token ────────────────────────────────────────────────────────────

function hmac(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Genera el valor de la cookie firmada para un timestamp dado.
 * Retorna `null` si no hay password configurada: el login tiene que fallar
 * cerrado, nunca "entra cualquiera porque no hay password".
 */
export function signSessionToken(nowMs: number = Date.now()): string | null {
  const pass = getPanelPassword();
  if (!pass) return null;
  const ts = String(nowMs);
  const sig = hmac(pass, ts);
  return `${ts}.${sig}`;
}

/** Verifica el HMAC y la expiración de un token. Timing-safe. */
export function verifySessionToken(
  token: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!token || typeof token !== 'string') return false;
  const pass = getPanelPassword();
  if (!pass) return false;

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return false;

  const ts = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  // ts debe ser un entero positivo razonable
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || tsNum <= 0) return false;

  // Expiración
  if (nowMs - tsNum > SESSION_TTL_SECONDS * 1000) return false;
  // Tampoco aceptamos timestamps del futuro (clock skew razonable)
  if (tsNum - nowMs > 60_000) return false;

  // HMAC esperado
  const expected = hmac(pass, ts);
  return safeEqualHex(sig, expected);
}

/** Compara dos strings hex en tiempo constante. */
function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    const ab = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    if (ab.length === 0 || ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

// ─── Verificación de password (timing-safe) ────────────────────────────────

export function verifyPassword(input: string | undefined): boolean {
  const pass = getPanelPassword();
  if (!pass) return false;
  if (typeof input !== 'string' || input.length === 0) return false;
  // Si los largos no matchean, comparamos contra sí mismo para no leakear
  // timing por length.
  const a = Buffer.from(input);
  const b = Buffer.from(pass);
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

// ─── Cookie helpers ────────────────────────────────────────────────────────

export function sessionCookieOptions(): {
  httpOnly: boolean;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  };
}

export function clearSessionCookieOptions(): {
  httpOnly: boolean;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return { ...sessionCookieOptions(), maxAge: 0 };
}

// ─── IP del visitante ──────────────────────────────────────────────────────
//
// La resolución está inline (no hay lib/clientIp.ts en este repo, T01 no lo
// creó). Topología: visitante → Cloudflare (proxy) → Caddy → Node. Cloudflare
// y Caddy APENDEAN a `x-forwarded-for`, así que el primer token es texto libre
// del atacante y el último el que agregó el proxy de confianza.
//
// Orden de confianza:
//   1. `cf-connecting-ip` — Cloudflare lo sobreescribe siempre.
//   2. `x-real-ip` — lo setea Caddy con `header_up X-Real-IP {client_ip}`.
//   3. último token de `x-forwarded-for` — fallback.
//   4. `undefined` — dev local sin proxy.

type HeaderLike = { get(name: string): string | null };

export function getClientIp(headers: HeaderLike): string {
  const cf = headers.get('cf-connecting-ip')?.trim();
  if (cf) return cf;

  const real = headers.get('x-real-ip')?.trim();
  if (real) return real;

  const parts = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return parts.at(-1) ?? 'unknown';
}

// ─── Rate limit (in-memory, por IP) ────────────────────────────────────────
//
// Ventana fija deslizante por simplicidad. El bucket vive en la memoria del
// proceso: con N instancias el límite efectivo se multiplica por N. El panel
// corre en UNA sola instancia (PM2, 127.0.0.1:3005), así todos los intentos
// de login caen en el mismo bucket. Si algún día se balancea entre
// instancias, hay que mover el bucket a Redis (INCR + EXPIRE).

type Bucket = { count: number; firstTs: number };

declare global {
  // eslint-disable-next-line no-var
  var __panelRateLimit: Map<string, Bucket> | undefined;
}

function getBuckets(): Map<string, Bucket> {
  if (!globalThis.__panelRateLimit) {
    globalThis.__panelRateLimit = new Map();
  }
  return globalThis.__panelRateLimit;
}

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export function checkLoginRateLimit(
  ip: string,
  nowMs: number = Date.now(),
): RateLimitResult {
  const buckets = getBuckets();
  const b = buckets.get(ip);

  // GC oportunista: limpia 1 bucket viejo al azar para que no crezca
  // indefinidamente.
  if (buckets.size > 1024) {
    const firstKey = buckets.keys().next().value;
    if (firstKey !== undefined) buckets.delete(firstKey);
  }

  if (!b || nowMs - b.firstTs > RATE_LIMIT_WINDOW_MS) {
    buckets.set(ip, { count: 1, firstTs: nowMs });
    return { allowed: true };
  }

  if (b.count >= RATE_LIMIT_MAX_ATTEMPTS) {
    const retryAfterSeconds = Math.ceil(
      (b.firstTs + RATE_LIMIT_WINDOW_MS - nowMs) / 1000,
    );
    return { allowed: false, retryAfterSeconds: Math.max(1, retryAfterSeconds) };
  }

  b.count += 1;
  return { allowed: true };
}

/** Resetea el contador de un IP tras un login exitoso. */
export function resetLoginRateLimit(ip: string): void {
  getBuckets().delete(ip);
}

// ─── API alto nivel ────────────────────────────────────────────────────────

/**
 * Verifica si el request tiene una sesión válida (lee cookie firmada).
 * Acepta cualquier objeto con `cookies.get(name)?.value` (NextRequest,
 * `cookies()` de next/headers).
 */
export function isAuthenticated(cookies: {
  get: (name: string) => { value: string } | undefined;
}): boolean {
  const c = cookies.get(PANEL_COOKIE_NAME);
  if (!c) return false;
  return verifySessionToken(c.value);
}
