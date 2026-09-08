'use client';

/**
 * Nav — las ocho tabs del panel + el selector de funnel.
 *
 * El selector vive acá y no en cada sección porque Embudo y Ventas lo
 * comparten: cambiar de funnel no puede perder el rango elegido, y viceversa.
 * Por eso cada cambio (tab, funnel, rango) preserva TODO el query string
 * actual: `?f=` y `?range=` sobreviven a la navegación.
 *
 * Filtrar las tabs por `seccionesPermitidas` es COSMÉTICO (D6): esconde los
 * links que le darían un redirect a quien no tiene la sección, pero la
 * seguridad de verdad es el guard del layout y el `guard()` de las routes. Si
 * este filtro no corriera, nadie vería datos que no debe; sólo vería una tab
 * que lo rebota.
 *
 * Los iconos son de Phosphor (D-R11), peso `bold` como el resto del panel.
 */

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { CaretDown } from '@phosphor-icons/react';
import { nombreVisible } from '@/lib/funnel-nombre';
import type { Funnel } from '@/lib/funnels';
// SÓLO el tipo, con `import type`: `lib/permisos.ts` importa `next/headers`
// (server-only) y este componente es `'use client'`. Un import de valor —traer
// la constante `SECCIONES`— arrastraría ese módulo al bundle del cliente y el
// build falla con "You're importing a component that needs next/headers". El
// tipo se borra en compilación, así que no cruza esa frontera.
import type { Seccion } from '@/lib/permisos';

const TABS = [
  { href: '/resumen', label: 'Resumen', seccion: 'resumen' },
  { href: '/embudo', label: 'Embudo', seccion: 'embudo' },
  { href: '/ventas', label: 'Ventas', seccion: 'ventas' },
  { href: '/anuncios', label: 'Anuncios', seccion: 'anuncios' },
  { href: '/finanzas', label: 'Finanzas', seccion: 'finanzas' },
  { href: '/leads', label: 'Leads', seccion: 'leads' },
  // Tareas va ANTES de Config: Config es la última porque es configuración, y
  // Tareas es una pantalla de uso diario. Apunta a /tareas, que existe recién
  // con T06 (§7 del plan): hasta entonces el link da 404, y es esperado.
  { href: '/tareas', label: 'Tareas', seccion: 'tareas' },
  { href: '/config', label: 'Config', seccion: 'config' },
] satisfies { href: string; label: string; seccion: Seccion }[];

/**
 * El estilo compartido de los dos <select> del header (funnel y período).
 * Está acá y lo importa `RangePicker` porque son el MISMO control con datos
 * distintos: cuando divergen, el header se ve desalineado.
 *
 * Fondo SÓLIDO y no un `bg-overlay/N` translúcido. Un <select> sin
 * background-color resuelto se pinta con el default del navegador, que es
 * BLANCO: en un panel oscuro se ve como un bug de color, y es exactamente lo
 * que pasaba cuando la escala de opacidad no tenía el valor usado. Con un
 * token sólido no depende de eso.
 */
export const SELECT_HEADER =
  'press appearance-none rounded-lg border border-border-strong bg-surface-raised py-1.5 pl-3 pr-8 text-sm font-medium text-neutral-200 shadow-inset-highlight transition-[background-color,border-color,box-shadow] duration-250 hover:border-overlay/18 hover:bg-surface-overlay';

export function Nav({
  funnels,
  saldoPendiente = false,
  seccionesPermitidas,
  nombre,
}: {
  funnels: Funnel[];
  /**
   * true = falta cargar el saldo de hoy en alguna cuenta. Pone un punto en la
   * tab de Finanzas.
   *
   * El punto está además del aviso flotante (`AvisoSaldo`) y no en su lugar,
   * porque los dos duran distinto: el aviso se descarta con "Después" y no
   * vuelve hasta mañana, mientras que el punto se queda hasta que el saldo esté
   * cargado de verdad. Si el único recordatorio fuera descartable, "después" y
   * "listo" se volverían indistinguibles.
   */
  saldoPendiente?: boolean;
  /**
   * Las secciones que el usuario puede ver. Sólo se muestran esas tabs (D6, y
   * es cosmético: la seguridad es el guard). Opcional: si NO viene (por ejemplo
   * si alguien monta el componente sin la prop), se muestran TODAS las tabs,
   * que es el comportamiento de siempre. El layout de `(panel)` siempre la pasa
   * con `sesion.secciones`.
   */
  seccionesPermitidas?: readonly Seccion[];
  /**
   * El nombre del usuario logueado. Con dos personas usando el mismo panel,
   * saber con cuál estás deja de ser un detalle: es lo que evita crear una
   * tarea con el dueño equivocado. Va al lado de Salir.
   */
  nombre?: string;
}) {
  const pathname = usePathname() ?? '/';
  const searchParams = useSearchParams();
  const router = useRouter();

  // Sólo las tabs de las secciones permitidas (D6). El filtro es cosmético: el
  // guard del layout y el `guard()` de las routes son la seguridad de verdad.
  // Sin la prop (undefined) se muestran todas, que es el comportamiento de siempre.
  const tabsVisibles = seccionesPermitidas
    ? TABS.filter((t) => seccionesPermitidas.includes(t.seccion))
    : TABS;

  const onFunnelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('f', e.target.value);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const selectedFunnel = searchParams.get('f');

  return (
    <nav className="flex flex-wrap items-center gap-2.5">
      {/*
        Control segmentado, no una fila de links. El canal es un surco hundido
        (fondo más oscuro que el header + sombra interna) y la tab activa una
        pastilla que FLOTA dentro de él: por eso el canal lleva sombra hacia
        adentro y la pastilla hacia afuera. Es la misma lógica de luz que el
        resto del panel, y es lo que hace que se lea como un objeto físico.

        La tab activa se marca con TRES señales a la vez, no sólo con el color
        de la letra: la pastilla elevada, el peso semibold y una barra corta
        debajo del texto. Con siete tabs del mismo largo, un cambio de color de
        letra no alcanza para responder "dónde estoy" de un vistazo.

        Nada de eso ocupa espacio: la pastilla es fondo, la barra es un
        pseudo-elemento posicionado y el ancho de la tab lo fija el `after` del
        texto en negrita (ver abajo). Así las tabs no se mueven un pixel al
        cambiar de sección.
      */}
      <ul className="flex items-center gap-0.5 rounded-xl bg-canvas/60 p-1 shadow-[inset_0_1px_2px_0_rgba(4,6,14,0.6),inset_0_0_0_1px_rgba(255,255,255,0.05)]">
        {tabsVisibles.map((t) => {
          const tab = { ...t, pendiente: t.href === '/finanzas' && saldoPendiente };
          const active =
            pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <li key={tab.href}>
              <Link
                href={{ pathname: tab.href, search: searchParams.toString() }}
                aria-current={active ? 'page' : undefined}
                className={`press relative block rounded-lg px-3 py-1.5 text-sm transition-[background-color,color,box-shadow] duration-250 ${
                  active
                    ? 'bg-surface-raised font-semibold text-neutral-50 shadow-lozenge after:absolute after:inset-x-3 after:bottom-1 after:h-0.5 after:rounded-full after:bg-good-500 after:content-[""]'
                    : 'font-medium text-neutral-400 hover:bg-overlay/7 hover:text-neutral-100'
                }`}
              >
                {/*
                  El truco del ancho: los dos labels se apilan en la MISMA
                  celda de un grid, así la celda mide lo que mide el más ancho
                  —el semibold— siempre. Sin esto la tab se ensancha al
                  activarse (medium → semibold ocupa más) y las otras seis se
                  corren de lugar en cada navegación. Es el jitter que ya tenía
                  el nav y que no se veía porque nadie mira las otras tabs
                  mientras cambia de sección.
                */}
                <span className="grid">
                  <span
                    aria-hidden
                    className="invisible col-start-1 row-start-1 font-semibold"
                  >
                    {tab.label}
                  </span>
                  <span className="col-start-1 row-start-1">{tab.label}</span>
                </span>
                {/*
                  El punto de pendiente. Va `absolute` y NO en el flujo para no
                  ensanchar la tab: el truco del grid de arriba fija el ancho
                  contra el label en semibold, y un punto que ocupara espacio
                  correría las otras seis tabs cada vez que aparece o se va —
                  justo el jitter que ese grid existe para evitar.

                  El texto para lector de pantalla va aparte y en `sr-only`,
                  porque un punto de color no dice nada a quien no lo ve.
                */}
                {tab.pendiente && (
                  <>
                    <span
                      aria-hidden
                      className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-warn-500"
                    />
                    <span className="sr-only"> (falta cargar el saldo de hoy)</span>
                  </>
                )}
              </Link>
            </li>
          );
        })}
      </ul>

      {funnels.length > 0 && (
        <div className="relative inline-flex items-center">
          <select
            value={
              selectedFunnel && funnels.some((f) => f.slug === selectedFunnel)
                ? selectedFunnel
                : funnels[0]!.slug
            }
            onChange={onFunnelChange}
            aria-label="Funnel"
            className={SELECT_HEADER}
          >
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
      )}

      {/*
        El nombre del usuario logueado, al lado de los controles del header
        (Salir queda inmediatamente después, en el layout). Con dos personas
        usando el mismo panel, saber con cuál estás deja de ser un detalle: es
        lo que evita crear una tarea con el dueño equivocado. `text-neutral-400`
        y el mismo tamaño que "Salir".
      */}
      {nombre && (
        <span className="px-2.5 py-1.5 text-sm font-medium text-neutral-400">
          {nombre}
        </span>
      )}
    </nav>
  );
}
