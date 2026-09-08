/**
 * `/cambiar-clave` — el cambio de clave, OBLIGATORIO la primera vez.
 *
 * FUERA del grupo `(panel)` a propósito (como `app/page.tsx`): si estuviera
 * adentro, el layout de T03 la protegería y, como redirige a `/cambiar-clave`
 * cuando `debeCambiarClave` es true, entraría en un bucle infinito.
 *
 * El server action `cambiarClaveAction`:
 *   - Lee la sesión REAL (`sesionActual`), no confía en que ya esté validada.
 *   - Pide la clave ACTUAL y la verifica contra el hash guardado. Sin eso, una
 *     sesión robada o una máquina desbloqueada cambia la clave y te deja afuera
 *     de tu propio panel.
 *   - Valida el mínimo `MIN_LARGO_CLAVE` (15) EN EL SERVER: el `minLength` del
 *     input es comodidad, un POST directo lo ignora.
 *   - La nueva no puede ser igual a la actual: si no, "cambiar la clave" se
 *     satisface con `123456` otra vez y `debe_cambiar_clave` pasa a false con la
 *     clave por defecto puesta — el agujero de D8 quedándose abierto.
 *   - Al terminar: `debe_cambiar_clave = false` y RE-FIRMA la cookie (ts nuevo).
 *
 * Si `debeCambiarClave` es true, la pantalla NO TIENE SALIDA (nada de link a
 * `/resumen` ni botón "después"): es la mitigación de D8 y un escape la anula.
 * El botón Salir sí queda.
 *
 * Es un server component (necesita el server action y leer la sesión). El
 * contador de caracteres es la única pieza interactiva y va con un <script>
 * inline chico, no con un componente client aparte: la ownership de esta task
 * es exactamente este archivo, y un componente client sería un archivo nuevo.
 */

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { PanelLogo } from '@/components/PanelLogo';
import {
  MIN_LARGO_CLAVE,
  PANEL_COOKIE_NAME,
  hashearClave,
  sessionCookieOptions,
  signSessionToken,
  verificarClave,
} from '@/lib/auth';
import { sesionActual } from '@/lib/permisos';
import { cambiarClave, usuarioPorNombre } from '@/lib/queries/usuarios';

export const dynamic = 'force-dynamic';

type SearchParams = { [key: string]: string | string[] | undefined };

const INPUT_CLS =
  'mt-2 w-full rounded-xl border border-border-strong bg-canvas/60 px-3.5 py-2.5 text-sm text-neutral-100 shadow-[inset_0_1px_2px_0_rgba(4,6,14,0.5)] transition-colors duration-250 placeholder:text-neutral-600 hover:border-overlay/16 focus:border-good-500/60';

async function cambiarClaveAction(formData: FormData): Promise<void> {
  'use server';

  const sesion = await sesionActual();
  if (!sesion) {
    redirect('/');
  }
  // El fallback de D10 (usuarioId 0) no tiene fila ni clave propia que cambiar:
  // no puede usar esta pantalla. Se lo manda al panel.
  if (sesion.esFallback || sesion.usuarioId === 0) {
    redirect('/resumen');
  }

  const actualRaw = formData.get('claveActual');
  const nuevaRaw = formData.get('claveNueva');
  const repeticionRaw = formData.get('claveRepeticion');
  const claveActual = typeof actualRaw === 'string' ? actualRaw : '';
  const claveNueva = typeof nuevaRaw === 'string' ? nuevaRaw : '';
  const claveRepeticion = typeof repeticionRaw === 'string' ? repeticionRaw : '';

  // Traemos el hash por el NOMBRE de la sesión (es lo único que expone el hash).
  // Verificar la actual contra la sesión real y no confiar en que ya se validó.
  const fila = await usuarioPorNombre(sesion.usuario);
  if (!fila || fila.id !== sesion.usuarioId) {
    redirect('/?error=1');
  }

  const actualOk = await verificarClave(claveActual, fila.claveHash);
  if (!actualOk) {
    redirect('/cambiar-clave?error=actual');
  }

  // Mínimo validado EN EL SERVER.
  if (claveNueva.length < MIN_LARGO_CLAVE) {
    redirect('/cambiar-clave?error=corta');
  }

  if (claveNueva !== claveRepeticion) {
    redirect('/cambiar-clave?error=repeticion');
  }

  // La nueva NO puede ser igual a la actual (compara la clave en claro contra el
  // hash de la actual: si matchea, es la misma).
  const esLaMisma = await verificarClave(claveNueva, fila.claveHash);
  if (esLaMisma) {
    redirect('/cambiar-clave?error=igual');
  }

  const hash = await hashearClave(claveNueva);
  await cambiarClave(sesion.usuarioId, hash); // baja debe_cambiar_clave a false

  // RE-FIRMAR la cookie: el ts nuevo renueva las 12 h y, sobre todo, saca a la
  // sesión del estado "pendiente" en el request siguiente.
  const token = signSessionToken(sesion.usuarioId);
  if (token) {
    cookies().set({
      name: PANEL_COOKIE_NAME,
      value: token,
      ...sessionCookieOptions(),
    });
  }

  redirect('/resumen');
}

async function salirAction(): Promise<void> {
  'use server';
  cookies().delete(PANEL_COOKIE_NAME);
  redirect('/');
}

export default async function CambiarClavePage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const sesion = await sesionActual();
  if (!sesion) {
    redirect('/');
  }
  if (sesion.esFallback || sesion.usuarioId === 0) {
    redirect('/resumen');
  }

  const error = typeof searchParams?.error === 'string' ? searchParams?.error : undefined;
  const mensajeError = MENSAJES_ERROR[error ?? ''] ?? undefined;

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
          {sesion.debeCambiarClave ? 'Cambiá tu contraseña' : 'Cambiar contraseña'}
        </h1>
        <p className="mt-1.5 max-w-[44ch] text-pretty text-sm leading-relaxed text-neutral-400">
          {sesion.debeCambiarClave
            ? `Es tu primer ingreso: elegí una contraseña propia de al menos ${MIN_LARGO_CLAVE} caracteres para poder usar el panel.`
            : `Elegí una contraseña nueva de al menos ${MIN_LARGO_CLAVE} caracteres. Tenés que ingresar la actual para confirmar.`}
        </p>

        <form action={cambiarClaveAction} className="mt-6 space-y-3.5">
          <label className="block">
            <span className="block text-sm font-medium text-neutral-300">Contraseña actual</span>
            <input
              type="password"
              name="claveActual"
              autoComplete="current-password"
              autoFocus
              required
              className={INPUT_CLS}
              placeholder="tu contraseña actual"
            />
          </label>

          <label className="block">
            <span className="block text-sm font-medium text-neutral-300">Contraseña nueva</span>
            <input
              id="clave-nueva"
              type="password"
              name="claveNueva"
              autoComplete="new-password"
              required
              minLength={MIN_LARGO_CLAVE}
              className={INPUT_CLS}
              placeholder="mínimo 15 caracteres"
            />
            {/*
              El contador es visible porque 15 es más de lo que la gente espera:
              sin él, la mitad de los intentos fallan sin saber por qué. Empieza
              en 0 y el <script> de abajo lo actualiza al tipear. `aria-live`
              para que un lector de pantalla lo anuncie.
            */}
            <span
              id="clave-contador"
              aria-live="polite"
              className="mt-1.5 block text-xs text-neutral-500"
            >
              0 / {MIN_LARGO_CLAVE} caracteres
            </span>
          </label>

          <label className="block">
            <span className="block text-sm font-medium text-neutral-300">Repetir la nueva</span>
            <input
              type="password"
              name="claveRepeticion"
              autoComplete="new-password"
              required
              minLength={MIN_LARGO_CLAVE}
              className={INPUT_CLS}
              placeholder="repetí la contraseña nueva"
            />
          </label>

          {mensajeError && (
            <p
              className="rounded-xl border border-bad-500/22 bg-bad-500/[0.09] px-3.5 py-2.5 text-sm text-bad-200"
              role="alert"
            >
              {mensajeError}
            </p>
          )}

          <button
            type="submit"
            className="press w-full rounded-xl bg-gradient-to-b from-good-400 to-good-600 px-3 py-2.5 text-sm font-semibold text-canvas shadow-glow-good transition-[filter,box-shadow] duration-250 hover:brightness-110"
          >
            Cambiar contraseña
          </button>
        </form>

        {/*
          Contador de caracteres, en vanilla JS: el único bit interactivo de la
          pantalla. Va inline y no en un componente client porque la ownership
          de esta task es sólo este archivo (crear un .tsx client sería un
          archivo nuevo fuera de la lista). El tono pasa a `good` cuando llega al
          mínimo, además del texto, para no depender sólo del color.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function () {
                var min = ${MIN_LARGO_CLAVE};
                var input = document.getElementById('clave-nueva');
                var out = document.getElementById('clave-contador');
                if (!input || !out) return;
                function upd() {
                  var n = input.value.length;
                  out.textContent = n + ' / ' + min + ' caracteres';
                  out.className = 'mt-1.5 block text-xs ' + (n >= min ? 'text-good-400' : 'text-neutral-500');
                }
                input.addEventListener('input', upd);
                upd();
              })();
            `,
          }}
        />

        {/*
          La ÚNICA salida es Salir. No hay link a /resumen ni botón "después":
          si `debeCambiarClave` es true, un escape anularía la mitigación de D8.
          El botón Salir queda siempre (cerrar sesión es legítimo).
        */}
        <form action={salirAction} className="mt-4">
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

const MENSAJES_ERROR: Record<string, string> = {
  actual: 'La contraseña actual no es correcta.',
  corta: `La contraseña nueva es demasiado corta (mínimo ${MIN_LARGO_CLAVE} caracteres).`,
  repeticion: 'La contraseña nueva y su repetición no coinciden.',
  igual: 'La contraseña nueva no puede ser igual a la actual.',
};
