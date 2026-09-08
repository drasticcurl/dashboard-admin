/**
 * `/api/usuarios/clave` — POST. Dos formas, una sola ruta:
 *
 *   { claveActual, claveNueva }  → CUALQUIER usuario cambia la SUYA.
 *   { id, resetear: true }        → SÓLO admin: resetea la de OTRO a 123456.
 *
 * La ruta está mapeada como 'admin' en MAPA_API (T01), pero la primera forma es
 * la excepción de "cualquiera cambia la suya". Por eso NO se usa
 * `guardSeccion(req)` (haría 403 a un no-admin antes de poder ramificar): se lee
 * la sesión directo con `sesionActual()` y se decide adentro, comparando contra
 * la sesión — sin tocar el mapa (§5.2).
 *
 * `runtime='nodejs'`, `dynamic='force-dynamic'`, zod safeParse, sobre
 * `{ ok:true }` / `{ ok:false, error, detail }`, éxito 200.
 *
 * `claveHash` NUNCA sale en un JSON. La clave del reset SÍ sale en texto, a
 * propósito (§5.4): es info que el admin ya tiene derecho a saber y esconderla
 * sólo genera una llamada.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { MIN_LARGO_CLAVE, hashearClave, verificarClave } from '@/lib/auth';
import { sesionActual } from '@/lib/permisos';
import { q } from '@/lib/db';
import { cambiarClave, usuarioPorId, usuarioPorNombre } from '@/lib/queries/usuarios';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** La clave a la que vuelve un reset (D8). Igual que la inicial de un alta. */
const CLAVE_RESET = '123456';

function json(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, { status });
}

// Las dos formas son excluyentes. Un discriminated union no encaja limpio con
// campos totalmente distintos, así que se prueban los dos schemas por separado.
const cambioPropioSchema = z.object({
  claveActual: z.string().min(1),
  claveNueva: z.string().min(1),
});

const resetSchema = z.object({
  id: z.number().int().positive(),
  resetear: z.literal(true),
});

export async function POST(req: NextRequest): Promise<Response> {
  // No `guardSeccion`: esta ruta tiene la excepción del cambio propio. El chequeo
  // de sesión y clave_pendiente se hace a mano, con la misma semántica que el
  // guard (401 sin sesión).
  const sesion = await sesionActual();
  if (!sesion) {
    return json(401, { ok: false, error: 'unauthorized' });
  }

  const body = await req.json().catch(() => null);

  // ── Forma RESET: { id, resetear:true } — sólo admin ──────────────────────
  const reset = resetSchema.safeParse(body);
  if (reset.success) {
    if (!sesion.esAdmin) {
      return json(403, { ok: false, error: 'forbidden' });
    }
    const objetivo = await usuarioPorId(reset.data.id);
    if (!objetivo) {
      return json(404, { ok: false, error: 'unknown_usuario' });
    }

    // El reset vuelve la clave a 123456 Y `debe_cambiar_clave` a true. La capa
    // `cambiarClave(id, hash)` de T01 baja el flag a false (es para el cambio
    // propio), así que el reset se hace con un UPDATE parametrizado acá — sin
    // tocar lib/ (contrato congelado) y sin concatenar valores (§9.3). Es la
    // ÚNICA escritura de este route que no pasa por la capa de queries, y la
    // razón está acá para que no parezca un descuido.
    const hash = await hashearClave(CLAVE_RESET);
    await q(
      `UPDATE usuarios SET clave_hash = $2, debe_cambiar_clave = true WHERE id = $1`,
      [reset.data.id, hash],
    );

    // La clave en texto, a propósito, para que el admin la pueda pasar (§5.4).
    return json(200, { ok: true, claveNueva: CLAVE_RESET });
  }

  // ── Forma CAMBIO PROPIO: { claveActual, claveNueva } — cualquiera ────────
  const propio = cambioPropioSchema.safeParse(body);
  if (!propio.success) {
    return json(400, {
      ok: false,
      error: 'invalid_payload',
      detail: 'esperado { claveActual, claveNueva } o { id, resetear: true }',
    });
  }

  // El fallback de D10 (usuarioId 0) no tiene fila ni clave propia que cambiar.
  if (sesion.esFallback || sesion.usuarioId === 0) {
    return json(403, { ok: false, error: 'forbidden', detail: 'la sesión de emergencia no tiene clave propia' });
  }

  // El hash sale por el NOMBRE de la sesión (único lugar que lo expone), pero se
  // valida que la fila sea la del usuarioId de la sesión: la clave que se cambia
  // es SIEMPRE la del que está logueado, nunca la de otro.
  const fila = await usuarioPorNombre(sesion.usuario);
  if (!fila || fila.id !== sesion.usuarioId) {
    return json(401, { ok: false, error: 'unauthorized' });
  }

  const actualOk = await verificarClave(propio.data.claveActual, fila.claveHash);
  if (!actualOk) {
    return json(400, { ok: false, error: 'invalid_payload', detail: 'la contraseña actual no es correcta' });
  }

  if (propio.data.claveNueva.length < MIN_LARGO_CLAVE) {
    return json(400, {
      ok: false,
      error: 'invalid_payload',
      detail: `la contraseña nueva necesita al menos ${MIN_LARGO_CLAVE} caracteres`,
    });
  }

  // La nueva no puede ser igual a la actual (si no, el agujero de D8 sigue abierto).
  const esLaMisma = await verificarClave(propio.data.claveNueva, fila.claveHash);
  if (esLaMisma) {
    return json(400, {
      ok: false,
      error: 'invalid_payload',
      detail: 'la contraseña nueva no puede ser igual a la actual',
    });
  }

  const hash = await hashearClave(propio.data.claveNueva);
  await cambiarClave(sesion.usuarioId, hash); // baja debe_cambiar_clave a false

  return json(200, { ok: true });
}
