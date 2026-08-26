/**
 * Los valores YA GUARDADOS que huelen a este bug (spec parseo-montos-anuncios,
 * cláusulas 2.12, 2.13 y 2.14).
 *
 * QUÉ ES UNA SOSPECHA Y QUÉ NO
 * `numeroDeTexto` leía `1.000` como 1: el punto se interpretaba como decimal y
 * el importe quedaba mil veces más chico. El parseo ya está arreglado, pero lo
 * que se guardó antes sigue ahí, y **no se corrige solo** (decisión 2 del
 * bugfix): un `budget_max = 1` no se distingue con certeza de un techo de un
 * euro puesto a propósito. Así que esto **señala**, no arregla. Ningún consumidor
 * de este módulo escribe una fila.
 *
 * POR QUÉ EL UMBRAL VIVE ACÁ Y NO EN EL SQL DEL SCRIPT
 * El script de auditoría (`scripts/verificar-montos-reglas.ts`) y el aviso de la
 * lista de Reglas llaman a `sospechasDeRegla`. Si el `WHERE` del script filtrara
 * por el umbral, habría dos reglas que pueden discrepar —una en SQL y una en
 * TypeScript— y eso es exactamente el error que este spec vino a arreglar en el
 * parseo. El script hace un `SELECT` amplio y filtra acá. Son cientos de filas:
 * el costo es irrelevante y la alternativa es tener dos verdades.
 *
 * MÓDULO PURO: sin `pg`, sin `fetch`. Lo importa un componente cliente.
 */

/** Banda «muy probable»: por debajo de 10 EUR. */
export const UMBRAL_ALTO_EUR = 10;

/** Banda «posible»: de 10 a 99,99 EUR. Desde 100 no se reporta nada. */
export const UMBRAL_BAJO_EUR = 100;

/**
 * Las métricas de condición que son importes en EUR y por lo tanto se auditan.
 *
 * `ad_rule_conditions.value` está en EUR para estas cinco (ver el comentario de
 * la 016 sobre unidades): un umbral de gasto o de ingresos por debajo de 10 EUR
 * es implausible en una cuenta real, así que la sospecha tiene sentido.
 */
export const METRICAS_EUR_AUDITABLES = ['spend', 'revenue', 'net', 'profit', 'budget'] as const;

/**
 * Las que NO se auditan, y es una decisión, no un olvido.
 *
 * Un CPA de 8 EUR, un CPC de 0,30 y un ROI de 1,3 son valores completamente
 * normales; `sales`, `clicks` e `impressions` son cantidades chicas por
 * naturaleza. Reportarlas sería ruido que entierra las sospechas reales. Está
 * exportada para que el script pueda imprimir la lista: la omisión tiene que ser
 * **visible**, no silenciosa.
 */
export const METRICAS_NO_AUDITABLES = [
  'cpa',
  'cpc',
  'roi',
  'roas',
  'ctr',
  'sales',
  'clicks',
  'impressions',
] as const;

/**
 * Las etiquetas en castellano de las cinco métricas auditables.
 *
 * Copiadas palabra por palabra de `METRICA_LABEL` de `ReglasView.tsx`, que vive
 * en un componente cliente de `app/`: ningún módulo de producción de `lib/`
 * importa de `app/` (Decisión 1 del diseño), y traerse un `.tsx` acá arrastraría
 * React a un script de Node. Son cinco palabras y sólo se usan para el texto del
 * reporte; si alguna cambia en la UI, cambiarla acá también.
 */
const ETIQUETA_METRICA: Record<string, string> = {
  spend: 'gasto',
  revenue: 'ingresos',
  net: 'neto',
  profit: 'ganancia',
  budget: 'presupuesto',
};

export type BandaSospecha = 'alta' | 'baja';

export type Sospecha = {
  /** La columna donde está el valor. `condicion` es `ad_rule_conditions.value`. */
  campo: 'action_value' | 'budget_max' | 'budget_min' | 'condicion';
  /** Cómo se lo nombra en la pantalla: «techo», «gasto (condición 2)». */
  etiqueta: string;
  /** El valor tal como está guardado hoy. 1.5 */
  valor: number;
  /** El texto que, leído con el parseo viejo, habría producido `valor`. '1.500' */
  textoProbable: string;
  /** El número que esa persona quiso escribir. 1500 */
  valorProbable: number;
  /** 'alta' = por debajo de UMBRAL_ALTO_EUR; 'baja' = entre los dos umbrales. */
  banda: BandaSospecha;
  /**
   * `true` sólo para `action_value` con `action_unit = 'percent'`: un grupo que
   * 2.12 NO pide y que se incluye igual, declarado como extensión (ver abajo).
   * El script lo imprime aparte para que se pueda evaluar por separado.
   */
  extension: boolean;
};

/**
 * La forma mínima que hace falta para auditar una regla.
 *
 * Tipos anchos a propósito (`string | null` y no la unión): lo satisfacen tanto
 * el `ReglaFila` de la pantalla como la fila cruda que el script arma desde el
 * `SELECT`, sin conversiones en el medio. Eso es lo que hace que la UI y el
 * script no puedan discrepar (Property 7).
 */
export type ReglaAuditable = {
  /** 'percent' | 'fixed' | null, tal como está en la columna. */
  actionUnit: string | null;
  actionValue: number | null;
  budgetMax: number | null;
  budgetMin: number | null;
  /**
   * Está en el tipo A PROPÓSITO y no se mira nunca.
   *
   * 2.13 lo declara **no detectable**: `max_runs_per_day = 1` es un valor
   * legítimo y frecuente («una vez por día»), indistinguible de un `1.000`
   * corrompido. Tenerlo acá y no usarlo deja la decisión escrita donde alguien
   * la va a leer, en lugar de que parezca que se olvidó.
   */
  maxRunsPerDay: number | null;
  /**
   * Las condiciones **en el orden en que la pantalla las numera**: ordenadas por
   * `position`. La etiqueta dice «(condición N)» con N = índice + 1, igual que
   * `ReglasView`, así que el número del reporte y el de la UI coinciden sólo si
   * el llamador respeta ese orden.
   */
  condiciones: readonly { metric: string; op: string; value: number }[];
};

/**
 * La banda de un importe guardado, o `null` si no hay nada que sospechar.
 *
 * DOS BANDAS, NO UNA, y el motivo es aritmético: la corrupción divide por 1000.
 * Una intención de cuatro dígitos (1000–9999) cae en 1–9,99, y una de cinco
 * (`10.000`, `25.000`) cae en 10–99,99. Con un solo corte en 10 la segunda
 * familia se pierde en silencio; con un solo corte en 100 el reporte se llena de
 * techos chicos legítimos. Dos bandas etiquetadas dejan la decisión donde 2.13
 * la pone: en una persona.
 */
function bandaDe(valor: number): BandaSospecha | null {
  if (!(valor > 0)) return null;
  if (valor < UMBRAL_ALTO_EUR) return 'alta';
  if (valor < UMBRAL_BAJO_EUR) return 'baja';
  return null;
}

/**
 * `true` si el valor pudo haber salido de un texto de la forma `\d+\.\d{3}`.
 *
 * Es lo que hace **exacta** la reconstrucción, y no es una formalidad: los
 * importes de `ad_rules` son `numeric(14,2)` (dos decimales como máximo), pero
 * `ad_rule_conditions.value` es `numeric(16,4)`. Un umbral guardado como 1,2345
 * tiene cuatro decimales y por lo tanto NO puede venir de un texto con tres:
 * `(1.2345).toFixed(3)` sería `'1.234'`, que ya no es el mismo número. Ese valor
 * no es sospechoso de este bug, y sin este corte el reporte inventaría un texto
 * que nadie escribió.
 */
function reconstruible(valor: number): boolean {
  return Number(valor.toFixed(3)) === valor;
}

/**
 * El texto que produjo un valor, y el número que se quiso escribir.
 *
 * El parseo viejo leía `1.000` con `Number()`, que interpreta ese literal como
 * el decimal 1,000 = 1. Así que la reconstrucción no adivina nada: el texto es
 * `valor.toFixed(3)` y la intención es `Math.round(valor * 1000)`.
 * `(1.5).toFixed(3)` es `'1.500'` y `Math.round(1.5 * 1000)` es 1500;
 * `(10).toFixed(3)` es `'10.000'` y da 10000.
 *
 * El `Math.round` está por el punto flotante y no por el redondeo decimal: con
 * tres decimales o menos, `valor * 1000` es entero salvo por el épsilon de IEEE
 * 754 (`0.29 * 1000` da 289.99999999999994).
 */
function sospechaDe(
  campo: Sospecha['campo'],
  etiqueta: string,
  valor: number | null,
  opciones: { extension?: boolean } = {},
): Sospecha | null {
  if (valor === null || !Number.isFinite(valor)) return null;
  if (!reconstruible(valor)) return null;
  const banda = bandaDe(valor);
  if (banda === null) return null;
  return {
    campo,
    etiqueta,
    valor,
    textoProbable: valor.toFixed(3),
    valorProbable: Math.round(valor * 1000),
    banda,
    extension: opciones.extension === true,
  };
}

/**
 * Todos los valores sospechosos de una regla, en el orden en que la pantalla los
 * muestra: primero el valor de la acción, después techo y piso, después las
 * condiciones.
 *
 * Es **el mismo predicado** que usan el script y el aviso de la lista. Una regla
 * limpia devuelve `[]`.
 *
 * FALSOS POSITIVOS: son esperados y no se filtran. Un techo de 5 EUR escrito a
 * propósito aparece en el reporte con banda alta, porque es literalmente
 * indistinguible de un `5.000` corrompido (2.13). La salida dice «sospechoso», no
 * «error», y la corrección es a mano.
 */
export function sospechasDeRegla(r: ReglaAuditable): Sospecha[] {
  const out: Sospecha[] = [];

  // ─── El valor de la acción ────────────────────────────────────────────────
  if (r.actionUnit === 'fixed') {
    // Importe absoluto en EUR: sumar o restar menos de 10 EUR es posible, pero
    // es también la marca de un `1.000` corrompido.
    const s = sospechaDe('action_value', 'valor de la acción', r.actionValue);
    if (s) out.push(s);
  } else if (r.actionUnit === 'percent') {
    // EXTENSIÓN DECLARADA SOBRE 2.12. La cláusula nombra los importes absolutos,
    // así que un porcentaje queda afuera. Se incluye igual, marcado con
    // `extension: true`, porque el agujero es real y es el peor caso del bug
    // entero: para `budget_decrease` el CHECK ad_rules_percent_direccion sólo
    // exige `action_value < 100`, así que un `1.500` que quería decir 150% queda
    // guardado como 1,5 y significa «bajá el presupuesto al 1,5% del actual».
    // (Para `budget_increase` el mismo CHECK exige > 100, así que ahí la base ya
    // rechaza el valor corrompido.)
    //
    // Si al revisar se prefiere respetar 2.12 al pie de la letra, se borra esta
    // rama y no hace falta tocar nada más: el campo `extension` deja el grupo
    // separado en el reporte y en la UI.
    const s = sospechaDe('action_value', 'valor de la acción (%)', r.actionValue, { extension: true });
    if (s) out.push(s);
  }

  // ─── Techo y piso ─────────────────────────────────────────────────────────
  // Un techo de 9,99 EUR/día no puede subir casi ningún presupuesto real: es el
  // síntoma exacto de 1.6, la regla que quedó sin poder hacer nada.
  const techo = sospechaDe('budget_max', 'techo', r.budgetMax);
  if (techo) out.push(techo);
  const piso = sospechaDe('budget_min', 'piso', r.budgetMin);
  if (piso) out.push(piso);

  // ─── Los umbrales de las condiciones ──────────────────────────────────────
  for (let i = 0; i < r.condiciones.length; i++) {
    const c = r.condiciones[i]!;
    // Sólo las cinco métricas de importe. El resto no se audita (ver
    // METRICAS_NO_AUDITABLES).
    if (!(METRICAS_EUR_AUDITABLES as readonly string[]).includes(c.metric)) continue;
    const nombre = ETIQUETA_METRICA[c.metric] ?? c.metric;
    const s = sospechaDe('condicion', `${nombre} (condición ${i + 1})`, c.value);
    if (s) out.push(s);
  }

  // NOTA: `r.maxRunsPerDay` no se mira. Es la decisión de 2.13, no un olvido; el
  // comentario del campo en `ReglaAuditable` lo explica.
  return out;
}

/** Cuántas sospechas hay de cada banda. Lo usa el resumen final del script. */
export function totalesPorBanda(sospechas: readonly Sospecha[]): { alta: number; baja: number } {
  return {
    alta: sospechas.filter((s) => s.banda === 'alta').length,
    baja: sospechas.filter((s) => s.banda === 'baja').length,
  };
}
