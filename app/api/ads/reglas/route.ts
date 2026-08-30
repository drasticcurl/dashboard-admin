/**
 * /api/ads/reglas — escritura y lectura de reglas del motor (T19).
 *
 *   GET    /api/ads/reglas            lista todas las reglas con condiciones
 *   POST   /api/ads/reglas            crear (sin id) o actualizar (con id)
 *   DELETE /api/ads/reglas?id=7       borrar (no borra su historial: FK SET NULL)
 *   POST   /api/ads/reglas?preview=1  evaluar sin ejecutar, SIEMPRE en sombra
 *
 * Reglas no negociables (task §5):
 *   - `guard(req)` en los cuatro métodos: es escritura y es la convención.
 *   - zod replica los CHECK de la base con `refine`, así el error dice QUÉ campo
 *     está mal (Postgres sólo dice el nombre de un constraint).
 *   - regla + condiciones en UNA transacción.
 *   - una regla NUEVA nace `enabled=false` y `dry_run=true`, ignorando el
 *     payload (D-A12). Prenderla es un segundo POST explícito.
 *   - `preview=1` llama a `correrRegla` con `forzarSombra: true`: nunca escribe
 *     en Meta.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { q, q1, tx } from '@/lib/db';
import { guard, json } from '@/app/api/config/_lib';
import { correrRegla } from '@/lib/ads/reglas/ejecutor';
import { motivoIncoherente } from '@/lib/ads/reglas/coherencia';
import { interruptores, reglaPorId } from '@/lib/ads/reglas/repo';
import { listarReglas } from '@/app/(panel)/anuncios/reglas/_server';
import { MONEDA_REPORTE, SIMBOLO_REPORTE } from '@/lib/moneda-reporte';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const METRICAS = [
  'sales', 'revenue', 'spend', 'net', 'profit', 'roi', 'roas', 'cpa',
  'budget', 'impressions', 'clicks', 'ctr', 'cpc',
] as const;
const OPS = ['>', '>=', '<', '<=', '=', '!='] as const;
const ACCIONES = ['pause', 'activate', 'budget_increase', 'budget_decrease'] as const;

const condicionSchema = z.object({
  metric: z.enum(METRICAS),
  op: z.enum(OPS),
  value: z.number().finite(),
});

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

// El schema replica los CHECK de `ad_rules` (los 18) en zod. `metricsLevel` sólo
// acepta 'object': 'parent' no está implementado (task §4.6) y la base lo
// rechaza, así que un payload que lo traiga corta acá con 400 y no con un 500.
const reglaSchema = z
  .object({
    id: z.number().int().positive().optional(),
    name: z.string().trim().min(1, 'El nombre es obligatorio').max(200),
    // `required_error`/`invalid_type_error` y no sólo `.min(1)`: el mensaje del
    // `.min(1)` sólo dispara si el campo ESTÁ y viene vacío. Con el campo
    // ausente zod emite su default ('Required') y el 400 no nombraba el campo
    // que falta, que es lo que pide R9 c2. Los tres mensajes son el mismo a
    // propósito: para quien manda el payload, "no vino", "vino null" y "vino
    // vacío" son el mismo problema.
    accountId: z
      .string({
        required_error: 'Falta la cuenta de anuncios',
        invalid_type_error: 'Falta la cuenta de anuncios',
      })
      .trim()
      .min(1, 'Falta la cuenta de anuncios')
      .max(64, 'Falta la cuenta de anuncios'),
    level: z.enum(['campaign', 'adset', 'ad']),
    statusFilter: z.enum(['active', 'paused', 'any']).optional().default('active'),
    nameFilter: z.string().max(200).nullable().optional(),
    nameFilterMode: z.enum(['contains', 'not_contains']).optional().default('contains'),
    action: z.enum(ACCIONES),
    actionValue: z.number().finite().nullable().optional(),
    actionUnit: z.enum(['percent', 'fixed']).nullable().optional(),
    budgetMax: z.number().finite().nullable().optional(),
    budgetMin: z.number().finite().nullable().optional(),
    period: z.enum(['today', 'yesterday', '7d', '7d_excl_today']).optional().default('today'),
    metricsLevel: z.string().optional(),
    everyMinutes: z.number().int().min(1).max(1440).optional().default(15),
    windowStart: z.string().regex(HORA, 'La hora de inicio tiene que ser HH:MM').nullable().optional(),
    windowEnd: z.string().regex(HORA, 'La hora de fin tiene que ser HH:MM').nullable().optional(),
    maxRunsPerDay: z.number().int().positive().nullable().optional(),
    cooldownMinutes: z.number().int().min(0).optional().default(60),
    // 0 = sin tope (migración 024). El default sigue en 4: sólo se abre la
    // opción, no se cambia lo que trae una regla nueva.
    maxActionsPerObjectPerDay: z.number().int().min(0).optional().default(4),
    conditions: z.array(condicionSchema).max(50).optional().default([]),
    enabled: z.boolean().optional(),
    dryRun: z.boolean().optional(),
  })
  .superRefine((d, ctx) => {
    const esPresupuesto = d.action === 'budget_increase' || d.action === 'budget_decrease';

    // §4.6: 'parent' no está implementado (la base lo rechaza con
    // ad_rules_mlevel_valido). El formulario no lo ofrece; si el payload lo
    // trae, zod lo corta con un mensaje claro.
    if (d.metricsLevel != null && d.metricsLevel !== 'object') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'El nivel de las condiciones "parent" no está implementado: sólo se acepta "object"',
        path: ['metricsLevel'],
      });
    }

    // D-A5: en Meta los anuncios no tienen presupuesto.
    if (esPresupuesto && d.level === 'ad') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'En Meta los anuncios no tienen presupuesto: una regla de presupuesto no puede ser de nivel "ad"',
        path: ['level'],
      });
    }

    if (esPresupuesto) {
      if (d.actionValue == null || d.actionValue <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Una acción de presupuesto necesita un valor positivo',
          path: ['actionValue'],
        });
      }
      if (!d.actionUnit) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Falta la unidad del valor (% o ${SIMBOLO_REPORTE})`, path: ['actionUnit'] });
      }
      if (d.action === 'budget_increase' && d.budgetMax == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Una subida de presupuesto necesita un límite máximo (techo): sin él, "+20% cada 15 min" no se detiene nunca',
          path: ['budgetMax'],
        });
      }
      if (d.action === 'budget_decrease' && d.budgetMin == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Una baja de presupuesto necesita un límite mínimo (piso)',
          path: ['budgetMin'],
        });
      }
      // D-A9 (dirección del factor): el porcentaje es un FACTOR, no un incremento.
      if (d.actionUnit === 'percent' && d.actionValue != null) {
        if (d.action === 'budget_increase' && d.actionValue <= 100) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Un factor menor a 100 BAJA el presupuesto; para subir al doble va 200% (100% no cambia nada)',
            path: ['actionValue'],
          });
        }
        if (d.action === 'budget_decrease' && d.actionValue >= 100) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Para bajar a la mitad va 50%; 250% multiplica por 2,5 y SUBE el presupuesto',
            path: ['actionValue'],
          });
        }
      }
    }

    // límites positivos (un techo en 0 no significa nada).
    if (d.budgetMax != null && d.budgetMax <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'El límite máximo tiene que ser mayor a 0', path: ['budgetMax'] });
    }
    if (d.budgetMin != null && d.budgetMin <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'El límite mínimo tiene que ser mayor a 0', path: ['budgetMin'] });
    }

    // techo sobre piso: con techo €10 y piso €25 no hay valor que satisfaga los dos.
    if (d.budgetMax != null && d.budgetMin != null && d.budgetMax < d.budgetMin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Con techo ${d.budgetMax} y piso ${d.budgetMin} no hay ningún valor que satisfaga los dos`,
        path: ['budgetMax'],
      });
    }

    // ── Coherencia: lo que se puede guardar pero no puede funcionar ─────────
    //
    // Ventana de un minuto, alcance que la acción no puede tocar y condiciones
    // que se contradicen. Las tres se ven igual desde afuera: una regla
    // prendida, sin errores, que no ejecuta nunca nada. `lib/ads/reglas/
    // coherencia` es el mismo módulo que usa el formulario, para que el mensaje
    // que ve el usuario sea el que aplica el server.
    //
    // LA EXCEPCIÓN, QUE NO ES UN DESCUIDO: si el payload apaga la regla o la
    // manda a sombra, no se valida nada de esto. Una regla incoherente ya
    // cargada tiene que poder apagarse y tiene que poder volver a simulación
    // SIEMPRE — son las dos acciones que reducen el riesgo, y bloquearlas por
    // un problema de coherencia dejaría a alguien sin forma de frenar una regla
    // desde la UI. Lo que no se puede es dejarla prendida y en real.
    const reduceRiesgo = d.enabled === false || d.dryRun === true;
    if (!reduceRiesgo) {
      const motivo = motivoIncoherente({
        action: d.action,
        statusFilter: d.statusFilter,
        windowStart: d.windowStart,
        windowEnd: d.windowEnd,
        conditions: d.conditions,
      });
      if (motivo !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: motivo, path: ['conditions'] });
      }
    }
  });

// ─────────────────────────────────────────────────────────────────────────────

/**
 * R9 c3: la cuenta tiene que ser una Cuenta_Activa. Se chequea acá y no sólo en
 * la base porque el FK diría "viola ad_rules_cuenta_fk" y no "act_x no existe o
 * está inactiva", y porque el FK acepta cuentas inactivas (existen en la tabla).
 */
async function cuentaEsActiva(accountId: string): Promise<boolean> {
  const cuenta = await q1<{ ok: boolean }>(
    `SELECT (active AND platform = 'meta') AS ok
       FROM ad_accounts
      WHERE account_id = $1`,
    [accountId],
  );
  return cuenta?.ok ?? false;
}

export async function GET(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const reglas = await listarReglas();
  return json(200, { ok: true, reglas });
}

export async function POST(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const preview = req.nextUrl.searchParams.get('preview') === '1';

  // ── preview: evaluar sin ejecutar, SIEMPRE en sombra (task §5.7) ──────────
  // Necesita el id de una regla guardada: es lo que llaman "correr ahora" y la
  // confirmación de §3.2. Con `accountId` opcional corre sobre ESA cuenta sin
  // guardar nada (sirve para preguntar "¿qué haría esta regla si la muevo a la
  // otra cuenta?"); sin `accountId`, sobre la cuenta guardada de la Regla.
  if (preview) {
    const parsedPreview = z
      .object({
        id: z.number().int().positive(),
        accountId: z.string().trim().min(1).max(64).optional(),
      })
      .safeParse(await req.json().catch(() => null));
    if (!parsedPreview.success) {
      return json(400, { ok: false, error: 'invalid_payload', detail: 'preview necesita el id de una regla' });
    }
    const r = await reglaPorId(parsedPreview.data.id);
    if (!r) return json(404, { ok: false, error: 'not_found' });

    // El override de cuenta tiene que ser una Cuenta_Activa, igual que el POST
    // normal: un preview sobre una cuenta inactiva no tiene zona con la que
    // evaluar la ventana horaria.
    const accountIdPreview = parsedPreview.data.accountId ?? null;
    if (accountIdPreview !== null && !(await cuentaEsActiva(accountIdPreview))) {
      return json(400, {
        ok: false,
        error: 'cuenta_invalida',
        detail: `la cuenta ${accountIdPreview} no existe o no está activa`,
      });
    }

    // "Correr ahora" (o el preview de la confirmación) tiene que evaluar aunque
    // la regla esté apagada o el interruptor global esté en false: es justamente
    // lo que se quiere probar ANTES de prenderla. Se fuerza `enabled: true` y
    // `forzarSombra: true` + `habilitado: true`; `forzarSombra` garantiza que
    // NADA se escribe en Meta, pase lo que pase.
    const sw = await interruptores();
    const resultado = await correrRegla(
      { regla: { ...r.regla, enabled: true, accountId: accountIdPreview ?? r.regla.accountId }, condiciones: r.condiciones },
      {
        forzarSombra: true,
        switches: {
          habilitado: true,
          forzarSombra: true,
          maxDailyBudgetEur: sw.maxDailyBudgetEur,
          maxDeltaPorTickEur: sw.maxDeltaPorTickEur,
        },
      },
    );
    return json(200, { ok: true, resultado });
  }

  const parsed = reglaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(400, {
      ok: false,
      error: 'invalid_payload',
      detail: parsed.error.issues[0]?.message,
    });
  }
  const d = parsed.data;
  // ── R9 c3: la cuenta tiene que existir y estar activa ANTES de la
  //    transacción, para cortar con un mensaje que nombre el id y no con el
  //    código del FK. ────────────────────────────────────────────────────────
  if (!(await cuentaEsActiva(d.accountId))) {
    return json(400, {
      ok: false,
      error: 'cuenta_invalida',
      detail: `la cuenta ${d.accountId} no existe o no está activa`,
    });
  }
  // ── crear o actualizar en una transacción ─────────────────────────────────
  try {
    const ruleId = await tx(async (client) => {
      // Con pause/activate el valor, la unidad y los límites no aplican: se
      // fuerzan a NULL igual que el formulario los deja (no escondidos, vacíos).
      const esPresupuesto = d.action === 'budget_increase' || d.action === 'budget_decrease';
      const actionValue = esPresupuesto ? d.actionValue ?? null : null;
      const actionUnit = esPresupuesto ? d.actionUnit ?? null : null;
      const budgetMax = esPresupuesto ? d.budgetMax ?? null : null;
      const budgetMin = esPresupuesto ? d.budgetMin ?? null : null;
      const nameFilter = d.nameFilter ?? null;
      const windowStart = d.windowStart ?? null;
      const windowEnd = d.windowEnd ?? null;

      let ruleId: number;
      if (d.id == null) {
        // Regla nueva: nace apagada y en sombra SIEMPRE (D-A12), ignorando
        // enabled/dryRun del payload. `metrics_level` se fija en 'object'.
        const res = await client.query(
          `INSERT INTO ad_rules
             (name, enabled, dry_run, account_id, level, status_filter, name_filter,
              name_filter_mode, action, action_value, action_unit, budget_max, budget_min,
              period, metrics_level, every_minutes, window_start, window_end,
              max_runs_per_day, cooldown_minutes, max_actions_per_object_per_day)
           VALUES ($1, false, true, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                   'object', $13, $14::time, $15::time, $16, $17, $18)
           RETURNING id`,
          [
            d.name, d.accountId, d.level, d.statusFilter, nameFilter, d.nameFilterMode,
            d.action, actionValue, actionUnit, budgetMax, budgetMin, d.period,
            d.everyMinutes, windowStart, windowEnd, d.maxRunsPerDay,
            d.cooldownMinutes, d.maxActionsPerObjectPerDay,
          ],
        );
        ruleId = res.rows[0].id;
      } else {
        // Actualizar: enabled/dry_run se cambian acá (los switches de la fila).
        // Si no vienen, se conservan.
        const res = await client.query(
          `UPDATE ad_rules SET
             name = $2, account_id = $3, level = $4, status_filter = $5,
             name_filter = $6, name_filter_mode = $7, action = $8, action_value = $9,
             action_unit = $10, budget_max = $11, budget_min = $12, period = $13,
             every_minutes = $14, window_start = $15::time, window_end = $16::time,
             max_runs_per_day = $17, cooldown_minutes = $18,
             max_actions_per_object_per_day = $19,
             enabled = COALESCE($20, enabled),
             dry_run = COALESCE($21, dry_run),
             updated_at = now()
           WHERE id = $1
           RETURNING id`,
          [
            d.id, d.name, d.accountId, d.level, d.statusFilter, nameFilter, d.nameFilterMode,
            d.action, actionValue, actionUnit, budgetMax, budgetMin, d.period,
            d.everyMinutes, windowStart, windowEnd, d.maxRunsPerDay,
            d.cooldownMinutes, d.maxActionsPerObjectPerDay,
            d.enabled ?? null, d.dryRun ?? null,
          ],
        );
        if (res.rows.length === 0) {
          throw new Error('not_found');
        }
        ruleId = d.id;
      }

      // Condiciones: se borran las viejas y se insertan las nuevas. Sin el
      // DELETE, una edición duplicaría las condiciones (task §5.4).
      await client.query('DELETE FROM ad_rule_conditions WHERE rule_id = $1', [ruleId]);
      for (let i = 0; i < d.conditions.length; i++) {
        const c = d.conditions[i];
        await client.query(
          `INSERT INTO ad_rule_conditions (rule_id, metric, op, value, position)
           VALUES ($1, $2, $3, $4, $5)`,
          [ruleId, c.metric, c.op, c.value, i],
        );
      }
      return ruleId;
    });

    return json(200, { ok: true, id: ruleId });
  } catch (e) {
    if (e instanceof Error && e.message === 'not_found') {
      return json(404, { ok: false, error: 'not_found' });
    }
    // Nombre duplicado: el único es (account_id, name) desde la 021 (R9 c5).
    // El mensaje nombra la cuenta y el nombre, que es lo que hace falta para
    // saber cuál de las dos reglas homónimas está en conflicto.
    if ((e as { code?: string }).code === '23505') {
      return json(409, {
        ok: false,
        error: 'nombre_duplicado',
        detail: `Ya existe una regla llamada «${d.name}» en la cuenta ${d.accountId}`,
      });
    }
    // 23503 = FK violada: la cuenta se borró entre el chequeo y el INSERT.
    if ((e as { code?: string }).code === '23503') {
      return json(400, {
        ok: false,
        error: 'cuenta_invalida',
        detail: `la cuenta ${d.accountId} no existe`,
      });
    }
    throw e;
  }
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const idStr = req.nextUrl.searchParams.get('id');
  const id = idStr ? Number(idStr) : NaN;
  if (!Number.isInteger(id) || id <= 0) {
    return json(400, { ok: false, error: 'invalid_params', detail: 'falta un id válido' });
  }

  // El historial NO se borra: las FK de ad_actions/ad_rule_runs son SET NULL y
  // rule_name queda desnormalizado (verificación 10 del task).
  const res = await q<{ id: number }>('DELETE FROM ad_rules WHERE id = $1 RETURNING id', [id]);
  if (res.length === 0) return json(404, { ok: false, error: 'not_found' });
  return json(200, { ok: true });
}
