import { describe, expect, it } from 'vitest';
import { deviceFromUA } from './device';

describe('deviceFromUA', () => {
  // UAs reales (task T02 §6). El caso clave es el iPad: manda 'Mobile' en su
  // UA, así que tablet tiene que evaluarse primero.
  it.each([
    [
      'iPad',
      'Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
      'tablet',
    ],
    [
      'iPhone',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
      'mobile',
    ],
    [
      'Android phone',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
      'mobile',
    ],
    [
      'Android tablet (sin "Tablet" en el UA)',
      'Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      // Un Android tablet no detectable por las regex del task (no dice
      // "Tablet" ni "Mobile") cae en mobile: inherente al parser mínimo; el
      // device es contexto de la sesión, no una métrica.
      'mobile',
    ],
    [
      'Windows tablet',
      'Mozilla/5.0 (Windows NT 6.2; Win64; x64; Tablet PC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'tablet',
    ],
    [
      'Windows desktop Chrome',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'desktop',
    ],
    [
      'macOS Safari',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
      'desktop',
    ],
    [
      'Kindle (Silk)',
      'Mozilla/5.0 (Linux; U; en-us) AppleWebKit/534.13 (KHTML, like Gecko) Silk/3.13 Safari/534.13',
      'tablet',
    ],
  ] as const)('%s → %s', (_label, ua, expected) => {
    expect(deviceFromUA(ua)).toBe(expected);
  });

  it('UA vacío o ausente → unknown', () => {
    expect(deviceFromUA('')).toBe('unknown');
    expect(deviceFromUA(null)).toBe('unknown');
    expect(deviceFromUA(undefined)).toBe('unknown');
  });
});
