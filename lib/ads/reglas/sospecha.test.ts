import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  METRICAS_EUR_AUDITABLES,
  METRICAS_NO_AUDITABLES,
  UMBRAL_ALTO_EUR,
  UMBRAL_BAJO_EUR,
  sospechasDeRegla,
  totalesPorBanda,
  type ReglaAuditable,
  type Sospecha,
} from './sospecha';

/**
 * Feature: parseo-montos-anuncios — Property 7: la sospecha que ve la UI es la
 * misma que reporta el script
 *
 * **Validates: Requirements 2.12, 2.13**
 *
 * LO QUE ESTE ARCHIVO PROTEGE. `sospechasDeRegla` es el único predicado que
 * deciden el script de auditoría (`npm run ads:auditar-montos`) y el aviso de la
 * lista de Reglas. Property 7 es, literalmente, que sea uno solo: si el umbral
 * viviera en el `WHERE` del script, el reporte y la pantalla podrían discrepar y
 * este spec estaría reproduciendo su propio bug una escala más arriba. Los tests
 * de acá fijan el predicado; los dos consumidores no tienen ninguno propio.
 *
 * NO CORRIGE NADA, Y ESO ES LA DECISIÓN 2 del bugfix: un `budget_max = 1` no se
 * distingue con certeza de un techo de un euro puesto a propósito, así que se
 * SEÑALA y decide una persona. Por eso el caso armado a mano de abajo incluye un
 * falso positivo declarado: un techo de 5 EUR deliberado SÍ se reporta.
 *
 * Todo es puro: sin base, sin red, sin render.
 */

/** Una regla sin nada sospechoso, para sobreescribirle un campo por test. */
const REGLA_LIMPIA: ReglaAuditable = {
  actionUnit: null,
  actionValue: null,
  budgetMax: null,
  budgetMin: null,
  maxRunsPerDay: null,
  condiciones: [],
};

const regla = (parcial: Partial<ReglaAuditable>): ReglaAuditable => ({ ...REGLA_LIMPIA, ...parcial });

/** La sospecha de un campo, o `undefined`. */
const de = (ss: Sospecha[], campo: Sospecha['campo']): Sospecha | undefined => ss.find((s) => s.campo === campo);

// ─────────────────────────────────────────────────────────────────────────────
// Los umbrales y sus bordes exactos
// ─────────────────────────────────────────────────────────────────────────────

describe('las dos bandas y sus bordes', () => {
  it('los umbrales son 10 y 100', () => {
    // Pinneados: son el contrato que el script imprime y el que la tabla de
    // §Decisión 5 del diseño justifica. Cambiarlos es cambiar el reporte.
    expect(UMBRAL_ALTO_EUR).toBe(10);
    expect(UMBRAL_BAJO_EUR).toBe(100);
  });

  it('banda alta por debajo de 10, banda baja de 10 a 99,99, nada desde 100', () => {
    // El borde de arriba de la banda alta: 9,99 entra, 10 ya no.
    expect(de(sospechasDeRegla(regla({ budgetMax: 9.99 })), 'budget_max')?.banda).toBe('alta');
    expect(de(sospechasDeRegla(regla({ budgetMax: 10 })), 'budget_max')?.banda).toBe('baja');

    // El borde de arriba de la banda baja: 99,99 entra, 100 no se reporta.
    expect(de(sospechasDeRegla(regla({ budgetMax: 99.99 })), 'budget_max')?.banda).toBe('baja');
    expect(sospechasDeRegla(regla({ budgetMax: 100 }))).toEqual([]);
    expect(sospechasDeRegla(regla({ budgetMax: 100.01 }))).toEqual([]);
  });

  it('la banda baja existe porque una intención de cinco dígitos cae ahí', () => {
    // Es el motivo de que haya dos bandas y no una: `10.000` quedó guardado como
    // 10 y `25.000` como 25. Con un único corte en 10 esta familia entera se
    // perdía en silencio.
    const s = de(sospechasDeRegla(regla({ budgetMax: 25 })), 'budget_max')!;
    expect(s.banda).toBe('baja');
    expect(s.textoProbable).toBe('25.000');
    expect(s.valorProbable).toBe(25000);
  });

  it('el 0 y los negativos no son sospechosos: la corrupción no los produce', () => {
    // `0.000` habría dado 0 y la intención también sería 0: no hay nada que
    // reconstruir. Los negativos quedan afuera a propósito — la banda está
    // definida sobre importes positivos, y reportar todo lo que está por debajo
    // de 10 incluiría cada umbral negativo legítimo («neto < -5»).
    expect(sospechasDeRegla(regla({ budgetMax: 0 }))).toEqual([]);
    expect(sospechasDeRegla(regla({ actionUnit: 'fixed', actionValue: -1.5 }))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// La reconstrucción del texto: exacta, sin adivinar
// ─────────────────────────────────────────────────────────────────────────────

describe('la reconstrucción del texto probable', () => {
  it('1,5 vino de «1.500» y quería decir 1500', () => {
    const s = de(sospechasDeRegla(regla({ budgetMin: 1.5 })), 'budget_min')!;
    expect(s.valor).toBe(1.5);
    expect(s.textoProbable).toBe('1.500');
    expect(s.valorProbable).toBe(1500);
    // La vuelta completa: el parseo viejo (`Number`) leería ese texto como el
    // valor guardado. Eso es lo que hace que el reporte se pueda decidir a mano.
    expect(Number(s.textoProbable)).toBe(s.valor);
  });

  it('10 vino de «10.000» y quería decir 10000', () => {
    const s = de(sospechasDeRegla(regla({ budgetMin: 10 })), 'budget_min')!;
    expect(s.textoProbable).toBe('10.000');
    expect(s.valorProbable).toBe(10000);
    expect(Number(s.textoProbable)).toBe(10);
  });

  it('un valor con más de tres decimales NO se reporta: no pudo salir de este bug', () => {
    // `ad_rule_conditions.value` es numeric(16,4). Un umbral de 1,2345 tiene
    // cuatro decimales, así que ningún texto `\d+\.\d{3}` lo produce:
    // `(1.2345).toFixed(3)` sería '1.234', que ya es otro número. Sin este corte
    // el reporte inventaría un texto que nadie escribió.
    const ss = sospechasDeRegla(regla({ condiciones: [{ metric: 'spend', op: '>', value: 1.2345 }] }));
    expect(ss).toEqual([]);
    // Con tres decimales sí: 1,234 pudo venir de «1.234».
    const conTres = sospechasDeRegla(regla({ condiciones: [{ metric: 'spend', op: '>', value: 1.234 }] }));
    expect(conTres).toHaveLength(1);
    expect(conTres[0]!.textoProbable).toBe('1.234');
    expect(conTres[0]!.valorProbable).toBe(1234);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Qué se audita y qué no, que es una decisión y no un olvido
// ─────────────────────────────────────────────────────────────────────────────

describe('las métricas que no se auditan', () => {
  it('las ocho métricas no auditables no producen ninguna sospecha, ni con un valor de banda alta', () => {
    // Un CPA de 8 EUR, un CPC de 0,30 y un ROI de 1,3 son valores normales:
    // reportarlos entierra las sospechas reales.
    for (const metric of METRICAS_NO_AUDITABLES) {
      expect(
        sospechasDeRegla(regla({ condiciones: [{ metric, op: '>', value: 1.5 }] })),
        `${metric} no se audita`,
      ).toEqual([]);
    }
  });

  it('las cinco métricas de importe sí se auditan', () => {
    for (const metric of METRICAS_EUR_AUDITABLES) {
      const ss = sospechasDeRegla(regla({ condiciones: [{ metric, op: '>', value: 1.5 }] }));
      expect(ss, `${metric} se audita`).toHaveLength(1);
      expect(ss[0]!.campo).toBe('condicion');
    }
  });

  it('las dos listas no se solapan y cubren las trece métricas del CHECK', () => {
    const todas = [...METRICAS_EUR_AUDITABLES, ...METRICAS_NO_AUDITABLES];
    expect(new Set(todas).size).toBe(13);
  });

  it('la etiqueta de la condición nombra la métrica y su posición, como en la pantalla', () => {
    const ss = sospechasDeRegla(
      regla({
        condiciones: [
          { metric: 'cpa', op: '<', value: 8 }, // no auditable: no consume número
          { metric: 'spend', op: '>', value: 1.5 },
        ],
      }),
    );
    // «condición 2» y no «condición 1»: el número es el que la UI muestra, o sea
    // el índice en el orden de `position`, aunque la condición 1 no se audite.
    expect(ss).toHaveLength(1);
    expect(ss[0]!.etiqueta).toBe('gasto (condición 2)');
  });
});

describe('max_runs_per_day', () => {
  it('nunca produce una sospecha: 2.13 lo declara no detectable', () => {
    // 1 ejecución diaria es legítimo y frecuente, e indistinguible de un `1.000`
    // corrompido. El script lo dice en voz alta en su salida para que la omisión
    // sea visible.
    for (const maxRunsPerDay of [1, 2, 5, 10, 99, null]) {
      expect(sospechasDeRegla(regla({ maxRunsPerDay })), `max_runs_per_day = ${maxRunsPerDay}`).toEqual([]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// El valor de la acción: fijo (2.12) y porcentaje (extensión declarada)
// ─────────────────────────────────────────────────────────────────────────────

describe('el valor de la acción', () => {
  it('con unidad fija es una sospecha de 2.12, sin marca de extensión', () => {
    const s = de(sospechasDeRegla(regla({ actionUnit: 'fixed', actionValue: 1.5 })), 'action_value')!;
    expect(s.etiqueta).toBe('valor de la acción');
    expect(s.extension).toBe(false);
    expect(s.valorProbable).toBe(1500);
  });

  it('con unidad porcentaje se reporta MARCADO como extensión sobre 2.12', () => {
    // El peor caso del bug entero: un `1.500` que quería decir 150% quedó como
    // 1,5 y significa «bajá el presupuesto al 1,5% del actual». 2.12 nombra los
    // importes absolutos, así que esto va aparte y etiquetado.
    const s = de(sospechasDeRegla(regla({ actionUnit: 'percent', actionValue: 1.5 })), 'action_value')!;
    expect(s.etiqueta).toBe('valor de la acción (%)');
    expect(s.extension).toBe(true);
  });

  it('sin unidad no se mira el valor: pausar y activar no llevan importe', () => {
    expect(sospechasDeRegla(regla({ actionUnit: null, actionValue: 1.5 }))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// El caso armado a mano del diseño
// ─────────────────────────────────────────────────────────────────────────────

describe('la regla de ejemplo del diseño', () => {
  // Un valor de cada banda, un techo de 5 EUR puesto a propósito, una condición
  // de CPA baja y un límite de una ejecución por día.
  const ejemplo: ReglaAuditable = {
    actionUnit: 'fixed',
    actionValue: 1.5, // banda alta: quería decir 1500
    budgetMax: 5, // ← FALSO POSITIVO ESPERADO: un techo de 5 EUR deliberado
    budgetMin: 25, // banda baja: quería decir 25000
    maxRunsPerDay: 1, // no detectable (2.13)
    condiciones: [
      { metric: 'cpa', op: '<', value: 8 }, // un CPA de 8 EUR es normal: no se reporta
      { metric: 'spend', op: '>', value: 4.5 }, // banda alta: quería decir 4500
      { metric: 'roi', op: '>', value: 1.3 }, // un ROI de 1,3 es normal: no se reporta
      { metric: 'revenue', op: '>', value: 60 }, // banda baja: quería decir 60000
    ],
  };

  it('reporta los cuatro importes y el techo deliberado, y nada más', () => {
    const ss = sospechasDeRegla(ejemplo);
    expect(
      ss.map((s) => ({ etiqueta: s.etiqueta, valor: s.valor, texto: s.textoProbable, probable: s.valorProbable, banda: s.banda })),
    ).toEqual([
      { etiqueta: 'valor de la acción', valor: 1.5, texto: '1.500', probable: 1500, banda: 'alta' },
      // El falso positivo, declarado: 5 EUR escrito a propósito es
      // indistinguible de un «5.000» corrompido, así que se reporta. La salida
      // dice «sospechoso», no «error» (2.13), y la corrección es a mano.
      { etiqueta: 'techo', valor: 5, texto: '5.000', probable: 5000, banda: 'alta' },
      { etiqueta: 'piso', valor: 25, texto: '25.000', probable: 25000, banda: 'baja' },
      { etiqueta: 'gasto (condición 2)', valor: 4.5, texto: '4.500', probable: 4500, banda: 'alta' },
      { etiqueta: 'ingresos (condición 4)', valor: 60, texto: '60.000', probable: 60000, banda: 'baja' },
    ]);
  });

  it('los totales por banda son los que cierra el reporte', () => {
    expect(totalesPorBanda(sospechasDeRegla(ejemplo))).toEqual({ alta: 3, baja: 2 });
  });

  it('una regla sana no produce nada', () => {
    expect(
      sospechasDeRegla({
        actionUnit: 'fixed',
        actionValue: 500,
        budgetMax: 1000,
        budgetMin: 150,
        maxRunsPerDay: 4,
        condiciones: [
          { metric: 'spend', op: '>', value: 4500 },
          { metric: 'roi', op: '<', value: 1.1 },
        ],
      }),
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 7 — determinista, y la reconstrucción exacta
// ─────────────────────────────────────────────────────────────────────────────

/** Importes como los que la base puede tener: 2, 3 y 4 decimales, y `null`. */
const importe: fc.Arbitrary<number | null> = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 1, max: 1_200 }).map((c) => c / 100) },
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 20_000 }).map((c) => c / 100) },
  { weight: 2, arbitrary: fc.integer({ min: 1, max: 9_999 }).map((m) => m / 1_000) },
  // Cuatro decimales: sólo posible en las condiciones (numeric(16,4)). Están para
  // que la propiedad vea los valores NO reconstruibles.
  { weight: 2, arbitrary: fc.integer({ min: 1, max: 99_999 }).map((m) => m / 10_000) },
  { weight: 1, arbitrary: fc.integer({ min: -5_000, max: 300_000 }).map((c) => c / 100) },
  { weight: 1, arbitrary: fc.constant(null) },
);

const METRICAS: readonly string[] = [...METRICAS_EUR_AUDITABLES, ...METRICAS_NO_AUDITABLES];

const reglaGenerada: fc.Arbitrary<ReglaAuditable> = fc.record({
  actionUnit: fc.constantFrom('fixed', 'percent', null),
  actionValue: importe,
  budgetMax: importe,
  budgetMin: importe,
  maxRunsPerDay: fc.option(fc.integer({ min: 1, max: 100 }), { nil: null }),
  condiciones: fc.array(
    fc.record({
      metric: fc.constantFrom(...METRICAS),
      op: fc.constantFrom('>', '>=', '<', '<=', '=', '!='),
      value: importe.map((v) => v ?? 0),
    }),
    { maxLength: 4 },
  ),
});

/**
 * El oráculo del predicado, escrito aparte y en una línea: un importe se reporta
 * si es positivo, está por debajo del umbral bajo y pudo salir de un texto de
 * tres decimales. Sirve para la dirección que de verdad importa —que ningún campo
 * auditable se OMITA en silencio—, que es la que un `filter` mal escrito rompe.
 */
const seEspera = (v: number | null): boolean =>
  v !== null && v > 0 && v < UMBRAL_BAJO_EUR && Number(v.toFixed(3)) === v;

// Feature: parseo-montos-anuncios, Property 7: la sospecha que ve la UI es la
// misma que reporta el script
//
// **Validates: Requirements 2.12, 2.13**
describe('Property 7: sospechasDeRegla es determinista y la reconstrucción es exacta', () => {
  it('para toda regla: mismo resultado dos veces, texto exacto, y ningún campo auditable omitido', () => {
    let conAlta = 0;
    let conBaja = 0;

    fc.assert(
      fc.property(reglaGenerada, (r) => {
        const ss = sospechasDeRegla(r);

        // ─── Determinista: los dos consumidores llaman por separado ─────────
        //
        // El script y la UI invocan el predicado en procesos distintos. Si el
        // resultado dependiera de algo que no está en la regla, el reporte y la
        // pantalla podrían discrepar, que es justo lo que Property 7 niega.
        expect(sospechasDeRegla(r)).toEqual(ss);

        for (const s of ss) {
          // ─── La reconstrucción es exacta, no una estimación ───────────────
          expect(Number(s.textoProbable), `${s.etiqueta}: el texto no relee el valor`).toBe(s.valor);
          expect(s.valorProbable, `${s.etiqueta}: el valor probable no es ×1000`).toBe(Math.round(s.valor * 1000));
          expect(s.textoProbable).toMatch(/^\d+\.\d{3}$/);

          // ─── La banda es función del valor, y nada se reporta desde 100 ───
          expect(s.valor).toBeGreaterThan(0);
          expect(s.valor).toBeLessThan(UMBRAL_BAJO_EUR);
          expect(s.banda).toBe(s.valor < UMBRAL_ALTO_EUR ? 'alta' : 'baja');
          if (s.banda === 'alta') conAlta++;
          else conBaja++;

          // Sólo el porcentaje va marcado como extensión sobre 2.12.
          expect(s.extension).toBe(s.campo === 'action_value' && r.actionUnit === 'percent');
        }

        // ─── Ningún campo auditable se omite en silencio ────────────────────
        const hay = (campo: Sospecha['campo']) => ss.some((s) => s.campo === campo);
        expect(hay('budget_max'), `techo ${r.budgetMax}`).toBe(seEspera(r.budgetMax));
        expect(hay('budget_min'), `piso ${r.budgetMin}`).toBe(seEspera(r.budgetMin));
        expect(hay('action_value'), `valor ${r.actionValue} (${r.actionUnit})`).toBe(
          r.actionUnit !== null && seEspera(r.actionValue),
        );
        const condicionesEsperadas = r.condiciones.filter(
          (c) => (METRICAS_EUR_AUDITABLES as readonly string[]).includes(c.metric) && seEspera(c.value),
        ).length;
        expect(ss.filter((s) => s.campo === 'condicion')).toHaveLength(condicionesEsperadas);

        // `max_runs_per_day` no aparece nunca, con ningún valor (2.13).
        expect(ss.every((s) => s.campo !== 'condicion' || !s.etiqueta.includes('ejecuciones'))).toBe(true);
      }),
      { numRuns: 1_000 },
    );

    // Cobertura: sin las dos bandas presentes la propiedad sería casi vacía.
    expect(conAlta, 'la generación no produjo ninguna sospecha de banda alta').toBeGreaterThan(0);
    expect(conBaja, 'la generación no produjo ninguna sospecha de banda baja').toBeGreaterThan(0);
  });
});
