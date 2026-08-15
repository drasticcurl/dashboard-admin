'use client';

/**
 * celdas.tsx (task 19.2 de gestion-campanas-anuncios): los controles que
 * ESCRIBEN desde una celda de la tabla, movidos desde AnunciosView.tsx SIN
 * cambiar su comportamiento (D-A19):
 *   - `ToggleEstado`: optimista con reversión si el POST falla, y SIN
 *     Dialogo_Confirmacion (R14 c11): el toggle de una fila es reversible con
 *     un click y ya funciona así.
 *   - `PresupuestoCelda`: la edición de presupuesto de una fila, que sigue
 *     abriendo confirmación.
 *   - `RatioTone`: el formato con tono de los cocientes.
 *
 * `AnunciosView.tsx` los importa de acá y se elimina en la task 20.4; la
 * `Tabla_Anuncios` (TablaAds.tsx) los reusa.
 */

import type { MetricasObjeto } from '@/lib/ads/tipos';
import { Badge, fmtMoney } from '@/components/ui';

// Estados que Meta muestra pero que no se pueden escribir: no son toggleables.
const NO_TOGGLEABLE = new Set(['ARCHIVED', 'DELETED', 'DISAPPROVED', 'WITH_ISSUES', 'PENDING_REVIEW', 'IN_PROCESS']);

/** El estado efectivo en castellano, para el badge que acompaña al nombre. */
export function etiquetaEffective(s: string): string {
  const map: Record<string, string> = {
    CAMPAIGN_PAUSED: 'campaña pausada',
    ADSET_PAUSED: 'conjunto pausado',
    WITH_ISSUES: 'con problemas',
    DISAPPROVED: 'rechazado',
    PENDING_REVIEW: 'en revisión',
    IN_PROCESS: 'procesando',
    PENDING_BILLING_INFO: 'sin facturación',
  };
  return map[s] ?? s;
}

function money(n: number): string {
  return fmtMoney(n, 'EUR');
}

export function RatioTone({ v, umbral }: { v: number | null; umbral: number }): JSX.Element {
  if (v === null) return <span className="text-neutral-600">—</span>;
  const ratio = v.toFixed(2);
  const tone = v < umbral ? 'text-rose-400' : v < umbral + 1 ? 'text-amber-400' : 'text-good-400';
  return <span className={tone}>{ratio}</span>;
}

export function ToggleEstado({
  fila,
  onToggle,
}: {
  fila: MetricasObjeto;
  onToggle: (f: MetricasObjeto) => void;
}): JSX.Element {
  const noToggleable = NO_TOGGLEABLE.has(fila.status ?? '') || NO_TOGGLEABLE.has(fila.effectiveStatus ?? '');
  if (noToggleable) {
    return <Badge tone="warn">{fila.effectiveStatus ?? fila.status ?? '?'}</Badge>;
  }
  const activo = fila.status === 'ACTIVE';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={activo}
      aria-label={`${fila.objectName ?? fila.objectId}: ${activo ? 'pausar' : 'activar'}`}
      onClick={() => onToggle(fila)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-good-500/50 ${
        activo ? 'bg-good-500' : 'bg-overlay/12'
      }`}
      title={activo ? 'Pausar' : 'Activar'}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          activo ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

export function PresupuestoCelda({
  fila,
  edit,
  onEdit,
  onConfirm,
}: {
  fila: MetricasObjeto;
  edit: string | undefined;
  onEdit: (v: string) => void;
  onConfirm: (eur: number) => void;
}): JSX.Element {
  const editable = fila.budgetLevel === fila.level && fila.budgetMode === 'daily';

  if (fila.level === 'ad') return <span className="text-neutral-600">—</span>;

  if (!editable) {
    const motivo =
      fila.budgetMode === 'lifetime'
        ? 'presupuesto total: este panel sólo edita presupuestos diarios'
        : fila.budgetLevel !== fila.level
          ? 'el presupuesto se maneja en la campaña'
          : 'no editable';
    return (
      <span className="text-neutral-500" title={motivo}>
        {fila.dailyBudgetEur === null ? '—' : money(fila.dailyBudgetEur)}
      </span>
    );
  }

  if (edit === undefined) {
    return (
      <button
        type="button"
        onClick={() => onEdit(fila.dailyBudgetEur !== null ? String(fila.dailyBudgetEur) : '')}
        className="rounded px-1 text-neutral-200 underline decoration-dotted underline-offset-2 hover:text-neutral-50 focus:outline-none focus:ring-2 focus:ring-good-500/50"
        title="Editar presupuesto"
      >
        {fila.dailyBudgetEur === null ? '—' : money(fila.dailyBudgetEur)}
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="number"
        min={0}
        step={0.01}
        value={edit}
        autoFocus
        onChange={(e) => onEdit(e.target.value)}
        onBlur={() => {
          const n = Number(edit);
          if (Number.isFinite(n) && n > 0) onConfirm(n);
          else onEdit(''); // descarta
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const n = Number(edit);
            if (Number.isFinite(n) && n > 0) onConfirm(n);
          }
          if (e.key === 'Escape') onEdit('');
        }}
        className="w-24 rounded border border-border-strong bg-overlay/4 px-1 py-0.5 text-right text-sm text-neutral-100 focus:outline-none focus:ring-2 focus:ring-good-500/50"
        aria-label="Presupuesto en euros"
      />
    </span>
  );
}
