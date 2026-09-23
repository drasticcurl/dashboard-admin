/**
 * loading.tsx de /anuncios — mismo motivo que resumen/loading.tsx.
 *
 * Acá el server component hace además la consulta de cuentas y la Jerarquía
 * (anuncios/page.tsx), así que sin este fallback el cuelgue percibido era el
 * peor de las tres pantallas. La tabla es lo dominante de esta vista, así que
 * el esqueleto es una tabla ancha en vez de KPIs.
 */

import { Skeleton } from '@/components/ui';

export default function Loading(): JSX.Element {
  return (
    <div className="space-y-4">
      <Skeleton variant="table" rows={8} />
    </div>
  );
}
