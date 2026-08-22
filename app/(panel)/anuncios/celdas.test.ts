import { describe, expect, it } from 'vitest';
import type { NivelAds } from '@/lib/ads/tipos';
import { motivoPresupuestoNoEditable } from './celdas';

/**
 * Task 3.4: el motivo de la celda de presupuesto no editable (R1 c7).
 *
 * El test existe por una razón concreta: la versión anterior derivaba el texto
 * de `budgetLevel !== level` y afirmaba siempre "el presupuesto se maneja en la
 * campaña". Las dos cuentas reales son ABO (`budget_level = 'adset'`), así que
 * a nivel campaña el mensaje decía exactamente lo contrario de la realidad y
 * nadie lo notó por meses. Lo que se fija acá es que el texto nombre el nivel
 * donde el presupuesto vive DE VERDAD.
 */

type Fila = Parameters<typeof motivoPresupuestoNoEditable>[0];

function fila(
  level: NivelAds,
  budgetLevel: Fila['budgetLevel'],
  budgetMode: Fila['budgetMode'],
): Fila {
  return { level, budgetLevel, budgetMode };
}

describe('motivoPresupuestoNoEditable', () => {
  it('a nivel campaña en una cuenta ABO manda al conjunto, no a la campaña', () => {
    // El caso de producción: campaña de una cuenta ABO, sin presupuesto propio.
    const motivo = motivoPresupuestoNoEditable(fila('campaign', 'adset', null));
    expect(motivo).toContain('cada conjunto (ABO)');
    expect(motivo).toContain('Conjuntos');
    // La afirmación vieja, la que estaba invertida.
    expect(motivo).not.toContain('la campaña');
  });

  it('a nivel conjunto en una cuenta CBO manda a la campaña', () => {
    const motivo = motivoPresupuestoNoEditable(fila('adset', 'campaign', null));
    expect(motivo).toContain('la campaña (CBO)');
    expect(motivo).toContain('Campañas');
    expect(motivo).not.toContain('conjunto (ABO)');
  });

  it('cuando el presupuesto vive en este mismo nivel dice que falta el diario, y no se manda a sí mismo', () => {
    // budgetMode null con budgetLevel === level: el presupuesto se maneja acá,
    // pero el objeto no tiene ninguno cargado. Decir "se maneja en cada
    // conjunto" mirando conjuntos sería cierto e inservible.
    expect(motivoPresupuestoNoEditable(fila('adset', 'adset', null))).toBe(
      'este conjunto no tiene un presupuesto diario cargado en Meta',
    );
    expect(motivoPresupuestoNoEditable(fila('campaign', 'campaign', null))).toBe(
      'esta campaña no tiene un presupuesto diario cargado en Meta',
    );
  });

  it('sin presupuesto propio lo dice, en lugar de un "no editable" pelado', () => {
    const motivo = motivoPresupuestoNoEditable(fila('ad', null, null));
    expect(motivo).toContain('no tiene presupuesto propio');
    expect(motivo).not.toBe('no editable');
  });

  it('el presupuesto total gana sobre el nivel: no se arregla cambiando de pestaña', () => {
    for (const nivel of ['campaign', 'adset'] as const) {
      for (const donde of ['campaign', 'adset', null] as const) {
        expect(motivoPresupuestoNoEditable(fila(nivel, donde, 'lifetime'))).toBe(
          'presupuesto total: este panel sólo edita presupuestos diarios',
        );
      }
    }
  });

  it('ninguna combinación queda sin motivo ni nombra el nivel equivocado', () => {
    const niveles: NivelAds[] = ['campaign', 'adset', 'ad'];
    const dondes: Fila['budgetLevel'][] = ['campaign', 'adset', null];
    const modos: Fila['budgetMode'][] = ['daily', 'lifetime', null];
    for (const level of niveles) {
      for (const budgetLevel of dondes) {
        for (const budgetMode of modos) {
          const motivo = motivoPresupuestoNoEditable(fila(level, budgetLevel, budgetMode));
          expect(motivo.length).toBeGreaterThan(0);
          // Nunca puede mandar a la campaña un presupuesto que vive en el
          // conjunto, ni al revés: ese fue el bug.
          if (budgetLevel === 'adset' && budgetMode !== 'lifetime') expect(motivo).not.toContain('(CBO)');
          if (budgetLevel === 'campaign' && budgetMode !== 'lifetime') expect(motivo).not.toContain('(ABO)');
        }
      }
    }
  });
});
