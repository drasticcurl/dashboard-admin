/**
 * Tipos que cruzan fronteras entre tasks: los payloads del ingest (contrato
 * congelado, §4 del plan), el vocabulario de eventos (§6) y los enums de
 * ventas. Nada de tipos internos de una sección.
 */

export const EVENT_NAMES = [
  'step_view',
  'sales_view',
  'checkout_click',
  'upsell_view',
  'upsell_click',
  'downsell_view',
  'lead',
  'purchase',
  // Retención del VSL del upsell (`testfunnel/lib/vsl-retention.ts`). Se agregan
  // porque sin ellos cada evento de retención entra como `unknown_event`: los
  // eventos SE GUARDAN igual (nada se descarta), pero dejan una fila en
  // `ingest_errors` y el banner de avisos del embudo los cuenta. Medido en
  // producción el 2026-08-21, últimas 24 h: 679 `unknown_event`, que junto a los
  // `unknown_experiment` dejaban el banner inservible — un problema real de
  // configuración quedaba tapado por 1485 avisos esperables.
  //
  // Agregar un nombre acá NO lo convierte en un hito del embudo: `deriveSessionState`
  // decide los hitos por su propia lista y no se toca.
  'vsl_sound_on',
  'vsl_audio',
  'vsl_pitch',
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export function isKnownEvent(name: string): name is EventName {
  return (EVENT_NAMES as readonly string[]).includes(name);
}

export const TIERS = ['front', 'bump', 'upsell', 'upsell2', 'downsell', 'unknown'] as const;
export type Tier = (typeof TIERS)[number];

export const ORDER_STATUSES = ['approved', 'refunded', 'chargeback', 'pending'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Un evento del ingest (§4). name se valida contra el vocabulario, no se acota en el tipo. */
export type IngestEvent = {
  name: string;
  at: string; // ISO-8601 UTC
  stepIndex?: number;
  stepSlug?: string;
  value?: number;
  currency?: string;
  eventUid?: string;
  props?: Record<string, unknown>;
};

export type IngestContext = {
  utms?: {
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
    utm_content?: string;
    utm_term?: string;
    fbclid?: string;
  };
  country?: string;
  device?: string;
  referrer?: string;
  path?: string;
};

export type IngestPayload = {
  sessionId: string;
  visitorId: string;
  variant?: string;
  /** Dimensión del experimento A/B del pop-up ('A' | 'B'). Opcional: la ausencia se guarda NULL. */
  experiment?: string;
  events: IngestEvent[];
  context?: IngestContext;
};

/** Fila de funnel_steps tal como sale de la base (snake_case). */
export type FunnelStepRow = {
  funnel_id: number;
  step_index: number;
  slug: string;
  label: string;
  kind: string;
  counts_in_funnel: boolean;
};
