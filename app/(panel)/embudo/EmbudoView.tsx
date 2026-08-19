'use client';

/**
 * EmbudoView — la pantalla de embudo con filtros locales (task T06).
 *
 * Recibe los datos iniciales que renderizó el server y se maneja sola de
 * ahí en adelante: el toggle de base y los filtros cambian el query string
 * de su propio fetch a /api/data/funnel sin tocar la URL del browser, que
 * sigue siendo la de `?f=&range=` (la que comparten Nav y RangePicker).
 *
 * Rediseño T04: arriba de la lista paso a paso se suma el embudo literal
 * por etapas (EmbudoChart), que sale de `funnel_stages` (D-R07). El toggle
 * de base ahora vive en `?base=` (D-R14) y sobrevive al refresh.
 *
 * El control que está arriba del embudo por etapas es UNO de dos, según el
 * rango tenga test A/B o no:
 *
 *  - con test  → toggle de portada (A y B / Landing A / Landing B). Recorta el
 *                embudo entero, así que muestra en qué etapa pierde gente cada
 *                entrada, que es lo que un test de portada necesita responder.
 *  - sin test  → toggle de base (paso 0 vs paso 1), el que estaba solo hasta
 *                ahora. No se borró: sin variantes en el rango el otro no tendría
 *                nada que ofrecer.
 *
 * `?base=` sigue funcionando por URL en los dos casos, así que la base se puede
 * cambiar incluso cuando su toggle no está a la vista.
 *
 * El "peor paso" se calcula acá, sobre las filas ya armadas: es la de mayor
 * dropFromPrevious entre filas consecutivas, excluyendo la base — la misma
 * regla del panel viejo (FunnelView.tsx:238-247), sobre la matemática que
 * T06 §3 define para los datos nuevos.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import type { Funnel } from '@/lib/funnels';
import type { BaseMode, ExperimentoRow, FunnelData } from '@/lib/queries/funnel';
// El centinela viene de `lib/experimento.ts` y NO de `lib/queries/funnel`: ese
// módulo importa `pg` y esto es un componente de cliente.
import { SIN_EXPERIMENTO } from '@/lib/experimento';
import { EmbudoChart } from '@/components/EmbudoChart';
import {
  Badge,
  Banner,
  BarRow,
  Card,
  EmptyState,
  Spinner,
  StatCard,
  Table,
  fmtInt,
  fmtMoney,
  fmtPct,
} from '@/components/ui';
import { CaretDown, CaretUp } from '@phosphor-icons/react';

const SELECT_CLS =
  'appearance-none rounded-lg border border-white/10 bg-white/[0.04] py-1.5 pl-3 pr-7 text-sm font-medium text-neutral-200 transition-colors hover:bg-white/[0.07] focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/50';

type CampaignRow = { campaign: string; sessions: number; purchases: number };
type CampaignSortKey = 'campaign' | 'sessions' | 'purchases' | 'conversion';

/**
 * Etiqueta de la fila del desglose del experimento (R9.14). Cualquier otro
 * valor —incluido el centinela '(sin asignar)'— se devuelve tal cual.
 *
 * El texto ESPEJA `HERO_VARIANT_LABEL` del funnel (lib/quiz-v2/heroVariant.ts),
 * que es la fuente de verdad de qué renderiza cada variante. No se puede
 * importar (son dos repos), así que está duplicado a mano: si allá se cambia la
 * portada B, acá hay que seguirlo.
 *
 * OJO con la trampa de este campo: `sessions.experiment` es UN SOLO SLOT y el
 * payload manda el valor ('A'/'B') sin decir de qué experimento es. Estas
 * etiquetas describen el test de PORTADA, que es el único que reporta hoy. Las
 * sesiones del test del pop-up de descuento —retirado, el control ganó— tienen
 * 'A' y 'B' en la misma columna, así que un rango de fechas que cruce los dos
 * los muestra mezclados y rotulados como portada. El rango es la única defensa:
 * mirá desde el día que arrancó el test de portada.
 */
export function etiquetaExperimento(v: string): string {
  if (v === 'A') return 'A · control (portada actual)';
  if (v === 'B') return 'B · portada con pregunta';
  return v;
}

/**
 * Predicados PUROS de visibilidad de las dos cards, extraídos del componente
 * para poder testearlos sin jsdom (este proyecto no lo tiene). Los dos gates
 * son independientes (R9.11, R9.12): la card `Test A/B` cuenta filas del
 * desglose y la card `Variantes` mira el arreglo de variantes del funnel, y
 * ninguno lee al otro.
 */
export function debeMostrarCardTestAB(experiments: ExperimentoRow[]): boolean {
  return experiments.length > 1;
}

/**
 * ¿Se muestra el selector de variante? Cuenta las opciones ESTABLES (las de la
 * última respuesta sin filtrar), no las filas del desglose visible.
 *
 * Es un gate aparte y no `debeMostrarCardTestAB` aplicado a otra lista, porque
 * responde otra pregunta. La card pregunta "¿hay algo que comparar acá?" y con
 * el filtro puesto la respuesta es no. El selector pregunta "¿existe más de una
 * variante en este funnel y rango?", y eso tiene que seguir siendo cierto
 * MIENTRAS el filtro está puesto: si no, el control desaparece justo cuando hace
 * falta para volver atrás.
 */
export function debeMostrarSelectorExperimento(opciones: string[]): boolean {
  return opciones.length > 1;
}

/**
 * Etiqueta CORTA de una variante, para el toggle que está arriba del embudo por
 * etapas. Es otra función que `etiquetaExperimento` a propósito: ahí las
 * etiquetas describen qué cambia cada variante ('A · control (portada actual)')
 * porque la tabla tiene ancho para eso, y acá tienen que caber en un botón al
 * lado del otro.
 */
export function etiquetaCortaExperimento(v: string): string {
  if (v === 'A') return 'Landing A';
  if (v === 'B') return 'Landing B';
  if (v === SIN_EXPERIMENTO) return 'Sin asignar';
  return v;
}

export function debeMostrarCardVariantes(variants: string[]): boolean {
  return variants.length > 1;
}

export function EmbudoView({
  funnel,
  initialData,
}: {
  funnel: Funnel;
  initialData: FunnelData;
}) {
  const searchParams = useSearchParams();
  const pathname = usePathname() ?? '/embudo';
  const router = useRouter();

  // El toggle de D4: el 100% es la landing (paso 0) o el inicio del quiz
  // (paso 1). Vive en `?base=` (D-R14) y no en useState: así sobrevive al
  // refresh y se comparte por link, el mismo patrón que `range` y `f`.
  const base: BaseMode = searchParams.get('base') === 'start' ? 'start' : 'landing';
  const [variant, setVariant] = useState('');
  const [campaign, setCampaign] = useState('');
  const [country, setCountry] = useState('');
  // La variante del A/B arranca de la URL: la página del server ya filtró con
  // `?exp=`, así que si el select arrancara vacío mostraría "A y B juntas" arriba
  // de un embudo que es solo de B.
  const [experiment, setExperiment] = useState(searchParams.get('exp') ?? '');

  /**
   * Opciones del selector del experimento. Van en estado propio y NO se derivan
   * de `data.experiments` en cada pintura: al filtrar por B el desglose devuelve
   * UNA fila, y un select alimentado por esa lista se quedaría con una sola
   * opción —sin forma de volver a "A y B juntas"— y encima se auto-ocultaría por
   * su propio gate. Se refrescan solo con las respuestas SIN filtrar, que son las
   * únicas que ven el universo completo.
   */
  const [expOptions, setExpOptions] = useState<string[]>(() =>
    initialData.experiments.map((r) => r.experiment),
  );

  const [data, setData] = useState<FunnelData>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  // La primera pintura ya trae los datos del server: no refetchear al
  // montar, solo ante cambios (filtro, base, rango, funnel).
  const firstRun = useRef(true);

  function setBase(next: BaseMode) {
    if (next === base) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set('base', next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  // Al cambiar de funnel los filtros locales no tienen sentido para el
  // funnel nuevo (una campaña de uno no existe en el otro): se limpian.
  useEffect(() => {
    setVariant('');
    setCampaign('');
    setCountry('');
    // El experimento también: la 'B' de un funnel no es la 'B' de otro.
    setExperiment('');
  }, [funnel.slug]);

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ f: funnel.slug, base });
    const range = searchParams.get('range');
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    if (from && to) {
      params.set('from', from);
      params.set('to', to);
    } else {
      params.set('range', range ?? 'today');
    }
    if (variant) params.set('variant', variant);
    if (campaign) params.set('campaign', campaign);
    if (country) params.set('country', country);
    if (experiment) params.set('exp', experiment);

    fetch(`/api/data/funnel?${params.toString()}`, {
      signal: ctrl.signal,
      cache: 'no-store',
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as FunnelData;
      })
      .then((fresh) => {
        setData(fresh);
        // Solo la respuesta SIN filtrar por experimento ve todas las variantes:
        // es la única que puede refrescar las opciones del select sin amputarlo.
        if (!experiment) setExpOptions(fresh.experiments.map((r) => r.experiment));
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Error de red');
      })
      .finally(() => setLoading(false));

    return () => ctrl.abort();
  }, [base, variant, campaign, country, experiment, funnel.slug, searchParams, retryTick]);

  // El peor paso: la fila de mayor caída contra la anterior. La primera fila
  // (el paso base) no participa: no tiene caída contra nada (T06 §3).
  const worstIndex = useMemo(() => {
    let max = 0;
    let idx = -1;
    data.steps.forEach((s, i) => {
      if (i > 0 && s.dropFromPrevious > max) {
        max = s.dropFromPrevious;
        idx = i;
      }
    });
    return idx;
  }, [data.steps]);

  const startedRate = data.totalSessions > 0 ? (data.quizStarted / data.totalSessions) * 100 : 0;
  const purchaseRate = data.totalSessions > 0 ? (data.purchases / data.totalSessions) * 100 : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold text-neutral-50">Embudo</h1>
        <Badge tone="info">{funnel.name}</Badge>
        {loading && (
          <span className="flex items-center gap-2 text-xs text-neutral-500">
            <Spinner /> Actualizando…
          </span>
        )}
      </div>

      {error && (
        <Banner tone="bad" title="No se pudo cargar el embudo">
          <span className="flex flex-wrap items-center gap-3">
            {error}
            <button
              type="button"
              onClick={() => setRetryTick((t) => t + 1)}
              className="rounded-md border border-white/10 px-2 py-1 font-semibold text-neutral-200 hover:bg-white/[0.06]"
            >
              Reintentar
            </button>
          </span>
        </Banner>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Sesiones" value={fmtInt(data.totalSessions)} />
        <StatCard
          label="Empezaron el quiz"
          value={fmtInt(data.quizStarted)}
          sub={`${fmtPct(startedRate)} de las sesiones`}
        />
        <StatCard
          label="Llegaron a la venta"
          value={fmtInt(data.salesViews)}
          sub={`${fmtInt(data.checkoutClicks)} clickearon comprar`}
        />
        <StatCard
          label="Compraron"
          value={fmtInt(data.purchases)}
          sub={`${fmtPct(purchaseRate)} sesión → compra`}
        />
      </div>

      {/*
        El toggle de este bloque cambia según haya test o no.

        Con test corriendo manda la comparación de portadas: es la pregunta que se
        está haciendo en ese momento, y recorta el embudo por etapas completo, así
        que se ve en qué etapa pierde gente cada entrada.

        Sin test cae al toggle de base (paso 0 vs paso 1), que es el que estaba
        acá antes. No se borró: en un rango donde el experimento no corrió, o en un
        funnel que no testea, el de variantes no tendría nada que ofrecer y el de
        base sigue siendo útil. `?base=` sigue andando por URL en los dos casos.
      */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/[0.06] bg-[#13131a] p-4">
        <div>
          {debeMostrarSelectorExperimento(expOptions) ? (
            <p className="text-sm text-neutral-300">
              Comparando{' '}
              <span className="font-semibold text-neutral-100">
                {experiment === '' ? 'las dos portadas juntas' : etiquetaCortaExperimento(experiment)}
              </span>
              . El recorte aplica a todo el embudo de abajo.
            </p>
          ) : (
            <p className="text-sm text-neutral-300">
              % de personas que llegan a cada paso, medido desde{' '}
              <span className="font-semibold text-neutral-100">
                {base === 'landing' ? 'la landing (entrada)' : 'el inicio del quiz (1ª pregunta)'}
              </span>
              .
            </p>
          )}
          <p className="mt-1 text-xs text-neutral-500">
            Landing → inicio del quiz:{' '}
            <span className="font-semibold tabular-nums text-neutral-300">
              {fmtPct(startedRate)}
            </span>{' '}
            — es la caída más grande de todo el embudo.
          </p>
        </div>

        {debeMostrarSelectorExperimento(expOptions) ? (
          <div
            role="group"
            aria-label="Portada del test A/B"
            className="flex items-center gap-1 rounded-lg border border-white/[0.06] bg-white/[0.02] p-1"
          >
            {/*
              La opción de "juntas" va primero y con value '' (el mismo que
              significa "sin filtro" en el resto de la vista). Sin ella el toggle
              te encerraría en una variante, y el embudo total —el que se mira
              cuando no estás pensando en el test— quedaría inaccesible.
            */}
            <button
              type="button"
              onClick={() => setExperiment('')}
              aria-pressed={experiment === ''}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500/50 ${
                experiment === ''
                  ? 'bg-white/[0.08] text-neutral-50'
                  : 'text-neutral-400 hover:bg-white/[0.05] hover:text-neutral-200'
              }`}
            >
              A y B
            </button>
            {/*
              Un botón por variante REALMENTE presente en el rango, no por valor
              declarado en el funnel: en un rango donde solo corrió una, ofrecer la
              otra daría un embudo vacío.
            */}
            {expOptions.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setExperiment(v)}
                aria-pressed={experiment === v}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500/50 ${
                  experiment === v
                    ? 'bg-white/[0.08] text-neutral-50'
                    : 'text-neutral-400 hover:bg-white/[0.05] hover:text-neutral-200'
                }`}
              >
                {etiquetaCortaExperimento(v)}
              </button>
            ))}
          </div>
        ) : (
          <div
            role="group"
            aria-label="Base de medición del porcentaje"
            className="flex items-center gap-1 rounded-lg border border-white/[0.06] bg-white/[0.02] p-1"
          >
            <button
              type="button"
              onClick={() => setBase('landing')}
              aria-pressed={base === 'landing'}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500/50 ${
                base === 'landing'
                  ? 'bg-white/[0.08] text-neutral-50'
                  : 'text-neutral-400 hover:bg-white/[0.05] hover:text-neutral-200'
              }`}
            >
              Desde la landing
            </button>
            <button
              type="button"
              onClick={() => setBase('start')}
              aria-pressed={base === 'start'}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500/50 ${
                base === 'start'
                  ? 'bg-white/[0.08] text-neutral-50'
                  : 'text-neutral-400 hover:bg-white/[0.05] hover:text-neutral-200'
              }`}
            >
              Desde la 1ª pregunta
            </button>
          </div>
        )}
      </div>

      <Card
        title={`Embudo por etapas · ${funnel.name}`}
        hint="Las etapas salen de la configuración del funnel. El número de cada etapa es el real; si un hito supera a la etapa anterior, el ancho del trapecio se recorta para mantener la forma y la etapa queda marcada."
      >
        {data.porEtapas.huerfanas.length > 0 && (
          <Banner tone="warn" title="Hay etapas que apuntan a un paso que ya no existe">
            <span className="flex flex-col gap-1">
              {data.porEtapas.huerfanas.map((h) => (
                <span key={h.stageOrder}>
                  «{h.label}» apunta al slug <span className="font-mono">{h.slugFaltante}</span>, que no
                  está en el quiz de este funnel. La etapa no se muestra; revisá las etapas en Config.
                </span>
              ))}
            </span>
          </Banner>
        )}
        {data.porEtapas.etapas.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <p className="text-sm font-medium text-neutral-300">
              Este funnel no tiene etapas configuradas
            </p>
            <p className="text-xs text-neutral-500">
              El embudo por etapas se arma desde Config → Etapas. La lista paso a paso sigue
              disponible más abajo.
            </p>
            <Link
              href="/config"
              className="text-xs font-semibold text-good-400 underline underline-offset-2"
            >
              Ir a Config
            </Link>
          </div>
        ) : data.totalSessions === 0 ? (
          <EmptyState
            title="No hay datos en el rango elegido"
            hint="El embudo arranca de cero el día del deploy: los rangos anteriores a la migración no van a mostrar movimiento."
          />
        ) : (
          <EmbudoChart etapas={data.porEtapas.etapas} />
        )}
      </Card>

      <Card title={`Paso a paso · ${funnel.name}`} hint="Sesiones que llegaron a cada paso o más allá">
        {data.totalSessions === 0 ? (
          <EmptyState
            title="No hay datos en el rango elegido"
            hint="El embudo arranca de cero el día del deploy: los rangos anteriores a la migración no van a mostrar movimiento."
          />
        ) : (
          <div className="space-y-1.5">
            {worstIndex >= 0 && (
              <p className="text-xs text-neutral-500">
                Mayor caída:{' '}
                <span className="font-semibold text-rose-400">{data.steps[worstIndex]!.label}</span>
              </p>
            )}
            {data.steps.map((s, i) => (
              // El delta contra el paso anterior no entra en BarRow (el kit
              // es de T05 y no se toca): va en una columna propia al final.
              <div key={`${s.kind}:${s.slug}`} className="flex items-center gap-3">
                <BarRow
                  label={s.label}
                  pct={s.pctOfBase}
                  count={s.sessions}
                  tone={s.kind === 'content' ? 'info' : 'neutral'}
                  highlight={i === worstIndex}
                />
                <span
                  className="w-14 shrink-0 text-right text-xs tabular-nums text-neutral-500"
                  title="Caída contra el paso anterior"
                >
                  {i === 0 || s.dropFromPrevious === 0 ? '—' : `-${fmtPct(s.dropFromPrevious, 0)}`}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/*
        Con el filtro puesto el desglose trae una sola fila y el gate diría que no
        hay nada que mostrar. Pero ahí la card es justamente lo que se quiere ver:
        el recorrido completo de ESA variante, plata incluida. Por eso el `||`.
      */}
      {(debeMostrarCardTestAB(data.experiments) || experiment !== '') && (
        <Card
          title="Test A/B de la portada"
          hint="El funnel completo por variante de entrada, de la sesión hasta la plata. Respeta los mismos filtros que el resto del embudo. Las dos últimas columnas son las que deciden el test."
        >
          <Table
            rows={data.experiments}
            empty="Sin datos"
            columns={[
              {
                key: 'experiment',
                header: 'Variante',
                render: (r) => <span className="text-neutral-200">{etiquetaExperimento(r.experiment)}</span>,
              },
              { key: 'sessions', header: 'Sesiones', align: 'right', render: (r) => fmtInt(r.sessions) },
              { key: 'salesViews', header: 'Vio venta', align: 'right', render: (r) => fmtInt(r.salesViews) },
              { key: 'pctSalesView', header: '% venta', align: 'right', render: (r) => fmtPct(r.pctSalesView, 1) },
              { key: 'checkoutClicks', header: 'Click', align: 'right', render: (r) => fmtInt(r.checkoutClicks) },
              { key: 'pctCheckoutClick', header: '% click', align: 'right', render: (r) => fmtPct(r.pctCheckoutClick, 1) },
              { key: 'purchases', header: 'Compras', align: 'right', render: (r) => fmtInt(r.purchases) },
              { key: 'pctPurchase', header: '% compra', align: 'right', render: (r) => fmtPct(r.pctPurchase, 1) },
              // El tramo que la card vieja no miraba: sin esto una entrada que
              // vende más front y menos upsell parece ganadora sin serlo.
              { key: 'upsellViews', header: 'Vio upsell', align: 'right', render: (r) => fmtInt(r.upsellViews) },
              { key: 'upsellClicks', header: 'Upsell', align: 'right', render: (r) => fmtInt(r.upsellClicks) },
              { key: 'pctUpsellTake', header: '% upsell', align: 'right', render: (r) => fmtPct(r.pctUpsellTake, 1) },
              { key: 'downsellViews', header: 'Vio downsell', align: 'right', render: (r) => fmtInt(r.downsellViews) },
              {
                key: 'pctSessionToPurchase',
                header: 'Conv. total',
                align: 'right',
                render: (r) => fmtPct(r.pctSessionToPurchase, 2),
              },
              {
                key: 'revenue',
                header: 'Facturado',
                align: 'right',
                render: (r) => fmtMoney(r.revenue, funnel.sellCurrency),
              },
              // El veredicto. Va última y resaltada porque es la única columna
              // que ya tiene adentro el tráfico, los upsells y los reembolsos: si
              // discrepa con "Conv. total", esta gana.
              {
                key: 'revenuePerSession',
                header: '$ / sesión',
                align: 'right',
                className: 'text-neutral-50',
                render: (r) => fmtMoney(r.revenuePerSession, funnel.sellCurrency),
              },
            ]}
          />
        </Card>
      )}

      <Card title="Filtros" hint="Cada filtro recorta el embudo completo">
        <div className="flex flex-wrap items-center gap-2">
          {/*
            Acá NO va un selector de la variante del A/B: eso lo maneja el toggle
            que está arriba del embudo por etapas. Dos controles para el mismo
            estado es la forma más rápida de que la vista muestre una cosa y el
            control diga otra.
          */}
          {debeMostrarCardVariantes(funnel.variants) && (
            <select
              value={variant}
              onChange={(e) => setVariant(e.target.value)}
              aria-label="Variante"
              className={SELECT_CLS}
            >
              <option value="" className="bg-[#13131a] text-neutral-200">
                Todas las variantes
              </option>
              {funnel.variants.map((v) => (
                <option key={v} value={v} className="bg-[#13131a] text-neutral-200">
                  {v}
                </option>
              ))}
            </select>
          )}
          <select
            value={campaign}
            onChange={(e) => setCampaign(e.target.value)}
            aria-label="Campaña"
            className={SELECT_CLS}
          >
            <option value="" className="bg-[#13131a] text-neutral-200">
              Todas las campañas
            </option>
            {data.campaigns
              .filter((c) => c.campaign !== '(otras)')
              .map((c) => (
                <option key={c.campaign} value={c.campaign} className="bg-[#13131a] text-neutral-200">
                  {c.campaign}
                </option>
              ))}
          </select>
          <select
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            aria-label="País"
            className={SELECT_CLS}
          >
            <option value="" className="bg-[#13131a] text-neutral-200">
              Todos los países
            </option>
            {data.countries.map((c) => (
              <option key={c.country} value={c.country} className="bg-[#13131a] text-neutral-200">
                {c.country}
              </option>
            ))}
          </select>
        </div>
      </Card>

      <Card title="Campañas" hint="Las 20 principales del rango; el resto se suma en «(otras)»">
        <CampaignTable rows={data.campaigns} />
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        {debeMostrarCardVariantes(funnel.variants) && (
          <Card title="Variantes">
            <Table
              rows={data.variants}
              empty="Sin datos"
              columns={[
                {
                  key: 'variant',
                  header: 'Variante',
                  render: (r) => <span className="text-neutral-200">{r.variant}</span>,
                },
                {
                  key: 'sessions',
                  header: 'Sesiones',
                  align: 'right',
                  render: (r) => fmtInt(r.sessions),
                },
                {
                  key: 'purchases',
                  header: 'Compras',
                  align: 'right',
                  render: (r) => fmtInt(r.purchases),
                },
                {
                  key: 'conversion',
                  header: 'Conv.',
                  align: 'right',
                  render: (r) =>
                    r.sessions > 0 ? fmtPct((r.purchases / r.sessions) * 100, 0) : '—',
                },
              ]}
            />
          </Card>
        )}
        <Card title="Países">
          <Table
            rows={data.countries}
            empty="Sin datos"
            columns={[
              {
                key: 'country',
                header: 'País',
                render: (r) => <span className="text-neutral-200">{r.country}</span>,
              },
              {
                key: 'sessions',
                header: 'Sesiones',
                align: 'right',
                render: (r) => fmtInt(r.sessions),
              },
            ]}
          />
        </Card>
        <Card title="Dispositivos">
          <Table
            rows={data.devices}
            empty="Sin datos"
            columns={[
              {
                key: 'device',
                header: 'Dispositivo',
                render: (r) => <span className="text-neutral-200">{r.device}</span>,
              },
              {
                key: 'sessions',
                header: 'Sesiones',
                align: 'right',
                render: (r) => fmtInt(r.sessions),
              },
            ]}
          />
        </Card>
      </div>

      {data.ingestWarnings.length > 0 && (
        <Banner tone="warn" title="Avisos de ingesta en las últimas 24 h">
          <span className="flex flex-wrap items-center gap-2">
            {data.ingestWarnings.map((w) => (
              <span key={w.reason} className="tabular-nums">
                {w.count}× {w.reason}
              </span>
            ))}
            <Link href="/config" className="underline underline-offset-2">
              Ver en Config
            </Link>
          </span>
        </Banner>
      )}
    </div>
  );
}

function CampaignTable({ rows }: { rows: CampaignRow[] }) {
  const [sortKey, setSortKey] = useState<CampaignSortKey>('sessions');
  const [sortDesc, setSortDesc] = useState(true);

  const sorted = useMemo(() => {
    const withConversion = rows.map((r) => ({
      ...r,
      conversion: r.sessions > 0 ? (r.purchases / r.sessions) * 100 : 0,
    }));
    return [...withConversion].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const cmp =
        typeof av === 'string' && typeof bv === 'string'
          ? av.localeCompare(bv, 'es')
          : (av as number) - (bv as number);
      return sortDesc ? -cmp : cmp;
    });
  }, [rows, sortKey, sortDesc]);

  function header(key: CampaignSortKey, label: string, align: 'left' | 'right') {
    const active = sortKey === key;
    return (
      <button
        type="button"
        onClick={() => {
          if (active) {
            setSortDesc((d) => !d);
          } else {
            setSortKey(key);
            setSortDesc(true);
          }
        }}
        className={`text-xs font-semibold uppercase tracking-wide transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500/50 ${
          align === 'right' ? 'w-full text-right' : ''
        } ${active ? 'text-neutral-200' : 'text-neutral-500 hover:text-neutral-300'}`}
        aria-label={`Ordenar por ${label}${active ? (sortDesc ? ' descendente' : ' ascendente') : ''}`}
      >
        {label}
        {active && (
          <span className="ml-0.5 inline-flex align-middle">
            {sortDesc ? (
              <CaretDown size={11} weight="bold" aria-hidden="true" />
            ) : (
              <CaretUp size={11} weight="bold" aria-hidden="true" />
            )}
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-white/[0.06]">
            <th scope="col" className="px-3 py-2">
              {header('campaign', 'Campaña', 'left')}
            </th>
            <th scope="col" className="px-3 py-2">
              {header('sessions', 'Sesiones', 'right')}
            </th>
            <th scope="col" className="px-3 py-2">
              {header('purchases', 'Compras', 'right')}
            </th>
            <th scope="col" className="px-3 py-2">
              {header('conversion', 'Conversión', 'right')}
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-3 py-8 text-center text-sm text-neutral-500">
                Sin datos
              </td>
            </tr>
          ) : (
            sorted.map((r) => (
              <tr key={r.campaign} className="border-b border-white/[0.04] last:border-0">
                <td className="px-3 py-2.5 text-neutral-200">
                  {r.campaign === '(otras)' ? <span className="text-neutral-500">{r.campaign}</span> : r.campaign}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-neutral-200">{fmtInt(r.sessions)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-neutral-200">{fmtInt(r.purchases)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-neutral-200">
                  {fmtPct(r.conversion, 0)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
