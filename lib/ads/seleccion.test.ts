import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MAX_CASCADA,
  MAX_SELECCION,
  aCascada,
  aplicarEvento,
  destildar,
  estadoInicial,
  normalizarCascada,
  tildar,
  tildarPagina,
  type EstadoSeleccion,
} from './seleccion';
import { genEventosSeleccion } from '../test/generadores-ads';

/**
 * Tests de ejemplo de Seleccion_Activa y Filtro_Cascada (task 6.3). La Property 8
 * (ninguna acción cruza niveles) vive en la task 6.2, sobre `aplicarEvento` con
 * secuencias de eventos al azar.
 */

function seleccionDe(nivel: 'campaign' | 'adset', n: number) {
  return {
    nivel,
    ids: Array.from({ length: n }, (_, i) => `${nivel}-${i}`),
  };
}

describe('tope de 100 (R9 c9, c10)', () => {
  it('el tilde 101 se bloquea sin alterar los 100 ya elegidos', () => {
    const llena = seleccionDe('adset', MAX_SELECCION);
    const { seleccion, agregado } = tildar(llena, 'extra');
    expect(agregado).toBe(false);
    expect(seleccion.ids).toHaveLength(MAX_SELECCION);
    expect(seleccion.ids).not.toContain('extra');
  });

  it('destildar siempre está permitido, también con la selección llena', () => {
    const llena = seleccionDe('adset', MAX_SELECCION);
    const s = destildar(llena, llena.ids[0]!);
    expect(s.ids).toHaveLength(MAX_SELECCION - 1);
  });
});

describe('tildar todas (R9 c8)', () => {
  it('tilda sólo las filas de la página en pantalla, hasta 100', () => {
    const previa = seleccionDe('adset', 3);
    const pagina = Array.from({ length: 8 }, (_, i) => `pag-${i}`);
    const s = tildarPagina(previa, pagina);
    expect(s.ids).toHaveLength(11);
    expect(s.ids).toEqual([...previa.ids, ...pagina]);
  });

  it('respeta el tope de 100 mezclando con la selección previa', () => {
    const previa = seleccionDe('adset', 98);
    const pagina = Array.from({ length: 5 }, (_, i) => `pag-${i}`);
    const s = tildarPagina(previa, pagina);
    expect(s.ids).toHaveLength(MAX_SELECCION);
    expect(s.ids.slice(98)).toEqual(['pag-0', 'pag-1']);
  });
});

describe('el conflicto 50/100 (R8 c14, R9 c4)', () => {
  it('una selección de 100 al bajar de nivel deja una cascada de 50 con descartados 50 y motivo tope', () => {
    const seleccion = seleccionDe('campaign', MAX_SELECCION);
    const cascada = aCascada(seleccion);
    expect(cascada.nivel).toBe('campaign');
    expect(cascada.ids).toHaveLength(MAX_CASCADA);
    expect(cascada.ids).toEqual(seleccion.ids.slice(0, MAX_CASCADA));
    expect(cascada.descartados).toBe(50);
    expect(cascada.motivo).toBe('tope');
  });

  it('conserva el ORDEN EN QUE VIENEN (el del Orden_Tabla vigente)', () => {
    const seleccion = { nivel: 'campaign' as const, ids: ['a', 'b', 'c'] };
    const enOrdenDeTabla = ['c', 'a', 'b'];
    const cascada = aCascada(seleccion, enOrdenDeTabla);
    expect(cascada.ids).toEqual(['c', 'a', 'b']);
  });
});

describe('la tabla de transiciones (aplicarEvento)', () => {
  it('cambiar un filtro de Barra_Filtros vacía la selección y conserva la cascada (R9 c6)', () => {
    let e: EstadoSeleccion = estadoInicial('campaign');
    e = aplicarEvento(e, { tipo: 'tildar', id: 'campaign-0' });
    e = aplicarEvento(e, { tipo: 'tildar', id: 'campaign-1' });
    e = aplicarEvento(e, { tipo: 'cambiar_filtro' });
    expect(e.seleccion.ids).toEqual([]);
    expect(e.cascada).toBeNull();
  });

  it('limpiar el Chip_Cascada vacía la cascada y conserva la selección (R8 c6)', () => {
    let e: EstadoSeleccion = estadoInicial('campaign');
    e = aplicarEvento(e, { tipo: 'tildar', id: 'campaign-0' });
    e = aplicarEvento(e, {
      tipo: 'cambiar_nivel',
      nivel: 'adset',
      idsDeLaCuenta: new Set(['campaign-0']),
    });
    expect(e.cascada?.ids).toEqual(['campaign-0']);
    e = aplicarEvento(e, { tipo: 'tildar', id: 's-1' });
    const seleccionAntes = e.seleccion.ids;
    e = aplicarEvento(e, { tipo: 'limpiar_cascada' });
    expect(e.cascada).toBeNull();
    expect(e.seleccion.ids).toEqual(seleccionAntes);
  });

  it('bajar de nivel con selección arma la cascada; subir la vacía (R9 c4, R8 c10)', () => {
    let e: EstadoSeleccion = estadoInicial('campaign');
    e = aplicarEvento(e, { tipo: 'tildar', id: 'campaign-0' });
    e = aplicarEvento(e, { tipo: 'tildar', id: 'campaign-1' });
    e = aplicarEvento(e, {
      tipo: 'cambiar_nivel',
      nivel: 'adset',
      idsDeLaCuenta: new Set(['campaign-0', 'campaign-1']),
    });
    expect(e.nivel).toBe('adset');
    expect(e.seleccion.ids).toEqual([]); // R9 c5: arranca en 0
    expect(e.cascada?.nivel).toBe('campaign');
    expect(e.cascada?.ids).toEqual(['campaign-0', 'campaign-1']);

    e = aplicarEvento(e, {
      tipo: 'cambiar_nivel',
      nivel: 'campaign',
      idsDeLaCuenta: new Set(['campaign-0', 'campaign-1']),
    });
    expect(e.cascada).toBeNull(); // R8 c10: subió al nivel de los ids
  });

  it('bajar de nivel con 0 seleccionados conserva la cascada (tabla del design, R1 c3)', () => {
    let e: EstadoSeleccion = estadoInicial('campaign');
    e = aplicarEvento(e, {
      tipo: 'cambiar_nivel',
      nivel: 'adset',
      idsDeLaCuenta: new Set(['x']),
    });
    expect(e.cascada).toBeNull();
    e = aplicarEvento(e, { tipo: 'cambiar_filtro' });
    e = aplicarEvento(e, { tipo: 'cambiar_nivel', nivel: 'ad', idsDeLaCuenta: new Set(['x']) });
    expect(e.cascada).toBeNull();
    expect(e.nivel).toBe('ad');
  });

  it('activar la pestaña del nivel vigente no cambia nada (R1 c15)', () => {
    const e = estadoInicial('campaign');
    const despues = aplicarEvento(e, {
      tipo: 'cambiar_nivel',
      nivel: 'campaign',
      idsDeLaCuenta: new Set(),
    });
    expect(despues).toBe(e);
  });

  it('normalizarCascada conserva sólo ids de la cuenta y reporta descartados (R8 c8, c9)', () => {
    const c = {
      nivel: 'campaign' as const,
      ids: ['misma', 'otra', 'misma', 'otra'],
      descartados: 0,
      motivo: null as null,
    };
    const n = normalizarCascada(c, 'adset', new Set(['misma']));
    expect(n.ids).toEqual(['misma']);
    expect(n.descartados).toBe(3); // 1 repetida + 2 de otra cuenta
    expect(n.motivo).toBe('otra_cuenta');
  });

  it('normalizarCascada vacía cuando el Nivel_Activo alcanza el nivel de los ids (R8 c10)', () => {
    const c = { nivel: 'adset' as const, ids: ['s1'], descartados: 0, motivo: null as null };
    expect(normalizarCascada(c, 'adset', new Set(['s1'])).ids).toEqual([]);
    expect(normalizarCascada(c, 'campaign', new Set(['s1'])).ids).toEqual([]);
    expect(normalizarCascada(c, 'ad', new Set(['s1'])).ids).toEqual(['s1']);
  });
});

// Feature: gestion-campanas-anuncios, Property 8: Ninguna Accion_Lote cruza
// niveles
describe('Property 8 (R9 c3, c2, c5, c12)', () => {
  it('para toda secuencia de eventos, la selección pertenece al nivel vigente y el nivel nuevo arranca vacío', () => {
    fc.assert(
      fc.property(genEventosSeleccion(), (eventos) => {
        let e: EstadoSeleccion = estadoInicial('campaign');
        for (const ev of eventos) {
          const nivelAntes = e.nivel;
          e = aplicarEvento(e, ev);
          // la Seleccion_Activa siempre declara el Nivel_Activo vigente
          expect(e.seleccion.nivel).toBe(e.nivel);
          // todo id tildado pertenece al nivel vigente (prefijo c/s/a del pool)
          for (const id of e.seleccion.ids) {
            const prefijo = id[0];
            if (e.nivel === 'campaign') expect(prefijo, `id ${id} en nivel ${e.nivel}`).toBe('c');
            if (e.nivel === 'adset') expect(prefijo, `id ${id} en nivel ${e.nivel}`).toBe('s');
            if (e.nivel === 'ad') expect(prefijo, `id ${id} en nivel ${e.nivel}`).toBe('a');
          }
          // nunca más de 100 (R9 c9)
          expect(e.seleccion.ids.length).toBeLessThanOrEqual(MAX_SELECCION);
          // la cascada nunca supera 50 (R8 c1)
          expect(e.cascada ? e.cascada.ids.length : 0).toBeLessThanOrEqual(MAX_CASCADA);

          if (ev.tipo === 'cambiar_nivel' && ev.nivel !== nivelAntes) {
            // R9 c5: la selección del nivel nuevo arranca vacía
            expect(e.seleccion.ids).toEqual([]);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
