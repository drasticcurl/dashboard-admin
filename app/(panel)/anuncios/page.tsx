/**
 * /anuncios — el gestor de campañas, conjuntos y anuncios (T17 §1).
 *
 * Server component: lee las cuentas activas, resuelve los filtros del query
 * string (con default a la primera cuenta activa para no disparar `zonas_horarias
 * mezcladas`, P-A03) y hace el fetch inicial acá para que la primera pintura ya
 * tenga datos. Los cambios de filtro los maneja AnunciosView en el client, que
 * refetchea /api/data/ads sin recargar.
 *
 * El filtro sigue siendo POR CUENTA y nunca por funnel: una corrida pide una
 * sola cuenta porque dos cuentas en zonas distintas hacen tirar
 * `zonas_horarias_mezcladas` (P-A03). Pero el funnel del Nav sí decide QUÉ
 * cuenta se muestra por defecto, usando el mapeo `ad_accounts.funnel_id` que
 * se edita en Config → Publicidad:
 *
 *   ?account= explícito  →  esa cuenta (el usuario la eligió a mano)
 *   si no, ?f= del Nav   →  la cuenta imputada a ese funnel
 *   si no                →  la primera cuenta activa
 *
 * Antes el default era siempre `ORDER BY account_id LIMIT 1`, así que elegir un
 * funnel arriba te dejaba mirando la cuenta del otro sin ninguna señal de que
 * no se correspondían.
 */

import { q, q1 } from '@/lib/db';
import { getMetricasAds } from '@/lib/queries/ads';
import { ensureFreshAdSpend } from '@/lib/ads/live';
import { today } from '@/lib/day';
import type { NivelAds, PeriodoAds } from '@/lib/ads/tipos';
import { EmptyState } from '@/components/ui';
import { AnunciosView } from './AnunciosView';

export const dynamic = 'force-dynamic';

type SearchParams = { [key: string]: string | string[] | undefined };

function single(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

const NIVELES: NivelAds[] = ['campaign', 'adset', 'ad'];
const PERIODOS: PeriodoAds[] = ['today', 'yesterday', '7d', '7d_excl_today'];

export type CuentaAds = {
  accountId: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
  /** El funnel al que se le imputa el gasto (`ad_accounts.funnel_id`). */
  funnelSlug: string | null;
  funnelName: string | null;
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
  if (cuentas.length === 0) {
    return (
      <EmptyState
        title="No hay cuentas publicitarias configuradas"
        hint="Dalas de alta en Config → Publicidad."
      />
    );
  }

  const level = (NIVELES.includes(single(searchParams.level) as NivelAds)
    ? (single(searchParams.level) as NivelAds)
    : 'campaign') as NivelAds;
  const period = (PERIODOS.includes(single(searchParams.period) as PeriodoAds)
    ? (single(searchParams.period) as PeriodoAds)
    : 'today') as PeriodoAds;
  const status = (['active', 'paused', 'any'].includes(single(searchParams.status) ?? '')
    ? (single(searchParams.status) as 'active' | 'paused' | 'any')
    : 'any') as 'active' | 'paused' | 'any';
  // La cuenta sigue al funnel del Nav cuando no hay `?account=` explícito (ver
  // el encabezado). `?f=` trae el SLUG del funnel, que es lo que escribe el Nav.
  const funnelSlug = single(searchParams.f);
  const cuentaDelFunnel = funnelSlug
    ? cuentas.find((c) => c.funnelSlug === funnelSlug)
    : undefined;
  const accountPedida = single(searchParams.account);
  const account =
    accountPedida && cuentas.some((c) => c.accountId === accountPedida)
      ? accountPedida
      : (cuentaDelFunnel?.accountId ?? cuentas[0]!.accountId);

  // Para avisar en la UI cuando lo que se ve no es lo que el Nav dice. Pasa si
  // el funnel elegido no tiene cuenta imputada, o si el usuario fijó `?account=`
  // a mano y no coincide: sin el aviso, los números parecen del otro funnel.
  const cuentaActual = cuentas.find((c) => c.accountId === account) ?? cuentas[0]!;
  const desalineada =
    funnelSlug !== undefined && cuentaActual.funnelSlug !== funnelSlug
      ? { funnelSlug, cuentaFunnel: cuentaActual.funnelName }
      : null;
  const nombre = single(searchParams.nombre);
  const campaignId = single(searchParams.campaignId);
  const adsetId = single(searchParams.adsetId);
  // El cursor de paginación. Antes no se leía acá, así que la primera pintura
  // ignoraba el `?after=` de la URL y "Cargar más" no hacía nada.
  const after = single(searchParams.after);

  let data;
  try {
    data = await getMetricasAds({
      level,
      period,
      accountIds: [account],
      status,
      nombre,
      campaignId,
      adsetId,
      after,
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

  // El nombre del padre, para el breadcrumb al bajar de nivel (§8).
  let breadcrumb: { nivel: NivelAds; id: string; name: string | null } | null = null;
  if (level === 'adset' && campaignId) {
    breadcrumb = await q1<{ id: string; name: string | null }>(
      `SELECT campaign_id AS id, name FROM ad_campaigns WHERE campaign_id = $1`,
      [campaignId],
    ).then((r) => (r ? { nivel: 'campaign' as const, id: r.id, name: r.name } : null));
  } else if (level === 'ad' && adsetId) {
    breadcrumb = await q1<{ id: string; name: string | null }>(
      `SELECT adset_id AS id, name FROM ad_sets WHERE adset_id = $1`,
      [adsetId],
    ).then((r) => (r ? { nivel: 'adset' as const, id: r.id, name: r.name } : null));
  }

  return (
    <AnunciosView
      cuentas={cuentas}
      initialData={data}
      adsFreshness={adsFreshness}
      filtros={{ level, period, status, account, nombre, campaignId, adsetId, after }}
      breadcrumb={breadcrumb}
      desalineada={desalineada}
    />
  );
}
