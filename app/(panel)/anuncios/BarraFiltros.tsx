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
 */

import { useRef, useState } from 'react';
import type { NivelAds, PeriodoAds } from '@/lib/ads/tipos';
import { fmtDate } from '@/components/ui';
import type { CuentaAds } from './page';

const PERIODO_ROTULO: Record<PeriodoAds, string> = {
  today: 'Hoy',
  yesterday: 'Ayer',
  '7d': '7 días',
  '7d_excl_today': '7 días sin hoy',
};

const inputCls =
  'rounded-lg border border-border-strong bg-overlay/4 px-2 py-1.5 text-sm text-neutral-200 focus:border-good-500/50 focus:outline-none focus:ring-1 focus:ring-good-500/50';

export function BarraFiltros({
  nivel,
  period,
  rango,
  status,
  cuenta,
  nombre,
  cuentas,
  cascada,
  ocultarSinDatos,
  ocultarPadreApagado,
  onPeriodo,
  onStatus,
  onNombre,
  onOcultarSinDatos,
  onOcultarPadreApagado,
}: {
  nivel: NivelAds;
  period: PeriodoAds;
  /** El rango resuelto del período, para expresarlo como fechas (R1 c5). */
  rango: { from: string; to: string } | null;
  status: 'active' | 'paused' | 'any';
  cuenta: string;
  nombre: string;
  cuentas: CuentaAds[];
  /** El ChipCascada: el "control" del Filtro_Cascada (R1 c4). */
  cascada: React.ReactNode;
  ocultarSinDatos: boolean;
  ocultarPadreApagado: boolean;
  onPeriodo: (p: PeriodoAds) => void;
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

  const periodoLabel = rango
    ? `${PERIODO_ROTULO[period]} (${fmtDate(rango.from)} – ${fmtDate(rango.to)})`
    : PERIODO_ROTULO[period];

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Filtro_Cascada: el ChipCascada, visible sólo con cascada activa */}
      {cascada}

      <label className="flex items-center gap-1.5">
        <span className="text-xs text-neutral-500">Período</span>
        <select
          value={period}
          onChange={(e) => onPeriodo(e.target.value as PeriodoAds)}
          aria-label="Período de visualización"
          className={inputCls}
        >
          {(['today', 'yesterday', '7d', '7d_excl_today'] as PeriodoAds[]).map((p) => (
            <option key={p} value={p}>
              {p === period ? periodoLabel : PERIODO_ROTULO[p]}
            </option>
          ))}
        </select>
      </label>

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
        className="flex cursor-pointer items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-200"
        title="Oculta las filas que en este período no tienen ni gasto ni ventas. Una fila con gasto y sin ventas NO se oculta: es la que hay que ver."
      >
        <input
          type="checkbox"
          checked={ocultarSinDatos}
          onChange={(e) => onOcultarSinDatos(e.target.checked)}
          className="h-3.5 w-3.5 accent-good-500"
        />
        Ocultar sin datos
      </label>

      {nivel !== 'campaign' && (
        <label
          className="flex cursor-pointer items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-200"
          title="Oculta los que están apagados porque su padre está apagado (CAMPAIGN_PAUSED o ADSET_PAUSED en Meta), no por su propio estado."
        >
          <input
            type="checkbox"
            checked={ocultarPadreApagado}
            onChange={(e) => onOcultarPadreApagado(e.target.checked)}
            className="h-3.5 w-3.5 accent-good-500"
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
