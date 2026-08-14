/**
 * Costo por producto.
 *
 * El caso que más importa acá es el último: un costo mayor al precio de venta NO
 * se topea. En las comisiones sí se topea, porque una comisión mayor a la venta
 * sólo puede ser un error de tipeo; un costo mayor a la venta es un caso real
 * —se vende a pérdida— y taparlo escondería justamente lo que hay que ver.
 */
import { describe, expect, it } from 'vitest';
import { applyCosts, type ProductCost } from './costs';

const SHOP = 'mitienda.myshopify.com';

function costo(over: Partial<ProductCost> = {}): ProductCost {
  return { shopDomain: '*', productId: '111', cost: 1000, currency: 'ARS', ...over };
}
function item(productId: string | null, quantity = 1, title: string | null = 'Producto') {
  return { productId, title, quantity };
}

describe('applyCosts', () => {
  it('un ítem con costo cargado', () => {
    const r = applyCosts({
      items: [item('111')],
      currency: 'ARS',
      shopDomain: SHOP,
      costs: [costo()],
    });
    expect(r.amount).toBe(1000);
    expect(r.breakdown).toHaveLength(1);
  });

  it('multiplica por la cantidad', () => {
    const r = applyCosts({
      items: [item('111', 3)],
      currency: 'ARS',
      shopDomain: SHOP,
      costs: [costo()],
    });
    expect(r.amount).toBe(3000);
    expect(r.breakdown[0]!.quantity).toBe(3);
  });

  it('front + bump: suma los dos costos', () => {
    const r = applyCosts({
      items: [item('111', 1, 'Front'), item('222', 1, 'Bump')],
      currency: 'ARS',
      shopDomain: SHOP,
      costs: [costo({ productId: '111', cost: 1000 }), costo({ productId: '222', cost: 400 })],
    });
    expect(r.amount).toBe(1400);
    expect(r.breakdown.map((b) => b.title)).toEqual(['Front', 'Bump']);
  });

  it('un producto sin costo cargado no aporta nada y no rompe', () => {
    const r = applyCosts({
      items: [item('111'), item('999')],
      currency: 'ARS',
      shopDomain: SHOP,
      costs: [costo({ productId: '111' })],
    });
    expect(r.amount).toBe(1000);
    expect(r.breakdown).toHaveLength(1);
  });

  it('la fila de la tienda exacta le gana a la comodín *', () => {
    const r = applyCosts({
      items: [item('111')],
      currency: 'ARS',
      shopDomain: SHOP,
      costs: [costo({ shopDomain: '*', cost: 1000 }), costo({ shopDomain: SHOP, cost: 250 })],
    });
    expect(r.amount).toBe(250);
  });

  it('un costo en otra moneda se saltea y avisa, no se convierte', () => {
    const r = applyCosts({
      items: [item('111', 1, 'Importado')],
      currency: 'ARS',
      shopDomain: SHOP,
      costs: [costo({ currency: 'USD', cost: 10 })],
    });
    expect(r.amount).toBe(0);
    expect(r.warnings.join(' ')).toContain('Importado');
    expect(r.warnings.join(' ')).toContain('USD');
  });

  it('un ítem sin productId se ignora', () => {
    const r = applyCosts({
      items: [item(null)],
      currency: 'ARS',
      shopDomain: SHOP,
      costs: [costo()],
    });
    expect(r.amount).toBe(0);
  });

  it('convierte a euros con la cotización de la orden', () => {
    const r = applyCosts({
      items: [item('111')],
      currency: 'ARS',
      shopDomain: SHOP,
      costs: [costo()],
      fxRate: 0.0005785,
    });
    expect(r.amountEur).toBe(0.58);
  });

  it('sin cotización el EUR queda en null, no en 0', () => {
    const r = applyCosts({
      items: [item('111')],
      currency: 'ARS',
      shopDomain: SHOP,
      costs: [costo()],
      fxRate: null,
    });
    expect(r.amountEur).toBeNull();
  });

  it('cantidad inválida cuenta como 1, no como NaN', () => {
    const r = applyCosts({
      items: [item('111', NaN), item('222', -3)],
      currency: 'ARS',
      shopDomain: SHOP,
      costs: [costo({ productId: '111', cost: 100 }), costo({ productId: '222', cost: 50 })],
    });
    expect(r.amount).toBe(150);
  });

  it('EL CASO QUE NO SE TOPEA: el costo puede superar la venta (pérdida real)', () => {
    // 5000 de costo en una venta de 1000 es información, no un error de tipeo.
    // Si se topeara, el panel mostraría margen 0 en vez de margen negativo y el
    // producto seguiría vendiéndose a pérdida sin que nadie lo viera.
    const r = applyCosts({
      items: [item('111')],
      currency: 'ARS',
      shopDomain: SHOP,
      costs: [costo({ cost: 5000 })],
    });
    expect(r.amount).toBe(5000);
    expect(r.warnings).toEqual([]);
  });
});
