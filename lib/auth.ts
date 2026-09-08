/**
 * Auth del panel — identidad por usuario, permisos leídos de la base.
 *
 * Hasta la migración 030 el panel se autenticaba con UNA contraseña compartida
 * (`DASHBOARD_PASSWORD`) y la cookie no llevaba identidad. Este módulo la lleva:
 *
 * Modelo de seguridad:
 *  - La cookie `panel_token` = `${usuarioId}.${ts}.${hmac}` con HMAC-SHA256
 *    sobre `${usuarioId}.${ts}` (el punto va DENTRO del payload firmado, D2).
 *    El secreto de firma es `PANEL_SESSION_SECRET`, con default a
 *    `DASHBOARD_PASSWORD` (ver `secretoDeFirma`, D1). La cookie NO se puede
 *    forjar sin conocer el secreto, y editarle el id invalida la firma.
 *  - La clave de cada usuario se hashea con scrypt de `node:crypto`
 *    (`scrypt$<N>$<r>$<p>$<salt hex>$<derivada hex>`, D7). Los parámetros van EN
 *    la fila, así que subir el costo no invalida los hashes viejos.
 *  - Verificación timing-safe (`crypto.timingSafeEqual`) del HMAC de la cookie y
 *    de la derivada de scrypt, con el chequeo de longitud ANTES (que no es una
 *    optimización: `timingSafeEqual` tira si las longitudes difieren).
 *  - Rate limit por IP: 5 intentos / 15 min. Después 401 + Retry-After.
 *  - TTL de sesión: 12 h. Renovación = re-login.
 *  - Cookie `httpOnly`, `sameSite=lax`, `secure` en prod, `path=/`.
 *
 * Reglas operativas:
 *  - El secreto de firma es requerido. Si falta (ni PANEL_SESSION_SECRET ni
 *    DASHBOARD_PASSWORD), TODOS los checks fallan (no abre el panel "por
 *    accidente"). Se loguea un warning una sola vez por proceso (`warnedMissing`).
 *  - Rotar `PANEL_SESSION_SECRET` invalida las sesiones de TODOS y es la única
 *    palanca que existe para echar a alguien en el acto (plan P-02): no hay
 *    tabla de sesiones ni denylist, y el logout sólo borra la cookie.
 *  - La clave NUNCA viaja en query params, solo POST body. Un hash NUNCA sale en
 *    un JSON (lo garantiza `lib/queries/usuarios.ts`: sólo `usuarioPorNombre`
 *    devuelve `claveHash`, y sólo lo usa el login del server).
 *
 * Este módulo es server-only (importa `node:crypto`): NO se importa desde
 * middleware.ts, que corre en Edge y tiene su propia copia del verify con
 * Web Crypto (ver su docblock). Las dos primitivas TIENEN que firmar igual —
 * está afirmado en `tasks/usuarios-y-tareas/_verificacion-sesion.mjs` (afirm. 7).
 */

import crypto from 'node:crypto';

// ─── Constantes públicas ───────────────────────────────────────────────────

export const PANEL_COOKIE_NAME = 'panel_token';
export const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 h

/**
 * Largo mínimo de una clave de usuario, en el CAMBIO de clave (D8). No se aplica
 * acá ni en `hashearClave`: el seed tiene que poder sembrar '123456' (6 chars),
 * que la primera pantalla obliga a cambiar. La validación de este mínimo vive en
 * el route de cambio de clave (T04), no en esta capa.
 *
 * Es distinto de `MIN_PASSWORD_LENGTH` (24), que es el mínimo recomendado del
 * `DASHBOARD_PASSWORD` compartido y sigue siendo sólo un warning.
 */
export const MIN_LARGO_CLAVE = 15;

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 min
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const MIN_PASSWORD_LENGTH = 24;

// ─── Parámetros de scrypt (D7) ─────────────────────────────────────────────
//
// Se usan al HASHEAR. Al VERIFICAR, N/r/p salen de la fila que se comprueba (no
// de acá): es lo único que permite subir el costo sin invalidar los hashes ya
// guardados. Medido en este repo con Node v24: ~30 ms en régimen, ~99 ms la
// primera del proceso.

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32; // 32 bytes derivados
const SCRYPT_SALT_BYTES = 16;

// ─── Warnings de configuración (una sola vez por proceso) ──────────────────

let warnedMissing = false;
let warnedShort = false;

/**
 * El secreto con el que se firma la cookie. Default: DASHBOARD_PASSWORD.
 *
 * El default NO es pereza. Las dos instancias (hilvanapp e infinix) deployan del
 * mismo origin/main y ninguna declara esta variable todavía: sin el default, el
 * próximo deploy las deja a las dos sin poder firmar una sesión. Es la regla de
 * `.kiro/steering/instancias.md` — el default es siempre el valor histórico de
 * hilvanapp. Y por eso NO va en el array REQUIRED de deploy/deploy.sh:177.
 *
 * Rotarlo invalida las sesiones de TODOS y es la única palanca que existe para
 * echar a alguien en el acto (plan P-02).
 *
 * Falla cerrado: si no hay ni PANEL_SESSION_SECRET ni DASHBOARD_PASSWORD,
 * devuelve null y todos los checks de abajo cierran en false/null.
 */
function secretoDeFirma(): string | null {
  const secret = process.env.PANEL_SESSION_SECRET || process.env.DASHBOARD_PASSWORD;
  if (!secret) {
    if (!warnedMissing) {
      console.warn(
        '[auth] ni PANEL_SESSION_SECRET ni DASHBOARD_PASSWORD configurados — ' +
          'todo el panel queda bloqueado (no se puede firmar ni verificar sesión).',
      );
      warnedMissing = true;
    }
    return null;
  }
  return secret;
}

/**
 * La contraseña compartida, sólo para el fallback de D10 (`verifyPassword`).
 * Distinta de `secretoDeFirma`: el fallback compara la clave tipeada contra
 * DASHBOARD_PASSWORD, no contra el secreto de firma (aunque hoy por default sean
 * el mismo string, son dos conceptos y se separan a propósito).
 */
function getPanelPassword(): string | null {
  const pass = process.env.DASHBOARD_PASSWORD;
  if (!pass) return null;
  if (pass.length < MIN_PASSWORD_LENGTH && !warnedShort) {
    console.warn(
      `[auth] DASHBOARD_PASSWORD tiene ${pass.length} chars — recomendado >= ${MIN_PASSWORD_LENGTH}.`,
    );
    warnedShort = true;
  }
  return pass;
}

/** `true` solo si hay un secreto de firma configurado. Todo lo demás cierra. */
export function isConfigured(): boolean {
  return secretoDeFirma() !== null;
}

// ─── HMAC token ────────────────────────────────────────────────────────────

function hmac(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Firma la cookie de un usuario. Formato `${usuarioId}.${ts}.${hmac}` donde el
 * HMAC se calcula sobre `${usuarioId}.${ts}` — el punto DENTRO del payload (D2):
 * sin él, id=1/ts=23 y id=12/ts=3 firmarían igual.
 *
 * Retorna `null` si no hay secreto configurado: el login tiene que fallar
 * cerrado, nunca "entra cualquiera porque no hay secreto".
 */
export function signSessionToken(usuarioId: number, nowMs: number = Date.now()): string | null {
  const secret = secretoDeFirma();
  if (!secret) return null;
  const payload = `${usuarioId}.${nowMs}`;
  const sig = hmac(secret, payload);
  return `${payload}.${sig}`;
}

/**
 * Verifica firma y expiración de un token y devuelve el usuarioId, o `null`.
 *
 * El parser exige EXACTAMENTE 3 campos, `/^\d+$/` en los dos primeros (no
 * `Number()`: `Number('7e2')` es 700 y `Number(' 7')` es 7, así que dos strings
 * distintos darían el mismo id con firmas distintas), y 64 hex en el tercero. Un
 * token viejo de 2 campos se RECHAZA, no se malinterpreta (todas las sesiones
 * vivas se cortan en el deploy — es el fallo seguro, D2).
 */
export function verifySessionToken(
  token: string | undefined,
  nowMs: number = Date.now(),
): { usuarioId: number } | null {
  if (!token || typeof token !== 'string') return null;
  const secret = secretoDeFirma();
  if (!secret) return null;

  const partes = token.split('.');
  if (partes.length !== 3) return null;
  const [idStr, tsStr, sig] = partes;

  // Enteros positivos sin notación exponencial ni espacios. `/^\d+$/`, no Number().
  if (!/^\d+$/.test(idStr) || !/^\d+$/.test(tsStr)) return null;
  // La firma tiene que ser 64 hex (SHA-256): un largo distinto es un token
  // corrupto o forjado.
  if (!/^[0-9a-f]{64}$/.test(sig)) return null;

  const tsNum = Number(tsStr);
  // Expiración.
  if (nowMs - tsNum > SESSION_TTL_SECONDS * 1000) return null;
  // Tampoco aceptamos timestamps del futuro (clock skew razonable de 60 s).
  if (tsNum - nowMs > 60_000) return null;

  // El payload firmado es `${id}.${ts}`, con el punto adentro (D2).
  const expected = hmac(secret, `${idStr}.${tsStr}`);
  if (!safeEqualHex(sig, expected)) return null;

  return { usuarioId: Number(idStr) };
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

// ─── Hash de claves de usuario (scrypt async, D7) ──────────────────────────

/**
 * Hashea una clave con scrypt. Formato:
 *   `scrypt$<N>$<r>$<p>$<salt hex>$<derivada hex>`
 *
 * scrypt ASYNC y no `scryptSync`: `scryptSync` bloquea el event loop de Next los
 * ~30-99 ms que cuesta, y el login no es el único request en vuelo. El salt es
 * aleatorio por hash, así que dos llamadas con la misma clave dan hashes
 * distintos.
 *
 * NO valida el largo mínimo: eso es `MIN_LARGO_CLAVE`, que aplica T04 en el
 * cambio de clave. Acá el seed tiene que poder sembrar '123456'.
 */
export function hashearClave(clave: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
    crypto.scrypt(
      clave,
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
      (err, derivada) => {
        if (err) return reject(err);
        resolve(
          `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derivada.toString('hex')}`,
        );
      },
    );
  });
}

/**
 * Verifica una clave contra un hash guardado. Lee N/r/p/salt/keylen DE LA FILA
 * (no de las constantes del módulo): es lo que permite subir el costo más
 * adelante sin invalidar los hashes viejos. Comparación timing-safe con chequeo
 * de longitud antes.
 */
export function verificarClave(clave: string, guardado: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof clave !== 'string' || typeof guardado !== 'string') return resolve(false);
    const partes = guardado.split('$');
    if (partes.length !== 6 || partes[0] !== 'scrypt') return resolve(false);
    const [, nStr, rStr, pStr, saltHex, dkHex] = partes;
    const N = Number(nStr);
    const r = Number(rStr);
    const p = Number(pStr);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
      return resolve(false);
    }
    let salt: Buffer;
    let esperado: Buffer;
    try {
      salt = Buffer.from(saltHex, 'hex');
      esperado = Buffer.from(dkHex, 'hex');
    } catch {
      return resolve(false);
    }
    if (esperado.length === 0) return resolve(false);
    // El keylen sale del hash guardado (largo de la derivada), no de la constante.
    crypto.scrypt(clave, salt, esperado.length, { N, r, p }, (err, derivada) => {
      if (err) return resolve(false);
      // Chequeo de longitud ANTES: timingSafeEqual tira si difieren.
      if (derivada.length !== esperado.length) return resolve(false);
      resolve(crypto.timingSafeEqual(derivada, esperado));
    });
  });
}

// ─── Verificación de la contraseña compartida (timing-safe) ────────────────
//
// Se conserva SÓLO para el fallback de D10: con la tabla `usuarios` vacía,
// `lib/permisos.ts` acepta DASHBOARD_PASSWORD y esa sesión vale como admin.
// `app/page.tsx` (T04) la llama en esa rama.

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
 * `true` si el request trae una cookie con firma y expiración válidas. Es un
 * chequeo de PRESENCIA de sesión, no de PERMISO: el permiso se lee de la base
 * en `lib/permisos.ts` (D3).
 *
 * Se conserva con la misma firma (devuelve boolean) porque lo importan varias
 * routes de `/api/**` y el layout del panel, que son de T03 y T04. Cambiarle la
 * firma sin necesidad rompería esos archivos ajenos antes de que sus tasks
 * corran. `verifySessionToken` ahora devuelve `{ usuarioId }`; acá se colapsa a
 * boolean para el caller que sólo pregunta "¿hay sesión?".
 *
 * Acepta cualquier objeto con `cookies.get(name)?.value` (NextRequest,
 * `cookies()` de next/headers).
 */
export function isAuthenticated(cookies: {
  get: (name: string) => { value: string } | undefined;
}): boolean {
  const c = cookies.get(PANEL_COOKIE_NAME);
  if (!c) return false;
  return verifySessionToken(c.value) !== null;
}
