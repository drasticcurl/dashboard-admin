/**
 * loading.tsx de /creativos — mismo motivo que resumen/loading.tsx.
 */

import { Skeleton } from '@/components/ui';

export default function Loading(): JSX.Element {
  return (
    <div className="space-y-4">
      <Skeleton variant="table" rows={6} />
    </div>
  );
}
