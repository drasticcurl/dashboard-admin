/**
 * Cliente de Supabase por funnel, SOLO lectura, por la API REST de PostgREST
 * (task T09 §A).
 *
 * Los funnels migraron su tracking a la base nueva, pero los leads (tabla
 * `clientes`) quedaron en Supabase por decisión del usuario, y esta sección
 * los lee de ahí. Sin `@supabase/supabase-js` a propósito: T01 no lo declaró
 * en package.json y §8 del plan prohíbe tocar esa fila. PostgREST responde a
 * GET con headers de rango, y es todo lo que hace falta para leer una tabla.
 *
 * Credenciales por funnel, el sufijo es el slug en mayúsculas:
 *   SUPABASE_URL_<SLUG> / SUPABASE_SERVICE_KEY_<SLUG>
 * Un funnel nuevo se agrega solo con sus dos variables. Si faltan, la
 * sección muestra "no configurado" para ese funnel y el resto del panel
 * sigue funcionando: acá nunca se tira una excepción por env faltante.
 *
 * Postgres directo (funnels que dejaron Supabase): si existe
 *   LEADS_DATABASE_URL_<SLUG>   (ej. postgres://chauhinchazon_ro:...@127.0.0.1:5432/chauhinchazon)
 * se lee la tabla `clientes` de esa base con un rol de SOLO lectura y las
 * vars de Supabase de ese slug se ignoran. Mismas funciones, mismo resultado:
 * los callers no saben de dónde sale el dato.
 *
 * Paginación: PostgREST corta en 1000 filas en silencio (el bug real que los
 * funnels ya se comieron en `lib/admin/supabase-store.ts`), así que todo
 * fetch que pueda superar ese número pagina con el header `Range` hasta que
 * la respuesta traiga menos filas que el tamaño de página.
 */

import { Pool } from 'pg';

export type LeadsEnv =
  | { kind: 'rest'; url: string; key: string }
  | { kind: 'pg'; url: string };

export function getLeadsEnv(slug: string): LeadsEnv | null {
  const pgUrl = process.env[`LEADS_DATABASE_URL_${slug.toUpperCase()}`]?.trim();
  if (pgUrl) return { kind: 'pg', url: pgUrl };
  const url = process.env[`SUPABASE_URL_${slug.toUpperCase()}`];
  const key = process.env[`SUPABASE_SERVICE_KEY_${slug.toUpperCase()}`];
  if (!url || !key) return null;
  return { kind: 'rest', url: url.replace(/\/+$/, ''), key };
}

/* ─── Postgres directo ─────────────────────────────────────────────── */

// Un pool chico por base de funnel (no el del panel: otra base, otro rol).
const pools = new Map<string, Pool>();

function leadsPool(url: string): Pool {
  let pool = pools.get(url);
  if (!pool) {
    pool = new Pool({ connectionString: url, max: 2, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
    pool.on('error', (err) => {
      console.error('[leads-pg] error en el pool (la conexión se reintenta sola):', err.message);
    });
    pools.set(url, pool);
  }
  return pool;
}

/** WHERE por ventana de creación; los valores siempre como parámetros. */
function createdWindow(opts: { gte?: string | null; lt?: string | null }): { sql: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  if (opts.gte) {
    params.push(opts.gte);
    parts.push(`created_at >= $${params.length}`);
  }
  if (opts.lt) {
    params.push(opts.lt);
    parts.push(`created_at < $${params.length}`);
  }
  return { sql: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', params };
}

// created_at como string ISO, igual que lo devolvía PostgREST (pg da Date).
const PG_BASE_COLUMNS = `email, nombre, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS created_at,
  compro, utm_source, utm_medium, utm_campaign, utm_content, tipo_hinchazon, severidad`;

/**
 * Columnas de `clientes` que existen y sirven (task T09 §A). El resto del
 * quiz viejo (`apertura`, `momento`, `sintomas`, …) está casi todo en NULL:
 * no se selecciona ni se muestra como si fuera dato.
 */
export type LeadColumns = {
  email: string;
  nombre: string | null;
  created_at: string;
  compro: boolean | string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  tipo_hinchazon: number | null;
  severidad: number | null;
};

const BASE_COLUMNS = [
  'email',
  'nombre',
  'created_at',
  'compro',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'tipo_hinchazon',
  'severidad',
].join(',');

/** El subconjunto que usa el export: el CSV viejo no toca UTMs. */
const EXPORT_COLUMNS = ['email', 'nombre', 'created_at', 'tipo_hinchazon', 'severidad'].join(',');

type RestResult<T> = { rows: T[]; total: number | null };

/**
 * GET a PostgREST. `preferCount` suma el header `Prefer: count=exact`, que
 * hace que la respuesta traiga el total en `Content-Range` (formato
 * «0-0/123», o «* /0» sin filas): es la forma de contar sin traer filas.
 */
async function restGet<T>(
  env: Extract<LeadsEnv, { kind: 'rest' }>,
  params: URLSearchParams,
  opts: { from: number; to: number; preferCount?: boolean },
): Promise<RestResult<T>> {
  const res = await fetch(`${env.url}/rest/v1/clientes?${params.toString()}`, {
    headers: {
      apikey: env.key,
      Authorization: `Bearer ${env.key}`,
      Range: `${opts.from}-${opts.to}`,
      ...(opts.preferCount ? { Prefer: 'count=exact' } : {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    // PostgREST también usa 400/401 para errores de filtro o de permisos:
    // el detalle va en el body y es lo que permite diagnosticar sin SSH.
    const detail = await res.text().catch(() => '');
    throw new Error(`Supabase REST ${res.status}: ${detail.slice(0, 200)}`);
  }
  const rows = (await res.json()) as T[];
  let total: number | null = null;
  const cr = res.headers.get('content-range');
  if (cr) {
    // '0-0/123' o '*/0' (vacío): el total es lo que sigue a la última barra.
    const m = /\/(\d+)$/.exec(cr);
    if (m) total = Number(m[1]);
  }
  return { rows, total };
}

/** Params `select` + `order` comunes a todos los fetches de leads. */
function baseParams(columns: string): URLSearchParams {
  const p = new URLSearchParams({ select: columns, order: 'created_at.desc' });
  return p;
}

/** Total de leads, opcionalmente acotado a una ventana de creación. */
export async function countLeads(
  env: LeadsEnv,
  opts: { gte?: string; lt?: string } = {},
): Promise<number> {
  if (env.kind === 'pg') {
    const w = createdWindow(opts);
    const r = await leadsPool(env.url).query(`SELECT count(*)::int AS n FROM clientes${w.sql}`, w.params);
    return Number(r.rows[0]?.n ?? 0);
  }
  const params = baseParams('email');
  if (opts.gte) params.set('created_at', `gte.${opts.gte}`);
  if (opts.lt) params.set('created_at', `lt.${opts.lt}`);
  const { total, rows } = await restGet<LeadColumns>(env, params, {
    from: 0,
    to: 0,
    preferCount: true,
  });
  return total ?? rows.length;
}

/** Los últimos `limit` leads, con todas las columnas que muestra la tabla. */
export async function fetchRecentLeads(env: LeadsEnv, limit: number): Promise<LeadColumns[]> {
  if (env.kind === 'pg') {
    const r = await leadsPool(env.url).query(
      `SELECT ${PG_BASE_COLUMNS} FROM clientes ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return r.rows as LeadColumns[];
  }
  const params = baseParams(BASE_COLUMNS);
  const { rows } = await restGet<LeadColumns>(env, params, { from: 0, to: limit - 1 });
  return rows;
}

/**
 * Todos los leads (paginado de 1000 en 1000). `since` es un instante ISO ya
 * resuelto: el caller calcula el borde del día en la TZ del funnel, no acá.
 */
export async function fetchAllLeads(
  env: LeadsEnv,
  opts: { since?: string | null } = {},
): Promise<LeadColumns[]> {
  if (env.kind === 'pg') {
    const w = createdWindow({ gte: opts.since });
    const r = await leadsPool(env.url).query(
      `SELECT ${PG_BASE_COLUMNS} FROM clientes${w.sql} ORDER BY created_at DESC`,
      w.params,
    );
    return r.rows as LeadColumns[];
  }
  const PAGE = 1000;
  const out: LeadColumns[] = [];
  const params = baseParams(EXPORT_COLUMNS);
  if (opts.since) params.set('created_at', `gte.${opts.since}`);
  for (let offset = 0; ; offset += PAGE) {
    const { rows } = await restGet<LeadColumns>(env, params, {
      from: offset,
      to: offset + PAGE - 1,
    });
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/** Emails de leads creados en una ventana, para el cruce comprador/no-comprador. */
export async function fetchLeadEmailsInRange(
  env: LeadsEnv,
  opts: { gte: string; lt: string },
): Promise<string[]> {
  if (env.kind === 'pg') {
    const w = createdWindow(opts);
    const r = await leadsPool(env.url).query(`SELECT lower(trim(email)) AS email FROM clientes${w.sql}`, w.params);
    return r.rows.map((row) => String(row.email)).filter(Boolean);
  }
  const PAGE = 1000;
  const out: string[] = [];
  const params = baseParams('email');
  // Dos valores para la misma columna son AND en PostgREST: hace falta
  // `append`, `set` pisaría el límite inferior.
  params.append('created_at', `gte.${opts.gte}`);
  params.append('created_at', `lt.${opts.lt}`);
  for (let offset = 0; ; offset += PAGE) {
    const { rows } = await restGet<LeadColumns>(env, params, {
      from: offset,
      to: offset + PAGE - 1,
    });
    for (const r of rows) if (r.email) out.push(r.email.trim().toLowerCase());
    if (rows.length < PAGE) break;
  }
  return out;
}

/** El lead más reciente, para el "último lead recibido". */
export async function fetchLastLeadAt(env: LeadsEnv): Promise<string | null> {
  if (env.kind === 'pg') {
    const r = await leadsPool(env.url).query(
      `SELECT to_char(max(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS at FROM clientes`,
    );
    return r.rows[0]?.at ?? null;
  }
  const params = baseParams('created_at');
  const { rows } = await restGet<LeadColumns>(env, params, { from: 0, to: 0 });
  return rows[0]?.created_at ?? null;
}
