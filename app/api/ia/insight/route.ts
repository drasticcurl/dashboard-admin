/**
 * POST /api/ia/insight — genera (o devuelve de la caché) el análisis con IA.
 *
 * ─── ES LA UNICA RUTA DEL PANEL QUE GASTA PLATA ────────────────────────────
 * Por eso tiene tres cosas que las otras no necesitan:
 *
 *   1. `guard(req)` como todas las de escritura, pero acá el 401 no protege
 *      datos: protege crédito. Una sesión filtrada con esto abierto es una
 *      factura.
 *   2. Es POST y no GET. No es cosmético: un GET lo puede disparar un prefetch
 *      del browser, un crawler o un `<link rel=prefetch>`, y cada disparo sería
 *      una llamada paga. El pedido tiene que ser una acción deliberada.
 *   3. El techo diario de `lib/ia/insights.ts`, que contesta 429.
 *
 * La caché por huella vive en `generarInsight`: si los números no cambiaron
 * devuelve la fila que ya estaba sin llamar a OpenAI. Apretar el botón diez veces
 * sobre los mismos datos cuesta una sola llamada.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { guard, json } from '@/app/api/config/_lib';
import { resolveRange, type RangePreset } from '@/lib/day';
import { today } from '@/lib/day';
import { getOverviewData } from '@/lib/queries/overview';
import { getFinanceOverview, listMovements, listScheduledPayments } from '@/lib/queries/finance';
import { getSaldoOverview, serieDiaria } from '@/lib/queries/saldo';
import { reconciliarMeses } from '@/lib/queries/reconciliacion';
import { armarBriefResumen, INSTRUCCIONES_RESUMEN } from '@/lib/ia/brief-resumen';
import { armarBriefFinanzas, INSTRUCCIONES_FINANZAS } from '@/lib/ia/brief-finanzas';
import { generarInsight, LimiteIaError } from '@/lib/ia/insights';
import { hayIa, IaError } from '@/lib/ia/openai';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Los mismos meses que el cron: 6 alcanza para ver si un hueco se acumula. */
const MESES_FINANZAS = 6;

const PRESETS = ['today', 'yesterday', '7d', '14d', '30d', 'mtd', 'all'] as const;
const DIA = /^\d{4}-\d{2}-\d{2}$/;

const Query = z.object({
  ambito: z.enum(['resumen', 'finanzas']),
  range: z.enum(PRESETS).optional(),
  from: z.string().regex(DIA).optional(),
  to: z.string().regex(DIA).optional(),
});

export async function POST(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return denied;

  // 503 y no 500: no está roto, está apagado. Es una instancia sin la key, que es
  // un estado válido y esperado (ver .env.example).
  if (!hayIa()) {
    return json(503, { ok: false, error: 'ia_apagada' });
  }

  const parsed = Query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return json(400, { ok: false, error: 'invalid_payload', detail: parsed.error.message });
  }
  const { ambito } = parsed.data;

  const tz = process.env.DASHBOARD_TZ ?? 'America/Argentina/Buenos_Aires';

  try {
    const insight =
      ambito === 'resumen'
        ? await deResumen(parsed.data, tz)
        : await deFinanzas(tz);

    return json(200, { ok: true, insight });
  } catch (err) {
    if (err instanceof LimiteIaError) {
      // 429 con el detalle: el componente muestra el mensaje traducido, pero el
      // detalle sirve en la consola cuando alguien pregunta por qué no genera.
      return json(429, { ok: false, error: 'limite_diario', detail: err.message });
    }
    if (err instanceof IaError) {
      // El timeout se distingue porque es el único que vale reintentar tal cual.
      if (err.causa === 'timeout') {
        return json(504, { ok: false, error: 'timeout', detail: err.message });
      }
      // 502: el que falló es OpenAI, no este panel. Con un 500 el usuario busca
      // el problema del lado equivocado.
      return json(502, { ok: false, error: 'openai_fallo', detail: err.message });
    }
    console.error('[api/ia/insight] falló:', err instanceof Error ? err.message : err);
    return json(500, { ok: false, error: 'error_interno' });
  }
}

async function deResumen(qs: z.infer<typeof Query>, tz: string) {
  // El rango se resuelve igual que en /api/data/overview: from+to explícitos
  // ganan, si no el preset, y por defecto 'today'.
  const rango =
    qs.from && qs.to
      ? { from: qs.from, to: qs.to }
      : await resolveRange((qs.range ?? 'today') as RangePreset, tz);

  // Se llama a getOverviewData y NO a ensureFreshAdSpend: el gasto de hoy lo
  // refresca el render de la pantalla, que ya corrió antes de que el usuario
  // pudiera apretar el botón. Pedirlo otra vez es una llamada a Meta de más.
  const data = await getOverviewData(rango);

  return generarInsight({
    ambito: 'resumen',
    instrucciones: INSTRUCCIONES_RESUMEN,
    brief: armarBriefResumen(data, rango),
    rango: { desde: rango.from, hasta: rango.to },
    origen: 'manual',
  });
}

async function deFinanzas(tz: string) {
  const hoy = await today(tz);

  const [reconciliacion, saldo, overview, movimientos, programados] = await Promise.all([
    reconciliarMeses(MESES_FINANZAS),
    getSaldoOverview(),
    getFinanceOverview(),
    listMovements({}),
    listScheduledPayments(),
  ]);
  const serieDelMes = await serieDiaria(hoy.slice(0, 7));

  const brief = armarBriefFinanzas({
    hoy,
    reconciliacion,
    ultimoPatrimonio: saldo.ultimo,
    faltanCargarHoy: overview.faltanCargarHoy,
    serieDelMes,
    movimientos,
    atrasados: programados.filter((p) => p.atrasado),
  });

  const desde = reconciliacion.length ? `${reconciliacion[0]!.month}-01` : hoy;

  return generarInsight({
    ambito: 'finanzas',
    instrucciones: INSTRUCCIONES_FINANZAS,
    brief,
    rango: { desde, hasta: hoy },
    origen: 'manual',
  });
}
