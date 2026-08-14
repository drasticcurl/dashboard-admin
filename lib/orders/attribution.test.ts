import { describe, expect, it } from 'vitest';
import type { ShopifyOrder } from './types';
import {
  buyerEmail,
  inferUtmSource,
  noteAttr,
  orderAttribution,
  orderUtms,
  parseUtmsFromLandingSite,
  parseUtmsFromNoteAttributes,
} from './attribution';

/**
 * Tests puros de la atribución (la herencia por email toca la base y vive en
 * webhook.test.ts, junto con el resto de la integración).
 */

function order(over: Partial<ShopifyOrder>): ShopifyOrder {
  return { id: 1, email: 'test@example.com', ...over };
}

describe('noteAttr', () => {
  it('matchea case-insensitive y devuelve undefined si el valor está vacío', () => {
    const o = order({ note_attributes: [{ name: 'FUNNEL', value: 'chauhinchazon' }, { name: 'sid', value: '' }] });
    expect(noteAttr(o, 'funnel')).toBe('chauhinchazon');
    expect(noteAttr(o, 'SID')).toBeUndefined();
    expect(noteAttr(o, 'nope')).toBeUndefined();
  });
});

describe('parseUtmsFromNoteAttributes', () => {
  it('toma utm_* y fbclid, ignora fbc/fbp/src_host (eran de CAPI)', () => {
    const attrs = [
      { name: 'utm_campaign', value: 'AOV+NUEVO' },
      { name: 'fbclid', value: 'abc123' },
      { name: 'fbc', value: 'fb.1.1723400000.abc123' },
      { name: 'fbp', value: 'fb.1.1.123456' },
      { name: 'src_host', value: 'chauhinchazon.com' },
    ];
    expect(parseUtmsFromNoteAttributes(attrs)).toEqual({
      utm_campaign: 'AOV+NUEVO',
      fbclid: 'abc123',
    });
  });

  it('sin claves utm → undefined (para que caiga al landing_site)', () => {
    expect(parseUtmsFromNoteAttributes([{ name: 'funnel', value: 'chauhinchazon' }])).toBeUndefined();
    expect(parseUtmsFromNoteAttributes(undefined)).toBeUndefined();
  });
});

describe('parseUtmsFromLandingSite', () => {
  it('toma la query aunque el path sea relativo', () => {
    expect(parseUtmsFromLandingSite('/cart/8123456789012:1?utm_source=google&utm_campaign=Perf')).toEqual({
      utm_source: 'google',
      utm_campaign: 'Perf',
    });
  });

  it('sin query → undefined; URL absoluta funciona igual', () => {
    expect(parseUtmsFromLandingSite('/checkout')).toBeUndefined();
    expect(parseUtmsFromLandingSite('https://chauhinchazon.com/checkout?utm_medium=cpc')).toEqual({
      utm_medium: 'cpc',
    });
  });
});

describe('orderUtms', () => {
  it('note_attributes ganan sobre landing_site (canal confiable)', () => {
    const o = order({
      landing_site: '/cart/1?utm_source=landing&utm_campaign=de-la-url',
      note_attributes: [{ name: 'utm_source', value: 'attribute' }],
    });
    expect(orderUtms(o)).toEqual({ utm_source: 'attribute' });
  });

  it('sin note_attributes cae al landing_site', () => {
    const o = order({ landing_site: '/cart/1?utm_source=landing' });
    expect(orderUtms(o)).toEqual({ utm_source: 'landing' });
  });
});

describe('inferUtmSource', () => {
  it('réplica de testfunnel/lib/utm.ts: sin source pero con fbclid → facebook', () => {
    expect(inferUtmSource({ fbclid: 'abc' })).toBe('facebook');
    expect(inferUtmSource({ utm_source: 'tiktok' })).toBe('tiktok');
    expect(inferUtmSource({ utm_source: '  ', fbclid: '' })).toBe('');
    expect(inferUtmSource(null)).toBe('');
  });
});

describe('orderAttribution', () => {
  it('normaliza valores (decodifica %XX y +, colapsa espacios) y completa con (directo)', () => {
    const o = order({
      note_attributes: [
        { name: 'utm_campaign', value: 'UGC+AD+3+%2F+TEST' },
        { name: 'utm_source', value: 'facebook' },
      ],
    });
    const att = orderAttribution(o);
    expect(att.utms).toEqual({
      utm_source: 'facebook',
      utm_medium: '(directo)',
      utm_campaign: 'UGC AD 3 / TEST',
      utm_content: '(directo)',
      utm_term: '(directo)',
    });
    expect(att.fbclid).toBeNull();
  });

  it('sin ninguna fuente → todas (directo), y fbclid NULL (no tiene centinela)', () => {
    const att = orderAttribution(order({ landing_site: '/checkout' }));
    expect(att.utms.utm_source).toBe('(directo)');
    expect(att.utms.utm_campaign).toBe('(directo)');
    expect(att.fbclid).toBeNull();
  });

  it('solo con fbclid → source facebook y fbclid guardado', () => {
    const att = orderAttribution(order({ landing_site: '/cart/1?fbclid=abc123' }));
    expect(att.utms.utm_source).toBe('facebook');
    expect(att.fbclid).toBe('abc123');
  });

  it('sid/vid solo si son uuids; caso-insensitive se baja a minúsculas', () => {
    const o = order({
      note_attributes: [
        { name: 'sid', value: '11111111-2222-4333-8444-555555555555' },
        { name: 'vid', value: 'AAAABBBB-CCCC-4DDD-8EEE-FFFFFFFFFFFF' },
        { name: 'funnel', value: 'chauhinchazon' },
      ],
    });
    const att = orderAttribution(o);
    expect(att.sid).toBe('11111111-2222-4333-8444-555555555555');
    expect(att.vid).toBe('aaaabbbb-cccc-4ddd-8eee-ffffffffffff');
    expect(att.funnel).toBe('chauhinchazon');

    const bad = orderAttribution(
      order({ note_attributes: [{ name: 'sid', value: 'no-es-un-uuid' }, { name: 'vid', value: '123' }] }),
    );
    expect(bad.sid).toBeNull();
    expect(bad.vid).toBeNull();
  });
});

describe('buyerEmail', () => {
  it('email || contact_email || customer.email, minúsculas y trim', () => {
    expect(buyerEmail(order({}))).toBe('test@example.com');
    expect(buyerEmail(order({ email: '  CARLA@X.COM  ' }))).toBe('carla@x.com');
    expect(buyerEmail(order({ email: '', customer: { email: 'Ana@X.com' } }))).toBe('ana@x.com');
    expect(buyerEmail(order({ email: '', customer: {} }))).toBe('');
  });
});
