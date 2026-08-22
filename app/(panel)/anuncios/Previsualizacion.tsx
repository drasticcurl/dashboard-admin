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
 *
 * La columna «Qué pasa» muestra el motivo de la Omisión Y la advertencia cuando
 * vienen las dos (R3.4, R6.4): ver `textoQuePasa`, que es donde está escrito por
 * qué elegir una sola escondía el caso que importaba.
 *
 * Lo que este componente NO puede advertir todavía: el padre pausado de R6.4. La
 * advertencia la calcula `calcularPrevisualizacion` sólo si recibe
 * `params.padres`, y una fila de la tabla (`MetricasObjeto`) no trae el `status`
 * de su campaña —el `effectiveStatus` propio no alcanza, porque Meta lo resuelve
 * con el estado propio antes que con el del padre—. La de Objeto_Desaparecido sí
 * sale acá: `desaparecidoAt` viaja en la fila.
 */

import { Banner } from '@/components/ui';
// El catálogo de motivos vive en `lib/ads/mensajes.ts` (task 2.1): lo comparte
// con el aviso posterior a la ejecución, así la previa y el resultado no pueden
// nombrar el mismo motivo de dos maneras distintas.
import { MOTIVO_TEXTO } from '@/lib/ads/mensajes';
import type { Previsualizacion as Previa } from '@/lib/ads/previsualizacion';

const NIVEL_LABEL: Record<string, string> = {
  campaign: 'campañas',
  adset: 'conjuntos',
  ad: 'anuncios',
};

/**
 * Lo que la columna «Qué pasa» dice de una fila: el motivo de la Omisión y la
 * advertencia, LOS DOS cuando los dos aplican (task 15, R3.4, R6.4).
 *
 * Antes era un `motivo ? … : advertencia ? …`, y esa exclusión escondía justo el
 * caso que la advertencia vino a cubrir: un conjunto ACTIVE bajo una campaña
 * pausada llega con `motivo: 'ya_esta_en_ese_estado'` y con la advertencia de
 * padre apagado, y contra la cuenta real eso son 92 de 169 conjuntos. Ahí el
 * motivo tapaba lo único que explicaba el síntoma reportado («parece que lo
 * habilita pero realmente no lo hace»): que el objeto no entrega.
 *
 * Son dos hechos distintos —por qué no se escribe y por qué no sirve— así que van
 * los dos, con el mismo ` · ` con el que `sumarAdvertencia` junta dos
 * advertencias entre sí. Devuelve `''` cuando no hay nada que advertir, y ahí la
 * celda vuelve a decir «se aplica» o «no ejecutable».
 */
export function textoQuePasa(fila: Pick<Previa['filas'][number], 'motivo' | 'advertencia'>): string {
  const partes = [fila.motivo ? MOTIVO_TEXTO[fila.motivo] : null, fila.advertencia];
  return partes.filter((t): t is string => typeof t === 'string' && t !== '').join(' · ');
}

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
                  {textoQuePasa(f) !== '' ? (
                    <span className="text-warn-300">{textoQuePasa(f)}</span>
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
              // El mismo texto que la celda, y por una razón que no es sólo de
              // consistencia: la tabla dibuja 50 filas y esta lista TODAS las
              // omitidas, así que para un lote grande es el único lugar donde la
              // advertencia de una fila 51 en adelante llega a la pantalla.
              <li key={f.objectId}>
                {f.objectName ?? f.objectId}: {textoQuePasa(f)}
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
