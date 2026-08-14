import { describe, expect, it } from 'vitest';
import { DIRECT_LABEL, cleanUtmValue, parseIngestPayload } from './schema';

function basePayload(over: Record<string, unknown> = {}) {
  return {
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    visitorId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    events: [
      { name: 'step_view', at: '2026-08-11T14:03:11.000Z', stepIndex: 3, stepSlug: 'donde_acumula' },
    ],
    ...over,
  };
}

describe('parseIngestPayload', () => {
  it('payload válido → pasa y variant toma el default', () => {
    const { payload, warnings } = parseIngestPayload(basePayload());
    expect(payload.sessionId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(payload.visitorId).toBe('6ba7b810-9dad-11d1-80b4-00c04fd430c8');
    expect(payload.variant).toBe('default');
    expect(payload.events).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it('sessionId o visitorId que no son uuid → falla fuerte (la PK de sessions no se llena de porquería)', () => {
    expect(() => parseIngestPayload(basePayload({ sessionId: 'no-un-uuid' }))).toThrow();
    expect(() => parseIngestPayload(basePayload({ visitorId: 123 }))).toThrow();
  });

  it('events vacío o sin at válido → falla', () => {
    expect(() => parseIngestPayload(basePayload({ events: [] }))).toThrow();
    expect(() =>
      parseIngestPayload(basePayload({ events: [{ name: 'step_view', at: 'ayer' }] })),
    ).toThrow();
  });

  it('stepIndex fuera de 0..200 → falla (el catálogo nunca va a llegar tan lejos)', () => {
    expect(() =>
      parseIngestPayload(basePayload({ events: [{ name: 'step_view', at: '2026-08-11T14:03:11.000Z', stepIndex: 250 }] })),
    ).toThrow();
  });

  it('utms se normalizan con la misma regla que los funnels (decodifica %XX y +, colapsa espacios)', () => {
    const { payload } = parseIngestPayload(
      basePayload({ context: { utms: { utm_campaign: 'UGC+AD+%2F+test   x' } } }),
    );
    expect(payload.context!.utms!.utm_campaign).toBe('UGC AD / test x');
  });

  it('utm vacío → (directo), no NULL (el CASE del upsert compara contra el centinela)', () => {
    const { payload } = parseIngestPayload(basePayload({ context: { utms: { utm_campaign: '   ' } } }));
    expect(payload.context!.utms!.utm_campaign).toBe(DIRECT_LABEL);
  });

  it('claves de utms que no son las 6 conocidas → se ignoran en silencio', () => {
    const { payload } = parseIngestPayload(
      basePayload({ context: { utms: { utm_source: 'fb', utm_gclid: 'x', nonsense: 1 } as Record<string, unknown> } }),
    );
    const utms = payload.context!.utms as unknown as Record<string, unknown>;
    expect(utms.utm_source).toBe('fb');
    expect('utm_gclid' in utms).toBe(false);
    expect('nonsense' in utms).toBe(false);
  });

  it('country se guarda en mayúsculas; fbclid vacío no se convierte en (directo)', () => {
    const { payload } = parseIngestPayload(
      basePayload({ context: { country: 'ar', utms: { fbclid: '' } } }),
    );
    expect(payload.context!.country).toBe('AR');
    expect(payload.context!.utms!.fbclid).toBeUndefined();
  });

  it('referrer se reduce a hostname; un referrer que no es URL se descarta', () => {
    const { payload } = parseIngestPayload(
      basePayload({ context: { referrer: 'https://www.facebook.com/ads?x=1' } }),
    );
    expect(payload.context!.referrer).toBe('www.facebook.com');
    const { payload: p2 } = parseIngestPayload(basePayload({ context: { referrer: 'no-es-una-url' } }));
    expect(p2.context!.referrer).toBeUndefined();
  });

  it('at en 2035 → se clampea a now() con warning clamped_at, no se descarta', () => {
    const before = Date.now();
    const { payload, warnings } = parseIngestPayload(
      basePayload({ events: [{ name: 'step_view', at: '2035-01-01T00:00:00.000Z', stepIndex: 0 }] }),
    );
    const at = Date.parse(payload.events[0].at);
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
    expect(warnings).toEqual(['clamped_at']);
  });

  it('at más de 30 días en el pasado → también se clampea', () => {
    const { payload, warnings } = parseIngestPayload(
      basePayload({ events: [{ name: 'step_view', at: '2020-01-01T00:00:00.000Z', stepIndex: 0 }] }),
    );
    expect(Date.parse(payload.events[0].at)).toBeLessThanOrEqual(Date.now() + 1000);
    expect(warnings).toEqual(['clamped_at']);
  });

  it('at dentro del rango (hace 2 días) → sin warning', () => {
    const { warnings } = parseIngestPayload(
      basePayload({
        events: [
          { name: 'step_view', at: new Date(Date.now() - 2 * 86_400_000).toISOString(), stepIndex: 0 },
        ],
      }),
    );
    expect(warnings).toEqual([]);
  });

  it('props de más de 4 KB serializados → falla el schema', () => {
    expect(() =>
      parseIngestPayload(
        basePayload({ events: [{ name: 'step_view', at: '2026-08-11T14:03:11.000Z', props: { basura: 'x'.repeat(5000) } }] }),
      ),
    ).toThrow(/4 KB/);
  });

  it('props chicas pasan y quedan intactas', () => {
    const { payload } = parseIngestPayload(
      basePayload({
        events: [{ name: 'step_view', at: '2026-08-11T14:03:11.000Z', props: { source: 'quiz', n: 3 } }],
      }),
    );
    expect(payload.events[0].props).toEqual({ source: 'quiz', n: 3 });
  });
});

describe('cleanUtmValue', () => {
  it('replica la regla de testfunnel/lib/utm.ts', () => {
    expect(cleanUtmValue('Hola+Mundo')).toBe('Hola Mundo');
    expect(cleanUtmValue('a%20b%2Fc')).toBe('a b/c');
    expect(cleanUtmValue('  con   espacios  ')).toBe('con espacios');
    expect(cleanUtmValue(null)).toBe('');
    expect(cleanUtmValue(undefined)).toBe('');
    expect(cleanUtmValue('%ZZ-invalido')).toBe('%ZZ-invalido');
  });
});
