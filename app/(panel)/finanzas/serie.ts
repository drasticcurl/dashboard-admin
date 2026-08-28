// Lo monta T06: `GraficoSaldo`, `CargaDiaria` y `CuentasSection` importan de acá.

/**
 * Las funciones puras del módulo de saldo (T04 §3): etiquetas de eje, el texto
 * de un punto sin dato, la política de parseo de un saldo y el total en vivo del
 * formulario.
 *
 * Todo lo que se pueda decidir sin React vive acá porque es lo único que este
 * repo puede testear: `vitest.config.ts` usa `environment: 'node'` y sólo
 * incluye los archivos `.test.ts`, así que no hay forma de renderizar un
 * componente y no hay jsdom que lo permita. La
 * consecuencia práctica es que cada regla que importe (qué dice un día sin
 * carga, si un saldo de 0 se acepta, con qué signo entra una deuda al total)
 * tiene que estar acá y no adentro de un `.tsx`, o queda sin verificar.
 *
 * Las dos reglas que este archivo NO puede importar, y por qué:
 *
 *  1. `parsearMonto` de `@/lib/monto` — **rechaza el cero** (`if (n.valor <= 0)`).
 *     Para un movimiento está bien (un gasto de 0 no existe), pero un saldo de 0
 *     es una cuenta vacía, es frecuente, y el CHECK de la base es
 *     `amount_eur >= 0`. Con `parsearMonto` una cuenta en cero sería imposible de
 *     cargar y, por D5, ese día nunca podría estar completo: el gráfico pierde el
 *     punto y nada explica por qué. Por eso `parsearSaldo` se escribe ENCIMA de
 *     `leerNumeroEscrito`, el núcleo sin política, y reusa el resto de la política
 *     de Finanzas sin cambiarla.
 *  2. `signoDe` de `@/lib/queries/saldo` — es un import de VALOR desde un módulo
 *     que importa `pg`, así que arrastraría el driver de Postgres al bundle del
 *     browser (es el mismo motivo por el que `FinanzasView.tsx` trae sus tipos con
 *     `import type`). Se duplica como `signoDeSaldo` y `serie.test.ts` ancla las
 *     dos implementaciones contra la misma tabla de casos: en un test de node sí
 *     se puede importar el original.
 */

import { leerNumeroEscrito, type NumeroEscrito } from '@/lib/monto';
import type { AccountKind } from '@/lib/queries/saldo';

// ─── Etiquetas de eje ───────────────────────────────────────────────────────

/**
 * '2026-08-05' → '05/08'. La etiqueta del eje en la vista diaria.
 *
 * Corta el string, no construye un `Date`: `new Date('2026-08-05')` se parsea
 * como UTC y en una TZ al oeste de Greenwich devuelve el día anterior, así que
 * el eje mostraría un día menos que el dato.
 */
export function etiquetaDia(day: string): string {
  // Un formato inesperado vuelve tal cual: es la diferencia entre un eje raro y
  // un eje que dice "undefined/undefined".
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  return `${day.slice(8, 10)}/${day.slice(5, 7)}`;
}

/** '2026-08' → '08/26'. La etiqueta del eje en la vista mensual. */
export function etiquetaMes(month: string): string {
  if (!/^\d{4}-\d{2}$/.test(month)) return month;
  return `${month.slice(5, 7)}/${month.slice(2, 4)}`;
}

/**
 * Qué se muestra cuando el valor es `null`. Devuelve el TEXTO, nunca un 0.
 *
 * Existe como función y no como literal suelto para que no haya dos componentes
 * decidiendo distinto qué dice un día sin carga: un patrimonio de 0 es un dato
 * real y dramático, y taparlo con un 0 lo vuelve indistinguible de "no cargué"
 * (D12).
 */
export function textoSinDato(): string {
  return 'sin información';
}

// ─── El signo de una cuenta, duplicado a propósito ──────────────────────────

/**
 * El signo con el que una cuenta entra al total. Copia exacta de `signoDe` de
 * `lib/queries/saldo.ts`, que no se puede importar desde el browser (ver la nota
 * 2 de la cabecera). `serie.test.ts` compara las dos contra la misma tabla, así
 * que no pueden separarse en silencio.
 */
export function signoDeSaldo(kind: AccountKind, amountEur: number): number {
  return kind === 'deuda' ? -Math.abs(amountEur) : Math.abs(amountEur);
}

// ─── La política de parseo de un SALDO ──────────────────────────────────────

export type SaldoParseado = { ok: true; valor: number } | { ok: false; error: string };

/**
 * Lo máximo que entra en `numeric(14,2)`: 12 dígitos enteros. Duplicado del
 * `MAX` de `lib/monto.ts`, que es module-local y no se exporta (y ese archivo no
 * se toca: plan §8). Si la columna cambia de precisión, los dos se mueven.
 */
const MAX = 1_000_000_000_000;

/**
 * Los mensajes de los tres motivos que no son ambigüedad. La rama `ambiguo`
 * devuelve la explicación que ya armó el núcleo — con las DOS lecturas, que es
 * el punto: un mensaje que sólo dice "está mal" no le sirve a nadie.
 */
function errorDeLectura(n: Extract<NumeroEscrito, { ok: false }>, raw: string): string {
  switch (n.motivo) {
    case 'ambiguo':
      return n.explicacion;
    case 'vacio':
      // No es alcanzable desde `parsearSaldo` (el corte del campo en blanco es
      // anterior); se mapea igual para que el switch sea exhaustivo y un motivo
      // nuevo del núcleo no compile.
      return 'escribí un saldo';
    case 'caracteres':
      return 'el saldo sólo lleva números, coma o punto';
    case 'ilegible':
      return `no se entiende el saldo "${raw.trim()}"`;
  }
}

/**
 * Como `parsearMonto` pero **acepta el CERO**: un saldo de 0 es una cuenta
 * vacía, y es la única diferencia entre las dos políticas.
 *
 * Mismo orden de cortes que `parsearMonto`, que es lo que preserva sus mensajes:
 *
 *   ruido → vacío → signo → núcleo → decimales > 2 → finitud → < 0 → ≥ MAX → redondeo
 *
 * Lo que se reusa sin cambiar:
 *
 *  · **el signo menos se rechaza.** Una cuenta de deuda pide el número POSITIVO
 *    ("cuánto debemos") y el `−` lo pone el `kind` al leer (D4). Nunca se le pide
 *    a la persona escribir un negativo.
 *  · **`"1.000"` se rechaza como ambiguo**, con las dos lecturas ofrecidas.
 *    `Number("1.000")` es 1 y guardaba un euro donde la persona quiso mil: no
 *    falla, miente. El motivo largo está en `registro.md`, 2026-08-24 y `0e151e0`.
 *  · **máximo 2 decimales.** `numeric(14,2)` redondearía el tercero sin avisar.
 *
 * Lo que cambia respecto de `parsearMonto`: `<= 0` pasa a ser `< 0`, y los
 * mensajes dicen "saldo" en lugar de "monto".
 */
export function parsearSaldo(raw: string): SaldoParseado {
  // El mismo ruido que limpia el núcleo (espacios raros de un copy-paste,
  // símbolos de moneda): se limpia acá también porque los dos cortes de abajo
  // —campo vacío y signo— se deciden antes de llamarlo.
  const s = raw.replace(/[\s\u00a0\u202f\u2009€$]/g, '');

  if (s.length === 0) {
    // En el formulario este caso no llega: un campo vacío es `null` (o sea "sin
    // cargar"), que es distinto de un 0 tipeado y se resuelve antes de parsear.
    return { ok: false, error: 'escribí un saldo' };
  }
  if (s.startsWith('-')) {
    return {
      ok: false,
      error:
        'el saldo va sin el signo menos: en una cuenta de deuda se escribe cuánto se debe, en positivo',
    };
  }

  // Al núcleo se le pasa `raw` y no `s`: la frase de la ambigüedad cita el texto
  // tal como se escribió, y eso sólo sale bien si ve el original.
  const n = leerNumeroEscrito(raw);
  if (!n.ok) return { ok: false, error: errorDeLectura(n, raw) };
  if (n.decimales > 2) return { ok: false, error: 'el saldo lleva 2 decimales como máximo' };
  // La finitud va DESPUÉS de los decimales (el núcleo no la mira): así 400
  // dígitos con cuatro decimales siguen devolviendo el mensaje de los decimales.
  if (!Number.isFinite(n.valor)) return { ok: false, error: `no se entiende el saldo "${raw.trim()}"` };
  // `< 0` y no `<= 0`: ACÁ está toda la diferencia con `parsearMonto`. El signo
  // ya se rechazó arriba, así que esto sólo atrapa un "-0".
  if (n.valor < 0) {
    return {
      ok: false,
      error: 'el saldo no puede ser negativo: si la cuenta está en descubierto, cargala como cuenta de tipo deuda',
    };
  }
  if (n.valor >= MAX) return { ok: false, error: 'el saldo es demasiado grande' };

  // Redondeo a 2 decimales para que lo que viaja al backend sea EXACTAMENTE lo
  // que Postgres va a guardar en numeric(14,2).
  return { ok: true, valor: Math.round(n.valor * 100) / 100 };
}

// ─── El total en vivo del formulario ────────────────────────────────────────

export type FilaTipeada = {
  kind: AccountKind;
  /** El texto crudo del input. `''` = sin cargar, y NO es lo mismo que `'0'`. */
  raw: string;
};

export type TotalTipeado = {
  /** La suma con el signo de cada `kind` ya aplicado, redondeada a 2 decimales. */
  totalEur: number;
  /** Cuántas filas tienen un saldo legible (un `'0'` cuenta como cargada). */
  cargadas: number;
  esperadas: number;
  /**
   * `true` sólo si TODAS las filas tienen un saldo legible. Mientras sea `false`,
   * `totalEur` es un PARCIAL y no el patrimonio: por D5 un total al que le falta
   * una cuenta no es un número que falta, es un número equivocado que se ve igual
   * de bien que uno correcto, así que la UI tiene que decir cuál de los dos está
   * mostrando.
   */
  completo: boolean;
  /** Filas con texto que no se puede leer. Con una sola, el total todavía miente. */
  invalidas: number;
};

/**
 * El total que va a quedar, mientras se tipea. Es la única forma de que el
 * usuario note que puso un número de más ANTES de guardar.
 *
 * Vive acá y no en `CargaDiaria` porque la distinción parcial/completo de D5 es
 * exactamente la regla que no puede quedar sin test.
 */
export function totalTipeado(filas: readonly FilaTipeada[]): TotalTipeado {
  let total = 0;
  let cargadas = 0;
  let invalidas = 0;

  for (const f of filas) {
    if (f.raw.trim() === '') continue; // sin cargar: no suma y no es un error
    const n = parsearSaldo(f.raw);
    if (!n.ok) {
      invalidas += 1;
      continue;
    }
    total += signoDeSaldo(f.kind, n.valor);
    cargadas += 1;
  }

  return {
    // Sumar dos numeric de 2 decimales en float deja restos (0.1 + 0.2), y el
    // total se muestra al lado de los números que el usuario acaba de tipear:
    // un 8499,999999999999 ahí es indistinguible de un bug de la suma.
    totalEur: Math.round(total * 100) / 100,
    cargadas,
    esperadas: filas.length,
    completo: filas.length > 0 && cargadas === filas.length,
    invalidas,
  };
}

// ─── Dónde cae el cero, para el degradado del gráfico ───────────────────────

/**
 * Dónde cae el cero dentro del rango de la serie, en tanto por uno **desde
 * arriba**: es el `offset` de los dos stops del degradado que pinta lo positivo
 * de `good` y lo negativo de `bad` en un solo `<Area>`.
 *
 * Un `<Area>` tiene un solo `fill`, así que la única forma de que un mes en
 * pérdida se vea distinto de un mes en ganancia es partir el degradado en el
 * cero. 1 = todo positivo (todo `good`), 0 = todo negativo (todo `bad`).
 *
 * **Es aproximado a propósito.** El eje va con `domain={['auto','auto']}` (plan
 * §5: un patrimonio que se mueve entre 8.000 y 8.400 con el eje anclado en cero
 * se ve como una recta), y ese `auto` redondea el dominio a números lindos, así
 * que el borde del degradado puede caer unos píxeles arriba o abajo del cero
 * real. El cero EXACTO lo marca la `<ReferenceLine y={0}>`, que es lo que se
 * lee; el degradado sólo tiene que decir "de acá para abajo se perdió plata".
 */
export function offsetDelCero(valores: readonly (number | null)[]): number {
  const nums = valores.filter((v): v is number => v !== null);
  if (nums.length === 0) return 1; // nada que dibujar
  const max = Math.max(...nums);
  const min = Math.min(...nums);
  if (max <= 0) return 0; // todo bajo el cero
  if (min >= 0) return 1; // todo sobre el cero
  return max / (max - min);
}

// ─── El fetch de los dos formularios ────────────────────────────────────────

/**
 * **No es pura**, y está acá igual: es el único archivo de T04 que
 * `CargaDiaria` y `CuentasSection` pueden importar los dos, y el detalle que
 * importa no se puede volver a escribir a mano.
 *
 * Ese detalle es `detail` ANTES de `error`. Los routes ponen el motivo legible
 * ("un saldo no puede ser negativo: …") en `detail` y un código estable en
 * `error`; leyendo sólo `error`, el banner rojo le muestra al usuario la palabra
 * `invalid_payload` y todo el trabajo de traducir los CHECK a castellano se
 * pierde en esta línea. Ya pasó: está en `registro.md`, 2026-08-24.
 *
 * `FinanzasView.tsx` tiene hoy una copia idéntica de esto. Unificarlas es de
 * T06, que es la que puede tocar ese archivo (plan §8).
 */
export async function pedir<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; detail?: string };
  if (!res.ok) throw new Error(body.detail ?? body.error ?? `HTTP ${res.status}`);
  return body;
}
