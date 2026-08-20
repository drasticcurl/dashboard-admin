import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { NextRequest } from 'next/server';
import { q, q1 } from '../../../../lib/db';
import { GET, POST } from './route';
import { isAuthenticated } from '../../../../lib/auth';
import { enviar, fetchMinimoPresupuesto, fetchObjeto } from '../../../../lib/ads/meta';
import { correrRegla } from '../../../../lib/ads/reglas/ejecutor';
import type { ResultadoCorrida } from '../../../../lib/ads/reglas/ejecutor';
import type { ReglaFila } from '@/app/(panel)/anuncios/reglas/_tipos';
import { genNombreRegla, genReglaPayload, type PayloadRegla } from '../../../../lib/test/generadores-ads';

/**
 * Tests del API de reglas (tasks 8.3, 8.4, 8.5 y 8.6): las Properties 7, 8 y 9
 * más los casos del preview y de las filas de ad_actions.
 *
 * `isAuthenticated` se mockea (mismo patrón que app/api/data/ads/route.test.ts).
 * `correrRegla` se mockea en el borde del ejecutor para verificar el cableado
 * del preview (forzarSombra, la cuenta elegida) sin llamar a Meta; los mocks de
 * lib/ads/meta son los contadores de "cero llamadas a Meta".
 */

vi.mock('../../../../lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/auth')>();
  return { ...actual, isAuthenticated: vi.fn(() => true) };
});

vi.mock('../../../../lib/ads/reglas/ejecutor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/ads/reglas/ejecutor')>();
  return { ...actual, correrRegla: vi.fn() };
});

vi.mock('../../../../lib/ads/meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/ads/meta')>();
  return { ...actual, enviar: vi.fn(), fetchMinimoPresupuesto: vi.fn(), fetchObjeto: vi.fn() };
});

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

// Guarda de schema-probe (política de base de la spec reglas-anuncios-por-cuenta):
// la migración 021 la aplica el usuario con su runbook, NUNCA el agente. Contra
// una base en la 019 (`account_ids`, sin `account_id`), el POST y la foto de
// reglas tiran `column "account_id" of relation "ad_rules" does not exist`
// (42703), y este test no arregla la base: se saltea con un mensaje claro. Es
// el equivalente a skipIf(!dbAvailable), misma filosofía.
//
// No puede ser un `describe.skipIf` con el probe adentro porque la consulta es
// async y el tsconfig del proyecto (target ES5) no admite top-level await; el
// skip se hace por test con `ctx.skip()`.
let avisoEsquemaDado = false;

async function requiereEsquema021(ctx: { skip: () => void }): Promise<boolean> {
  if (!dbAvailable) {
    ctx.skip();
    return false;
  }
  try {
    const r = await q1<{ n: string }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'ad_rules' AND column_name = 'account_id'`,
    );
    if (Number(r?.n ?? 0) > 0) return true;
  } catch {
    // base caída o probe fallido: se saltea igual que sin DATABASE_URL.
  }
  if (!avisoEsquemaDado) {
    avisoEsquemaDado = true;
    console.warn(
      '[route.test.ts] la base está en la migración 019 (ad_rules.account_id no existe): ' +
        'la 021 la aplica el usuario con su runbook. Tests que la necesitan salteados.',
    );
  }
  ctx.skip();
  return false;
}

const mockAuth = vi.mocked(isAuthenticated);
const mockCorrerRegla = vi.mocked(correrRegla);
const mockEnviar = vi.mocked(enviar);
const mockFetchMinimo = vi.mocked(fetchMinimoPresupuesto);

const PREFIJO = 'T19-API-';
const CUENTA_A = `${PREFIJO}act-a`;
const CUENTA_B = `${PREFIJO}act-b`;
const CUENTA_INACTIVA = `${PREFIJO}inactiva`;

function post(body: unknown, preview = false): Promise<Response> {
  const url = preview ? 'http://localhost/api/ads/reglas?preview=1' : 'http://localhost/api/ads/reglas';
  return POST(new NextRequest(url, { method: 'POST', body: JSON.stringify(body) }));
}

function get(): Promise<Response> {
  return GET(new NextRequest('http://localhost/api/ads/reglas'));
}

/** Payload de creación mínimo y válido: pausar conjuntos, sin condiciones. */
function payloadMinimo(): PayloadRegla {
  return {
    name: `${PREFIJO}minimo`,
    accountId: CUENTA_A,
    level: 'adset',
    statusFilter: 'active',
    nameFilter: null,
    nameFilterMode: 'contains',
    action: 'pause',
    actionValue: null,
    actionUnit: null,
    budgetMax: null,
    budgetMin: null,
    period: 'today',
    everyMinutes: 15,
    windowStart: null,
    windowEnd: null,
    maxRunsPerDay: null,
    cooldownMinutes: 60,
    maxActionsPerObjectPerDay: 4,
    conditions: [],
  };
}

function resultadoVacio(): ResultadoCorrida {
  return {
    ruleId: 0,
    ruleName: '',
    runId: null,
    corrio: true,
    motivoNoCorrio: null,
    dryRun: true,
    objetosEvaluados: 0,
    objetosQueCumplen: 0,
    ejecutadas: 0,
    simuladas: 0,
    omitidas: 0,
    acciones: [],
    error: null,
  };
}

/** Foto de ad_rules + ad_rule_conditions, para el invariante "no dejó rastro". */
async function fotoDeReglas(): Promise<unknown> {
  const [reglas, condiciones] = await Promise.all([
    q<{ id: number; name: string; account_id: string }>(`SELECT id, name, account_id FROM ad_rules ORDER BY id`),
    q<{ rule_id: number; position: number; metric: string; op: string; value: string }>(
      `SELECT rule_id, position, metric, op, value FROM ad_rule_conditions ORDER BY rule_id, position`,
    ),
  ]);
  return { reglas, condiciones };
}

beforeAll(async () => {
  if (!dbAvailable) return;
  await q(`DELETE FROM ad_actions WHERE rule_name LIKE $1`, [PREFIJO + '%']);
  await q(`DELETE FROM ad_rules WHERE name LIKE $1`, [PREFIJO + '%']);
  await q(`DELETE FROM ad_accounts WHERE account_id LIKE $1`, [PREFIJO + '%']);
  await q(
    `INSERT INTO ad_accounts (account_id, platform, name, currency, timezone, active) VALUES
       ($1, 'meta', 'cuenta A', 'EUR', 'Europe/Lisbon', true),
       ($2, 'meta', 'cuenta B', 'EUR', 'America/Argentina/Buenos_Aires', true),
       ($3, 'meta', 'inactiva', 'EUR', 'Europe/Lisbon', false)
     ON CONFLICT (account_id) DO UPDATE SET active = EXCLUDED.active, timezone = EXCLUDED.timezone`,
    [CUENTA_A, CUENTA_B, CUENTA_INACTIVA],
  );
});

afterEach(() => {
  vi.clearAllMocks();
  mockAuth.mockImplementation(() => true);
});

afterAll(async () => {
  if (!dbAvailable) return;
  await q(`DELETE FROM ad_actions WHERE rule_name LIKE $1`, [PREFIJO + '%']);
  await q(`DELETE FROM ad_rules WHERE name LIKE $1`, [PREFIJO + '%']);
  await q(`DELETE FROM ad_accounts WHERE account_id LIKE $1`, [PREFIJO + '%']);
});

describe.skipIf(!dbAvailable)('/api/ads/reglas', () => {
  it('sin cookie → 401', async () => {
    mockAuth.mockImplementation(() => false);
    const resp = await get();
    expect(resp.status).toBe(401);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Property 7 (task 8.3)
  // ─────────────────────────────────────────────────────────────────────────────

  it('Feature: reglas-anuncios-por-cuenta, Property 7: una Regla sin cuenta válida no se guarda y no deja rastro', async (ctx) => {
    if (!(await requiereEsquema021(ctx))) return;
    const mutaciones = ['ausente', 'vacia', 'espacios', 'larga', 'inexistente', 'inactiva'] as const;
    await fc.assert(
      fc.asyncProperty(
        genReglaPayload(),
        fc.constantFrom(...mutaciones),
        async (payload, mutacion) => {
          const mutado = { ...payload, accountId: cuentaMutada(payload, mutacion) } as Record<string, unknown>;
          if (mutacion === 'ausente') delete mutado.accountId;

          const antes = await fotoDeReglas();
          const resp = await post(mutado);
          const cuerpo = (await resp.json()) as { error?: string; detail?: string };

          // Invariante 1: 400, nunca 500.
          expect(resp.status).toBe(400);
          expect(resp.status).not.toBe(500);

          // Invariante 2: el detail nombra el campo faltante o el id recibido.
          if (mutacion === 'ausente' || mutacion === 'vacia' || mutacion === 'espacios' || mutacion === 'larga') {
            expect(cuerpo.detail).toBe('Falta la cuenta de anuncios');
          } else {
            expect(cuerpo.detail).toContain(mutado.accountId as string);
            expect(cuerpo.detail).toContain('no existe o no está activa');
          }

          // Invariante 3: ad_rules y ad_rule_conditions quedan EXACTAMENTE igual.
          expect(await fotoDeReglas()).toEqual(antes);
        },
      ),
      { numRuns: 100 },
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Property 8 (task 8.4)
  // ─────────────────────────────────────────────────────────────────────────────

  it('Feature: reglas-anuncios-por-cuenta, Property 8: una Regla sobrevive la ida y vuelta por el API_Reglas', async (ctx) => {
    if (!(await requiereEsquema021(ctx))) return;
    await fc.assert(
      fc.asyncProperty(genReglaPayload(), async (payload) => {
        const enviado: PayloadRegla = {
          ...payload,
          accountId: CUENTA_A,
          name: `${PREFIJO}p8-${payload.name.slice(0, 150)}`,
        };
        // Igual que en la Property 9: el zod del API declara `name` con `.trim()`,
        // y el `.slice(0, 150)` puede dejar un espacio al final. Lo que la ida y
        // vuelta tiene que conservar es el nombre NORMALIZADO, no la cadena cruda
        // que se mandó.
        const nombreGuardado = enviado.name.trim();
        const resp = await post(enviado);
        expect(resp.status).toBe(200);
        const creada = (await resp.json()) as { ok: boolean; id: number };
        expect(creada.ok).toBe(true);
        const id = creada.id;
        try {
          const listado = await get();
          expect(listado.status).toBe(200);
          const cuerpo = (await listado.json()) as { reglas: ReglaFila[] };
          const fila = cuerpo.reglas.find((r) => r.id === id);
          expect(fila).toBeTruthy();

          // El mismo accountId y la misma configuración en todos los campos.
          expect(fila!.accountId).toBe(CUENTA_A);
          expect(fila!.name).toBe(nombreGuardado);
          expect(fila!.level).toBe(enviado.level);
          expect(fila!.statusFilter).toBe(enviado.statusFilter);
          expect(fila!.nameFilter).toBe(enviado.nameFilter ?? null);
          expect(fila!.nameFilterMode).toBe(enviado.nameFilterMode);
          expect(fila!.action).toBe(enviado.action);
          expect(fila!.actionValue).toBe(enviado.actionValue ?? null);
          expect(fila!.actionUnit).toBe(enviado.actionUnit ?? null);
          expect(fila!.budgetMax).toBe(enviado.budgetMax ?? null);
          expect(fila!.budgetMin).toBe(enviado.budgetMin ?? null);
          expect(fila!.period).toBe(enviado.period);
          expect(fila!.everyMinutes).toBe(enviado.everyMinutes);
          expect(fila!.windowStart).toBe(enviado.windowStart ?? null);
          expect(fila!.windowEnd).toBe(enviado.windowEnd ?? null);
          expect(fila!.maxRunsPerDay).toBe(enviado.maxRunsPerDay ?? null);
          expect(fila!.cooldownMinutes).toBe(enviado.cooldownMinutes);
          expect(fila!.maxActionsPerObjectPerDay).toBe(enviado.maxActionsPerObjectPerDay);

          // Las condiciones, con metric/op/value en las MISMAS posiciones.
          expect(fila!.condiciones).toHaveLength(enviado.conditions.length);
          for (let i = 0; i < enviado.conditions.length; i++) {
            expect(fila!.condiciones[i].metric).toBe(enviado.conditions[i].metric);
            expect(fila!.condiciones[i].op).toBe(enviado.conditions[i].op);
            expect(fila!.condiciones[i].value).toBe(enviado.conditions[i].value);
          }

          // Nace apagada y en sombra, ignorando lo que pidió el payload.
          expect(fila!.enabled).toBe(false);
          expect(fila!.dryRun).toBe(true);
        } finally {
          await q(`DELETE FROM ad_rules WHERE id = $1`, [id]);
        }
      }),
      { numRuns: 100 },
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Property 9 (task 8.5)
  // ─────────────────────────────────────────────────────────────────────────────

  it('Feature: reglas-anuncios-por-cuenta, Property 9: el único (cuenta, nombre) separa cuentas y choca dentro de una', async (ctx) => {
    if (!(await requiereEsquema021(ctx))) return;
    await fc.assert(
      fc.asyncProperty(genNombreRegla(), async (nombre) => {
        const base = {
          ...payloadMinimo(),
          name: `${PREFIJO}p9-${nombre.slice(0, 150)}`,
          conditions: [{ metric: 'roi' as const, op: '>' as const, value: 1.2 }],
        };
        // POR QUÉ NO SE COMPARA `base.name` TAL CUAL
        // El zod del API declara `name: z.string().trim()`, así que el nombre que
        // se guarda y el que aparece en el 409 son el nombre NORMALIZADO. El
        // `.slice(0, 150)` de arriba corta el nombre generado en cualquier punto
        // y puede dejar un espacio al final, y ahí `base.name` y el nombre
        // guardado dejan de ser la misma cadena. Lo que pide R9 c5 es que el
        // mensaje identifique la cuenta y el nombre en conflicto, y el nombre en
        // conflicto es el normalizado: es el que está en la fila y el que el
        // único (account_id, name) hizo chocar.
        const nombreGuardado = base.name.trim();
        const id1 = (await (await post({ ...base, accountId: CUENTA_A })).json()).id as number;
        const id2 = (await (await post({ ...base, accountId: CUENTA_B })).json()).id as number;
        try {
          // El mismo nombre en dos cuentas convive: el único es (account_id, name).
          expect(id1).toBeGreaterThan(0);
          expect(id2).toBeGreaterThan(0);

          // Foto de la regla original y sus condiciones, para verificar que el
          // 409 no la toca.
          const antes = await q<{ rule_id: number; position: number; metric: string; op: string; value: string }>(
            `SELECT rule_id, position, metric, op, value FROM ad_rule_conditions WHERE rule_id = $1 ORDER BY position`,
            [id1],
          );

          // Repetido DENTRO de la misma cuenta → 409 que nombra cuenta y nombre.
          const resp = await post({ ...base, accountId: CUENTA_A });
          expect(resp.status).toBe(409);
          const cuerpo = (await resp.json()) as { error?: string; detail?: string };
          expect(cuerpo.error).toBe('nombre_duplicado');
          expect(cuerpo.detail).toContain(nombreGuardado);
          expect(cuerpo.detail).toContain(CUENTA_A);

          // La Regla existente y sus condiciones quedan intactas.
          const fila = await q1<{ name: string; account_id: string }>(
            `SELECT name, account_id FROM ad_rules WHERE id = $1`,
            [id1],
          );
          expect(fila!.name).toBe(nombreGuardado);
          expect(fila!.account_id).toBe(CUENTA_A);
          const despues = await q<{ rule_id: number; position: number; metric: string; op: string; value: string }>(
            `SELECT rule_id, position, metric, op, value FROM ad_rule_conditions WHERE rule_id = $1 ORDER BY position`,
            [id1],
          );
          expect(despues).toEqual(antes);
        } finally {
          await q(`DELETE FROM ad_rules WHERE id = ANY($1::int[])`, [[id1, id2]]);
        }
      }),
      { numRuns: 100 },
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Casos del preview y de las ad_actions (task 8.6)
  // ─────────────────────────────────────────────────────────────────────────────

  it('preview=1 sin accountId: 200, forzarSombra true y cero llamadas a Meta', async (ctx) => {
    if (!(await requiereEsquema021(ctx))) return;
    const creada = await post({ ...payloadMinimo(), name: `${PREFIJO}preview-a` });
    const id = (await creada.json()).id as number;
    try {
      mockCorrerRegla.mockResolvedValue(resultadoVacio());
      const resp = await post({ id }, true);
      expect(resp.status).toBe(200);
      const llamada = mockCorrerRegla.mock.calls.at(-1)!;
      expect(llamada[1]?.forzarSombra).toBe(true);
      // Sin override, corre sobre la cuenta guardada de la Regla.
      expect(llamada[0].regla.accountId).toBe(CUENTA_A);
      expect(llamada[0].regla.enabled).toBe(true);
      expect(mockEnviar).not.toHaveBeenCalled();
      expect(mockFetchMinimo).not.toHaveBeenCalled();
    } finally {
      await q(`DELETE FROM ad_rules WHERE id = $1`, [id]);
    }
  });

  it('preview=1 con accountId: corre sobre ESA cuenta, siempre en sombra', async (ctx) => {
    if (!(await requiereEsquema021(ctx))) return;
    const creada = await post({ ...payloadMinimo(), name: `${PREFIJO}preview-b` });
    const id = (await creada.json()).id as number;
    try {
      mockCorrerRegla.mockResolvedValue(resultadoVacio());
      const resp = await post({ id, accountId: CUENTA_B }, true);
      expect(resp.status).toBe(200);
      const llamada = mockCorrerRegla.mock.calls.at(-1)!;
      expect(llamada[1]?.forzarSombra).toBe(true);
      expect(llamada[0].regla.accountId).toBe(CUENTA_B);
      expect(mockEnviar).not.toHaveBeenCalled();
    } finally {
      await q(`DELETE FROM ad_rules WHERE id = $1`, [id]);
    }
  });

  it('preview=1 con accountId inactivo responde 400 igual que el POST normal', async (ctx) => {
    if (!(await requiereEsquema021(ctx))) return;
    const creada = await post({ ...payloadMinimo(), name: `${PREFIJO}preview-c` });
    const id = (await creada.json()).id as number;
    try {
      mockCorrerRegla.mockResolvedValue(resultadoVacio());
      const resp = await post({ id, accountId: CUENTA_INACTIVA }, true);
      expect(resp.status).toBe(400);
      const cuerpo = (await resp.json()) as { error?: string; detail?: string };
      expect(cuerpo.error).toBe('cuenta_invalida');
      expect(cuerpo.detail).toContain(CUENTA_INACTIVA);
      expect(mockCorrerRegla).not.toHaveBeenCalled();
    } finally {
      await q(`DELETE FROM ad_rules WHERE id = $1`, [id]);
    }
  });

  it('cambiar el accountId conserva las filas de ad_actions con su account_id original (R9 c8)', async (ctx) => {
    if (!(await requiereEsquema021(ctx))) return;
    const nombre = `${PREFIJO}acciones-${Date.now()}`;
    const creada = await post({ ...payloadMinimo(), name: nombre, accountId: CUENTA_A });
    const id = (await creada.json()).id as number;
    try {
      // Una fila de ad_actions escrita cuando la regla estaba en la cuenta A.
      await q(
        `INSERT INTO ad_actions (rule_id, rule_name, source, account_id, level, object_id, action, dry_run, ok, estado, explicacion)
         VALUES ($1, $2, 'rule', $3, 'adset', $4, 'pause', true, true, 'simulado', 'cambio de cuenta')`,
        [id, nombre, CUENTA_A, `${PREFIJO}obj-${id}`],
      );

      // Mover la regla a la cuenta B: el UPDATE no toca ad_actions.
      const resp = await post({ ...payloadMinimo(), id, name: `${nombre}-b`, accountId: CUENTA_B });
      expect(resp.status).toBe(200);

      const filas = await q<{ account_id: string }>(`SELECT account_id FROM ad_actions WHERE rule_id = $1`, [id]);
      expect(filas).toHaveLength(1);
      expect(filas[0].account_id).toBe(CUENTA_A);
    } finally {
      await q(`DELETE FROM ad_actions WHERE rule_id = $1`, [id]);
      await q(`DELETE FROM ad_rules WHERE id = $1`, [id]);
    }
  });

  // ── Coherencia: configuraciones que se pueden escribir y no pueden funcionar.
  //    La lógica está probada en lib/ads/reglas/coherencia.test.ts; acá se
  //    verifica el cableado en el API y la excepción de las acciones que reducen
  //    el riesgo, que es lo que no se puede romper sin dejar a alguien sin forma
  //    de frenar una regla.
  it('rechaza con 400 una regla que no podría actuar nunca', async (ctx) => {
    if (!(await requiereEsquema021(ctx))) return;
    const antes = await fotoDeReglas();

    const casos: { nombre: string; parche: Partial<PayloadRegla>; enMensaje: string }[] = [
      {
        nombre: 'pausar mirando sólo pausados',
        parche: { action: 'pause', statusFilter: 'paused' },
        enMensaje: 'no puede hacer nada',
      },
      {
        nombre: 'activar mirando sólo activos',
        parche: { action: 'activate', statusFilter: 'active' },
        enMensaje: 'no puede hacer nada',
      },
      {
        nombre: 'ventana de un minuto',
        parche: { windowStart: '09:00', windowEnd: '09:00' },
        enMensaje: 'ese minuto exacto',
      },
      {
        nombre: 'condiciones que se contradicen',
        parche: {
          conditions: [
            { metric: 'spend', op: '>', value: 10 },
            { metric: 'spend', op: '<', value: 2 },
          ],
        },
        enMensaje: 'nunca',
      },
    ];

    for (const c of casos) {
      const resp = await post({ ...payloadMinimo(), name: `${PREFIJO}incoherente`, ...c.parche });
      expect(resp.status, c.nombre).toBe(400);
      const cuerpo = (await resp.json()) as { error?: string; detail?: string };
      expect(cuerpo.error, c.nombre).toBe('invalid_payload');
      expect(cuerpo.detail ?? '', c.nombre).toContain(c.enMensaje);
    }

    // Ninguno dejó rastro.
    expect(await fotoDeReglas()).toEqual(antes);
  });

  it('una regla incoherente ya guardada se puede APAGAR y mandar a sombra', async (ctx) => {
    if (!(await requiereEsquema021(ctx))) return;
    const nombre = `${PREFIJO}incoherente-guardada-${Date.now()}`;
    // Se siembra por SQL, salteando el API: es el estado en el que quedaron las
    // reglas creadas antes de que existiera esta validación.
    const fila = await q1<{ id: number }>(
      `INSERT INTO ad_rules (name, enabled, dry_run, account_id, level, status_filter, action,
                             window_start, window_end)
       VALUES ($1, true, false, $2, 'adset', 'paused', 'pause', '09:00'::time, '09:00'::time)
       RETURNING id`,
      [nombre, CUENTA_A],
    );
    const id = fila!.id;
    try {
      const base = { ...payloadMinimo(), id, name: nombre, statusFilter: 'paused' as const, action: 'pause' as const };

      // Apagarla: permitido aunque siga siendo incoherente.
      const apagar = await post({ ...base, enabled: false });
      expect(apagar.status).toBe(200);

      // Volverla a sombra: también permitido.
      const sombra = await post({ ...base, dryRun: true });
      expect(sombra.status).toBe(200);

      // Prenderla en real: eso NO.
      const prender = await post({ ...base, enabled: true, dryRun: false });
      expect(prender.status).toBe(400);
      const cuerpo = (await prender.json()) as { detail?: string };
      expect(cuerpo.detail ?? '').toContain('no puede hacer nada');

      const estado = await q1<{ enabled: boolean; dry_run: boolean }>(
        `SELECT enabled, dry_run FROM ad_rules WHERE id = $1`,
        [id],
      );
      expect(estado?.enabled).toBe(false);
      expect(estado?.dry_run).toBe(true);
    } finally {
      await q(`DELETE FROM ad_rules WHERE id = $1`, [id]);
    }
  });
});

/** UNA mutación de la cuenta entre las seis del criterio de la Property 7. */
function cuentaMutada(p: PayloadRegla, mutacion: 'ausente' | 'vacia' | 'espacios' | 'larga' | 'inexistente' | 'inactiva'): string {
  switch (mutacion) {
    case 'vacia':
      return '';
    case 'espacios':
      return '   ';
    case 'larga':
      return 'x'.repeat(65);
    case 'inexistente':
      // Id fijo y sin espacios en los bordes: el zod aplica trim() y el detail
      // del 400 nombra el id YA recortado.
      return `${PREFIJO}no-existe`;
    case 'inactiva':
      return CUENTA_INACTIVA;
    case 'ausente':
      return p.accountId; // no importa: el campo se borra
  }
}
