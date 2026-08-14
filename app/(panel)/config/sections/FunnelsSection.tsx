'use client';

/**
 * FunnelsSection — la sección Funnels de Config (T07 §3).
 *
 * Misma mecánica que el resto: muta contra /api/config/funnels y refetchea.
 * El slug no se edita (es la clave de los cart attributes y las ingest
 * keys); la key se regenera con confirmación y se muestra una sola vez.
 */

import { useState } from 'react';
import type { Funnel } from '@/lib/funnels';
import { Badge, Card, Table, fmtInt } from '@/components/ui';
import { btnGhost, btnPrimary, inputCls, type ConfigShell } from '../kit';

export function FunnelsSection({
  funnels,
  setFunnels,
  shell,
}: {
  funnels: Funnel[];
  setFunnels: (f: Funnel[]) => void;
  shell: ConfigShell;
}): JSX.Element {
  const { api, show, busy, setBusy } = shell;

  const [editFunnel, setEditFunnel] = useState<Funnel | null>(null);
  const [funnelForm, setFunnelForm] = useState({
    name: '',
    timezone: 'America/Argentina/Buenos_Aires',
    sellCurrency: 'ARS',
    color: '#8b5cf6',
    variants: 'default',
    active: true,
  });
  const [newFunnel, setNewFunnel] = useState({ slug: '', name: '', timezone: 'America/Argentina/Buenos_Aires', sellCurrency: 'ARS' });
  const [newKey, setNewKey] = useState<{ slug: string; key: string } | null>(null);

  async function saveFunnel() {
    setBusy(true);
    try {
      const res = await api<{
        diasRecalculados: { filas: number; from: string | null; to: string | null } | null;
      }>(`/api/config/funnels`, {
        method: 'PATCH',
        body: JSON.stringify({
          slug: editFunnel!.slug,
          name: funnelForm.name,
          timezone: funnelForm.timezone,
          sellCurrency: funnelForm.sellCurrency,
          color: funnelForm.color,
          variants: funnelForm.variants.split(',').map((v) => v.trim()).filter(Boolean),
          active: funnelForm.active,
        }),
      });
      const { funnels: f } = await api<{ funnels: Funnel[] }>('/api/config/funnels');
      setFunnels(f);
      setEditFunnel(null);
      // Cambiar la zona mueve ventas de día: decir solo "actualizado" dejaría al
      // usuario sin saber que los números que está mirando cambiaron.
      const dr = res.diasRecalculados;
      show(
        'good',
        dr && dr.filas > 0
          ? `Funnel actualizado — se recalculó el día de ${fmtInt(dr.filas)} filas (${dr.from} a ${dr.to}) y se reconstruyó el Resumen`
          : 'Funnel actualizado',
      );
    } catch (err) {
      show('bad', err instanceof Error ? err.message : 'Error');
    } finally {
      setBusy(false);
    }
  }

  async function createFunnel() {
    setBusy(true);
    try {
      await api('/api/config/funnels', { method: 'POST', body: JSON.stringify(newFunnel) });
      const { funnels: f } = await api<{ funnels: Funnel[] }>('/api/config/funnels');
      setFunnels(f);
      setNewFunnel({ slug: '', name: '', timezone: 'America/Argentina/Buenos_Aires', sellCurrency: 'ARS' });
      show('good', 'Funnel creado — cargale los pasos con "Importar pasos" y regenerá la ingest key');
    } catch (err) {
      show('bad', err instanceof Error ? err.message : 'Error');
    } finally {
      setBusy(false);
    }
  }

  async function regenerateKey(slug: string) {
    if (!window.confirm(`¿Regenerar la ingest key de "${slug}"? La key anterior deja de funcionar al instante.`)) return;
    setBusy(true);
    try {
      const res = await api<{ key: string }>('/api/config/funnels/ingest-key', {
        method: 'POST',
        body: JSON.stringify({ slug }),
      });
      setNewKey({ slug, key: res.key });
      show('good', 'Key regenerada — copiala ahora, no se vuelve a mostrar');
    } catch (err) {
      show('bad', err instanceof Error ? err.message : 'Error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Funnels"
      hint="El slug no se edita: es la clave que usan los cart attributes y las ingest keys."
    >
      <Table
        rows={funnels}
        empty="Sin funnels"
        columns={[
          { key: 'name', header: 'Nombre', render: (f) => <span className="font-medium text-neutral-100">{f.name}</span> },
          { key: 'slug', header: 'Slug', render: (f) => <code className="rounded bg-overlay/10 px-1 text-neutral-300">{f.slug}</code> },
          { key: 'tz', header: 'Zona horaria', render: (f) => <span className="text-neutral-300">{f.timezone}</span> },
          { key: 'cur', header: 'Moneda', render: (f) => <span className="text-neutral-300">{f.sellCurrency}</span> },
          { key: 'variants', header: 'Variants', render: (f) => <span className="text-neutral-400">{f.variants.join(', ')}</span> },
          {
            key: 'active',
            header: 'Activo',
            render: (f) => (f.active ? <Badge tone="good">sí</Badge> : <Badge tone="warn">no</Badge>),
          },
          {
            key: 'acciones',
            header: '',
            render: (f) => (
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  className={btnGhost}
                  onClick={() => {
                    setEditFunnel(f);
                    setFunnelForm({
                      name: f.name,
                      timezone: f.timezone,
                      sellCurrency: f.sellCurrency,
                      color: f.color,
                      variants: f.variants.join(','),
                      active: f.active,
                    });
                  }}
                >
                  Editar
                </button>
                <button type="button" className={btnGhost} onClick={() => regenerateKey(f.slug)}>
                  Regenerar key
                </button>
              </span>
            ),
          },
        ]}
      />

      {newKey && (
        <div className="mt-4 rounded-xl border border-warn-500/30 bg-warn-500/[0.06] p-4">
          <p className="text-sm font-semibold text-warn-200">
            Key nueva para {newKey.slug} — se muestra una sola vez
          </p>
          <code className="mt-2 block break-all rounded-lg bg-black/40 p-3 text-xs text-amber-100">
            {newKey.key}
          </code>
          <p className="mt-2 text-xs text-warn-200/80">
            Copiala al <code className="rounded bg-overlay/10 px-1">.env.production</code> del funnel
            (INGEST_KEY) y redesplegalo. No la vuelvas a pedir: regenerarla invalida esta.
          </p>
        </div>
      )}

      {editFunnel && (
        <div className="mt-4 space-y-3 rounded-xl border border-border-subtle bg-overlay/2 p-4">
          <p className="text-sm font-semibold text-neutral-200">Editando {editFunnel.slug}</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1 text-xs text-neutral-500">
              Nombre
              <input className={inputCls} value={funnelForm.name} onChange={(e) => setFunnelForm({ ...funnelForm, name: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-neutral-500">
              Zona horaria de la tienda
              <input className={inputCls} value={funnelForm.timezone} onChange={(e) => setFunnelForm({ ...funnelForm, timezone: e.target.value })} />
              <span className="text-[11px] leading-tight text-neutral-600">
                Corta el día de las ventas y del embudo. Al guardar se recalculan los días ya
                registrados. Si querés que cierre con Meta, poné acá la zona de la cuenta
                publicitaria (la ves en Publicidad, en la sección Fuentes).
              </span>
            </label>
            <label className="flex flex-col gap-1 text-xs text-neutral-500">
              Moneda
              <input className={inputCls} maxLength={3} value={funnelForm.sellCurrency} onChange={(e) => setFunnelForm({ ...funnelForm, sellCurrency: e.target.value.toUpperCase() })} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-neutral-500">
              Color
              <input className={inputCls} value={funnelForm.color} onChange={(e) => setFunnelForm({ ...funnelForm, color: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-neutral-500">
              Variants (coma)
              <input className={inputCls} value={funnelForm.variants} onChange={(e) => setFunnelForm({ ...funnelForm, variants: e.target.value })} />
            </label>
            <label className="flex items-center gap-2 text-xs text-neutral-400">
              <input type="checkbox" checked={funnelForm.active} onChange={(e) => setFunnelForm({ ...funnelForm, active: e.target.checked })} className="h-4 w-4 accent-good-500" />
              Activo
            </label>

          </div>
          <div className="flex gap-2">
            <button type="button" className={btnPrimary} onClick={saveFunnel}>Guardar</button>
            <button type="button" className={btnGhost} onClick={() => setEditFunnel(null)}>Cancelar</button>
          </div>
        </div>
      )}

      <div className="mt-4 border-t border-border-subtle pt-4">
        <p className="mb-3 text-sm font-semibold text-neutral-200">Alta de un funnel nuevo</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Slug (minúsculas, sin espacios)
            <input className={inputCls} value={newFunnel.slug} onChange={(e) => setNewFunnel({ ...newFunnel, slug: e.target.value.toLowerCase() })} placeholder="mi-funnel" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Nombre
            <input className={inputCls} value={newFunnel.name} onChange={(e) => setNewFunnel({ ...newFunnel, name: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Zona horaria
            <input className={inputCls} value={newFunnel.timezone} onChange={(e) => setNewFunnel({ ...newFunnel, timezone: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Moneda
            <input className={inputCls} maxLength={3} value={newFunnel.sellCurrency} onChange={(e) => setNewFunnel({ ...newFunnel, sellCurrency: e.target.value.toUpperCase() })} />
          </label>
        </div>
        <button type="button" className={`${btnPrimary} mt-3`} onClick={createFunnel}>Crear funnel</button>
      </div>
    </Card>
  );
}
