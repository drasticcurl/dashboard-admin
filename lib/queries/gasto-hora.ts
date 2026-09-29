/**
 * El gasto de ads de UN funnel en UN día, repartido en sus 24 horas.
 *
 * Puro y sin base: lo llama lib/queries/overview.ts con las lecturas de
 * `ad_spend_hora` (migración 036) y el total del día de `ad_spend`.
 *
 * Las lecturas son el gasto ACUMULADO del día a un instante. Lo que se gastó
 * entre dos lecturas se reparte en proporción al tiempo entre las horas que
 * cubre ese intervalo: con el cron solo (a los :07) una lectura de las 14:07
 * cuenta 53 minutos de gasto de las 13 y 7 de las 14, no todo a las 14.
 *
 * Tres reglas para que las 24 horas SUMEN el total del día (y el resultado por
 * hora cierre con el KPI de Resultado):
 *  1. Antes de la primera lectura, el gasto se reparte desde las 00:00. Es el
 *     caso del día del deploy de la 036 y de cualquier día en que la primera
 *     sync llegó tarde.
 *  2. Sin ninguna lectura (los días anteriores a la 036), el total se reparte
 *     parejo entre las horas que ya pasaron. El usuario lo pidió así: "los
 *     anteriores ya no importan".
 *  3. Lo que falte entre la última lectura y el total (una corrección de Meta
 *     que llegó al día siguiente) se reparte desde la última lectura hasta el
 *     final del día, o hasta ahora si el día es hoy.
 *
 * La hora de un instante es `floor((t − inicio) / 1h)`: exacta en zonas sin
 * horario de verano (Argentina). En un día con cambio de hora, una hora queda
 * corrida; el total del día sigue cerrando.
 */

const HORA_MS = 3_600_000;

export type LecturaGasto = { t: number; acum: number };

export function repartirGastoDelDia(opts: {
  /** 00:00 del día en la TZ del dashboard, en ms. */
  inicioMs: number;
  /** Ahora, en ms: acota el reparto de hoy a las horas que ya pasaron. */
  ahoraMs: number;
  /** El gasto total del día (de `ad_spend`). */
  total: number;
  lecturas: LecturaGasto[];
}): number[] {
  const { inicioMs, ahoraMs, total } = opts;
  const finMs = inicioMs + 24 * HORA_MS;
  const limite = Math.max(inicioMs, Math.min(finMs, ahoraMs));
  const horas = Array.from({ length: 24 }, () => 0);

  const horaDe = (t: number): number => Math.min(23, Math.max(0, Math.floor((t - inicioMs) / HORA_MS)));

  function repartir(monto: number, desde: number, hasta: number): void {
    if (monto === 0) return;
    if (hasta <= desde) {
      horas[horaDe(desde)]! += monto;
      return;
    }
    const largo = hasta - desde;
    for (let h = horaDe(desde); h <= horaDe(hasta - 1); h++) {
      const a = Math.max(desde, inicioMs + h * HORA_MS);
      const b = Math.min(hasta, inicioMs + (h + 1) * HORA_MS);
      if (b > a) horas[h]! += (monto * (b - a)) / largo;
    }
  }

  const ordenadas = [...opts.lecturas].sort((x, y) => x.t - y.t);
  let prevT = inicioMs;
  let prevAcum = 0;
  for (const l of ordenadas) {
    const t = Math.min(finMs, Math.max(inicioMs, l.t));
    repartir(l.acum - prevAcum, prevT, t);
    prevT = t;
    prevAcum = l.acum;
  }
  repartir(total - prevAcum, prevT, Math.max(prevT, limite));
  return horas;
}
