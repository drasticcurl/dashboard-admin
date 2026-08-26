import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  bucketPermitido,
  esExcepcionDeclarada,
  isBugCondition,
  textoDeCampo,
} from '@/lib/test/preservacion-montos';
import * as Reglas from './ReglasView';

/**
 * Feature: parseo-montos-anuncios — Property 2: Preservation, lado Reglas
 *
 * **Validates: Requirements 3.8, 3.9, 3.10, 3.13**
 *
 * QUÉ NÚMERO LEE REGLAS DE UN TEXTO SÓLO CAMBIA DONDE ESTÁ DECLARADO. Es la
 * misma propiedad que `lib/ads/presupuesto.preservacion.test.ts`, con el mismo
 * predicado —importado, no copiado: dos predicados que se ensanchan por separado
 * son el bug de este spec una escala más arriba— y con el otro oráculo.
 *
 * ─── POR QUÉ HAY UNA IMPLEMENTACIÓN DUPLICADA ACÁ ADENTRO ───────────────────
 *
 * `numeroDeTextoOriginal` es el cuerpo de `numeroDeTexto` (`ReglasView.tsx:574`)
 * de hoy, dos líneas copiadas tal cual. Está duplicado A PROPÓSITO: es el oráculo
 * de la refactorización. La task 3.5 reemplaza `numeroDeTexto` por
 * `numeroDeCampo`, que devuelve estado en lugar de `number`, y sin esta copia no
 * queda con qué comparar. Mismo criterio que la `reglaOriginal` de
 * `lib/ads/presupuesto.test.ts:192`.
 *
 * NO SE ACTUALIZA NUNCA. Si el arreglo lo hace fallar, lo que se discute es el
 * arreglo o el diseño, no el oráculo.
 *
 * ─── OBSERVADO ANTES DE AFIRMAR ─────────────────────────────────────────────
 *
 * El oráculo se corrió contra el `numeroDeTexto` real antes de escribir la
 * propiedad: 0 divergencias sobre los generadores (que incluyen `0x10`, `0b11`,
 * `0o17`, `+5`, `.5`, `5.`, los espacios unicode y el BOM) y sobre la tabla
 * pinneada de abajo. Las dos comprobaciones quedan como test.
 *
 * ─── LA NORMALIZACIÓN, QUE NO ES UN CAMBIO DE VEREDICTO ─────────────────────
 *
 * El oráculo devuelve `number` con NaN como única señal de fallo, y devuelve
 * `Infinity` para un texto de 400 dígitos. Los llamadores de hoy preguntan
 * `Number.isFinite` sobre ese número, así que «no leyó ningún número» es hoy
 * `!Number.isFinite(n)`, y el diseño pone ese mismo chequeo adentro de
 * `numeroDeCampo` («pliega la finitud dentro de `error`»). Los dos lados se
 * comparan entonces como `number | null`, con `null` = «no hay número». Es un
 * cambio de DÓNDE vive el chequeo, no de qué texto se lee: por eso la
 * normalización va en el test y no en el predicado de excepciones.
 *
 * ─── DOS HALLAZGOS PARA LA TASK 3.5 Y LA 3.8 ────────────────────────────────
 *
 * Salen de comparar el oráculo contra una simulación del núcleo del diseño sobre
 * 358.206 textos: 6.915 flips, todos dentro de C o de las seis familias que
 * estaban declaradas entonces MENOS 56, que son exactamente `^-\d+\.\d{3}$` y que
 * la task 3.2 declaró como familia (g).
 *
 * 1. EL SIGNO, QUE LA 3.2 DECLARÓ COMO FAMILIA (g). `numeroDeTexto('-1.000')` es
 *    hoy -1 y el núcleo lo da como `ambiguo`, porque acepta el `-` inicial y
 *    decide la ambigüedad sobre lo que queda. `-1.000` no cumple `isBugCondition`
 *    (la izquierda del punto es `-1`, y C pide todos dígitos) y no caía en ninguna
 *    de las seis familias originales. Se genera igual (`textoDeCConSigno`):
 *    esquivar una clase de flip conocida es volver la propiedad trivialmente
 *    verdadera.
 *
 *    LA DECISIÓN de la 3.2, escrita en §Alcance del diseño: el signo ENTRA en la
 *    ambigüedad, y la clase es la familia (g) (`^-\d+\.\d{3}$`, con el `-`
 *    obligatorio). Se descartó la salida fácil —que el núcleo no trate como
 *    ambiguo un texto con signo— justamente por este lado: una condición
 *    «ganancia < -1.000» se seguiría guardando como -1 y el bug sobreviviría para
 *    los negativos. Las dos filas (g) de la tabla de flips lo prueban.
 *
 * 2. LA FAMILIA (f) NO ES INOCUA EN REGLAS, aunque §Alcance la declare como
 *    «sigue siendo rechazo, cambia el mensaje». Eso vale para el presupuesto,
 *    donde el 0 lo ataja `bajo_el_minimo`. En Reglas no hay mínimo: el núcleo
 *    resuelve `'.'` (y `','`) como 0, así que `numeroDeCampo('.')` daría `ok` con
 *    valor 0. En `problemaAccion` y en `problemaProgramacion` el 0 lo frenan los
 *    cortes que ya existen (`v <= 0`, entero mayor a 0), pero en una CONDICIÓN el
 *    0 es legítimo a propósito (3.9), así que «gasto > .» pasaría de bloquearse
 *    («no es un número», hoy) a guardarse como «gasto > 0» — que en una regla de
 *    pausar significa pausá todo. Es exactamente el modo de falla que 3.7 vino a
 *    evitar, entrando por otra puerta. La fila (f) de la tabla de flips de abajo
 *    afirma lo que el diseño implica (0) y deja anotado que si se decide que el
 *    núcleo rechace un texto sin dígitos, esa fila pasa a `null` y la familia (f)
 *    desaparece del predicado.
 *
 * ─── RESULTADO ESPERADO MIENTRAS EL ARREGLO NO ESTÁ ─────────────────────────
 *
 * La propiedad, los casos que no cambian y la mitad «viejo» de la tabla de flips
 * PASAN (baseline). La mitad «nuevo» FALLA, porque afirma un veredicto que
 * todavía no existe. Está escrita y fallando a propósito: no se comenta ni se
 * marca `skip`.
 */

// ─── Oráculo 2: el `numeroDeTexto` de hoy, congelado ─────────────────────────

/**
 * `numeroDeTexto` tal como está en `ReglasView.tsx:574` antes de la task 3.5.
 * DUPLICADA A PROPÓSITO: ES EL ORÁCULO DE LA REFACTORIZACIÓN.
 *
 * Dos líneas: `trim().replace(',', '.')` y `t === '' ? NaN : Number(t)`. El
 * `replace` sin flag global cambia SÓLO la primera coma, y eso es parte del
 * veredicto de hoy: `'1,234.56'` queda `'1.234.56'` y da NaN.
 */
function numeroDeTextoOriginal(s: string): number {
  const t = s.trim().replace(',', '.');
  return t === '' ? Number.NaN : Number(t);
}

/** El número que Reglas leía, normalizado a `number | null`. */
function leeElOraculo(texto: string): number | null {
  const n = numeroDeTextoOriginal(texto);
  return Number.isFinite(n) ? n : null;
}

/**
 * Las dos formas que el módulo real puede tener, para que este archivo compile y
 * corra en los dos mundos: hoy exporta `numeroDeTexto` (devuelve `number`) y
 * después de la task 3.5 exporta `numeroDeCampo` (devuelve estado). Es el mismo
 * puente que usa `montoAmbiguo.test.ts`, y existe para que `npx tsc --noEmit`
 * siga limpio mientras la mitad «nuevo» de la tabla falla.
 */
const mod = Reglas as unknown as {
  numeroDeCampo?: (s: string) => { estado: string; valor?: number };
  numeroDeTexto?: (s: string) => number;
};

/** `null` significa «Reglas no leyó ningún número de ese texto». */
function leeReglas(texto: string): number | null {
  if (typeof mod.numeroDeCampo === 'function') {
    const r = mod.numeroDeCampo(texto);
    return r.estado === 'ok' && typeof r.valor === 'number' && Number.isFinite(r.valor)
      ? r.valor
      : null;
  }
  const n = mod.numeroDeTexto!(texto);
  return Number.isFinite(n) ? n : null;
}

/** Si el arreglo ya entró: el original dejó de existir. */
const ARREGLO_PUESTO = typeof mod.numeroDeTexto !== 'function';

// ─── El oráculo reproduce el presente ────────────────────────────────────────

/**
 * El número que Reglas lee HOY, texto por texto, medido corriendo el módulo real
 * y pegado acá como literal. Es lo que congela al oráculo para siempre: después
 * de la task 3.5 la implementación real ya no da esto, y esta tabla se lo sigue
 * exigiendo a la copia.
 *
 * `-0` va como `-0` y no como `0`: `toBe` compara con `Object.is`, así que la
 * distinción se conserva. Está pinneado porque es la única entrada donde el signo
 * sobrevive al parseo sin cambiar el valor.
 */
const LECTURAS_DE_HOY: readonly [string, number | null][] = [
  // El vacío: NaN a propósito, para que no se confunda con un 0 deliberado (3.9).
  ['', null],
  [' ', null],
  ['   ', null],
  ['\t\n', null],
  ['\u00a0', null],
  ['\ufeff', null],
  ['\u3000', null],
  // Lo que `Number` no interpreta.
  ['abc', null],
  ['NaN', null],
  ['Infinity', null],
  ['-Infinity', null],
  ['1.2.3', null],
  ['1_000', null],
  ['1.00.000', null],
  ['..', null],
  ['.', null],
  [',', null],
  ['-.', null],
  ['€.', null],
  ['€5', null],
  ['1\u202f000', null],
  ['1\u00a0000', null],
  ['1.000.000', null],
  ['1.234,56', null],
  ['1,234.56', null],
  ['1,000,000', null],
  // La coma decimal, que en Reglas YA funciona y no se puede perder (3.8).
  ['1,5', 1.5],
  ['100,50', 100.5],
  ['10,005', 10.005],
  ['0,01', 0.01],
  // Lo que `Number` interpreta y no debería: la familia (c).
  ['0x10', 16],
  ['0b11', 3],
  ['0o17', 15],
  ['+5', 5],
  ['1e3', 1_000],
  ['1e-3', 0.001],
  // El 0 deliberado y el signo (3.9).
  ['0', 0],
  ['-0', -0],
  ['-5', -5],
  ['.5', 0.5],
  ['5.', 5],
  ['  12.5  ', 12.5],
  ['1000', 1_000],
  // La Bug_Condition: los cuatro números mil veces menores que se leen hoy.
  ['1.000', 1],
  ['1.500', 1.5],
  ['10.000', 10],
  ['0.000', 0],
  // La familia (e) y el hallazgo del signo.
  ['1000.000', 1_000],
  ['12345.678', 12_345.678],
  ['-1.000', -1],
  ['-1000.000', -1_000],
];

describe('el oráculo reproduce el presente', () => {
  it('el módulo expone exactamente uno de los dos parseos, y el oráculo congela el viejo', () => {
    // Sin esto, un import mal escrito dejaría la comprobación de abajo pasando
    // en silencio por la rama que no corresponde.
    expect(
      typeof mod.numeroDeTexto === 'function' || typeof mod.numeroDeCampo === 'function',
      'ReglasView tiene que exportar numeroDeTexto (hoy) o numeroDeCampo (después de la 3.5)',
    ).toBe(true);
  });

  it('lee, texto por texto, el número que la implementación de hoy leía al copiarla', () => {
    for (const [texto, esperado] of LECTURAS_DE_HOY) {
      expect(leeElOraculo(texto), JSON.stringify(texto)).toBe(esperado);
    }
  });

  it('mientras la implementación que congeló siga en su lugar, coincide con ella en TODO texto', () => {
    if (ARREGLO_PUESTO) {
      // `numeroDeTexto` ya no existe, así que «coincidir en todo texto» sería
      // afirmar algo falso por diseño. Lo que queda es la propiedad de
      // preservación de abajo. Acá se afirma lo único cierto en los dos mundos:
      // que el oráculo no se movió.
      expect(leeElOraculo('1.000')).toBe(1);
      return;
    }
    fc.assert(
      fc.property(textoDeCampo, (texto) => {
        expect(leeReglas(texto), JSON.stringify(texto)).toBe(leeElOraculo(texto));
      }),
      { numRuns: 2_000 },
    );
  });
});

// ─── Property 2: Preservation ────────────────────────────────────────────────

describe('Feature: parseo-montos-anuncios, Property 2: Preservation (Reglas)', () => {
  it('para todo texto, si el número que Reglas lee cambió, el texto cumple C o cae en una de las siete familias declaradas', () => {
    fc.assert(
      fc.property(textoDeCampo, (texto) => {
        const viejo = leeElOraculo(texto);
        const nuevo = leeReglas(texto);
        if (Object.is(viejo, nuevo)) return;

        // C va preguntada aparte de las siete familias, como está escrita la
        // propiedad: la Bug_Condition no es una excepción, es el bug.
        expect(
          isBugCondition(texto) || esExcepcionDeclarada(texto),
          `${JSON.stringify(texto)} pasó de leerse como ${viejo} a ${nuevo} y NO está declarado: ` +
            'no cumple la Bug_Condition ni cae en ninguna de las siete familias de §Alcance. ' +
            'La respuesta por defecto es corregir el arreglo; declarar una familia nueva exige ' +
            'agregarla ANTES a §Alcance del diseño y a la tabla de flips de este archivo.',
        ).toBe(true);
      }),
      { numRuns: 2_000 },
    );
  });
});

// ─── Lo que no cambia, y no puede cambiar ────────────────────────────────────

/**
 * Tres textos que caen DENTRO de una familia declarada y que igual tienen que
 * leerse igual. La propiedad de arriba les permitiría cambiar —`'1,5'` tiene
 * coma, o sea familia (a)—, así que sin estos pines la preservación de lo que
 * más importa quedaría sin cubrir: la coma ya funciona en Reglas y es un arreglo
 * anterior de esta misma función (3.8), y el 0 escrito a propósito tiene que
 * seguir siendo guardable (3.9).
 */
const NO_CAMBIAN: readonly [string, number | null, string][] = [
  ['1,5', 1.5, '3.8: la coma decimal ya funciona en Reglas'],
  ['100,50', 100.5, '3.8: y con dos decimales también'],
  ['0', 0, '3.9: el 0 escrito a propósito («ventas <= 0») se sigue leyendo como 0'],
  ['', null, '3.10: el campo vacío no lee ningún número, así que viaja como null y nunca como 0'],
  ['   ', null, '3.10: el campo con espacios tampoco'],
  ['1000', 1_000, '3.1: un importe sin separadores no se toca'],
  ['1.2.3', null, 'lo ilegible sigue siendo ilegible'],
];

describe('los casos que no cambian, con el arreglo puesto o sin él', () => {
  for (const [texto, esperado, por] of NO_CAMBIAN) {
    it(`${JSON.stringify(texto)} se lee como ${esperado} — ${por}`, () => {
      expect(leeElOraculo(texto), 'el oráculo').toBe(esperado);
      expect(leeReglas(texto), 'la implementación real').toBe(esperado);
    });
  }
});

// ─── Guarda 2: la tabla de flips ─────────────────────────────────────────────

/**
 * Un caso por familia, con las DOS columnas: lo que leía el oráculo y lo que lee
 * el arreglo. Sin esta tabla se puede ensanchar una familia para tapar un flip
 * nuevo sin que nada se queje: la propiedad ya lo consideraría declarado y la
 * Property 1 sólo mira los textos de C.
 */
/** `'(a) coma'` → `'(a)'`, `'C'` → `'C'`: la etiqueta con la que la fila declara
 *  su bucket, para poder cruzarla con la que devuelve el predicado. */
const marcadorDe = (familia: string): string => (familia.startsWith('C') ? 'C' : familia.slice(0, 3));

const FLIPS: readonly {
  familia: string;
  texto: string;
  viejo: number | null;
  nuevo: number | null;
  por: string;
}[] = [
  {
    familia: 'C',
    texto: '1.000',
    viejo: 1,
    nuevo: null,
    por: 'el techo que quedaba en 1 EUR y no dejaba subir nada nunca (1.6)',
  },
  {
    familia: 'C',
    texto: '0.000',
    viejo: 0,
    nuevo: null,
    por: 'dentro de C: hoy se lee como 0, que en una condición es «pausá todo»',
  },
  {
    familia: '(a) coma',
    texto: '1,000,000',
    viejo: null,
    nuevo: 1_000_000,
    por: '2.3: la agrupación al estilo inglés se lee; hoy el replace de una sola coma la rompe',
  },
  {
    familia: '(a) coma',
    texto: '1.234,56',
    viejo: null,
    nuevo: 1_234.56,
    por: '2.3: la mixta bien formada se lee',
  },
  {
    familia: '(b) más de un punto',
    texto: '1.000.000',
    viejo: null,
    nuevo: 1_000_000,
    por: '2.3: la agrupación de miles se lee',
  },
  {
    familia: '(c) no es sólo dígitos y puntos',
    texto: '1e3',
    viejo: 1_000,
    nuevo: null,
    por: '2.5: nadie escribe 1e3 en el techo de una regla queriendo decir 1000',
  },
  {
    familia: '(c) no es sólo dígitos y puntos',
    texto: '0x10',
    viejo: 16,
    nuevo: null,
    por: '2.5: el hexadecimal deja de interpretarse',
  },
  {
    familia: '(d) ruido',
    texto: '€5',
    viejo: null,
    nuevo: 5,
    por: '2.5: el símbolo de moneda se limpia',
  },
  {
    familia: '(d) ruido',
    texto: '1\u202f000',
    viejo: null,
    nuevo: 1_000,
    por: '2.5: el espacio fino que pega un Excel se limpia',
  },
  {
    familia: '(e) regla ancha',
    texto: '1000.000',
    viejo: 1_000,
    nuevo: null,
    por: 'la lectura que el arreglo PIERDE a propósito: 1000.000 no tiene una lectura sin ambigüedad',
  },
  {
    familia: '(f) sin dígitos',
    texto: '.',
    viejo: null,
    nuevo: null,
    por:
      'HALLAZGO de la task 2, RESUELTO en la 3.5: el núcleo resuelve «.» como 0, y en una ' +
      'CONDICIÓN el 0 es legítimo (3.9), así que «gasto > .» pasaba de bloquearse a guardarse ' +
      'como «gasto > 0» — el modo de falla de 3.7 por otra puerta. La 3.5 puso la POLÍTICA en ' +
      '`numeroDeCampo` (un texto sin ningún dígito es `error`) y no en el núcleo, que sigue ' +
      'resolviendo 0 porque cambiarlo movería el mensaje de `parsearMonto(".")`, que 3.13 ' +
      'congela. Esta fila es el «pasa a null» que su versión anterior anunciaba; la familia (f) ' +
      'SE QUEDA en el predicado, porque del lado presupuesto «.» sí flipea (no_numero → ' +
      'bajo_el_minimo) y de este lado ya no flipea nada: null antes y null ahora',
  },
  {
    familia: '(a) coma, misma forma que (f)',
    texto: ',',
    viejo: null,
    nuevo: null,
    por: 'la coma sola no tiene ningún dígito igual que el punto solo: el mismo hallazgo, otro carácter',
  },
  {
    familia: '(g) el signo',
    texto: '-1.000',
    viejo: -1,
    nuevo: null,
    por:
      'la clase que la task 2 midió (56 flips de este lado) y la 3.2 declaró: el signo entra en la ' +
      'ambigüedad. Es el caso que decide el bug para los negativos: «ganancia < -1.000» se ' +
      'guardaba como −1 y ahora bloquea el guardado',
  },
  {
    familia: '(g) el signo',
    texto: '-1000.000',
    viejo: -1_000,
    nuevo: null,
    por: 'la otra mitad de (g): la forma de (e) con signo cae en la misma familia, no en (e)',
  },
];

describe('la tabla de flips, mitad «viejo»: el oráculo', () => {
  for (const f of FLIPS) {
    it(`${f.familia} · ${JSON.stringify(f.texto)} leía ${f.viejo}`, () => {
      expect(leeElOraculo(f.texto)).toBe(f.viejo);
    });
  }

  it('cada texto de la tabla cae en el bucket que su fila dice', () => {
    for (const f of FLIPS) {
      const bucket = bucketPermitido(f.texto);
      expect(
        bucket !== null && bucket.startsWith(marcadorDe(f.familia)),
        `${f.familia} · ${JSON.stringify(f.texto)} cae en ${bucket}`,
      ).toBe(true);
    }
  });
});

describe('la tabla de flips, mitad «nuevo»: el arreglo', () => {
  // ESTA MITAD FALLA HASTA LA TASK 3.8, y está escrita y fallando a propósito:
  // afirma un veredicto que todavía no existe. No se comenta ni se marca `skip`.
  for (const f of FLIPS) {
    it(`${f.familia} · ${JSON.stringify(f.texto)} pasa a leerse ${f.nuevo} — ${f.por}`, () => {
      expect(leeReglas(f.texto)).toBe(f.nuevo);
    });
  }
});
