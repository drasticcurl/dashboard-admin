/**
 * Métricas por objeto de Anuncios (T15): el cruce del gasto de Meta con las
 * ventas reales, atribuidas por el id que viene en los UTMs.
 *
 * Implementa el contrato congelado de §4 de 00-PLAN-ANUNCIOS.md. Una fila por
 * campaña, conjunto o anuncio, con el gasto de `ad_spend` y la plata real de
 * `orders` al lado, más el contador de ventas sin atribuir (D-A8).
 *
 * Este archivo no toca la red, no escribe en Meta y no evalúa reglas: es SQL
 * y mapeo. Es la pieza sobre la que se apoyan la tabla del gestor (T17) y cada
 * condición de cada regla (T16): si estos números están mal, el motor pausa
 * campañas rentables.
 *
 * ── Las tres reglas que no se pueden romper ──
 * 1. EL DÍA NO ES EL MISMO EN LAS DOS ZONAS (D-A10). Las ventas se agrupan por
 *    `(orders.purchased_at AT TIME ZONE cuenta.timezone)::date` y NUNCA por
 *    `orders.day`, que está congelado en la zona del funnel. Verificado en
 *    `_verificacion-016.sql` §6.
 * 2. UNA LLAMADA = UNA ZONA HORARIA. Si las cuentas alcanzadas no comparten
 *    zona, se TIRA en lugar de elegir la primera (§4 punto 2).
 * 3. `null` Y NO `0` cuando el denominador es cero (ROI/ROAS/CPA/CTR/CPC). Un
 *    conjunto con €0 de gasto no tiene ROI: si se devuelve 0, la condición
 *    `ROI < 1.1` se cumple y la regla pausa un conjunto que no gastó nada.
 *
 * La convención de qué `status` contribuye a cada término del neto se copia de
 * `lib/queries/sales.ts` para que Ventas y Anuncios muestren el mismo neto. El
 * `roi` de `sales.ts` es OTRA COSA (resultado / gasto_total): acá no se importa
 * ni se replica (D-A7): `roi = neto / gasto_ads`.
 */

import { q, q1 } from '@/lib/db';
import { SQL_VIGENTE } from '@/lib/ads/jerarquia';
import { esClaveOrden, ORDEN_SQL } from '@/lib/ads/orden';
import { TZ_DEFAULT } from '@/lib/ads/zona';
import type {
  ClaveOrden,
  FiltrosAds,
  MetricasObjeto,
  NivelAds,
  PeriodoAds,
  ResultadoMetricas,
} from '@/lib/ads/tipos';

/** Tope de filas por página (default y máximo del contrato §4). */
const LIMIT_DEFAULT = 500;
const LIMIT_MAX = 1000;

/**
 * Extracción del id de Meta desde un UTM, MIRROR de la expresión SQL del §4
 * (verificada con y sin espacios en `_verificacion-016.sql` §5). Los guardias
 * de longitud no son decorativos: sin ellos, una campaña llamada "2026" se
 * toma como un id. Vive acá para que el test pruebe los 6 casos del plan
 * contra la misma lógica que corre en SQL.
 */
export function extraerIdDeUtm(utm: string): string | null {
  if (/\|\s*[0-9]{6,}\s*$/.test(utm)) {
    const m = /[0-9]+\s*$/.exec(utm);
    return m ? m[0].trim() : null;
  }
  if (/^\s*[0-9]{9,}\s*$/.test(utm)) {
    return utm.trim();
  }
  return null;
}

/** La expresión SQL de la extracción, idéntica a la del plan (§4). */
const EXTRAE_SQL = (col: string): string => String.raw`
    CASE
      WHEN ${col} ~ '\|\s*[0-9]{6,}\s*$' THEN btrim(substring(${col} from '[0-9]+\s*$'))
      WHEN ${col} ~ '^\s*[0-9]{9,}\s*$' THEN btrim(${col})
      ELSE NULL
    END`;

type NivelAdsValido = NivelAds;
type PeriodoAdsValido = PeriodoAds;

const NIVELES: NivelAdsValido[] = ['campaign', 'adset', 'ad'];
const PERIODOS: PeriodoAdsValido[] = ['today', 'yesterday', '7d', '7d_excl_today'];

/**
 * La regla de vigencia de T14 (`SQL_VIGENTE`), con la columna `synced_at`
 * calificada al alias de la tabla. `SQL_VIGENTE` la dejó sin calificar porque
 * T14 la usa sobre una sola tabla; acá la campaña se une a conjuntos/anuncios
 * (los tres tienen `synced_at`) y sin calificar queda ambigua.
 */
function vigenciaDe(alias: string): string {
  return SQL_VIGENTE.replaceAll('<tabla>', alias).replace(
    'synced_at >=',
    `${alias}.synced_at >=`,
  );
}

/** Filas tal como salen de pg (numeric/bigint → string): el mapeo a número
 *  ocurre una sola vez, en `filaDesdeRow`, igual que el resto de lib/queries/. */
export type RowMetricas = {
  objectId: string;
  objectName: string | null;
  accountId: string;
  campaignId: string;
  adsetId: string;
  adId: string;
  funnelId: number | null;
  status: string | null;
  effectiveStatus: string | null;
  budgetLevel: 'campaign' | 'adset' | null;
  budgetMode: 'daily' | 'lifetime' | null;
  dailyBudgetEur: string | null;
  spendEur: string;
  impressions: string;
  clicks: string;
  sales: number;
  revenueEur: string;
  refundedEur: string;
  commissionsEur: string;
  costsEur: string;
  ultimaAccionAt: Date | string | null;

  // ── Metricas_Creativo (P-G03). El SQL que las llena es la task 15.1; hasta
  // entonces `filaDesdeRow` no las lee y devuelve null. ─────────────────────
  videoReproducciones: string | null;
  videoThruplay: string | null;
  videoP25: string | null;
  videoP50: string | null;
  videoP75: string | null;
  videoP100: string | null;

  // ── Metricas_Rango. `alcanceImpresiones` es la base de la frecuencia
  // (impresiones del rango ÷ alcance del rango, R7 c5). ─────────────────────
  alcance: string | null;
  alcanceImpresiones: string | null;

  /** Inicio programado de la jerarquía (R11 c8). */
  inicioProgramado: Date | string | null;

  /**
   * Frescura de la Jerarquía (R3.1). Las tres ramas de la jerarquía traen las
   * columnas del objeto y la rama de solo-gasto del `UNION ALL` las trae en
   * `NULL`, así que la propiedad SIEMPRE viene: obligatorias y anulables, sin
   * `?`. El `null` de la rama de solo-gasto es un dato, no un hueco: significa
   * "este objeto no está en la Jerarquía".
   */
  syncedAt: Date | string | null;
  desaparecidoAt: Date | string | null;
};

/**
 * Convierte una fila de pg en una `MetricasObjeto`. Es la única función que
 * toca `Number()`, y el único lugar donde se calculan los cuatro cocientes
 * que devuelven `null` (ROI/ROAS/CPA/CTR/CPC): en SQL se enredan con los
 * COALESCE.
 *
 * `neto` y `profit` SÍ pueden ser 0 legítimamente: son sumas, no cocientes.
 */
export function filaDesdeRow(level: NivelAdsValido, row: RowMetricas): MetricasObjeto {
  const spendEur = Number(row.spendEur);
  const revenueEur = Number(row.revenueEur);
  const refundedEur = Number(row.refundedEur);
  const commissionsEur = Number(row.commissionsEur);
  const costsEur = Number(row.costsEur);
  const sales = Number(row.sales);
  const impressions = Number(row.impressions);
  const clicks = Number(row.clicks);

  const netEur = revenueEur - refundedEur - commissionsEur - costsEur;
  const profitEur = netEur - spendEur;

  return {
    level,
    objectId: row.objectId,
    objectName: row.objectName,
    accountId: row.accountId,
    campaignId: row.campaignId,
    adsetId: row.adsetId,
    adId: row.adId,
    funnelId: row.funnelId,
    status: row.status,
    effectiveStatus: row.effectiveStatus,
    budgetLevel: row.budgetLevel,
    budgetMode: row.budgetMode,
    dailyBudgetEur: row.dailyBudgetEur === null ? null : Number(row.dailyBudgetEur),
    spendEur,
    impressions,
    clicks,
    sales,
    revenueEur,
    refundedEur,
    commissionsEur,
    costsEur,
    netEur,
    profitEur,
    // null y no 0: un conjunto con €0 de gasto NO tiene ROI (§4 punto 1).
    roas: spendEur > 0 ? revenueEur / spendEur : null,
    roi: spendEur > 0 ? netEur / spendEur : null,
    cpaEur: sales > 0 ? spendEur / sales : null,
    ctr: impressions > 0 ? clicks / impressions : null,
    cpcEur: clicks > 0 ? spendEur / clicks : null,
    ultimaAccionAt:
      row.ultimaAccionAt === null
        ? null
        : row.ultimaAccionAt instanceof Date
          ? row.ultimaAccionAt.toISOString()
          : new Date(row.ultimaAccionAt).toISOString(),
    // ── Metricas_Creativo y Metricas_Rango. null y no 0: distinguir "campo
    // ausente" de "campo en cero" es el punto de R7 c8/c14. Los cocientes se
    // calculan acá, que es LA fuente de verdad de lo que se muestra: el SQL de
    // `medidas` los tiene SOLO para el ORDER BY (design §4). ───────────────
    cpmEur: impressions > 0 ? (spendEur * 1000) / impressions : null,
    videoReproducciones: nullableNumber(row.videoReproducciones),
    videoThruplay: nullableNumber(row.videoThruplay),
    videoP25: nullableNumber(row.videoP25),
    videoP50: nullableNumber(row.videoP50),
    videoP75: nullableNumber(row.videoP75),
    videoP100: nullableNumber(row.videoP100),
    hookRate:
      impressions > 0 && row.videoReproducciones !== null
        ? (nullableNumber(row.videoReproducciones) ?? 0) / impressions
        : null,
    alcance: nullableNumber(row.alcance),
    frecuencia: frecuenciaDesdeRow(row),
    inicioProgramado:
      row.inicioProgramado === null
        ? null
        : row.inicioProgramado instanceof Date
          ? row.inicioProgramado.toISOString()
          : new Date(row.inicioProgramado).toISOString(),
    // ── Frescura de la Jerarquía (R3.1). Los dos son hechos distintos: cuándo
    // se confirmó el objeto y desde cuándo Meta dejó de devolverlo. Las filas
    // que salen del UNION ALL con `gasto` (objetos con gasto sin fila en la
    // Jerarquía) traen NULL en las dos, que es correcto: nunca se sincronizaron
    // ni desaparecieron. ──────────────────────────────────────────────────
    syncedAt: isoDesdeRow(row.syncedAt),
    desaparecidoAt: isoDesdeRow(row.desaparecidoAt),
  };
}

/**
 * La fila del agregado del filtro completo (R7.1). Todo llega como string:
 * `sum(numeric)` es numeric, `sum(int)` es bigint y `count(*)` es bigint, y el
 * driver los pasa sin convertir para no perder precisión.
 */
export type RowTotales = {
  spendEur: string;
  revenueEur: string;
  netEur: string;
  profitEur: string;
  sales: string;
  filas: string;
};

/**
 * Los totales del filtro completo. El agregado no tiene GROUP BY, así que
 * SIEMPRE devuelve una fila; el `null` se contempla igual porque `q1` lo
 * permite en el tipo, y un filtro sin filas vale 0 en los seis campos.
 */
export function totalesDesdeRow(row: RowTotales | null): ResultadoMetricas['totales'] {
  return {
    spendEur: Number(row?.spendEur ?? 0),
    revenueEur: Number(row?.revenueEur ?? 0),
    netEur: Number(row?.netEur ?? 0),
    profitEur: Number(row?.profitEur ?? 0),
    sales: Number(row?.sales ?? 0),
    filas: Number(row?.filas ?? 0),
  };
}

/**
 * timestamptz de pg (Date con el driver, string si alguien castea a text) → ISO
 * 8601, conservando el null. Sigue aceptando `undefined` y tratándolo como
 * `null` aunque el tipo ya no lo permita: si algún día una capa de proyección
 * deja de reenviar la columna, la propiedad llega ausente y
 * `new Date(undefined).toISOString()` tira RangeError. Una fecha inválida
 * también devuelve null: preferimos la columna en `—` antes que una excepción
 * que voltea la tabla entera.
 */
function isoDesdeRow(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** bigint/numeric de pg (string) → number, conservando el null. */
function nullableNumber(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Frecuencia = impresiones del rango ÷ alcance del rango (R7 c5). Sólo con el
 *  rango exacto guardado: si falta cualquiera de los dos, null → `—`. */
function frecuenciaDesdeRow(row: RowMetricas): number | null {
  const alcance = nullableNumber(row.alcance);
  const impresiones = nullableNumber(row.alcanceImpresiones);
  if (alcance === null || impresiones === null || alcance <= 0) return null;
  return impresiones / alcance;
}

/**
 * La clave del nivel pedido: qué columna identifica al objeto en `ad_spend`,
 * en la jerarquía y en la resolución de atribución.
 */
type FragmentosNivel = {
  /** columna de ad_spend que identifica al objeto del nivel */
  gastoObjectId: string;
  /** GROUP BY del gasto */
  gastoGroupBy: string;
  /** columnas de padre para el objeto que sólo tiene gasto */
  gastoPadre: string;
  /** nombre desnormalizado (de ad_spend) para el objeto que sólo tiene gasto */
  gastoNombre: string;
  /** condición "tiene id" del nivel */
  gastoIdCond: string;
  /** columna de `atribuidas` con el id del nivel (para ventas y sinAtribuir) */
  ventasObjectId: string;
  ventasGroupBy: string;
};

const FRAGMENTOS: Record<NivelAdsValido, FragmentosNivel> = {
  campaign: {
    gastoObjectId: 's.campaign_id',
    gastoGroupBy: 's.account_id, s.campaign_id',
    gastoPadre: `s.campaign_id AS "campaignId", '' AS "adsetId", '' AS "adId"`,
    gastoNombre: 'max(s.campaign_name)',
    gastoIdCond: `s.campaign_id <> ''`,
    ventasObjectId: 'campaign_id',
    ventasGroupBy: 'account_id, campaign_id',
  },
  adset: {
    gastoObjectId: 's.adset_id',
    gastoGroupBy: 's.account_id, s.campaign_id, s.adset_id',
    gastoPadre: `s.campaign_id AS "campaignId", s.adset_id AS "adsetId", '' AS "adId"`,
    gastoNombre: 'max(s.adset_name)',
    gastoIdCond: `s.adset_id <> ''`,
    ventasObjectId: 'adset_id',
    ventasGroupBy: 'account_id, adset_id',
  },
  ad: {
    gastoObjectId: 's.ad_id',
    gastoGroupBy: 's.account_id, s.campaign_id, s.adset_id, s.ad_id',
    gastoPadre: `s.campaign_id AS "campaignId", s.adset_id AS "adsetId", s.ad_id AS "adId"`,
    gastoNombre: 'max(s.ad_name)',
    gastoIdCond: `s.ad_id <> ''`,
    ventasObjectId: 'ad_id',
    ventasGroupBy: 'account_id, ad_id',
  },
};

/** La rama de la jerarquía (objetos vigentes) para el nivel pedido. */
function jerarquiaObjetos(level: NivelAdsValido, filtros: { status: string }): string {
  switch (level) {
    case 'campaign': {
      const vigencia = vigenciaDe('c');
      return `
  SELECT c.campaign_id AS "objectId", c.name AS "objectName", c.account_id AS "accountId",
         c.campaign_id AS "campaignId", '' AS "adsetId", '' AS "adId",
         c."funnelId",
         c.status, c.effective_status AS "effectiveStatus",
         c.budget_level AS "budgetLevel",
         CASE WHEN c.daily_budget IS NOT NULL THEN 'daily'
              WHEN c.lifetime_budget IS NOT NULL THEN 'lifetime'
              ELSE NULL END AS "budgetMode",
         CASE WHEN c.daily_budget IS NOT NULL THEN c.daily_budget / 100.0 ELSE NULL END AS "dailyBudgetEur",
         c.start_time AS "inicioProgramado",
         c.synced_at AS "syncedAt", c.desaparecido_at AS "desaparecidoAt"
    FROM jerarquia_camps c
   WHERE ${vigencia}${filtros.status}`;
    }
    case 'adset': {
      const vigencia = vigenciaDe('s');
      return `
  SELECT s.adset_id AS "objectId", s.name AS "objectName", s.account_id AS "accountId",
         s.campaign_id AS "campaignId", s.adset_id AS "adsetId", '' AS "adId",
         s."funnelId",
         s.status, s.effective_status AS "effectiveStatus",
         c.budget_level AS "budgetLevel",
         CASE WHEN s.daily_budget IS NOT NULL THEN 'daily'
              WHEN s.lifetime_budget IS NOT NULL THEN 'lifetime'
              ELSE NULL END AS "budgetMode",
         CASE WHEN s.daily_budget IS NOT NULL THEN s.daily_budget / 100.0 ELSE NULL END AS "dailyBudgetEur",
         s.start_time AS "inicioProgramado",
         -- Calificadas con el alias del conjunto y no a secas: esta rama lo une
         -- con su campaña y las dos tablas tienen las dos columnas. La frescura
         -- que la fila muestra es la DEL OBJETO del nivel pedido (R3.1), no la
         -- de su padre.
         s.synced_at AS "syncedAt", s.desaparecido_at AS "desaparecidoAt"
    FROM jerarquia_sets s
    JOIN jerarquia_camps c ON c.campaign_id = s.campaign_id
   WHERE ${vigencia}${filtros.status}`;
    }
    case 'ad': {
      const vigencia = vigenciaDe('a');
      return `
  SELECT a.ad_id AS "objectId", a.name AS "objectName", a.account_id AS "accountId",
         a.campaign_id AS "campaignId", a.adset_id AS "adsetId", a.ad_id AS "adId",
         a."funnelId",
         a.status, a.effective_status AS "effectiveStatus",
         NULL::text AS "budgetLevel", NULL::text AS "budgetMode", NULL::numeric AS "dailyBudgetEur",
         NULL::timestamptz AS "inicioProgramado",
         a.synced_at AS "syncedAt", a.desaparecido_at AS "desaparecidoAt"
    FROM jerarquia_ads a
   WHERE ${vigencia}${filtros.status}`;
    }
  }
}

/**
 * La cadena de CTEs comunes a la query de filas y a la de sinAtribuir: cuentas
 * alcanzadas + su zona, la jerarquía acotada a esas cuentas, las órdenes con el
 * pre-filtro de ±2 días y los ids extraídos, y la cascada de atribución del §4.
 */
function comun(
  pAccounts: string,
  pDesde: string,
  pHasta: string,
  pTz: string,
  frag: FragmentosNivel,
): string {
  return `
  cuenta AS (
    SELECT a.account_id AS "accountId", a.funnel_id AS "funnelId",
           COALESCE(a.timezone, ${pTz}) AS tz
      FROM ad_accounts a
     WHERE a.active AND a.platform = 'meta'
       AND (${pAccounts}::text[] IS NULL OR cardinality(${pAccounts}) = 0 OR a.account_id = ANY(${pAccounts}))
  ),
  jerarquia_camps AS (
    SELECT c.*, cu."funnelId"
      FROM ad_campaigns c JOIN cuenta cu ON cu."accountId" = c.account_id
  ),
  jerarquia_sets AS (
    SELECT s.*, cu."funnelId"
      FROM ad_sets s JOIN cuenta cu ON cu."accountId" = s.account_id
  ),
  jerarquia_ads AS (
    SELECT a.*, cu."funnelId"
      FROM ads a JOIN cuenta cu ON cu."accountId" = a.account_id
  ),
  ordenes AS (
    SELECT o.id, o.amount_eur, o.commission_amount_eur, o.cost_amount_eur, o.status, o.purchased_at,
           ${EXTRAE_SQL('o.utm_campaign')} AS cid,
           ${EXTRAE_SQL('o.utm_medium')} AS sid,
           ${EXTRAE_SQL('o.utm_content')} AS aid
      FROM orders o
     WHERE o.purchased_at >= (${pDesde}::date - 2)::timestamptz
       AND o.purchased_at <  (${pHasta}::date + 2)::timestamptz
  ),
  atribuidas AS (
    SELECT o.amount_eur, o.commission_amount_eur, o.cost_amount_eur, o.status,
           COALESCE(ad.campaign_id, s.campaign_id, c.campaign_id) AS campaign_id,
           COALESCE(ad.adset_id, s.adset_id, '') AS adset_id,
           COALESCE(ad.ad_id, '') AS ad_id,
           COALESCE(ad.account_id, s.account_id, c.account_id) AS account_id
      FROM ordenes o
      LEFT JOIN jerarquia_ads ad ON o.aid IS NOT NULL AND ad.ad_id = o.aid
      LEFT JOIN jerarquia_sets s ON o.aid IS NULL AND o.sid IS NOT NULL AND s.adset_id = o.sid
      LEFT JOIN jerarquia_camps c ON o.aid IS NULL AND o.sid IS NULL AND o.cid IS NOT NULL AND c.campaign_id = o.cid
     WHERE (o.purchased_at AT TIME ZONE ${pTz})::date BETWEEN ${pDesde}::date AND ${pHasta}::date
  )`;
}

/** El rango del período, resuelto en la zona de la cuenta (misma fuente que
 *  getMetricasAds: el route lo usa para pedir el alcance ANTES de leer). */
export async function rangoDePeriodo(
  period: PeriodoAds,
  tz: string,
): Promise<{ desde: string; hasta: string }> {
  const rango = await q1<{ desde: string; hasta: string }>(
    `SELECT CASE $1::text
                WHEN 'today'          THEN (now() AT TIME ZONE $2)::date
                WHEN 'yesterday'      THEN ((now() AT TIME ZONE $2)::date - 1)
                WHEN '7d'             THEN ((now() AT TIME ZONE $2)::date - 6)
                WHEN '7d_excl_today'  THEN ((now() AT TIME ZONE $2)::date - 7)
              END::text AS desde,
            CASE $1::text
                WHEN 'today'          THEN (now() AT TIME ZONE $2)::date
                WHEN 'yesterday'      THEN ((now() AT TIME ZONE $2)::date - 1)
                WHEN '7d'             THEN (now() AT TIME ZONE $2)::date
                WHEN '7d_excl_today'  THEN ((now() AT TIME ZONE $2)::date - 1)
              END::text AS hasta`,
    [period, tz],
  );
  return {
    desde: rango?.desde ?? '1970-01-01',
    hasta: rango?.hasta ?? '1970-01-01',
  };
}

export async function getMetricasAds(f: FiltrosAds): Promise<ResultadoMetricas> {
  const level = f.level;
  const period = f.period;
  if (!NIVELES.includes(level)) throw new Error(`nivel de anuncios inválido: ${level}`);
  if (!PERIODOS.includes(period)) throw new Error(`período de anuncios inválido: ${period}`);

  const frag = FRAGMENTOS[level];
  const accountIds = f.accountIds && f.accountIds.length ? f.accountIds : null;
  const lim = Math.max(1, Math.min(f.limit ?? LIMIT_DEFAULT, LIMIT_MAX));

  // ── 1. Cuentas alcanzadas + zona. Una llamada = una zona horaria (§4). ──
  const cuentas = await q<{ accountId: string; tz: string }>(
    `SELECT account_id AS "accountId", COALESCE(timezone, $1) AS tz
       FROM ad_accounts
      WHERE active AND platform = 'meta'
        AND ($2::text[] IS NULL OR cardinality($2) = 0 OR account_id = ANY($2))
      ORDER BY account_id`,
    [TZ_DEFAULT, accountIds],
  );

  const zonas = new Set(cuentas.map((c) => c.tz));
  if (zonas.size > 1) {
    throw new Error(
      `zonas horarias mezcladas: ${cuentas
        .map((c) => `${c.accountId}=${c.tz}`)
        .join(', ')}. ` +
        'Esta versión no soporta una regla sobre cuentas en zonas distintas (P-A09).',
    );
  }

  const generatedAt = new Date().toISOString();
  const tz = cuentas[0]?.tz ?? TZ_DEFAULT;

  // ── 2. Rango del período, resuelto en la zona de la cuenta. ──
  const { desde, hasta } = await rangoDePeriodo(period, tz);

  // ── 3. Parámetros de la query de filas ──
  const params: unknown[] = [];
  let n = 1;
  const ph = (): string => `$${n++}`;
  const p = (v: unknown): string => {
    params.push(v);
    return ph();
  };

  const pAccounts = p(accountIds);
  const pDesde = p(desde);
  const pHasta = p(hasta);
  const pTz = p(tz);

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ EL FILTRO DE ESTADO VA AFUERA DE LA JERARQUÍA. LEER ANTES DE MOVERLO.    │
  // └─────────────────────────────────────────────────────────────────────────┘
  // Se aplica sobre la columna YA PROYECTADA por `jerarquia_vigentes`, no con el
  // alias de la tabla adentro de esa CTE, y eso no es estilo: es lo que hace que
  // el anti-join de `objetos` signifique lo que dice.
  //
  // El anti-join pregunta "¿este objeto con gasto NO está en la jerarquía?". Si
  // el filtro de estado vive adentro de la CTE que el anti-join usa como
  // referencia, la pregunta se convierte en "¿no está entre los ACTIVOS?", y
  // entonces TODO objeto que el filtro excluye reaparece por la rama de
  // solo-gasto con `status = NULL`.
  //
  // El modo de falla que eso causó (medido en producción el 2026-09-01): la
  // regla «Apagar - Gasto +$4 sin ventas» pausó los mismos 15 conjuntos entre 23
  // y 57 veces por día. El ciclo era:
  //
  //   1. El conjunto está ACTIVE, entra por la jerarquía, la regla lo pausa.
  //   2. `ad_sets.status` pasa a PAUSED, así que sale de la jerarquía filtrada.
  //   3. El anti-join lo considera "no está en la jerarquía" y lo reinyecta por
  //      la rama de gasto (sigue teniendo filas en `ad_spend` del período), con
  //      `status = NULL`.
  //   4. El paso 2 de `motor.ts` compara `fila.status === 'PAUSED'`: NULL no es
  //      PAUSED, así que no descarta nada y vuelve a pausar. Para siempre.
  //
  // La huella que lo prueba: cada conjunto tiene exactamente UNA fila de pausa
  // con `before_value = 'ACTIVE'` (la legítima) y entre 49 y 56 con
  // `before_value = NULL`, y cero acciones de `activate` que pudieran explicarlo.
  //
  // La cascada tampoco se filtra adentro de la jerarquía, por el mismo motivo:
  // va al WHERE de `base` (ver la nota de correctitud en la cadena de CTEs).
  const filtroEstado =
    f.status === 'active'
      ? ` WHERE status = 'ACTIVE'`
      : f.status === 'paused'
        ? ` WHERE status = 'PAUSED'`
        : '';

  // Filtro_Cascada: los arrays nuevos (R8 c11). Los campos singulares
  // `campaignId`/`adsetId` se conservan por compatibilidad y se envuelven en
  // arrays. Tope de 50 ids por lista (R8 c1, c14).
  const campaignIds = f.campaignIds ?? (f.campaignId ? [f.campaignId] : null);
  const adsetIds = f.adsetIds ?? (f.adsetId && level !== 'campaign' ? [f.adsetId] : null);

  // Orden_Tabla normalizado (R4 c3). Default: gastos descendente.
  const claveOrden = f.orderBy && esClaveOrden(f.orderBy) ? f.orderBy : ('gastos' as ClaveOrden);
  const dir = f.orderDir === 'asc' ? 'asc' : 'desc';
  const conPagina = typeof f.page === 'number' && Number.isFinite(f.page) && f.page >= 1;
  const pagina = conPagina ? Math.floor(f.page!) : 1;
  const offset = (pagina - 1) * lim;

  const pNombre = p(f.nombre ?? null);
  const pCampaignIds = p(campaignIds);
  const pAdsetIds = p(adsetIds);
  const pOcultarPadre = p(f.ocultarPadreApagado === true);
  const pOcultarSinDatos = p(f.ocultarSinDatos === true);
  const pNivel = p(level);

  const com = comun(pAccounts, pDesde, pHasta, pTz, frag);
  // Sin filtro de estado: ésta es la referencia de EXISTENCIA en la jerarquía.
  const jerObj = jerarquiaObjetos(level, { status: '' });

  // ── La cadena de CTEs. `base` es el SELECT final de antes, sin ORDER BY ni
  // LIMIT, y con el Filtro_Cascada aplicado sobre las columnas
  // desnormalizadas que TODAS las ramas de `objetos` traen. ───────────────
  // NOTA DE CORRECTITUD: antes la cascada se filtraba dentro de la jerarquía,
  // así que la rama `UNION ALL` de objetos que sólo tienen gasto NO la
  // respetaba: un objeto con gasto de otra campaña aparecía igual. Movido al
  // WHERE de `base`, la contención de R8 c3 es cierta por construcción (la
  // Property 7 lo verifica, incluida esa rama).
  const cadenaComun = `WITH${com},
  gasto AS (
    SELECT s.account_id AS "accountId",
           ${frag.gastoObjectId} AS "objectId",
           ${frag.gastoPadre},
           ${frag.gastoNombre} AS "objectName",
           COALESCE(sum(s.spend_eur), 0) AS "spendEur",
           COALESCE(sum(s.impressions), 0) AS impressions,
           COALESCE(sum(s.clicks), 0) AS clicks,
           -- sin COALESCE a propósito: si todas las filas del rango tienen el
           -- campo ausente (sync degradado), la suma es NULL y la columna
           -- muestra —, que es distinto de 0 (R7 c8/c14).
           sum(s.video_plays) AS "videoReproducciones",
           sum(s.video_thruplay) AS "videoThruplay",
           sum(s.video_p25) AS "videoP25",
           sum(s.video_p50) AS "videoP50",
           sum(s.video_p75) AS "videoP75",
           sum(s.video_p100) AS "videoP100"
      FROM ad_spend s
      JOIN cuenta cu ON cu."accountId" = s.account_id
     WHERE s.day BETWEEN ${pDesde}::date AND ${pHasta}::date
       AND ${frag.gastoIdCond}
     GROUP BY ${frag.gastoGroupBy}
  ),
  -- Todos los objetos VIGENTES del nivel, sin mirar el estado. Es la referencia
  -- del anti-join de abajo: "estar en la jerarquía" no puede depender del filtro
  -- de estado (ver el comentario largo de filtroEstado en el TypeScript).
  jerarquia_vigentes AS (${jerObj}),
  jerarquia_objetos AS (SELECT * FROM jerarquia_vigentes${filtroEstado}),
  objetos AS (
    SELECT * FROM jerarquia_objetos
    UNION ALL
    SELECT g."objectId", g."objectName", g."accountId",
           g."campaignId", g."adsetId", g."adId",
           cu."funnelId",
           NULL::text AS status, NULL::text AS "effectiveStatus",
           NULL::text AS "budgetLevel", NULL::text AS "budgetMode", NULL::numeric AS "dailyBudgetEur",
           NULL::timestamptz AS "inicioProgramado",
           -- Frescura en NULL y no en now(): esta rama son objetos con gasto en
           -- ad_spend que NO tienen fila en la Jerarquía, así que nunca se
           -- sincronizaron ni desaparecieron. Un now() acá los dibujaría como
           -- los más frescos de la tabla, que es exactamente lo contrario.
           NULL::timestamptz AS "syncedAt", NULL::timestamptz AS "desaparecidoAt"
      FROM gasto g
      JOIN cuenta cu ON cu."accountId" = g."accountId"
     -- Contra jerarquia_VIGENTES, no contra jerarquia_objetos: un conjunto
     -- pausado SÍ está en la jerarquía, así que no se reinyecta acá con el
     -- estado en NULL. Volver a apuntar esto a jerarquia_objetos reabre el
     -- bucle de pausas del 2026-09-01.
     WHERE NOT EXISTS (SELECT 1 FROM jerarquia_vigentes h
                        WHERE h."objectId" = g."objectId" AND h."accountId" = g."accountId")
  ),
  ventas AS (
    SELECT account_id, ${frag.ventasObjectId} AS "objectId",
           count(*) FILTER (WHERE status = 'approved')::int AS "sales",
           COALESCE(sum(amount_eur) FILTER (WHERE status = 'approved'), 0) AS "revenueEur",
           COALESCE(sum(amount_eur) FILTER (WHERE status <> 'approved'), 0) AS "refundedEur",
           COALESCE(sum(commission_amount_eur) FILTER (WHERE status = 'approved'), 0) AS "commissionsEur",
           COALESCE(sum(cost_amount_eur) FILTER (WHERE status = 'approved'), 0) AS "costsEur"
      FROM atribuidas
     WHERE ${frag.ventasObjectId} IS NOT NULL AND ${frag.ventasObjectId} <> ''
     GROUP BY ${frag.ventasGroupBy}
  ),
  ultima_accion AS (
    SELECT object_id, max(created_at) AS "ultimaAccionAt"
      FROM ad_actions
     WHERE NOT dry_run
     GROUP BY object_id
  ),
  base AS (
    SELECT o."objectId", o."objectName", o."accountId",
           o."campaignId", o."adsetId", o."adId", o."funnelId",
           o.status, o."effectiveStatus", o."budgetLevel", o."budgetMode", o."dailyBudgetEur",
           COALESCE(g."spendEur", 0) AS "spendEur",
           COALESCE(g.impressions, 0) AS impressions,
           COALESCE(g.clicks, 0) AS clicks,
           g."videoReproducciones", g."videoThruplay",
           g."videoP25", g."videoP50", g."videoP75", g."videoP100",
           COALESCE(v."sales", 0) AS "sales",
           COALESCE(v."revenueEur", 0) AS "revenueEur",
           COALESCE(v."refundedEur", 0) AS "refundedEur",
           COALESCE(v."commissionsEur", 0) AS "commissionsEur",
           COALESCE(v."costsEur", 0) AS "costsEur",
           al.reach AS "alcance",
           al.impressions AS "alcanceImpresiones",
           u."ultimaAccionAt",
           o."inicioProgramado",
           -- Re-proyectadas explícitamente: este SELECT enumera sus columnas una
           -- por una, así que una que llega a objetos y no se nombra acá no
           -- llega nunca a la fila (medidas y el SELECT final sí usan estrella).
           o."syncedAt", o."desaparecidoAt"
      FROM objetos o
      LEFT JOIN gasto g ON g."accountId" = o."accountId" AND g."objectId" = o."objectId"
      LEFT JOIN ventas v ON v.account_id = o."accountId" AND v."objectId" = o."objectId"
      -- Metricas_Rango: igualdad EXACTA del rango (P-G07). Sin fila → NULL → —.
      LEFT JOIN ad_alcance al
             ON al.platform = 'meta' AND al.account_id = o."accountId"
            AND al.level = ${pNivel}::text AND al.object_id = o."objectId"
            AND al.date_from = ${pDesde}::date AND al.date_to = ${pHasta}::date
      LEFT JOIN ultima_accion u ON u.object_id = o."objectId"
     WHERE (${pNombre}::text IS NULL OR o."objectName" ILIKE '%' || ${pNombre} || '%')
       -- Filtro_Cascada: acá y no dentro de la jerarquía, para que alcance
       -- también a los objetos que sólo tienen gasto (R8 c2, c3).
       AND (${pCampaignIds}::text[] IS NULL OR cardinality(${pCampaignIds}) = 0
            OR o."campaignId" = ANY(${pCampaignIds}))
       AND (${pAdsetIds}::text[] IS NULL OR cardinality(${pAdsetIds}) = 0
            OR o."adsetId" = ANY(${pAdsetIds}))
       -- Padre apagado: el effective_status de Meta ya lo dice, así que no hace
       -- falta un JOIN al padre. Los objetos que SÓLO tienen gasto traen NULL y
       -- NO se ocultan: NULL es "no sé", y esconder gasto por no saber es peor
       -- que mostrarlo. A nivel campaña el filtro es inocuo (una campaña no
       -- tiene padre, nunca está CAMPAIGN_PAUSED).
       AND (NOT ${pOcultarPadre}::boolean OR o."effectiveStatus" IS NULL
            OR o."effectiveStatus" NOT IN ('CAMPAIGN_PAUSED', 'ADSET_PAUSED'))
  ),
  -- Los cocientes existen SOLO para el ORDER BY. Lo que la API devuelve lo
  -- sigue calculando filaDesdeRow: una sola fuente de verdad para lo que se
  -- muestra (la Property 6 impide que las dos mitades se separen).
  medidas AS (
    SELECT b.*,
           (b."revenueEur" - b."refundedEur" - b."commissionsEur" - b."costsEur") AS "netEur",
           (b."revenueEur" - b."refundedEur" - b."commissionsEur" - b."costsEur") - b."spendEur" AS "profitEur",
           b."revenueEur" / NULLIF(b."spendEur", 0) AS "roas",
           (b."revenueEur" - b."refundedEur" - b."commissionsEur" - b."costsEur") / NULLIF(b."spendEur", 0) AS "roi",
           b."spendEur" / NULLIF(b."sales", 0) AS "cpaEur",
           b.clicks::numeric / NULLIF(b.impressions, 0) AS "ctr",
           b."spendEur" / NULLIF(b.clicks, 0) AS "cpcEur",
           b."spendEur" * 1000 / NULLIF(b.impressions, 0) AS "cpmEur",
           b."alcanceImpresiones"::numeric / NULLIF(b."alcance", 0) AS "frecuencia",
           b."videoReproducciones"::numeric / NULLIF(b.impressions, 0) AS "hookRate"
      FROM base b
     -- Sin datos en el período: ni gasto ni ventas. Con gasto y sin ventas la
     -- fila SÍ tiene dato y no se oculta nunca — es justo la que hay que ver.
     -- Va acá y no en base porque spendEur y sales son alias de ese SELECT y
     -- un WHERE no puede referenciar los alias de su propio SELECT.
     WHERE (NOT ${pOcultarSinDatos}::boolean OR b."spendEur" > 0 OR b."sales" > 0)
  )`;

  // Los parámetros que `cadenaComun` referencia, congelados ACÁ: `p()` empuja
  // sobre el mismo `params` y las ramas de la query de filas todavía van a
  // agregar los suyos (offset/limit, o after/limit). Postgres deduce la aridad
  // del $n más alto que el SQL nombra, así que ejecutar `cadenaComun` con el
  // array completo tira `bind message supplies N parameters, but prepared
  // statement requires M`. El snapshot va antes de esas ramas y no después,
  // para que agregar un filtro nuevo arriba no obligue a tocar un número.
  const paramsCadenaComun = params.slice();

  // `page` tiene precedencia sobre `after` (design §4). Con `after` se conserva
  // el comportamiento viejo por compatibilidad; con `page`, el orden es el del
  // Orden_Tabla resuelto SOBRE TODO el conjunto filtrado, y el recorte de
  // página va DESPUÉS (R4 c3, c9). `count(*) OVER ()` se evalúa antes del
  // ORDER BY/LIMIT externo: es el total real, no el de la página (R4 c13).
  // Los parámetros de la cola se crean POR RAMA: Postgres rechaza un parámetro
  // no referenciado, así que cada rama sólo agrega los que usa.
  const filasSql = conPagina
    ? `${cadenaComun}
SELECT m.*, count(*) OVER () AS "totalFilas"
  FROM medidas m
 ORDER BY ${ORDEN_SQL[claveOrden]} ${dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, m."objectId" ASC
 OFFSET ${p(offset)}
 LIMIT ${p(lim)}`
    : (() => {
        const pAfter = p(f.after ?? null);
        return `${cadenaComun}
SELECT m.*, count(*) OVER () AS "totalFilas"
  FROM medidas m
 WHERE (${pAfter}::text IS NULL OR m."objectId" > ${pAfter})
 ORDER BY m."objectId" ASC
 LIMIT ${p(lim)}`;
      })();

  // ── 4. Los totales del FILTRO COMPLETO (R7.1, Property 9). ──
  // La MISMA `cadenaComun` que las filas, sin OFFSET ni LIMIT: el total es una
  // función del filtro y no de la página. Corre sobre `medidas` y no sobre
  // `base` porque el filtro `ocultarSinDatos` vive en el WHERE de `medidas`, y
  // un total que incluyera filas que la tabla esconde no sería el de lo que el
  // usuario ve.
  //
  // `netEur` y `profitEur` se SUMAN de las columnas que `medidas` ya calcula en
  // lugar de rearmar la fórmula: dos copias de `revenue − refunded − comisiones
  // − costos` se separan en el primer cambio, y entonces el total dejaría de
  // cerrar contra las filas.
  //
  // Sin cocientes a propósito (ROI/ROAS/CPA): el cociente de las sumas no es la
  // suma de los cocientes, y devolverlos acá invitaría a promediarlos.
  // COALESCE porque sum() sobre cero filas es NULL, y el total de un filtro
  // vacío es 0.
  const totalesSql = `${cadenaComun}
SELECT COALESCE(sum(m."spendEur"), 0)   AS "spendEur",
       COALESCE(sum(m."revenueEur"), 0) AS "revenueEur",
       COALESCE(sum(m."netEur"), 0)     AS "netEur",
       COALESCE(sum(m."profitEur"), 0)  AS "profitEur",
       COALESCE(sum(m."sales"), 0)      AS "sales",
       count(*)                         AS "filas"
  FROM medidas m`;

  // ── 5. Ventas sin atribuir (D-A8), para el nivel pedido. ──
  const sinSql = `WITH${com}
SELECT count(*) FILTER (WHERE status = 'approved')::int AS "sales",
       COALESCE(sum(amount_eur) FILTER (WHERE status = 'approved'), 0) AS "revenueEur"
  FROM atribuidas
 WHERE COALESCE(${frag.ventasObjectId}, '') = ''`;

  const sinParams: unknown[] = [accountIds, desde, hasta, tz];

  // Las tres en el mismo Promise.all: el agregado no agrega una vuelta de red.
  const [filasRaw, totalesRow, sinRow] = await Promise.all([
    q<RowMetricas & { totalFilas: string }>(filasSql, params),
    q1<RowTotales>(totalesSql, paramsCadenaComun),
    q1<{ sales: number; revenueEur: string }>(sinSql, sinParams),
  ]);

  const total = filasRaw.length > 0 ? Number(filasRaw[0]!.totalFilas) : 0;
  const totalPaginas = total === 0 ? 0 : Math.ceil(total / lim);
  const filas = filasRaw.map((r) => filaDesdeRow(level, r));

  return {
    filas,
    hayMas: conPagina ? pagina < totalPaginas : total > lim,
    sinAtribuir: {
      sales: sinRow?.sales ?? 0,
      revenueEur: sinRow ? Number(sinRow.revenueEur) : 0,
    },
    rango: { from: desde, to: hasta, timezone: tz },
    generatedAt,
    total,
    pagina,
    totalPaginas,
    orden: { clave: claveOrden, dir },
    alcanceError: null,
    totales: totalesDesdeRow(totalesRow),
  };
}

