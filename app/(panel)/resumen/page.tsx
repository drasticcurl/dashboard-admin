/**
 * /resumen — todos los funnels en una pantalla (task T08), ahora con widgets
 * configurables (T05 del rediseño).
 *
 * Es la página de inicio del panel (T05 redirige acá tras el login). Server
 * component: resuelve el rango en la TZ del dashboard (D19, no hay funnel
 * que la defina), hace el fetch inicial acá para que la primera pintura ya
 * tenga datos, y lee el layout guardado de settings para que NO haya que
 * pedirlo con un fetch desde el client: un fetch dibujaría el layout por
 * defecto y después saltaría al del usuario (parpadeo, T05 §3).
 *
 * El catálogo (lib/widgets/catalogo-resumen.tsx) NO se importa acá a
 * propósito: importa recharts y es de componentes client.
 *
 * A diferencia de Embudo y Ventas, no hay `?f=`: el Resumen es global. El
 * `f` que deja el Nav en el query string se ignora a propósito.
 */

import { resolveFunnelRange } from '@/lib/queries/funnel';
import { getDashboardTimezone } from '@/lib/queries/sales';
import { getOverviewData } from '@/lib/queries/overview';
import { resolveRange, today } from '@/lib/day';
import { ensureFreshAdSpend } from '@/lib/ads/live';
import { q1 } from '@/lib/db';
import type { WidgetLayout } from '@/lib/widgets/tipos';
import { ResumenView } from './ResumenView';

export const dynamic = 'force-dynamic';

type SearchParams = { [key: string]: string | string[] | undefined };

function single(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export default async function ResumenPage({ searchParams }: { searchParams: SearchParams }) {
  const timezone = getDashboardTimezone();
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
    // Un from/to mal escrito en la URL no merece romper la pantalla: cae al
    // preset por defecto. El route sí devuelve 400; acá hay UI, no API.
    range = await resolveRange('today', timezone);
  }

  // Igual que en Ventas: si el rango llega a hoy se refresca el gasto de Meta
  // antes de leer, así el Resultado y el ROAS no mezclan ventas de este minuto
  // con gasto del cron de hace una hora. `ensureFreshAdSpend` reconstruye
  // también el rollup del día, que es de donde lee esta pantalla.
  const hoy = await today(timezone);
  await ensureFreshAdSpend(range.to, hoy);

  const [data, layoutRow] = await Promise.all([
    getOverviewData(range),
    // Lectura propia de la fila, igual que el GET de /api/config/ui-layout:
    // la whitelist de getSettingsRecord() no incluye los layouts.
    q1<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', ['ui_layout_resumen']),
  ]);

  // El valor va crudo: parseLayout de WidgetGrid lo normaliza y nunca tira.
  const layoutGuardado =
    layoutRow === null || layoutRow.value === null ? null : (layoutRow.value as WidgetLayout);

  return <ResumenView initialData={data} layoutGuardado={layoutGuardado} />;
}
