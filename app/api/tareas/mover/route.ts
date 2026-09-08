/**
 * /api/tareas/mover — POST { id, columna, orden: number[] }.
 *
 * Mueve la tarjeta `id` a `columna` y reescribe el orden de esa columna con
 * `orden` (la lista completa de ids que quedan en la columna destino). El molde,
 * el sobre y el tratamiento de errores son los de `../route.ts`.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { guardSeccion } from '@/lib/permisos';
import { json } from '@/app/api/config/_lib';
import { q1 } from '@/lib/db';
import { TareaInputError, moverTarea } from '@/lib/queries/tareas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const columnaEnum = z.enum(['por_hacer', 'en_progreso', 'en_revision', 'hecho']);

const moverSchema = z.object({
  id: z.number().int().positive(),
  columna: columnaEnum,
  // La lista completa de ids de la columna destino, ordenada. `.positive()`
  // porque son ids reales; `.min(1)` porque la columna destino tiene al menos la
  // tarjeta que se está moviendo.
  orden: z.array(z.number().int().positive()).min(1),
});

async function duenoDeLaTarjeta(id: number): Promise<number | null> {
  const row = await q1<{ asignado_a: string | number }>(
    'SELECT asignado_a FROM tareas WHERE id = $1',
    [id],
  );
  return row ? Number(row.asignado_a) : null;
}

export async function POST(req: NextRequest): Promise<Response> {
  const g = await guardSeccion(req);
  if ('respuesta' in g) return g.respuesta;
  const { sesion } = g;

  const parsed = moverSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(400, {
      ok: false,
      error: 'invalid_payload',
      detail: parsed.error.issues[0]?.message,
    });
  }
  const { id, columna, orden } = parsed.data;

  // `orden` TIENE que contener a `id`: si no, el cliente pidió reordenar una
  // columna sin la tarjeta que dice estar moviendo hacia ella. 400 con el detail
  // diciendo qué esperaba, no un error opaco de la capa de datos.
  if (!orden.includes(id)) {
    return json(400, {
      ok: false,
      error: 'invalid_payload',
      detail: `la lista de orden tiene que contener el id ${id} de la tarjeta que se mueve`,
    });
  }

  // Se verifica el dueño de la tarjeta que SE MUEVE (`id`), NO el de las demás de
  // `orden`. Parece un agujero y no lo es: `orden` es toda la columna destino,
  // que incluye tarjetas de otros, y reordenarlas es una consecuencia inevitable
  // de mover la propia a una columna compartida (§4.5). `posicion` es orden de
  // presentación, no contenido; exigir ser dueño de todas dejaría a un no-admin
  // sin poder mover ninguna tarjeta a una columna que comparte con otro.
  const dueno = await duenoDeLaTarjeta(id);
  if (dueno === null) {
    return json(404, { ok: false, error: 'unknown_tarea' });
  }
  if (!sesion.esAdmin && dueno !== sesion.usuarioId) {
    return json(403, {
      ok: false,
      error: 'forbidden',
      detail: 'esa tarea está asignada a otra persona',
    });
  }

  try {
    await moverTarea(id, columna, orden);
    return json(200, { ok: true });
  } catch (err) {
    if (err instanceof TareaInputError) {
      const code = err.message.includes('no existe') ? 404 : 400;
      const error = code === 404 ? 'unknown_tarea' : 'invalid_payload';
      return json(code, { ok: false, error, detail: err.message });
    }
    throw err;
  }
}
