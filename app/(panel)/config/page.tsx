/**
 * /config — la pantalla que hace operable el panel sin SSH (task T09 §B,
 * rediseñada en T07 §3).
 *
 * Server component: resuelve el funnel del query string (las secciones de
 * pasos y etapas siguen al funnel del selector del Nav) y hace el fetch
 * inicial de todo — funnels, pasos, etapas, productos, tiendas, ajustes,
 * cotizaciones y salud — para que la primera pintura ya tenga datos. Los
 * cambios los maneja ConfigView en el client, refetcheando /api/config/*.
 *
 * La sección activa viaja en `?s=` (D-R14) y el `key` remonta ConfigView
 * cuando cambia el funnel: sus estados internos arrancan del funnel que
 * corresponda, no del anterior.
 */

import { getFunnelBySlug, listFunnels, listSteps } from '@/lib/funnels';
import { listCommissions } from '@/lib/commissions';
import { q } from '@/lib/db';
import type { FunnelStageRow } from '@/lib/queries/funnel';
import { getUnknownSteps, listFxRates, listProductMappings, listShopMappings, getSettingsRecord, getSystemStatus, listUnmappedProducts } from '@/app/api/config/_lib';
import { EmptyState } from '@/components/ui';
import { ConfigView } from './ConfigView';

export const dynamic = 'force-dynamic';

type SearchParams = { [key: string]: string | string[] | undefined };

function single(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

async function listStages(funnelId: number): Promise<FunnelStageRow[]> {
  return q<FunnelStageRow>(
    `SELECT stage_order AS "stageOrder", label,
            starts_at_slug AS "startsAtSlug", milestone
     FROM funnel_stages
     WHERE funnel_id = $1
     ORDER BY stage_order`,
    [funnelId],
  );
}

export default async function ConfigPage({ searchParams }: { searchParams: SearchParams }) {
  const slug = single(searchParams.f);
  let funnel = slug ? await getFunnelBySlug(slug) : null;
  if (!funnel) {
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

  const [funnels, steps, stages, unknownSteps, products, shops, settings, fx, system, commissions] =
    await Promise.all([
      listFunnels({ includeInactive: true }),
      listSteps(funnel.id),
      listStages(funnel.id),
      getUnknownSteps(funnel.id),
      Promise.all([listProductMappings(), listUnmappedProducts()]),
      listShopMappings(),
      getSettingsRecord(),
      listFxRates(20),
      getSystemStatus({}),
      listCommissions(),
    ]);

  return (
    <ConfigView
      key={funnel.slug}
      funnel={funnel}
      initial={{
        funnels,
        steps,
        stages,
        unknownSteps,
        mappings: products[0],
        unmapped: products[1],
        shops,
        settings,
        fx,
        system,
        commissions,
      }}
    />
  );
}
