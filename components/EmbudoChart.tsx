'use client';

/**
 * EmbudoChart — el embudo literal por etapas, HORIZONTAL (rediseño T04).
 *
 * Está dibujado en SVG a mano y no con recharts. `Funnel` de recharts sólo
 * apila verticalmente: no tiene orientación horizontal, ni forma de meter la
 * etiqueta debajo de cada tramo, ni de pintar cada tramo por severidad. Las
 * tres cosas son el pedido, así que un polígono por etapa sale más simple que
 * pelearle al componente. Sigue sin dependencias nuevas.
 *
 * Tres reglas que son el corazón:
 *
 *   - El ALTO de cada tramo es `anchoDibujo`, NO `sessions`: es ilustrativo y
 *     se recorta para que la figura siga angostándose cuando un hito supera al
 *     paso anterior (D-R09). El número que se escribe es siempre el real.
 *   - El COLOR es la severidad de la caída contra la etapa anterior, no la
 *     fuente del dato. Es lo que hace que se vea "dónde va mal" sin leer.
 *     Como el color ya no distingue paso de hito, el hito se marca con el
 *     borde punteado y con su etiqueta.
 *   - El porcentaje va DENTRO del tramo y el nombre DEBAJO, alineados en la
 *     misma grilla de columnas.
 */

import type { EmbudoEtapa } from '@/lib/widgets/tipos';
import { fmtInt, fmtPct } from '@/components/ui';
import { panelColors } from '@/tailwind.config';

const TITULO_INCONSISTENTE =
  'El número real supera al de la etapa anterior. Los pasos salen del histograma de max_step_index y los hitos de columnas propias (sales_view_at, checkout_click_at, purchased_at): son fuentes distintas y una sesión puede saltar. El alto se recorta para mantener la forma del embudo; el número es el real.';

/**
 * La severidad de la caída. Los cortes son de lectura, no estadísticos: en un
 * quiz de 22 pasos perder menos del 15% entre dos etapas es normal, y perder
 * más de 40% es donde hay que mirar.
 *
 * La primera etapa no tiene caída (es la base), así que va neutra: pintarla de
 * verde diría "acá vamos bien" sobre un número que es 100% por definición.
 */
type Severidad = 'base' | 'ok' | 'medio' | 'malo';

function severidad(e: EmbudoEtapa, esPrimera: boolean): Severidad {
  if (esPrimera) return 'base';
  if (e.dropFromPrevious >= 40) return 'malo';
  if (e.dropFromPrevious >= 15) return 'medio';
  return 'ok';
}

const RELLENO: Record<Severidad, string> = {
  base: '#3f3f46',
  ok: panelColors.good,
  medio: panelColors.warn,
  malo: panelColors.bad,
};

const LEYENDA: ReadonlyArray<{ sev: Severidad; texto: string }> = [
  { sev: 'base', texto: 'Base (100%)' },
  { sev: 'ok', texto: 'Cae menos de 15%' },
  { sev: 'medio', texto: 'Cae 15-40%' },
  { sev: 'malo', texto: 'Cae más de 40%' },
];

// Coordenadas del viewBox. El SVG escala solo con preserveAspectRatio=none en
// el eje X, así que estos números son proporciones, no píxeles.
const VB_W = 1000;
const VB_H = 200;
const MIN_ALTO_TEXTO = 34; // debajo de esto el % no entra adentro del tramo

export function EmbudoChart({ etapas }: { etapas: EmbudoEtapa[] }): JSX.Element | null {
  const n = etapas.length;
  if (n === 0) return null;

  const segW = VB_W / n;
  const hayInconsistente = etapas.some((e) => e.inconsistente);

  // El alto de cada frontera. La izquierda de cada tramo es su propio ancho y
  // la derecha es el de la etapa siguiente; el último tramo queda recto porque
  // no hay una etapa después que defina su borde.
  const altoDe = (i: number): number => (etapas[i]!.anchoDibujo / 100) * VB_H;

  const resumen = etapas
    .map((e) => `${e.label}: ${fmtInt(e.sessions)} (${fmtPct(e.pctOfBase)})`)
    .join(' · ');

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-neutral-500">
        {LEYENDA.map((l) => (
          <span key={l.sev} className="inline-flex items-center gap-1.5">
            <span
              className="h-2 w-2 rounded-sm"
              style={{ backgroundColor: RELLENO[l.sev] }}
              aria-hidden
            />
            {l.texto}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-2 w-3 rounded-sm border border-dashed border-neutral-400"
            aria-hidden
          />
          Hito (columna propia de sesiones)
        </span>
      </div>

      {/* El SVG y la fila de etiquetas comparten la misma grilla de N columnas,
          así que cada nombre cae exactamente debajo de su tramo. */}
      <div className="overflow-hidden rounded-xl border border-border-subtle bg-overlay/2 p-3">
        <svg
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          preserveAspectRatio="none"
          className="block h-[200px] w-full"
          role="img"
          aria-label={`Embudo por etapas. ${resumen}`}
        >
          {etapas.map((e, i) => {
            const hIzq = altoDe(i);
            const hDer = i + 1 < n ? altoDe(i + 1) : hIzq;
            const x0 = i * segW;
            const x1 = x0 + segW - 2; // 2 unidades de aire entre tramos
            const yTopIzq = (VB_H - hIzq) / 2;
            const yTopDer = (VB_H - hDer) / 2;
            const sev = severidad(e, i === 0);
            const alturaMedia = (hIzq + hDer) / 2;
            const cabeElTexto = alturaMedia >= MIN_ALTO_TEXTO;
            return (
              <g key={e.stageOrder}>
                {e.inconsistente && <title>{TITULO_INCONSISTENTE}</title>}
                <polygon
                  points={`${x0},${yTopIzq} ${x1},${yTopDer} ${x1},${yTopDer + hDer} ${x0},${yTopIzq + hIzq}`}
                  fill={RELLENO[sev]}
                  fillOpacity={0.85}
                  stroke={e.inconsistente ? panelColors.warn : 'rgba(255,255,255,0.18)'}
                  strokeWidth={e.inconsistente ? 3 : 1}
                  strokeDasharray={e.fuente === 'hito' ? '6 4' : undefined}
                />
                {/* El % DENTRO del tramo. Si el tramo es muy finito no entra y
                    se dibuja justo encima, porque un número recortado por el
                    borde es peor que uno afuera. */}
                <text
                  x={x0 + (segW - 2) / 2}
                  y={cabeElTexto ? VB_H / 2 + 5 : yTopIzq - 6}
                  textAnchor="middle"
                  fontSize={15}
                  fontWeight={700}
                  fill={cabeElTexto ? '#0a0a0f' : '#e4e4e7'}
                  style={{ fontFamily: 'var(--font-geist-mono), ui-monospace, monospace' }}
                >
                  {fmtPct(e.pctOfBase, 1)}
                </text>
              </g>
            );
          })}
        </svg>

        <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
          {etapas.map((e, i) => (
            <div
              key={e.stageOrder}
              className="min-w-0 border-t border-border-subtle pt-2 text-center"
              title={e.inconsistente ? TITULO_INCONSISTENTE : undefined}
            >
              <p className="truncate text-[11px] font-medium text-neutral-300" title={e.label}>
                {e.inconsistente && <span className="text-warn-400">⚠ </span>}
                {e.label}
              </p>
              <p className="font-mono text-xs tabular-nums text-neutral-100">{fmtInt(e.sessions)}</p>
              {i > 0 && (
                <p
                  className={`font-mono text-[10px] tabular-nums ${
                    severidad(e, false) === 'malo'
                      ? 'text-bad-300'
                      : severidad(e, false) === 'medio'
                        ? 'text-warn-300'
                        : 'text-neutral-500'
                  }`}
                >
                  {e.dropFromPrevious > 0 ? `-${fmtPct(e.dropFromPrevious, 0)}` : '—'}
                </p>
              )}
              {e.fuente === 'hito' && (
                <p className="text-[10px] text-neutral-600">hito</p>
              )}
            </div>
          ))}
        </div>
      </div>

      {hayInconsistente && (
        <p className="mt-2 text-[11px] font-medium text-warn-400" title={TITULO_INCONSISTENTE}>
          ⚠ Hay una etapa con más sesiones que la anterior. El alto del tramo se recorta para que la
          figura siga siendo un embudo, pero el número que se muestra es el real.
        </p>
      )}
    </div>
  );
}
