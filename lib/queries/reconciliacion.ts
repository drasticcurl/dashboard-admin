/**
 * Reconciliación mensual: la ganancia MEDIDA contra la ganancia OPERATIVA.
 *
 * ─── QUE ES ────────────────────────────────────────────────────────────────
 * El panel tiene dos formas independientes de contestar "cuánto ganamos este
 * mes", y hasta ahora nunca se compararon entre sí porque viven en módulos
 * distintos:
 *
 *   1. MEDIDA (`lib/queries/saldo.ts:serieMensual`) — sale de los saldos que el
 *      usuario tipea mirando sus cuentas: Δpatrimonio − retiros − aportes.
 *      No depende de que ninguna venta se haya registrado bien.
 *   2. OPERATIVA (`daily_metrics`) — sale de las ventas y el gasto de ads que
 *      entraron por el webhook y por la API de Meta: neto − ads.
 *      No depende de que el usuario haya cargado ningún saldo.
 *
 * Las dos miden lo mismo por caminos que no se tocan. Si no coinciden, hay algo
 * que no está registrado en alguno de los dos lados, y ESO es el dato: es el
 * único chequeo del panel que puede detectar una venta que nunca llegó, un gasto
 * que nadie cargó o un saldo mal tipeado.
 *
 * ─── LA IDENTIDAD ──────────────────────────────────────────────────────────
 * Partiendo de qué compone el cambio de patrimonio de un mes:
 *
 *   Δpatrimonio = neto − ads + Σ(movimientos con signo)
 *
 * y sabiendo que `serieMensual` ya le descuenta los retiros y los aportes
 * (`ganancia = Δ − retiros − aportes`, con los retiros guardados negativos y los
 * aportes positivos), los movimientos que quedan adentro son los gastos:
 *
 *   ganancia ≈ (neto − ads) − |gastos|
 *            = resultadoOperativoEur − gastosEur
 *
 * El `≈` es literal y es medio módulo: ver "POR QUE NO CIERRA EXACTO" abajo.
 *
 * ─── LOS AJUSTES QUEDAN AFUERA DEL HUECO, A PROPOSITO ──────────────────────
 * Un movimiento `ajuste` NO mueve plata real: es el usuario corrigiendo la
 * contabilidad. Como el patrimonio ahora se MIDE (migración 028), un ajuste no
 * cambia `Δpatrimonio`, así que meterlo en el lado esperado de la identidad
 * inventaría un hueco que no existe.
 *
 * Pero tampoco se ignora: se devuelve en `ajustesEur` justamente para que quien
 * lea el hueco pueda ver si los ajustes lo explican. Si `huecoEur ≈ ajustesEur`,
 * el hueco ya estaba reconocido y alguien lo anotó.
 *
 * ─── POR QUE NO CIERRA EXACTO Y ESO NO ES UN BUG ───────────────────────────
 * Un hueco chico es normal y tiene causas conocidas. No las corrijas acá:
 *
 *   · Timing. Una venta del 31 que entra al banco el 2 está en el neto de este
 *     mes y en el patrimonio del que viene. Es la causa más común y la que hace
 *     que el hueco de un mes aparezca con el signo opuesto en el siguiente.
 *   · `retenido`. La plata en Mercado Pago cuenta en el patrimonio pero se
 *     libera después; un mes que retiene más de lo habitual abre hueco.
 *   · La deuda con Meta. El gasto de ads se registra el día que Meta lo reporta,
 *     y el patrimonio lo refleja como deuda hasta que se paga.
 *   · Devoluciones de un mes anterior, que bajan el neto de este.
 *
 * Lo que SÍ es señal es un hueco grande, o uno que crece mes a mes en el mismo
 * sentido en vez de alternar el signo.
 *
 * ─── NULL NO ES CERO ───────────────────────────────────────────────────────
 * `gananciaMedidaEur` es null cuando al mes le falta un cierre completo (el suyo
 * o el del mes anterior), y en ese caso `huecoEur` también es null: no hay con
 * qué comparar. Es el mismo contrato que el resto del módulo de Finanzas y por
 * el mismo motivo — un cero inventado es indistinguible de un cero real.
 */

import { q } from '@/lib/db';
import { serieMensual } from '@/lib/queries/saldo';

export type ReconciliacionMes = {
  /** 'YYYY-MM' */
  month: string;

  // ── Lado MEDIDO (saldos tipeados) ──────────────────────────────────────
  /** Δpatrimonio − retiros − aportes. null si falta el cierre del mes o del anterior. */
  gananciaMedidaEur: number | null;
  /** Patrimonio del último día COMPLETO del mes. null si no hubo ninguno. */
  cierreEur: number | null;
  /** De qué día es ese cierre. Sin esto el número no significa nada. */
  diaCierre: string | null;

  // ── Lado OPERATIVO (daily_metrics) ─────────────────────────────────────
  /** Neto − ads del mes. La misma definición que el Resumen. */
  resultadoOperativoEur: number;
  /** Bruto − devoluciones − comisiones − costos. */
  netoEur: number;
  adsEur: number;

  // ── Movimientos del mes ────────────────────────────────────────────────
  /** MAGNITUD de los gastos (positiva). En la base están guardados negativos. */
  gastosEur: number;
  /** Con signo: los retiros son <= 0. */
  retirosEur: number;
  /** Con signo: los aportes son >= 0. */
  aportesEur: number;
  /** Con signo, cualquier dirección. Queda FUERA del hueco (ver cabecera). */
  ajustesEur: number;

  // ── La comparación ─────────────────────────────────────────────────────
  /** resultadoOperativoEur − gastosEur: lo que el patrimonio debería haber subido. */
  esperadoEur: number;
  /** medido − esperado. null si no hay medición. Positivo = subió más de lo explicable. */
  huecoEur: number | null;
  /** hueco ÷ |esperado|, en tanto por uno. null sin medición o con esperado 0. */
  huecoPct: number | null;
};

/**
 * La aritmética, aislada y sin base para poder testearla. Recibe los seis
 * números que salen de las tres queries y devuelve los tres derivados.
 *
 * `gastosSignedEur` entra tal como está en la base (negativo) y sale como
 * magnitud en `gastosEur`: la conversión vive acá y no en el SQL para que el
 * signo se resuelva en un solo lugar, igual que `applySign` en `finance.ts`.
 */
export function calcularHueco(e: {
  gananciaMedidaEur: number | null;
  netoEur: number;
  adsEur: number;
  gastosSignedEur: number;
}): {
  resultadoOperativoEur: number;
  gastosEur: number;
  esperadoEur: number;
  huecoEur: number | null;
  huecoPct: number | null;
} {
  const resultadoOperativoEur = redondear(e.netoEur - e.adsEur);
  const gastosEur = redondear(Math.abs(e.gastosSignedEur));
  const esperadoEur = redondear(resultadoOperativoEur - gastosEur);

  // null se propaga: sin medición no hay comparación posible. Nunca 0.
  const huecoEur =
    e.gananciaMedidaEur === null ? null : redondear(e.gananciaMedidaEur - esperadoEur);

  // El denominador es el VALOR ABSOLUTO del esperado: con un esperado negativo
  // (un mes que perdió plata), dividir por el valor con signo invierte la
  // lectura y un hueco a favor aparecería como negativo.
  const huecoPct =
    huecoEur === null || esperadoEur === 0 ? null : huecoEur / Math.abs(esperadoEur);

  return { resultadoOperativoEur, gastosEur, esperadoEur, huecoEur, huecoPct };
}

/**
 * Dos decimales. Las columnas son `numeric(14,2)` y las sumas se hacen en SQL,
 * pero las RESTAS entre resultados de queries distintas pasan por el float de
 * JS: sin esto, 4200.5 − 1100.3 deja 3100.1999999999998 y el hueco de un mes que
 * cierra perfecto se muestra como un número raro.
 */
function redondear(n: number): number {
  return Math.round(n * 100) / 100;
}

const MONEY = (v: string): number => Number(v);

type OperativoRow = { month: string; netoEur: string; adsEur: string };

// La definición del neto es la MISMA que SUMMARY_SQL en overview.ts (bruto −
// devoluciones − comisiones − costos) y tiene que seguir siéndolo: si las dos
// difieren, la reconciliación reporta un hueco que sólo existe porque el panel
// mide el neto de dos formas. Si tocás una, tocá la otra.
const OPERATIVO_POR_MES_SQL = `
  SELECT to_char(day, 'YYYY-MM') AS month,
         (COALESCE(SUM(revenue_gross_eur), 0)
        - COALESCE(SUM(revenue_refunded_eur), 0)
        - COALESCE(SUM(commissions_eur), 0)
        - COALESCE(SUM(costs_eur), 0))::text AS "netoEur",
         COALESCE(SUM(ad_spend_eur), 0)::text AS "adsEur"
  FROM daily_metrics
  WHERE variant = '*'
    AND day >= $1::date
    AND day < ($2::date + interval '1 month')
  GROUP BY 1`;

type MovimientosRow = { month: string; gastosEur: string; ajustesEur: string };

// Sólo gastos y ajustes: los retiros y los aportes ya vienen de `serieMensual`,
// que es donde se descuentan de la ganancia. Pedirlos otra vez acá sería tener
// dos lugares que suman lo mismo.
const MOVIMIENTOS_POR_MES_SQL = `
  SELECT to_char(day, 'YYYY-MM') AS month,
         COALESCE(SUM(amount_eur) FILTER (WHERE kind = 'gasto'), 0)::text  AS "gastosEur",
         COALESCE(SUM(amount_eur) FILTER (WHERE kind = 'ajuste'), 0)::text AS "ajustesEur"
  FROM finance_movements
  WHERE day >= $1::date
    AND day < ($2::date + interval '1 month')
  GROUP BY 1`;

/**
 * Los últimos `meses` meses reconciliados, del más viejo al más nuevo.
 *
 * El lado medido se le pide a `serieMensual()` en vez de reimplementar el CTE
 * del patrimonio: ese CTE está escrito una sola vez a propósito (ver la cabecera
 * de `saldo.ts`) y `finance.ts` tiene un comentario explícito pidiendo que no se
 * reimplemente contra las tablas nuevas.
 */
export async function reconciliarMeses(meses: number): Promise<ReconciliacionMes[]> {
  if (!Number.isInteger(meses) || meses < 1) {
    throw new Error(`meses inválido: ${meses} (se espera un entero >= 1)`);
  }

  const medido = await serieMensual(meses);
  if (medido.length === 0) return [];

  // El rango de las dos queries se deriva de los meses que devolvió
  // `serieMensual`, no de un `now()` propio: así las tres lecturas hablan del
  // mismo período y del mismo "hoy" resuelto en DASHBOARD_TZ.
  const desde = `${medido[0]!.month}-01`;
  const hasta = `${medido[medido.length - 1]!.month}-01`;

  const [operativoRows, movimientosRows] = await Promise.all([
    q<OperativoRow>(OPERATIVO_POR_MES_SQL, [desde, hasta]),
    q<MovimientosRow>(MOVIMIENTOS_POR_MES_SQL, [desde, hasta]),
  ]);

  const operativoPorMes = new Map(operativoRows.map((r) => [r.month, r]));
  const movimientosPorMes = new Map(movimientosRows.map((r) => [r.month, r]));

  return medido.map((m) => {
    const op = operativoPorMes.get(m.month);
    const mov = movimientosPorMes.get(m.month);

    // Un mes sin filas en daily_metrics o sin movimientos es un 0 REAL, no un
    // dato faltante: significa que no hubo ventas ni gastos ese mes. Es el
    // único lugar de este archivo donde un `?? 0` es correcto, y por eso está
    // acotado a estas tres líneas en vez de aplicarse al objeto entero.
    const netoEur = op ? MONEY(op.netoEur) : 0;
    const adsEur = op ? MONEY(op.adsEur) : 0;
    const gastosSignedEur = mov ? MONEY(mov.gastosEur) : 0;
    const ajustesEur = mov ? MONEY(mov.ajustesEur) : 0;

    const calc = calcularHueco({
      gananciaMedidaEur: m.gananciaEur,
      netoEur,
      adsEur,
      gastosSignedEur,
    });

    return {
      month: m.month,
      gananciaMedidaEur: m.gananciaEur,
      cierreEur: m.cierreEur,
      diaCierre: m.diaCierre,
      netoEur,
      adsEur,
      retirosEur: m.retirosEur,
      aportesEur: m.aportesEur,
      ajustesEur,
      ...calc,
    };
  });
}
