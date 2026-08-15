import fc from 'fast-check';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { q, q1 } from '../db';
import { getMetricasAds } from './ads';
import { CATALOGO_METRICAS, valorDeMetrica } from '../ads/catalogo';
import { comparadorOrden } from '../ads/orden';
import type { ClaveOrden, MetricasObjeto } from '../ads/tipos';

/**
 * Property 5 (task 15.2): ordenar no agrega ni saca filas. El modelo es el
 * recorrido completo de páginas contra el orden por identificador: para todo
 * Orden_Tabla, toda dirección y todo tamaño de página, el conjunto de filas al
 * recorrer TODAS las páginas es una permutación del conjunto con orden por id —
 * igual cantidad, sin filas repetidas ni omitidas entre páginas (R4 c5, c8, c9).
 *
 * Se siembran 0..300 objetos con gasto, nulos y empates a propósito. Los nulos
 * salen solos del modelo: gasto 0 → ROI null, sin ventas → CPA null, sin
 * impresiones → CTR null, sin presupuesto en la jerarquía → null, sin video ni
 * alcance → null. La Property 6 (modelo contra SQL) vive en la task 15.3.
 */

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

const CUENTA = `P5-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ZONA = 'Europe/Lisbon';

const CLAVES_ORDENABLES: ClaveOrden[] = CATALOGO_METRICAS.filter((e) => e.ordenable).map(
  (e) => e.clave as ClaveOrden,
);

/** Un objeto sembrado: campaña (por la rama de gasto) con métricas chicas para
 *  que haya empates, y ceros para que haya nulos en los cocientes. */
type Sembrada = {
  objectId: string;
  name: string | null;
  spend: number;
  impressions: number;
  clicks: number;
};

function genSiembra(): fc.Arbitrary<Sembrada[]> {
  const nombre = (): fc.Arbitrary<string | null> =>
    fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: null });
  return fc
    .array(
      fc
        .tuple(
          fc.integer({ min: 1000000000000000, max: 9999999999999999 }).map(String),
          nombre(),
          fc.integer({ min: 0, max: 5 }), // spend: empates y ceros a propósito
          fc.integer({ min: 0, max: 5 }), // impressions
          fc.integer({ min: 0, max: 5 }), // clicks
        )
        .map(([objectId, name, spend, impressions, clicks]) => ({
          objectId,
          name,
          spend,
          impressions,
          clicks,
        })),
      { minLength: 0, maxLength: 300 },
    )
    .map((filas) => {
      // ids únicos: dos filas con el mismo campaign_id violarían ad_spend_unico
      const vistos = new Set<string>();
      return filas.filter((f) => (vistos.has(f.objectId) ? false : (vistos.add(f.objectId), true)));
    });
}

async function sembrar(filas: Sembrada[], dia: string): Promise<void> {
  await q(
    `INSERT INTO ad_accounts (account_id, platform, name, currency, active, timezone)
     VALUES ($1, 'meta', 'test', 'EUR', true, $2)
     ON CONFLICT (account_id) DO UPDATE SET active = true, timezone = $2`,
    [CUENTA, ZONA],
  );
  await q('DELETE FROM ad_spend WHERE account_id = $1', [CUENTA]);
  for (const f of filas) {
    await q(
      `INSERT INTO ad_spend (platform, account_id, day, level, campaign_id, campaign_name,
                             adset_id, adset_name, ad_id, ad_name, spend, currency, spend_eur,
                             impressions, clicks, synced_at)
       VALUES ('meta', $1, $2::date, 'ad', $3, $4, '', NULL, '', NULL, $5, 'EUR', $5, $6, $7, now())`,
      [CUENTA, dia, f.objectId, f.name, f.spend, f.impressions, f.clicks],
    );
  }
}

/** Para la Property 6, algunos objetos viven también en la jerarquía: nombre,
 *  estado y presupuesto varían de verdad (y otros quedan sólo con gasto). */
type SembradaConJerarquia = Sembrada & {
  enJerarquia: boolean;
  status: 'ACTIVE' | 'PAUSED';
  dailyBudget: number | null;
};

function genSiembraP6(): fc.Arbitrary<SembradaConJerarquia[]> {
  return genSiembra().map((filas) =>
    filas.map((f, i) => {
      const enJerarquia = i % 2 === 0;
      return {
        ...f,
        enJerarquia,
        status: (i % 4 === 0 ? 'PAUSED' : 'ACTIVE') as 'ACTIVE' | 'PAUSED',
        dailyBudget: enJerarquia ? (i % 3 === 0 ? null : ((i % 5) + 1) * 10) : null,
      };
    }),
  );
}

async function sembrarJerarquia(filas: SembradaConJerarquia[]): Promise<void> {
  await q('DELETE FROM ad_campaigns WHERE account_id = $1', [CUENTA]);
  for (const f of filas) {
    if (!f.enJerarquia) continue;
    await q(
      `INSERT INTO ad_campaigns (campaign_id, account_id, name, status, effective_status,
                                 budget_level, daily_budget, currency, synced_at)
       VALUES ($1, $2, $3, $4, $4, CASE WHEN $5::bigint IS NULL THEN 'adset' ELSE 'campaign' END,
               $5::bigint, 'EUR', now())
       ON CONFLICT (campaign_id) DO UPDATE SET synced_at = now()`,
      [f.objectId, CUENTA, f.name ?? 'sin nombre', f.status, f.dailyBudget],
    );
  }
}

async function hoyLocal(): Promise<string> {
  const r = await q1<{ hoy: string }>(`SELECT (now() AT TIME ZONE $1)::date::text AS hoy`, [ZONA]);
  return r!.hoy;
}

/** El conjunto completo en el orden por identificador (la rama `after`). */
async function basePorId(): Promise<string[]> {
  const todas: string[] = [];
  let after: string | undefined;
  for (;;) {
    const r = await getMetricasAds({
      level: 'campaign',
      period: 'today',
      accountIds: [CUENTA],
      after,
      limit: 1000,
    });
    todas.push(...r.filas.map((f) => f.objectId));
    if (!r.hayMas) break;
    after = todas[todas.length - 1];
  }
  return todas;
}

afterAll(async () => {
  if (!dbAvailable) return;
  await q('DELETE FROM ad_spend WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_campaigns WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_accounts WHERE account_id = $1', [CUENTA]);
});

// Feature: gestion-campanas-anuncios, Property 5: Ordenar no agrega ni saca
// filas
describe.skipIf(!dbAvailable)('Property 5 (R4 c5, c8, c9)', () => {
  it('para toda siembra, clave ordenable, dirección y tamaño de página, recorrer todas las páginas es una permutación del orden por id', async () => {
    await fc.assert(
      fc.asyncProperty(
        genSiembra(),
        fc.constantFrom(...CLAVES_ORDENABLES),
        fc.constantFrom('asc', 'desc'),
        fc.constantFrom(1, 7, 50),
        async (sembradas, clave, dir, tamano) => {
          const dia = await hoyLocal();
          await sembrar(sembradas, dia);

          const porId = await basePorId();

          // recorre TODAS las páginas con el Orden_Tabla pedido
          const recorridas: string[] = [];
          let pagina = 1;
          let totalDeclarado = 0;
          for (;;) {
            const r = await getMetricasAds({
              level: 'campaign',
              period: 'today',
              accountIds: [CUENTA],
              orderBy: clave,
              orderDir: dir,
              page: pagina,
              limit: tamano,
            });
            totalDeclarado = r.total;
            recorridas.push(...r.filas.map((f) => f.objectId));
            if (pagina >= r.totalPaginas) break;
            pagina += 1;
          }

          // igual cantidad de filas
          expect(recorridas).toHaveLength(porId.length);
          expect(totalDeclarado).toBe(porId.length);
          // sin filas repetidas
          expect(new Set(recorridas).size).toBe(recorridas.length);
          // ni omitidas: el conjunto es el mismo
          expect(new Set(recorridas)).toEqual(new Set(porId));
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: gestion-campanas-anuncios, Property 6: El orden es total, pone los
// nulos al final y las dos implementaciones coinciden
describe.skipIf(!dbAvailable)('Property 6 (R4 c6, c7, c3)', () => {
  it('para toda siembra, clave y dirección, la secuencia del ORDER BY de SQL es idéntica a la del comparador TS, con nulos al final y desempate por id ascendente', async () => {
    await fc.assert(
      fc.asyncProperty(
        genSiembraP6(),
        fc.constantFrom(...CLAVES_ORDENABLES),
        fc.constantFrom('asc', 'desc'),
        async (sembradas, clave, dir) => {
          const dia = await hoyLocal();
          await sembrar(sembradas, dia);
          await sembrarJerarquia(sembradas);

          // la secuencia que produce el SQL (una sola página: total ≤ 300 < 1000)
          const r = await getMetricasAds({
            level: 'campaign',
            period: 'today',
            accountIds: [CUENTA],
            orderBy: clave,
            orderDir: dir,
            page: 1,
            limit: 1000,
          });
          const secuenciaSql = r.filas.map((f) => f.objectId);

          // la secuencia que produce el comparador de TypeScript sobre las
          // MISMAS filas devueltas (las del modelo filaDesdeRow)
          const modelo = [...r.filas].sort(comparadorOrden(clave, dir));
          expect(modelo.map((f) => f.objectId), `clave ${clave} ${dir}`).toEqual(secuenciaSql);

          // nulos al final en las DOS direcciones (el cero es un valor):
          // ninguna fila con valor puede quedar después de una con null.
          const ultimoValor = ((): number => {
            let ultimo = -1;
            modelo.forEach((f, i) => {
              if (valorDeMetrica(f, clave) !== null) ultimo = i;
            });
            return ultimo;
          })();
          for (let i = ultimoValor + 1; i < modelo.length; i++) {
            expect(
              valorDeMetrica(modelo[i]!, clave),
              `clave ${clave}: valor después de un null`,
            ).toBeNull();
          }

          // desempate por objectId ASCENDENTE entre filas con el mismo valor
          for (let i = 1; i < modelo.length; i++) {
            const previo = modelo[i - 1]!;
            const actual = modelo[i]!;
            const vp = valorDeMetrica(previo, clave);
            const va = valorDeMetrica(actual, clave);
            if (vp !== null && va !== null && vp === va) {
              expect(
                previo.objectId < actual.objectId,
                `desempate ${clave} ${dir}: ${previo.objectId} vs ${actual.objectId}`,
              ).toBe(true);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
