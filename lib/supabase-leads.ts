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
 * Paginación: PostgREST corta en 1000 filas en silencio (el bug real que los
 * funnels ya se comieron en `lib/admin/supabase-store.ts`), así que todo
 * fetch que pueda superar ese número pagina con el header `Range` hasta que
 * la respuesta traiga menos filas que el tamaño de página.
 */

export type LeadsEnv = { url: string; key: string };

export function getLeadsEnv(slug: string): LeadsEnv | null {
  const url = process.env[`SUPABASE_URL_${slug.toUpperCase()}`];
  const key = process.env[`SUPABASE_SERVICE_KEY_${slug.toUpperCase()}`];
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ''), key };
}

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
  env: LeadsEnv,
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
  const params = baseParams('created_at');
  const { rows } = await restGet<LeadColumns>(env, params, { from: 0, to: 0 });
  return rows[0]?.created_at ?? null;
}
