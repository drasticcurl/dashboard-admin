import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Tests de `/api/usuarios` (T04 §5).
 *
 * El guard y la capa de queries se mockean enteros: sin eso, cada test tocaría
 * la base y dependería de `DASHBOARD_PASSWORD` / `PANEL_SESSION_SECRET`, que en
 * CI no están. El patrón es el de `app/api/data/ads/route.test.ts:82-85` —
 * `vi.mock` con `importOriginal` sobreescribiendo lo justo — pero acá el guard
 * de este route es `guardSeccion` de `lib/permisos` (no `isAuthenticated` de
 * `lib/auth`), así que se mockea ahí.
 *
 * Lo que estos tests fijan:
 *  - 403 forbidden si el guard rechaza (no-admin) — el sobre real del guard.
 *  - POST crea con clave inicial y NUNCA devuelve claveHash.
 *  - PATCH valida `secciones` con z.enum contra SECCIONES (una sección inventada
 *    da 400, no llega a la base).
 *  - El UsuarioInputError del "único admin" se traduce a 400.
 */

// ── Mock del guard y la sesión (lib/permisos) ────────────────────────────────
// Se deja `SECCIONES` real (lo usa el schema del route) y se controla sólo
// `guardSeccion`. `guardSeccion` devuelve `{ sesion }` para pasar o
// `{ respuesta }` para cortar — replicamos las dos formas.
const guardMock = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock('@/lib/permisos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/permisos')>();
  return { ...actual, guardSeccion: guardMock.fn };
});

// ── Mock de la capa de queries ───────────────────────────────────────────────
const queriesMock = vi.hoisted(() => ({
  listarUsuarios: vi.fn(),
  crearUsuario: vi.fn(),
  actualizarUsuario: vi.fn(),
  fijarSecciones: vi.fn(),
}));

vi.mock('@/lib/queries/usuarios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/queries/usuarios')>();
  return {
    ...actual, // conserva la clase UsuarioInputError real
    listarUsuarios: queriesMock.listarUsuarios,
    crearUsuario: queriesMock.crearUsuario,
    actualizarUsuario: queriesMock.actualizarUsuario,
    fijarSecciones: queriesMock.fijarSecciones,
  };
});

// `hashearClave` de lib/auth: no queremos correr scrypt en cada test. Devuelve
// un hash falso; el route sólo lo pasa a la capa (mockeada).
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, hashearClave: vi.fn(async () => 'scrypt$fake') };
});

import { GET, POST, PATCH } from './route';
import { UsuarioInputError } from '@/lib/queries/usuarios';

const SESION_ADMIN = {
  usuarioId: 1,
  usuario: 'lucho',
  nombre: 'Lucho',
  esAdmin: true,
  debeCambiarClave: false,
  secciones: [],
  esFallback: false,
};

function req(body?: unknown): NextRequest {
  return new NextRequest('http://localhost/api/usuarios', {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Por defecto el guard deja pasar como admin.
  guardMock.fn.mockResolvedValue({ sesion: SESION_ADMIN });
});

describe('guard', () => {
  it('devuelve el 403 del guard cuando rechaza (no admin)', async () => {
    const { NextResponse } = await import('next/server');
    guardMock.fn.mockResolvedValueOnce({
      respuesta: NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 }),
    });
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: 'forbidden' });
  });

  it('propaga el 401 del guard sin sesión', async () => {
    const { NextResponse } = await import('next/server');
    guardMock.fn.mockResolvedValueOnce({
      respuesta: NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 }),
    });
    const res = await GET(req());
    expect(res.status).toBe(401);
  });
});

describe('GET', () => {
  it('lista los usuarios', async () => {
    queriesMock.listarUsuarios.mockResolvedValue([
      { id: 1, usuario: 'lucho', nombre: 'Lucho', esAdmin: true, debeCambiarClave: false, activo: true, ultimoLoginAt: null, secciones: [] },
    ]);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.usuarios).toHaveLength(1);
  });
});

describe('POST crea', () => {
  it('crea con éxito 200 (no 201) y NO devuelve claveHash', async () => {
    queriesMock.crearUsuario.mockResolvedValue({
      id: 2, usuario: 'nahuel', nombre: 'Nahuel', esAdmin: false, debeCambiarClave: true, activo: true, ultimoLoginAt: null, secciones: [],
    });
    const res = await POST(req({ usuario: 'nahuel', nombre: 'Nahuel' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.usuario.usuario).toBe('nahuel');
    expect(JSON.stringify(body)).not.toContain('claveHash');
    expect(JSON.stringify(body)).not.toContain('clave_hash');
    // Se creó con debe_cambiar_clave true y no-admin.
    expect(queriesMock.crearUsuario).toHaveBeenCalledWith(
      expect.objectContaining({ usuario: 'nahuel', nombre: 'Nahuel', esAdmin: false, debeCambiarClave: true }),
    );
  });

  it('400 con payload inválido (falta nombre)', async () => {
    const res = await POST(req({ usuario: 'nahuel' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_payload');
    expect(queriesMock.crearUsuario).not.toHaveBeenCalled();
  });

  it('traduce el nombre duplicado (UsuarioInputError) a 400', async () => {
    queriesMock.crearUsuario.mockRejectedValue(new UsuarioInputError('ya existe un usuario con ese nombre'));
    const res = await POST(req({ usuario: 'lucho', nombre: 'Lucho' }));
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toContain('ya existe');
  });
});

describe('PATCH', () => {
  it('valida secciones con z.enum: una sección inventada da 400 sin tocar la base', async () => {
    const res = await PATCH(req({ id: 2, secciones: ['resumen', 'inventada'] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_payload');
    expect(queriesMock.fijarSecciones).not.toHaveBeenCalled();
  });

  it('acepta secciones válidas y las pasa como estado final', async () => {
    queriesMock.fijarSecciones.mockResolvedValue({
      id: 2, usuario: 'nahuel', nombre: 'Nahuel', esAdmin: false, debeCambiarClave: false, activo: true, ultimoLoginAt: null, secciones: ['resumen', 'finanzas'],
    });
    const res = await PATCH(req({ id: 2, secciones: ['resumen', 'finanzas'] }));
    expect(res.status).toBe(200);
    expect(queriesMock.fijarSecciones).toHaveBeenCalledWith(2, ['resumen', 'finanzas']);
  });

  it('traduce el UsuarioInputError del único admin a 400', async () => {
    queriesMock.actualizarUsuario.mockRejectedValue(
      new UsuarioInputError('no se puede: es el único admin activo, el panel quedaría sin nadie que administre'),
    );
    const res = await PATCH(req({ id: 1, esAdmin: false }));
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toContain('único admin');
  });

  it('traduce "no existe" a 404', async () => {
    queriesMock.actualizarUsuario.mockRejectedValue(new UsuarioInputError('ese usuario no existe'));
    const res = await PATCH(req({ id: 999, activo: false }));
    expect(res.status).toBe(404);
  });

  it('400 si no hay nada para cambiar', async () => {
    const res = await PATCH(req({ id: 2 }));
    expect(res.status).toBe(400);
  });
});
