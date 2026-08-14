'use client';

/**
 * ProductosSection — product_map: lo que resuelve el tier y el funnel de
 * cada venta (T07 §3). Mapear re-resuelve las órdenes viejas, y el costo se
 * congela en cada venta.
 */

import { useState } from 'react';
import type { Funnel } from '@/lib/funnels';
import { TIERS } from '@/lib/types';
import type { ProductMapping, UnmappedProduct } from '@/app/api/config/_lib';
import { Badge, Card, Table, fmtDateTime, fmtInt } from '@/components/ui';
import { btnGhost, btnPrimary, inputCls, type ConfigShell } from '../kit';

const TIER_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad' | 'info'> = {
  front: 'good',
  bump: 'info',
  upsell: 'neutral',
  upsell2: 'neutral',
  downsell: 'neutral',
  unknown: 'warn',
};

export function ProductosSection({
  funnel,
  funnels,
  mappings,
  setMappings,
  unmapped,
  setUnmapped,
  shell,
}: {
  funnel: Funnel;
  funnels: Funnel[];
  mappings: ProductMapping[];
  setMappings: (m: ProductMapping[]) => void;
  unmapped: UnmappedProduct[];
  setUnmapped: (u: UnmappedProduct[]) => void;
  shell: ConfigShell;
}): JSX.Element {
  const { api, show, busy, setBusy } = shell;

  const [productForm, setProductForm] = useState({
    shopDomain: '*',
    productId: '',
    funnelId: funnel.id,
    tier: 'front',
    label: '',
    cost: '',
    costCurrency: 'ARS',
  });

  async function refreshProducts() {
    const res = await api<{ mappings: ProductMapping[]; unmapped: UnmappedProduct[] }>(
      '/api/config/products',
    );
    setMappings(res.mappings);
    setUnmapped(res.unmapped);
  }

  async function saveProduct() {
    setBusy(true);
    try {
      const res = await api<{
        correctedItems: number;
        correctedOrders: number;
        correctedCosts: number;
        stampedByTitle: number;
      }>(
        '/api/config/products',
        {
          method: 'POST',
          // El costo va como número y la moneda solo si hay costo: el schema
          // rechaza un costo sin moneda, y mandar '' daría un 400 poco claro.
          body: JSON.stringify({
            ...productForm,
            cost: Number(productForm.cost || 0),
            costCurrency: Number(productForm.cost || 0) > 0 ? productForm.costCurrency : null,
          }),
        },
      );
      await refreshProducts();
      setProductForm({ ...productForm, productId: '', label: '', cost: '' });
      // El costo se informa aparte porque es lo que el usuario acaba de cargar:
      // decir solo "se re-resolvieron 0 órdenes" hacía parecer que no pasó nada.
      show(
        'good',
        `Producto mapeado — ${res.correctedItems} ítems y ${res.correctedOrders} órdenes re-resueltas · ` +
          `costo recalculado en ${res.correctedCosts} ${res.correctedCosts === 1 ? 'venta' : 'ventas'}` +
          (res.stampedByTitle > 0 ? ` · ${res.stampedByTitle} enganchados por título` : ''),
      );
    } catch (err) {
      show('bad', err instanceof Error ? err.message : 'Error');
    } finally {
      setBusy(false);
    }
  }

  async function deleteMapping(m: ProductMapping) {
    if (!window.confirm(`¿Borrar el mapa de "${m.productId}" en ${m.shopDomain}?`)) return;
    setBusy(true);
    try {
      await api(
        `/api/config/products?shopDomain=${encodeURIComponent(m.shopDomain)}&productId=${encodeURIComponent(m.productId)}`,
        { method: 'DELETE' },
      );
      await refreshProducts();
      show('good', 'Mapa borrado');
    } catch (err) {
      show('bad', err instanceof Error ? err.message : 'Error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Productos → funnel y tier"
      hint="product_map: lo que resuelve el tier y el funnel de cada venta (D10, D11). Mapear re-resuelve las órdenes viejas."
    >
      <Table
        rows={mappings}
        empty="Todavía no hay productos mapeados"
        columns={[
          { key: 'shop', header: 'Tienda', render: (m) => <code className="rounded bg-overlay/10 px-1 text-neutral-300">{m.shopDomain}</code> },
          { key: 'pid', header: 'Producto', render: (m) => <code className="text-neutral-300">{m.productId}</code> },
          { key: 'funnel', header: 'Funnel', render: (m) => <span className="text-neutral-300">{m.funnelName}</span> },
          { key: 'tier', header: 'Tier', render: (m) => <Badge tone={TIER_TONE[m.tier] ?? 'neutral'}>{m.tier}</Badge> },
          { key: 'label', header: 'Label', render: (m) => <span className="text-neutral-400">{m.label ?? '—'}</span> },
          {
            key: 'cost',
            header: 'Costo',
            align: 'right',
            render: (m) =>
              m.cost > 0 ? (
                <span className="tabular-nums text-neutral-300">
                  {m.cost} {m.costCurrency}
                </span>
              ) : (
                <Badge tone="warn">sin cargar</Badge>
              ),
          },
          {
            key: 'acciones',
            header: '',
            render: (m) => (
              <button
                type="button"
                className={btnGhost}
                onClick={() => {
                  setProductForm({
                    shopDomain: m.shopDomain,
                    productId: m.productId,
                    funnelId: m.funnelId,
                    tier: m.tier,
                    label: m.label ?? '',
                    cost: m.cost > 0 ? String(m.cost) : '',
                    costCurrency: m.costCurrency ?? 'ARS',
                  });
                }}
              >
                Editar
              </button>
            ),
          },
        ]}
      />

      {unmapped.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-sm font-semibold text-warn-200">
            Aparecieron en ventas y todavía no tienen mapa ({unmapped.length})
          </p>
          <Table
            rows={unmapped}
            empty=""
            columns={[
              {
                key: 'pid',
                header: 'Producto',
                // Sin ID = vino del import de CSV (el export de Shopify no
                // trae product_id). Se dice explícito para que no parezca un
                // dato faltante por error: se mapea por título.
                render: (u) =>
                  u.productId ? (
                    <code className="text-neutral-300">{u.productId}</code>
                  ) : (
                    <span className="text-warn-300/80">sin ID · por título</span>
                  ),
              },
              { key: 'title', header: 'Título', render: (u) => <span className="block max-w-64 truncate text-neutral-300" title={u.title ?? undefined}>{u.title ?? '—'}</span> },
              { key: 'shop', header: 'Tienda', render: (u) => <code className="rounded bg-overlay/10 px-1 text-neutral-400">{u.shopDomain}</code> },
              { key: 'veces', header: 'Ventas', align: 'right', render: (u) => <span className="tabular-nums text-neutral-300">{fmtInt(u.veces)}</span> },
              { key: 'ultima', header: 'Última', render: (u) => <span className="text-neutral-400">{u.ultima ? fmtDateTime(u.ultima) : '—'}</span> },
              {
                key: 'acciones',
                header: '',
                render: (u) => (
                  <button
                    type="button"
                    className={btnPrimary}
                    onClick={() =>
                      setProductForm({
                        shopDomain: u.shopDomain,
                        // Sin ID de Shopify se propone uno derivado del
                        // título: la tabla lo necesita (es parte de la PK) y
                        // así queda a la vista que no es un ID de Shopify. Si
                        // el usuario tiene el real, lo reemplaza y el
                        // enganche por título funciona igual.
                        productId: u.productId ?? `titulo:${(u.title ?? '').slice(0, 240)}`,
                        funnelId: funnel.id,
                        tier: 'front',
                        // El label es lo que engancha los ítems sin ID: se
                        // prefilla con el título exacto y no hay que tocarlo.
                        label: u.title ?? '',
                        cost: '',
                        costCurrency: 'ARS',
                      })
                    }
                  >
                    Mapear
                  </button>
                ),
              },
            ]}
          />
        </div>
      )}

      <div className="mt-4 border-t border-border-subtle pt-4">
        <p className="mb-3 text-sm font-semibold text-neutral-200">
          Mapear producto <span className="font-normal text-neutral-500">— `*` como tienda = cualquier tienda</span>
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Tienda
            <input className={inputCls} value={productForm.shopDomain} onChange={(e) => setProductForm({ ...productForm, shopDomain: e.target.value })} placeholder="*" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Product ID
            <input className={inputCls} value={productForm.productId} onChange={(e) => setProductForm({ ...productForm, productId: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Funnel
            <select className={inputCls} value={productForm.funnelId} onChange={(e) => setProductForm({ ...productForm, funnelId: Number(e.target.value) })}>
              {funnels.map((f) => (
                <option key={f.id} value={f.id} className="bg-surface">{f.name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Tier
            <select className={inputCls} value={productForm.tier} onChange={(e) => setProductForm({ ...productForm, tier: e.target.value })}>
              {TIERS.map((t) => (
                <option key={t} value={t} className="bg-surface">{t}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Label (opcional)
            <input className={inputCls} value={productForm.label} onChange={(e) => setProductForm({ ...productForm, label: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Costo unitario
            <input
              className={inputCls}
              inputMode="decimal"
              placeholder="0"
              value={productForm.cost}
              onChange={(e) => setProductForm({ ...productForm, cost: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Moneda del costo
            <input
              className={inputCls}
              maxLength={3}
              value={productForm.costCurrency}
              onChange={(e) => setProductForm({ ...productForm, costCurrency: e.target.value.toUpperCase() })}
            />
          </label>
        </div>
        <p className="mt-2 text-xs text-neutral-500">
          El costo se multiplica por la cantidad de cada ítem, así que una compra de front + bump
          suma los dos. Se descuenta del neto y se congela en cada venta: cambiarlo acá no
          reescribe lo ya vendido, para eso está{' '}
          <code className="rounded bg-overlay/10 px-1">npm run commissions:backfill</code>. Un costo
          en otra moneda que la venta se saltea, no se convierte.
        </p>
        <button type="button" className={`${btnPrimary} mt-3`} onClick={saveProduct} disabled={!productForm.productId}>
          Guardar y recalcular ventas
        </button>
      </div>
    </Card>
  );
}
