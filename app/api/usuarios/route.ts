/**
 * `/api/usuarios` — GET lista · POST crea · PATCH edita.
 *
 * Sólo admin (MAPA_API de T01 lo mapea como 'admin'). `guardSeccion(req)` es la
 * primera línea de cada método: 401 sin sesión, 403 `clave_pendiente` si debe
 * cambiar la clave, 403 `forbidden` si no es admin.
 *
 * Sobre de respuesta como el resto del panel: `{ ok:true, ... }` /
 * `{ ok:false, error, detail }`. Éxito 200, NO 201 (convención del repo,
 * `app/api/finanzas/cuentas/route.ts`).
 *
 * `claveHash` NUNCA sale en un JSON: `listarUsuarios` (T01) ya no la devuelve, y
 * acá no se vuelve a agregar "para el debug".
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { guardSeccion, SECCIONES } from '@/lib/permisos';
import { hashearClave } from '@/lib/auth';
import {
  UsuarioInputError,
  actualizarUsuario,
  crearUsuario,
  fijarSecciones,
  listarUsuarios,
} from '@/lib/queries/usuarios';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** La clave inicial de un usuario nuevo (D8). Riesgo aceptado a pedido: nace con
 *  `debe_cambiar_clave = true`, así que esa sesión no sirve para nada que no sea
 *  cambiarla. */
const CLAVE_INICIAL = '123456';

function json(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, { status });
}

const createSchema = z.object({
  usuario: z.string().trim().min(1, 'el usuario no puede estar vacío').max(60),
  nombre: z.string().trim().min(1, 'el nombre no puede estar vacío').max(120),
});

// `secciones` es el ESTADO FINAL de los 8 switches, validado con z.enum contra
// SECCIONES — nunca un array a mano. Si divergiera del vocabulario, el INSERT
// explotaría con un 23514 que el usuario ve como un 500.
const seccionEnum = z.enum(SECCIONES);

const patchSchema = z
  .object({
    id: z.number().int().positive(),
    nombre: z.string().trim().min(1).max(120).optional(),
    esAdmin: z.boolean().optional(),
    activo: z.boolean().optional(),
    secciones: z.array(seccionEnum).optional(),
  })
  .refine(
    (v) =>
      v.nombre !== undefined ||
      v.esAdmin !== undefined ||
      v.activo !== undefined ||
      v.secciones !== undefined,
    { message: 'no hay nada para cambiar' },
  );

export async function GET(req: NextRequest): Promise<Response> {
  const guardia = await guardSeccion(req);
  if ('respuesta' in guardia) return guardia.respuesta;

  return json(200, { ok: true, usuarios: await listarUsuarios() });
}

export async function POST(req: NextRequest): Promise<Response> {
  const guardia = await guardSeccion(req);
  if ('respuesta' in guardia) return guardia.respuesta;

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(400, {
      ok: false,
      error: 'invalid_payload',
      detail: parsed.error.issues[0]?.message,
    });
  }

  // El hasheo vive en lib/auth.ts; la capa de queries recibe el hash ya hecho.
  const claveHash = await hashearClave(CLAVE_INICIAL);

  try {
    const usuario = await crearUsuario({
      usuario: parsed.data.usuario,
      nombre: parsed.data.nombre,
      claveHash,
      // Un usuario nuevo NO es admin (los permisos se dan con los switches) y
      // debe cambiar la clave en el primer ingreso (default de la capa, explícito
      // acá para que se lea).
      esAdmin: false,
      debeCambiarClave: true,
    });
    return json(200, { ok: true, usuario });
  } catch (err) {
    // El nombre duplicado (23505) sale 400 traducido, no 500.
    if (err instanceof UsuarioInputError) {
      return json(400, { ok: false, error: 'invalid_payload', detail: err.message });
    }
    throw err;
  }
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const guardia = await guardSeccion(req);
  if ('respuesta' in guardia) return guardia.respuesta;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(400, {
      ok: false,
      error: 'invalid_payload',
      detail: parsed.error.issues[0]?.message,
    });
  }

  const { id, nombre, esAdmin, activo, secciones } = parsed.data;

  try {
    // Dos escrituras que hay que ordenar: primero los campos del usuario (la
    // validación de "no quedarse sin admin" vive en actualizarUsuario, dentro de
    // su tx), después el reemplazo de secciones. `fijarSecciones` reemplaza el
    // conjunto completo dentro de su propia tx.
    let usuario;
    if (nombre !== undefined || esAdmin !== undefined || activo !== undefined) {
      usuario = await actualizarUsuario(id, { nombre, esAdmin, activo });
    }
    if (secciones !== undefined) {
      // Un admin no tiene filas de secciones (D11): su "ve todo" lo resuelve
      // es_admin. Fijar secciones a un admin no rompe nada (las ignora al leer),
      // pero se aplica igual: si más tarde deja de ser admin, quedan las que se
      // eligieron.
      usuario = await fijarSecciones(id, secciones as (typeof SECCIONES)[number][]);
    }
    // Si sólo cambió algo que no re-lee (no debería pasar por el refine), releer.
    if (!usuario) {
      const todos = await listarUsuarios();
      usuario = todos.find((u) => u.id === id) ?? null;
      if (!usuario) return json(404, { ok: false, error: 'unknown_usuario' });
    }
    return json(200, { ok: true, usuario });
  } catch (err) {
    if (err instanceof UsuarioInputError) {
      // "ese usuario no existe" → 404; el resto (único admin, etc.) → 400.
      const code = err.message.includes('no existe') ? 404 : 400;
      return json(code, { ok: false, error: 'invalid_payload', detail: err.message });
    }
    throw err;
  }
}
