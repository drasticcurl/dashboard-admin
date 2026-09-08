/**
 * `/sin-acceso` — el usuario entró pero no tiene NINGUNA sección asignada.
 *
 * FUERA del grupo `(panel)` a propósito (como `app/page.tsx` y `/cambiar-clave`):
 * si estuviera adentro, el layout de T03 la protegería y `requerirSeccion`
 * redirige acá cuando el usuario no tiene ninguna sección — un bucle.
 *
 * Una pantalla, un párrafo y el botón Salir. SIN links a nada del panel: no
 * puede entrar a nada, así que un link sólo lo mandaría a un redirect.
 */

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { PanelLogo } from '@/components/PanelLogo';
import { PANEL_COOKIE_NAME } from '@/lib/auth';

export const dynamic = 'force-dynamic';

async function salirAction(): Promise<void> {
  'use server';
  cookies().delete(PANEL_COOKIE_NAME);
  redirect('/');
}

export default function SinAccesoPage() {
  return (
    <main className="relative flex min-h-dvh items-center justify-center bg-canvas px-4 text-neutral-100 antialiased">
      <div aria-hidden className="aurora" />
      <div aria-hidden className="grain" />

      <div className="glass sheen w-full max-w-md rounded-3xl border border-border-subtle p-7">
        <div className="mb-5 flex items-center gap-2.5">
          <PanelLogo size="md" />
          <span className="text-sm font-semibold text-neutral-300">Dashboard interno</span>
        </div>

        <h1 className="text-[1.5rem] font-semibold -tracking-[0.02em] text-neutral-50">
          Todavía no tenés acceso
        </h1>
        <p className="mt-1.5 max-w-[46ch] text-pretty text-sm leading-relaxed text-neutral-400">
          Tu usuario no tiene ninguna sección asignada. Pedile a un administrador
          que te habilite las pestañas que necesitás y volvé a entrar.
        </p>

        {/* Sin links a nada del panel: no puede entrar a ninguna sección. La
            única acción es cerrar sesión. */}
        <form action={salirAction} className="mt-6">
          <button
            type="submit"
            className="press w-full rounded-xl border border-border-strong bg-surface-raised px-3 py-2.5 text-sm font-semibold text-neutral-300 shadow-inset-highlight transition-colors duration-250 hover:border-overlay/16 hover:bg-surface-overlay hover:text-neutral-100"
          >
            Salir
          </button>
        </form>
      </div>
    </main>
  );
}
