/**
 * Programación del inicio (task 8.1 de gestion-campanas-anuncios): resuelve
 * fecha + hora + Zona_Cuenta a un instante único con desplazamiento horario
 * explícito y segundos en 00 (R11 c4).
 *
 * La aritmética se resuelve EN POSTGRESQL con `AT TIME ZONE`, igual que todo el
 * resto del proyecto (`lib/day.ts` lo dice con todas las letras: hacerlo con el
 * `Date` de JS corre un día en el horario de verano y nadie se da cuenta). La
 * detección de DST es la de la base de datos de zonas del sistema, no una tabla
 * propia. Por eso este módulo NO está en la lista de puros: necesita la base.
 *
 * DST (R11 c12, Property 16):
 *   - hora INEXISTENTE (salto hacia adelante): PostgreSQL mapea por el hueco
 *     (02:30 → 03:30 en una zona que salta a las 02:00) y el módulo lo informa
 *     como ajustado, con el instante efectivo;
 *   - hora REPETIDA (salto hacia atrás): PostgreSQL elige la primera aparición;
 *     el módulo detecta la repetición y resuelve al primer instante POSTERIOR
 *     al cambio (la segunda aparición, con el desplazamiento de después del
 *     salto), informando el efectivo.
 */

import { q1 } from '../db';

export type ResolucionInicio = {
  /** ISO 8601 con desplazamiento explícito y segundos en 00 (lo que se envía). */
  instante: string;
  /** La hora de pared efectiva resuelta en la Zona_Cuenta (informa el ajuste). */
  efectivo: string;
  /** true cuando la hora pedida no existe o se repite por un cambio de horario. */
  ajustadoPorDst: boolean;
};

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORA = /^\d{2}:\d{2}$/;

/** '-90' → '-01:30', '60' → '+01:00'. */
function formatoOffset(offsetMin: number): string {
  const signo = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${signo}${hh}:${mm}`;
}

/**
 * Resuelve fecha + hora + zona a un instante único (R11 c4). Los segundos
 * quedan fijos en 00. La fecha es 'YYYY-MM-DD' y la hora 'HH:MM'.
 */
export async function resolverInicio(
  fecha: string,
  hora: string,
  zona: string,
): Promise<ResolucionInicio> {
  if (!RE_FECHA.test(fecha)) throw new Error(`resolverInicio: fecha inválida: ${fecha}`);
  if (!RE_HORA.test(hora)) throw new Error(`resolverInicio: hora inválida: ${hora}`);

  // t = la interpretación estándar de la hora local; t2 = t + 1 hora, para
  // detectar la hora repetida del salto hacia atrás. El offset se calcula como
  // pared(zona) − pared(UTC): es exacto para el instante, no depende de la zona
  // de sesión de la base.
  const row = await q1<{
    pared: string;
    offsetMin: number;
    pared2Hora: string;
    offset2Min: number;
  }>(
    `SELECT to_char(t AT TIME ZONE $3, 'YYYY-MM-DD"T"HH24:MI:SS') AS pared,
            (EXTRACT(EPOCH FROM ((t AT TIME ZONE $3) - (t AT TIME ZONE 'UTC'))) / 60)::int AS "offsetMin",
            to_char(t2 AT TIME ZONE $3, 'HH24:MI') AS "pared2Hora",
            (EXTRACT(EPOCH FROM ((t2 AT TIME ZONE $3) - (t2 AT TIME ZONE 'UTC'))) / 60)::int AS "offset2Min"
       FROM (SELECT ($1::date + $2::time) AT TIME ZONE $3 AS t,
                    ($1::date + $2::time) AT TIME ZONE $3 + interval '1 hour' AS t2) x`,
    [fecha, `${hora}:00`, zona],
  );
  if (!row) throw new Error(`resolverInicio: la zona ${zona} no es válida para PostgreSQL`);

  const pared = row.pared;
  const offset = Number(row.offsetMin);
  const offset2 = Number(row.offset2Min);

  // Hora inexistente (salto hacia adelante): PostgreSQL mapeó por el hueco y la
  // hora de pared ya no es la pedida.
  if (pared.slice(11, 16) !== hora) {
    return { instante: `${pared}${formatoOffset(offset)}`, efectivo: pared, ajustadoPorDst: true };
  }

  // Hora repetida (salto hacia atrás): la hora de pared de t+1h es LA MISMA y el
  // desplazamiento cambió. Resolver al primer instante posterior al cambio =
  // segunda aparición: la MISMA hora de pared con el desplazamiento de después
  // del salto.
  if (offset2 !== offset && row.pared2Hora === hora) {
    return {
      instante: `${pared.slice(0, 11)}${hora}:00${formatoOffset(offset2)}`,
      efectivo: pared,
      ajustadoPorDst: true,
    };
  }

  return { instante: `${pared}${formatoOffset(offset)}`, efectivo: pared, ajustadoPorDst: false };
}

/**
 * Mañana a las 00:00 en la Zona_Cuenta: el valor por defecto de R11 c2.
 * La fecha sale de PostgreSQL (`AT TIME ZONE`), no del Date de JS.
 */
export async function mananaMedianoche(
  zona: string,
): Promise<{ fecha: string; hora: '00:00' }> {
  const row = await q1<{ fecha: string }>(
    `SELECT ((now() AT TIME ZONE $1)::date + 1)::text AS fecha`,
    [zona],
  );
  if (!row) throw new Error(`mananaMedianoche: la zona ${zona} no es válida para PostgreSQL`);
  return { fecha: row.fecha, hora: '00:00' };
}
