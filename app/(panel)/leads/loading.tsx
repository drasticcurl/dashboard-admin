/**
 * loading.tsx de /leads — mismo motivo que resumen/loading.tsx.
 *
 * Con la forma de la pantalla: la fila de seis KPIs, la tarjeta de exportar y
 * la tabla. Con sólo la tabla, los KPIs aparecían de golpe arriba y empujaban
 * todo para abajo.
 */

import { Skeleton } from '@/components/ui';

export default function Loading(): JSX.Element {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Skeleton variant="kpi" />
        <Skeleton variant="kpi" />
        <Skeleton variant="kpi" />
        <Skeleton variant="kpi" />
        <Skeleton variant="kpi" />
        <Skeleton variant="kpi" />
      </div>
      <Skeleton variant="table" rows={2} />
      <Skeleton variant="table" rows={8} />
    </div>
  );
}
