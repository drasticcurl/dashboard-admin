'use client';

/**
 * CotizacionesSection — pesos por euro (1/rate) (T07 §3).
 *
 * La tabla guarda 1 ARS en EUR, que es ilegible; acá se muestra 1/rate. La
 * carga manual es la vía de escape de D13 y pisa la del cron para ese día
 * (source=manual).
 */

import { useState } from 'react';
import type { FxRateRow } from '@/app/api/config/_lib';
import { Badge, Card, Table, fmtDateTime, fmtInt } from '@/components/ui';
import { btnPrimary, inputCls, type ConfigShell } from '../kit';

export function CotizacionesSection({
  fx,
  setFx,
  shell,
}: {
  fx: FxRateRow[];
  setFx: (f: FxRateRow[]) => void;
  shell: ConfigShell;
}): JSX.Element {
  const { api, show, busy, setBusy } = shell;

  const [fxForm, setFxForm] = useState({ day: '', arsPerEuro: '' });

  async function saveFx() {
    setBusy(true);
    try {
      await api('/api/config/fx', {
        method: 'POST',
        body: JSON.stringify({ day: fxForm.day, arsPerEuro: Number(fxForm.arsPerEuro) }),
      });
      const res = await api<{ rates: FxRateRow[] }>('/api/config/fx');
      setFx(res.rates);
      setFxForm({ day: '', arsPerEuro: '' });
      show('good', 'Cotización cargada — pisa la del cron para ese día (source=manual)');
    } catch (err) {
      show('bad', err instanceof Error ? err.message : 'Error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Cotizaciones"
      hint="Pesos por euro (1/rate): la tabla guarda 1 ARS en EUR, que es ilegible. La carga manual es la vía de escape de D13."
    >
      <Table
        rows={fx}
        empty="Todavía no hay cotizaciones (corré scripts/fetch-fx.ts o cargá una a mano)"
        columns={[
          { key: 'day', header: 'Día', render: (r) => <span className="tabular-nums text-neutral-300">{r.day}</span> },
          { key: 'ars', header: 'Pesos por euro', align: 'right', render: (r) => <span className="tabular-nums text-neutral-200">{fmtInt(Math.round(r.arsPerEuro))}</span> },
          { key: 'rate', header: '1 ARS → EUR', align: 'right', render: (r) => <span className="tabular-nums text-neutral-400">{Number(r.rate).toFixed(7)}</span> },
          { key: 'source', header: 'Fuente', render: (r) => <Badge tone={r.source === 'manual' ? 'info' : r.source === 'dolarapi' ? 'good' : 'neutral'}>{r.source}</Badge> },
          { key: 'fetched', header: 'Obtenida', render: (r) => <span className="text-neutral-400">{fmtDateTime(r.fetchedAt)}</span> },
        ]}
      />
      <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-border-subtle pt-4">
        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Día
          <input type="date" className={inputCls} value={fxForm.day} onChange={(e) => setFxForm({ ...fxForm, day: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Pesos por euro
          <input type="number" step="0.01" className={inputCls} value={fxForm.arsPerEuro} onChange={(e) => setFxForm({ ...fxForm, arsPerEuro: e.target.value })} placeholder="1728.65" />
        </label>
        <button type="button" className={btnPrimary} onClick={saveFx} disabled={!fxForm.day || !fxForm.arsPerEuro}>
          Cargar cotización
        </button>
      </div>
    </Card>
  );
}
