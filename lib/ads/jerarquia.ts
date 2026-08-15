/**
 * Sync de la jerarquía de anuncios de Meta (T14): campañas → conjuntos → anuncios.
 *
 * Llena y mantiene `ad_campaigns`, `ad_sets` y `ads` desde la Marketing API, de
 * forma idempotente y resistente a fallas parciales. No calcula métricas, no
 * evalúa reglas y no escribe nada en Meta: sólo lee la jerarquía y la guarda.
 *
 * POR QUÉ EXISTE (D-A4)
 * `ad_spend` solo tiene filas de objetos que gastaron ese día, y no tiene ni
 * estado ni presupuesto. Un conjunto pausado ayer no aparece hoy, así que sin
 * estas tablas no se puede listar ni reactivar. La jerarquía es el inventario;
 * `ad_spend` es el consumo.
 *
 * EL MODELO ES lib/ads/sync.ts
 * De ahí salen el manejo de errores por cuenta (una cuenta que falla no detiene
 * a las otras), el upsert idempotente por UNNEST y la forma del resultado.
 *
 * EL ORDEN IMPORTA: campañas → conjuntos → anuncios. Las FK van en esa
 * dirección, e insertar un conjunto antes que su campaña viola la FK y aborta
 * la transacción entera. Los tres niveles de una cuenta van en UNA transacción.
 *
 * NO SE BORRA NADA (P-A04). Un objeto que Meta dejó de devolver simplemente no
 * se refresca y su `synced_at` queda atrás. Borrarlo perdería el nombre, que es
 * lo que hace legible el historial de `ad_actions` semanas después.
 */

import { q, tx } from '../db';
import { fetchAds, fetchAdSets, fetchCampaigns, fetchCuenta, fetchDsaConjuntos, MetaAdsError } from './meta';
import { cuentasActivas, type CuentaSync } from './sync';
import type { DsaConjunto, MetaAd, MetaAdSet, MetaCampaign } from './tipos';

export type ResultadoNivel = { traidos: number; guardados: number; huerfanos: number };

export type ResultadoCuenta = {
  accountId: string;
  name: string | null;
  campanias: ResultadoNivel;
  conjuntos: ResultadoNivel;
  anuncios: ResultadoNivel;
  /** Cuántos objetos quedaron sin refrescar en esta corrida (§5). */
  desaparecidos: number;
  /**
   * La moneda de la cuenta si NO es EUR, y por eso se salteó (D-A10, §4).
   * No es un error: es una cuenta fuera de alcance, y tiene que verse escrita.
   */
  monedaNoSoportada: string | null;
  /** Objetos con presupuesto TOTAL, que se listan pero no se automatizan (§4). */
  conPresupuestoLifetime: number;
  error: string | null;
};

export type ResultadoJerarquia = { cuentas: ResultadoCuenta[]; corridaAt: string };

/**
 * Regla de vigencia, idéntica para T15 y T17 (§5). Un objeto está vigente si se
 * refrescó en la última corrida exitosa de SU cuenta. El margen de 10 minutos
 * absorbe que los tres niveles se escriben en momentos ligeramente distintos.
 * La referencia es siempre el max(synced_at) de las CAMPAÑAS de la cuenta (el
 * primer nivel en escribirse), no de la tabla propia.
 *
 * `<tabla>` es el alias de la tabla que se está filtrando y hay que reemplazarlo
 * al pegar la cláusula (ej: `SQL_VIGENTE.replace('<tabla>', 'c')`). Es una
 * constante de string a propósito: no hay forma de que dos tasks la escriban
 * distinto por accidente.
 */
export const SQL_VIGENTE = `synced_at >= (
  SELECT max(c2.synced_at) - interval '10 minutes'
    FROM ad_campaigns c2 WHERE c2.account_id = <tabla>.account_id
)`;

/**
 * Dónde vive el presupuesto de una campaña. Meta no tiene un campo que lo diga:
 * se infiere. Cero es un valor, no la ausencia de uno (D-A5).
 */
export function inferirBudgetLevel(
  dailyBudget: number | null,
  lifetimeBudget: number | null,
): 'campaign' | 'adset' {
  return dailyBudget !== null || lifetimeBudget !== null ? 'campaign' : 'adset';
}

/**
 * Descarta los objetos cuyo padre no está en `idsPadre` y los cuenta. Se usa
 * para los conjuntos sin campaña y los anuncios sin conjunto (§5): un objeto
 * que apunta a un padre que no trajo esta corrida NI está en la base violaría
 * la FK y abortaría la transacción, así que se descarta en lugar de insertarlo.
 */
export function filtrarHuerfanos<T>(
  objetos: T[],
  idsPadre: ReadonlySet<string>,
  padreDe: (o: T) => string,
): { validos: T[]; huerfanos: number } {
  const validos: T[] = [];
  let huerfanos = 0;
  for (const o of objetos) {
    if (idsPadre.has(padreDe(o))) validos.push(o);
    else huerfanos += 1;
  }
  return { validos, huerfanos };
}

/**
 * Meta usa "0" como centinela de "sin presupuesto" en la edge de conjuntos: un
 * conjunto con presupuesto diario devuelve `lifetime_budget: "0"` al lado. Un
 * presupuesto de 0 unidades mínimas no existe (el piso es €0,87 = 87, P-A11),
 * así que 0 se normaliza a null al guardar, para no confundir a T15 (que deriva
 * budgetMode de estas columnas) ni el conteo de presupuestos TOTAL.
 *
 * Se aplica a los valores QUE SE GUARDAN. La inferencia de budget_level usa los
 * valores crudos, donde 0 sí cuenta como "tiene presupuesto" (es un valor, no
 * la ausencia de uno).
 */
export function normalizarPresupuestos(
  dailyBudget: number | null,
  lifetimeBudget: number | null,
): { dailyBudget: number | null; lifetimeBudget: number | null } {
  return {
    dailyBudget: dailyBudget === 0 ? null : dailyBudget,
    lifetimeBudget: lifetimeBudget === 0 ? null : lifetimeBudget,
  };
}

/**
 * Un conjunto de una campaña CBO no tiene presupuesto propio, aunque Meta
 * devuelva un valor heredado: el presupuesto vive en la campaña y escribir en
 * el conjunto falla. Si se guarda el heredado, el gestor muestra un presupuesto
 * editable donde no se puede editar (§4 punto 2).
 */
export function anularPresupuestoEnCBO(
  conjuntos: MetaAdSet[],
  campaniasCBO: ReadonlySet<string>,
): MetaAdSet[] {
  return conjuntos.map((s) =>
    campaniasCBO.has(s.campaignId) ? { ...s, dailyBudget: null, lifetimeBudget: null } : s,
  );
}

type CampaniaNivel = MetaCampaign & { budgetLevel: 'campaign' | 'adset' };

/**
 * Trae la jerarquía completa de las cuentas activas y la guarda.
 * Idempotente: dos corridas seguidas dejan la base igual (upsert por PK).
 */
export async function sincronizarJerarquia(opts?: {
  cuentas?: string[]; // ausente = todas las activas de ad_accounts
  dryRun?: boolean;
}): Promise<ResultadoJerarquia> {
  const dryRun = opts?.dryRun ?? false;
  const activas = await cuentasActivas();
  const seleccion = opts?.cuentas?.length ? new Set(opts.cuentas) : null;
  const cuentas = seleccion ? activas.filter((c) => seleccion.has(c.accountId)) : activas;

  const out: ResultadoJerarquia = { cuentas: [], corridaAt: new Date().toISOString() };

  for (const cuenta of cuentas) {
    const r: ResultadoCuenta = {
      accountId: cuenta.accountId,
      name: cuenta.name,
      campanias: { traidos: 0, guardados: 0, huerfanos: 0 },
      conjuntos: { traidos: 0, guardados: 0, huerfanos: 0 },
      anuncios: { traidos: 0, guardados: 0, huerfanos: 0 },
      desaparecidos: 0,
      monedaNoSoportada: null,
      conPresupuestoLifetime: 0,
      error: null,
    };
    out.cuentas.push(r);
    try {
      await sincronizarCuenta(cuenta, dryRun, r);
    } catch (e) {
      r.error =
        e instanceof MetaAdsError
          ? `${e.message} (code ${e.code ?? '-'})`
          : e instanceof Error
            ? e.message
            : String(e);
    }
  }

  return out;
}

async function sincronizarCuenta(
  cuenta: CuentaSync,
  dryRun: boolean,
  r: ResultadoCuenta,
): Promise<void> {
  // D-A10: sólo cuentas en EUR. El dato de ad_accounts puede estar desactualizado
  // y no está verificado, así que además de mirarlo se consulta a Meta (fetchCuenta).
  if (cuenta.currency != null && cuenta.currency !== 'EUR') {
    r.monedaNoSoportada = cuenta.currency;
    return;
  }
  const meta = await fetchCuenta(cuenta.accountId);
  if (meta.currency !== 'EUR') {
    r.monedaNoSoportada = meta.currency ?? 'desconocida';
    return;
  }

  // Las tres lecturas salen en paralelo: son independientes entre sí. La de DSA
  // es una lectura APARTE y best-effort (P-G01): si falla, la jerarquía se
  // sincroniza igual y dsa_checked_at queda en NULL = preflight inconcluso.
  const [campanias, conjuntos, anuncios, dsa] = await Promise.all([
    fetchCampaigns(cuenta.accountId),
    fetchAdSets(cuenta.accountId),
    fetchAds(cuenta.accountId),
    fetchDsaConjuntos(cuenta.accountId).catch((): DsaConjunto[] => []),
  ]);

  // Los que ya están en base, para decidir huérfanos y desaparecidos. El mapa
  // adset→campaña sirve para no confiar en el campaign_id desnormalizado de Meta
  // a nivel anuncio (verificación 3b).
  const [campExistentes, setExistentes, adExistentes] = await Promise.all([
    q<{ campaign_id: string }>('SELECT campaign_id FROM ad_campaigns WHERE account_id = $1', [
      cuenta.accountId,
    ]),
    q<{ adset_id: string; campaign_id: string }>(
      'SELECT adset_id, campaign_id FROM ad_sets WHERE account_id = $1',
      [cuenta.accountId],
    ),
    q<{ ad_id: string }>('SELECT ad_id FROM ads WHERE account_id = $1', [cuenta.accountId]),
  ]);

  const campTraidos = new Set(campanias.map((c) => c.campaignId));
  const setTraidos = new Set(conjuntos.map((s) => s.adsetId));
  const adTraidos = new Set(anuncios.map((a) => a.adId));

  const idsCampaniaValidos = new Set<string>(campTraidos);
  for (const x of campExistentes) idsCampaniaValidos.add(x.campaign_id);
  const idsConjuntoValidos = new Set<string>(setTraidos);
  for (const x of setExistentes) idsConjuntoValidos.add(x.adset_id);

  const conjFiltrados = filtrarHuerfanos(conjuntos, idsCampaniaValidos, (s) => s.campaignId);
  const adsFiltrados = filtrarHuerfanos(anuncios, idsConjuntoValidos, (a) => a.adsetId);

  // budget_level se calcula al guardar, no se lee de Meta (§4). La inferencia
  // usa los valores crudos (0 es un valor); lo que se guarda va normalizado
  // (0 → null, el centinela de Meta).
  const campaniasNivel: CampaniaNivel[] = campanias.map((c) => {
    const nivel = inferirBudgetLevel(c.dailyBudget, c.lifetimeBudget);
    const { dailyBudget, lifetimeBudget } = normalizarPresupuestos(c.dailyBudget, c.lifetimeBudget);
    return { ...c, budgetLevel: nivel, dailyBudget, lifetimeBudget };
  });
  const campaniasCBO = new Set(
    campaniasNivel.filter((c) => c.budgetLevel === 'campaign').map((c) => c.campaignId),
  );
  const conjuntosNormalizados = conjFiltrados.validos.map((s) => ({
    ...s,
    ...normalizarPresupuestos(s.dailyBudget, s.lifetimeBudget),
  }));
  const conjuntosFinales = anularPresupuestoEnCBO(conjuntosNormalizados, campaniasCBO);

  // El campaign_id de un anuncio sale del conjunto padre, no del campo de Meta:
  // garantiza coherencia entre ads.campaign_id y ad_sets.campaign_id.
  const adsetCampaign = new Map<string, string>();
  for (const x of setExistentes) adsetCampaign.set(x.adset_id, x.campaign_id);
  for (const s of conjuntosFinales) adsetCampaign.set(s.adsetId, s.campaignId);
  const anunciosFinales = adsFiltrados.validos.map((a) => ({
    ...a,
    campaignId: adsetCampaign.get(a.adsetId) ?? a.campaignId,
  }));

  r.campanias.traidos = campanias.length;
  r.campanias.guardados = dryRun ? 0 : campaniasNivel.length;
  r.campanias.huerfanos = 0; // las campañas no tienen padre
  r.conjuntos.traidos = conjuntos.length;
  r.conjuntos.guardados = dryRun ? 0 : conjuntosFinales.length;
  r.conjuntos.huerfanos = conjFiltrados.huerfanos;
  r.anuncios.traidos = anuncios.length;
  r.anuncios.guardados = dryRun ? 0 : anunciosFinales.length;
  r.anuncios.huerfanos = adsFiltrados.huerfanos;

  r.desaparecidos =
    campExistentes.filter((x) => !campTraidos.has(x.campaign_id)).length +
    setExistentes.filter((x) => !setTraidos.has(x.adset_id)).length +
    adExistentes.filter((x) => !adTraidos.has(x.ad_id)).length;

  r.conPresupuestoLifetime =
    campaniasNivel.filter((c) => c.lifetimeBudget !== null).length +
    conjuntosFinales.filter((s) => s.lifetimeBudget !== null).length;

  if (dryRun) return;

  await escribirCuenta(
    cuenta.accountId,
    campaniasNivel,
    conjuntosFinales,
    anunciosFinales,
    dsa.length > 0 ? dsa : null,
  );
}

async function escribirCuenta(
  accountId: string,
  campanias: CampaniaNivel[],
  conjuntos: MetaAdSet[],
  anuncios: MetaAd[],
  dsa: DsaConjunto[] | null,
): Promise<void> {
  // DSA best-effort (P-G01): si la lectura trajo filas, se guardan y
  // dsa_checked_at marca la verificación; si no trajo (o falló), dsa_checked_at
  // queda NULL = inconcluso, y el preflight lo informa así.
  const dsaPorId = new Map((dsa ?? []).map((d) => [d.adsetId, d]));
  const dsaCheckedAt = dsa === null ? null : new Date();

  await tx(async (cl) => {
    if (campanias.length) {
      await cl.query(
        `INSERT INTO ad_campaigns (campaign_id, account_id, name, objective, status,
                                   effective_status, budget_level, daily_budget,
                                   lifetime_budget, currency, bid_strategy,
                                   created_time, start_time, end_time, synced_at)
         SELECT u.id, $1, u.name, u.objective, u.status, u.effective_status,
                u.budget_level, u.daily_budget, u.lifetime_budget, $2, u.bid_strategy,
                NULLIF(u.created_time, '')::timestamptz,
                NULLIF(u.start_time, '')::timestamptz, NULLIF(u.end_time, '')::timestamptz,
                now()
           FROM UNNEST($3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
                       $8::text[], $9::bigint[], $10::bigint[], $11::text[], $12::text[],
                       $13::text[], $14::text[])
                AS u(id, name, objective, status, effective_status,
                     budget_level, daily_budget, lifetime_budget, bid_strategy,
                     created_time, start_time, end_time)
         ON CONFLICT (campaign_id) DO UPDATE SET
           name = EXCLUDED.name,
           objective = EXCLUDED.objective,
           status = EXCLUDED.status,
           effective_status = EXCLUDED.effective_status,
           budget_level = EXCLUDED.budget_level,
           daily_budget = EXCLUDED.daily_budget,
           lifetime_budget = EXCLUDED.lifetime_budget,
           bid_strategy = EXCLUDED.bid_strategy,
           start_time = EXCLUDED.start_time,
           end_time = EXCLUDED.end_time,
           synced_at = now()`,
        [
          accountId,
          'EUR',
          campanias.map((c) => c.campaignId),
          campanias.map((c) => c.name),
          campanias.map((c) => c.objective),
          campanias.map((c) => c.status),
          campanias.map((c) => c.effectiveStatus),
          campanias.map((c) => c.budgetLevel),
          campanias.map((c) => c.dailyBudget),
          campanias.map((c) => c.lifetimeBudget),
          campanias.map((c) => c.bidStrategy),
          campanias.map((c) => c.createdTime),
          campanias.map((c) => c.startTime),
          campanias.map((c) => c.endTime),
        ],
      );
    }

    if (conjuntos.length) {
      await cl.query(
        `INSERT INTO ad_sets (adset_id, campaign_id, account_id, name, status,
                              effective_status, daily_budget, lifetime_budget,
                              currency, optimization_goal, billing_event,
                              bid_strategy, created_time, start_time, end_time,
                              dsa_payor, dsa_beneficiary, dsa_checked_at, synced_at)
         SELECT u.id, u.campaign_id, $1, u.name, u.status, u.effective_status,
                u.daily_budget, u.lifetime_budget, $2, u.optimization_goal,
                u.billing_event, u.bid_strategy,
                NULLIF(u.created_time, '')::timestamptz,
                NULLIF(u.start_time, '')::timestamptz, NULLIF(u.end_time, '')::timestamptz,
                u.dsa_payor, u.dsa_beneficiary, $3::timestamptz, now()
           FROM UNNEST($4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
                       $9::bigint[], $10::bigint[], $11::text[], $12::text[],
                       $13::text[], $14::text[], $15::text[], $16::text[],
                       $17::text[], $18::text[])
                AS u(id, campaign_id, name, status, effective_status,
                     daily_budget, lifetime_budget, optimization_goal,
                     billing_event, bid_strategy, created_time, start_time, end_time,
                     dsa_payor, dsa_beneficiary)
         ON CONFLICT (adset_id) DO UPDATE SET
           campaign_id = EXCLUDED.campaign_id,
           name = EXCLUDED.name,
           status = EXCLUDED.status,
           effective_status = EXCLUDED.effective_status,
           daily_budget = EXCLUDED.daily_budget,
           lifetime_budget = EXCLUDED.lifetime_budget,
           optimization_goal = EXCLUDED.optimization_goal,
           billing_event = EXCLUDED.billing_event,
           bid_strategy = EXCLUDED.bid_strategy,
           start_time = EXCLUDED.start_time,
           end_time = EXCLUDED.end_time,
           dsa_payor = EXCLUDED.dsa_payor,
           dsa_beneficiary = EXCLUDED.dsa_beneficiary,
           dsa_checked_at = EXCLUDED.dsa_checked_at,
           synced_at = now()`,
        [
          accountId,
          'EUR',
          dsaCheckedAt,
          conjuntos.map((s) => s.adsetId),
          conjuntos.map((s) => s.campaignId),
          conjuntos.map((s) => s.name),
          conjuntos.map((s) => s.status),
          conjuntos.map((s) => s.effectiveStatus),
          conjuntos.map((s) => s.dailyBudget),
          conjuntos.map((s) => s.lifetimeBudget),
          conjuntos.map((s) => s.optimizationGoal),
          conjuntos.map((s) => s.billingEvent),
          conjuntos.map((s) => s.bidStrategy),
          conjuntos.map((s) => s.createdTime),
          conjuntos.map((s) => s.startTime),
          conjuntos.map((s) => s.endTime),
          conjuntos.map((s) => dsaPorId.get(s.adsetId)?.dsaPayor ?? null),
          conjuntos.map((s) => dsaPorId.get(s.adsetId)?.dsaBeneficiary ?? null),
        ],
      );
    }

    if (anuncios.length) {
      await cl.query(
        `INSERT INTO ads (ad_id, adset_id, campaign_id, account_id, name, status,
                          effective_status, creative_id, created_time, synced_at)
         SELECT u.id, u.adset_id, u.campaign_id, $1, u.name, u.status,
                u.effective_status, u.creative_id,
                NULLIF(u.created_time, '')::timestamptz, now()
           FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                       $7::text[], $8::text[], $9::text[])
                AS u(id, adset_id, campaign_id, name, status, effective_status,
                     creative_id, created_time)
         ON CONFLICT (ad_id) DO UPDATE SET
           adset_id = EXCLUDED.adset_id,
           campaign_id = EXCLUDED.campaign_id,
           name = EXCLUDED.name,
           status = EXCLUDED.status,
           effective_status = EXCLUDED.effective_status,
           creative_id = EXCLUDED.creative_id,
           synced_at = now()`,
        [
          accountId,
          anuncios.map((a) => a.adId),
          anuncios.map((a) => a.adsetId),
          anuncios.map((a) => a.campaignId),
          anuncios.map((a) => a.name),
          anuncios.map((a) => a.status),
          anuncios.map((a) => a.effectiveStatus),
          anuncios.map((a) => a.creativeId),
          anuncios.map((a) => a.createdTime),
        ],
      );
    }
  });
}
