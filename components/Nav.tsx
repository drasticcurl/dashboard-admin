'use client';

/**
 * Nav.tsx — el catálogo de secciones del panel y el selector de funnel.
 *
 * ── Qué dejó de estar acá (rediseño v3) ─────────────────────────────────────
 *
 * Hasta v3 este archivo dibujaba las nueve tabs como un control segmentado en
 * el header. El rediseño las movió a un sidebar de 220px (desktop) y a un
 * drawer (mobile), que viven en `components/Shell.tsx`.
 *
 * El motivo no es estético: con nueve tabs, un segmentado horizontal no entra
 * en 760px de ancho. Lo que hacía era wrap a dos filas, y el header —que es
 * sticky— pasaba a medir 120px de alto en mobile, o sea un tercio de la
 * pantalla de un teléfono ocupado por la navegación. Un sidebar no tiene ese
 * problema porque crece hacia abajo, donde hay lugar.
 *
 * Lo que SÍ sigue viviendo acá:
 *  · `TABS`, el catálogo: href, rótulo, sección para el filtro de permisos e
 *    icono. Es la fuente de verdad que consume el Shell.
 *  · `SELECT_HEADER`, el estilo compartido de los dos <select> del panel.
 *  · `SelectorFunnel`, el <select> de funnel, que preserva el resto del query
 *    string para que cambiar de funnel no pierda el rango elegido.
 *
 * Los iconos son de Phosphor (D-R11), peso `bold` como el resto del panel.
 */

import { useRouter, useSearchParams } from 'next/navigation';
import {
  CaretDown,
  ChartDonut,
  CurrencyCircleDollar,
  FilmSlate,
  Funnel as FunnelIcon,
  Gear,
  Kanban,
  Megaphone,
  Receipt,
  UsersThree,
  type Icon,
} from '@phosphor-icons/react';
import { nombreVisible } from '@/lib/funnel-nombre';
import type { Funnel } from '@/lib/funnels';
// SÓLO el tipo, con `import type`: `lib/permisos.ts` importa `next/headers`
// (server-only) y este componente es `'use client'`. Un import de valor —traer
// la constante `SECCIONES`— arrastraría ese módulo al bundle del cliente y el
// build falla con "You're importing a component that needs next/headers". El
// tipo se borra en compilación, así que no cruza esa frontera.
import type { Seccion } from '@/lib/permisos';

export type Tab = {
  href: string;
  label: string;
  seccion: Seccion;
  icono: Icon;
};

export const TABS = [
  { href: '/resumen', label: 'Resumen', seccion: 'resumen', icono: ChartDonut },
  { href: '/embudo', label: 'Embudo', seccion: 'embudo', icono: FunnelIcon },
  { href: '/ventas', label: 'Ventas', seccion: 'ventas', icono: Receipt },
  { href: '/anuncios', label: 'Anuncios', seccion: 'anuncios', icono: Megaphone },
  { href: '/finanzas', label: 'Finanzas', seccion: 'finanzas', icono: CurrencyCircleDollar },
  { href: '/leads', label: 'Leads', seccion: 'leads', icono: UsersThree },
  // Tareas va ANTES de Config: Config es la última porque es configuración, y
  // Tareas es una pantalla de uso diario.
  { href: '/tareas', label: 'Tareas', seccion: 'tareas', icono: Kanban },
  // Creativos, junto a Tareas: también es una pantalla de uso diario y no de
  // configuración (034).
  { href: '/creativos', label: 'Creativos', seccion: 'creativos', icono: FilmSlate },
  { href: '/config', label: 'Config', seccion: 'config', icono: Gear },
] satisfies Tab[];

/**
 * El estilo compartido de los dos <select> del panel (funnel y período).
 * Está acá y lo importa `RangePicker` porque son el MISMO control con datos
 * distintos: cuando divergen, la barra de filtros se ve desalineada.
 *
 * Fondo SÓLIDO y no un `bg-overlay/N` translúcido. Un <select> sin
 * background-color resuelto se pinta con el default del navegador, que es
 * BLANCO: en un panel oscuro se ve como un bug de color, y es exactamente lo
 * que pasaba cuando la escala de opacidad no tenía el valor usado. Con un
 * token sólido no depende de eso.
 *
 * `min-h-[36px] panel:min-h-0` y no la clase `.tap`: un <select> con
 * `display:inline-flex` (que es lo que hace `.tap`) pierde la flecha nativa en
 * Safari. Acá el alto se estira con `py` y `min-height`, que no tocan el
 * display.
 */
export const SELECT_HEADER =
  'press min-h-[44px] appearance-none rounded-lg border border-border-strong bg-surface-raised py-1.5 pl-3 pr-8 text-sm font-medium text-neutral-200 shadow-inset-highlight transition-[background-color,border-color,box-shadow] duration-250 hover:border-overlay/18 hover:bg-surface-overlay panel:min-h-0';

/**
 * Filtra el catálogo por las secciones permitidas (D6).
 *
 * Es COSMÉTICO: esconde los links que le darían un redirect a quien no tiene la
 * sección, pero la seguridad de verdad es el guard del layout y el `guard()` de
 * las routes. Si esto no corriera, nadie vería datos que no debe; sólo vería una
 * entrada del menú que lo rebota.
 *
 * Sin la lista (undefined) devuelve TODAS, que es el comportamiento de siempre.
 */
export function tabsVisibles(permitidas?: readonly Seccion[]): Tab[] {
  return permitidas ? TABS.filter((t) => permitidas.includes(t.seccion)) : [...TABS];
}

/** ¿Esta tab es la de la ruta actual? Cuenta también las subrutas. */
export function tabActiva(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SelectorFunnel({ funnels }: { funnels: Funnel[] }): JSX.Element | null {
  const searchParams = useSearchParams();
  const router = useRouter();

  if (funnels.length === 0) return null;

  const seleccionado = searchParams.get('f');
  const valor =
    seleccionado && funnels.some((f) => f.slug === seleccionado)
      ? seleccionado
      : funnels[0]!.slug;

  const alCambiar = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    // Se preserva TODO el query string actual: `?range=` tiene que sobrevivir a
    // un cambio de funnel, y viceversa.
    const params = new URLSearchParams(searchParams.toString());
    params.set('f', e.target.value);
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="relative inline-flex items-center">
      <select value={valor} onChange={alCambiar} aria-label="Funnel" className={SELECT_HEADER}>
        {funnels.map((f) => (
          // El VALUE sigue siendo el slug: el alias es sólo presentación y no
          // puede cambiar lo que viaja en la URL.
          <option key={f.slug} value={f.slug} className="bg-surface-raised text-neutral-200">
            {nombreVisible(f)}
          </option>
        ))}
      </select>
      <CaretDown
        size={12}
        weight="bold"
        aria-hidden
        className="pointer-events-none absolute right-3 text-neutral-400"
      />
    </div>
  );
}
