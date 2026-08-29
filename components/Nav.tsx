'use client';

/**
 * Nav — las seis tabs del panel + el selector de funnel.
 *
 * El selector vive acá y no en cada sección porque Embudo y Ventas lo
 * comparten: cambiar de funnel no puede perder el rango elegido, y viceversa.
 * Por eso cada cambio (tab, funnel, rango) preserva TODO el query string
 * actual: `?f=` y `?range=` sobreviven a la navegación.
 *
 * Los iconos son de Phosphor (D-R11), peso `bold` como el resto del panel.
 */

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { CaretDown } from '@phosphor-icons/react';
import { nombreVisible } from '@/lib/funnel-nombre';
import type { Funnel } from '@/lib/funnels';

const TABS = [
  { href: '/resumen', label: 'Resumen' },
  { href: '/embudo', label: 'Embudo' },
  { href: '/ventas', label: 'Ventas' },
  { href: '/anuncios', label: 'Anuncios' },
  { href: '/finanzas', label: 'Finanzas' },
  { href: '/leads', label: 'Leads' },
  { href: '/config', label: 'Config' },
];

/**
 * El estilo compartido de los dos <select> del header (funnel y período).
 * Está acá y lo importa `RangePicker` porque son el MISMO control con datos
 * distintos: cuando divergen, el header se ve desalineado.
 *
 * Fondo SÓLIDO y no un `bg-overlay/N` translúcido. Un <select> sin
 * background-color resuelto se pinta con el default del navegador, que es
 * BLANCO: en un panel oscuro se ve como un bug de color, y es exactamente lo
 * que pasaba cuando la escala de opacidad no tenía el valor usado. Con un
 * token sólido no depende de eso.
 */
export const SELECT_HEADER =
  'press appearance-none rounded-lg border border-border-strong bg-surface-raised py-1.5 pl-3 pr-8 text-sm font-medium text-neutral-200 shadow-inset-highlight transition-[background-color,border-color,box-shadow] duration-250 hover:border-overlay/18 hover:bg-surface-overlay';

export function Nav({
  funnels,
  saldoPendiente = false,
}: {
  funnels: Funnel[];
  /**
   * true = falta cargar el saldo de hoy en alguna cuenta. Pone un punto en la
   * tab de Finanzas.
   *
   * El punto está además del aviso flotante (`AvisoSaldo`) y no en su lugar,
   * porque los dos duran distinto: el aviso se descarta con "Después" y no
   * vuelve hasta mañana, mientras que el punto se queda hasta que el saldo esté
   * cargado de verdad. Si el único recordatorio fuera descartable, "después" y
   * "listo" se volverían indistinguibles.
   */
  saldoPendiente?: boolean;
}) {
  const pathname = usePathname() ?? '/';
  const searchParams = useSearchParams();
  const router = useRouter();

  const onFunnelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('f', e.target.value);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const selectedFunnel = searchParams.get('f');

  return (
    <nav className="flex flex-wrap items-center gap-2.5">
      {/*
        Control segmentado, no una fila de links. El canal es un surco hundido
        (fondo más oscuro que el header + sombra interna) y la tab activa una
        pastilla que FLOTA dentro de él: por eso el canal lleva sombra hacia
        adentro y la pastilla hacia afuera. Es la misma lógica de luz que el
        resto del panel, y es lo que hace que se lea como un objeto físico.

        La tab activa se marca con TRES señales a la vez, no sólo con el color
        de la letra: la pastilla elevada, el peso semibold y una barra corta
        debajo del texto. Con siete tabs del mismo largo, un cambio de color de
        letra no alcanza para responder "dónde estoy" de un vistazo.

        Nada de eso ocupa espacio: la pastilla es fondo, la barra es un
        pseudo-elemento posicionado y el ancho de la tab lo fija el `after` del
        texto en negrita (ver abajo). Así las tabs no se mueven un pixel al
        cambiar de sección.
      */}
      <ul className="flex items-center gap-0.5 rounded-xl bg-canvas/60 p-1 shadow-[inset_0_1px_2px_0_rgba(4,6,14,0.6),inset_0_0_0_1px_rgba(255,255,255,0.05)]">
        {TABS.map((t) => {
          const tab = { ...t, pendiente: t.href === '/finanzas' && saldoPendiente };
          const active =
            pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <li key={tab.href}>
              <Link
                href={{ pathname: tab.href, search: searchParams.toString() }}
                aria-current={active ? 'page' : undefined}
                className={`press relative block rounded-lg px-3 py-1.5 text-sm transition-[background-color,color,box-shadow] duration-250 ${
                  active
                    ? 'bg-surface-raised font-semibold text-neutral-50 shadow-lozenge after:absolute after:inset-x-3 after:bottom-1 after:h-0.5 after:rounded-full after:bg-good-500 after:content-[""]'
                    : 'font-medium text-neutral-400 hover:bg-overlay/7 hover:text-neutral-100'
                }`}
              >
                {/*
                  El truco del ancho: los dos labels se apilan en la MISMA
                  celda de un grid, así la celda mide lo que mide el más ancho
                  —el semibold— siempre. Sin esto la tab se ensancha al
                  activarse (medium → semibold ocupa más) y las otras seis se
                  corren de lugar en cada navegación. Es el jitter que ya tenía
                  el nav y que no se veía porque nadie mira las otras tabs
                  mientras cambia de sección.
                */}
                <span className="grid">
                  <span
                    aria-hidden
                    className="invisible col-start-1 row-start-1 font-semibold"
                  >
                    {tab.label}
                  </span>
                  <span className="col-start-1 row-start-1">{tab.label}</span>
                </span>
                {/*
                  El punto de pendiente. Va `absolute` y NO en el flujo para no
                  ensanchar la tab: el truco del grid de arriba fija el ancho
                  contra el label en semibold, y un punto que ocupara espacio
                  correría las otras seis tabs cada vez que aparece o se va —
                  justo el jitter que ese grid existe para evitar.

                  El texto para lector de pantalla va aparte y en `sr-only`,
                  porque un punto de color no dice nada a quien no lo ve.
                */}
                {tab.pendiente && (
                  <>
                    <span
                      aria-hidden
                      className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-warn-500"
                    />
                    <span className="sr-only"> (falta cargar el saldo de hoy)</span>
                  </>
                )}
              </Link>
            </li>
          );
        })}
      </ul>

      {funnels.length > 0 && (
        <div className="relative inline-flex items-center">
          <select
            value={
              selectedFunnel && funnels.some((f) => f.slug === selectedFunnel)
                ? selectedFunnel
                : funnels[0]!.slug
            }
            onChange={onFunnelChange}
            aria-label="Funnel"
            className={SELECT_HEADER}
          >
            {funnels.map((f) => (
              // El VALUE sigue siendo el slug: el alias es sólo presentación y no
              // puede cambiar lo que viaja en la URL.
              <option key={f.slug} value={f.slug} className="bg-surface-raised text-neutral-200">
                {nombreVisible(f)}
              </option>
            ))}
          </select>
          <CaretDown
            size={12}
            weight="bold"
            aria-hidden
            className="pointer-events-none absolute right-3 text-neutral-400"
          />
        </div>
      )}
    </nav>
  );
}
