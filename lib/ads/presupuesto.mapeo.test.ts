import { describe, expect, it } from 'vitest';
import { parsearPresupuesto, textoDeMotivo, type MotivoPresupuesto } from './presupuesto';

/**
 * Feature: parseo-montos-anuncios, task 3.3 — LAS CINCO ENTRADAS DEL MAPEO
 * NÚCLEO → MOTIVO, PINNEADAS CASO POR CASO.
 *
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.5, 3.1, 3.2, 3.3, 3.4, 3.6**
 *
 * POR QUÉ ESTE ARCHIVO EXISTE APARTE. `parsearPresupuesto` dejó de hacer
 * `Number(texto)` y ahora le pregunta al núcleo compartido (`leerNumeroEscrito`
 * en `lib/monto.ts`) qué número dice el texto. El núcleo tiene cuatro motivos y
 * el presupuesto tiene seis, así que hay un MAPEO en el medio, y un mapeo es
 * exactamente el lugar donde un cambio de mensaje se cuela sin que nadie lo
 * decida. Las cinco entradas de abajo están escritas una por una para que sean
 * DELIBERADAS Y NO DESCUBRIMIENTOS: las cuatro que el diseño nombra en
 * §Fix Implementation → decisión 2, más la familia (g), que la task 2 midió y la
 * 3.2 decidió.
 *
 * No van en `presupuesto.test.ts` por dos razones. La primera es de propiedad: ese
 * archivo tiene un único editor declarado (la task 3.6, que actualiza los cinco
 * casos que el diseño ya declaró que cambian) y mezclar acá lo que la 3.3 pinnea
 * con lo que la 3.6 reescribe deja las dos tareas pisándose el mismo archivo. La
 * segunda es de lectura: estos cinco casos son el CONTRATO ENTRE DOS MÓDULOS, no
 * los cortes del presupuesto, y separarlos es lo que hace que se encuentren
 * cuando alguien vaya a tocar el núcleo.
 *
 * Los veredictos de abajo salen de correr el módulo con `tsx`, no de leer el
 * código. Función pura: sin base, sin red y sin React.
 */

const TECHO = 100;

/** El motivo del rechazo, o `null` si el texto era válido. */
function motivoDe(texto: string, techoEur = TECHO): MotivoPresupuesto | null {
  const r = parsearPresupuesto(texto, techoEur);
  return r.ok ? null : r.motivo;
}

/** El texto que el rechazo lleva puesto, o `null` si el texto era válido. */
function textoDe(texto: string, techoEur = TECHO): string | null {
  const r = parsearPresupuesto(texto, techoEur);
  return r.ok ? null : r.texto;
}

// ─── 1. `ambiguo`, con su texto interpolado ──────────────────────────────────

describe('1. el motivo `ambiguo` y su texto interpolado (2.1)', () => {
  it('un texto de la Bug_Condition se rechaza por ambiguo, no por rango', () => {
    // Los cuatro importes de 1.2, que hoy se aceptaban mil veces menores: de
    // `'1.000'` salía `daily_budget: '100'` sobre la campaña real de Meta.
    expect(motivoDe('1.000')).toBe('ambiguo');
    expect(motivoDe('1.500')).toBe('ambiguo');
    expect(motivoDe('2.000')).toBe('ambiguo');
    expect(motivoDe('10.000')).toBe('ambiguo');
  });

  it('el texto del rechazo ofrece LAS DOS lecturas, no dice sólo que está mal', () => {
    // 2.1 no pide un rechazo, pide que la persona pueda ELEGIR: el mensaje trae
    // el número sin el punto y el número truncado en el punto.
    const t = textoDe('1.000')!;
    expect(t).toContain('1000');
    expect(t).toContain('"1.000"'); // cita el texto tal como se escribió
    expect(t).toBe(
      '"1.000" se puede leer de dos formas: escribí 1000 si querés decir 1000, o 1 si querés decir 1',
    );
  });

  it('el texto es el del núcleo y NO el de respaldo del catálogo', () => {
    // La distinción es el motivo entero por el que la rama de rechazo lleva un
    // campo `texto`: la explicación interpola el texto que se tipeó, así que no
    // puede salir de un `Record` de textos fijos. El respaldo existe para quien
    // tenga el motivo y no el resultado a mano, y no tiene que ganarle nunca.
    expect(textoDe('1.000')).not.toBe(textoDeMotivo('ambiguo'));
    expect(textoDeMotivo('ambiguo').length).toBeGreaterThan(0);
  });

  it('la ambigüedad se decide ANTES del mínimo y del techo, así que el techo no la mueve', () => {
    // El orden importa y es lo que arregla el hallazgo de la task 1: los dos
    // textos de abajo YA se rechazaban, pero por el motivo equivocado y con un
    // mensaje que no ofrecía ninguna lectura para corregir.
    expect(motivoDe('0.000')).toBe('ambiguo'); // era bajo_el_minimo
    expect(motivoDe('12345.678', 5_000)).toBe('ambiguo'); // era sobre_el_techo
    expect(motivoDe('100.001')).toBe('ambiguo'); // era sobre_el_techo
    expect(motivoDe('10.005')).toBe('ambiguo'); // era mas_de_dos_decimales
    // Y con un techo que no es un número tampoco cambia: la ambigüedad es del
    // texto, no del rango.
    expect(motivoDe('1.000', Number.NaN)).toBe('ambiguo');
  });

  it('la regla ancha se conserva: 4 o más dígitos a la izquierda también es ambiguo (familia (e))', () => {
    // `'1000.000'` es la única ACEPTACIÓN que este arreglo pierde a propósito
    // (daba 1000). Angostar la regla a 1–3 dígitos haría que `parsearMonto`
    // devolviera 1000 donde hoy rechaza, y 3.13 congela sus veredictos.
    expect(motivoDe('1000.000', 5_000)).toBe('ambiguo');
    expect(textoDe('1000.000', 5_000)).toContain('1000000');
  });
});

// ─── 2. El negativo sigue siendo `bajo_el_minimo`, no `no_numero` ────────────

describe('2. los negativos siguen siendo bajo_el_minimo (3.3)', () => {
  it('el núcleo devuelve el negativo como número, así que lo agarra el mínimo y no el mapeo', () => {
    // Es la consecuencia directa de que el signo sea POLÍTICA del llamador: el
    // núcleo acepta `-5` y devuelve −5, y el corte del mínimo lo rechaza igual
    // que cuando acá había un `Number()`. Si el núcleo rechazara el signo, estos
    // tres pasarían a `no_numero` y el mensaje del campo cambiaría sin que
    // ninguna cláusula lo pida.
    expect(motivoDe('-5')).toBe('bajo_el_minimo');
    expect(motivoDe('-0')).toBe('bajo_el_minimo');
    expect(motivoDe('0')).toBe('bajo_el_minimo');
    expect(textoDe('-5')).toContain('0,01');
  });

  it('lo que tiene letras sigue cayendo en no_numero antes de que el mínimo lo vea', () => {
    // `-Infinity` no es un negativo legible: el núcleo lo rechaza por
    // `caracteres`. Va acá porque es el borde del caso de arriba, y el orden
    // entre los dos es lo que decide qué mensaje se lee.
    expect(motivoDe('-Infinity')).toBe('no_numero');
  });
});

// ─── 3. `€` solo es `no_numero` y no `vacio` ─────────────────────────────────

describe('3. un campo con sólo ruido es no_numero, no vacio (3.2)', () => {
  it('el `vacio` del núcleo NO se mapea al `vacio` del presupuesto', () => {
    // `trim()` no vacía `'€'`, así que el primer corte no lo toma y el texto
    // llega al núcleo, que lo deja en nada al limpiar el ruido. El campo TIENE
    // algo escrito: informar «falta el importe» frente a un campo con un símbolo
    // adentro sería mentirle a quien lo está mirando. Y es lo que devolvía antes.
    expect(motivoDe('€')).toBe('no_numero');
    expect(motivoDe(' € ')).toBe('no_numero');
    expect(motivoDe('$')).toBe('no_numero');
  });

  it('el campo realmente en blanco sigue siendo vacio, con su texto de siempre', () => {
    // El otro lado del corte, que 3.2 congela: acá no hay borde rojo, porque el
    // importe no está mal escrito, está sin escribir.
    expect(motivoDe('')).toBe('vacio');
    expect(motivoDe('   ')).toBe('vacio');
    expect(motivoDe('\t\n')).toBe('vacio');
    // El espacio duro y el BOM que pega un Excel también los vacía `trim()`.
    expect(motivoDe('\u00a0')).toBe('vacio');
    expect(motivoDe('\ufeff')).toBe('vacio');
    expect(textoDe('')).toBe('falta el importe del presupuesto');
  });
});

// ─── 4. `'.'` pasa de `no_numero` a `bajo_el_minimo` (familia (f)) ───────────

describe('4. el punto suelto pasa a bajo_el_minimo — familia (f)', () => {
  it('el núcleo resuelve «.» como 0 donde Number daba NaN: sigue siendo rechazo, cambia el mensaje', () => {
    // Declarado en §Alcance y NO corregido: que el núcleo rechace un texto sin
    // dígitos cambiaría el mensaje de `parsearMonto('.')`, y 3.13 lo congela. La
    // entrada está acá para que el cambio de mensaje sea una decisión escrita y no
    // algo que alguien descubra leyendo un fallo.
    expect(motivoDe('.')).toBe('bajo_el_minimo');
    expect(motivoDe('-.')).toBe('bajo_el_minimo');
    expect(motivoDe('€.')).toBe('bajo_el_minimo');
  });

  it('lo que los separadores no pueden formar sigue siendo no_numero', () => {
    // El borde de la familia (f): «..» no resuelve como 0, es `ilegible` en el
    // núcleo y `no_numero` acá, igual que antes.
    expect(motivoDe('..')).toBe('no_numero');
    expect(motivoDe('1.2.3')).toBe('no_numero');
    expect(motivoDe('1.00.000')).toBe('no_numero');
  });
});

// ─── 5. `'-1.000'` pasa de `bajo_el_minimo` a `ambiguo` (familia (g)) ────────

describe('5. el signo entra en la ambigüedad — familia (g)', () => {
  it('«-1.000» es ambiguo y no bajo_el_minimo: es −1000 o −1, y no se adivina', () => {
    // La clase que la task 2 midió (64 flips del lado presupuesto sobre 404.661
    // combinaciones) y que la 3.2 decidió. Se descartó la salida fácil —que el
    // núcleo no trate como ambiguo un texto con signo— porque deja el bug vivo
    // para los negativos: una condición «ganancia < -1.000» se seguiría guardando
    // como −1, que es el mismo modo de falla que este arreglo vino a cerrar.
    expect(motivoDe('-1.000')).toBe('ambiguo');
    expect(motivoDe('-1000.000')).toBe('ambiguo');
  });

  it('el mensaje del negativo ambiguo ofrece las dos lecturas CON el signo', () => {
    // Sin el signo en las dos lecturas el mensaje diría «escribí 1000» para un
    // texto que empezaba con `-`, y la corrección que ofrece estaría mal.
    const t = textoDe('-1.000')!;
    expect(t).toContain('-1000');
    expect(t).toContain('-1');
  });
});
