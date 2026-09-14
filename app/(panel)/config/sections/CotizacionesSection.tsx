'use client';

/**
 * CotizacionesSection — las cotizaciones que el panel usa para consolidar (T07 §3).
 *
 * La tabla guarda "1 unidad de base en quote" (0,0005682 para ARS→EUR), que es
 * ilegible para el peso; por eso se muestra también la inversa. Desde el
 * 2026-09-14 hay MÁS DE UN PAR: el cron archiva ARS→moneda de reporte y además
 * la paridad de cada moneda de venta que no sea el peso (USD→EUR, del funnel
 * LATAM). De ahí la columna "Par": sin ella, un 0,8622 se lee como si fuera un
 * rate del peso y parece un error de tres órdenes de magnitud.
 *
 * La carga manual es la vía de escape de D13 y pisa la del cron para ese día
 * (source=manual). Cubre sólo el par del peso: el endpoint escribe base='ARS'.
 */

import { useState } from 'react';
import type { FxRateRow } from '@/app/api/config/_lib';
import { Badge, Card, Table, fmtDateTime, fmtInt } from '@/components/ui';
import { btnPrimary, inputCls, type ConfigShell } from '../kit';
import { MONEDA_REPORTE } from '@/lib/moneda-reporte';

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
      hint={`El cron archiva un par por moneda de venta: ARS→${MONEDA_REPORTE} con dolarapi, y la paridad directa de las demás (el funnel LATAM vende en USD). La carga manual es la vía de escape de D13 y sólo cubre el par del peso.`}
    >
      <Table
        rows={fx}
        empty="Todavía no hay cotizaciones (corré scripts/fetch-fx.ts o cargá una a mano)"
        columns={[
          { key: 'day', header: 'Día', render: (r) => <span className="tabular-nums text-neutral-300">{r.day}</span> },
          // La columna del par no es decorativa: sin ella, una fila USD→EUR se lee
          // como si fuera pesos por euro y 1,16 parece un error de mil veces.
          { key: 'par', header: 'Par', render: (r) => <span className="tabular-nums text-neutral-400">{r.base} → {r.quote}</span> },
          { key: 'rate', header: `1 unidad → ${MONEDA_REPORTE}`, align: 'right', render: (r) => <span className="tabular-nums text-neutral-200">{Number(r.rate).toFixed(r.base === 'ARS' ? 7 : 4)}</span> },
          { key: 'inversa', header: 'Inversa', align: 'right', render: (r) => (
            <span className="tabular-nums text-neutral-400">
              {r.base === 'ARS' ? fmtInt(Math.round(r.arsPerEuro)) : r.arsPerEuro.toFixed(4)} {r.base}
            </span>
          ) },
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
          Pesos por {MONEDA_REPORTE}
          <input type="number" step="0.01" className={inputCls} value={fxForm.arsPerEuro} onChange={(e) => setFxForm({ ...fxForm, arsPerEuro: e.target.value })} />
        </label>
        <button type="button" className={btnPrimary} onClick={saveFx} disabled={!fxForm.day || !fxForm.arsPerEuro}>
          Cargar cotización
        </button>
      </div>
    </Card>
  );
}
