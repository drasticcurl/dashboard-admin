import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MINIMO_EUR, parsearPresupuesto } from './presupuesto';
import {
  bucketPermitido,
  esExcepcionDeclarada,
  isBugCondition,
  techoPositivo,
  textoDeCampo,
} from '../test/preservacion-montos';

/**
 * Feature: parseo-montos-anuncios — Property 2: Preservation
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.13**
 *
 * EL VEREDICTO DEL PRESUPUESTO SÓLO CAMBIA DONDE ESTÁ DECLARADO. La propiedad no
 * está escrita como una tabla («este texto da esto») sino al revés: **si algo
 * cambió, tiene que estar declarado**. Escrita así, cualquier cambio de veredicto
 * que el arreglo introduzca sin querer aparece como contraejemplo con el texto
 * exacto que lo dispara, incluidos los textos que a nadie se le ocurrieron —que
 * es donde vivía el bug original.
 *
 * ─── POR QUÉ HAY UNA IMPLEMENTACIÓN DUPLICADA ACÁ ADENTRO ───────────────────
 *
 * `parsearPresupuestoOriginal` es el cuerpo de `parsearPresupuesto` de hoy,
 * copiado línea por línea. Está duplicado A PROPÓSITO: es el oráculo de la
 * refactorización. La task 3.3 reemplaza la implementación real, y sin esta copia
 * no queda con qué comparar. El precedente está en el módulo de al lado:
 * `presupuesto.test.ts` congela igual la `reglaOriginal` del `valido` de
 * `FormularioPresupuesto`, con el mismo comentario.
 *
 * NO SE ACTUALIZA NUNCA. Si el arreglo lo hace fallar, lo que se discute es el
 * arreglo o el diseño, no el oráculo.
 *
 * ─── OBSERVADO ANTES DE AFIRMAR ─────────────────────────────────────────────
 *
 * Un oráculo que no reproduce el presente no sirve de nada, así que se midió
 * antes de escribir la propiedad, corriendo el módulo real contra la copia:
 *
 *   · 59 textos × 6 techos (100, 5000, NaN, 0, 0,01 y 1e21) = 354 combinaciones,
 *     0 divergencias.
 *   · Sobre los generadores de `presupuesto.test.ts` (que incluyen `0x10`,
 *     `0b11`, `0o17`, `+5`, `.5`, `5.`, los espacios unicode y el BOM) más las
 *     ramas nuevas de las seis familias: 0 divergencias.
 *
 * Las dos cosas quedan como test: la tabla pinneada de abajo congela el oráculo
 * texto por texto (y sigue valiendo después del arreglo), y la comprobación
 * estricta exige igualdad en TODO texto mientras la implementación que el oráculo
 * congeló siga en su lugar.
 *
 * ─── EL HALLAZGO DE LA TASK 2, Y CÓMO LO CERRÓ LA 3.2 ───────────────────────
 *
 * Al comparar el oráculo contra una simulación del arreglo (el núcleo del diseño
 * + la política del presupuesto) sobre 404.661 combinaciones, aparecieron 14.870
 * flips. Todos caen en la Bug_Condition o en las seis familias que estaban
 * declaradas entonces MENOS UNA CLASE, que son 64 y se describen exactamente con
 * `^-\d+\.\d{3}$`:
 *
 *     parsearPresupuesto('-1.000', 100)     hoy → bajo_el_minimo
 *                                        simulado → ambiguo
 *
 * `-1.000` no cumple `isBugCondition` (la izquierda del punto es `-1`, y C pide
 * que sean todos dígitos) y no caía en ninguna de las seis, pero el núcleo acepta
 * el `-` inicial y decide la ambigüedad sobre lo que queda. Es un rechazo que
 * sigue siendo rechazo y cambia de mensaje, la misma forma que la familia (f) y
 * la mitad de la (e).
 *
 * Se generan igual (`textoDeCConSigno`) en lugar de esquivarse: una propiedad que
 * no genera una clase de flip conocida es el «predicado trivialmente verdadero»
 * contra el que el plan pone las dos guardas.
 *
 * LA DECISIÓN, tomada en la task 3.2: **el signo entra en la ambigüedad**, y la
 * clase se declara como **familia (g)** en §Alcance del diseño, con el `-`
 * obligatorio (`^-\d+\.\d{3}$`; sin signo esa forma ya es C o (e)). Se descartó
 * la alternativa —que el núcleo no trate como ambiguo un texto con signo— porque
 * deja el bug vivo para los negativos: una condición de Reglas «ganancia <
 * -1.000» se seguiría guardando como −1. Las dos filas (g) de la tabla de flips
 * de abajo son la prueba de que el flip ocurre, con los dos veredictos.
 *
 * ─── RESULTADO ESPERADO MIENTRAS EL ARREGLO NO ESTÁ ─────────────────────────
 *
 * La propiedad y la mitad «viejo» de la tabla de flips PASAN (es el baseline).
 * La mitad «nuevo» FALLA, porque afirma un veredicto que todavía no existe. Está
 * escrita y fallando a propósito: no se comenta ni se marca `skip`.
 */

// ─── Oráculo 1: el `parsearPresupuesto` de hoy, congelado ────────────────────

/** Los motivos de hoy. Local y no importado: la task 3.3 le suma `ambiguo` al
 *  enum real y le agrega `texto` a la rama de rechazo, y el oráculo no tiene que
 *  seguir ninguno de los dos cambios. */
type MotivoOriginal =
  | 'vacio'
  | 'no_numero'
  | 'bajo_el_minimo'
  | 'sobre_el_techo'
  | 'mas_de_dos_decimales';

type PresupuestoOriginal = { ok: true; valor: number } | { ok: false; motivo: MotivoOriginal };

/**
 * `parsearPresupuesto` tal como está en `lib/ads/presupuesto.ts:86` antes de la
 * task 3.3. DUPLICADA A PROPÓSITO: ES EL ORÁCULO DE LA REFACTORIZACIÓN.
 *
 * Seis cortes, en este orden: el `trim()` a `vacio`, `Number()`,
 * `Number.isFinite`, `!(n >= MINIMO_EUR)`, `!(n <= techoEur)` y
 * `Number(n.toFixed(2)) !== n`.
 *
 * El mínimo va como literal `0.01` y no como `MINIMO_EUR`: un oráculo que
 * importa una constante de la implementación se mueve cuando la constante se
 * mueve, y entonces deja de ser el veredicto de hoy. La deriva no queda muda: el
 * primer test de abajo falla si `MINIMO_EUR` deja de ser 0,01.
 */
function parsearPresupuestoOriginal(texto: string, techoEur: number): PresupuestoOriginal {
  if (texto.trim() === '') return { ok: false, motivo: 'vacio' };

  const n = Number(texto);
  if (!Number.isFinite(n)) return { ok: false, motivo: 'no_numero' };
  if (!(n >= 0.01)) return { ok: false, motivo: 'bajo_el_minimo' };
  if (!(n <= techoEur)) return { ok: false, motivo: 'sobre_el_techo' };
  if (Number(n.toFixed(2)) !== n) return { ok: false, motivo: 'mas_de_dos_decimales' };

  return { ok: true, valor: n };
}

/**
 * El veredicto como una cadena: `'ok:12.5'` o `'no:bajo_el_minimo'`.
 *
 * Es lo que la propiedad compara, y compara esto y no los objetos enteros por
 * dos razones. La primera es que el diseño define «el mismo veredicto» como
 * mismo `ok`, mismo `valor` cuando acepta y mismo motivo cuando rechaza: el
 * campo `texto` que la task 3.3 agrega al rechazo no es un cambio de veredicto,
 * así que un `toEqual` del objeto entero fallaría para TODO rechazo y no probaría
 * nada. La segunda es de tipos: comparar `r.motivo === 'ambiguo'` contra la unión
 * de hoy es un error de compilación (los tipos no se solapan), y `npx tsc
 * --noEmit` tiene que seguir limpio mientras la mitad «nuevo» de la tabla falla.
 */
function veredicto(r: { ok: true; valor: number } | { ok: false; motivo: string }): string {
  return r.ok ? `ok:${r.valor}` : `no:${r.motivo}`;
}

/**
 * Si el arreglo ya entró. Se detecta por el comportamiento y no por la forma:
 * «1.000» deja de aceptarse es LA transición de todo este spec, así que no puede
 * quedar mal nombrada ni cambiar de campo. Sirve para que la comprobación
 * estricta de fidelidad del oráculo se retire sola cuando la implementación que
 * congeló deje de existir, en lugar de volverse una aserción falsa.
 */
const ARREGLO_PUESTO = !parsearPresupuesto('1.000', 5_000).ok;

const TECHO = 100;

// ─── El oráculo reproduce el presente ────────────────────────────────────────

/**
 * El veredicto de HOY, texto por texto, medido corriendo el módulo real (vitest,
 * environment node) y pegado acá como literal. Es lo que congela al oráculo para
 * siempre: después de la task 3.3 la implementación real ya no da esto, y esta
 * tabla sigue exigiéndoselo a la copia.
 *
 * Los textos son los de los generadores de `presupuesto.test.ts` —`0x10`,
 * `0b11`, `0o17`, `+5`, `.5`, `5.`, el espacio fino, el duro, el ideográfico y
 * el BOM— más los que el diseño nombra en §Examples y en §Alcance.
 */
const VEREDICTOS_DE_HOY: readonly [string, string][] = [
  // Vacío: `Number('   ')` es 0, pero el campo se ve en blanco (3.2).
  ['', 'no:vacio'],
  [' ', 'no:vacio'],
  ['   ', 'no:vacio'],
  ['\t\n', 'no:vacio'],
  ['\u00a0', 'no:vacio'],
  ['\ufeff', 'no:vacio'],
  ['\u3000', 'no:vacio'],
  // Lo que `Number` no interpreta, incluidos NaN e Infinity escritos.
  ['abc', 'no:no_numero'],
  ['NaN', 'no:no_numero'],
  ['Infinity', 'no:no_numero'],
  ['-Infinity', 'no:no_numero'],
  ['1,5', 'no:no_numero'],
  ['1.2.3', 'no:no_numero'],
  ['1_000', 'no:no_numero'],
  ['1.00.000', 'no:no_numero'],
  ['..', 'no:no_numero'],
  ['.', 'no:no_numero'],
  ['-.', 'no:no_numero'],
  ['€.', 'no:no_numero'],
  ['€5', 'no:no_numero'],
  ['1\u202f000', 'no:no_numero'],
  ['1\u00a0000', 'no:no_numero'],
  ['100,50', 'no:no_numero'],
  ['1.000.000', 'no:no_numero'],
  ['1.234,56', 'no:no_numero'],
  ['1,234.56', 'no:no_numero'],
  ['10,005', 'no:no_numero'],
  // Lo que `Number` SÍ interpreta y no debería: es la familia (c) de §Alcance.
  ['0x10', 'ok:16'],
  ['0b11', 'ok:3'],
  ['0o17', 'ok:15'],
  ['+5', 'ok:5'],
  ['1e2', 'ok:100'],
  ['1e-3', 'no:bajo_el_minimo'],
  ['1e21', 'no:sobre_el_techo'],
  // El cero, los negativos y el borde del mínimo.
  ['0', 'no:bajo_el_minimo'],
  ['-0', 'no:bajo_el_minimo'],
  ['-5', 'no:bajo_el_minimo'],
  ['0.009', 'no:bajo_el_minimo'],
  ['0.005', 'no:bajo_el_minimo'],
  ['0.001', 'no:bajo_el_minimo'],
  ['0.01', 'ok:0.01'],
  // Los dos bordes cerrados y el punto suelto de cada lado.
  ['.5', 'ok:0.5'],
  ['5.', 'ok:5'],
  ['100', 'ok:100'],
  ['100.00', 'ok:100'],
  ['  12.5  ', 'ok:12.5'],
  // Sobre el techo y más de dos decimales.
  ['100.01', 'no:sobre_el_techo'],
  ['1000', 'no:sobre_el_techo'],
  ['100.001', 'no:sobre_el_techo'],
  ['10.005', 'no:mas_de_dos_decimales'],
  ['12.345', 'no:mas_de_dos_decimales'],
  ['0.011', 'no:mas_de_dos_decimales'],
  // La Bug_Condition: los cuatro importes mil veces menores que se aceptan hoy.
  ['1.000', 'ok:1'],
  ['1.500', 'ok:1.5'],
  ['10.000', 'ok:10'],
  ['0.000', 'no:bajo_el_minimo'],
  // La familia (e) y el hallazgo del signo.
  ['1000.000', 'no:sobre_el_techo'],
  ['12345.678', 'no:sobre_el_techo'],
  ['-1.000', 'no:bajo_el_minimo'],
  ['-1000.000', 'no:bajo_el_minimo'],
];

/** Los mismos textos con otros techos, incluidos los dos que no son un número
 *  positivo: es el veredicto que 3.4 congela. */
const VEREDICTOS_POR_TECHO: readonly [string, number, string][] = [
  ['1000.000', 5_000, 'ok:1000'],
  ['12345.678', 5_000, 'no:sobre_el_techo'],
  ['100,50', 5_000, 'no:no_numero'],
  ['1\u202f000', 5_000, 'no:no_numero'],
  ['0.01', 0.01, 'ok:0.01'],
  ['10', Number.NaN, 'no:sobre_el_techo'],
  ['10', 0, 'no:sobre_el_techo'],
  ['0.01', Number.NaN, 'no:sobre_el_techo'],
];

describe('el oráculo reproduce el presente', () => {
  it('el mínimo que el oráculo tiene escrito a mano sigue siendo el de la implementación', () => {
    // Si esto falla, `MINIMO_EUR` se movió y el oráculo dejó de ser el veredicto
    // de hoy: hay que decidir si el cambio del mínimo es deliberado ANTES de
    // mirar cualquier otro fallo de este archivo.
    expect(MINIMO_EUR).toBe(0.01);
  });

  it('da, texto por texto, el veredicto que la implementación de hoy daba al copiarlo', () => {
    for (const [texto, esperado] of VEREDICTOS_DE_HOY) {
      expect(veredicto(parsearPresupuestoOriginal(texto, TECHO)), JSON.stringify(texto)).toBe(esperado);
    }
  });

  it('reproduce también los techos que no son un número positivo (3.4)', () => {
    for (const [texto, techo, esperado] of VEREDICTOS_POR_TECHO) {
      expect(
        veredicto(parsearPresupuestoOriginal(texto, techo)),
        `${JSON.stringify(texto)} con techo ${techo}`,
      ).toBe(esperado);
    }
  });

  it('mientras la implementación que congeló siga en su lugar, coincide con ella en TODO texto', () => {
    if (ARREGLO_PUESTO) {
      // El arreglo ya entró: la implementación que este oráculo congeló no existe
      // más, así que exigir igualdad en todo texto sería afirmar algo falso por
      // diseño. Lo que queda es la propiedad de preservación de abajo, que es la
      // forma durable de la misma comprobación. Acá sólo se afirma lo único que
      // sigue siendo cierto en los dos mundos: que el oráculo no se movió.
      expect(veredicto(parsearPresupuestoOriginal('1.000', 5_000))).toBe('ok:1');
      return;
    }
    fc.assert(
      fc.property(textoDeCampo, techoPositivo, (texto, techoEur) => {
        expect(
          veredicto(parsearPresupuesto(texto, techoEur)),
          `${JSON.stringify(texto)} con techo ${techoEur}`,
        ).toBe(veredicto(parsearPresupuestoOriginal(texto, techoEur)));
      }),
      { numRuns: 2_000 },
    );
  });
});

// ─── Property 2: Preservation ────────────────────────────────────────────────

describe('Feature: parseo-montos-anuncios, Property 2: Preservation', () => {
  it('para todo texto y todo techo positivo, si el veredicto cambió, el texto cumple C o cae en una de las siete familias declaradas', () => {
    fc.assert(
      fc.property(textoDeCampo, techoPositivo, (texto, techoEur) => {
        const viejo = veredicto(parsearPresupuestoOriginal(texto, techoEur));
        const nuevo = veredicto(parsearPresupuesto(texto, techoEur));
        if (viejo === nuevo) return;

        // C va preguntada aparte de las siete familias, como está escrita la
        // propiedad: la Bug_Condition no es una excepción, es el bug.
        expect(
          isBugCondition(texto) || esExcepcionDeclarada(texto),
          `${JSON.stringify(texto)} con techo ${techoEur} cambió de ${viejo} a ${nuevo} y NO está declarado: ` +
            'no cumple la Bug_Condition ni cae en ninguna de las siete familias de §Alcance. ' +
            'La respuesta por defecto es corregir el arreglo; declarar una familia nueva exige ' +
            'agregarla ANTES a §Alcance del diseño y a la tabla de flips de este archivo.',
        ).toBe(true);
      }),
      { numRuns: 2_000 },
    );
  });

  it('fuera de C y de las siete familias, coincide campo por campo: ok, valor y motivo', () => {
    // La contrarrecíproca de la propiedad de arriba, escrita sobre los objetos y
    // no sobre la cadena del veredicto. Aporta dos cosas: nombra el campo que
    // cambió (un texto que hoy se rechaza por `mas_de_dos_decimales` y mañana por
    // `sobre_el_techo` sigue siendo un rechazo y es otro mensaje en la pantalla,
    // 3.3 y 3.6), y compara los valores con `Object.is`, que distingue lo que
    // `String(valor)` empareja: 0 y -0.
    fc.assert(
      fc.property(textoDeCampo, techoPositivo, (texto, techoEur) => {
        if (bucketPermitido(texto) !== null) return;
        const viejo = parsearPresupuestoOriginal(texto, techoEur);
        const nuevo = parsearPresupuesto(texto, techoEur);
        expect(nuevo.ok, `${JSON.stringify(texto)} con techo ${techoEur}`).toBe(viejo.ok);
        if (!viejo.ok && !nuevo.ok) {
          expect(nuevo.motivo, `motivo de ${JSON.stringify(texto)}`).toBe(viejo.motivo);
        }
        if (viejo.ok && nuevo.ok) {
          expect(nuevo.valor, `valor de ${JSON.stringify(texto)}`).toBe(viejo.valor);
        }
      }),
      { numRuns: 2_000 },
    );
  });
});

// ─── Guarda 2: la tabla de flips ─────────────────────────────────────────────

/**
 * Un caso por familia, con las DOS columnas: el veredicto viejo contra el oráculo
 * y el nuevo contra el arreglo.
 *
 * Sin esta tabla la propiedad de arriba se puede volver trivial sin que nada se
 * queje: alcanza con ensanchar una familia para tapar un flip nuevo, y ni la
 * propiedad (que ya lo consideraría declarado) ni la Property 1 (que sólo mira
 * los textos de C) lo agarran. Acá cada familia tiene que DEMOSTRAR que su flip
 * ocurre, y con qué veredicto exacto de los dos lados.
 *
 * Las dos filas de C no son una de las siete familias: van porque el predicado las
 * usa como bucket y porque el flip que muestran es un cambio de MOTIVO, que la
 * Property 1 de `montoAmbiguo.test.ts` no mira (ahí se afirma el rechazo y las
 * dos lecturas, no el motivo). `0.000` es el hallazgo de la task 1: dentro de C
 * hay textos que HOY ya se rechazan, pero por el motivo equivocado y con un
 * mensaje que no ofrece ninguna lectura.
 */
/** `'(a) coma'` → `'(a)'`, `'C'` → `'C'`: la etiqueta con la que la fila declara
 *  su bucket, para poder cruzarla con la que devuelve el predicado. */
const marcadorDe = (familia: string): string => (familia.startsWith('C') ? 'C' : familia.slice(0, 3));

const FLIPS: readonly {
  familia: string;
  texto: string;
  techo: number;
  viejo: string;
  nuevo: string;
  por: string;
}[] = [
  {
    familia: 'C',
    texto: '1.000',
    techo: TECHO,
    viejo: 'ok:1',
    nuevo: 'no:ambiguo',
    por: 'el importe que llegaba a Meta como daily_budget 100 (1.1)',
  },
  {
    familia: 'C',
    texto: '0.000',
    techo: TECHO,
    viejo: 'no:bajo_el_minimo',
    nuevo: 'no:ambiguo',
    por: 'dentro de C, hoy se rechaza por el motivo equivocado (hallazgo de la task 1)',
  },
  {
    familia: '(a) coma',
    texto: '100,50',
    techo: 5_000,
    viejo: 'no:no_numero',
    nuevo: 'ok:100.5',
    por: '2.2: la coma decimal se acepta, como en Finanzas',
  },
  {
    familia: '(a) coma',
    texto: '10,005',
    techo: TECHO,
    viejo: 'no:no_numero',
    nuevo: 'no:mas_de_dos_decimales',
    por: '2.2 con el corte de decimales intacto: sigue siendo rechazo y cambia de motivo',
  },
  {
    familia: '(b) más de un punto',
    texto: '1.000.000',
    techo: 5_000,
    viejo: 'no:no_numero',
    nuevo: 'no:sobre_el_techo',
    por: '2.3: la agrupación de miles se lee, y recién ahí la agarra el techo',
  },
  {
    familia: '(c) no es sólo dígitos y puntos',
    texto: '1e2',
    techo: TECHO,
    viejo: 'ok:100',
    nuevo: 'no:no_numero',
    por: '2.5: la notación exponencial pasa de interpretarse a rechazarse',
  },
  {
    familia: '(c) no es sólo dígitos y puntos',
    texto: '0x10',
    techo: TECHO,
    viejo: 'ok:16',
    nuevo: 'no:no_numero',
    por: '2.5: nadie tipea 0x10 en un presupuesto queriendo decir 16 euros',
  },
  {
    familia: '(c) no es sólo dígitos y puntos',
    texto: '+5',
    techo: TECHO,
    viejo: 'ok:5',
    nuevo: 'no:no_numero',
    por: '2.5: el signo + no es «sólo números, coma o punto»',
  },
  {
    familia: '(d) ruido',
    texto: '€5',
    techo: TECHO,
    viejo: 'no:no_numero',
    nuevo: 'ok:5',
    por: '2.5 en la dirección contraria: el símbolo de moneda se limpia',
  },
  {
    familia: '(d) ruido',
    texto: '1\u202f000',
    techo: 5_000,
    viejo: 'no:no_numero',
    nuevo: 'ok:1000',
    por: '2.5: el espacio fino que pega un Excel se limpia',
  },
  {
    familia: '(e) regla ancha',
    texto: '1000.000',
    techo: 5_000,
    viejo: 'ok:1000',
    nuevo: 'no:ambiguo',
    por: 'la aceptación que el arreglo PIERDE a propósito: 1000.000 no tiene una lectura sin ambigüedad',
  },
  {
    familia: '(e) regla ancha',
    texto: '12345.678',
    techo: 5_000,
    viejo: 'no:sobre_el_techo',
    nuevo: 'no:ambiguo',
    por: 'la otra mitad de (e): sigue siendo rechazo y cambia de motivo',
  },
  {
    familia: '(f) sin dígitos',
    texto: '.',
    techo: TECHO,
    viejo: 'no:no_numero',
    nuevo: 'no:bajo_el_minimo',
    por: 'el núcleo resuelve «.» como 0 donde Number daba NaN: sigue siendo rechazo, cambia el mensaje',
  },
  {
    familia: '(g) el signo',
    texto: '-1.000',
    techo: TECHO,
    viejo: 'no:bajo_el_minimo',
    nuevo: 'no:ambiguo',
    por:
      'la clase que la task 2 midió y la 3.2 declaró: el signo entra en la ambigüedad, porque si ' +
      'el núcleo no lo mirara, «ganancia < -1.000» se seguiría guardando como −1',
  },
  {
    familia: '(g) el signo',
    texto: '-1000.000',
    techo: TECHO,
    viejo: 'no:bajo_el_minimo',
    nuevo: 'no:ambiguo',
    por: 'la otra mitad de (g): la forma de (e) con signo cae en la misma familia, no en (e)',
  },
];

describe('la tabla de flips, mitad «viejo»: el oráculo', () => {
  for (const f of FLIPS) {
    it(`${f.familia} · ${JSON.stringify(f.texto)} daba ${f.viejo}`, () => {
      expect(veredicto(parsearPresupuestoOriginal(f.texto, f.techo))).toBe(f.viejo);
    });
  }

  it('cada texto de la tabla cae en el bucket que su fila dice', () => {
    // No alcanza con que caiga en ALGUNO: si un texto se muda de familia, la
    // tabla deja de probar lo que su nombre dice y el predicado y la tabla se
    // desincronizan, que es el mismo error que este spec vino a arreglar un nivel
    // más arriba.
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
    it(`${f.familia} · ${JSON.stringify(f.texto)} pasa a ${f.nuevo} — ${f.por}`, () => {
      expect(veredicto(parsearPresupuesto(f.texto, f.techo))).toBe(f.nuevo);
    });
  }
});
