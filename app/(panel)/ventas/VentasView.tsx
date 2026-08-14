'use client';

/**
 * VentasView — la pantalla de ventas de un funnel, rediseñada (task T06).
 *
 * El `WidgetGrid` de T03 reemplaza la grilla de 12 StatCards en 5 columnas:
 * el layout lo arma el usuario con el catálogo de lib/widgets/catalogo-ventas.tsx
 * y se guarda en la VPS (D-R04). La jerarquía se resolvió por defecto y por
 * elección: dos números grandes arriba (Neto y Resultado), el resto disponible
 * como widgets. Ningún número se pierde.
 *
 * Lo que quedó FUERA de los widgets a propósito (T06 §4): los avisos de datos
 * malos no pueden ser algo que el usuario saque sin querer. Van consolidados
 * en un solo bloque: órdenes sin tier, FX provisoria y el cajón sin atribuir
 * (que además es el único camino a esas órdenes, así que conserva su link).
 *
 * El toggle EUR/ARS vive en `?cur=` (D-R14): query string si está, si no el
 * setting default_currency_view (lo resuelve el server y baja como prop), si
 * no EUR. Cambiarlo NO refetchea: es de visualización, los pares Orig/Eur ya
 * vienen calculados con la cotización de cada día.
 *
 * No se importa nada en runtime desde lib/queries/sales.ts a propósito: ese
 * archivo importa pg, y traerlo al bundle del browser rompería el build del
 * client. Los tipos entran como `import type` (se borran en compilación).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Funnel } from '@/lib/funnels';
import type { FrescuraAds } from '@/lib/ads/live';
import type { SalesData } from '@/lib/queries/sales';
import { Badge, Banner, Grid, Skeleton, fmtInt, fmtMoney } from '@/components/ui';
import { WidgetGrid } from '@/components/WidgetGrid';
import { catalogoVentas, LAYOUT_VENTAS_POR_DEFECTO } from '@/lib/widgets/catalogo-ventas';
import type { VentasWidgetData } from '@/lib/widgets/catalogo-ventas';
import type { WidgetLayout } from '@/lib/widgets/tipos';

// El mismo valor que UNATTRIBUTED_FUNNEL en lib/queries/sales.ts: no se puede
// importar desde acá sin arrastrar pg al bundle del client.
const UNATTRIBUTED = '__unattributed__';

export function VentasView({
  funnel,
  initialData,
  defaultCurrency,
  adsFreshness,
  layoutGuardado,
}: {
  funnel: Funnel | null; // null = cajón "sin atribuir"
  initialData: SalesData;
  defaultCurrency: 'EUR' | 'ARS';
  adsFreshness: FrescuraAds;
  layoutGuardado: WidgetLayout | null;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname() ?? '/ventas';
  const unattributed = funnel === null;
  const fParam = funnel ? funnel.slug : UNATTRIBUTED;

  // ?cur= manda sobre el setting (D-R14). El server ya resolvió el valor
  // inicial (query → setting → EUR) y lo pasó en `defaultCurrency`; acá la
  // URL es la única fuente de verdad, así el toggle sobrevive a un refresh y
  // al back/forward sin estado local que desincronizar.
  const curParam = searchParams.get('cur');
  const showEur =
    curParam === 'EUR' || curParam === 'ARS' ? curParam === 'EUR' : defaultCurrency === 'EUR';

  const [data, setData] = useState<SalesData>(initialData);
  const [frescura, setFrescura] = useState<FrescuraAds>(adsFreshness);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  // La primera pintura ya trae los datos del server: no refetchear al
  // montar, solo ante cambios (funnel, rango, filtros, retry).
  const firstRun = useRef(true);

  const rangeParam = searchParams.get('range');
  const fromParam = searchParams.get('from');
  const toParam = searchParams.get('to');
  const tierParam = searchParams.get('tier');
  const campParam = searchParams.get('campaign');
  const srcParam = searchParams.get('source');
  const statusParam = searchParams.get('status');

  // La clave del refetch: funnel + rango + filtros. `cur` NO está a propósito:
  // el toggle es de visualización y no justifica un request. Sin esta clave,
  // el `useSearchParams` del efecto se dispararía con cada toggle y haría un
  // fetch de más (y peor: un toggle de moneda no debe mover el layout).
  const fetchKey = useMemo(
    () =>
      [
        fParam,
        fromParam && toParam ? `${fromParam}~${toParam}` : rangeParam ?? 'today',
        tierParam ?? '',
        campParam ?? '',
        srcParam ?? '',
        statusParam ?? '',
      ].join('|'),
    [fParam, rangeParam, fromParam, toParam, tierParam, campParam, srcParam, statusParam],
  );

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ f: fParam });
    if (fromParam && toParam) {
      params.set('from', fromParam);
      params.set('to', toParam);
    } else {
      params.set('range', rangeParam ?? 'today');
    }
    if (tierParam) params.set('tier', tierParam);
    if (campParam) params.set('campaign', campParam);
    if (srcParam) params.set('source', srcParam);
    if (statusParam) params.set('status', statusParam);

    fetch(`/api/data/sales?${params.toString()}`, {
      signal: ctrl.signal,
      cache: 'no-store',
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as SalesData & { adsFreshness?: FrescuraAds };
      })
      .then((body) => {
        setData(body);
        // El route refresca el gasto igual que el server: si no se tomara la
        // frescura nueva, la tarjeta seguiría diciendo la antigüedad del primer
        // render y en un rato mostraría "hace 40 min" con el número al día.
        if (body.adsFreshness) setFrescura(body.adsFreshness);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Error de red');
      })
      .finally(() => setLoading(false));

    return () => ctrl.abort();
  }, [fetchKey, retryTick]);

  const toggleCur = (eur: boolean): void => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('cur', eur ? 'EUR' : data.totals.currency);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  // Los datos que el WidgetGrid reparte: `frescura` va adentro porque el
  // widget de ads muestra la antigüedad pegada al número.
  const widgetData: VentasWidgetData = useMemo(
    () => ({ sales: data, showEur, frescura }),
    [data, showEur, frescura],
  );

  const t = data.totals;

  // ── Los avisos fijos (T06 §4): datos malos, consolidados en UN bloque. ──
  // No son widgets: no pueden ser algo que el usuario saque sin querer.
  const avisos: ReactNode[] = [];
  if (t.unknownTierCount > 0) {
    avisos.push(
      <>
        {fmtInt(t.unknownTierCount)} órdenes sin tier asignado —{' '}
        <Link href="/config" className="underline underline-offset-2">
          configuralo en product_map
        </Link>
      </>,
    );
  }
  if (t.fxStaleCount > 0) {
    avisos.push(
      <>
        {fmtInt(t.fxStaleCount)} órdenes con cotización provisoria o sin convertir — el total en
        euros lleva *. Corré <code className="rounded bg-overlay/10 px-1">npm run fx:backfill</code>{' '}
        para completarlas.
      </>,
    );
  }
  if (!unattributed && data.unattributed.orders > 0) {
    avisos.push(
      <>
        {fmtInt(data.unattributed.orders)} ventas sin funnel asignado ({fmtMoney(data.unattributed.netEur, 'EUR')}) —{' '}
        <Link href={`/ventas?f=${UNATTRIBUTED}`} className="underline underline-offset-2">
          ver el cajón sin atribuir
        </Link>
      </>,
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-neutral-50">Ventas</h1>
          {unattributed ? (
            <Badge tone="warn">Sin atribuir</Badge>
          ) : (
            <Badge tone="info">{funnel!.name}</Badge>
          )}
        </div>

        <div
          role="group"
          aria-label="Moneda de visualización"
          className="flex items-center gap-1 rounded-lg border border-border-subtle bg-overlay/2 p-1"
        >
          <button
            type="button"
            onClick={() => toggleCur(true)}
            aria-pressed={showEur}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500/50 ${
              showEur ? 'bg-overlay/8 text-neutral-50' : 'text-neutral-400 hover:bg-overlay/5 hover:text-neutral-200'
            }`}
          >
            EUR
          </button>
          <button
            type="button"
            onClick={() => toggleCur(false)}
            aria-pressed={!showEur}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500/50 ${
              !showEur ? 'bg-overlay/8 text-neutral-50' : 'text-neutral-400 hover:bg-overlay/5 hover:text-neutral-200'
            }`}
          >
            {t.currency}
          </button>
        </div>
      </div>

      {error && (
        <Banner tone="bad" title="No se pudieron cargar las ventas">
          <span className="flex flex-wrap items-center gap-3">
            {error}
            <button
              type="button"
              onClick={() => setRetryTick((x) => x + 1)}
              className="rounded-md border border-border-strong px-2 py-1 font-semibold text-neutral-200 transition-colors hover:bg-overlay/6"
            >
              Reintentar
            </button>
          </span>
        </Banner>
      )}

      {avisos.length > 0 && (
        <Banner tone="warn" title="Datos por revisar">
          <ul className="space-y-1">
            {avisos.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </Banner>
      )}

      {loading ? (
        // El estado cargando tiene la FORMA de los widgets (§9.10), no un
        // spinner centrado. Es la silueta del layout por defecto.
        <Grid className="auto-rows-[240px]">
          <div className="md:col-span-2 xl:col-span-2">
            <Skeleton variant="kpi" />
          </div>
          <div className="md:col-span-2 xl:col-span-2">
            <Skeleton variant="kpi" />
          </div>
          <Skeleton variant="kpi" />
          <Skeleton variant="kpi" />
          <Skeleton variant="kpi" />
          <Skeleton variant="kpi" />
          <div className="row-span-2 md:col-span-2 xl:col-span-2">
            <Skeleton variant="chart" />
          </div>
          <div className="row-span-2 md:col-span-2 xl:col-span-2">
            <Skeleton variant="table" rows={6} />
          </div>
        </Grid>
      ) : (
        <WidgetGrid
          pantalla="ventas"
          catalogo={catalogoVentas}
          data={widgetData}
          porDefecto={LAYOUT_VENTAS_POR_DEFECTO}
          layoutGuardado={layoutGuardado}
        />
      )}
    </div>
  );
}
