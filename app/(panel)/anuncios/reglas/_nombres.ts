/**
 * Helpers puros de la pantalla de reglas (spec reglas-anuncios-por-cuenta).
 *
 * Client-safe: este archivo NO importa nada en runtime. Sólo funciones puras,
 * para que los tests las importen sin arrastrar `pg`, recharts ni React.
 */

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
