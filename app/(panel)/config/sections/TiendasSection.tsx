'use client';

/**
 * TiendasSection — shop_map: el último recurso de resolución de funnel
 * cuando el cart attribute y el producto no alcanzan (T07 §3).
 */

import { useState } from 'react';
import type { Funnel } from '@/lib/funnels';
import type { ShopMapping } from '@/app/api/config/_lib';
import { Card, Table } from '@/components/ui';
import { btnGhost, btnPrimary, inputCls, type ConfigShell } from '../kit';

export function TiendasSection({
  funnel,
  funnels,
  shops,
  setShops,
  shell,
}: {
  funnel: Funnel;
  funnels: Funnel[];
  shops: ShopMapping[];
  setShops: (s: ShopMapping[]) => void;
  shell: ConfigShell;
}): JSX.Element {
  const { api, show, busy, setBusy } = shell;

  const [shopForm, setShopForm] = useState({ shopDomain: '', funnelId: funnel.id });

  async function saveShop() {
    setBusy(true);
    try {
      await api('/api/config/shops', { method: 'POST', body: JSON.stringify(shopForm) });
      const res = await api<{ shops: ShopMapping[] }>('/api/config/shops');
      setShops(res.shops);
      setShopForm({ shopDomain: '', funnelId: funnel.id });
      show('good', 'Tienda mapeada');
    } catch (err) {
      show('bad', err instanceof Error ? err.message : 'Error');
    } finally {
      setBusy(false);
    }
  }

  async function deleteShop(s: ShopMapping) {
    if (!window.confirm(`¿Borrar el mapa de "${s.shopDomain}"?`)) return;
    setBusy(true);
    try {
      await api(`/api/config/shops?shopDomain=${encodeURIComponent(s.shopDomain)}`, {
        method: 'DELETE',
      });
      const res = await api<{ shops: ShopMapping[] }>('/api/config/shops');
      setShops(res.shops);
      show('good', 'Mapa de tienda borrado');
    } catch (err) {
      show('bad', err instanceof Error ? err.message : 'Error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Tiendas → funnel"
      hint="shop_map: el último recurso de D10 cuando el cart attribute y el producto no alcanzan."
    >
      <Table
        rows={shops}
        empty="Sin mapas de tienda"
        columns={[
          { key: 'shop', header: 'Tienda', render: (s) => <code className="rounded bg-overlay/10 px-1 text-neutral-300">{s.shopDomain}</code> },
          { key: 'funnel', header: 'Funnel', render: (s) => <span className="text-neutral-300">{s.funnelName}</span> },
          {
            key: 'acciones',
            header: '',
            render: (s) => (
              <button type="button" className={btnGhost} onClick={() => deleteShop(s)}>
                Borrar
              </button>
            ),
          },
        ]}
      />
      <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-border-subtle pt-4">
        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Tienda
          <input className={inputCls} value={shopForm.shopDomain} onChange={(e) => setShopForm({ ...shopForm, shopDomain: e.target.value })} placeholder="mitienda.myshopify.com" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Funnel
          <select className={inputCls} value={shopForm.funnelId} onChange={(e) => setShopForm({ ...shopForm, funnelId: Number(e.target.value) })}>
            {funnels.map((f) => (
              <option key={f.id} value={f.id} className="bg-surface">{f.name}</option>
            ))}
          </select>
        </label>
        <button type="button" className={btnPrimary} onClick={saveShop} disabled={!shopForm.shopDomain}>
          Agregar
        </button>
      </div>
    </Card>
  );
}
