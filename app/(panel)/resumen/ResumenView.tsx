'use client';

/**
 * ResumenView — la pantalla del Resumen unificado (task T08), rediseñada con
 * widgets configurables (T05).
 *
 * Recibe los datos iniciales que renderizó el server y se maneja sola de ahí
 * en adelante: un cambio de rango (RangePicker) o de funnel (`?f=`, el General
 * o el tablero de un funnel) refetchea /api/data/overview sin recargar la
 * página. El layout guardado también baja del server como
 * prop, así que la primera pintura ya muestra el layout del usuario.
 *
 * Fuera del grid de widgets quedan (T05 §3): el título, el banner de error,
 * el banner de rollup viejo y el pie con la fecha del último rollup — son
 * estado del sistema y no pueden depender de que el usuario tenga un widget
 * puesto. Las alertas del sistema son un widget más del catálogo (con sus
 * links a /ventas?f= y /config intactos).
 *
 * Los tres estados (§9.10 del plan): cargando con Skeleton con la forma de
 * los widgets, vacío con EmptyState compuesto arriba del grid (los widgets
 * siguen a la vista para poder editarlos), y error con reintentar.
 *
 * No se importa nada en runtime desde lib/queries/overview.ts a propósito:
 * ese archivo importa pg, y traerlo al bundle del browser rompería el build
 * del client. Los tipos entran como `import type`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { WidgetGrid } from '@/components/WidgetGrid';
import { catalogoResumen } from '@/lib/widgets/catalogo-resumen';
import { layoutPorDefectoResumen } from './layout-por-defecto';
import type { OverviewData } from '@/lib/queries/overview';
import type { FrescuraAds } from '@/lib/ads/live';
import type { WidgetLayout } from '@/lib/widgets/tipos';
import { textoEdad, usePollingGasto } from '@/lib/ads/polling';
import { Badge, Banner, EmptyState, Skeleton, Spinner, fmtDateTime } from '@/components/ui';
import { MONEDA_REPORTE, leerMonedaVista } from '@/lib/moneda-reporte';
import { nombreZona } from '@/lib/zona-nombre';

// El reloj '14:20' de los avisos. La query lo arma con DASHBOARD_TZ en el
// server; acá se usa la TZ del browser, que es lo que el usuario espera ver.
function fmtClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit' }).format(d);
}

/** '2026-09-27' → '27/09', para la cotización al lado del switch. */
function fmtDiaCorto(dia: string): string {
  return `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
}

/** 0,8612: cuatro decimales, que es donde se mueve un cruce EUR/USD. */
const fmtCotizacion = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 4, maximumFractionDigits: 4 });

/**
 * Qué dispara un pedido, y cómo se ve mientras viaja:
 *  · `completo` — cambió el rango o se reintentó: esqueleto en lugar del grid.
 *  · `moneda`   — sólo cambió el switch EUR/USD: el grid se queda con los
 *                 números viejos (que siguen diciendo su moneda de verdad,
 *                 `data.moneda`) y se reemplazan cuando llegan los nuevos. Un
 *                 toggle no debería vaciar la pantalla ni tirar ediciones de
 *                 layout sin guardar.
 *  · `tick`     — el polling del gasto: silencioso, y cede si hay otro en vuelo.
 */
type ModoCarga = 'completo' | 'moneda' | 'tick';

/** Esqueleto con la forma del contenido: los 4 KPIs, el gráfico y la tabla. */
function EsqueletoResumen(): JSX.Element {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Skeleton variant="kpi" />
        <Skeleton variant="kpi" />
        <Skeleton variant="kpi" />
        <Skeleton variant="kpi" />
      </div>
      <Skeleton variant="chart" />
      <Skeleton variant="table" rows={4} />
    </div>
  );
}

export function ResumenView({
  initialData,
  adsFreshness,
  layoutGuardado,
}: {
  initialData: OverviewData;
  adsFreshness: FrescuraAds;
  layoutGuardado: WidgetLayout | null;
}) {
  const searchParams = useSearchParams();

  const [data, setData] = useState<OverviewData>(initialData);
  const [frescura, setFrescura] = useState<FrescuraAds>(adsFreshness);
  const [loading, setLoading] = useState(false);
  const [cambiandoMoneda, setCambiandoMoneda] = useState(false);
  const [refrescando, setRefrescando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  // Lo que define el pedido, separado en sus dos mitades: el alcance + el rango,
  // y la moneda. Separarlas es lo que permite que el switch no muestre el
  // esqueleto. `?f=` es el alcance (General o un funnel): cambiarlo cambia el
  // reloj con el que se corta "hoy", así que va con el rango y no con la moneda.
  const funnelParam = searchParams.get('f');
  const rangeParam = searchParams.get('range');
  const fromParam = searchParams.get('from');
  const toParam = searchParams.get('to');
  const moneda = leerMonedaVista(searchParams.get('moneda'));

  const enVuelo = useRef<AbortController | null>(null);

  // Un solo camino de fetch para los tres disparadores (ver ModoCarga).
  // `tick` NO es cosmético: `loading` desmonta el WidgetGrid, y hacerlo cada
  // minuto haría parpadear la pantalla entera y tiraría las ediciones de layout
  // sin guardar. El tick cambia los números en su lugar y nada más.
  const cargar = useCallback(
    (modo: ModoCarga): void => {
      if (enVuelo.current) {
        // El polling cede: si ya hay un pedido abierto (un cambio de rango, o
        // el tick anterior que tardó más que el intervalo), este tick se
        // saltea. Los otros dos son al revés: mandan, y abortan lo que haya.
        if (modo === 'tick') return;
        enVuelo.current.abort();
      }
      const ctrl = new AbortController();
      enVuelo.current = ctrl;

      if (modo === 'tick') {
        setRefrescando(true);
      } else if (modo === 'moneda') {
        setCambiandoMoneda(true);
        setError(null);
      } else {
        setLoading(true);
        setError(null);
      }

      const params = new URLSearchParams();
      if (funnelParam) params.set('f', funnelParam);
      if (fromParam && toParam) {
        params.set('from', fromParam);
        params.set('to', toParam);
      } else {
        params.set('range', rangeParam ?? 'today');
      }
      if (moneda !== MONEDA_REPORTE) params.set('moneda', moneda);

      fetch(`/api/data/overview?${params.toString()}`, {
        signal: ctrl.signal,
        cache: 'no-store',
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return (await res.json()) as OverviewData & { adsFreshness?: FrescuraAds };
        })
        .then((body) => {
          setData(body);
          // El route refresca el gasto igual que el render del server: sin
          // tomar la frescura nueva, la marca seguiría contando la antigüedad
          // del primer render con los números ya al día.
          if (body.adsFreshness) setFrescura(body.adsFreshness);
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          // Un tick que falla no tapa la pantalla con el banner rojo: los
          // números que se están viendo siguen siendo válidos, solo quedaron
          // viejos, y la marca de frescura ya lo cuenta. El error del cambio de
          // rango o de moneda sí se muestra: lo que se ve no es lo que se pidió.
          if (modo !== 'tick') setError(err instanceof Error ? err.message : 'Error de red');
        })
        .finally(() => {
          if (enVuelo.current === ctrl) enVuelo.current = null;
          if (modo === 'tick') setRefrescando(false);
          else if (modo === 'moneda') setCambiandoMoneda(false);
          else setLoading(false);
        });
    },
    [funnelParam, rangeParam, fromParam, toParam, moneda],
  );

  // La primera pintura ya trae los datos del server: no refetchear al montar,
  // solo ante cambios de rango, de moneda o retry. Se compara contra lo último
  // que se pidió para saber cuál de los tres cambió.
  const claveRango = `${funnelParam ?? ''}|${rangeParam ?? ''}|${fromParam ?? ''}|${toParam ?? ''}`;
  const ultimo = useRef({ claveRango, moneda, retryTick });
  useEffect(() => {
    const antes = ultimo.current;
    ultimo.current = { claveRango, moneda, retryTick };
    if (antes.claveRango === claveRango && antes.moneda === moneda && antes.retryTick === retryTick) return;
    const soloMoneda = antes.claveRango === claveRango && antes.retryTick === retryTick;
    cargar(soloMoneda ? 'moneda' : 'completo');
  }, [cargar, claveRango, moneda, retryTick]);

  // Al desmontar, lo que esté en vuelo se aborta: sin esto un setData llegaría
  // a un componente que ya no existe.
  useEffect(() => () => enVuelo.current?.abort(), []);

  // Si el server pintó sin esperar al sync (`refreshed: false` con
  // `ageSeconds` ya vencido — ver `esperar: false` en resumen/page.tsx), no hay
  // que esperar el intervalo completo de usePollingGasto para ponerse al día:
  // se dispara un tick silencioso apenas monta. Es SOLO al montar (deps vacías
  // a propósito) — un cambio de rango ya tiene su propio fetch no silencioso
  // arriba, y repetir esto en cada re-render de `frescura` crearía un loop.
  useEffect(() => {
    if (!adsFreshness.refreshed) cargar('tick');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // El gasto de Meta cada minuto (lib/ads/polling.ts): el route refresca contra
  // Meta antes de leer, así que repetir el pedido ES el refresco. Con un rango
  // cerrado no cuesta una llamada — `ensureFreshAdSpend` sale antes — y el
  // pedido igual repinta las ventas, que sí se mueven.
  usePollingGasto(() => cargar('tick'), { pausado: loading });

  const edadGasto = textoEdad(frescura) ?? '—';
  const empty = data.funnels.every((f) => f.sessions === 0 && f.orders === 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <RelojAlcance alcance={data.alcance} />
          {(loading || cambiandoMoneda) && (
            <span className="flex items-center gap-2 text-xs text-neutral-500">
              <Spinner /> {cambiandoMoneda ? `Pasando a ${moneda}…` : 'Actualizando…'}
            </span>
          )}
          {/* La cotización con la que se convirtió el último día del rango. Los
              días anteriores usan cada uno la suya (lo dice el title): mostrar
              una sola cotización sin aclararlo haría creer que el mes entero se
              convirtió con la de hoy. */}
          {data.cotizacion && !cambiandoMoneda && (
            <span
              className="font-mono text-xs tabular-nums text-neutral-500"
              title={`Cada día del período se convierte con la cotización de ese día. Esta es la del ${fmtDiaCorto(
                data.cotizacion.dia,
              )} (fuente: ${data.cotizacion.source}).`}
            >
              1 {data.moneda} = {fmtCotizacion.format(data.cotizacion.rate)} {MONEDA_REPORTE}
              {data.cotizacion.dia !== (data.byDay[data.byDay.length - 1]?.day ?? data.cotizacion.dia) &&
                ` · del ${fmtDiaCorto(data.cotizacion.dia)}`}
            </span>
          )}
        </div>

        {/* La marca de frescura del gasto. El de ads es el único número de esta
            pantalla que puede quedar atrás sin que nada falle: las ventas las
            escribe un webhook cuando pasan, el gasto hay que ir a buscarlo a
            Meta. Decir la antigüedad acá es lo que permite leer el Resultado y
            el ROAS sin desconfiar. El título tiene el error completo cuando el
            sync viene fallando. */}
        <span
          title={frescura.error ?? undefined}
          className={`flex items-center gap-2 text-xs ${
            frescura.error ? 'text-warn-400' : 'text-neutral-500'
          }`}
        >
          {refrescando && <Spinner />}
          gasto {edadGasto}
        </span>
      </div>

      {error && (
        <Banner tone="bad" title="No se pudo cargar el resumen">
          <span className="flex flex-wrap items-center gap-3">
            {error}
            <button
              type="button"
              onClick={() => setRetryTick((x) => x + 1)}
              className="rounded-md border border-border-strong px-2 py-1 font-semibold text-neutral-200 transition-colors hover:bg-overlay/6 focus:outline-none focus-visible:ring-2 focus-visible:ring-acento-500/60"
            >
              Reintentar
            </button>
          </span>
        </Banner>
      )}

      {data.monedaSinCotizacion && (
        <Banner tone="warn" title={`Todavía no hay cotización ${data.monedaSinCotizacion}`}>
          Los importes siguen en {data.moneda}. El cron diario la guarda en la próxima corrida; para
          cargarla ya y completar los días pasados corré{' '}
          <code className="rounded bg-overlay/10 px-1">npm run fx:fetch</code> y{' '}
          <code className="rounded bg-overlay/10 px-1">npm run fx:historico-alternativa</code>.
        </Banner>
      )}

      {/* El aviso de rollup viejo va fijo, no como widget (T05 §3): si el
          cron está muerto, el aviso no puede depender de que el usuario
          tenga el widget puesto. */}
      {data.staleRollup && (
        <Banner tone="bad">
          {data.lastRollupAt
            ? `el rollup no corre desde las ${fmtClock(data.lastRollupAt)}`
            : 'el rollup no corrió nunca — corré npm run rollup'}
        </Banner>
      )}

      {empty && (
        <EmptyState
          title="Todavía no hay datos para mostrar"
          hint="Faltan tres pasos: 1) cargar las ingest keys de los funnels, 2) agregar el webhook de Shopify en cada tienda, 3) correr npm run rollup."
        />
      )}

      {/* El esqueleto reemplaza a la grilla durante el refetch (misma decisión
          que Ventas, P-R20): muestra la forma del contenido. Cuidado: si el
          usuario estaba editando sin guardar, un cambio de rango pierde esas
          ediciones — decisión explícita del usuario al cierre del rediseño. */}
      {loading ? (
        <EsqueletoResumen />
      ) : (
        <WidgetGrid
          pantalla="resumen"
          catalogo={catalogoResumen}
          data={data}
          porDefecto={layoutPorDefectoResumen}
          layoutGuardado={layoutGuardado}
        />
      )}

      {/* El pie: cuándo se generó y si el rollup está viejo. En neutral-500 y
          no 600: con el canvas nuevo el 600 no llega a 4.5:1 y es un dato que
          se consulta, no decoración. */}
      <p className="text-xs text-neutral-500">
        Generado {fmtDateTime(data.generatedAt)}
        {data.staleRollup && data.lastRollupAt && (
          <> · último rollup: {fmtDateTime(data.lastRollupAt)}</>
        )}
      </p>
    </div>
  );
}

/**
 * Con qué reloj se cortó el día que se está viendo. En el General además nombra
 * a los funnels que cuentan su día en otra zona y a qué hora arranca: sin eso,
 * que Astra no sume nada en "hoy" a la 01:00 de Lisboa parece un bug.
 */
function RelojAlcance({ alcance }: { alcance: OverviewData['alcance'] }): JSX.Element {
  return (
    <span className="text-xs text-neutral-500">
      Día en hora de {nombreZona(alcance.timezone)}
      {alcance.otrasZonas.map((z) => (
        <span key={z.slug}>
          {' '}
          · {z.nombre}: hora de {nombreZona(z.timezone)}
          {z.arrancaA && <> (su día arranca a las {z.arrancaA})</>}
        </span>
      ))}
    </span>
  );
}

/*
  Era una copia a mano del `Badge` de `components/ui.tsx` con el tono `info`
  escrito de nuevo clase por clase, así que quedaba fuera de cualquier cambio
  del kit —de hecho ya había divergido en el radio—. Ahora usa el primitivo.
*/
function BadgeTodas(): JSX.Element {
  return <Badge tone="info">todos los funnels</Badge>;
}
