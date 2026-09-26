import { describe, expect, it } from 'vitest';
import type { ExperimentoRow } from '@/lib/queries/funnel';
import { calcularTasasExperimento, SIN_EXPERIMENTO } from '@/lib/queries/funnel';
import {
  MIN_COMPRAS_POR_BRAZO,
  brazosEstetica,
  debeMostrarCardEstetica,
  liderEstetica,
  muestraChicaEstetica,
  nombreBrazoEstetica,
} from './CardTestEstetica';

/**
 * Card del A/B de estética del quiz (almagemela). Funciones puras, sin jsdom,
 * mismo criterio que `gates.test.ts` y CardPitch.
 */

function fila(experiment: string, sessions: number, purchases: number, revenue: number): ExperimentoRow {
  return calcularTasasExperimento([
    {
      experiment,
      sessions,
      salesViews: Math.round(sessions / 2),
      checkoutClicks: purchases * 2,
      purchases,
      upsellViews: 0,
      upsellClicks: 0,
      downsellViews: 0,
      revenue,
    },
  ])[0]!;
}

describe('debeMostrarCardEstetica', () => {
  it('aparece solo si el funnel declara brazos estetica_*', () => {
    expect(debeMostrarCardEstetica(['estetica_original', 'estetica_tarot'])).toBe(true);
    expect(debeMostrarCardEstetica([])).toBe(false);
  });

  it('NO aparece en chauhinchazon: su A/B de portada cerrado y el del pitch son otros tests', () => {
    expect(debeMostrarCardEstetica(['A', 'B', 'pitch_A', 'pitch_B'])).toBe(false);
  });
});

describe('brazosEstetica', () => {
  it('deja afuera las sesiones sin asignar y los brazos de otros tests', () => {
    const filas = [
      fila('estetica_original', 100, 3, 30000),
      fila(SIN_EXPERIMENTO, 5000, 90, 900000),
      fila('pitch_A', 40, 1, 5000),
      fila('estetica_tarot', 110, 4, 42000),
    ];
    expect(brazosEstetica(filas).map((f) => f.experiment)).toEqual(['estetica_original', 'estetica_tarot']);
  });

  it('ordena Original, Tarot y después la referencia de los anuncios (el SQL las trae alfabéticas)', () => {
    const filas = calcularTasasExperimento(
      ['estetica_tarot', 'estetica_original_hilvanapp', 'estetica_original'].map((experiment) => ({
        experiment,
        sessions: 10,
        salesViews: 5,
        checkoutClicks: 2,
        purchases: 1,
        upsellViews: 0,
        upsellClicks: 0,
        downsellViews: 0,
        revenue: 100,
      })),
    );
    expect(brazosEstetica(filas).map((f) => f.experiment)).toEqual([
      'estetica_original',
      'estetica_tarot',
      'estetica_original_hilvanapp',
    ]);
  });
});

describe('nombreBrazoEstetica', () => {
  it('nombres claros para las tres filas conocidas', () => {
    expect(nombreBrazoEstetica('estetica_original')).toBe('Original');
    expect(nombreBrazoEstetica('estetica_tarot')).toBe('Tarot');
    expect(nombreBrazoEstetica('estetica_original_hilvanapp')).toBe('Original · anuncios');
  });

  it('una fila desconocida: saca el prefijo y capitaliza', () => {
    expect(nombreBrazoEstetica('estetica_minimal')).toBe('Minimal');
    expect(nombreBrazoEstetica('estetica_')).toBe('estetica_');
  });
});

describe('liderEstetica', () => {
  it('gana la plata por sesión, aunque el otro brazo tenga más compras', () => {
    // Original: 5 compras / 100 sesiones, 30.000 → 300/sesión.
    // Tarot: 4 compras / 80 sesiones, 32.000 → 400/sesión.
    const original = fila('estetica_original', 100, 5, 30000);
    const tarot = fila('estetica_tarot', 80, 4, 32000);
    expect(liderEstetica([original, tarot])?.experiment).toBe('estetica_tarot');
  });

  it('la referencia de los anuncios nunca gana, aunque deje más plata por sesión', () => {
    const original = fila('estetica_original', 100, 5, 30000);
    const tarot = fila('estetica_tarot', 80, 4, 32000);
    const anuncios = fila('estetica_original_hilvanapp', 5000, 400, 9000000);
    expect(liderEstetica([original, tarot, anuncios])?.experiment).toBe('estetica_tarot');
    expect(liderEstetica([original, anuncios])).toBeNull();
  });

  it('sin dos brazos con sesiones, o con empate, no marca a nadie', () => {
    expect(liderEstetica([fila('estetica_tarot', 50, 2, 10000)])).toBeNull();
    expect(liderEstetica([fila('estetica_original', 0, 0, 0), fila('estetica_tarot', 50, 2, 10000)])).toBeNull();
    expect(liderEstetica([fila('estetica_original', 10, 1, 1000), fila('estetica_tarot', 20, 2, 2000)])).toBeNull();
  });
});

describe('muestraChicaEstetica', () => {
  it('avisa mientras falte un brazo o el más chico no llegue al mínimo de compras', () => {
    const n = MIN_COMPRAS_POR_BRAZO;
    expect(muestraChicaEstetica([fila('estetica_tarot', 5000, n + 50, 1)])).toBe(true);
    expect(muestraChicaEstetica([fila('estetica_original', 5000, n - 1, 1), fila('estetica_tarot', 5000, n + 50, 1)])).toBe(true);
    expect(muestraChicaEstetica([fila('estetica_original', 5000, n, 1), fila('estetica_tarot', 5000, n + 50, 1)])).toBe(false);
  });

  it('la referencia de los anuncios no cuenta como brazo ni tapa la falta de uno', () => {
    const n = MIN_COMPRAS_POR_BRAZO;
    expect(
      muestraChicaEstetica([fila('estetica_tarot', 5000, n + 50, 1), fila('estetica_original_hilvanapp', 9000, n * 5, 1)]),
    ).toBe(true);
  });
});
