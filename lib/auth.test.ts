import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkLoginRateLimit,
  isConfigured,
  resetLoginRateLimit,
  signSessionToken,
  verifyPassword,
  verifySessionToken,
} from './auth';

/**
 * El módulo lee `process.env.DASHBOARD_PASSWORD` en cada llamada (no lo
 * cachea), así que los tests pueden controlar la password por test. Cada IP
 * de rate limit es única por test para no depender del orden de ejecución.
 */

const LONG_PASS = 'una-password-larga-de-prueba-0123456789';

beforeEach(() => {
  process.env.DASHBOARD_PASSWORD = LONG_PASS;
});

afterEach(() => {
  delete process.env.DASHBOARD_PASSWORD;
});

describe('signSessionToken / verifySessionToken', () => {
  it('un token recién firmado pasa la verificación', () => {
    const token = signSessionToken();
    expect(token).toBeTruthy();
    expect(verifySessionToken(token!)).toBe(true);
  });

  it('un token vencido no pasa (TTL 12 h)', () => {
    const token = signSessionToken(Date.now() - 13 * 60 * 60 * 1000);
    expect(verifySessionToken(token!)).toBe(false);
  });

  it('un token del futuro no pasa (skew máximo 60 s)', () => {
    const token = signSessionToken(Date.now() + 5 * 60 * 1000);
    expect(verifySessionToken(token!)).toBe(false);
  });

  it('un token firmado con otra password no pasa', () => {
    const token = signSessionToken();
    process.env.DASHBOARD_PASSWORD = 'otra-password-larga-distinta-9876543210';
    expect(verifySessionToken(token!)).toBe(false);
  });

  it('formato inválido no pasa', () => {
    for (const bad of [
      undefined,
      '',
      'sin-punto',
      '.solo-firma',
      '123.',
      'abc.def',
      'no-numerico.abcdef',
      '-1.abcdef',
      '1.2.3',
    ]) {
      expect(verifySessionToken(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('sin password configurada todo falla cerrado', () => {
    delete process.env.DASHBOARD_PASSWORD;
    expect(isConfigured()).toBe(false);
    expect(signSessionToken()).toBeNull();
    expect(verifyPassword('cualquier-cosa')).toBe(false);
    expect(verifySessionToken('1.abc')).toBe(false);
  });
});

describe('verifyPassword', () => {
  it('acepta la password correcta y rechaza cualquier otra', () => {
    expect(verifyPassword(LONG_PASS)).toBe(true);
    expect(verifyPassword('mala')).toBe(false);
    expect(verifyPassword('')).toBe(false);
    expect(verifyPassword(undefined)).toBe(false);
  });
});

describe('checkLoginRateLimit', () => {
  const ip = '203.0.113.55';

  it('permite 5 intentos y corta al 6º, con retryAfterSeconds', () => {
    for (let i = 1; i <= 5; i++) {
      expect(checkLoginRateLimit(ip), `intento ${i}`).toEqual({ allowed: true });
    }
    const blocked = checkLoginRateLimit(ip);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it('se resetea al éxito: después de resetLoginRateLimit vuelve a permitir', () => {
    for (let i = 0; i < 5; i++) checkLoginRateLimit(ip);
    expect(checkLoginRateLimit(ip).allowed).toBe(false);
    resetLoginRateLimit(ip);
    expect(checkLoginRateLimit(ip).allowed).toBe(true);
  });

  it('IPs distintas tienen buckets independientes', () => {
    for (let i = 0; i < 6; i++) checkLoginRateLimit(ip);
    expect(checkLoginRateLimit('203.0.113.99').allowed).toBe(true);
  });
});
