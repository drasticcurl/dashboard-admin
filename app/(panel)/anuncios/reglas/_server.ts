/**
 * Acceso a datos de la pantalla de reglas (T19): lecturas server-only.
 *
 * Importado por `app/(panel)/anuncios/reglas/page.tsx` (server), por
 * `app/api/ads/reglas/route.ts` y por `app/api/ads/interruptores/route.ts`.
 * Nunca por un client component (lleva `pg`). Los tipos que comparte con el
 * client viven en `_tipos.ts`, que es types-only.
 *
 * Todo el SQL usa parámetros ($1, $2…). Los `numeric` de pg llegan como string
 * y se convierten con Number() una sola vez, en el mapeo.
 */

import { q } from '@/lib/db';
import type { Condicion, Regla } from '@/lib/ads/tipos';
import type { CuentaAds, EstadoInterruptores, ReglaFila } from './_tipos';

// ─────────────────────────────────────────────────────────────────────────────
// Reglas (todas, no sólo las prendidas: la lista muestra también las apagadas)
// ─────────────────────────────────────────────────────────────────────────────

type FilaReglaRaw = {
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
  created_at: Date;
  updated_at: Date;
  last_run_at: Date | null;
  last_run_error: string | null;
};

const soloHora = (v: string | null): string | null => (v === null ? null : v.slice(0, 5));
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export async function listarReglas(): Promise<ReglaFila[]> {
  const [filas, condiciones] = await Promise.all([
    q<FilaReglaRaw>(
      `SELECT id, name, enabled, dry_run, account_ids, level, status_filter,
              name_filter, name_filter_mode, action, action_value, action_unit,
              budget_max, budget_min, period, metrics_level, every_minutes,
              window_start, window_end, max_runs_per_day, cooldown_minutes,
              max_actions_per_object_per_day, created_at, updated_at,
              last_run_at, last_run_error
         FROM ad_rules
        ORDER BY id`,
    ),
    q<{ rule_id: number; metric: string; op: string; value: string }>(
      `SELECT rule_id, metric, op, value FROM ad_rule_conditions ORDER BY rule_id, position`,
    ),
  ]);

  const porRegla = new Map<number, Condicion[]>();
  for (const c of condiciones) {
    const lista = porRegla.get(c.rule_id) ?? [];
    lista.push({
      metric: c.metric as Condicion['metric'],
      op: c.op as Condicion['op'],
      value: Number(c.value),
    });
    porRegla.set(c.rule_id, lista);
  }

  return filas.map((f) => ({
    id: f.id,
    name: f.name,
    enabled: f.enabled,
    dryRun: f.dry_run,
    accountIds: f.account_ids,
    level: f.level as Regla['level'],
    statusFilter: f.status_filter as Regla['statusFilter'],
    nameFilter: f.name_filter,
    nameFilterMode: f.name_filter_mode as Regla['nameFilterMode'],
    action: f.action as Regla['action'],
    actionValue: f.action_value === null ? null : Number(f.action_value),
    actionUnit: f.action_unit as Regla['actionUnit'],
    budgetMax: f.budget_max === null ? null : Number(f.budget_max),
    budgetMin: f.budget_min === null ? null : Number(f.budget_min),
    period: f.period as Regla['period'],
    metricsLevel: 'object',
    everyMinutes: f.every_minutes,
    windowStart: soloHora(f.window_start),
    windowEnd: soloHora(f.window_end),
    maxRunsPerDay: f.max_runs_per_day,
    cooldownMinutes: f.cooldown_minutes,
    maxActionsPerObjectPerDay: f.max_actions_per_object_per_day,
    condiciones: porRegla.get(f.id) ?? [],
    lastRunAt: iso(f.last_run_at),
    lastRunError: f.last_run_error,
    createdAt: f.created_at.toISOString(),
    updatedAt: f.updated_at.toISOString(),
  }));
}

export async function listarCuentas(): Promise<CuentaAds[]> {
  return q<CuentaAds>(
    `SELECT account_id AS "accountId", name
       FROM ad_accounts
      WHERE active AND platform = 'meta'
      ORDER BY account_id`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Interruptores y estado del worker (§5b.5): sólo las claves que se muestran
// ─────────────────────────────────────────────────────────────────────────────

// Nunca agregar a esta lista la fila del bot token de Telegram (§5b.6): este
// endpoint se responde al navegador y el token es un secreto.
const CLAVES_INTERRUPTORES = [
  'ads_rules_enabled',
  'ads_rules_force_dry_run',
  'ads_insights_ttl_seconds',
  'ads_max_daily_budget_eur',
  'ads_max_delta_por_tick_eur',
  'ads_backoff_until',
  'ads_backoff_reason',
  'ads_backoff_failures',
  'ads_worker_last_tick',
] as const;

/**
 * Los interruptores globales, el TTL, los topes y el estado del worker, leídos
 * por nombre. Si una fila no existe, el default es el lado SEGURO: habilitado
 * false, forzarSombra true.
 */
export async function leerInterruptores(): Promise<EstadoInterruptores> {
  const filas = await q<{ key: string; value: unknown }>(
    `SELECT key, value FROM settings WHERE key = ANY($1::text[])`,
    [CLAVES_INTERRUPTORES],
  );
  const m = new Map(filas.map((f) => [f.key, f.value]));

  const bool = (k: string, def: boolean): boolean => {
    const v = m.get(k);
    return typeof v === 'boolean' ? v : def;
  };
  const num = (k: string, def: number): number => {
    const v = m.get(k);
    return typeof v === 'number' && Number.isFinite(v) ? v : def;
  };
  const texto = (k: string): string | null => {
    const v = m.get(k);
    return typeof v === 'string' && v.length > 0 ? v : null;
  };

  return {
    habilitado: bool('ads_rules_enabled', false),
    forzarSombra: bool('ads_rules_force_dry_run', true),
    ttlSegundos: num('ads_insights_ttl_seconds', 55),
    maxDailyBudgetEur: num('ads_max_daily_budget_eur', 200),
    maxDeltaPorTickEur: num('ads_max_delta_por_tick_eur', 300),
    backoffUntil: texto('ads_backoff_until'),
    backoffReason: texto('ads_backoff_reason'),
    backoffFailures: num('ads_backoff_failures', 0),
    workerLastTick: texto('ads_worker_last_tick'),
  };
}
