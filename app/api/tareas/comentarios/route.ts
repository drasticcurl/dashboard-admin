/**
 * /api/tareas/comentarios — POST { tareaId, cuerpo }.
 *
 * Comentar NO requiere ser dueño (§4.3): es la forma que tiene el admin de pedir
 * algo sobre una tarjeta ajena, y al revés. Por eso NO hay comprobación de dueño
 * acá. Lo que sí es innegociable: el `usuarioId` del comentario sale de la
 * SESIÓN, nunca del body — un comentario firmable por el cliente es un comentario
 * que se puede poner en boca de otro. Cualquier `usuarioId` que venga en el body
 * se ignora (el schema ni lo mira).
 *
 * Sin PATCH ni DELETE de comentarios: no se pidió, y un comentario editable en un
 * tablero compartido es una conversación que cambia de significado después de
 * leída.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { guardSeccion } from '@/lib/permisos';
import { json } from '@/app/api/config/_lib';
import { TareaInputError, comentar } from '@/lib/queries/tareas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const comentarioSchema = z.object({
  tareaId: z.number().int().positive(),
  // El `.trim()` va ANTES del `.min(1)`: sin eso, un cuerpo de puros espacios
  // pasa el `min(1)` de zod y lo rechaza el CHECK `tarea_comentarios_cuerpo_no_vacio`
  // de la 031 — otra vez como un 500 crudo en vez de un 400 legible.
  cuerpo: z.string().trim().min(1, 'el comentario no puede estar vacío').max(4000),
});

export async function POST(req: NextRequest): Promise<Response> {
  const g = await guardSeccion(req);
  if ('respuesta' in g) return g.respuesta;
  const { sesion } = g;

  const parsed = comentarioSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(400, {
      ok: false,
      error: 'invalid_payload',
      detail: parsed.error.issues[0]?.message,
    });
  }
  const { tareaId, cuerpo } = parsed.data;

  try {
    // usuarioId de la SESIÓN. En el fallback de D10 (usuarioId 0, tabla vacía) el
    // FK a usuarios falla con 23503 → TareaInputError → 400: la sesión del
    // bootstrap no puede firmar un comentario, y es correcto que no pueda (no hay
    // un usuario real detrás).
    const comentario = await comentar(tareaId, sesion.usuarioId, cuerpo);
    return json(200, { ok: true, comentario });
  } catch (err) {
    if (err instanceof TareaInputError) {
      // "el usuario indicado no existe" cubre tanto una tareaId inexistente (FK
      // de tarea_id) como el caso del fallback; los dos son 400 con el detail
      // legible que traduce la capa de datos.
      return json(400, { ok: false, error: 'invalid_payload', detail: err.message });
    }
    throw err;
  }
}
