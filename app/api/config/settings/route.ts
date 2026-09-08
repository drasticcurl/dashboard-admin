/**
 * /api/config/settings (task T09 §B.4) — los settings del panel (plan §3.10).
 *
 * GET   → fx_source, default_currency_view, retention_days_events.
 * PATCH → actualiza los que vengan en el body, en tres upserts.
 *
 * fx_source lleva la advertencia de P-01: el default del plan es `oficial`,
 * y cambiarlo a `blue` cambia las conversiones de las ventas NUEVAS — las
 * viejas ya tienen su cotización congelada en la fila (D12).
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getSettingsRecord, guard, json, parseJson, setSetting } from '../_lib';
import { MONEDA_REPORTE } from '@/lib/moneda-reporte';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  fxSource: z.enum(['oficial', 'blue']).optional(),
  // Acepta la moneda de reporte de ESTA instancia o 'ARS' (que significa
  // "mostrar la moneda de venta del funnel"). Antes era un enum fijo
  // ['EUR','ARS'], que en una instancia que consolida en dólares rechazaba el
  // único valor válido.
  defaultCurrencyView: z.enum([MONEDA_REPORTE, 'ARS']).optional(),
  retentionDaysEvents: z.number().int().min(1).max(3650).optional(),
});

export async function GET(req: NextRequest) {
  // Antes de este módulo de permisos, este GET no llamaba a guard() (a
  // diferencia de su propio PATCH, dos líneas más abajo): cualquiera con la
  // cookie vieja de "autenticado sin identidad" lo veía, y con permisos por
  // sección eso pasa a ser cualquiera CON SESIÓN, sin importar si tiene
  // 'config'. Es exactamente el bug silencioso que D5 existe para evitar,
  // sólo que en la dirección "ver de más" en vez de "romper una pantalla
  // ajena". Se descubrió corriendo el checklist de T03 (curl con la cookie
  // de un usuario sin 'config': daba 200 en vez de 403).
  const denied = await guard(req);
  if (denied) return denied;

  const settings = await getSettingsRecord();
  return json(200, { ok: true, settings });
}

export async function PATCH(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return denied;

  const raw = await parseJson(req);
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) {
    return json(400, { ok: false, error: 'invalid_payload', detail: parsed.error.issues[0]?.message });
  }

  const { fxSource, defaultCurrencyView, retentionDaysEvents } = parsed.data;
  if (fxSource !== undefined) await setSetting('fx_source', fxSource);
  if (defaultCurrencyView !== undefined) await setSetting('default_currency_view', defaultCurrencyView);
  if (retentionDaysEvents !== undefined) await setSetting('retention_days_events', retentionDaysEvents);

  const settings = await getSettingsRecord();
  return json(200, { ok: true, settings });
}
