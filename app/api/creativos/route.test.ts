import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { Sesion } from '@/lib/permisos';

/**
 * Tests de /api/creativos. NO tocan la base — mismo patrón de
 * `app/api/tareas/route.test.ts`: `vi.mock('@/lib/permisos', importOriginal)`
 * con `guardSeccion` mockeado, y la capa de datos (`@/lib/queries/creativos`)
 * mockeada entera como spies.
 *
 * A diferencia de /api/tareas, ACÁ NO HAY autorización a nivel fila: no hace
 * falta mockear `q1` de `@/lib/db` para simular un "dueño", porque el route no
 * lo comprueba (ver el docblock de la route: cualquiera con la sección puede
 * editar o borrar cualquier fila). Eso mismo es lo que el test 8 verifica
 * explícitamente.
 */

const ADMIN: Sesion = {
  usuarioId: 1,
  usuario: 'lucho',
  nombre: 'Lucho',
  esAdmin: true,
  debeCambiarClave: false,
  secciones: [
    'resumen', 'embudo', 'ventas', 'anuncios', 'finanzas', 'leads', 'config', 'tareas', 'creativos',
  ],
  esFallback: false,
};

const NAHUEL: Sesion = {
  usuarioId: 2,
  usuario: 'nahuel',
  nombre: 'Nahuel',
  esAdmin: false,
  debeCambiarClave: false,
  secciones: ['creativos'],
  esFallback: false,
};

const FALLBACK: Sesion = {
  usuarioId: 0,
  usuario: 'admin',
  nombre: 'Administrador',
  esAdmin: true,
  debeCambiarClave: false,
  secciones: [
    'resumen', 'embudo', 'ventas', 'anuncios', 'finanzas', 'leads', 'config', 'tareas', 'creativos',
  ],
  esFallback: true,
};

const estado = vi.hoisted(() => ({
  sesion: null as Sesion | null,
  respuestaGuard: null as { status: number; error: string } | null,
}));

vi.mock('@/lib/permisos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/permisos')>();
  return {
    ...actual,
    guardSeccion: vi.fn(async () => {
      if (estado.respuestaGuard) {
        return {
          respuesta: NextResponse.json(
            { ok: false, error: estado.respuestaGuard.error },
            { status: estado.respuestaGuard.status },
          ),
        };
      }
      return { sesion: estado.sesion };
    }),
  };
});

const creativoFalso = {
  id: 10,
  nombre: 'Testimonio Marta v2',
  link: 'https://ejemplo.test/v1',
  rendimiento: 'alto' as const,
  creadoPor: 1,
  creadoPorNombre: 'Lucho',
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z',
};

vi.mock('@/lib/queries/creativos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/queries/creativos')>();
  return {
    ...actual, // conserva CreativoInputError y RENDIMIENTOS
    listarCreativos: vi.fn(async () => [creativoFalso]),
    crearCreativo: vi.fn(async () => creativoFalso),
    editarCreativo: vi.fn(async () => creativoFalso),
    borrarCreativo: vi.fn(async () => undefined),
  };
});

import { GET, POST, PATCH, DELETE } from './route';
import * as queries from '@/lib/queries/creativos';

const crearCreativoSpy = vi.mocked(queries.crearCreativo);
const editarCreativoSpy = vi.mocked(queries.editarCreativo);
const borrarCreativoSpy = vi.mocked(queries.borrarCreativo);
const listarCreativosSpy = vi.mocked(queries.listarCreativos);

function req(url: string, init?: { method?: string; body?: unknown; raw?: string }): NextRequest {
  const full = `http://localhost${url}`;
  if (init?.raw !== undefined) {
    return new NextRequest(full, { method: init.method ?? 'POST', body: init.raw });
  }
  if (init?.body !== undefined) {
    return new NextRequest(full, {
      method: init.method ?? 'POST',
      body: JSON.stringify(init.body),
      headers: { 'content-type': 'application/json' },
    });
  }
  return new NextRequest(full, { method: init?.method ?? 'GET' });
}

beforeEach(() => {
  estado.sesion = ADMIN;
  estado.respuestaGuard = null;
  vi.clearAllMocks();
});

// ─── 1-3: el guard ───────────────────────────────────────────────────────────

describe('el guard corta antes que la lógica del route', () => {
  it('1. sin sesión → 401', async () => {
    estado.respuestaGuard = { status: 401, error: 'unauthorized' };
    const r = await GET(req('/api/creativos'));
    expect(r.status).toBe(401);
  });

  it('2. sin la sección creativos → 403 forbidden', async () => {
    estado.respuestaGuard = { status: 403, error: 'forbidden' };
    const r = await GET(req('/api/creativos'));
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('forbidden');
  });

  it('3. debeCambiarClave → 403 clave_pendiente', async () => {
    estado.respuestaGuard = { status: 403, error: 'clave_pendiente' };
    const r = await GET(req('/api/creativos'));
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('clave_pendiente');
  });
});

// ─── GET ─────────────────────────────────────────────────────────────────────

describe('GET /api/creativos', () => {
  it('4. devuelve la lista de la capa de datos', async () => {
    const r = await GET(req('/api/creativos'));
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.creativos).toEqual([creativoFalso]);
    expect(listarCreativosSpy).toHaveBeenCalled();
  });
});

// ─── POST ────────────────────────────────────────────────────────────────────

describe('POST /api/creativos', () => {
  it('5. POST con los tres campos → 200 con el creativo', async () => {
    const r = await POST(
      req('/api/creativos', {
        body: { nombre: 'Video', link: 'https://ejemplo.test/v', rendimiento: 'alto' },
      }),
    );
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.creativo).toEqual(creativoFalso);
  });

  it('6. falta un campo obligatorio → 400 invalid_payload', async () => {
    const sinNombre = await POST(
      req('/api/creativos', { body: { link: 'https://ejemplo.test/v', rendimiento: 'alto' } }),
    );
    expect(sinNombre.status).toBe(400);
    expect((await sinNombre.json()).error).toBe('invalid_payload');

    const sinLink = await POST(
      req('/api/creativos', { body: { nombre: 'x', rendimiento: 'alto' } }),
    );
    expect(sinLink.status).toBe(400);

    const sinRendimiento = await POST(
      req('/api/creativos', { body: { nombre: 'x', link: 'https://ejemplo.test/v' } }),
    );
    expect(sinRendimiento.status).toBe(400);
  });

  it('7. rendimiento fuera de alto/medio/bajo → 400 invalid_payload', async () => {
    const r = await POST(
      req('/api/creativos', {
        body: { nombre: 'x', link: 'https://ejemplo.test/v', rendimiento: 'excelente' },
      }),
    );
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_payload');
  });

  it('8. body que no es JSON → 400, NO 500', async () => {
    const r = await POST(req('/api/creativos', { raw: 'esto no es json {' }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_payload');
  });

  it('9. creado_por sale de la sesión, no del body', async () => {
    estado.sesion = NAHUEL;
    await POST(
      req('/api/creativos', {
        body: { nombre: 'x', link: 'https://ejemplo.test/v', rendimiento: 'alto' },
      }),
    );
    expect(crearCreativoSpy).toHaveBeenCalledWith(expect.any(Object), 2);
  });

  it('10. sesión de fallback (D10, usuarioId 0) → creado_por null', async () => {
    estado.sesion = FALLBACK;
    await POST(
      req('/api/creativos', {
        body: { nombre: 'x', link: 'https://ejemplo.test/v', rendimiento: 'alto' },
      }),
    );
    expect(crearCreativoSpy).toHaveBeenCalledWith(expect.any(Object), null);
  });
});

// ─── PATCH: sin autorización a nivel fila ───────────────────────────────────

describe('PATCH /api/creativos — sin dueño por fila', () => {
  it('11. un no-admin puede editar cualquier fila (no se comprueba dueño)', async () => {
    estado.sesion = NAHUEL;
    const r = await PATCH(req('/api/creativos', { method: 'PATCH', body: { id: 10, rendimiento: 'bajo' } }));
    expect(r.status).toBe(200);
    expect(editarCreativoSpy).toHaveBeenCalledWith(10, expect.objectContaining({ rendimiento: 'bajo' }));
  });

  it('12. id inválido en el body → 400 invalid_payload', async () => {
    const r = await PATCH(req('/api/creativos', { method: 'PATCH', body: { id: -1, nombre: 'x' } }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_payload');
  });

  it('13. CreativoInputError "no existe" → 404 unknown_creativo', async () => {
    editarCreativoSpy.mockRejectedValueOnce(
      new queries.CreativoInputError('ese creativo no existe'),
    );
    const r = await PATCH(req('/api/creativos', { method: 'PATCH', body: { id: 999, nombre: 'x' } }));
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe('unknown_creativo');
  });

  it('14. CreativoInputError de validación → 400 invalid_payload', async () => {
    editarCreativoSpy.mockRejectedValueOnce(
      new queries.CreativoInputError('el link tiene que empezar con http:// o https://'),
    );
    const r = await PATCH(req('/api/creativos', { method: 'PATCH', body: { id: 10, link: 'x' } }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_payload');
  });
});

// ─── DELETE: sin autorización a nivel fila ──────────────────────────────────

describe('DELETE /api/creativos — sin dueño por fila', () => {
  it('15. un no-admin puede borrar cualquier fila', async () => {
    estado.sesion = NAHUEL;
    const r = await DELETE(req('/api/creativos?id=10', { method: 'DELETE' }));
    expect(r.status).toBe(200);
    expect(borrarCreativoSpy).toHaveBeenCalledWith(10);
  });

  it('16. id inválido en la query → 400 invalid_payload, no llama a borrarCreativo', async () => {
    const r = await DELETE(req('/api/creativos?id=abc', { method: 'DELETE' }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_payload');
    expect(borrarCreativoSpy).not.toHaveBeenCalled();
  });
});
