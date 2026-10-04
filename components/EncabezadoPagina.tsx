'use client';

/**
 * EncabezadoPagina — el bloque de arriba de cada pantalla: título grande y
 * subtítulo a la izquierda, filtros (funnel y período) a la derecha.
 *
 * ── Por qué los filtros viven acá y no en una barra aparte ──────────────────
 *
 * La primera pasada del rediseño los puso en una barra sticky propia, arriba del
 * encabezado. En las capturas de referencia van en la MISMA fila que el título,
 * y no es un detalle de gusto: la barra separada sumaba una franja de ~60px con
 * dos controles flotando solos, y en mobile hacía wrap y se comía 115px de alto
 * antes de que empezara el contenido. Acá los filtros se apoyan en algo.
 *
 * ── El subtítulo no es decorativo ───────────────────────────────────────────
 *
 * Dice QUÉ contesta la pantalla ("Dónde se cae la gente, paso por paso"), que es
 * justo lo que un título de una palabra no dice. Cada pantalla pasa el suyo.
 *
 * `children` es para lo que sea propio de la pantalla y tenga que ir en la fila
 * de los filtros: el toggle EUR/ARS de Ventas, el selector de asignado de
 * Tareas, el botón "Nueva tarea".
 */

import type { ReactNode } from 'react';
import type { Funnel } from '@/lib/funnels';
import { RangePicker } from '@/components/RangePicker';
import { SelectorFunnel } from '@/components/Nav';

export function EncabezadoPagina({
  titulo,
  subtitulo,
  funnels,
  conFunnel = true,
  conGeneral = false,
  conPeriodo = true,
  children,
  chip,
}: {
  titulo: string;
  /** Una línea que dice qué contesta la pantalla. */
  subtitulo?: string;
  /** Si no viene, no se dibuja el selector de funnel. */
  funnels?: Funnel[];
  conFunnel?: boolean;
  /** Suma «General» (todos los funnels) al selector: sólo el Resumen. */
  conGeneral?: boolean;
  conPeriodo?: boolean;
  /** Controles propios de la pantalla, a la izquierda de los filtros. */
  children?: ReactNode;
  /** Una pastilla al lado del título (el funnel activo, "todos los funnels"). */
  chip?: ReactNode;
}): JSX.Element {
  return (
    /*
      `items-start` y no `items-center`: con el subtítulo, el bloque de la
      izquierda mide dos líneas y centrar deja los <select> flotando a media
      altura del párrafo en lugar de alineados con el título.

      `gap-x-4 gap-y-3` + `flex-wrap`: en mobile los filtros bajan a su propia
      línea, que es lo que pide el handoff ("hacen wrap").
    */
    <div className="mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {/* `font-display` semibold con el tracking apretado (D6): a 26px el
              espaciado por defecto de Bricolage se ve suelto, y es el único
              título de la pantalla, así que puede tener voz propia. */}
          <h1 className="font-display text-[24px] font-semibold leading-tight -tracking-[0.03em] text-neutral-50 panel:text-[30px]">
            {titulo}
          </h1>
          {chip}
        </div>
        {/*
          La costura bajo el título: el segundo de los cuatro lugares de D7.
          48px y no el ancho del título, a propósito: es una puntada que firma
          la pantalla, no un subrayado que la mide. Va entre el título y el
          subtítulo porque cose las dos cosas: "qué pantalla" y "qué contesta".
        */}
        <span aria-hidden className="costura mt-2.5 block w-12 panel:mt-3" />
        {subtitulo && (
          <p className="mt-2 text-sm text-neutral-400 panel:mt-2.5">{subtitulo}</p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {children}
        {conFunnel && funnels && funnels.length > 0 && (
          <SelectorFunnel funnels={funnels} conGeneral={conGeneral} />
        )}
        {conPeriodo && <RangePicker />}
      </div>
    </div>
  );
}
