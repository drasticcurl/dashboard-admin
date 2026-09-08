/**
 * /api/tareas — GET / POST / PATCH / DELETE del tablero kanban.
 *
 * El molde es `app/api/finanzas/cuentas/route.ts`: `runtime='nodejs'` y
 * `dynamic='force-dynamic'` a nivel módulo (el `pg` no corre en Edge), el guard
 * como PRIMERÍSIMA línea de cada método (GET incluido), zod con `safeParse`
 * sobre `await req.json().catch(() => null)` para que un body malformado sea el
 * mismo 400 que un campo inválido, el sobre `{ ok:true, ... }` con éxito 200
 * (NO 201), y los errores de Postgres SIN traducir acá: sólo
 * `if (err instanceof TareaInputError) return json(400, ...)` y el resto
 * `throw err` — el mapeo del SQLSTATE vive en `lib/queries/tareas.ts` (T02).
 *
 * ACÁ vive lo que la capa de datos no conoce a propósito (T02 §1): QUIÉN puede
 * editar qué. La regla de §4 del task:
 *   · Ver / crear / comentar: cualquiera (crear a cualquiera, comentar cualquiera).
 *   · Editar / mover / borrar / links: sólo el dueño, salvo admin.
 * El dueño se comprueba SIEMPRE contra el `asignado_a` de la BASE (no el del
 * payload) y DESPUÉS de leer la tarjeta: leer primero, comprobar después,
 * escribir al final. Un `WHERE asignado_a = $1` en el UPDATE no distingue 404
 * (no existe) de 403 (no es tuya) — devuelve 0 filas en los dos casos.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { guardSeccion } from '@/lib/permisos';
import { json } from '@/app/api/config/_lib';
import { q1 } from '@/lib/db';
import {
  TareaInputError,
  crearTarea,
  editarTarea,
  listarTareas,
  borrarTarea,
} from '@/lib/queries/tareas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ─── Esquemas ────────────────────────────────────────────────────────────────

const columnaEnum = z.enum(['por_hacer', 'en_progreso', 'en_revision', 'hecho']);
const prioridadEnum = z.enum(['alta', 'media', 'baja']);
const fecha = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'la fecha va en formato YYYY-MM-DD');

const createSchema = z.object({
  titulo: z.string().trim().min(1, 'la tarea necesita un título').max(200),
  asignadoA: z.number().int().positive('hay que asignar la tarea a alguien'),
  notas: z.string().max(4000).nullable().optional(),
  prioridad: prioridadEnum.optional(),
  columna: columnaEnum.optional(),
  venceEl: fecha.nullable().optional(),
});

// `.nullable().optional()` en notas y venceEl (líneas 46-48 del molde): mandar
// `null` BORRA la nota/fecha, no mandar el campo la DEJA. Con `.optional()` solo
// no hay forma de borrar una nota.
const patchSchema = z.object({
  id: z.number().int().positive(),
  titulo: z.string().trim().min(1).max(200).optional(),
  notas: z.string().max(4000).nullable().optional(),
  prioridad: prioridadEnum.optional(),
  asignadoA: z.number().int().positive().optional(),
  venceEl: fecha.nullable().optional(),
});

// ─── Autorización a nivel fila (§4) ───────────────────────────────────────────

type DuenoRow = { asignado_a: string | number };

/**
 * Lee el `asignado_a` actual de una tarjeta. `null` si no existe. Es la lectura
 * de §4.1: hay que tenerla ANTES de decidir 404 vs 403 vs escribir.
 */
async function duenoDeLaTarjeta(id: number): Promise<number | null> {
  const row = await q1<DuenoRow>('SELECT asignado_a FROM tareas WHERE id = $1', [id]);
  return row ? Number(row.asignado_a) : null;
}

const RESP_403_AJENA = {
  ok: false as const,
  error: 'forbidden' as const,
  // El detail expone el motivo real a propósito (§4): el usuario YA ve la
  // tarjeta y de quién es, así que no hay nada que filtrar, y un 403 mudo lo
  // manda a mirar la consola.
  detail: 'esa tarea está asignada a otra persona',
};

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<Response> {
  const g = await guardSeccion(req);
  if ('respuesta' in g) return g.respuesta;

  const params = new URL(req.url).searchParams;
  const asignadoRaw = params.get('asignado');

  // Sin el parámetro, el default es TODAS: es un tablero compartido y esconder
  // por default es lo contrario de lo que se pidió (§5).
  let asignadoA: number | null = null;
  if (asignadoRaw !== null && asignadoRaw !== 'todas') {
    // Un `asignado` inválido → 400, NUNCA tratado como 'todas': un typo en el
    // cliente mostraría todo en silencio.
    if (!/^\d+$/.test(asignadoRaw)) {
      return json(400, {
        ok: false,
        error: 'invalid_payload',
        detail: 'asignado tiene que ser un id numérico o el literal "todas"',
      });
    }
    asignadoA = Number(asignadoRaw);
  }

  const archivadas = params.get('archivadas') === '1';

  const tareas = await listarTareas({ asignadoA, archivadas });
  return json(200, { ok: true, tareas });
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

  // Crear NO está restringido: un no-admin puede crear una tarjeta asignada a
  // cualquiera (§4). No hay comprobación de dueño acá.
  //
  // `creado_por` sale de la SESIÓN, y va `null` en el fallback de D10: la sesión
  // del DASHBOARD_PASSWORD con la tabla vacía tiene usuarioId 0, que no existe en
  // `usuarios` y haría fallar el FK con un 23503.
  const creadoPor = sesion.esFallback ? null : sesion.usuarioId;

  try {
    const tarea = await crearTarea(parsed.data, creadoPor);
    return json(200, { ok: true, tarea });
  } catch (err) {
    if (err instanceof TareaInputError) {
      return json(400, { ok: false, error: 'invalid_payload', detail: err.message });
    }
    throw err;
  }
}

// ─── PATCH ────────────────────────────────────────────────────────────────────

export async function PATCH(req: NextRequest): Promise<Response> {
  const g = await guardSeccion(req);
  if ('respuesta' in g) return g.respuesta;
  const { sesion } = g;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(400, {
      ok: false,
      error: 'invalid_payload',
      detail: parsed.error.issues[0]?.message,
    });
  }
  const { id, ...cambios } = parsed.data;

  // Leer primero (§4.1): necesito el `asignado_a` DE LA BASE para distinguir
  // "no existe" (404) de "no es tuya" (403), y para no dejar que reasignar sea
  // una forma de saltarse el chequeo — reasignar ES editar (§4.2).
  const dueno = await duenoDeLaTarjeta(id);
  if (dueno === null) {
    // 404 y NO 403: editar una tarjeta inexistente no es un problema de permiso.
    // El orden de los chequeos importa (§6.12).
    return json(404, { ok: false, error: 'unknown_tarea' });
  }
  // Comprobar después: un no-admin sólo edita las que tiene asignadas HOY. Si la
  // tarjeta es suya puede incluso pasársela a otro (delegar, §4.2, es válido);
  // lo que no puede es tocar una que YA es de otro. Se compara contra `dueno`
  // (base), nunca contra `cambios.asignadoA` (payload).
  if (!sesion.esAdmin && dueno !== sesion.usuarioId) {
    return json(403, RESP_403_AJENA);
  }

  try {
    const tarea = await editarTarea(id, cambios);
    return json(200, { ok: true, tarea });
  } catch (err) {
    if (err instanceof TareaInputError) {
      // "esa tarea no existe" no debería salir por acá (ya leímos el dueño), pero
      // una carrera podría borrarla en el medio: 404 si el mensaje lo dice.
      const code = err.message.includes('no existe') ? 404 : 400;
      const error = code === 404 ? 'unknown_tarea' : 'invalid_payload';
      return json(code, { ok: false, error, detail: err.message });
    }
    throw err;
  }
}

// ─── DELETE ─────────────────────────────────────────────────────────────────

/**
 * Borra una tarjeta. El CASCADE de la 031 se lleva sus links y comentarios; el
 * conteo de comentarios se lee ANTES de borrar y viaja en la respuesta para que
 * la confirmación de T06 pueda decir el número (borrar una tarjeta con 8
 * comentarios borra la conversación).
 */
export async function DELETE(req: NextRequest): Promise<Response> {
  const g = await guardSeccion(req);
  if ('respuesta' in g) return g.respuesta;
  const { sesion } = g;

  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) {
    return json(400, { ok: false, error: 'invalid_payload', detail: 'id inválido' });
  }

  const dueno = await duenoDeLaTarjeta(id);
  if (dueno === null) {
    return json(404, { ok: false, error: 'unknown_tarea' });
  }
  if (!sesion.esAdmin && dueno !== sesion.usuarioId) {
    return json(403, RESP_403_AJENA);
  }

  // El conteo de comentarios, antes de que el CASCADE se los lleve.
  const row = await q1<{ n: string }>(
    'SELECT count(*)::text AS n FROM tarea_comentarios WHERE tarea_id = $1',
    [id],
  );
  const comentariosBorrados = Number(row?.n ?? 0);

  await borrarTarea(id);
  return json(200, { ok: true, comentariosBorrados });
}
