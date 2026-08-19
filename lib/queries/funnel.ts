/**
 * Embudo por funnel (task T06).
 *
 * El corazón del cálculo es D3: el embudo se mide por sesión única, no por
 * evento, y como los dos quizzes son estrictamente lineales, "cuántas
 * sesiones llegaron al paso N" es exactamente "cuántas tienen
 * max_step_index >= N". Eso sale de UNA query de histograma más una suma
 * acumulada inversa en TypeScript — no de un count por paso (con 27 pasos
 * serían 27 escaneos de la misma tabla).
 *
 * Los porcentajes conservan la matemática del panel viejo
 * (FunnelView.tsx:203-244, D4): el 100% es el paso 0 y hay un toggle a
 * "desde la 1ª pregunta" (paso 1). El denominador (baseRef) es el conteo
 * del paso base con fallback al total de sesiones, y `|| 1` evita la
 * división por cero sin que un dato raro rompa el JSON.
 */

import { q, q1 } from '@/lib/db';
import { listSteps } from '@/lib/funnels';
import { resolveRange, type RangePreset } from '@/lib/day';
import type { EmbudoEtapa, EmbudoPorEtapas } from '@/lib/widgets/tipos';

export type BaseMode = 'landing' | 'start';

export type FunnelFilters = {
  funnelId: number;
  from: string; // 'YYYY-MM-DD' en la TZ del funnel
  to: string;
  base?: BaseMode; // D4: el 100% es el paso 0; toggle al 1
  variant?: string; // undefined = todas
  utmCampaign?: string;
  utmSource?: string;
  country?: string;
  /**
   * Variante del experimento A/B (`sessions.experiment`). undefined = todas.
   *
   * El experimento pasó de dimensión de SALIDA a dimensión de ENTRADA: la 020
   * lo dejó como un GROUP BY de una card y nada más, pero un test de PORTADA
   * necesita responder "¿dónde pierde gente la entrada B?", y eso es recortar
   * el embudo completo —los 17 pasos, las etapas, las campañas— a una variante.
   * Por eso entra al WHERE compartido y no a una query aparte.
   *
   * El centinela `SIN_EXPERIMENTO` filtra las sesiones que NO participaron
   * (`experiment IS NULL`): sin esa traducción, elegir "(sin asignar)" en la UI
   * compararía contra el string literal y devolvería siempre cero.
   */
  experiment?: string;
};

export type FunnelStepRow = {
  stepIndex: number;
  slug: string;
  label: string;
  kind: string;
  sessions: number; // sesiones que llegaron a este paso o más allá
  pctOfBase: number; // vs el paso base (0 o 1)
  pctOfPrevious: number; // vs el paso anterior
  dropFromPrevious: number;
};

export type FunnelData = {
  totalSessions: number;
  quizStarted: number; // max_step_index >= 1
  salesViews: number;
  checkoutClicks: number;
  purchases: number;
  steps: FunnelStepRow[];
  campaigns: { campaign: string; sessions: number; purchases: number }[];
  variants: { variant: string; sessions: number; purchases: number }[];
  countries: { country: string; sessions: number }[];
  devices: { device: string; sessions: number }[];
  // D20: los datos raros se registran y se muestran. El banner del embudo
  // es la cara visible de ingest_errors.
  ingestWarnings: { reason: string; count: number }[];
  generatedAt: string;
  // El embudo literal por etapas (rediseño T04, contrato §5 del plan): se
  // agrega sin tocar los campos que ya existían. Los porcentajes van 0-100,
  // la misma convención que FunnelStepRow.
  porEtapas: EmbudoPorEtapas;
  // Desglose por dimensión del experimento A/B. `variants` sigue intacto: es
  // otra dimensión (país), con su propio gate.
  experiments: ExperimentoRow[];
};

// ─── Desglose del experimento A/B ───────────────────────────────────────────
//
// Una fila por valor distinto de sessions.experiment (el centinela agrupa los
// NULL). Las tasas son derivadas y viven en `calcularTasasExperimento`, pura y
// testeable sin base (R9.7): son aritmética que se equivoca en silencio y
// conviene tener vigilada igual que buildEmbudoPorEtapas.
//
// El desglose llega hasta el FINAL del funnel (upsell, downsell y plata) y no
// hasta la compra del front. Un test de PORTADA se decide por lo que la entrada
// factura, no por cuántos front vendió: una entrada puede traer más compras y
// menos upsells y terminar valiendo menos. Cortar en `purchases` es exactamente
// el error que hace elegir la entrada equivocada.

/** Contadores crudos de una fila del desglose, tal como salen de SQL. */
export type ExperimentoContadores = {
  experiment: string;
  sessions: number;
  salesViews: number;
  checkoutClicks: number;
  purchases: number;
  /** Sesiones que vieron el upsell (`upsell_view_at` no nulo). */
  upsellViews: number;
  /** Sesiones que clickearon comprar en el upsell (`upsell_click_at`). */
  upsellClicks: number;
  /** Sesiones que vieron el downsell (`downsell_view_at`). */
  downsellViews: number;
  /**
   * Plata aprobada atribuida a las sesiones de esta fila, en la moneda de venta
   * del funnel. Sale de `orders` (la fuente real de la facturación, la misma que
   * usa Ventas), NO de `events.value_cents`: el value del evento es el precio
   * que el funnel *pretendía* cobrar y no sabe de reembolsos ni de órdenes que
   * nunca se aprobaron.
   */
  revenue: number;
};

/** Una fila del desglose con sus tasas derivadas. Las de % van 0-100. */
export type ExperimentoRow = ExperimentoContadores & {
  pctSalesView: number; // sesión → vio la venta
  pctCheckoutClick: number; // vio la venta → clickeó comprar
  pctPurchase: number; // clickeó comprar → compró
  pctSessionToPurchase: number; // sesión → compró
  /**
   * Compró el front → clickeó comprar el upsell. El take rate del upsell: es la
   * parte del funnel que la card vieja no miraba.
   */
  pctUpsellTake: number;
  /**
   * Plata por sesión, en la moneda de venta. NO es un porcentaje.
   *
   * Es LA métrica que decide un test de entrada: normaliza por tráfico, así que
   * compara A contra B aunque el reparto 50/50 no haya quedado perfecto, y
   * cuenta upsells y reembolsos. Cuando `pctSessionToPurchase` y esta columna
   * no coinciden en quién gana, gana esta.
   */
  revenuePerSession: number;
};

/**
 * Función PURA: contadores → tasas. Vive fuera de `getFunnelData` a propósito,
 * igual que `buildEmbudoPorEtapas`: es aritmética que se equivoca en silencio y
 * se testea sin base (R9.7).
 *
 * Denominador 0 ⇒ 0 con chequeo explícito (nunca `|| 1`): acá el 0 tiene que
 * ser visible en la UI y no un 0% derivado de una división por 1. Nunca NaN ni
 * Infinity. Las cuatro tasas van 0-100, la misma convención que
 * `FunnelStepRow.pctOfBase`.
 *
 * El orden de salida se decide ACÁ y no con un ORDER BY: el centinela empieza
 * con '(' y su posición depende de la collation de la base, así que ordenarlo
 * en SQL daría un resultado distinto según el servidor. Orden: A, B, el resto
 * alfabético, y el centinela siempre último.
 */
export function calcularTasasExperimento(filas: ExperimentoContadores[]): ExperimentoRow[] {
  const pct = (numerador: number, denominador: number): number => {
    if (denominador === 0) return 0;
    return (numerador / denominador) * 100;
  };

  const ordenadas = [...filas].sort((a, b) => {
    const aSent = a.experiment === SIN_EXPERIMENTO;
    const bSent = b.experiment === SIN_EXPERIMENTO;
    if (aSent || bSent) return aSent === bSent ? 0 : aSent ? 1 : -1; // centinela siempre último
    if (a.experiment === 'A' || b.experiment === 'A') {
      return a.experiment === b.experiment ? 0 : a.experiment === 'A' ? -1 : 1; // A primero
    }
    if (a.experiment === 'B' || b.experiment === 'B') {
      return a.experiment === b.experiment ? 0 : a.experiment === 'B' ? -1 : 1; // B segundo
    }
    return a.experiment.localeCompare(b.experiment, 'es'); // el resto, alfabético
  });

  return ordenadas.map((f) => ({
    ...f,
    pctSalesView: pct(f.salesViews, f.sessions),
    pctCheckoutClick: pct(f.checkoutClicks, f.salesViews),
    pctPurchase: pct(f.purchases, f.checkoutClicks),
    pctSessionToPurchase: pct(f.purchases, f.sessions),
    // El denominador del take rate del upsell son las COMPRAS del front, no las
    // vistas del upsell: la pregunta es "de los que compraron, cuántos sumaron
    // el upsell". Con `upsellViews` abajo, una variante que muestra mal el
    // upsell se vería con mejor take rate del que tiene.
    pctUpsellTake: pct(f.upsellClicks, f.purchases),
    // Plata por sesión: NO pasa por `pct` porque no es un porcentaje y no está
    // acotada a 100. Mismo cuidado con el denominador 0 (sesiones 0 ⇒ 0).
    revenuePerSession: f.sessions === 0 ? 0 : f.revenue / f.sessions,
  }));
}

// ─── Filtros compartidos ────────────────────────────────────────────────────
//
// Un solo WHERE para todas las queries del embudo (task T06 §2): el patrón
// ($n::text IS NULL OR col = $n) deja que una sola SQL cubra todas las
// combinaciones de filtro sin armar el WHERE concatenando strings. Los
// valores SIEMPRE van como parámetros.
// El centinela de la dimensión del experimento vive en `lib/experimento.ts`
// porque este módulo importa `pg` y los componentes de cliente lo necesitan sin
// arrastrarlo al bundle (mismo patrón que `nombreVisible` en `lib/funnels.ts`).
// Se re-exporta para que el código de servidor y los tests lo sigan encontrando
// acá, junto al resto del embudo.
//
// Se importa Y se re-exporta: un `export ... from` solo no trae el valor al
// scope de este módulo, y `WHERE_SESSIONS` lo interpola. El import va ARRIBA de
// esa constante porque un template literal se evalúa cuando el módulo carga.
import { SIN_EXPERIMENTO } from '@/lib/experimento';
export { SIN_EXPERIMENTO };

// El filtro del experimento entra ACÁ y no en cada query: así recorta el embudo
// COMPLETO (histograma de pasos, etapas, campañas, países, dispositivos) con
// una sola línea, en vez de siete queries que se olvidan una.
//
// $8 tiene dos lecturas y por eso son dos condiciones y no una: con el centinela
// se piden las sesiones que NO participaron (`experiment IS NULL`), con
// cualquier otro valor se compara la columna. Un solo `= $8` devolvería cero
// filas al elegir "(sin asignar)", porque en SQL nada es igual a NULL.
const WHERE_SESSIONS = `
  funnel_id = $1
  AND day BETWEEN $2::date AND $3::date
  AND ($4::text IS NULL OR variant      = $4)
  AND ($5::text IS NULL OR utm_campaign = $5)
  AND ($6::text IS NULL OR utm_source   = $6)
  AND ($7::text IS NULL OR country      = $7)
  AND ($8::text IS NULL
       OR ($8 = '${SIN_EXPERIMENTO}' AND experiment IS NULL)
       OR experiment = $8)`;

function filterParams(f: FunnelFilters): unknown[] {
  return [
    f.funnelId,
    f.from,
    f.to,
    f.variant ?? null,
    f.utmCampaign ?? null,
    f.utmSource ?? null,
    f.country ?? null,
    f.experiment ?? null,
  ];
}

type HistRow = { maxStepIndex: number; n: number };
type TotalsRow = {
  total: number;
  quizStarted: number;
  salesViews: number;
  checkoutClicks: number;
  purchases: number;
};
type BreakdownRow = { sessions: number; purchases: number };
type CountRow = { sessions: number };
type WarningRow = { reason: string; count: number };

// Sesiones sin país ni dispositivo: la columna es nullable y el GROUP BY
// devuelve NULL. Se usa el centinela '(sin dato)' en vez de propagar null al
// JSON, la misma convención que los '(directo)' de los UTMs.
const NO_DATA = '(sin dato)';

// La tabla de campañas con 300 filas es ilegible: se corta en 20 y el resto
// se suma en una fila '(otras)' (task T06 §2).
const CAMPAIGN_CAP = 20;

// ─── Embudo por etapas (rediseño T04) ───────────────────────────────────────
//
// Las etapas salen de `funnel_stages` (migración 017, D-R07): una fila es o
// un rango de pasos (arranca en `startsAtSlug`) o un hito, y el CHECK de la
// 017 garantiza que nunca son las dos ni ninguna. El conteo de una etapa de
// paso es el de su PRIMER paso: "cuántas sesiones entraron". Así cada frontera
// entre dos etapas es una pérdida real y atribuible; con el último paso, una
// etapa de 17 pasos escondía el rebote de la landing dentro del abandono del
// quiz. `sessions` ya es acumulado inverso, así que nunca se suman los pasos.
// El detalle está en el comentario de `buildEmbudoPorEtapas`.
//
// El embudo NO es monótono (D-R09): los hitos salen de columnas propias y
// pueden superar al paso previo. El número viaja tal cual; lo que se recorta
// es el ANCHO de dibujo, y la etapa queda marcada como inconsistente.

/** Los tres hitos que pueden abrir una etapa (vocabulario de la 017). */
export type Milestone = 'sales_view' | 'checkout_click' | 'purchase';

/** Una fila de `funnel_stages` (migración 017). */
export type FunnelStageRow = {
  stageOrder: number;
  label: string;
  startsAtSlug: string | null;
  milestone: Milestone | null;
};

/** Un paso del catálogo con su conteo acumulado inverso, para armar etapas. */
export type PasoConConteo = {
  stepIndex: number;
  slug: string;
  sessions: number;
};

type EtapaCruda = {
  stageOrder: number;
  label: string;
  slugs: string[];
  fuente: 'paso' | 'hito';
  sessions: number;
  /** El primer stepIndex de la etapa (de donde sale el conteo); null si es hito. */
  firstStepIdx: number | null;
  /** El último stepIndex que la etapa contiene; null para hitos. */
  lastStepIdx: number | null;
};

const MILESTONE_FIELD: Record<Milestone, keyof Pick<FunnelData, 'salesViews' | 'checkoutClicks' | 'purchases'>> = {
  sales_view: 'salesViews',
  checkout_click: 'checkoutClicks',
  purchase: 'purchases',
};

/**
 * Función PURA que arma el embudo por etapas a partir de la configuración,
 * los pasos con su conteo y los hitos. Vive fuera de `getFunnelData` a
 * propósito: es el cálculo que más se puede equivocar en silencio y se testea
 * sin base (T04 §6).
 *
 * `baseIndex` es el paso base (0 = landing, 1 = 1ª pregunta): las etapas de
 * paso que terminan antes de ese índice quedan fuera del embudo, igual que
 * los pasos por encima de la base no se listan.
 */
export function buildEmbudoPorEtapas(
  etapasConfig: FunnelStageRow[],
  pasos: PasoConConteo[],
  hitos: { salesViews: number; checkoutClicks: number; purchases: number },
  baseIndex: number,
): EmbudoPorEtapas {
  const config = [...etapasConfig].sort((a, b) => a.stageOrder - b.stageOrder);

  // "El último paso de la etapa" depende del orden: se ordena acá para que
  // la función sea pura de verdad y no dependa del orden en que lleguen.
  const pasosOrdenados = [...pasos].sort((a, b) => a.stepIndex - b.stepIndex);
  const slugToIndex = new Map<string, number>();
  for (const p of pasosOrdenados) if (!slugToIndex.has(p.slug)) slugToIndex.set(p.slug, p.stepIndex);
  const lastIdx = pasosOrdenados.reduce((m, p) => Math.max(m, p.stepIndex), -1);

  // Frontera de cada etapa de paso, alineada con `config`: -1 marca la
  // huérfana (su slug ya no existe, D-R07) o la fila de hito.
  const huerfanas: EmbudoPorEtapas['huerfanas'] = [];
  const fronteras: number[] = [];
  for (const c of config) {
    if (c.startsAtSlug === null) {
      fronteras.push(-1);
      continue;
    }
    const idx = slugToIndex.get(c.startsAtSlug);
    if (idx === undefined) {
      huerfanas.push({ stageOrder: c.stageOrder, label: c.label, slugFaltante: c.startsAtSlug });
      fronteras.push(-1);
    } else {
      fronteras.push(idx);
    }
  }

  // Una etapa contiene los pasos desde su frontera (inclusive) hasta la
  // frontera de la PRÓXIMA etapa de paso (exclusive); la última llega al
  // final del catálogo.
  //
  // EL CONTEO ES EL DE SU PRIMER PASO: "cuántas sesiones ENTRARON a la etapa".
  // Nunca la suma de los pasos (`sessions` ya es acumulado inverso, sumarlo da
  // un número sin sentido, varias veces más grande que el total).
  //
  // Antes se tomaba el ÚLTIMO paso ("cuántas la completaron") y eso escondía el
  // dato más importante del embudo. Con 17 pasos dentro de "Preguntas", el
  // salto de Landing (4023) a Preguntas (1087, o sea el paso 17) mezclaba dos
  // pérdidas distintas en una sola barra: las 1661 sesiones que se fueron en la
  // landing sin tocar nada, y las ~1275 que abandonaron el quiz en el medio. No
  // se podía saber cuál era cuál.
  //
  // Con el primer paso, cada frontera entre dos etapas es una pérdida real y
  // atribuible: Landing 4023 → Preguntas 2362 ES el rebote de la landing, y
  // Preguntas 2362 → Puente 1028 ES el abandono del quiz. Es también la lectura
  // convencional de un embudo ("llegaron a esta etapa").
  const crudas: EtapaCruda[] = [];
  config.forEach((c, i) => {
    if (c.milestone !== null) {
      crudas.push({
        stageOrder: c.stageOrder,
        label: c.label,
        slugs: [],
        fuente: 'hito',
        sessions: hitos[MILESTONE_FIELD[c.milestone]],
        firstStepIdx: null,
        lastStepIdx: null,
      });
      return;
    }
    const startIdx = fronteras[i];
    if (startIdx === -1) return; // huérfana: ya está en `huerfanas`
    const nextIdx = fronteras.slice(i + 1).find((x) => x !== -1);
    const endIdx = nextIdx !== undefined ? nextIdx - 1 : lastIdx;
    const dentro = pasosOrdenados.filter((p) => p.stepIndex >= startIdx && p.stepIndex <= endIdx);
    // El primer paso AL O POR ENCIMA de la base: con base='start' una etapa que
    // arranca en el paso 0 no puede contar el paso 0, o su conteo sería el total
    // de sesiones y el 100% dejaría de ser la base elegida.
    const primero = dentro.find((p) => p.stepIndex >= baseIndex) ?? dentro[0];
    const ultimo = dentro.length > 0 ? dentro[dentro.length - 1] : undefined;
    crudas.push({
      stageOrder: c.stageOrder,
      label: c.label,
      slugs: dentro.map((p) => p.slug),
      fuente: 'paso',
      sessions: primero ? primero.sessions : 0,
      firstStepIdx: primero ? primero.stepIndex : null,
      lastStepIdx: ultimo ? ultimo.stepIndex : null,
    });
  });

  const visibles = crudas.filter(
    (c) => !(c.fuente === 'paso' && c.lastStepIdx !== null && c.lastStepIdx < baseIndex),
  );

  // El 100% es la primera etapa visible, con el mismo guard de `baseRef` que
  // los pasos: cero sesiones da todo 0, no NaN (T04 §6 punto 8).
  const baseSessions = visibles.length > 0 ? visibles[0]!.sessions : 0;
  const baseRef = baseSessions || 1;

  let prevSessions = 0;
  let prevAncho = 100;
  const etapas: EmbudoEtapa[] = visibles.map((c, i) => {
    const pctOfBase = (c.sessions / baseRef) * 100;
    const pctOfPrevious = i === 0 ? 100 : prevSessions > 0 ? (c.sessions / prevSessions) * 100 : 0;
    const dropFromPrevious = i === 0 ? 0 : prevSessions > 0 ? 100 - pctOfPrevious : 0;
    // D-R09: el ancho se recorta al de la etapa anterior (acumulativo), el
    // número no. `inconsistente` se decide con sessions, no con el ancho.
    const anchoDibujo = i === 0 ? 100 : Math.min(pctOfBase, prevAncho);
    const inconsistente = i > 0 && c.sessions > prevSessions;
    prevSessions = c.sessions;
    prevAncho = anchoDibujo;
    return {
      stageOrder: c.stageOrder,
      label: c.label,
      slugs: c.slugs,
      fuente: c.fuente,
      sessions: c.sessions,
      pctOfBase,
      pctOfPrevious,
      dropFromPrevious,
      anchoDibujo,
      inconsistente,
    };
  });

  return { etapas, huerfanas };
}

export async function getFunnelData(f: FunnelFilters): Promise<FunnelData> {
  const base = f.base ?? 'landing';
  const params = filterParams(f);

  const [
    catalog,
    histRows,
    totalsRow,
    campaignRows,
    variantRows,
    countryRows,
    deviceRows,
    warningRows,
    stageRows,
    experimentRows,
  ] = await Promise.all([
      listSteps(f.funnelId),
      q<HistRow>(
        `SELECT max_step_index AS "maxStepIndex", count(*)::int AS n
         FROM sessions
         WHERE ${WHERE_SESSIONS}
         GROUP BY 1`,
        params,
      ),
      q1<TotalsRow>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE max_step_index >= 1)::int      AS "quizStarted",
                count(*) FILTER (WHERE sales_view_at     IS NOT NULL)::int AS "salesViews",
                count(*) FILTER (WHERE checkout_click_at IS NOT NULL)::int AS "checkoutClicks",
                count(*) FILTER (WHERE purchased_at      IS NOT NULL)::int AS purchases
         FROM sessions
         WHERE ${WHERE_SESSIONS}`,
        params,
      ),
      q<BreakdownRow & { campaign: string }>(
        `SELECT utm_campaign AS campaign,
                count(*)::int AS sessions,
                count(*) FILTER (WHERE purchased_at IS NOT NULL)::int AS purchases
         FROM sessions
         WHERE ${WHERE_SESSIONS}
         GROUP BY 1
         ORDER BY sessions DESC`,
        params,
      ),
      q<BreakdownRow & { variant: string }>(
        `SELECT variant,
                count(*)::int AS sessions,
                count(*) FILTER (WHERE purchased_at IS NOT NULL)::int AS purchases
         FROM sessions
         WHERE ${WHERE_SESSIONS}
         GROUP BY 1
         ORDER BY sessions DESC`,
        params,
      ),
      q<CountRow & { country: string | null }>(
        `SELECT country, count(*)::int AS sessions
         FROM sessions
         WHERE ${WHERE_SESSIONS}
         GROUP BY 1
         ORDER BY sessions DESC`,
        params,
      ),
      q<CountRow & { device: string | null }>(
        `SELECT device, count(*)::int AS sessions
         FROM sessions
         WHERE ${WHERE_SESSIONS}
         GROUP BY 1
         ORDER BY sessions DESC`,
        params,
      ),
      q<WarningRow>(
        // "Recientes" = últimas 24 h: un aviso de hace una semana no es un
        // problema en curso y el banner deja de gritar solo.
        `SELECT reason, count(*)::int AS count
         FROM ingest_errors
         WHERE funnel_id = $1 AND received_at >= now() - interval '24 hours'
         GROUP BY 1
         ORDER BY count DESC`,
        [f.funnelId],
      ),
      // Las etapas del embudo literal (migración 017, D-R07): la frontera es
      // un slug, estable aunque el quiz se reordene. Una fila es un rango de
      // pasos o un hito: los CHECK de la 017 garantizan que nunca las dos.
      q<FunnelStageRow>(
        `SELECT stage_order AS "stageOrder", label,
                starts_at_slug AS "startsAtSlug", milestone
         FROM funnel_stages
         WHERE funnel_id = $1
         ORDER BY stage_order`,
        [f.funnelId],
      ),
      // Desglose por dimensión del experimento: una consulta más contra
      // `sessions`, ninguna contra `events`, con el MISMO WHERE_SESSIONS y los
      // MISMOS parámetros posicionales que el resto del embudo. El centinela
      // agrupa los NULL; el orden de las filas lo decide
      // `calcularTasasExperimento`, no un ORDER BY (la collation de la base
      // pondría el centinela en cualquier lado según el servidor).
      //
      // La plata sale de `orders`, la fuente real de la facturación (la misma que
      // usa Ventas), con una subconsulta correlacionada por sesión. Las
      // decisiones que no son obvias:
      //
      //  - Subconsulta y NO un join a `orders`: una sesión con front + upsell
      //    tiene DOS órdenes, y un join plano la duplicaría en todos los
      //    `count(*)` de arriba, inflando sesiones y conversiones. Sumando de a
      //    una sesión los contadores quedan intactos.
      //  - Va dentro de `sum(...)`, así que la sesión sin órdenes aporta 0 y
      //    sigue contando en el denominador. Si desaparecieran las que no
      //    compraron, toda variante mostraría ~100% de conversión.
      //  - `status = 'approved'`: la plata reembolsada no es plata. Mismo
      //    criterio que el bruto de Ventas (lib/queries/sales.ts).
      //  - El join es por `session_id` SOLO. `orders.funnel_id` es atribución
      //    denormalizada y puede ser NULL (D10 de la migración 004): sumarlo a la
      //    condición descartaría en silencio las ventas que no se pudieron
      //    atribuir pero sí tienen sesión. El funnel ya lo acota el WHERE de
      //    `sessions`, que corre sobre una sola columna `funnel_id`.
      //  - `WHERE_SESSIONS` se interpola TAL CUAL, sin alias: por eso la
      //    subconsulta se correlaciona con `sessions.id` calificado y no se
      //    renombra la tabla. Un alias obligaría a reescribir el WHERE
      //    compartido, que es justo lo que lo mantiene sincronizado con el resto
      //    del embudo.
      //
      // La atribución es por COHORTE de entrada: la orden cuenta en el día en que
      // empezó la SESIÓN (el rango filtra `sessions.day`), no en el día en que se
      // cobró. Es lo correcto para un test de entrada —la compra de mañana
      // pertenece a la portada que la trajo hoy— y es también la razón de que esta
      // columna no tenga por qué coincidir con el bruto de Ventas del mismo rango.
      q<ExperimentoContadores>(
        `SELECT COALESCE(experiment, '${SIN_EXPERIMENTO}') AS experiment,
                count(*)::int                                                  AS sessions,
                count(*) FILTER (WHERE sales_view_at     IS NOT NULL)::int      AS "salesViews",
                count(*) FILTER (WHERE checkout_click_at IS NOT NULL)::int      AS "checkoutClicks",
                count(*) FILTER (WHERE purchased_at      IS NOT NULL)::int      AS purchases,
                count(*) FILTER (WHERE upsell_view_at    IS NOT NULL)::int      AS "upsellViews",
                count(*) FILTER (WHERE upsell_click_at   IS NOT NULL)::int      AS "upsellClicks",
                count(*) FILTER (WHERE downsell_view_at  IS NOT NULL)::int      AS "downsellViews",
                COALESCE(sum((
                  SELECT COALESCE(sum(o.amount), 0)
                  FROM orders o
                  WHERE o.session_id = sessions.id
                    AND o.status     = 'approved'
                )), 0)::float8                                                 AS revenue
         FROM sessions
         WHERE ${WHERE_SESSIONS}
         GROUP BY 1`,
        params,
      ),
    ]);

  const totals = totalsRow ?? {
    total: 0,
    quizStarted: 0,
    salesViews: 0,
    checkoutClicks: 0,
    purchases: 0,
  };

  // Suma acumulada inversa del histograma (D3): reached[i] = sesiones con
  // max_step_index >= i. El array se agranda hasta el tope del catálogo y del
  // histograma: un valor de step fuera del catálogo (un funnel que cambió sus
  // pasos) igual aporta a los pasos que tiene debajo.
  const catalogMax = catalog.length > 0 ? catalog[catalog.length - 1]!.stepIndex : 0;
  const histMax = histRows.reduce((m, r) => Math.max(m, r.maxStepIndex), 0);
  const reached = new Array<number>(Math.max(catalogMax, histMax) + 1).fill(0);
  for (const r of histRows) reached[r.maxStepIndex] = r.n;
  for (let i = reached.length - 2; i >= 0; i--) reached[i] += reached[i + 1];

  // D4: el 100% es el paso base (0 o 1). El `?? total` cubre el caso en que
  // nadie llegó al paso base pero hay sesiones, y el `|| 1` el de cero
  // sesiones (todo da 0, no NaN).
  const baseIndex = base === 'start' ? 1 : 0;
  const baseRef = (reached[baseIndex] ?? totals.total) || 1;

  // El embudo por etapas se arma con la MISMA fuente que los pasos: el
  // catálogo completo y el histograma acumulado. Los hitos leen los totales
  // que ya se consultan (T04 §4.3): no hay SQL nuevo para ellos.
  const porEtapas = buildEmbudoPorEtapas(
    stageRows,
    catalog.map((s) => ({ stepIndex: s.stepIndex, slug: s.slug, sessions: reached[s.stepIndex] ?? 0 })),
    { salesViews: totals.salesViews, checkoutClicks: totals.checkoutClicks, purchases: totals.purchases },
    baseIndex,
  );

  const steps: FunnelStepRow[] = [];
  let prev = 0;
  for (const s of catalog) {
    if (s.stepIndex < baseIndex) continue; // los pasos por encima de la base no se muestran
    const sessions = reached[s.stepIndex] ?? 0;
    steps.push(makeRow(s.stepIndex, s.slug, s.label, s.kind, sessions, baseRef, prev));
    prev = sessions;
  }
  // Los hitos son parte del embudo aunque no sean pasos del quiz: se agregan
  // al final de la lista, con el mismo baseRef (igual que el panel viejo).
  const milestones: Array<[slug: string, label: string, n: number]> = [
    ['sales_view', 'Llegaron a la venta', totals.salesViews],
    ['checkout_click', 'Clickearon comprar', totals.checkoutClicks],
    ['purchase', 'Compraron', totals.purchases],
  ];
  for (const [slug, label, n] of milestones) {
    steps.push(makeRow(-1, slug, label, 'milestone', n, baseRef, prev));
    prev = n;
  }

  // La fila '(otras)' suma el resto: sin esto la cuenta con 300 campañas
  // hace una tabla ilegible (task T06 §2).
  const campaigns = campaignRows.slice(0, CAMPAIGN_CAP);
  if (campaignRows.length > CAMPAIGN_CAP) {
    const rest = campaignRows.slice(CAMPAIGN_CAP);
    campaigns.push({
      campaign: '(otras)',
      sessions: rest.reduce((a, r) => a + r.sessions, 0),
      purchases: rest.reduce((a, r) => a + r.purchases, 0),
    });
  }

  return {
    totalSessions: totals.total,
    quizStarted: totals.quizStarted,
    salesViews: totals.salesViews,
    checkoutClicks: totals.checkoutClicks,
    purchases: totals.purchases,
    steps,
    campaigns,
    variants: variantRows,
    countries: countryRows.map((r) => ({ country: r.country ?? NO_DATA, sessions: r.sessions })),
    devices: deviceRows.map((r) => ({ device: r.device ?? NO_DATA, sessions: r.sessions })),
    ingestWarnings: warningRows,
    porEtapas,
    experiments: calcularTasasExperimento(experimentRows),
    generatedAt: new Date().toISOString(),
  };
}

function makeRow(
  stepIndex: number,
  slug: string,
  label: string,
  kind: string,
  sessions: number,
  baseRef: number,
  prev: number,
): FunnelStepRow {
  const pctOfBase = (sessions / baseRef) * 100;
  const pctOfPrevious = prev > 0 ? (sessions / prev) * 100 : 0;
  return {
    stepIndex,
    slug,
    label,
    kind,
    sessions,
    pctOfBase,
    pctOfPrevious,
    // La caída se mide contra el paso anterior (task T06 §3): es la que
    // decide el "peor paso", no la caída contra la base.
    dropFromPrevious: prev > 0 ? 100 - pctOfPrevious : 0,
  };
}

// ─── Rango compartido entre el route y la página ────────────────────────────
//
// Los dos resuelven el rango igual (preset del RangePicker o from/to a mano,
// siempre en la TZ del funnel, D19): la lógica vive acá y no duplicada, para
// que no haya dos formas de interpretar el mismo query string.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RANGE_PRESETS: ReadonlySet<string> = new Set(['today', 'yesterday', '7d', '14d', '30d', 'mtd', 'all']);

/**
 * Resuelve `?range=` o `?from=..&to=..` a un par de días. Tira RangeError si
 * llega un from/to inválido o incompleto; el route lo traduce a 400 y la
 * página cae al preset por defecto.
 */
export async function resolveFunnelRange(
  opts: { preset?: string | null; from?: string | null; to?: string | null },
  timezone: string,
): Promise<{ from: string; to: string }> {
  if (opts.from || opts.to) {
    if (
      !opts.from ||
      !opts.to ||
      !DATE_RE.test(opts.from) ||
      !DATE_RE.test(opts.to) ||
      opts.from > opts.to
    ) {
      throw new RangeError('invalid_range');
    }
    return { from: opts.from, to: opts.to };
  }
  // Un preset desconocido cae en 'today', el mismo default del RangePicker.
  const preset: RangePreset = RANGE_PRESETS.has(opts.preset ?? '')
    ? (opts.preset as RangePreset)
    : 'today';
  return resolveRange(preset, timezone);
}
