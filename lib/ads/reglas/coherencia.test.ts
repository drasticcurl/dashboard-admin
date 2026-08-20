import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  motivoAlcanceInutil,
  motivoCondicionesImposibles,
  motivoIncoherente,
  motivoVentanaInvalida,
} from './coherencia';

/**
 * Las protecciones contra configuraciones que se pueden guardar y no pueden
 * funcionar. Módulo puro: no toca la base ni Meta.
 */

describe('motivoVentanaInvalida', () => {
  it('acepta la ventana vacía y la ventana completa con horas distintas', () => {
    expect(motivoVentanaInvalida(null, null)).toBeNull();
    expect(motivoVentanaInvalida('', '')).toBeNull();
    expect(motivoVentanaInvalida('08:00', '23:00')).toBeNull();
    // Cruzar la medianoche es válido: dentroDeVentana lo soporta con start > end.
    expect(motivoVentanaInvalida('22:00', '06:00')).toBeNull();
  });

  it('rechaza media ventana', () => {
    expect(motivoVentanaInvalida('08:00', null)).toContain('completa o vacía');
    expect(motivoVentanaInvalida(null, '23:00')).toContain('completa o vacía');
    expect(motivoVentanaInvalida('08:00', '   ')).toContain('completa o vacía');
  });

  it('rechaza las dos horas iguales, que dejan un minuto por día', () => {
    expect(motivoVentanaInvalida('12:30', '12:30')).toContain('ese minuto exacto');
    expect(motivoVentanaInvalida('00:00', '00:00')).toContain('ese minuto exacto');
  });
});

describe('motivoAlcanceInutil', () => {
  it('rechaza pausar mirando sólo pausados y activar mirando sólo activos', () => {
    expect(motivoAlcanceInutil('pause', 'paused')).toContain('no puede hacer nada');
    expect(motivoAlcanceInutil('activate', 'active')).toContain('no puede hacer nada');
  });

  it('deja pasar las combinaciones que sí pueden actuar', () => {
    expect(motivoAlcanceInutil('pause', 'active')).toBeNull();
    expect(motivoAlcanceInutil('pause', 'any')).toBeNull();
    expect(motivoAlcanceInutil('activate', 'paused')).toBeNull();
    expect(motivoAlcanceInutil('activate', 'any')).toBeNull();
    // Una regla de presupuesto puede editar un objeto pausado.
    expect(motivoAlcanceInutil('budget_increase', 'paused')).toBeNull();
    expect(motivoAlcanceInutil('budget_decrease', 'active')).toBeNull();
  });
});

describe('motivoCondicionesImposibles', () => {
  const c = (metric: string, op: string, value: number) => ({ metric, op, value });

  it('no se queja de lo que sí puede cumplirse', () => {
    expect(motivoCondicionesImposibles([])).toBeNull();
    expect(motivoCondicionesImposibles([c('spend', '>', 4)])).toBeNull();
    // Dos métricas distintas nunca se cruzan entre sí.
    expect(motivoCondicionesImposibles([c('sales', '<=', 0), c('spend', '>', 4)])).toBeNull();
    // Rango con solución: 4 < gasto < 10.
    expect(motivoCondicionesImposibles([c('spend', '>', 4), c('spend', '<', 10)])).toBeNull();
    // Redundante pero satisfacible: gana la más estricta.
    expect(motivoCondicionesImposibles([c('roi', '>', 1.5), c('roi', '>', 2)])).toBeNull();
    // Cerrado en un punto: 5 <= gasto <= 5 se cumple con gasto = 5.
    expect(motivoCondicionesImposibles([c('spend', '>=', 5), c('spend', '<=', 5)])).toBeNull();
  });

  it('detecta rangos vacíos', () => {
    expect(motivoCondicionesImposibles([c('spend', '>', 10), c('spend', '<', 5)])).toContain('nunca');
    expect(motivoCondicionesImposibles([c('spend', '>=', 7), c('spend', '<=', 3)])).toContain('nunca');
    // Abierto en los dos lados sobre el mismo número: no hay valor posible.
    expect(motivoCondicionesImposibles([c('spend', '>', 5), c('spend', '<', 5)])).toContain('nunca');
    expect(motivoCondicionesImposibles([c('spend', '>', 5), c('spend', '<=', 5)])).toContain('nunca');
  });

  it('detecta iguales que se contradicen', () => {
    expect(motivoCondicionesImposibles([c('sales', '=', 0), c('sales', '=', 3)])).toContain('al mismo tiempo');
    expect(motivoCondicionesImposibles([c('sales', '=', 2), c('sales', '!=', 2)])).toContain('al mismo tiempo');
    expect(motivoCondicionesImposibles([c('spend', '=', 3), c('spend', '>', 10)])).toContain('afuera del rango');
    expect(motivoCondicionesImposibles([c('spend', '=', 10), c('spend', '<', 10)])).toContain('afuera del rango');
    // Un igual dentro del rango es coherente.
    expect(motivoCondicionesImposibles([c('spend', '=', 7), c('spend', '>', 5), c('spend', '<', 10)])).toBeNull();
  });

  it('usa la etiqueta en castellano si se la pasan', () => {
    const msg = motivoCondicionesImposibles([c('spend', '>', 10), c('spend', '<', 5)], () => 'gasto');
    expect(msg).toContain('gasto');
  });

  it('Property: una sola condición por métrica nunca es imposible', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('spend', 'roi', 'sales', 'revenue'),
        fc.constantFrom('>', '>=', '<', '<=', '=', '!='),
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        (metric, op, value) => {
          expect(motivoCondicionesImposibles([{ metric, op, value }])).toBeNull();
        },
      ),
      { numRuns: 200 },
    );
  });

  it('Property: repetir la MISMA condición nunca la vuelve imposible', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('>', '>=', '<', '<=', '='),
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        (op, value) => {
          const dos = [
            { metric: 'spend', op, value },
            { metric: 'spend', op, value },
          ];
          expect(motivoCondicionesImposibles(dos)).toBeNull();
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('motivoIncoherente', () => {
  it('devuelve null para una regla que puede funcionar', () => {
    expect(
      motivoIncoherente({
        action: 'pause',
        statusFilter: 'active',
        windowStart: null,
        windowEnd: null,
        conditions: [
          { metric: 'sales', op: '<=', value: 0 },
          { metric: 'spend', op: '>', value: 4 },
        ],
      }),
    ).toBeNull();
  });

  it('encuentra el problema venga de donde venga', () => {
    expect(motivoIncoherente({ action: 'pause', statusFilter: 'paused' })).toContain('no puede hacer nada');
    expect(
      motivoIncoherente({ action: 'pause', statusFilter: 'active', windowStart: '09:00', windowEnd: '09:00' }),
    ).toContain('ese minuto exacto');
    expect(
      motivoIncoherente({
        action: 'pause',
        statusFilter: 'active',
        conditions: [
          { metric: 'spend', op: '>', value: 10 },
          { metric: 'spend', op: '<', value: 2 },
        ],
      }),
    ).toContain('nunca');
  });
});
