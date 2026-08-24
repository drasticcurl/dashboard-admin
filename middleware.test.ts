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
import { afterEach, describe, expect, it } from 'vitest';
import { urlDeLogin } from './middleware';

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
