import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Condicion } from '@/lib/ads/tipos';
import { sospechasDeRegla } from '@/lib/ads/reglas/sospecha';
import { avisoDeSospecha } from './ReglasView';
import type { ReglaFila } from './_tipos';

/**
 * Feature: parseo-montos-anuncios, task 6.3 — el aviso de la lista de Reglas
 * (cláusula 2.14).
 *
 * **Validates: Requirements 2.14**
 *
 * QUÉ SE TESTEA ACÁ Y QUÉ NO. El predicado y los umbrales son de
 * `lib/ads/reglas/sospecha.ts` y los fija `sospecha.test.ts`; acá no se
 * re-testean las bandas ni la reconstrucción del texto. Lo que se verifica es la
 * capa que agrega la pantalla, que son tres cosas y todas puras:
 *
 * 1. Si la fila lleva badge o no, y qué dice.
 * 2. Que el «(condición N)» del badge sea el N que el reporte del script
 *    imprime, que es el índice en la lista ordenada por `position`.
 * 3. Que `ReglaFila` entre a `sospechasDeRegla` sin ninguna conversión: es lo que
 *    hace que la UI y el script no puedan discrepar (Property 7). Eso lo prueba
 *    el compilador, no un `expect`, y por eso el fixture de abajo es un
 *    `ReglaFila` completo y no un objeto parcial casteado.
 *
 * Sin render: decidir si la fila lleva badge no necesita DOM.
 */

/** Una regla completa y sin nada sospechoso, para sobreescribirle campos por test. */
const FILA_LIMPIA: ReglaFila = {
  id: 1,
  name: 'Pausar los conjuntos que no venden',
  enabled: true,
  dryRun: true,
  accountId: 'act_1',
  level: 'adset',
  statusFilter: 'active',
  nameFilter: null,
  nameFilterMode: 'contains',
  action: 'budget_increase',
  actionValue: null,
  actionUnit: null,
  budgetMax: null,
  budgetMin: null,
  period: 'today',
  metricsLevel: 'object',
  everyMinutes: 60,
  windowStart: null,
  windowEnd: null,
  maxRunsPerDay: null,
  cooldownMinutes: 60,
  maxActionsPerObjectPerDay: 2,
  condiciones: [],
  lastRunAt: null,
  lastRunError: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const fila = (parcial: Partial<ReglaFila>): ReglaFila => ({ ...FILA_LIMPIA, ...parcial });

// ─────────────────────────────────────────────────────────────────────────────
// Si la fila lleva badge, y qué dice
// ─────────────────────────────────────────────────────────────────────────────

describe('cuándo la celda «Acción y condición» lleva el badge', () => {
  it('una regla sin nada sospechoso no lleva aviso', () => {
    // Techo y piso de tamaño normal, y una condición de gasto de 500 EUR: nada
    // que señalar, y la celda queda como estaba antes de esta task.
    expect(
      avisoDeSospecha(
        fila({
          actionUnit: 'fixed',
          actionValue: 500,
          budgetMax: 300,
          budgetMin: 150,
          condiciones: [{ metric: 'spend', op: '>', value: 500 }],
        }),
      ),
    ).toBeNull();
  });

  it('un techo de 1,5 lleva el badge, y el detalle dice qué se quiso escribir', () => {
    const aviso = avisoDeSospecha(fila({ budgetMax: 1.5 }));
    expect(aviso).not.toBeNull();
    expect(aviso!.etiqueta).toBe('revisar 1 importe');
    // El detalle es el mismo dato que imprime `npm run ads:auditar-montos`: el
    // campo, el valor guardado, el texto que lo produjo y la intención.
    expect(aviso!.detalle).toContain('techo');
    expect(aviso!.detalle).toContain('guardado 1.5');
    expect(aviso!.detalle).toContain('«1.500»');
    expect(aviso!.detalle).toContain('1500');
    expect(aviso!.detalle).toContain('muy probable');
  });

  it('la etiqueta cuenta los importes, en singular y en plural', () => {
    expect(avisoDeSospecha(fila({ budgetMax: 1.5 }))!.etiqueta).toBe('revisar 1 importe');
    expect(avisoDeSospecha(fila({ budgetMax: 1.5, budgetMin: 25 }))!.etiqueta).toBe('revisar 2 importes');
  });

  it('la banda «posible» se nombra igual que en el reporte del script', () => {
    // 25 cae entre los dos umbrales: es la familia de las intenciones de cinco
    // dígitos (`25.000`), la que un solo corte en 10 perdería en silencio.
    const aviso = avisoDeSospecha(fila({ budgetMin: 25 }))!;
    expect(aviso.detalle).toContain('posible');
    expect(aviso.detalle).not.toContain('muy probable');
    expect(aviso.detalle).toContain('«25.000»');
  });

  it('el porcentaje se muestra marcado como lo que es, no como un importe', () => {
    // `action_unit = 'percent'` es la extensión declarada sobre 2.12: un `1.500`
    // que quería decir 150% quedó como 1,5 = «bajá al 1,5% del actual».
    const aviso = avisoDeSospecha(fila({ action: 'budget_decrease', actionUnit: 'percent', actionValue: 1.5 }))!;
    expect(aviso.detalle).toContain('es un porcentaje, no un importe');
  });

  it('el aviso no dice «error»: dice revisar, porque un techo chico puede ser deliberado', () => {
    // 2.13. Un techo de 5 EUR puesto a propósito muestra el badge y eso es
    // correcto: es indistinguible de un `5.000` corrompido. Lo que NO puede
    // hacer el aviso es afirmar que está mal.
    const aviso = avisoDeSospecha(fila({ budgetMax: 5 }))!;
    expect(aviso.etiqueta).toContain('revisar');
    expect(aviso.etiqueta.toLowerCase()).not.toContain('error');
    expect(aviso.detalle.toLowerCase()).not.toContain('error');
    // 2.14: el aviso no corrige nada. La fila entra y sale igual.
    const antes = fila({ budgetMax: 5 });
    const copia = structuredClone(antes);
    avisoDeSospecha(antes);
    expect(antes).toEqual(copia);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// El número de la condición: el del badge tiene que ser el del reporte
// ─────────────────────────────────────────────────────────────────────────────

describe('el «(condición N)» del badge', () => {
  it('numera desde 1 en el orden de la lista, que es el orden de `position`', () => {
    // `listarReglas` (`_server.ts`) trae las condiciones con
    // `ORDER BY rule_id, position`, así que el índice del array ES la posición.
    // El script ordena su SELECT igual: los dos numeran lo mismo.
    const condiciones: Condicion[] = [
      { metric: 'roi', op: '<', value: 1.2 }, // no auditable: no se cuenta ni se numera distinto
      { metric: 'spend', op: '>', value: 1.5 },
    ];
    const aviso = avisoDeSospecha(fila({ condiciones }))!;
    expect(aviso.detalle).toContain('gasto (condición 2)');
  });

  it('invertir el orden mueve el número, que es por qué el orden importa', () => {
    // Este test no describe una preferencia: es la razón por la que la lista se
    // consume tal como viene de `listarReglas` y no reordenada de otra forma. Si
    // alguien saca el `ORDER BY position`, el badge y el reporte empiezan a
    // nombrar condiciones distintas y nada más lo avisa.
    const gasto: Condicion = { metric: 'spend', op: '>', value: 1.5 };
    const roi: Condicion = { metric: 'roi', op: '<', value: 1.2 };
    expect(avisoDeSospecha(fila({ condiciones: [gasto, roi] }))!.detalle).toContain('(condición 1)');
    expect(avisoDeSospecha(fila({ condiciones: [roi, gasto] }))!.detalle).toContain('(condición 2)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 7, en el borde de la UI: la sospecha que ve la pantalla es la del script
// ─────────────────────────────────────────────────────────────────────────────

// **Validates: Requirements 2.14**
describe('Property 7 en la pantalla: el aviso es exactamente lo que devuelve `sospechasDeRegla`', () => {
  it('para toda regla: hay badge si y sólo si hay sospechas, y el detalle no se pierde ninguna', () => {
    // Los valores se generan en el rango donde el predicado decide algo: cerca de
    // los dos umbrales (0–120) y con a lo sumo tres decimales, que es lo que la
    // reconstrucción puede explicar. Los `null` entran también: son la mayoría de
    // las reglas reales.
    const importe = fc.oneof(
      fc.constant(null),
      fc.integer({ min: 0, max: 120000 }).map((n) => n / 1000),
      fc.integer({ min: 100, max: 5000 }),
    );
    const genCondicion: fc.Arbitrary<Condicion> = fc.record({
      metric: fc.constantFrom<Condicion['metric']>('spend', 'revenue', 'net', 'profit', 'budget', 'roi', 'cpa', 'clicks'),
      op: fc.constantFrom<Condicion['op']>('>', '>=', '<', '<='),
      value: fc.integer({ min: 0, max: 120000 }).map((n) => n / 1000),
    });

    fc.assert(
      fc.property(
        fc.record({
          actionUnit: fc.constantFrom<ReglaFila['actionUnit']>(null, 'fixed', 'percent'),
          actionValue: importe,
          budgetMax: importe,
          budgetMin: importe,
          maxRunsPerDay: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 24 })),
          condiciones: fc.array(genCondicion, { maxLength: 4 }),
        }),
        (parcial) => {
          const r = fila(parcial);
          const ss = sospechasDeRegla(r);
          const aviso = avisoDeSospecha(r);

          // 1. El badge aparece exactamente cuando el script reportaría algo.
          expect(aviso === null).toBe(ss.length === 0);
          if (aviso === null) return;

          // 2. La cuenta de la etiqueta es la cantidad de sospechas.
          expect(aviso.etiqueta).toBe(ss.length === 1 ? 'revisar 1 importe' : `revisar ${ss.length} importes`);

          // 3. Ninguna sospecha se queda afuera del tooltip, y cada una llega con
          //    su texto probable y su intención: el mismo dato que el reporte.
          for (const s of ss) {
            expect(aviso.detalle).toContain(s.etiqueta);
            expect(aviso.detalle).toContain(`«${s.textoProbable}»`);
            expect(aviso.detalle).toContain(String(s.valorProbable));
          }
        },
      ),
      { numRuns: 1000 },
    );
  });
});
