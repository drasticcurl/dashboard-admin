'use client';

/**
 * PopoverFila — la edición contextual de UNA fila de la tabla de Anuncios
 * (handoff del rediseño v3, §Interacciones: «el fix principal de UX»).
 *
 * ── Qué problema resuelve ───────────────────────────────────────────────────
 *
 * Antes, editar el presupuesto de la fila 14 abría un formulario a mitad de
 * página, lejos de la fila. Con 14 columnas y filas que se llaman
 * `CH-ES-ABO-VID-03 | Intereses | 25-34`, mirar el formulario y volver a la
 * fila para confirmar que era la correcta era el gesto normal — y el formulario
 * no decía de qué fila venía. Editar el presupuesto de la fila equivocada es
 * plata.
 *
 * Este popover se abre PEGADO a la fila y se mueve con ella al scrollear,
 * porque está `position:absolute` dentro del marco de la tabla (no `fixed`
 * contra el viewport). Es la diferencia entre "un formulario que habla de una
 * fila" y "un formulario que sale de una fila".
 *
 * ── Por qué NO escribe directo ──────────────────────────────────────────────
 *
 * Guardar un presupuesto o un nombre desde acá NO llama al Endpoint_Acciones:
 * llama al mismo `onEditarPresupuesto` / `onRenombrar` que ya usaba la celda, y
 * ese abre el Dialogo_Confirmacion con la Previsualizacion.
 *
 * Es deliberado y es lo único que hace que este cambio sea seguro: la cadena
 * previa → confirmación → ejecución es la que tiene los tests de montos
 * (`presupuesto.preservacion.test.ts`, `acciones.margen.test.ts`, el techo de
 * `maxPresupuesto`). Un popover que mandara el POST por su cuenta se saltearía
 * las cuatro validaciones y el único aviso sería el importe ya aplicado en
 * Meta. Acá el popover es la ENTRADA —mejor ubicada y con mejor input—, no un
 * camino nuevo hasta la API.
 *
 * ── Por qué el cálculo de posición es una función aparte ────────────────────
 *
 * `vitest.config.ts` corre en node, sin jsdom: la única forma de fijar con un
 * test que el popover no se sale de la pantalla es que la aritmética viva fuera
 * del JSX. Es el mismo criterio que `frescuraDeFila` y `accionDeToggle`.
 */

import { useEffect, useRef, useState } from 'react';
import {
  CopySimple,
  CurrencyDollar,
  Pause,
  Play,
  TextAa,
} from '@phosphor-icons/react';
import type { MetricasObjeto } from '@/lib/ads/tipos';
import { fmtMoney } from '@/components/ui';
import { MONEDA_REPORTE, SIMBOLO_REPORTE } from '@/lib/moneda-reporte';
import { motivoPresupuestoNoEditable } from './celdas';

/** El ancho del popover en desktop (handoff: 288px). */
export const ANCHO_POPOVER = 288;

/** Aire entre la fila y el popover. */
const AIRE = 6;

/** Margen mínimo contra el canto del marco, para que no quede al ras. */
const MARGEN = 8;

/** Qué está mostrando el popover. */
export type VistaPopover = 'menu' | 'presupuesto' | 'renombrar';

export type EstadoPopover = {
  vista: VistaPopover;
  /** `objectId` de la fila. Es lo que resalta la fila y lo que cierra al cambiar de página. */
  filaId: string;
  top: number;
  left: number;
};

/**
 * Dónde va el popover, en coordenadas del marco de la tabla.
 *
 * Todo entra en píxeles y sale en píxeles: no lee el DOM ni `window`. Los
 * rectángulos son los de `getBoundingClientRect()` (relativos al viewport) y el
 * resultado es relativo al marco, que es lo que necesita un `position:absolute`
 * adentro de él.
 *
 * Las dos decisiones que el test fija:
 *
 *  · **Si no entra abajo, se abre ARRIBA de la fila.** El caso real es la
 *    última fila de la página: abajo no hay 300px y el popover quedaría con los
 *    botones Cancelar/Guardar fuera de la pantalla. Se mide contra el viewport
 *    (`altoViewport`) y no contra el marco, porque lo que corta es la ventana.
 *  · **`left` se acota a los dos cantos del marco.** La columna del menú "⋯" es
 *    la última de una tabla de 14 columnas: un popover de 288px alineado a ese
 *    botón se sale sí o sí por la derecha. Se corre hacia la izquierda lo justo
 *    para entrar, en lugar de dejar que el navegador muestre scroll horizontal
 *    hacia la nada.
 *
 * El clamp de `left` aplica el mínimo DESPUÉS del máximo (`Math.max(MARGEN,
 * ...)` envolviendo al `Math.min`): en un marco más angosto que el popover
 * —mobile con la tabla en scroll horizontal— el máximo da un número negativo, y
 * sin el mínimo por fuera el popover arrancaría fuera de la pantalla por la
 * izquierda. En ese caso el que gana es el mínimo, que es el borde correcto.
 */
export function posicionPopover({
  ancla,
  fila,
  marco,
  alto,
  altoViewport,
  ancho = ANCHO_POPOVER,
}: {
  /** Rect del botón que abrió el popover (el "⋯" o el del presupuesto). */
  ancla: { left: number; right: number };
  /** Rect de la FILA, no del botón: el popover cuelga de la fila entera. */
  fila: { top: number; bottom: number };
  /** Rect del marco de la tabla (el contenedor `position:relative`). */
  marco: { top: number; left: number; width: number };
  /** Alto estimado del popover. Se usa sólo para decidir arriba/abajo. */
  alto: number;
  altoViewport: number;
  /** Ancho del popover. Sólo se pasa distinto en los tests. */
  ancho?: number;
}): { top: number; left: number; arriba: boolean } {
  const entraAbajo = fila.bottom + AIRE + alto <= altoViewport;
  const arriba = !entraAbajo;

  const top = arriba
    ? fila.top - marco.top - alto - AIRE
    : fila.bottom - marco.top + AIRE;

  const left = Math.max(
    MARGEN,
    Math.min(ancla.left - marco.left, marco.width - ancho - MARGEN),
  );

  return { top, left, arriba };
}

/**
 * ¿El viewport es de mobile? (< 760px, el corte del handoff.)
 *
 * Arranca en `false` y no en el resultado de `matchMedia`: en el primer render
 * del cliente todavía no hay `window` en SSR, y devolver distinto en servidor y
 * cliente es un error de hidratación. El primer `useEffect` corrige en el mismo
 * tick, antes de que el popover se pueda abrir.
 */
export function useEsMobile(): boolean {
  const [esMobile, setEsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 759px)');
    setEsMobile(mq.matches);
    const alCambiar = (e: MediaQueryListEvent) => setEsMobile(e.matches);
    mq.addEventListener('change', alCambiar);
    return () => mq.removeEventListener('change', alCambiar);
  }, []);
  return esMobile;
}

/**
 * Los dos modos de presupuesto de Meta, con el rótulo del handoff.
 *
 * `total` va deshabilitado SIEMPRE, y no es un pendiente de esta pantalla: el
 * módulo de anuncios no escribe presupuestos de por vida en ningún nivel
 * (D-A10, `lib/ads/tipos.ts`: `budgetMode 'lifetime'` se muestra pero no se
 * edita, y las reglas lo omiten con motivo
 * `presupuesto_lifetime_no_soportado`).
 *
 * Se dibuja igual, en gris y con el motivo en el `title`, en lugar de mostrar
 * sólo "Diario": un segmentado de UNA opción no comunica nada, y con los dos
 * visibles queda claro que el panel sabe que existe el otro modo y que
 * deliberadamente no lo toca. Habilitarlo pediría escribir en Meta por un camino
 * que no existe.
 */
const MODOS = [
  { clave: 'diario' as const, rotulo: 'Diario', disponible: true },
  { clave: 'total' as const, rotulo: 'Total de por vida', disponible: false },
];

export type ModoPresupuesto = 'diario' | 'total';

const ITEM =
  'tap flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-neutral-200 transition-colors duration-250 hover:bg-good-900 hover:text-good-100 disabled:cursor-not-allowed disabled:text-neutral-600 disabled:hover:bg-transparent';

/**
 * Lo que el popover necesita saber de la fila. Un subconjunto de
 * `MetricasObjeto` y no el objeto entero para que el test de posición no tenga
 * que fabricar una fila de 40 campos.
 */
export type FilaPopover = Pick<
  MetricasObjeto,
  | 'objectId'
  | 'objectName'
  | 'level'
  | 'status'
  | 'spendEur'
  | 'dailyBudgetEur'
  | 'budgetLevel'
  | 'budgetMode'
>;

/**
 * ¿Se puede editar el presupuesto de esta fila desde acá?
 *
 * Es la MISMA condición que `PresupuestoCelda` (`celdas.tsx`), copiada a
 * propósito en una función con nombre en lugar de repetida en línea: si los dos
 * lugares divergen, el menú ofrece "Editar presupuesto" para una fila cuya celda
 * dice que no se puede, y el diálogo siguiente abre con el campo bloqueado sin
 * explicar por qué.
 */
export function presupuestoEditable(fila: FilaPopover): boolean {
  return fila.level !== 'ad' && fila.budgetLevel === fila.level && fila.budgetMode === 'daily';
}

export function PopoverFila({
  estado,
  fila,
  esMobile,
  onVista,
  onCerrar,
  onPresupuesto,
  onRenombrar,
  onDuplicar,
  onToggle,
}: {
  estado: EstadoPopover;
  fila: FilaPopover;
  esMobile: boolean;
  onVista: (v: VistaPopover) => void;
  onCerrar: () => void;
  /** Abre el Dialogo_Confirmacion con el importe sembrado. NO escribe. */
  onPresupuesto: (eur: number, modo: ModoPresupuesto) => void;
  /** Abre el Dialogo_Confirmacion en modo exacto con el nombre sembrado. */
  onRenombrar: (nombre: string) => void;
  onDuplicar: () => void;
  onToggle: () => void;
}): JSX.Element {
  const caja = useRef<HTMLDivElement>(null);
  const [modo, setModo] = useState<ModoPresupuesto>('diario');
  const [importe, setImporte] = useState<string>(
    fila.dailyBudgetEur !== null && fila.dailyBudgetEur > 0 ? String(fila.dailyBudgetEur) : '',
  );
  const [nombre, setNombre] = useState<string>(fila.objectName ?? '');

  // Escape cierra, y el click AFUERA cierra. El listener va en `pointerdown` y
  // no en `click`: con `click`, arrastrar para seleccionar el importe y soltar
  // sobre la tabla cerraba el popover y perdía lo tipeado (es el mismo bug que
  // el modal de Finanzas ya tenía documentado).
  useEffect(() => {
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCerrar();
      }
    };
    const alApuntar = (e: PointerEvent) => {
      if (!caja.current?.contains(e.target as Node)) onCerrar();
    };
    document.addEventListener('keydown', alTeclear);
    // `true` (captura): sin esto, un click en un botón que se desmonta por el
    // mismo click nunca llega a burbujear hasta acá.
    document.addEventListener('pointerdown', alApuntar, true);
    return () => {
      document.removeEventListener('keydown', alTeclear);
      document.removeEventListener('pointerdown', alApuntar, true);
    };
  }, [onCerrar]);

  // El foco entra al popover al abrirse: en mobile es una hoja que tapa media
  // pantalla, y en desktop el input del importe es lo único que se quiere tocar.
  useEffect(() => {
    const primero = caja.current?.querySelector<HTMLElement>(
      'input, button:not([disabled])',
    );
    primero?.focus();
  }, [estado.vista]);

  const pausada = fila.status === 'PAUSED';
  const puedePresupuesto = presupuestoEditable(fila);
  const motivoSinPresupuesto = puedePresupuesto ? null : motivoPresupuestoNoEditable(fila);
  const importeNum = Number(importe.replace(',', '.'));
  const importeValido = Number.isFinite(importeNum) && importeNum > 0;
  const nombreValido = nombre.trim().length > 0;

  const cuerpo = (
    <>
      {estado.vista === 'menu' && (
        <div className="p-1.5">
          {/* De qué fila estamos hablando. Es la mitad del punto del popover:
              el formulario viejo no lo decía. `break-words` y no `truncate`
              porque un nombre de Meta cortado a la mitad no identifica nada. */}
          <p
            className="border-b border-divider px-2.5 pb-2 pt-1 text-xs font-medium text-neutral-400"
            title={fila.objectName ?? undefined}
          >
            <span className="break-words text-neutral-200">
              {fila.objectName ?? '(sin nombre)'}
            </span>
          </p>
          <div className="pt-1.5">
            {/* Deshabilitado CON el motivo en el title, no escondido: una fila de
                nivel anuncio nunca tiene presupuesto propio, y un menú al que le
                faltan items según la fila obliga a adivinar si la opción no está
                o si no se encontró. */}
            <button
              type="button"
              className={ITEM}
              disabled={!puedePresupuesto}
              title={motivoSinPresupuesto ?? 'Editar presupuesto'}
              onClick={() => onVista('presupuesto')}
            >
              <CurrencyDollar size={15} weight="bold" aria-hidden />
              Editar presupuesto
              {fila.level === 'ad' && (
                <span className="ml-auto text-xs text-neutral-600">Del conjunto</span>
              )}
            </button>
            <button type="button" className={ITEM} onClick={() => onVista('renombrar')}>
              <TextAa size={15} weight="bold" aria-hidden />
              Renombrar
            </button>
            <button type="button" className={ITEM} onClick={onDuplicar}>
              <CopySimple size={15} weight="bold" aria-hidden />
              Duplicar
              {/* El handoff pide decirlo acá y no en el diálogo siguiente:
                  "duplicar" a secas deja la duda de si la copia arranca gastando. */}
              <span className="ml-auto text-xs text-neutral-500">pausada</span>
            </button>
            <button type="button" className={ITEM} onClick={onToggle}>
              {pausada ? (
                <Play size={15} weight="bold" aria-hidden />
              ) : (
                <Pause size={15} weight="bold" aria-hidden />
              )}
              {pausada ? 'Activar' : 'Pausar'}
            </button>
          </div>
        </div>
      )}

      {estado.vista === 'presupuesto' && (
        <div className="p-3">
          <p className="mb-2.5 text-xs font-medium text-neutral-400">Presupuesto</p>

          {/* Segmentado Diario / Total de por vida. */}
          <div
            role="group"
            aria-label="Tipo de presupuesto"
            className="mb-3 flex gap-0.5 rounded-md bg-canvas/60 p-0.5"
          >
            {MODOS.map((m) => (
              <button
                key={m.clave}
                type="button"
                onClick={() => m.disponible && setModo(m.clave)}
                disabled={!m.disponible}
                aria-pressed={modo === m.clave}
                title={
                  m.disponible
                    ? undefined
                    : 'este panel sólo edita presupuestos diarios (D-A10)'
                }
                className={`flex-1 rounded px-2 py-1.5 text-xs transition-colors duration-250 ${
                  modo === m.clave
                    ? 'bg-good-900 font-medium text-good-100'
                    : m.disponible
                      ? 'text-neutral-400 hover:text-neutral-100'
                      : 'cursor-not-allowed text-neutral-600'
                }`}
              >
                {m.rotulo}
              </button>
            ))}
          </div>

          <label className="block">
            <span className="sr-only">Importe del presupuesto</span>
            <span className="flex items-center gap-1.5 rounded-md border border-border-strong bg-canvas/50 px-2.5 focus-within:border-good-500/60">
              <span aria-hidden className="text-base text-neutral-500">
                {SIMBOLO_REPORTE}
              </span>
              {/* 44px de alto y 18px de tipografía: es un campo de plata y se
                  tipea con el pulgar tanto como con el teclado. */}
              <input
                value={importe}
                onChange={(e) => setImporte(e.target.value)}
                inputMode="decimal"
                placeholder="0"
                className="h-11 w-full bg-transparent text-[18px] tabular-nums text-neutral-50 outline-none placeholder:text-neutral-600"
              />
            </span>
          </label>

          <p className="mt-2 text-xs text-neutral-500">
            Gastado en el período: {fmtMoney(fila.spendEur, MONEDA_REPORTE)}
            {fila.dailyBudgetEur !== null && fila.dailyBudgetEur > 0 && (
              <> · ahora: {fmtMoney(fila.dailyBudgetEur, MONEDA_REPORTE)}</>
            )}
          </p>

          {/* El motivo, no un botón gris. Es la regla del proyecto desde el
              incidente del 2026-08-24: un control deshabilitado sin explicación
              es un callejón sin salida. */}
          {!importeValido && importe.trim() !== '' && (
            <p className="mt-1.5 text-xs text-warn-300" aria-live="polite">
              el presupuesto tiene que ser mayor que 0
            </p>
          )}

          <Pie
            onCancelar={() => onVista('menu')}
            onGuardar={() => onPresupuesto(importeNum, modo)}
            puede={importeValido}
          />
        </div>
      )}

      {estado.vista === 'renombrar' && (
        <div className="p-3">
          <p className="mb-2.5 text-xs font-medium text-neutral-400">Nombre</p>
          <textarea
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            rows={3}
            className="w-full resize-none rounded-md border border-border-strong bg-canvas/50 px-2.5 py-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-good-500/60"
            placeholder="Nombre del objeto"
          />
          <Pie
            onCancelar={() => onVista('menu')}
            onGuardar={() => onRenombrar(nombre.trim())}
            puede={nombreValido}
          />
        </div>
      )}
    </>
  );

  if (esMobile) {
    return (
      <>
        {/* El backdrop al 70% del handoff. En desktop no hay: el popover está
            pegado a la fila y tapar la tabla escondería justo el contexto que
            el popover existe para dar. En mobile sí, porque la hoja ocupa media
            pantalla y sin backdrop no se entiende que el resto está inactivo. */}
        <div
          aria-hidden
          className="fixed inset-0 z-modal bg-neutral-900/70"
          onPointerDown={onCerrar}
        />
        <div
          ref={caja}
          role="dialog"
          aria-modal="true"
          aria-label={`Editar ${fila.objectName ?? fila.objectId}`}
          className="hoja-sube fixed inset-x-0 bottom-0 z-modal max-h-[80dvh] overflow-y-auto rounded-t-2xl border-t border-border-strong bg-surface-overlay pb-[env(safe-area-inset-bottom)] shadow-popover"
        >
          {/* El handle de 36×4: es lo que hace que se lea como una hoja que se
              puede arrastrar y no como un cartel que apareció. */}
          <div className="flex justify-center py-2.5">
            <span aria-hidden className="h-1 w-9 rounded-full bg-neutral-700" />
          </div>
          {cuerpo}
        </div>
      </>
    );
  }

  return (
    <div
      ref={caja}
      role="dialog"
      aria-label={`Editar ${fila.objectName ?? fila.objectId}`}
      style={{ top: estado.top, left: estado.left, width: ANCHO_POPOVER }}
      /* `absolute` dentro del marco de la tabla: es lo que hace que el popover
         se mueva con la fila al scrollear la página. Con `fixed` se quedaría
         quieto en la pantalla mientras la fila de la que habla se va para
         arriba, que es exactamente lo que se venía a arreglar. */
      className="absolute z-popover rounded-lg border border-border-strong bg-surface-overlay shadow-popover"
    >
      {cuerpo}
    </div>
  );
}

/** El pie de los dos formularios: Cancelar / Guardar, con el mismo orden. */
function Pie({
  onCancelar,
  onGuardar,
  puede,
}: {
  onCancelar: () => void;
  onGuardar: () => void;
  puede: boolean;
}): JSX.Element {
  return (
    <div className="mt-3 flex items-center justify-end gap-2 border-t border-divider pt-3">
      <button
        type="button"
        onClick={onCancelar}
        className="tap press rounded-md px-2.5 py-1.5 text-xs font-medium text-neutral-400 transition-colors duration-250 hover:bg-overlay/6 hover:text-neutral-100"
      >
        Cancelar
      </button>
      <button
        type="button"
        onClick={onGuardar}
        disabled={!puede}
        className="tap press rounded-md bg-gradient-to-b from-good-400 to-good-600 px-3 py-1.5 text-xs font-semibold text-canvas shadow-glow-good transition-[filter] duration-250 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Guardar
      </button>
    </div>
  );
}
