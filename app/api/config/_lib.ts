/**
 * Helpers y queries compartidas de /api/config/** (task T09 §B) — guard de
 * auth, validación y las lecturas que comparten los routes con la página de
 * Configuración.
 *
 * Este archivo NO es un route (no se llama route.ts): es un módulo regular
 * dentro del árbol de ownership de T09, importable desde los routes y desde
 * app/(panel)/config/page.tsx (server component).
 *
 * Reglas del task para todos los endpoints de config:
 *   - Guard de auth en cada uno: son endpoints de escritura, no alcanza con
 *     el middleware (plan §9: sin cookie → 401, nunca datos).
 *   - Todo el SQL con parámetros ($1, $2), nunca concatenación.
 *   - `timezone` se valida con Intl (el único lugar donde JS conoce la lista
 *     real de TZ válidas); `funnel_id` se chequea contra la tabla.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticated } from '@/lib/auth';
import { q, q1 } from '@/lib/db';

export function json(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, { status });
}

/** 401 si no hay cookie válida; null si está OK. */
export async function guard(req: NextRequest): Promise<NextResponse | null> {
  if (!isAuthenticated(req.cookies)) {
    return json(401, { ok: false, error: 'unauthorized' });
  }
  return null;
}

export async function parseJson(req: NextRequest): Promise<unknown | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/** Los valores permitidos del catálogo de pasos (schema §3.2). */
export const STEP_KINDS = ['landing', 'question', 'content', 'sales'] as const;

/**
 * TZ válida para el field de un formulario. Intl tira si el string no es una
 * zona real; no existe una lista canónica accesible sin un paquete de datos.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function funnelExists(funnelId: number): Promise<boolean> {
  const row = await q1<{ id: number }>('SELECT id FROM funnels WHERE id = $1', [funnelId]);
  return row !== null;
}

// ─── Lecturas compartidas ────────────────────────────────────────────────────

export type UnknownStepWarning = { detail: string; count: number };

/**
 * Los pasos que el ingest vio y el catálogo no conoce (D20): la señal de que
 * el quiz avanzó y `funnel_steps` quedó viejo. Últimos 7 días, agrupado por
 * el detalle (que lleva el step_index / slug), que es como se lee.
 */
export async function getUnknownSteps(funnelId: number): Promise<UnknownStepWarning[]> {
  return q<UnknownStepWarning>(
    `SELECT detail, count(*)::int AS count
     FROM ingest_errors
     WHERE funnel_id = $1
       AND reason IN ('unknown_step', 'step_slug_mismatch')
       AND received_at >= now() - interval '7 days'
     GROUP BY detail
     ORDER BY count DESC`,
    [funnelId],
  );
}

export type ProductMapping = {
  id: number;
  shopDomain: string;
  productId: string;
  funnelId: number;
  funnelSlug: string;
  funnelName: string;
  tier: string;
  label: string | null;
  /** Costo unitario del producto (migración 013). 0 = sin cargar. */
  cost: number;
  costCurrency: string | null;
};

export async function listProductMappings(): Promise<ProductMapping[]> {
  return q<ProductMapping>(
    `SELECT pm.id, pm.shop_domain AS "shopDomain", pm.product_id AS "productId",
            pm.funnel_id AS "funnelId", f.slug AS "funnelSlug", f.name AS "funnelName",
            pm.tier, pm.label,
            pm.cost::float8 AS cost, pm.cost_currency AS "costCurrency"
     FROM product_map pm
     JOIN funnels f ON f.id = pm.funnel_id
     ORDER BY pm.shop_domain, pm.product_id`,
  );
}

export type UnmappedProduct = {
  // null = el ítem llegó sin ID de producto (import de CSV) y su única
  // identidad es el título. La UI ofrece mapearlo igual, por título.
  productId: string | null;
  title: string | null;
  veces: number;
  ultima: string | null;
  shopDomain: string;
};

/**
 * Los productos que ya aparecieron en ventas y todavía no tienen mapa — la
 * lista que hace que esta pantalla sea operable sin SQL (task T09 §B.3).
 *
 * Dos ramas porque hay dos formas de entrar una venta:
 * · El webhook trae `shopify_product_id`: se agrupa por ID.
 * · El import de CSV NO lo trae (el export de Shopify no tiene ni product_id
 *   ni SKU en las líneas), así que esos ítems se agrupan por título.
 * Sin la segunda rama un producto importado por CSV y sin mapa quedaba
 * invisible en esta pantalla: la venta se veía en el total "sin atribuir" pero
 * no había forma de mapearla desde el panel.
 */
export async function listUnmappedProducts(): Promise<UnmappedProduct[]> {
  return q<UnmappedProduct>(
    `SELECT oi.shopify_product_id AS "productId", min(oi.title) AS title,
            count(*)::int AS veces, max(o.purchased_at) AS ultima, o.shop_domain AS "shopDomain"
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE oi.tier = 'unknown' AND oi.shopify_product_id IS NOT NULL
     GROUP BY oi.shopify_product_id, o.shop_domain
     UNION ALL
     SELECT NULL AS "productId", oi.title AS title,
            count(*)::int AS veces, max(o.purchased_at) AS ultima, o.shop_domain AS "shopDomain"
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE oi.tier = 'unknown' AND oi.shopify_product_id IS NULL AND oi.title IS NOT NULL
     GROUP BY oi.title, o.shop_domain
     ORDER BY veces DESC`,
  );
}

export type ShopMapping = {
  shopDomain: string;
  funnelId: number;
  funnelSlug: string;
  funnelName: string;
};

export async function listShopMappings(): Promise<ShopMapping[]> {
  return q<ShopMapping>(
    `SELECT sm.shop_domain AS "shopDomain", sm.funnel_id AS "funnelId",
            f.slug AS "funnelSlug", f.name AS "funnelName"
     FROM shop_map sm
     JOIN funnels f ON f.id = sm.funnel_id
     ORDER BY sm.shop_domain`,
  );
}

export type PanelSettings = {
  fxSource: 'oficial' | 'blue';
  defaultCurrencyView: 'EUR' | 'ARS';
  retentionDaysEvents: number;
};

const SETTING_KEYS = ['fx_source', 'default_currency_view', 'retention_days_events'] as const;

/** Los tres settings de la UI (plan §3.10), con los defaults del seed. */
export async function getSettingsRecord(): Promise<PanelSettings> {
  const rows = await q<{ key: string; value: unknown }>(
    `SELECT key, value FROM settings WHERE key = ANY($1::text[])`,
    [SETTING_KEYS],
  );
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    fxSource: map.get('fx_source') === 'blue' ? 'blue' : 'oficial',
    defaultCurrencyView: map.get('default_currency_view') === 'ARS' ? 'ARS' : 'EUR',
    retentionDaysEvents:
      typeof map.get('retention_days_events') === 'number'
        ? (map.get('retention_days_events') as number)
        : 180,
  };
}

/** Setea un setting; el value va como jsonb (JSON.stringify ya da el formato del seed). */
export async function setSetting(key: string, value: unknown): Promise<void> {
  await q(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

export type FxRateRow = {
  day: string;
  rate: string; // 1 base en quote — numeric viene como string de pg
  arsPerEuro: number; // 1/rate, que es como se lee (D13)
  source: string;
  fetchedAt: string;
};

export async function listFxRates(limit = 20): Promise<FxRateRow[]> {
  const rows = await q<{ day: Date; rate: string; source: string; fetchedAt: Date }>(
    `SELECT day, rate::text AS rate, source, fetched_at AS "fetchedAt"
     FROM fx_rates
     ORDER BY day DESC, fetched_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10),
    rate: r.rate,
    arsPerEuro: Number(r.rate) > 0 ? 1 / Number(r.rate) : 0,
    source: r.source,
    fetchedAt: r.fetchedAt instanceof Date ? r.fetchedAt.toISOString() : String(r.fetchedAt),
  }));
}

export type WebhookEventRow = {
  id: number;
  receivedAt: string;
  source: string | null;
  shopDomain: string | null;
  topic: string | null;
  externalId: string | null;
  status: string;
  error: string | null;
};

export type IngestErrorRow = {
  id: number;
  receivedAt: string;
  funnelId: number | null;
  reason: string;
  detail: string | null;
};

export type SystemStatus = {
  lastSessions: { slug: string; lastSeenAt: string | null }[];
  lastRollupAt: string | null;
  lastFx: { day: string; arsPerEuro: number; source: string } | null;
  partitions: number;
  webhookEvents: WebhookEventRow[];
  ingestErrors: IngestErrorRow[];
};

type WebhookEventRowRaw = Omit<WebhookEventRow, 'id' | 'receivedAt'> & { id: string; receivedAt: Date | string };
type IngestErrorRowRaw = Omit<IngestErrorRow, 'id' | 'receivedAt'> & { id: string; receivedAt: Date | string };

/**
 * Estado del sistema (task T09 §B.4): último dato recibido en cada pieza de
 * la cadena (sesión → rollup → cotización → particiones) más las dos tablas
 * de diagnóstico. Filtros opcionales por status/reason para las listas.
 */
export async function getSystemStatus(opts: {
  wstatus?: string | null;
  reason?: string | null;
}): Promise<SystemStatus> {
  const [lastSessions, lastRollup, lastFx, partitions, webhookEvents, ingestErrors] =
    await Promise.all([
      q<{ slug: string; lastSeenAt: Date | string | null }>(
        `SELECT f.slug, max(s.last_seen_at) AS "lastSeenAt"
         FROM sessions s
         JOIN funnels f ON f.id = s.funnel_id
         GROUP BY f.id, f.slug
         ORDER BY f.slug`,
      ),
      q1<{ at: Date }>(`SELECT max(computed_at) AS at FROM daily_metrics`),
      q1<{ day: Date; rate: string; source: string }>(
        `SELECT day, rate::text AS rate, source
         FROM fx_rates ORDER BY day DESC, fetched_at DESC LIMIT 1`,
      ),
      // Las particiones de events son tablas hijas de la particionada: el
      // catálogo de pg_inherits es la única fuente de verdad de cuántas hay.
      q1<{ partitions: number }>(
        `SELECT count(*)::int AS partitions FROM pg_inherits WHERE inhparent = 'events'::regclass`,
      ),
      q<WebhookEventRowRaw>(
        `SELECT id, received_at AS "receivedAt", source, shop_domain AS "shopDomain",
                topic, external_id AS "externalId", status, error
         FROM webhook_events
         WHERE ($1::text IS NULL OR status = $1)
         ORDER BY received_at DESC
         LIMIT 50`,
        [opts.wstatus ?? null],
      ),
      q<IngestErrorRowRaw>(
        `SELECT id, received_at AS "receivedAt", funnel_id AS "funnelId", reason, detail
         FROM ingest_errors
         WHERE ($1::text IS NULL OR reason = $1)
         ORDER BY received_at DESC
         LIMIT 50`,
        [opts.reason ?? null],
      ),
    ]);

  return {
    lastSessions: lastSessions.map((r) => ({
      slug: r.slug,
      lastSeenAt: r.lastSeenAt instanceof Date ? r.lastSeenAt.toISOString() : r.lastSeenAt ? String(r.lastSeenAt) : null,
    })),
    lastRollupAt: lastRollup?.at ? lastRollup.at.toISOString() : null,
    lastFx: lastFx
      ? {
          day: lastFx.day instanceof Date ? lastFx.day.toISOString().slice(0, 10) : String(lastFx.day).slice(0, 10),
          arsPerEuro: Number(lastFx.rate) > 0 ? 1 / Number(lastFx.rate) : 0,
          source: lastFx.source,
        }
      : null,
    partitions: partitions?.partitions ?? 0,
    webhookEvents: webhookEvents.map((r) => ({
      id: Number(r.id),
      receivedAt: r.receivedAt instanceof Date ? r.receivedAt.toISOString() : String(r.receivedAt),
      source: r.source,
      shopDomain: r.shopDomain,
      topic: r.topic,
      externalId: r.externalId,
      status: r.status,
      error: r.error,
    })),
    ingestErrors: ingestErrors.map((r) => ({
      id: Number(r.id),
      receivedAt: r.receivedAt instanceof Date ? r.receivedAt.toISOString() : String(r.receivedAt),
      funnelId: r.funnelId,
      reason: r.reason,
      detail: r.detail,
    })),
  };
}
