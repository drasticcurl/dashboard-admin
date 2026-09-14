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
import { Badge, Banner, Card, Table, fmtDateTime, fmtInt, fmtMoney } from '@/components/ui';
import { MONEDA_REPORTE } from '@/lib/moneda-reporte';
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

type Campania = {
  campaignId: string;
  campaignName: string | null;
  status: string | null;
  effectiveStatus: string | null;
  desaparecidoAt: string | null;
  funnelId: number | null;
  funnelName: string | null;
  nota: string | null;
  funnelEfectivoId: number | null;
  funnelEfectivoName: string | null;
  spendEur: number;
  ultimoDia: string | null;
  ventasPorFunnel: Array<{ funnelId: number | null; funnelName: string; ventas: number }>;
};
type CampaniasPayload = {
  accountId: string;
  cuentaFunnelId: number | null;
  cuentaFunnelName: string | null;
  dias: number;
  campanias: Campania[];
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
  // Qué cuenta tiene el panel de campañas abierto. Se pide al abrirlo y no con
  // la sección: son 270 campañas en la cuenta grande y no hacen falta para
  // mirar las cuentas.
  const [abierta, setAbierta] = useState<string | null>(null);
  const [camps, setCamps] = useState<CampaniasPayload | null>(null);
  const [filtro, setFiltro] = useState('');

  useEffect(() => {
    api<AdsPayload>('/api/config/ads')
      .then(setAds)
      .catch(() => setAds({ accounts: [], descubiertas: [], tokenError: 'no se pudo consultar' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function cargarCampanias(accountId: string, q = ''): Promise<void> {
    setCamps(null);
    const qs = q.trim() === '' ? '' : `&q=${encodeURIComponent(q.trim())}`;
    try {
      setCamps(await api<CampaniasPayload>(`/api/config/ads/campanas?accountId=${encodeURIComponent(accountId)}${qs}`));
    } catch (e) {
      show('bad', (e as Error).message);
      setAbierta(null);
    }
  }

  async function asignarCampania(accountId: string, campaignId: string, funnelId: number | null): Promise<void> {
    setBusy(true);
    try {
      const r = await api<{ reasignadas: number; rollup: { from: string; to: string } | null }>(
        '/api/config/ads/campanas',
        { method: 'POST', body: JSON.stringify({ accountId, campaignId, funnelId }) },
      );
      await cargarCampanias(accountId, filtro);
      setAds(await api<AdsPayload>('/api/config/ads'));
      show(
        'good',
        r.reasignadas > 0
          ? `Campaña guardada — ${r.reasignadas} filas de gasto reimputadas` +
              (r.rollup ? ` y el resumen recalculado del ${r.rollup.from} al ${r.rollup.to}` : '')
          : 'Campaña guardada — no había gasto para reimputar',
      );
    } catch (e) {
      show('bad', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

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
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      className={btnGhost}
                      onClick={() => {
                        const siguiente = abierta === a.accountId ? null : a.accountId;
                        setAbierta(siguiente);
                        setFiltro('');
                        if (siguiente) void cargarCampanias(siguiente);
                      }}
                    >
                      {abierta === a.accountId ? 'Ocultar campañas' : 'Campañas'}
                    </button>
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
                  </div>
                ) },
              ]}
            />
          </div>

          {abierta !== null && (
            <div className="mt-4 rounded-xl border border-border-subtle bg-overlay/2 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Campañas de {ads.accounts.find((a) => a.accountId === abierta)?.name ?? abierta}
                </p>
                <input
                  className={inputCls}
                  placeholder="Filtrar por nombre o id"
                  value={filtro}
                  onChange={(e) => setFiltro(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void cargarCampanias(abierta, filtro)}
                />
              </div>

              {/* Por qué esto existe, en una línea y en el lugar donde se usa. */}
              <p className="mt-2 text-xs text-neutral-500">
                Una cuenta puede servir a varios funnels. Lo que se elige acá es la{' '}
                <strong className="text-neutral-400">excepción</strong>: la campaña que no se toca
                hereda el funnel de la cuenta
                {camps?.cuentaFunnelName ? ` (${camps.cuentaFunnelName})` : ' (sin asignar)'}. Al
                guardar se reimputa el gasto ya registrado y se recalcula el resumen de esos días.
              </p>

              {camps === null ? (
                <p className="mt-3 text-xs text-neutral-500">Cargando campañas…</p>
              ) : (
                <div className="mt-3">
                  <Table
                    rows={camps.campanias}
                    empty="Esta cuenta no tiene campañas todavía (el sync de la jerarquía corre cada 15 minutos)"
                    columns={[
                      {
                        key: 'name',
                        header: 'Campaña',
                        render: (c) => (
                          <span className="text-neutral-300">
                            {c.campaignName ?? c.campaignId}
                            {c.desaparecidoAt ? (
                              <Badge tone="neutral">ya no está en Meta</Badge>
                            ) : c.status && c.status !== 'ACTIVE' ? (
                              <span className="ml-2 text-neutral-500">{c.status.toLowerCase()}</span>
                            ) : null}
                          </span>
                        ),
                      },
                      {
                        key: 'spend',
                        header: `Gasto ${camps.dias}d`,
                        align: 'right',
                        render: (c) => (
                          <span className="tabular-nums text-neutral-300">
                            {c.spendEur > 0 ? fmtMoney(c.spendEur, MONEDA_REPORTE) : '—'}
                          </span>
                        ),
                      },
                      {
                        // El detector: de qué funnel son las ventas que se le
                        // atribuyeron por UTM. Si no coincide con la columna de
                        // al lado, el mapeo está mal — y se ve sin abrir SQL.
                        key: 'ventas',
                        header: `Ventas ${camps.dias}d`,
                        render: (c) =>
                          c.ventasPorFunnel.length === 0 ? (
                            <span className="text-neutral-600">—</span>
                          ) : (
                            <span className="flex flex-wrap gap-1">
                              {c.ventasPorFunnel.map((v) => (
                                <Badge
                                  key={`${c.campaignId}-${v.funnelId ?? 'sin'}`}
                                  tone={v.funnelId === c.funnelEfectivoId ? 'neutral' : 'warn'}
                                >
                                  {v.funnelName}: {fmtInt(v.ventas)}
                                </Badge>
                              ))}
                            </span>
                          ),
                      },
                      {
                        key: 'funnel',
                        header: 'Se imputa a',
                        render: (c) => (
                          <select
                            className={inputCls}
                            value={c.funnelId ?? ''}
                            disabled={busy}
                            onChange={(e) =>
                              asignarCampania(
                                camps.accountId,
                                c.campaignId,
                                e.target.value === '' ? null : Number(e.target.value),
                              )
                            }
                          >
                            <option value="">
                              — hereda: {camps.cuentaFunnelName ?? 'sin asignar'} —
                            </option>
                            {funnels.map((f) => (
                              <option key={f.id} value={f.id}>{f.name}</option>
                            ))}
                          </select>
                        ),
                      },
                    ]}
                  />
                </div>
              )}
            </div>
          )}

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
