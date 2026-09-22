/**
 * /api/creativos — GET / POST / PATCH / DELETE del tracker de eficiencia de
 * videos.
 *
 * El molde es `app/api/tareas/route.ts`: `runtime='nodejs'` y
 * `dynamic='force-dynamic'` a nivel módulo, el guard como PRIMERÍSIMA línea de
 * cada método (GET incluido), zod con `safeParse` sobre
 * `await req.json().catch(() => null)`, el sobre `{ ok:true, ... }` con éxito
 * 200, y los errores de Postgres SIN traducir acá (el mapeo del SQLSTATE vive en
 * `lib/queries/creativos.ts`).
 *
 * A diferencia de `/api/tareas`, ACÁ NO hay autorización a nivel fila: cualquiera
 * con la sección 'creativos' puede editar o borrar cualquier fila, porque no hay
 * "dueño" (ver el docblock de la 034 y de `lib/queries/creativos.ts`). Por eso no
 * hay un `duenoDeLaFila` ni un chequeo de `sesion.esAdmin` antes de escribir.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { guardSeccion } from '@/lib/permisos';
import { json } from '@/app/api/config/_lib';
import {
  CreativoInputError,
  RENDIMIENTOS,
  crearCreativo,
  editarCreativo,
  listarCreativos,
  borrarCreativo,
  type Rendimiento,
} from '@/lib/queries/creativos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ─── Esquemas ────────────────────────────────────────────────────────────────

// El cast del array a la tupla no-vacía que pide z.enum: RENDIMIENTOS ya es
// `readonly Rendimiento[]` con al menos un elemento (const literal), zod pide el
// tipo de tupla para inferir el enum en compilación.
const rendimientoEnum = z.enum(RENDIMIENTOS as unknown as [Rendimiento, ...Rendimiento[]]);

const createSchema = z.object({
  nombre: z.string().trim().min(1, 'el creativo necesita un nombre').max(200),
  link: z.string().trim().min(1, 'el creativo necesita un link').max(2000),
  rendimiento: rendimientoEnum,
});

const patchSchema = z.object({
  id: z.number().int().positive(),
  nombre: z.string().trim().min(1).max(200).optional(),
  link: z.string().trim().min(1).max(2000).optional(),
  rendimiento: rendimientoEnum.optional(),
});

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<Response> {
  const g = await guardSeccion(req);
  if ('respuesta' in g) return g.respuesta;

  const creativos = await listarCreativos();
  return json(200, { ok: true, creativos });
}

// ─── POST ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<Response> {
  const g = await guardSeccion(req);
  if ('respuesta' in g) return g.respuesta;
  const { sesion } = g;

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(400, {
      ok: false,
      error: 'invalid_payload',
      detail: parsed.error.issues[0]?.message,
    });
  }

  // `creado_por` sale de la SESIÓN, null en el fallback de D10 (usuarioId 0 no
  // existe en `usuarios` y haría fallar el FK con un 23503), mismo patrón que
  // POST /api/tareas.
  const creadoPor = sesion.esFallback ? null : sesion.usuarioId;

  try {
    const creativo = await crearCreativo(
      { nombre: parsed.data.nombre, link: parsed.data.link, rendimiento: parsed.data.rendimiento },
      creadoPor,
    );
    return json(200, { ok: true, creativo });
  } catch (err) {
    if (err instanceof CreativoInputError) {
      return json(400, { ok: false, error: 'invalid_payload', detail: err.message });
    }
    throw err;
  }
}

// ─── PATCH ────────────────────────────────────────────────────────────────────

export async function PATCH(req: NextRequest): Promise<Response> {
  const g = await guardSeccion(req);
  if ('respuesta' in g) return g.respuesta;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(400, {
      ok: false,
      error: 'invalid_payload',
      detail: parsed.error.issues[0]?.message,
    });
  }
  const { id, ...cambios } = parsed.data;

  try {
    const creativo = await editarCreativo(id, cambios);
    return json(200, { ok: true, creativo });
  } catch (err) {
    if (err instanceof CreativoInputError) {
      const code = err.message.includes('no existe') ? 404 : 400;
      const error = code === 404 ? 'unknown_creativo' : 'invalid_payload';
      return json(code, { ok: false, error, detail: err.message });
    }
    throw err;
  }
}

// ─── DELETE ─────────────────────────────────────────────────────────────────

export async function DELETE(req: NextRequest): Promise<Response> {
  const g = await guardSeccion(req);
  if ('respuesta' in g) return g.respuesta;

  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return json(400, { ok: false, error: 'invalid_payload', detail: 'id inválido' });
  }

  await borrarCreativo(id);
  return json(200, { ok: true });
}
