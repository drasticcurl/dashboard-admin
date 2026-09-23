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
import { Portal } from '@/components/Portal';

/** Lo que se puede enfocar adentro del modal, en orden de tabulación. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  titulo,
  descripcion,
  onCerrar,
  children,
  pie,
  ancho = 'md',
}: {
  titulo: string;
  /** Una línea que explica de qué es la sección. Se ata con aria-describedby. */
  descripcion?: string;
  onCerrar: () => void;
  children: ReactNode;
  /**
   * El pie FIJO: el resumen de lo que se va a guardar y los botones.
   *
   * Es una prop y no parte de `children` porque tiene que quedar FUERA del div
   * que scrollea. Cuando los botones viven adentro del cuerpo, un modal con 6
   * cuentas los empuja abajo del área visible y el único scroll que los trae de
   * vuelta es el del cuerpo — que nadie busca, porque un modal se lee como algo
   * que entra entero. Es el bug de «Corregir saldos» que el rediseño v3 vino a
   * arreglar: el botón de guardar existía y no se veía.
   */
  pie?: ReactNode;
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
    /* `Portal`: el overlay se cuelga del <body>. Es `fixed inset-0`, y dentro del
       árbol de la pantalla un ancestro animado le creaba containing block, así
       que medía contra el documento y no contra el viewport — el modal "cortado
       por la mitad" que se reportó. Ver components/Portal.tsx. */
    <Portal>
    <div
      /*
        `overflow-hidden` y no `overflow-y-auto`: el scroll del overlay era el
        parche que hacía "alcanzable" un modal más alto que la ventana, y es
        justo el que nadie encuentra. Con la tarjeta acotada a
        calc(100dvh - 48px) el overlay no necesita scrollear NUNCA, así que
        dejárselo habilitado sólo deja abierta la puerta a que el bug vuelva sin
        que nada se vea raro.

        `items-stretch` en mobile + `items-center` desde 760px: en mobile la
        tarjeta es una hoja que va de 24px del tope hasta abajo (handoff), y para
        eso tiene que poder estirarse.
      */
      className="fixed inset-0 z-modal flex items-stretch justify-center overflow-hidden bg-canvas/80 pt-6 backdrop-blur-sm panel:items-center panel:p-4"
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
          Tres partes: encabezado fijo, cuerpo con scroll, pie fijo. El techo de
          la tarjeta es `calc(100dvh - 48px)` (handoff v3): 24px de aire arriba y
          24 abajo, y NUNCA más alta que la ventana.

          `dvh` y no `vh` por lo mismo que `min-h-dvh` en el layout del panel:
          `100vh` en Safari de iOS cuenta la barra de direcciones que se esconde
          al scrollear, así que con `vh` el pie fijo queda tapado por la barra
          justo en el navegador donde el modal se usa con el pulgar.

          En mobile es una hoja: ocupa todo el ancho, arranca a 24px del tope
          (el `pt-6` del overlay) y llega hasta abajo, con las esquinas
          redondeadas sólo arriba. Desde 760px es una tarjeta centrada de
          min(560px, 100% − 32px), que es el `max-w-[560px]` + el `p-4` del
          overlay.
        */
        className={`flex max-h-[calc(100dvh-48px)] w-full flex-col overflow-hidden rounded-t-2xl border border-border-strong bg-surface shadow-float outline-none panel:my-auto panel:rounded-2xl ${
          ancho === 'lg' ? 'panel:max-w-4xl' : 'panel:max-w-[560px]'
        }`}
      >
        {/* Encabezado FIJO. `shrink-0` para que no lo aplaste el cuerpo, y el
            divisor abajo para que se lea como una franja y no como el borde de
            la primera fila del contenido.

            La descripción se ESCONDE debajo de 760px: medido a 390px, el
            encabezado con la descripción de tres líneas medía 125px, y entre eso
            y el pie al cuerpo le quedaban 474 de 844 — el modal se leía como
            "la mitad de un cuadro". El texto no se pierde: queda en el `title`
            del encabezado. */}
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-divider px-4 py-3 panel:px-5 panel:py-4">
          <div className="min-w-0" title={descripcion}>
            <h2 id={idTitulo} className="text-base font-medium -tracking-[0.01em] text-neutral-50">
              {titulo}
            </h2>
            {descripcion && (
              <p id={idDesc} className="mt-1 hidden text-xs text-neutral-500 panel:block">
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
            className="tap press shrink-0 rounded-lg border border-border-strong px-2.5 py-1.5 text-sm text-neutral-300 transition-colors duration-250 hover:bg-overlay/6 hover:text-neutral-100"
          >
            Cerrar{' '}
            <span aria-hidden className="ml-1 hidden text-neutral-500 panel:inline">
              Esc
            </span>
          </button>
        </div>
        {/*
          `min-h-0` NO es decorativo y es el 90% de este div: un hijo de flex
          tiene `min-height: auto`, o sea que se niega a encogerse por debajo de
          su contenido, así que sin esto el `overflow-y-auto` nunca se activa y la
          tarjeta desborda el `max-h` igual que antes. Es la trampa clásica de
          "puse overflow-auto y no scrollea".
        */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4 panel:px-5">{children}</div>
        {pie && (
          // El pie FIJO, fuera del scroll. `shrink-0` por el mismo motivo que el
          // encabezado. El `safe-area-inset-bottom` es para el iPhone: sin él la
          // barra de gestos del sistema se come la mitad del botón de guardar.
          <div className="shrink-0 border-t border-divider bg-surface p-4 pb-[max(1rem,env(safe-area-inset-bottom))] panel:px-5 panel:pb-4">
            {pie}
          </div>
        )}
      </div>
    </div>
    </Portal>
  );
}
