import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  agruparPorColumna,
  aplicarMovimiento,
  estaVencida,
  moverEntreColumnas,
  nuevoOrdenAlSoltar,
  puedeEditar,
  type Yo,
} from './TableroView';
import type { Columna, Tarea } from '@/lib/queries/tareas';

// ─── Fábrica mínima de tareas para los tests ─────────────────────────────────

function tarea(over: Partial<Tarea> & Pick<Tarea, 'id'>): Tarea {
  return {
    id: over.id,
    titulo: `t${over.id}`,
    notas: null,
    columna: 'por_hacer',
    prioridad: 'media',
    posicion: 10,
    asignadoA: 1,
    asignadoNombre: 'Uno',
    creadoPor: 1,
    creadoPorNombre: 'Uno',
    venceEl: null,
    hechaAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    links: [],
    comentarios: [],
    ...over,
  };
}

describe('agruparPorColumna', () => {
  it('devuelve SIEMPRE las 4 claves, aunque alguna esté vacía', () => {
    const g = agruparPorColumna([tarea({ id: 1, columna: 'hecho' })]);
    expect(Object.keys(g).sort()).toEqual(
      ['en_progreso', 'en_revision', 'hecho', 'por_hacer'].sort(),
    );
    expect(g.por_hacer).toEqual([]);
    expect(g.hecho.map((t) => t.id)).toEqual([1]);
  });

  it('ordena por posicion y desempata por id', () => {
    const g = agruparPorColumna([
      tarea({ id: 3, columna: 'por_hacer', posicion: 20 }),
      tarea({ id: 1, columna: 'por_hacer', posicion: 10 }),
      tarea({ id: 2, columna: 'por_hacer', posicion: 10 }), // empate en posicion con id 1
    ]);
    // posicion 10 antes que 20; entre las dos de posicion 10, id 1 antes que id 2.
    expect(g.por_hacer.map((t) => t.id)).toEqual([1, 2, 3]);
  });
});

describe('nuevoOrdenAlSoltar (reordenar dentro de una columna)', () => {
  it('mueve al principio', () => {
    expect(nuevoOrdenAlSoltar([1, 2, 3, 4], 2, 0)).toEqual([3, 1, 2, 4]);
  });
  it('mueve al final', () => {
    expect(nuevoOrdenAlSoltar([1, 2, 3, 4], 0, 3)).toEqual([2, 3, 4, 1]);
  });
  it('mueve al medio', () => {
    expect(nuevoOrdenAlSoltar([1, 2, 3, 4], 0, 2)).toEqual([2, 3, 1, 4]);
  });
  it('soltar en el mismo lugar no cambia nada', () => {
    expect(nuevoOrdenAlSoltar([1, 2, 3, 4], 2, 2)).toEqual([1, 2, 3, 4]);
  });
});

describe('moverEntreColumnas (de una columna a otra)', () => {
  it('inserta el id en la posición destino', () => {
    expect(moverEntreColumnas([10, 20, 30], 99, 1)).toEqual([10, 99, 20, 30]);
  });
  it('al final si el índice se pasa', () => {
    expect(moverEntreColumnas([10, 20], 99, 5)).toEqual([10, 20, 99]);
  });
  it('en una columna VACÍA devuelve [id]', () => {
    expect(moverEntreColumnas([], 99, 0)).toEqual([99]);
  });
  it('nunca duplica si el id ya estuviera', () => {
    expect(moverEntreColumnas([10, 99, 20], 99, 0)).toEqual([99, 10, 20]);
  });
});

describe('puedeEditar', () => {
  const admin: Yo = { id: 9, nombre: 'Admin', esAdmin: true };
  const dueno: Yo = { id: 5, nombre: 'Dueño', esAdmin: false };
  const otro: Yo = { id: 7, nombre: 'Otro', esAdmin: false };
  const t = { asignadoA: 5 };

  it('admin edita cualquiera', () => {
    expect(puedeEditar(admin, t)).toBe(true);
  });
  it('el dueño edita la suya', () => {
    expect(puedeEditar(dueno, t)).toBe(true);
  });
  it('el resto no', () => {
    expect(puedeEditar(otro, t)).toBe(false);
  });
});

describe('estaVencida', () => {
  const hoy = new Date('2026-09-08T12:00:00');
  it('ayer está vencida', () => {
    expect(estaVencida('2026-09-07', hoy)).toBe(true);
  });
  it('HOY no está vencida', () => {
    expect(estaVencida('2026-09-08', hoy)).toBe(false);
  });
  it('mañana no está vencida', () => {
    expect(estaVencida('2026-09-09', hoy)).toBe(false);
  });
  it('sin fecha no está vencida', () => {
    expect(estaVencida(null, hoy)).toBe(false);
  });
});

describe('contadores', () => {
  it('links y comentarios vacíos son 0, no undefined', () => {
    const t = tarea({ id: 1 });
    expect(t.links.length).toBe(0);
    expect(t.comentarios.length).toBe(0);
    expect(t.links.length).not.toBeUndefined();
    expect(t.comentarios.length).not.toBeUndefined();
  });
});

describe('aplicarMovimiento (estado local ≡ lo que escribe el server)', () => {
  it('reescribe posiciones 10,20,30… en la columna destino y cambia la columna', () => {
    const tareas = [
      tarea({ id: 1, columna: 'por_hacer', posicion: 10 }),
      tarea({ id: 2, columna: 'en_progreso', posicion: 10 }),
      tarea({ id: 3, columna: 'en_progreso', posicion: 20 }),
    ];
    // mover id 1 a en_progreso, entre 2 y 3
    const res = aplicarMovimiento(tareas, 1, 'en_progreso', [2, 1, 3]);
    const m = new Map(res.map((t) => [t.id, t]));
    expect(m.get(1)!.columna).toBe('en_progreso');
    expect(m.get(2)!.posicion).toBe(10);
    expect(m.get(1)!.posicion).toBe(20);
    expect(m.get(3)!.posicion).toBe(30);
  });
});

// ─── La propiedad (no opcional): nuevoOrdenAlSoltar es una PERMUTACIÓN ────────

describe('propiedad: nuevoOrdenAlSoltar preserva todos los ids (fast-check)', () => {
  it('para cualquier lista y cualquier (desde,hasta) válido, el resultado es una permutación exacta', () => {
    fc.assert(
      fc.property(
        // ids únicos (son ids de tarjetas: no se repiten en una columna)
        fc.uniqueArray(fc.integer({ min: 1, max: 10_000 }), { minLength: 1, maxLength: 40 }),
        fc.nat(),
        fc.nat(),
        (ids, a, b) => {
          const desde = a % ids.length;
          const hasta = b % ids.length;
          const salida = nuevoOrdenAlSoltar(ids, desde, hasta);

          // mismo largo
          expect(salida.length).toBe(ids.length);
          // sin duplicados
          expect(new Set(salida).size).toBe(salida.length);
          // mismos elementos exactos (sin pérdidas, sin agregados)
          expect([...salida].sort((x, y) => x - y)).toEqual([...ids].sort((x, y) => x - y));
        },
      ),
      { numRuns: 200 },
    );
  });
});
