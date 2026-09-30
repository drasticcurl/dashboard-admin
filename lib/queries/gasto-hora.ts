/**
 * El gasto de ads de UN funnel en UN día de Meta, repartido en horas.
 *
 * Puro y sin base: lo llama lib/queries/overview.ts con las lecturas de
 * `ad_spend_hora` (migración 036) y el total del día de `ad_spend`.
 *
 * Las lecturas son el gasto ACUMULADO del día a un instante. Lo que se gastó
 * entre dos lecturas se reparte en proporción al tiempo entre las horas que
 * cubre ese intervalo: con el cron solo (a los :07) una lectura de las 14:07
 * cuenta 53 minutos de gasto de las 13 y 7 de las 14, no todo a las 14.
 *
 * Tres reglas para que las horas SUMEN el total del día:
 *  1. Antes de la primera lectura, el gasto se reparte desde el arranque del
 *     día. Es el caso del día del deploy de la 036 y de cualquier día en que la
 *     primera sync llegó tarde.
 *  2. Sin ninguna lectura (los días anteriores a la 036), el total se reparte
 *     parejo entre las horas que ya pasaron. El usuario lo pidió así: "los
 *     anteriores ya no importan".
 *  3. Lo que falte entre la última lectura y el total (una corrección de Meta
 *     que llegó al día siguiente) se reparte desde la última lectura hasta el
 *     final del día, o hasta ahora si el día es hoy.
 *
 * ── Dos relojes: el día de Meta y el día del panel ─────────────────────────
 *
 * El "día" de `ad_spend` es el de la CUENTA publicitaria (migración 015), que
 * puede no ser el del panel: con la cuenta en Europe/Lisbon y el panel en
 * Buenos Aires, el día de Meta arranca a las 20:00 del día anterior. Antes este
 * archivo arrancaba el día de Meta a las 00:00 del PANEL, y el bug se veía así:
 * todas las lecturas de 20:00 a 23:59 caían antes del "inicio", se aplastaban
 * contra él, y cuatro horas de gasto de ANOCHE aparecían como una sola barra
 * roja enorme a las 00 de hoy. Por eso ahora la cuenta es en dos pasos:
 *
 *   `tramosGastoDelDia` — el gasto del día de Meta como tramos de tiempo
 *                          ABSOLUTO (ms), con el día cortado en la zona de la
 *                          cuenta;
 *   `volcarEnHoras`     — esos tramos, recortados al rango del panel y
 *                          sumados en sus horas de reloj.
 *
 * Un día de Meta queda partido entre dos días del panel, y cada parte va a
 * donde pasó de verdad.
 */

const HORA_MS = 3_600_000;

export type LecturaGasto = { t: number; acum: number };

/** Un monto gastado de forma pareja entre dos instantes (ms). */
export type TramoGasto = { desde: number; hasta: number; monto: number };

/**
 * El gasto de un día de Meta como tramos de tiempo absoluto. Los tramos suman
 * `total` (salvo que `total` sea menor a la última lectura, que es un dato
 * roto de Meta: se respeta lo leído).
 */
export function tramosGastoDelDia(opts: {
  /** Arranque del día de Meta (00:00 en la zona de la cuenta), en ms. */
  inicioMs: number;
  /** Fin del día de Meta (00:00 del día siguiente en esa zona), en ms. */
  finMs: number;
  /** Ahora, en ms: acota el reparto de hoy a lo que ya pasó. */
  ahoraMs: number;
  total: number;
  lecturas: LecturaGasto[];
}): TramoGasto[] {
  const { inicioMs, finMs, ahoraMs, total } = opts;
  const limite = Math.max(inicioMs, Math.min(finMs, ahoraMs));
  const tramos: TramoGasto[] = [];
  const agregar = (monto: number, desde: number, hasta: number): void => {
    if (monto === 0) return;
    // Un monto sin duración (una lectura justo en el arranque, o una corrección
    // de Meta sobre un día que ya cerró) se vuelve un tramo de 1 ms pegado al
    // instante, del lado de ADENTRO del día: si quedara en `finMs` exacto,
    // caería en el día siguiente del panel y el total no cerraría.
    if (hasta <= desde) {
      hasta = Math.max(inicioMs + 1, Math.min(finMs, desde));
      desde = hasta - 1;
    }
    tramos.push({ desde, hasta, monto });
  };

  const ordenadas = [...opts.lecturas].sort((x, y) => x.t - y.t);
  let prevT = inicioMs;
  let prevAcum = 0;
  for (const l of ordenadas) {
    const t = Math.min(finMs, Math.max(inicioMs, l.t));
    agregar(l.acum - prevAcum, prevT, t);
    prevT = t;
    prevAcum = l.acum;
  }
  agregar(total - prevAcum, prevT, Math.max(prevT, limite));
  return tramos;
}

/**
 * Suma los tramos en las horas de reloj del rango del panel. `horas[h]` es la
 * hora h del día (0..23); en un rango de varios días cada hora suma todos. Lo
 * que cae fuera de [rangoInicioMs, rangoFinMs) no se cuenta: es gasto de otro
 * día del panel.
 *
 * La hora de un instante es `floor((t − rangoInicio) / 1h) mod 24`: exacta en
 * zonas sin horario de verano (Argentina). En un día con cambio de hora del
 * panel, una hora queda corrida.
 */
export function volcarEnHoras(
  tramos: TramoGasto[],
  rangoInicioMs: number,
  rangoFinMs: number,
  horas: number[],
): void {
  for (const { desde, hasta, monto } of tramos) {
    const a0 = Math.max(desde, rangoInicioMs);
    const b0 = Math.min(hasta, rangoFinMs);
    if (b0 <= a0) continue;
    const largo = hasta - desde;
    for (let k = Math.floor((a0 - rangoInicioMs) / HORA_MS); k * HORA_MS + rangoInicioMs < b0; k++) {
      const a = Math.max(a0, rangoInicioMs + k * HORA_MS);
      const b = Math.min(b0, rangoInicioMs + (k + 1) * HORA_MS);
      if (b > a) horas[k % 24]! += (monto * (b - a)) / largo;
    }
  }
}

/**
 * Atajo para el caso en que el día de Meta y el del panel coinciden: las 24
 * horas de ese día. Lo usan los tests de las tres reglas.
 */
export function repartirGastoDelDia(opts: {
  /** 00:00 del día, en ms. */
  inicioMs: number;
  ahoraMs: number;
  total: number;
  lecturas: LecturaGasto[];
}): number[] {
  const finMs = opts.inicioMs + 24 * HORA_MS;
  const horas = Array.from({ length: 24 }, () => 0);
  volcarEnHoras(tramosGastoDelDia({ ...opts, finMs }), opts.inicioMs, finMs, horas);
  return horas;
}
