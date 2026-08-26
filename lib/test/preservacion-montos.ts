/**
 * Lo que comparten los dos tests de preservación de `parseo-montos-anuncios`
 * (task 2): la Bug_Condition, las SIETE familias de excepción declaradas en
 * §Alcance del diseño, y los generadores de texto de campo.
 *
 * Eran seis cuando la task 2 escribió este archivo. La séptima —(g), el signo—
 * la agregó la task 3.2 con la decisión que cerró el hallazgo que la 2 había
 * dejado abierto acá abajo, en el comentario de `textoDeCConSigno`.
 *
 * UN SOLO ARCHIVO, y en este spec el motivo es literal: el bug que se está
 * arreglando es una regla de parseo escrita cuatro veces. Un predicado de
 * excepciones escrito dos veces —uno en `presupuesto.preservacion.test.ts` y
 * otro en `numeroDeCampo.preservacion.test.ts`— es el mismo error una escala más
 * arriba: los dos se ensancharían por separado y cada propiedad creería estar
 * cubriendo lo que cubre la otra. Es el mismo argumento con el que
 * `lib/test/generadores-ads.ts` ya existe. Y ya rindió: la familia (g) se agregó
 * en UN lugar y las dos propiedades la tomaron.
 *
 * SÓLO SE USA EN TESTS. No entra al bundle: nadie de producción lo importa.
 *
 * Los generadores son una COPIA de los de `lib/ads/presupuesto.test.ts`, con
 * ramas nuevas para las siete familias. No se movieron desde ahí porque ese
 * archivo tiene un único editor declarado (la task 3.6) y la task 2 no lo toca.
 * Si algún día se unifican, la copia de allá es la que se borra.
 */

import fc from 'fast-check';

/**
 * El ruido que `parsearMonto` limpia hoy y que el núcleo compartido va a
 * limpiar: espacios (incluidos el fino, el duro y el BOM, que entran pegados de
 * un Excel o de una factura) y los dos símbolos de moneda. Copiado tal cual de
 * `lib/monto.ts` (que la task 3.1 movió desde `app/(panel)/finanzas/monto.ts`):
 * es la definición de «ruido» del sistema, y si ahí cambia, acá tiene que
 * cambiar.
 */
export const RUIDO = /[\s\u00a0\u202f\u2009€$]/g;

/** El texto como lo ve el núcleo: sin ruido. */
export const limpiarRuido = (texto: string): string => texto.replace(RUIDO, '');

/**
 * La Bug_Condition (C), textual de §Bug Condition del diseño: sobre el texto ya
 * limpio de ruido, UN punto, CERO comas, 1 a 3 dígitos a la izquierda y
 * EXACTAMENTE 3 a la derecha, todos dígitos.
 *
 * `^\d{1,3}\.\d{3}$` es la forma compacta de esas seis condiciones juntas: el
 * ancla y la clase de dígitos ya obligan a que no haya comas, a que el punto sea
 * uno solo y a que los dos lados sean dígitos.
 *
 * Se llama `REGEX_BUG_CONDITION` y no `REGEX_C` para que no se confunda con la
 * familia (c), que es otra cosa: C es el bug, (c) es una excepción declarada.
 */
export const REGEX_BUG_CONDITION = /^\d{1,3}\.\d{3}$/;

/** `isBugCondition(input)` de §Bug Condition. */
export const isBugCondition = (texto: string): boolean =>
  REGEX_BUG_CONDITION.test(limpiarRuido(texto));

// ─── Las SIETE familias de excepción, una regex por familia ───────────────────
//
// GUARDA 1 del plan: siete regex NOMBRADAS con su número de cláusula al lado, y
// no una condición compuesta. El único punto débil de la propiedad de
// preservación es un predicado demasiado ancho: escrito así, ensancharlo obliga
// a tocar una familia con nombre y número, no a agregar un `||` al final de una
// línea larga.
//
// La tabla de §Alcance, tal cual:
//
//   a  el texto tiene una coma                          2.2
//   b  el texto tiene más de un punto                   2.3
//   c  tras limpiar el ruido no cumple `^-?[\d.]*$`     2.5
//   d  trae €, $ o espacios que `Number` no tolera      2.5
//   e  `^\d{4,}\.\d{3}$` (la regla ancha)               diseño §«La regla implementada es más ancha»
//   f  sin dígitos y el núcleo lo resuelve como 0        §Alcance, sin cláusula
//   g  `^-\d+\.\d{3}$` (C y (e) con signo)              diseño §«La familia (g): el signo entra en la ambigüedad»

/** (a) 2.2 — la coma decimal pasa a leerse como en Finanzas. Hoy `Number` no la
 *  lee y todo texto con coma es `no_numero`. Aplica al texto limpio. */
export const FAMILIA_A = /,/;

/** (b) 2.3 — más de un punto: hoy `no_numero`, con el arreglo es agrupación de
 *  miles si está bien formada (`1.000.000`) e `ilegible` si no (`1.00.000`).
 *  Aplica al texto limpio. */
export const FAMILIA_B = /\..*\./;

/** (c) 2.5 — queda algún carácter que no es dígito ni punto, con el `-` inicial
 *  permitido: `1e3`, `0x10`, `0b11`, `0o17`, `+5`, `abc`. Es el complemento
 *  exacto de `^-?[\d.]*$`. Aplica al texto limpio SIN el signo inicial. */
export const FAMILIA_C = /[^\d.]/;

/** (d) 2.5 — hay `€`, `$` o un espacio en una posición que `Number` no tolera.
 *  `Number` perdona los espacios de los extremos (los mismos que saca `trim`),
 *  así que `'  12,5  '` no es esta familia y `'1 000'` sí. Aplica al texto
 *  RECORTADO, no al limpio: limpiarlo borraría justo lo que hay que detectar. */
export const FAMILIA_D = /[€$\s]/;

/** (e) — la regla ancha del diseño: 4 o más dígitos a la izquierda del punto y
 *  exactamente 3 a la derecha. Queda fuera de la C escrita en 2.1 y se rechaza
 *  igual, porque angostar la regla cambiaría un veredicto de `parsearMonto` y
 *  3.13 los congela. Aplica al texto limpio. */
export const FAMILIA_E = /^\d{4,}\.\d{3}$/;

/** (f) — no hay ningún dígito y el núcleo lo resuelve como 0: `'.'` (y `'€.'`,
 *  que limpia a `'.'`), donde `Number('.')` daba NaN. Aplica al texto limpio. */
export const FAMILIA_F = /^-?\.$/;

/** (g) — la misma forma que C y que (e), con signo: `'-1.000'`, `'-1000.000'`.
 *  La task 2 la midió (64 flips del lado presupuesto, 56 del lado Reglas, sobre
 *  404.661 y 358.206 combinaciones) y la 3.2 decidió que **el signo entra en la
 *  ambigüedad**: `-1.000` es −1000 o −1, y se rechaza como tal. La alternativa
 *  —que el núcleo no mire el signo— deja el bug vivo para los negativos, porque
 *  una condición «ganancia < -1.000» se seguiría guardando como −1.
 *
 *  El `-` va OBLIGATORIO y no como `-?`: sin signo esta forma ya está cubierta
 *  por C (`^\d{1,3}\.\d{3}$`) y por (e) (`^\d{4,}\.\d{3}$`), y una familia que se
 *  solapa con otras dos es el predicado ensanchado que las dos guardas del plan
 *  existen para impedir. Aplica al texto limpio. */
export const FAMILIA_G = /^-\d+\.\d{3}$/;

/**
 * En cuál de las SIETE familias cae un texto, o `null` si en ninguna. Devuelve la
 * etiqueta y no un booleano para que el contraejemplo de la propiedad diga POR
 * QUÉ estaba permitido cambiar, que es la mitad de la información cuando alguien
 * lee un fallo seis meses después.
 *
 * Las familias se prueban en el orden de la tabla de §Alcance. El orden sólo
 * decide la etiqueta cuando un texto cae en más de una (`'€.'` es (d) y (f)); el
 * booleano es el mismo en cualquier orden.
 */
export function familiaDeclarada(texto: string): string | null {
  const limpio = limpiarRuido(texto);
  if (FAMILIA_A.test(limpio)) return '(a) el texto tiene una coma (2.2)';
  if (FAMILIA_B.test(limpio)) return '(b) más de un punto (2.3)';
  if (FAMILIA_C.test(limpio.replace(/^-/, ''))) return '(c) no cumple ^-?[\\d.]*$ (2.5)';
  if (FAMILIA_D.test(texto.trim())) return '(d) €, $ o espacios que Number no tolera (2.5)';
  if (FAMILIA_E.test(limpio)) return '(e) ^\\d{4,}\\.\\d{3}$, la regla ancha';
  if (FAMILIA_F.test(limpio)) return '(f) sin dígitos, el núcleo resuelve 0';
  if (FAMILIA_G.test(limpio)) return '(g) ^-\\d+\\.\\d{3}$, el signo entra en la ambigüedad';
  return null;
}

/** El predicado de §Preservation Checking: `esExcepcionDeclarada(texto)`. Son
 *  las siete familias y NADA MÁS: la Bug_Condition no es una excepción, es el bug,
 *  y la propiedad la pregunta aparte con `isBugCondition`. */
export const esExcepcionDeclarada = (texto: string): boolean => familiaDeclarada(texto) !== null;

/**
 * El bucket que autoriza a un texto a cambiar de veredicto: la Bug_Condition o
 * una de las siete familias. `null` = ninguno, o sea que un cambio de veredicto en
 * ese texto es un contraejemplo de la preservación.
 */
export const bucketPermitido = (texto: string): string | null =>
  isBugCondition(texto) ? 'C — la Bug_Condition (2.1)' : familiaDeclarada(texto);

// ─── Generadores ─────────────────────────────────────────────────────────────

/** Techo en 0,01..5000,00 EUR, siempre positivo. Se genera en céntimos para no
 *  producir techos como 1.4e-45, que ningún `settings` puede tener.
 *  Copiado de `lib/ads/presupuesto.test.ts`. */
export const techoPositivo: fc.Arbitrary<number> = fc
  .integer({ min: 1, max: 500_000 })
  .map((centimos) => centimos / 100);

/** La Bug_Condition entera: 1 a 3 dígitos, punto, 3 dígitos. */
export const textoDeC: fc.Arbitrary<string> = fc
  .tuple(fc.integer({ min: 0, max: 999 }), fc.integer({ min: 0, max: 999 }))
  .map(([izq, der]) => `${izq}.${String(der).padStart(3, '0')}`);

/** La familia (e): 4 a 8 dígitos a la izquierda. */
export const textoDeFamiliaE: fc.Arbitrary<string> = fc
  .tuple(fc.integer({ min: 1_000, max: 99_999_999 }), fc.integer({ min: 0, max: 999 }))
  .map(([izq, der]) => `${izq}.${String(der).padStart(3, '0')}`);

/**
 * HALLAZGO DE LA TASK 2, RESUELTO EN LA 3.2: la misma forma de C y de (e) pero
 * con signo. `-1.000` NO cumple `isBugCondition` (la izquierda del punto es `-1`,
 * que no son todos dígitos) y no caía en ninguna de las seis familias originales,
 * pero el núcleo acepta el `-` inicial y decide la ambigüedad sobre lo que queda,
 * así que `-1.000` pasa de `bajo_el_minimo` a `ambiguo`.
 *
 * Se genera igual en lugar de esquivarse: una propiedad de preservación que no
 * genera una clase de flip conocida es exactamente el «predicado trivialmente
 * verdadero» contra el que el plan pone las dos guardas.
 *
 * LA DECISIÓN, tomada en la 3.2 y escrita en §Alcance del diseño: **el signo
 * entra en la ambigüedad**, y la clase se declara como familia (g) con el `-`
 * obligatorio (`FAMILIA_G`, arriba). Se descartó la salida fácil —que el núcleo
 * no trate como ambiguo un texto con signo— porque deja el bug vivo para los
 * negativos: una condición «ganancia < -1.000» se seguiría guardando como −1, que
 * es el mismo modo de falla que este spec vino a arreglar.
 */
export const textoDeCConSigno: fc.Arbitrary<string> = fc
  .tuple(fc.integer({ min: 0, max: 99_999 }), fc.integer({ min: 0, max: 999 }))
  .map(([izq, der]) => `-${izq}.${String(der).padStart(3, '0')}`);

/** Agrupaciones y decimales con coma, bien y mal formados: la familia (a) y la
 *  mitad de la (b). `Number` no lee ninguno, así que hoy son todos
 *  `no_numero`. */
const textoConComa: fc.Arbitrary<string> = fc.oneof(
  fc.integer({ min: 0, max: 999_999 }).map((c) => `${Math.floor(c / 100)},${String(c % 100).padStart(2, '0')}`),
  fc.constantFrom(
    '1,5', '100,50', '0,01', '1.234,56', '1,234.56', '1,000,000', '1.000.000',
    '10,005', '1,00,000', '1,2,3', ',', '1,', ',5',
  ),
);

/** Texto con ruido metido adentro: la familia (d). Con el ruido en el medio
 *  `Number` devuelve NaN, y con el arreglo se limpia y se lee el número. */
const textoConRuido: fc.Arbitrary<string> = fc.oneof(
  fc
    .tuple(fc.integer({ min: 1, max: 999 }), fc.integer({ min: 0, max: 999 }), fc.constantFrom(' ', '\u00a0', '\u202f', '\u2009'))
    .map(([miles, resto, sep]) => `${miles}${sep}${String(resto).padStart(3, '0')}`),
  fc.integer({ min: 1, max: 5_000 }).map((n) => `€${n}`),
  fc.integer({ min: 1, max: 5_000 }).map((n) => `${n} €`),
  fc.constantFrom('€5', '$5', '€.', '€', ' € ', '1 000', '12 345,67', '\u2009', '5\u3000'),
);

/**
 * Lo que el usuario puede dejar en el campo. Las siete primeras ramas son las de
 * `lib/ads/presupuesto.test.ts`, con sus pesos: la mezcla está pesada hacia
 * importes bien formados a propósito, porque con puro texto al azar la
 * preservación se cumpliría de forma trivial (todo rechazado por igual) y no
 * probaría el camino válido. Las ramas nuevas son las que hacen aparecer las
 * siete familias.
 */
export const textoDeCampo: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: -1_000, max: 300_000 }).map((c) => (c / 100).toFixed(2)) },
  { weight: 3, arbitrary: fc.integer({ min: -1_000, max: 300_000 }).map((c) => String(c / 100)) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 300_000 }).map((m) => (m / 1_000).toFixed(3)) },
  {
    weight: 2,
    arbitrary: fc
      .tuple(fc.integer({ min: -99, max: 99 }), fc.integer({ min: -4, max: 22 }))
      .map(([mantisa, exp]) => `${mantisa}e${exp}`),
  },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      '', ' ', '   ', '\t', '\n', '\u00a0', '\ufeff', '\u3000',
      'abc', 'NaN', 'Infinity', '-Infinity', '1,5', '1.2.3', '1_000',
      '0x10', '0b11', '0o17', '+5', '-0', '.5', '5.', '0', '0.01', '0.001',
      // Agregados en la task 2: los bordes del núcleo que el diseño nombra uno
      // por uno en §Alcance y en las cuatro entradas pinneadas del mapeo.
      '.', '-.', '..', '1.00.000', '1.000', '1000.000', '12345.678', '0.000',
    ),
  },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 300_000 }).map((c) => `  ${c / 100}  `) },
  { weight: 1, arbitrary: fc.string({ maxLength: 12 }) },
  // ─── Ramas nuevas: las siete familias y la Bug_Condition ───
  { weight: 3, arbitrary: textoDeC },
  { weight: 2, arbitrary: textoDeFamiliaE },
  { weight: 3, arbitrary: textoConComa },
  { weight: 2, arbitrary: textoConRuido },
  { weight: 1, arbitrary: textoDeCConSigno },
);
