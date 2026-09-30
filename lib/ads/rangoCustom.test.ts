import { describe, expect, it } from 'vitest';
import { resolverRangoCustom } from './rangoCustom';

const HOY = '2026-09-30';
const MIN = '2026-06-02';

describe('resolverRangoCustom', () => {
  it('deja pasar un rango válido tal cual', () => {
    expect(resolverRangoCustom('2026-09-01', '2026-09-15', HOY, MIN)).toEqual({ desde: '2026-09-01', hasta: '2026-09-15' });
  });
  it('recorta el inicio al primer día con ventas', () => {
    expect(resolverRangoCustom('2026-01-01', '2026-06-10', HOY, MIN)).toEqual({ desde: MIN, hasta: '2026-06-10' });
  });
  it('recorta el final a hoy', () => {
    expect(resolverRangoCustom('2026-09-20', '2026-12-31', HOY, MIN)).toEqual({ desde: '2026-09-20', hasta: HOY });
  });
  it('sin ventas todavía (minimo null) no recorta el inicio', () => {
    expect(resolverRangoCustom('2026-01-01', '2026-01-02', HOY, null)).toEqual({ desde: '2026-01-01', hasta: '2026-01-02' });
  });
  it('null si falta un borde, el formato es inválido o está invertido', () => {
    expect(resolverRangoCustom(null, '2026-09-01', HOY, MIN)).toBeNull();
    expect(resolverRangoCustom('2026-9-1', '2026-09-02', HOY, MIN)).toBeNull();
    expect(resolverRangoCustom('2026-09-10', '2026-09-01', HOY, MIN)).toBeNull();
  });
  it('null si el rango queda entero fuera de los bordes', () => {
    expect(resolverRangoCustom('2026-01-01', '2026-02-01', HOY, MIN)).toBeNull();
    expect(resolverRangoCustom('2026-10-05', '2026-10-06', HOY, MIN)).toBeNull();
  });
});
