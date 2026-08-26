import { describe, expect, it } from 'vitest';
import {
  numeroDeCampo,
  payloadDeForm,
  problema,
  problemaAccion,
  problemaCondiciones,
  problemaProgramacion,
} from './ReglasView';
// El fixture compartido de la pantalla. La task 4.1 lo sacó de acá, de
// `_nombres.test.ts` y de `montoAmbiguo.test.ts`, donde estaba copiado tres veces.
import { formBase, type FormEstado } from './_formBase';

/**
 * `numeroDeCampo` y las ramas nuevas de las tres `problema*` (task 3.5 del spec
 * `parseo-montos-anuncios`).
 *
 * **Validates: Requirements 2.6, 2.7, 2.8, 2.9, 3.7, 3.8, 3.9, 3.10**
 *
 * QUÉ CUBRE ESTE ARCHIVO Y QUÉ NO. Acá van los tres estados del parseo, la
 * política propia de esta pantalla y un caso por rama nueva de cada `problema*`,
 * con el mensaje verificado. Lo que NO va acá, para no duplicarlo:
 *
 *   · el rechazo de la Bug_Condition en los cinco campos → `montoAmbiguo.test.ts`;
 *   · que el veredicto sólo cambie donde está declarado →
 *     `numeroDeCampo.preservacion.test.ts`, que compara contra el oráculo
 *     congelado del `numeroDeTexto` de antes.
 *
 * Todo es puro: no hay base, ni red, ni render.
 */

// ─── Los tres estados ────────────────────────────────────────────────────────

describe('numeroDeCampo: los tres estados', () => {
  it('el campo en blanco es `vacio`, que es su propio estado y no un 0 (3.9, 3.10)', () => {
    for (const blanco of ['', ' ', '   ', '\t\n']) {
      expect(numeroDeCampo(blanco), JSON.stringify(blanco)).toEqual({ estado: 'vacio' });
    }
    // La distinción que todo esto existe para sostener: el 0 escrito a propósito
    // («ventas <= 0») es un número, no un campo sin llenar.
    expect(numeroDeCampo('0')).toEqual({ estado: 'ok', valor: 0 });
  });

  it('un número se lee, con coma o con punto decimal (3.8)', () => {
    expect(numeroDeCampo('1000')).toEqual({ estado: 'ok', valor: 1000 });
    expect(numeroDeCampo('1,5')).toEqual({ estado: 'ok', valor: 1.5 });
    expect(numeroDeCampo('100,50')).toEqual({ estado: 'ok', valor: 100.5 });
    expect(numeroDeCampo('0.5')).toEqual({ estado: 'ok', valor: 0.5 });
    expect(numeroDeCampo('  12.5  ')).toEqual({ estado: 'ok', valor: 12.5 });
    // Las dos agrupaciones de miles, que antes eran NaN (2.3).
    expect(numeroDeCampo('1.000.000')).toEqual({ estado: 'ok', valor: 1_000_000 });
    expect(numeroDeCampo('1.234,56')).toEqual({ estado: 'ok', valor: 1234.56 });
    // El negativo vuelve negativo: en una condición («ganancia < -10») es legítimo.
    expect(numeroDeCampo('-10')).toEqual({ estado: 'ok', valor: -10 });
  });

  it('«1.000» es `error` con motivo `ambiguo`, y el detalle trae LAS DOS lecturas (2.1)', () => {
    const r = numeroDeCampo('1.000');
    expect(r.estado).toBe('error');
    if (r.estado !== 'error') return;
    expect(r.motivo).toBe('ambiguo');
    expect(r.detalle).toContain('1000');
    expect(r.detalle).toContain('se puede leer de dos formas');
    // La frase no nombra ningún sustantivo: es lo que la deja servir igual para un
    // importe, un ROI y un límite de ejecuciones (2.1).
    for (const sustantivo of ['importe', 'presupuesto', 'monto', 'valor', 'límite']) {
      expect(r.detalle, `«${sustantivo}» no puede aparecer en la frase compartida`).not.toContain(
        sustantivo,
      );
    }
  });

  it('lo que no nombra un número es `error`, y el vacío del núcleo también', () => {
    const motivoDe = (s: string): string => {
      const r = numeroDeCampo(s);
      return r.estado === 'error' ? r.motivo : r.estado;
    };
    // `'€'` es todo ruido: el núcleo lo da como `vacio`, pero el CAMPO tiene algo
    // escrito y ese algo no es un número, así que acá es `error`.
    expect(motivoDe('€')).toBe('ilegible');
    expect(motivoDe('abc')).toBe('ilegible');
    expect(motivoDe('1e3')).toBe('caracteres');
    expect(motivoDe('0x10')).toBe('caracteres');
    expect(motivoDe('1.2.3')).toBe('ilegible');
    expect(motivoDe('1.00.000')).toBe('ilegible');
    // La finitud plegada dentro de `error`: un `ok` de Reglas trae SIEMPRE un
    // número finito, así que ningún call site puede olvidarse del chequeo.
    expect(motivoDe('9'.repeat(400))).toBe('ilegible');
    expect(numeroDeCampo('9'.repeat(400)).estado).toBe('error');
  });
});

// ─── La política propia: un texto sin dígitos no es 0 ────────────────────────

describe('numeroDeCampo: un texto SIN DÍGITOS no es 0 (política de Reglas)', () => {
  /**
   * LA DECISIÓN QUE ESTE TEST PINNEA. El núcleo resuelve `'.'` y `','` como 0 —la
   * familia (f) de §Alcance, declarada y no corregida porque corregirla movería el
   * mensaje de `parsearMonto('.')`, que la cláusula 3.13 congela—. En el
   * presupuesto ese 0 es inocuo: lo ataja `bajo_el_minimo`. En Reglas NO HAY
   * MÍNIMO, y en una condición el 0 es legítimo a propósito (3.9), así que
   * «gasto > .» pasaría de bloquearse a guardarse como «gasto > 0», que en una
   * regla de pausar significa PAUSÁ TODO: el modo de falla que 3.7 vino a evitar,
   * entrando por otra puerta.
   *
   * La política se pone en `numeroDeCampo` y no en el núcleo, que no se toca. Si
   * alguien la saca, este test cae y el de abajo dice qué se rompe.
   */
  for (const sinDigitos of ['.', ',', '-.', '..', '-', '€.']) {
    it(`${JSON.stringify(sinDigitos)} es error y no 0`, () => {
      const r = numeroDeCampo(sinDigitos);
      expect(r.estado, `${JSON.stringify(sinDigitos)} no puede leerse como un número`).toBe('error');
    });
  }

  it('«gasto > .» sigue bloqueando el guardado y no se guarda como «gasto > 0»', () => {
    const f = formBase({ conditions: [{ metric: 'spend', op: '>', value: '.' }] });
    const p = problemaCondiciones(f);
    expect(p, 'una condición sin ningún dígito no puede pasar').not.toBeNull();
    expect(p!).toBe('El valor de gasto (condición 1) no es un número: «.».');
    expect((payloadDeForm(f).conditions as readonly { value: unknown }[])[0]!.value).toBeNull();
  });
});

// ─── problemaAccion ──────────────────────────────────────────────────────────

describe('problemaAccion: las ramas nuevas', () => {
  const conValor = (over: Partial<FormEstado> = {}): FormEstado =>
    formBase({ action: 'budget_increase', actionUnit: 'fixed', actionValue: '50', budgetMax: '9999', ...over });

  it('el valor ambiguo se reporta nombrando el campo y explicando las dos lecturas (2.6, 2.9)', () => {
    const p = problemaAccion(conValor({ actionValue: '1.000' }));
    expect(p).toBe(
      'El valor de la acción: "1.000" se puede leer de dos formas: escribí 1000 si querés decir 1000, o 1 si querés decir 1',
    );
  });

  it('el techo y el piso ambiguos también, cada uno con su nombre', () => {
    expect(problemaAccion(conValor({ budgetMax: '1.000' }))!).toContain('El límite máximo: ');
    expect(problemaAccion(conValor({ budgetMax: '1.000' }))!).toContain('escribí 1000');
    const piso = problemaAccion(
      formBase({ action: 'budget_decrease', actionUnit: 'fixed', actionValue: '50', budgetMin: '2.000' }),
    );
    expect(piso!).toContain('El límite mínimo: ');
    expect(piso!).toContain('escribí 2000');
  });

  it('el mensaje del no-número queda TEXTUAL, palabra por palabra el de antes (2.7)', () => {
    expect(problemaAccion(conValor({ actionValue: 'abc' }))).toBe(
      'El valor de la acción no es un número: «abc».',
    );
    expect(problemaAccion(conValor({ budgetMax: '1e3' }))).toBe(
      'El límite máximo no es un número: «1e3».',
    );
    expect(
      problemaAccion(
        formBase({ action: 'budget_decrease', actionUnit: 'fixed', actionValue: '50', budgetMin: '1.2.3' }),
      ),
    ).toBe('El límite mínimo no es un número: «1.2.3».');
  });

  it('los mensajes del vacío quedan TEXTUALES', () => {
    expect(problemaAccion(conValor({ actionValue: '' }))).toBe('Falta el valor de la acción.');
    expect(problemaAccion(conValor({ actionValue: '   ' }))).toBe('Falta el valor de la acción.');
    expect(problemaAccion(conValor({ budgetMax: '' }))).toBe('Falta el límite máximo (techo).');
    expect(
      problemaAccion(formBase({ action: 'budget_decrease', actionUnit: 'fixed', actionValue: '50', budgetMin: '' })),
    ).toBe('Falta el límite mínimo (piso).');
  });

  it('los cortes de siempre siguen mirando el número, ahora el que el texto dice de verdad', () => {
    // El 0 comparte mensaje con el vacío, como antes.
    expect(problemaAccion(conValor({ actionValue: '0' }))).toBe('Falta el valor de la acción.');
    expect(problemaAccion(conValor({ budgetMax: '0' }))).toBe('El límite máximo tiene que ser mayor a 0.');
    // Los avisos de porcentaje (3.11) y el techo menor al piso (3.12).
    expect(
      problemaAccion(formBase({ action: 'budget_increase', actionUnit: 'percent', actionValue: '80', budgetMax: '99' }))!,
    ).toContain('Un factor menor a 100 BAJA el presupuesto');
    expect(
      problemaAccion(formBase({ action: 'budget_decrease', actionUnit: 'percent', actionValue: '150', budgetMin: '5' }))!,
    ).toContain('Para bajar a la mitad va 50%');
    expect(problemaAccion(conValor({ budgetMax: '10', budgetMin: '20' }))).toBe(
      'Con techo 10 y piso 20 no hay ningún valor que satisfaga los dos.',
    );
    // Y la coma sigue funcionando de punta a punta (3.8).
    expect(problemaAccion(conValor({ actionValue: '1,5' }))).toBeNull();
    expect(payloadDeForm(conValor({ actionValue: '1,5' })).actionValue).toBe(1.5);
  });
});

// ─── problemaCondiciones ─────────────────────────────────────────────────────

describe('problemaCondiciones: las ramas nuevas', () => {
  it('el valor ambiguo nombra la condición y explica las dos lecturas (2.7)', () => {
    const p = problemaCondiciones(formBase({ conditions: [{ metric: 'spend', op: '>', value: '1.000' }] }));
    expect(p).toBe(
      'El valor de gasto (condición 1): "1.000" se puede leer de dos formas: escribí 1000 si querés decir 1000, o 1 si querés decir 1',
    );
  });

  it('el mensaje del vacío queda TEXTUAL, que es el arreglo anterior de esta función (3.7)', () => {
    expect(
      problemaCondiciones(
        formBase({
          conditions: [
            { metric: 'spend', op: '>', value: '10' },
            { metric: 'roi', op: '<', value: '  ' },
          ],
        }),
      ),
    ).toBe('ROI (condición 2) no tiene valor. Un valor vacío se guardaría como 0, no como «sin límite».');
  });

  it('el no-número conserva su mensaje y el 0 deliberado se sigue pudiendo guardar (3.9)', () => {
    expect(
      problemaCondiciones(formBase({ conditions: [{ metric: 'roas', op: '>=', value: 'abc' }] })),
    ).toBe('El valor de ROAS (condición 1) no es un número: «abc».');
    const cero = formBase({ conditions: [{ metric: 'sales', op: '<=', value: '0' }] });
    expect(problemaCondiciones(cero)).toBeNull();
    expect((payloadDeForm(cero).conditions as readonly { value: unknown }[])[0]!.value).toBe(0);
  });

  it('la coherencia entre condiciones recibe los valores ya parseados y deja de poder ver un NaN', () => {
    // Las dos condiciones se leen bien (con coma, incluso) y el intervalo que
    // piden es vacío: eso es lo único que `motivoCondicionesImposibles` decide.
    const p = problemaCondiciones(
      formBase({
        conditions: [
          { metric: 'spend', op: '>', value: '10,5' },
          { metric: 'spend', op: '<', value: '5' },
        ],
      }),
    );
    expect(p).toBe('Ningún valor de gasto cumple las dos condiciones a la vez: la regla no va a actuar nunca.');
  });
});

// ─── problemaProgramacion ────────────────────────────────────────────────────

describe('problemaProgramacion: el límite de ejecuciones diarias', () => {
  const TEXTUAL =
    'El límite de ejecuciones diarias tiene que ser un entero mayor a 0, o vacío para no tener límite.';

  it('«1.000» se rechaza por ambiguo, con las dos lecturas (2.8)', () => {
    const p = problemaProgramacion(formBase({ maxRunsPerDay: '1.000' }));
    expect(p).toBe(
      'El límite de ejecuciones diarias: "1.000" se puede leer de dos formas: escribí 1000 si querés decir 1000, o 1 si querés decir 1',
    );
  });

  it('«1000» se acepta y viaja como 1000, no como 1 (2.8)', () => {
    const f = formBase({ maxRunsPerDay: '1000' });
    expect(problemaProgramacion(f)).toBeNull();
    expect(payloadDeForm(f).maxRunsPerDay).toBe(1000);
  });

  it('lo que no es entero mayor a 0 conserva el mensaje TEXTUAL de antes (2.8)', () => {
    // `1,5` se LEE como 1,5 y se rechaza por no ser entero: es el caso que 2.8
    // nombra, y el mensaje es el de siempre.
    expect(problemaProgramacion(formBase({ maxRunsPerDay: '1,5' }))).toBe(TEXTUAL);
    expect(problemaProgramacion(formBase({ maxRunsPerDay: '0' }))).toBe(TEXTUAL);
    expect(problemaProgramacion(formBase({ maxRunsPerDay: '-3' }))).toBe(TEXTUAL);
    expect(problemaProgramacion(formBase({ maxRunsPerDay: 'abc' }))).toBe(TEXTUAL);
    expect(problemaProgramacion(formBase({ maxRunsPerDay: '1e3' }))).toBe(TEXTUAL);
  });

  it('el vacío no tiene límite y viaja como null, nunca como 0 (3.10)', () => {
    const f = formBase({ maxRunsPerDay: '   ' });
    expect(problemaProgramacion(f)).toBeNull();
    expect(payloadDeForm(f).maxRunsPerDay).toBeNull();
  });
});

// ─── payloadDeForm ───────────────────────────────────────────────────────────

describe('payloadDeForm: el vacío viaja como null y nunca como 0 (3.10)', () => {
  it('los cuatro campos escalares vacíos son null', () => {
    const p = payloadDeForm(formBase({ action: 'budget_increase' }));
    expect(p.actionValue).toBeNull();
    expect(p.budgetMax).toBeNull();
    expect(p.budgetMin).toBeNull();
    expect(p.maxRunsPerDay).toBeNull();
  });

  it('con la acción sin presupuesto los tres campos de presupuesto son null aunque tengan texto', () => {
    const p = payloadDeForm(formBase({ action: 'pause', actionValue: '50', budgetMax: '99', budgetMin: '1' }));
    expect(p.actionValue).toBeNull();
    expect(p.budgetMax).toBeNull();
    expect(p.budgetMin).toBeNull();
  });
});
