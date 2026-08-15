/**
 * verificarCupoObjetos (task 23.2 de gestion-campanas-anuncios): el preflight de
 * cupo de la duplicación (P-G06).
 *
 * El preflight combina un conteo LOCAL (siempre disponible) con una lectura
 * remota opcional, y la autoridad final es el rechazo de Meta, mapeado en el
 * catálogo de errores (R10 c13). El tope configurado vive en
 * `settings.ads_max_objetos_cuenta` (null = DESCONOCIDO, no "sin límite": el
 * límite real depende del tier de la cuenta y no está medido). La lectura
 * remota es best-effort y su existencia la determina
 * `scripts/verificar-dsa-cupo.ts` (D-04): hasta que su salida confirme un cupo
 * legible, `topeRemoto` es null y el veredicto se resuelve con el tope
 * configurado.
 *
 * Con `veredicto: 'desconocido'` la Previsualizacion lo dice y la corrida
 * sigue: la autoridad final es el rechazo de Meta.
 */

import { q, q1 } from '../db';

export type CupoObjetos = {
  /** Objetos que la jerarquía local conoce para la cuenta (campañas + conjuntos + anuncios). */
  localesConocidos: number;
  /** Objetos que la corrida va a crear. */
  aCrear: number;
  /** Tope configurado en settings.ads_max_objetos_cuenta. null = desconocido. */
  topeConfigurado: number | null;
  /** Lo que informó Meta, si la versión configurada expone un cupo legible. null = no se pudo leer. */
  topeRemoto: number | null;
  /** 'ok' | 'cerca' (≥ 90 % del tope conocido) | 'excede' | 'desconocido' */
  veredicto: 'ok' | 'cerca' | 'excede' | 'desconocido';
};

export async function verificarCupoObjetos(
  accountId: string,
  aCrear: number,
): Promise<CupoObjetos> {
  const [conteo, topeRow] = await Promise.all([
    q1<{ n: number }>(
      `SELECT
         (SELECT count(*) FROM ad_campaigns WHERE account_id = $1)
       + (SELECT count(*) FROM ad_sets      WHERE account_id = $1)
       + (SELECT count(*) FROM ads          WHERE account_id = $1) AS n`,
      [accountId],
    ),
    q1<{ value: unknown }>(
      `SELECT value FROM settings WHERE key = 'ads_max_objetos_cuenta'`,
    ),
  ]);

  const localesConocidos = conteo?.n ?? 0;
  const topeConfigurado =
    typeof topeRow?.value === 'number' ? (topeRow.value as number) : null;

  // Lectura remota best-effort. La API no documenta un campo de "máximo de
  // objetos por cuenta": su existencia la confirma verificar-dsa-cupo.ts
  // (D-04). Hasta entonces null, y el veredicto no inventa un tope.
  const topeRemoto: number | null = null;

  const tope = topeRemoto ?? topeConfigurado;
  let veredicto: CupoObjetos['veredicto'] = 'desconocido';
  if (tope !== null && Number.isFinite(tope)) {
    const total = localesConocidos + aCrear;
    if (total >= tope) veredicto = 'excede';
    else if (total >= tope * 0.9) veredicto = 'cerca';
    else veredicto = 'ok';
  }

  return { localesConocidos, aCrear, topeConfigurado, topeRemoto, veredicto };
}
