'use client';

/**
 * PublicidadSection — cuentas de Meta y su imputación a funnels (T07 §3).
 *
 * El descubrimiento le pega a la API de Meta, así que esta sección carga
 * sus datos al montarse y no en el server: no puede demorar el render de
 * toda la pantalla de configuración.
 */

import { useEffect, useState } from 'react';
import type { Funnel } from '@/lib/funnels';
import { Badge, Banner, Card, Table, fmtDateTime, fmtInt } from '@/components/ui';
import { btnGhost, inputCls, type ConfigShell } from '../kit';

type AdAccount = {
  accountId: string; name: string | null; currency: string | null;
  timezone: string | null;
  funnelId: number | null; funnelName: string | null; funnelTimezone: string | null;
  active: boolean;
  lastSyncAt: string | null; lastSyncError: string | null; spendRows: number;
};
type AdsPayload = {
  accounts: AdAccount[];
  descubiertas: Array<{
    accountId: string; name: string | null; currency: string | null; timezone: string | null;
  }>;
  tokenError: string | null;
};

export function PublicidadSection({
  funnels,
  shell,
}: {
  funnels: Funnel[];
  shell: ConfigShell;
}): JSX.Element {
  const { api, show, busy, setBusy } = shell;
  const [ads, setAds] = useState<AdsPayload | null>(null);

  useEffect(() => {
    api<AdsPayload>('/api/config/ads')
      .then(setAds)
      .catch(() => setAds({ accounts: [], descubiertas: [], tokenError: 'no se pudo consultar' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveAdAccount(accountId: string, funnelId: number | null, extra?: Partial<AdAccount>) {
    setBusy(true);
    try {
      const r = await api<{ reasignadas: number }>('/api/config/ads', {
        method: 'POST',
        body: JSON.stringify({
          accountId,
          funnelId,
          name: extra?.name ?? null,
          currency: extra?.currency ?? null,
          timezone: extra?.timezone ?? null,
          active: extra?.active,
        }),
      });
      setAds(await api<AdsPayload>('/api/config/ads'));
      show(
        'good',
        r.reasignadas > 0
          ? `Cuenta guardada — ${r.reasignadas} filas de gasto reimputadas`
          : 'Cuenta guardada',
      );
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
      title="Publicidad"
      hint="El gasto se lee de la Marketing API de Meta y se imputa al funnel de cada cuenta. Es un costo POR DÍA, así que no entra en el neto de cada venta: sale aparte como Ads y produce el Resultado."
    >
      {ads === null ? (
        <p className="text-xs text-neutral-500">Consultando Meta…</p>
      ) : (
        <>
          {ads.tokenError && (
            <Banner tone="warn" title="El token de Meta no puede leer cuentas">
              <span className="block">{ads.tokenError}</span>
              <span className="mt-2 block">
                Hace falta un token de <strong>usuario del sistema</strong> con permiso{' '}
                <code className="rounded bg-overlay/10 px-1">ads_read</code> en{' '}
                <code className="rounded bg-overlay/10 px-1">META_ADS_TOKEN</code>. Ojo: el token de
                CAPI no sirve — es para <em>mandar</em> eventos, no para leer gasto. Y además del
                permiso, el usuario del sistema tiene que tener la cuenta{' '}
                <strong>asignada</strong> (Analista o más): son dos cosas distintas.
              </span>
            </Banner>
          )}

          {/* Dos calendarios distintos comparados como uno: es la causa de que
              el panel y el administrador de anuncios muestren números que no
              cierran. Se explica una sola vez y con los valores concretos. */}
          {ads.accounts.some(
            (a) => a.timezone && a.funnelTimezone && a.timezone !== a.funnelTimezone,
          ) && (
            <Banner tone="warn" title="El gasto y las ventas están cortando el día en zonas distintas">
              <span className="block">
                Meta reporta el gasto por día en la zona de la <strong>cuenta publicitaria</strong>;
                las ventas y el embudo se cortan en la zona de la <strong>tienda</strong> del funnel.
                Mientras no coincidan, el ROAS de un día divide la facturación de un recorte por el
                gasto de otro.
              </span>
              <ul className="mt-2 list-inside list-disc">
                {ads.accounts
                  .filter((a) => a.timezone && a.funnelTimezone && a.timezone !== a.funnelTimezone)
                  .map((a) => (
                    <li key={a.accountId}>
                      <code className="rounded bg-overlay/10 px-1">{a.name ?? a.accountId}</code>{' '}
                      corta en {a.timezone}, y {a.funnelName} en {a.funnelTimezone}
                    </li>
                  ))}
              </ul>
              <span className="mt-2 block">
                Para que cierren, poné la misma zona en las dos puntas: la de la cuenta se cambia en
                el administrador de anuncios de Meta, y la de la tienda arriba, en{' '}
                <strong>Funnels → Zona horaria</strong>. Al guardar la de la tienda el panel
                recalcula los días ya registrados.
              </span>
            </Banner>
          )}

          <div className="mt-3">
            <Table
              rows={ads.accounts}
              empty="Todavía no hay cuentas. Las que el token pueda leer aparecen abajo para dar de alta en un click."
              columns={[
                { key: 'accountId', header: 'Cuenta', render: (a) => (
                  <span className="tabular-nums text-neutral-300">
                    {a.accountId}
                    {a.name ? <span className="ml-2 text-neutral-500">{a.name}</span> : null}
                  </span>
                ) },
                { key: 'currency', header: 'Moneda', render: (a) => a.currency ?? '—' },
                {
                  key: 'tz',
                  header: 'Zona (día del gasto)',
                  // Meta reporta los días en la zona de la CUENTA. Si no es la
                  // misma que la de la tienda, el gasto de un día y la
                  // facturación de ese día son recortes distintos, y el ROAS
                  // está dividiendo peras por manzanas. Se marca en ámbar en
                  // vez de dejarlo pasar callado.
                  render: (a) => {
                    if (!a.timezone) {
                      return <span className="text-neutral-500" title="Se completa en el próximo sync">— sin sincronizar</span>;
                    }
                    const alineada = a.funnelTimezone === null || a.timezone === a.funnelTimezone;
                    return (
                      <span className={alineada ? 'text-neutral-300' : 'text-warn-300'}
                            title={alineada ? undefined : `La tienda corta el día en ${a.funnelTimezone}: el gasto y las ventas no hablan del mismo día`}>
                        {a.timezone}
                        {alineada ? null : ' ≠ tienda'}
                      </span>
                    );
                  },
                },
                { key: 'funnel', header: 'Se imputa a', render: (a) => (
                  <select
                    className={inputCls}
                    value={a.funnelId ?? ''}
                    disabled={busy}
                    onChange={(e) =>
                      saveAdAccount(a.accountId, e.target.value === '' ? null : Number(e.target.value))
                    }
                  >
                    <option value="">— sin asignar —</option>
                    {funnels.map((f) => (
                      <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                  </select>
                ) },
                { key: 'spendRows', header: 'Filas', align: 'right', render: (a) => fmtInt(a.spendRows) },
                { key: 'sync', header: 'Último sync', render: (a) =>
                  a.lastSyncError ? (
                    <Badge tone="bad">{a.lastSyncError.slice(0, 40)}</Badge>
                  ) : a.lastSyncAt ? (
                    <span className="text-neutral-400">{fmtDateTime(a.lastSyncAt)}</span>
                  ) : (
                    <Badge tone="neutral">nunca</Badge>
                  ) },
                { key: 'acciones', header: '', align: 'right', render: (a) => (
                  <button
                    type="button"
                    className={btnGhost}
                    disabled={busy}
                    onClick={async () => {
                      if (!confirm(`Dar de baja ${a.accountId}? El gasto ya guardado NO se borra.`)) return;
                      setBusy(true);
                      try {
                        await api(`/api/config/ads?accountId=${encodeURIComponent(a.accountId)}`, { method: 'DELETE' });
                        setAds(await api<AdsPayload>('/api/config/ads'));
                        show('good', 'Cuenta dada de baja — el gasto histórico se conservó');
                      } catch (e) {
                        show('bad', (e as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Dar de baja
                  </button>
                ) },
              ]}
            />
          </div>

          {ads.descubiertas.length > 0 && (
            <div className="mt-4 rounded-xl border border-border-subtle bg-overlay/2 p-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Cuentas que ve el token y no están dadas de alta
              </p>
              <div className="space-y-2">
                {ads.descubiertas.map((d) => (
                  <div key={d.accountId} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="tabular-nums text-neutral-300">{d.accountId}</span>
                    <span className="text-neutral-500">{d.name}</span>
                    <Badge tone="neutral">{d.currency ?? '?'}</Badge>
                    {d.timezone ? <Badge tone="neutral">{d.timezone}</Badge> : null}
                    <select
                      className={inputCls}
                      defaultValue=""
                      disabled={busy}
                      onChange={(e) =>
                        e.target.value !== '' &&
                        saveAdAccount(d.accountId, Number(e.target.value), {
                          name: d.name,
                          currency: d.currency,
                          timezone: d.timezone,
                        })
                      }
                    >
                      <option value="">Dar de alta e imputar a…</option>
                      {funnels.map((f) => (
                        <option key={f.id} value={f.id}>{f.name}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="mt-4 text-xs text-neutral-500">
            El gasto lo trae{' '}
            <code className="rounded bg-overlay/10 px-1">npm run ads:sync</code> (cron cada hora,
            reprocesando hoy y ayer porque Meta ajusta el gasto del día en curso). Como los UTMs
            llevan el ID de Meta después del <code className="rounded bg-overlay/10 px-1">|</code>, el
            gasto se cruza con las ventas por ID exacto y la tabla de campañas de{' '}
            <strong className="text-neutral-400">Ventas</strong> muestra ROAS por campaña.
          </p>
        </>
      )}
    </Card>
  );
}
