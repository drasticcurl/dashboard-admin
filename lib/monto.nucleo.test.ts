/**
 * Tests del NÚCLEO de lectura (`leerNumeroEscrito`), task 3.2 del spec
 * `parseo-montos-anuncios`.
 *
 * POR QUÉ ESTE ARCHIVO Y NO `monto.test.ts`. Los 12 tests de `lib/monto.test.ts`
 * son la verificación literal de la cláusula 3.13 —«los 12 tests de Finanzas
 * pasan SIN editarse»— y el plan declara que nadie los toca. Todo lo que se
 * agrega sobre el núcleo entra acá, y así el `git diff --stat` de ese archivo
 * sigue en 0.
 *
 * QUÉ SE PRUEBA ACÁ. El núcleo decide QUÉ NÚMERO DICE un texto y nada más. Los
 * cortes de rango, de signo y de decimales son política de cada pantalla y se
 * prueban donde viven: `monto.test.ts` para Finanzas, `presupuesto.test.ts` para
 * el presupuesto diario.
 *
 * Las TRES DIFERENCIAS declaradas del núcleo contra el `parsearMonto` de hoy
 * (acepta el signo, `decimales` es una cantidad y NO chequea `Number.isFinite`)
 * tienen su propio bloque abajo: están anotadas en el tipo, y acá quedan medidas
 * para que ningún consumidor las dé por hechas.
 */
import { describe, expect, it } from 'vitest';
import { leerNumeroEscrito, type NumeroEscrito } from './monto';

/** El resultado como algo que se puede comparar de un vistazo. */
function leer(raw: string): string {
  const r = leerNumeroEscrito(raw);
  return r.ok ? `ok:${r.valor}/${r.decimales}d` : `no:${r.motivo}`;
}

function motivo(raw: string): string {
  const r = leerNumeroEscrito(raw);
  return r.ok ? `ok (${r.valor})` : r.motivo;
}

function ambiguo(raw: string): Extract<NumeroEscrito, { motivo: 'ambiguo' }> {
  const r = leerNumeroEscrito(raw);
  if (r.ok || r.motivo !== 'ambiguo') throw new Error(`${JSON.stringify(raw)} no dio ambiguo: ${motivo(raw)}`);
  return r;
}

describe('leerNumeroEscrito: los cuatro motivos', () => {
  it('vacio: no quedó nada después de limpiar el ruido', () => {
    for (const raw of ['', ' ', '   ', '\t\n', '\u00a0', '\u202f', '\u2009', '\ufeff', '€', ' € ', '$', '€ $']) {
      expect(motivo(raw), JSON.stringify(raw)).toBe('vacio');
    }
  });

  it('caracteres: hay algo que no es dígito, coma ni punto', () => {
    // Todo lo que `Number` interpretaba y un campo de plata no debería aceptar:
    // el criterio es «sólo números, coma o punto» (2.5).
    for (const raw of ['abc', '10a', 'NaN', 'Infinity', '-Infinity', '1e3', '1e-3', '0x10', '0b11', '0o17', '+5', '1_000', '-abc', '--5', '-']) {
      expect(motivo(raw), JSON.stringify(raw)).toBe('caracteres');
    }
  });

  it('ilegible: los separadores no forman ningún número', () => {
    for (const raw of ['1.00.000', '1,00,000', '1,2,3', '1.2.3', '1.2345,67', '12,3456.7']) {
      expect(motivo(raw), JSON.stringify(raw)).toBe('ilegible');
    }
  });

  it('ambiguo: un punto con exactamente 3 dígitos a la derecha', () => {
    for (const raw of ['1.000', '1.500', '2.500', '10.000', '999.999', '0.000', '0.009']) {
      expect(motivo(raw), JSON.stringify(raw)).toBe('ambiguo');
    }
  });

  it('la ambigüedad trae las DOS lecturas y la frase ya armada', () => {
    const r = ambiguo('1.000');
    expect(r.comoMiles).toBe('1000');
    expect(r.comoDecimal).toBe('1');
    expect(r.explicacion).toBe(
      '"1.000" se puede leer de dos formas: escribí 1000 si querés decir 1000, o 1 si querés decir 1',
    );
    // La frase no nombra ningún sustantivo: es lo que hace que la misma cadena
    // sirva para un importe, para un ROI y para un límite de ejecuciones.
    expect(r.explicacion).not.toContain('monto');
    expect(r.explicacion).not.toContain('importe');
  });

  it('la frase cita el texto como se escribió, no el texto limpio', () => {
    // Es lo que hace que `parsearMonto('€1.000')` siga diciendo `"€1.000"`, que
    // es el mensaje de hoy y 3.13 lo congela.
    expect(ambiguo('€1.000').explicacion).toContain('"€1.000"');
    expect(ambiguo(' 1.000 ').explicacion).toContain('"1.000"');
  });
});

describe('leerNumeroEscrito: qué número dice el texto', () => {
  it('la coma decimal y el punto decimal', () => {
    expect(leer('100,50')).toBe('ok:100.5/2d');
    expect(leer('0,99')).toBe('ok:0.99/2d');
    expect(leer('1234,5')).toBe('ok:1234.5/1d');
    expect(leer('100.50')).toBe('ok:100.5/2d');
    expect(leer('100.5')).toBe('ok:100.5/1d');
    expect(leer('0.99')).toBe('ok:0.99/2d');
  });

  it('los enteros pelados', () => {
    expect(leer('0')).toBe('ok:0/0d');
    expect(leer('1')).toBe('ok:1/0d');
    expect(leer('999999')).toBe('ok:999999/0d');
  });

  it('las dos agrupaciones de miles', () => {
    expect(leer('1.000.000')).toBe('ok:1000000/0d');
    expect(leer('1,000,000')).toBe('ok:1000000/0d');
  });

  it('las dos mixtas: manda el separador que aparece último', () => {
    expect(leer('1.234,56')).toBe('ok:1234.56/2d');
    expect(leer('1,234.56')).toBe('ok:1234.56/2d');
    expect(leer('12.345.678,90')).toBe('ok:12345678.9/2d');
    expect(leer('1.500,00')).toBe('ok:1500/2d');
  });

  it('«.5», «5.» y «.» solo, que resuelve como 0', () => {
    // El punto solo da 0 donde `Number('.')` daba NaN. Es la familia (f) de
    // §Alcance: declarada y no corregida, porque corregirla cambiaría el mensaje
    // de `parsearMonto('.')` y 3.13 congela los mensajes.
    expect(leer('.5')).toBe('ok:0.5/1d');
    expect(leer('5.')).toBe('ok:5/0d');
    expect(leer('.')).toBe('ok:0/0d');
    expect(leer(',')).toBe('ok:0/0d');
    expect(leer(',5')).toBe('ok:0.5/1d');
    expect(leer('5,')).toBe('ok:5/0d');
  });

  it('la cantidad de decimales que reporta es la que el texto tiene escrita', () => {
    // Es una CANTIDAD y no un veredicto: cada pantalla pone su propio límite
    // (numeric(14,2) en Finanzas y presupuesto, numeric(16,4) en las condiciones).
    const decimalesDe = (raw: string): number => {
      const r = leerNumeroEscrito(raw);
      if (!r.ok) throw new Error(`${JSON.stringify(raw)} no se pudo leer: ${motivo(raw)}`);
      return r.decimales;
    };
    expect(decimalesDe('5.')).toBe(0);
    expect(decimalesDe('1000')).toBe(0);
    expect(decimalesDe('1.000.000')).toBe(0);
    expect(decimalesDe('1,000,000')).toBe(0);
    expect(decimalesDe('100.5')).toBe(1);
    expect(decimalesDe('0,99')).toBe(2);
    expect(decimalesDe('1.234,56')).toBe(2);
    expect(decimalesDe('10,005')).toBe(3);
    expect(decimalesDe('1.234,5678')).toBe(4);
    // Los ceros a la derecha cuentan: son los que el usuario escribió.
    expect(decimalesDe('1,00')).toBe(2);
  });

  it('el ruido de un copy-paste se limpia: €, espacio fino, espacio duro y BOM', () => {
    expect(leer('€100,50')).toBe('ok:100.5/2d');
    expect(leer('$100,50')).toBe('ok:100.5/2d');
    expect(leer(' 100,50 ')).toBe('ok:100.5/2d');
    expect(leer('1 234,56')).toBe('ok:1234.56/2d');
    expect(leer('1\u00a0234,56')).toBe('ok:1234.56/2d');
    expect(leer('1\u202f234,56')).toBe('ok:1234.56/2d');
    expect(leer('1\u2009234,56')).toBe('ok:1234.56/2d');
    expect(leer('\ufeff1234,56')).toBe('ok:1234.56/2d');
    expect(leer('1 000')).toBe('ok:1000/0d');
  });
});

describe('leerNumeroEscrito: las tres diferencias declaradas', () => {
  it('1. el negativo vuelve como VALOR NEGATIVO, no como error', () => {
    // El signo es política del llamador: en Finanzas lo pone el tipo de
    // movimiento, en un presupuesto es «bajo el mínimo» y en una condición
    // («ganancia < -10») es legítimo. El núcleo no opina.
    expect(leer('-5')).toBe('ok:-5/0d');
    expect(leer('-100,50')).toBe('ok:-100.5/2d');
    expect(leer('-1.234,56')).toBe('ok:-1234.56/2d');
    expect(leer('-1.000.000')).toBe('ok:-1000000/0d');
    expect(leer('-.5')).toBe('ok:-0.5/1d');
    expect(leer('-€5')).toBe('ok:-5/0d');
    // El -0 sobrevive: es la única entrada donde el signo no cambia el valor, y
    // Reglas lo lee así hoy.
    const cero = leerNumeroEscrito('-0');
    expect(cero.ok).toBe(true);
    if (cero.ok) expect(Object.is(cero.valor, -0)).toBe(true);
  });

  it('2. el signo NO esquiva la ambigüedad: «-1.000» es −1000 o −1 — familia (g)', () => {
    // Medido en la task 2 (64 flips del lado presupuesto, 56 del lado Reglas) y
    // decidido en la 3.2. La alternativa —que el núcleo no mire el signo— deja el
    // bug vivo para los negativos: una condición «ganancia < -1.000» se seguiría
    // guardando como −1, que es el mismo modo de falla que este parseo vino a
    // arreglar. Un campo de número no adivina, y eso no depende del signo.
    const r = ambiguo('-1.000');
    expect(r.comoMiles).toBe('-1000');
    expect(r.comoDecimal).toBe('-1');
    expect(r.explicacion).toBe(
      '"-1.000" se puede leer de dos formas: escribí -1000 si querés decir -1000, o -1 si querés decir -1',
    );
    for (const raw of ['-1.000', '-1.500', '-0.000', '-1000.000', '-12345.678']) {
      expect(motivo(raw), JSON.stringify(raw)).toBe('ambiguo');
    }
  });

  it('3. NO chequea Number.isFinite: 400 dígitos vuelven como Infinity con ok:true', () => {
    // Incomoda y es deliberado: `parsearMonto` mira los decimales ANTES de la
    // finitud, así que 400 dígitos con cuatro decimales devuelven «el monto lleva
    // 2 decimales como máximo» y no «no se entiende el monto». Si el núcleo
    // rechazara la finitud, ese mensaje cambiaría y 3.13 lo congela.
    const r = leerNumeroEscrito(`${'9'.repeat(400)},0000`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.valor).toBe(Number.POSITIVE_INFINITY);
      expect(r.decimales).toBe(4);
    }
    const neg = leerNumeroEscrito(`-${'9'.repeat(400)}`);
    expect(neg.ok).toBe(true);
    if (neg.ok) expect(neg.valor).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe('leerNumeroEscrito: la regla de la ambigüedad es ancha a propósito', () => {
  it('no mira cuántos dígitos hay a la izquierda: «1000.000» también es ambiguo', () => {
    // El corte es `derecha.length === 3 && corte > 0`. Angostarlo a 1–3 dígitos
    // haría que `parsearMonto('1000.000')` pase de rechazar a devolver 1000, que
    // es exactamente lo que 3.13 prohíbe. Y `1000.000` tampoco tiene una lectura
    // sin ambigüedad: como agrupación está mal formado, como decimal es 1000,000.
    expect(motivo('1000.000')).toBe('ambiguo');
    expect(motivo('12345.678')).toBe('ambiguo');
    expect(ambiguo('1000.000').comoMiles).toBe('1000000');
    expect(ambiguo('1000.000').comoDecimal).toBe('1000');
  });

  it('hace falta un dígito a la izquierda y exactamente tres a la derecha', () => {
    // `corte > 0`: sin nada a la izquierda no hay dos lecturas, es un decimal.
    expect(leer('.000')).toBe('ok:0/3d');
    // Dos o cuatro decimales no son ambiguos: sólo tres se pueden confundir con
    // una agrupación de miles.
    expect(leer('1.00')).toBe('ok:1/2d');
    expect(leer('1.0000')).toBe('ok:1/4d');
    // Con coma no hay ambigüedad en ningún caso: la coma es el decimal del
    // castellano y una sola coma nunca agrupa.
    expect(leer('1,000')).toBe('ok:1/3d');
  });
});
