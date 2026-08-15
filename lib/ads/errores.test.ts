import { describe, expect, it } from 'vitest';
import { CATALOGO_ERRORES, traducirError, type ContextoError } from './errores';

/**
 * Tests del catálogo de errores (task 9.2). Regla del design §Error Handling:
 * lo NO verificado cae en «sin mapear», que no corta el lote.
 */

const ctx: ContextoError = {
  objectId: '120210000111',
  objectName: 'Conjunto de prueba',
  nivel: 'adset',
  accountId: 'act_1',
};

const ctxCuota: ContextoError = {
  ...ctx,
  contexto: { confirmadas: 3, noIntentadas: 7, backoffSegundos: 300 },
};

describe('filas verificadas del catálogo', () => {
  it('100/3858079: pagador DSA, fallido, no corta, nombra el objeto', () => {
    const r = traducirError({ codigo: 100, subcodigo: 3858079, mensaje: 'x' }, ctx);
    expect(r.mensaje).toContain('pagador');
    expect(r.mensaje).toContain(ctx.objectName!);
    expect(r.clasifica).toBe('fallido');
    expect(r.corta).toBeNull();
  });

  it('100/3858081: beneficiario DSA, fallido, no corta', () => {
    const r = traducirError({ codigo: 100, subcodigo: 3858081 }, ctx);
    expect(r.mensaje).toContain('beneficiario');
    expect(r.clasifica).toBe('fallido');
    expect(r.corta).toBeNull();
  });

  it('613: cuota, CORTA el lote, informa confirmadas/no intentadas/segundos', () => {
    const r = traducirError({ codigo: 613 }, ctxCuota);
    expect(r.corta).toBe('cuota');
    expect(r.clasifica).toBe('fallido');
    expect(r.mensaje).toContain('3');
    expect(r.mensaje).toContain('7');
    expect(r.mensaje).toContain('300');
  });

  it('código 2 y 5xx sin cuerpo y red/timeout clasifican indeterminado y no cortan', () => {
    expect(traducirError({ codigo: 2 }, ctx).clasifica).toBe('indeterminado');
    expect(traducirError({ codigo: 2 }, ctx).corta).toBeNull();
    expect(traducirError({ httpStatus: 500 }, ctx).clasifica).toBe('indeterminado');
    expect(traducirError({ httpStatus: 500 }, ctx).corta).toBeNull();
    expect(traducirError({ transient: true }, ctx).clasifica).toBe('indeterminado');
  });
});

describe('lo no verificado y lo sin mapear (regla 3)', () => {
  it('190 (token vencido) está declarado pero NO matchea hasta la verificación: cae en sin mapear y no corta', () => {
    const entrada190 = CATALOGO_ERRORES.find((e) => e.codigo === 190);
    expect(entrada190?.verificado).toBe(false);
    const r = traducirError({ codigo: 190, mensaje: 'expired' }, ctx);
    expect(r.corta).toBeNull(); // el lado seguro: no cortar por un código no confirmado
    expect(r.codigoMeta).toBe(190);
  });

  it('17 (cuota de usuario) tampoco corta hasta la verificación', () => {
    expect(traducirError({ codigo: 17, mensaje: 'rate limit' }, ctx).corta).toBeNull();
  });

  it('un código sin mapear devuelve el mensaje genérico, no corta y conserva el código como dato secundario', () => {
    const r = traducirError({ codigo: 9999, mensaje: 'Algo raro pasó' }, ctx);
    expect(r.mensaje).toContain('Algo raro pasó');
    expect(r.mensaje).toContain(ctx.objectName!);
    expect(r.codigoMeta).toBe(9999);
    expect(r.corta).toBeNull();
    expect(r.clasifica).toBe('fallido');
  });
});

describe('reglas del catálogo (R16 c9, R17 c9)', () => {
  it('ningún mensaje del catálogo contiene la URL ni el token', () => {
    const token = 'EAAG-SECRETO-PARA-EL-TEST';
    for (const fila of CATALOGO_ERRORES) {
      const mensaje = fila.castellano(ctxCuota);
      expect(mensaje).not.toContain('graph.facebook.com');
      expect(mensaje).not.toContain(token);
    }
    const generico = traducirError({ codigo: 1, mensaje: 'ver https://graph.facebook.com/x token=abc' }, ctx);
    expect(generico.mensaje).not.toContain('graph.facebook.com');
  });
});
