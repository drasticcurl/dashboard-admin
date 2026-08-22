'use client';

/**
 * ResultadosLote (task 20.3): la cantidad de objetos confirmados sobre el total
 * de la Accion_Lote, y la lista COMPLETA —sin truncar, hasta 100 objetos— de los
 * objetos que necesitan que la pantalla diga algo, con su identificador, su
 * resultado y el motivo (R16 c3). El texto es el del catálogo de errores en
 * castellano, con el código de Meta como dato secundario dentro del mismo detalle
 * (R16 c9). Un resultado `indeterminado` avisa que no se pudo confirmar y que se
 * define cuando corra la reconciliación (R16 c8).
 *
 * ## Por qué esta lista es la que muestra las advertencias
 *
 * `avisoDeLote` (`lib/ads/mensajes.ts`) devuelve `null` para un lote de varios
 * objetos en el que algo se aplicó, y lo documenta: un aviso arriba no puede
 * hablar por 100 objetos sin fabricar un conteo que después nadie desglosa. Deja
 * dicho que el lugar de las advertencias por objeto es esta lista.
 *
 * Hasta esta pasada la lista no las mostraba, y peor: filtraba por
 * `estado !== 'confirmado'`, así que un lote de 20 conjuntos activados bajo
 * campañas pausadas —escrituras que Meta confirmó y objetos que no van a
 * entregar— salía de acá como «20 de 20 aplicados» y ni una palabra más. La
 * advertencia de R6.4 no habla de si la escritura llegó sino de si el objeto va a
 * hacer algo, así que el `confirmado` no puede ser el filtro: lo que decide si un
 * objeto aparece es si queda algo que decir de él (`necesitaRenglon`).
 *
 * La composición sigue el criterio de `textoQuePasa` de `Previsualizacion.tsx`:
 * el motivo y la advertencia se suman, no compiten. Ver `textoQuePaso`.
 */

import { Banner } from '@/components/ui';
// El mismo catálogo de motivos que la Previsualizacion y que el aviso: un solo
// texto por motivo, así la previa, el aviso y este desglose no pueden nombrar la
// misma Omisión de tres maneras (task 2.1).
import { MOTIVO_TEXTO, type ResultadoAccion } from '@/lib/ads/mensajes';

/**
 * Un resultado por objeto, tal como lo declara `lib/ads/mensajes.ts` para el
 * cuerpo del Endpoint_Acciones.
 *
 * Es un alias y no una copia de los campos a propósito. La copia local era la que
 * dejaba caer los campos nuevos sin que nada se rompiera: el route agregó
 * `advertencia` (task 15) y `edadDelDato` (task 14.3) al cuerpo, el tipo de acá
 * no los conocía y esta lista los ignoraba en silencio. Con el alias, el único
 * productor y el único consumidor comparten la declaración y el compilador es el
 * que avisa.
 */
export type ResultadoLote = ResultadoAccion;

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

/**
 * El color del resultado. `confirmado` en verde y el resto en ámbar porque R6.4
 * pide distinguir «se aplicó y no entrega» de «la acción falló», y desde que los
 * confirmados con advertencia entran a la lista las dos cosas conviven en la misma
 * columna: con un solo color, un objeto que sí cambió se leería como uno que no.
 */
const ESTADO_COLOR: Record<ResultadoLote['estado'], string> = {
  confirmado: 'text-good-300',
  fallido: 'text-warn-300',
  indeterminado: 'text-warn-300',
  omitido: 'text-warn-300',
  no_intentado: 'text-warn-300',
};

/**
 * Si de este objeto queda algo que decir. Un `confirmado` sin advertencia es el
 * único caso que no: el conteo de arriba ya lo cuenta y repetirlo sería ruido en
 * el camino normal.
 */
export function necesitaRenglon(r: ResultadoLote): boolean {
  return r.estado !== 'confirmado' || textoONulo(r.advertencia) !== null;
}

/**
 * Lo que pasó con un objeto: el motivo de la Omisión Y la advertencia, los dos
 * cuando los dos aplican (R3.4, R6.4).
 *
 * Es el hermano post-ejecución de `textoQuePasa` de `Previsualizacion.tsx`, con
 * el mismo separador y por la misma razón: contra la cuenta real, 92 de 169
 * conjuntos llegan con motivo Y advertencia, así que elegir uno esconde el caso
 * mayoritario. Allá la pregunta es qué va a pasar y acá qué pasó, y los tipos no
 * son el mismo —un resultado puede traer `ya_esta_entregando`, que la previa no
 * emite— así que la función se escribe dos veces y el catálogo se comparte una.
 *
 * `''` cuando no hay nada que agregar: ahí el renglón queda con el resultado solo,
 * que para un `fallido` ya lleva el mensaje del catálogo de errores abajo.
 */
export function textoQuePaso(r: ResultadoLote): string {
  return [textoDelMotivo(r.motivo), textoONulo(r.advertencia)]
    .filter((t): t is string => t !== null)
    .join(' · ');
}

/**
 * La antigüedad del dato con el que el servidor decidió la Omisión, como oración
 * propia, o `null` cuando no viajó (R6.1).
 *
 * En su propio renglón y no dentro del paréntesis del resultado: son preguntas
 * distintas —por qué el servidor decidió eso y con qué dato lo decidió— y el
 * paréntesis ya puede llevar dos cláusulas. En un lote es donde más pesa: veinte
 * omisiones que citan un dato de hace cinco días son un diagnóstico, y de una
 * sola sería una nota al pie.
 *
 * El texto es el mismo que `oracionDeEdad` de `lib/ads/mensajes.ts` pone en el
 * aviso de un objeto solo, palabra por palabra: el toggle de una fila y el
 * renglón del lote hablan del mismo hecho y no pueden decirlo distinto. La
 * antigüedad llega YA formateada por el servidor
 * (`edadDelDatoDeOmision`, `lib/ads/acciones.ts`), así que acá no hay redondeo.
 */
export function textoDeLaEdad(r: ResultadoLote): string | null {
  const edad = textoONulo(r.edadDelDato);
  return edad === null ? null : `Se decidió según un dato ${edad}.`;
}

/**
 * Qué es la lista que sigue. Cambia con lo que hay adentro porque desde que los
 * aplicados con advertencia entran, «los que no se aplicaron» dejó de describirla:
 * un usuario que lea ese encabezado sobre un renglón que dice «aplicado» va a
 * pensar que la pantalla se contradice.
 */
export function leyendaDeLista(renglones: readonly ResultadoLote[]): string {
  const aplicados = renglones.reduce((a, r) => (r.estado === 'confirmado' ? a + 1 : a), 0);
  if (aplicados === 0) return 'Objetos que no se aplicaron:';
  if (aplicados === renglones.length) {
    return 'Objetos que se aplicaron en Meta y aun así tienen algo que advertir:';
  }
  return 'Objetos que no se aplicaron, más los aplicados con una advertencia:';
}

/**
 * Un texto que sirve para mostrar, o `null`. La cadena vacía cuenta como ausente,
 * con el mismo criterio que `textoONulo` de `lib/ads/mensajes.ts`: el cuerpo entra
 * de un `res.json()`, así que `advertencia: ''` es un servidor que no dijo nada y
 * no una advertencia vacía que haya que dibujar.
 */
function textoONulo(valor: unknown): string | null {
  return typeof valor === 'string' && valor !== '' ? valor : null;
}

/** El motivo en castellano, o `null` si no vino. */
function textoDelMotivo(motivo: ResultadoLote['motivo']): string | null {
  if (motivo === undefined || motivo === null) return null;
  // Anotado como opcional aunque el `Record` sea completo sobre la unión: un
  // motivo que este cliente todavía no conoce llega igual desde el servidor, y la
  // clave cruda es peor que el texto del catálogo pero mucho mejor que un hueco.
  const delCatalogo: string | undefined = MOTIVO_TEXTO[motivo];
  return delCatalogo ?? motivo;
}

export function ResultadosLote({ respuesta }: { respuesta: RespuestaLote }): JSX.Element {
  const renglones = respuesta.resultados.filter(necesitaRenglon);

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

      {renglones.length > 0 && (
        <>
          <p className="text-xs text-neutral-500">{leyendaDeLista(renglones)}</p>
          <ul className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-border-strong p-2 text-xs">
            {renglones.map((r) => {
              const quePaso = textoQuePaso(r);
              const edad = textoDeLaEdad(r);
              return (
                <li key={r.objectId} className="rounded bg-overlay/3 px-2 py-1">
                  <span className="font-mono text-neutral-400">{r.objectId}</span>{' '}
                  <span className="text-neutral-300">{r.objectName ?? ''}</span> —{' '}
                  <span className={`font-semibold ${ESTADO_COLOR[r.estado]}`}>
                    {ESTADO_TEXTO[r.estado]}
                  </span>
                  {quePaso !== '' ? ` (${quePaso})` : ''}
                  {r.mensaje && <span className="block text-neutral-400">{r.mensaje}</span>}
                  {edad !== null && <span className="block text-neutral-500">{edad}</span>}
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
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
