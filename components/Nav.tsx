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
import { CaretDown, ChartLineUp } from '@phosphor-icons/react';
import { nombreVisible } from '@/lib/funnel-nombre';
import type { Funnel } from '@/lib/funnels';

const TABS = [
  { href: '/resumen', label: 'Resumen' },
  { href: '/embudo', label: 'Embudo' },
  { href: '/ventas', label: 'Ventas' },
  { href: '/anuncios', label: 'Anuncios' },
  { href: '/leads', label: 'Leads' },
  { href: '/config', label: 'Config' },
];

/**
 * El logo del panel. Vive en un client component porque el layout del panel
 * es un server component y `@phosphor-icons/react` llama a `createContext`
 * al importarse, que la build server-only de React no tiene (T07 §7, D-R11:
 * el logo deja de ser la letra P).
 */
export function PanelLogo(): JSX.Element {
  return (
    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-emerald-500 text-white shadow-lg shadow-violet-500/20">
      <ChartLineUp size={16} weight="bold" aria-hidden />
    </span>
  );
}

export function Nav({ funnels }: { funnels: Funnel[] }) {
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
    <nav className="flex flex-wrap items-center gap-3">
      {/*
        La tab activa se marca con TRES señales a la vez, no sólo con el color
        de la letra: una pastilla sólida más clara que el canal, un borde
        interno que la despega del fondo, y una barra debajo del texto. Con
        seis tabs del mismo largo, un cambio de color de letra no alcanza para
        responder "dónde estoy" de un vistazo.

        El borde va como `ring-inset` y la barra como pseudo-elemento
        posicionado: las dos cosas no ocupan espacio, así que las tabs no se
        mueven un pixel al cambiar de sección.
      */}
      <ul className="flex items-center gap-1 rounded-lg border border-border-subtle bg-overlay/4 p-1">
        {TABS.map((tab) => {
          const active =
            pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <li key={tab.href}>
              <Link
                href={{ pathname: tab.href, search: searchParams.toString() }}
                aria-current={active ? 'page' : undefined}
                className={`relative block rounded-md px-3 py-1.5 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-good-500/50 ${
                  active
                    ? 'bg-surface-raised font-semibold text-neutral-50 shadow-card ring-1 ring-inset ring-border-strong after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:rounded-full after:bg-good-500 after:content-[""]'
                    : 'font-medium text-neutral-400 hover:bg-overlay/6 hover:text-neutral-200'
                }`}
              >
                {tab.label}
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
            /*
              Fondo SÓLIDO y no un `bg-overlay/N` translúcido. Un <select> sin
              background-color resuelto se pinta con el default del navegador,
              que es BLANCO: en un panel oscuro se ve como un bug de color y es
              exactamente lo que pasaba cuando la escala de opacidad no tenía
              el valor usado. Con un token sólido no depende de eso.
            */
            className="appearance-none rounded-lg border border-border-strong bg-surface-raised py-1.5 pl-3 pr-7 text-sm font-medium text-neutral-200 transition-colors hover:border-overlay/20 focus:border-good-500/50 focus:outline-none focus:ring-1 focus:ring-good-500/50"
          >
            {funnels.map((f) => (
              // El VALUE sigue siendo el slug: el alias es sólo presentación y no
              // puede cambiar lo que viaja en la URL.
              <option key={f.slug} value={f.slug} className="bg-surface text-neutral-200">
                {nombreVisible(f)}
              </option>
            ))}
          </select>
          <CaretDown
            size={12}
            weight="bold"
            aria-hidden
            className="pointer-events-none absolute right-2.5 text-neutral-500"
          />
        </div>
      )}
    </nav>
  );
}
