'use client';

/**
 * ResumenView — la pantalla del Resumen unificado (task T08), rediseñada con
 * widgets configurables (T05).
 *
 * Recibe los datos iniciales que renderizó el server y se maneja sola de ahí
 * en adelante: un cambio de rango (RangePicker) refetchea /api/data/overview
 * sin recargar la página. El layout guardado también baja del server como
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

// El reloj '14:20' de los avisos. La query lo arma con DASHBOARD_TZ en el
// server; acá se usa la TZ del browser, que es lo que el usuario espera ver.
function fmtClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit' }).format(d);
}

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
  const [refrescando, setRefrescando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  // La primera pintura ya trae los datos del server: no refetchear al
  // montar, solo ante cambios de rango o retry.
  const firstRun = useRef(true);
  const enVuelo = useRef<AbortController | null>(null);

  // Un solo camino de fetch para los dos disparadores: el cambio de rango y el
  // tick del gasto. `silencioso` es la única diferencia y NO es cosmética:
  // `loading` desmonta el WidgetGrid, y hacerlo cada minuto haría parpadear la
  // pantalla entera y tiraría las ediciones de layout sin guardar. El tick
  // cambia los números en su lugar y nada más.
  const cargar = useCallback(
    ({ silencioso }: { silencioso: boolean }): void => {
      if (enVuelo.current) {
        // El polling cede: si ya hay un pedido abierto (un cambio de rango, o
        // el tick anterior que tardó más que el intervalo), este tick se
        // saltea. El cambio de rango es al revés: manda, y aborta lo que haya.
        if (silencioso) return;
        enVuelo.current.abort();
      }
      const ctrl = new AbortController();
      enVuelo.current = ctrl;

      if (silencioso) {
        setRefrescando(true);
      } else {
        setLoading(true);
        setError(null);
      }

      const params = new URLSearchParams();
      const range = searchParams.get('range');
      const from = searchParams.get('from');
      const to = searchParams.get('to');
      if (from && to) {
        params.set('from', from);
        params.set('to', to);
      } else {
        params.set('range', range ?? 'today');
      }

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
          // rango sí se muestra, que ahí no quedó nada para mirar.
          if (!silencioso) setError(err instanceof Error ? err.message : 'Error de red');
        })
        .finally(() => {
          if (enVuelo.current === ctrl) enVuelo.current = null;
          if (silencioso) setRefrescando(false);
          else setLoading(false);
        });
    },
    [searchParams],
  );

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    cargar({ silencioso: false });
    return () => enVuelo.current?.abort();
  }, [cargar, retryTick]);

  // El gasto de Meta cada minuto (lib/ads/polling.ts): el route refresca contra
  // Meta antes de leer, así que repetir el pedido ES el refresco. Con un rango
  // cerrado no cuesta una llamada — `ensureFreshAdSpend` sale antes — y el
  // pedido igual repinta las ventas, que sí se mueven.
  usePollingGasto(() => cargar({ silencioso: true }), { pausado: loading });

  const edadGasto = textoEdad(frescura) ?? '—';
  const empty = data.funnels.every((f) => f.sessions === 0 && f.orders === 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-neutral-50">Resumen</h1>
          <BadgeTodas />
          {loading && (
            <span className="flex items-center gap-2 text-xs text-neutral-500">
              <Spinner /> Actualizando…
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
              className="rounded-md border border-border-strong px-2 py-1 font-semibold text-neutral-200 hover:bg-overlay/6"
            >
              Reintentar
            </button>
          </span>
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

      {/* El pie: cuándo se generó y si el rollup está viejo. */}
      <p className="text-xs text-neutral-600">
        Generado {fmtDateTime(data.generatedAt)}
        {data.staleRollup && data.lastRollupAt && (
          <> · último rollup: {fmtDateTime(data.lastRollupAt)}</>
        )}
      </p>
    </div>
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
