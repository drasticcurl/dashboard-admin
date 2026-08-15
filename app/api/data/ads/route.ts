/**
 * GET /api/data/ads — la tabla del gestor de anuncios (T17 §5), extendida por
 * gestion-campanas-anuncios (task 16.2): cascada, orden, paginación por página
 * y Metricas_Rango.
 *
 * - Lee `campaignIds`/`adsetIds` (Filtro_Cascada, hasta 50 cada una), `orderBy`/
 *   `orderDir`, `page`, `columnas` y `forzar`.
 * - Llama a `asegurarAlcance` SOLO si alguna columna visible es Metricas_Rango:
 *   si ninguna Vista las muestra, no se gasta una llamada a Meta (R7 c6).
 * - Resuelve la cuenta con la precedencia de R1 c12: `?account=` existente y
 *   activa, si no la imputada al funnel del navegador, si no la primera activa;
 *   y devuelve un aviso cuando el valor de `?account=` no se aplicó.
 * - `forzar` pasa `{forzar: true, timeoutMs: 60_000}` a `ensureFreshAdSpend`
 *   (R1 c7): es el camino del Boton_Actualizar.
 *
 * Guard de auth como todos los /api/data/* (plan §9): sin cookie → 401.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { q, q1 } from '@/lib/db';
import { getMetricasAds, rangoDePeriodo } from '@/lib/queries/ads';
import { ensureFreshAdSpend } from '@/lib/ads/live';
import { asegurarAlcance } from '@/lib/ads/alcance';
import { today } from '@/lib/day';
import { esClaveOrden } from '@/lib/ads/orden';
import { entrada } from '@/lib/ads/catalogo';
import type { NivelAds, PeriodoAds } from '@/lib/ads/tipos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

const NIVELES: NivelAds[] = ['campaign', 'adset', 'ad'];
const PERIODOS: PeriodoAds[] = ['today', 'yesterday', '7d', '7d_excl_today'];
const ESTADOS = ['active', 'paused', 'any'] as const;
const MAX_CASCADA = 50;

/** Una lista de ids del query string: dígitos de 1..20, sin repetidos, hasta 50. */
function listaIds(vals: string[]): string[] | undefined {
  const out: string[] = [];
  const vistos = new Set<string>();
  for (const v of vals) {
    if (out.length >= MAX_CASCADA) break;
    if (!/^\d{1,20}$/.test(v) || vistos.has(v)) continue;
    vistos.add(v);
    out.push(v);
  }
  return out.length > 0 ? out : undefined;
}

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

  // ── La cuenta vigente, con la precedencia de R1 c12. ──
  const cuentaPedida = sp.get('account') ?? undefined;
  const funnelSlug = sp.get('f') ?? undefined;

  const cuentas = await q<{ accountId: string; funnelSlug: string | null }>(
    `SELECT a.account_id AS "accountId", f.slug AS "funnelSlug"
       FROM ad_accounts a
       LEFT JOIN funnels f ON f.id = a.funnel_id
      WHERE a.active AND a.platform = 'meta'
      ORDER BY a.account_id`,
  );

  let accountId: string | undefined;
  let avisoCuenta: string | null = null;

  if (cuentaPedida !== undefined) {
    const valida = cuentas.some((c) => c.accountId === cuentaPedida);
    if (valida) {
      accountId = cuentaPedida;
    } else {
      // R1 c12: el valor de ?account= no identificó una cuenta activa: se
      // recurre a la regla siguiente y se avisa.
      avisoCuenta = `el valor de ?account=${cuentaPedida} no se aplicó (no existe o no está activa)`;
    }
  }
  if (accountId === undefined && funnelSlug !== undefined) {
    accountId = cuentas.find((c) => c.funnelSlug === funnelSlug)?.accountId;
  }
  if (accountId === undefined) {
    accountId = cuentas[0]?.accountId;
  }
  if (cuentas.length === 0) {
    // Sin cuentas activas: Tabs_Nivel y Barra_Filtros se muestran sin filas.
    return json(200, {
      ok: true,
      sinCuentas: true,
      aviso: 'no hay cuentas publicitarias activas',
      filas: [],
      hayMas: false,
      sinAtribuir: { sales: 0, revenueEur: 0 },
      total: 0,
      pagina: 1,
      totalPaginas: 0,
      orden: { clave: 'gastos', dir: 'desc' },
      alcanceError: null,
    });
  }

  // Una sola cuenta: una sola zona horaria (§4 punto 2). accountIds vacío
  // significaría "todas" y con zonas mezcladas tira, así que se evita.
  const accountIds = accountId ? [accountId] : undefined;

  const orderByRaw = sp.get('orderBy') ?? undefined;
  const orderBy = orderByRaw && esClaveOrden(orderByRaw) ? orderByRaw : undefined;
  const orderDir = sp.get('orderDir') === 'asc' ? 'asc' : 'desc';
  const pageRaw = Number(sp.get('page'));
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : undefined;

  const campaignIds = listaIds(sp.getAll('campaignIds'));
  const adsetIds = listaIds(sp.getAll('adsetIds'));

  // Las columnas visibles: sirven para NO pedir el alcance si nadie lo muestra.
  const columnas = (sp.get('columnas') ?? '').split(',').filter(Boolean);

  // ── Metricas_Rango: asegurar el alcance ANTES de leer, y sólo si alguna
  // columna visible es de rango (R7 c6). El rango se resuelve en la misma zona
  // que usa getMetricasAds. ──
  let alcanceError: string | null = null;
  const pideAlcance = columnas.some((c) => entrada(c)?.rango);
  if (pideAlcance && accountId) {
    const tzRow = await q1<{ tz: string }>(
      `SELECT COALESCE(timezone, 'Europe/Lisbon') AS tz FROM ad_accounts WHERE account_id = $1`,
      [accountId],
    );
    const rango = await rangoDePeriodo(period, tzRow?.tz ?? 'Europe/Lisbon');
    const r = await asegurarAlcance(accountId, level, rango.desde, rango.hasta);
    if (r.error) alcanceError = r.error;
  }

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
      campaignIds,
      adsetIds,
      orderBy,
      orderDir,
      page,
      columnas: columnas.filter(esClaveOrden),
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
  // pantalla sale con lo último guardado. `forzar` es el camino del
  // Boton_Actualizar (R1 c7): ignora el TTL y espera hasta 60 s.
  const hoy = await today(data.rango.timezone);
  const adsFreshness = sp.get('forzar') !== null
    ? await ensureFreshAdSpend(data.rango.to, hoy, { forzar: true, timeoutMs: 60_000 })
    : await ensureFreshAdSpend(data.rango.to, hoy);

  // Los dos topes de D-A9c, para que el campo de presupuesto tenga su `max`.
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
    alcanceError,
    avisoCuenta,
  });
}
