/**
 * loading.tsx de /finanzas — mismo motivo que resumen/loading.tsx.
 *
 * Con la forma de la pantalla de verdad (patrimonio, gráfico, botonera y las
 * dos tarjetas de abajo) y no la de un Resumen: antes eran cuatro KPIs que
 * Finanzas no tiene, así que al cargar la pantalla "saltaba" de una grilla a
 * otra.
 */

import { Skeleton } from '@/components/ui';

export default function Loading(): JSX.Element {
  return (
    <div className="space-y-4">
      <Skeleton variant="kpi" />
      <Skeleton variant="chart" />
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton variant="table" rows={2} />
        <Skeleton variant="table" rows={2} />
        <Skeleton variant="table" rows={2} />
        <Skeleton variant="table" rows={2} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton variant="table" rows={5} />
        <Skeleton variant="table" rows={5} />
      </div>
    </div>
  );
}
