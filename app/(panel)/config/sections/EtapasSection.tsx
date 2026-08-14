'use client';

/**
 * EtapasSection — el editor de etapas del embudo por funnel (T07 §4).
 *
 * Es lo que hace configurable lo que dibuja T04: una lista ordenada de
 * fronteras (paso o hito) que se guarda entera contra
 * /api/config/stages. Agregar, renombrar, reordenar y borrar son ediciones
 * de la lista local; el POST valida en el server y devuelve 400 con motivo
 * en castellano.
 *
 * Las dos decisiones que el usuario delegó (D-R08 / P-R03) se revierten acá:
 * separar `viral_news` de Preguntas es agregar una etapa que arranque en
 * `nombre`; separar `loading_steps` de Diagnóstico es agregar otra más.
 */

import { useState } from 'react';
import type { Funnel, FunnelStep } from '@/lib/funnels';
import type { FunnelStageRow } from '@/lib/queries/funnel';
import { ArrowDown, ArrowUp, Plus, Trash } from '@phosphor-icons/react';
import { Banner, Card, IconButton } from '@/components/ui';
import type { EtapaGuardada } from '@/app/api/config/stages/_etapas';
import { btnPrimary, inputCls, type ConfigShell } from '../kit';

const MILESTONES = [
  { value: 'sales_view', label: 'Vio la venta' },
  { value: 'checkout_click', label: 'Clickeó comprar' },
  { value: 'purchase', label: 'Compró' },
] as const;

type DraftEtapa = { key: string; label: string; fuente: string };

function uuid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `f-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function deFila(e: FunnelStageRow): DraftEtapa {
  return {
    key: uuid(),
    label: e.label,
    fuente: e.startsAtSlug ? `paso:${e.startsAtSlug}` : `hito:${e.milestone ?? ''}`,
  };
}

/** La validación client-side de lo mismo que rechaza el server: el usuario
 * no tiene que descubrir el 400 pegándole al POST. */
function problema(filas: DraftEtapa[]): string | null {
  if (filas.length === 0) return 'El embudo necesita al menos una etapa.';
  const vistos = new Set<string>();
  for (let i = 0; i < filas.length; i++) {
    const f = filas[i]!;
    if (!f.label.trim()) return `La etapa ${i + 1} no tiene nombre.`;
    if (!f.fuente) return `La etapa ${i + 1} («${f.label.trim()}») no tiene fuente: elegí un paso o un hito.`;
    if (vistos.has(f.fuente)) return `La fuente de la etapa ${i + 1} ya la usa otra etapa.`;
    vistos.add(f.fuente);
  }
  return null;
}

export function EtapasSection({
  funnel,
  steps,
  stages,
  setStages,
  shell,
}: {
  funnel: Funnel;
  steps: FunnelStep[];
  stages: FunnelStageRow[];
  setStages: (s: FunnelStageRow[]) => void;
  shell: ConfigShell;
}): JSX.Element {
  const { api, show, busy, setBusy } = shell;

  const [filas, setFilas] = useState<DraftEtapa[]>(stages.map(deFila));
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState<boolean>(false);

  function setFila(i: number, p: Partial<DraftEtapa>) {
    setFilas((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...p } : f)));
    setError(null);
  }

  function agregar() {
    setFilas((prev) => [...prev, { key: uuid(), label: '', fuente: '' }]);
    setError(null);
  }

  function borrar(i: number) {
    setFilas((prev) => prev.filter((_, idx) => idx !== i));
    setError(null);
  }

  function mover(i: number, dir: -1 | 1) {
    setFilas((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
    setError(null);
  }

  async function guardar() {
    const prob = problema(filas);
    if (prob) {
      setError(prob);
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ ok: boolean; stages: EtapaGuardada[] }>('/api/config/stages', {
        method: 'POST',
        body: JSON.stringify({
          funnelId: funnel.id,
          stages: filas.map((f, i) => ({
            stageOrder: i,
            label: f.label.trim(),
            startsAtSlug: f.fuente.startsWith('paso:') ? f.fuente.slice(5) : null,
            milestone: f.fuente.startsWith('hito:') ? f.fuente.slice(5) : null,
          })),
        }),
      });
      setStages(
        res.stages.map((s) => ({
          stageOrder: s.stageOrder,
          label: s.label,
          startsAtSlug: s.startsAtSlug,
          milestone: s.milestone as FunnelStageRow['milestone'],
        })),
      );
      setFilas(res.stages.map((s) => deFila(s as FunnelStageRow)));
      setGuardado(true);
      show('good', 'Etapas guardadas — el Embudo se recalcula con la lista nueva');
    } catch (err) {
      show('bad', err instanceof Error ? err.message : 'Error');
    } finally {
      setBusy(false);
    }
  }

  const pasos = [...steps].sort((a, b) => a.stepIndex - b.stepIndex);

  return (
    <Card
      title={`Etapas del embudo · ${funnel.name}`}
      hint="Cada etapa arranca en un paso del quiz (o en un hito) y llega hasta donde arranca la siguiente. El conteo es el de su ÚLTIMO paso."
    >
      <Banner tone="info" title="Las dos decisiones que quedaron por vos (D-R08)">
        El seed dejó <code className="rounded bg-overlay/10 px-1">viral_news</code> («Nota viral»)
        dentro de Preguntas y <code className="rounded bg-overlay/10 px-1">loading_steps</code>{' '}
        («Armando el plan») dentro de Diagnóstico. Para separarlos: agregá una etapa que arranque en{' '}
        <code className="rounded bg-overlay/10 px-1">nombre</code> (separa viral_news) y otra en{' '}
        <code className="rounded bg-overlay/10 px-1">loading_steps</code> (separa la pantalla de
        carga). Es la única decisión de este rediseño que cambia lo que vas a mirar todos los días:
        mirá /embudo después de guardar.
      </Banner>

      {error && (
        <Banner tone="bad" title="Revisá antes de guardar">
          {error}
        </Banner>
      )}

      <div className="mt-4 space-y-2">
        {filas.map((f, i) => (
          <div
            key={f.key}
            className="flex flex-wrap items-center gap-2 rounded-xl border border-border-subtle bg-overlay/2 p-2"
          >
            <span className="w-8 text-right font-mono text-xs tabular-nums text-neutral-500">
              {i}
            </span>
            <input
              className={`${inputCls} w-44`}
              value={f.label}
              placeholder="Nombre de la etapa"
              onChange={(e) => setFila(i, { label: e.target.value })}
              aria-label={`Nombre de la etapa ${i}`}
            />
            <select
              className={inputCls}
              value={f.fuente}
              onChange={(e) => setFila(i, { fuente: e.target.value })}
              aria-label={`Fuente de la etapa ${i}`}
            >
              <option value="" className="bg-surface">— elegir fuente —</option>
              <optgroup label="Pasos del quiz" className="bg-surface">
                {pasos.map((p) => (
                  <option key={p.slug} value={`paso:${p.slug}`} className="bg-surface">
                    {p.stepIndex} · {p.label} ({p.slug})
                  </option>
                ))}
              </optgroup>
              <optgroup label="Hitos" className="bg-surface">
                {MILESTONES.map((m) => (
                  <option key={m.value} value={`hito:${m.value}`} className="bg-surface">
                    {m.label} ({m.value})
                  </option>
                ))}
              </optgroup>
            </select>
            <span className="flex items-center gap-1">
              <IconButton label={`Subir la etapa ${i}`} onClick={() => mover(i, -1)} disabled={i === 0 || busy}>
                <ArrowUp size={14} weight="bold" />
              </IconButton>
              <IconButton label={`Bajar la etapa ${i}`} onClick={() => mover(i, 1)} disabled={i === filas.length - 1 || busy}>
                <ArrowDown size={14} weight="bold" />
              </IconButton>
              <IconButton label={`Borrar la etapa ${i}`} onClick={() => borrar(i)} tone="bad" disabled={busy}>
                <Trash size={14} weight="bold" />
              </IconButton>
            </span>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="flex items-center gap-1.5 border border-border-strong px-2.5 py-1.5 text-xs font-semibold text-neutral-300 transition-colors hover:bg-overlay/6 focus:outline-none focus:ring-2 focus:ring-good-500/50" onClick={agregar} disabled={busy}>
          <Plus size={14} weight="bold" /> Agregar etapa
        </button>
        <button type="button" className={btnPrimary} onClick={guardar} disabled={busy}>
          Guardar etapas
        </button>
        {guardado && <span className="text-xs text-neutral-500">Guardadas — mirá /embudo</span>}
      </div>
    </Card>
  );
}
