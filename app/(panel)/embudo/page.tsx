/**
 * /embudo — el paso a paso de un funnel (task T06).
 *
 * Server component: resuelve el funnel del query string (con fallback al
 * primero, como el Nav), resuelve el rango en la TZ del funnel y hace el
 * fetch inicial acá, para que la primera pintura ya tenga datos. Los
 * cambios de filtro y del toggle de base los maneja EmbudoView en el client
 * sin recargar.
 */

import { getFunnelBySlug, listFunnels } from '@/lib/funnels';
import { getFunnelData, resolveFunnelRange } from '@/lib/queries/funnel';
import { resolveRange } from '@/lib/day';
import { EmptyState } from '@/components/ui';
import { EmbudoView } from './EmbudoView';

export const dynamic = 'force-dynamic';

type SearchParams = { [key: string]: string | string[] | undefined };

function single(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export default async function EmbudoPage({ searchParams }: { searchParams: SearchParams }) {
  const slug = single(searchParams.f);
  let funnel = slug ? await getFunnelBySlug(slug) : null;
  if (!funnel) {
    // Sin `?f=` o con un slug desconocido, el primer funnel activo: es el
    // mismo default del selector del Nav.
    const funnels = await listFunnels();
    funnel = funnels[0] ?? null;
  }
  if (!funnel) {
    return (
      <EmptyState
        title="No hay funnels configurados"
        hint="Corré las migraciones y el seed antes de usar el panel."
      />
    );
  }

  let range: { from: string; to: string };
  try {
    range = await resolveFunnelRange(
      {
        preset: single(searchParams.range),
        from: single(searchParams.from),
        to: single(searchParams.to),
      },
      funnel.timezone,
    );
  } catch {
    // Un from/to mal escrito en la URL no merece romper la pantalla: cae al
    // preset por defecto. El route sí devuelve 400; acá hay UI, no API.
    range = await resolveRange('today', funnel.timezone);
  }

  const data = await getFunnelData({
    funnelId: funnel.id,
    from: range.from,
    to: range.to,
    base: single(searchParams.base) === 'start' ? 'start' : 'landing',
    variant: single(searchParams.variant),
    utmCampaign: single(searchParams.campaign),
    utmSource: single(searchParams.source),
    country: single(searchParams.country),
    // Sin `experiment`: el embudo es UNO SOLO, sin desglose por test A/B. El
    // filtro existió mientras corrió el test de portada (`?exp=`) y se retiró al
    // cerrarse. `FunnelFilters.experiment` sigue soportado en la capa de queries
    // para el próximo experimento; esta pantalla simplemente no lo manda.
  });

  return <EmbudoView funnel={funnel} initialData={data} />;
}
