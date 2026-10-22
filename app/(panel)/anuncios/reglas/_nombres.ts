/**
 * Helpers puros de la pantalla de reglas (spec reglas-anuncios-por-cuenta).
 *
 * Client-safe: este archivo NO importa nada en runtime. Sólo funciones puras,
 * para que los tests las importen sin arrastrar `pg`, recharts ni React.
 */

import type { NivelAds, Regla } from '@/lib/ads/tipos';

/**
 * El filtro por nombre en castellano, para el resumen del formulario y el aviso
 * de «sin condiciones». Nombra a los padres porque el motor también los mira
 * (`pasaFiltroDeNombre` en lib/ads/reglas/motor.ts): una frase que hablara sólo
 * del nombre del conjunto escondería que «no contiene CBO» deja afuera a todos
 * los conjuntos de una campaña CBO. '' = sin filtro.
 */
export function fraseFiltroNombre(
  level: NivelAds,
  mode: Regla['nameFilterMode'],
  filtro: string | null,
): string {
  const texto = (filtro ?? '').trim();
  if (texto === '') return '';
  const t = `«${texto}»`;
  if (mode === 'contains') {
    if (level === 'campaign') return `con ${t} en el nombre`;
    if (level === 'adset') return `con ${t} en su nombre o en el de su campaña`;
    return `con ${t} en su nombre, en el de su conjunto o en el de su campaña`;
  }
  if (level === 'campaign') return `sin ${t} en el nombre`;
  if (level === 'adset') return `sin ${t} en su nombre ni en el de su campaña`;
  return `sin ${t} en su nombre, ni en el de su conjunto ni en el de su campaña`;
}

/**
 * El nombre que propone «Duplicar». El único de `ad_rules` es `(account_id,
 * name)` (migración 021), así que la colisión sólo puede darse DENTRO de la
 * misma cuenta: `ocupados` son los nombres de las reglas de ESA cuenta y de
 * ninguna otra (R8 c8).
 *
 * Tope de 200 caracteres, el mismo de `ad_rules.name` y del zod: si la raíz no
 * entra con el sufijo, se recorta la raíz, nunca el sufijo (el sufijo es lo que
 * le dice al usuario que es una copia). El resultado nunca queda vacío después
 * de `trim()`: siempre termina en `)`.
 */
export function nombreDeCopia(base: string, ocupados: readonly string[]): string {
  const tomados = new Set(ocupados);
  const raiz = base.trim() || 'regla';
  let n = 1;
  for (;;) {
    const sufijo = n === 1 ? ' (copia)' : ` (copia ${n})`;
    const candidato =
      raiz.length + sufijo.length <= 200 ? `${raiz}${sufijo}` : `${raiz.slice(0, 200 - sufijo.length)}${sufijo}`;
    if (!tomados.has(candidato)) return candidato;
    n += 1;
  }
}
