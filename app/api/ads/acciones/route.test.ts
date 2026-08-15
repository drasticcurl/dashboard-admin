import fc from 'fast-check';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { q, q1 } from '../../../../lib/db';
import { POST } from './route';
import { enviar, fetchObjeto, MetaAdsError, postForm, setInicio, setNombre } from '../../../../lib/ads/meta';
import { sincronizarJerarquia } from '../../../../lib/ads/jerarquia';
import { isAuthenticated } from '../../../../lib/auth';
import { preflight } from '../../../../lib/ads/acciones';

/**
 * Property 14 (task 18.3): un lote inválido no produce ningún efecto (R13 c12,
 * R17 c4, R14 c13, R10 c17, R10 c18, R17 c5). Generador: pedido válido + UNA
 * mutación que lo invalida, elegida al azar. Los espías fallan el test si se
 * llama a Meta (escritura) o si se escribe en la base.
 */

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

vi.mock('../../../../lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/auth')>();
  return { ...actual, isAuthenticated: vi.fn(() => true), getClientIp: () => 'test-ip' };
});

vi.mock('../../../../lib/ads/meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/ads/meta')>();
  return {
    ...actual,
    enviar: vi.fn(),
    setNombre: vi.fn(),
    setInicio: vi.fn(),
    fetchObjeto: vi.fn(),
    fetchMinimoPresupuesto: vi.fn().mockResolvedValue(null),
    postForm: vi.fn(),
  };
});

vi.mock('../../../../lib/ads/jerarquia', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/ads/jerarquia')>();
  return { ...actual, sincronizarJerarquia: vi.fn().mockResolvedValue({ cuentas: [], corridaAt: '' }) };
});

const mockEnviar = vi.mocked(enviar);
const mockSetNombre = vi.mocked(setNombre);
const mockSetInicio = vi.mocked(setInicio);
const mockFetchObjeto = vi.mocked(fetchObjeto);
const mockAuth = vi.mocked(isAuthenticated);

const CUENTA = `P14-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const OTRA_CUENTA = `${CUENTA}-otra`;
// ids de 20 dígitos: el esquema cerrado exige ^\d{1,20}$ (R17 c3)
const CAMPANA = '11111111111111111111';
const OTRA_CAMPANA = '33333333333333333333';
const CONJUNTO = '22222222222222222222';

async function contarAcciones(): Promise<number> {
  const r = await q1<{ n: number }>(`SELECT count(*)::int AS n FROM ad_actions`);
  return r?.n ?? 0;
}

const peticionValida = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  level: 'campaign',
  accountId: CUENTA,
  action: 'pause',
  objectIds: [CAMPANA],
  ...over,
});

const mutaciones = fc.constantFrom(
  'id_inexistente',
  'id_de_otra_cuenta',
  'id_formato_invalido',
  'campo_no_declarado',
  'accion_invalida',
  'lote_de_101',
  'presupuesto_sobre_techo',
  'presupuesto_tres_decimales',
  'presupuesto_lifetime',
  'presupuesto_nivel_ajeno',
  'moneda_no_eur',
  'sin_cookie',
);

function aplicarMutacion(base: Record<string, unknown>, m: string): Record<string, unknown> {
  const c = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  switch (m) {
    case 'id_inexistente':
      c.objectIds = ['9999999999999999'];
      return c;
    case 'id_de_otra_cuenta':
      c.accountId = OTRA_CUENTA;
      c.objectIds = [CAMPANA]; // la campaña existe, pero en OTRA cuenta
      return c;
    case 'id_formato_invalido':
      c.objectIds = ['abc'];
      return c;
    case 'campo_no_declarado':
      c['campo_fantasma'] = 1;
      return c;
    case 'accion_invalida':
      c.action = 'archive'; // R17 c13: archivado no es representable
      return c;
    case 'lote_de_101':
      c.objectIds = Array.from({ length: 101 }, (_, i) => `${CAMPANA}-${i}`);
      return c;
    case 'presupuesto_sobre_techo':
      c.action = 'budget_set';
      c.level = 'adset';
      c.objectIds = [CONJUNTO];
      c.budgetEur = 999999; // techo de settings = 200
      return c;
    case 'presupuesto_tres_decimales':
      c.action = 'budget_set';
      c.level = 'adset';
      c.objectIds = [CONJUNTO];
      c.budgetEur = 10.999;
      return c;
    case 'presupuesto_lifetime': {
      c.action = 'budget_set';
      c.level = 'campaign';
      c.objectIds = [CAMPANA];
      c.budgetEur = 10;
      return c; // CAMPANA está sembrada con lifetime_budget
    }
    case 'presupuesto_nivel_ajeno':
      c.action = 'budget_set';
      c.level = 'adset';
      c.objectIds = [CONJUNTO];
      c.budgetEur = 10; // el conjunto es de campaña CBO: presupuesto vive en la campaña
      return c;
    case 'moneda_no_eur':
      // La cuenta de la otra campaña factura en USD: un presupuesto se rechaza.
      return {
        level: 'campaign',
        accountId: OTRA_CUENTA,
        action: 'budget_set',
        objectIds: [OTRA_CAMPANA],
        budgetEur: 10,
      };
    case 'sin_cookie':
      return c; // el cuerpo queda válido; la cookie se revoca en el test
    default:
      return c;
  }
}

async function sembrar(): Promise<void> {
  await q(
    `INSERT INTO ad_accounts (account_id, platform, name, currency, active, timezone) VALUES
       ($1, 'meta', 'test', 'EUR', true, 'Europe/Lisbon'),
       ($2, 'meta', 'otra', 'USD', true, 'Europe/Lisbon')
     ON CONFLICT (account_id) DO UPDATE SET active = true, currency = EXCLUDED.currency`,
    [CUENTA, OTRA_CUENTA],
  );
  await q(
    `INSERT INTO ad_campaigns (campaign_id, account_id, name, status, effective_status,
                               budget_level, lifetime_budget, currency, synced_at) VALUES
       ($1, $3, 'Campaña lifetime', 'ACTIVE', 'ACTIVE', 'campaign', 5000, 'EUR', now()),
       ($2, $4, 'Campaña de otra cuenta', 'ACTIVE', 'ACTIVE', 'campaign', NULL, 'USD', now())
     ON CONFLICT (campaign_id) DO UPDATE SET synced_at = now()`,
    [CAMPANA, OTRA_CAMPANA, CUENTA, OTRA_CUENTA],
  );
  await q(
    `INSERT INTO ad_sets (adset_id, campaign_id, account_id, name, status, effective_status,
                          daily_budget, currency, synced_at)
     VALUES ($1, $2, $3, 'Conjunto CBO', 'ACTIVE', 'ACTIVE', NULL, 'EUR', now())
     ON CONFLICT (adset_id) DO UPDATE SET synced_at = now()`,
    [CONJUNTO, CAMPANA, CUENTA],
  );
}

beforeAll(async () => {
  if (!dbAvailable) return;
  await sembrar();
});

afterAll(async () => {
  if (!dbAvailable) return;
  await q('DELETE FROM ad_sets WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_campaigns WHERE account_id = ANY($1::text[])', [[CUENTA, OTRA_CUENTA]]);
  await q('DELETE FROM ad_accounts WHERE account_id = ANY($1::text[])', [[CUENTA, OTRA_CUENTA]]);
});

function requestCon(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/ads/acciones', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Feature: gestion-campanas-anuncios, Property 14: Un lote inválido no produce
// ningún efecto
describe.skipIf(!dbAvailable)('Property 14 (R13 c12, R17 c4, R14 c13, R10 c17, c18, R17 c5)', () => {
  it('para todo pedido válido con UNA cota rota al azar, el endpoint rechaza con cero escrituras y cero llamadas de escritura a Meta', async () => {
    await fc.assert(
      fc.asyncProperty(mutaciones, async (m) => {
        mockEnviar.mockClear();
        mockFetchObjeto.mockClear();
        mockAuth.mockClear();
        mockAuth.mockImplementation(() => true);
        const antes = await contarAcciones();
        const pedido = aplicarMutacion(peticionValida(), m);

        if (m === 'sin_cookie') {
          mockAuth.mockImplementationOnce(() => false); // R17 c1: 401 antes de deserializar
        }

        const resp = await POST(requestCon(pedido) as never);
        const cuerpo = (await resp.json()) as { ok: boolean; error?: string; detail?: string };

        // rechazado
        expect(resp.status, `mutación ${m}`).not.toBe(200);
        expect(cuerpo.ok, `mutación ${m}`).toBe(false);
        // cero llamadas de escritura a Meta
        expect(mockEnviar, `mutación ${m}: enviar() fue llamado`).not.toHaveBeenCalled();
        expect(mockFetchObjeto, `mutación ${m}`).not.toHaveBeenCalled();
        // cero escrituras en la base (ad_actions es la única tabla que escribe)
        expect(await contarAcciones(), `mutación ${m}`).toBe(antes);
      }),
      { numRuns: 100 },
    );
  }, 60_000);
});

// Feature: gestion-campanas-anuncios, Property 15: Una fila de ad_actions por
// objeto alcanzado, siempre cerrada
describe.skipIf(!dbAvailable)('Property 15 (R15 c1, c3, c6, R16 c2)', () => {
  const CUENTA_P15 = `P15-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  type Desenlace = 'ok' | 'error' | 'timeout' | 'corte';

  const desenlaces = fc.constantFrom<Desenlace>('ok', 'error', 'timeout', 'corte');

  async function sembrarP15(n: number): Promise<string[]> {
    // ids de 20 dígitos, únicos dentro de la cuenta
    const ids = Array.from({ length: n }, (_, i) => String(i).padStart(20, '0'));
    // defensa contra corridas anteriores: la PK de ad_campaigns es GLOBAL y un
    // id reciclado puede pertenecer a la cuenta de otra corrida
    await q('DELETE FROM ad_campaigns WHERE campaign_id = ANY($1::text[])', [ids]);
    await q(
      `INSERT INTO ad_accounts (account_id, platform, name, currency, active, timezone)
       VALUES ($1, 'meta', 'test', 'EUR', true, 'Europe/Lisbon')
       ON CONFLICT (account_id) DO UPDATE SET active = true`,
      [CUENTA_P15],
    );
    for (const id of ids) {
      await q(
        `INSERT INTO ad_campaigns (campaign_id, account_id, name, status, effective_status,
                                   budget_level, currency, synced_at)
         VALUES ($1, $2, $3, 'ACTIVE', 'ACTIVE', 'campaign', 'EUR', now())
         ON CONFLICT (campaign_id) DO UPDATE SET synced_at = now()`,
        [id, CUENTA_P15, `Objeto ${id}`],
      );
    }
    return ids;
  }

  async function resetearBackoff(): Promise<void> {
    await q(
      `UPDATE settings SET value = '""'::jsonb WHERE key IN ('ads_backoff_until', 'ads_backoff_reason')`,
    );
    await q(
      `UPDATE settings SET value = '0'::jsonb WHERE key IN ('ads_backoff_failures', 'ads_backoff_clean_ticks')`,
    );
  }

  afterAll(async () => {
    if (!dbAvailable) return;
    await q('DELETE FROM ad_actions WHERE account_id = $1', [CUENTA_P15]);
    await q('DELETE FROM ad_campaigns WHERE account_id = $1', [CUENTA_P15]);
    await q('DELETE FROM ad_accounts WHERE account_id = $1', [CUENTA_P15]);
    await resetearBackoff();
  });

  it('para todo lote con un patrón al azar de éxito, error, timeout y corte, cada objeto alcanzado tiene exactamente una fila manual y cerrada', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 100 }).chain((n) =>
          fc.array(desenlaces, { minLength: n, maxLength: n }).map((patron) => ({ n, patron })),
        ),
        async ({ n, patron }) => {
          await q('DELETE FROM ad_actions WHERE account_id = $1', [CUENTA_P15]);
          await resetearBackoff();
          mockAuth.mockClear();
          mockAuth.mockImplementation(() => true);
          const ids = await sembrarP15(n);

          const porId = new Map(ids.map((id, i) => [id, patron[i]!]));
          mockEnviar.mockClear();
          mockFetchObjeto.mockClear();
          mockFetchObjeto.mockResolvedValue(null); // refrescarJerarquia no-op
          mockEnviar.mockImplementation(async (objectId: string) => {
            const d = porId.get(objectId)!;
            if (d === 'ok') return { estado: 'confirmado' as const };
            if (d === 'error') {
              return {
                estado: 'fallido' as const,
                error: new MetaAdsError('rechazado por Meta', 9999),
              };
            }
            if (d === 'timeout') {
              return {
                estado: 'indeterminado' as const,
                error: new MetaAdsError('timeout', undefined, undefined, undefined, true),
              };
            }
            // corte: cuota (613), que es el corte VERIFICADO del catálogo
            return {
              estado: 'fallido' as const,
              error: new MetaAdsError('cuota', 613),
            };
          });

          const resp = await POST(
            requestCon({
              level: 'campaign',
              accountId: CUENTA_P15,
              action: 'pause',
              objectIds: ids,
            }) as never,
          );
          const cuerpo = (await resp.json()) as {
            ok: boolean;
            total: number;
            corte: { causa: string } | null;
            resultados: Array<{ objectId: string; estado: string }>;
          };

          // la respuesta clasifica cada objeto
          expect(cuerpo.total).toBe(n);
          expect(cuerpo.resultados).toHaveLength(n);
          const corteEn = patron.indexOf('corte');
          for (let i = 0; i < n; i++) {
            const d = patron[i]!;
            const r = cuerpo.resultados[i]!;
            expect(r.objectId).toBe(ids[i]);
            if (corteEn >= 0 && i > corteEn) continue; // cortado: no_intentado (se verifica abajo)
            if (d === 'ok') expect(r.estado).toBe('confirmado');
            if (d === 'error') expect(r.estado).toBe('fallido');
            if (d === 'timeout') expect(r.estado).toBe('indeterminado');
            if (d === 'corte') {
              expect(r.estado).toBe('fallido');
              expect(cuerpo.corte?.causa).toBe('cuota');
            }
          }
          if (corteEn >= 0) {
            for (let i = corteEn + 1; i < n; i++) {
              expect(cuerpo.resultados[i]!.estado).toBe('no_intentado');
            }
          }

          // ad_actions: exactamente una fila por objeto INTENTADO (los del
          // corte hacia atrás no se intentan y no tienen fila), todas manuales
          // y ninguna pendiente al terminar.
          const intentados = corteEn >= 0 ? corteEn + 1 : n;
          const filas = await q<{ object_id: string; source: string; estado: string }>(
            `SELECT object_id, source, estado FROM ad_actions WHERE account_id = $1 ORDER BY id`,
            [CUENTA_P15],
          );
          expect(filas).toHaveLength(intentados);
          for (const f of filas) {
            expect(f.source).toBe('manual');
            expect(f.estado).not.toBe('pendiente'); // R15 c3: siempre cerrada
          }
          for (let i = 0; i < intentados; i++) {
            const d = patron[i]!;
            const f = filas[i]!;
            expect(f.object_id).toBe(ids[i]);
            if (d === 'ok') expect(f.estado).toBe('confirmado');
            if (d === 'error') expect(f.estado).toBe('fallido');
            if (d === 'timeout') expect(f.estado).toBe('indeterminado');
            if (d === 'corte') expect(f.estado).toBe('fallido');
          }
        },
      ),
      { numRuns: 100 },
    );
  }, 60_000);
});

// ─── Tests de ejemplo del Endpoint_Acciones (task 18.5) ─────────────────────

describe.skipIf(!dbAvailable)('Endpoint_Acciones — ejemplos (R17 c1..c7, c11, c13)', () => {
  const CUENTA_E = `E18-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  // ids de 20 dígitos: el esquema cerrado exige ^\d{1,20}$ (R17 c3)
  const CAMP_E = '44444444444444444444';
  const CAMP_E2 = '55555555555555555555';
  const OTRA_E = `${CUENTA_E}-otra`;
  const CAMP_OTRA = '66666666666666666666';

  async function sembrar(): Promise<void> {
    await q(
      `INSERT INTO ad_accounts (account_id, platform, name, currency, active, timezone) VALUES
         ($1, 'meta', 'test', 'EUR', true, 'Europe/Lisbon'),
         ($2, 'meta', 'otra', 'EUR', true, 'Europe/Lisbon')
       ON CONFLICT (account_id) DO UPDATE SET active = true`,
      [CUENTA_E, OTRA_E],
    );
    await q(
      `INSERT INTO ad_campaigns (campaign_id, account_id, name, status, effective_status,
                                 budget_level, daily_budget, currency, synced_at) VALUES
         ($1, $3, 'Campaña A', 'ACTIVE', 'ACTIVE', 'campaign', 1000, 'EUR', now()),
         ($2, $3, 'Campaña B', 'ACTIVE', 'ACTIVE', 'campaign', 1000, 'EUR', now()),
         ($4, $5, 'Campaña de otra cuenta', 'ACTIVE', 'ACTIVE', 'campaign', 1000, 'EUR', now())
       ON CONFLICT (campaign_id) DO UPDATE SET synced_at = now()`,
      [CAMP_E, CAMP_E2, CUENTA_E, CAMP_OTRA, OTRA_E],
    );
  }

  beforeAll(async () => {
    if (!dbAvailable) return;
    await sembrar();
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await q('DELETE FROM ad_actions WHERE account_id = $1', [CUENTA_E]);
    await q('DELETE FROM ad_campaigns WHERE account_id = ANY($1::text[])', [[CUENTA_E, OTRA_E]]);
    await q('DELETE FROM ad_accounts WHERE account_id = ANY($1::text[])', [[CUENTA_E, OTRA_E]]);
    await q(
      `UPDATE settings SET value = '""'::jsonb WHERE key IN ('ads_backoff_until', 'ads_backoff_reason')`,
    );
    await q(
      `UPDATE settings SET value = '0'::jsonb WHERE key IN ('ads_backoff_failures', 'ads_backoff_clean_ticks')`,
    );
    await q(`UPDATE settings SET value = 'false'::jsonb WHERE key = 'ads_rules_enabled'`);
    await q(`UPDATE settings SET value = 'true'::jsonb WHERE key = 'ads_rules_force_dry_run'`);
  });

  const pedir = (body: Record<string, unknown>): Promise<Response> =>
    POST(
      new Request('http://localhost/api/ads/acciones', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }) as never,
    );

  it('sin cookie: 401, cero escrituras, cero llamadas a Meta (R17 c1, c2)', async () => {
    mockAuth.mockImplementation(() => false);
    mockEnviar.mockClear();
    const antes = await contarAcciones();
    const resp = await pedir({ level: 'campaign', accountId: CUENTA_E, action: 'pause', objectIds: [CAMP_E] });
    expect(resp.status).toBe(401);
    expect(mockEnviar).not.toHaveBeenCalled();
    expect(await contarAcciones()).toBe(antes);
  });

  it('un campo no declarado rechaza el pedido entero (R17 c3)', async () => {
    mockAuth.mockImplementation(() => true);
    const resp = await pedir({
      level: 'campaign',
      accountId: CUENTA_E,
      action: 'pause',
      objectIds: [CAMP_E],
      forzar: true, // no declarado
    });
    expect(resp.status).toBe(400);
    const cuerpo = (await resp.json()) as { error: string };
    expect(cuerpo.error).toBe('invalid_payload');
  });

  it('un id de otra cuenta rechaza el lote completo enumerando los ids (R17 c4)', async () => {
    mockAuth.mockImplementation(() => true);
    mockEnviar.mockClear();
    const resp = await pedir({ level: 'campaign', accountId: CUENTA_E, action: 'pause', objectIds: [CAMP_OTRA] });
    expect(resp.status).toBe(400);
    const cuerpo = (await resp.json()) as { error: string; detail: string };
    expect(cuerpo.error).toBe('objetos_invalidos');
    expect(cuerpo.detail).toContain(CAMP_OTRA);
    expect(mockEnviar).not.toHaveBeenCalled();
  });

  it('un estado distinto de ACTIVE/PAUSED o un archivado/borrado NO son representables (R17 c13)', async () => {
    mockAuth.mockImplementation(() => true);
    mockEnviar.mockClear();
    for (const action of ['archive', 'delete', 'ARCHIVED']) {
      const resp = await pedir({ level: 'campaign', accountId: CUENTA_E, action, objectIds: [CAMP_E] });
      expect(resp.status, `acción ${action}`).toBe(400);
    }
    expect(mockEnviar).not.toHaveBeenCalled();
  });

  it('el Techo_Absoluto no tiene excepciones, ni con marca de forzado (R17 c5, c7)', async () => {
    mockAuth.mockImplementation(() => true);
    mockEnviar.mockClear();
    // por encima del techo de settings (200)
    const resp = await pedir({
      level: 'campaign',
      accountId: CUENTA_E,
      action: 'budget_set',
      objectIds: [CAMP_E],
      budgetEur: 250,
    });
    expect(resp.status).toBe(400);
    const cuerpo = (await resp.json()) as { error: string; detail: string };
    expect(cuerpo.error).toBe('tope_absoluto');
    expect(cuerpo.detail).toContain('250');
    expect(mockEnviar).not.toHaveBeenCalled();
  });

  it('el Tope_Lote rechaza el lote completo con la suma y el tope (R13 c11, R17 c5)', async () => {
    mockAuth.mockImplementation(() => true);
    mockEnviar.mockClear();
    // dos campañas sin presupuesto, 199 c/u: delta 398 > tope 300
    const resp = await pedir({
      level: 'campaign',
      accountId: CUENTA_E,
      action: 'budget_set',
      objectIds: [CAMP_E, CAMP_E2],
      budgetEur: 199,
    });
    expect(resp.status).toBe(400);
    const cuerpo = (await resp.json()) as { error: string };
    expect(cuerpo.error).toBe('tope_lote');
    expect(mockEnviar).not.toHaveBeenCalled();
  });

  it('backoff por cuota activo rechaza las duplicaciones con los segundos restantes (R17 c11)', async () => {
    mockAuth.mockImplementation(() => true);
    await q(
      `UPDATE settings SET value = to_jsonb((now() + interval '5 minutes')::text)
        WHERE key = 'ads_backoff_until'`,
    );
    const pf = await preflight({
      level: 'campaign',
      accountId: CUENTA_E,
      accion: 'duplicate',
      objectIds: [CAMP_E],
      copias: 1,
    });
    expect(pf.ok).toBe(false);
    if (!pf.ok) {
      expect(pf.error.motivo).toBe('backoff_activo');
      expect(pf.error.detalle).toMatch(/segundos/);
    }
  });

  it('los interruptores del motor apagados NO frenan una acción manual (R17 c6)', async () => {
    mockAuth.mockImplementation(() => true);
    mockEnviar.mockClear();
    mockEnviar.mockResolvedValue({ estado: 'confirmado' });
    mockFetchObjeto.mockResolvedValue(null);
    await q(`UPDATE settings SET value = 'false'::jsonb WHERE key = 'ads_rules_enabled'`);
    await q(`UPDATE settings SET value = 'true'::jsonb WHERE key = 'ads_rules_force_dry_run'`);

    const resp = await pedir({ level: 'campaign', accountId: CUENTA_E, action: 'pause', objectIds: [CAMP_E] });
    expect(resp.status).toBe(200);
    const cuerpo = (await resp.json()) as { ok: boolean; aplicados: number; resultados: Array<{ estado: string }> };
    expect(cuerpo.ok).toBe(true);
    expect(cuerpo.aplicados).toBe(1);
    expect(cuerpo.resultados[0]!.estado).toBe('confirmado');
    expect(mockEnviar).toHaveBeenCalledTimes(1);
  });
});

// ─── Tests de la duplicación (task 23.5) ────────────────────────────────────

describe.skipIf(!dbAvailable)('duplicación (R10 c4, c10, c11, c12, c14, c17, R16 c5)', () => {
  const CUENTA_D = `D23-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const CAMP_D = '77777777777777777777';
  const CAMP_D2 = '88888888888888888888';
  const mockPostForm = vi.mocked(postForm);
  const mockSync = vi.mocked(sincronizarJerarquia);

  beforeAll(async () => {
    if (!dbAvailable) return;
    await q(
      `INSERT INTO ad_accounts (account_id, platform, name, currency, active, timezone)
       VALUES ($1, 'meta', 'test', 'EUR', true, 'Europe/Lisbon')
       ON CONFLICT (account_id) DO UPDATE SET active = true`,
      [CUENTA_D],
    );
    const idsD = [CAMP_D, CAMP_D2, ...Array.from({ length: 19 }, (_, i) => `77${String(i + 10).padStart(18, '0')}`)];
    for (const id of idsD) {
      await q(
        `INSERT INTO ad_campaigns (campaign_id, account_id, name, status, effective_status,
                                   budget_level, currency, synced_at)
         VALUES ($1, $2, $3, 'ACTIVE', 'ACTIVE', 'campaign', 'EUR', now())
         ON CONFLICT (campaign_id) DO UPDATE SET synced_at = now()`,
        [id, CUENTA_D, `Campaña ${id}`],
      );
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await q('DELETE FROM ad_actions WHERE account_id = $1', [CUENTA_D]);
    await q('DELETE FROM ad_campaigns WHERE account_id = $1', [CUENTA_D]);
    await q('DELETE FROM ad_accounts WHERE account_id = $1', [CUENTA_D]);
    await q(
      `UPDATE settings SET value = '""'::jsonb WHERE key IN ('ads_backoff_until', 'ads_backoff_reason')`,
    );
    await q(`UPDATE settings SET value = '0'::jsonb WHERE key IN ('ads_backoff_failures', 'ads_backoff_clean_ticks')`);
  });

  const pedirDuplicar = (body: Record<string, unknown>): Promise<Response> =>
    POST(
      new Request('http://localhost/api/ads/acciones', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }) as never,
    );

  it('nivel ad se rechaza ANTES de llamar a Meta (R10 c14)', async () => {
    mockAuth.mockClear();
    mockAuth.mockImplementation(() => true);
    mockPostForm.mockClear();
    const resp = await pedirDuplicar({ level: 'ad', accountId: CUENTA_D, action: 'duplicate', objectIds: [CAMP_D], copias: 1 });
    expect(resp.status).toBe(400);
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it('copias fuera de 1..5 y más de 20 orígenes se rechazan sin crear nada (R10 c17)', async () => {
    mockAuth.mockClear();
    mockAuth.mockImplementation(() => true);
    mockPostForm.mockClear();

    const fueraDeRango = await pedirDuplicar({ level: 'campaign', accountId: CUENTA_D, action: 'duplicate', objectIds: [CAMP_D], copias: 6 });
    expect(fueraDeRango.status).toBe(400);

    const muchosOrigenes = await pedirDuplicar({
      level: 'campaign',
      accountId: CUENTA_D,
      action: 'duplicate',
      objectIds: Array.from({ length: 21 }, (_, i) => String(i).padStart(20, '0')),
      copias: 1,
    });
    expect(muchosOrigenes.status).toBe(400);
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it('más de 100 Copias por corrida se rechaza en el preflight (R17 c15)', async () => {
    mockAuth.mockClear();
    mockAuth.mockImplementation(() => true);
    const pf = await preflight({
      level: 'campaign',
      accountId: CUENTA_D,
      accion: 'duplicate',
      objectIds: [CAMP_D, CAMP_D2, ...Array.from({ length: 19 }, (_, i) => `77${String(i + 10).padStart(18, '0')}`)],
      copias: 5, // 105 copias
    });
    expect(pf.ok).toBe(false);
    if (!pf.ok) expect(pf.error.motivo).toBe('muchas_copias');
  });

  it('DSA faltante registra fallido con su mensaje y el lote CONTINÚA (R10 c11)', async () => {
    mockAuth.mockClear();
    mockAuth.mockImplementation(() => true);
    mockPostForm.mockClear();
    mockPostForm.mockImplementation(async (url) => {
      if (url.includes('77777777777777777777')) {
        return { res: new Response('{}', { status: 400 }), cuerpo: { error: { message: 'dsa', code: 100, error_subcode: 3858079 } } };
      }
      return { res: new Response('{}', { status: 200 }), cuerpo: { id: '120210000000000001' } };
    });
    mockSync.mockResolvedValue({ cuentas: [], corridaAt: '' });

    const resp = await pedirDuplicar({
      level: 'campaign',
      accountId: CUENTA_D,
      action: 'duplicate',
      objectIds: [CAMP_D, CAMP_D2],
      copias: 1,
    });
    expect(resp.status).toBe(200);
    const cuerpo = (await resp.json()) as {
      total: number;
      aplicados: number;
      resultados: Array<{ estado: string; mensaje: string | null; codigoMeta: number | null }>;
    };
    expect(cuerpo.total).toBe(2);
    expect(cuerpo.aplicados).toBe(1);
    expect(cuerpo.resultados[0]!.estado).toBe('fallido');
    expect(cuerpo.resultados[0]!.mensaje).toContain('pagador');
    expect(cuerpo.resultados[0]!.codigoMeta).toBe(100);
    expect(cuerpo.resultados[1]!.estado).toBe('confirmado');

    const filas = await q<{ estado: string }>(
      `SELECT estado FROM ad_actions WHERE account_id = $1 ORDER BY id`,
      [CUENTA_D],
    );
    expect(filas).toHaveLength(2);
    expect(filas[0]!.estado).toBe('fallido');
    expect(filas[1]!.estado).toBe('confirmado');
  }, 60_000);

  it('613 corta el lote: las confirmadas se informan, las restantes no se intentan y el backoff se activa (R10 c12, R17 c17)', async () => {
    mockAuth.mockClear();
    mockAuth.mockImplementation(() => true);
    mockPostForm.mockClear();
    mockPostForm.mockImplementation(async (url) => {
      if (url.includes('77777777777777777777')) {
        return { res: new Response('{}', { status: 200 }), cuerpo: { id: '120210000000000001' } };
      }
      return { res: new Response('{}', { status: 400 }), cuerpo: { error: { message: 'cuota', code: 613 } } };
    });
    mockSync.mockResolvedValue({ cuentas: [], corridaAt: '' });

    const resp = await pedirDuplicar({
      level: 'campaign',
      accountId: CUENTA_D,
      action: 'duplicate',
      objectIds: [CAMP_D, CAMP_D2],
      copias: 1,
    });
    const cuerpo = (await resp.json()) as {
      corte: { causa: string; backoffSegundos: number | null } | null;
      resultados: Array<{ estado: string }>;
    };
    expect(cuerpo.corte?.causa).toBe('cuota');
    expect(cuerpo.corte?.backoffSegundos).toBeGreaterThan(0);
    expect(cuerpo.resultados[0]!.estado).toBe('confirmado');
    expect(cuerpo.resultados[1]!.estado).toBe('fallido');
  }, 60_000);

  it('un Sync_Jerarquia fallido deja la duplicación CONFIRMADA sin repetir la copia (R10 c10)', async () => {
    await q(
      `UPDATE settings SET value = '""'::jsonb WHERE key IN ('ads_backoff_until', 'ads_backoff_reason')`,
    );
    await q(`UPDATE settings SET value = '0'::jsonb WHERE key IN ('ads_backoff_failures', 'ads_backoff_clean_ticks')`);
    mockAuth.mockClear();
    mockAuth.mockImplementation(() => true);
    mockPostForm.mockClear();
    mockPostForm.mockResolvedValue({ res: new Response('{}', { status: 200 }), cuerpo: { id: '120210000000000001' } });
    mockSync.mockRejectedValue(new Error('Meta no responde'));

    const resp = await pedirDuplicar({
      level: 'campaign',
      accountId: CUENTA_D,
      action: 'duplicate',
      objectIds: [CAMP_D],
      copias: 1,
    });
    expect(resp.status).toBe(200);
    const cuerpo = (await resp.json()) as { aplicados: number; jerarquiaSincronizada: boolean };
    expect(cuerpo.aplicados).toBe(1);
    expect(cuerpo.jerarquiaSincronizada).toBe(false);
    // la operación de copia NO se repite: una sola llamada a /copies
    const llamadasCopias = mockPostForm.mock.calls.filter(([u]) => String(u).includes('/copies'));
    expect(llamadasCopias).toHaveLength(1);
  }, 60_000);
});

// ─── Tests del renombrado (task 25.3) ───────────────────────────────────────

describe.skipIf(!dbAvailable)('renombrado (R12 c3, c4, c9, c10, c11)', () => {
  const CUENTA_R = `R25-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const OBJ_R = '55555555555555555551';
  const OBJ_R2 = '55555555555555555552';

  beforeAll(async () => {
    if (!dbAvailable) return;
    await q(
      `INSERT INTO ad_accounts (account_id, platform, name, currency, active, timezone)
       VALUES ($1, 'meta', 'test', 'EUR', true, 'Europe/Lisbon')
       ON CONFLICT (account_id) DO UPDATE SET active = true`,
      [CUENTA_R],
    );
    for (const [id, nombre] of [[OBJ_R, 'Frío'], [OBJ_R2, 'Caliente']]) {
      await q(
        `INSERT INTO ad_campaigns (campaign_id, account_id, name, status, effective_status,
                                   budget_level, currency, synced_at)
         VALUES ($1, $2, $3, 'ACTIVE', 'ACTIVE', 'campaign', 'EUR', now())
         ON CONFLICT (campaign_id) DO UPDATE SET synced_at = now(), name = $3`,
        [id, CUENTA_R, nombre],
      );
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await q('DELETE FROM ad_actions WHERE account_id = $1', [CUENTA_R]);
    await q('DELETE FROM ad_campaigns WHERE account_id = $1', [CUENTA_R]);
    await q('DELETE FROM ad_accounts WHERE account_id = $1', [CUENTA_R]);
  });

  const pedirRename = (body: Record<string, unknown>): Promise<Response> =>
    POST(
      new Request('http://localhost/api/ads/acciones', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }) as never,
    );

  it('nombre vacío y nombre de 401 caracteres se rechazan sin llamar a Meta (R12 c3, c4)', async () => {
    mockAuth.mockClear();
    mockAuth.mockImplementation(() => true);
    mockEnviar.mockClear();

    const vacio = await pedirRename({
      level: 'campaign',
      accountId: CUENTA_R,
      action: 'rename',
      objectIds: [OBJ_R],
      modo: { tipo: 'exacto', nombre: '   ' },
    });
    expect(vacio.status).toBe(400);

    const largo = await pedirRename({
      level: 'campaign',
      accountId: CUENTA_R,
      action: 'rename',
      objectIds: [OBJ_R],
      modo: { tipo: 'exacto', nombre: 'x'.repeat(401) },
    });
    expect(largo.status).toBe(400);
    expect(mockEnviar).not.toHaveBeenCalled();
  });

  it('un objeto que falla no detiene el lote: resultado individual por objeto (R12 c10)', async () => {
    mockAuth.mockClear();
    mockAuth.mockImplementation(() => true);
    mockSetNombre.mockClear();
    mockFetchObjeto.mockClear();
    mockSetNombre
      .mockResolvedValueOnce({ estado: 'fallido', error: new MetaAdsError('rechazado', 9999) })
      .mockResolvedValueOnce({ estado: 'confirmado' });
    mockFetchObjeto.mockResolvedValue({ objectId: OBJ_R2, name: 'Caliente - v2', status: 'ACTIVE', effectiveStatus: 'ACTIVE', dailyBudget: null, lifetimeBudget: null });

    const resp = await pedirRename({
      level: 'campaign',
      accountId: CUENTA_R,
      action: 'rename',
      objectIds: [OBJ_R, OBJ_R2],
      modo: { tipo: 'sufijo', texto: ' - v2' },
    });
    expect(resp.status).toBe(200);
    const cuerpo = (await resp.json()) as { aplicados: number; total: number; resultados: Array<{ estado: string; codigoMeta: number | null }> };
    expect(cuerpo.total).toBe(2);
    expect(cuerpo.aplicados).toBe(1);
    expect(cuerpo.resultados[0]!.estado).toBe('fallido');
    expect(cuerpo.resultados[0]!.codigoMeta).toBe(9999);
    expect(cuerpo.resultados[1]!.estado).toBe('confirmado');

    // la fila local del confirmado refleja el nombre releído de Meta (R12 c5)
    const fila = await q<{ name: string | null }>(
      `SELECT name FROM ad_campaigns WHERE campaign_id = $1`,
      [OBJ_R2],
    );
    expect(fila[0]!.name).toBe('Caliente - v2');
  }, 30_000);

  it('si la relectura no devuelve nombre en 10 s, la fila local conserva el anterior y queda pendiente de verificación (R12 c11)', async () => {
    mockAuth.mockClear();
    mockAuth.mockImplementation(() => true);
    mockSetNombre.mockClear();
    mockFetchObjeto.mockClear();
    mockSetNombre.mockResolvedValue({ estado: 'confirmado' });
    mockFetchObjeto.mockResolvedValue(null); // la relectura no devuelve nada

    const resp = await pedirRename({
      level: 'campaign',
      accountId: CUENTA_R,
      action: 'rename',
      objectIds: [OBJ_R],
      modo: { tipo: 'sufijo', texto: ' - v3' },
    });
    const cuerpo = (await resp.json()) as { resultados: Array<{ estado: string; mensaje: string | null }> };
    expect(cuerpo.resultados[0]!.estado).toBe('confirmado');
    expect(cuerpo.resultados[0]!.mensaje).toContain('no pudo verificarse');

    const fila = await q<{ name: string | null }>(
      `SELECT name FROM ad_campaigns WHERE campaign_id = $1`,
      [OBJ_R],
    );
    expect(fila[0]!.name).toBe('Frío'); // conserva el anterior

    const accion = await q<{ metrics: Record<string, unknown> }>(
      `SELECT metrics FROM ad_actions WHERE account_id = $1 AND object_id = $2 ORDER BY id DESC LIMIT 1`,
      [CUENTA_R, OBJ_R],
    );
    expect(accion[0]!.metrics.pendiente_verificacion).toBe(true);
  }, 30_000);
});

// ─── Tests de la programación (task 26.3) ───────────────────────────────────

describe.skipIf(!dbAvailable)('programación del inicio (R11 c4, c5, c6, c9, c10, c11)', () => {
  const CUENTA_S = `S26-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const SET_FRESCO = '66666666666666666661';
  const SET_ENTREGANDO = '66666666666666666662';

  beforeAll(async () => {
    if (!dbAvailable) return;
    await q(
      `INSERT INTO ad_accounts (account_id, platform, name, currency, active, timezone)
       VALUES ($1, 'meta', 'test', 'EUR', true, 'Europe/Lisbon')
       ON CONFLICT (account_id) DO UPDATE SET active = true`,
      [CUENTA_S],
    );
    await q(
      `INSERT INTO ad_campaigns (campaign_id, account_id, name, status, effective_status,
                                 budget_level, currency, synced_at)
       VALUES ($1, $2, 'Campaña S', 'ACTIVE', 'ACTIVE', 'adset', 'EUR', now())
       ON CONFLICT (campaign_id) DO UPDATE SET synced_at = now()`,
      ['66666666666666666660', CUENTA_S],
    );
    await q(
      `INSERT INTO ad_sets (adset_id, campaign_id, account_id, name, status, effective_status,
                            currency, synced_at)
       VALUES ($1, '66666666666666666660', $2, 'Fresco', 'PAUSED', 'PAUSED', 'EUR', now())
       ON CONFLICT (adset_id) DO UPDATE SET synced_at = now(), start_time = NULL`,
      [SET_FRESCO, CUENTA_S],
    );
    await q(
      `INSERT INTO ad_sets (adset_id, campaign_id, account_id, name, status, effective_status,
                            start_time, currency, synced_at)
       VALUES ($1, '66666666666666666660', $2, 'Entregando', 'ACTIVE', 'ACTIVE',
               (now() - interval '1 day'), 'EUR', now())
       ON CONFLICT (adset_id) DO UPDATE SET synced_at = now(), start_time = (now() - interval '1 day')`,
      [SET_ENTREGANDO, CUENTA_S],
    );
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await q('DELETE FROM ad_actions WHERE account_id = $1', [CUENTA_S]);
    await q('DELETE FROM ad_sets WHERE account_id = $1', [CUENTA_S]);
    await q('DELETE FROM ad_campaigns WHERE account_id = $1', [CUENTA_S]);
    await q('DELETE FROM ad_accounts WHERE account_id = $1', [CUENTA_S]);
  });

  const pedirSchedule = (body: Record<string, unknown>): Promise<Response> =>
    POST(
      new Request('http://localhost/api/ads/acciones', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }) as never,
    );

  const manana = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10) + 'T00:00:00+00:00';

  it('un pedido a nivel ad falla la validación sin tocar la base (R11 c9)', async () => {
    mockAuth.mockClear();
    mockAuth.mockImplementation(() => true);
    mockSetInicio.mockClear();
    const resp = await pedirSchedule({
      level: 'ad',
      accountId: CUENTA_S,
      action: 'schedule',
      objectIds: [SET_FRESCO],
      inicio: manana,
    });
    expect(resp.status).toBe(400);
    expect(mockSetInicio).not.toHaveBeenCalled();
  });

  it('un inicio anterior al momento del pedido rechaza el lote completo (R11 c5)', async () => {
    mockAuth.mockClear();
    mockAuth.mockImplementation(() => true);
    mockSetInicio.mockClear();
    const pasado = new Date(Date.now() - 60_000).toISOString().slice(0, 19) + '+00:00';
    const resp = await pedirSchedule({
      level: 'adset',
      accountId: CUENTA_S,
      action: 'schedule',
      objectIds: [SET_FRESCO],
      inicio: pasado,
    });
    expect(resp.status).toBe(400);
    const cuerpo = (await resp.json()) as { error: string };
    expect(cuerpo.error).toBe('fecha_invalida');
    expect(mockSetInicio).not.toHaveBeenCalled();
  });

  it('un objeto que ya está entregando se omite con su motivo y el lote sigue (R11 c6)', async () => {
    mockAuth.mockClear();
    mockAuth.mockImplementation(() => true);
    mockSetInicio.mockClear();
    mockSetInicio.mockResolvedValue({ estado: 'confirmado' });
    mockFetchObjeto.mockResolvedValue({
      objectId: SET_FRESCO,
      name: null,
      status: 'PAUSED',
      effectiveStatus: 'PAUSED',
      dailyBudget: null,
      lifetimeBudget: null,
    });

    const resp = await pedirSchedule({
      level: 'adset',
      accountId: CUENTA_S,
      action: 'schedule',
      objectIds: [SET_ENTREGANDO, SET_FRESCO],
      inicio: manana,
    });
    expect(resp.status).toBe(200);
    const cuerpo = (await resp.json()) as {
      aplicados: number;
      resultados: Array<{ estado: string; motivo?: string; mensaje: string | null }>;
    };
    expect(cuerpo.aplicados).toBe(1);
    expect(cuerpo.resultados[0]!.estado).toBe('omitido');
    expect(cuerpo.resultados[0]!.motivo).toBe('ya_esta_entregando');
    expect(cuerpo.resultados[1]!.estado).toBe('confirmado');
    // al omitido NO se le envió ningún cambio: una sola llamada a setInicio
    expect(mockSetInicio).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('el instante enviado lleva offset explícito y segundos en 00 (R11 c4)', async () => {
    mockAuth.mockClear();
    mockAuth.mockImplementation(() => true);
    mockSetInicio.mockClear();
    mockSetInicio.mockResolvedValue({ estado: 'confirmado' });
    mockFetchObjeto.mockResolvedValue({
      objectId: SET_FRESCO,
      name: null,
      status: 'PAUSED',
      effectiveStatus: 'PAUSED',
      dailyBudget: null,
      lifetimeBudget: null,
    });

    const resp = await pedirSchedule({
      level: 'adset',
      accountId: CUENTA_S,
      action: 'schedule',
      objectIds: [SET_FRESCO],
      inicio: manana,
    });
    expect(resp.status).toBe(200);
    const enviado = mockSetInicio.mock.calls[0]![1]!;
    expect(enviado).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/);
    // y la fila local quedó con el inicio programado (R11 c7)
    const fila = await q<{ start_time: Date | null }>(
      `SELECT start_time FROM ad_sets WHERE adset_id = $1`,
      [SET_FRESCO],
    );
    expect(fila[0]!.start_time).not.toBeNull();
  }, 30_000);
});
