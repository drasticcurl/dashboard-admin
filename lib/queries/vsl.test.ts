import { describe, expect, it } from 'vitest';
import { curvaVsl, medianaHistograma, peoresTramos } from './vsl';

// 10 activaron el sonido: 2 se fueron antes de 5 s (sin audio), 3 a los 40 s,
// 2 a los 95 s y 3 lo terminaron (video de 300 s).
const H = [
  { maxSec: 40, sesiones: 3 },
  { maxSec: 95, sesiones: 2 },
  { maxSec: 298, sesiones: 3 },
];

describe('vsl', () => {
  it('la curva arranca en 100 % sobre los que activaron el sonido y cuenta sesiones que llegaron', () => {
    const c = curvaVsl(H, 10, 300);
    expect(c[0]).toEqual({ segundo: 0, sesiones: 10, pct: 100 });
    expect(c.find((p) => p.segundo === 30)?.sesiones).toBe(8);
    expect(c.find((p) => p.segundo === 60)?.sesiones).toBe(5);
    expect(c.at(-1)).toMatchObject({ segundo: 290, sesiones: 3, pct: 30 });
  });

  it('sin base no hay curva', () => {
    expect(curvaVsl(H, 0, 300)).toEqual([]);
  });

  it('los peores tramos no cuentan a quien lo terminó', () => {
    const t = peoresTramos(H, 10, 300);
    expect(t[0]).toMatchObject({ desde: 30, hasta: 60, seFueron: 3, pct: 30 });
    expect(t[1]).toMatchObject({ desde: 90, seFueron: 2 });
    expect(t).toHaveLength(2);
  });

  it('mediana del histograma', () => {
    expect(medianaHistograma(H)).toBe(95);
    expect(medianaHistograma([])).toBeNull();
  });
});
