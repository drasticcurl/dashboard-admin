/**
 * POST /api/ads/acciones — acciones manuales del gestor (T17 §9).
 *
 * Pausar, activar o fijar presupuesto sobre objetos de la jerarquía, de a un
 * lote. Es el endpoint donde un importe entra escrito a mano y donde un payload
 * armado a mano llega directo a Meta, así que acá viven los dos frenos que
 * cuestan plata de verdad (D-A9c):
 *   - el TECHO ABSOLUTO por objeto (`ads_max_daily_budget_eur`), y
 *   - el tope AGREGADO del lote (`ads_max_delta_por_tick_eur`).
 * La confirmación de la UI NO es un control de seguridad: este handler se puede
 * invocar directo con un curl autenticado.
 *
 * LOS INTERRUPTORES GLOBALES DE D-A12 NO APLICAN ACÁ (D-A12c): son para el motor
 * automático; una acción manual es una persona apretando un botón a propósito.
 * El techo absoluto de D-A9c sí aplica: no tiene excepciones.
 *
 * El lote NO es atómico (§6c del plan): 10 ids son 10 mutaciones independientes.
 * Si 3 fallan, 7 quedaron aplicadas, y la respuesta lo dice por objeto.
 *
 * Sobre "quién tocó esto": `source='manual'` dice por qué CANAL entró la acción,
 * no quién la hizo. El panel se autentica con contraseña compartida y cookie
 * HMAC, sin usuarios ni roles; `actor_hint` guarda el rastro técnico (IP,
 * user-agent) y es lo máximo que ese modelo permite (P-A12).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { isAuthenticated, getClientIp } from '@/lib/auth';
import { q, q1 } from '@/lib/db';
import { enviar, fetchObjeto, MetaAdsError } from '@/lib/ads/meta';
import type { NivelAds, ResultadoEscritura } from '@/lib/ads/tipos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, { status });
}

const schema = z
  .object({
    level: z.enum(['campaign', 'adset', 'ad']),
    action: z.enum(['pause', 'activate', 'budget_set']),
    objectIds: z.array(z.string().min(1).max(64)).min(1).max(100),
    budgetEur: z.number().positive().finite().optional(),
  })
  // En Meta los anuncios no tienen presupuesto (D-A5): que el tipo lo haga
  // imposible es más barato que descubrirlo por un error de la API.
  .refine((d) => d.action !== 'budget_set' || (d.level !== 'ad' && d.budgetEur !== undefined), {
    message: 'un anuncio no tiene presupuesto (D-A5)',
  });

type Objeto = {
  objectId: string;
  objectName: string | null;
  accountId: string;
  status: string | null;
  effectiveStatus: string | null;
  budgetLevel: string | null;
  budgetMode: string | null;
  dailyBudget: number | null; // unidades mínimas
  currency: string | null;
};

const TABLA_NIVEL: Record<NivelAds, { tabla: string; pk: string }> = {
  campaign: { tabla: 'ad_campaigns', pk: 'campaign_id' },
  adset: { tabla: 'ad_sets', pk: 'adset_id' },
  ad: { tabla: 'ads', pk: 'ad_id' },
};

const ETIQUETA_NIVEL: Record<NivelAds, string> = {
  campaign: 'campaña',
  adset: 'conjunto',
  ad: 'anuncio',
};

const dosDecimales = new Intl.NumberFormat('es-AR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function eur(n: number): string {
  return `€${dosDecimales.format(n)}`;
}

/** El objeto en la jerarquía + la moneda de su cuenta, o null si no existe/está inactivo. */
async function leerObjeto(level: NivelAds, objectId: string): Promise<Objeto | null> {
  const t = TABLA_NIVEL[level];

  // `budget_level` vive en `ad_campaigns`; un conjunto lo hereda de su campaña y
  // un anuncio nunca lo tiene (D-A5). La query es distinta por nivel.
  const budgetLevelSql =
    level === 'campaign'
      ? 'o.budget_level'
      : level === 'adset'
        ? '(SELECT c.budget_level FROM ad_campaigns c WHERE c.campaign_id = o.campaign_id)'
        : 'NULL::text';

  const row = await q1<{
    name: string | null;
    accountId: string;
    status: string | null;
    budgetLevel: string | null;
    dailyBudget: string | null;
    lifetimeBudget: string | null;
    currency: string | null;
  }>(
    `SELECT o.name, o.account_id AS "accountId", o.status,
            ${budgetLevelSql} AS "budgetLevel",
            o.daily_budget AS "dailyBudget", o.lifetime_budget AS "lifetimeBudget",
            a.currency
       FROM ${t.tabla} o
       JOIN ad_accounts a ON a.account_id = o.account_id AND a.active AND a.platform = 'meta'
      WHERE o.${t.pk} = $1`,
    [objectId],
  );
  if (!row) return null;
  return {
    objectId,
    objectName: row.name,
    accountId: row.accountId,
    status: row.status,
    effectiveStatus: null,
    budgetLevel: row.budgetLevel,
    // budgetMode se infiere igual que en T14/T15: daily si hay daily_budget,
    // lifetime si hay lifetime_budget, null si ninguno.
    budgetMode:
      row.dailyBudget !== null
        ? 'daily'
        : row.lifetimeBudget !== null
          ? 'lifetime'
          : null,
    dailyBudget: row.dailyBudget === null ? null : Number(row.dailyBudget),
    currency: row.currency,
  };
}

async function topes(): Promise<{ maxDailyBudgetEur: number; maxDeltaPorTickEur: number }> {
  const r = await q1<{ max: unknown; delta: unknown }>(
    `SELECT (SELECT value FROM settings WHERE key = 'ads_max_daily_budget_eur') AS "max",
            (SELECT value FROM settings WHERE key = 'ads_max_delta_por_tick_eur') AS "delta"`,
  );
  return {
    maxDailyBudgetEur: typeof r?.max === 'number' ? (r.max as number) : 200,
    maxDeltaPorTickEur: typeof r?.delta === 'number' ? (r.delta as number) : 300,
  };
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!isAuthenticated(req.cookies)) {
    return json(401, { ok: false, error: 'unauthorized' });
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(400, {
      ok: false,
      error: 'invalid_payload',
      detail: parsed.error.issues[0]?.message,
    });
  }
  const d = parsed.data;

  const { maxDailyBudgetEur, maxDeltaPorTickEur } = await topes();

  // ── Validación previa a cualquier llamada a Meta ──────────────────────────
  // 1. Objetos reales, de cuentas activas. Un id inventado no puede convertirse
  //    en una llamada a la API (T17 §9.5).
  const objetos: (Objeto | null)[] = [];
  for (const id of d.objectIds) {
    objetos.push(await leerObjeto(d.level, id));
  }
  const desconocidos = d.objectIds.filter((_, i) => objetos[i] === null);
  if (desconocidos.length > 0) {
    return json(400, {
      ok: false,
      error: 'unknown_object',
      detail: `objetos que no existen o no están en una cuenta activa: ${desconocidos.slice(0, 5).join(', ')}`,
    });
  }

  // 2. Para presupuesto: el techo absoluto, el tope agregado y los casos que
  //    Meta rechazaría con un error ilegible.
  if (d.action === 'budget_set') {
    const budgetEur = d.budgetEur as number;
    if (budgetEur > maxDailyBudgetEur) {
      return json(400, {
        ok: false,
        error: 'tope_absoluto',
        detail: `${eur(budgetEur)} pasa el máximo de ${eur(maxDailyBudgetEur)} por objeto`,
      });
    }
    // Tope agregado del lote: lo que se va a AGREGAR entre todos los objetos.
    // 80 conjuntos a €50 cada uno son €4.000 de presupuesto diario nuevo en un
    // request, y cada uno individualmente estaba dentro del límite.
    let delta = 0;
    for (const o of objetos) {
      if (!o) continue;
      const actual = o.dailyBudget !== null ? o.dailyBudget / 100 : 0;
      const nuevo = budgetEur;
      if (nuevo > actual) delta += nuevo - actual;
    }
    if (delta > maxDeltaPorTickEur) {
      return json(400, {
        ok: false,
        error: 'tope_absoluto',
        detail: `el lote sumaría ${eur(delta)} de presupuesto nuevo, más que el máximo de ${eur(maxDeltaPorTickEur)} por corrida`,
      });
    }
    for (const o of objetos) {
      if (!o) continue;
      if (o.budgetMode === 'lifetime') {
        return json(400, { ok: false, error: 'presupuesto_lifetime_no_soportado', detail: o.objectId });
      }
      if (o.currency !== 'EUR') {
        return json(400, { ok: false, error: 'moneda_no_soportada', detail: `${o.objectId} (${o.currency ?? '?'})` });
      }
      if (o.budgetLevel !== d.level) {
        return json(400, { ok: false, error: 'sin_presupuesto_en_este_nivel', detail: o.objectId });
      }
    }
  }

  // ── Ejecutar, objeto por objeto. No atómico (T17 §9). ────────────────────
  const actorHint = `ip=${getClientIp(req.headers)} ua=${(req.headers.get('user-agent') ?? '?').slice(0, 60)}`;
  const resultados: { objectId: string; ok: boolean; error: string | null; explicacion: string }[] = [];

  for (const o of objetos) {
    if (!o) continue; // ya chequeado arriba, defensivo
    const antes = o.dailyBudget !== null ? o.dailyBudget / 100 : null;

    // before_value / after_value en el vocabulario del historial.
    let before: string | null;
    let after: string | null;
    let explicacion: string;
    let campos: Record<string, string>;

    if (d.action === 'pause') {
      before = o.status;
      after = 'PAUSED';
      campos = { status: 'PAUSED' };
      explicacion = `Manual: se pausó el ${ETIQUETA_NIVEL[d.level]} «${o.objectName ?? o.objectId}» (${o.accountId}). Estado anterior: ${o.status ?? '?'}.`;
    } else if (d.action === 'activate') {
      before = o.status;
      after = 'ACTIVE';
      campos = { status: 'ACTIVE' };
      explicacion = `Manual: se activó el ${ETIQUETA_NIVEL[d.level]} «${o.objectName ?? o.objectId}» (${o.accountId}). Estado anterior: ${o.status ?? '?'}.`;
    } else {
      before = antes !== null ? eur(antes) : null;
      after = eur(d.budgetEur as number);
      campos = { daily_budget: String(Math.round((d.budgetEur as number) * 100)) };
      explicacion = `Manual: presupuesto del ${ETIQUETA_NIVEL[d.level]} «${o.objectName ?? o.objectId}» (${o.accountId}) de ${before ?? '—'} a ${after}.`;
    }

    // §6c: la fila se abre ANTES del POST y se cierra después. Un timeout es
    // 'indeterminado', no 'fallido': puede haberse aplicado igual.
    const accion = await q1<{ id: string }>(
      `INSERT INTO ad_actions
         (source, account_id, level, object_id, object_name, action, before_value, after_value,
          dry_run, ok, estado, explicacion, metrics, actor_hint)
       VALUES ('manual', $1, $2, $3, $4, $5, $6, $7, false, false, 'pendiente', $8, '{}'::jsonb, $9)
       RETURNING id`,
      [o.accountId, d.level, o.objectId, o.objectName, d.action, before, after, explicacion, actorHint],
    );
    const accionId = Number((accion as { id: string }).id);

    let r: ResultadoEscritura;
    try {
      r = await enviar(o.objectId, campos);
    } catch (e) {
      r = {
        estado: 'indeterminado',
        error: new MetaAdsError(e instanceof Error ? e.message : String(e), undefined, undefined, undefined, true),
      };
    }

    if (r.estado === 'confirmado') {
      await q(
        `UPDATE ad_actions SET estado = 'confirmado', ok = true WHERE id = $1`,
        [accionId],
      );
      await refrescarJerarquia(d.level, o.objectId);
      resultados.push({ objectId: o.objectId, ok: true, error: null, explicacion });
    } else if (r.estado === 'fallido') {
      const m = `${r.error.message} (code ${r.error.code ?? '-'})`;
      await q(`UPDATE ad_actions SET estado = 'fallido', ok = false, error = $2 WHERE id = $1`, [accionId, m]);
      resultados.push({ objectId: o.objectId, ok: false, error: m, explicacion });
    } else {
      const m = `${r.error.message} (code ${r.error.code ?? '-'})`;
      await q(`UPDATE ad_actions SET estado = 'indeterminado', ok = false, error = $2 WHERE id = $1`, [accionId, m]);
      resultados.push({ objectId: o.objectId, ok: false, error: m, explicacion });
    }
  }

  const ok = resultados.filter((r) => r.ok).length;
  return json(200, {
    ok: true,
    aplicados: ok,
    total: resultados.length,
    resultados,
  });
}

/** Relee el objeto en Meta y refresca la fila de la jerarquía (T17 §9.9). */
async function refrescarJerarquia(level: NivelAds, objectId: string): Promise<void> {
  try {
    const o = await fetchObjeto(objectId, level);
    if (!o) return;
    const t = TABLA_NIVEL[level];
    if (level === 'ad') {
      await q(
        `UPDATE ads SET status = $2, effective_status = $3, synced_at = now() WHERE ad_id = $1`,
        [objectId, o.status, o.effectiveStatus],
      );
    } else {
      await q(
        `UPDATE ${t.tabla} SET status = $2, effective_status = $3, daily_budget = $4, lifetime_budget = $5, synced_at = now() WHERE ${t.pk} = $1`,
        [objectId, o.status, o.effectiveStatus, o.dailyBudget, o.lifetimeBudget],
      );
    }
  } catch {
    // Best-effort: la jerarquía se refresca en el próximo sync. La acción ya
    // quedó confirmada en Meta y en ad_actions.
  }
}
