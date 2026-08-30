/**
 * /api/ads/reglas/csv — importar y exportar reglas en el formato de UTMify.
 *
 *   GET  /api/ads/reglas/csv                 baja TODAS las reglas como CSV
 *   GET  /api/ads/reglas/csv?accountId=act_1 baja sólo las de esa cuenta
 *   POST /api/ads/reglas/csv                 importa un CSV
 *
 * La traducción vive en `lib/ads/reglas/utmify.ts` (pura y testeada contra el
 * CSV real): este route sólo hace auth, valida el destino y escribe.
 *
 * Reglas no negociables, las mismas que el route hermano de reglas:
 *   - `guard(req)` en los dos métodos.
 *   - Todo el import en UNA transacción: o entran todas las reglas del archivo
 *     o no entra ninguna. Un import a medias deja al usuario sin saber qué
 *     quedó cargado y con un motor corriendo sobre una mezcla.
 *   - Una regla importada nace `enabled=false` y `dry_run=true`, igual que una
 *     creada a mano (D-A12). El formato de UTMify no trae esos campos, así que
 *     acá no hay nada que ignorar: no existen en el archivo.
 *   - `reemplazar` borra las reglas viejas de las cuentas de destino ANTES de
 *     insertar, dentro de la misma transacción. El historial no se toca: las FK
 *     de `ad_actions` y `ad_rule_runs` hacia `ad_rules` son SET NULL.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { q, tx } from '@/lib/db';
import { guard, json } from '@/app/api/config/_lib';
import { interruptores } from '@/lib/ads/reglas/repo';
import { listarReglas } from '@/app/(panel)/anuncios/reglas/_server';
import { avisosDeExport, exportarCsvUtmify, importarCsvUtmify } from '@/lib/ads/reglas/utmify';
import { MONEDA_REPORTE, SIMBOLO_REPORTE } from '@/lib/moneda-reporte';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Topes del payload. No son un límite de negocio: son el freno para que un
 * archivo enorme (o pegado por error) no ocupe memoria ni la transacción.
 */
const MAX_CSV_BYTES = 512 * 1024;
const MAX_REGLAS = 500;

// ─── GET: exportar ───────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const accountId = req.nextUrl.searchParams.get('accountId');
  const todas = await listarReglas();
  const reglas = accountId ? todas.filter((r) => r.accountId === accountId) : todas;

  const csv = exportarCsvUtmify(reglas);

  // Nombre con fecha: estos archivos se acumulan en Descargas y "reglas.csv"
  // repetido cinco veces no dice cuál es el último.
  const hoy = new Date().toISOString().slice(0, 10);
  const sufijo = accountId ? `-${accountId}` : '';
  const nombre = `reglas-utmify${sufijo}-${hoy}.csv`;

  return new Response(csv, {
    status: 200,
    headers: {
      // utf-8 explícito: los nombres de las reglas tienen ñ y tildes
      // («ACTIVAR A LAS 00 CAMPAÑAS») y sin esto Excel los rompe.
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${nombre}"`,
      'Cache-Control': 'no-store',
      // Los avisos de lo que el formato NO puede llevar viajan en un header
      // para que la UI los muestre sin tener que parsear el archivo.
      'X-Avisos': encodeURIComponent(JSON.stringify(avisosDeExport(reglas))),
    },
  });
}

// ─── POST: importar ──────────────────────────────────────────────────────────

const importSchema = z.object({
  csv: z.string().min(1, 'Falta el contenido del CSV'),
  /** Las cuentas donde entra el archivo. Una regla = una cuenta, así que con
   *  más de una se inserta una copia de cada regla por cuenta. */
  accountIds: z.array(z.string().trim().min(1).max(64)).min(1, 'Elegí al menos una cuenta'),
  /** true = borra las reglas actuales de esas cuentas antes de insertar. */
  reemplazar: z.boolean().optional().default(false),
});

type Omitida = { accountId: string; name: string; motivo: string };

export async function POST(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const body = await req.json().catch(() => null);
  const parsed = importSchema.safeParse(body);
  if (!parsed.success) {
    return json(400, { ok: false, error: 'invalid_payload', detail: parsed.error.issues[0]?.message });
  }
  const { csv, accountIds, reemplazar } = parsed.data;

  if (Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) {
    return json(413, { ok: false, error: 'csv_demasiado_grande', detail: 'El archivo pasa los 512 KB' });
  }

  // ── Las cuentas de destino tienen que ser Cuentas_Activas ────────────────
  // Igual que en el route de reglas: se chequea acá para poder nombrar la
  // cuenta en el mensaje, y porque el FK acepta cuentas inactivas.
  const unicas = Array.from(new Set(accountIds));
  const activas = await q<{ account_id: string }>(
    `SELECT account_id FROM ad_accounts WHERE active AND platform = 'meta' AND account_id = ANY($1::text[])`,
    [unicas],
  );
  const validas = new Set(activas.map((a) => a.account_id));
  const invalidas = unicas.filter((a) => !validas.has(a));
  if (invalidas.length > 0) {
    return json(400, {
      ok: false,
      error: 'cuenta_invalida',
      detail: `estas cuentas no existen o no están activas: ${invalidas.join(', ')}`,
    });
  }

  // ── Traducir ─────────────────────────────────────────────────────────────
  const { reglas, errores, avisos } = importarCsvUtmify(csv);

  if (reglas.length === 0) {
    return json(400, {
      ok: false,
      error: 'sin_reglas',
      detail: errores.length > 0 ? `Ninguna fila se pudo traducir (${errores.length} con error)` : (avisos[0] ?? 'El archivo no tiene reglas'),
      errores,
      avisos,
    });
  }
  if (reglas.length * unicas.length > MAX_REGLAS) {
    return json(413, {
      ok: false,
      error: 'demasiadas_reglas',
      detail: `${reglas.length} reglas × ${unicas.length} cuentas pasa el tope de ${MAX_REGLAS}`,
    });
  }

  // ── Escribir, todo o nada ────────────────────────────────────────────────
  const omitidas: Omitida[] = [];
  let creadas = 0;
  let borradas = 0;

  try {
    await tx(async (client) => {
      if (reemplazar) {
        const del = await client.query(
          `DELETE FROM ad_rules WHERE account_id = ANY($1::text[]) RETURNING id`,
          [unicas],
        );
        borradas = del.rowCount ?? 0;
      }

      // Los nombres que ya están ocupados en las cuentas de destino. Se consulta
      // DESPUÉS del borrado (misma transacción) para que con `reemplazar` la
      // lista salga vacía. Se chequea acá en vez de dejar que salte el único
      // (account_id, name): una violación de constraint aborta la transacción
      // entera en Postgres y perderíamos las reglas buenas del archivo.
      const ya = await client.query<{ account_id: string; name: string }>(
        `SELECT account_id, name FROM ad_rules WHERE account_id = ANY($1::text[])`,
        [unicas],
      );
      const ocupados = new Set(ya.rows.map((r) => `${r.account_id}\u0000${r.name}`));

      for (const accountId of unicas) {
        for (const r of reglas) {
          if (ocupados.has(`${accountId}\u0000${r.name}`)) {
            omitidas.push({
              accountId,
              name: r.name,
              motivo: 'ya existe una regla con ese nombre en la cuenta',
            });
            continue;
          }

          const res = await client.query<{ id: number }>(
            `INSERT INTO ad_rules
               (name, enabled, dry_run, account_id, level, status_filter, name_filter,
                name_filter_mode, action, action_value, action_unit, budget_max, budget_min,
                period, metrics_level, every_minutes, window_start, window_end,
                max_runs_per_day, cooldown_minutes, max_actions_per_object_per_day)
             VALUES ($1, false, true, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                     'object', $13, $14::time, $15::time, $16, $17, $18)
             RETURNING id`,
            [
              r.name,
              accountId,
              r.level,
              r.statusFilter,
              r.nameFilter,
              r.nameFilterMode,
              r.action,
              r.actionValue,
              r.actionUnit,
              r.budgetMax,
              r.budgetMin,
              r.period,
              r.everyMinutes,
              r.windowStart,
              r.windowEnd,
              r.maxRunsPerDay,
              r.cooldownMinutes,
              r.maxActionsPerObjectPerDay,
            ],
          );
          const ruleId = res.rows[0].id;
          ocupados.add(`${accountId}\u0000${r.name}`);

          for (let i = 0; i < r.conditions.length; i++) {
            const c = r.conditions[i];
            await client.query(
              `INSERT INTO ad_rule_conditions (rule_id, metric, op, value, position)
               VALUES ($1, $2, $3, $4, $5)`,
              [ruleId, c.metric, c.op, c.value, i],
            );
          }
          creadas++;
        }
      }
    });
  } catch (e) {
    // Los CHECK de la base son la última red: si algo pasó el traductor y la
    // base lo rechaza, el mensaje del constraint es lo único que tenemos, pero
    // al menos se devuelve entero en vez de un 500 pelado.
    const err = e as { code?: string; constraint?: string; message?: string };
    if (err.code === '23514') {
      return json(400, {
        ok: false,
        error: 'regla_invalida',
        detail: `la base rechazó una regla (${err.constraint ?? 'CHECK'}): ${err.message ?? ''}`,
      });
    }
    if (err.code === '23505') {
      return json(409, { ok: false, error: 'nombre_duplicado', detail: err.message ?? 'nombre repetido' });
    }
    throw e;
  }

  // ── Avisos que sólo se pueden dar mirando la configuración del panel ─────
  const extra: string[] = [];
  const sw = await interruptores();
  const sobreTecho = reglas.filter((r) => r.budgetMax != null && r.budgetMax > sw.maxDailyBudgetEur);
  if (sobreTecho.length > 0) {
    extra.push(
      `${sobreTecho.length} regla(s) tienen un techo por encima del máximo absoluto por objeto (${SIMBOLO_REPORTE}${sw.maxDailyBudgetEur}): las subidas se van a cortar siempre en ese tope. Se cambia en Config → Publicidad.`,
    );
  }

  return json(200, {
    ok: true,
    creadas,
    borradas,
    cuentas: unicas,
    omitidas,
    errores,
    avisos: [...avisos, ...extra],
  });
}
