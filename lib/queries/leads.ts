/**
 * Leads (task T09 §A) — el lado Postgres del cruce + el formato del CSV.
 *
 * Los leads viven en Supabase (`clientes`) y acá solo vive lo que es de esta
 * base: el set de emails de compradores aprobados (`orders`, la fuente de
 * verdad nueva — NO `purchases` de Supabase, que es el entitlement de la
 * PWA y ya no manda en atribución). Es el mismo cruce que hacía
 * `/api/admin/leads-stats`, pero contra la fuente correcta.
 *
 * La comparación es lowercase en ambos lados: `clientes` guarda el email
 * casi siempre en minúsculas, pero `orders` puede venir con caps desde
 * Shopify/Hotmart (misma regla que el panel viejo).
 *
 * El CSV es una copia literal de `/api/admin/leads-export` de los funnels
 * (borrado por T10/T11; rescatado del backup `Copia de testfunnel`): mismo
 * escape, mismos tags, misma nota, mismo BOM, mismo CRLF. Shopify acepta ese
 * formato hoy: si cambia algo de esto, el import de Customers falla.
 */

import { q, q1 } from '@/lib/db';
import {
  countLeads,
  fetchAllLeads,
  fetchLastLeadAt,
  fetchLeadEmailsInRange,
  fetchRecentLeads,
  getLeadsEnv,
  type LeadColumns,
  type LeadsEnv,
} from '@/lib/supabase-leads';

export type RecentLead = {
  email: string;
  nombre: string | null;
  createdAt: string;
  compro: boolean | string | null;
  utmSource: string | null;
  utmCampaign: string | null;
  tipoHinchazon: number | null;
  severidad: number | null;
};

export type LeadsData = {
  configured: boolean; // false = faltan las vars de Supabase para este funnel
  supabaseError: string | null; // env configurado pero el fetch falló (D20: se muestra, no se tapa)
  totalLeads: number; // histórico completo
  rangeLeads: number; // dentro del rango elegido
  buyers: number; // leads del rango que ya compraron (status approved en orders)
  nonBuyers: number; // leads del rango sin compra aprobada
  last24h: number;
  last7d: number;
  last30d: number;
  lastLeadAt: string | null;
  recent: RecentLead[]; // últimos 100
  generatedAt: string;
};

export function emptyLeadsData(extra: Partial<LeadsData> = {}): LeadsData {
  return {
    configured: true,
    supabaseError: null,
    totalLeads: 0,
    rangeLeads: 0,
    buyers: 0,
    nonBuyers: 0,
    last24h: 0,
    last7d: 0,
    last30d: 0,
    lastLeadAt: null,
    recent: [],
    generatedAt: new Date().toISOString(),
    ...extra,
  };
}

/**
 * Emails de compradores aprobados en Postgres. Un email puede repetirse (una
 * compra por upsell), el Set deduplica.
 */
export async function getApprovedBuyerEmails(): Promise<Set<string>> {
  const rows = await q<{ email: string }>(
    `SELECT email FROM orders WHERE status = 'approved' AND email IS NOT NULL`,
  );
  return new Set(rows.map((r) => r.email.trim().toLowerCase()));
}

/**
 * El borde de un día como instante ISO en la TZ de un funnel: midnight local
 * de `day + addDays`. El corte del día es asunto de la TZ (D19), y acá se
 * resuelve en Postgres, no en JS — la misma razón que en lib/day.ts.
 */
export async function dayBoundaryISO(day: string, timezone: string, addDays = 0): Promise<string> {
  const row = await q1<{ at: Date }>(
    `SELECT (($1::date + $2::int)::timestamp AT TIME ZONE $3) AS at`,
    [day, addDays, timezone],
  );
  return row!.at.toISOString();
}

const ROLLING_24H = 24 * 60 * 60 * 1000;
const ROLLING_7D = 7 * ROLLING_24H;
const ROLLING_30D = 30 * ROLLING_24H;

/**
 * Stats de leads de un funnel. Tira si Supabase falla (el caller lo traduce
 * a `supabaseError` + ceros: el número no se muestra como si fuera exacto).
 */
export async function getLeadsData(
  funnel: { slug: string; timezone: string; name: string },
  range: { from: string; to: string },
): Promise<LeadsData> {
  const env = getLeadsEnv(funnel.slug);
  if (!env) {
    return emptyLeadsData({ configured: false });
  }

  // Las "últimas 24 h / 7 d / 30 d" son ventanas deslizantes de reloj, igual
  // que en el panel viejo; el rango del selector, en cambio, es el corte de
  // día de la TZ del funnel (D19). El límite inferior del rango es exclusivo
  // para que no se pisen días.
  const now = Date.now();
  const iso24h = new Date(now - ROLLING_24H).toISOString();
  const iso7d = new Date(now - ROLLING_7D).toISOString();
  const iso30d = new Date(now - ROLLING_30D).toISOString();
  const fromISO = await dayBoundaryISO(range.from, funnel.timezone);
  const toExclusiveISO = await dayBoundaryISO(range.to, funnel.timezone, 1);

  const [totalLeads, rangeLeads, last24h, last7d, last30d, lastLeadAt, recent, rangeEmails, buyerEmails] =
    await Promise.all([
      countLeads(env),
      countLeads(env, { gte: fromISO, lt: toExclusiveISO }),
      countLeads(env, { gte: iso24h }),
      countLeads(env, { gte: iso7d }),
      countLeads(env, { gte: iso30d }),
      fetchLastLeadAt(env),
      fetchRecentLeads(env, 100),
      fetchLeadEmailsInRange(env, { gte: fromISO, lt: toExclusiveISO }),
      getApprovedBuyerEmails(),
    ]);

  const buyers = rangeEmails.filter((e) => buyerEmails.has(e)).length;

  return {
    ...emptyLeadsData(),
    totalLeads,
    rangeLeads,
    buyers,
    // El conteo del rango y el de emails pueden diferir un instante (uno es
    // COUNT en la base, el otro paginado): el no-comprador nunca da negativo.
    nonBuyers: Math.max(0, rangeLeads - buyers),
    last24h,
    last7d,
    last30d,
    lastLeadAt,
    recent: recent.map((l) => ({
      email: l.email,
      nombre: l.nombre,
      createdAt: l.created_at,
      compro: l.compro,
      utmSource: l.utm_source,
      utmCampaign: l.utm_campaign,
      tipoHinchazon: l.tipo_hinchazon,
      severidad: l.severidad,
    })),
  };
}

// ─── CSV — copia literal del panel viejo ─────────────────────────────────────

type ExportLead = Pick<LeadColumns, 'email' | 'nombre' | 'created_at' | 'tipo_hinchazon' | 'severidad'>;

function severidadBucket(score: number | null | undefined): 'baja' | 'media' | 'alta' | 'sd' {
  if (score == null) return 'sd';
  if (score >= 8) return 'alta';
  if (score >= 5) return 'media';
  return 'baja';
}

function csvEscape(value: string | number | null | undefined): string {
  if (value == null) return '';
  const s = String(value);
  // Si tiene coma, comilla o newline, se envuelve en comillas y se escapan
  // las comillas dobles: es el escape que el import de Shopify entiende.
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildTags(lead: ExportLead): string {
  const tags = ['quiz-lead', 'no-comprador'];
  if (lead.tipo_hinchazon != null) tags.push(`tipo-${lead.tipo_hinchazon}`);
  const sev = severidadBucket(lead.severidad);
  if (sev !== 'sd') tags.push(`severidad-${sev}`);
  return tags.join(',');
}

function buildNote(lead: ExportLead): string {
  const parts: string[] = [];
  if (lead.tipo_hinchazon != null) parts.push(`Tipo hinchazon ${lead.tipo_hinchazon}`);
  if (lead.severidad != null) parts.push(`severidad ${lead.severidad}/10`);
  parts.push(`quiz ${new Date(lead.created_at).toISOString().slice(0, 10)}`);
  return parts.join(' — ');
}

/**
 * Construye el CSV con el formato exacto del `/api/admin/leads-export` viejo.
 * Filtra acá lo que el panel viejo filtraba en memoria: email vacío afuera y
 * compradores afuera cuando `onlyNonBuyers` (los `since` ya vino resuelto en
 * el fetch).
 */
export function buildLeadsCsv(
  leads: ExportLead[],
  buyerEmails: Set<string>,
  onlyNonBuyers: boolean,
): { csv: string; count: number } {
  const headers = [
    'First Name',
    'Last Name',
    'Email',
    'Accepts Email Marketing',
    'Tags',
    'Note',
  ];

  const lines: string[] = [headers.join(',')];

  for (const lead of leads) {
    if (!lead.email) continue;
    const lower = lead.email.trim().toLowerCase();
    if (onlyNonBuyers && buyerEmails.has(lower)) continue;

    const firstName = (lead.nombre ?? '').trim();
    lines.push(
      [
        csvEscape(firstName),
        csvEscape(''), // Last Name (no se captura)
        csvEscape(lead.email.trim()),
        csvEscape('yes'),
        csvEscape(buildTags(lead)),
        csvEscape(buildNote(lead)),
      ].join(','),
    );
  }

  // BOM al inicio: sin él Excel rompe los acentos del Note. CRLF: el import
  // de Shopify lo espera así.
  const csv = '\uFEFF' + lines.join('\r\n') + '\r\n';
  return { csv, count: lines.length - 1 };
}

/** El flujo completo del export, compartido con el route. */
export async function getLeadsCsv(
  funnel: { slug: string; timezone: string },
  opts: { since?: string | null; onlyNonBuyers: boolean },
): Promise<{ csv: string; count: number }> {
  const env = getLeadsEnv(funnel.slug);
  if (!env) {
    throw new Error('supabase_not_configured');
  }
  const sinceISO = opts.since ? await dayBoundaryISO(opts.since, funnel.timezone) : null;
  const leads = await fetchAllLeads(env, { since: sinceISO });
  const buyerEmails = opts.onlyNonBuyers ? await getApprovedBuyerEmails() : new Set<string>();
  return buildLeadsCsv(leads, buyerEmails, opts.onlyNonBuyers);
}
