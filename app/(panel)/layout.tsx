/**
 * Layout del route group `(panel)` — el shell que comparten las cuatro
 * secciones (Resumen, Embudo, Ventas, Leads + Config), sin que la URL diga
 * `(panel)`.
 *
 * - Guard: si la cookie firmada no es válida → redirect a `/`. El middleware
 *   ya cubre esto, pero el guard en el layout es la defensa que queda si
 *   alguien toca el matcher.
 * - `force-dynamic`: un panel de métricas cacheado no sirve para nada.
 * - El selector de funnels lo carga el layout (server) y se lo pasa a
 *   `<Nav/>` (client): `listFunnels` toca Postgres, que no existe en el
 *   browser.
 * - Logout: server action que borra la cookie y vuelve al login.
 */

import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { listFunnels } from '@/lib/funnels';
import {
  PANEL_COOKIE_NAME,
  clearSessionCookieOptions,
  isAuthenticated,
} from '@/lib/auth';
import { Nav, PanelLogo } from '@/components/Nav';
import { RangePicker } from '@/components/RangePicker';

export const dynamic = 'force-dynamic';

async function logoutAction(): Promise<void> {
  'use server';
  cookies().set({
    name: PANEL_COOKIE_NAME,
    value: '',
    ...clearSessionCookieOptions(),
  });
  redirect('/');
}

export default async function PanelLayout({ children }: { children: ReactNode }) {
  if (!isAuthenticated(cookies())) {
    redirect('/');
  }

  const funnels = await listFunnels();

  return (
    <div className="min-h-screen bg-canvas text-neutral-100 antialiased">
      {/* glow ambiental superior, igual que el /admin de los funnels */}
      <div className="pointer-events-none fixed inset-x-0 top-0 -z-10 h-72 bg-gradient-to-b from-violet-600/10 via-emerald-500/[0.04] to-transparent blur-2xl" />
      <header className="sticky top-0 z-20 border-b border-border-subtle bg-canvas/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <Link
            href="/resumen"
            className="flex shrink-0 items-center gap-2 text-sm font-semibold tracking-tight text-neutral-100 hover:text-white"
          >
            <PanelLogo />
            <span className="hidden sm:inline">Panel · Hilvan</span>
            <span className="sm:hidden">Panel</span>
          </Link>

          <div className="flex flex-wrap items-center gap-3">
            <Nav funnels={funnels} />
            <RangePicker />
            <form action={logoutAction}>
              <button
                type="submit"
                className="rounded-lg px-2.5 py-1.5 text-sm text-neutral-400 transition-colors hover:bg-overlay/6 hover:text-neutral-100"
              >
                Salir
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
