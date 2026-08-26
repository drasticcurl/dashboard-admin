/**
 * Qué número dice un texto, y el parseo del monto que se tipea en los
 * formularios de Finanzas.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO. Antes el formulario hacía `Number(input)` crudo,
 * y eso rompía de dos formas, las dos en silencio:
 *
 *   "100,50"  → NaN  → el botón "Cargar" quedaba gris PARA SIEMPRE, sin decir
 *                      por qué. Es el bug que se reportó como "no me habilita
 *                      el botón nunca": en español la coma es el separador
 *                      decimal, así que era el caso normal, no un caso raro.
 *   "1.000"   → 1    → guardaba UN euro donde el usuario quiso mil. Peor que
 *                      el anterior: no falla, miente. El patrimonio queda mal
 *                      y nada avisa.
 *
 * La regla de diseño acá es que un campo de plata NO ADIVINA. Cuando la
 * entrada es ambigua de verdad devuelve un error que se le muestra al usuario,
 * en lugar de elegir una interpretación y escribirla en la base.
 *
 * `numeric(14,2)` (migración 022) es el otro límite: más de 2 decimales los
 * redondearía Postgres sin avisar, así que se rechazan acá.
 *
 * POR QUÉ VIVE EN `lib/` Y NO EN `app/(panel)/finanzas/`. El mismo bug de
 * `"1.000"` estaba escrito otras tres veces en Anuncios (presupuesto diario,
 * valores de Reglas y límite de ejecuciones diarias), las tres con `Number()`.
 * Mientras hubiera cuatro implementaciones, arreglar una no arreglaba nada, y
 * ningún módulo de `lib/` podía importar este archivo desde una ruta del panel
 * sin invertir la dependencia. Por eso se movió acá con su test (task 3.1 del
 * spec `parseo-montos-anuncios`) y por eso se le extrajo el NÚCLEO
 * (`leerNumeroEscrito`), que es lo único que los cuatro sitios comparten.
 *
 * NÚCLEO Y POLÍTICA, que es la división que sostiene todo el archivo:
 *
 *   · el NÚCLEO decide QUÉ NÚMERO DICE un texto, y nada más;
 *   · la POLÍTICA decide si ese número sirve para este campo (rango, signo,
 *     cantidad de decimales, entero o no) y con qué palabras se rechaza.
 *
 * `parsearMonto` es núcleo + la política de Finanzas. `parsearPresupuesto`
 * (`lib/ads/presupuesto.ts`) y los campos de Reglas llaman al mismo núcleo con
 * su propia política: mínimo, techo y `numeric(16,4)` en lugar de
 * `numeric(14,2)`, y mensajes que nombran el campo.
 */

export type MontoParseado = { ok: true; valor: number } | { ok: false; error: string };

/** Lo máximo que entra en numeric(14,2): 12 dígitos enteros. */
const MAX = 1_000_000_000_000;

/**
 * Espacios (incluido el fino y el duro que mete un copy-paste de Excel o de
 * una factura) y los dos símbolos de moneda que alguien puede pegar sin querer.
 */
const RUIDO = /[\s\u00a0\u202f\u2009€$]/g;

/**
 * Un separador de miles bien formado: grupos de exactamente 3 dígitos, con 1 a
 * 3 al principio. "1.000.000" sí, "1.00.000" no, "12.3456" no.
 */
function desagrupar(txt: string, sep: '.' | ','): string | null {
  if (!txt.includes(sep)) return txt;
  const re = sep === '.' ? /^\d{1,3}(?:\.\d{3})+$/ : /^\d{1,3}(?:,\d{3})+$/;
  if (!re.test(txt)) return null;
  return txt.split(sep).join('');
}

// ─── El núcleo: qué número dice un texto ─────────────────────────────────────

/** Por qué un texto no nombra ningún número. Conjunto cerrado. */
export type MotivoNumero =
  /** No quedó nada después de limpiar el ruido: `''`, `'   '`, `'€'`. */
  | 'vacio'
  /** Hay algo que no es dígito, coma ni punto: `1e3`, `0x10`, `+5`, `abc`. */
  | 'caracteres'
  /** Los separadores no forman ningún número: `1.00.000`, `1,2,3`, `12.3456`. */
  | 'ilegible'
  /** Un punto con exactamente 3 dígitos a la derecha: `1.000` es 1000 o 1, y no
   *  hay forma de saber cuál. Es la Bug_Condition del spec. */
  | 'ambiguo';

/**
 * El resultado del núcleo. La rama `ambiguo` lleva las dos lecturas por separado
 * y la frase ya armada, porque el valor del rechazo está en que la persona ELIJA:
 * un mensaje que sólo dice «está mal» no le sirve a nadie.
 *
 * `explicacion` no nombra ningún sustantivo («"1.000" se puede leer de dos
 * formas: …»), así que la misma cadena sirve para un importe, para un ROI y para
 * un límite de ejecuciones. Es lo único que las tres pantallas comparten palabra
 * por palabra.
 */
export type NumeroEscrito =
  | { ok: true; valor: number; decimales: number }
  | { ok: false; motivo: Exclude<MotivoNumero, 'ambiguo'> }
  | {
      ok: false;
      motivo: 'ambiguo';
      /** La lectura como agrupación de miles: `"1000"` (con signo si lo había). */
      comoMiles: string;
      /** La lectura como decimal: `"1"` (con signo si lo había). */
      comoDecimal: string;
      /** La frase de las dos lecturas, ya armada y sin nombrar ningún campo. */
      explicacion: string;
    };

/**
 * QUÉ NÚMERO DICE UN TEXTO. **Sin ninguna política**: no mira rango, ni signo, ni
 * cuántos decimales son demasiados, ni si el número es representable.
 *
 * TRES COSAS QUE NINGÚN CONSUMIDOR PUEDE DAR POR HECHAS, y que están así a
 * propósito (§Fix Implementation, decisión 1 del diseño):
 *
 * 1. **Un `-` inicial se acepta y el valor vuelve NEGATIVO**, en lugar de
 *    rechazarse. El signo es política del llamador: en Finanzas lo pone el tipo
 *    de movimiento, en un presupuesto es «bajo el mínimo» y en una condición
 *    («ganancia < -10») es perfectamente legítimo. El que necesite rechazarlo lo
 *    rechaza él, como hace `parsearMonto` abajo.
 * 2. **`decimales` es una CANTIDAD, no un veredicto.** Cada pantalla pone su
 *    propio límite: `numeric(14,2)` en Finanzas y en el presupuesto,
 *    `numeric(16,4)` en las condiciones de Reglas.
 * 3. **NO se chequea `Number.isFinite`**, así que un texto de 400 dígitos vuelve
 *    con `ok: true` y `valor: Infinity`. Incomoda y es deliberado: `parsearMonto`
 *    mira los decimales ANTES de la finitud, así que hoy 400 dígitos con cuatro
 *    decimales devuelven «el monto lleva 2 decimales como máximo» y no «no se
 *    entiende el monto». Si el núcleo rechazara la finitud, ese mensaje cambiaría,
 *    y la cláusula 3.13 congela los mensajes de Finanzas sin distinguir entre
 *    entradas plausibles y absurdas. **Cada política aplica `Number.isFinite` en
 *    la posición que su orden de mensajes exige.**
 *
 * La ambigüedad se decide sobre los dígitos y **el signo no la esquiva**:
 * `'-1.000'` es −1000 o −1, y se rechaza igual que `'1.000'`. Es la familia (g)
 * de §Alcance, medida en la task 2 y decidida en la 3.2: si el núcleo no mirara
 * el signo, una condición «ganancia < -1.000» se seguiría guardando como −1, que
 * es el mismo modo de falla que este parseo vino a arreglar.
 *
 * La regla de la ambigüedad es MÁS ANCHA que «1 a 3 dígitos a la izquierda»: el
 * corte es `derecha.length === 3 && corte > 0`, sin mirar cuántos dígitos hay a la
 * izquierda, así que `1000.000` y `12345.678` también se rechazan. No se angosta:
 * `1000.000` tampoco tiene una lectura sin ambigüedad (como agrupación está mal
 * formado, como decimal es 1000,000) y angostarla haría que `parsearMonto`
 * devolviera 1000 donde hoy rechaza, que es exactamente lo que 3.13 prohíbe.
 */
export function leerNumeroEscrito(raw: string): NumeroEscrito {
  const limpio = raw.replace(RUIDO, '');
  if (limpio.length === 0) return { ok: false, motivo: 'vacio' };

  // El signo se separa acá y se vuelve a poner sobre el valor al final. La
  // ambigüedad se decide sobre lo que queda: ver la nota del signo arriba.
  const negativo = limpio.startsWith('-');
  const s = negativo ? limpio.slice(1) : limpio;
  const signo = negativo ? '-' : '';

  // `'-'` solo cae acá: queda algo escrito y ese algo no es un número.
  if (!/^[\d.,]+$/.test(s)) return { ok: false, motivo: 'caracteres' };

  const comas = (s.match(/,/g) ?? []).length;
  const puntos = (s.match(/\./g) ?? []).length;

  let entero: string;
  let decimales: string;

  if (comas > 0 && puntos > 0) {
    // Están los dos: el que aparece ÚLTIMO es el decimal y el otro agrupa
    // miles. Así escrito no hay ambigüedad en ningún idioma.
    // "1.234,56" → 1234.56   ·   "1,234.56" → 1234.56
    const sep: '.' | ',' = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    const miles: '.' | ',' = sep === ',' ? '.' : ',';
    const corte = s.lastIndexOf(sep);
    const izq = desagrupar(s.slice(0, corte), miles);
    if (izq === null) return { ok: false, motivo: 'ilegible' };
    entero = izq;
    decimales = s.slice(corte + 1);
  } else if (comas === 1) {
    // Una sola coma es el decimal: es como se escribe la plata en español.
    const corte = s.indexOf(',');
    entero = s.slice(0, corte);
    decimales = s.slice(corte + 1);
  } else if (comas > 1) {
    // Varias comas sólo pueden ser miles al estilo inglés: "1,000,000".
    const sinMiles = desagrupar(s, ',');
    if (sinMiles === null) return { ok: false, motivo: 'ilegible' };
    entero = sinMiles;
    decimales = '';
  } else if (puntos > 1) {
    // "1.000.000" — sólo puede ser agrupación de miles.
    const sinMiles = desagrupar(s, '.');
    if (sinMiles === null) return { ok: false, motivo: 'ilegible' };
    entero = sinMiles;
    decimales = '';
  } else if (puntos === 1) {
    const corte = s.indexOf('.');
    const derecha = s.slice(corte + 1);
    if (derecha.length === 3 && corte > 0) {
      // ACÁ ESTABA EL BUG QUE GUARDABA 1 EN VEZ DE 1000. "1.000" es mil para
      // quien escribe en español y uno-con-tres-decimales para JavaScript, y no
      // hay forma de saber cuál quiso. Como es plata, no se elige: se pregunta.
      return ambiguo(raw, `${signo}${s.split('.').join('')}`, `${signo}${s.slice(0, corte)}`);
    }
    entero = s.slice(0, corte);
    decimales = derecha;
  } else {
    entero = s;
    decimales = '';
  }

  if (!/^\d*$/.test(entero) || !/^\d*$/.test(decimales)) {
    return { ok: false, motivo: 'ilegible' };
  }
  // `'.'` y `'.5'` no traen parte entera. Resuelven como 0 y 0,5 donde
  // `Number('.')` daba NaN: es la familia (f) de §Alcance, declarada y no
  // corregida porque corregirla cambiaría el mensaje de `parsearMonto('.')`.
  if (entero.length === 0) entero = '0';

  const n = Number(`${entero}.${decimales === '' ? '0' : decimales}`);
  return { ok: true, valor: negativo ? -n : n, decimales: decimales.length };
}

function ambiguo(raw: string, comoMiles: string, comoDecimal: string): NumeroEscrito {
  return {
    ok: false,
    motivo: 'ambiguo',
    comoMiles,
    comoDecimal,
    explicacion: `"${raw.trim()}" se puede leer de dos formas: escribí ${comoMiles} si querés decir ${comoMiles}, o ${comoDecimal} si querés decir ${comoDecimal}`,
  };
}

// ─── La política de Finanzas ─────────────────────────────────────────────────

/**
 * Los mensajes de Finanzas para los tres motivos que no son ambigüedad, **palabra
 * por palabra los de siempre**: la cláusula 3.13 congela los veredictos Y los
 * textos de `parsearMonto`, así que este mapeo es la parte del archivo que no se
 * puede «mejorar» sin romper la cláusula.
 *
 * `vacio` no es alcanzable desde `parsearMonto` (el corte del campo en blanco es
 * anterior y devuelve esta misma frase), y se mapea igual para que el `switch` sea
 * exhaustivo: si mañana aparece un motivo nuevo, esto no compila.
 */
function errorDeLectura(n: Extract<NumeroEscrito, { ok: false }>, raw: string): string {
  switch (n.motivo) {
    case 'ambiguo':
      return n.explicacion;
    case 'vacio':
      return 'escribí un monto';
    case 'caracteres':
      return 'el monto sólo lleva números, coma o punto';
    case 'ilegible':
      return `no se entiende el monto "${raw.trim()}"`;
  }
}

/**
 * El núcleo más la política de Finanzas, **con el orden de cortes intacto**, que
 * es lo que preserva sus mensajes:
 *
 *   ruido → vacío → signo → núcleo → decimales > 2 → finitud → ≤ 0 → ≥ MAX →
 *   redondeo
 *
 * El chequeo del signo va **antes** del de caracteres a propósito: `'-abc'`
 * devuelve el mensaje del signo y no el de «sólo números, coma o punto», y ese
 * orden es parte de los veredictos que 3.13 congela.
 *
 * Al núcleo se le pasa `raw` y no `s`: limpiar el ruido dos veces da lo mismo,
 * pero la frase de la ambigüedad cita el texto tal como se escribió
 * (`parsearMonto('€1.000')` dice `"€1.000"`), y eso sólo sale bien si el núcleo
 * ve el original.
 */
export function parsearMonto(raw: string): MontoParseado {
  const s = raw.replace(RUIDO, '');

  if (s.length === 0) return { ok: false, error: 'escribí un monto' };
  if (s.startsWith('-')) {
    // El signo no se tipea: lo pone el tipo de movimiento (gasto y retiro van
    // siempre en negativo) o el toggle +/− del ajuste. Es POLÍTICA de Finanzas:
    // el núcleo acepta el negativo y lo devuelve como valor negativo.
    return { ok: false, error: 'el monto va sin el signo menos: el signo lo define el tipo de movimiento' };
  }

  const n = leerNumeroEscrito(raw);
  if (!n.ok) return { ok: false, error: errorDeLectura(n, raw) };
  if (n.decimales > 2) {
    return { ok: false, error: 'el monto lleva 2 decimales como máximo' };
  }
  // La finitud se pregunta ACÁ, después de los decimales, porque el núcleo no la
  // mira: es lo que hace que 400 dígitos con cuatro decimales sigan devolviendo
  // el mensaje de los decimales y no el de «no se entiende».
  if (!Number.isFinite(n.valor)) {
    return { ok: false, error: `no se entiende el monto "${raw.trim()}"` };
  }
  if (n.valor <= 0) return { ok: false, error: 'el monto tiene que ser mayor que cero' };
  if (n.valor >= MAX) return { ok: false, error: 'el monto es demasiado grande' };

  // Redondeo a 2 decimales para que lo que viaja al backend sea EXACTAMENTE lo
  // que Postgres va a guardar en numeric(14,2).
  return { ok: true, valor: Math.round(n.valor * 100) / 100 };
}

/**
 * Cómo se muestra un monto en el input al editar: con coma decimal, que es lo
 * que el usuario espera volver a ver y lo que `parsearMonto` acepta.
 */
export function formatearMontoParaInput(valor: number): string {
  const abs = Math.abs(valor);
  return Number.isInteger(abs) ? String(abs) : abs.toFixed(2).replace('.', ',');
}
