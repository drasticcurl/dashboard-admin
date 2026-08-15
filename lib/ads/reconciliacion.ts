/**
 * Reconciliación de duplicaciones (task 24.1 de gestion-campanas-anuncios): el
 * cierre de las filas de `ad_actions` que una duplicación dejó abiertas, POR
 * NOMBRE PLANIFICADO (P-G05).
 *
 * El nombre de cada Copia es determinístico y libre de colisiones (P12), así que
 * una duplicación cuyo resultado nunca llegó se resuelve preguntando por el
 * nombre: se corre el Sync_Jerarquia de la cuenta y se busca, entre los hijos
 * del mismo padre, un objeto que se llame exactamente como dice `after_value`.
 *   - aparece → `confirmado`, con su id en `metrics.creados`;
 *   - no aparece y pasaron más de 15 minutos → `fallido`;
 *   - no aparece y todavía está fresco → queda abierta, se reintenta el tick
 *     siguiente;
 *   - el Sync_Jerarquia falla → queda sin resolver, se reintenta.
 *
 * Es un módulo NUEVO a propósito: no se toca `reconciliar()` de
 * `lib/ads/reglas/ejecutor.ts`, que reconcilia por valor leído del objeto y no
 * sirve para una duplicación que no tiene un objeto propio que preguntar.
 */

import { q } from '../db';
import { sincronizarJerarquia } from './jerarquia';

type FilaAbierta = {
  id: number;
  level: string;
  object_id: string;
  after_value: string | null;
  created_at: Date | string;
  metrics: Record<string, unknown>;
};

const MINUTOS_ANTES_DE_FALLAR = 15; // P-G05

/** Busca la Copia por su nombre planificado entre los hermanos del mismo padre. */
async function buscarPorNombre(
  accountId: string,
  level: string,
  originalId: string,
  nombre: string,
): Promise<string | null> {
  if (level === 'campaign') {
    const row = await q<{ id: string }>(
      `SELECT campaign_id AS id FROM ad_campaigns
        WHERE account_id = $1 AND name = $2
        ORDER BY synced_at DESC LIMIT 1`,
      [accountId, nombre],
    );
    return row[0]?.id ?? null;
  }
  if (level === 'adset') {
    const original = await q<{ campaign_id: string }>(
      `SELECT campaign_id FROM ad_sets WHERE adset_id = $1`,
      [originalId],
    );
    const padre = original[0]?.campaign_id;
    if (!padre) return null;
    const row = await q<{ id: string }>(
      `SELECT adset_id AS id FROM ad_sets
        WHERE campaign_id = $1 AND name = $2
        ORDER BY synced_at DESC LIMIT 1`,
      [padre, nombre],
    );
    return row[0]?.id ?? null;
  }
  return null;
}

/**
 * Cierra las duplicaciones sin resolver de la cuenta, por nombre planificado.
 * Acotada a `limite` filas (el endpoint usa 20 con presupuesto de 5 s; el
 * script del cron puede pasar más). Devuelve cuántas se resolvieron y cuántas
 * quedaron abiertas.
 */
export async function reconciliarDuplicaciones(
  accountId: string,
  limite = 20,
): Promise<{ resueltas: number; pendientes: number }> {
  const abiertas = await q<FilaAbierta>(
    `SELECT id, level, object_id, after_value, created_at, metrics
       FROM ad_actions
      WHERE account_id = $1 AND action = 'duplicate'
        AND estado IN ('pendiente', 'indeterminado')
      ORDER BY created_at
      LIMIT $2`,
    [accountId, limite],
  );
  if (abiertas.length === 0) return { resueltas: 0, pendientes: 0 };

  // La jerarquía se sincroniza UNA vez para todas las filas de la cuenta. Si
  // falla, todo queda sin resolver y se reintenta el tick siguiente.
  try {
    await sincronizarJerarquia({ cuentas: [accountId] });
  } catch {
    return { resueltas: 0, pendientes: abiertas.length };
  }

  let resueltas = 0;
  let pendientes = 0;
  const ahora = Date.now();

  for (const fila of abiertas) {
    const nombre = fila.after_value;
    if (!nombre) {
      // Sin nombre planificado no hay llave de reconciliación: lo único honesto
      // es dejarla como está (los ids parciales ya quedaron en metrics.creados).
      pendientes += 1;
      continue;
    }
    const encontrada = await buscarPorNombre(accountId, fila.level, fila.object_id, nombre);
    if (encontrada) {
      await q(
        `UPDATE ad_actions
            SET estado = 'confirmado', ok = true,
                metrics = metrics || jsonb_build_object('creados', COALESCE(metrics->'creados', '[]'::jsonb) || to_jsonb($2::text))
          WHERE id = $1`,
        [fila.id, encontrada],
      );
      resueltas += 1;
      continue;
    }

    const creada = fila.created_at instanceof Date ? fila.created_at.getTime() : new Date(fila.created_at).getTime();
    if (ahora - creada > MINUTOS_ANTES_DE_FALLAR * 60_000) {
      await q(
        `UPDATE ad_actions
            SET estado = 'fallido', ok = false,
                error = COALESCE(error, 'la reconciliación no encontró la Copia con el nombre planificado después de 15 minutos')
          WHERE id = $1`,
        [fila.id],
      );
      resueltas += 1;
    } else {
      pendientes += 1;
    }
  }

  return { resueltas, pendientes };
}
