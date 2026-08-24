/**
 * `/` — login del panel.
 *
 * Sin auth: form de login (server action `loginAction`), mismo patrón que
 * `app/admin/page.tsx` de los funnels:
 *   - Rate limit por IP (5 intentos / 15 min) en `lib/auth.ts`.
 *   - Comparación timing-safe.
 *   - Cookie firmada con HMAC-SHA256(ts, DASHBOARD_PASSWORD).
 *   - Mensaje de error genérico para no leakear estado (ni "password mala"
 *     vs "rate limit", ni si la password está configurada).
 *
 * Con auth: redirect a `/resumen`.
 */

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { PanelLogo } from '@/components/PanelLogo';
import {
  PANEL_COOKIE_NAME,
  checkLoginRateLimit,
  getClientIp,
  isAuthenticated,
  resetLoginRateLimit,
  sessionCookieOptions,
  signSessionToken,
  verifyPassword,
} from '@/lib/auth';

export const dynamic = 'force-dynamic';

type SearchParams = { [key: string]: string | string[] | undefined };

async function loginAction(formData: FormData): Promise<void> {
  'use server';

  // La IP sale de `x-real-ip` (la setea Caddy con {client_ip}); en dev local
  // sin proxy cae al último token de x-forwarded-for o 'unknown'.
  const h = headers();
  const ip = getClientIp({ get: (name: string): string | null => h.get(name) });

  const rl = checkLoginRateLimit(ip);
  if (!rl.allowed) {
    redirect('/?error=1');
  }

  const password = formData.get('password');
  const passStr = typeof password === 'string' ? password : '';

  if (!verifyPassword(passStr)) {
    redirect('/?error=1');
  }

  const token = signSessionToken();
  if (!token) {
    // Sin password configurada el sign devuelve null: el login falla cerrado.
    redirect('/?error=1');
  }

  resetLoginRateLimit(ip);

  cookies().set({
    name: PANEL_COOKIE_NAME,
    value: token,
    ...sessionCookieOptions(),
  });

  redirect('/resumen');
}

export default function LoginPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const authed = isAuthenticated(cookies());

  if (authed) {
    redirect('/resumen');
  }

  const error = typeof searchParams?.error === 'string' ? searchParams?.error : undefined;

  return (
    /*
      El login era una foto del panel ANTES de que existieran los tokens: los
      dos colores de fondo escritos como hex crudos, los bordes como alfas de
      blanco a mano, el acento y el error tomados directo de la paleta de
      Tailwind en lugar de los tonos semánticos del panel, y el logo como la
      letra "P" cuando el resto del panel ya usaba el icono. Ahora no define
      ningún color propio: todo sale de los tokens y el logo es el componente
      compartido.
    */
    <main className="relative flex min-h-dvh items-center justify-center bg-canvas px-4 text-neutral-100 antialiased">
      <div aria-hidden className="aurora" />
      <div aria-hidden className="grain" />

      {/*
        La tarjeta es de VIDRIO acá y no en el resto del panel porque es lo
        único que hay en pantalla: el blur recoge la luz ambiental del fondo, y
        es lo que hace que la primera pantalla se vea como un objeto apoyado
        sobre el fondo en lugar de un recuadro sobre un color.
      */}
      <div className="glass sheen w-full max-w-md rounded-3xl border border-border-subtle p-7">
        <div className="mb-5 flex items-center gap-2.5">
          <PanelLogo size="md" />
          <span className="text-sm font-semibold text-neutral-300">Dashboard interno</span>
        </div>

        <h1 className="text-[1.5rem] font-semibold -tracking-[0.02em] text-neutral-50">
          Acceso al panel
        </h1>
        <p className="mt-1.5 max-w-[42ch] text-pretty text-sm leading-relaxed text-neutral-400">
          Esta sección es privada. Ingresá la contraseña para continuar.
        </p>

        <form action={loginAction} className="mt-6 space-y-3.5">
          <label className="block">
            <span className="block text-sm font-medium text-neutral-300">Contraseña</span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              autoFocus
              required
              /* El anillo de foco lo da el `:focus-visible` global. Acá sólo
                 viaja el cambio de borde, que es la señal de "estoy escribiendo
                 en este campo" y sobrevive al click del mouse. */
              className="mt-2 w-full rounded-xl border border-border-strong bg-canvas/60 px-3.5 py-2.5 text-sm text-neutral-100 shadow-[inset_0_1px_2px_0_rgba(4,6,14,0.5)] transition-colors duration-250 placeholder:text-neutral-600 hover:border-overlay/16 focus:border-good-500/60"
              placeholder="••••••••••••••••••••••••"
            />
          </label>

          <button
            type="submit"
            className="press w-full rounded-xl bg-gradient-to-b from-good-400 to-good-600 px-3 py-2.5 text-sm font-semibold text-canvas shadow-glow-good transition-[filter,box-shadow] duration-250 hover:brightness-110"
          >
            Ingresar
          </button>

          {error && (
            /*
              El mensaje es genérico a propósito: no distingue contraseña mala
              de rate limit, para no filtrar en qué estado está el login. Lo que
              cambió es la forma — antes era una línea de texto roja suelta que
              se podía perder de vista; ahora es un bloque teñido con el tono
              `bad`, que es el mismo lenguaje de error del resto del panel.
            */
            <p
              className="rounded-xl border border-bad-500/22 bg-bad-500/[0.09] px-3.5 py-2.5 text-sm text-bad-200"
              role="alert"
            >
              No pudimos validar esa contraseña. Probá de nuevo.
            </p>
          )}
        </form>
      </div>
    </main>
  );
}
