import { q1 } from './db';

export type RangePreset = 'today' | 'yesterday' | '7d' | '14d' | '30d' | 'mtd' | 'all';

/**
 * El corte del día es la fuente de bugs número uno de este tipo de panel, y
 * toda la aritmética de fechas se hace en SQL con `AT TIME ZONE`: hacer "hace
 * 7 días" con el Date de JS sobre una TZ distinta a la del server te corre un
 * día en el horario de verano y nadie se da cuenta.
 */

/** El día local de un funnel para un instante. Se resuelve en Postgres, no en JS. */
export async function localDay(at: Date, timezone: string): Promise<string> {
  const row = await q1<{ day: string }>(
    `SELECT ($1::timestamptz AT TIME ZONE $2)::date::text AS day`,
    [at.toISOString(), timezone],
  );
  return row!.day;
}

/** Hoy en una TZ, como 'YYYY-MM-DD'. */
export async function today(timezone: string): Promise<string> {
  const row = await q1<{ day: string }>(
    `SELECT (now() AT TIME ZONE $1)::date::text AS day`,
    [timezone],
  );
  return row!.day;
}

// Desplazamiento de días sobre una fecha ya resuelta: es aritmética de `date`
// (que no tiene zona horaria), así que un cambio de DST no la puede correr.
async function shift(day: string, days: number): Promise<string> {
  const row = await q1<{ day: string }>(
    `SELECT ($1::date + $2::int)::text AS day`,
    [day, days],
  );
  return row!.day;
}

/** Presets del selector de rango → { from, to } en la TZ dada. */
export async function resolveRange(
  preset: RangePreset,
  timezone: string,
): Promise<{ from: string; to: string }> {
  const to = await today(timezone);
  switch (preset) {
    case 'today':
      return { from: to, to };
    case 'yesterday': {
      const yesterday = await shift(to, -1);
      return { from: yesterday, to: yesterday };
    }
    case '7d':
      return { from: await shift(to, -6), to };
    case '14d':
      return { from: await shift(to, -13), to };
    case '30d':
      return { from: await shift(to, -29), to };
    case 'mtd': {
      // date_trunc devuelve timestamp y a texto arrastra ' 00:00:00': el
      // ::date intermedio es el que deja la forma 'YYYY-MM-DD'.
      const row = await q1<{ from: string }>(
        `SELECT date_trunc('month', $1::date)::date::text AS from`,
        [to],
      );
      return { from: row!.from, to };
    }
    case 'all':
      return { from: '2000-01-01', to };
  }
}
