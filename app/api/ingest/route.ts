import { createHash, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { q, q1 } from '@/lib/db';
import { getFunnelByIngestKey } from '@/lib/funnels';
import { applyBatch } from '@/lib/ingest/apply';
import { deviceFromUA } from '@/lib/ingest/device';
import { parseIngestPayload } from '@/lib/ingest/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_EVENTS = 50;

function json(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, { status });
}

/**
 * Fila en ingest_errors. Para 'unauthorized' el payload NO se guarda: puede
 * ser basura de un atacante y no aporta nada; para 'invalid_payload' sí, es
 * un bug de un funnel autenticado (task T02 §3). El caller decide qué pasa.
 */
async function logError(reason: string, detail?: string, payload?: unknown): Promise<void> {
  await q('INSERT INTO ingest_errors (reason, detail, payload) VALUES ($1, $2, $3::jsonb)', [
    reason,
    detail ?? null,
    payload === undefined ? null : JSON.stringify(payload),
  ]);
}

export async function POST(req: NextRequest) {
  try {
    // 1. Tamaño, antes de parsear: un JSON de 10 MB no se parsea para después
    // rechazarlo (task T02 §3). El content-length es un filtro barato previo;
    // la medida autoritativa es la de los bytes reales.
    const declared = req.headers.get('content-length');
    if (declared && Number(declared) > MAX_BODY_BYTES) {
      return json(413, { ok: false, error: 'too_large' });
    }
    const buf = await req.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) {
      return json(413, { ok: false, error: 'too_large' });
    }
    const bodyText = new TextDecoder().decode(buf);

    // 2. Bearer. Sin header o mal formado → 401 sin fila: no hay ni funnel
    // para anotar (task T02 §3).
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
    if (!match) {
      return json(401, { ok: false, error: 'unauthorized' });
    }
    const key = match[1].trim();

    const funnel = await getFunnelByIngestKey(key);
    if (!funnel) {
      // Sin payload ni key en la fila: el que manda basura no tiene por qué
      // ver nada útil. La fila existe para el humano que mira el panel.
      await logError('unauthorized').catch(() => {});
      return json(401, { ok: false, error: 'unauthorized' });
    }

    // getFunnelByIngestKey ya matcheó por igualdad en SQL, pero === sobre
    // strings sale temprano en el primer byte distinto: la comparación
    // timing-safe va sobre el hash recuperado, contra el hash calculado. Los
    // dos en hex (el guardado está en hex): comparar binario contra hex sería
    // un mismatch de longitud y rechazaría todo.
    const presented = Buffer.from(createHash('sha256').update(key).digest('hex'), 'utf8');
    const stored = await q1<{ hash: string }>('SELECT ingest_key_hash AS hash FROM funnels WHERE id = $1', [
      funnel.id,
    ]);
    const storedHash = Buffer.from(stored?.hash ?? '', 'utf8');
    if (presented.length !== storedHash.length || !timingSafeEqual(presented, storedHash)) {
      await logError('unauthorized').catch(() => {});
      return json(401, { ok: false, error: 'unauthorized' });
    }

    // 3. JSON crudo.
    let raw: unknown;
    try {
      raw = JSON.parse(bodyText);
    } catch {
      return json(400, { ok: false, error: 'invalid_payload' });
    }

    // 4. Cantidad de eventos, ANTES del schema: el contrato (§4 del plan)
    // dice 413 para más de 50 eventos, y si el zod (max(50)) rechazara
    // primero, el funnel vería un 400 invalid_payload que no está en el
    // contrato. Es un chequeo O(1) sobre un array ya parseado.
    const rawEvents = (raw as { events?: unknown } | null)?.events;
    if (Array.isArray(rawEvents) && rawEvents.length > MAX_EVENTS) {
      return json(413, { ok: false, error: 'too_large' });
    }

    // 5. Schema (zod, §4 del plan). Acá el payload sí va a la fila: es de un
    // funnel autenticado y el error es nuestro bug.
    let parsed: ReturnType<typeof parseIngestPayload>;
    try {
      parsed = parseIngestPayload(raw);
    } catch (err) {
      if (!(err instanceof ZodError)) throw err;
      const first = err.issues[0];
      const detail = first ? `${first.path.join('.')}: ${first.message}` : 'payload inválido';
      await logError('invalid_payload', detail, raw).catch(() => {});
      return json(400, { ok: false, error: 'invalid_payload', detail });
    }

    // Si el funnel no manda el device en el context, se parsea del UA: los
    // relés server-to-server pueden no reenviar el header del browser.
    const { payload, warnings } = parsed;
    payload.context ??= {};
    payload.context.device ??= deviceFromUA(req.headers.get('user-agent'));

    const { accepted, warnings: batchWarnings } = await applyBatch(funnel, payload);
    return json(200, { ok: true, accepted, warnings: [...warnings, ...batchWarnings] });
  } catch (err) {
    // Nunca un 5xx para el funnel: un 500 no arregla nada y ensucia sus logs.
    // El error queda en ingest_errors, que es donde se mira (task T02 §3).
    console.error('[ingest] error inesperado:', err);
    await logError('error', err instanceof Error ? err.message : String(err)).catch(() => {});
    return json(200, { ok: false, error: 'internal' });
  }
}
