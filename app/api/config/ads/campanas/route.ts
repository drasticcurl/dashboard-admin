/**
 * /api/config/ads/campanas — a qué funnel se le imputa el gasto de cada CAMPAÑA
 * (migración 033).
 *
 * ── POR QUÉ EXISTE ────────────────────────────────────────────────────────
 * `/api/config/ads` asigna la cuenta entera a un funnel, y eso alcanzaba
 * mientras cada funnel tuviera su propia cuenta publicitaria. Desde el
 * 2026-09-14 la cuenta de Chau Hinchazón corre además campañas de LATAM (y va a
 * correr las de gelatina): su gasto se imputaba completo al funnel 1, así que AR
 * pagaba el gasto de LATAM y LATAM aparecía con €0 y ROI infinito.
 *
 * Este endpoint escribe las EXCEPCIONES. Una campaña sin fila hereda el funnel de
 * su cuenta, que es el comportamiento anterior: con la tabla vacía nada cambia.
 *
 * ── LAS DOS COSAS QUE HACE ADEMÁS DE GUARDAR ──────────────────────────────
 * 1. Reimputa `ad_spend` de esa campaña (histórico incluido), igual que el POST
 *    de cuentas ya hacía por cuenta. Sin esto el mapeo solo valdría para el
 *    gasto que entre después y los dos totales quedarían mal sin ninguna señal.
 * 2. Recorre el rollup del rango afectado. `daily_metrics.ad_spend_eur` es un
 *    agregado CONGELADO: sin recomputarlo, Resumen, el brief de IA y la
 *    reconciliación siguen mostrando la imputación vieja hasta que pase el cron
 *    diario de 35 días. Es el paso que es fácil olvidarse.
 *
 * ── EL GET TRAE EL DETECTOR DE DISCREPANCIA ───────────────────────────────
 * Por cada campaña dice de qué funnels son las ventas que se le atribuyeron por
 * UTM. Si una campaña imputada a `chauhinchazon` vendió 7 veces y las 7 ventas
 * son de `gelatina`, el mapeo está mal y se ve sin leer SQL. NO se usa para
 * imputar automáticamente: una campaña que gastó y no vendió no tendría funnel, y
 * ese es justamente el gasto que hay que mirar (ver la migración 033).
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { q, q1 } from '@/lib/db';
import { EXTRAE_SQL } from '@/lib/queries/ads';
import { rollupRange } from '@/scripts/rollup';
import { guard, json, parseJson } from '../../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Ventana de gasto y de ventas que se muestra para decidir el mapeo. */
const DIAS_VENTANA = 30;

const postSchema = z.object({
  accountId: z.string().min(3).max(64),
  // El id de campaña de Meta es numérico y largo ('120249504324770617'). Se pide
  // como string: en JS un entero de 18 dígitos ya no es exacto.
  campaignId: z.string().min(6).max(64).regex(/^\d+$/),
  // null = borrar la excepción y volver a heredar el funnel de la cuenta.
  funnelId: z.number().int().positive().nullable(),
  nota: z.string().max(500).nullable().optional(),
});

export type CampaniaFunnelRow = {
  campaignId: string;
  campaignName: string | null;
  status: string | null;
  effectiveStatus: string | null;
  /** Puesto cuando Meta dejó de devolver la campaña (migración 025). */
  desaparecidoAt: string | null;
  /** El mapeo explícito, o null si hereda. */
  funnelId: number | null;
  funnelName: string | null;
  nota: string | null;
  /** El funnel que se está usando de verdad: el mapeo o el de la cuenta. */
  funnelEfectivoId: number | null;
  funnelEfectivoName: string | null;
  spendEur: number;
  ultimoDia: string | null;
  /** Detector: ventas atribuidas a esta campaña, por funnel. */
  ventasPorFunnel: Array<{ funnelId: number | null; funnelName: string; ventas: number }>;
};

type RowRaw = Omit<CampaniaFunnelRow, 'spendEur' | 'ultimoDia' | 'ventasPorFunnel'> & {
  spendEur: string;
  ultimoDia: Date | string | null;
  ventasPorFunnel: Array<{ funnelId: number | null; funnelName: string | null; ventas: number }> | null;
};

function dia(v: Date | string | null): string | null {
  if (v === null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const y = v.getFullYear();
  const m = String(v.getMonth() + 1).padStart(2, '0');
  const d = String(v.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export async function GET(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const accountId = req.nextUrl.searchParams.get('accountId');
  if (!accountId) return json(400, { ok: false, error: 'missing_params', detail: 'accountId' });
  const buscar = req.nextUrl.searchParams.get('q');

  const cuenta = await q1<{ funnelId: number | null; funnelName: string | null }>(
    `SELECT a.funnel_id AS "funnelId", f.name AS "funnelName"
       FROM ad_accounts a LEFT JOIN funnels f ON f.id = a.funnel_id
      WHERE a.account_id = $1`,
    [accountId],
  );
  if (!cuenta) return json(404, { ok: false, error: 'unknown_account' });

  // Las campañas salen del espejo de la jerarquía Y del gasto: una campaña que
  // gastó pero que el sync de la jerarquía todavía no trajo (corre cada 15 min,
  // el de gasto cada hora) tiene que poder mapearse igual. Es la misma idea que
  // la rama de "solo gasto" del UNION de lib/queries/ads.ts.
  const rows = await q<RowRaw>(
    `WITH campanias AS (
       SELECT c.campaign_id, c.name, c.status, c.effective_status, c.desaparecido_at
         FROM ad_campaigns c
        WHERE c.account_id = $1
       UNION
       SELECT s.campaign_id, max(s.campaign_name), NULL, NULL, NULL
         FROM ad_spend s
        WHERE s.account_id = $1 AND s.campaign_id <> ''
          AND NOT EXISTS (SELECT 1 FROM ad_campaigns c2 WHERE c2.campaign_id = s.campaign_id)
        GROUP BY s.campaign_id
     ),
     gasto AS (
       SELECT s.campaign_id,
              sum(s.spend_eur) AS spend_eur,
              max(s.day) AS ultimo_dia
         FROM ad_spend s
        WHERE s.account_id = $1
          AND s.campaign_id <> ''
          AND s.day >= (current_date - $2::int)
        GROUP BY s.campaign_id
     ),
     ventas AS (
       -- Las ventas se cruzan con la campaña por el ID que viene en el UTM, con
       -- la MISMA expresión que usa la pantalla de Anuncios (se importa, no se
       -- copia: dos regex que tienen que coincidir siempre terminan divergiendo).
       SELECT cid AS campaign_id, funnel_id, funnel_name, count(*)::int AS ventas
         FROM (
           SELECT ${EXTRAE_SQL('o.utm_campaign')} AS cid, o.funnel_id,
                  COALESCE(f.name, '(sin funnel)') AS funnel_name
             FROM orders o
             LEFT JOIN funnels f ON f.id = o.funnel_id
            WHERE o.status = 'approved'
              AND o.purchased_at >= (current_date - $2::int)::timestamptz
         ) x
        WHERE cid IS NOT NULL
        GROUP BY cid, funnel_id, funnel_name
     )
     SELECT c.campaign_id AS "campaignId", c.name AS "campaignName",
            c.status, c.effective_status AS "effectiveStatus",
            c.desaparecido_at AS "desaparecidoAt",
            m.funnel_id AS "funnelId", fm.name AS "funnelName", m.nota,
            COALESCE(m.funnel_id, $3::smallint) AS "funnelEfectivoId",
            COALESCE(fm.name, $4::text) AS "funnelEfectivoName",
            COALESCE(g.spend_eur, 0)::text AS "spendEur",
            g.ultimo_dia AS "ultimoDia",
            (SELECT json_agg(json_build_object('funnelId', v.funnel_id,
                                               'funnelName', v.funnel_name,
                                               'ventas', v.ventas)
                             ORDER BY v.ventas DESC)
               FROM ventas v WHERE v.campaign_id = c.campaign_id) AS "ventasPorFunnel"
       FROM campanias c
       LEFT JOIN ad_campaign_funnel m ON m.campaign_id = c.campaign_id
       LEFT JOIN funnels fm ON fm.id = m.funnel_id
       LEFT JOIN gasto g ON g.campaign_id = c.campaign_id
      WHERE ($5::text IS NULL OR c.name ILIKE '%' || $5 || '%' OR c.campaign_id = $5)
      ORDER BY COALESCE(g.spend_eur, 0) DESC, c.name NULLS LAST`,
    [accountId, DIAS_VENTANA, cuenta.funnelId, cuenta.funnelName, buscar && buscar.trim() !== '' ? buscar.trim() : null],
  );

  return json(200, {
    ok: true,
    accountId,
    cuentaFunnelId: cuenta.funnelId,
    cuentaFunnelName: cuenta.funnelName,
    dias: DIAS_VENTANA,
    campanias: rows.map((r) => ({
      ...r,
      spendEur: Number(r.spendEur),
      ultimoDia: dia(r.ultimoDia),
      desaparecidoAt: r.desaparecidoAt,
      ventasPorFunnel: (r.ventasPorFunnel ?? []).map((v) => ({
        funnelId: v.funnelId,
        funnelName: v.funnelName ?? '(sin funnel)',
        ventas: v.ventas,
      })),
    })),
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const denied = await guard(req);
  if (denied) return denied;

  const parsed = postSchema.safeParse(await parseJson(req));
  if (!parsed.success) {
    return json(400, { ok: false, error: 'invalid_payload', detail: parsed.error.issues[0]?.message });
  }
  const { campaignId, funnelId, nota } = parsed.data;
  const accountId = parsed.data.accountId.startsWith('act_')
    ? parsed.data.accountId
    : `act_${parsed.data.accountId}`;

  const cuenta = await q1<{ funnelId: number | null }>(
    `SELECT funnel_id AS "funnelId" FROM ad_accounts WHERE account_id = $1`,
    [accountId],
  );
  if (!cuenta) return json(404, { ok: false, error: 'unknown_account' });

  // La campaña tiene que existir en el espejo o en el gasto de ESA cuenta: sin
  // este chequeo, un id mal tipeado se guarda como un mapeo que no imputa nada y
  // no hay forma de darse cuenta mirando la pantalla.
  const existe = await q1<{ ok: boolean }>(
    `SELECT true AS ok
       WHERE EXISTS (SELECT 1 FROM ad_campaigns WHERE campaign_id = $1 AND account_id = $2)
          OR EXISTS (SELECT 1 FROM ad_spend WHERE campaign_id = $1 AND account_id = $2)`,
    [campaignId, accountId],
  );
  if (!existe) return json(404, { ok: false, error: 'unknown_campaign' });

  if (funnelId !== null) {
    const f = await q1<{ id: number }>('SELECT id FROM funnels WHERE id = $1', [funnelId]);
    if (!f) return json(404, { ok: false, error: 'unknown_funnel' });
  }

  // El nombre se guarda como rótulo (para leer el mapeo dentro de seis meses),
  // nunca para resolver: eso lo hace el id.
  const nombre = await q1<{ name: string | null }>(
    `SELECT COALESCE((SELECT name FROM ad_campaigns WHERE campaign_id = $1),
                     (SELECT max(campaign_name) FROM ad_spend WHERE campaign_id = $1)) AS name`,
    [campaignId],
  );

  if (funnelId === null) {
    await q('DELETE FROM ad_campaign_funnel WHERE campaign_id = $1', [campaignId]);
  } else {
    await q(
      `INSERT INTO ad_campaign_funnel (campaign_id, funnel_id, account_id, campaign_name, nota)
       VALUES ($1, $2::smallint, $3, $4, $5)
       ON CONFLICT (campaign_id) DO UPDATE SET
         funnel_id = EXCLUDED.funnel_id,
         account_id = EXCLUDED.account_id,
         campaign_name = COALESCE(EXCLUDED.campaign_name, ad_campaign_funnel.campaign_name),
         nota = EXCLUDED.nota,
         updated_at = now()`,
      [campaignId, funnelId, accountId, nombre?.name ?? null, nota ?? null],
    );
  }

  // El funnel que corresponde ahora a las filas de gasto de esta campaña: el
  // mapeo nuevo, o el de la cuenta si se borró la excepción. Es la misma cascada
  // que aplica el sync (lib/ads/sync.ts).
  const efectivo = funnelId ?? cuenta.funnelId;

  // Se reimputa por campaign_id y no por (campaign_id, account_id): el id de
  // campaña es único en Meta, y si alguna fila vieja quedó con otra cuenta igual
  // hay que moverla — dejarla imputada al funnel anterior es el bug que este
  // endpoint viene a arreglar.
  const reasignadas = await q<{ id: string }>(
    `UPDATE ad_spend SET funnel_id = $2::smallint
      WHERE campaign_id = $1 AND funnel_id IS DISTINCT FROM $2::smallint
      RETURNING id`,
    [campaignId, efectivo],
  );

  // Y el rollup del rango que se movió. Sin esto el Resumen sigue mostrando la
  // imputación vieja: `daily_metrics` es un agregado congelado, no una vista.
  // El rango sale del gasto de la campaña, así que es acotado (una campaña vive
  // semanas, no años) — el cron diario ya recomputa 35 días de una.
  let rollup: { from: string; to: string; rows: number } | null = null;
  if (reasignadas.length > 0) {
    const rango = await q1<{ from: Date | string | null; to: Date | string | null }>(
      `SELECT min(day) AS from, max(day) AS to FROM ad_spend WHERE campaign_id = $1`,
      [campaignId],
    );
    const from = dia(rango?.from ?? null);
    const to = dia(rango?.to ?? null);
    if (from && to) {
      const res = await rollupRange({ from, to });
      rollup = { from, to, rows: res.rows };
    }
  }

  return json(200, { ok: true, campaignId, funnelId, reasignadas: reasignadas.length, rollup });
}
