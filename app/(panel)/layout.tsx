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
import { listFunnels } from '@/lib/funnels';
import {
  PANEL_COOKIE_NAME,
  clearSessionCookieOptions,
} from '@/lib/auth';
import { sesionActual } from '@/lib/permisos';
import { faltanSaldosDeHoy } from '@/lib/queries/saldo';
import { AvisoSaldo } from '@/components/AvisoSaldo';
import { Shell } from '@/components/Shell';

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
        Salto al contenido: antes del <main> hay la hamburguesa, los dos filtros
        y —en desktop— los nueve links del sidebar, así que sin esto quien navega
        con teclado tabula por todo eso en CADA carga de página.
      */}
      <a
        href="#contenido"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-salto focus:rounded-lg focus:bg-surface-raised focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-neutral-50 focus:shadow-float"
      >
        Saltar al contenido
      </a>

      {/*
        El shell (sidebar en desktop, drawer en mobile) es un componente client:
        necesita el pathname para marcar la sección activa y estado para el
        drawer. El `<form>` del logout se le pasa YA RENDERIZADO como prop,
        porque la server action vive acá y no puede importarse desde un
        'use client'.
      */}
      <Shell
        funnels={funnels}
        saldoPendiente={saldo.faltan.length > 0}
        seccionesPermitidas={sesion.secciones}
        nombre={sesion.nombre}
        salir={
          <form action={logoutAction}>
            {/* Link de texto en verde y no un botón con fondo: en el pie del
                sidebar, un botón con el mismo tratamiento que los ítems de
                navegación se lee como una décima sección en vez de como la
                salida. Así se ve que es una acción. */}
            <button
              type="submit"
              className="tap press rounded-lg px-1.5 py-1 text-sm font-medium text-good-400 transition-colors duration-250 hover:bg-good-900 hover:text-good-200"
            >
              Salir
            </button>
          </form>
        }
      >
        {children}
      </Shell>

      {/*
        Fuera del `reveal` del <main>: el aviso no es contenido de la pantalla y
        no tiene que entrar en la animación escalonada de las tarjetas. Se
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
