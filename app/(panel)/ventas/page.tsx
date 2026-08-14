/**
 * /ventas — ventas de un funnel, o el cajón "sin atribuir" (task T07,
 * rediseñada en T06).
 *
 * Server component: resuelve el funnel del query string (fallback al primero,
 * como el Nav) o `f=__unattributed__` para el cajón de huérfanas, resuelve el
 * rango en la TZ correcta (la del funnel, o la del dashboard sin funnel, D19)
 * y hace el fetch inicial acá para que la primera pintura ya tenga datos. El
 * toggle EUR/ARS y las recargas los maneja VentasView en el client.
 *
 * La moneda inicial sale de `?cur=` si está, si no de
 * settings.default_currency_view, si no EUR (D-R14): se lee acá, en el server,
 * y se pasa como prop — el client no toca la base.
 *
 * El layout de widgets se lee acá (settings.ui_layout_ventas) y baja como
 * prop: un fetch desde el client dibujaría el layout por defecto y después
 * saltaría al del usuario. null = nunca guardaron → layout por defecto.
 */

import { getFunnelBySlug, listFunnels } from '@/lib/funnels';
import { resolveFunnelRange } from '@/lib/queries/funnel';
import {
  getDashboardTimezone,
  getDefaultCurrencyView,
  getSalesData,
  UNATTRIBUTED_FUNNEL,
} from '@/lib/queries/sales';
import type { SalesStatus } from '@/lib/queries/sales';
import { resolveRange, today } from '@/lib/day';
import { ensureFreshAdSpend } from '@/lib/ads/live';
import { q1 } from '@/lib/db';
import { EmptyState } from '@/components/ui';
import type { WidgetLayout } from '@/lib/widgets/tipos';
import { VentasView } from './VentasView';

export const dynamic = 'force-dynamic';

type SearchParams = { [key: string]: string | string[] | undefined };

function single(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export default async function VentasPage({ searchParams }: { searchParams: SearchParams }) {
  const slug = single(searchParams.f);
  const unattributed = slug === UNATTRIBUTED_FUNNEL;

  let funnel = unattributed ? null : slug ? await getFunnelBySlug(slug) : null;
  if (!funnel && !unattributed) {
    // Sin `?f=` o con un slug desconocido, el primer funnel activo: es el
    // mismo default del selector del Nav.
    const funnels = await listFunnels();
    funnel = funnels[0] ?? null;
  }
  if (!funnel && !unattributed) {
    return (
      <EmptyState
        title="No hay funnels configurados"
        hint="Corré las migraciones y el seed antes de usar el panel."
      />
    );
  }

  const timezone = funnel ? funnel.timezone : getDashboardTimezone();
  let range: { from: string; to: string };
  try {
    range = await resolveFunnelRange(
      {
        preset: single(searchParams.range),
        from: single(searchParams.from),
        to: single(searchParams.to),
      },
      timezone,
    );
  } catch {
    // Un from/to mal escrito no merece romper la pantalla: cae al preset por
    // defecto. El route sí devuelve 400; acá hay UI, no API.
    range = await resolveRange('today', timezone);
  }

  // El gasto de Meta se refresca ANTES de leer los totales: si el rango llega a
  // hoy, la tarjeta de Ads y el ROI tienen que mostrar lo que se gastó hasta
  // este minuto, igual que las ventas. Tiene TTL, timeout y no puede tirar (ver
  // lib/ads/live.ts), así que en el peor caso la pantalla sale con lo último
  // guardado y lo dice.
  const hoy = await today(timezone);
  const adsFreshness = await ensureFreshAdSpend(range.to, hoy);

  // Los filtros de la API viven en el query string (D-R14): la pantalla los
  // honra aunque hoy no tenga controles para setearlos (link compartible).
  const statusParam = single(searchParams.status);
  const status: SalesStatus =
    statusParam === 'approved' || statusParam === 'refunded' || statusParam === 'chargeback'
      ? statusParam
      : 'all';

  const data = await getSalesData({
    funnelId: funnel?.id ?? null,
    from: range.from,
    to: range.to,
    tier: single(searchParams.tier),
    utmCampaign: single(searchParams.campaign),
    utmSource: single(searchParams.source),
    status,
  });

  // ?cur= si está, si no el setting, si no EUR (T06 §5).
  const curParam = single(searchParams.cur);
  const defaultCurrency: 'EUR' | 'ARS' =
    curParam === 'EUR' || curParam === 'ARS' ? curParam : await getDefaultCurrencyView();

  // El layout guardado de la pantalla (D-R04). WidgetGrid normaliza y nunca
  // tira, así que lo que venga de la base se le pasa tal cual.
  const layoutRow = await q1<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [
    'ui_layout_ventas',
  ]);
  const layoutGuardado = (layoutRow?.value ?? null) as WidgetLayout | null;

  return (
    <VentasView
      funnel={funnel}
      initialData={data}
      defaultCurrency={defaultCurrency}
      adsFreshness={adsFreshness}
      layoutGuardado={layoutGuardado}
    />
  );
}
