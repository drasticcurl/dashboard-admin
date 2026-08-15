'use client';

/**
 * ResultadosLote (task 20.3): la cantidad de objetos confirmados sobre el total
 * de la Accion_Lote, y la lista COMPLETA —sin truncar, hasta 100 objetos— de
 * los no confirmados con su identificador, su resultado y el motivo (R16 c3).
 * El texto es el del catálogo de errores en castellano, con el código de Meta
 * como dato secundario dentro del mismo detalle (R16 c9). Un resultado
 * `indeterminado` avisa que no se pudo confirmar y que se define cuando corra
 * la reconciliación (R16 c8).
 */

import { Banner } from '@/components/ui';

export type ResultadoLote = {
  objectId: string;
  objectName: string | null;
  estado: 'confirmado' | 'fallido' | 'indeterminado' | 'omitido' | 'no_intentado';
  mensaje: string | null;
  codigoMeta: number | null;
  motivo?: string;
};

export type RespuestaLote = {
  aplicados: number;
  total: number;
  corte: { causa: string; detalle: string; backoffSegundos: number | null } | null;
  resultados: ResultadoLote[];
};

const ESTADO_TEXTO: Record<ResultadoLote['estado'], string> = {
  confirmado: 'aplicado',
  fallido: 'falló',
  indeterminado: 'sin confirmar',
  omitido: 'omitido',
  no_intentado: 'no intentado',
};

export function ResultadosLote({ respuesta }: { respuesta: RespuestaLote }): JSX.Element {
  const noConfirmados = respuesta.resultados.filter((r) => r.estado !== 'confirmado');

  return (
    <div className="space-y-2">
      <p className="text-sm text-neutral-200">
        <span className="font-semibold">{respuesta.aplicados}</span> de{' '}
        <span className="font-semibold">{respuesta.total}</span> aplicados.
      </p>

      {respuesta.corte && (
        <Banner tone="bad" title="El lote se cortó">
          {respuesta.corte.detalle}
          {respuesta.corte.backoffSegundos !== null && (
            <span className="ml-1">Volvé a intentar en {respuesta.corte.backoffSegundos} segundos.</span>
          )}
        </Banner>
      )}

      {noConfirmados.length > 0 && (
        <ul className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-border-strong p-2 text-xs">
          {noConfirmados.map((r) => (
            <li key={r.objectId} className="rounded bg-overlay/3 px-2 py-1">
              <span className="font-mono text-neutral-400">{r.objectId}</span>{' '}
              <span className="text-neutral-300">{r.objectName ?? ''}</span> —{' '}
              <span className="font-semibold text-warn-300">{ESTADO_TEXTO[r.estado]}</span>
              {r.motivo ? ` (${r.motivo})` : ''}
              {r.mensaje && <span className="block text-neutral-400">{r.mensaje}</span>}
              {r.codigoMeta !== null && (
                <span className="block text-neutral-600">código de Meta: {r.codigoMeta}</span>
              )}
              {r.estado === 'indeterminado' && (
                <span className="block text-neutral-500">
                  No se pudo confirmar si la acción se aplicó: el resultado se define cuando corra la
                  reconciliación.
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
