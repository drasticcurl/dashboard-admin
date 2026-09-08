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
 * `backdrop-blur-sm`, y la tarjeta con `rounded-2xl border-border-strong
 * bg-surface shadow-float`.
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
 *  · **La tarjeta tiene techo y scrollea POR DENTRO.** Un modal que crece hasta
 *    donde quiera el contenido deja los botones fuera de pantalla en cualquier
 *    laptop, y el único scroll disponible era el del overlay: nadie lo busca.
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
        /*
          `max-h` + `flex-col` + el scroll ADENTRO, no en el overlay.
          Antes la tarjeta no tenía techo y crecía todo lo que pedía el
          contenido: el scroll lo hacía el overlay, así que en un viewport de
          laptop (~670px de alto) el detalle de una tarea —formulario + enlaces +
          comentarios + borrar— quedaba con la mitad fuera de pantalla y el botón
          de guardar sólo aparecía scrolleando el fondo, que es lo que nadie
          intenta cuando ve un modal. Con el techo, la tarjeta SIEMPRE entra, el
          encabezado y el botón Cerrar quedan fijos, y lo que se mueve es el
          contenido.

          `dvh` y no `vh` por lo mismo que `min-h-dvh` en el layout del panel:
          `100vh` en Safari de iOS cuenta la barra de direcciones que se esconde.
          El `-2rem` es el `p-4` del overlay: sin restarlo la tarjeta mide el
          viewport entero y se come su propio margen.

          El molde es el modal de `anuncios/reglas/ReglasView.tsx`, que ya
          resolvía esto con `max-h-[calc(100vh-2rem)] flex-col overflow-hidden`.
        */
        className={`my-auto flex max-h-[calc(100dvh-2rem)] w-full flex-col ${
          ancho === 'lg' ? 'max-w-4xl' : 'max-w-xl'
        } rounded-2xl border border-border-strong bg-surface p-5 shadow-float outline-none`}
      >
        <div className="mb-4 flex shrink-0 items-start justify-between gap-4">
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
        {/*
          `min-h-0` NO es decorativo y es el 90% de este div: un hijo de flex
          tiene `min-height: auto`, o sea que se niega a encogerse por debajo de
          su contenido, así que sin esto el `overflow-y-auto` nunca se activa y la
          tarjeta desborda el `max-h` igual que antes. Es la trampa clásica de
          "puse overflow-auto y no scrollea".

          `-mr-2 pr-2` mete la barra de scroll adentro del padding de la tarjeta,
          para que no corte el borde derecho de los inputs.
        */}
        <div className="-mr-2 min-h-0 flex-1 overflow-y-auto pr-2">{children}</div>
      </div>
    </div>
  );
}
