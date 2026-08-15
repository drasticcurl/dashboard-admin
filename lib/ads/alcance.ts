/**
 * Metricas_Rango: alcance y frecuencia (task 14.2 de gestion-campanas-anuncios).
 *
 * El alcance NO ES ADITIVO entre días: sumar el alcance de dos días cuenta dos
 * veces a la misma persona. Por eso vive en `ad_alcance` (migración 018 §4), con
 * el RANGO como parte de la clave, y la pantalla sólo muestra un número cuando
 * pide EXACTAMENTE el rango que está guardado (P-G07). Nunca se suma, nunca se
 * interpola, nunca se aproxima con el rango más parecido.
 *
 * `asegurarAlcance` es calcado de `ensureFreshAdSpend`: si hay filas frescas
 * para ese (nivel, from, to) no llama a Meta, y NUNCA TIRA — un fallo deja el
 * alcance en NULL y la columna en `—`; el error viaja al llamador para
 * `ResultadoMetricas.alcanceError`. Se paga una llamada extra por
 * (cuenta, nivel, período) por ventana de TTL, y sólo cuando alguna Vista tiene
 * la columna de alcance o frecuencia visible.
 */

import { q, q1 } from '../db';
import { fetchAlcance, MetaAdsError } from './meta';
import { TZ_DEFAULT } from './zona';
import type { NivelAds } from './tipos';

export type ResultadoAlcance = {
  /** false = ya había filas frescas y no se llamó a Meta. */
  pedido: boolean;
  filas: number;
  /** null = sin problema. El error de Meta va recortado y sin URL. */
  error: string | null;
};

/** El TTL de `settings.ads_insights_ttl_seconds` (seed 55 s). */
async function ttlSegundos(): Promise<number> {
  const r = await q1<{ value: unknown }>(
    `SELECT value FROM settings WHERE key = 'ads_insights_ttl_seconds'`,
  );
  const n = typeof r?.value === 'number' ? (r.value as number) : 55;
  return Number.isFinite(n) && n >= 0 ? n : 55;
}

/**
 * Los cuatro rangos que la pantalla ofrece, resueltos en la Zona_Cuenta. Son
 * los ÚNICOS que se guardan: un rango arbitrario no tendría cómo encontrarse
 * después (P-G07).
 */
async function rangosDePantalla(tz: string): Promise<Set<string>> {
  const r = await q1<{ hoy: string }>(`SELECT (now() AT TIME ZONE $1)::date::text AS hoy`, [tz]);
  const hoy = r?.hoy ?? '1970-01-01';
  const filas = await q<{ desde: string; hasta: string }>(
    `SELECT (($1::date) - 1)::text AS desde, ($1::date - 1)::text AS hasta
     UNION ALL SELECT $1::text, $1::text
     UNION ALL SELECT ($1::date - 6)::text, $1::text
     UNION ALL SELECT ($1::date - 7)::text, ($1::date - 1)::text`,
    [hoy],
  );
  return new Set(filas.map((f) => `${f.desde}|${f.hasta}`));
}

/**
 * Asegura que existan filas de alcance frescas para `(nivel, from, to)`:
 *   - si el rango incluye hoy: frescura por TTL (`ads_insights_ttl_seconds`);
 *   - si el rango está cerrado y `synced_at > date_to + 2 días`: la fila es
 *     FINAL y no se vuelve a pedir nunca (Meta ajusta los días recién cerrados,
 *     después no).
 * Nunca tira. Una llamada por (cuenta, nivel, período) por ventana de TTL.
 */
export async function asegurarAlcance(
  accountId: string,
  level: NivelAds,
  from: string,
  to: string,
): Promise<ResultadoAlcance> {
  try {
    // Defensa del contrato: sólo se guardan rangos de pantalla. Un rango raro
    // es un bug del llamador, no una llamada a Meta.
    const tzRow = await q1<{ tz: string }>(
      `SELECT COALESCE(timezone, $2) AS tz FROM ad_accounts WHERE account_id = $1`,
      [accountId, TZ_DEFAULT],
    );
    const tz = tzRow?.tz ?? TZ_DEFAULT;
    const rangos = await rangosDePantalla(tz);
    if (!rangos.has(`${from}|${to}`)) {
      return { pedido: false, filas: 0, error: null };
    }

    const existente = await q1<{ syncedAt: Date | string | null; cuenta: number }>(
      `SELECT min(synced_at) AS "syncedAt", count(*)::int AS cuenta
         FROM ad_alcance
        WHERE platform = 'meta' AND account_id = $1 AND level = $2
          AND date_from = $3::date AND date_to = $4::date`,
      [accountId, level, from, to],
    );

    if (existente && existente.cuenta > 0 && existente.syncedAt !== null) {
      const hoy = await q1<{ hoy: string }>(
        `SELECT (now() AT TIME ZONE $1)::date::text AS hoy`,
        [tz],
      );
      const incluyeHoy = to >= (hoy?.hoy ?? '1970-01-01');
      if (incluyeHoy) {
        const synced = existente.syncedAt instanceof Date ? existente.syncedAt : new Date(existente.syncedAt);
        const age = (Date.now() - synced.getTime()) / 1000;
        if (age < (await ttlSegundos())) {
          return { pedido: false, filas: existente.cuenta, error: null };
        }
      } else {
        // Rango cerrado: final pasados 2 días del cierre.
        const finalRow = await q1<{ final: boolean }>(
          `SELECT (min(synced_at) > ($2::date + 2)::timestamptz) AS final
             FROM ad_alcance
            WHERE platform = 'meta' AND account_id = $3 AND level = $4
              AND date_from = $1::date AND date_to = $2::date`,
          [from, to, accountId, level],
        );
        if (finalRow?.final) {
          return { pedido: false, filas: existente.cuenta, error: null };
        }
      }
    }

    const filas = await fetchAlcance(accountId, level, from, to);
    const validas = filas.filter((f) => f.objectId !== '');
    if (validas.length > 0) {
      await q(
        `INSERT INTO ad_alcance (platform, account_id, level, object_id, date_from, date_to,
                                 reach, impressions, frequency, synced_at)
         SELECT 'meta', $1, $2, u.object_id, $3::date, $4::date, u.reach, u.impressions, u.frequency, now()
           FROM UNNEST($5::text[], $6::bigint[], $7::bigint[], $8::numeric[]) AS u(object_id, reach, impressions, frequency)
         ON CONFLICT (platform, account_id, level, object_id, date_from, date_to)
         DO UPDATE SET reach = EXCLUDED.reach,
                       impressions = EXCLUDED.impressions,
                       frequency = EXCLUDED.frequency,
                       synced_at = now()`,
        [
          accountId,
          level,
          from,
          to,
          validas.map((f) => f.objectId),
          validas.map((f) => f.reach),
          validas.map((f) => f.impressions),
          validas.map((f) => f.frequency),
        ],
      );
    }
    return { pedido: true, filas: validas.length, error: null };
  } catch (e) {
    const msg = e instanceof MetaAdsError ? e.message : e instanceof Error ? e.message : String(e);
    return { pedido: true, filas: 0, error: msg.slice(0, 500) };
  }
}
