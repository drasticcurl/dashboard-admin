import { describe, expect, it } from 'vitest';
import type { ExperimentoRow } from '@/lib/queries/funnel';
import { calcularTasasExperimento, SIN_EXPERIMENTO } from '@/lib/queries/funnel';
import {
  BRAZOS_DEL_TEST,
  MIN_COMPRAS_POR_BRAZO,
  brazosDelTest,
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

/**
 * Generalización (2026-09-28): el test de estética de chauhinchazon /
 * chauhinchazon-latam compara Original contra Ritual. Los brazos salen de lo que
 * el funnel declara; los tests de arriba (almagemela) no pasan brazos y prueban
 * el default, igual que antes.
 */
describe('brazosDelTest', () => {
  it('chauhinchazon: solo los estetica_* declarados, fuera los A/B de portada y del pitch', () => {
    expect(brazosDelTest(['A', 'B', 'pitch_A', 'pitch_B', 'estetica_original', 'estetica_ritual'])).toEqual([
      'estetica_original',
      'estetica_ritual',
    ]);
  });

  it('almagemela: la fila de referencia (_hilvanapp) no compite', () => {
    expect(brazosDelTest(['estetica_original', 'estetica_tarot', 'estetica_original_hilvanapp'])).toEqual([
      'estetica_original',
      'estetica_tarot',
    ]);
  });

  it('sin brazos declarados, el comportamiento de antes', () => {
    expect(brazosDelTest([])).toEqual(BRAZOS_DEL_TEST);
  });

  it('Original va primero aunque se haya declarado después', () => {
    expect(brazosDelTest(['estetica_ritual', 'estetica_original'])).toEqual(['estetica_original', 'estetica_ritual']);
  });
});

describe('Original contra Ritual (chauhinchazon)', () => {
  const brazos = brazosDelTest(['A', 'B', 'pitch_A', 'pitch_B', 'estetica_original', 'estetica_ritual']);

  it('ordena Original y después Ritual (el SQL las trae alfabéticas)', () => {
    const filas = [fila('estetica_ritual', 100, 3, 300), fila(SIN_EXPERIMENTO, 900, 9, 900), fila('estetica_original', 100, 3, 300)];
    expect(brazosEstetica(filas, brazos).map((f) => f.experiment)).toEqual(['estetica_original', 'estetica_ritual']);
  });

  it('gana el que más plata por sesión deja, aunque tenga menos compras', () => {
    // Original: 6 compras / 100 sesiones, 600 → 6/sesión. Ritual: 5 / 80, 640 → 8/sesión.
    const original = fila('estetica_original', 100, 6, 600);
    const ritual = fila('estetica_ritual', 80, 5, 640);
    expect(liderEstetica([original, ritual], brazos)?.experiment).toBe('estetica_ritual');
    // Sin los brazos, Ritual caería como referencia y nunca ganaría: por eso hacen falta.
    expect(liderEstetica([original, ritual])).toBeNull();
  });

  it('la muestra alcanza solo con MIN_COMPRAS_POR_BRAZO en los DOS brazos', () => {
    const n = MIN_COMPRAS_POR_BRAZO;
    expect(muestraChicaEstetica([fila('estetica_original', 5000, n + 50, 1)], brazos)).toBe(true);
    expect(muestraChicaEstetica([fila('estetica_original', 5000, n + 50, 1), fila('estetica_ritual', 5000, n - 1, 1)], brazos)).toBe(true);
    expect(muestraChicaEstetica([fila('estetica_original', 5000, n - 1, 1), fila('estetica_ritual', 5000, n + 50, 1)], brazos)).toBe(true);
    expect(muestraChicaEstetica([fila('estetica_original', 5000, n, 1), fila('estetica_ritual', 5000, n, 1)], brazos)).toBe(false);
  });

  it('el nombre de la fila nueva', () => {
    expect(nombreBrazoEstetica('estetica_ritual')).toBe('Ritual');
  });
});

describe('Original contra Original + (chauhinchazon, desde 2026-09-30)', () => {
  // Lo que queda declarado después de la 038: sale Ritual, entra Original +.
  const brazos = brazosDelTest(['A', 'B', 'pitch_A', 'pitch_B', 'estetica_original', 'estetica_plus']);

  it('los brazos son Original y Original +, en ese orden', () => {
    expect(brazos).toEqual(['estetica_original', 'estetica_plus']);
    const filas = [fila('estetica_plus', 100, 3, 300), fila(SIN_EXPERIMENTO, 900, 9, 900), fila('estetica_original', 100, 3, 300)];
    expect(brazosEstetica(filas, brazos).map((f) => f.experiment)).toEqual(['estetica_original', 'estetica_plus']);
  });

  it('decide por plata por sesión y avisa con muestra chica', () => {
    const original = fila('estetica_original', 100, 6, 600);
    const plus = fila('estetica_plus', 80, 5, 640);
    expect(liderEstetica([original, plus], brazos)?.experiment).toBe('estetica_plus');
    const n = MIN_COMPRAS_POR_BRAZO;
    expect(muestraChicaEstetica([fila('estetica_original', 5000, n, 1), fila('estetica_plus', 5000, n - 1, 1)], brazos)).toBe(true);
    expect(muestraChicaEstetica([fila('estetica_original', 5000, n, 1), fila('estetica_plus', 5000, n, 1)], brazos)).toBe(false);
  });

  it('el nombre de la fila', () => {
    expect(nombreBrazoEstetica('estetica_plus')).toBe('Original +');
  });
});
