'use client';

/**
 * BarraFrescura (task 20.1 de gestion-campanas-anuncios; las dos edades son la
 * task 11 de frescura-y-acciones-anuncios): la Marca_Frescura y el
 * Boton_Actualizar, alineados a la derecha, entre Tabs_Nivel y Barra_Filtros
 * (R1 c6..c11).
 *
 * DOS EDADES Y NO UNA (R4.5)
 * El panel muestra dos cosas que se traen por caminos distintos y se atrasan por
 * separado: el gasto, que vuelve a pedirse solo cada minuto mientras la pestaña
 * está a la vista, y la Jerarquía —estados, presupuestos, nombres—, que la
 * mantiene un cron cada 15 minutos y que sólo se fuerza a mano. Colapsarlas en
 * un número esconde justamente el bug que se reportó: "cambio algo en Facebook y
 * el panel sigue igual" pasaba con el gasto al día al lado de un estado de hace
 * un cuarto de hora, y la barra decía una sola edad, la del gasto.
 *
 * LA EDAD DE LA JERARQUÍA NO ES UNA ALARMA
 * Que diga "hace 8 min" es el caso NORMAL: el polling automático no la dispara a
 * propósito (R4.8, es una llamada por cuenta y por nivel), así que ese número es
 * el del cron hasta que el usuario aprieta Actualizar. Por eso se dibuja con el
 * mismo tono neutro que la del gasto y el detalle explica de dónde viene, en vez
 * de pintarla de ámbar y sugerir que algo se rompió. Lo que sí es un problema
 * —una corrida que falló— viaja en `errorJerarquia` y ahí sí cambia el tono.
 *
 * EL TEXTO DE LA EDAD LO ARMA `textoEdad` (lib/ads/polling.ts)
 * El mismo para las dos, compartido con el widget de gasto de Ventas y con el
 * Resumen. Cuando la sincronización falló, ese texto dice "sync con error" en
 * lugar de la edad, porque las dos frescuras avanzan su reloj también cuando
 * fallan y la edad pasa a significar "cuándo se intentó"; el mensaje del error va
 * al lado. Abajo de 90 segundos dice "al día" en vez de "hace 0 min", que con el
 * tick de cada minuto es el caso normal y no vale la pena contarlo en minutos.
 *
 * ESTE COMPONENTE NO DECIDE CUÁNDO UNA EDAD DESAPARECE
 * Recibe textos ya resueltos. Que una respuesta sin `forzar` no traiga frescura
 * de Jerarquía —y por lo tanto no pueda borrar la que trajo el último
 * Actualizar— lo resuelve `aplicarRespuesta` en GestorAnuncios, que hidrata por
 * presencia y no por nulo.
 *
 * ACCESIBILIDAD
 * Las dos edades y los dos errores son TEXTO visible, no color ni `title`: un
 * `title` no lo alcanza el teclado ni lo lee un lector de pantalla, así que una
 * marca cuya única información viva ahí no existe para media pantalla. El `title`
 * queda como el detalle largo para el mouse, el mismo criterio que la
 * MarcaFrescura de las filas (celdas.tsx).
 *
 * EL BOTON_ACTUALIZAR
 * Dispara `onActualizar`, que fuerza las DOS sincronizaciones (R4.1). El freno de
 * un refresco cada 10 segundos es del llamador (useRef con el timestamp del
 * disparo), que pasa `segundosRestantes` entre 1 y 10 para informarlo sin llamar
 * a nada (R1 c10, c11). Mientras el refresco está en curso el botón queda
 * deshabilitado con un indicador de carga, y las filas y las marcas previas
 * siguen visibles (R1 c8).
 */

import { Spinner } from '@/components/ui';

const DETALLE_GASTO =
  'El gasto se vuelve a pedir solo cada minuto mientras esta pestaña está a la vista. ' +
  'Actualizar lo fuerza, ignorando el TTL del servidor.';

const DETALLE_JERARQUIA =
  'Los estados, los presupuestos y los nombres los trae la sincronización de la jerarquía: ' +
  'un cron cada 15 minutos, y Actualizar cuando no querés esperarlo. El refresco automático ' +
  'no la dispara, así que mientras nadie apriete el botón esta edad es la del cron.';

/**
 * Una de las dos edades. El rótulo va en el texto y no como `aria-label` porque
 * "gasto" y "jerarquía" es lo que distingue a las dos, y quien las mira o las
 * escucha necesita las dos cosas juntas.
 */
function Edad({
  rotulo,
  edad,
  error,
  detalle,
}: {
  rotulo: string;
  edad: string;
  error: string | null;
  detalle: string;
}): JSX.Element {
  return (
    <span className={`flex flex-wrap items-baseline gap-x-1 ${error ? 'text-warn-400' : 'text-neutral-400'}`}>
      <span title={error ? `${error} — ${detalle}` : detalle}>
        {rotulo} {edad}
      </span>
      {error && <span>— {error}</span>}
    </span>
  );
}

export function BarraFrescura({
  edadGasto,
  errorGasto,
  edadJerarquia,
  errorJerarquia,
  refrescando,
  segundosRestantes,
  onActualizar,
}: {
  /** Texto ya resuelto de la edad del gasto (el Gestor lo arma con `textoEdad`). */
  edadGasto: string;
  errorGasto: string | null;
  /** Texto ya resuelto de la edad de la Jerarquía, del mismo `textoEdad`. */
  edadJerarquia: string;
  errorJerarquia: string | null;
  refrescando: boolean;
  /** null = sin freno activo; 1..10 = segundos que faltan para el próximo disparo. */
  segundosRestantes: number | null;
  onActualizar: () => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <div
        role="group"
        aria-label="Antigüedad de los datos sincronizados"
        className="flex flex-col gap-0.5 text-xs leading-tight"
      >
        <Edad rotulo="gasto" edad={edadGasto} error={errorGasto} detalle={DETALLE_GASTO} />
        <Edad rotulo="jerarquía" edad={edadJerarquia} error={errorJerarquia} detalle={DETALLE_JERARQUIA} />
      </div>
      <button
        type="button"
        onClick={onActualizar}
        disabled={refrescando || segundosRestantes !== null}
        className="inline-flex items-center gap-1.5 rounded-md border border-border-strong px-2.5 py-1.5 text-xs font-semibold text-neutral-200 transition-colors hover:bg-overlay/6 focus:outline-none focus-visible:ring-2 focus-visible:ring-good-500/60 disabled:cursor-not-allowed disabled:opacity-50"
        title={
          segundosRestantes !== null
            ? `Esperá ${segundosRestantes} segundo${segundosRestantes === 1 ? '' : 's'} para volver a actualizar`
            : 'Forzar un refresco del gasto y de la jerarquía —estados, presupuestos y nombres— ignorando los TTL'
        }
      >
        {refrescando ? <Spinner /> : null}
        {refrescando
          ? 'Actualizando…'
          : segundosRestantes !== null
            ? `Actualizar (${segundosRestantes}s)`
            : 'Actualizar'}
      </button>
    </div>
  );
}
