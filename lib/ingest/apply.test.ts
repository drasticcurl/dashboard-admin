import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../../app/api/ingest/route';
import { q, q1 } from '../db';
import { getFunnelBySlug, type Funnel } from '../funnels';
import type { IngestEvent, IngestPayload } from '../types';
import { applyBatch } from './apply';
import { parseIngestPayload } from './schema';

/**
 * Integración con Postgres real. Todos los casos que tocan la base viven en
 * este archivo (también los del route, casos 9-10 del task): dos archivos
 * escribiendo la misma base en paralelo se pisan el cleanup de ingest_errors,
 * así que el aislamiento es por archivo, no por test.
 */
const dbAvailable = Boolean(process.env.DATABASE_URL);

const SESSION_COLS = `id, funnel_id, visitor_id, variant, day::text AS day, started_at, last_seen_at,
  max_step_index, sales_view_at, checkout_click_at, purchased_at, upsell_view_at, upsell_click_at,
  downsell_view_at, utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, country,
  device, referrer_host, landing_path`;

type SessionRow = {
  id: string;
  funnel_id: number;
  visitor_id: string;
  variant: string;
  day: string;
  started_at: Date;
  last_seen_at: Date;
  max_step_index: number;
  sales_view_at: Date | null;
  checkout_click_at: Date | null;
  purchased_at: Date | null;
  upsell_view_at: Date | null;
  upsell_click_at: Date | null;
  downsell_view_at: Date | null;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
  fbclid: string | null;
  country: string | null;
  device: string | null;
  referrer_host: string | null;
  landing_path: string | null;
};

describe.skipIf(!dbAvailable)('ingest (integración)', () => {
  let funnel: Funnel;
  let resetFunnel: Funnel;
  let errorsBaseline = 0;
  let originalIngestKeyHash: string | null = null;
  let ingestKey = '';
  const createdSids: string[] = [];

  beforeAll(async () => {
    const f = await getFunnelBySlug('chauhinchazon');
    const r = await getFunnelBySlug('reset');
    if (!f || !r) throw new Error('faltan los funnels del seed: corré npm run db:migrate');
    funnel = f;
    resetFunnel = r;

    // El seed deja hashes PENDING_SET_INGEST_KEY_*: para que los tests de HTTP
    // (casos 9-10) puedan mandar un Bearer válido, se setea una key de prueba
    // y se restaura el hash original al terminar.
    const row = await q1<{ hash: string }>('SELECT ingest_key_hash AS hash FROM funnels WHERE id = $1', [funnel.id]);
    originalIngestKeyHash = row?.hash ?? null;
    const key = `test-key-${randomUUID()}`;
    const hash = createHash('sha256').update(key).digest('hex');
    await q('UPDATE funnels SET ingest_key_hash = $1 WHERE id = $2', [hash, funnel.id]);
    ingestKey = key;

    const errRow = await q1<{ max: number }>('SELECT COALESCE(MAX(id), 0) AS max FROM ingest_errors');
    errorsBaseline = errRow?.max ?? 0;
  });

  afterAll(async () => {
    if (originalIngestKeyHash) {
      await q('UPDATE funnels SET ingest_key_hash = $1 WHERE id = $2', [originalIngestKeyHash, funnel.id]);
    }
  });

  afterEach(async () => {
    if (createdSids.length > 0) {
      const sids = createdSids.splice(0);
      await q('DELETE FROM events WHERE session_id = ANY($1::uuid[])', [sids]);
      await q('DELETE FROM sessions WHERE id = ANY($1::uuid[])', [sids]);
    }
    await q('DELETE FROM ingest_errors WHERE id > $1', [errorsBaseline]);
  });

  function ev(name: string, at: string, extra: Record<string, unknown> = {}): IngestEvent {
    return { name, at, ...extra } as IngestEvent;
  }

  function makePayload(events: IngestEvent[], over: Partial<IngestPayload> = {}, sid: string = randomUUID()): IngestPayload {
    createdSids.push(sid);
    return {
      sessionId: sid,
      visitorId: randomUUID(),
      variant: 'ar',
      events,
      ...over,
    };
  }

  async function readSession(sid: string): Promise<SessionRow | null> {
    return q1<SessionRow>(`SELECT ${SESSION_COLS} FROM sessions WHERE id = $1`, [sid]);
  }

  async function expectedDay(at: string): Promise<string> {
    const row = await q1<{ day: string }>(
      'SELECT ($1::timestamptz AT TIME ZONE $2)::date::text AS day',
      [at, funnel.timezone],
    );
    return row!.day;
  }

  describe('applyBatch', () => {
    it('lote nuevo → sesión con day del primer evento, max_step_index del lote y el hito del §6', async () => {
      const events = [
        ev('step_view', '2026-08-11T03:00:00.000Z', { stepIndex: 3, stepSlug: 'donde_acumula' }),
        ev('step_view', '2026-08-11T20:00:00.000Z', { stepIndex: 21, stepSlug: 'sales_page' }),
        ev('sales_view', '2026-08-11T20:05:00.000Z'),
      ];
      const p = makePayload(events, {
        // El payload llega normalizado del schema (country ya en mayúsculas):
        // la normalización es responsabilidad de schema.ts, cubierta en
        // schema.test.ts.
        context: { utms: { utm_campaign: 'test' }, country: 'AR', path: '/quiz' },
      });
      const res = await applyBatch(funnel, p);
      expect(res).toEqual({ accepted: 3, warnings: [] });

      const s = (await readSession(p.sessionId))!;
      expect(s.funnel_id).toBe(funnel.id);
      expect(s.variant).toBe('ar');
      // 03:00Z = 00:00 en BUE: el día es el del PRIMER evento, no el del último.
      expect(s.day).toBe(await expectedDay('2026-08-11T03:00:00.000Z'));
      expect(s.max_step_index).toBe(21);
      expect(s.started_at.toISOString()).toBe('2026-08-11T03:00:00.000Z');
      expect(s.last_seen_at.toISOString()).toBe('2026-08-11T20:05:00.000Z');
      expect(s.sales_view_at!.toISOString()).toBe('2026-08-11T20:05:00.000Z');
      expect(s.checkout_click_at).toBeNull();
      expect(s.utm_campaign).toBe('test');
      expect(s.utm_source).toBe('(directo)');
      expect(s.country).toBe('AR');
      expect(s.landing_path).toBe('/quiz');
    });

    it('el mismo lote dos veces → sessions queda byte por byte igual (idempotencia)', async () => {
      const p = makePayload(
        [
          ev('step_view', '2026-08-11T03:00:00.000Z', { stepIndex: 3, stepSlug: 'donde_acumula' }),
          ev('sales_view', '2026-08-11T20:05:00.000Z'),
        ],
        { context: { utms: { utm_campaign: 'test' } } },
      );
      await applyBatch(funnel, p);
      const first = await readSession(p.sessionId);
      await applyBatch(funnel, p);
      const second = await readSession(p.sessionId);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      // events SÍ se duplica: es el log crudo, no la métrica (regla 4 del §4).
      // 2 eventos del lote × 2 envíos = 4 filas.
      const count = await q1<{ n: string }>(
        'SELECT count(*)::text AS n FROM events WHERE session_id = $1',
        [p.sessionId],
      );
      expect(count!.n).toBe('4');
    });

    it('lote desordenado → started_at es el mínimo y last_seen_at el máximo', async () => {
      const p = makePayload([
        ev('step_view', '2026-08-11T20:00:00.000Z', { stepIndex: 21, stepSlug: 'sales_page' }),
        ev('step_view', '2026-08-11T03:00:00.000Z', { stepIndex: 0, stepSlug: 'landing_hook' }),
        ev('step_view', '2026-08-11T10:00:00.000Z', { stepIndex: 5, stepSlug: 'nombre' }),
      ]);
      await applyBatch(funnel, p);
      const s = (await readSession(p.sessionId))!;
      expect(s.started_at.toISOString()).toBe('2026-08-11T03:00:00.000Z');
      expect(s.last_seen_at.toISOString()).toBe('2026-08-11T20:00:00.000Z');
      expect(s.max_step_index).toBe(21);
    });

    it('lote posterior con max_step_index menor → no baja el guardado', async () => {
      const sid = randomUUID();
      createdSids.push(sid);
      await applyBatch(funnel, makePayload([ev('step_view', '2026-08-11T03:00:00.000Z', { stepIndex: 15 })], {}, sid));
      await applyBatch(funnel, makePayload([ev('step_view', '2026-08-11T04:00:00.000Z', { stepIndex: 2 })], {}, sid));
      const s = (await readSession(sid))!;
      expect(s.max_step_index).toBe(15);
    });

    it('sesión que llega primero sin UTMs y después con → la atribución se completa', async () => {
      const sid = randomUUID();
      createdSids.push(sid);
      await applyBatch(funnel, makePayload([ev('step_view', '2026-08-11T03:00:00.000Z', { stepIndex: 0 })], {}, sid));
      await applyBatch(
        funnel,
        makePayload(
          [ev('step_view', '2026-08-11T04:00:00.000Z', { stepIndex: 1 })],
          { context: { utms: { utm_source: 'facebook', utm_campaign: 'campaña-1' }, country: 'BR', device: 'mobile' } },
          sid,
        ),
      );
      const s = (await readSession(sid))!;
      expect(s.utm_source).toBe('facebook');
      expect(s.utm_campaign).toBe('campaña-1');
      expect(s.utm_medium).toBe('(directo)');
      expect(s.country).toBe('BR');
      expect(s.device).toBe('mobile');
    });

    it('sesión que llega con UTMs y después con otros → no se sobrescribe', async () => {
      const sid = randomUUID();
      createdSids.push(sid);
      await applyBatch(
        funnel,
        makePayload(
          [ev('step_view', '2026-08-11T03:00:00.000Z', { stepIndex: 0 })],
          { context: { utms: { utm_source: 'facebook', utm_campaign: 'primera' }, country: 'AR' } },
          sid,
        ),
      );
      await applyBatch(
        funnel,
        makePayload(
          [ev('step_view', '2026-08-11T04:00:00.000Z', { stepIndex: 1 })],
          { context: { utms: { utm_source: 'google', utm_campaign: 'segunda' }, country: 'BR' } },
          sid,
        ),
      );
      const s = (await readSession(sid))!;
      expect(s.utm_source).toBe('facebook');
      expect(s.utm_campaign).toBe('primera');
      expect(s.country).toBe('AR');
    });

    it('step_view con stepIndex fuera del catálogo → warning, fila en ingest_errors y evento guardado', async () => {
      const p = makePayload([ev('step_view', '2026-08-11T03:00:00.000Z', { stepIndex: 99, stepSlug: 'chirimbolo' })]);
      const res = await applyBatch(funnel, p);
      expect(res.accepted).toBe(1);
      expect(res.warnings).toEqual(['unknown_step:99']);
      const errs = await q('SELECT reason, detail FROM ingest_errors WHERE id > $1', [errorsBaseline]);
      expect(errs).toHaveLength(1);
      expect(errs[0].reason).toBe('unknown_step');
      const e = await q1('SELECT name, step_index FROM events WHERE session_id = $1', [p.sessionId]);
      expect(e!.name).toBe('step_view');
      expect(e!.step_index).toBe(99);
    });

    it('slug que no coincide con el catálogo → step_slug_mismatch, el embudo se mide por stepIndex', async () => {
      const p = makePayload([ev('step_view', '2026-08-11T03:00:00.000Z', { stepIndex: 3, stepSlug: 'nombre' })]);
      const res = await applyBatch(funnel, p);
      expect(res.warnings).toEqual(['step_slug_mismatch:3:nombre']);
      const s = (await readSession(p.sessionId))!;
      expect(s.max_step_index).toBe(3);
      const e = await q1('SELECT step_slug FROM events WHERE session_id = $1', [p.sessionId]);
      expect(e!.step_slug).toBe('nombre');
    });

    it('evento fuera del vocabulario → se guarda tal cual con warning unknown_event', async () => {
      const p = makePayload([ev('video_played', '2026-08-11T03:00:00.000Z')]);
      const res = await applyBatch(funnel, p);
      expect(res.warnings).toEqual(['unknown_event:video_played']);
      const e = await q1('SELECT name FROM events WHERE session_id = $1', [p.sessionId]);
      expect(e!.name).toBe('video_played');
      const errs = await q('SELECT reason FROM ingest_errors WHERE id > $1', [errorsBaseline]);
      expect(errs[0].reason).toBe('unknown_event');
    });

    it('variant no declarado → warning unknown_variant y se guarda igual (regla 1 del §4)', async () => {
      const p = makePayload(
        [ev('step_view', '2026-08-11T03:00:00.000Z', { stepIndex: 0, stepSlug: 'landing_hook' })],
        { variant: 'latam2' },
      );
      const res = await applyBatch(funnel, p);
      expect(res.warnings).toEqual(['unknown_variant:latam2']);
      const s = (await readSession(p.sessionId))!;
      expect(s.variant).toBe('latam2');
    });

    it('sesión que ya existe con otro funnel → no se sobrescribe y los eventos igual se guardan', async () => {
      const sid = randomUUID();
      createdSids.push(sid);
      await applyBatch(funnel, makePayload([ev('step_view', '2026-08-11T03:00:00.000Z', { stepIndex: 3 })], {}, sid));
      const res = await applyBatch(
        resetFunnel,
        makePayload([ev('sales_view', '2026-08-11T04:00:00.000Z')], { variant: 'default' }, sid),
      );
      expect(res.warnings).toEqual(['session_funnel_mismatch']);
      const s = (await readSession(sid))!;
      expect(s.funnel_id).toBe(funnel.id);
      const e = await q1('SELECT funnel_id FROM events WHERE session_id = $1 AND name = \'sales_view\'', [sid]);
      expect(e!.funnel_id).toBe(resetFunnel.id);
    });

    it('los hitos se quedan con el primer at: purchase posterior no corre purchased_at', async () => {
      const sid = randomUUID();
      createdSids.push(sid);
      await applyBatch(funnel, makePayload([ev('purchase', '2026-08-11T10:00:00.000Z')], {}, sid));
      await applyBatch(funnel, makePayload([ev('purchase', '2026-08-11T11:00:00.000Z')], {}, sid));
      const s = (await readSession(sid))!;
      expect(s.purchased_at!.toISOString()).toBe('2026-08-11T10:00:00.000Z');
    });

    it('at en 2035 → se clampea a now con warning clamped_at y el evento se guarda', async () => {
      const p = makePayload([ev('step_view', '2035-01-01T00:00:00.000Z', { stepIndex: 0, stepSlug: 'landing_hook' })]);
      const { payload, warnings } = parseIngestPayload(p);
      expect(warnings).toEqual(['clamped_at']);
      const res = await applyBatch(funnel, payload);
      expect(res).toEqual({ accepted: 1, warnings: [] });
      const e = await q1('SELECT occurred_at FROM events WHERE session_id = $1', [p.sessionId]);
      const at = new Date(e!.occurred_at).getTime();
      expect(at).toBeGreaterThanOrEqual(Date.now() - 2000);
      expect(at).toBeLessThanOrEqual(Date.now() + 2000);
      const s = (await readSession(payload.sessionId))!;
      const todayRow = await q1<{ day: string }>(
        'SELECT (now() AT TIME ZONE $1)::date::text AS day',
        [funnel.timezone],
      );
      expect(s.day).toBe(todayRow!.day);
    });
  });

  describe('route (HTTP)', () => {
    function ingestReq(body: string, headers: Record<string, string> = {}): NextRequest {
      return new NextRequest('http://127.0.0.1:3005/api/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });
    }

    it('key inválida → 401 y sessions sin filas nuevas', async () => {
      const sid = randomUUID();
      createdSids.push(sid);
      const body = JSON.stringify({
        sessionId: sid,
        visitorId: randomUUID(),
        events: [{ name: 'step_view', at: new Date().toISOString(), stepIndex: 0 }],
      });
      const res = await POST(ingestReq(body, { authorization: 'Bearer nope' }));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: 'unauthorized' });
      expect(await q1('SELECT id FROM sessions WHERE id = $1', [sid])).toBeNull();
      const errs = await q<{ reason: string }>('SELECT reason FROM ingest_errors WHERE id > $1', [errorsBaseline]);
      expect(errs.some((r) => r.reason === 'unauthorized')).toBe(true);
    });

    it('sin header de Authorization → 401', async () => {
      const res = await POST(ingestReq('{}'));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: 'unauthorized' });
    });

    it('body de 100 KB → 413 sin parsear', async () => {
      const res = await POST(
        ingestReq(JSON.stringify({ sessionId: randomUUID(), events: [{ name: 'step_view', at: new Date().toISOString(), props: { basura: 'x'.repeat(100 * 1024) } }] })),
      );
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ ok: false, error: 'too_large' });
    });

    it('más de 50 eventos → 413 (el contrato dice too_large, no invalid_payload)', async () => {
      const events = Array.from({ length: 51 }, (_, i) => ({
        name: 'step_view',
        at: new Date(Date.now() + i).toISOString(),
        stepIndex: 0,
      }));
      const res = await POST(
        ingestReq(JSON.stringify({ sessionId: randomUUID(), visitorId: randomUUID(), events }), {
          authorization: `Bearer ${ingestKey}`,
        }),
      );
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ ok: false, error: 'too_large' });
    });

    it('lote válido → 200 con accepted y warnings vacío', async () => {
      const sid = randomUUID();
      createdSids.push(sid);
      const body = JSON.stringify({
        sessionId: sid,
        visitorId: randomUUID(),
        variant: 'ar',
        events: [
          { name: 'step_view', at: '2026-08-11T14:00:00.000Z', stepIndex: 0, stepSlug: 'landing_hook' },
          { name: 'step_view', at: '2026-08-11T14:01:00.000Z', stepIndex: 3, stepSlug: 'donde_acumula' },
        ],
      });
      const res = await POST(ingestReq(body, { authorization: `Bearer ${ingestKey}` }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, accepted: 2, warnings: [] });
      const s = (await readSession(sid))!;
      expect(s.max_step_index).toBe(3);
      expect(s.variant).toBe('ar');
    });

    it('JSON inválido → 400 invalid_payload', async () => {
      // Con Bearer válido: el orden del route es tamaño → auth → JSON, así
      // que sin auth un JSON inválido da 401 y eso es correcto.
      const res = await POST(ingestReq('{no-es-json', { authorization: `Bearer ${ingestKey}` }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'invalid_payload' });
    });

    it('payload que no pasa el schema → 400 con detail del primer issue y fila con el payload', async () => {
      const body = JSON.stringify({
        sessionId: 'uuid-basura',
        visitorId: randomUUID(),
        events: [{ name: 'step_view', at: '2026-08-11T14:00:00.000Z' }],
      });
      const res = await POST(ingestReq(body, { authorization: `Bearer ${ingestKey}` }));
      expect(res.status).toBe(400);
      const parsed = (await res.json()) as { error: string; detail: string };
      expect(parsed.error).toBe('invalid_payload');
      expect(parsed.detail).toContain('sessionId');
      const errs = await q<{ reason: string; payload: unknown }>(
        'SELECT reason, payload FROM ingest_errors WHERE id > $1',
        [errorsBaseline],
      );
      expect(errs).toHaveLength(1);
      expect(errs[0].reason).toBe('invalid_payload');
      expect(errs[0].payload).not.toBeNull();
    });
  });
});
