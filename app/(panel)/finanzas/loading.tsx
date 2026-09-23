/**
 * loading.tsx de /finanzas — mismo motivo que resumen/loading.tsx.
 */

import { Skeleton } from '@/components/ui';

export default function Loading(): JSX.Element {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Skeleton variant="kpi" />
        <Skeleton variant="kpi" />
        <Skeleton variant="kpi" />
        <Skeleton variant="kpi" />
      </div>
      <Skeleton variant="chart" />
      <Skeleton variant="table" rows={5} />
    </div>
  );
}
