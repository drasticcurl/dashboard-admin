'use client';

/**
 * Modal — el contenedor de las secciones que /finanzas ya no muestra abiertas.
 *
 * La pantalla por defecto es sólo el patrimonio y su gráfico; cargar saldos,
 * movimientos, pagos programados y cuentas se abren desde un botón y viven acá
 * adentro.
 *
 * ── Por qué no se reusó DialogoConfirmacion ─────────────────────────────────
 *
 * `app/(panel)/anuncios/DialogoConfirmacion.tsx` es el otro modal del panel y
 * no sirve para esto: recibe una `Previsualizacion` de anuncios y trae su propio
 * checkbox de confirmación y sus botones Cancelar/Ejecutar. Es un diálogo de
 * confirmación, no un contenedor.
 *
 * Lo que sí se copió de él es el envoltorio visual, para que los dos modales del
 * panel se vean como el mismo objeto: `fixed inset-0` con `bg-canvas/80` y
 * `backdrop-blur-sm`, la tarjeta con `rounded-2xl border-border-strong bg-surface
 * shadow-float`, y `max-h-[90vh] overflow-y-auto`.
 *
 * Y lo que se AGREGÓ, porque acá adentro van formularios y no un sí/no:
 *
 *  · **Escape cierra.** Un formulario a pantalla completa sin salida por teclado
 *    es una trampa.
 *  · **El click en el fondo cierra**, pero sólo si empezó en el fondo
 *    (`onMouseDown` sobre el overlay, no `onClick`): con `onClick` a secas,
 *    arrastrar para seleccionar un texto de adentro y soltar afuera cerraba el
 *    modal y perdía lo tipeado.
 *  · **El foco entra al abrir y VUELVE al botón al cerrar.** Sin lo segundo, el
 *    foco se cae al `<body>` y quien navega con teclado tiene que tabular desde
 *    el principio del header cada vez que cierra una sección.
 *  · **El foco queda atrapado adentro** mientras está abierto. Sin esto, Tab
 *    sigue recorriendo las tabs del panel que están detrás del overlay y no se
 *    pueden ver.
 *  · **El scroll del fondo se bloquea.** Sin esto, la rueda del mouse scrollea
 *    la página de atrás y el modal parece pegado.
 *
 * No se usó el `<dialog>` nativo (que daría varias de estas gratis) porque su
 * `::backdrop` no acepta las utilidades de Tailwind del panel y habría que
 * escribir CSS suelto para el fondo: quedaría un modal que no se ve como el otro.
 */

import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';

/** Lo que se puede enfocar adentro del modal, en orden de tabulación. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  titulo,
  descripcion,
  onCerrar,
  children,
  ancho = 'md',
}: {
  titulo: string;
  /** Una línea que explica de qué es la sección. Se ata con aria-describedby. */
  descripcion?: string;
  onCerrar: () => void;
  children: ReactNode;
  /** `lg` para las secciones con tabla; `md` para un formulario solo. */
  ancho?: 'md' | 'lg';
}): JSX.Element {
  const caja = useRef<HTMLDivElement>(null);
  const idTitulo = useId();
  const idDesc = useId();

  // Se guarda quién tenía el foco ANTES de abrir para devolvérselo al cerrar.
  const focoPrevio = useRef<HTMLElement | null>(null);

  useEffect(() => {
    focoPrevio.current = document.activeElement as HTMLElement | null;

    // El primer control del modal, o la caja: enfocar la caja alcanza para que
    // el lector de pantalla anuncie el título, y evita que el foco arranque en
    // el botón de cerrar (que es lo último que la persona quiere hacer).
    const primero = caja.current?.querySelector<HTMLElement>(FOCUSABLE);
    (primero ?? caja.current)?.focus();

    const overflowPrevio = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = overflowPrevio;
      // `?.` y no `!`: el botón que abrió el modal puede haber desaparecido del
      // DOM mientras estaba abierto (por ejemplo, si se borró la cuenta que lo
      // mostraba), y enfocar un nodo huérfano tira.
      focoPrevio.current?.focus?.();
    };
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCerrar();
        return;
      }
      if (e.key !== 'Tab') return;

      // Trampa de foco: en el último elemento, Tab vuelve al primero; en el
      // primero, Shift+Tab va al último.
      const focusables = Array.from(caja.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (focusables.length === 0) return;
      const primero = focusables[0]!;
      const ultimo = focusables[focusables.length - 1]!;
      const activo = document.activeElement;

      if (!e.shiftKey && activo === ultimo) {
        e.preventDefault();
        primero.focus();
      } else if (e.shiftKey && activo === primero) {
        e.preventDefault();
        ultimo.focus();
      }
    },
    [onCerrar],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-canvas/80 p-4 backdrop-blur-sm sm:items-center"
      // `onMouseDown` en el overlay y el chequeo de target: cierra sólo cuando
      // el gesto EMPEZÓ en el fondo. Con onClick, seleccionar texto de adentro
      // y soltar afuera cerraba el modal y perdía lo tipeado.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCerrar();
      }}
      onKeyDown={onKeyDown}
    >
      <div
        ref={caja}
        role="dialog"
        aria-modal="true"
        aria-labelledby={idTitulo}
        aria-describedby={descripcion ? idDesc : undefined}
        tabIndex={-1}
        className={`my-auto w-full ${
          ancho === 'lg' ? 'max-w-4xl' : 'max-w-xl'
        } rounded-2xl border border-border-strong bg-surface p-5 shadow-float outline-none`}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 id={idTitulo} className="text-base font-semibold -tracking-[0.01em] text-neutral-50">
              {titulo}
            </h2>
            {descripcion && (
              <p id={idDesc} className="mt-1 text-xs text-neutral-500">
                {descripcion}
              </p>
            )}
          </div>
          {/*
            Dice "Cerrar" con texto y no sólo una X: es el único control de
            salida visible y un icono suelto obliga a adivinar. El atajo se
            anuncia al lado porque Escape no se descubre solo.
          */}
          <button
            type="button"
            onClick={onCerrar}
            className="press shrink-0 rounded-lg border border-border-strong px-2.5 py-1.5 text-sm text-neutral-300 transition-colors duration-250 hover:bg-overlay/6 hover:text-neutral-100"
          >
            Cerrar <span aria-hidden className="ml-1 text-neutral-500">Esc</span>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
