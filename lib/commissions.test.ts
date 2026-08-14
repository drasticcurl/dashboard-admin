/**
 * Reglas de comisión.
 *
 * El foco no es la multiplicación, que es una línea, sino los casos que dan un
 * número creíble y equivocado — la única forma peligrosa de fallar en un panel
 * de plata. Un `NaN` en la columna contamina todos los totales sin romper nada
 * visible, y un porcentaje mal tipeado da un neto negativo que nadie explica.
 */
import { describe, expect, it } from 'vitest';
import { applyCommissions, type CommissionRule } from './commissions';

function regla(over: Partial<CommissionRule> = {}): CommissionRule {
  return {
    id: 1,
    name: 'Mercado Pago',
    funnelId: null,
    kind: 'percent',
    value: 5,
    currency: null,
    active: true,
    ...over,
  };
}

const ARS = { amount: 10000, currency: 'ARS' };

describe('applyCommissions', () => {
  it('una porcentual', () => {
    const r = applyCommissions({ ...ARS, rules: [regla({ value: 5 })] });
    expect(r.amount).toBe(500);
    expect(r.breakdown).toHaveLength(1);
    expect(r.breakdown[0]!.name).toBe('Mercado Pago');
  });

  it('una fija', () => {
    const r = applyCommissions({
      ...ARS,
      rules: [regla({ kind: 'fixed', value: 100, currency: 'ARS', name: 'Cargo fijo' })],
    });
    expect(r.amount).toBe(100);
  });

  it('varias juntas: global + del funnel, porcentual + fija', () => {
    const r = applyCommissions({
      ...ARS,
      rules: [
        regla({ id: 1, name: 'MP', value: 5 }),
        regla({ id: 2, name: 'IVA', value: 1.05 }),
        regla({ id: 3, name: 'Fijo', kind: 'fixed', value: 100, currency: 'ARS' }),
      ],
    });
    // 500 + 105 + 100
    expect(r.amount).toBe(705);
    expect(r.breakdown.map((b) => b.name)).toEqual(['MP', 'IVA', 'Fijo']);
  });

  it('los porcentajes NO se componen: el orden de las filas no cambia el total', () => {
    const a = applyCommissions({
      ...ARS,
      rules: [regla({ id: 1, value: 5 }), regla({ id: 2, value: 3 })],
    });
    const b = applyCommissions({
      ...ARS,
      rules: [regla({ id: 2, value: 3 }), regla({ id: 1, value: 5 })],
    });
    expect(a.amount).toBe(800); // 500 + 300, no 500 + 285
    expect(b.amount).toBe(a.amount);
  });

  it('las inactivas se ignoran', () => {
    const r = applyCommissions({
      ...ARS,
      rules: [regla({ value: 5 }), regla({ id: 2, value: 50, active: false })],
    });
    expect(r.amount).toBe(500);
  });

  it('una fija en otra moneda se saltea y avisa, no se convierte', () => {
    // Convertir metería la cotización del día en un número cargado como fijo.
    const r = applyCommissions({
      ...ARS,
      rules: [regla({ kind: 'fixed', value: 10, currency: 'USD', name: 'Cargo USD' })],
    });
    expect(r.amount).toBe(0);
    expect(r.warnings.join(' ')).toContain('Cargo USD');
    expect(r.warnings.join(' ')).toContain('USD');
  });

  it('EL CASO PELIGROSO: 629 en vez de 6.29 se ignora y avisa', () => {
    const r = applyCommissions({ ...ARS, rules: [regla({ value: 629 })] });
    expect(r.amount).toBe(0);
    expect(r.warnings.join(' ')).toContain('fuera de 0-100');
  });

  it('el total nunca supera el monto de la venta', () => {
    const r = applyCommissions({
      amount: 1000,
      currency: 'ARS',
      rules: [
        regla({ id: 1, value: 90 }),
        regla({ id: 2, kind: 'fixed', value: 5000, currency: 'ARS' }),
      ],
    });
    expect(r.amount).toBe(1000);
    expect(r.warnings.join(' ')).toContain('superaban el monto');
    // El desglose se conserva completo aunque el total se recorte: si no, no se
    // podría ver de dónde salió el exceso.
    expect(r.breakdown).toHaveLength(2);
  });

  it('sin reglas da 0 y no cambia ningún número', () => {
    const r = applyCommissions({ ...ARS, rules: [] });
    expect(r.amount).toBe(0);
    expect(r.amountEur).toBeNull();
    expect(r.breakdown).toEqual([]);
  });

  it('convierte a euros con la cotización de LA ORDEN', () => {
    const r = applyCommissions({ ...ARS, rules: [regla({ value: 10 })], fxRate: 0.0005785 });
    expect(r.amount).toBe(1000);
    expect(r.amountEur).toBe(0.58);
  });

  it('sin cotización el EUR queda en null, no en 0', () => {
    // Un 0 se sumaría como comisión nula y el neto en euros quedaría inflado.
    const r = applyCommissions({ ...ARS, rules: [regla({ value: 10 })], fxRate: null });
    expect(r.amountEur).toBeNull();
  });

  it('NaN e Infinity no se propagan a la columna', () => {
    expect(applyCommissions({ amount: NaN, currency: 'ARS', rules: [regla()] }).amount).toBe(0);
    expect(applyCommissions({ ...ARS, rules: [regla({ value: NaN })] }).amount).toBe(0);
    expect(applyCommissions({ ...ARS, rules: [regla({ value: Infinity })] }).amount).toBe(0);
    expect(
      applyCommissions({ ...ARS, rules: [regla({ value: 5 })], fxRate: NaN }).amountEur,
    ).toBeNull();
  });

  it('valores negativos se ignoran con aviso', () => {
    const r = applyCommissions({ ...ARS, rules: [regla({ value: -5 })] });
    expect(r.amount).toBe(0);
    expect(r.warnings.join(' ')).toContain('valor inválido');
  });

  it('redondea a centavos sin arrastrar el error de punto flotante', () => {
    const r = applyCommissions({ amount: 3, currency: 'ARS', rules: [regla({ value: 10 })] });
    expect(r.amount).toBe(0.3);
  });

  it('una venta de 0 no genera comisión por una regla fija', () => {
    const r = applyCommissions({
      amount: 0,
      currency: 'ARS',
      rules: [regla({ kind: 'fixed', value: 100, currency: 'ARS' })],
    });
    expect(r.amount).toBe(0);
  });
});
