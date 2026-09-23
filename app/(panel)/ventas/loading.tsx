/**
 * loading.tsx de /ventas — mismo motivo que resumen/loading.tsx: sin esto,
 * cambiar a esta pestaña dejaba la pantalla anterior congelada hasta que el
 * server terminara (queries + antes del fix, hasta 8 s esperando a Meta).
 *
 * La forma calca el bloque `loading` de VentasView.tsx (2 KPIs grandes + 4
 * chicos + gráfico + tabla), así el salto al contenido real es de datos, no
 * de layout.
 */

import { Grid, Skeleton } from '@/components/ui';

export default function Loading(): JSX.Element {
  return (
    <div className="space-y-4">
      <Grid className="panel:auto-rows-[240px]">
        <div className="panel:col-span-2">
          <Skeleton variant="kpi" />
        </div>
        <div className="panel:col-span-2">
          <Skeleton variant="kpi" />
        </div>
        <Skeleton variant="kpi" />
        <Skeleton variant="kpi" />
        <Skeleton variant="kpi" />
        <Skeleton variant="kpi" />
        <div className="row-span-2 panel:col-span-2">
          <Skeleton variant="chart" />
        </div>
        <div className="row-span-2 panel:col-span-2">
          <Skeleton variant="table" rows={6} />
        </div>
      </Grid>
    </div>
  );
}
