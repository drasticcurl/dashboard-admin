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
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-good-500/50 ${
              active
                ? 'bg-overlay/8 text-neutral-50'
                : 'text-neutral-400 hover:bg-overlay/5 hover:text-neutral-200'
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
