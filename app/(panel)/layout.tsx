/**
 * Layout del route group `(panel)` — el shell que comparten las cuatro
 * secciones (Resumen, Embudo, Ventas, Leads + Config), sin que la URL diga
 * `(panel)`.
 *
 * - Guard: `sesionActual()` lee la cookie firmada y consulta la base. Sin
 *   sesión usable → redirect a `/`; con `debeCambiarClave` → `/cambiar-clave`.
 *   El middleware ya cubre la firma, pero el guard en el layout es la defensa
 *   que queda si alguien toca el matcher, y además es el ÚNICO que lee la
 *   identidad (el middleware corre en Edge y no puede consultar Postgres, D3).
 *   El chequeo de `debeCambiarClave` va acá y no en los layouts de sección: si
 *   estuviera en cada uno, alguien con la clave por defecto y sin secciones
 *   caería en /sin-acceso y nunca podría cambiarla (D8).
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
} from '@/lib/auth';
import { sesionActual } from '@/lib/permisos';
import { faltanSaldosDeHoy } from '@/lib/queries/saldo';
import { PANEL_TITLE } from '@/lib/brand';
import { AvisoSaldo } from '@/components/AvisoSaldo';
import { Nav } from '@/components/Nav';
import { PanelLogo } from '@/components/PanelLogo';
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
  // `sesionActual()` valida la firma de la cookie Y consulta la base (D3): así
  // desactivar a alguien o quitarle una pestaña tiene efecto en el request
  // siguiente, no cuando se le venza la sesión.
  const sesion = await sesionActual();
  if (!sesion) redirect('/');
  // La clave pendiente se chequea acá, en el layout general, y NO en los siete
  // layouts de sección: si no, alguien con la clave por defecto y sin secciones
  // caería en /sin-acceso y nunca podría cambiarla (D8).
  if (sesion.debeCambiarClave) redirect('/cambiar-clave');

  // Las dos en paralelo: `faltanSaldosDeHoy` es UNA consulta y corre en cada
  // pantalla del panel, así que no puede sumar latencia en serie.
  //
  // Va en el layout y no en /finanzas a propósito: el patrimonio se mide a mano
  // y un día al que le falta una cuenta no aparece en el gráfico, así que
  // olvidarse no degrada el dato, LO BORRA. Un recordatorio que sólo se ve
  // adentro de Finanzas obligaría a entrar para acordarse de entrar.
  const [funnels, saldo] = await Promise.all([listFunnels(), faltanSaldosDeHoy()]);

  return (
    /*
      `min-h-dvh` y no `min-h-screen`: en Safari de iOS `100vh` cuenta la barra
      de direcciones que se esconde al scrollear, así que el layout salta unos
      píxeles al primer gesto. `dvh` mide el viewport que hay de verdad.
    */
    <div className="min-h-dvh bg-canvas text-neutral-100 antialiased">
      {/* Luz ambiental y grano: las dos capas decorativas del fondo. */}
      <div aria-hidden className="aurora" />
      <div aria-hidden className="grain" />

      {/*
        Salto al contenido: el header tiene ~10 controles antes del <main>, así
        que sin esto quien navega con teclado tabula por las 7 tabs, el select
        de funnel, el de rango y Salir en CADA carga de página.
      */}
      <a
        href="#contenido"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-surface-raised focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-neutral-50 focus:shadow-float"
      >
        Saltar al contenido
      </a>

      {/*
        El header es la única superficie de vidrio de verdad del panel: el
        contenido pasa POR DEBAJO difuminado. El borde inferior no es una línea
        pareja sino un degradado que se apaga en los extremos, así el header se
        apoya sobre el contenido en lugar de cortarlo.
      */}
      <header className="glass-bar sticky top-0 z-20">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
          <Link
            href="/resumen"
            className="flex shrink-0 items-center gap-2.5 text-sm font-semibold tracking-tight text-neutral-100 transition-colors hover:text-neutral-50"
          >
            <PanelLogo />
            {/* El nombre sale de PANEL_BRAND (lib/brand.ts): varias instancias
                deployan de este mismo repo y cada una muestra su proyecto. */}
            <span className="hidden sm:inline">{PANEL_TITLE}</span>
            <span className="sm:hidden">Panel</span>
          </Link>

          <div className="flex flex-wrap items-center gap-2.5">
            <Nav
              funnels={funnels}
              saldoPendiente={saldo.faltan.length > 0}
              seccionesPermitidas={sesion.secciones}
              nombre={sesion.nombre}
            />
            <RangePicker />
            <form action={logoutAction}>
              <button
                type="submit"
                className="press rounded-lg px-2.5 py-1.5 text-sm font-medium text-neutral-400 transition-colors duration-250 hover:bg-overlay/8 hover:text-neutral-100"
              >
                Salir
              </button>
            </form>
          </div>
        </div>
        <div
          aria-hidden
          className="h-px bg-gradient-to-r from-transparent via-overlay/12 to-transparent"
        />
      </header>

      {/*
        Padding inferior más grande que el superior: ópticamente, un bloque con
        el mismo aire arriba y abajo se ve caído hacia el final de la página.
      */}
      {/*
        `reveal` escalona la entrada de los bloques de la pantalla (ver
        globals.css): la cabecera, y después cada tarjeta con 45ms de
        diferencia. Va acá, a nivel de página, y NO en el primitivo `Grid`:
        los hijos de esa grilla son los widgets arrastrables y llevan un
        `transform` inline de dnd-kit que una animación CSS pisaría, porque en
        la cascada las animaciones ganan a los estilos inline. Animar la grilla
        entera es seguro; animar sus items rompería el drag.
      */}
      <main id="contenido" className="reveal mx-auto max-w-7xl px-4 pb-16 pt-7">
        {children}
      </main>

      {/*
        Fuera del <main> y del `reveal`: el aviso no es contenido de la pantalla
        y no tiene que entrar en la animación escalonada de las tarjetas. Se
        oculta solo dentro de /finanzas, donde el botón ya está latiendo.
      */}
      {/*
        `saldo.hoy` viene del server resuelto en DASHBOARD_TZ, y NO de un
        `new Date()`: es la clave del "descartar por hoy", así que con la fecha
        del browser (o con un toISOString(), que es UTC) el aviso se reactivaría
        a la medianoche equivocada — hasta 5 horas antes en producción.
      */}
      <AvisoSaldo faltan={saldo.faltan} hoy={saldo.hoy} />
    </div>
  );
}
