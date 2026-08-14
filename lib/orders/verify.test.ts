import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySignatureWithSecrets } from './verify';

/**
 * Tests del núcleo puro de la verificación HMAC. El camino con env real
 * (getWebhookSecrets, ruteo, 401 del route) vive en webhook.test.ts: ese
 * archivo es dueño exclusivo de la mutación de SHOPIFY_WEBHOOK_SECRETS, para
 * que dos archivos en paralelo no se pisen el env compartido del proceso.
 */

const SECRET = 'secret-a';
const OTHER_SECRET = 'secret-b';

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64');
}

describe('verifySignatureWithSecrets', () => {
  const body = '{"hello":"world"}';

  it('firma correcta → valid', () => {
    expect(verifySignatureWithSecrets(body, sign(body, SECRET), [SECRET])).toBe('valid');
  });

  it('firma incorrecta → invalid', () => {
    expect(verifySignatureWithSecrets(body, sign(body, OTHER_SECRET), [SECRET])).toBe('invalid');
  });

  it('multi-secret: cualquiera de la lista que valide → valid', () => {
    expect(verifySignatureWithSecrets(body, sign(body, OTHER_SECRET), [SECRET, OTHER_SECRET])).toBe(
      'valid',
    );
  });

  it('sin header → invalid cuando hay secrets configuradas', () => {
    expect(verifySignatureWithSecrets(body, null, [SECRET])).toBe('invalid');
  });

  it('sin secrets → unconfigured (el endpoint lo rechaza, no hay modo permisivo)', () => {
    expect(verifySignatureWithSecrets(body, sign(body, SECRET), [])).toBe('unconfigured');
    expect(verifySignatureWithSecrets(body, null, [])).toBe('unconfigured');
  });

  it('un byte distinto en el body → invalid (el HMAC es del body crudo exacto)', () => {
    expect(verifySignatureWithSecrets(`${body} `, sign(body, SECRET), [SECRET])).toBe('invalid');
  });

  it('header basura que no es base64 → invalid, no tira', () => {
    expect(verifySignatureWithSecrets(body, '¡no-es-base64!', [SECRET])).toBe('invalid');
  });
});
