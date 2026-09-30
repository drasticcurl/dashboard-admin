'use client';

/**
 * BarraFiltros (task 20.1): la fila de controles ROTULADOS y siempre visibles
 * (R1 c4, c5): Filtro_Cascada (el ChipCascada), Período de visualización,
 * Cuenta de anuncio, Estado y búsqueda por nombre. Sin menús ni acordeones:
 * todo visible desde el primer render a 1280 px o más.
 *
 * La CUENTA es de sólo lectura: la determina el funnel del selector de arriba.
 * Se muestra igual porque tenés que poder ver cuál estás mirando; lo que no
 * tenés que poder es cambiarla desde acá y quedar viendo una cuenta que no se
 * corresponde con el funnel elegido.
 *
 * - La búsqueda por nombre acepta hasta 200 caracteres y debouncea (R1 c4).
 * - Cada filtro muestra su valor vigente dentro de su propio control, con un
 *   rótulo de valor por defecto cuando no hay selección explícita (R1 c5).
 * - El período se expresa como rango de fechas resuelto en la Zona_Cuenta.
 * - El período se elige con el MISMO popover que el selector global del panel
 *   (`PopoverPeriodo`): los cuatro períodos fijos a la izquierda y el calendario
 *   a la derecha. El calendario no deja elegir días anteriores a la primera
 *   venta registrada (`primerDia`): antes no hay ventas que atribuir.
 */

import { useRef, useState } from 'react';
import { CalendarBlank, CaretDown } from '@phosphor-icons/react';
import { PopoverPeriodo } from '@/components/RangePicker';
import { aDia, etiquetaRango } from '@/lib/rango-fechas';
import type { NivelAds, PeriodoAds } from '@/lib/ads/tipos';
import { fmtDate } from '@/components/ui';
import type { CuentaAds } from './page';

const PERIODO_ROTULO: Record<PeriodoAds, string> = {
  today: 'Hoy',
  yesterday: 'Ayer',
  '7d': '7 días',
  '7d_excl_today': '7 días sin hoy',
};

const OPCIONES_PERIODO = (['today', 'yesterday', '7d', '7d_excl_today'] as PeriodoAds[]).map((p) => ({
  value: p,
  label: PERIODO_ROTULO[p],
}));

/** Hoy en el reloj del navegador: sólo acota el calendario (el server vuelve a acotar en la zona de la cuenta). */
function hoyLocal(): string {
  const d = new Date();
  return aDia(d.getFullYear(), d.getMonth(), d.getDate());
}

const inputCls =
  'min-h-[44px] rounded-lg border border-border-strong bg-canvas/50 px-2 py-1.5 text-sm text-neutral-200 shadow-[inset_0_1px_2px_0_rgb(var(--sombra)/0.45)] transition-colors duration-250 placeholder:text-neutral-600 hover:border-overlay/16 focus:border-acento-500/60 focus:outline-none focus:ring-1 focus:ring-acento-500/50 panel:min-h-0';

export function BarraFiltros({
  nivel,
  period,
  rango,
  rangoCustom,
  primerDia,
  status,
  cuenta,
  nombre,
  cuentas,
  cascada,
  ocultarSinDatos,
  ocultarPadreApagado,
  onPeriodo,
  onRango,
  onStatus,
  onNombre,
  onOcultarSinDatos,
  onOcultarPadreApagado,
}: {
  nivel: NivelAds;
  period: PeriodoAds;
  /** El rango resuelto del período, para expresarlo como fechas (R1 c5). */
  rango: { from: string; to: string } | null;
  /** El rango elegido en el calendario, si hay uno. Gana sobre `period`. */
  rangoCustom: { from: string; to: string } | null;
  /** Primer día con ventas: el borde izquierdo del calendario. */
  primerDia: string | null;
  status: 'active' | 'paused' | 'any';
  cuenta: string;
  nombre: string;
  cuentas: CuentaAds[];
  /** El ChipCascada: el "control" del Filtro_Cascada (R1 c4). */
  cascada: React.ReactNode;
  ocultarSinDatos: boolean;
  ocultarPadreApagado: boolean;
  onPeriodo: (p: PeriodoAds) => void;
  onRango: (from: string, to: string) => void;
  onStatus: (s: 'active' | 'paused' | 'any') => void;
  onNombre: (n: string) => void;
  onOcultarSinDatos: (v: boolean) => void;
  onOcultarPadreApagado: (v: boolean) => void;
}): JSX.Element {
  const [textoNombre, setTextoNombre] = useState(nombre);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cambiarNombre = (v: string): void => {
    setTextoNombre(v);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => onNombre(v), 400);
  };

  const [calendario, setCalendario] = useState(false);
  const botonPeriodo = useRef<HTMLButtonElement>(null);
  const hoy = hoyLocal();

  const periodoLabel = rangoCustom
    ? etiquetaRango(rangoCustom.from, rangoCustom.to, hoy)
    : rango
      ? `${PERIODO_ROTULO[period]} (${fmtDate(rango.from)} – ${fmtDate(rango.to)})`
      : PERIODO_ROTULO[period];

  const cerrarCalendario = (): void => {
    setCalendario(false);
    botonPeriodo.current?.focus();
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Filtro_Cascada: el ChipCascada, visible sólo con cascada activa */}
      {cascada}

      <span className="relative flex items-center gap-1.5">
        <span className="text-xs text-neutral-500">Período</span>
        <button
          ref={botonPeriodo}
          type="button"
          onClick={() => setCalendario((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={calendario}
          aria-label={`Período de visualización: ${periodoLabel}`}
          className={`${inputCls} inline-flex items-center gap-2 pr-2.5 ${rangoCustom ? 'border-acento-700/70' : ''}`}
        >
          <CalendarBlank
            size={14}
            weight="bold"
            aria-hidden
            className={rangoCustom ? 'text-acento-400' : 'text-neutral-400'}
          />
          <span className="whitespace-nowrap">{periodoLabel}</span>
          <CaretDown
            size={12}
            weight="bold"
            aria-hidden
            className={`text-neutral-500 transition-transform ${calendario ? 'rotate-180' : ''}`}
          />
        </button>
        {calendario && (
          <PopoverPeriodo
            ancla={botonPeriodo.current}
            hoy={hoy}
            opciones={OPCIONES_PERIODO}
            preset={rangoCustom ? null : period}
            custom={rangoCustom}
            minimo={primerDia}
            onPreset={(v) => {
              setCalendario(false);
              onPeriodo(v as PeriodoAds);
            }}
            onRango={(from, to) => {
              setCalendario(false);
              onRango(from, to);
            }}
            onCerrar={cerrarCalendario}
          />
        )}
      </span>

      {/* Sólo lectura: la cuenta sale del funnel elegido arriba. */}
      <span className="flex items-center gap-1.5">
        <span className="text-xs text-neutral-500">Cuenta</span>
        <span
          className="rounded-lg border border-border-subtle bg-overlay/2 px-2 py-1.5 text-sm text-neutral-400"
          title="La determina el funnel elegido en el selector de arriba. Se imputa en Config → Publicidad."
        >
          {cuentas.find((c) => c.accountId === cuenta)?.name ?? cuenta ?? 'Sin cuenta'}
        </span>
      </span>

      <label className="flex items-center gap-1.5">
        <span className="text-xs text-neutral-500">Estado</span>
        <select
          value={status}
          onChange={(e) => onStatus(e.target.value as 'active' | 'paused' | 'any')}
          aria-label="Estado"
          className={inputCls}
        >
          <option value="any">Cualquiera</option>
          <option value="active">Activos</option>
          <option value="paused">Pausados</option>
        </select>
      </label>

      {/* Los dos interruptores de ruido. Se guardan en la URL, así que recargar
          o compartir el link conserva la vista. */}
      <label
        className="flex min-h-[44px] cursor-pointer items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-200 panel:min-h-0"
        title="Oculta las filas que en este período no tienen ni gasto ni ventas. Una fila con gasto y sin ventas NO se oculta: es la que hay que ver."
      >
        <input
          type="checkbox"
          checked={ocultarSinDatos}
          onChange={(e) => onOcultarSinDatos(e.target.checked)}
          className="h-5 w-5 accent-acento-500 panel:h-3.5 panel:w-3.5"
        />
        Ocultar sin datos
      </label>

      {nivel !== 'campaign' && (
        <label
          className="flex min-h-[44px] cursor-pointer items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-200 panel:min-h-0"
          title="Oculta los que están apagados porque su padre está apagado (CAMPAIGN_PAUSED o ADSET_PAUSED en Meta), no por su propio estado."
        >
          <input
            type="checkbox"
            checked={ocultarPadreApagado}
            onChange={(e) => onOcultarPadreApagado(e.target.checked)}
            className="h-5 w-5 accent-acento-500 panel:h-3.5 panel:w-3.5"
          />
          Ocultar con padre apagado
        </label>
      )}

      <label className="flex items-center gap-1.5">
        <span className="text-xs text-neutral-500">Nombre</span>
        <input
          type="text"
          value={textoNombre}
          maxLength={200}
          onChange={(e) => cambiarNombre(e.target.value)}
          placeholder="Buscar por nombre…"
          aria-label="Búsqueda por nombre"
          className={`${inputCls} w-48`}
        />
      </label>
    </div>
  );
}
