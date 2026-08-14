/**
 * Acceso a datos del motor de reglas (T16).
 *
 * Acá vive TODA la E/S contra Postgres del motor: leer reglas, contar acciones
 * para el cooldown y el máximo por objeto, abrir/cerrar la fila de ad_actions
 * ANTES y DESPUÉS del POST (§6c), y leer los interruptores globales y los topes
 * (D-A12, D-A9c). `motor.ts` y `explicacion.ts` no tocan la base: esta es la
 * única puerta.
 *
 * Todo el SQL usa parámetros ($1, $2…), nunca interpolación. Los `numeric` de
 * pg llegan como string y se convierten con Number() una sola vez, en el mapeo.
 */

import { q, q1 } from '../../db';
import type { Condicion, NivelAds, Regla } from '../tipos';

// ─────────────────────────────────────────────────────────────────────────────
// Reglas y condiciones
// ─────────────────────────────────────────────────────────────────────────────

type FilaRegla = {
  id: number;
  name: string;
  enabled: boolean;
  dry_run: boolean;
  account_ids: string[];
  level: string;
  status_filter: string;
  name_filter: string | null;
  name_filter_mode: string;
  action: string;
  action_value: string | null;
  action_unit: string | null;
  budget_max: string | null;
  budget_min: string | null;
  period: string;
  metrics_level: string;
  every_minutes: number;
  window_start: string | null;
  window_end: string | null;
  max_runs_per_day: number | null;
  cooldown_minutes: number;
  max_actions_per_object_per_day: number;
};

const SELECT_REGLA = `
  SELECT id, name, enabled, dry_run, account_ids, level, status_filter,
         name_filter, name_filter_mode, action, action_value, action_unit,
         budget_max, budget_min, period, metrics_level, every_minutes,
         window_start, window_end, max_runs_per_day, cooldown_minutes,
         max_actions_per_object_per_day
    FROM ad_rules`;

// El tipo `time` de Postgres llega como 'HH:MM:SS'; el contrato es 'HH:MM'.
const soloHora = (v: string | null): string | null => (v === null ? null : v.slice(0, 5));

function mapearRegla(r: FilaRegla): Regla {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    dryRun: r.dry_run,
    accountIds: r.account_ids,
    level: r.level as Regla['level'],
    statusFilter: r.status_filter as Regla['statusFilter'],
    nameFilter: r.name_filter,
    nameFilterMode: r.name_filter_mode as Regla['nameFilterMode'],
    action: r.action as Regla['action'],
    actionValue: r.action_value === null ? null : Number(r.action_value),
    actionUnit: r.action_unit as Regla['actionUnit'],
    budgetMax: r.budget_max === null ? null : Number(r.budget_max),
    budgetMin: r.budget_min === null ? null : Number(r.budget_min),
    period: r.period as Regla['period'],
    metricsLevel: 'object',
    everyMinutes: r.every_minutes,
    windowStart: soloHora(r.window_start),
    windowEnd: soloHora(r.window_end),
    maxRunsPerDay: r.max_runs_per_day,
    cooldownMinutes: r.cooldown_minutes,
    maxActionsPerObjectPerDay: r.max_actions_per_object_per_day,
  };
}

/** Las reglas prendidas, con sus condiciones ya cargadas. */
export async function reglasActivas(): Promise<{ regla: Regla; condiciones: Condicion[] }[]> {
  const [filas, condiciones] = await Promise.all([
    q<FilaRegla>(`${SELECT_REGLA} WHERE enabled ORDER BY id`),
    q<{ rule_id: number; metric: string; op: string; value: string }>(
      `SELECT rule_id, metric, op, value FROM ad_rule_conditions ORDER BY rule_id, position`,
    ),
  ]);

  const condPorRegla = new Map<number, Condicion[]>();
  for (const c of condiciones) {
    const lista = condPorRegla.get(c.rule_id) ?? [];
    lista.push({ metric: c.metric as Condicion['metric'], op: c.op as Condicion['op'], value: Number(c.value) });
    condPorRegla.set(c.rule_id, lista);
  }

  return filas.map((f) => ({ regla: mapearRegla(f), condiciones: condPorRegla.get(f.id) ?? [] }));
}

export async function reglaPorId(
  id: number,
): Promise<{ regla: Regla; condiciones: Condicion[] } | null> {
  const [fila, condiciones] = await Promise.all([
    q1<FilaRegla>(`${SELECT_REGLA} WHERE id = $1`, [id]),
    q<{ metric: string; op: string; value: string }>(
      `SELECT metric, op, value FROM ad_rule_conditions WHERE rule_id = $1 ORDER BY position`,
      [id],
    ),
  ]);
  if (!fila) return null;
  return {
    regla: mapearRegla(fila),
    condiciones: condiciones.map((c) => ({
      metric: c.metric as Condicion['metric'],
      op: c.op as Condicion['op'],
      value: Number(c.value),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Historial por objeto (cooldown y máximo por objeto)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Acciones REALES de hoy por objeto. Sólo cuentan las que consumen cupo:
 * `estado IN ('confirmado','indeterminado')` y `NOT dry_run` (D-A5 nota, y el
 * índice parcial ad_actions_objeto_idx está construido con esa condición).
 *
 * "Hoy" es el día del SERVIDOR (date_trunc('day', now())), no el de la cuenta
 * de Meta: es un freno operativo, no una métrica de negocio. No lo "arregles".
 *
 * `sinCerrar` sale de la misma consulta: si hay una fila 'pendiente' o
 * 'indeterminado' para el objeto, no se decide sobre él hasta reconciliar
 * (§6b). Se pide en lote (un solo `= ANY($1)`), no de a uno.
 */
export async function historialDeHoy(
  objectIds: string[],
): Promise<Map<string, { cuenta: number; ultimaAt: Date | null; sinCerrar: boolean }>> {
  if (objectIds.length === 0) return new Map();
  const filas = await q<{
    object_id: string;
    cuenta: string;
    ultima_at: Date | null;
    sin_cerrar: boolean;
  }>(
    `SELECT object_id,
            count(*) FILTER (WHERE estado IN ('confirmado', 'indeterminado'))::int AS cuenta,
            max(created_at) AS ultima_at,
            bool_or(estado IN ('pendiente', 'indeterminado')) AS sin_cerrar
       FROM ad_actions
      WHERE NOT dry_run
        AND created_at >= date_trunc('day', now())
        AND object_id = ANY($1)
      GROUP BY object_id`,
    [objectIds],
  );
  const out = new Map<string, { cuenta: number; ultimaAt: Date | null; sinCerrar: boolean }>();
  for (const f of filas) {
    out.set(f.object_id, { cuenta: Number(f.cuenta), ultimaAt: f.ultima_at, sinCerrar: f.sin_cerrar });
  }
  return out;
}

/** Las filas que quedaron a mitad de camino. Las cierra el reconciliador (§6b). */
export async function mutacionesSinCerrar(): Promise<{
  id: number;
  objectId: string;
  level: NivelAds;
  action: string;
  beforeValue: string | null;
  afterValue: string | null;
  createdAt: Date;
}[]> {
  const filas = await q<{
    id: number;
    object_id: string;
    level: string;
    action: string;
    before_value: string | null;
    after_value: string | null;
    created_at: Date;
  }>(
    `SELECT id, object_id, level, action, before_value, after_value, created_at
       FROM ad_actions
      WHERE estado IN ('pendiente', 'indeterminado')
        AND created_at < now() - interval '1 minute'
      ORDER BY created_at`,
  );
  return filas.map((f) => ({
    id: f.id,
    objectId: f.object_id,
    level: f.level as NivelAds,
    action: f.action,
    beforeValue: f.before_value,
    afterValue: f.after_value,
    createdAt: f.created_at,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Escritura de ad_actions (§6c: abrir antes del POST, cerrar después)
// ─────────────────────────────────────────────────────────────────────────────

export type FilaAccion = {
  runId: number;
  ruleId: number;
  ruleName: string;
  accountId: string;
  level: NivelAds;
  objectId: string;
  objectName: string | null;
  action: 'pause' | 'activate' | 'budget_increase' | 'budget_decrease';
  beforeValue: string | null;
  afterValue: string | null;
  dryRun: boolean;
  ok: boolean;
  estado: 'pendiente' | 'confirmado' | 'fallido' | 'indeterminado' | 'simulado' | 'omitido';
  skippedReason?: string | null;
  explicacion: string;
  metrics: Record<string, number | null>;
  error?: string | null;
};

function insertarAccion(a: FilaAccion): Promise<number> {
  return q1<{ id: number }>(
    `INSERT INTO ad_actions
       (run_id, rule_id, rule_name, source, account_id, level, object_id, object_name,
        action, before_value, after_value, dry_run, ok, estado, skipped_reason,
        explicacion, metrics, error)
     VALUES ($1,$2,$3,'rule',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id`,
    [
      a.runId,
      a.ruleId,
      a.ruleName,
      a.accountId,
      a.level,
      a.objectId,
      a.objectName,
      a.action,
      a.beforeValue,
      a.afterValue,
      a.dryRun,
      a.ok,
      a.estado,
      a.skippedReason ?? null,
      a.explicacion,
      JSON.stringify(a.metrics),
      a.error ?? null,
    ],
  ).then((r) => (r as { id: number }).id);
}

/** Abre la fila de ad_actions ANTES del POST y devuelve su id (§6c). */
export async function abrirAccion(a: Omit<FilaAccion, 'estado'>): Promise<number> {
  return insertarAccion({ ...a, estado: 'pendiente', ok: false });
}

/** Cierra esa fila con el resultado real de Meta (§6c). */
export async function cerrarAccion(
  id: number,
  r: { estado: 'confirmado' | 'fallido' | 'indeterminado'; ok: boolean; afterValue?: string | null; error?: string | null },
): Promise<void> {
  await q(
    `UPDATE ad_actions
        SET estado = $2, ok = $3,
            after_value = COALESCE($4, after_value),
            error = $5
      WHERE id = $1`,
    [id, r.estado, r.ok, r.afterValue ?? null, r.error ?? null],
  );
}

/** Una fila de ad_actions ya resuelta (simulado u omitido), sin pasar por Meta. */
export async function registrarAccion(a: FilaAccion): Promise<void> {
  await insertarAccion(a);
}

// ─────────────────────────────────────────────────────────────────────────────
// Corridas (ad_rule_runs)
// ─────────────────────────────────────────────────────────────────────────────

/** Corridas de hoy de una regla, para max_runs_per_day. */
export async function corridasDeHoy(ruleId: number): Promise<number> {
  const r = await q1<{ n: string }>(
    `SELECT count(*)::int AS n FROM ad_rule_runs
      WHERE rule_id = $1 AND started_at >= date_trunc('day', now())`,
    [ruleId],
  );
  return r ? Number(r.n) : 0;
}

/** La última vez que corrió una regla, para la cadencia (every_minutes). */
export async function ultimaCorridaAt(ruleId: number): Promise<Date | null> {
  const r = await q1<{ at: Date | null }>(
    `SELECT max(started_at) AS at FROM ad_rule_runs WHERE rule_id = $1`,
    [ruleId],
  );
  return r?.at ?? null;
}

export async function abrirCorrida(ruleId: number, dryRun: boolean): Promise<number> {
  const r = await q1<{ id: string }>(
    `INSERT INTO ad_rule_runs (rule_id, rule_name, dry_run)
     VALUES ($1, (SELECT name FROM ad_rules WHERE id = $1), $2)
     RETURNING id`,
    [ruleId, dryRun],
  );
  return Number((r as { id: string }).id);
}

export async function cerrarCorrida(
  runId: number,
  r: {
    objetosEvaluados: number;
    objetosQueCumplen: number;
    accionesEjecutadas: number;
    accionesSimuladas: number;
    omitidas: number;
    error?: string | null;
  },
): Promise<void> {
  await q(
    `UPDATE ad_rule_runs
        SET finished_at = now(),
            objetos_evaluados = $2,
            objetos_que_cumplen = $3,
            acciones_ejecutadas = $4,
            acciones_simuladas = $5,
            omitidas = $6,
            error = $7
      WHERE id = $1`,
    [runId, r.objetosEvaluados, r.objetosQueCumplen, r.accionesEjecutadas, r.accionesSimuladas, r.omitidas, r.error ?? null],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Interruptores y topes (D-A12, D-A9c)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Los interruptores globales Y los topes, en UNA consulta. Van juntos porque se
 * leen juntos al principio de cada tick, y porque un tope que se lee tarde o se
 * cachea no es un tope. `settings.value` es jsonb: pg lo devuelve parseado
 * (boolean, number o string), así que no hay que comparar contra '"true"'.
 *
 * Si una fila no existe, el default es el lado SEGURO: `habilitado: false`,
 * `forzarSombra: true`, y los topes en 0 (que dejan al módulo sin poder subir
 * nada).
 */
export async function interruptores(): Promise<{
  habilitado: boolean;
  forzarSombra: boolean;
  maxDailyBudgetEur: number;
  maxDeltaPorTickEur: number;
}> {
  const filas = await q<{ key: string; value: unknown }>(
    `SELECT key, value FROM settings
      WHERE key IN ('ads_rules_enabled', 'ads_rules_force_dry_run',
                    'ads_max_daily_budget_eur', 'ads_max_delta_por_tick_eur')`,
  );
  const mapa = new Map<string, unknown>(filas.map((f) => [f.key, f.value]));
  const numero = (key: string): number => {
    const v = mapa.get(key);
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  return {
    habilitado: mapa.get('ads_rules_enabled') === true,
    forzarSombra: mapa.get('ads_rules_force_dry_run') !== false,
    maxDailyBudgetEur: numero('ads_max_daily_budget_eur'),
    maxDeltaPorTickEur: numero('ads_max_delta_por_tick_eur'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Zona horaria del alcance de la regla (para la ventana horaria de debeCorrer)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Las zonas horarias de las cuentas que alcanza una regla, ya resueltas desde
 * `ad_accounts` (sin llamar a Meta). `accountIds` vacío = todas las cuentas
 * activas. Devuelve las zonas DISTINTAS: si hay más de una, la regla va a
 * omitirse con 'zonas_horarias_mezcladas' cuando `getMetricasAds` tire.
 */
export async function zonasDeCuentas(accountIds: string[]): Promise<string[]> {
  const filas = await q<{ timezone: string }>(
    `SELECT DISTINCT timezone
       FROM ad_accounts
      WHERE active AND platform = 'meta'
        AND ($1::text[] = '{}'::text[] OR account_id = ANY($1))
        AND timezone IS NOT NULL`,
    [accountIds],
  );
  return filas.map((f) => f.timezone);
}

// ─────────────────────────────────────────────────────────────────────────────
// Refresco de la jerarquía después de escribir (§6 regla 4b)
// ─────────────────────────────────────────────────────────────────────────────

const TABLA_NIVEL: Record<NivelAds, { tabla: string; pk: string; tienePresupuesto: boolean }> = {
  campaign: { tabla: 'ad_campaigns', pk: 'campaign_id', tienePresupuesto: true },
  adset: { tabla: 'ad_sets', pk: 'adset_id', tienePresupuesto: true },
  ad: { tabla: 'ads', pk: 'ad_id', tienePresupuesto: false },
};

/**
 * Refresca la fila de la jerarquía con lo que Meta devolvió (source of truth).
 * Se escribe lo que Meta dice, no lo que se pidió: si Meta redondeó o ajustó al
 * mínimo de la cuenta, el valor real es el suyo. Los anuncios no tienen
 * presupuesto (D-A5), así que en ese nivel sólo se refresca el estado.
 */
export async function actualizarJerarquia(
  level: NivelAds,
  objectId: string,
  campos: { status: string | null; effectiveStatus: string | null; dailyBudget: number | null; lifetimeBudget: number | null },
): Promise<void> {
  const t = TABLA_NIVEL[level];
  if (t.tienePresupuesto) {
    await q(
      `UPDATE ${t.tabla}
          SET status = $2, effective_status = $3,
              daily_budget = $4, lifetime_budget = $5,
              synced_at = now()
        WHERE ${t.pk} = $1`,
      [objectId, campos.status, campos.effectiveStatus, campos.dailyBudget, campos.lifetimeBudget],
    );
  } else {
    await q(
      `UPDATE ${t.tabla}
          SET status = $2, effective_status = $3, synced_at = now()
        WHERE ${t.pk} = $1`,
      [objectId, campos.status, campos.effectiveStatus],
    );
  }
}

/**
 * Si `fetchObjeto` falló, no sabemos el valor real: se deja la fila de
 * ad_actions en 'confirmado' (el cambio se aplicó) pero se marca la jerarquía
 * como vieja bajándole el synced_at, así el sync de T14 la refresca y la regla
 * no decide contra un número que no se sabe si es correcto.
 */
export async function marcarJerarquiaVieja(level: NivelAds, objectId: string): Promise<void> {
  const t = TABLA_NIVEL[level];
  await q(
    `UPDATE ${t.tabla} SET synced_at = now() - interval '1 day' WHERE ${t.pk} = $1`,
    [objectId],
  );
}

/** Marca el fin de la corrida de una regla y su error (token vencido, etc.). */
export async function actualizarRegla(ruleId: number, error: string | null): Promise<void> {
  await q(`UPDATE ad_rules SET last_run_at = now(), last_run_error = $2 WHERE id = $1`, [
    ruleId,
    error,
  ]);
}
