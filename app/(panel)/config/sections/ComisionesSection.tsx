'use client';

/**
 * ComisionesSection — las reglas de comisión (T07 §3).
 *
 * Cada venta se lleva TODAS las comisiones activas que le corresponden
 * (globales + las de su funnel), los porcentajes siempre sobre el monto de
 * la venta, y el valor queda congelado en cada venta: editar acá no
 * reescribe el pasado.
 */

import { useState } from 'react';
import type { Funnel } from '@/lib/funnels';
import type { CommissionRule } from '@/lib/commissions';
import { Badge, Banner, Card, Table } from '@/components/ui';
import { btnGhost, btnPrimary, inputCls, type ConfigShell } from '../kit';

export function ComisionesSection({
  funnels,
  commissions,
  setCommissions,
  shell,
}: {
  funnels: Funnel[];
  commissions: CommissionRule[];
  setCommissions: (c: CommissionRule[]) => void;
  shell: ConfigShell;
}): JSX.Element {
  const { api, show, busy, setBusy } = shell;

  const [comForm, setComForm] = useState({
    name: '',
    scope: '' as string, // '' = global, o el slug del funnel
    kind: 'percent' as 'percent' | 'fixed',
    value: '',
    currency: 'ARS',
  });
  const [editCom, setEditCom] = useState<number | null>(null);

  async function refetchCommissions() {
    const { commissions: c } = await api<{ commissions: CommissionRule[] }>('/api/config/commissions');
    setCommissions(c);
  }

  async function saveCommission() {
    setBusy(true);
    try {
      const body = {
        name: comForm.name.trim(),
        // '' es global: la API espera null, no cadena vacía.
        funnelSlug: comForm.scope === '' ? null : comForm.scope,
        kind: comForm.kind,
        value: Number(comForm.value || 0),
        // Las porcentuales no llevan moneda; la API igual la fuerza a null.
        currency: comForm.kind === 'fixed' ? comForm.currency : null,
      };
      if (editCom === null) {
        await api('/api/config/commissions', { method: 'POST', body: JSON.stringify(body) });
      } else {
        await api('/api/config/commissions', {
          method: 'PATCH',
          body: JSON.stringify({ id: editCom, ...body }),
        });
      }
      await refetchCommissions();
      setEditCom(null);
      setComForm({ name: '', scope: '', kind: 'percent', value: '', currency: 'ARS' });
      show('good', 'Comisión guardada — no reescribe las ventas ya registradas');
    } catch (e) {
      show('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleCommission(c: CommissionRule) {
    setBusy(true);
    try {
      await api('/api/config/commissions', {
        method: 'PATCH',
        body: JSON.stringify({ id: c.id, active: !c.active }),
      });
      await refetchCommissions();
      show('good', c.active ? 'Comisión desactivada' : 'Comisión activada');
    } catch (e) {
      show('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteCommission(c: CommissionRule) {
    if (!confirm(`Borrar la comisión "${c.name}"? Las ventas ya registradas la conservan en su desglose.`)) return;
    setBusy(true);
    try {
      await api(`/api/config/commissions?id=${c.id}`, { method: 'DELETE' });
      await refetchCommissions();
      show('good', 'Comisión borrada');
    } catch (e) {
      show('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const funnelName = (id: number | null): string =>
    id === null ? 'Todos los funnels' : (funnels.find((f) => f.id === id)?.name ?? `#${id}`);

  return (
    <Card
      title="Comisiones"
      hint="Se descuentan del neto en Ventas y en el Resumen. Cada una es global o de un funnel, y porcentual o fija por venta."
    >
      <p className="mb-3 text-xs text-neutral-500">
        A cada venta se le aplican <strong className="text-neutral-400">todas</strong> las
        comisiones activas que le corresponden: las globales más las de su funnel. Los
        porcentajes se calculan siempre sobre el monto de la venta, no en cascada uno sobre el
        otro, así que el orden de las filas no cambia el resultado.
      </p>
      <Banner tone="info" title="Editar acá no reescribe el pasado">
        La comisión se congela en cada venta al registrarla, para que un reporte de un mes cerrado
        no se mueva solo. Para reexpresar ventas ya cobradas, corré{' '}
        <code className="rounded bg-overlay/10 px-1">npm run commissions:backfill -- --dry-run</code>{' '}
        y después sin <code className="rounded bg-overlay/10 px-1">--dry-run</code>.
      </Banner>

      <div className="mt-4">
        <Table
          rows={commissions}
          empty="Todavía no hay comisiones. Mientras no haya ninguna, el neto es igual al bruto menos devoluciones."
          columns={[
            { key: 'name', header: 'Nombre', render: (c) => (
              <span className={c.active ? 'text-neutral-200' : 'text-neutral-500 line-through'}>
                {c.name}
              </span>
            ) },
            { key: 'scope', header: 'Aplica a', render: (c) => (
              <Badge tone={c.funnelId === null ? 'info' : 'neutral'}>{funnelName(c.funnelId)}</Badge>
            ) },
            { key: 'kind', header: 'Tipo', render: (c) => (c.kind === 'percent' ? 'Porcentual' : 'Fija por venta') },
            { key: 'value', header: 'Valor', align: 'right', render: (c) => (
              <span className="tabular-nums">
                {c.kind === 'percent' ? `${c.value} %` : `${c.value} ${c.currency ?? ''}`}
              </span>
            ) },
            { key: 'active', header: 'Estado', render: (c) => (
              <Badge tone={c.active ? 'good' : 'neutral'}>{c.active ? 'Activa' : 'Inactiva'}</Badge>
            ) },
            { key: 'acciones', header: '', align: 'right', render: (c) => (
              <span className="flex justify-end gap-2">
                <button type="button" className={btnGhost} disabled={busy} onClick={() => {
                  setEditCom(c.id);
                  setComForm({
                    name: c.name,
                    scope: c.funnelId === null ? '' : (funnels.find((f) => f.id === c.funnelId)?.slug ?? ''),
                    kind: c.kind,
                    value: String(c.value),
                    currency: c.currency ?? 'ARS',
                  });
                }}>Editar</button>
                <button type="button" className={btnGhost} disabled={busy} onClick={() => toggleCommission(c)}>
                  {c.active ? 'Desactivar' : 'Activar'}
                </button>
                <button type="button" className={btnGhost} disabled={busy} onClick={() => deleteCommission(c)}>
                  Borrar
                </button>
              </span>
            ) },
          ]}
        />
      </div>

      <div className="mt-4 rounded-xl border border-border-subtle bg-overlay/2 p-4">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          {editCom === null ? 'Agregar comisión' : 'Editar comisión'}
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Nombre
            <input
              className={inputCls}
              placeholder="Mercado Pago"
              value={comForm.name}
              onChange={(e) => setComForm({ ...comForm, name: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Aplica a
            <select
              className={inputCls}
              value={comForm.scope}
              onChange={(e) => setComForm({ ...comForm, scope: e.target.value })}
            >
              <option value="">Todos los funnels (global)</option>
              {funnels.map((f) => (
                <option key={f.slug} value={f.slug}>{f.name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            Tipo
            <select
              className={inputCls}
              value={comForm.kind}
              onChange={(e) => setComForm({ ...comForm, kind: e.target.value as 'percent' | 'fixed' })}
            >
              <option value="percent">Porcentual (%)</option>
              <option value="fixed">Fija por venta</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">
            {comForm.kind === 'percent' ? 'Porcentaje' : 'Monto por venta'}
            <input
              className={inputCls}
              inputMode="decimal"
              placeholder={comForm.kind === 'percent' ? '5' : '100'}
              value={comForm.value}
              onChange={(e) => setComForm({ ...comForm, value: e.target.value })}
            />
          </label>
          {/* La moneda solo tiene sentido en las fijas: un 5 % no es "5 % de pesos". */}
          {comForm.kind === 'fixed' ? (
            <label className="flex flex-col gap-1 text-xs text-neutral-500">
              Moneda
              <input
                className={inputCls}
                maxLength={3}
                value={comForm.currency}
                onChange={(e) => setComForm({ ...comForm, currency: e.target.value.toUpperCase() })}
              />
            </label>
          ) : (
            <p className="self-end text-xs text-neutral-600">
              Se calcula sobre el monto de cada venta.
            </p>
          )}
        </div>
        <div className="mt-3 flex gap-2">
          <button type="button" className={btnPrimary} disabled={busy} onClick={saveCommission}>
            {editCom === null ? 'Agregar' : 'Guardar cambios'}
          </button>
          {editCom !== null && (
            <button type="button" className={btnGhost} disabled={busy} onClick={() => {
              setEditCom(null);
              setComForm({ name: '', scope: '', kind: 'percent', value: '', currency: 'ARS' });
            }}>Cancelar</button>
          )}
        </div>
        {comForm.kind === 'fixed' && (
          <p className="mt-2 text-xs text-neutral-500">
            Una comisión fija solo se aplica a las ventas en su misma moneda. Si no coincide, se
            saltea y queda avisado en el backfill — no se convierte, porque convertir metería la
            cotización del día en un número que cargaste como fijo.
          </p>
        )}
      </div>
    </Card>
  );
}
