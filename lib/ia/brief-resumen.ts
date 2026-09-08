/**
 * El brief del Resumen: qué le mandamos al modelo sobre los funnels.
 *
 * ─── QUE APORTA QUE LAS 24 TARJETAS NO APORTEN ─────────────────────────────
 * La pantalla ya muestra todos los KPI. Lo que NO muestra, y es lo único que
 * justifica el gasto, son dos cosas que requieren cruzar filas:
 *
 *   · EL EMBUDO COMPARADO. `FunnelSummary` ya trae las conversiones de cada
 *     tramo (sesión → quiz → página de venta → checkout → orden) por funnel, y
 *     nadie las lee en paralelo. Con la mediana del conjunto al lado, "el
 *     checkout de X convierte al 9 % y la mediana es 26 %" localiza el problema
 *     en un tramo en vez de decir "X vende poco".
 *   · LA DESCOMPOSICION DEL CAMBIO. `prev` permite separar si el neto se movió
 *     por tráfico, por conversión o por ticket. Los tres deltas se calculan acá y
 *     el modelo sólo dice cuál manda.
 *
 * ─── FUNCION PURA ──────────────────────────────────────────────────────────
 * `OverviewData` entra, el brief sale. Sin base, sin fetch, testeable. Y sin
 * `generatedAt` ni `lastRollupAt`: son timestamps y romperían la huella (ver
 * lib/ia/brief.ts regla 1). La confiabilidad de los datos viaja como el booleano
 * `datosConfiables`, que es lo que el modelo necesita saber.
 */

import { MONEDA_REPORTE, type MonedaReporte } from '@/lib/moneda-reporte';
import type { OverviewData } from '@/lib/queries/overview';
import { mediana, r2, r2n, r4n, ratio, variacion } from './brief';

/**
 * Piso de sesiones para que un funnel entre en la mediana del conjunto y para
 * que el modelo lo compare.
 *
 * Existe porque un funnel con 4 sesiones y 1 venta tiene una conversión del 25 %
 * que no significa nada, y sin piso ese número entra en la mediana y desplaza la
 * referencia de todos los demás. 200 es arbitrario pero del orden correcto: es
 * suficiente para que un punto porcentual sea distinguible del ruido.
 */
const MIN_SESIONES_COMPARABLE = 200;

export type TramoEmbudo = {
  /** Órdenes ÷ sesiones. El de punta a punta. */
  sesionAOrden: number | null;
  sesionAQuiz: number | null;
  quizAVista: number | null;
  vistaACheckout: number | null;
  checkoutAOrden: number | null;
};

export type FunnelBrief = {
  slug: string;
  nombre: string;
  sesiones: number;
  ordenes: number;
  netoEur: number;
  adsEur: number;
  /** Neto − ads. Negativo = ese funnel está perdiendo plata. */
  resultadoEur: number;
  ticketPromedioEur: number | null;
  cpaEur: number | null;
  roas: number | null;
  margenNeto: number | null;
  tasaDevolucion: number | null;
  ingresoPorSesionEur: number | null;
  embudo: TramoEmbudo;
  /**
   * false cuando el funnel no llega al piso de sesiones. El modelo tiene
   * instrucción de no sacar conclusiones de estos, y va en el brief en vez de
   * filtrarlos porque "hay un funnel con muy poco tráfico" también es
   * información.
   */
  comparable: boolean;
};

export type BriefResumen = {
  pantalla: 'resumen';
  moneda: MonedaReporte;
  rango: { desde: string; hasta: string; dias: number };
  /**
   * false si el rollup tiene más de 30 min. El modelo tiene instrucción de
   * arrancar por esto: analizar los ceros de un cron muerto es peor que no
   * analizar nada.
   */
  datosConfiables: boolean;
  /** Los avisos que la pantalla ya muestra. Contexto para no contradecirla. */
  avisos: { tono: string; texto: string }[];
  totales: {
    sesiones: number;
    ordenes: number;
    netoEur: number;
    brutoEur: number;
    adsEur: number;
    resultadoEur: number;
    ticketPromedioEur: number;
    devueltasEur: number;
    roas: number | null;
    margenNeto: number | null;
    cpaEur: number | null;
    ingresoPorSesionEur: number | null;
    tasaDevolucion: number | null;
    convSesionAOrden: number | null;
    convCheckoutAOrden: number | null;
  };
  /**
   * Los deltas contra el período anterior de igual largo, YA CALCULADOS en tanto
   * por uno. null cuando no hay período anterior (rango 'all') — no se compara
   * contra un cero inventado.
   */
  cambioVsAnterior: {
    netoPct: number | null;
    sesionesPct: number | null;
    ordenesPct: number | null;
    ticketPct: number | null;
    adsPct: number | null;
    resultadoAbsEur: number;
  } | null;
  /**
   * La mediana de cada tramo entre los funnels comparables. Es la referencia
   * contra la que el modelo mide a cada uno; sin esto sólo puede decir si un
   * número le parece alto o bajo, que es opinión y no dato.
   */
  medianasDelConjunto: TramoEmbudo;
  funnels: FunnelBrief[];
  dias: {
    /** Los días del rango con su neto, para que el modelo detecte un día raro. */
    serie: { dia: string; netoEur: number; ordenes: number; sesiones: number }[];
    mejor: { dia: string; netoEur: number } | null;
    peor: { dia: string; netoEur: number } | null;
    sinVentas: number;
  };
};

/** Cuántos días de la serie entran. Un rango de 400 días no aporta 400 puntos. */
const MAX_DIAS_SERIE = 62;

export function armarBriefResumen(
  d: OverviewData,
  rango: { from: string; to: string },
): BriefResumen {
  const funnels: FunnelBrief[] = d.funnels.map((f) => ({
    slug: f.slug,
    nombre: f.name,
    sesiones: f.sessions,
    ordenes: f.orders,
    netoEur: r2(f.netEur),
    adsEur: r2(f.adSpendEur),
    resultadoEur: r2(f.resultEur),
    // Los campos VIEJOS de FunnelSummary devuelven 0 sin denominador por
    // compatibilidad con las vistas (está documentado en overview.ts). Acá se
    // normalizan a null: el brief no puede decirle al modelo que el ROAS fue 0
    // cuando lo que pasa es que no hay gasto cargado.
    ticketPromedioEur: f.orders > 0 ? r2(f.avgTicketEur) : null,
    cpaEur: r2n(f.cpa),
    roas: f.adSpendEur > 0 ? r4n(f.roas) : null,
    margenNeto: r4n(f.netMargin),
    tasaDevolucion: r4n(f.refundRate),
    ingresoPorSesionEur: r2n(f.revPerSession),
    embudo: {
      sesionAOrden: f.sessions > 0 ? r4n(f.convSessionToSale) : null,
      sesionAQuiz: r4n(f.convSessionToQuiz),
      quizAVista: r4n(f.convQuizToSalesView),
      // Este tramo no existe en FunnelSummary y es el que cierra la cadena: sin
      // él, un funnel que trae gente a la página de venta y no la hace clickear
      // es indistinguible de uno que sí y pierde en el checkout.
      vistaACheckout: ratio(f.checkoutClicks, f.salesViews),
      checkoutAOrden: r4n(f.convCheckoutToSale),
    },
    comparable: f.sessions >= MIN_SESIONES_COMPARABLE,
  }));

  const comparables = funnels.filter((f) => f.comparable);
  const medianasDelConjunto: TramoEmbudo = {
    sesionAOrden: mediana(comparables.map((f) => f.embudo.sesionAOrden)),
    sesionAQuiz: mediana(comparables.map((f) => f.embudo.sesionAQuiz)),
    quizAVista: mediana(comparables.map((f) => f.embudo.quizAVista)),
    vistaACheckout: mediana(comparables.map((f) => f.embudo.vistaACheckout)),
    checkoutAOrden: mediana(comparables.map((f) => f.embudo.checkoutAOrden)),
  };

  const t = d.totals;
  const p = d.prev;

  // La serie se recorta desde el FINAL: si el rango es largo, los días que
  // importan son los últimos, no los primeros.
  const serieCompleta = d.byDay.map((x) => ({
    dia: x.day,
    netoEur: r2(x.netEur),
    ordenes: x.orders,
    sesiones: x.sessions,
  }));
  const serie = serieCompleta.slice(-MAX_DIAS_SERIE);

  // El mejor y el peor se calculan sobre la serie COMPLETA, no sobre la
  // recortada: son el dato que ubica un día raro y perderlo por el recorte
  // dejaría al modelo comparando contra un máximo que no es el máximo.
  const conVentas = serieCompleta.filter((x) => x.ordenes > 0);
  const mejor = conVentas.length
    ? conVentas.reduce((a, b) => (b.netoEur > a.netoEur ? b : a))
    : null;
  const peor = conVentas.length
    ? conVentas.reduce((a, b) => (b.netoEur < a.netoEur ? b : a))
    : null;

  return {
    pantalla: 'resumen',
    moneda: MONEDA_REPORTE,
    rango: { desde: rango.from, hasta: rango.to, dias: serieCompleta.length },
    datosConfiables: !d.staleRollup,
    avisos: d.alerts.map((a) => ({ tono: a.tone, texto: a.text })),
    totales: {
      sesiones: t.sessions,
      ordenes: t.orders,
      netoEur: r2(t.netEur),
      brutoEur: r2(t.grossEur),
      adsEur: r2(t.adSpendEur),
      resultadoEur: r2(t.resultEur),
      ticketPromedioEur: r2(t.avgTicketEur),
      devueltasEur: r2(t.refundedEur),
      roas: t.adSpendEur > 0 ? r4n(t.roas) : null,
      margenNeto: r4n(t.netMargin),
      cpaEur: r2n(t.cpa),
      ingresoPorSesionEur: r2n(t.revPerSession),
      tasaDevolucion: r4n(t.refundRate),
      convSesionAOrden: r4n(t.convSessionToSale),
      convCheckoutAOrden: r4n(t.convCheckoutToSale),
    },
    cambioVsAnterior: p
      ? {
          netoPct: variacion(t.netEur, p.netEur),
          sesionesPct: variacion(t.sessions, p.sessions),
          ordenesPct: variacion(t.orders, p.orders),
          ticketPct: variacion(t.avgTicketEur, p.avgTicketEur),
          adsPct: variacion(t.adSpendEur, p.adSpendEur),
          resultadoAbsEur: r2(t.resultEur - p.resultEur),
        }
      : null,
    medianasDelConjunto,
    funnels,
    dias: {
      serie,
      mejor: mejor ? { dia: mejor.dia, netoEur: mejor.netoEur } : null,
      peor: peor ? { dia: peor.dia, netoEur: peor.netoEur } : null,
      sinVentas: serieCompleta.filter((x) => x.ordenes === 0).length,
    },
  };
}

/**
 * Las instrucciones del Resumen. Van separadas del brief porque son estables: el
 * mismo texto para todas las corridas, así del lado de OpenAI se puede cachear el
 * prefijo y del nuestro se puede diffear qué cambió cuando la salida empeora.
 *
 * Las reglas negativas son la mitad del prompt y no son decorativas: sin ellas la
 * salida por defecto de cualquier modelo sobre un dashboard es un párrafo
 * felicitando por el crecimiento con dos números pegados.
 */
export const INSTRUCCIONES_RESUMEN = `
Sos un analista de performance de e-commerce mirando el panel de una operación de
funnels con tráfico pago. Te paso un JSON con los números YA CALCULADOS de un
período. Devolvés entre 2 y 4 observaciones, la más importante primero.

QUE BUSCAR, en este orden de prioridad:
1. Si "datosConfiables" es false o hay avisos de tono "bad": eso va PRIMERO y
   decís explícitamente que el resto de los números puede no ser confiable.
2. Funnels con "resultadoEur" negativo: gastan más de lo que dejan. Decí cuánto.
3. Dónde pierde cada funnel, comparando su "embudo" contra
   "medianasDelConjunto". Un tramo muy por debajo de la mediana localiza el
   problema (el checkout, la página de venta, el quiz) en vez de decir que el
   funnel "va mal". Es la observación más valiosa que podés dar.
4. Si hay "cambioVsAnterior": descomponé el movimiento. ¿Se movió el tráfico
   ("sesionesPct"), la conversión ("convSesionAOrden") o el ticket
   ("ticketPct")? Nombrá cuál explica el cambio del neto.
5. Un día de "dias.serie" claramente fuera de escala.

REGLAS QUE NO SE NEGOCIAN:
- NO calcules nada. Todos los números que necesitás están en el JSON. Si un
  número que querés citar no está, no menciones ese número.
- null significa "no se puede calcular por falta de denominador", NO cero. Nunca
  digas que un ratio en null "es 0 %" ni "cayó".
- Los ratios vienen en tanto por uno: 0.0432 es 4,32 %. Escribilos como
  porcentaje en el texto.
- Los montos están en la moneda del campo "moneda". Usá ESE código, no asumas
  euros ni dólares.
- Ignorá los funnels con "comparable": false para sacar conclusiones. Si querés
  mencionarlos, es sólo para decir que no tienen tráfico suficiente.
- Si el período no tiene datos suficientes (sin sesiones, sin órdenes, sin gasto),
  devolvé UNA sola observación de tono "info" diciendo exactamente eso. No
  rellenes.
- Nada de felicitaciones, nada de "seguí así", nada de consejos genéricos de
  marketing. Si no tenés una recomendación anclada en un número del JSON, no des
  recomendación.
- En "evidencia" listá las métricas del JSON en las que te apoyás, con el valor
  EXACTO como figura ahí. Se valida contra el JSON; una cita que no coincide se
  descarta.

FORMATO: castellano rioplatense, directo, sin jerga de consultor. El título es
una línea. El cuerpo, dos o tres oraciones.
Tonos: "bad" sólo para plata que se pierde o datos inusables. "warn" para algo
que hay que mirar. "good" para una mejora real y medida. "info" para el resto.
`.trim();
