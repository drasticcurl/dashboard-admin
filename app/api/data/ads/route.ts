/**
 * GET /api/data/ads — la tabla del gestor de anuncios (T17 §5), extendida por
 * gestion-campanas-anuncios (task 16.2): cascada, orden, paginación por página
 * y Metricas_Rango.
 *
 * - Lee `campaignIds`/`adsetIds` (Filtro_Cascada, hasta 50 cada una), `orderBy`/
 *   `orderDir`, `page`, `columnas` y `forzar`.
 * - `sinDatos=0` oculta las filas sin gasto y sin ventas en el período;
 *   `padreApagado=0` oculta los conjuntos y anuncios cuyo padre está apagado.
 *   Se leen como "=0" (apagar el mostrar) para que la ausencia signifique
 *   "mostrar todo", que es el comportamiento de siempre.
 * - Llama a `asegurarAlcance` SOLO si alguna columna visible es Metricas_Rango:
 *   si ninguna Vista las muestra, no se gasta una llamada a Meta (R7 c6).
 * - Resuelve la cuenta con la precedencia de R1 c12: `?account=` existente y
 *   activa, si no la imputada al funnel del navegador, si no la primera activa;
 *   y devuelve un aviso cuando el valor de `?account=` no se aplicó.
 * - `forzar` es el camino del Boton_Actualizar: pasa `{forzar: true,
 *   timeoutMs: 60_000}` a `ensureFreshAdSpend` (R1 c7) y es lo único que
 *   dispara `ensureFreshJerarquia`, con 30 s (R4.1, R4.8).
 *
 * EL ORDEN, QUE ES LO QUE ESTE ENDPOINT TIENE DE DELICADO (R5.1)
 * Sincronizar y DESPUÉS leer:
 *
 *   1. zona de la cuenta + rango del período  (rangoDePeriodo)
 *   2. ensureFreshAdSpend  ┐ en paralelo
 *      ensureFreshJerarquia┘ (sólo con `forzar`)
 *   3. asegurarAlcance (sólo si alguna columna lo pide)
 *   4. getMetricasAds
 *   5. respuesta
 *
 * Estuvo al revés —leer y después sincronizar— y el síntoma era el que se
 * reportó: apretar Actualizar devolvía los mismos números, y lo que el sync
 * traía recién aparecía en el pedido SIGUIENTE.
 *
 * Guard de auth como todos los /api/data/* (plan §9): sin cookie → 401.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { q, q1 } from '@/lib/db';
import { getMetricasAds, rangoDePeriodo } from '@/lib/queries/ads';
import { ensureFreshAdSpend } from '@/lib/ads/live';
import { ensureFreshJerarquia } from '@/lib/ads/liveJerarquia';
import { asegurarAlcance } from '@/lib/ads/alcance';
import { TZ_DEFAULT } from '@/lib/ads/zona';
import { today } from '@/lib/day';
import { esClaveOrden } from '@/lib/ads/orden';
import { entrada } from '@/lib/ads/catalogo';
import type { NivelAds, PeriodoAds, ResultadoMetricas } from '@/lib/ads/tipos';

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
    //
    // EL CUERPO VA ANOTADO COMO `ResultadoMetricas` A PROPÓSITO (task 17.2).
    // Este corte era un literal suelto y se le fueron quedando campos afuera:
    // `rango`, `generatedAt` y —desde la task 17.1— `totales`. El cliente hace
    // `setData({ ...body })` en `aplicarRespuesta`, así que en este camino
    // quedaban en `undefined` tres campos que el tipo declara obligatorios, y
    // `data.totales.spendEur` habría tirado en runtime con el tipo diciendo que
    // no podía pasar. Con la anotación, el próximo campo que se agregue a
    // `ResultadoMetricas` rompe acá en `tsc` y no en pantalla.
    //
    // `rango` se resuelve con la MISMA función que usa la lectura, en la zona
    // por defecto: sin cuentas no hay zona de cuenta, y es un pedido por
    // pantalla en un panel sin publicidad configurada, no un camino caliente.
    const rangoVacio = await rangoDePeriodo(period, TZ_DEFAULT);
    const vacio: ResultadoMetricas = {
      filas: [],
      hayMas: false,
      sinAtribuir: { sales: 0, revenueEur: 0 },
      rango: { from: rangoVacio.desde, to: rangoVacio.hasta, timezone: TZ_DEFAULT },
      generatedAt: new Date().toISOString(),
      total: 0,
      pagina: 1,
      totalPaginas: 0,
      orden: { clave: 'gastos', dir: 'desc' },
      alcanceError: null,
      // Los seis en cero, que es el mismo criterio que `totalesDesdeRow` aplica
      // a un filtro sin filas: un total de 0 es un total real, no un hueco.
      totales: { spendEur: 0, revenueEur: 0, netEur: 0, profitEur: 0, sales: 0, filas: 0 },
    };
    return json(200, {
      ok: true,
      sinCuentas: true,
      aviso: 'no hay cuentas publicitarias activas',
      ...vacio,
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

  /** El Boton_Actualizar. El polling automático NO lo manda. */
  const forzar = sp.get('forzar') !== null;

  // ── 1. La zona de la cuenta y el rango del período, antes que nada más. ──
  //
  // ES LO QUE PERMITE SINCRONIZAR ANTES DE LEER (R5.1). El orden estuvo
  // invertido por una dependencia concreta: `ensureFreshAdSpend` necesita el
  // último día del rango y el día de hoy resueltos en la zona de la cuenta, y
  // esos dos salían de `data.rango`, o sea del resultado de la lectura. Con la
  // lectura primero, la respuesta se armaba siempre con la foto anterior.
  //
  // `rangoDePeriodo` es una función independiente que resuelve el rango con el
  // MISMO SQL que usa `getMetricasAds` adentro, así que izarla corta la
  // dependencia sin cambiar qué rango se mira.
  //
  // El `COALESCE(timezone, TZ_DEFAULT)` es el mismo que aplica `getMetricasAds`,
  // y `TZ_DEFAULT` se importa en lugar de repetir el literal: si los dos
  // defaults se separan, el sync y la lectura miran días distintos para una
  // cuenta con `timezone` en NULL.
  const tzRow = await q1<{ tz: string }>(
    `SELECT COALESCE(timezone, $2) AS tz FROM ad_accounts WHERE account_id = $1`,
    [accountId, TZ_DEFAULT],
  );
  const tz = tzRow?.tz ?? TZ_DEFAULT;
  const [rango, hoy] = await Promise.all([rangoDePeriodo(period, tz), today(tz)]);

  // ── 2. Los dos sync, en paralelo, ANTES de leer (R5.1). ──
  //
  // En paralelo porque son independientes: uno escribe `ad_spend` y el otro la
  // Jerarquía. En serie sólo se sumarían las dos esperas.
  //
  // Ninguno de los dos puede tirar: los dos tienen TTL, timeout y el catch
  // adentro (lib/ads/live.ts, lib/ads/liveJerarquia.ts). Si el presupuesto de
  // espera se agota, vuelven con lo último guardado y el sync sigue de fondo, y
  // eso viaja en `refreshed`/`error` de cada frescura en lugar de bloquear la
  // pantalla (R5.2).
  //
  // La Jerarquía se dispara SÓLO con `forzar` (R4.8): es una llamada por cuenta
  // y por nivel, y engancharla al polling la multiplicaría por pestaña abierta.
  // Sin `forzar` el campo viaja en `null` —la barra muestra la edad guardada, que
  // es la que mantiene el cron de 15 minutos— y no un objeto que sugeriría que
  // este pedido fue a Meta.
  const [adsFreshness, jerarquiaFreshness] = await Promise.all([
    forzar
      ? ensureFreshAdSpend(rango.hasta, hoy, { forzar: true, timeoutMs: 60_000 })
      : ensureFreshAdSpend(rango.hasta, hoy),
    // El `&& accountId` es el mismo chequeo defensivo que usa la rama del
    // alcance: después del corte por `cuentas.length === 0` la precedencia
    // siempre dejó una cuenta, así que no es un caso real.
    forzar && accountId ? ensureFreshJerarquia(accountId, { forzar: true, timeoutMs: 30_000 }) : null,
  ]);

  // ── 3. Metricas_Rango: asegurar el alcance, y sólo si alguna columna visible
  // es de rango (R7 c6). Va después de los sync y antes de la lectura: la
  // lectura exige igualdad EXACTA del rango, así que la fila de alcance de este
  // `rango` tiene que estar escrita antes del SELECT. ──
  let alcanceError: string | null = null;
  const pideAlcance = columnas.some((c) => entrada(c)?.rango);
  if (pideAlcance && accountId) {
    const r = await asegurarAlcance(accountId, level, rango.desde, rango.hasta);
    if (r.error) alcanceError = r.error;
  }

  // ── 4. La lectura, que ahora sí ve lo que los sync de arriba escribieron. ──
  //
  // `getMetricasAds` vuelve a resolver el rango adentro, con la misma
  // `rangoDePeriodo` y la misma zona, así que devuelve el mismo `rango` que se
  // usó recién. Es una consulta de fechas repetida y es a propósito: pasarle el
  // rango ya resuelto cambiaría su firma, y `rango` de la respuesta sigue siendo
  // el que la lectura usó de verdad.
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
      ocultarSinDatos: sp.get('sinDatos') === '0',
      ocultarPadreApagado: sp.get('padreApagado') === '0',
      orderBy,
      orderDir,
      page,
      columnas: columnas.filter(esClaveOrden),
      limit: Number(sp.get('limit') ?? '500') || undefined,
      after: sp.get('after') ?? undefined,
    });
  } catch (e) {
    // El error que este 422 vino a cubrir es `zonas horarias mezcladas`, y con
    // `accountIds` de un solo elemento ya no debería alcanzarse: la lectura ve
    // una cuenta, o sea una zona. El catch se queda igual porque cualquier otro
    // fallo de la lectura tiene que salir como un mensaje que la UI muestra, no
    // como un 500 que parece un bug.
    return json(422, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }

  // Los dos topes de D-A9c, para que el campo de presupuesto tenga su `max`, y
  // el umbral de Frescura_Objeto (025), para que la tabla sepa a partir de
  // cuántos segundos una fila está vieja. Los tres en la misma vuelta: son tres
  // subselects de `settings`, no hay razón para tres viajes.
  const topes = await q1<{ max: unknown; delta: unknown; umbral: unknown }>(
    `SELECT (SELECT value FROM settings WHERE key = 'ads_max_daily_budget_eur') AS "max",
            (SELECT value FROM settings WHERE key = 'ads_max_delta_por_tick_eur') AS "delta",
            (SELECT value FROM settings WHERE key = 'ads_frescura_umbral_segundos') AS "umbral"`,
  );

  return json(200, {
    ok: true,
    ...data,
    adsFreshness,
    // `null` cuando el pedido no vino con `forzar`: no hubo Sync_Jerarquia en
    // este pedido, y la barra tiene que poder distinguir eso de una que corrió
    // (R4.5, R4.8).
    jerarquiaFreshness,
    maxDailyBudgetEur: typeof topes?.max === 'number' ? (topes.max as number) : 200,
    maxDeltaPorTickEur: typeof topes?.delta === 'number' ? (topes.delta as number) : 300,
    // `settings.value` es jsonb y puede tener cualquier cosa: si no es un número
    // se cae al mismo 900 que seedeó la 025, no a un `NaN` que dejaría a toda la
    // tabla marcada como vieja.
    frescuraUmbralSegundos: typeof topes?.umbral === 'number' ? (topes.umbral as number) : 900,
    alcanceError,
    avisoCuenta,
  });
}
