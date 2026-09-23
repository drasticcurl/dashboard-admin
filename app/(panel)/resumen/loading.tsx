/**
 * loading.tsx de /resumen — el fallback de Suspense de Next mientras el
 * server component (page.tsx) resuelve.
 *
 * Por qué existe: sin este archivo, Next no tiene ningún boundary de Suspense
 * en esta ruta, así que el navegador se queda mostrando la pantalla ANTERIOR
 * congelada hasta que el server termine todo su trabajo (queries + antes del
 * fix de `esperar: false`, hasta 8 s esperando a Meta). Con este archivo, la
 * navegación pinta esto al instante y después swapea al contenido real — la
 * misma sensación de "carga rápido" que ya tienen los cambios de rango dentro
 * de la pantalla (ver ResumenView.tsx, que usa el mismo `Skeleton`).
 *
 * La forma calca la de `EsqueletoResumen` en ResumenView.tsx (4 KPIs + gráfico
 * + tabla) para que el salto entre el loading y el contenido real sea de
 * datos, no de layout.
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
      <Skeleton variant="table" rows={4} />
    </div>
  );
}
