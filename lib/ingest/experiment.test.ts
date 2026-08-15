import fc from 'fast-check';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { q, q1 } from '../db';
import { getFunnelBySlug, type Funnel } from '../funnels';
import type { IngestEvent, IngestPayload } from '../types';
import { applyBatch } from './apply';
import { ingestPayloadSchema, parseIngestPayload } from './schema';

/**
 * Dimensión `experiment` del pop-up (spec ab-test-popup-descuento).
 *
 * Parte pura (Property 26): el schema, sin base ni guarda.
 * Parte contra Postgres (Properties 27-30): skipIf sobre DATABASE_URL, con
 * siembra y limpieza, igual que apply.test.ts. El aislamiento es por sid
 * (sesiones y eventos creados por esta suite) y por baseline de id en
 * ingest_errors.
 */

// vitest no carga .env solo (mismo patrón que lib/queries/funnel.test.ts):
// cargarlo acá hace que la suite corra contra la base real en vez de
// saltarse en silencio.
if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

// Guarda de schema-probe: la migración 020 (sessions.experiment y
// funnels.experiments) NO está aplicada en la base local — la aplica el
// usuario en su paso 0 manual (task 4). Si falta alguna columna, los describes
// contra la base se saltaN con un mensaje claro en vez de fallar con
// "column does not exist". Es la misma filosofía que skipIf(!dbAvailable),
// pero el resultado se conoce recién después de consultar la base.
//
// El probe es SOLO LECTURA de information_schema y corre en un subproceso
// síncrono a propósito: top-level await acá rompería `next build`, cuyo
// typecheck usa el target por defecto (ES5, sin top-level await).
const schemaReady = dbAvailable && probeEsquema('[experiment.test.ts]');
if (dbAvailable && !schemaReady) {
  console.warn(
    '[experiment.test.ts] schema-probe: falta sessions.experiment o funnels.experiments ' +
      '(migración 020 sin aplicar en esta base): se saltan los tests contra la base',
  );
}

/**
 * ¿Las columnas de la migración 020 existen en la base de DATABASE_URL?
 * Fallo de conexión ⇒ false ⇒ los tests contra la base se saltan. Duplicada a
 * propósito en los archivos de test que la necesitan (self-contained).
 */
function probeEsquema(tag: string): boolean {
  try {
    const out = execFileSync(
      'node',
      [
        '-e',
        `const {Client}=require('pg');
const c=new Client({connectionString:process.argv[1]});
c.connect()
  .then(()=>c.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE (table_name='sessions' AND column_name='experiment') OR (table_name='funnels' AND column_name='experiments')"))
  .then((r)=>c.end().then(()=>process.stdout.write(r.rows[0].n===2?'1':'0')))
  .catch(()=>{try{c.end()}catch(_){};process.stdout.write('0');});`,
        process.env.DATABASE_URL!,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 },
    );
    return out.toString().trim() === '1';
  } catch (err) {
    console.warn(`${tag} schema-probe falló, se saltan los tests contra la base:`, err instanceof Error ? err.message : err);
    return false;
  }
}

const FECHA = '2026-08-11';

/** Los caracteres que `ingestPayloadSchema` acepta en `experiment`. */
const CHARS_EXPERIMENT = [
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'.split(''),
  ...'áéíóúñÁÉÍÓÚÑäöüç'.split(''),
];

function basePayload(over: Record<string, unknown> = {}) {
  return {
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    visitorId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    events: [{ name: 'step_view', at: `${FECHA}T14:03:11.000Z`, stepIndex: 0, stepSlug: 'landing_hook' }],
    ...over,
  };
}

// ─── Parte pura: el schema, sin base ─────────────────────────────────────────

describe('ingestPayloadSchema: la dimensión experiment (pura)', () => {
  // Feature: ab-test-popup-descuento, Property 26: El schema acepta la dimensión exactamente hasta 32 caracteres
  it('Property 26: cualquier cadena de hasta 32 caracteres se acepta, de más se rechaza, y la omisión queda undefined', () => {
    // La frontera de los 32, con largo exacto en unidades de código UTF-16.
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 64 }), (n) => {
        const s = 'x'.repeat(n);
        const r = ingestPayloadSchema.safeParse(basePayload({ experiment: s }));
        expect(r.success).toBe(n <= 32);
        if (!r.success) {
          expect(r.error.issues.some((i) => i.path.includes('experiment'))).toBe(true);
        }
      }),
      { numRuns: 100 },
    );

    // Contenido variado dentro del límite: pasa tal cual (sin limpieza de UTM,
    // es un token cerrado, no una campaña).
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a', 'B', '7', '_', 'ñ', '-'), { minLength: 0, maxLength: 32 }),
        (chars) => {
          const s = chars.join('');
          const { payload } = parseIngestPayload(basePayload({ experiment: s }));
          expect(payload.experiment).toBe(s);
        },
      ),
      { numRuns: 100 },
    );

    // La omisión del campo se acepta y el campo queda sin definir: es lo que
    // permite que el COALESCE del upsert distinga "no vino" de "vino algo".
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), () => {
        const { payload } = parseIngestPayload(basePayload());
        expect(payload.experiment).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  // Regresión del bug que encontró la Property 30: un valor con byte NUL medía
  // 3 caracteres, pasaba el .max(32) y recién Postgres lo rechazaba en el
  // INSERT (22021), así que el lote entero terminaba en 500. Ahora corta en el
  // borde con un issue en `experiment`.
  it('un valor con caracteres de control (byte NUL) se rechaza en el schema, no en el INSERT', () => {
    for (const malo of ['a\u0000b', '\u0000', 'A\u0007', 'a b', 'a\nb']) {
      const r = ingestPayloadSchema.safeParse(basePayload({ experiment: malo }));
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.issues.some((i) => i.path.includes('experiment'))).toBe(true);
      }
    }
  });
});

// ─── Parte contra Postgres ───────────────────────────────────────────────────

describe.skipIf(!(dbAvailable && schemaReady))('ingest: la dimensión experiment (integración)', () => {
  let funnel: Funnel;
  let errorsBaseline = 0;
  const createdSids: string[] = [];

  const SESSION_COLS = `id, variant, day::text AS day, experiment`;

  type SessionRow = {
    id: string;
    variant: string;
    day: string;
    experiment: string | null;
  };

  beforeAll(async () => {
    const f = await getFunnelBySlug('chauhinchazon');
    if (!f) throw new Error('falta el funnel del seed: corré npm run db:migrate');
    funnel = f;
    const errRow = await q1<{ max: number }>('SELECT COALESCE(MAX(id), 0) AS max FROM ingest_errors');
    errorsBaseline = errRow?.max ?? 0;
  });

  afterEach(async () => {
    if (createdSids.length > 0) {
      const sids = createdSids.splice(0);
      await q('DELETE FROM events WHERE session_id = ANY($1::uuid[])', [sids]);
      await q('DELETE FROM sessions WHERE id = ANY($1::uuid[])', [sids]);
    }
    await q('DELETE FROM ingest_errors WHERE id > $1', [errorsBaseline]);
  });

  function makePayload(over: Partial<IngestPayload> = {}, sid: string = randomUUID()): IngestPayload {
    createdSids.push(sid);
    return {
      sessionId: sid,
      visitorId: randomUUID(),
      variant: 'ar',
      events: [{ name: 'step_view', at: `${FECHA}T03:00:00.000Z`, stepIndex: 0, stepSlug: 'landing_hook' }],
      ...over,
    };
  }

  function lotesCon(
    sid: string,
    seq: Array<{ experiment?: string; variant?: string; at: string }>,
  ): IngestPayload[] {
    return seq.map((s) =>
      makePayload(
        {
          ...(s.variant !== undefined ? { variant: s.variant } : {}),
          ...(s.experiment !== undefined ? { experiment: s.experiment } : {}),
          events: [{ name: 'step_view', at: s.at, stepIndex: 0, stepSlug: 'landing_hook' }],
        },
        sid,
      ),
    );
  }

  async function readSession(sid: string): Promise<SessionRow | null> {
    return q1<SessionRow>(`SELECT ${SESSION_COLS} FROM sessions WHERE id = $1`, [sid]);
  }

  // Feature: ab-test-popup-descuento, Property 27: Un lote sin la dimensión se procesa completo
  it('Property 27: lotes de 1..50 eventos sin experiment → aceptados todos y la columna queda NULL', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 50 }), async (n) => {
        // Sin stepIndex a propósito: el lote no interactúa con el catálogo de
        // pasos y el único resultado esperado es la aceptación completa.
        const events: IngestEvent[] = Array.from({ length: n }, (_, i) => ({
          name: 'step_view',
          at: new Date(Date.UTC(2026, 7, 11, 3, 0, i % 60)).toISOString(),
        }));
        const p = makePayload({ events });
        const res = await applyBatch(funnel, p);
        expect(res.accepted).toBe(n);
        expect(res.warnings).toEqual([]);
        const s = (await readSession(p.sessionId))!;
        expect(s.experiment).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  // Feature: ab-test-popup-descuento, Property 28: El upsert de la dimensión es confluente e idempotente
  it('Property 28: para cualquier secuencia de lotes, el valor final es el primer no-nulo del orden aplicado, y repetir un lote no cambia nada', async () => {
    const valores = fc.array(fc.constantFrom(null, 'A', 'B'), { minLength: 1, maxLength: 5 });
    await fc.assert(
      fc.asyncProperty(valores, async (seq) => {
        const minuto = (i: number) => `2026-08-11T03:${String(i % 60).padStart(2, '0')}:00.000Z`;

        // 1) En el orden original: el final es el primer no-nulo de `seq`.
        const sidA = randomUUID();
        const lotesA = lotesCon(
          sidA,
          seq.map((v, i) => ({ experiment: v ?? undefined, at: minuto(i) })),
        );
        for (const l of lotesA) await applyBatch(funnel, l);
        const esperadoA = seq.find((v) => v !== null) ?? null;
        expect((await readSession(sidA))!.experiment).toBe(esperadoA);

        // 2) Otra sesión, MISMA secuencia invertida: el final es el primer
        //    no-nulo DEL ORDEN APLICADO, o sea el del orden invertido. Si el
        //    resultado dependiera del orden de llegada de otra manera, acá
        //    fallaría.
        const sidB = randomUUID();
        const invertida = [...seq].reverse();
        const lotesB = lotesCon(
          sidB,
          invertida.map((v, i) => ({ experiment: v ?? undefined, at: minuto(i + 6) })),
        );
        for (const l of lotesB) await applyBatch(funnel, l);
        const esperadoB = invertida.find((v) => v !== null) ?? null;
        expect((await readSession(sidB))!.experiment).toBe(esperadoB);

        // 3) Idempotencia por lote: aplicar el último lote de nuevo no cambia
        //    el valor (y NULL repetido tampoco pisa un valor ya asignado).
        await applyBatch(funnel, lotesA[lotesA.length - 1]!);
        expect((await readSession(sidA))!.experiment).toBe(esperadoA);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: ab-test-popup-descuento, Property 29: El conflicto no toca variant ni day
  it('Property 29: dos o más lotes con variant y día distintos → quedan los del primer lote', async () => {
    const variante = fc.constantFrom('ar', 'latam');
    const experimento = fc.constantFrom(null, 'A', 'B');
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ variant: variante, experiment: experimento }), { minLength: 2, maxLength: 4 }),
        async (seq) => {
          const sid = randomUUID();
          const lotes = lotesCon(
            sid,
            seq.map((s, i) => ({
              variant: s.variant,
              experiment: s.experiment ?? undefined,
              // Días distintos: el day se congela con el del PRIMER lote.
              at: `2026-08-1${i + 1}T12:00:00.000Z`,
            })),
          );
          const primer = seq[0]!;
          const primerDay = await q1<{ day: string }>(
            'SELECT ($1::timestamptz AT TIME ZONE $2)::date::text AS day',
            [lotes[0]!.events[0]!.at, funnel.timezone],
          );

          for (const l of lotes) await applyBatch(funnel, l);

          const s = (await readSession(sid))!;
          expect(s.variant).toBe(primer.variant);
          expect(s.day).toBe(primerDay!.day);
          // Y la dimensión, con la regla de la 28: primer no-nulo aplicado.
          const primerExp = seq.map((x) => x.experiment).find((v) => v !== null) ?? null;
          expect(s.experiment).toBe(primerExp);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: ab-test-popup-descuento, Property 30: Una dimensión no declarada se guarda y se avisa
  it('Property 30: valor fuera del conjunto → se guarda igual, warning y fila en ingest_errors; variant igual que antes', async () => {
    // 'z' adelante garantiza que el valor nunca es 'A' ni 'B' (los declarados
    // de chauhinchazon post-migración 020).
    //
    // El charset es el MISMO que valida `ingestPayloadSchema`: esta property
    // llama a `applyBatch` directo, sin pasar por el zod, así que el generador
    // tiene que quedarse dentro de lo que el borde acepta. Con `unit: 'binary'`
    // producía el byte NUL, que ningún payload real puede atravesar la
    // validación y que Postgres rechaza en el INSERT con 22021 (el bug que
    // encontró esta property, arreglado en lib/ingest/schema.ts).
    const desconocida = fc
      .string({ minLength: 0, maxLength: 31, unit: fc.constantFrom(...CHARS_EXPERIMENT) })
      .map((s) => `z${s}`);
    const variante = fc.constantFrom('ar', 'latam2');
    await fc.assert(
      fc.asyncProperty(desconocida, variante, async (exp, variant) => {
        const p = makePayload({ experiment: exp, variant });
        const res = await applyBatch(funnel, p);
        expect(res.accepted).toBe(1);
        expect(res.warnings).toContain(`unknown_experiment:${exp}`);
        // La validación de variant se comporta igual que antes del cambio.
        if (variant === 'latam2') {
          expect(res.warnings).toContain('unknown_variant:latam2');
        } else {
          expect(res.warnings).not.toContain('unknown_variant:ar');
        }

        const s = (await readSession(p.sessionId))!;
        expect(s.experiment).toBe(exp);
        expect(s.variant).toBe(variant);

        const errs = await q<{ reason: string }>(
          'SELECT reason FROM ingest_errors WHERE id > $1',
          [errorsBaseline],
        );
        expect(errs.some((e) => e.reason === 'unknown_experiment')).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
