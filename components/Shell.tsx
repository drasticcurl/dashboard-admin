'use client';

/**
 * Shell — el marco del panel: sidebar en desktop, drawer en mobile.
 *
 * ── Por qué dejó de ser un header con tabs ──────────────────────────────────
 *
 * Con nueve secciones, el control segmentado horizontal que había en el header
 * no entra en 760px: hacía wrap a dos filas y el header —que es sticky— pasaba a
 * medir ~120px de alto, o sea un tercio de la pantalla de un teléfono ocupada
 * permanentemente por la navegación. Un sidebar crece hacia abajo, donde sí hay
 * lugar, y en mobile desaparece del todo detrás de un botón.
 *
 * ── Las tres decisiones que importan ────────────────────────────────────────
 *
 * 1. **El sidebar es `fixed` y el contenido lleva `padding-left`**, no un flex
 *    de dos columnas. Con flex, el sidebar es tan alto como la página y en una
 *    pantalla de 4000px de contenido el logo y «Salir» quedan arriba, fuera de
 *    vista: para cambiar de sección hay que volver al tope. Con `fixed` el
 *    sidebar siempre está.
 *
 * 2. **El drawer se desmonta cuando se cierra**, no se esconde con
 *    `translate-x`. Un drawer escondido pero montado deja sus nueve links en el
 *    orden de tabulación: quien navega con teclado en mobile tabula por un menú
 *    invisible antes de llegar al contenido. Y el `hidden` de CSS no lo arregla
 *    en todos los navegadores si el elemento tiene una transición corriendo.
 *
 * 3. **El drawer cierra al navegar**, con un efecto sobre el pathname. Sin eso,
 *    tocar «Ventas» carga la pantalla nueva DETRÁS del menú abierto, y el gesto
 *    queda a mitad de camino.
 */

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { List, X } from '@phosphor-icons/react';
import type { Funnel } from '@/lib/funnels';
import type { Seccion } from '@/lib/permisos';
import { PANEL_TITLE } from '@/lib/brand';
import { nombreVisible } from '@/lib/funnel-nombre';
import { nombreZona } from '@/lib/zona-nombre';
import { PanelLogo } from '@/components/PanelLogo';
import { EncabezadoPagina } from '@/components/EncabezadoPagina';
import { funnelElegido, tabActiva, tabsVisibles, type Tab } from '@/components/Nav';
import { SwitchMoneda } from '@/components/SwitchMoneda';

/** El ancho del sidebar (handoff: 220px). */
const ANCHO_SIDEBAR = 'w-[220px]';

/**
 * Qué dice cada pantalla debajo de su título, y qué filtros le sirven.
 *
 * El subtítulo no es decorativo: dice QUÉ contesta la pantalla, que es justo lo
 * que un título de una palabra no dice. Los de Resumen, Embudo, Ventas y
 * Anuncios son los de las capturas de referencia.
 *
 * `funnel` y `periodo` se declaran por pantalla porque no todas dependen de los
 * dos: Tareas no tiene período (una tarea no pertenece a un rango) y Config no
 * tiene ninguno salvo las secciones por funnel, que traen su propio selector.
 *
 * `moneda` es el switch EUR/USD (components/SwitchMoneda.tsx). Por ahora sólo
 * el Resumen sabe convertir al leer; prenderlo en otra pantalla sin que su
 * query lea `?moneda=` dejaría un switch que no hace nada.
 *
 * `general` agrega «General» (todos los funnels) al selector. Sólo el Resumen:
 * es la única pantalla que suma funnels, cada uno con el día de su zona.
 *
 * `zona: false` saca "· hora de X" de la pastilla en una pantalla con funnel que
 * no corta el período por día en la zona del funnel (Creativos es un registro
 * manual): ahí la zona no diría nada cierto.
 */
const PANTALLAS: Record<
  string,
  { subtitulo: string; funnel: boolean; periodo: boolean; moneda?: boolean; general?: boolean; zona?: boolean }
> = {
  '/resumen':   { subtitulo: 'Cómo viene el período, en una mirada.',        funnel: true,  periodo: true, moneda: true, general: true },
  '/embudo':    { subtitulo: 'Dónde se cae la gente, paso por paso.',        funnel: true,  periodo: true },
  '/ventas':    { subtitulo: 'Lo que entró, lo que costó y lo que quedó.',   funnel: true,  periodo: true },
  '/anuncios':  { subtitulo: 'Tocá un presupuesto para editarlo ahí mismo.', funnel: true,  periodo: true },
  '/finanzas':  { subtitulo: 'El patrimonio medido, día por día.',           funnel: false, periodo: false },
  '/leads':     { subtitulo: 'Quiénes dejaron sus datos y en qué estado.',   funnel: true,  periodo: true },
  '/tareas':    { subtitulo: 'Qué hay que hacer y en qué anda cada cosa.',   funnel: false, periodo: false },
  '/creativos': { subtitulo: 'Qué creativo rinde y cuál no.',                funnel: true,  periodo: true, zona: false },
  '/config':    { subtitulo: 'Funnels, dinero, fuentes y sistema.',          funnel: false, periodo: false },
};

/** La pantalla a la que pertenece la ruta actual, contando las subrutas. */
function pantallaDe(pathname: string): { href: string; label: string } | null {
  const tab = tabsVisibles().find((t) => tabActiva(t.href, pathname));
  return tab ? { href: tab.href, label: tab.label } : null;
}

export function Shell({
  funnels,
  saldoPendiente = false,
  seccionesPermitidas,
  nombre,
  salir,
  children,
}: {
  funnels: Funnel[];
  /**
   * true = falta cargar el saldo de hoy en alguna cuenta. Pone un punto del
   * acento de 7px en Finanzas (es un "tocá acá", no un buen resultado: en verde
   * se leía como "Finanzas está bien", que es justo lo contrario), y otro en el botón hamburguesa (donde el de Finanzas no
   * se ve, porque el menú está cerrado).
   *
   * El punto está además del aviso flotante (`AvisoSaldo`) y no en su lugar,
   * porque los dos duran distinto: el aviso se descarta con "Después" y no
   * vuelve hasta mañana, mientras que el punto se queda hasta que el saldo esté
   * cargado de verdad. Si el único recordatorio fuera descartable, "después" y
   * "listo" se volverían indistinguibles.
   */
  saldoPendiente?: boolean;
  /** Las secciones que el usuario puede ver (D6, cosmético: la seguridad es el guard). */
  seccionesPermitidas?: readonly Seccion[];
  /**
   * El nombre del usuario logueado. Con dos personas usando el mismo panel,
   * saber con cuál estás deja de ser un detalle: es lo que evita crear una
   * tarea con el dueño equivocado.
   */
  nombre?: string;
  /**
   * El `<form>` con la server action de logout, pasado ya renderizado desde el
   * layout. Va como prop y no se importa acá porque este componente es
   * `'use client'` y la action vive en un server component: pasar el JSX ya
   * armado es la forma soportada de cruzar esa frontera.
   */
  salir: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const pathname = usePathname() ?? '/';
  const searchParams = useSearchParams();
  const [drawerAbierto, setDrawerAbierto] = useState(false);
  const tabs = tabsVisibles(seccionesPermitidas);

  const pantalla = pantallaDe(pathname);
  const conf = pantalla ? PANTALLAS[pantalla.href] : undefined;

  /**
   * La pastilla al lado del título: el funnel elegido y la zona con la que esa
   * pantalla corta el día ("Astra Tarot · hora de Buenos Aires"), o «General» en
   * el Resumen sin `?f=`.
   *
   * Sale de `funnelElegido`, la misma función que usa el <select>: si acá se
   * resolviera distinto, la pastilla diría un funnel y el selector otro. La zona
   * va porque desde el 2026-10-04 no todos los funnels cortan el día a la misma
   * hora, y un "hoy" sin reloj es lo que confundió el ROI de Astra.
   */
  const chipFunnel = (() => {
    if (funnels.length === 0) return null;
    const elegido = funnelElegido(funnels, searchParams.get('f'), conf?.general ?? false);
    if (!elegido) return { nombre: 'General', zona: null };
    return {
      nombre: nombreVisible(elegido),
      zona: conf?.zona === false ? null : nombreZona(elegido.timezone),
    };
  })();

  // Cierra al navegar (decisión 3). Sin esto la pantalla nueva carga detrás del
  // menú abierto.
  useEffect(() => setDrawerAbierto(false), [pathname]);

  // Escape cierra, y mientras está abierto se bloquea el scroll del fondo: un
  // drawer sobre una página que se sigue moviendo debajo se lee como un glitch.
  useEffect(() => {
    if (!drawerAbierto) return;
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerAbierto(false);
    };
    const overflowPrevio = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', alTeclear);
    return () => {
      document.body.style.overflow = overflowPrevio;
      document.removeEventListener('keydown', alTeclear);
    };
  }, [drawerAbierto]);

  return (
    <>
      {/* ── Sidebar de desktop ─────────────────────────────────────────────── */}
      <aside
        className={`fixed inset-y-0 left-0 z-barra hidden ${ANCHO_SIDEBAR} flex-col border-r border-divider bg-surface panel:flex`}
      >
        <Link
          href="/resumen"
          className="flex shrink-0 items-center gap-2.5 px-4 py-4 text-neutral-100 transition-colors hover:text-neutral-50"
        >
          <PanelLogo />
          {/* El nombre del panel es de las pocas cosas en `font-display` (D6):
              es la marca, y un punto más grande que los ítems para que el
              sidebar tenga una cabeza y no sea una lista más. */}
          <span className="truncate font-display text-[15px] font-semibold -tracking-[0.015em]">
            {PANEL_TITLE}
          </span>
        </Link>

        {/* `overflow-y-auto` y no un alto fijo: con nueve items y un usuario de
            nombre largo, en una laptop de 13" en escala 125% el bloque de abajo
            se salía de la pantalla. */}
        <nav aria-label="Secciones del panel" className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          <ul className="flex flex-col gap-0.5">
            {tabs.map((t) => (
              <li key={t.href}>
                <ItemNav
                  tab={t}
                  activo={tabActiva(t.href, pathname)}
                  pendiente={t.href === '/finanzas' && saldoPendiente}
                />
              </li>
            ))}
          </ul>
        </nav>

        <div className="shrink-0 border-t border-divider px-3 py-3">
          <PieUsuario nombre={nombre} salir={salir} />
        </div>
      </aside>

      {/* ── Drawer de mobile ───────────────────────────────────────────────── */}
      {drawerAbierto && (
        <>
          <div
            aria-hidden
            className="fixed inset-0 z-modal bg-canvas/75 backdrop-blur-sm panel:hidden"
            onClick={() => setDrawerAbierto(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Secciones del panel"
            className="fixed inset-y-0 left-0 z-modal flex w-[min(84%,300px)] flex-col border-r border-divider bg-surface shadow-popover panel:hidden"
          >
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-divider px-3 py-3">
              <span className="flex min-w-0 items-center gap-2.5 text-neutral-100">
                <PanelLogo />
                <span className="truncate font-display text-[15px] font-semibold -tracking-[0.015em]">
                  {PANEL_TITLE}
                </span>
              </span>
              <button
                type="button"
                onClick={() => setDrawerAbierto(false)}
                aria-label="Cerrar el menú"
                className="tap press shrink-0 rounded-lg text-neutral-400 transition-colors duration-250 hover:bg-overlay/8 hover:text-neutral-100"
              >
                <X size={20} weight="bold" aria-hidden />
              </button>
            </div>

            <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
              <ul className="flex flex-col gap-0.5">
                {tabs.map((t) => (
                  <li key={t.href}>
                    <ItemNav
                      tab={t}
                      activo={tabActiva(t.href, pathname)}
                      pendiente={t.href === '/finanzas' && saldoPendiente}
                      alto
                    />
                  </li>
                ))}
              </ul>
            </nav>

            <div className="shrink-0 border-t border-divider px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <PieUsuario nombre={nombre} salir={salir} />
            </div>
          </div>
        </>
      )}

      {/* ── Contenido ──────────────────────────────────────────────────────── */}
      {/*
        `padding-left` y no un flex de dos columnas (decisión 1). El sidebar es
        fixed, así que no ocupa lugar en el flujo: este padding es el que le
        reserva el espacio.
      */}
      <div className="panel:pl-[220px]">
        {/*
          La barra sticky de mobile: SÓLO la hamburguesa y el nombre de la
          sección. Los filtros se fueron al encabezado de página (ver
          EncabezadoPagina.tsx): acá flotaban solos en una franja propia y en
          mobile hacían wrap, comiéndose ~115px de alto antes del contenido.

          En desktop esta barra no existe: el sidebar ya dice dónde estás.
        */}
        <header className="glass-bar sticky top-0 z-barra flex items-center gap-2 px-4 py-2 panel:hidden">
          <button
            type="button"
            onClick={() => setDrawerAbierto(true)}
            aria-label="Abrir el menú de secciones"
            aria-expanded={drawerAbierto}
            className="tap press relative -ml-1 shrink-0 rounded-lg text-neutral-300 transition-colors duration-250 hover:bg-overlay/8 hover:text-neutral-100"
          >
            <List size={22} weight="bold" aria-hidden />
            {/* El punto de saldo pendiente también acá: con el menú cerrado, el
                de Finanzas no se ve, así que el recordatorio no existiría en
                mobile. */}
            {saldoPendiente && (
              <>
                <span
                  aria-hidden
                  className="absolute right-2 top-2 h-[7px] w-[7px] rounded-full bg-acento-500"
                />
                <span className="sr-only"> (falta cargar el saldo de hoy)</span>
              </>
            )}
          </button>
          <span className="truncate text-sm font-medium text-neutral-300">
            {pantalla?.label ?? PANEL_TITLE}
          </span>
        </header>

        {/*
          `reveal` escalona la entrada de los bloques de la pantalla (ver
          globals.css). Va acá, a nivel de página, y NO en el primitivo `Grid`:
          los hijos de esa grilla son los widgets arrastrables y llevan un
          `transform` inline de dnd-kit que una animación CSS pisaría, porque en
          la cascada las animaciones ganan a los estilos inline.

          Padding del handoff: 36px 40px 96px en desktop, 20px 16px 96px en
          mobile. El inferior es mucho más grande que el superior porque
          ópticamente un bloque con el mismo aire arriba y abajo se ve caído
          hacia el final de la página — y además es donde se apoya el aviso
          flotante de saldo, que así no tapa contenido.

          `overflow-x-clip`: el cinturón de seguridad contra el desborde
          horizontal. Medido antes de esto, /anuncios a 390px daba un documento
          de 1269px —o sea que la PÁGINA ENTERA se arrastraba de costado, que es
          el síntoma de "es la misma que la web"—. El scroll lateral tiene que
          vivir dentro del contenedor de la tabla y no acá. `clip` y no `hidden`
          porque `hidden` en un eje convierte el otro en scroll container y
          rompería el `position: sticky` del encabezado.
        */}
        <main
          id="contenido"
          className="reveal mx-auto max-w-[1320px] overflow-x-clip px-4 pb-24 pt-5 panel:px-10 panel:pt-9"
        >
          {pantalla && (
            <EncabezadoPagina
              titulo={pantalla.label}
              subtitulo={conf?.subtitulo}
              funnels={funnels}
              conFunnel={conf?.funnel ?? false}
              conGeneral={conf?.general ?? false}
              conPeriodo={conf?.periodo ?? false}
              chip={
                conf?.funnel && chipFunnel ? (
                  <span className="rounded-md bg-acento-900 px-2 py-0.5 text-xs font-medium text-acento-200">
                    {chipFunnel.nombre}
                    {chipFunnel.zona && (
                      <span className="font-normal text-acento-300"> · hora de {chipFunnel.zona}</span>
                    )}
                  </span>
                ) : null
              }
            >
              {/* El switch va en `children`, que EncabezadoPagina dibuja a la
                  izquierda del selector de funnel. */}
              {conf?.moneda && <SwitchMoneda />}
            </EncabezadoPagina>
          )}
          {children}
        </main>
      </div>
    </>
  );
}

/**
 * El pie del sidebar: avatar con la inicial, nombre, y «Salir» a la derecha.
 *
 * Una sola fila, como en la captura de referencia. Antes era el nombre en una
 * línea y abajo un botón con borde y fondo propio: medía el doble de alto y,
 * al tener el mismo tratamiento visual que los ítems de navegación, «Salir»
 * competía con ellos —parecía una décima sección en vez de la salida—.
 *
 * Ahora «Salir» es un link de texto en el acento: se ve que es una acción y no
 * un lugar al que se va.
 *
 * El avatar va en `acento-800`: es "vos", o sea interfaz. En verde parecía un
 * estado ("usuario activo / ok") que nadie estaba informando.
 */
function PieUsuario({ nombre, salir }: { nombre?: string; salir: ReactNode }): JSX.Element {
  const inicial = nombre?.trim()?.[0]?.toUpperCase() ?? '?';
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-acento-800 text-xs font-medium text-acento-100"
      >
        {inicial}
      </span>
      {nombre && (
        <span className="min-w-0 flex-1 truncate text-sm text-neutral-300" title={nombre}>
          {nombre}
        </span>
      )}
      <span className="shrink-0">{salir}</span>
    </div>
  );
}

/**
 * Un item de navegación.
 *
 * El estado activo se marca con TRES señales a la vez y no sólo con el color de
 * la letra: fondo `acento-900`, texto `acento-100` y la costura vertical a la
 * izquierda. Con nueve items del mismo largo, un cambio de color de letra no
 * alcanza para responder "dónde estoy" de un vistazo.
 *
 * La costura (`.costura-v`, globals.css) reemplaza a la barra lisa de 2px que
 * había hasta v3, y es el primero de los cuatro lugares donde D7 la permite:
 * el hilván marca "por acá vas". Va como elemento `absolute` y no como un
 * borde: un `border-left` corre el contenido 2px cuando aparece, así que el
 * rótulo de la sección activa quedaría desalineado con los otros ocho.
 */
function ItemNav({
  tab,
  activo,
  pendiente,
  alto = false,
}: {
  tab: Tab;
  activo: boolean;
  pendiente: boolean;
  /** true en el drawer: items de 48px de alto (handoff). */
  alto?: boolean;
}): JSX.Element {
  const searchParams = useSearchParams();
  const Icono = tab.icono;

  return (
    <Link
      href={{ pathname: tab.href, search: searchParams.toString() }}
      aria-current={activo ? 'page' : undefined}
      className={`press relative flex items-center gap-2.5 rounded-lg px-2.5 text-sm transition-[background-color,color] duration-250 ${
        alto ? 'min-h-[48px]' : 'py-2'
      } ${
        activo
          ? 'bg-acento-900 font-medium text-acento-100'
          : 'text-neutral-400 hover:bg-overlay/7 hover:text-neutral-100'
      }`}
    >
      {/* `h-auto` pisa el `height: 100%` de la receta para que manden los
          `inset-y`: la puntada queda dentro del ítem y no pegada a sus cantos. */}
      {activo && <span aria-hidden className="costura-v absolute inset-y-2 left-0 h-auto" />}
      <Icono
        size={17}
        weight="bold"
        aria-hidden
        className={`shrink-0 ${activo ? 'text-acento-400' : ''}`}
      />
      <span className="truncate">{tab.label}</span>
      {pendiente && (
        <>
          <span
            aria-hidden
            className="ml-auto h-[7px] w-[7px] shrink-0 rounded-full bg-acento-500"
          />
          <span className="sr-only"> (falta cargar el saldo de hoy)</span>
        </>
      )}
    </Link>
  );
}
