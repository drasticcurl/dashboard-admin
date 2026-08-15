import { z } from 'zod';
import type { IngestPayload } from '../types';

// Centinela de la atribución, idéntico al de los funnels
// (testfunnel/lib/utm.ts: DIRECT_LABEL). PostgreSQL trata NULL ≠ NULL, así que
// una columna con NULL nunca matchearía el CASE del upsert del plan §3.3, que
// compara contra '(directo)': con NULL la atribución quedaría congelada en
// directo para siempre y la campaña no entraría jamás.
export const DIRECT_LABEL = '(directo)';

// Replica exacta de cleanUtmValue de testfunnel/lib/utm.ts. No es un
// "parecido": si el dashboard normalizara distinto que el checkout, la campaña
// de una sesión y la de su venta no matchearían y la atribución se parte
// (task T02 §4).
export function cleanUtmValue(raw: string | null | undefined): string {
  if (raw == null) return '';
  let v = String(raw);
  // Muchos sistemas codifican el espacio como '+'; decodeURIComponent no lo
  // decodifica, así que se reemplaza antes. Si el '%XX' restante es inválido se
  // conserva el raw con los '+' ya limpios, en vez de tirar el valor entero.
  try {
    v = decodeURIComponent(v.replace(/\+/g, ' '));
  } catch {
    v = v.replace(/\+/g, ' ');
  }
  return v.replace(/\s+/g, ' ').trim();
}

// Un reloj mal puesto en el cliente puede meter eventos en 2035 y romper la
// partición (plan §3.4). Fuera de rango no se descarta: se clampea a now() y se
// avisa con un warning (task T02 §4).
const FUTURE_CLAMP_MS = 24 * 60 * 60 * 1000;
const PAST_CLAMP_MS = 30 * 24 * 60 * 60 * 1000;

const eventSchema = z
  .object({
    name: z.string(),
    at: z.string().datetime(),
    stepIndex: z.number().int().min(0).max(200).optional(),
    stepSlug: z.string().optional(),
    value: z.number().int().optional(),
    currency: z.string().optional(),
    eventUid: z.string().optional(),
    // props es jsonb libre, pero un funnel con un bug que mande 1 MB por
    // evento inflaría events sin aportar nada: tope de 4 KB serializados.
    props: z.record(z.unknown()).optional(),
  })
  .superRefine((ev, ctx) => {
    const bytes = Buffer.byteLength(JSON.stringify(ev.props ?? {}), 'utf8');
    if (bytes > 4096) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `props supera los 4 KB serializados (${bytes} bytes)`,
      });
    }
  });

// z.object() descarta por defecto las claves no declaradas: las claves de utms
// que no sean las 6 conocidas se ignoran en silencio (task T02 §4).
const utmSchema = z.object({
  utm_source: z.string().optional(),
  utm_medium: z.string().optional(),
  utm_campaign: z.string().optional(),
  utm_content: z.string().optional(),
  utm_term: z.string().optional(),
  fbclid: z.string().optional(),
});

const contextSchema = z.object({
  utms: utmSchema.optional(),
  country: z.string().length(2).optional(),
  device: z.string().optional(),
  referrer: z.string().optional(),
  path: z.string().optional(),
});

// Charset de `experiment`. El largo solo NO alcanza: 'a\u0000b' mide 3 y pasaba
// el .max(32), y después Postgres rechaza el INSERT con 22021
// (report_invalid_encoding: un texto no puede contener el byte NUL), así que el
// LOTE ENTERO terminaba en 500 en vez de rechazarse limpio con 400.
//
// `experiment` es un token cerrado del funnel (los valores reales son 'A' y
// 'B'), no texto libre: se acota a alfanumérico, guion y guion bajo, más letras
// latinas acentuadas (U+00C0–U+024F) para no romper una etiqueta con tilde.
// La clase se escribe con rangos explícitos y sin la bandera `u`: el tsconfig no
// declara `target`, así que `\p{L}` no compila.
// El `*` y no `+` es a propósito: la cadena vacía se sigue aceptando, igual que
// antes del cambio.
const EXPERIMENT_CHARSET = /^[A-Za-z0-9_\-\u00C0-\u024F]*$/;

export const ingestPayloadSchema = z.object({
  sessionId: z.string().uuid(),
  visitorId: z.string().uuid(),
  variant: z.string().max(32).default('default'),
  // Dimensión del experimento A/B del pop-up. Sin `.default()`: la ausencia
  // tiene que llegar como `undefined` hasta la columna, para que el COALESCE
  // del upsert distinga "no vino" de "vino algo".
  experiment: z
    .string()
    .max(32)
    .regex(
      EXPERIMENT_CHARSET,
      'experiment solo acepta letras, números, guion y guion bajo (es un token, no texto libre)',
    )
    .optional(),
  events: z.array(eventSchema).min(1).max(50),
  context: contextSchema.optional(),
});

export type IngestParseResult = { payload: IngestPayload; warnings: string[] };

function hostnameOf(referrer: string): string | undefined {
  try {
    return new URL(referrer).hostname;
  } catch {
    // Un referrer sin scheme no es una URL: mejor NULL que basura en la columna.
    return undefined;
  }
}

/** Valida el §4 del plan y deja el payload normalizado. Tira ZodError si falla. */
export function parseIngestPayload(raw: unknown): IngestParseResult {
  const parsed = ingestPayloadSchema.parse(raw);
  const warnings: string[] = [];
  const now = new Date();

  const events = parsed.events.map((ev) => {
    const at = new Date(ev.at);
    if (at.getTime() > now.getTime() + FUTURE_CLAMP_MS || at.getTime() < now.getTime() - PAST_CLAMP_MS) {
      warnings.push('clamped_at');
      return { ...ev, at: now.toISOString() };
    }
    return ev;
  });

  const utms = parsed.context?.utms;
  const clean = (v?: string) => cleanUtmValue(v) || DIRECT_LABEL;
  const cleanedFbclid = utms ? cleanUtmValue(utms.fbclid) : '';
  const context = parsed.context
    ? {
        utms: utms
          ? {
              utm_source: clean(utms.utm_source),
              utm_medium: clean(utms.utm_medium),
              utm_campaign: clean(utms.utm_campaign),
              utm_content: clean(utms.utm_content),
              utm_term: clean(utms.utm_term),
              // fbclid es un token opaco, no una UTM: vacío se guarda como NULL
              // y no como '(directo)', porque la columna es nullable y el
              // COALESCE del upsert distingue NULL de un valor real.
              fbclid: cleanedFbclid === '' ? undefined : cleanedFbclid,
            }
          : undefined,
        country: parsed.context.country?.toUpperCase(),
        device: parsed.context.device,
        referrer: parsed.context.referrer ? hostnameOf(parsed.context.referrer) : undefined,
        path: parsed.context.path,
      }
    : undefined;

  return {
    payload: {
      sessionId: parsed.sessionId,
      visitorId: parsed.visitorId,
      variant: parsed.variant,
      // El experimento es un token cerrado del funnel, no una UTM: se pasa tal
      // cual, sin cleanUtmValue (que lo normalizaría como campaña).
      experiment: parsed.experiment,
      events,
      context,
    },
    warnings,
  };
}
