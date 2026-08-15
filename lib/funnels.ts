import { q, q1 } from './db';
import { createHash } from 'node:crypto';

export type Funnel = {
  id: number;
  slug: string;
  name: string;
  /**
   * Nombre para mostrar en el selector del panel. null = sin alias, se muestra
   * `name`. Es SOLO presentación: la identidad sigue siendo `slug`, así que
   * cambiar un alias no toca ninguna URL ni ninguna FK.
   */
  alias: string | null;
  timezone: string;
  sellCurrency: string;
  variants: string[];
  /**
   * Conjunto de valores declarados de la dimensión `experiment` (A/B del
   * pop-up). Vacío = no se valida nada en el ingest: un funnel que no testea
   * no tiene por qué empezar a llenar ingest_errors.
   */
  experiments: string[];
  color: string;
  active: boolean;
};

export type FunnelStep = {
  stepIndex: number;
  slug: string;
  label: string;
  kind: string;
  countsInFunnel: boolean;
};

const FUNNEL_SELECT = `
  SELECT id, slug, name, alias, timezone, sell_currency AS "sellCurrency",
         variants, experiments, color, active
  FROM funnels`;

// El helper vive en `lib/funnel-nombre.ts` porque este módulo importa `pg` y
// los componentes de cliente no pueden arrastrarlo al bundle. Se re-exporta para
// que el código de servidor lo tenga en el mismo lugar que el resto de funnels.
export { nombreVisible } from './funnel-nombre';

export async function listFunnels(opts?: { includeInactive?: boolean }): Promise<Funnel[]> {
  const where = opts?.includeInactive ? '' : 'WHERE active = true';
  return q<Funnel>(`${FUNNEL_SELECT} ${where} ORDER BY id`);
}

export async function getFunnelBySlug(slug: string): Promise<Funnel | null> {
  return q1<Funnel>(`${FUNNEL_SELECT} WHERE slug = $1`, [slug]);
}

export async function getFunnelById(id: number): Promise<Funnel | null> {
  return q1<Funnel>(`${FUNNEL_SELECT} WHERE id = $1`, [id]);
}

// Cache en memoria de 60 s: el ingest llama a esta función en cada request y
// pegarle a la base por cada evento es el cuello de botella más tonto posible.
// Se cachea también el null: una key inválida se sigue rechazando igual, solo
// que sin consultar la base 50 veces por batch.
const keyCache = new Map<string, { funnel: Funnel | null; expires: number }>();
const KEY_CACHE_TTL_MS = 60_000;

/** Resuelve el funnel a partir de la ingest key en claro. Hashea y busca por hash. */
export async function getFunnelByIngestKey(key: string): Promise<Funnel | null> {
  const hash = createHash('sha256').update(key).digest('hex');
  const cached = keyCache.get(hash);
  if (cached && cached.expires > Date.now()) return cached.funnel;
  const funnel = await q1<Funnel>(`${FUNNEL_SELECT} WHERE ingest_key_hash = $1`, [hash]);
  keyCache.set(hash, { funnel, expires: Date.now() + KEY_CACHE_TTL_MS });
  return funnel;
}

export async function listSteps(funnelId: number): Promise<FunnelStep[]> {
  return q<FunnelStep>(
    `SELECT step_index AS "stepIndex", slug, label, kind, counts_in_funnel AS "countsInFunnel"
     FROM funnel_steps
     WHERE funnel_id = $1
     ORDER BY step_index`,
    [funnelId],
  );
}
