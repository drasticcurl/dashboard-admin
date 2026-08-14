/**
 * /api/config/ui-layout (task T03) — el layout de widgets de Resumen y Ventas.
 *
 * GET  ?pantalla=resumen|ventas → { ok, layout: WidgetLayout | null }.
 * POST { pantalla, layout }     → valida con zod, guarda en settings y
 *                                 devuelve lo guardado.
 *
 * Dos decisiones que no se pueden relajar:
 * - El mapeo pantalla→clave es CERRADO (z.enum → LAYOUT_KEY). Con una
 *   interpolación `ui_layout_${pantalla}` este endpoint se vuelve un escritor
 *   arbitrario de la tabla de configuración.
 * - `guard(req)` va ANTES de leer el body: sin cookie válida devuelve 401 y
 *   no escribe nada (§9.12 del plan).
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { q1 } from '@/lib/db';
import { widgetLayoutSchema } from '@/lib/widgets/layout';
import type { WidgetLayout } from '@/lib/widgets/tipos';
import { guard, json, parseJson, setSetting } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const pantallaSchema = z.enum(['resumen', 'ventas']);

/** Mapeo cerrado de pantalla a fila de settings. Son dos filas (D-R04):
 *  guardar Resumen no puede pisar Ventas. */
const LAYOUT_KEY: Record<z.infer<typeof pantallaSchema>, string> = {
  resumen: 'ui_layout_resumen',
  ventas: 'ui_layout_ventas',
};

const postSchema = z.object({
  pantalla: pantallaSchema,
  layout: widgetLayoutSchema,
});

export async function GET(req: NextRequest) {
  const pantalla = pantallaSchema.safeParse(req.nextUrl.searchParams.get('pantalla'));
  if (!pantalla.success) {
    return json(400, { ok: false, error: 'invalid_payload', detail: pantalla.error.issues[0]?.message });
  }

  // Lectura propia y no getSettingsRecord(): la whitelist de _lib.ts no
  // incluye los layouts (task §3 punto 2).
  const row = await q1<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [
    LAYOUT_KEY[pantalla.data],
  ]);
  const layout: WidgetLayout | null = row === null || row.value === null ? null : (row.value as WidgetLayout);
  return json(200, { ok: true, layout });
}

export async function POST(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return denied;

  const raw = await parseJson(req);
  const parsed = postSchema.safeParse(raw);
  if (!parsed.success) {
    return json(400, { ok: false, error: 'invalid_payload', detail: parsed.error.issues[0]?.message });
  }

  const { pantalla, layout } = parsed.data;
  await setSetting(LAYOUT_KEY[pantalla], layout);

  return json(200, { ok: true, layout });
}
