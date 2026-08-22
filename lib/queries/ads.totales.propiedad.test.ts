import fc from 'fast-check';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { q, q1 } from '../db';
import { getMetricasAds } from './ads';
import type { ClaveOrden, FiltrosAds, NivelAds, ResultadoMetricas } from '../ads/tipos';

/**
 * Property 9 (task 17.3): los totales no dependen de la paginación.
 *
 * **Validates: Requirements 7.1, 7.3**
 *
 * El smoke test del agregado vive en `ads.totales.test.ts` (task 17.1): 7 filas
 * de gasto, páginas de 3, cero ventas. Acá se verifica la propiedad completa —
 * para TODO filtro y TODO par de páginas de su resultado, `totales` es el mismo
 * objeto, y ese objeto es exactamente la suma de recorrer todas las páginas.
 *
 * ── Por qué el generador genera FILTROS y no páginas ──
 * Que dos páginas del mismo filtro coincidan es fácil de cumplir por accidente:
 * el agregado no lleva OFFSET, así que cualquier implementación que no mire la
 * página pasa. Lo que puede estar mal es SOBRE QUÉ corre el agregado. Cada
 * filtro vive en un lugar distinto de la cadena de CTEs:
 *
 *   status               → WHERE de la rama de jerarquía (uno por nivel)
 *   nombre / cascada     → WHERE de `base`
 *   ocultarPadreApagado  → WHERE de `base`
 *   ocultarSinDatos      → WHERE de `medidas`
 *
 * `ocultarSinDatos` es el que más pesa: es el único que vive en `medidas`, así
 * que un agregado calculado sobre `base` daría el mismo número que las filas en
 * todos los demás casos y se separaría EXACTAMENTE acá. `orderBy`/`orderDir` van
 * al otro lado: el total tiene que ser invariante bajo el orden, y un total que
 * cambia al reordenar significa que el agregado está viendo otro conjunto de
 * filas. Y los tres `level` son tres fragmentos de SQL distintos: el agregado
 * tiene que cerrar en los tres.
 *
 * ── Por qué la semilla es fija y el filtro varía ──
 * Sembrar por iteración cuesta 5 INSERT y la propiedad no gana nada: lo que se
 * verifica es la relación entre el agregado y las filas de UNA base, para muchos
 * filtros. La base se siembra una vez, con la variedad que los filtros necesitan
 * para morder: filas con gasto y sin ventas, con ventas y sin gasto, con las
 * dos, con ninguna (para que `ocultarSinDatos` tenga qué sacar), objetos activos
 * y pausados, objetos con `effective_status` CAMPAIGN_PAUSED y ADSET_PAUSED
 * (para que `ocultarPadreApagado` tenga qué sacar), gasto de objetos que NO
 * están en la jerarquía (la rama `UNION ALL` de `gasto`) y ventas atribuidas en
 * los tres niveles, para que `revenueEur`, `netEur`, `profitEur` y `sales` no
 * sean cero en todas las iteraciones.
 *
 * Quedan 11 filas a nivel campaña, 19 a nivel conjunto y 30 a nivel anuncio: lo
 * suficiente para que un filtro con estado y cascada siga sin entrar en una sola
 * página, que es la condición para que la propiedad tenga páginas que comparar.
 */
if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}
const dbAvailable = Boolean(process.env.DATABASE_URL);

/**
 * Marca de 9 dígitos: los ids de los objetos tienen que ser NUMÉRICOS y de 9+
 * dígitos para que `extraerIdDeUtm` los reconozca en los UTMs de las órdenes (si
 * no, no hay atribución y `revenueEur`/`sales` quedan en cero en toda la
 * propiedad, que es la mitad de los campos sin verificar). Y tienen que ser
 * ÚNICOS porque `ad_campaigns.campaign_id` es PK global, no por cuenta: otro
 * test corriendo en paralelo contra la misma base rompería el INSERT.
 */
const M = `${String(Date.now()).slice(-7)}${Math.floor(Math.random() * 90 + 10)}`;
const CUENTA = `TOTP-${M}`;
const FUENTE = `totp-${M}`; // `orders.source`, para poder limpiar sólo lo propio
const ZONA = 'Europe/Lisbon';

// ── Campañas: activas y pausadas, con gasto, con ventas, con las dos y con nada.
const C1 = `${M}101`; // PXN alfa — gasto (propio + fantasma), 1 venta
const C2 = `${M}102`; // PXN beta pausada — gasto, sin ventas
const C3 = `${M}103`; // zeta gamma — sin gasto, con ventas
const C4 = `${M}104`; // PXN delta pausada — gasto, 1 venta
const C5 = `${M}105`; // zeta epsilon — NI gasto NI ventas
const C6 = `${M}106`; // PXN omega — sin gasto, con ventas

// ── Conjuntos: los `effective_status` CAMPAIGN_PAUSED son los que hacen morder
//    a `ocultarPadreApagado`, y S3/S7 los tienen CON gasto (una fila con gasto
//    que el filtro esconde: el caso que separa el total de las filas).
const S1 = `${M}201`; // C1, ACTIVE   — gasto + venta
const S2 = `${M}202`; // C1, PAUSED   — gasto, sin ventas
const S3 = `${M}203`; // C2, CAMPAIGN_PAUSED — gasto
const S4 = `${M}204`; // C3, ACTIVE   — nada
const S5 = `${M}205`; // C3, PAUSED   — ventas sin gasto
const S6 = `${M}206`; // C4, CAMPAIGN_PAUSED — nada
const S7 = `${M}207`; // C4, CAMPAIGN_PAUSED — gasto + venta
const S8 = `${M}208`; // C6, ACTIVE   — ventas sin gasto
const S9 = `${M}209`; // C1, ACTIVE   — gasto

// ── Anuncios.
const A1 = `${M}301`; // S1 ACTIVE/ACTIVE          — gasto 7 + venta 50 + reembolso 20
const A2 = `${M}302`; // S2 ACTIVE/ADSET_PAUSED    — gasto 3
const A3 = `${M}303`; // S2 PAUSED/ADSET_PAUSED    — nada
const A4 = `${M}304`; // S3 ACTIVE/CAMPAIGN_PAUSED — gasto 5
const A5 = `${M}305`; // S4 ACTIVE/ACTIVE          — nada
const A6 = `${M}306`; // S5 PAUSED/ADSET_PAUSED    — venta 15 sin gasto
const A7 = `${M}307`; // S7 ACTIVE/CAMPAIGN_PAUSED — gasto 9 + venta 30
const A8 = `${M}308`; // S8 ACTIVE/ACTIVE          — venta 25 sin gasto
const A9 = `${M}309`; // S9 ACTIVE/ACTIVE          — gasto 4
const A10 = `${M}310`; // S9 PAUSED/PAUSED         — gasto 2, 0 clics (cpc null)
const A11 = `${M}311`; // S1 ACTIVE/ACTIVE         — nada
const A12 = `${M}312`; // S8 PAUSED/PAUSED         — nada

// ── Gasto de objetos SIN fila en la jerarquía (rama `UNION ALL` de `gasto`).
//    F2 cuelga de una campaña REAL: a nivel campaña suma a C1, y a nivel
//    conjunto/anuncio aparece como fila propia.
const CF = `${M}901`;
const SF1 = `${M}911`;
const AF1 = `${M}921`;
const SF2 = `${M}912`;
const AF2 = `${M}922`;

type FilaJerarquia = [id: string, padre: string, nombre: string, status: string, efectivo: string];

const CAMPANIAS: FilaJerarquia[] = [
  [C1, '', 'PXN alfa', 'ACTIVE', 'ACTIVE'],
  [C2, '', 'PXN beta pausada', 'PAUSED', 'PAUSED'],
  [C3, '', 'zeta gamma', 'ACTIVE', 'ACTIVE'],
  [C4, '', 'PXN delta pausada', 'PAUSED', 'PAUSED'],
  [C5, '', 'zeta epsilon sin datos', 'ACTIVE', 'WITH_ISSUES'],
  [C6, '', 'PXN omega sin gasto', 'ACTIVE', 'ACTIVE'],
];

const CONJUNTOS: FilaJerarquia[] = [
  [S1, C1, 'PXN conjunto uno', 'ACTIVE', 'ACTIVE'],
  [S2, C1, 'PXN conjunto dos', 'PAUSED', 'PAUSED'],
  [S3, C2, 'PXN conjunto tres', 'ACTIVE', 'CAMPAIGN_PAUSED'],
  [S4, C3, 'zeta conjunto cuatro', 'ACTIVE', 'ACTIVE'],
  [S5, C3, 'zeta conjunto cinco', 'PAUSED', 'PAUSED'],
  [S6, C4, 'PXN conjunto seis', 'ACTIVE', 'CAMPAIGN_PAUSED'],
  [S7, C4, 'PXN conjunto siete', 'PAUSED', 'CAMPAIGN_PAUSED'],
  [S8, C6, 'PXN conjunto ocho', 'ACTIVE', 'ACTIVE'],
  [S9, C1, 'omega conjunto nueve', 'ACTIVE', 'ACTIVE'],
];

const ANUNCIOS: FilaJerarquia[] = [
  [A1, S1, 'PXN anuncio uno', 'ACTIVE', 'ACTIVE'],
  [A2, S2, 'PXN anuncio dos', 'ACTIVE', 'ADSET_PAUSED'],
  [A3, S2, 'zeta anuncio tres', 'PAUSED', 'ADSET_PAUSED'],
  [A4, S3, 'PXN anuncio cuatro', 'ACTIVE', 'CAMPAIGN_PAUSED'],
  [A5, S4, 'zeta anuncio cinco', 'ACTIVE', 'ACTIVE'],
  [A6, S5, 'zeta anuncio seis', 'PAUSED', 'ADSET_PAUSED'],
  [A7, S7, 'PXN anuncio siete', 'ACTIVE', 'CAMPAIGN_PAUSED'],
  [A8, S8, 'PXN anuncio ocho', 'ACTIVE', 'ACTIVE'],
  [A9, S9, 'omega anuncio nueve', 'ACTIVE', 'ACTIVE'],
  [A10, S9, 'omega anuncio diez', 'PAUSED', 'PAUSED'],
  [A11, S1, 'PXN anuncio once', 'ACTIVE', 'ACTIVE'],
  [A12, S8, 'zeta anuncio doce', 'PAUSED', 'PAUSED'],
];

/**
 * Relleno: 4 campañas más, con 2 conjuntos cada una y 2 anuncios cada conjunto,
 * con estado, `effective_status`, nombre y gasto ciclados.
 *
 * No cubren ningún caso que las filas de arriba no cubran: existen para que un
 * filtro con `status` y cascada siga dejando MÁS DE UNA PÁGINA de resultado. Con
 * sólo las filas de arriba, la mayoría de los filtros generados entraba en una
 * sola página y la mitad (a) de la propiedad — la que compara páginas entre sí —
 * no se ejercitaba casi nunca.
 */
const RELLENO = (() => {
  const campanias: FilaJerarquia[] = [];
  const conjuntos: FilaJerarquia[] = [];
  const anuncios: FilaJerarquia[] = [];
  /** [adId, spendEur] */
  const gastos: Array<[string, number]> = [];
  const etiquetas = ['PXN relleno', 'zeta relleno', 'omega relleno', 'PXN relleno bis'];

  for (let i = 0; i < etiquetas.length; i++) {
    const cid = `${M}11${i}`;
    const campPausada = i % 2 === 1;
    const estadoCamp = campPausada ? 'PAUSED' : 'ACTIVE';
    campanias.push([cid, '', `${etiquetas[i]!} campaña`, estadoCamp, estadoCamp]);

    for (let j = 0; j < 2; j++) {
      const sid = `${M}2${20 + i * 2 + j}`;
      const setPausado = j === 1;
      conjuntos.push([
        sid,
        cid,
        `${etiquetas[i]!} conjunto ${j}`,
        setPausado ? 'PAUSED' : 'ACTIVE',
        // El `effective_status` que informa Meta: el padre manda.
        campPausada ? 'CAMPAIGN_PAUSED' : setPausado ? 'PAUSED' : 'ACTIVE',
      ]);

      for (let k = 0; k < 2; k++) {
        const aid = `${M}3${20 + (i * 2 + j) * 2 + k}`;
        const adPausado = k === 1;
        anuncios.push([
          aid,
          sid,
          `${etiquetas[i]!} anuncio ${j}${k}`,
          adPausado ? 'PAUSED' : 'ACTIVE',
          campPausada
            ? 'CAMPAIGN_PAUSED'
            : setPausado
              ? 'ADSET_PAUSED'
              : adPausado
                ? 'PAUSED'
                : 'ACTIVE',
        ]);
        // Gasto en la mitad: la otra mitad queda sin gasto y sin ventas, que es
        // lo que `ocultarSinDatos` saca.
        if ((i + j + k) % 2 === 0) gastos.push([aid, 1 + ((i * 4 + j * 2 + k) % 8)]);
      }
    }
  }
  return { campanias, conjuntos, anuncios, gastos };
})();

CAMPANIAS.push(...RELLENO.campanias);
CONJUNTOS.push(...RELLENO.conjuntos);
ANUNCIOS.push(...RELLENO.anuncios);

/** Padre de cada conjunto/anuncio, para armar las filas de `ad_spend`. */
const CAMP_DE_SET = new Map(CONJUNTOS.map(([id, padre]) => [id, padre]));
const SET_DE_AD = new Map(ANUNCIOS.map(([id, padre]) => [id, padre]));
const NOMBRE_DE = new Map(
  [...CAMPANIAS, ...CONJUNTOS, ...ANUNCIOS].map(([id, , nombre]) => [id, nombre]),
);

type FilaGasto = {
  campaignId: string;
  adsetId: string;
  adId: string;
  campaignName: string;
  adsetName: string;
  adName: string;
  spendEur: number;
  impressions: number;
  clicks: number;
};

/** El gasto de un anuncio de la jerarquía, con los ids y nombres de sus padres. */
function gastoDeAnuncio(adId: string, spendEur: number, impressions: number, clicks: number): FilaGasto {
  const adsetId = SET_DE_AD.get(adId)!;
  const campaignId = CAMP_DE_SET.get(adsetId)!;
  return {
    campaignId,
    adsetId,
    adId,
    campaignName: NOMBRE_DE.get(campaignId)!,
    adsetName: NOMBRE_DE.get(adsetId)!,
    adName: NOMBRE_DE.get(adId)!,
    spendEur,
    impressions,
    clicks,
  };
}

const GASTOS: FilaGasto[] = [
  gastoDeAnuncio(A1, 7, 700, 21),
  gastoDeAnuncio(A2, 3, 300, 9),
  gastoDeAnuncio(A4, 5, 500, 12),
  gastoDeAnuncio(A7, 9, 900, 18),
  gastoDeAnuncio(A9, 4, 400, 8),
  // 0 clics: `cpc` queda null y el orden por esa clave ejercita NULLS LAST.
  gastoDeAnuncio(A10, 2, 200, 0),
  // Fantasmas: sin fila en la jerarquía. F1 con la campaña también inventada,
  // F2 colgado de una campaña real.
  {
    campaignId: CF,
    adsetId: SF1,
    adId: AF1,
    campaignName: 'PXN fantasma campaña',
    adsetName: 'PXN fantasma conjunto',
    adName: 'PXN fantasma anuncio',
    spendEur: 11,
    impressions: 1100,
    clicks: 25,
  },
  {
    campaignId: C1,
    adsetId: SF2,
    adId: AF2,
    campaignName: 'PXN alfa',
    adsetName: 'zeta fantasma conjunto',
    adName: 'zeta fantasma anuncio',
    spendEur: 13,
    // 0 impresiones: `ctr`/`cpm` quedan null.
    impressions: 0,
    clicks: 0,
  },
  ...RELLENO.gastos.map(([adId, gasto]) => gastoDeAnuncio(adId, gasto, gasto * 100, gasto * 2)),
];

/**
 * Órdenes a sembrar. `nivel` dice a qué UTM va el id: la cascada de atribución
 * prefiere el anuncio, después el conjunto, después la campaña, y un id que no
 * matchea deja la orden sin atribuir. Con atribución a nivel anuncio la venta
 * sube sola al conjunto y a la campaña, así que los tres niveles ven ventas.
 */
type FilaOrden = {
  id: string;
  nivel: 'ad' | 'adset' | 'campaign' | 'nada';
  objeto: string;
  amountEur: number;
  status: string;
  comision: number;
  costo: number;
};

const ORDENES: FilaOrden[] = [
  { id: 'o1', nivel: 'ad', objeto: A1, amountEur: 50, status: 'approved', comision: 5, costo: 3 },
  // status <> 'approved': entra en `refundedEur` y NO cuenta como venta, así que
  // `netEur` no es una función de `revenueEur` y sumar mal se nota.
  { id: 'o2', nivel: 'ad', objeto: A1, amountEur: 20, status: 'refunded', comision: 0, costo: 0 },
  { id: 'o3', nivel: 'ad', objeto: A7, amountEur: 30, status: 'approved', comision: 2, costo: 1 },
  { id: 'o4', nivel: 'ad', objeto: A6, amountEur: 15, status: 'approved', comision: 1, costo: 0 },
  { id: 'o5', nivel: 'ad', objeto: A8, amountEur: 25, status: 'approved', comision: 0, costo: 2 },
  // Atribuida al conjunto: a nivel anuncio esta venta NO tiene fila (queda en
  // `sinAtribuir`), a nivel conjunto y campaña sí.
  { id: 'o6', nivel: 'adset', objeto: S5, amountEur: 40, status: 'approved', comision: 3, costo: 2 },
  { id: 'o7', nivel: 'campaign', objeto: C6, amountEur: 12, status: 'approved', comision: 1, costo: 1 },
  { id: 'o8', nivel: 'nada', objeto: '', amountEur: 9, status: 'approved', comision: 0, costo: 0 },
  // Dos ventas sobre el relleno, para que los subconjuntos grandes también
  // tengan `revenueEur` y `sales` distintos de cero.
  {
    id: 'o9',
    nivel: 'ad',
    objeto: RELLENO.anuncios[0]![0],
    amountEur: 18,
    status: 'approved',
    comision: 2,
    costo: 1,
  },
  {
    id: 'o10',
    nivel: 'adset',
    objeto: RELLENO.conjuntos[5]![0],
    amountEur: 22,
    status: 'approved',
    comision: 0,
    costo: 3,
  },
];

const utmDe = (o: FilaOrden, nivel: FilaOrden['nivel']): string =>
  o.nivel === nivel ? `atribucion|${o.objeto}` : '(directo)';

describe.skipIf(!dbAvailable)('Property 9 — totales del filtro, no de la página (R7.1, R7.3)', () => {
  beforeAll(async () => {
    await q(
      `INSERT INTO ad_accounts (account_id, platform, name, currency, timezone, active)
       VALUES ($1, 'meta', 'cuenta de la Property 9', 'EUR', $2, true)
       ON CONFLICT (account_id) DO UPDATE SET timezone = $2, active = true`,
      [CUENTA, ZONA],
    );

    const dia = (await q1<{ hoy: string }>(`SELECT (now() AT TIME ZONE $1)::date::text AS hoy`, [
      ZONA,
    ]))!.hoy;

    // Un INSERT por tabla con unnest, en orden de FK: la jerarquía tiene
    // ON DELETE CASCADE y FKs reales, así que el orden importa.
    await q(
      `INSERT INTO ad_campaigns (campaign_id, account_id, name, status, effective_status,
                                 budget_level, daily_budget, currency, synced_at)
       SELECT u.id, $1, u.nombre, u.st, u.est, 'adset', 2500, 'EUR', now()
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS u(id, nombre, st, est)`,
      [
        CUENTA,
        CAMPANIAS.map((c) => c[0]),
        CAMPANIAS.map((c) => c[2]),
        CAMPANIAS.map((c) => c[3]),
        CAMPANIAS.map((c) => c[4]),
      ],
    );
    await q(
      `INSERT INTO ad_sets (adset_id, campaign_id, account_id, name, status, effective_status,
                            daily_budget, currency, synced_at)
       SELECT u.id, u.padre, $1, u.nombre, u.st, u.est, 1500, 'EUR', now()
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
              AS u(id, padre, nombre, st, est)`,
      [
        CUENTA,
        CONJUNTOS.map((s) => s[0]),
        CONJUNTOS.map((s) => s[1]),
        CONJUNTOS.map((s) => s[2]),
        CONJUNTOS.map((s) => s[3]),
        CONJUNTOS.map((s) => s[4]),
      ],
    );
    await q(
      `INSERT INTO ads (ad_id, adset_id, campaign_id, account_id, name, status,
                        effective_status, synced_at)
       SELECT u.id, u.padre, u.abuelo, $1, u.nombre, u.st, u.est, now()
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
              AS u(id, padre, abuelo, nombre, st, est)`,
      [
        CUENTA,
        ANUNCIOS.map((a) => a[0]),
        ANUNCIOS.map((a) => a[1]),
        ANUNCIOS.map((a) => CAMP_DE_SET.get(a[1])!),
        ANUNCIOS.map((a) => a[2]),
        ANUNCIOS.map((a) => a[3]),
        ANUNCIOS.map((a) => a[4]),
      ],
    );
    await q(
      `INSERT INTO ad_spend (platform, account_id, day, level, campaign_id, campaign_name,
                             adset_id, adset_name, ad_id, ad_name, spend, currency, spend_eur,
                             impressions, clicks, synced_at)
       SELECT 'meta', $1, $2::date, 'ad', u.cid, u.cn, u.sid, u.sn, u.aid, u.an,
              u.gasto, 'EUR', u.gasto, u.imp, u.cl, now()
         FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
                     $9::numeric[], $10::bigint[], $11::bigint[])
              AS u(cid, sid, aid, cn, sn, an, gasto, imp, cl)`,
      [
        CUENTA,
        dia,
        GASTOS.map((g) => g.campaignId),
        GASTOS.map((g) => g.adsetId),
        GASTOS.map((g) => g.adId),
        GASTOS.map((g) => g.campaignName),
        GASTOS.map((g) => g.adsetName),
        GASTOS.map((g) => g.adName),
        GASTOS.map((g) => g.spendEur),
        GASTOS.map((g) => g.impressions),
        GASTOS.map((g) => g.clicks),
      ],
    );
    // `funnel_id` en NULL a propósito: la FK apunta a `funnels` y este test no
    // necesita un funnel para nada.
    await q(
      `INSERT INTO orders (funnel_id, source, external_id, email, status, tier, amount, currency,
                           amount_eur, utm_source, utm_campaign, utm_medium, utm_content,
                           purchased_at, day, commission_amount, commission_amount_eur,
                           cost_amount, cost_amount_eur)
       SELECT NULL::smallint, $1, u.eid, 'p9@test', u.st, 'front', u.monto, 'EUR', u.monto,
              '(directo)', u.ucamp, u.umed, u.ucont, now(), $2::date,
              u.com, u.com, u.cost, u.cost
         FROM unnest($3::text[], $4::text[], $5::numeric[], $6::text[], $7::text[], $8::text[],
                     $9::numeric[], $10::numeric[])
              AS u(eid, st, monto, ucamp, umed, ucont, com, cost)`,
      [
        FUENTE,
        dia,
        ORDENES.map((o) => o.id),
        ORDENES.map((o) => o.status),
        ORDENES.map((o) => o.amountEur),
        ORDENES.map((o) => utmDe(o, 'campaign')),
        ORDENES.map((o) => utmDe(o, 'adset')),
        ORDENES.map((o) => utmDe(o, 'ad')),
        ORDENES.map((o) => o.comision),
        ORDENES.map((o) => o.costo),
      ],
    );
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await q(`DELETE FROM orders WHERE source = $1`, [FUENTE]);
    await q(`DELETE FROM ad_spend WHERE account_id = $1`, [CUENTA]);
    await q(`DELETE FROM ads WHERE account_id = $1`, [CUENTA]);
    await q(`DELETE FROM ad_sets WHERE account_id = $1`, [CUENTA]);
    await q(`DELETE FROM ad_campaigns WHERE account_id = $1`, [CUENTA]);
    await q(`DELETE FROM ad_accounts WHERE account_id = $1`, [CUENTA]);
  });

  const pedir = (extra: Partial<FiltrosAds>): Promise<ResultadoMetricas> =>
    getMetricasAds({
      level: 'ad',
      period: 'today',
      accountIds: [CUENTA],
      status: 'any',
      ...extra,
    });

  /** Recorre TODAS las páginas del filtro. Devuelve una entrada por página, en
   *  orden. Un filtro sin filas devuelve una sola página vacía (`totalPaginas`
   *  es 0 porque sale de un `count(*) OVER ()` de la query de filas). */
  async function recorrerPaginas(filtro: Partial<FiltrosAds>): Promise<ResultadoMetricas[]> {
    const paginas: ResultadoMetricas[] = [];
    for (let pagina = 1; ; pagina++) {
      const r = await pedir({ ...filtro, page: pagina });
      paginas.push(r);
      if (pagina >= r.totalPaginas) break;
      // Cota de seguridad: a lo sumo 30 filas sembradas y limit >= 2 son 15
      // páginas, así que 40 no se alcanza nunca con un recorrido que avanza. Sin
      // esta cota, uno que no avanzara colgaría el test en lugar de fallarlo.
      expect(pagina, 'el recorrido de páginas no termina').toBeLessThan(40);
    }
    return paginas;
  }

  // ── Los ejemplos ────────────────────────────────────────────────────────

  it('con más filas que la página, el total es el del filtro y no el de la página visible', async () => {
    const paginas = await recorrerPaginas({ level: 'ad', limit: 4 });
    const todas = paginas.flatMap((p) => p.filas);

    expect(paginas.length).toBeGreaterThan(1);
    expect(paginas[0]!.filas).toHaveLength(4);

    // El bug de producción: la barra de KPIs reducía `data.filas`. La suma de la
    // primera página NO puede coincidir con el total, o el ejemplo no prueba nada.
    const sumaPrimera = paginas[0]!.filas.reduce((a, f) => a + f.spendEur, 0);
    const sumaTodas = todas.reduce((a, f) => a + f.spendEur, 0);
    expect(sumaPrimera).not.toBeCloseTo(sumaTodas, 6);
    expect(paginas[0]!.totales.spendEur).toBeCloseTo(sumaTodas, 6);
    expect(paginas[0]!.totales.filas).toBe(todas.length);

    // Y las ventas atribuidas llegan al agregado: sin esto, cuatro de los seis
    // campos serían cero en todo el archivo y no estarían verificados.
    expect(paginas[0]!.totales.sales).toBeGreaterThan(0);
    expect(paginas[0]!.totales.revenueEur).toBeGreaterThan(0);
    expect(paginas[0]!.totales.netEur).toBeCloseTo(
      todas.reduce((a, f) => a + f.netEur, 0),
      6,
    );
  });

  it('ocultarSinDatos mueve el total: el agregado corre sobre lo que la tabla muestra', async () => {
    // El filtro que distingue un agregado sobre `medidas` de uno sobre `base`.
    // Saca filas SIN gasto y SIN ventas, así que `filas` baja y `spendEur` no.
    const con = await recorrerPaginas({ level: 'ad', limit: 100, ocultarSinDatos: true });
    const sin = await recorrerPaginas({ level: 'ad', limit: 100 });

    expect(con[0]!.totales.filas).toBeLessThan(sin[0]!.totales.filas);
    expect(con[0]!.totales.filas).toBe(con.flatMap((p) => p.filas).length);
    // Ninguna fila con gasto se oculta nunca, así que el gasto total no se mueve.
    expect(con[0]!.totales.spendEur).toBeCloseTo(sin[0]!.totales.spendEur, 6);
  });

  // ── La propiedad ────────────────────────────────────────────────────────

  /** Claves de orden que la semilla ejercita de verdad: sumas, textos, cocientes
   *  con y sin nulos, y una columna que es null en todas las filas. */
  const CLAVES: ClaveOrden[] = [
    'gastos',
    'ingresos',
    'ganancia',
    'ventas',
    'nombre',
    'estado',
    'roi',
    'cpa',
    'cpc',
    'impresiones',
    'presupuesto',
    'ultimaActualizacion',
  ];

  const IDS_CAMPANIAS = CAMPANIAS.map((c) => c[0]);
  const IDS_CONJUNTOS = CONJUNTOS.map((s) => s[0]);
  /** Los conjuntos de cada campaña, para poder generar una cascada COHERENTE. */
  const SETS_DE_CAMP = new Map<string, string[]>(IDS_CAMPANIAS.map((c) => [c, []]));
  for (const [id, padre] of CONJUNTOS) SETS_DE_CAMP.get(padre)!.push(id);

  type Cascada = { campaignIds?: string[]; adsetIds?: string[] };

  /**
   * La cascada se genera por FORMAS y no como dos arrays independientes. Las dos
   * listas se combinan en conjunción, así que dos subconjuntos al azar se
   * contradicen casi siempre y el filtro da cero filas: un caso válido (todos
   * los totales en cero) pero que no verifica nada sobre la suma, y con dos
   * arrays independientes se comía la mitad de las iteraciones.
   */
  const genCascada = (level: NivelAds): fc.Arbitrary<Cascada> =>
    fc.oneof(
      { weight: 6, arbitrary: fc.constant<Cascada>({}) },
      // Arrays vacíos: `cardinality = 0` apaga el filtro, y es un camino
      // distinto del parámetro ausente (R8 c15).
      { weight: 1, arbitrary: fc.constant<Cascada>({ campaignIds: [], adsetIds: [] }) },
      {
        // Subconjuntos grandes: uno de una sola campaña recorta el resultado a
        // dos o tres filas y entra en una página, así que la comparación entre
        // páginas no llega a pasar por acá.
        weight: 5,
        arbitrary: fc
          .shuffledSubarray(IDS_CAMPANIAS, { minLength: 3, maxLength: IDS_CAMPANIAS.length })
          .map((campaignIds) => ({ campaignIds })),
      },
      {
        // A nivel campaña el `adsetId` de todas las filas de la jerarquía es '',
        // así que una cascada de conjuntos da cero filas siempre.
        weight: level === 'campaign' ? 0 : 4,
        arbitrary: fc
          .shuffledSubarray(IDS_CONJUNTOS, { minLength: 4, maxLength: IDS_CONJUNTOS.length })
          .map((adsetIds) => ({ adsetIds })),
      },
      {
        // Las dos listas a la vez, coherentes: una campaña y sus conjuntos.
        weight: 2,
        arbitrary: fc.constantFrom(...IDS_CAMPANIAS).map((cid) => ({
          campaignIds: [cid],
          adsetIds: SETS_DE_CAMP.get(cid)!,
        })),
      },
      {
        // Sólo objetos que NO están en la jerarquía: la rama `UNION ALL`.
        weight: 1,
        arbitrary: fc.constantFrom<Cascada>({ campaignIds: [CF] }, { adsetIds: [SF1, SF2] }),
      },
    );

  /** Un filtro completo. `undefined` (ausente) y no sólo el valor: los caminos
   *  de "sin filtro" son parámetros distintos en el SQL. */
  const genFiltro = (): fc.Arbitrary<Partial<FiltrosAds>> =>
    fc.constantFrom<NivelAds>('campaign', 'adset', 'ad').chain((level) =>
      fc
        .record({
          status: fc.constantFrom<'active' | 'paused' | 'any'>('active', 'paused', 'any'),
          ocultarSinDatos: fc.boolean(),
          ocultarPadreApagado: fc.boolean(),
          // Substrings presentes en los nombres de los TRES niveles, más
          // 'fantasma', que deja sólo las filas de la rama `UNION ALL`, más uno
          // que no matchea nada (filtro vacío, caso válido).
          nombre: fc.oneof(
            { weight: 6, arbitrary: fc.constant(undefined) },
            { weight: 5, arbitrary: fc.constantFrom('PXN', 'zeta', 'omega') },
            // 'fantasma' deja SÓLO las filas de la rama `UNION ALL` (son pocas) y
            // 'no-matchea-nada' deja el filtro vacío: los dos son casos válidos
            // pero de una sola página, así que van con peso bajo.
            { weight: 1, arbitrary: fc.constantFrom('fantasma', 'no-matchea-nada') },
          ),
          cascada: genCascada(level),
          orderBy: fc.constantFrom(...CLAVES),
          orderDir: fc.constantFrom<'asc' | 'desc'>('asc', 'desc'),
          // Chico a propósito: el interés está en que el filtro NO entre en una
          // sola página, y un filtro con `status` y cascada deja subconjuntos de
          // pocas filas. Con este rango y la semilla completa (11 filas a nivel
          // campaña, 19 a nivel conjunto, 30 a nivel anuncio) la mayoría de los
          // filtros generados tiene dos páginas o más.
          limit: fc.integer({ min: 2, max: 5 }),
        })
        .map(({ cascada, ...resto }) => ({ level, ...resto, ...cascada })),
    );

  // Feature: frescura-y-acciones-anuncios, Property 9: los totales no dependen
  // de la paginación
  it(
    'para todo filtro, los totales son idénticos en todas sus páginas e iguales a la suma de recorrerlas',
    async () => {
      await fc.assert(
        fc.asyncProperty(genFiltro(), async (filtro) => {
          const paginas = await recorrerPaginas(filtro);
          const primera = paginas[0]!;

          // (a) el total es una función del filtro, no de la página (R7.3).
          for (const p of paginas.slice(1)) {
            expect(p.totales, `página ${p.pagina}`).toEqual(primera.totales);
          }

          // La cola de la query tiene DOS ramas con parámetros propios
          // (offset/limit con `page`, after/limit sin él) y el agregado corre con
          // un slice del array compartido. Pedir sin `page` ejercita la otra
          // rama con el mismo filtro: si el slice quedara mal, Postgres tira en
          // el bind.
          const conCursor = await pedir({ ...filtro, page: undefined });
          expect(conCursor.totales, 'rama del cursor `after`').toEqual(primera.totales);

          // (b) y ese total es exactamente lo que se junta recorriendo todo (R7.1).
          const todas = paginas.flatMap((p) => p.filas);
          const suma = (f: (fila: (typeof todas)[number]) => number): number =>
            todas.reduce((a, fila) => a + f(fila), 0);

          expect(new Set(todas.map((f) => f.objectId)).size, 'sin filas repetidas').toBe(
            todas.length,
          );
          expect(primera.totales.filas).toBe(todas.length);
          expect(primera.totales.sales).toBe(suma((f) => f.sales));
          expect(primera.totales.spendEur).toBeCloseTo(suma((f) => f.spendEur), 6);
          expect(primera.totales.revenueEur).toBeCloseTo(suma((f) => f.revenueEur), 6);
          expect(primera.totales.netEur).toBeCloseTo(suma((f) => f.netEur), 6);
          expect(primera.totales.profitEur).toBeCloseTo(suma((f) => f.profitEur), 6);
        }),
        // 60 iteraciones. Cada una recorre TODAS las páginas del filtro y cada
        // página son tres consultas, así que el costo crece con `numRuns` mucho
        // más rápido que en una propiedad pura y el número no es gratis.
        //
        // 60 es lo que le da varias muestras a cada celda de la grilla que
        // importa — 3 niveles × 3 estados × 4 combinaciones de los interruptores
        // de ruido son 36 celdas. Medido sobre la distribución de arriba: de 60
        // iteraciones, 30 dan resultados de más de una página (que es donde la
        // mitad (a) de la propiedad tiene algo que comparar), 38 dan ventas
        // atribuidas distintas de cero y 7 dan el filtro vacío. Corre en ~1,5 s
        // contra Postgres local.
        { numRuns: 60 },
      );
    },
    // La base es compartida con el resto de la suite: bajo contención el default
    // de 30 s no alcanza para 60 iteraciones, y un timeout acá se leería como un
    // fallo de la propiedad, que es el diagnóstico equivocado.
    180_000,
  );
});
