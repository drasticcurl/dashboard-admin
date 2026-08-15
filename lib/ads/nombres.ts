/**
 * Nombres de las Copia y renombrado en lote (task 7.1 de gestion-campanas-anuncios).
 * PURA: sin `pg` y sin red. Es la pieza de la que depende la reconciliación
 * (P-G05): el nombre de una Copia es DETERMINÍSTICO y libre de colisiones, así
 * que una duplicación cuyo resultado nunca llegó se resuelve preguntando por el
 * nombre planificado. No es cosmética: es lo que hace auditable la operación.
 *
 * `ocupados` se arma con los nombres de los hermanos del mismo padre que el
 * panel conoce (la jerarquía local) más los nombres ya planificados en la misma
 * corrida. No se promete unicidad contra objetos que Meta tiene y la jerarquía
 * local no vio (R10 c5 pide exactamente "los que el panel ya conoce").
 */

export const LARGO_MAX_NOMBRE = 400; // R10 c6, R12 c4

/**
 * El nombre de la copia N de `original`, evitando los nombres ya ocupados.
 * Forma: `<original> - Copia N`, con N el primer secuencial libre (R10 c5).
 * Si el resultado pasa de 400 caracteres, se recorta la parte HEREDADA desde el
 * final, conservando el sufijo completo y al menos 1 carácter heredado (R10 c6).
 */
export function nombreDeCopia(original: string, ocupados: ReadonlySet<string>): string {
  let n = 1;
  for (;;) {
    const candidato = recortarConSufijo(original, ` - Copia ${n}`);
    if (!ocupados.has(candidato)) return candidato;
    n += 1;
  }
}

/** La parte heredada + el sufijo, dentro de LARGO_MAX_NOMBRE y con ≥1 carácter heredado. */
function recortarConSufijo(original: string, sufijo: string): string {
  if (original.length + sufijo.length <= LARGO_MAX_NOMBRE) return original + sufijo;
  const base = original.slice(0, Math.max(1, LARGO_MAX_NOMBRE - sufijo.length));
  return base + sufijo;
}

/**
 * Los nombres de las K copias de un original: todos distintos entre sí y
 * distintos de los ocupados (Property 12). Cada nombre planificado entra en
 * `ocupados` para la copia siguiente, así una corrida nunca repite un nombre.
 */
export function nombresDeCopias(
  original: string,
  k: number,
  ocupados: ReadonlySet<string>,
): string[] {
  const ocupadosVivos = new Set(ocupados);
  const out: string[] = [];
  for (let i = 0; i < k; i++) {
    const nombre = nombreDeCopia(original, ocupadosVivos);
    out.push(nombre);
    ocupadosVivos.add(nombre);
  }
  return out;
}

/** Los cuatro modos de renombrado en lote (R12 c2). Exactamente uno por operación. */
export type ModoRenombre =
  | { tipo: 'prefijo'; texto: string }
  | { tipo: 'sufijo'; texto: string }
  | { tipo: 'reemplazo'; buscar: string; poner: string }
  | { tipo: 'exacto'; nombre: string };

/**
 * Aplica un modo de renombrado. El reemplazo es SENSIBLE a mayúsculas y
 * minúsculas (R12 c2) y reemplaza TODAS las apariciones.
 */
export function aplicarRenombre(nombre: string, modo: ModoRenombre): string {
  switch (modo.tipo) {
    case 'prefijo':
      return `${modo.texto}${nombre}`;
    case 'sufijo':
      return `${nombre}${modo.texto}`;
    case 'reemplazo':
      return modo.buscar === '' ? nombre : nombre.replaceAll(modo.buscar, modo.poner);
    case 'exacto':
      return modo.nombre;
  }
}
