import { describe, expect, it } from 'vitest';
import { MILESTONES, validarEtapas, type EtapaEntrada } from './_etapas';

/**
 * Los cinco casos inválidos del §4 de T07, lockeados como función pura: el
 * route tiene que devolver 400 con motivo en castellano, y acá se testea que
 * la validación los rechaza ANTES de llegar a Postgres (un 500 de CHECK no es
 * un mensaje usable).
 */

const SLUGS = new Set(['landing_hook', 'edad', 'nombre', 'expert_bridge', 'sales_page']);

function etapa(
  stageOrder: number,
  label: string,
  fuente: { startsAtSlug?: string; milestone?: string } = {},
): EtapaEntrada {
  return {
    stageOrder,
    label,
    startsAtSlug: fuente.startsAtSlug ?? null,
    milestone: fuente.milestone ?? null,
  };
}

describe('validarEtapas (T07 §4)', () => {
  it('acepta el seed completo de la 017', () => {
    const etapas = [
      etapa(0, 'Landing', { startsAtSlug: 'landing_hook' }),
      etapa(1, 'Preguntas', { startsAtSlug: 'edad' }),
      etapa(2, 'Puente al experto', { startsAtSlug: 'expert_bridge' }),
      etapa(3, 'Página de venta', { startsAtSlug: 'sales_page' }),
      etapa(4, 'Vio la venta', { milestone: 'sales_view' }),
      etapa(5, 'Clickeó comprar', { milestone: 'checkout_click' }),
      etapa(6, 'Compró', { milestone: 'purchase' }),
    ];
    expect(validarEtapas(SLUGS, etapas)).toBeNull();
  });

  it('rechaza la lista vacía (el seed de la 017 la rellenaría sola)', () => {
    const res = validarEtapas(SLUGS, []);
    expect(res).not.toBeNull();
    expect(res!.error).toBe('stages_vacio');
  });

  it('rechaza una etapa con paso e hito a la vez', () => {
    const res = validarEtapas(SLUGS, [
      etapa(0, 'X', { startsAtSlug: 'landing_hook', milestone: 'purchase' }),
    ]);
    expect(res).not.toBeNull();
    expect(res!.error).toBe('etapa_sin_fuente_unica');
    expect(res!.detail).toContain('startsAtSlug');
  });

  it('rechaza una etapa sin fuente', () => {
    const res = validarEtapas(SLUGS, [etapa(0, 'X')]);
    expect(res).not.toBeNull();
    expect(res!.error).toBe('etapa_sin_fuente_unica');
  });

  it('rechaza un milestone fuera del vocabulario', () => {
    const res = validarEtapas(SLUGS, [etapa(0, 'X', { milestone: 'otra_cosa' })]);
    expect(res).not.toBeNull();
    expect(res!.error).toBe('milestone_invalido');
    expect(res!.detail).toContain(MILESTONES[0]);
  });

  it('rechaza un slug que arranca dos etapas', () => {
    const res = validarEtapas(SLUGS, [
      etapa(0, 'A', { startsAtSlug: 'landing_hook' }),
      etapa(1, 'B', { startsAtSlug: 'landing_hook' }),
    ]);
    expect(res).not.toBeNull();
    expect(res!.error).toBe('slug_repetido');
  });

  it('rechaza un slug que no existe en el funnel', () => {
    const res = validarEtapas(SLUGS, [etapa(0, 'A', { startsAtSlug: 'no_existe' })]);
    expect(res).not.toBeNull();
    expect(res!.error).toBe('slug_inexistente');
  });

  it('rechaza stage_order con huecos', () => {
    const res = validarEtapas(SLUGS, [
      etapa(0, 'A', { startsAtSlug: 'landing_hook' }),
      etapa(2, 'B', { milestone: 'purchase' }),
    ]);
    expect(res).not.toBeNull();
    expect(res!.error).toBe('stage_order_invalido');
  });

  it('rechaza stage_order repetidos', () => {
    const res = validarEtapas(SLUGS, [
      etapa(0, 'A', { startsAtSlug: 'landing_hook' }),
      etapa(0, 'B', { milestone: 'purchase' }),
    ]);
    expect(res).not.toBeNull();
    expect(res!.error).toBe('stage_order_invalido');
  });

  it('rechaza una etiqueta vacía o de espacios', () => {
    expect(validarEtapas(SLUGS, [etapa(0, '   ', { startsAtSlug: 'landing_hook' })])!.error).toBe(
      'etapa_sin_nombre',
    );
  });

  it('rechaza un hito repetido', () => {
    const res = validarEtapas(SLUGS, [
      etapa(0, 'A', { milestone: 'purchase' }),
      etapa(1, 'B', { milestone: 'purchase' }),
    ]);
    expect(res).not.toBeNull();
    expect(res!.error).toBe('milestone_repetido');
  });
});
