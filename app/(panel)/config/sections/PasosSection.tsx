'use client';

/**
 * PasosSection — el catálogo de pasos del quiz de un funnel (T07 §3).
 *
 * Dos acciones de escritura: PATCH de un paso (con aviso de que cambiar el
 * índice reinterpreta el histórico) y el POST de "Importar pasos", que
 * reemplaza el catálogo en una transacción y PRESERVA counts_in_funnel
 * (bug de producción corregido en app/api/config/steps/route.ts).
 */

import { useState } from 'react';
import type { Funnel, FunnelStep } from '@/lib/funnels';
import type { UnknownStepWarning } from '@/app/api/config/_lib';
import { Banner, Card, Table, fmtInt } from '@/components/ui';
import { btnPrimary, inputCls, type ConfigShell } from '../kit';

const STEP_KIND_OPTIONS = ['landing', 'question', 'content', 'sales'];

export function PasosSection({
  funnel,
  steps,
  setSteps,
  unknownSteps,
  setUnknownSteps,
  shell,
}: {
  funnel: Funnel;
  steps: FunnelStep[];
  setSteps: (s: FunnelStep[]) => void;
  unknownSteps: UnknownStepWarning[];
  setUnknownSteps: (u: UnknownStepWarning[]) => void;
  shell: ConfigShell;
}): JSX.Element {
  const { api, show, busy, setBusy } = shell;

  const [stepDrafts, setStepDrafts] = useState<Record<number, FunnelStep>>({});
  const [importJson, setImportJson] = useState('');

  function stepDraft(s: FunnelStep): FunnelStep {
    return stepDrafts[s.stepIndex] ?? s;
  }

  async function saveStep(s: FunnelStep) {
    const d = stepDraft(s);
    setBusy(true);
    try {
      await api('/api/config/steps', {
        method: 'PATCH',
        body: JSON.stringify({
          funnelId: funnel.id,
          stepIndex: s.stepIndex,
          slug: d.slug,
          label: d.label,
          kind: d.kind,
          newStepIndex: d.stepIndex === s.stepIndex ? undefined : d.stepIndex,
        }),
      });
      const res = await api<{ steps: FunnelStep[]; unknownSteps: UnknownStepWarning[] }>(
        `/api/config/steps?funnelId=${funnel.id}`,
      );
      setSteps(res.steps);
      setUnknownSteps(res.unknownSteps);
      setStepDrafts((prev) => {
        const next = { ...prev };
        delete next[s.stepIndex];
        return next;
      });
      show('good', 'Paso actualizado');
    } catch (err) {
      show('bad', err instanceof Error ? err.message : 'Error');
    } finally {
      setBusy(false);
    }
  }

  async function importSteps() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(importJson);
    } catch {
      show('bad', 'El JSON no es válido');
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ count: number }>('/api/config/steps', {
        method: 'POST',
        body: JSON.stringify({ funnelId: funnel.id, steps: parsed }),
      });
      const stepsRes = await api<{ steps: FunnelStep[]; unknownSteps: UnknownStepWarning[] }>(
        `/api/config/steps?funnelId=${funnel.id}`,
      );
      setSteps(stepsRes.steps);
      setUnknownSteps(stepsRes.unknownSteps);
      setImportJson('');
      show('good', `${res.count} pasos importados — el "no cuenta en el embudo" de cada paso se conserva`);
    } catch (err) {
      show('bad', err instanceof Error ? err.message : 'Error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={`Pasos del quiz · ${funnel.name}`}
      hint="El histórico se mide por step_index, no por slug: cambiar un índice reinterpreta las sesiones viejas."
    >
      {unknownSteps.length > 0 && (
        <div className="mb-4">
          <Banner tone="warn" title="El ingest está viendo pasos que no están en el catálogo (últimos 7 días)">
            <ul className="mt-1 list-inside list-disc">
              {unknownSteps.map((u) => (
                <li key={u.detail}>
                  {u.detail} <span className="text-neutral-400">× {fmtInt(u.count)}</span>
                </li>
              ))}
            </ul>
          </Banner>
        </div>
      )}

      <Table
        rows={steps}
        empty="Este funnel no tiene pasos — importá el catálogo abajo"
        columns={[
          {
            key: 'idx',
            header: 'Índice',
            render: (s) => (
              <span className="flex flex-col gap-0.5">
                <input
                  type="number"
                  min={0}
                  className={`${inputCls} w-20`}
                  value={stepDraft(s).stepIndex}
                  onChange={(e) => setStepDrafts({ ...stepDrafts, [s.stepIndex]: { ...stepDraft(s), stepIndex: Number(e.target.value) } })}
                />
                <span className="text-[10px] leading-tight text-warn-400/90">
                  cambia el histórico
                </span>
              </span>
            ),
          },
          {
            key: 'slug',
            header: 'Slug',
            render: (s) => (
              <input
                className={inputCls}
                value={stepDraft(s).slug}
                onChange={(e) => setStepDrafts({ ...stepDrafts, [s.stepIndex]: { ...stepDraft(s), slug: e.target.value } })}
              />
            ),
          },
          {
            key: 'label',
            header: 'Label',
            render: (s) => (
              <input
                className={`${inputCls} w-48`}
                value={stepDraft(s).label}
                onChange={(e) => setStepDrafts({ ...stepDrafts, [s.stepIndex]: { ...stepDraft(s), label: e.target.value } })}
              />
            ),
          },
          {
            key: 'kind',
            header: 'Tipo',
            render: (s) => (
              <select
                className={inputCls}
                value={stepDraft(s).kind}
                onChange={(e) => setStepDrafts({ ...stepDrafts, [s.stepIndex]: { ...stepDraft(s), kind: e.target.value } })}
              >
                {STEP_KIND_OPTIONS.map((k) => (
                  <option key={k} value={k} className="bg-surface">{k}</option>
                ))}
              </select>
            ),
          },
          {
            key: 'acciones',
            header: '',
            render: (s) => (
              <button type="button" className={btnPrimary} onClick={() => saveStep(s)}>
                Guardar
              </button>
            ),
          },
        ]}
      />

      <div className="mt-4 border-t border-border-subtle pt-4">
        <p className="mb-1 text-sm font-semibold text-neutral-200">Importar pasos</p>
        <p className="mb-2 text-xs text-neutral-500">
          Pegá el catálogo completo como JSON y reemplaza el actual en una transacción — el camino
          cuando el quiz agrega preguntas.
        </p>
        <textarea
          className={`${inputCls} h-24 w-full font-mono text-xs`}
          placeholder='[{ "stepIndex": 0, "slug": "landing_hook", "label": "Landing", "kind": "landing" }]'
          value={importJson}
          onChange={(e) => setImportJson(e.target.value)}
        />
        <button type="button" className={`${btnPrimary} mt-2`} onClick={importSteps}>
          Reemplazar catálogo
        </button>
      </div>
    </Card>
  );
}
