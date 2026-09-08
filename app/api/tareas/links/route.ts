/**
 * /api/tareas/links — POST { tareaId, url, etiqueta? } / DELETE ?id=.
 *
 * Un no-admin agrega o borra links SÓLO en las tarjetas asignadas a él (§4); el
 * admin en todas. El dueño se comprueba contra el `asignado_a` de la BASE,
 * después de leer y antes de escribir, igual que en `../route.ts`.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { guardSeccion } from '@/lib/permisos';
import { json } from '@/app/api/config/_lib';
import { q1 } from '@/lib/db';
import { TareaInputError, agregarLink, borrarLink } from '@/lib/queries/tareas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const linkSchema = z.object({
  tareaId: z.number().int().positive(),
  // DOS chequeos, no uno: `z.string().url()` ACEPTA `javascript:alert(1)` (es una
  // URL válida según el WHATWG), así que además se exige protocolo http/https con
  // un `.refine()` explícito. Sin esto, un `javascript:` pasaría zod y sólo lo
  // frenaría el CHECK de la 031 — como un 500 crudo en vez de un 400 legible. El
  // CHECK es la última defensa; esto es la primera.
  url: z
    .string()
    .url('el link no es una URL válida')
    .refine((u) => /^https?:\/\//i.test(u), 'el link tiene que empezar con http:// o https://'),
  etiqueta: z.string().trim().max(80).optional(),
});

async function duenoDeLaTarjeta(id: number): Promise<number | null> {
  const row = await q1<{ asignado_a: string | number }>(
    'SELECT asignado_a FROM tareas WHERE id = $1',
    [id],
  );
  return row ? Number(row.asignado_a) : null;
}

const RESP_403_AJENA = {
  ok: false as const,
  error: 'forbidden' as const,
  detail: 'esa tarea está asignada a otra persona',
};

export async function POST(req: NextRequest): Promise<Response> {
  const g = await guardSeccion(req);
  if ('respuesta' in g) return g.respuesta;
  const { sesion } = g;

  const parsed = linkSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(400, {
      ok: false,
      error: 'invalid_payload',
      detail: parsed.error.issues[0]?.message,
    });
  }
  const { tareaId, url, etiqueta } = parsed.data;

  const dueno = await duenoDeLaTarjeta(tareaId);
  if (dueno === null) {
    return json(404, { ok: false, error: 'unknown_tarea' });
  }
  if (!sesion.esAdmin && dueno !== sesion.usuarioId) {
    return json(403, RESP_403_AJENA);
  }

  try {
    const link = await agregarLink(tareaId, url, etiqueta ?? null);
    return json(200, { ok: true, link });
  } catch (err) {
    if (err instanceof TareaInputError) {
      return json(400, { ok: false, error: 'invalid_payload', detail: err.message });
    }
    throw err;
  }
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const g = await guardSeccion(req);
  if ('respuesta' in g) return g.respuesta;
  const { sesion } = g;

  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return json(400, { ok: false, error: 'invalid_payload', detail: 'id inválido' });
  }

  // Para autorizar hay que saber a qué tarjeta pertenece el link, y quién es su
  // dueña. El link no existe → 404 (no 403): borrar un link inexistente no es un
  // problema de permiso.
  const row = await q1<{ asignado_a: string | number }>(
    `SELECT t.asignado_a
       FROM tarea_links l
       JOIN tareas t ON t.id = l.tarea_id
      WHERE l.id = $1`,
    [id],
  );
  if (!row) {
    return json(404, { ok: false, error: 'unknown_link' });
  }
  const dueno = Number(row.asignado_a);
  if (!sesion.esAdmin && dueno !== sesion.usuarioId) {
    return json(403, RESP_403_AJENA);
  }

  await borrarLink(id);
  return json(200, { ok: true });
}
