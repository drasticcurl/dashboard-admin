/**
 * Tests del redirect al login del middleware.
 *
 * EL BUG QUE ORIGINÓ ESTE ARCHIVO: el redirect se armaba con
 * `new URL('/', req.url)`, y en el build standalone detrás de Caddy `req.url`
 * lleva la dirección donde escucha el proceso, no el Host que pidió el browser.
 * Al vencerse la sesión, el panel de producción mandaba al usuario a
 * `http://localhost:3000/` — una dirección que en la VPS no existe, porque el
 * proceso escucha en 127.0.0.1:3005.
 *
 * Estos tests fijan el orden de precedencia, que es lo que importa: la env var
 * canónica primero, después los headers del proxy, y recién al final la URL del
 * request.
 */
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { middleware, urlDeLogin } from './middleware';

const original = process.env.NEXT_PUBLIC_SITE_URL;

afterEach(() => {
  if (original === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = original;
});

/**
 * Un request como el que llega en producción: la URL interna es la del proceso
 * (que es de donde salía el localhost:3000) y el dominio real viaja en los
 * headers que agrega Caddy.
 */
function requestDeProduccion(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/resumen', { headers });
}

describe('urlDeLogin', () => {
  it('usa NEXT_PUBLIC_SITE_URL cuando está, y nunca la URL interna', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://panel.hilvanapp.com';
    const url = urlDeLogin(requestDeProduccion());
    expect(url.toString()).toBe('https://panel.hilvanapp.com/');
    expect(url.host).not.toContain('localhost');
  });

  it('la env var gana sobre los headers del proxy (un header lo escribe el cliente)', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://panel.hilvanapp.com';
    const url = urlDeLogin(
      requestDeProduccion({ 'x-forwarded-host': 'atacante.example', 'x-forwarded-proto': 'http' }),
    );
    expect(url.toString()).toBe('https://panel.hilvanapp.com/');
  });

  it('sin env var, cae en x-forwarded-host + x-forwarded-proto (lo que manda Caddy)', () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const url = urlDeLogin(
      requestDeProduccion({ 'x-forwarded-host': 'panel.hilvanapp.com', 'x-forwarded-proto': 'https' }),
    );
    expect(url.toString()).toBe('https://panel.hilvanapp.com/');
  });

  it('sin x-forwarded-proto, un host que no es local se asume https', () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const url = urlDeLogin(requestDeProduccion({ host: 'panel.hilvanapp.com' }));
    expect(url.toString()).toBe('https://panel.hilvanapp.com/');
  });

  it('en dev local sigue siendo http y el puerto real', () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const req = new NextRequest('http://localhost:3005/resumen', { headers: { host: 'localhost:3005' } });
    const url = urlDeLogin(req);
    expect(url.toString()).toBe('http://localhost:3005/');
  });

  it('una env var mal escrita no rompe el redirect: cae a los headers', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'no-es-una-url';
    const url = urlDeLogin(
      requestDeProduccion({ 'x-forwarded-host': 'panel.hilvanapp.com', 'x-forwarded-proto': 'https' }),
    );
    expect(url.toString()).toBe('https://panel.hilvanapp.com/');
  });

  it('siempre apunta a la raíz y sin query string', () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const req = new NextRequest('http://localhost:3005/ventas?f=quiz&range=30d', {
      headers: { host: 'localhost:3005' },
    });
    const url = urlDeLogin(req);
    expect(url.pathname).toBe('/');
    expect(url.search).toBe('');
  });
});

/**
 * `middleware()`: sin sesión, una RUTA DE API tiene que devolver un 401 con
 * cuerpo JSON — nunca el redirect 307 a `/` que usa el resto del panel.
 *
 * EL BUG QUE ORIGINÓ ESTE BLOQUE: con sesión vencida, `GET
 * /api/data/ads?...&forzar=1` (el Boton_Actualizar) volvía un 307 a `/`.
 * `fetch` sigue ese redirect solo y `leerFilas` (`GestorAnuncios.tsx`) le pasa
 * el HTML de la pantalla de login a `res.json()`, que tira. El aviso en
 * pantalla mostraba el error de ESE parseo y no el problema real (la sesión
 * venció): «Unexpected token '<'» en Chrome, «The string did not match the
 * expected pattern» en Safari — confirmado en el log de Caddy de producción,
 * donde ese pedido con `forzar=1` volvió `status: 307` en vez de `200`.
 *
 * Cada route de `/api/**` ya hace su propio `isAuthenticated(...)` → 401 JSON
 * (es el guard de "sin cookie, nunca datos" que el plan pide independiente del
 * middleware). Estos tests fijan que el middleware, cuando corta ANTES de que
 * el route se ejecute, entregue la MISMA forma de respuesta.
 */
describe('middleware', () => {
  const DASHBOARD_PASSWORD = 'una-password-de-prueba-para-el-middleware-123456';
  const originalPassword = process.env.DASHBOARD_PASSWORD;

  beforeEach(() => {
    process.env.DASHBOARD_PASSWORD = DASHBOARD_PASSWORD;
  });

  afterEach(() => {
    if (originalPassword === undefined) delete process.env.DASHBOARD_PASSWORD;
    else process.env.DASHBOARD_PASSWORD = originalPassword;
  });

  /** Mismo formato que `lib/auth.ts`: `${id}.${ts}.${hmac(secret, `${id}.${ts}`)}`. */
  async function cookieValida(usuarioId = 7, nowMs: number = Date.now()): Promise<string> {
    const payload = `${usuarioId}.${nowMs}`;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(DASHBOARD_PASSWORD),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    const sig = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
    return `${payload}.${sig}`;
  }

  /** El token VIEJO de 2 campos (`${ts}.${hmac(secret, ts)}`), el que había antes
   *  de la migración 030. Tiene que ser RECHAZADO por el parser nuevo. */
  async function cookieVieja(nowMs: number = Date.now()): Promise<string> {
    const ts = String(nowMs);
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(DASHBOARD_PASSWORD),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ts));
    const sig = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
    return `${ts}.${sig}`;
  }

  function reqCon(url: string, cookie?: string): NextRequest {
    return new NextRequest(url, {
      headers: { host: 'panel.hilvanapp.com', ...(cookie ? { cookie: `panel_token=${cookie}` } : {}) },
    });
  }

  it('sin cookie, a una ruta de API: 401 JSON, no un redirect', async () => {
    const res = await middleware(reqCon('https://panel.hilvanapp.com/api/data/ads?forzar=1'));
    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('con cookie vencida (>12h), a una ruta de API: 401 JSON', async () => {
    const vencida = await cookieValida(7, Date.now() - 13 * 60 * 60 * 1000);
    const res = await middleware(reqCon('https://panel.hilvanapp.com/api/data/ads?forzar=1', vencida));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it('con el token VIEJO de 2 campos, a una ruta de API: 401 (todas las sesiones vivas se cortan)', async () => {
    const vieja = await cookieVieja();
    const res = await middleware(reqCon('https://panel.hilvanapp.com/api/data/ads?forzar=1', vieja));
    expect(res.status).toBe(401);
  });

  it('el 401 de una API es parseable como JSON (lo que rompía antes: HTML a res.json())', async () => {
    const res = await middleware(reqCon('https://panel.hilvanapp.com/api/data/ads?forzar=1'));
    expect(res.headers.get('content-type')).toContain('application/json');
    await expect(res.clone().json()).resolves.not.toThrow();
  });

  it('sin cookie, a una PÁGINA (no API): sigue siendo el redirect 307 de siempre', async () => {
    const res = await middleware(reqCon('https://panel.hilvanapp.com/anuncios'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://panel.hilvanapp.com/');
  });

  it('con cookie válida, a una ruta de API: pasa (next), sin redirect ni 401', async () => {
    const valida = await cookieValida();
    const res = await middleware(reqCon('https://panel.hilvanapp.com/api/data/ads?forzar=1', valida));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });
});
