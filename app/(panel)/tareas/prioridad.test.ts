import { describe, expect, it } from 'vitest';
import {
  PRIORIDADES,
  etiquetaDePrioridad,
  ordenDePrioridad,
  tonoDePrioridad,
} from './prioridad';
import type { Prioridad } from '@/lib/queries/tareas';

describe('prioridad', () => {
  it('las tres prioridades dan tres tonos distintos', () => {
    const tonos = PRIORIDADES.map((p) => tonoDePrioridad(p));
    expect(new Set(tonos).size).toBe(3);
    expect(tonoDePrioridad('alta')).toBe('bad');
    expect(tonoDePrioridad('media')).toBe('warn');
    expect(tonoDePrioridad('baja')).toBe('neutral');
  });

  it('baja NUNCA es good: good es el acento del panel', () => {
    for (const p of PRIORIDADES) {
      expect(tonoDePrioridad(p as Prioridad)).not.toBe('good');
    }
  });

  it('ordenDePrioridad ordena alta → media → baja', () => {
    expect(ordenDePrioridad('alta')).toBe(0);
    expect(ordenDePrioridad('media')).toBe(1);
    expect(ordenDePrioridad('baja')).toBe(2);
    const ordenado = [...PRIORIDADES].sort(
      (a, b) => ordenDePrioridad(a as Prioridad) - ordenDePrioridad(b as Prioridad),
    );
    expect(ordenado).toEqual(['alta', 'media', 'baja']);
  });

  it('etiquetaDePrioridad devuelve la palabra capitalizada', () => {
    expect(etiquetaDePrioridad('alta')).toBe('Alta');
    expect(etiquetaDePrioridad('media')).toBe('Media');
    expect(etiquetaDePrioridad('baja')).toBe('Baja');
  });

  it('ningún tono ni etiqueta es un literal de color', () => {
    const esLiteralColor = (v: string) => /^#|^rgb\(/.test(v);
    for (const p of PRIORIDADES) {
      expect(esLiteralColor(tonoDePrioridad(p as Prioridad))).toBe(false);
      expect(esLiteralColor(etiquetaDePrioridad(p as Prioridad))).toBe(false);
    }
  });
});
