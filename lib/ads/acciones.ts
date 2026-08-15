/**
 * Preflight y auditoría del Endpoint_Acciones (task 18.1 de
 * gestion-campanas-anuncios). La confirmación de la interfaz NO es un control
 * de seguridad: todo lo que la Previsualizacion mostró se revalida acá, del
 * lado del servidor, con los datos reales de la base (R14 c10).
 *
 * - `preflight`: rechaza el lote completo SIN una sola escritura ni una sola
 *   llamada de escritura a Meta cuando algo no pasa (R17 c4, c5, c7, c11, c12,
 *   R13 c2..c7, c11, R10 c17, c18, R11 c5). Revalida con
 *   `calcularPrevisualizacion` — el MISMO módulo que usó el cliente — así
 *   revalidar no puede contradecir lo que el usuario confirmó (R14 c10).
 * - `abrirAccion`/`cerrarAccion`: la fila de `ad_actions` se abre en `pendiente`
 *   ANTES de la llamada a Meta y se cierra con el estado resultante (R15 c3).
 *   La `explicacion` la arma el servidor y NO acepta texto del cliente
 *   (R15 c5); `actor_hint` lleva el rastro técnico con tope de 200 caracteres.
 * - `activarBackoffCuota`/`segundosBackoffRestante`: el backoff por app de
 *   `ads_backoff_*`, con la MISMA forma de cuatro filas y el mismo escalón
 *   min(15 × 2^failures, 60) que usa el worker (R17 c17).
 *
 * Los interruptores globales del motor (`ads_rules_enabled`,
 * `ads_rules_force_dry_run`) NO se consultan (R17 c6): siguen siendo del motor.
 */

import { q, q1 } from '../db';
import { fetchMinimoPresupuesto } from './meta';
import { TZ_DEFAULT } from './zona';
import type { AccionAds, MetricasObjeto, NivelAds } from './tipos';
import { calcularPrevisualizacion, type ParametrosAccion, type Previsualizacion } from './previsualizacion';
import type { ModoRenombre } from './nombres';

export type ObjetoPreflight = {
  objectId: string;
  objectName: string | null;
  accountId: string;
  status: string | null;
  effectiveStatus: string | null;
  campaignId: string;
  budgetLevel: 'campaign' | 'adset' | null;
  budgetMode: 'daily' | 'lifetime' | null;
  /** Unidades mínimas, como la base. */
  dailyBudget: number | null;
  currency: string | null;
  inicioProgramado: string | null;
};

export type MotivoRechazo =
  | 'objetos_invalidos'
  | 'tope_absoluto'
  | 'tope_lote'
  | 'presupuesto_lifetime_no_soportado'
  | 'moneda_no_soportada'
  | 'sin_presupuesto_en_este_nivel'
  | 'presupuesto_bajo_el_minimo'
  | 'muchas_copias'
  | 'backoff_activo'
  | 'fecha_invalida'
  | 'previsualizacion_incompleta';

export type ErrorPreflight = { motivo: MotivoRechazo; detalle: string };

export type ResultadoPreflight =
  | {
      ok: true;
      objetos: ObjetoPreflight[];
      /** La revalidación con el mismo módulo del cliente (R14 c10). */
      previa: Previsualizacion;
      topes: { techoEur: number; topeLoteEur: number };
      minimoDiarioEur: number | null;
      zona: string;
    }
  | { ok: false; error: ErrorPreflight };

const TABLA_NIVEL: Record<NivelAds, { tabla: string; pk: string }> = {
  campaign: { tabla: 'ad_campaigns', pk: 'campaign_id' },
  adset: { tabla: 'ad_sets', pk: 'adset_id' },
  ad: { tabla: 'ads', pk: 'ad_id' },
};

export const ETIQUETA_NIVEL: Record<NivelAds, string> = {
  campaign: 'campaña',
  adset: 'conjunto',
  ad: 'anuncio',
};

const dosDecimales = new Intl.NumberFormat('es-AR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const eur = (n: number): string => `€${dosDecimales.format(n)}`;

// ─── Topes de settings (la ÚNICA fuente, R17 c7) ─────────────────────────────

export async function topesDeSettings(): Promise<{ techoEur: number; topeLoteEur: number }> {
  const r = await q1<{ max: unknown; delta: unknown }>(
    `SELECT (SELECT value FROM settings WHERE key = 'ads_max_daily_budget_eur') AS "max",
            (SELECT value FROM settings WHERE key = 'ads_max_delta_por_tick_eur') AS "delta"`,
  );
  return {
    techoEur: typeof r?.max === 'number' ? (r.max as number) : 200,
    topeLoteEur: typeof r?.delta === 'number' ? (r.delta as number) : 300,
  };
}

// ─── Backoff por app (ads_backoff_*), misma forma que el worker ─────────────

async function leerBackoff(): Promise<{ until: Date | null; failures: number }> {
  const filas = await q<{ key: string; value: unknown }>(
    `SELECT key, value FROM settings WHERE key IN ('ads_backoff_until', 'ads_backoff_failures')`,
  );
  const m = new Map(filas.map((f) => [f.key, f.value]));
  const hasta = m.get('ads_backoff_until');
  const hastaStr = typeof hasta === 'string' && hasta.length > 0 ? hasta : null;
  return {
    until: hastaStr ? new Date(hastaStr) : null,
    failures: Number(m.get('ads_backoff_failures')) || 0,
  };
}

async function setValor(key: string, value: unknown): Promise<void> {
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

/** Segundos enteros que faltan para que expire el backoff por app. null = no hay. */
export async function segundosBackoffRestante(): Promise<number | null> {
  const b = await leerBackoff();
  if (!b.until || b.until.getTime() <= Date.now()) return null;
  return Math.ceil((b.until.getTime() - Date.now()) / 1000);
}

/**
 * Activa el backoff por app tras un error de cuota, con el mismo escalón del
 * worker: min(15 × 2^failures, 60) minutos. Devuelve los segundos enteros
 * restantes (R17 c17).
 */
export async function activarBackoffCuota(): Promise<number> {
  const b = await leerBackoff();
  const minutos = Math.min(15 * 2 ** b.failures, 60);
  const until = new Date(Date.now() + minutos * 60_000);
  await setValor('ads_backoff_until', until.toISOString());
  await setValor('ads_backoff_reason', `Meta respondió un error de cuota (17/613) durante una acción manual. Pausado ${minutos} min (reincidencia ${b.failures + 1}).`);
  await setValor('ads_backoff_failures', b.failures + 1);
  await setValor('ads_backoff_clean_ticks', 0);
  return minutos * 60;
}

// ─── Lectura de objetos ──────────────────────────────────────────────────────

async function leerObjetos(
  level: NivelAds,
  accountId: string,
  objectIds: string[],
): Promise<(ObjetoPreflight | null)[]> {
  const t = TABLA_NIVEL[level];
  const budgetLevelSql =
    level === 'campaign'
      ? 'o.budget_level'
      : level === 'adset'
        ? '(SELECT c.budget_level FROM ad_campaigns c WHERE c.campaign_id = o.campaign_id)'
        : 'NULL::text';
  const inicioSql =
    level === 'campaign'
      ? 'o.start_time'
      : level === 'adset'
        ? 'o.start_time'
        : 'NULL::timestamptz';
  const campaignSql =
    level === 'campaign' ? 'o.campaign_id' : level === 'adset' ? 'o.campaign_id' : 'o.campaign_id';

  const rows = await q<{
    objectId: string;
    name: string | null;
    status: string | null;
    effectiveStatus: string | null;
    campaignId: string;
    budgetLevel: string | null;
    dailyBudget: string | null;
    lifetimeBudget: string | null;
    currency: string | null;
    inicioProgramado: Date | string | null;
  }>(
    `SELECT o.${t.pk} AS "objectId", o.name, o.status, o.effective_status AS "effectiveStatus",
            ${campaignSql} AS "campaignId",
            ${budgetLevelSql} AS "budgetLevel",
            o.daily_budget AS "dailyBudget", o.lifetime_budget AS "lifetimeBudget",
            a.currency, ${inicioSql} AS "inicioProgramado"
       FROM ${t.tabla} o
       JOIN ad_accounts a ON a.account_id = o.account_id AND a.active AND a.platform = 'meta'
      WHERE o.account_id = $1 AND o.${t.pk} = ANY($2::text[])`,
    [accountId, objectIds],
  );
  const porId = new Map(rows.map((r) => [r.objectId, r]));
  return objectIds.map((id) => {
    const r = porId.get(id);
    if (!r) return null; // id desconocido: el preflight lo rechaza en bloque
    return {
      objectId: r.objectId,
      objectName: r.name,
      accountId,
      status: r.status,
      effectiveStatus: r.effectiveStatus,
      campaignId: r.campaignId,
      budgetLevel: (r.budgetLevel === 'campaign' || r.budgetLevel === 'adset' ? r.budgetLevel : null) as 'campaign' | 'adset' | null,
      budgetMode:
        r.dailyBudget !== null
          ? 'daily'
          : r.lifetimeBudget !== null
            ? 'lifetime'
            : null,
      dailyBudget: r.dailyBudget === null ? null : Number(r.dailyBudget),
      currency: r.currency,
      inicioProgramado:
        r.inicioProgramado === null
          ? null
          : r.inicioProgramado instanceof Date
            ? r.inicioProgramado.toISOString()
            : new Date(r.inicioProgramado).toISOString(),
    };
  });
}

/** La fila de la jerarquía como MetricasObjeto (lo mínimo que la
 *  Previsualizacion lee), para revalidar con el MISMO módulo del cliente. */
function aMetricas(o: ObjetoPreflight, level: NivelAds): MetricasObjeto {
  return {
    level,
    objectId: o.objectId,
    objectName: o.objectName,
    accountId: o.accountId,
    campaignId: o.campaignId,
    adsetId: level === 'campaign' ? '' : level === 'adset' ? o.objectId : '',
    adId: level === 'ad' ? o.objectId : '',
    funnelId: null,
    status: o.status,
    effectiveStatus: o.effectiveStatus,
    budgetLevel: o.budgetLevel,
    budgetMode: o.budgetMode,
    dailyBudgetEur: o.dailyBudget === null ? null : o.dailyBudget / 100,
    spendEur: 0,
    impressions: 0,
    clicks: 0,
    sales: 0,
    revenueEur: 0,
    refundedEur: 0,
    commissionsEur: 0,
    costsEur: 0,
    netEur: 0,
    profitEur: 0,
    roas: null,
    roi: null,
    cpaEur: null,
    ctr: null,
    cpcEur: null,
    ultimaAccionAt: null,
    cpmEur: null,
    hookRate: null,
    videoReproducciones: null,
    videoThruplay: null,
    videoP25: null,
    videoP50: null,
    videoP75: null,
    videoP100: null,
    alcance: null,
    frecuencia: null,
    inicioProgramado: o.inicioProgramado,
  };
}

/** El desglose de descendientes por objeto origen, desde la base (R14 c5):
 *  una lectura de la jerarquía local, no de Meta. */
async function desgloseDesdeBase(
  level: NivelAds,
  objectIds: string[],
): Promise<Map<string, { conjuntos: number; anuncios: number }>> {
  const out = new Map<string, { conjuntos: number; anuncios: number }>();
  if (level === 'campaign') {
    const sets = await q<{ campaign_id: string; n: number }>(
      `SELECT campaign_id, count(*)::int AS n FROM ad_sets WHERE campaign_id = ANY($1::text[]) GROUP BY campaign_id`,
      [objectIds],
    );
    const ads = await q<{ campaign_id: string; n: number }>(
      `SELECT campaign_id, count(*)::int AS n FROM ads WHERE campaign_id = ANY($1::text[]) GROUP BY campaign_id`,
      [objectIds],
    );
    const adsPorCamp = new Map(ads.map((r) => [r.campaign_id, r.n]));
    for (const s of sets) {
      out.set(s.campaign_id, { conjuntos: s.n, anuncios: adsPorCamp.get(s.campaign_id) ?? 0 });
    }
    for (const id of objectIds) if (!out.has(id)) out.set(id, { conjuntos: 0, anuncios: 0 });
  } else if (level === 'adset') {
    const ads = await q<{ adset_id: string; n: number }>(
      `SELECT adset_id, count(*)::int AS n FROM ads WHERE adset_id = ANY($1::text[]) GROUP BY adset_id`,
      [objectIds],
    );
    const porSet = new Map(ads.map((r) => [r.adset_id, r.n]));
    for (const id of objectIds) out.set(id, { conjuntos: 0, anuncios: porSet.get(id) ?? 0 });
  }
  return out;
}

// ─── El preflight ────────────────────────────────────────────────────────────

export async function preflight(d: {
  level: NivelAds;
  accountId: string;
  accion: AccionAds;
  objectIds: string[];
  budgetEur?: number;
  copias?: number;
  inicio?: string;
  modo?: ModoRenombre;
  ahora?: Date;
}): Promise<ResultadoPreflight> {
  const ahora = d.ahora ?? new Date();

  // 1. Objetos reales, de ESTA cuenta, de una cuenta activa (R17 c4). Un id de
  //    otra cuenta o inventado no aparece en el JOIN y se rechaza el lote.
  const objetosLeidos = await leerObjetos(d.level, d.accountId, d.objectIds);
  const faltantes = d.objectIds.filter((id, i) => !objetosLeidos[i] || objetosLeidos[i]!.objectId !== id);
  if (faltantes.length > 0) {
    return {
      ok: false,
      error: {
        motivo: 'objetos_invalidos',
        detalle: `objetos que no existen, no pertenecen a la cuenta ${d.accountId} o están en una cuenta inactiva: ${faltantes.slice(0, 10).join(', ')}`,
      },
    };
  }
  const objetos = objetosLeidos as ObjetoPreflight[];

  // 2. Una sola cuenta → una sola Zona_Cuenta (R17 c12).
  const zonaRow = await q1<{ tz: string }>(
    `SELECT COALESCE(timezone, $2) AS tz FROM ad_accounts WHERE account_id = $1`,
    [d.accountId, TZ_DEFAULT],
  );
  const zona = zonaRow?.tz ?? TZ_DEFAULT;

  // 3. Techo_Absoluto y Tope_Lote, SOLO de settings (R17 c5, c7).
  const topes = await topesDeSettings();

  // 4. Backoff por cuota activo → rechazo de las duplicaciones en lote ANTES
  //    de cualquier llamada (R17 c11).
  if (d.accion === 'duplicate') {
    const segundos = await segundosBackoffRestante();
    if (segundos !== null) {
      return {
        ok: false,
        error: {
          motivo: 'backoff_activo',
          detalle: `hay un backoff por cuota activo: quedan ${segundos} segundos antes de poder duplicar`,
        },
      };
    }
    // 5. Topes de la corrida (R17 c15): 20 orígenes, 100 Copias.
    if (d.objectIds.length > 20) {
      return {
        ok: false,
        error: {
          motivo: 'muchas_copias',
          detalle: 'se aceptan hasta 20 objetos origen por corrida de duplicación',
        },
      };
    }
    const k = d.copias ?? 1;
    if (!Number.isInteger(k) || k < 1 || k > 5 || d.objectIds.length * k > 100) {
      return {
        ok: false,
        error: {
          motivo: 'muchas_copias',
          detalle: 'se aceptan de 1 a 5 copias por objeto y hasta 100 copias por corrida',
        },
      };
    }
    // 6. Fecha de inicio (R10 c18): posterior al pedido en Zona_Cuenta y no más
    //    de 6 meses.
    if (d.inicio !== undefined) {
      const instante = new Date(d.inicio);
      const tope = ahora.getTime() + 180 * 24 * 3600 * 1000;
      if (Number.isNaN(instante.getTime()) || instante.getTime() <= ahora.getTime() || instante.getTime() > tope) {
        return {
          ok: false,
          error: {
            motivo: 'fecha_invalida',
            detalle: 'el inicio tiene que ser posterior al momento actual y no más de 6 meses después, interpretado en la zona de la cuenta',
          },
        };
      }
    }
  }

  // 7. Programación (R11 c2, c5): entre el instante actual y 365 días.
  if (d.accion === 'schedule') {
    const instante = d.inicio !== undefined ? new Date(d.inicio) : new Date(NaN);
    const tope = ahora.getTime() + 365 * 24 * 3600 * 1000;
    if (Number.isNaN(instante.getTime()) || instante.getTime() <= ahora.getTime() || instante.getTime() > tope) {
      return {
        ok: false,
        error: {
          motivo: 'fecha_invalida',
          detalle: 'el inicio tiene que ser posterior al momento actual y no más de 365 días después, interpretado en la zona de la cuenta',
        },
      };
    }
  }

  // 8. Presupuesto: todas las verificaciones ANTES de cualquier cambio
  //    (R13 c12). Aplica también al presupuesto que llega con una duplicación.
  let minimoDiarioEur: number | null = null;
  if (d.budgetEur !== undefined && (d.accion === 'budget_set' || d.accion === 'duplicate')) {
    if (d.budgetEur > topes.techoEur) {
      return {
        ok: false,
        error: {
          motivo: 'tope_absoluto',
          detalle: `${eur(d.budgetEur)} pasa el máximo de ${eur(topes.techoEur)} por objeto`,
        },
      };
    }
    let delta = 0;
    const afectados: string[] = [];
    for (const o of objetos) {
      const actual = o.dailyBudget !== null ? o.dailyBudget / 100 : 0;
      if (d.budgetEur > actual) delta += d.budgetEur - actual;
      if (o.budgetMode === 'lifetime') {
        return {
          ok: false,
          error: {
            motivo: 'presupuesto_lifetime_no_soportado',
            detalle: `objetos con presupuesto TOTAL en lugar de diario (este panel edita únicamente presupuestos diarios): ${o.objectId}`,
          },
        };
      }
      if (o.currency !== 'EUR') {
        return {
          ok: false,
          error: {
            motivo: 'moneda_no_soportada',
            detalle: `objetos cuya cuenta no factura en EUR: ${o.objectId} (${o.currency ?? '?'})`,
          },
        };
      }
      if (o.budgetLevel !== d.level) {
        return {
          ok: false,
          error: {
            motivo: 'sin_presupuesto_en_este_nivel',
            detalle: `objetos cuyo presupuesto vive en otro nivel de la jerarquía: ${o.objectId} (${o.budgetLevel ?? 'ninguno'})`,
          },
        };
      }
      afectados.push(o.objectId);
    }
    if (delta > topes.topeLoteEur) {
      return {
        ok: false,
        error: {
          motivo: 'tope_lote',
          detalle: `el lote sumaría ${eur(delta)} de presupuesto nuevo, más que el máximo de ${eur(topes.topeLoteEur)} por corrida`,
        },
      };
    }
    // Mínimo diario que informa la cuenta (R13 c7): lectura a Meta, nunca una
    // escritura. null = no se sabe, y entonces no se rechaza por eso.
    const minimoUnidades = await fetchMinimoPresupuesto(d.accountId).catch(() => null);
    minimoDiarioEur = minimoUnidades === null ? null : minimoUnidades / 100;
    if (minimoDiarioEur !== null && d.budgetEur < minimoDiarioEur) {
      return {
        ok: false,
        error: {
          motivo: 'presupuesto_bajo_el_minimo',
          detalle: `${eur(d.budgetEur)} está por debajo del mínimo diario de ${eur(minimoDiarioEur)} que informa la cuenta (${afectados.slice(0, 5).join(', ')})`,
        },
      };
    }
  }

  // 9. Revalidación con el MISMO módulo que usó el cliente (R14 c10): lo que el
  //    usuario confirmó no puede dar distinto acá.
  const filas = objetos.map((o) => aMetricas(o, d.level));
  const params: ParametrosAccion = {
    copias: d.copias,
    budgetEur: d.budgetEur,
    inicio: d.inicio,
    modo: d.modo,
    desglose: d.accion === 'duplicate' ? { porObjeto: await desgloseDesdeBase(d.level, d.objectIds) } : undefined,
  };
  const previa = calcularPrevisualizacion(d.accion, d.level, filas, d.objectIds, params, {
    techoEur: topes.techoEur,
    topeLoteEur: topes.topeLoteEur,
    minimoDiarioEur,
  });
  if (!previa.completa) {
    return {
      ok: false,
      error: {
        motivo: 'previsualizacion_incompleta',
        detalle: 'los datos del servidor no alcanzaron para revalidar la Previsualizacion del cliente',
      },
    };
  }

  return { ok: true, objetos, previa, topes, minimoDiarioEur, zona };
}

// ─── Auditoría: abrir y cerrar filas de ad_actions ───────────────────────────

/** La explicación en castellano la arma el SERVIDOR, de 1 a 300 caracteres,
 *  nombrando la acción, el nivel, el nombre del objeto y la cuenta, y SIN
 *  aceptar texto provisto por el cliente (R15 c5). */
export function armarExplicacion(d: {
  accion: AccionAds;
  nivel: NivelAds;
  objectName: string | null;
  objectId: string;
  accountId: string;
  extra?: string;
}): string {
  const nombre = d.objectName ?? d.objectId;
  let s: string;
  switch (d.accion) {
    case 'pause':
      s = `Manual: se pausó el ${ETIQUETA_NIVEL[d.nivel]} «${nombre}» (${d.accountId}).`;
      break;
    case 'activate':
      s = `Manual: se activó el ${ETIQUETA_NIVEL[d.nivel]} «${nombre}» (${d.accountId}).`;
      break;
    case 'budget_set':
      s = `Manual: se fijó el presupuesto diario del ${ETIQUETA_NIVEL[d.nivel]} «${nombre}» (${d.accountId})${d.extra ? `: ${d.extra}` : ''}.`;
      break;
    case 'duplicate':
      s = `Manual: se duplicó el ${ETIQUETA_NIVEL[d.nivel]} «${nombre}» (${d.accountId})${d.extra ? ` como ${d.extra}` : ''}, con sus descendientes, todos pausados.`;
      break;
    case 'rename':
      s = `Manual: se renombró el ${ETIQUETA_NIVEL[d.nivel]} «${nombre}» (${d.accountId})${d.extra ? ` a ${d.extra}` : ''}.`;
      break;
    case 'schedule':
      s = `Manual: se programó el inicio del ${ETIQUETA_NIVEL[d.nivel]} «${nombre}» (${d.accountId})${d.extra ? ` para ${d.extra}` : ''}.`;
      break;
    default:
      s = `Manual: acción ${d.accion} sobre el ${ETIQUETA_NIVEL[d.nivel]} «${nombre}» (${d.accountId}).`;
  }
  return s.slice(0, 300);
}

export async function abrirAccion(d: {
  accountId: string;
  nivel: NivelAds;
  objectId: string;
  objectName: string | null;
  accion: AccionAds;
  before: string | null;
  after: string | null;
  explicacion: string;
  actorHint: string;
  metrics?: Record<string, unknown>;
}): Promise<number> {
  const row = await q1<{ id: string }>(
    `INSERT INTO ad_actions
       (source, account_id, level, object_id, object_name, action, before_value, after_value,
        dry_run, ok, estado, explicacion, metrics, actor_hint)
     VALUES ('manual', $1, $2, $3, $4, $5, $6, $7, false, false, 'pendiente', $8, $9::jsonb, $10)
     RETURNING id`,
    [
      d.accountId,
      d.nivel,
      d.objectId,
      d.objectName,
      d.accion,
      d.before,
      d.after,
      d.explicacion,
      JSON.stringify(d.metrics ?? {}),
      d.actorHint.slice(0, 200),
    ],
  );
  return Number((row as { id: string }).id);
}

export async function cerrarAccion(
  id: number,
  estado: 'confirmado' | 'fallido' | 'indeterminado' | 'omitido',
  extra: { error?: string | null; metrics?: Record<string, unknown> } = {},
): Promise<void> {
  // El cierre ocurre dentro de los 5 s del fin de la llamada (R15 c3): lo
  // garantiza el llamador, que await-ea este UPDATE apenas vuelve de Meta.
  await q(
    `UPDATE ad_actions
        SET estado = $2, ok = $3, error = $4,
            metrics = CASE WHEN $5::jsonb IS NULL THEN metrics ELSE metrics || $5::jsonb END
      WHERE id = $1`,
    [id, estado, estado === 'confirmado', extra.error ?? null, JSON.stringify(extra.metrics ?? null)],
  );
}
