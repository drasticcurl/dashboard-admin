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
    <div className="flex min-h-screen items-center justify-center bg-[#0a0a0f] px-4 text-neutral-100 antialiased">
      <div className="w-full max-w-md rounded-2xl border border-white/[0.06] bg-[#13131a] p-6 shadow-2xl">
        <div className="mb-4 flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-emerald-500 text-sm font-bold text-white shadow-lg shadow-violet-500/20">
            P
          </span>
          <span className="text-sm font-semibold text-neutral-300">Dashboard interno</span>
        </div>
        <h1 className="text-lg font-semibold text-neutral-50">Acceso al panel</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Esta sección es privada. Ingresá la contraseña para continuar.
        </p>

        <form action={loginAction} className="mt-5 space-y-3">
          <label className="block">
            <span className="block text-sm font-medium text-neutral-300">
              Contraseña
            </span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              autoFocus
              required
              className="mt-1.5 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
              placeholder="••••••••••••••••••••••••"
            />
          </label>

          <button
            type="submit"
            className="w-full rounded-xl bg-emerald-500 px-3 py-2 text-sm font-semibold text-emerald-950 transition-colors hover:bg-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:ring-offset-2 focus:ring-offset-[#0a0a0f]"
          >
            Ingresar
          </button>

          {error && (
            <p className="text-sm text-rose-400" role="alert">
              Contraseña incorrecta.
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
