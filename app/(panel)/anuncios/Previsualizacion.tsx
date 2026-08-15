'use client';

/**
 * Previsualizacion (task 20.3, el componente): la tabla de antes → después que
 * arma `calcularPrevisualizacion` (los valores YA vienen formateados), más las
 * omisiones con su motivo, el desglose de objetos a crear de una duplicación y
 * los totales de presupuesto con el aviso del 125 % (R13 c8, c9).
 *
 * Muestra como máximo 50 filas con desplazamiento para las restantes (R14 c4),
 * y cuando `completa` es false deja el aviso de Previsualizacion incompleta:
 * el diálogo no deja ejecutar (R14 c12).
 */

import { Banner } from '@/components/ui';
import type { Previsualizacion as Previa } from '@/lib/ads/previsualizacion';

const MOTIVO_TEXTO: Record<string, string> = {
  ya_esta_en_ese_estado: 'ya está en el estado que la acción pediría',
  valor_igual_al_anterior: 'el valor resultante es igual al anterior',
  campo_no_aplica: 'el campo que la acción cambia no aplica a este objeto',
  no_pertenece_al_nivel: 'el objeto no pertenece al Nivel_Activo',
  excede_tope_de_lote: 'el objeto excede el límite de 100 objetos por Accion_Lote',
};

const NIVEL_LABEL: Record<string, string> = {
  campaign: 'campañas',
  adset: 'conjuntos',
  ad: 'anuncios',
};

export function Previsualizacion({ previa }: { previa: Previa }): JSX.Element {
  const primeras = previa.filas.slice(0, 50);
  const resto = previa.filas.length - primeras.length;
  const omitidas = previa.filas.filter((f) => f.motivo);

  return (
    <div className="space-y-3">
      <p className="text-sm text-neutral-300">
        <span className="font-semibold text-neutral-100">{previa.rotuloAccion}</span> sobre{' '}
        <span className="font-semibold text-neutral-100">{previa.alcanzados}</span> {NIVEL_LABEL[previa.nivel]}:
      </p>

      {previa.aCrear && (
        <p className="text-sm text-neutral-300">
          Se crearían {previa.aCrear.total} objetos: {previa.aCrear.campanias} campañas,{' '}
          {previa.aCrear.conjuntos} conjuntos y {previa.aCrear.anuncios} anuncios, todos pausados.
        </p>
      )}

      {previa.presupuesto && (
        <div className="space-y-1 text-sm text-neutral-300">
          <p>
            Presupuesto nuevo que el lote agrega: <span className="font-semibold text-neutral-100">{previa.presupuesto.deltaTotalEur.toFixed(2)} EUR</span>{' '}
            (tope del lote: {previa.presupuesto.topeLoteEur.toFixed(2)} EUR · techo por objeto: {previa.presupuesto.techoEur.toFixed(2)} EUR).
          </p>
          <p className="text-xs text-neutral-500">
            Meta puede gastar hasta el 125 % del presupuesto diario de un objeto en un día, y hasta 7 veces
            ese presupuesto en una semana calendario, compensando el promedio dentro de esa semana: el
            presupuesto no es un tope duro de gasto.
          </p>
        </div>
      )}

      <div className="max-h-64 overflow-y-auto rounded-lg border border-border-strong">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border-subtle text-xs uppercase tracking-wide text-neutral-500">
              <th className="px-2 py-1.5 font-semibold">Objeto</th>
              <th className="px-2 py-1.5 font-semibold">Antes</th>
              <th className="px-2 py-1.5 font-semibold">Después</th>
              <th className="px-2 py-1.5 font-semibold">Qué pasa</th>
            </tr>
          </thead>
          <tbody>
            {primeras.map((f) => (
              <tr key={f.objectId} className="border-b border-overlay/4 last:border-0">
                <td className="max-w-52 truncate px-2 py-1.5 text-neutral-200" title={f.objectName ?? f.objectId}>
                  {f.objectName ?? f.objectId}
                </td>
                <td className="px-2 py-1.5 text-neutral-400">{f.antes ?? '—'}</td>
                <td className="px-2 py-1.5 text-neutral-200">{f.despues ?? '—'}</td>
                <td className="px-2 py-1.5 text-xs">
                  {f.motivo ? (
                    <span className="text-warn-300">{MOTIVO_TEXTO[f.motivo] ?? f.motivo}</span>
                  ) : f.advertencia ? (
                    <span className="text-amber-300">{f.advertencia}</span>
                  ) : f.ejecutable ? (
                    <span className="text-good-300">se aplica</span>
                  ) : (
                    <span className="text-bad-300">no ejecutable</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {resto > 0 && (
          <p className="px-2 py-1.5 text-xs text-neutral-500">… y {resto} filas más (desplazá para verlas).</p>
        )}
      </div>

      {omitidas.length > 0 && (
        <div className="text-xs text-neutral-400">
          <p className="mb-1 font-semibold">Se omiten {omitidas.length} objeto(s):</p>
          <ul className="list-inside list-disc space-y-0.5">
            {omitidas.map((f) => (
              <li key={f.objectId}>
                {f.objectName ?? f.objectId}: {MOTIVO_TEXTO[f.motivo ?? ''] ?? f.motivo}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!previa.completa && (
        <Banner tone="bad" title="Previsualización incompleta">
          Los datos cargados no alcanzan para calcular el antes o el después de algún objeto: no se puede
          ejecutar hasta que se carguen.
        </Banner>
      )}
    </div>
  );
}
