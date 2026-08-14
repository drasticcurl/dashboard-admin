'use client';

/**
 * RangePicker — selector GLOBAL de período del panel.
 *
 * Vive en el header del layout `(panel)`. Escribe el preset en `?range=` con
 * `router.replace(..., { scroll: false })` (sin recargar ni saltar arriba),
 * preservando el resto del query (`?f=` del funnel) para que el funnel
 * elegido no se pierda al cambiar el rango.
 *
 * Cada sección (T06-T09) lee `?range=` y lo resuelve con `resolveRange` de
 * `lib/day.ts` (T01). La lista de presets está acá porque `lib/day.ts` solo
 * exporta el tipo `RangePreset`, no las opciones.
 */

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { CaretDown } from '@phosphor-icons/react';
import type { RangePreset } from '@/lib/day';

const RANGE_OPTIONS: ReadonlyArray<{ value: RangePreset; label: string }> = [
  { value: 'today', label: 'Hoy' },
  { value: 'yesterday', label: 'Ayer' },
  { value: '7d', label: '7 días' },
  { value: '14d', label: '14 días' },
  { value: '30d', label: '30 días' },
  { value: 'mtd', label: 'Mes actual' },
  { value: 'all', label: 'Todo' },
];

/** Preset por defecto: el mismo default que el RangePicker de los funnels. */
const DEFAULT_RANGE: RangePreset = 'today';

function isRangePreset(v: string | null): v is RangePreset {
  return typeof v === 'string' && RANGE_OPTIONS.some((o) => o.value === v);
}

export function RangePicker() {
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  const searchParams = useSearchParams();

  const raw = searchParams.get('range');
  const current: RangePreset = isRangePreset(raw) ? raw : DEFAULT_RANGE;

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('range', e.target.value);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="relative inline-flex items-center" title="Período del panel">
      <select
        value={current}
        onChange={onChange}
        aria-label="Período del panel"
        /* Sólido y no translúcido: ver el comentario del <select> de Nav.tsx.
           Un select sin fondo resuelto lo pinta el navegador de BLANCO. */
        className="appearance-none rounded-lg border border-border-strong bg-surface-raised py-1.5 pl-3 pr-7 text-sm font-medium text-neutral-200 transition-colors hover:border-overlay/20 focus:border-good-500/50 focus:outline-none focus:ring-1 focus:ring-good-500/50"
      >
        {RANGE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value} className="bg-surface text-neutral-200">
            {o.label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-2.5 text-neutral-500">
        <CaretDown size={14} weight="bold" aria-hidden="true" />
      </span>
    </div>
  );
}
