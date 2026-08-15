import fc from 'fast-check';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { q, q1 } from '../db';
import { getMetricasAds } from './ads';
import { genArbolAds, type ArbolAds } from '../test/generadores-ads';

/**
 * Property 7 (task 15.4): la cascada contiene, nunca amplía (R8 c3, c2, c15).
 *
 * El modelo es el resultado con cascada VACÍA filtrado: para todo árbol de
 * 1..5 campañas × 0..4 conjuntos × 0..6 anuncios, con gasto en objetos que NO
 * están en la jerarquía (la rama de solo-gasto, el bug que el filtro movido al
 * WHERE de `base` arregla), y para toda cascada de 1..50 ids:
 *   - con cascada, las filas mostradas son EXACTAMENTE las filas sin cascada
 *     cuyos objetos descienden (directa o transitivamente) de alguno de los
 *     ids — ni una de más, ni una de menos;
 *   - con cascada vacía se muestran todas las filas del nivel.
 */

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

const CUENTA = `P7-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ZONA = 'Europe/Lisbon';

/** Gasto fantasma: objetos que NO están en la jerarquía (algunos con campaña
 *  real, otros con ids inventados), para ejercitar la rama de solo-gasto. */
type GastoFantasma = {
  campaignId: string;
  adsetId: string;
  adId: string;
};

function genFantasmas(arbol: ArbolAds): fc.Arbitrary<GastoFantasma[]> {
  const campanias = arbol.campanias.map((c) => c.campaignId);
  const unFantasma = fc.oneof(
    // campaña real con conjunto fantasma
    fc
      .tuple(fc.constantFrom(...campanias), fc.uuid(), fc.uuid())
      .map(([campaignId, adsetId, adId]) => ({ campaignId, adsetId, adId })),
    // todo fantasma
    fc
      .tuple(fc.uuid(), fc.uuid(), fc.uuid())
      .map(([campaignId, adsetId, adId]) => ({ campaignId, adsetId, adId })),
  );
  return fc.array(unFantasma, { minLength: 0, maxLength: 12 });
}

async function sembrar(arbol: ArbolAds, fantasmas: GastoFantasma[], dia: string): Promise<void> {
  await q(
    `INSERT INTO ad_accounts (account_id, platform, name, currency, active, timezone)
     VALUES ($1, 'meta', 'test', 'EUR', true, $2)
     ON CONFLICT (account_id) DO UPDATE SET active = true, timezone = $2`,
    [CUENTA, ZONA],
  );
  await q('DELETE FROM ad_spend WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ads WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_sets WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_campaigns WHERE account_id = $1', [CUENTA]);

  // UN INSERT por tabla con unnest, en orden de FK. Antes era un insert por fila:
  // un árbol de 5x4x6 son ~180 round-trips por iteración y con 100 iteraciones la
  // propiedad se pasaba del timeout, la abortaban a mitad del sembrado y el test
  // siguiente fallaba con violación de ads_adset_id_fkey sobre datos parciales.
  const cIds = arbol.campanias.map((c) => c.campaignId);
  if (cIds.length > 0) {
    await q(
      `INSERT INTO ad_campaigns (campaign_id, account_id, name, status, effective_status,
                                 budget_level, currency, synced_at)
       SELECT u.cid, $2, 'Campaña ' || u.cid, 'ACTIVE', 'ACTIVE', 'adset', 'EUR', now()
         FROM unnest($1::text[]) AS u(cid)`,
      [cIds, CUENTA],
    );
  }

  const sIds: string[] = [];
  const sCamp: string[] = [];
  for (const c of arbol.campanias) {
    for (const s of c.conjuntos) {
      sIds.push(s.adsetId);
      sCamp.push(s.campaignId);
    }
  }
  if (sIds.length > 0) {
    await q(
      `INSERT INTO ad_sets (adset_id, campaign_id, account_id, name, status, effective_status,
                            currency, synced_at)
       SELECT u.sid, u.cid, $3, 'Conjunto ' || u.sid, 'ACTIVE', 'ACTIVE', 'EUR', now()
         FROM unnest($1::text[], $2::text[]) AS u(sid, cid)`,
      [sIds, sCamp, CUENTA],
    );
  }

  const aIds: string[] = [];
  const aSet: string[] = [];
  const aCamp: string[] = [];
  for (const c of arbol.campanias) {
    for (const s of c.conjuntos) {
      for (const a of s.anuncios) {
        aIds.push(a.adId);
        aSet.push(s.adsetId);
        aCamp.push(s.campaignId);
      }
    }
  }
  if (aIds.length > 0) {
    await q(
      `INSERT INTO ads (ad_id, adset_id, campaign_id, account_id, name, status,
                        effective_status, synced_at)
       SELECT u.aid, u.sid, u.cid, $4, 'Anuncio ' || u.aid, 'ACTIVE', 'ACTIVE', now()
         FROM unnest($1::text[], $2::text[], $3::text[]) AS u(aid, sid, cid)`,
      [aIds, aSet, aCamp, CUENTA],
    );
  }

  // Gasto de los objetos reales (un anuncio por conjunto) y de los fantasmas.
  const gCamp: string[] = [];
  const gSet: string[] = [];
  const gAd: string[] = [];
  for (const c of arbol.campanias) {
    for (const s of c.conjuntos) {
      if (s.anuncios.length === 0) continue;
      gCamp.push(c.campaignId);
      gSet.push(s.adsetId);
      gAd.push(s.anuncios[0]!.adId);
    }
  }
  if (gCamp.length > 0) {
    await q(
      `INSERT INTO ad_spend (platform, account_id, day, level, campaign_id, campaign_name,
                             adset_id, adset_name, ad_id, ad_name, spend, currency, spend_eur,
                             impressions, clicks, synced_at)
       SELECT 'meta', $4, $5::date, 'ad', u.cid, 'Campaña ' || u.cid, u.sid,
              'Conjunto ' || u.sid, u.aid, 'Anuncio ' || u.aid, 5, 'EUR', 5, 1, 1, now()
         FROM unnest($1::text[], $2::text[], $3::text[]) AS u(cid, sid, aid)`,
      [gCamp, gSet, gAd, CUENTA, dia],
    );
  }
  if (fantasmas.length > 0) {
    await q(
      `INSERT INTO ad_spend (platform, account_id, day, level, campaign_id, campaign_name,
                             adset_id, adset_name, ad_id, ad_name, spend, currency, spend_eur,
                             impressions, clicks, synced_at)
       SELECT 'meta', $4, $5::date, 'ad', u.cid, 'fantasma', u.sid, 'fantasma', u.aid,
              'fantasma', 7, 'EUR', 7, 1, 1, now()
         FROM unnest($1::text[], $2::text[], $3::text[]) AS u(cid, sid, aid)`,
      [
        fantasmas.map((f) => f.campaignId),
        fantasmas.map((f) => f.adsetId),
        fantasmas.map((f) => f.adId),
        CUENTA,
        dia,
      ],
    );
  }
}

async function todasSinCascada(level: 'adset' | 'ad'): Promise<string[]> {
  const out: string[] = [];
  let pagina = 1;
  for (;;) {
    const r = await getMetricasAds({
      level,
      period: 'today',
      accountIds: [CUENTA],
      page: pagina,
      limit: 1000,
    });
    out.push(...r.filas.map((f) => f.objectId));
    if (pagina >= r.totalPaginas) break;
    pagina += 1;
  }
  return out;
}

afterAll(async () => {
  if (!dbAvailable) return;
  await q('DELETE FROM ad_spend WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ads WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_sets WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_campaigns WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_accounts WHERE account_id = $1', [CUENTA]);
});

// Feature: gestion-campanas-anuncios, Property 7: La cascada contiene, nunca
// amplía
describe.skipIf(!dbAvailable)('Property 7 (R8 c3, c2, c15)', () => {
  it('para todo árbol y toda cascada, las filas mostradas son exactamente las filas sin cascada cuyos objetos descienden de los ids', async () => {
    await fc.assert(
      fc.asyncProperty(
        genArbolAds().chain((arbol) =>
          fc
            .tuple(
              genFantasmas(arbol),
              fc.constantFrom<'adset' | 'ad'>('adset', 'ad'),
              fc.array(fc.uuid(), { minLength: 1, maxLength: 50 }),
              fc.boolean(),
            )
            .map(([fantasmas, level, idsCascada, incluirConocida]) => ({
              arbol,
              fantasmas,
              level,
              idsCascada,
              incluirConocida,
            })),
        ),
        async ({ arbol, fantasmas, level, idsCascada, incluirConocida }) => {
          const dia = (await q1<{ hoy: string }>(
            `SELECT (now() AT TIME ZONE $1)::date::text AS hoy`,
            [ZONA],
          ))!.hoy;

          // la cascada puede incluir campañas reales del árbol (para que la
          // contención se ejercite de verdad) e ids inventados (que no matchean)
          const idsConocidos = arbol.campanias.map((c) => c.campaignId);
          const cascada: string[] = [];
          if (incluirConocida && idsConocidos.length > 0) {
            cascada.push(idsConocidos[Math.floor(Math.random() * idsConocidos.length)]!);
          }
          cascada.push(...idsCascada);
          // dedup, tope 50
          const cascadaFinal = Array.from(new Set(cascada)).slice(0, 50);

          await sembrar(arbol, fantasmas, dia);

          // el modelo: el resultado sin cascada filtrado por pertenencia
          const sinCascada = await todasSinCascada(level);
          const esperados = await (async (): Promise<string[]> => {
            if (cascadaFinal.length === 0) return sinCascada;
            if (level === 'adset') {
              // objetos del nivel con campaignId en la cascada
              const rows = await q(
                `SELECT DISTINCT o."objectId" FROM (
                   SELECT adset_id AS "objectId", campaign_id AS "campaignId" FROM ad_sets WHERE account_id = $1
                   UNION ALL
                   SELECT DISTINCT adset_id, campaign_id FROM ad_spend WHERE account_id = $1 AND adset_id <> ''
                 ) o WHERE o."campaignId" = ANY($2::text[])`,
                [CUENTA, cascadaFinal],
              );
              return sinCascada.filter((id) => rows.some((r) => r.objectId === id));
            }
            const rows = await q(
              `SELECT DISTINCT o."objectId" FROM (
                 SELECT ad_id AS "objectId", adset_id AS "adsetId" FROM ads WHERE account_id = $1
                 UNION ALL
                 SELECT DISTINCT ad_id, adset_id FROM ad_spend WHERE account_id = $1 AND ad_id <> ''
               ) o WHERE o."adsetId" = ANY($2::text[])`,
              [CUENTA, cascadaFinal],
            );
            return sinCascada.filter((id) => rows.some((r) => r.objectId === id));
          })();

          // con cascada
          const conCascada: string[] = [];
          let pagina = 1;
          for (;;) {
            const r = await getMetricasAds({
              level,
              period: 'today',
              accountIds: [CUENTA],
              ...(level === 'adset' ? { campaignIds: cascadaFinal } : { adsetIds: cascadaFinal }),
              page: pagina,
              limit: 1000,
            });
            conCascada.push(...r.filas.map((f) => f.objectId));
            if (pagina >= r.totalPaginas) break;
            pagina += 1;
          }

          // contención: nada que no descienda de la cascada
          expect(new Set(conCascada).size, 'sin repetidas').toBe(conCascada.length);
          // igualdad exacta contra el modelo
          expect(new Set(conCascada)).toEqual(new Set(esperados));
        },
      ),
      { numRuns: 100 },
    );
  });

  it('con cascada vacía se muestran todas las filas del nivel (R8 c15)', async () => {
    const arbol = fc.sample(genArbolAds(), { numRuns: 1, seed: 7 })[0]!;
    const dia = (await q1<{ hoy: string }>(
      `SELECT (now() AT TIME ZONE $1)::date::text AS hoy`,
      [ZONA],
    ))!.hoy;
    await sembrar(arbol, [], dia);
    const sinCascada = await todasSinCascada('adset');
    const vacia = await getMetricasAds({
      level: 'adset',
      period: 'today',
      accountIds: [CUENTA],
      campaignIds: [],
      page: 1,
      limit: 1000,
    });
    expect(new Set(vacia.filas.map((f) => f.objectId))).toEqual(new Set(sinCascada));
  });
});
