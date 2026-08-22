import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q, q1 } from '../db';
import { getMetricasAds } from './ads';
import type { ResultadoMetricas } from '../ads/tipos';

/**
 * Los totales del filtro completo (R7.1, Property 9 — task 17.1).
 *
 * Es el smoke test del agregado que la task 17.1 agrega a `getMetricasAds`. La
 * Property 9 completa (todo filtro, todo par de páginas) es la task 17.3: acá se
 * fija lo mínimo que protege el cambio de esta task.
 *
 * Lo que viene a atrapar es el bug de producción: la barra de KPIs reducía
 * `data.filas`, así que con 505 anuncios y un tope de 500 filas por página el
 * total de gasto NUNCA incluía todas las filas y "el gasto bajaba de la nada" al
 * cambiar de página. Con 7 filas y páginas de 3, la suma de la primera página
 * (18) tiene que ser DISTINTA del total (28), o el test no estaría probando nada.
 *
 * Los dos caminos de paginación se prueban por separado a propósito. `p()`
 * empuja parámetros sobre un array compartido: la rama `page` agrega
 * offset/limit y la rama `after` agrega after/limit DESPUÉS de que la cadena de
 * CTEs quedó armada, así que el agregado corre con un slice de ese array. Si el
 * slice quedara mal, Postgres tira en el bind y no hay forma de que el error
 * pase inadvertido — pero sólo si las dos ramas se ejecutan.
 */
if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}
const dbAvailable = Boolean(process.env.DATABASE_URL);

const CUENTA = `TOT-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ZONA = 'Europe/Lisbon';

/** 7 anuncios con gasto 1..7. Sin jerarquía: salen por la rama `UNION ALL` de
 *  `gasto`, que es la que no depende de la regla de vigencia. */
const GASTOS = [1, 2, 3, 4, 5, 6, 7];
const SUMA_TOTAL = 28; // 1+2+…+7, exacto en punto flotante
const LIMITE = 3; // 7 filas → 3 páginas
const SUMA_PRIMERA_PAGINA = 18; // orden por defecto: gastos desc → 7+6+5

describe.skipIf(!dbAvailable)('getMetricasAds — totales del filtro completo (R7.1)', () => {
  beforeAll(async () => {
    await q(
      `INSERT INTO ad_accounts (account_id, platform, name, currency, timezone, active)
       VALUES ($1, 'meta', 'cuenta de totales', 'EUR', $2, true)
       ON CONFLICT (account_id) DO UPDATE SET timezone = $2, active = true`,
      [CUENTA, ZONA],
    );

    const dia = (await q1<{ hoy: string }>(`SELECT (now() AT TIME ZONE $1)::date::text AS hoy`, [
      ZONA,
    ]))!.hoy;

    await q(
      `INSERT INTO ad_spend (platform, account_id, day, level, campaign_id, campaign_name,
                             adset_id, adset_name, ad_id, ad_name, spend, currency, spend_eur,
                             impressions, clicks, synced_at)
       SELECT 'meta', $1, $2::date, 'ad',
              'c' || u.g::text, 'C ' || u.g::text,
              's' || u.g::text, 'S ' || u.g::text,
              'a' || u.g::text, 'A ' || u.g::text,
              u.g, 'EUR', u.g, u.g * 100, u.g, now()
         FROM unnest($3::numeric[]) AS u(g)`,
      [CUENTA, dia, GASTOS],
    );
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await q(`DELETE FROM ad_spend WHERE account_id = $1`, [CUENTA]);
    await q(`DELETE FROM ad_accounts WHERE account_id = $1`, [CUENTA]);
  });

  const pedir = (extra: Partial<Parameters<typeof getMetricasAds>[0]>) =>
    getMetricasAds({
      level: 'ad',
      period: 'today',
      accountIds: [CUENTA],
      limit: LIMITE,
      ...extra,
    });

  it('el total de gasto es el del filtro y no el de la página visible', async () => {
    const p1 = await pedir({ page: 1 });

    expect(p1.filas).toHaveLength(LIMITE);
    expect(p1.total).toBe(GASTOS.length);
    expect(p1.totalPaginas).toBe(3);

    // La suma de la página visible NO alcanza: es el bug que este agregado viene
    // a arreglar. Si estas dos fueran iguales, el test no probaría nada.
    const sumaVisible = p1.filas.reduce((a, f) => a + f.spendEur, 0);
    expect(sumaVisible).toBe(SUMA_PRIMERA_PAGINA);
    expect(sumaVisible).not.toBe(SUMA_TOTAL);

    expect(p1.totales.spendEur).toBe(SUMA_TOTAL);
    expect(p1.totales.filas).toBe(GASTOS.length);
  });

  it('los totales son idénticos en todas las páginas y suman lo mismo que recorrerlas', async () => {
    const paginas: ResultadoMetricas[] = [];
    for (let n = 1; n <= 3; n++) paginas.push(await pedir({ page: n }));

    // Property 9: el total es una función del filtro, no de la página.
    for (const p of paginas.slice(1)) {
      expect(p.totales, `página ${p.pagina}`).toEqual(paginas[0]!.totales);
    }

    // …y ese total es exactamente lo que se junta recorriendo todo.
    const todas = paginas.flatMap((p) => p.filas);
    expect(todas).toHaveLength(GASTOS.length);
    expect(paginas[0]!.totales.spendEur).toBe(todas.reduce((a, f) => a + f.spendEur, 0));

    // netEur y profitEur salen de sumar las columnas que `medidas` ya calcula,
    // no de rearmar la fórmula: el total tiene que cerrar contra las filas.
    // Sin ventas atribuidas el neto es 0 y la ganancia es el gasto en negativo,
    // que es justamente el caso donde una fórmula duplicada pasaría igual.
    expect(paginas[0]!.totales.netEur).toBeCloseTo(
      todas.reduce((a, f) => a + f.netEur, 0),
      6,
    );
    expect(paginas[0]!.totales.profitEur).toBeCloseTo(
      todas.reduce((a, f) => a + f.profitEur, 0),
      6,
    );
    expect(paginas[0]!.totales.profitEur).toBeCloseTo(-SUMA_TOTAL, 6);
    expect(paginas[0]!.totales.sales).toBe(0);
  });

  it('en una página más allá del final los totales siguen siendo los del filtro', async () => {
    // `total` sale de un count(*) OVER () de la query de filas, así que sin
    // filas colapsa a 0. `totales.filas` no: por eso los dos campos existen.
    const vacia = await pedir({ page: 5 });

    expect(vacia.filas).toHaveLength(0);
    expect(vacia.total).toBe(0);
    expect(vacia.totales.filas).toBe(GASTOS.length);
    expect(vacia.totales.spendEur).toBe(SUMA_TOTAL);
  });

  it('el camino con cursor `after` devuelve los mismos totales', async () => {
    // La otra rama de la cola de la query, con sus propios parámetros: prueba
    // que el agregado corre con los de la cadena común y no con los de la rama.
    const conCursor = await pedir({ after: 'a0' });

    expect(conCursor.filas.length).toBeLessThan(GASTOS.length);
    expect(conCursor.totales.spendEur).toBe(SUMA_TOTAL);
    expect(conCursor.totales.filas).toBe(GASTOS.length);
  });

  it('un filtro que no alcanza ninguna fila da todos los totales en cero', async () => {
    const nada = await pedir({ page: 1, nombre: 'no-existe-este-nombre' });

    expect(nada.filas).toHaveLength(0);
    expect(nada.totales).toEqual({
      spendEur: 0,
      revenueEur: 0,
      netEur: 0,
      profitEur: 0,
      sales: 0,
      filas: 0,
    });
  });
});
