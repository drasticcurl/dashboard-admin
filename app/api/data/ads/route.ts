/**
 * GET /api/data/ads — la tabla del gestor de anuncios (T17 §5).
 *
 * Devuelve las filas de `getMetricasAds` (gasto + ventas por campaña/conjunto/
 * anuncio) más la frescura del gasto y los dos topes monetarios (D-A9c) que la
 * UI usa para el campo de presupuesto. La respuesta viene ACOTADA (`limit`
 * default 500, máx 1000) y trae `hayMas`: una tabla truncada en silencio es
 * peor que una larga, porque el usuario busca un anuncio y concluye que no
 * existe.
 *
 * Guard de auth como todos los /api/data/* (plan §9): sin cookie → 401.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { q1 } from '@/lib/db';
import { getMetricasAds } from '@/lib/queries/ads';
import { ensureFreshAdSpend } from '@/lib/ads/live';
import { today } from '@/lib/day';
import type { NivelAds, PeriodoAds } from '@/lib/ads/tipos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

const NIVELES: NivelAds[] = ['campaign', 'adset', 'ad'];
const PERIODOS: PeriodoAds[] = ['today', 'yesterday', '7d', '7d_excl_today'];
const ESTADOS = ['active', 'paused', 'any'] as const;

export async function GET(req: NextRequest): Promise<Response> {
  if (!isAuthenticated(req.cookies)) {
    return json(401, { ok: false, error: 'unauthorized' });
  }

  const sp = req.nextUrl.searchParams;

  // Es una pantalla, no una API pública: un query string editado a mano no
  // tiene que dejarla en blanco, así que los valores inválidos caen al default
  // en lugar de devolver 400.
  const level = (NIVELES.includes(sp.get('level') as NivelAds) ? sp.get('level') : 'campaign') as NivelAds;
  const period = (PERIODOS.includes(sp.get('period') as PeriodoAds) ? sp.get('period') : 'today') as PeriodoAds;
  const status = (ESTADOS.includes(sp.get('status') as (typeof ESTADOS)[number])
    ? sp.get('status')
    : 'any') as 'active' | 'paused' | 'any';

  let accountId = sp.get('account') ?? undefined;

  // Sin `?account=`, se usa la PRIMERA cuenta activa: con las dos cuentas del
  // usuario en zonas distintas (P-A03), pedir "todas" tira `zonas_horarias_
  // mezcladas`, y la pantalla tiene que abrir mostrando algo, no un error.
  if (!accountId) {
    const primera = await q1<{ accountId: string }>(
      `SELECT account_id AS "accountId" FROM ad_accounts
        WHERE active AND platform = 'meta' ORDER BY account_id LIMIT 1`,
    );
    accountId = primera?.accountId;
  }

  // Una sola cuenta: una sola zona horaria (§4 punto 2). accountIds vacío
  // significaría "todas" y con zonas mezcladas tira, así que se evita.
  const accountIds = accountId ? [accountId] : undefined;

  let data;
  try {
    data = await getMetricasAds({
      level,
      period,
      accountIds,
      status,
      nombre: sp.get('nombre') ?? undefined,
      campaignId: sp.get('campaignId') ?? undefined,
      adsetId: sp.get('adsetId') ?? undefined,
      limit: Number(sp.get('limit') ?? '500') || undefined,
      after: sp.get('after') ?? undefined,
    });
  } catch (e) {
    // El caso más común es `zonas_horarias_mezcladas`: se devuelve el error y la
    // UI lo muestra, no un 500 que parece un bug.
    return json(422, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }

  // El gasto de hoy se refresca antes de leer, igual que /api/data/sales. Tiene
  // TTL, timeout y no puede tirar (lib/ads/live.ts), así que en el peor caso la
  // pantalla sale con lo último guardado.
  const hoy = await today(data.rango.timezone);
  const adsFreshness = await ensureFreshAdSpend(data.rango.to, hoy);

  // Los dos topes de D-A9c, para que el campo de presupuesto tenga su `max`.
  // `settings.value` es jsonb: pg lo devuelve parseado (número, booleano o
  // string), así que se lee el valor crudo y no `::text` (un jsonb no tiene
  // `max()`).
  const topes = await q1<{ max: unknown; delta: unknown }>(
    `SELECT (SELECT value FROM settings WHERE key = 'ads_max_daily_budget_eur') AS "max",
            (SELECT value FROM settings WHERE key = 'ads_max_delta_por_tick_eur') AS "delta"`,
  );

  return json(200, {
    ok: true,
    ...data,
    adsFreshness,
    maxDailyBudgetEur: typeof topes?.max === 'number' ? (topes.max as number) : 200,
    maxDeltaPorTickEur: typeof topes?.delta === 'number' ? (topes.delta as number) : 300,
  });
}
