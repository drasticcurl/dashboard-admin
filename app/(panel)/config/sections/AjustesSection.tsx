'use client';

/**
 * AjustesSection — los tres settings de la UI (T07 §3).
 *
 * Cambiar fx_source afecta las conversiones de ventas NUEVAS: las viejas ya
 * tienen su cotización congelada en la fila (D12).
 */

import type { PanelSettings } from '@/app/api/config/_lib';
import { Card } from '@/components/ui';
import { btnPrimary, inputCls, type ConfigShell } from '../kit';
import { MONEDA_REPORTE } from '@/lib/moneda-reporte';

export function AjustesSection({
  settings,
  setSettings,
  shell,
}: {
  settings: PanelSettings;
  setSettings: (s: PanelSettings) => void;
  shell: ConfigShell;
}): JSX.Element {
  const { api, show, busy, setBusy } = shell;

  async function saveSettings() {
    setBusy(true);
    try {
      const res = await api<{ settings: PanelSettings }>('/api/config/settings', {
        method: 'PATCH',
        body: JSON.stringify(settings),
      });
      setSettings(res.settings);
      show('good', 'Ajustes guardados');
    } catch (err) {
      show('bad', err instanceof Error ? err.message : 'Error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Ajustes" hint="settings (plan §3.10)">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Fuente de cotización
          <select className={inputCls} value={settings.fxSource} onChange={(e) => setSettings({ ...settings, fxSource: e.target.value as 'oficial' | 'blue' })}>
            <option value="oficial" className="bg-surface">Oficial (default del plan, P-01)</option>
            <option value="blue" className="bg-surface">Blue</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Moneda por defecto en Ventas
          <select className={inputCls} value={settings.defaultCurrencyView} onChange={(e) => setSettings({ ...settings, defaultCurrencyView: e.target.value })}>
            <option value={MONEDA_REPORTE} className="bg-surface">{MONEDA_REPORTE}</option>
            <option value="ARS" className="bg-surface">ARS</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-neutral-500">
          Retención de eventos (días)
          <input type="number" min={1} className={inputCls} value={settings.retentionDaysEvents} onChange={(e) => setSettings({ ...settings, retentionDaysEvents: Number(e.target.value) })} />
        </label>
      </div>
      <p className="mt-3 text-xs text-neutral-500">
        Cambiar fx_source afecta las conversiones de ventas <strong>nuevas</strong>: las viejas ya
        tienen su cotización congelada en la fila (D12).
      </p>
      <button type="button" className={`${btnPrimary} mt-3`} onClick={saveSettings}>Guardar ajustes</button>
    </Card>
  );
}
