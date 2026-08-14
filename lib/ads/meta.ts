/**
 * Cliente de la Marketing API de Meta: lectura de gasto y jerarquía + escritura
 * de estado y presupuesto (T13).
 *
 * QUÉ TOKEN HACE FALTA Y POR QUÉ NO SIRVE EL DE CAPI
 * `META_CAPI_TOKEN` (el de los funnels) sirve para MANDAR eventos a la
 * Conversions API. Leer gasto es otra API y otro permiso: hace falta `ads_read`,
 * y escribir (`pausar`, `activar`, `daily_budget`) hace falta `ads_management`,
 * que es OTRO permiso y además exige que el usuario del sistema tenga la cuenta
 * asignada con rol de administrador, no de analista. Se verificó con
 * `debug_token`: el de CAPI tiene solo `read_ads_dataset_quality` y
 * `/me/adaccounts` le devuelve "(#200) Missing Permissions".
 *
 * Por eso el panel usa su propia variable, `META_ADS_TOKEN`. Separadas a
 * propósito: nada de lo que se haga acá puede romper el envío de eventos, que es
 * el camino de la plata.
 *
 * EL TOKEN VA EN EL HEADER, EN TODAS LAS LLAMADAS (D-A3)
 * Antes iba en el query string. Deja de ser tolerable en el momento exacto en
 * que el token tiene `ads_management`: a partir de ahí cada URL de lectura
 * transporta una credencial que puede apagar la facturación de la cuenta, y las
 * URLs terminan en logs de acceso, mensajes de error, trazas y proxies. Por la
 * misma razón, `MetaAdsError` NUNCA lleva la URL en el mensaje, y la paginación
 * limpia el `access_token` que Meta mete dentro de `paging.next`.
 *
 * NIVEL DE DETALLE
 * Se pide `level=ad` con `time_increment=1`: una fila por anuncio y por día. Es
 * el grano más fino, y agregar por campaña o por día después es un GROUP BY.
 *
 * Los UTMs de los funnels traen `nombre|id` de Meta en utm_campaign (campaña),
 * utm_medium (conjunto) y utm_content (anuncio), así que este gasto se cruza con
 * las ventas por ID exacto, no por nombre.
 */

import type {
  MetaAd,
  MetaAdSet,
  MetaCampaign,
  MetaCuenta,
  MetaObjetoLeido,
  NivelAds,
  ResultadoEscritura,
  UsoCuenta,
} from './tipos';

export type MetaInsightRow = {
  date: string;
  accountId: string;
  campaignId: string;
  campaignName: string | null;
  adsetId: string;
  adsetName: string | null;
  adId: string;
  adName: string | null;
  spend: number;
  impressions: number;
  clicks: number;
};

export type MetaAccount = {
  accountId: string;
  name: string | null;
  currency: string | null;
  status: number | null;
  /**
   * Zona horaria con la que Meta reporta los días de esta cuenta. Es el dato
   * que define el corte de `ad_spend.day`: con `time_increment=1` Meta no
   * devuelve la zona en cada fila, la aplica según la configuración de la
   * cuenta. Sin guardarla, comparar el gasto del día con la facturación del día
   * de la tienda es comparar dos recortes distintos sin saberlo.
   */
  timezone: string | null;
};

/**
 * El sobre de error de Meta, con los cuatro campos extra que el backoff (D-A14)
 * necesita. Hoy se conserva `message`, `code` y `type` y el resto se descarta;
 * sin `subcode` no se puede distinguir un `17` de cuota de usuario de otro `17`
 * cualquiera, y sin `httpStatus` un 5xx se confunde con un 400.
 */
export class MetaAdsError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly type?: string,
    readonly subcode?: number,
    readonly transient?: boolean,
    readonly traceId?: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'MetaAdsError';
  }
}

// D-A16b: la versión de la Graph API es configurable para que su sunset (v21 cae
// alrededor de principios de 2027) no obligue a un deploy de código. Validada
// contra el formato vXX.Y para que un typo no produzca una URL rarísima con un
// 404 confuso. El error se tira al importar, así que un deploy apuntando a una
// versión retirada falla en el arranque y no en runtime.
const API_VERSION = (() => {
  const v = process.env.META_API_VERSION ?? 'v21.0';
  if (!/^v\d+\.\d+$/.test(v)) {
    throw new MetaAdsError(`META_API_VERSION inválida: ${v}`);
  }
  return v;
})();

const BASE = `https://graph.facebook.com/${API_VERSION}`;

function token(): string {
  const t = process.env.META_ADS_TOKEN;
  if (!t) {
    throw new MetaAdsError(
      'falta META_ADS_TOKEN — se necesita un token de usuario del sistema con permiso ads_read y ads_management',
    );
  }
  return t;
}

// ─── Telemetría de uso y contador de llamadas ────────────────────────────────

// El consumo que Meta informa en `x-business-use-case-usage`, por cuenta. Es un
// Map y NO un `let` global porque una respuesta sana de la cuenta B taparía la
// saturación de la cuenta A (D-A14): el backoff golpearía a A hasta que Meta la
// corte, y el síntoma visible sería "el backoff no funciona".
const usoPorCuenta = new Map<string, UsoCuenta>();

// Contador de llamadas salientes, para que el criterio §9.7 del plan ("con
// ads_rules_enabled=false el worker no hace NI UNA llamada a Meta") sea
// verificable por número y no por lectura de código.
const contador = { total: 0, porCuenta: {} as Record<string, number> };

// Clave reservada para las llamadas que no pertenecen a una cuenta concreta
// (/me/adaccounts, debug_token). Que el Map no tenga entrada para una cuenta
// significa "todavía no le hablé", que es distinto de "está al 0%": devolvemos null.
const CLAVE_APP = '_app';

/**
 * Lee el header `x-business-use-case-usage` y guarda el consumo de la cuenta.
 * Es telemetría: si el header no viene o no parsea, NO tira (un cambio de
 * formato en un header de Meta no puede dejar el panel sin gasto).
 */
function leerUso(res: Response, accountId: string | undefined): void {
  if (!accountId) return;
  const raw = res.headers.get('x-business-use-case-usage');
  if (!raw) return;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const key = Object.keys(obj)[0];
    const arr = key ? (obj[key] as unknown) : undefined;
    const u = (Array.isArray(arr) ? arr[0] : undefined) as
      | {
          call_count?: number;
          total_time?: number;
          total_cputime?: number;
          estimated_time_to_regain_access?: number;
        }
      | undefined;
    if (!u) return;
    const regainMin = Number(u.estimated_time_to_regain_access ?? 0);
    usoPorCuenta.set(accountId, {
      callCount: Number(u.call_count ?? 0),
      totalTime: Number(u.total_time ?? 0),
      totalCPUTime: Number(u.total_cputime ?? 0),
      regainAccessAt: regainMin > 0 ? new Date(Date.now() + regainMin * 60_000) : null,
    });
  } catch {
    // telemetría: ignorar
  }
}

/** El consumo que Meta informó para ESA cuenta, o null si todavía no le hablamos. */
export function ultimoUso(accountId: string): UsoCuenta | null {
  return usoPorCuenta.get(accountId) ?? null;
}

/** Cuántas llamadas salieron desde el último reinicio del contador. Lo imprime el worker. */
export function contadorLlamadas(): { total: number; porCuenta: Record<string, number> } {
  return { total: contador.total, porCuenta: { ...contador.porCuenta } };
}

export function reiniciarContador(): void {
  contador.total = 0;
  contador.porCuenta = {};
}

// ─── HTTP de lectura y escritura ─────────────────────────────────────────────

type MetaErrorBody = {
  error?: {
    message?: string;
    code?: number;
    type?: string;
    error_subcode?: number;
    is_transient?: boolean;
    fbtrace_id?: string;
  };
};

/** Timeout explícito: sin esto, una llamada colgada deja el cron trabado. */
async function pedir<T>(url: string, accountId?: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token()}` },
    signal: AbortSignal.timeout(30_000),
  });
  contador.total += 1;
  if (accountId) contador.porCuenta[accountId] = (contador.porCuenta[accountId] ?? 0) + 1;
  leerUso(res, accountId);
  // El cuerpo se tipa sin intersectar con T: `T & MetaErrorBody` con T genérico
  // forma un tipo circular cuando el llamador instancia T con un tipo que a su
  // vez lo referencia, y tsc lo rechaza (TS7022). El cast final lo deja en T.
  const body = (await res.json().catch(() => null)) as { error?: MetaErrorBody['error'] } | null;
  if (!res.ok || (body && body.error)) {
    const e = body?.error;
    throw new MetaAdsError(
      e?.message ?? `HTTP ${res.status} de la API de Meta`,
      e?.code,
      e?.type,
      e?.error_subcode,
      e?.is_transient,
      e?.fbtrace_id,
      res.status,
    );
  }
  return body as unknown as T;
}

/**
 * POST a un objeto de Meta. Devuelve `ResultadoEscritura` y no tira, porque un
 * POST que corta por timeout PUEDE haberse aplicado igual: el llamador tiene que
 * poder distinguir "Meta dijo no" (fallido) de "no se sabe" (indeterminado),
 * porque reintentar a ciegas es cómo una subida de presupuesto se aplica dos
 * veces (§6c del plan).
 */
export async function enviar(
  objectId: string,
  campos: Record<string, string>,
): Promise<ResultadoEscritura> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/${objectId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(campos),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    // AbortError del timeout o error de red (ECONNRESET, etc.): el pedido pudo
    // haberse aplicado en Meta y no lo sabemos.
    return {
      estado: 'indeterminado',
      error: new MetaAdsError(
        e instanceof Error ? e.message : String(e),
        undefined,
        undefined,
        undefined,
        true,
      ),
    };
  }
  contador.total += 1;
  const body = (await res.json().catch(() => null)) as
    | ({ success?: boolean } & MetaErrorBody)
    | null;
  const e = body?.error;
  if (!res.ok || (body && 'error' in body && e)) {
    // Un 5xx sin body: el server pudo haber procesado el cambio y caerse. No se
    // sabe. Un error de Meta con code: Meta procesó y rechazó, no pasó nada.
    if (res.status >= 500 && !e) {
      return {
        estado: 'indeterminado',
        error: new MetaAdsError(
          `HTTP ${res.status} de la API de Meta`,
          undefined,
          undefined,
          undefined,
          true,
          undefined,
          res.status,
        ),
      };
    }
    return {
      estado: 'fallido',
      error: new MetaAdsError(
        e?.message ?? `HTTP ${res.status} de la API de Meta`,
        e?.code,
        e?.type,
        e?.error_subcode,
        e?.is_transient,
        e?.fbtrace_id,
        res.status,
      ),
    };
  }
  if (body && body.success === true) return { estado: 'confirmado' };
  // HTTP ok pero sin confirmación: no se puede dar por hecha.
  return {
    estado: 'fallido',
    error: new MetaAdsError('respuesta de Meta sin confirmación', undefined, undefined, undefined, false, undefined, res.status),
  };
}

// ─── Paginación ──────────────────────────────────────────────────────────────

// Meta devuelve `paging.next` con el `access_token` ADENTRO de la URL. Si se sigue
// el cursor verbatim, el token termina en la URL de todas las páginas menos la
// primera (D-A3). Borrar el parámetro es menos código que reconstruir la URL y
// sobrevive a que Meta agregue parámetros al cursor en el futuro.
function limpiarCursor(next: string): string {
  const u = new URL(next);
  u.searchParams.delete('access_token');
  return u.toString();
}

/** Una página de una edge de Meta. `paging.next` es el cursor, con el token adentro. */
type Pagina<T> = { data?: T[]; paging?: { next?: string } };

/** Pagina hasta el final, con el mismo cortafuegos que fetchInsights. */
async function paginar<T>(urlInicial: string, accountId: string): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = urlInicial;
  let vueltas = 0;
  while (url) {
    // Cortafuegos: si algo sale mal con los cursores, no se itera para siempre.
    if (++vueltas > 100) {
      throw new MetaAdsError('la paginación de Meta no terminó después de 100 páginas');
    }
    const d: Pagina<T> = await pedir<Pagina<T>>(url, accountId);
    out.push(...(d.data ?? []));
    url = d.paging?.next ? limpiarCursor(d.paging.next) : null;
  }
  return out;
}

// ─── Lectura de gasto (ya existía, firma congelada) ─────────────────────────

/** Las cuentas que el token puede leer. Sirve para descubrirlas sin pedirle ids. */
export async function listAccounts(): Promise<MetaAccount[]> {
  const url = `${BASE}/me/adaccounts?fields=id,name,currency,account_status,timezone_name&limit=200`;
  const d = await pedir<{
    data?: Array<{
      id: string;
      name?: string;
      currency?: string;
      account_status?: number;
      timezone_name?: string;
    }>;
  }>(url, CLAVE_APP);
  return (d.data ?? []).map((a) => ({
    accountId: a.id,
    name: a.name ?? null,
    currency: a.currency ?? null,
    status: a.account_status ?? null,
    timezone: a.timezone_name ?? null,
  }));
}

/**
 * Gasto por anuncio y por día para un rango. Sigue la paginación de Meta hasta
 * el final: sin eso, una cuenta con muchos anuncios devuelve solo la primera
 * página y el gasto queda corto sin ningún error visible.
 */
export async function fetchInsights(
  accountId: string,
  since: string,
  until: string,
): Promise<MetaInsightRow[]> {
  const fields = [
    'spend',
    'impressions',
    'clicks',
    'campaign_id',
    'campaign_name',
    'adset_id',
    'adset_name',
    'ad_id',
    'ad_name',
  ].join(',');
  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));

  const urlInicial =
    `${BASE}/${accountId}/insights` +
    `?level=ad&time_increment=1&fields=${fields}` +
    `&time_range=${timeRange}&limit=500`;

  const out: MetaInsightRow[] = [];
  let url: string | null = urlInicial;
  let vueltas = 0;

  while (url) {
    if (++vueltas > 100) {
      throw new MetaAdsError('la paginación de Meta no terminó después de 100 páginas');
    }
    const d: Pagina<Record<string, string | undefined>> = await pedir<
      Pagina<Record<string, string | undefined>>
    >(url, accountId);

    for (const r of d.data ?? []) {
      // `spend` viene como string y puede faltar si el anuncio no gastó ese día.
      const spend = Number(r.spend ?? 0);
      out.push({
        date: r.date_start ?? since,
        accountId,
        campaignId: r.campaign_id ?? '',
        campaignName: r.campaign_name ?? null,
        adsetId: r.adset_id ?? '',
        adsetName: r.adset_name ?? null,
        adId: r.ad_id ?? '',
        adName: r.ad_name ?? null,
        spend: Number.isFinite(spend) ? spend : 0,
        impressions: Number(r.impressions ?? 0) || 0,
        clicks: Number(r.clicks ?? 0) || 0,
      });
    }
    url = d.paging?.next ? limpiarCursor(d.paging.next) : null;
  }

  return out;
}

// ─── Lectura de la jerarquía (T14) ──────────────────────────────────────────

// `daily_budget`/`lifetime_budget` llegan como string ("2500") y representan
// unidades mínimas de la moneda de la cuenta. Se pasan a number una sola vez.
function unidadesMinimas(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

type RawCampaign = {
  id: string;
  name?: string;
  objective?: string;
  status?: string;
  effective_status?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  bid_strategy?: string;
  created_time?: string;
};

/**
 * Campañas de la cuenta, paginadas hasta el final. `effective_status` se pide
 * SIEMPRE: es lo que dice Meta que pasa de verdad, con valores que no se pueden
 * escribir (CAMPAIGN_PAUSED, WITH_ISSUES, ...). Sin él, el panel muestra "activo"
 * un conjunto cuya campaña está pausada.
 */
export async function fetchCampaigns(accountId: string): Promise<MetaCampaign[]> {
  const fields =
    'id,name,objective,status,effective_status,daily_budget,lifetime_budget,bid_strategy,created_time';
  const url = `${BASE}/${accountId}/campaigns?fields=${fields}&limit=200`;
  const rows = await paginar<RawCampaign>(url, accountId);
  return rows.map((r) => ({
    campaignId: r.id,
    name: r.name ?? null,
    objective: r.objective ?? null,
    status: r.status ?? null,
    effectiveStatus: r.effective_status ?? null,
    dailyBudget: unidadesMinimas(r.daily_budget),
    lifetimeBudget: unidadesMinimas(r.lifetime_budget),
    bidStrategy: r.bid_strategy ?? null,
    createdTime: r.created_time ?? null,
  }));
}

type RawAdSet = {
  id: string;
  campaign_id?: string;
  name?: string;
  status?: string;
  effective_status?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  optimization_goal?: string;
  billing_event?: string;
  bid_strategy?: string;
  created_time?: string;
};

export async function fetchAdSets(accountId: string): Promise<MetaAdSet[]> {
  const fields =
    'id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,optimization_goal,billing_event,bid_strategy,created_time';
  const url = `${BASE}/${accountId}/adsets?fields=${fields}&limit=200`;
  const rows = await paginar<RawAdSet>(url, accountId);
  return rows.map((r) => ({
    adsetId: r.id,
    campaignId: r.campaign_id ?? '',
    name: r.name ?? null,
    status: r.status ?? null,
    effectiveStatus: r.effective_status ?? null,
    dailyBudget: unidadesMinimas(r.daily_budget),
    lifetimeBudget: unidadesMinimas(r.lifetime_budget),
    optimizationGoal: r.optimization_goal ?? null,
    billingEvent: r.billing_event ?? null,
    bidStrategy: r.bid_strategy ?? null,
    createdTime: r.created_time ?? null,
  }));
}

type RawAd = {
  id: string;
  adset_id?: string;
  campaign_id?: string;
  name?: string;
  status?: string;
  effective_status?: string;
  creative?: { id?: string };
  created_time?: string;
};

export async function fetchAds(accountId: string): Promise<MetaAd[]> {
  const fields = 'id,name,adset_id,campaign_id,status,effective_status,created_time,creative{id}';
  const url = `${BASE}/${accountId}/ads?fields=${fields}&limit=200`;
  const rows = await paginar<RawAd>(url, accountId);
  return rows.map((r) => ({
    adId: r.id,
    adsetId: r.adset_id ?? '',
    campaignId: r.campaign_id ?? '',
    name: r.name ?? null,
    status: r.status ?? null,
    effectiveStatus: r.effective_status ?? null,
    creativeId: r.creative?.id ?? null,
    createdTime: r.created_time ?? null,
  }));
}

/** Moneda y zona de la cuenta. Es lo que decide si la cuenta se procesa (D-A10). */
export async function fetchCuenta(accountId: string): Promise<MetaCuenta> {
  const d = await pedir<{
    currency?: string;
    timezone_name?: string;
    account_status?: number;
  }>(`${BASE}/${accountId}?fields=currency,timezone_name,account_status`, accountId);
  return {
    accountId,
    currency: d.currency ?? null,
    timezoneName: d.timezone_name ?? null,
    accountStatus: d.account_status ?? null,
  };
}

/**
 * El mínimo de presupuesto diario de la cuenta, en unidades mínimas.
 * `null` significa "NO SÉ el mínimo", nunca "el mínimo es 0" (D-A10).
 *
 * La edge `/minimum_budgets` devuelve UNA lista por cuenta, con un renglón por
 * moneda. Para una cuenta EUR, el renglón EUR trae:
 *   min_daily_budget_imp = 87 (€0,87), el piso absoluto que Meta acepta.
 * Los otros campos (video_views, high_freq, low_freq) dependen del objetivo y del
 * billing event y NO se usan todavía: este módulo sólo necesita un piso para no
 * pedir presupuestos que Meta rechaza (P-A11, resuelta en T13).
 */
export async function fetchMinimoPresupuesto(accountId: string): Promise<number | null> {
  const cuenta = await fetchCuenta(accountId);
  if (!cuenta.currency) return null;
  const d = await pedir<{
    data?: Array<{
      currency?: string;
      min_daily_budget_imp?: number | string;
    }>;
  }>(`${BASE}/${accountId}/minimum_budgets`, accountId);
  const row = (d.data ?? []).find((r) => r.currency === cuenta.currency);
  if (!row) return null;
  const n = Number(row.min_daily_budget_imp ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ─── Escritura (T16) ────────────────────────────────────────────────────────

/**
 * POST /{objectId} con status. Solo ACTIVE y PAUSED: nada irreversible (§0).
 * Un `ARCHIVED` o `DELETED` no existe en la firma a propósito.
 */
export async function setStatus(objectId: string, status: 'ACTIVE' | 'PAUSED'): Promise<void> {
  if (status !== 'ACTIVE' && status !== 'PAUSED') {
    throw new MetaAdsError(`setStatus: estado no escribible: ${status}`);
  }
  const r = await enviar(objectId, { status });
  if (r.estado !== 'confirmado') throw r.error;
}

/**
 * POST /{objectId} con daily_budget en unidades mínimas. Entero (D-A6).
 * `unidadesMinimas <= 0` es un bug del llamador: rechazarlo acá ahorra una
 * llamada de cuota que Meta rechazaría igual con un error que en el log parece
 * un problema de permisos.
 */
export async function setDailyBudget(objectId: string, unidadesMinimas: number): Promise<void> {
  if (!Number.isInteger(unidadesMinimas)) {
    throw new MetaAdsError(`setDailyBudget: el presupuesto tiene que ser un entero en unidades mínimas (vino ${unidadesMinimas})`);
  }
  if (unidadesMinimas <= 0) {
    throw new MetaAdsError(`setDailyBudget: el presupuesto tiene que ser mayor que cero (vino ${unidadesMinimas})`);
  }
  const r = await enviar(objectId, { daily_budget: String(unidadesMinimas) });
  if (r.estado !== 'confirmado') throw r.error;
}

/**
 * Lee UN objeto de Meta. Es la pieza que hace posible reconciliar: cuando un
 * POST termina en timeout no se sabe si se aplicó, y la única forma de
 * averiguarlo es preguntarle a Meta, que es el source of truth (§6b).
 */
export async function fetchObjeto(objectId: string, level: NivelAds): Promise<MetaObjetoLeido | null> {
  const d = await pedir<{
    id?: string;
    status?: string;
    effective_status?: string;
    daily_budget?: string;
    lifetime_budget?: string;
    error?: { code?: number };
  } | null>(`${BASE}/${objectId}?fields=id,status,effective_status,daily_budget,lifetime_budget`);
  if (!d || !d.id) return null;
  return {
    objectId: d.id,
    status: d.status ?? null,
    effectiveStatus: d.effective_status ?? null,
    dailyBudget: unidadesMinimas(d.daily_budget),
    lifetimeBudget: unidadesMinimas(d.lifetime_budget),
  };
}

// ─── Verificación de permisos (scripts/verificar-token-ads.ts) ──────────────

/**
 * Qué permisos tiene el token. `debug_token` lista los scopes; `ads_management`
 * y `ads_read` son los dos que este módulo necesita. Con algunos tokens de
 * usuario del sistema `debug_token` falla aunque la escritura funcione: por eso
 * la prueba que decide es la escritura no-op de scripts/verificar-token-ads.ts,
 * no esta función.
 */
export async function verificarPermisos(): Promise<{
  ok: boolean;
  scopes: string[];
  falta: string[];
  detalle: string;
  apiVersion: string;
}> {
  const d = await pedir<{ data?: { scopes?: string[] } }>(
    `${BASE}/debug_token?input_token=${encodeURIComponent(token())}`,
    CLAVE_APP,
  );
  const scopes = d.data?.scopes ?? [];
  const requeridos = ['ads_read', 'ads_management'];
  const falta = requeridos.filter((s) => !scopes.includes(s));
  const detalle = falta.length
    ? `al token le falta: ${falta.join(', ')}`
    : 'el token declara ads_read y ads_management';
  return {
    ok: falta.length === 0,
    scopes,
    falta,
    detalle,
    apiVersion: API_VERSION,
  };
}
