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
import type {
  FiltrosAds,
  MetricasObjeto,
  NivelAds,
  PeriodoAds,
  ResultadoMetricas,
} from '@/lib/ads/tipos';

/**
 * Default explícito cuando `ad_accounts.timezone` está en NULL (P-A03): no se
 * asume UTC en silencio. Es el mismo default que usa la verificación de T15 §8
 * (`coalesce(timezone,'Europe/Lisbon')`) y se devuelve en `rango.timezone` para
 * que la UI lo muestre.
 */
const TZ_DEFAULT = 'Europe/Lisbon';

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
  };
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
function jerarquiaObjetos(level: NivelAdsValido, filtros: { status: string; extra: string }): string {
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
         CASE WHEN c.daily_budget IS NOT NULL THEN c.daily_budget / 100.0 ELSE NULL END AS "dailyBudgetEur"
    FROM jerarquia_camps c
   WHERE ${vigencia}${filtros.status}${filtros.extra}`;
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
         CASE WHEN s.daily_budget IS NOT NULL THEN s.daily_budget / 100.0 ELSE NULL END AS "dailyBudgetEur"
    FROM jerarquia_sets s
    JOIN jerarquia_camps c ON c.campaign_id = s.campaign_id
   WHERE ${vigencia}${filtros.status}${filtros.extra}`;
    }
    case 'ad': {
      const vigencia = vigenciaDe('a');
      return `
  SELECT a.ad_id AS "objectId", a.name AS "objectName", a.account_id AS "accountId",
         a.campaign_id AS "campaignId", a.adset_id AS "adsetId", a.ad_id AS "adId",
         a."funnelId",
         a.status, a.effective_status AS "effectiveStatus",
         NULL::text AS "budgetLevel", NULL::text AS "budgetMode", NULL::numeric AS "dailyBudgetEur"
    FROM jerarquia_ads a
   WHERE ${vigencia}${filtros.status}${filtros.extra}`;
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
  const desde = rango?.desde ?? '1970-01-01';
  const hasta = rango?.hasta ?? '1970-01-01';

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

  // Filtros sobre la jerarquía (status + campaignId/adsetId). El alias de la
  // tabla del objeto es el del nivel pedido.
  const aliasStatus = level === 'campaign' ? 'c' : level === 'adset' ? 's' : 'a';
  const statusFiltro =
    f.status === 'active'
      ? ` AND ${aliasStatus}.status = 'ACTIVE'`
      : f.status === 'paused'
        ? ` AND ${aliasStatus}.status = 'PAUSED'`
        : '';
  const extras: string[] = [];
  if (f.campaignId) {
    const phC = p(f.campaignId);
    extras.push(` AND ${level === 'campaign' ? 'c' : level === 'adset' ? 's' : 'a'}.campaign_id = ${phC}`);
  }
  if (f.adsetId && level !== 'campaign') {
    const phA = p(f.adsetId);
    extras.push(` AND ${level === 'adset' ? 's' : 'a'}.adset_id = ${phA}`);
  }
  const extra = extras.join('');

  const pNombre = p(f.nombre ?? null);
  const pAfter = p(f.after ?? null);
  const pLimit = p(lim + 1);

  const com = comun(pAccounts, pDesde, pHasta, pTz, frag);
  const jerObj = jerarquiaObjetos(level, { status: statusFiltro, extra });

  const filasSql = `WITH${com},
  gasto AS (
    SELECT s.account_id AS "accountId",
           ${frag.gastoObjectId} AS "objectId",
           ${frag.gastoPadre},
           ${frag.gastoNombre} AS "objectName",
           COALESCE(sum(s.spend_eur), 0) AS "spendEur",
           COALESCE(sum(s.impressions), 0) AS impressions,
           COALESCE(sum(s.clicks), 0) AS clicks
      FROM ad_spend s
      JOIN cuenta cu ON cu."accountId" = s.account_id
     WHERE s.day BETWEEN ${pDesde}::date AND ${pHasta}::date
       AND ${frag.gastoIdCond}
     GROUP BY ${frag.gastoGroupBy}
  ),
  jerarquia_objetos AS (${jerObj}),
  objetos AS (
    SELECT * FROM jerarquia_objetos
    UNION ALL
    SELECT g."objectId", g."objectName", g."accountId",
           g."campaignId", g."adsetId", g."adId",
           cu."funnelId",
           NULL::text AS status, NULL::text AS "effectiveStatus",
           NULL::text AS "budgetLevel", NULL::text AS "budgetMode", NULL::numeric AS "dailyBudgetEur"
      FROM gasto g
      JOIN cuenta cu ON cu."accountId" = g."accountId"
     WHERE NOT EXISTS (SELECT 1 FROM jerarquia_objetos h
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
  )
SELECT o."objectId", o."objectName", o."accountId", o."campaignId", o."adsetId", o."adId",
       o."funnelId", o.status, o."effectiveStatus", o."budgetLevel", o."budgetMode",
       o."dailyBudgetEur",
       COALESCE(g."spendEur", 0) AS "spendEur",
       COALESCE(g.impressions, 0) AS impressions,
       COALESCE(g.clicks, 0) AS clicks,
       COALESCE(v."sales", 0) AS "sales",
       COALESCE(v."revenueEur", 0) AS "revenueEur",
       COALESCE(v."refundedEur", 0) AS "refundedEur",
       COALESCE(v."commissionsEur", 0) AS "commissionsEur",
       COALESCE(v."costsEur", 0) AS "costsEur",
       u."ultimaAccionAt"
  FROM objetos o
  LEFT JOIN gasto g ON g."accountId" = o."accountId" AND g."objectId" = o."objectId"
  LEFT JOIN ventas v ON v.account_id = o."accountId" AND v."objectId" = o."objectId"
  LEFT JOIN ultima_accion u ON u.object_id = o."objectId"
 WHERE (${pNombre}::text IS NULL OR o."objectName" ILIKE '%' || ${pNombre} || '%')
   AND (${pAfter}::text IS NULL OR o."objectId" > ${pAfter})
 ORDER BY o."objectId"
 LIMIT ${pLimit}`;

  // ── 4. Ventas sin atribuir (D-A8), para el nivel pedido. ──
  const sinSql = `WITH${com}
SELECT count(*) FILTER (WHERE status = 'approved')::int AS "sales",
       COALESCE(sum(amount_eur) FILTER (WHERE status = 'approved'), 0) AS "revenueEur"
  FROM atribuidas
 WHERE COALESCE(${frag.ventasObjectId}, '') = ''`;

  const sinParams: unknown[] = [accountIds, desde, hasta, tz];

  const [filasRaw, sinRow] = await Promise.all([
    q<RowMetricas>(filasSql, params),
    q1<{ sales: number; revenueEur: string }>(sinSql, sinParams),
  ]);

  const hayMas = filasRaw.length > lim;
  const filas = (hayMas ? filasRaw.slice(0, lim) : filasRaw).map((r) => filaDesdeRow(level, r));

  return {
    filas,
    hayMas,
    sinAtribuir: {
      sales: sinRow?.sales ?? 0,
      revenueEur: sinRow ? Number(sinRow.revenueEur) : 0,
    },
    rango: { from: desde, to: hasta, timezone: tz },
    generatedAt,
  };
}
