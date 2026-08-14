/**
 * Tests de la lógica pura del runtime de widgets (task T03 §5): sin DOM y sin
 * base, son funciones puras. Los 8 grupos del §5, y el del medio del grupo 1
 * es el más importante del rediseño: `{v:1,widgets:[]}` NO es lo mismo que
 * `null`. Si se colapsan, el usuario borra todos sus widgets, guarda, recarga
 * y le vuelven los de fábrica (D-R04).
 */

import { describe, expect, it } from 'vitest';
import { hasChanges, parseLayout, reorder, resolveLayout, resize, widgetLayoutSchema } from './layout';
import type { WidgetCatalogo, WidgetLayout, WidgetPlacement, WidgetSize } from './tipos';

/** Catálogo de juguete para los tests: 3 widgets con tamaños distintos. */
const catalogo: WidgetCatalogo<null> = {
  a: {
    id: 'a',
    label: 'A',
    grupo: 'plata',
    tamañoPorDefecto: { w: 1, h: 1 },
    tamañosPermitidos: [
      { w: 1, h: 1 },
      { w: 2, h: 1 },
    ],
    render: () => null,
  },
  b: {
    id: 'b',
    label: 'B',
    grupo: 'graficos',
    tamañoPorDefecto: { w: 2, h: 2 },
    tamañosPermitidos: [{ w: 2, h: 2 }],
    render: () => null,
  },
  c: {
    id: 'c',
    label: 'C',
    grupo: 'listas',
    tamañoPorDefecto: { w: 2, h: 1 },
    tamañosPermitidos: [
      { w: 2, h: 1 },
      { w: 1, h: 2 },
    ],
    render: () => null,
  },
};

const porDefecto: WidgetPlacement[] = [
  { id: 'a', w: 1, h: 1 },
  { id: 'b', w: 2, h: 2 },
];

const lleno: WidgetPlacement[] = [
  { id: 'a', w: 1, h: 1 },
  { id: 'b', w: 2, h: 2 },
  { id: 'c', w: 1, h: 2 },
];

/** Un layout tipado, para no escribir `as const` en cada literal del test. */
function layoutDe(widgets: WidgetPlacement[]): WidgetLayout {
  return { v: 1, widgets };
}

// ─── 1. Los tres estados de D-R04 ────────────────────────────────────────────

describe('parseLayout y resolveLayout: los tres estados de D-R04', () => {
  it('fila con null → parseLayout null y resolveLayout devuelve el layout por defecto', () => {
    expect(parseLayout(null)).toBeNull();
    const resuelto = resolveLayout(null, catalogo, porDefecto);
    expect(resuelto.placements).toEqual(porDefecto);
    expect(resuelto.desconocidos).toEqual([]);
  });

  it('{v:1,widgets:[]} → parseLayout lo conserva y resolveLayout RESPETA el vacío', () => {
    const layout = parseLayout({ v: 1, widgets: [] });
    expect(layout).toEqual({ v: 1, widgets: [] });
    expect(layout).not.toBeNull();

    const resuelto = resolveLayout(layout, catalogo, porDefecto);
    expect(resuelto.placements).toEqual([]);
    expect(resuelto.desconocidos).toEqual([]);
  });

  it('con widgets → esos widgets, en el mismo orden', () => {
    const layout = parseLayout({ v: 1, widgets: lleno });
    const resuelto = resolveLayout(layout, catalogo, porDefecto);
    expect(resuelto.placements).toEqual(lleno);
    expect(resuelto.desconocidos).toEqual([]);
  });
});

// ─── 2. id desconocido ───────────────────────────────────────────────────────

describe('id desconocido', () => {
  it('se descarta, aparece en desconocidos, y los demás se renderizan', () => {
    const layout = layoutDe([
      { id: 'no_existe', w: 1, h: 1 },
      { id: 'a', w: 1, h: 1 },
      { id: 'c', w: 1, h: 2 },
    ]);
    const resuelto = resolveLayout(layout, catalogo, porDefecto);
    expect(resuelto.placements).toEqual([
      { id: 'a', w: 1, h: 1 },
      { id: 'c', w: 1, h: 2 },
    ]);
    expect(resuelto.desconocidos).toEqual(['no_existe']);
  });

  it('un id desconocido repetido se reporta UNA sola vez', () => {
    const layout = layoutDe([
      { id: 'no_existe', w: 1, h: 1 },
      { id: 'no_existe', w: 2, h: 2 },
      { id: 'a', w: 1, h: 1 },
    ]);
    const resuelto = resolveLayout(layout, catalogo, porDefecto);
    expect(resuelto.desconocidos).toEqual(['no_existe']);
    expect(resuelto.placements).toEqual([{ id: 'a', w: 1, h: 1 }]);
  });

  it('un layout SOLO con ids desconocidos no tira: pantalla vacía y aviso, nunca en blanco por excepción', () => {
    const layout = layoutDe([{ id: 'zzz', w: 1, h: 1 }]);
    const resuelto = resolveLayout(layout, catalogo, porDefecto);
    expect(resuelto.placements).toEqual([]);
    expect(resuelto.desconocidos).toEqual(['zzz']);
  });
});

// ─── 3. basura nunca tira ────────────────────────────────────────────────────

describe('parseLayout con basura', () => {
  it.each([
    ['undefined', undefined],
    ['string json', '{}'],
    ['versión desconocida', { v: 99, widgets: [] }],
    ['widgets que no es array', { v: 1, widgets: 'x' }],
    ['placement con w inválido', { v: 1, widgets: [{ id: 'a', w: 3, h: 1 }] }],
    ['placement con h inválido', { v: 1, widgets: [{ id: 'a', w: 1, h: 9 }] }],
    ['placement sin id', { v: 1, widgets: [{ w: 1, h: 1 }] }],
    ['un número', 42],
    ['un array', [1, 2]],
    ['más de 100 widgets', { v: 1, widgets: Array.from({ length: 101 }, () => ({ id: 'a', w: 1, h: 1 })) }],
  ])('%s → null, sin lanzar', (_nombre, raw) => {
    expect(() => parseLayout(raw)).not.toThrow();
    expect(parseLayout(raw)).toBeNull();
  });

  it('100 widgets exactos es válido (el tope no corta de más)', () => {
    const widgets = Array.from({ length: 100 }, (_, i) => ({ id: `w${i}`, w: 1, h: 1 }));
    expect(parseLayout({ v: 1, widgets })).not.toBeNull();
  });
});

// ─── 4 y 5. resize y tamaños guardados ──────────────────────────────────────

describe('resize', () => {
  it('aplica un tamaño permitido', () => {
    const resultado = resize(lleno, 'a', { w: 2, h: 1 }, catalogo);
    expect(resultado).toEqual([
      { id: 'a', w: 2, h: 1 },
      { id: 'b', w: 2, h: 2 },
      { id: 'c', w: 1, h: 2 },
    ]);
    expect(resultado).not.toBe(lleno);
  });

  it('NO aplica un tamaño que el widget no permite', () => {
    expect(resize(lleno, 'b', { w: 1, h: 1 }, catalogo)).toEqual(lleno);
    expect(resize(lleno, 'c', { w: 1, h: 1 }, catalogo)).toEqual(lleno);
  });

  it('un id que no está en el catálogo no cambia nada', () => {
    expect(resize(lleno, 'zzz', { w: 1, h: 1 }, catalogo)).toEqual(lleno);
  });
});

describe('w/h guardado que ya no está permitido', () => {
  it('cae al tamañoPorDefecto del catálogo, no se renderiza el tamaño guardado', () => {
    const layout = layoutDe([{ id: 'b', w: 1, h: 1 }]);
    const resuelto = resolveLayout(layout, catalogo, porDefecto);
    expect(resuelto.placements).toEqual([{ id: 'b', w: 2, h: 2 }]);
  });

  it('un tamaño guardado permitido se conserva tal cual', () => {
    const layout = layoutDe([{ id: 'a', w: 2, h: 1 }]);
    const resuelto = resolveLayout(layout, catalogo, porDefecto);
    expect(resuelto.placements).toEqual([{ id: 'a', w: 2, h: 1 }]);
  });
});

// ─── 6. reorder ──────────────────────────────────────────────────────────────

describe('reorder', () => {
  it('mueve el primero al final', () => {
    expect(reorder(lleno, 0, 2)).toEqual([
      { id: 'b', w: 2, h: 2 },
      { id: 'c', w: 1, h: 2 },
      { id: 'a', w: 1, h: 1 },
    ]);
  });

  it('mueve el último al principio', () => {
    expect(reorder(lleno, 2, 0)).toEqual([
      { id: 'c', w: 1, h: 2 },
      { id: 'a', w: 1, h: 1 },
      { id: 'b', w: 2, h: 2 },
    ]);
  });

  it('conserva la cantidad y el contenido, sólo cambia el orden', () => {
    const reordenado = reorder(lleno, 0, 1);
    expect(reordenado).toHaveLength(lleno.length);
    for (const p of lleno) {
      expect(reordenado).toContainEqual(p);
    }
  });

  it('un índice fuera de rango no destruye el array', () => {
    expect(reorder(lleno, 0, 99)).toEqual(lleno);
    expect(reorder(lleno, 99, 0)).toEqual(lleno);
    expect(reorder(lleno, -1, 0)).toEqual(lleno);
    expect(reorder(lleno, 0, -1)).toEqual(lleno);
    expect(reorder(lleno, 1, 1)).toEqual(lleno);
  });
});

// ─── 7. id repetido ──────────────────────────────────────────────────────────

describe('id repetido en el layout', () => {
  it('se queda con la primera aparición', () => {
    const layout = layoutDe([
      { id: 'a', w: 2, h: 1 },
      { id: 'b', w: 2, h: 2 },
      { id: 'a', w: 1, h: 1 },
    ]);
    const resuelto = resolveLayout(layout, catalogo, porDefecto);
    expect(resuelto.placements).toEqual([
      { id: 'a', w: 2, h: 1 },
      { id: 'b', w: 2, h: 2 },
    ]);
  });
});

// ─── 8. hasChanges ───────────────────────────────────────────────────────────

describe('hasChanges', () => {
  it('mismo layout → false', () => {
    expect(hasChanges(lleno, lleno)).toBe(false);
    expect(hasChanges([], [])).toBe(false);
  });

  it('distinto orden con los mismos ids → true (el orden ES parte del layout)', () => {
    const reordenado = reorder(lleno, 2, 0);
    expect(hasChanges(reordenado, lleno)).toBe(true);
  });

  it('guardado null con placements → true', () => {
    expect(hasChanges(lleno, null)).toBe(true);
  });

  it('guardado null con el vacío también es un cambio: se puede guardar "sin widgets"', () => {
    expect(hasChanges([], null)).toBe(true);
  });

  it('cambio de tamaño → true', () => {
    const agrandado = resize(lleno, 'a', { w: 2, h: 1 }, catalogo);
    expect(hasChanges(agrandado, lleno)).toBe(true);
  });

  it('sacar o agregar un widget → true', () => {
    expect(hasChanges(lleno.slice(1), lleno)).toBe(true);
    expect(hasChanges(lleno, lleno.slice(1))).toBe(true);
  });

  it('después de guardar el mismo array → false', () => {
    const guardado = lleno.map((p) => ({ ...p }));
    expect(hasChanges(lleno, guardado)).toBe(false);
  });
});

// ─── schema compartido con el endpoint ───────────────────────────────────────

describe('widgetLayoutSchema (el que usa el POST)', () => {
  it('acepta un layout válido', () => {
    expect(widgetLayoutSchema.safeParse({ v: 1, widgets: lleno }).success).toBe(true);
    expect(widgetLayoutSchema.safeParse({ v: 1, widgets: [] }).success).toBe(true);
  });

  it('rechaza pantallas falsas, versiones y tamaños inválidos', () => {
    expect(widgetLayoutSchema.safeParse({ v: 99, widgets: [] }).success).toBe(false);
    expect(widgetLayoutSchema.safeParse({ v: 1, widgets: [{ id: 'x', w: 3, h: 1 }] }).success).toBe(false);
    expect(widgetLayoutSchema.safeParse({ v: 1, widgets: null }).success).toBe(false);
  });
});

// El tipo de tamaño tiene que ser literal 1|2 en toda la cadena: si alguien
// relaja WidgetSize, estos tests lo van a decir en compile-time igual; acá lo
// fijamos en runtime para que el layout guardado no pueda guardar w: 0.
describe('tipos de tamaño', () => {
  it('parseLayout normaliza a w/h 1|2', () => {
    const layout = parseLayout({ v: 1, widgets: [{ id: 'a', w: 1, h: 1 }] });
    expect(layout?.widgets[0]).toEqual({ id: 'a', w: 1, h: 1 });
    const size: WidgetSize = layout!.widgets[0];
    expect([1, 2]).toContain(size.w);
    expect([1, 2]).toContain(size.h);
  });
});
