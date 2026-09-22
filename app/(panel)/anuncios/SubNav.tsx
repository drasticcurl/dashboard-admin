'use client';

/**
 * SubNav de la sección Anuncios (T17): las tres sub-pestañas.
 *
 * Preserva el query string igual que Nav.tsx: cambiar de sub-tab no puede
 * perder el nivel, la cuenta o el período que se estaba mirando.
 *
 * T07 §6: cambio cosmético (iconos Phosphor y tokens). Nada de lógica.
 */

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { ClockCounterClockwise, MegaphoneSimple, SlidersHorizontal } from '@phosphor-icons/react';

const SUBTABS = [
  { href: '/anuncios', label: 'Campañas', icon: <MegaphoneSimple size={14} weight="bold" /> },
  { href: '/anuncios/reglas', label: 'Reglas', icon: <SlidersHorizontal size={14} weight="bold" /> },
  { href: '/anuncios/historial', label: 'Historial', icon: <ClockCounterClockwise size={14} weight="bold" /> },
];

export function SubNav(): JSX.Element {
  const pathname = usePathname() ?? '/';
  const searchParams = useSearchParams();

  return (
    <nav aria-label="Anuncios" className="flex items-center gap-1">
      {SUBTABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={{ pathname: tab.href, search: searchParams.toString() }}
            aria-current={active ? 'page' : undefined}
            /*
              Pestañas SUBRAYADAS (handoff v3) y no pastillas con relleno. El
              relleno de la activa era `bg-overlay/8`, el mismo tono con el que
              las inactivas responden al hover: pasar el mouse por «Reglas»
              mientras estabas en «Campañas» dejaba las dos con el mismo fondo, y
              cuál estaba abierta sólo lo decía el color de la letra.

              El subrayado va como pseudo-elemento sobre el borde inferior, y las
              inactivas llevan `border-transparent` del mismo grosor: sin eso el
              rótulo se corre 2px al activarse y las otras dos pestañas se mueven
              de lugar.
            */
            className={`tap flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors duration-250 focus:outline-none focus:ring-2 focus:ring-good-500/50 ${
              active
                ? 'border-good-500 font-medium text-neutral-50'
                : 'border-transparent text-neutral-400 hover:border-overlay/16 hover:text-neutral-200'
            }`}
          >
            {tab.icon}
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
