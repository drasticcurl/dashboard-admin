'use client';

/**
 * SwitchMoneda — el EUR/USD del encabezado del Resumen.
 *
 * Escribe `?moneda=` en la URL y nada más: la pantalla lo lee de ahí y pide los
 * datos convertidos (cada día con su cotización, ver `joinFactor` en
 * lib/queries/overview.ts). La URL es la única fuente de verdad, igual que el
 * `?cur=` de Ventas, así que sobrevive a un refresh y al back/forward.
 *
 * NO usa `?cur=`: ese parámetro ya lo lee Ventas con otro significado ("moneda
 * de reporte o moneda de venta"), y el Nav arrastra el query string entre
 * pantallas. Con el mismo nombre, elegir USD acá haría que Ventas mostrara los
 * importes en pesos.
 *
 * Elegir la moneda de reporte BORRA el parámetro en vez de escribir
 * `?moneda=EUR`: es el default, y así la URL de siempre sigue siendo la de
 * siempre.
 */

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { MONEDA_ALTERNATIVA, MONEDA_REPORTE, leerMonedaVista, type MonedaReporte } from '@/lib/moneda-reporte';

const OPCIONES: readonly MonedaReporte[] = [MONEDA_REPORTE, MONEDA_ALTERNATIVA];

export function SwitchMoneda(): JSX.Element {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  const actual = leerMonedaVista(searchParams.get('moneda'));

  const elegir = (m: MonedaReporte): void => {
    if (m === actual) return;
    const params = new URLSearchParams(searchParams.toString());
    if (m === MONEDA_REPORTE) params.delete('moneda');
    else params.set('moneda', m);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  return (
    /*
      Misma caja que los <select> de al lado (SELECT_HEADER): borde fuerte,
      fondo `surface-raised` y 34px de alto en desktop, para que la fila de
      filtros se lea como una sola pieza y no como un control de otra familia.
    */
    <div
      role="group"
      aria-label="Moneda"
      className="inline-flex min-h-[44px] items-stretch rounded-lg border border-border-strong bg-surface-raised p-0.5 shadow-inset-highlight panel:min-h-0"
    >
      {OPCIONES.map((m) => {
        const activa = m === actual;
        return (
          <button
            key={m}
            type="button"
            onClick={() => elegir(m)}
            aria-pressed={activa}
            className={`press min-w-[44px] justify-center rounded-md px-2.5 py-1 font-mono text-[13px] font-medium transition-colors duration-250 focus:outline-none focus-visible:ring-2 focus-visible:ring-acento-500/50 panel:min-w-0 ${
              activa
                ? 'bg-acento-900 text-acento-100'
                : 'text-neutral-400 hover:bg-overlay/6 hover:text-neutral-200'
            }`}
          >
            {m}
          </button>
        );
      })}
    </div>
  );
}
