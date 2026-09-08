/**
 * `/` — login del panel.
 *
 * Desde la migración 030 el login es por USUARIO + clave (antes era una sola
 * contraseña compartida). El server action `loginAction`:
 *   - Rate limit por IP (5 intentos / 15 min) en `lib/auth.ts`.
 *   - Busca el usuario por nombre normalizado (`usuarioPorNombre`).
 *   - FALLBACK D10: con la tabla `usuarios` VACÍA, DASHBOARD_PASSWORD sigue
 *     valiendo y esa sesión es admin (usuarioId 0). Se apaga solo en cuanto hay
 *     una fila. Lo resuelve `intentarFallback()` de `lib/permisos.ts`.
 *   - Verifica la clave con scrypt (`verificarClave`, timing-safe).
 *   - Firma la cookie con el id del usuario (`signSessionToken(id)`, D1/D2).
 *   - Redirige a `/cambiar-clave` si `debeCambiarClave`, si no a `/resumen`.
 *
 * El mensaje de error es GENÉRICO para las CUATRO causas (usuario inexistente,
 * clave mala, campo vacío, rate limit): un login que dice "no existe ese
 * usuario" es un enumerador de usuarios gratis, y distinguir rate limit de
 * clave mala filtra en qué estado está el login. Mismo `?error=1` para todo.
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
  verificarClave,
} from '@/lib/auth';
import { intentarFallback } from '@/lib/permisos';
import { marcarLogin, usuarioPorNombre } from '@/lib/queries/usuarios';

export const dynamic = 'force-dynamic';

type SearchParams = { [key: string]: string | string[] | undefined };

async function loginAction(formData: FormData): Promise<void> {
  'use server';

  // El id que va a la cookie sale de acá, y se decide DESPUÉS de validar. Lo
  // guardamos afuera del try porque el `redirect` de Next tira una excepción
  // (así corta el flujo), y firmar/redirigir tiene que pasar fuera de cualquier
  // catch que se coma ese throw.
  let usuarioIdParaCookie: number | null = null;
  let redirigirA = '/resumen';

  // La IP sale de `x-real-ip` (la setea Caddy con {client_ip}); en dev local
  // sin proxy cae al último token de x-forwarded-for o 'unknown'.
  const h = headers();
  const ip = getClientIp({ get: (name: string): string | null => h.get(name) });

  const rl = checkLoginRateLimit(ip);
  if (!rl.allowed) {
    // Rate limit: mismo mensaje genérico, sin decir que es rate limit.
    redirect('/?error=1');
  }

  const usuarioRaw = formData.get('usuario');
  const passwordRaw = formData.get('password');
  // El usuario se normaliza con .trim().toLowerCase() ANTES de buscar: el CHECK
  // de la 030 exige la columna en minúsculas sin espacios, así que sin esto
  // "Lucho" no entra y no hay ningún error que lo explique.
  const usuario = typeof usuarioRaw === 'string' ? usuarioRaw.trim().toLowerCase() : '';
  const clave = typeof passwordRaw === 'string' ? passwordRaw : '';

  // Campo vacío: mismo mensaje genérico. No distingue de clave mala.
  if (usuario === '' || clave === '') {
    redirect('/?error=1');
  }

  const fila = await usuarioPorNombre(usuario);

  if (!fila) {
    // El usuario no existe. SÓLO en ese caso se prueba el fallback de D10, y
    // sólo si la tabla está vacía: `intentarFallback` chequea `contarUsuarios()
    // === 0` adentro y verifica la clave contra DASHBOARD_PASSWORD. No es "si no
    // encontré el usuario, probá con la vieja" — se apaga solo en cuanto hay una
    // fila. La consulta a la base sólo ocurre en esta rama (usuario no hallado),
    // no en cada login.
    const fallback = await intentarFallback(clave);
    if (fallback) {
      usuarioIdParaCookie = fallback.usuarioId; // 0
      redirigirA = '/resumen';
    } else {
      redirect('/?error=1');
    }
  } else {
    // El usuario existe: verificar la clave contra su hash (scrypt, timing-safe).
    const ok = await verificarClave(clave, fila.claveHash);
    if (!ok) {
      redirect('/?error=1');
    }
    usuarioIdParaCookie = fila.id;
    // Marca el último login sólo tras un login exitoso de un usuario real (el
    // fallback no tiene fila que marcar).
    await marcarLogin(fila.id);
    redirigirA = fila.debeCambiarClave ? '/cambiar-clave' : '/resumen';
  }

  // Si llegamos acá sin id, algo salió mal: fallar cerrado.
  if (usuarioIdParaCookie === null) {
    redirect('/?error=1');
  }

  const token = signSessionToken(usuarioIdParaCookie);
  if (!token) {
    // Sin secreto de firma configurado el sign devuelve null: el login falla
    // cerrado (nunca "entra cualquiera porque no hay secreto").
    redirect('/?error=1');
  }

  // El reset del rate limit SÓLO después de un login exitoso, como hoy.
  resetLoginRateLimit(ip);

  cookies().set({
    name: PANEL_COOKIE_NAME,
    value: token,
    ...sessionCookieOptions(),
  });

  redirect(redirigirA);
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
          Esta sección es privada. Ingresá tu usuario y contraseña para continuar.
        </p>

        <form action={loginAction} className="mt-6 space-y-3.5">
          <label className="block">
            <span className="block text-sm font-medium text-neutral-300">Usuario</span>
            <input
              type="text"
              name="usuario"
              autoComplete="username"
              autoFocus
              required
              /* El anillo de foco lo da el `:focus-visible` global. Acá sólo
                 viaja el cambio de borde, que es la señal de "estoy escribiendo
                 en este campo" y sobrevive al click del mouse. */
              className="mt-2 w-full rounded-xl border border-border-strong bg-canvas/60 px-3.5 py-2.5 text-sm text-neutral-100 shadow-[inset_0_1px_2px_0_rgba(4,6,14,0.5)] transition-colors duration-250 placeholder:text-neutral-600 hover:border-overlay/16 focus:border-good-500/60"
              placeholder="tu usuario"
            />
          </label>

          <label className="block">
            <span className="block text-sm font-medium text-neutral-300">Contraseña</span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
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
              El mensaje es genérico a propósito: no distingue usuario
              inexistente de clave mala de campo vacío de rate limit, para no
              filtrar en qué estado está el login ni permitir enumerar usuarios.
              El bloque va teñido con el tono `bad`, el mismo lenguaje de error
              del resto del panel.
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
