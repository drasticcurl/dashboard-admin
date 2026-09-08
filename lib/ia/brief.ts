/**
 * Helpers compartidos por los dos briefs.
 *
 * ─── TRES REGLAS QUE VALEN PARA CUALQUIER BRIEF QUE SE AGREGUE ─────────────
 *
 * 1. NADA DE TIMESTAMPS. La huella del brief es la caché (ver la migración 029):
 *    si adentro hay un `generatedAt`, un `now()` o un reloj, la huella cambia en
 *    cada llamada, la caché deja de existir y nadie se entera hasta que llega la
 *    factura. Una FECHA ('2026-09-04') sí se puede: cambia una vez por día, que
 *    es exactamente la cadencia que queremos.
 *
 * 2. TODO NUMERO YA CALCULADO. El modelo interpreta, no hace aritmética. Los
 *    LLM son malos sumando y no hay forma de auditar una resta que hicieron
 *    adentro del párrafo. Si un insight necesita un delta, un porcentaje o una
 *    mediana, se calcula acá y se le pasa hecho.
 *
 * 3. `null` VA COMO `null`. Está prohibido el `?? 0` (la misma regla que
 *    documenta `FinanceOverview` en finance.ts). Si le mandás 0 donde no había
 *    dato, el modelo escribe con total seguridad que el margen fue del 0 %.
 *    El prompt le explica qué significa null; el brief tiene que decir la verdad.
 */

/** Dos decimales, para plata. */
export function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Dos decimales o null. Nunca convierte null en 0. */
export function r2n(n: number | null): number | null {
  return n === null ? null : r2(n);
}

/**
 * Cuatro decimales, para ratios en tanto por uno. 0,0432 y no 0,04321789: el
 * modelo no gana nada con el quinto decimal y cada dígito es un token que además
 * hace la huella más frágil de lo necesario.
 */
export function r4n(n: number | null): number | null {
  return n === null ? null : Math.round(n * 10_000) / 10_000;
}

/**
 * Variación relativa entre dos valores, en tanto por uno. null cuando no se
 * puede calcular, con el mismo criterio que `trendPct` en catalogo-resumen.tsx:
 * sin base no hay comparación y no se inventa un 0 %.
 *
 * El denominador es el VALOR ABSOLUTO de la base: con una base negativa (un mes
 * que perdió plata), dividir por el valor con signo invierte la lectura y una
 * mejora aparecería como caída.
 */
export function variacion(actual: number, base: number | null | undefined): number | null {
  if (base === null || base === undefined || base === 0) return null;
  return Math.round(((actual - base) / Math.abs(base)) * 10_000) / 10_000;
}

/**
 * La mediana de una lista, ignorando los null. null si no queda ninguno.
 *
 * Mediana y no promedio a propósito: es la referencia contra la que el modelo
 * compara cada funnel, y un funnel con una conversión absurda (3 sesiones y 1
 * venta = 33 %) corre el promedio lo suficiente para que todos los demás
 * parezcan malos.
 */
export function mediana(valores: (number | null)[]): number | null {
  const xs = valores.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const medio = Math.floor(xs.length / 2);
  const m = xs.length % 2 === 1 ? xs[medio]! : (xs[medio - 1]! + xs[medio]!) / 2;
  return Math.round(m * 10_000) / 10_000;
}

/** Un cociente en tanto por uno, o null sin denominador. Nunca Infinity ni NaN. */
export function ratio(numerador: number, denominador: number): number | null {
  if (denominador === 0) return null;
  return Math.round((numerador / denominador) * 10_000) / 10_000;
}
