import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { Sesion } from '@/lib/permisos';

/**
 * Tests de /api/tareas y sus tres sub-routes (§6 del task T05): las 18
 * afirmaciones de autorización, validación y forma de la respuesta.
 *
 * NO tocan la base. El patrón es el de `app/api/data/ads/route.test.ts:82-85`:
 * `vi.mock('@/lib/permisos', importOriginal)` con `guardSeccion` mockeado
 * devolviendo `{ sesion }` (o `{ respuesta }` para probar los 401/403 del
 * guard), con una `sesionDePrueba` MUTABLE entre tests para pasar de admin a
 * no-admin sin remockear.
 *
 * La capa de datos (`@/lib/queries/tareas`) y el `q1` de `@/lib/db` que usan los
 * routes para leer el dueño de una tarjeta se mockean enteros: acá se verifica
 * la LÓGICA DEL ROUTE (quién puede qué, qué status sale), no el SQL — ese se
 * verifica con base en `lib/queries/tareas.test.ts` (T02) y con los curls de §7.
 *
 * Lo que cada mock representa:
 *  · `duenoActual` (lo que devuelve `q1` de db): el `asignado_a` de la tarjeta en
 *    la base, o `null` = no existe. Es lo que distingue 404 de 403.
 *  · los spies de queries/tareas: que el route llamó (o no) a la capa de datos, y
 *    con qué argumentos (para probar que reasignar usa el dueño de la base, que
 *    creado_por sale de la sesión, y que el comentario va a nombre de la sesión).
 */

const ADMIN: Sesion = {
  usuarioId: 1,
  usuario: 'lucho',
  nombre: 'Lucho',
  esAdmin: true,
  debeCambiarClave: false,
  secciones: ['resumen', 'embudo', 'ventas', 'anuncios', 'finanzas', 'leads', 'config', 'tareas'],
  esFallback: false,
};

const NAHUEL: Sesion = {
  usuarioId: 2,
  usuario: 'nahuel',
  nombre: 'Nahuel',
  esAdmin: false,
  debeCambiarClave: false,
  secciones: ['tareas'],
  esFallback: false,
};

// El estado mutable que comparten los mocks. `guardMock` decide si el guard deja
// pasar (devuelve { sesion }) o corta (devuelve { respuesta }); `duenoActual`
// es lo que el `q1` de db devuelve como asignado_a.
const estado = vi.hoisted(() => ({
  sesion: null as Sesion | null,
  respuestaGuard: null as { status: number; error: string } | null,
  duenoActual: null as number | null,
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

// `q1` de lib/db devuelve el asignado_a de la tarjeta (o del link, con la misma
// forma { asignado_a }), o null si no existe. El DELETE de /api/tareas también
// pide un count de comentarios: se distingue por el SQL.
vi.mock('@/lib/db', () => ({
  q1: vi.fn(async (sql: string) => {
    if (sql.includes('count(*)')) return { n: '3' };
    if (estado.duenoActual === null) return null;
    return { asignado_a: estado.duenoActual };
  }),
}));

// La capa de datos entera, como spies. Cada uno devuelve algo mínimo con la
// forma del contrato; lo que importan son los ARGUMENTOS con que se los llama.
const tareaFalsa = {
  id: 10,
  titulo: 'x',
  notas: null,
  columna: 'por_hacer' as const,
  prioridad: 'media' as const,
  posicion: 0,
  asignadoA: 2,
  asignadoNombre: 'Nahuel',
  creadoPor: 1,
  creadoPorNombre: 'Lucho',
  venceEl: null,
  hechaAt: null,
  createdAt: '2026-09-08T00:00:00.000Z',
  updatedAt: '2026-09-08T00:00:00.000Z',
  links: [],
  comentarios: [],
};

vi.mock('@/lib/queries/tareas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/queries/tareas')>();
  return {
    ...actual, // conserva TareaInputError (los routes hacen instanceof)
    listarTareas: vi.fn(async () => [tareaFalsa]),
    crearTarea: vi.fn(async () => tareaFalsa),
    editarTarea: vi.fn(async () => tareaFalsa),
    moverTarea: vi.fn(async () => undefined),
    borrarTarea: vi.fn(async () => undefined),
    agregarLink: vi.fn(async () => ({ id: 1, url: 'https://x.com', etiqueta: null, posicion: 10 })),
    borrarLink: vi.fn(async () => undefined),
    comentar: vi.fn(async () => ({
      id: 1,
      usuarioId: 2,
      usuarioNombre: 'Nahuel',
      cuerpo: 'hola',
      createdAt: '2026-09-08T00:00:00.000Z',
    })),
  };
});

// Imports DESPUÉS de los mocks (los factories se izan igual, pero deja claro que
// el módulo bajo test ve los mocks).
import { GET, POST, PATCH, DELETE } from './route';
import { POST as MOVER } from './mover/route';
import { POST as LINK_POST, DELETE as LINK_DELETE } from './links/route';
import { POST as COMENTAR } from './comentarios/route';
import * as queries from '@/lib/queries/tareas';

const crearTareaSpy = vi.mocked(queries.crearTarea);
const editarTareaSpy = vi.mocked(queries.editarTarea);
const comentarSpy = vi.mocked(queries.comentar);
const listarTareasSpy = vi.mocked(queries.listarTareas);

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
  estado.duenoActual = null;
  vi.clearAllMocks();
});

// ─── 1-3: el guard (se prueba mockeando su respuesta) ────────────────────────

describe('el guard corta antes que la lógica del route', () => {
  it('1. sin sesión → 401', async () => {
    estado.respuestaGuard = { status: 401, error: 'unauthorized' };
    const r = await GET(req('/api/tareas'));
    expect(r.status).toBe(401);
  });

  it('2. sin la sección tareas → 403 forbidden', async () => {
    estado.respuestaGuard = { status: 403, error: 'forbidden' };
    const r = await GET(req('/api/tareas'));
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('forbidden');
  });

  it('3. debeCambiarClave → 403 clave_pendiente (NO forbidden)', async () => {
    estado.respuestaGuard = { status: 403, error: 'clave_pendiente' };
    const r = await GET(req('/api/tareas'));
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('clave_pendiente');
  });
});

// ─── 4-6: POST y body ────────────────────────────────────────────────────────

describe('POST /api/tareas', () => {
  it('4. POST con lo mínimo → 200 con la tarjeta', async () => {
    const r = await POST(req('/api/tareas', { body: { titulo: 'Tarea', asignadoA: 2 } }));
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.tarea.columna).toBe('por_hacer');
    expect(b.tarea.prioridad).toBe('media');
  });

  it('5. POST sin título o sin asignado → 400 invalid_payload', async () => {
    const sinTitulo = await POST(req('/api/tareas', { body: { asignadoA: 2 } }));
    expect(sinTitulo.status).toBe(400);
    expect((await sinTitulo.json()).error).toBe('invalid_payload');

    const sinAsignado = await POST(req('/api/tareas', { body: { titulo: 'x' } }));
    expect(sinAsignado.status).toBe(400);
  });

  it('6. body que no es JSON → 400, NO 500', async () => {
    const r = await POST(req('/api/tareas', { raw: 'esto no es json {' }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_payload');
  });

  it('9. no-admin creando una tarjeta asignada a otro → 200', async () => {
    estado.sesion = NAHUEL;
    const r = await POST(req('/api/tareas', { body: { titulo: 'para lucho', asignadoA: 1 } }));
    expect(r.status).toBe(200);
    // creado_por sale de la sesión (nahuel), no del payload
    expect(crearTareaSpy).toHaveBeenCalledWith(expect.objectContaining({ asignadoA: 1 }), 2);
  });
});

// ─── 7-12: PATCH y autorización a nivel fila ──────────────────────────────────

describe('PATCH /api/tareas — autorización a nivel fila', () => {
  it('7. no-admin editando una tarjeta ajena → 403 con detail', async () => {
    estado.sesion = NAHUEL;
    estado.duenoActual = 1; // es de lucho
    const r = await PATCH(req('/api/tareas', { method: 'PATCH', body: { id: 10, titulo: 'pisada' } }));
    expect(r.status).toBe(403);
    const b = await r.json();
    expect(b.error).toBe('forbidden');
    expect(b.detail).toBe('esa tarea está asignada a otra persona');
    // El 403 salió ANTES de escribir
    expect(editarTareaSpy).not.toHaveBeenCalled();
  });

  it('8. no-admin editando la suya → 200', async () => {
    estado.sesion = NAHUEL;
    estado.duenoActual = 2; // es de nahuel
    const r = await PATCH(req('/api/tareas', { method: 'PATCH', body: { id: 10, titulo: 'mía' } }));
    expect(r.status).toBe(200);
    expect(editarTareaSpy).toHaveBeenCalled();
  });

  it('10. no-admin reasignando SU tarjeta a otro → 200; una ajena → 403', async () => {
    estado.sesion = NAHUEL;
    // la suya, pasándosela a lucho (delegar)
    estado.duenoActual = 2;
    const propia = await PATCH(req('/api/tareas', { method: 'PATCH', body: { id: 10, asignadoA: 1 } }));
    expect(propia.status).toBe(200);
    // se verifica contra el dueño de la BASE (2), no contra el asignadoA del payload (1)
    expect(editarTareaSpy).toHaveBeenCalledWith(10, expect.objectContaining({ asignadoA: 1 }));

    // una ajena: no la puede tocar aunque quiera reasignarla
    editarTareaSpy.mockClear();
    estado.duenoActual = 1; // es de lucho
    const ajena = await PATCH(req('/api/tareas', { method: 'PATCH', body: { id: 11, asignadoA: 2 } }));
    expect(ajena.status).toBe(403);
    expect(editarTareaSpy).not.toHaveBeenCalled();
  });

  it('11. admin editando cualquiera → 200', async () => {
    estado.sesion = ADMIN;
    estado.duenoActual = 2; // de nahuel, pero el admin puede
    const r = await PATCH(req('/api/tareas', { method: 'PATCH', body: { id: 10, titulo: 'admin manda' } }));
    expect(r.status).toBe(200);
  });

  it('12. editar una tarjeta que no existe → 404, NO 403', async () => {
    estado.sesion = NAHUEL;
    estado.duenoActual = null; // no existe
    const r = await PATCH(req('/api/tareas', { method: 'PATCH', body: { id: 999, titulo: 'x' } }));
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe('unknown_tarea');
  });

  it('13. notas:null borra la nota; sin el campo, no la toca', async () => {
    estado.sesion = ADMIN;
    estado.duenoActual = 2;

    // null → se pasa null a editarTarea (borra)
    await PATCH(req('/api/tareas', { method: 'PATCH', body: { id: 10, notas: null } }));
    expect(editarTareaSpy).toHaveBeenCalledWith(10, expect.objectContaining({ notas: null }));

    // sin el campo → editarTarea NO recibe notas (no la toca)
    editarTareaSpy.mockClear();
    await PATCH(req('/api/tareas', { method: 'PATCH', body: { id: 10, titulo: 'solo título' } }));
    const cambios = editarTareaSpy.mock.calls[0][1];
    expect('notas' in cambios).toBe(false);
  });
});

// ─── 14: mover ─────────────────────────────────────────────────────────────

describe('POST /api/tareas/mover', () => {
  it('14. mover con orden que no contiene el id → 400', async () => {
    estado.sesion = ADMIN;
    estado.duenoActual = 2;
    const r = await MOVER(req('/api/tareas/mover', { body: { id: 10, columna: 'hecho', orden: [11, 12] } }));
    expect(r.status).toBe(400);
    const b = await r.json();
    expect(b.error).toBe('invalid_payload');
    expect(b.detail).toContain('10');
  });
});

// ─── 15: links ─────────────────────────────────────────────────────────────

describe('POST /api/tareas/links', () => {
  it('15. link javascript:alert(1) → 400 invalid_payload, NO 500', async () => {
    estado.sesion = ADMIN;
    estado.duenoActual = 2;
    const r = await LINK_POST(
      req('/api/tareas/links', { body: { tareaId: 10, url: 'javascript:alert(1)' } }),
    );
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_payload');
  });
});

// ─── 16-17: comentarios ──────────────────────────────────────────────────────

describe('POST /api/tareas/comentarios', () => {
  it('16. usuarioId en el body se ignora: el comentario queda a nombre de la sesión', async () => {
    estado.sesion = NAHUEL; // usuarioId 2
    const r = await COMENTAR(
      req('/api/tareas/comentarios', { body: { tareaId: 10, cuerpo: 'hola', usuarioId: 999 } }),
    );
    expect(r.status).toBe(200);
    // comentar(tareaId, usuarioId, cuerpo) con el usuarioId de la SESIÓN (2), no el 999 del body
    expect(comentarSpy).toHaveBeenCalledWith(10, 2, 'hola');
  });

  it('17. cuerpo de puros espacios → 400, NO 500', async () => {
    estado.sesion = ADMIN;
    const r = await COMENTAR(req('/api/tareas/comentarios', { body: { tareaId: 10, cuerpo: '   ' } }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('invalid_payload');
    expect(comentarSpy).not.toHaveBeenCalled();
  });
});

// ─── 18: el parámetro asignado del GET ───────────────────────────────────────

describe('GET /api/tareas — el parámetro asignado', () => {
  it('18. ?asignado=pepe → 400; ?asignado=todas y sin parámetro → todas', async () => {
    estado.sesion = ADMIN;

    const invalido = await GET(req('/api/tareas?asignado=pepe'));
    expect(invalido.status).toBe(400);
    expect((await invalido.json()).error).toBe('invalid_payload');
    expect(listarTareasSpy).not.toHaveBeenCalled();

    // ?asignado=todas → listarTareas con asignadoA null
    listarTareasSpy.mockClear();
    const todas = await GET(req('/api/tareas?asignado=todas'));
    expect(todas.status).toBe(200);
    expect(listarTareasSpy).toHaveBeenCalledWith({ asignadoA: null, archivadas: false });

    // sin el parámetro → también todas (asignadoA null)
    listarTareasSpy.mockClear();
    const sinParam = await GET(req('/api/tareas'));
    expect(sinParam.status).toBe(200);
    expect(listarTareasSpy).toHaveBeenCalledWith({ asignadoA: null, archivadas: false });

    // un id numérico → filtra
    listarTareasSpy.mockClear();
    const filtrada = await GET(req('/api/tareas?asignado=2'));
    expect(filtrada.status).toBe(200);
    expect(listarTareasSpy).toHaveBeenCalledWith({ asignadoA: 2, archivadas: false });
  });
});
