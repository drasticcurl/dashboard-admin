/**
 * loading.tsx de /config — mismo motivo que resumen/loading.tsx.
 */

import { Skeleton } from '@/components/ui';

export default function Loading(): JSX.Element {
  return (
    <div className="space-y-4">
      {/* Con la misma caja que el índice de secciones de ConfigView: si el
          esqueleto no tiene su forma, al cargar la pantalla "salta" y el ojo
          pierde el lugar donde iba a hacer click. */}
      <div className="rounded-xl border border-border-subtle bg-surface p-3">
        <Skeleton variant="text" rows={4} />
      </div>
      <Skeleton variant="table" rows={6} />
    </div>
  );
}
