/**
 * loading.tsx de /tareas — mismo motivo que resumen/loading.tsx.
 *
 * Cuatro columnas en fila, con los mismos anchos que TableroView: antes eran
 * tres en grilla y el tablero tiene cuatro, así que al llegar los datos las
 * columnas se reacomodaban.
 */

import { Skeleton } from '@/components/ui';

const COLUMNA = 'w-[min(86vw,300px)] shrink-0 panel:w-auto panel:min-w-[240px] panel:flex-1';

export default function Loading(): JSX.Element {
  return (
    <div className="-mx-4 flex gap-4 overflow-hidden px-4 panel:mx-0 panel:px-0">
      <div className={COLUMNA}>
        <Skeleton variant="table" rows={4} />
      </div>
      <div className={COLUMNA}>
        <Skeleton variant="table" rows={4} />
      </div>
      <div className={COLUMNA}>
        <Skeleton variant="table" rows={4} />
      </div>
      <div className={COLUMNA}>
        <Skeleton variant="table" rows={4} />
      </div>
    </div>
  );
}
