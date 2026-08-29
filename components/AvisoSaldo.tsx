'use client';

/**
 * AvisoSaldo — el recordatorio de cargar el saldo del día, en cualquier pantalla
 * del panel.
 *
 * El patrimonio de /finanzas se mide a mano una vez al día, y un día al que le
 * falta una cuenta NO tiene patrimonio: no aparece en el gráfico y el número
 * grande queda en "sin información". O sea que olvidarse no degrada el dato,
 * lo borra. Por eso el aviso vive en el layout y no en /finanzas: si sólo se
 * viera adentro de Finanzas, habría que entrar para acordarse de entrar.
 *
 * ── Por qué NO es una notificación del navegador ────────────────────────────
 *
 * La API `Notification` necesita permiso explícito, y el prompt del browser
 * aparece descolgado de cualquier contexto la primera vez. Además no sirve para
 * lo que se necesita: una notificación del sistema aparece cuando la pestaña
 * está cerrada, y este aviso sólo tiene sentido cuando la persona ya está
 * adentro del panel y a un click de resolverlo. Queda como opción si algún día
 * se quiere avisar sin tener el panel abierto — eso sería un bot de Telegram,
 * que ya existe para anuncios, y no esto.
 *
 * ── Cuándo aparece y cuándo se calla ───────────────────────────────────────
 *
 * Aparece al entrar al panel, con un retraso corto para no competir con la
 * primera pintura. Se cierra a mano y NO vuelve a molestar ese día: la marca va
 * en `localStorage` con la fecha del panel como clave, así que mañana vuelve
 * sola sin necesitar que nadie limpie nada.
 *
 * `localStorage` y no `sessionStorage` a propósito: con sessionStorage el aviso
 * reaparece en cada pestaña nueva, y el caso normal es tener el panel abierto en
 * varias.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const CLAVE = 'panel:aviso-saldo-descartado';

export function AvisoSaldo({ faltan, hoy }: { faltan: string[]; hoy: string }): JSX.Element | null {
  const [visible, setVisible] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    if (faltan.length === 0) return;
    // Adentro de /finanzas no hace falta: el botón «Cargar saldo de hoy» ya está
    // amarillo y latiendo a la vista. Dos avisos de lo mismo en la misma
    // pantalla se anulan entre sí.
    if (pathname?.startsWith('/finanzas')) return;

    let descartadoHoy = false;
    try {
      descartadoHoy = window.localStorage.getItem(CLAVE) === hoy;
    } catch {
      // Safari en modo privado tira al tocar localStorage. Sin el catch, el
      // aviso se cae entero y no avisa nada; así, en el peor caso, aparece cada
      // vez, que es el lado seguro para un recordatorio.
    }
    if (descartadoHoy) return;

    // 900 ms: el aviso entra después de que la pantalla terminó de aparecer (el
    // `reveal` del layout escalona hasta ~400 ms). Apareciendo junto con el
    // contenido se lee como parte de la página y se ignora.
    const t = setTimeout(() => setVisible(true), 900);
    return () => clearTimeout(t);
  }, [faltan.length, hoy, pathname]);

  if (!visible || faltan.length === 0) return null;

  const cerrar = (): void => {
    setVisible(false);
    try {
      window.localStorage.setItem(CLAVE, hoy);
    } catch {
      // Si no se puede recordar el descarte, el aviso vuelve en la próxima
      // navegación. Molesto, pero no roto.
    }
  };

  const n = faltan.length;

  return (
    /*
      `role="status"` y no `role="alert"`: alert interrumpe al lector de pantalla
      en el medio de lo que esté leyendo, y esto es un recordatorio, no una
      emergencia. `aria-live="polite"` (implícito en status) lo anuncia cuando
      la persona termina la frase en curso.

      `fixed bottom-4 right-4`: abajo a la derecha, fuera del camino del
      contenido y del header. En mobile ocupa el ancho menos los márgenes.
    */
    <div
      role="status"
      className="animate-rise-in fixed bottom-4 left-4 right-4 z-40 sm:left-auto sm:right-4 sm:max-w-sm"
    >
      <div className="rounded-2xl border border-warn-500/30 bg-surface-raised/95 p-4 shadow-float backdrop-blur-sm">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-semibold text-warn-200">
            Falta el saldo de hoy
          </p>
          <button
            type="button"
            onClick={cerrar}
            aria-label="Descartar el aviso por hoy"
            className="press -mr-1 -mt-1 shrink-0 rounded-lg px-2 py-1 text-xs text-neutral-400 transition-colors duration-250 hover:bg-overlay/8 hover:text-neutral-100"
          >
            Después
          </button>
        </div>

        <p className="mt-1.5 text-xs text-neutral-400">
          {n === 1 ? `Falta cargar ${faltan[0]}.` : `Faltan ${n} cuentas: ${faltan.join(', ')}.`}{' '}
          Hasta que estén todas, hoy no tiene patrimonio y no entra en el gráfico.
        </p>

        <Link
          href="/finanzas"
          onClick={cerrar}
          className="press mt-3 inline-flex items-center rounded-lg border border-warn-500/30 bg-warn-500/10 px-3 py-1.5 text-sm font-semibold text-warn-200 transition-colors duration-250 hover:bg-warn-500/20"
        >
          Cargar ahora
        </Link>
      </div>
    </div>
  );
}
