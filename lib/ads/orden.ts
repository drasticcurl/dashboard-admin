/**
 * Orden_Tabla (task 4.1 de gestion-campanas-anuncios): la clave de orden por
 * columna, en DOS mitades que no pueden separarse — la expresión SQL del
 * `ORDER BY` (sobre el CTE `medidas` de `getMetricasAds`) y el comparador
 * equivalente en TypeScript, que es el modelo de la Property 6.
 *
 * PURA: sin `pg` y sin red. La Property 6 (task 15.3) verifica las dos mitades
 * contra las mismas filas: si alguien cambia una fórmula acá o en el SQL y no
 * la otra, el test lo dice.
 *
 * Semántica del orden (R4 c6, c7):
 *   - los nulos van al FINAL en las dos direcciones (el cero es un valor);
 *   - el desempate es `objectId` ASCENDENTE, siempre, sin importar la dirección
 *     — es lo que hace el orden total y determinista, y lo que hace que la
 *     paginación por página no saltee ni repita filas;
 *   - primer click en una columna nueva → descendente; click en la misma →
 *     invierte, sin estado intermedio sin orden (R4 c1, c2);
 *   - un encabezado no ordenable no cambia nada (R4 c11);
 *   - cambiar la clave o la dirección vuelve a la página 1 (R4 c8).
 */

import type { ClaveOrden, MetricasObjeto } from './tipos';
import { valorDeMetrica } from './catalogo';

/**
 * La expresión SQL de cada clave, sobre el CTE `medidas` de `getMetricasAds`.
 * El alias `m` es el de ese CTE. Los cocientes existen SOLO para el ORDER BY:
 * lo que la API devuelve lo sigue calculando `filaDesdeRow` (una sola fuente de
 * verdad para lo que se muestra).
 */
export const ORDEN_SQL: Record<ClaveOrden, string> = {
  // Los textos ordenan con COLLATE "C": la Property 6 exige que la secuencia
  // del SQL sea idéntica a la del comparador TS, y la collation de la base
  // (en_US.utf8) no es replicable con localeCompare. C = orden de bytes UTF-8,
  // que ES el orden por código del comparador de TypeScript: las dos mitades
  // coinciden por construcción, para todo string. Las fechas ISO y los ids son
  // ASCII ordenable, así que no necesitan collation.
  nombre: 'm."objectName" COLLATE "C"',
  estado: 'm.status COLLATE "C"',
  gastos: 'm."spendEur"',
  ventas: 'm."sales"',
  ingresos: 'm."revenueEur"',
  ganancia: 'm."profitEur"',
  presupuesto: 'm."dailyBudgetEur"',
  roi: 'm."roi"',
  roas: 'm."roas"',
  cpa: 'm."cpaEur"',
  ctr: 'm."ctr"',
  cpc: 'm."cpcEur"',
  cpm: 'm."cpmEur"',
  alcance: 'm."alcance"',
  frecuencia: 'm."frecuencia"',
  hookRate: 'm."hookRate"',
  impresiones: 'm.impressions',
  clics: 'm.clicks',
  videoReproducciones: 'm."videoReproducciones"',
  videoThruplay: 'm."videoThruplay"',
  videoP25: 'm."videoP25"',
  videoP50: 'm."videoP50"',
  videoP75: 'm."videoP75"',
  videoP100: 'm."videoP100"',
  ultimaActualizacion: 'm."ultimaAccionAt"',
  inicioProgramado: 'm."inicioProgramado"',
};

export function esClaveOrden(clave: string): clave is ClaveOrden {
  return Object.prototype.hasOwnProperty.call(ORDEN_SQL, clave);
}

/** El estado completo del orden, incluida la página que lo acompaña (R4 c8). */
export type EstadoOrden = {
  clave: ClaveOrden;
  dir: 'asc' | 'desc';
  pagina: number;
};

export const ORDEN_DEFAULT: EstadoOrden = { clave: 'gastos', dir: 'desc', pagina: 1 };

/**
 * El Orden_Tabla siguiente a un click en un encabezado (R4 c1, c2, c8, c11):
 *   - columna no ordenable → el orden queda intacto (clave, dirección y página);
 *   - columna nueva → descendente, página 1;
 *   - la misma columna → invierte entre descendente y ascendente, página 1.
 */
export function siguienteOrden(actual: EstadoOrden, claveClickeada: string): EstadoOrden {
  if (!esClaveOrden(claveClickeada)) return actual;
  if (actual.clave === claveClickeada) {
    return { clave: actual.clave, dir: actual.dir === 'desc' ? 'asc' : 'desc', pagina: 1 };
  }
  return { clave: claveClickeada, dir: 'desc', pagina: 1 };
}

function esNumero(v: number | string | null): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * El comparador equivalente al `ORDER BY` de SQL. Es el modelo de la Property 6:
 * nulos al final en las DOS direcciones, cero como valor, desempate por
 * `objectId` ascendente — sin multiplicar el desempate por la dirección.
 */
export function comparadorOrden(
  clave: ClaveOrden,
  dir: 'asc' | 'desc',
): (a: MetricasObjeto, b: MetricasObjeto) => number {
  const signo = dir === 'desc' ? -1 : 1;
  return (a, b) => {
    const va = valorDeMetrica(a, clave);
    const vb = valorDeMetrica(b, clave);
    const aNulo = !esNumero(va) && va === null;
    const bNulo = !esNumero(vb) && vb === null;

    if (aNulo && bNulo) return a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0;
    if (aNulo) return 1; // nulos al final, en las dos direcciones
    if (bNulo) return -1;

    let cmp: number;
    if (esNumero(va) && esNumero(vb)) {
      cmp = va - vb;
    } else {
      // Comparación por código (UTF-16), que coincide byte a byte con la
      // collation "C" del ORDER BY de SQL (ver ORDEN_SQL): las dos mitades dan
      // la misma secuencia para todo string, sin depender del locale del
      // proceso ni de la collation de la base.
      cmp = va < vb ? -1 : va > vb ? 1 : 0;
    }
    if (cmp !== 0) return signo * cmp;
    // Desempate SIEMPRE ascendente (R4 c7): no lo afecta la dirección.
    return a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0;
  };
}
