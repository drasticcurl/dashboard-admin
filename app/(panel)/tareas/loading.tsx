/**
 * loading.tsx de /tareas — mismo motivo que resumen/loading.tsx.
 */

import { Skeleton } from '@/components/ui';

export default function Loading(): JSX.Element {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Skeleton variant="table" rows={4} />
      <Skeleton variant="table" rows={4} />
      <Skeleton variant="table" rows={4} />
    </div>
  );
}
