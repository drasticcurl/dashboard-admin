import { describe, expect, it } from 'vitest';
import { nombreVisible } from './funnel-nombre';

/**
 * `nombreVisible` es la única lógica del alias: un solo lugar decide qué nombre
 * ve el usuario. Si esto se duplica en otro componente, aparecen dos criterios
 * distintos para el mismo funnel.
 */
describe('nombreVisible', () => {
  it('con alias devuelve el alias', () => {
    expect(nombreVisible({ name: 'Chau Hinchazón', alias: 'Oferta A' })).toBe('Oferta A');
  });

  it('sin alias devuelve el nombre real', () => {
    expect(nombreVisible({ name: 'Chau Hinchazón', alias: null })).toBe('Chau Hinchazón');
  });

  it('un alias de sólo espacios cuenta como sin alias', () => {
    expect(nombreVisible({ name: 'Protocolo Reset +', alias: '   ' })).toBe('Protocolo Reset +');
  });

  it('recorta los espacios de los extremos del alias', () => {
    expect(nombreVisible({ name: 'Chau Hinchazón', alias: '  Oferta A  ' })).toBe('Oferta A');
  });

  it('un alias vacío cuenta como sin alias', () => {
    expect(nombreVisible({ name: 'Chau Hinchazón', alias: '' })).toBe('Chau Hinchazón');
  });
});
