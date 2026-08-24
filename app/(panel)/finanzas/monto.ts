/**
 * Parseo del monto que se tipea en los formularios de Finanzas.
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

function ambiguo(raw: string, comoMiles: string, comoDecimal: string): MontoParseado {
  return {
    ok: false,
    error: `"${raw.trim()}" se puede leer de dos formas: escribí ${comoMiles} si querés decir ${comoMiles}, o ${comoDecimal} si querés decir ${comoDecimal}`,
  };
}

export function parsearMonto(raw: string): MontoParseado {
  const s = raw.replace(RUIDO, '');

  if (s.length === 0) return { ok: false, error: 'escribí un monto' };
  if (raw.replace(RUIDO, '').startsWith('-')) {
    // El signo no se tipea: lo pone el tipo de movimiento (gasto y retiro van
    // siempre en negativo) o el toggle +/− del ajuste.
    return { ok: false, error: 'el monto va sin el signo menos: el signo lo define el tipo de movimiento' };
  }
  if (!/^[\d.,]+$/.test(s)) {
    return { ok: false, error: 'el monto sólo lleva números, coma o punto' };
  }

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
    if (izq === null) return { ok: false, error: `no se entiende el monto "${raw.trim()}"` };
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
    if (sinMiles === null) return { ok: false, error: `no se entiende el monto "${raw.trim()}"` };
    entero = sinMiles;
    decimales = '';
  } else if (puntos > 1) {
    // "1.000.000" — sólo puede ser agrupación de miles.
    const sinMiles = desagrupar(s, '.');
    if (sinMiles === null) return { ok: false, error: `no se entiende el monto "${raw.trim()}"` };
    entero = sinMiles;
    decimales = '';
  } else if (puntos === 1) {
    const corte = s.indexOf('.');
    const derecha = s.slice(corte + 1);
    if (derecha.length === 3 && corte > 0) {
      // ACÁ ESTABA EL BUG QUE GUARDABA 1 EN VEZ DE 1000. "1.000" es mil para
      // quien escribe en español y uno-con-tres-decimales para JavaScript, y no
      // hay forma de saber cuál quiso. Como es plata, no se elige: se pregunta.
      return ambiguo(raw, s.split('.').join(''), s.slice(0, corte));
    }
    entero = s.slice(0, corte);
    decimales = derecha;
  } else {
    entero = s;
    decimales = '';
  }

  if (!/^\d*$/.test(entero) || !/^\d*$/.test(decimales)) {
    return { ok: false, error: `no se entiende el monto "${raw.trim()}"` };
  }
  if (entero.length === 0) entero = '0';
  if (decimales.length > 2) {
    return { ok: false, error: 'el monto lleva 2 decimales como máximo' };
  }

  const n = Number(`${entero}.${decimales === '' ? '0' : decimales}`);
  if (!Number.isFinite(n)) {
    return { ok: false, error: `no se entiende el monto "${raw.trim()}"` };
  }
  if (n <= 0) return { ok: false, error: 'el monto tiene que ser mayor que cero' };
  if (n >= MAX) return { ok: false, error: 'el monto es demasiado grande' };

  // Redondeo a 2 decimales para que lo que viaja al backend sea EXACTAMENTE lo
  // que Postgres va a guardar en numeric(14,2).
  return { ok: true, valor: Math.round(n * 100) / 100 };
}

/**
 * Cómo se muestra un monto en el input al editar: con coma decimal, que es lo
 * que el usuario espera volver a ver y lo que `parsearMonto` acepta.
 */
export function formatearMontoParaInput(valor: number): string {
  const abs = Math.abs(valor);
  return Number.isInteger(abs) ? String(abs) : abs.toFixed(2).replace('.', ',');
}
