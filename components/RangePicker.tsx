'use client';

/**
 * RangePicker — selector GLOBAL de período del panel.
 *
 * Vive en el header del layout `(panel)`. Dos maneras de elegir, en el mismo
 * popover:
 *
 *  · un preset (`?range=7d`), que se resuelve en el server con `resolveRange`
 *    de `lib/day.ts` y por eso se mueve solo con el día;
 *  · un rango personalizado (`?from=2026-09-01&to=2026-09-15`), que es fijo.
 *    Resumen, Embudo, Ventas y Leads ya aceptaban `from`/`to`
 *    (`resolveFunnelRange` los valida y les da prioridad sobre `range`); lo que
 *    faltaba era poder elegirlos sin escribir la URL a mano.
 *
 * Al elegir uno se BORRA el otro del query: si quedaran los dos, `from`/`to`
 * ganan y el preset recién elegido no haría nada.
 *
 * Escribe con `router.replace(..., { scroll: false })` (sin recargar ni saltar
 * arriba) y preserva el resto del query (`?f=`, `?moneda=`).
 *
 * El popover va por Portal (ver components/Portal.tsx: un `fixed` adentro de
 * un ancestro animado se posiciona mal). En desktop cuelga del botón; debajo de
 * 760px es una hoja desde abajo, porque el botón puede quedar a la izquierda
 * cuando los filtros hacen wrap y un popover anclado a la derecha se saldría.
 */

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { CalendarBlank, CaretDown, CaretLeft, CaretRight } from '@phosphor-icons/react';
import { SELECT_HEADER } from '@/components/Nav';
import { Portal } from '@/components/Portal';
import type { RangePreset } from '@/lib/day';
import {
  DIA_RE,
  aDia,
  celdasMes,
  etiquetaRango,
  largoRango,
  nombreMes,
  ordenar,
  partes,
} from '@/lib/rango-fechas';

const RANGE_OPTIONS: ReadonlyArray<{ value: RangePreset; label: string }> = [
  { value: 'today', label: 'Hoy' },
  { value: 'yesterday', label: 'Ayer' },
  { value: '7d', label: '7 días' },
  { value: '14d', label: '14 días' },
  { value: '30d', label: '30 días' },
  { value: 'mtd', label: 'Mes actual' },
  { value: 'all', label: 'Todo' },
];

/** Preset por defecto: el mismo default que el RangePicker de los funnels. */
const DEFAULT_RANGE: RangePreset = 'today';

const DIAS_SEMANA = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

function isRangePreset(v: string | null): v is RangePreset {
  return typeof v === 'string' && RANGE_OPTIONS.some((o) => o.value === v);
}

/** Hoy en el reloj del navegador. Sólo acota el calendario (no se eligen días
 *  futuros): el "hoy" que cuenta para los datos lo resuelve el server. */
function hoyLocal(): string {
  const d = new Date();
  return aDia(d.getFullYear(), d.getMonth(), d.getDate());
}

export function RangePicker() {
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  const searchParams = useSearchParams();

  const raw = searchParams.get('range');
  const fromQ = searchParams.get('from');
  const toQ = searchParams.get('to');
  const custom =
    fromQ && toQ && DIA_RE.test(fromQ) && DIA_RE.test(toQ) && fromQ <= toQ ? { from: fromQ, to: toQ } : null;
  const preset: RangePreset = isRangePreset(raw) ? raw : DEFAULT_RANGE;

  const hoy = hoyLocal();
  const etiqueta = custom
    ? etiquetaRango(custom.from, custom.to, hoy)
    : (RANGE_OPTIONS.find((o) => o.value === preset)?.label ?? 'Hoy');

  const [abierto, setAbierto] = useState(false);
  const boton = useRef<HTMLButtonElement>(null);

  function navegar(mutar: (p: URLSearchParams) => void): void {
    const params = new URLSearchParams(searchParams.toString());
    mutar(params);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    setAbierto(false);
    boton.current?.focus();
  }

  const elegirPreset = (v: RangePreset): void =>
    navegar((p) => {
      p.set('range', v);
      p.delete('from');
      p.delete('to');
    });

  const elegirRango = (from: string, to: string): void =>
    navegar((p) => {
      p.delete('range');
      p.set('from', from);
      p.set('to', to);
    });

  return (
    <div className="relative inline-flex items-center">
      <button
        ref={boton}
        type="button"
        onClick={() => setAbierto((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={abierto}
        aria-label={`Período del panel: ${etiqueta}`}
        title="Período del panel"
        className={`${SELECT_HEADER} inline-flex items-center gap-2 ${custom ? 'border-acento-700/70' : ''}`}
      >
        <CalendarBlank size={14} weight="bold" className={custom ? 'text-acento-400' : 'text-neutral-400'} aria-hidden />
        <span className="whitespace-nowrap">{etiqueta}</span>
      </button>
      <span className="pointer-events-none absolute right-3 text-neutral-400">
        <CaretDown size={12} weight="bold" aria-hidden="true" className={`transition-transform ${abierto ? 'rotate-180' : ''}`} />
      </span>

      {abierto && (
        <PopoverPeriodo
          ancla={boton.current}
          hoy={hoy}
          preset={custom ? null : preset}
          custom={custom}
          onPreset={elegirPreset}
          onRango={elegirRango}
          onCerrar={() => {
            setAbierto(false);
            boton.current?.focus();
          }}
        />
      )}
    </div>
  );
}

function PopoverPeriodo({
  ancla,
  hoy,
  preset,
  custom,
  onPreset,
  onRango,
  onCerrar,
}: {
  ancla: HTMLElement | null;
  hoy: string;
  preset: RangePreset | null;
  custom: { from: string; to: string } | null;
  onPreset: (v: RangePreset) => void;
  onRango: (from: string, to: string) => void;
  onCerrar: () => void;
}): JSX.Element {
  // El mes que se ve: el del final del rango elegido, o el actual.
  const inicio = partes(custom?.to ?? hoy);
  const [mes, setMes] = useState({ y: inicio.y, m0: inicio.m0 });
  // La selección en curso: el primer click fija `a`, el segundo `b`.
  const [a, setA] = useState<string | null>(custom?.from ?? null);
  const [b, setB] = useState<string | null>(custom?.to ?? null);
  const [sobre, setSobre] = useState<string | null>(null);
  // Sólo en desktop (≥760px, el corte `panel`) se ancla al botón; debajo es
  // la hoja de abajo y la posición la ponen las clases.
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const cerrar = useRef(onCerrar);
  cerrar.current = onCerrar;

  // Se recalcula con el resize: el header cambia de alto cuando los filtros
  // hacen wrap, y al cruzar los 760px cambia de popover a hoja.
  useEffect(() => {
    function medir(): void {
      if (!ancla || !window.matchMedia('(min-width: 760px)').matches) {
        setPos(null);
        return;
      }
      const r = ancla.getBoundingClientRect();
      setPos({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
    }
    medir();
    window.addEventListener('resize', medir);
    return () => window.removeEventListener('resize', medir);
  }, [ancla]);

  // Escape cierra, y el foco entra al popover en el período activo. Deps
  // vacías a propósito: re-enfocar en cada render le robaría el foco al día
  // que se está eligiendo con el teclado.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') cerrar.current();
    }
    document.addEventListener('keydown', onKey);
    panel.current?.querySelector<HTMLElement>('[aria-checked="true"], button')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  function clickDia(dia: string): void {
    if (a === null || b !== null) {
      setA(dia);
      setB(null);
    } else {
      const [x, y] = ordenar(a, dia);
      setA(x);
      setB(y);
    }
  }

  // Lo que se pinta como rango: el elegido, o el que se está eligiendo con el
  // puntero encima (vista previa antes del segundo click).
  const [pDesde, pHasta] =
    a !== null && b !== null ? [a, b] : a !== null && sobre !== null ? ordenar(a, sobre) : [a, a];

  const celdas = celdasMes(mes.y, mes.m0);
  const esMesActual = mes.y === partes(hoy).y && mes.m0 === partes(hoy).m0;
  const moverMes = (delta: number): void =>
    setMes((m) => {
      const d = new Date(Date.UTC(m.y, m.m0 + delta, 1));
      return { y: d.getUTCFullYear(), m0: d.getUTCMonth() };
    });

  const listo = a !== null && b !== null;

  return (
    <Portal>
      <div className="fixed inset-0 z-40 bg-canvas/60 panel:bg-transparent" aria-hidden="true" onClick={onCerrar} />
      <div
        ref={panel}
        role="dialog"
        aria-label="Elegir período"
        className="hoja-sube fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col overflow-y-auto rounded-t-2xl border border-border-strong bg-surface-raised shadow-float panel:inset-x-auto panel:bottom-auto panel:w-[520px] panel:flex-row panel:rounded-2xl panel:[animation:none]"
        style={pos ? { top: pos.top, right: pos.right } : undefined}
      >

        {/* ── Presets ───────────────────────────────────────────────────── */}
        <div
          role="radiogroup"
          aria-label="Períodos rápidos"
          className="flex gap-1 overflow-x-auto border-b border-divider p-2 panel:w-36 panel:shrink-0 panel:flex-col panel:overflow-visible panel:border-b-0 panel:border-r"
        >
          {RANGE_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={preset === o.value}
              onClick={() => onPreset(o.value)}
              className={`shrink-0 rounded-lg px-3 py-1.5 text-left text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-acento-500/60 ${
                preset === o.value
                  ? 'bg-acento-900 font-medium text-acento-100'
                  : 'text-neutral-300 hover:bg-overlay/4 hover:text-neutral-50'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>

        {/* ── Calendario ────────────────────────────────────────────────── */}
        <div className="flex-1 p-3">
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => moverMes(-1)}
              aria-label="Mes anterior"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 hover:bg-overlay/4 hover:text-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-acento-500/60"
            >
              <CaretLeft size={14} weight="bold" />
            </button>
            <p className="text-sm font-medium capitalize text-neutral-100" aria-live="polite">
              {nombreMes(mes.m0)} <span className="font-mono text-neutral-500">{mes.y}</span>
            </p>
            <button
              type="button"
              onClick={() => moverMes(1)}
              disabled={esMesActual}
              aria-label="Mes siguiente"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 hover:bg-overlay/4 hover:text-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-acento-500/60 disabled:opacity-25 disabled:hover:bg-transparent"
            >
              <CaretRight size={14} weight="bold" />
            </button>
          </div>

          <div className="grid grid-cols-7 text-center text-[11px] font-medium text-neutral-600">
            {DIAS_SEMANA.map((d, i) => (
              <span key={i} className="py-1">
                {d}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-y-0.5" onPointerLeave={() => setSobre(null)}>
            {celdas.map((dia, i) => {
              if (dia === null) return <span key={`h${i}`} />;
              const futuro = dia > hoy;
              const enRango = pDesde !== null && pHasta !== null && dia >= pDesde && dia <= pHasta;
              const esPunta = dia === pDesde || dia === pHasta;
              const esHoy = dia === hoy;
              return (
                <div
                  key={dia}
                  className={`flex justify-center ${
                    enRango && !(pDesde === pHasta) ? 'bg-acento-900/70' : ''
                  } ${dia === pDesde ? 'rounded-l-lg' : ''} ${dia === pHasta ? 'rounded-r-lg' : ''}`}
                >
                  <button
                    type="button"
                    disabled={futuro}
                    onClick={() => clickDia(dia)}
                    onPointerEnter={() => setSobre(dia)}
                    aria-pressed={esPunta}
                    aria-label={dia}
                    className={`relative flex h-9 w-9 items-center justify-center rounded-lg font-mono text-xs tabular-nums transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-acento-500/60 disabled:cursor-not-allowed disabled:text-neutral-700 ${
                      esPunta
                        ? 'bg-acento-500 font-semibold text-canvas'
                        : enRango
                          ? 'text-acento-100'
                          : 'text-neutral-300 hover:bg-overlay/6'
                    }`}
                  >
                    {partes(dia).d}
                    {esHoy && !esPunta && (
                      <span aria-hidden className="absolute bottom-1 h-1 w-1 rounded-full bg-acento-400" />
                    )}
                  </button>
                </div>
              );
            })}
          </div>

          <div className="mt-3 flex items-center justify-between gap-3 border-t border-divider pt-3">
            <p className="min-w-0 text-xs text-neutral-400" aria-live="polite">
              {listo ? (
                <>
                  <span className="text-neutral-100">{etiquetaRango(a, b, hoy)}</span>
                  <span className="ml-1.5 text-neutral-500">· {largoRango(a, b)} {largoRango(a, b) === 1 ? 'día' : 'días'}</span>
                </>
              ) : a !== null ? (
                'Elegí el último día'
              ) : (
                'Elegí el primer día'
              )}
            </p>
            <button
              type="button"
              disabled={!listo}
              onClick={() => listo && onRango(a, b)}
              // La receta del botón primario del panel (§5 del plan iris): la
              // misma en todas las pantallas, así "Aplicar" y "Guardar" se
              // reconocen como la misma clase de acción.
              className="shrink-0 rounded-lg bg-gradient-to-b from-acento-400 to-acento-500 px-3 py-1.5 text-xs font-semibold text-canvas shadow-glow-acento transition-[filter] hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acento-500/60 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:brightness-100"
            >
              Aplicar
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
