/**
 * Tests puros de `lib/permisos.ts`. No tocan base ni red: sólo prueban las
 * partes que no consultan Postgres (`puedeVer`, `SECCIONES`, `MAPA_API`).
 * Cubren las verificaciones 10, 11 y 12 de T01 §10.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SECCIONES, puedeVer, MAPA_API, type Sesion, type Seccion } from './permisos';

function sesion(parcial: Partial<Sesion>): Sesion {
  return {
    usuarioId: 1,
    usuario: 'test',
    nombre: 'Test',
    esAdmin: false,
    debeCambiarClave: false,
    secciones: [],
    esFallback: false,
    ...parcial,
  };
}

describe('puedeVer', () => {
  it('10. un admin con secciones:[] ve las 8', () => {
    const admin = sesion({ esAdmin: true, secciones: [] });
    for (const s of SECCIONES) {
      expect(puedeVer(admin, s)).toBe(true);
    }
  });

  it('un no-admin ve sólo las secciones que tiene otorgadas', () => {
    const nahuel = sesion({ secciones: ['resumen', 'finanzas'] });
    expect(puedeVer(nahuel, 'resumen')).toBe(true);
    expect(puedeVer(nahuel, 'finanzas')).toBe(true);
    expect(puedeVer(nahuel, 'anuncios')).toBe(false);
    expect(puedeVer(nahuel, 'config')).toBe(false);
  });

  it('un no-admin sin ninguna sección no ve nada', () => {
    const nadie = sesion({ secciones: [] });
    for (const s of SECCIONES) {
      expect(puedeVer(nadie, s)).toBe(false);
    }
  });
});

describe('SECCIONES', () => {
  it('11. es EXACTAMENTE el vocabulario del CHECK usuario_secciones_valida de la 030', () => {
    const sql = readFileSync(
      path.join(process.cwd(), 'db', 'migrations', '030_usuarios.sql'),
      'utf8',
    );
    // Extrae el bloque IN ('...') del CHECK usuario_secciones_valida.
    const m = sql.match(/usuario_secciones_valida\s+CHECK\s*\(\s*seccion\s+IN\s*\(([^)]*)\)/i);
    expect(m, 'no encontré el CHECK usuario_secciones_valida en la 030').toBeTruthy();
    const delCheck = m![1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean)
      .sort();
    const deCodigo = [...SECCIONES].sort();
    expect(deCodigo).toEqual(delCheck);
  });

  it('no tiene duplicados y son 8', () => {
    expect(SECCIONES).toHaveLength(8);
    expect(new Set(SECCIONES).size).toBe(8);
  });
});

describe('MAPA_API', () => {
  it('12. toda clave empieza con /api/ y no termina en /', () => {
    for (const clave of Object.keys(MAPA_API)) {
      expect(clave.startsWith('/api/'), `"${clave}" no empieza con /api/`).toBe(true);
      expect(clave.endsWith('/'), `"${clave}" termina en /`).toBe(false);
    }
  });

  it('los valores son readonly Seccion[], "admin" o "publica", y las secciones existen', () => {
    const validas = new Set<string>(SECCIONES);
    for (const [clave, valor] of Object.entries(MAPA_API)) {
      if (valor === 'admin' || valor === 'publica') continue;
      expect(Array.isArray(valor), `"${clave}" no es array ni admin/publica`).toBe(true);
      for (const s of valor as readonly Seccion[]) {
        expect(validas.has(s), `"${clave}" mapea a una sección inexistente: ${s}`).toBe(true);
      }
    }
  });

  it('las tres excepciones documentadas están mapeadas a lo correcto (D5)', () => {
    expect(MAPA_API['/api/config/ui-layout']).toEqual(['resumen', 'ventas']);
    expect(MAPA_API['/api/config/vistas-ads']).toEqual(['anuncios']);
    expect(MAPA_API['/api/ia/insight']).toEqual(['resumen', 'finanzas']);
  });
});
