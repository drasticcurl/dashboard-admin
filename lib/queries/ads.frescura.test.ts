import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q, q1 } from '../db';
import { getMetricasAds } from './ads';
import type { NivelAds } from '../ads/tipos';

/**
 * Frescura de la Jerarquía en la fila (R3.1, task 7.2).
 *
 * El mapeo de `filaDesdeRow` ya lo cubre `ads.test.ts` con filas armadas a mano.
 * Lo que ese test NO puede ver es si el SELECT trae las columnas: una fila
 * literal siempre las tiene, y una fila de pg sólo las tiene si están en las
 * tres ramas de la jerarquía Y sobreviven a `base`, que enumera sus columnas una
 * por una. Por eso este archivo va contra la base.
 *
 * Dos casos por nivel, y los tres niveles porque son TRES fragmentos de SQL
 * distintos:
 *
 *   · objeto de la Jerarquía → `syncedAt` es su `synced_at` y `desaparecidoAt`
 *     su marca, los dos en ISO;
 *   · objeto con gasto y SIN fila en la Jerarquía (la rama `UNION ALL` con
 *     `gasto`) → los dos en `null`. Es la rama que se rompe primero, porque sus
 *     literales se escriben aparte de las columnas reales y nada obliga a que
 *     coincidan.
 *
 * TODOS los objetos se siembran con el MISMO `synced_at` a propósito. La regla
 * de vigencia (`SQL_VIGENTE`) compara el `synced_at` de cada objeto contra el
 * max de las CAMPAÑAS de su cuenta: mezclar un objeto viejo con uno recién
 * sincronizado sacaría al viejo de la jerarquía y el test miraría una fila que
 * la query nunca devuelve. Un objeto desaparecido conserva su `synced_at`
 * viejo, así que el caso realista es justamente éste: toda la cuenta con la
 * misma foto y la marca encima.
 */
if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}
const dbAvailable = Boolean(process.env.DATABASE_URL);
const CUENTA = `FRESC-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ZONA = 'Europe/Lisbon';

/** La foto de la cuenta: 5 días atrás, con milisegundos, para que la igualdad
 *  contra el ISO de vuelta no pase por redondeo. */
const SYNC = new Date(Date.now() - 5 * 86_400_000);
/** Las marcas de desaparición, POSTERIORES al sync (contrato de `tipos.ts`) y
 *  distintas entre niveles: si el SQL cruzara la columna de la campaña con la
 *  del conjunto, los valores no coincidirían y el test lo vería. */
const MARCA_CAMP = new Date(SYNC.getTime() + 1 * 86_400_000);
const MARCA_SET = new Date(SYNC.getTime() + 2 * 86_400_000);
const MARCA_AD = new Date(SYNC.getTime() + 3 * 86_400_000);

// Jerarquía: por nivel, uno marcado como desaparecido y uno presente.
const CAMP_MARCADA = '9101';
const CAMP_PRESENTE = '9102';
const SET_MARCADO = '8101';
const SET_PRESENTE = '8102';
const AD_MARCADO = '7101';
const AD_PRESENTE = '7102';

// Sólo en `ad_spend`: gasto de hoy sobre ids que no existen en la Jerarquía.
const CAMP_FANTASMA = '9199';
const SET_FANTASMA = '8199';
const AD_FANTASMA = '7199';

describe.skipIf(!dbAvailable)('getMetricasAds — frescura de la Jerarquía (R3.1)', () => {
  beforeAll(async () => {
    await q(
      `INSERT INTO ad_accounts (account_id, platform, name, currency, timezone, active)
       VALUES ($1, 'meta', 'cuenta de frescura', 'EUR', $2, true)
       ON CONFLICT (account_id) DO UPDATE SET timezone = $2, active = true`,
      [CUENTA, ZONA],
    );

    await q(
      `INSERT INTO ad_campaigns (campaign_id, account_id, name, status, effective_status,
                                 budget_level, currency, synced_at, desaparecido_at)
       SELECT u.cid, $1, 'C ' || u.cid, 'ACTIVE', 'ACTIVE', 'adset', 'EUR', $2::timestamptz,
              u.marca::timestamptz
         FROM unnest($3::text[], $4::text[]) AS u(cid, marca)`,
      [
        CUENTA,
        SYNC.toISOString(),
        [CAMP_MARCADA, CAMP_PRESENTE],
        [MARCA_CAMP.toISOString(), null],
      ],
    );

    await q(
      `INSERT INTO ad_sets (adset_id, campaign_id, account_id, name, status, effective_status,
                            currency, synced_at, desaparecido_at)
       SELECT u.sid, $2, $1, 'S ' || u.sid, 'ACTIVE', 'ACTIVE', 'EUR', $3::timestamptz,
              u.marca::timestamptz
         FROM unnest($4::text[], $5::text[]) AS u(sid, marca)`,
      [
        CUENTA,
        CAMP_PRESENTE,
        SYNC.toISOString(),
        [SET_MARCADO, SET_PRESENTE],
        [MARCA_SET.toISOString(), null],
      ],
    );

    await q(
      `INSERT INTO ads (ad_id, adset_id, campaign_id, account_id, name, status, effective_status,
                        synced_at, desaparecido_at)
       SELECT u.aid, $2, $3, $1, 'A ' || u.aid, 'ACTIVE', 'ACTIVE', $4::timestamptz,
              u.marca::timestamptz
         FROM unnest($5::text[], $6::text[]) AS u(aid, marca)`,
      [
        CUENTA,
        SET_PRESENTE,
        CAMP_PRESENTE,
        SYNC.toISOString(),
        [AD_MARCADO, AD_PRESENTE],
        [MARCA_AD.toISOString(), null],
      ],
    );

    // El gasto fantasma: una fila de hoy con ids que no están en ninguna de las
    // tres tablas de la Jerarquía. Produce una fila por nivel en la rama del
    // UNION ALL, que es la que este test viene a mirar.
    const dia = (await q1<{ hoy: string }>(
      `SELECT (now() AT TIME ZONE $1)::date::text AS hoy`,
      [ZONA],
    ))!.hoy;
    await q(
      `INSERT INTO ad_spend (platform, account_id, day, level, campaign_id, campaign_name,
                             adset_id, adset_name, ad_id, ad_name, spend, currency, spend_eur,
                             impressions, clicks, synced_at)
       VALUES ('meta', $1, $2::date, 'ad', $3, 'C fantasma', $4, 'S fantasma', $5, 'A fantasma',
               9, 'EUR', 9, 10, 1, now())`,
      [CUENTA, dia, CAMP_FANTASMA, SET_FANTASMA, AD_FANTASMA],
    );
  });

  afterAll(async () => {
    await q(`DELETE FROM ad_spend WHERE account_id = $1`, [CUENTA]);
    await q(`DELETE FROM ads WHERE account_id = $1`, [CUENTA]);
    await q(`DELETE FROM ad_sets WHERE account_id = $1`, [CUENTA]);
    await q(`DELETE FROM ad_campaigns WHERE account_id = $1`, [CUENTA]);
    await q(`DELETE FROM ad_accounts WHERE account_id = $1`, [CUENTA]);
  });

  async function porId(level: NivelAds): Promise<Map<string, { syncedAt: string | null; desaparecidoAt: string | null }>> {
    const r = await getMetricasAds({
      level,
      period: 'today',
      accountIds: [CUENTA],
      page: 1,
      limit: 100,
    });
    return new Map(
      r.filas.map((f) => [f.objectId, { syncedAt: f.syncedAt, desaparecidoAt: f.desaparecidoAt }]),
    );
  }

  const casos: Array<{
    level: NivelAds;
    marcado: string;
    presente: string;
    fantasma: string;
    marca: Date;
  }> = [
    { level: 'campaign', marcado: CAMP_MARCADA, presente: CAMP_PRESENTE, fantasma: CAMP_FANTASMA, marca: MARCA_CAMP },
    { level: 'adset', marcado: SET_MARCADO, presente: SET_PRESENTE, fantasma: SET_FANTASMA, marca: MARCA_SET },
    { level: 'ad', marcado: AD_MARCADO, presente: AD_PRESENTE, fantasma: AD_FANTASMA, marca: MARCA_AD },
  ];

  it.each(casos)(
    'nivel $level: el objeto de la Jerarquía trae synced_at y desaparecido_at en ISO',
    async ({ level, marcado, presente, marca }) => {
      const filas = await porId(level);

      // El objeto marcado NO desaparece de la tabla: se marca, no se borra (R3.5).
      const m = filas.get(marcado);
      expect(m, `la fila de ${marcado} tiene que estar`).toBeDefined();
      expect(m!.syncedAt).toBe(SYNC.toISOString());
      expect(m!.desaparecidoAt).toBe(marca.toISOString());
      // La marca es posterior al último sync confirmado: el objeto que no vino
      // no refresca su synced_at.
      expect(Date.parse(m!.desaparecidoAt!)).toBeGreaterThan(Date.parse(m!.syncedAt!));

      // El presente comparte el synced_at y no tiene marca.
      const p = filas.get(presente);
      expect(p, `la fila de ${presente} tiene que estar`).toBeDefined();
      expect(p!.syncedAt).toBe(SYNC.toISOString());
      expect(p!.desaparecidoAt).toBeNull();
    },
  );

  it.each(casos)(
    'nivel $level: el objeto con gasto y sin fila en la Jerarquía trae los dos campos en null',
    async ({ level, fantasma }) => {
      const filas = await porId(level);
      const f = filas.get(fantasma);
      expect(f, `la fila de solo-gasto ${fantasma} tiene que estar`).toBeDefined();
      expect(f!.syncedAt).toBeNull();
      expect(f!.desaparecidoAt).toBeNull();
    },
  );
});
