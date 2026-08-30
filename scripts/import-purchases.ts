#!/usr/bin/env node
/**
 * Importa el histórico de ventas de un Supabase (tabla `purchases`) a
 * `orders` (task T12 §Parte A, plan §3.5 y D15).
 *
 * D15 manda: se migra `purchases` (son ventas reales y están limpias), NO
 * `funnel_counts` (tiene basura documentada: el día centinela 2000-01-01,
 * `quiz_version='v1'` mal etiquetado y ventas infladas por el backfill del
 * panel viejo). El embudo arranca de cero el día del deploy.
 *
 * Uso (declarado en package.json por T01):
 *   npm run import:purchases -- --funnel=chauhinchazon --dry-run
 *   npm run import:purchases -- --funnel=chauhinchazon
 *   npm run import:purchases -- --funnel=reset --since=2026-01-01
 *
 * Credenciales por funnel, mismo esquema que T09:
 *   SUPABASE_URL_<SLUG> / SUPABASE_SERVICE_KEY_<SLUG>
 * (el sufijo es el slug en mayúsculas). Sin ellas, el script sale con error
 * y no escribe nada.
 *
 * `source = 'import'` y no `'shopify'` a propósito (task T12 §Parte A): el
 * único de `orders` es UNIQUE (source, external_id). Con `'import'`, si
 * mañana llega un webhook de Shopify por la devolución de una compra vieja,
 * entra como fila nueva en vez de chocar contra la importada. Preferimos una
 * fila duplicada visible a un INSERT que falla en silencio.
 *
 * NO crea `order_items`: `purchases` no tiene líneas de detalle (una fila por
 * compra, sin desglose de productos). Los ítems arrancan con el webhook.
 *
 * Paginación: PostgREST corta en 1000 filas EN SILENCIO — si no se pagina,
 * faltan ventas sin ningún error. Se pagina con el header `Range` y además,
 * con `Prefer: count=exact`, se verifica al final que lo leído coincida con
 * el total declarado: si no coincide, se aborta antes de escribir UNA fila.
 * Un histórico mal importado es peor que ninguno (task T12 §Cuándo parar).
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPool, q1, q, tx } from '../lib/db';
import { getFunnelBySlug } from '../lib/funnels';
import { toReportCurrency } from '../lib/fx';
import { resolveTier } from '../lib/orders/resolve';
import type { Tier } from '../lib/types';

// tsx no carga .env solo; en dev el env vive en el archivo, en producción
// viene de PM2 y no existe (process.loadEnvFile es de Node >= 20.12).
const envPath = path.join(process.cwd(), '.env');
if (typeof process.loadEnvFile === 'function' && existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

/**
 * Las columnas que el webhook de los funnels escribe en `purchases` (ver
 * app/api/shopify-webhook/route.ts y app/api/hotmart-webhook/route.ts). Se
 * pide `select=*`: estas son las que se mapean, el resto va en `raw` igual.
 */
type PurchaseRow = {
  email: string | null;
  hotmart_transaction: string | null;
  product_id: string | number | null;
  product_name: string | null;
  amount: number | string | null;
  currency: string | null;
  status: string | null;
  purchased_at: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  [key: string]: unknown;
};

type RestResult = { rows: PurchaseRow[]; total: number | null };

async function restGet(
  env: { url: string; key: string },
  params: URLSearchParams,
  from: number,
  to: number,
): Promise<RestResult> {
  const res = await fetch(`${env.url}/rest/v1/purchases?${params.toString()}`, {
    headers: {
      apikey: env.key,
      Authorization: `Bearer ${env.key}`,
      Range: `${from}-${to}`,
      // `count=exact` hace que PostgREST devuelva el total en Content-Range
      // (formato «0-999/2500»): es lo que permite verificar que la paginación
      // no truncó nada (mismo truco que lib/supabase-leads.ts de T09).
      Prefer: 'count=exact',
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    // PostgREST usa 400/401 para errores de filtro o de permisos: el detalle
    // va en el body y es lo que permite diagnosticar sin SSH.
    const detail = await res.text().catch(() => '');
    throw new Error(`Supabase REST ${res.status}: ${detail.slice(0, 200)}`);
  }
  const rows = (await res.json()) as PurchaseRow[];
  let total: number | null = null;
  const cr = res.headers.get('content-range');
  if (cr) {
    const m = /\/(\d+)$/.exec(cr);
    if (m) total = Number(m[1]);
  }
  return { rows, total };
}

/**
 * Todas las filas de `purchases`, de a 1000. `since` es un día 'YYYY-MM-DD'
 * opcional: se filtra `purchased_at >= since` en el server.
 */
async function fetchAllPurchases(
  env: { url: string; key: string },
  since?: string,
): Promise<{ rows: PurchaseRow[]; total: number | null }> {
  const PAGE = 1000;
  const params = new URLSearchParams({ select: '*', order: 'purchased_at.asc' });
  if (since) params.set('purchased_at', `gte.${since}`);

  const out: PurchaseRow[] = [];
  let total: number | null = null;
  for (let offset = 0; ; offset += PAGE) {
    const { rows, total: pageTotal } = await restGet(env, params, offset, offset + PAGE - 1);
    if (total === null) total = pageTotal;
    out.push(...rows);
    if (rows.length < PAGE) break;
    // Ya se leyó todo lo declarado: un server que siga devolviendo páginas
    // llenas a partir de acá está mintiendo (o un proxy le comió el Range) y
    // el chequeo de abajo lo aborta. Sin este break, un server así es un loop
    // infinito de fetch.
    if (total !== null && out.length >= total) break;
  }

  // El chequeo que hace que esta tarea no mienta: si PostgREST truncó (o si
  // el filtro devolvió menos de lo declarado), NO se escribe nada.
  if (total !== null && out.length !== total) {
    throw new Error(
      `paginación de PostgREST: se leyeron ${out.length} filas de ${total} declaradas ` +
        `— abortado, no se escribió nada. Volvé a intentar antes de tocar la base.`,
    );
  }
  return { rows: out, total };
}

/** Una fila ya resuelta, lista para el INSERT. */
type PreparedRow = {
  externalId: string;
  email: string | null;
  amount: number;
  currency: string;
  status: string;
  tier: Tier;
  purchasedAt: string;
  day: string;
  amountEur: number | null;
  fxRate: number | null;
  fxDay: string | null;
  fxStale: boolean;
  utms: { source: string; medium: string; campaign: string; content: string; term: string };
  raw: unknown;
};

const BATCH = 500;

async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  let funnelSlug: string | null = null;
  let since: string | undefined;
  let dryRun = false;
  for (const a of args) {
    if (a.startsWith('--funnel=')) funnelSlug = a.slice('--funnel='.length);
    else if (a.startsWith('--since=')) since = a.slice('--since='.length);
    else if (a === '--dry-run') dryRun = true;
    else throw new Error(`argumento desconocido: ${a}`);
  }
  if (!funnelSlug) throw new Error('falta --funnel=<slug> (chauhinchazon | reset)');

  const url = process.env[`SUPABASE_URL_${funnelSlug.toUpperCase()}`];
  const key = process.env[`SUPABASE_SERVICE_KEY_${funnelSlug.toUpperCase()}`];
  if (!url || !key) {
    throw new Error(
      `faltan SUPABASE_URL_${funnelSlug.toUpperCase()} / ` +
        `SUPABASE_SERVICE_KEY_${funnelSlug.toUpperCase()} — no se importa nada`,
    );
  }
  const env = { url: url.replace(/\/+$/, ''), key };

  const funnel = await getFunnelBySlug(funnelSlug);
  if (!funnel) throw new Error(`funnel '${funnelSlug}' no existe en la base local`);

  const { rows, total } = await fetchAllPurchases(env, since);
  const verb = dryRun ? 'importaría' : 'importa';
  console.log(`purchases: ${rows.length} filas leídas${total !== null ? ` de ${total} declaradas` : ''}`);

  // Las que ya están, para el conteo del dry-run y para no reintentarlas.
  const existing = new Set(
    (await q<{ external_id: string }>(
      `SELECT external_id FROM orders WHERE source = 'import' AND funnel_id = $1`,
      [funnel.id],
    )).map((r) => r.external_id),
  );

  // ─── Preparación (solo lecturas, antes de abrir cualquier transacción) ──
  // La resolución de tier, el día local y la cotización son lecturas; el
  // mismo orden que lib/orders/upsert.ts (T04): los escribos van todos en
  // transacciones de a 500, las lecturas corren antes, sobre el pool.
  const todo: PreparedRow[] = [];
  const skips = {
    sinExternalId: 0,
    sinMonto: 0,
    sinMoneda: 0,
    sinFecha: 0,
  };
  for (const row of rows) {
    const externalId = row.hotmart_transaction?.trim() || '';
    if (!externalId) {
      // external_id participa del UNIQUE (source, external_id) y la regla del
      // plan (§3) es que en un índice único nunca hay NULL (NULL ≠ NULL no
      // deduplica): una fila sin id entraría duplicada en cada corrida.
      skips.sinExternalId += 1;
      continue;
    }
    if (existing.has(externalId)) continue; // ya está: se cuenta al final

    const amount = Number(row.amount);
    if (row.amount === null || row.amount === '' || Number.isNaN(amount)) {
      // orders.amount es NOT NULL: inventar un monto corrompe la comparación
      // de sumas contra Supabase. Se cuenta y se muestra.
      skips.sinMonto += 1;
      continue;
    }
    const currency = row.currency?.trim();
    if (!currency) {
      skips.sinMoneda += 1;
      continue;
    }
    const purchasedAt = row.purchased_at;
    if (!purchasedAt || Number.isNaN(Date.parse(purchasedAt))) {
      skips.sinFecha += 1;
      continue;
    }

    // `tier` sale SOLO de product_map (D11): sin fila → 'unknown', nunca se
    // adivina por el nombre. shop_domain '*' porque el histórico no sabe de
    // qué tienda vino cada compra.
    const tier = await resolveTier('*', row.product_id != null ? String(row.product_id) : null);

    // El día es una resolución de zona horaria: en SQL, no en JS (lib/day.ts
    // explica por qué la aritmética de TZ en JS corre un día en horario de
    // verano).
    const dayRow = await q1<{ day: string }>(
      'SELECT ($1::timestamptz AT TIME ZONE $2)::date::text AS day',
      [purchasedAt, funnel.timezone],
    );
    const day = dayRow!.day;

    // Conversión congelada en la fila (D12/D13). Para los días viejos no hay
    // cotización (fx_rates arranca hoy): quedan con amount_eur NULL y
    // fx_stale = true. Es lo honesto — inventar una cotización retroactiva
    // es peor. El histórico se lee en ARS; si se quiere en euros, se cargan
    // filas en fx_rates y corre `npm run fx:backfill` (task T12 §Parte A).
    const fx = await toReportCurrency(amount, currency, day);

    const utm = (v: string | null): string => v ?? '(directo)';
    todo.push({
      externalId,
      email: row.email || null,
      amount,
      currency,
      status: row.status || 'approved',
      tier,
      purchasedAt,
      day,
      amountEur: fx?.amountEur ?? null,
      fxRate: fx?.rate ?? null,
      fxDay: fx?.fxDay ?? null,
      fxStale: fx ? fx.stale : true,
      utms: {
        source: utm(row.utm_source),
        medium: utm(row.utm_medium),
        campaign: utm(row.utm_campaign),
        content: utm(row.utm_content),
        term: utm(row.utm_term),
      },
      raw: row,
    });
  }

  // ─── Dry-run: nada se escribe ─────────────────────────────────────────
  const minDate = rows.length ? rows.map((r) => r.purchased_at ?? '').filter(Boolean).sort()[0] : null;
  const maxDate = rows.length
    ? rows.map((r) => r.purchased_at ?? '').filter(Boolean).sort().at(-1) ?? null
    : null;
  // Objetos planos en vez de Maps: el tsconfig no fija `target` y el default
  // de tsc (ES5) no puede iterar Maps sin downlevelIteration (mismo patrón
  // que el resto del repo, que solo usa .get()).
  const tierBreakdown: Partial<Record<Tier, number>> = {};
  for (const t of todo) tierBreakdown[t.tier] = (tierBreakdown[t.tier] ?? 0) + 1;

  const skipsTotal = skips.sinExternalId + skips.sinMonto + skips.sinMoneda + skips.sinFecha;
  console.log(`${verb} ${todo.length} (${rows.length - todo.length - skipsTotal} ya están)`);
  if (minDate || maxDate) console.log(`rango de fechas: ${minDate ?? '?'} … ${maxDate ?? '?'}`);
  const tierLines = (Object.keys(tierBreakdown) as Tier[])
    .map((k) => `${k}=${tierBreakdown[k]}`)
    .join(', ');
  if (tierLines) console.log(`desglose por tier: ${tierLines}`);
  const skipLines = [
    skips.sinExternalId ? `${skips.sinExternalId} sin hotmart_transaction` : null,
    skips.sinMonto ? `${skips.sinMonto} sin amount` : null,
    skips.sinMoneda ? `${skips.sinMoneda} sin currency` : null,
    skips.sinFecha ? `${skips.sinFecha} sin purchased_at` : null,
  ].filter(Boolean);
  if (skipLines.length) console.log(`salteadas: ${skipLines.join(', ')}`);

  if (dryRun) {
    console.log('dry-run: no se escribió nada');
    return;
  }

  // ─── Inserción en lotes de 500, una transacción por lote ─────────────
  // Un lote que falla a mitad de camino no puede dejar media corrida
  // adentro: el ROLLBACK deja ese lote completo afuera y el script sale con
  // error. Correrlo de nuevo no duplica nada (ON CONFLICT DO NOTHING + las
  // filas ya insertadas entran en `existing` en la corrida siguiente).
  let inserted = 0;
  let duplicates = 0;
  const noTier: string[] = [];
  const noFx: string[] = [];
  const totalsByCurrency: Record<string, number> = {};
  const byStatus: Record<string, { count: number; sum: number }> = {};

  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const batchInserts = await tx(async (c) => {
      let n = 0;
      for (const r of batch) {
        const ins = await c.query(
          `INSERT INTO orders (funnel_id, source, shop_domain, external_id, email, status, tier,
                               amount, currency, amount_eur, fx_rate, fx_day, fx_stale,
                               utm_source, utm_medium, utm_campaign, utm_content, utm_term,
                               purchased_at, day, refunded_at, raw)
           VALUES ($1::smallint, 'import', '*', $2, $3, $4, $5, $6::numeric, $7,
                   $8::numeric, $9::numeric, $10::date, $11,
                   $12, $13, $14, $15, $16,
                   $17::timestamptz, $18::date, $19::timestamptz, $20::jsonb)
           ON CONFLICT (source, external_id) DO NOTHING`,
          [
            funnel.id,
            r.externalId,
            r.email,
            r.status,
            r.tier,
            r.amount,
            r.currency,
            r.amountEur,
            r.fxRate,
            r.fxDay,
            r.fxStale,
            r.utms.source,
            r.utms.medium,
            r.utms.campaign,
            r.utms.content,
            r.utms.term,
            r.purchasedAt,
            r.day,
            // `refunded_at = purchased_at` cuando la fila no está approved:
            // el dato real de la devolución no existe en `purchases` (el
            // webhook viejo solo cambia status), así que la fecha de compra
            // es la mejor aproximación. Es un dato aproximado a propósito y
            // alguien lo va a mirar: acá queda la marca de agua.
            r.status !== 'approved' ? r.purchasedAt : null,
            JSON.stringify(r.raw),
          ],
        );
        n += ins.rowCount ?? 0;
      }
      return n;
    });
    duplicates += batch.length - batchInserts;
    inserted += batchInserts;

    for (const r of batch) {
      if (r.tier === 'unknown') noTier.push(r.externalId);
      if (r.amountEur === null) noFx.push(r.externalId);
      totalsByCurrency[r.currency] = (totalsByCurrency[r.currency] ?? 0) + r.amount;
      const st = byStatus[r.status] ?? { count: 0, sum: 0 };
      st.count += 1;
      st.sum += r.amount;
      byStatus[r.status] = st;
    }
    console.log(`lote ${i / BATCH + 1}/${Math.ceil(todo.length / BATCH)}: ${batchInserts} insertadas`);
  }

  // ─── Resumen final ────────────────────────────────────────────────────
  console.log('── resumen ──');
  console.log(`importadas: ${inserted}`);
  console.log(`salteadas por duplicado (ya estaban): ${duplicates}`);
  console.log(`sin tier (product_map no las mapea): ${noTier.length}`);
  console.log(`sin cotización (amount_eur NULL, fx_stale): ${noFx.length}`);
  for (const cur of Object.keys(totalsByCurrency)) {
    console.log(`total ${cur}: ${totalsByCurrency[cur].toFixed(2)}`);
  }
  // El conteo y la suma por status tienen que coincidir con el GROUP BY de
  // Supabase (task T12 §Verificación). Se imprimen acá para comparar directo.
  for (const status of Object.keys(byStatus)) {
    const { count, sum } = byStatus[status];
    console.log(`status ${status}: ${count} filas, ${sum.toFixed(2)}`);
  }
  if (skipsTotal) {
    console.log(
      `salteadas por datos incompletos: ${skipsTotal} ` +
        `(${skips.sinExternalId} sin id, ${skips.sinMonto} sin monto, ` +
        `${skips.sinMoneda} sin moneda, ${skips.sinFecha} sin fecha)`,
    );
  }
}

const isMain =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main()
    .catch((err) => {
      console.error('import-purchases falló:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => getPool().end().catch(() => {}));
}
