// Lo monta T06: este test cubre `serie.ts`, que usan los tres componentes.

/**
 * Tests de `serie.ts` (T04 §3). Todo PURO: no toca la base, no levanta React y
 * no lleva `skipIf`.
 *
 * ES EL ÚNICO TEST QUE T04 PUEDE ESCRIBIR. `vitest.config.ts` usa
 * `environment: 'node'` y no hay jsdom ni testing-library en el repo, así que
 * ningún componente se puede renderizar en un test. Por eso las reglas que
 * importan se sacaron de los `.tsx` y viven en `serie.ts`: si estuvieran adentro
 * de un componente, quedarían sin verificar.
 *
 * El caso que justifica la mitad del archivo es `parsearSaldo('0')`. Es el que
 * `parsearMonto` RECHAZA (`if (n.valor <= 0)`), y con ese rechazo una cuenta
 * vacía sería imposible de cargar: por D5 ese día nunca podría estar completo,
 * el gráfico perdería el punto y nada explicaría por qué.
 */

import { describe, expect, it } from 'vitest';
import { signoDe, type AccountKind } from '@/lib/queries/saldo';
import { parsearMonto } from '@/lib/monto';
import {
  etiquetaDia,
  etiquetaMes,
  offsetDelCero,
  parsearSaldo,
  signoDeSaldo,
  textoSinDato,
  totalTipeado,
} from './serie';

describe('etiquetaDia', () => {
  it('devuelve DD/MM con los dos dígitos, no 1/1', () => {
    // El caso que no puede faltar: sin los ceros a la izquierda el eje mezcla
    // anchos y las etiquetas bailan.
    expect(etiquetaDia('2026-01-01')).toBe('01/01');
    expect(etiquetaDia('2026-08-05')).toBe('05/08');
    expect(etiquetaDia('2026-12-31')).toBe('31/12');
  });

  it('no construye un Date, así que no corre el día por zona horaria', () => {
    // `new Date('2026-08-01')` es UTC medianoche: en Buenos Aires eso es el 31
    // de julio. Si esta función usara Date, el eje mostraría un día menos que
    // el dato que viene de la base.
    expect(etiquetaDia('2026-08-01')).toBe('01/08');
  });

  it('un formato inesperado vuelve tal cual, no "undefined/undefined"', () => {
    expect(etiquetaDia('2026-08')).toBe('2026-08');
    expect(etiquetaDia('')).toBe('');
  });
});

describe('etiquetaMes', () => {
  it('devuelve MM/AA', () => {
    expect(etiquetaMes('2026-12')).toBe('12/26');
    expect(etiquetaMes('2026-01')).toBe('01/26');
  });

  it('un formato inesperado vuelve tal cual', () => {
    expect(etiquetaMes('2026-08-05')).toBe('2026-08-05');
  });
});

describe('textoSinDato', () => {
  it('dice "sin información", nunca un 0', () => {
    // Un patrimonio de 0 es un dato real y dramático (D12): si el texto fuera
    // '0', "la cuenta quedó vacía" y "no cargué" se verían igual.
    expect(textoSinDato()).toBe('sin información');
    expect(textoSinDato()).not.toBe('0');
  });
});

describe('signoDeSaldo', () => {
  const casos: Array<[AccountKind, number]> = [
    ['dinero', 0],
    ['dinero', 8000],
    ['retenido', 1500],
    ['deuda', 0],
    ['deuda', 1200],
    ['deuda', 0.01],
  ];

  it('la deuda entra negativa y el resto positivo', () => {
    expect(signoDeSaldo('dinero', 8000)).toBe(8000);
    expect(signoDeSaldo('retenido', 1500)).toBe(1500);
    expect(signoDeSaldo('deuda', 1200)).toBe(-1200);
  });

  /*
    El componente NO puede importar `signoDe` de `lib/queries/saldo.ts`: ese
    módulo importa `pg`, y un import de valor desde el browser arrastraría el
    driver de Postgres al bundle. Así que la regla está duplicada... y este test
    es lo que impide que las dos copias se separen en silencio. Acá sí se puede
    importar el original: el test corre en node y `getPool()` es lazy, así que
    importarlo no abre ninguna conexión.
  */
  it('coincide exactamente con signoDe de lib/queries/saldo.ts', () => {
    for (const [kind, monto] of casos) {
      expect(signoDeSaldo(kind, monto), `${kind} ${monto}`).toBe(signoDe(kind, monto));
    }
  });
});

describe('parsearSaldo', () => {
  it('ACEPTA EL CERO — es toda la razón por la que esta función existe', () => {
    expect(parsearSaldo('0')).toEqual({ ok: true, valor: 0 });
  });

  it('y parsearMonto lo rechaza: si la UI usara parsearMonto, una cuenta vacía no se podría cargar', () => {
    // Este test no prueba `serie.ts`, prueba el MOTIVO de `serie.ts`. Si algún
    // día `parsearMonto` aceptara el 0, esto falla y hay que borrar
    // `parsearSaldo` en lugar de mantener dos parseos.
    const conMonto = parsearMonto('0');
    expect(conMonto.ok).toBe(false);
    expect(conMonto).toEqual({ ok: false, error: 'el monto tiene que ser mayor que cero' });
  });

  it('acepta las otras formas del cero', () => {
    expect(parsearSaldo('0,00')).toEqual({ ok: true, valor: 0 });
    expect(parsearSaldo('0.00')).toEqual({ ok: true, valor: 0 });
    expect(parsearSaldo('00')).toEqual({ ok: true, valor: 0 });
  });

  it('lee la coma como decimal, que es como se escribe la plata en castellano', () => {
    expect(parsearSaldo('100,50')).toEqual({ ok: true, valor: 100.5 });
    expect(parsearSaldo('1.234,56')).toEqual({ ok: true, valor: 1234.56 });
    expect(parsearSaldo('8000')).toEqual({ ok: true, valor: 8000 });
  });

  it('limpia el ruido de un copy-paste (símbolo de moneda, espacios raros)', () => {
    expect(parsearSaldo(' € 1.234,56 ')).toEqual({ ok: true, valor: 1234.56 });
  });

  it('rechaza el signo menos: la deuda se escribe en positivo (D4)', () => {
    const r = parsearSaldo('-5');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('sin el signo menos');
    // El mensaje tiene que decir QUÉ hacer, no sólo que está mal.
    expect(r.error).toContain('deuda');
  });

  it('rechaza "1.000" como ambiguo, y ofrece LAS DOS lecturas', () => {
    // `Number("1.000")` es 1: guardaba un euro donde la persona quiso mil. No
    // falla, miente. Ver registro.md, 2026-08-24 y el commit 0e151e0.
    const r = parsearSaldo('1.000');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('1000');
    expect(r.error).toContain('dos formas');
    // La lectura como decimal también se ofrece: el valor del rechazo está en
    // que la persona ELIJA.
    expect(r.error).toMatch(/o 1 si querés decir 1/);
  });

  it('rechaza más de 2 decimales: numeric(14,2) redondearía el tercero sin avisar', () => {
    expect(parsearSaldo('1,234')).toEqual({
      ok: false,
      error: 'el saldo lleva 2 decimales como máximo',
    });
  });

  it('rechaza un campo vacío, que en el formulario significa "sin cargar"', () => {
    expect(parsearSaldo('')).toEqual({ ok: false, error: 'escribí un saldo' });
    expect(parsearSaldo('   ')).toEqual({ ok: false, error: 'escribí un saldo' });
  });

  it('rechaza lo que no es un número, con el texto adentro del mensaje', () => {
    expect(parsearSaldo('abc')).toEqual({
      ok: false,
      error: 'el saldo sólo lleva números, coma o punto',
    });
    const r = parsearSaldo('1.00.000');
    expect(r).toEqual({ ok: false, error: 'no se entiende el saldo "1.00.000"' });
  });

  it('rechaza un saldo que no entra en numeric(14,2)', () => {
    expect(parsearSaldo('1000000000000')).toEqual({
      ok: false,
      error: 'el saldo es demasiado grande',
    });
    // El de al lado sí entra: el corte es en el billón, no antes.
    expect(parsearSaldo('999999999999,99')).toEqual({ ok: true, valor: 999999999999.99 });
  });

  it('redondea a 2 decimales, así que lo que viaja es lo que Postgres guarda', () => {
    expect(parsearSaldo('1,99')).toEqual({ ok: true, valor: 1.99 });
    expect(parsearSaldo('0,01')).toEqual({ ok: true, valor: 0.01 });
  });

  it('acepta todo lo que parsearMonto acepta, y con el mismo valor', () => {
    // La política de los saldos es la de Finanzas MENOS el rechazo del cero: si
    // divergiera en algún otro caso, serían dos parseos distintos de plata y
    // volvería el problema que 0e151e0 vino a cerrar.
    for (const raw of ['1', '100,50', '1.234,56', '0,01', '999', '12,3']) {
      const conMonto = parsearMonto(raw);
      expect(conMonto.ok, raw).toBe(true);
      if (!conMonto.ok) continue;
      expect(parsearSaldo(raw), raw).toEqual({ ok: true, valor: conMonto.valor });
    }
  });
});

describe('totalTipeado', () => {
  it('aplica el signo de cada cuenta: dinero + retenido − deuda', () => {
    const t = totalTipeado([
      { kind: 'dinero', raw: '8000' },
      { kind: 'retenido', raw: '1500' },
      { kind: 'dinero', raw: '700' },
      { kind: 'deuda', raw: '1200' },
    ]);
    expect(t.totalEur).toBe(9000);
    expect(t.completo).toBe(true);
    expect(t.cargadas).toBe(4);
    expect(t.invalidas).toBe(0);
  });

  it('un campo vacío NO suma y deja el total incompleto (D5)', () => {
    const t = totalTipeado([
      { kind: 'dinero', raw: '8000' },
      { kind: 'retenido', raw: '' },
      { kind: 'deuda', raw: '1200' },
    ]);
    // El total sigue siendo un número (la UI lo muestra), pero `completo: false`
    // es lo que la obliga a decir que es un PARCIAL. Un total al que le falta
    // una cuenta se ve igual de bien que uno correcto y no lo es.
    expect(t.totalEur).toBe(6800);
    expect(t.completo).toBe(false);
    expect(t.cargadas).toBe(2);
    expect(t.esperadas).toBe(3);
  });

  it('un 0 tipeado SÍ cuenta como cargada: es una cuenta vacía, no un campo sin llenar', () => {
    const t = totalTipeado([
      { kind: 'dinero', raw: '0' },
      { kind: 'deuda', raw: '500' },
    ]);
    expect(t.totalEur).toBe(-500);
    expect(t.completo).toBe(true);
    expect(t.cargadas).toBe(2);
  });

  it('cuenta las filas ilegibles y no las suma', () => {
    const t = totalTipeado([
      { kind: 'dinero', raw: '1.000' }, // ambiguo
      { kind: 'dinero', raw: '500' },
    ]);
    expect(t.invalidas).toBe(1);
    expect(t.cargadas).toBe(1);
    expect(t.completo).toBe(false);
    expect(t.totalEur).toBe(500);
  });

  it('sin ninguna fila no está completo: un patrimonio sin cuentas no es un patrimonio de cero', () => {
    const t = totalTipeado([]);
    expect(t.completo).toBe(false);
    expect(t.totalEur).toBe(0);
  });

  it('redondea la suma a 2 decimales', () => {
    // 0,1 + 0,2 en float da 0.30000000000000004, y ese número apareciendo al
    // lado de los que el usuario acaba de tipear parece un bug de la suma.
    const t = totalTipeado([
      { kind: 'dinero', raw: '0,1' },
      { kind: 'dinero', raw: '0,2' },
    ]);
    expect(t.totalEur).toBe(0.3);
  });
});

describe('offsetDelCero', () => {
  it('todo positivo: el degradado es entero del color de ganancia', () => {
    expect(offsetDelCero([100, 200, 300])).toBe(1);
    expect(offsetDelCero([0, 100])).toBe(1);
  });

  it('todo negativo: el degradado es entero del color de pérdida', () => {
    expect(offsetDelCero([-100, -200])).toBe(0);
    expect(offsetDelCero([0, -100])).toBe(0);
  });

  it('mezclado: el corte cae donde está el cero, medido desde arriba', () => {
    expect(offsetDelCero([100, -100])).toBe(0.5);
    expect(offsetDelCero([300, -100])).toBe(0.75);
    expect(offsetDelCero([100, -300])).toBe(0.25);
  });

  it('los nulls no participan: un mes sin cierre no mueve el corte', () => {
    expect(offsetDelCero([300, null, -100])).toBe(0.75);
  });

  it('una serie sin ningún dato no rompe', () => {
    // No hay nada que dibujar, así que el valor da igual; lo que no puede pasar
    // es un NaN en el `offset` de un stop, que deja el área sin pintar.
    expect(offsetDelCero([])).toBe(1);
    expect(offsetDelCero([null, null])).toBe(1);
  });
});
