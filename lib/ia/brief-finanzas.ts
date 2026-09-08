/**
 * El brief de Finanzas: qué le mandamos al modelo sobre la plata.
 *
 * ─── LO QUE JUSTIFICA ESTE BRIEF ES LA RECONCILIACION ──────────────────────
 * `lib/queries/reconciliacion.ts` compara la ganancia MEDIDA (los saldos que el
 * usuario tipea) contra la OPERATIVA (las ventas y el gasto de ads que entraron
 * solos). Son dos caminos que no se tocan, y el hueco entre ellos es el único
 * chequeo del panel capaz de detectar una venta que nunca llegó o un gasto que
 * nadie cargó.
 *
 * El hueco lo calculamos nosotros. Lo que el modelo aporta es la lectura: si
 * alterna de signo entre meses es timing (una venta del 31 que entra al banco el
 * 2) y si se acumula en el mismo sentido es algo que falta registrar. Esa
 * distinción está precalculada en `huecos.rachaMismoSigno` justamente para que no
 * la tenga que deducir sumando.
 *
 * ─── FUNCION PURA ──────────────────────────────────────────────────────────
 * Recibe lo que las pantallas ya cargan, devuelve el brief. La única fecha que
 * entra es `hoy` (día, sin hora): cambia una vez por día, que es la cadencia de
 * regeneración que queremos. Un timestamp rompería la huella (lib/ia/brief.ts).
 */

import { MONEDA_REPORTE, type MonedaReporte } from '@/lib/moneda-reporte';
import type { FinanceMovement, ScheduledPayment } from '@/lib/queries/finance';
import type { ReconciliacionMes } from '@/lib/queries/reconciliacion';
import type { PatrimonioDia, PuntoDiario } from '@/lib/queries/saldo';
import { r2, r2n, ratio, variacion } from './brief';

export type MesBrief = {
  mes: string;
  gananciaMedidaEur: number | null;
  resultadoOperativoEur: number;
  gastosEur: number;
  esperadoEur: number;
  huecoEur: number | null;
  huecoPct: number | null;
  ajustesEur: number;
  retirosEur: number;
  aportesEur: number;
  cierreEur: number | null;
  /** false = al mes le falta un cierre completo y su ganancia no se pudo medir. */
  medido: boolean;
};

export type BriefFinanzas = {
  pantalla: 'finanzas';
  moneda: MonedaReporte;
  hoy: string;
  /**
   * TODO el bloque es null cuando nunca se completó un día de carga, en vez de
   * un objeto con ceros. Es la misma forma que `FinanceOverview.desglose` y por
   * el mismo motivo: un `dineroEur: 0` inventado es indistinguible de una cuenta
   * realmente vacía, y el modelo lo leería como "no hay plata" cuando lo que
   * pasa es que nadie cargó los saldos.
   */
  patrimonio: {
    /** null = el último día completo existe pero su total no se pudo calcular. */
    totalEur: number | null;
    /** De qué día es la foto. Sin esto el número no significa nada. */
    dia: string;
    dineroEur: number;
    retenidoEur: number;
    /** POSITIVO: es cuánto se debe. El total lo resta. */
    deudaEur: number;
    /** Retenido ÷ (dinero + retenido): qué parte de la plata propia no se puede tocar. */
    proporcionRetenido: number | null;
    /** Deuda ÷ dinero: cuántas veces la deuda entra en lo líquido. */
    deudaSobreLiquido: number | null;
  } | null;
  completitud: {
    /** Cuentas vigentes hoy sin saldo cargado. Si hay, la foto de hoy no existe. */
    faltanCargarHoy: string[];
    /** Días del mes en curso sin patrimonio completo. La serie no es comparable. */
    diasIncompletosDelMes: number;
    diasDelMesTranscurridos: number;
  };
  meses: MesBrief[];
  huecos: {
    /** Suma de los huecos medibles. Si tiende a 0, los meses se compensan: timing. */
    acumuladoEur: number | null;
    /** Meses consecutivos (desde el más nuevo) con el hueco del mismo signo. */
    rachaMismoSigno: number;
    /** Cuántos meses del período no se pudieron medir. */
    mesesSinMedir: number;
  };
  gastos: {
    /** Promedio mensual sobre los meses CERRADOS. El mes en curso está a medias. */
    promedioMensualEur: number | null;
    /** Dinero líquido ÷ gasto promedio: cuántos meses aguanta. null sin gasto. */
    runwayMeses: number | null;
    /**
     * Por categoría: los últimos 3 meses cerrados contra los 3 anteriores, con la
     * variación ya calculada. Es lo que detecta un gasto que se fue subiendo de a
     * poco sin que nadie lo note.
     */
    porCategoria: {
      categoria: string;
      recientesEur: number;
      previosEur: number;
      variacionPct: number | null;
    }[];
  };
  pagosAtrasados: { nombre: string; montoEur: number; diaDelMes: number }[];
};

/** Cuántos meses cerrados entran en cada mitad de la comparación de gastos. */
const VENTANA_CATEGORIAS = 3;

export function armarBriefFinanzas(e: {
  hoy: string;
  reconciliacion: ReconciliacionMes[];
  ultimoPatrimonio: PatrimonioDia | null;
  faltanCargarHoy: string[];
  serieDelMes: PuntoDiario[];
  movimientos: FinanceMovement[];
  atrasados: ScheduledPayment[];
}): BriefFinanzas {
  const p = e.ultimoPatrimonio;
  // `dinero` queda null cuando no hay foto: es el denominador del runway, y un 0
  // acá haría que el runway diera 0 meses sobre una empresa que sólo no cargó los
  // saldos todavía.
  const dinero = p === null ? null : r2(p.dineroEur);

  const meses: MesBrief[] = e.reconciliacion.map((m) => ({
    mes: m.month,
    gananciaMedidaEur: r2n(m.gananciaMedidaEur),
    resultadoOperativoEur: m.resultadoOperativoEur,
    gastosEur: m.gastosEur,
    esperadoEur: m.esperadoEur,
    huecoEur: r2n(m.huecoEur),
    huecoPct: m.huecoPct === null ? null : Math.round(m.huecoPct * 10_000) / 10_000,
    ajustesEur: r2(m.ajustesEur),
    retirosEur: r2(m.retirosEur),
    aportesEur: r2(m.aportesEur),
    cierreEur: r2n(m.cierreEur),
    medido: m.gananciaMedidaEur !== null,
  }));

  // El mes en curso se excluye de todo promedio: está a medias por definición y
  // arrastra el promedio para abajo, que es como un runway falsamente optimista
  // se vuelve creíble.
  const mesActual = e.hoy.slice(0, 7);
  const cerrados = meses.filter((m) => m.mes !== mesActual);

  const conHueco = meses.filter((m) => m.huecoEur !== null);
  const acumuladoEur = conHueco.length
    ? r2(conHueco.reduce((a, m) => a + (m.huecoEur ?? 0), 0))
    : null;

  const gastosCerrados = cerrados.map((m) => m.gastosEur);
  const promedioMensualEur = gastosCerrados.length
    ? r2(gastosCerrados.reduce((a, b) => a + b, 0) / gastosCerrados.length)
    : null;

  return {
    pantalla: 'finanzas',
    moneda: MONEDA_REPORTE,
    hoy: e.hoy,
    patrimonio:
      p === null
        ? null
        : {
            totalEur: r2n(p.totalEur),
            dia: p.day,
            dineroEur: r2(p.dineroEur),
            retenidoEur: r2(p.retenidoEur),
            deudaEur: r2(p.deudaEur),
            proporcionRetenido: ratio(p.retenidoEur, p.dineroEur + p.retenidoEur),
            deudaSobreLiquido: ratio(p.deudaEur, p.dineroEur),
          },
    completitud: {
      faltanCargarHoy: e.faltanCargarHoy,
      // `totalEur === null` es exactamente la definición de día incompleto en
      // `saldo.ts` (D5): un día al que le falta una cuenta no tiene patrimonio.
      diasIncompletosDelMes: e.serieDelMes.filter((d) => d.totalEur === null).length,
      diasDelMesTranscurridos: e.serieDelMes.length,
    },
    meses,
    huecos: {
      acumuladoEur,
      rachaMismoSigno: contarRacha(meses),
      mesesSinMedir: meses.filter((m) => !m.medido).length,
    },
    gastos: {
      promedioMensualEur,
      // Dinero LIQUIDO, no patrimonio: el retenido no paga el alquiler y la
      // deuda todavía menos. Usar el total daría un runway que no existe.
      //
      // Los tres null se propagan: sin saldos cargados o sin historial de gastos
      // no hay runway que calcular, y "0 meses" es la afirmación más alarmante
      // que el panel puede hacer — no se dice por falta de datos.
      runwayMeses:
        dinero === null || promedioMensualEur === null || promedioMensualEur === 0
          ? null
          : Math.round((dinero / promedioMensualEur) * 10) / 10,
      porCategoria: compararCategorias(e.movimientos, cerrados.map((m) => m.mes)),
    },
    pagosAtrasados: e.atrasados.map((a) => ({
      nombre: a.name,
      montoEur: r2(a.amountEur),
      diaDelMes: a.dayOfMonth,
    })),
  };
}

/**
 * Cuántos meses consecutivos, contando desde el más reciente, tienen el hueco del
 * mismo signo.
 *
 * Es el discriminador entre "timing" y "algo falta". Un desfase de fechas hace
 * que el hueco de un mes aparezca invertido en el siguiente, así que la racha
 * queda en 1. Un gasto que nunca se registra empuja siempre para el mismo lado y
 * la racha crece. Se precalcula porque deducirlo requiere comparar signos de una
 * lista, que es justo lo que no le queremos pedir al modelo.
 *
 * Los meses sin medir CORTAN la racha: no se puede afirmar continuidad
 * atravesando un mes del que no se sabe nada.
 */
function contarRacha(meses: MesBrief[]): number {
  let racha = 0;
  let signo: number | null = null;
  for (let i = meses.length - 1; i >= 0; i--) {
    const h = meses[i]!.huecoEur;
    if (h === null || h === 0) break;
    const s = Math.sign(h);
    if (signo === null) signo = s;
    else if (s !== signo) break;
    racha++;
  }
  return racha;
}

/**
 * Los gastos por categoría, últimos 3 meses cerrados contra los 3 anteriores.
 *
 * `mesesCerrados` llega ordenado del más viejo al más nuevo. Se agrupa en TS y no
 * en SQL porque los movimientos ya están cargados en la pantalla: una query más
 * para reagrupar lo que ya está en memoria es un viaje a la base de gratis.
 */
function compararCategorias(
  movimientos: FinanceMovement[],
  mesesCerrados: string[],
): BriefFinanzas['gastos']['porCategoria'] {
  const recientes = new Set(mesesCerrados.slice(-VENTANA_CATEGORIAS));
  const previos = new Set(
    mesesCerrados.slice(-VENTANA_CATEGORIAS * 2, -VENTANA_CATEGORIAS),
  );

  const acc = new Map<string, { recientes: number; previos: number }>();
  for (const m of movimientos) {
    if (m.kind !== 'gasto') continue;
    const mes = m.day.slice(0, 7);
    const enRecientes = recientes.has(mes);
    const enPrevios = previos.has(mes);
    if (!enRecientes && !enPrevios) continue;

    // 'otros' y no null: `category` es nullable en la tabla y una clave null
    // colapsaría con la de un gasto sin categoría de otra época.
    const cat = m.category ?? 'otros';
    const actual = acc.get(cat) ?? { recientes: 0, previos: 0 };
    // Los gastos están guardados NEGATIVOS: se compara la magnitud, porque
    // "subió el gasto" con números negativos se lee al revés.
    const monto = Math.abs(m.amountEur);
    if (enRecientes) actual.recientes += monto;
    else actual.previos += monto;
    acc.set(cat, actual);
  }

  return [...acc.entries()]
    .map(([categoria, v]) => ({
      categoria,
      recientesEur: r2(v.recientes),
      previosEur: r2(v.previos),
      variacionPct: variacion(v.recientes, v.previos === 0 ? null : v.previos),
    }))
    .sort((a, b) => b.recientesEur - a.recientesEur);
}

export const INSTRUCCIONES_FINANZAS = `
Sos un analista financiero mirando el panel de una operación chica de e-commerce.
Te paso un JSON con los números YA CALCULADOS. Devolvés entre 2 y 4
observaciones, la más importante primero.

CONTEXTO QUE TENES QUE ENTENDER PARA NO DECIR PAVADAS:
- El patrimonio se MIDE: el usuario tipea a mano el saldo de cada cuenta una vez
  por día. No está calculado a partir de las ventas.
- "meses[].huecoEur" es la diferencia entre la ganancia MEDIDA (de esos saldos) y
  la ganancia ESPERADA (ventas − ads − gastos). Son dos caminos independientes,
  así que el hueco es la señal más importante del JSON.
- UN HUECO CHICO ES NORMAL. Causas conocidas: una venta de fin de mes que entra
  al banco el mes siguiente, plata retenida en Mercado Pago, la deuda con Meta que
  se paga después, devoluciones de meses anteriores.
- LO QUE IMPORTA ES EL PATRON, y está precalculado en "huecos": si
  "rachaMismoSigno" es 1 o 2, es timing y NO hay que alarmar. Si es 3 o más, o si
  "acumuladoEur" es grande y no tiende a cero, hay algo que no se está
  registrando. Decilo con esas palabras.
- Si "meses[].ajustesEur" es parecido al hueco de ese mes, el hueco ya estaba
  reconocido por el usuario. Mencionalo.

QUE BUSCAR, en orden:
1. Si "completitud.faltanCargarHoy" no está vacío o "diasIncompletosDelMes" es
   alto: eso va PRIMERO. Sin saldos cargados los números de abajo no se sostienen.
2. El patrón de huecos (ver arriba).
3. "gastos.runwayMeses": cuántos meses aguanta lo líquido al ritmo de gasto
   actual. Si es bajo, cruzalo con "patrimonio.deudaSobreLiquido".
4. "patrimonio.proporcionRetenido" alto: hay plata propia que no se puede usar, y
   el patrimonio total lo esconde.
5. "gastos.porCategoria": una categoría que subió fuerte contra los 3 meses
   anteriores.
6. Pagos atrasados, si hay.

REGLAS QUE NO SE NEGOCIAN:
- NO calcules nada. Todo está en el JSON. Si el número no está, no lo menciones.
- null significa "no se pudo medir", NO cero. Si "patrimonio" es null, nunca se
  completó un día de carga: NO digas que no hay plata, decí que faltan saldos.
  Lo mismo con "runwayMeses": null no es "cero meses de runway".
- Los montos están en la moneda del campo "moneda". Usá ESE código.
- Los ratios vienen en tanto por uno: 0.32 es 32 %.
- "deudaEur" es POSITIVO y representa lo que se DEBE.
- Si no hay meses medidos ("huecos.mesesSinMedir" igual a la cantidad de meses),
  devolvé UNA observación de tono "info" diciendo que falta cargar saldos para
  poder analizar. No rellenes.
- Nada de consejos financieros genéricos ni de felicitaciones. Si no tenés una
  recomendación anclada en un número del JSON, no des recomendación.
- En "evidencia" listá las métricas del JSON en las que te apoyás, con el valor
  EXACTO como figura ahí. Se valida; una cita que no coincide se descarta.

FORMATO: castellano rioplatense, directo. El título es una línea. El cuerpo, dos
o tres oraciones.
Tonos: "bad" sólo para plata que se pierde o datos inusables. "warn" para algo que
hay que mirar. "good" para una mejora real y medida. "info" para el resto.
`.trim();
