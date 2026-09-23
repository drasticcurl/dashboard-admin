'use client';

/**
 * TabsNivel — el segmentado Campañas / Conjuntos / Anuncios, con el conteo.
 *
 * ── Qué cambió en el rediseño v3 ────────────────────────────────────────────
 *
 * Antes eran pestañas con solapa (borde arriba y a los costados, fondo de la
 * tarjeta, subrayado del acento) apoyadas sobre la tarjeta de la tabla. El
 * problema es que la sección ya tiene OTRA fila de pestañas arriba —Campañas /
 * Reglas / Historial, del layout— y las dos se veían igual: dos filas de
 * pestañas subrayadas, una debajo de la otra, y ninguna decía a qué nivel
 * pertenecía.
 *
 * Ahora es un control SEGMENTADO (una pastilla dentro de un canal hundido), que
 * es lo que muestran las capturas de referencia: se lee como un selector de
 * modo, no como navegación, y no compite con las pestañas de arriba.
 *
 * ── El conteo ───────────────────────────────────────────────────────────────
 *
 * El número al lado del rótulo es el total de filas de ese nivel con los filtros
 * puestos. `conteos` sólo trae el del nivel que se está mirando —es lo que
 * devuelve la consulta— y el llamador va acumulando los de los otros dos a
 * medida que se visitan. Un nivel sin conteo todavía no muestra número en lugar
 * de mostrar un 0: "no lo sé" y "no hay ninguno" son cosas distintas, y con 0
 * alguien podría concluir que no hay conjuntos cuando lo único que pasa es que
 * no entró a esa pestaña.
 */

import { Funnel, Images, Megaphone } from '@phosphor-icons/react';
import type { NivelAds } from '@/lib/ads/tipos';
import { fmtInt } from '@/components/ui';

const TABS: { nivel: NivelAds; rotulo: string; Icono: typeof Megaphone }[] = [
  { nivel: 'campaign', rotulo: 'Campañas', Icono: Megaphone },
  { nivel: 'adset', rotulo: 'Conjuntos', Icono: Funnel },
  { nivel: 'ad', rotulo: 'Anuncios', Icono: Images },
];

export function TabsNivel({
  nivel,
  onNivel,
  conteos,
}: {
  nivel: NivelAds;
  onNivel: (nivel: NivelAds) => void;
  /** Filas por nivel con los filtros puestos. `null`/ausente = todavía no se sabe. */
  conteos?: Partial<Record<NivelAds, number | null>>;
}): JSX.Element {
  return (
    <div
      role="tablist"
      aria-label="Nivel de la jerarquía"
      /* `w-full panel:w-auto` + `overflow-x-auto`: en 390px los tres rótulos con
         su conteo no entran, así que el canal scrollea en lugar de hacer wrap a
         dos líneas (que duplicaría el alto de la barra). */
      className="flex w-full gap-0.5 overflow-x-auto rounded-lg bg-canvas/60 p-0.5 panel:w-auto"
    >
      {TABS.map(({ nivel: n, rotulo, Icono }) => {
        const activa = n === nivel;
        const cuenta = conteos?.[n];
        return (
          <button
            key={n}
            type="button"
            role="tab"
            aria-selected={activa}
            onClick={() => onNivel(n)}
            className={`tap flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition-colors duration-250 focus:outline-none focus-visible:ring-2 focus-visible:ring-good-500/60 ${
              activa
                ? 'bg-good-900 font-medium text-good-100'
                : 'text-neutral-400 hover:text-neutral-100'
            }`}
          >
            <Icono size={15} weight="bold" aria-hidden="true" />
            {rotulo}
            {typeof cuenta === 'number' && (
              <span
                className={`tabular-nums ${activa ? 'text-good-300' : 'text-neutral-600'}`}
              >
                {fmtInt(cuenta)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
