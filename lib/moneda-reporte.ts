/**
 * Moneda de reporte del panel: la unidad en la que se consolida TODO.
 *
 * ─── QUE ES ────────────────────────────────────────────────────────────────
 * Los funnels venden en su moneda local (`funnels.sell_currency`, hoy ARS) y el
 * panel guarda cada venta dos veces: el monto original y el monto convertido a
 * una moneda común. Esa moneda común es la de reporte, y es la que permite
 * sumar ventas de funnels distintos y compararlas contra el gasto de
 * publicidad.
 *
 * ─── POR QUE ES UNA ENV VAR ────────────────────────────────────────────────
 * Este repo lo comparten varias instancias del panel, cada una con su base de
 * datos y su `.env.production`, pero todas deployan del mismo `origin/main`.
 * Hasta ahora la moneda estaba escrita en el código en tres capas distintas
 * (el fetcher de cotizaciones, la conversión que se congela al insertar la
 * venta, y unos 40 lugares de formato), así que no había forma de que dos
 * instancias reportaran en monedas distintas.
 *
 * EL DEFAULT ES 'EUR' A PROPOSITO: es lo que el panel original ya venía
 * haciendo, y tiene años de ventas convertidas y congeladas en euros. Si el
 * default fuera otro, su próximo deploy empezaría a mezclar euros viejos con
 * dólares nuevos en la misma columna, sin que nada falle y sin forma de
 * distinguirlos después.
 *
 * ─── ES `NEXT_PUBLIC_` Y NO DEBERIA SORPRENDER ─────────────────────────────
 * No es un secreto: es un código de moneda de tres letras. Y tiene que llegar
 * al bundle del browser porque los widgets de Ventas, Resumen y Finanzas
 * formatean importes en componentes de cliente. La alternativa era bajarla como
 * prop desde el server hasta cada widget, atravesando cuatro niveles de árbol
 * para transportar una constante.
 *
 * ─── SE HORNEA EN EL BUILD ─────────────────────────────────────────────────
 * Cambiarla requiere un deploy completo, no alcanza con reiniciar el proceso.
 *
 * ─── CAMBIARLA EN UNA INSTANCIA CON HISTORIAL NO ES SOLO ESTO ──────────────
 * Los montos convertidos se congelan en el momento de la ingesta y nunca se
 * recalculan al leer (es a propósito: un reporte de marzo no puede cambiar
 * porque hoy se movió el dólar). Así que en una base que ya tiene ventas hay
 * que además cargar `fx_rates` con el par nuevo para todo el rango histórico y
 * reconvertir `orders`, `ad_spend` y `daily_metrics`. En una base nueva no hay
 * nada que recalcular.
 */

/** Las monedas de reporte soportadas: son las que tienen fetcher implementado. */
export type MonedaReporte = 'EUR' | 'USD';

const SOPORTADAS: readonly MonedaReporte[] = ['EUR', 'USD'];

function resolver(): MonedaReporte {
  const raw = process.env.NEXT_PUBLIC_REPORT_CURRENCY?.trim().toUpperCase();
  if (!raw) return 'EUR';
  if ((SOPORTADAS as readonly string[]).includes(raw)) return raw as MonedaReporte;
  // Un valor no soportado NO cae en silencio al default: sin fetcher para ese
  // par, `fx_rates` quedaría vacía y todas las ventas entrarían con
  // `amount_eur` en NULL. El panel mostraría ceros sin un solo error.
  throw new Error(
    `NEXT_PUBLIC_REPORT_CURRENCY='${raw}' no está soportada (solo ${SOPORTADAS.join(', ')}). ` +
      'Agregar una moneda nueva es implementar su fetcher en lib/fx-fetch.ts.',
  );
}

/** Moneda en la que el panel consolida. */
export const MONEDA_REPORTE: MonedaReporte = resolver();

/**
 * Símbolo corto de la moneda de reporte, para los textos donde no se usa
 * `fmtMoney` (etiquetas de formularios, mensajes de validación, logs de
 * scripts).
 *
 * ES 'US$' Y NO '$' A PROPOSITO: los funnels venden en pesos argentinos, que
 * `Intl` formatea justamente como '$'. Un dólar escrito '$' al lado de un peso
 * escrito '$' hace que dos números que difieren por mil se lean igual.
 *
 * Para importes de verdad usá `fmtMoney(n, MONEDA_REPORTE)`, que respeta el
 * locale y los decimales. Esto es solo para texto.
 */
export const SIMBOLO_REPORTE: string = MONEDA_REPORTE === 'USD' ? 'US$' : '€';

/**
 * Nombre de la columna donde vive el monto convertido.
 *
 * Las columnas se llaman `amount_eur`, `spend_eur`, `revenue_gross_eur` y así.
 * NO se renombran: son 13 columnas en 7 tablas, más los CHECKs de signo de las
 * migraciones 022 y 028 que las nombran, y el nombre de una columna no cambia
 * lo que hay adentro. Lo que cambia es el SIGNIFICADO: con MONEDA_REPORTE='USD',
 * `amount_eur` contiene dólares.
 *
 * Se exporta esta constante para que el lugar donde se explica esto sea uno y
 * no un comentario repetido en cada query.
 */
export const SUFIJO_COLUMNA_REPORTE = 'eur';
