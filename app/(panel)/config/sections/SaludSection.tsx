'use client';

/**
 * SaludSection — la última señal de cada pieza de la cadena (T07 §3).
 *
 * Sólo lectura: los dos selects filtran las tablas de diagnóstico y
 * refetchean solos. Sin esto, diagnosticar obliga a entrar por SSH.
 */

import { useEffect, useState } from 'react';
import type {
  IngestErrorRow,
  SystemStatus,
  WebhookEventRow,
} from '@/app/api/config/_lib';
import { Badge, Card, StatCard, Table, fmtDateTime, fmtInt } from '@/components/ui';
import { inputCls, type ConfigShell } from '../kit';

const STATUS_TONE: Record<string, 'neutral' | 'good' | 'warn' | 'bad' | 'info'> = {
  ok: 'good',
  duplicate: 'info',
  bad_signature: 'bad',
  unmatched_funnel: 'warn',
  error: 'bad',
  ignored: 'neutral',
};

export function SaludSection({
  initialSystem,
  shell,
}: {
  initialSystem: SystemStatus;
  shell: ConfigShell;
}): JSX.Element {
  const { api } = shell;

  const [system, setSystem] = useState<SystemStatus>(initialSystem);
  const [wstatus, setWstatus] = useState('');
  const [reason, setReason] = useState('');

  async function refreshSystem() {
    const qs = new URLSearchParams();
    if (wstatus) qs.set('wstatus', wstatus);
    if (reason) qs.set('reason', reason);
    const res = await api<SystemStatus>(`/api/config/system?${qs.toString()}`);
    setSystem(res);
  }

  // Los filtros de las tablas de diagnóstico refetchean solos: cambiar el
  // select dispara la consulta con el nuevo filtro.
  useEffect(() => {
    void refreshSystem();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wstatus, reason]);

  return (
    <Card title="Salud del sistema" hint="La última señal de cada pieza de la cadena. Sin esto, diagnosticar obliga a entrar por SSH.">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Última sesión por funnel"
          value={system.lastSessions.length > 0 ? system.lastSessions.map((s) => `${s.slug} · ${s.lastSeenAt ? fmtDateTime(s.lastSeenAt) : '—'}`).join(' | ') : '—'}
        />
        <StatCard label="Último rollup" value={system.lastRollupAt ? fmtDateTime(system.lastRollupAt) : '—'} sub="daily_metrics" />
        <StatCard
          label="Última cotización"
          value={system.lastFx ? `${fmtInt(Math.round(system.lastFx.arsPerEuro))} $/€` : '—'}
          sub={system.lastFx ? `${system.lastFx.day} · ${system.lastFx.source}` : undefined}
        />
        <StatCard label="Particiones de events" value={fmtInt(system.partitions)} sub="incluye events_default" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold text-neutral-200">Webhooks</p>
            <select className={`${inputCls} w-40`} value={wstatus} onChange={(e) => { setWstatus(e.target.value); }}>
              <option value="" className="bg-surface">Todos los estados</option>
              {['ok', 'duplicate', 'bad_signature', 'unmatched_funnel', 'error', 'ignored'].map((s) => (
                <option key={s} value={s} className="bg-surface">{s}</option>
              ))}
            </select>
          </div>
          <WebhooksTable rows={system.webhookEvents} />
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-semibold text-neutral-200">Errores de ingesta</p>
            <select className={`${inputCls} w-40`} value={reason} onChange={(e) => { setReason(e.target.value); }}>
              <option value="" className="bg-surface">Todas las razones</option>
              {['unknown_step', 'step_slug_mismatch', 'invalid_payload', 'unauthorized', 'unknown_event'].map((r) => (
                <option key={r} value={r} className="bg-surface">{r}</option>
              ))}
            </select>
          </div>
          <IngestErrorsTable rows={system.ingestErrors} />
        </div>
      </div>
    </Card>
  );
}

function WebhooksTable({ rows }: { rows: WebhookEventRow[] }): JSX.Element {
  return (
    <Table
      rows={rows}
      empty="Sin eventos de webhook"
      columns={[
        {
          key: 'when',
          header: 'Fecha',
          render: (r) => <span className="whitespace-nowrap text-neutral-400">{fmtDateTime(r.receivedAt)}</span>,
        },
        { key: 'topic', header: 'Topic', render: (r) => <span className="text-neutral-300">{r.topic ?? '—'}</span> },
        {
          key: 'ext',
          header: 'Orden',
          render: (r) => <code className="text-neutral-400">{r.externalId ?? '—'}</code>,
        },
        { key: 'status', header: 'Status', render: (r) => <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status}</Badge> },
      ]}
    />
  );
}

function IngestErrorsTable({ rows }: { rows: IngestErrorRow[] }): JSX.Element {
  return (
    <Table
      rows={rows}
      empty="Sin errores de ingesta"
      columns={[
        {
          key: 'when',
          header: 'Fecha',
          render: (r) => <span className="whitespace-nowrap text-neutral-400">{fmtDateTime(r.receivedAt)}</span>,
        },
        { key: 'reason', header: 'Razón', render: (r) => <Badge tone={r.reason === 'unauthorized' ? 'bad' : 'warn'}>{r.reason}</Badge> },
        { key: 'detail', header: 'Detalle', render: (r) => <span className="block max-w-56 truncate text-neutral-400" title={r.detail ?? undefined}>{r.detail ?? '—'}</span> },
      ]}
    />
  );
}
