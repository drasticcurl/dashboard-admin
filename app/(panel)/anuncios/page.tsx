/**
 * /anuncios — el gestor de campañas, conjuntos y anuncios (T17 §1), ahora
 * Gestor_Anuncios (gestion-campanas-anuncios, task 20.4).
 *
 * Server component: lee las cuentas activas, resuelve los filtros del query
 * string (con default a la primera cuenta activa para no disparar `zonas_horarias
 * mezcladas`, P-A03) y hace el fetch inicial acá para que la primera pintura ya
 * tenga datos. Los cambios de filtro los maneja GestorAnuncios en el client.
 *
 * La cuenta sigue la precedencia de R1 c12:
 *   ?account= explícito → esa cuenta (si existe y está activa; si no, aviso)
 *   si no, ?f= del Nav  → la cuenta imputada a ese funnel
 *   si no               → la primera cuenta activa
 *
 * La Vista_Por_Defecto se lee acá y llega como prop en el PRIMER render, así se
 * aplica en 2 segundos o menos sin salto visual entre las doce columnas base y
 * la Vista (R3 c8). El nivel por defecto es «Campañas» (R1 c13).
 */

import { q, q1 } from '@/lib/db';
import { getMetricasAds } from '@/lib/queries/ads';
import { ensureFreshAdSpend } from '@/lib/ads/live';
import { today } from '@/lib/day';
import type { NivelAds, PeriodoAds } from '@/lib/ads/tipos';
import { parseRepoVistas } from '@/lib/ads/vistas';
import type { Vista } from '@/lib/ads/vistas';
import { EmptyState } from '@/components/ui';
import { GestorAnuncios } from './GestorAnuncios';

export const dynamic = 'force-dynamic';

type SearchParams = { [key: string]: string | string[] | undefined };

function single(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function lista(v: string | string[] | undefined): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v;
  return [];
}

const NIVELES: NivelAds[] = ['campaign', 'adset', 'ad'];
const PERIODOS: PeriodoAds[] = ['today', 'yesterday', '7d', '7d_excl_today'];
const MAX_CASCADA = 50;

export type CuentaAds = {
  accountId: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
  /** El funnel al que se le imputa el gasto (`ad_accounts.funnel_id`). */
  funnelSlug: string | null;
  funnelName: string | null;
};

const LIMPIAR_IDS = (ids: string[]): string[] => {
  const vistos = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (out.length >= MAX_CASCADA) break;
    if (!/^\d{1,20}$/.test(id) || vistos.has(id)) continue;
    vistos.add(id);
    out.push(id);
  }
  return out;
};

export default async function AnunciosPage({ searchParams }: { searchParams: SearchParams }) {
  const cuentas = await q<CuentaAds>(
    `SELECT a.account_id AS "accountId", a.name, a.currency, a.timezone,
            f.slug AS "funnelSlug", f.name AS "funnelName"
       FROM ad_accounts a
       LEFT JOIN funnels f ON f.id = a.funnel_id
      WHERE a.active AND a.platform = 'meta'
      ORDER BY a.account_id`,
  );

  const nivel = (NIVELES.includes(single(searchParams.level) as NivelAds)
    ? (single(searchParams.level) as NivelAds)
    : 'campaign') as NivelAds;
  const period = (PERIODOS.includes(single(searchParams.period) as PeriodoAds)
    ? (single(searchParams.period) as PeriodoAds)
    : 'today') as PeriodoAds;
  const status = (['active', 'paused', 'any'].includes(single(searchParams.status) ?? '')
    ? (single(searchParams.status) as 'active' | 'paused' | 'any')
    : 'any') as 'active' | 'paused' | 'any';

  // ── La cuenta vigente, con la precedencia de R1 c12 ──
  const funnelSlug = single(searchParams.f);
  const cuentaDelFunnel = funnelSlug ? cuentas.find((c) => c.funnelSlug === funnelSlug) : undefined;
  const accountPedida = single(searchParams.account);
  let avisoCuenta: string | null = null;
  let account: string | undefined;
  if (accountPedida !== undefined) {
    if (cuentas.some((c) => c.accountId === accountPedida)) {
      account = accountPedida;
    } else {
      avisoCuenta = `el valor de ?account=${accountPedida} no se aplicó (no existe o no está activa)`;
    }
  }
  if (account === undefined) account = cuentaDelFunnel?.accountId;
  if (account === undefined) account = cuentas[0]?.accountId;

  const cuentaActual = cuentas.find((c) => c.accountId === account) ?? cuentas[0];
  const desalineada =
    funnelSlug !== undefined && cuentaActual && cuentaActual.funnelSlug !== funnelSlug
      ? { funnelSlug, cuentaFunnel: cuentaActual.funnelName }
      : null;

  const nombre = single(searchParams.nombre);

  // ── Filtro_Cascada de la URL (R8 c7, c13): la tabla abre ya filtrada ──
  const campaignIds = nivel === 'adset' || nivel === 'ad' ? LIMPIAR_IDS(lista(searchParams.campaignIds)) : [];
  const adsetIds = nivel === 'ad' ? LIMPIAR_IDS(lista(searchParams.adsetIds)) : [];

  let data;
  try {
    data = await getMetricasAds({
      level: nivel,
      period,
      accountIds: account ? [account] : undefined,
      status,
      nombre,
      campaignIds: campaignIds.length > 0 ? campaignIds : undefined,
      adsetIds: adsetIds.length > 0 ? adsetIds : undefined,
    });
  } catch (e) {
    return (
      <EmptyState
        title="No se pudo cargar la tabla"
        hint={e instanceof Error ? e.message : String(e)}
      />
    );
  }

  const hoy = await today(data.rango.timezone);
  const adsFreshness = await ensureFreshAdSpend(data.rango.to, hoy);

  // ── La Vista_Por_Defecto, para el primer render (R3 c8) ──
  let vistaPorDefecto: Vista | null = null;
  const repoRow = await q1<{ value: unknown }>(
    `SELECT value FROM settings WHERE key = 'ads_vistas'`,
  );
  if (repoRow && repoRow.value !== null) {
    const repo = parseRepoVistas(repoRow.value);
    if (repo?.porDefecto) {
      vistaPorDefecto = repo.vistas.find((v) => v.id === repo.porDefecto) ?? null;
    }
  }

  // ── Nombres de los ids de la cascada, para el ChipCascada (R8 c4) ──
  const idsCascada = nivel === 'adset' || nivel === 'ad' ? campaignIds : [];
  const nombresCascada: Record<string, string> = {};
  if (idsCascada.length > 0) {
    const filas = await q<{ id: string; name: string | null }>(
      `SELECT campaign_id AS id, name FROM ad_campaigns WHERE campaign_id = ANY($1::text[])`,
      [idsCascada],
    );
    for (const f of filas) if (f.name) nombresCascada[f.id] = f.name;
  }

  return (
    <GestorAnuncios
      cuentas={cuentas}
      initialData={data}
      adsFreshness={adsFreshness}
      nivelInicial={nivel}
      filtrosIniciales={{
        period,
        status,
        account: account ?? '',
        nombre,
        campaignIds,
        adsetIds,
      }}
      vistaPorDefecto={vistaPorDefecto}
      desalineada={desalineada}
      nombresCascada={nombresCascada}
      avisoCuentaInicial={avisoCuenta}
    />
  );
}
