'use client';

/**
 * BarraPrimaria — la fila de arriba de la tabla de Anuncios: segmentado con
 * conteo, buscador, y el resumen de lo que se está mirando.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 *
 * La sección tenía SEIS bloques apilados antes de la primera fila de la tabla:
 * las pestañas de nivel, la barra de frescura, la barra de filtros (período,
 * cuenta, estado, ocultar sin datos, nombre), el botón de vistas y columnas,
 * cuatro tarjetas de KPI de ~110px de alto, y hasta dos banners de aviso.
 * Medido a 390px, había que scrollear una pantalla y media para ver una
 * campaña; en 1440 se comía la mitad del alto útil.
 *
 * Las capturas de referencia tienen UNA fila: el segmentado con el conteo, el
 * buscador, y a la derecha «4 de 6 activas · EUR 710,18 gastados». Ese texto
 * contesta lo mismo que las cuatro tarjetas de KPI pero en una línea, y encima
 * contesta algo que las tarjetas NO decían: cuántas de las que estoy viendo
 * están prendidas.
 *
 * Lo que se movió NO se borró: período, cuenta, estado, ocultar sin datos,
 * vistas y columnas, y las cuatro tarjetas de KPI viven ahora dentro del
 * desplegable «Más filtros», cerrado por defecto. Un filtro que se usa una vez
 * por sesión no puede ocupar el lugar de la tabla en todas las demás.
 */

import { MagnifyingGlass } from '@phosphor-icons/react';
import type { NivelAds } from '@/lib/ads/tipos';
import { fmtInt } from '@/components/ui';
import { TabsNivel } from './TabsNivel';

export function BarraPrimaria({
  nivel,
  onNivel,
  conteos,
  nombre,
  onNombre,
  activas,
  totalFilas,
  gastado,
}: {
  nivel: NivelAds;
  onNivel: (n: NivelAds) => void;
  conteos?: Partial<Record<NivelAds, number | null>>;
  /** El texto de búsqueda vigente. */
  nombre: string;
  onNombre: (v: string) => void;
  /** Cuántas de las filas en pantalla están activas. */
  activas: number;
  /** Total de filas que alcanzan los filtros (lo dice el servidor). */
  totalFilas: number;
  /** El gasto del alcance, ya formateado con la moneda de reporte. */
  gastado: string;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-3 panel:flex-row panel:items-center panel:gap-4">
      <TabsNivel nivel={nivel} onNivel={onNivel} conteos={conteos} />

      {/* El buscador. La lupa va DENTRO del campo y no como rótulo al costado:
          «Nombre [buscar por nombre…]» gastaba 70px en decir lo que el
          placeholder ya dice. */}
      <div className="relative min-w-0 flex-1 panel:max-w-sm">
        <MagnifyingGlass
          size={15}
          weight="bold"
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500"
        />
        <input
          value={nombre}
          onChange={(e) => onNombre(e.target.value)}
          maxLength={200}
          placeholder="Buscar por nombre"
          aria-label="Buscar por nombre"
          className="h-11 w-full rounded-lg border border-border-strong bg-canvas/50 pl-9 pr-3 text-sm text-neutral-200 transition-colors duration-250 placeholder:text-neutral-600 hover:border-overlay/16 focus:border-good-500/60 focus:outline-none panel:h-9"
        />
      </div>

      {/* El resumen. `tabular-nums` para que no baile al refrescar el gasto, y
          `whitespace-nowrap` porque partido en dos líneas («4 de 6 / activas»)
          se lee como dos datos sueltos. */}
      <p className="shrink-0 text-xs text-neutral-500 tabular-nums panel:text-sm">
        <span className="whitespace-nowrap">
          {fmtInt(activas)} de {fmtInt(totalFilas)} activas
        </span>
        <span aria-hidden> · </span>
        <span className="whitespace-nowrap">{gastado} gastados</span>
      </p>
    </div>
  );
}
