/**
 * /leads — los leads de un funnel, leídos de Supabase (task T09 §A).
 *
 * Server component: resuelve el funnel del query string (fallback al primero,
 * como el resto de las secciones), resuelve el rango en la TZ del funnel y
 * hace el fetch inicial acá para que la primera pintura ya tenga datos. Sin
 * credenciales de Supabase, getLeadsData responde `configured: false` y la
 * pantalla muestra "no configurado" — el resto del panel no se entera.
 */

import { getFunnelBySlug, listFunnels } from '@/lib/funnels';
import { resolveFunnelRange } from '@/lib/queries/funnel';
import { getLeadsData } from '@/lib/queries/leads';
import { resolveRange } from '@/lib/day';
import { EmptyState } from '@/components/ui';
import { LeadsView } from './LeadsView';

export const dynamic = 'force-dynamic';

type SearchParams = { [key: string]: string | string[] | undefined };

function single(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export default async function LeadsPage({ searchParams }: { searchParams: SearchParams }) {
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
    range = await resolveRange('today', funnel.timezone);
  }

  const initialData = await getLeadsData(funnel, range);

  return <LeadsView funnel={funnel} initialData={initialData} />;
}
