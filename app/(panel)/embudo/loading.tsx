/**
 * loading.tsx de /embudo — mismo motivo que resumen/loading.tsx.
 *
 * La forma calca la de EmbudoView (los 4 KPIs, el embudo por etapas y el paso
 * a paso) con la misma grilla de KPIs: antes arrancaba en el gráfico y, al
 * llegar los datos, la fila de KPIs empujaba todo 100px para abajo.
 */

import { Skeleton } from '@/components/ui';

export default function Loading(): JSX.Element {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton variant="kpi" />
        <Skeleton variant="kpi" />
        <Skeleton variant="kpi" />
        <Skeleton variant="kpi" />
      </div>
      <Skeleton variant="chart" />
      <Skeleton variant="table" rows={6} />
    </div>
  );
}
