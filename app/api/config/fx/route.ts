/**
 * /api/config/fx (task T09 §B.4) — las cotizaciones y la vía de escape de
 * D13.
 *
 * GET  → las últimas 20 filas de fx_rates, con la columna "pesos por euro"
 *        calculada (1/rate), que es como se lee: la base guarda 1 ARS en
 *        EUR (0,0005785…), inútil para el ojo humano.
 * POST → carga manual de un día ({ day, arsPerEuro }): el usuario piensa en
 *        pesos por euro, así que el route recibe eso y guarda rate = 1/valor
 *        con source='manual'. El ON CONFLICT pisa la fila del cron para ese
 *        día, que es el caso de uso: querer usar blue o una cotización
 *        propia (D13).
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { q } from '@/lib/db';
import { MONEDA_REPORTE } from '@/lib/moneda-reporte';
import { guard, json, listFxRates, parseJson } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const postSchema = z.object({
  day: z.string().regex(DATE_RE),
  arsPerEuro: z.number().positive().max(100_000),
});

export async function GET() {
  const rates = await listFxRates(20);
  return json(200, { ok: true, rates });
}

export async function POST(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return denied;

  const raw = await parseJson(req);
  const parsed = postSchema.safeParse(raw);
  if (!parsed.success) {
    return json(400, { ok: false, error: 'invalid_payload', detail: parsed.error.issues[0]?.message });
  }
  const { day, arsPerEuro } = parsed.data;

  // 1 ARS = (1 / arsPerEuro) unidades de la moneda de reporte, con 10 decimales
  // como el resto de la tabla. El nombre del campo sigue siendo `arsPerEuro`
  // porque es el contrato del endpoint y lo manda la UI; lo que significa es
  // "pesos por unidad de la moneda de reporte".
  const rate = 1 / arsPerEuro;
  const res = await q(
    `INSERT INTO fx_rates (day, base, quote, rate, source, fetched_at)
     VALUES ($1::date, 'ARS', $3, $2::numeric, 'manual', now())
     ON CONFLICT (day, base, quote)
     DO UPDATE SET rate = EXCLUDED.rate, source = 'manual', fetched_at = now()
     RETURNING day::text AS day, rate::text AS rate, source`,
    [day, rate.toFixed(10), MONEDA_REPORTE],
  );
  return json(200, { ok: true, rate: res[0] });
}
