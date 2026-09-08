/**
 * Tests puros de `lib/auth.ts` — token de sesión con identidad y hash scrypt.
 * No tocan base ni red. Cubren las verificaciones de T01 §10 que son de auth
 * (1 a 9 de la lista, la parte de token y hash).
 *
 * El secreto de firma se setea acá (PANEL_SESSION_SECRET) porque `secretoDeFirma`
 * lo lee de process.env. Se restaura en afterEach para no filtrar a otros tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  signSessionToken,
  verifySessionToken,
  hashearClave,
  verificarClave,
  MIN_LARGO_CLAVE,
  SESSION_TTL_SECONDS,
} from './auth';

const SECRETO = 'un-secreto-de-firma-de-prueba-independiente-de-las-claves';
const originalSecret = process.env.PANEL_SESSION_SECRET;
const originalPass = process.env.DASHBOARD_PASSWORD;

beforeEach(() => {
  process.env.PANEL_SESSION_SECRET = SECRETO;
  // Que no haya un DASHBOARD_PASSWORD que se cuele como default distinto.
  delete process.env.DASHBOARD_PASSWORD;
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.PANEL_SESSION_SECRET;
  else process.env.PANEL_SESSION_SECRET = originalSecret;
  if (originalPass === undefined) delete process.env.DASHBOARD_PASSWORD;
  else process.env.DASHBOARD_PASSWORD = originalPass;
});

describe('signSessionToken / verifySessionToken', () => {
  it('firma y verifica un token válido, devolviendo el usuarioId', () => {
    const token = signSessionToken(7)!;
    expect(token.split('.')).toHaveLength(3);
    expect(verifySessionToken(token)).toEqual({ usuarioId: 7 });
  });

  it('1. un token firmado con un secreto NO verifica con otro', () => {
    const token = signSessionToken(7)!;
    process.env.PANEL_SESSION_SECRET = 'otro-secreto-completamente-distinto';
    expect(verifySessionToken(token)).toBeNull();
  });

  it('2. un token de 2 campos (la cookie vieja) → null', () => {
    const now = Date.now();
    // Reproducimos el token viejo `${ts}.${sig}` firmando sólo el ts.
    const viejo = `${now}.${'a'.repeat(64)}`;
    expect(verifySessionToken(viejo)).toBeNull();
  });

  it('3. un token con 4 campos → null', () => {
    const token = signSessionToken(7)!;
    expect(verifySessionToken(`${token}.extra`)).toBeNull();
  });

  it('4. id o ts no numéricos, con espacios o notación exponencial → null', () => {
    const now = Date.now();
    // Construimos strings inválidos; ninguno debería siquiera llegar a verificar
    // firma porque el parser los rechaza antes.
    expect(verifySessionToken(`7e2.${now}.${'a'.repeat(64)}`)).toBeNull();
    expect(verifySessionToken(` 7.${now}.${'a'.repeat(64)}`)).toBeNull();
    expect(verifySessionToken(`7.${now}e3.${'a'.repeat(64)}`)).toBeNull();
    expect(verifySessionToken(`abc.${now}.${'a'.repeat(64)}`)).toBeNull();
    expect(verifySessionToken(`-1.${now}.${'a'.repeat(64)}`)).toBeNull();
  });

  it('5. firma de 63 o 65 hex → null', () => {
    const token = signSessionToken(7)!;
    const [id, ts] = token.split('.');
    expect(verifySessionToken(`${id}.${ts}.${'a'.repeat(63)}`)).toBeNull();
    expect(verifySessionToken(`${id}.${ts}.${'a'.repeat(65)}`)).toBeNull();
  });

  it('6. vencido (>12h) → null; del futuro (>60s) → null', () => {
    const now = 1_757_318_400_000;
    const vencido = signSessionToken(7, now - (SESSION_TTL_SECONDS * 1000 + 1_000))!;
    expect(verifySessionToken(vencido, now)).toBeNull();

    const futuro = signSessionToken(7, now + 61_000)!;
    expect(verifySessionToken(futuro, now)).toBeNull();

    // En el borde de la ventana sigue siendo válido.
    const enBorde = signSessionToken(7, now - (SESSION_TTL_SECONDS * 1000 - 1_000))!;
    expect(verifySessionToken(enBorde, now)).toEqual({ usuarioId: 7 });
  });

  it('7. cambiarle el id al token invalida la firma', () => {
    const token = signSessionToken(7)!;
    const [, ts, sig] = token.split('.');
    // La firma es del par (7, ts). Con id=9 y la misma firma, no verifica.
    expect(verifySessionToken(`9.${ts}.${sig}`)).toBeNull();
  });

  it('el punto va DENTRO del payload: id=1/ts=23 y id=12/ts=3 firman distinto', () => {
    // No podemos forzar ts arbitrario con signSessionToken (usa nowMs), pero sí
    // firmar dos pares que concatenarían igual sin separador.
    const a = signSessionToken(1, 23)!;
    const b = signSessionToken(12, 3)!;
    expect(a.split('.')[2]).not.toBe(b.split('.')[2]);
  });

  it('sin secreto configurado, firma y verifica fallan cerrado', () => {
    delete process.env.PANEL_SESSION_SECRET;
    expect(signSessionToken(7)).toBeNull();
    expect(verifySessionToken('7.123.' + 'a'.repeat(64))).toBeNull();
  });
});

describe('hashearClave / verificarClave', () => {
  it('8. produce un hash con la forma del CHECK de la 030, y dos llamadas dan hashes distintos', async () => {
    const h1 = await hashearClave('una-clave-de-quince-o-mas');
    const h2 = await hashearClave('una-clave-de-quince-o-mas');
    // scrypt$<N>$<r>$<p>$<salt 32 hex>$<derivada 64 hex>, N=16384 r=8 p=1.
    expect(h1).toMatch(/^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    // El CHECK real de la 030 es `clave_hash LIKE 'scrypt$%$%$%$%$%'`.
    expect(h1.startsWith('scrypt$')).toBe(true);
    expect(h1.split('$')).toHaveLength(6);
    // Salt aleatorio: misma clave, hashes distintos.
    expect(h1).not.toBe(h2);
    expect(await verificarClave('una-clave-de-quince-o-mas', h1)).toBe(true);
  });

  it('una clave incorrecta, vacía o un hash mal formado no verifican', async () => {
    const h = await hashearClave('una-clave-de-quince-o-mas');
    expect(await verificarClave('otra-clave-cualquiera', h)).toBe(false);
    expect(await verificarClave('', h)).toBe(false);
    expect(await verificarClave('x', 'no-es-un-hash')).toBe(false);
    expect(await verificarClave('x', 'scrypt$16384$8$1$zz$zz')).toBe(false);
  });

  it('9. un hash con N viejo (1024) sigue verificando: los parámetros salen de la fila', async () => {
    // Construido a mano con scryptSync para simular un hash guardado con costo
    // más bajo, como lo haría una versión anterior del código.
    const { scryptSync, randomBytes } = await import('node:crypto');
    const salt = randomBytes(16);
    const dk = scryptSync('clave-con-parametros-viejos', salt, 32, { N: 1024, r: 8, p: 1 });
    const viejo = `scrypt$1024$8$1$${salt.toString('hex')}$${dk.toString('hex')}`;
    expect(await verificarClave('clave-con-parametros-viejos', viejo)).toBe(true);
    expect(await verificarClave('otra', viejo)).toBe(false);
  });

  it('MIN_LARGO_CLAVE es 15 y NO se aplica dentro de hashearClave (el seed usa 123456)', async () => {
    expect(MIN_LARGO_CLAVE).toBe(15);
    // hashearClave hashea cualquier largo: el mínimo lo aplica T04 en el cambio.
    const h = await hashearClave('123456');
    expect(await verificarClave('123456', h)).toBe(true);
  });
});
