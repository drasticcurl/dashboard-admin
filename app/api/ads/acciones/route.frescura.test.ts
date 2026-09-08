import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { q, q1 } from '../../../../lib/db';
import { POST } from './route';
import { enviar, fetchObjeto } from '../../../../lib/ads/meta';
import { isAuthenticated } from '../../../../lib/auth';
import { esperarRefrescosPendientes } from './_diferir';

/**
 * Task 16 de frescura-y-acciones-anuncios (R3.6, R4.7): `refrescarJerarquia`
 * limpia `desaparecido_at` después de una escritura confirmada.
 *
 * Los dos casos que fijan la regla son las dos ramas de la relectura, no el
 * nivel ni la acción:
 *
 * 1. La relectura TRAJO la fila. Meta confirmó la escritura y además devuelve el
 *    objeto: existe, así que la marca se va.
 * 2. La relectura NO trajo nada. Es la misma evidencia con la que la
 *    Sync_Jerarquia PONE la marca (Meta no devolvió el objeto), así que borrarla
 *    ahí la contradiría. La marca y el `synced_at` viejo quedan como estaban, que
 *    es lo que hace que la fila se siga viendo vieja en la tabla.
 *
 * A nivel campaña porque es el único nivel que hoy se puede ejercitar de punta a
 * punta: `leerObjetos` selecciona `o.daily_budget` de la tabla del nivel y `ads`
 * no tiene esa columna, así que un pause/activate a nivel `ad` corta en el
 * preflight antes de llegar acá. La rama `ad` de `refrescarJerarquia` escribe la
 * misma columna con el mismo literal.
 *
 * ## EL ÚNICO CAMBIO DE LA TASK 14.2: `await esperarRefrescosPendientes()`
 *
 * Desde la tanda C de `toggle-conjuntos-entrega`, `refrescarJerarquia` corre
 * DIFERIDA: la respuesta sale sin esperarla. Este archivo mira la base después de
 * la respuesta, así que sin la espera estaría corriendo una carrera contra el
 * refresco —y se corrió: pasó igual, o sea que la habría ganado casi siempre y
 * habría fallado en la máquina cargada del día—. Con `esperarRefrescosPendientes`
 * la espera es exacta y no hay ninguna gracia de reloj que invalidar.
 *
 * **Ninguna aserción de este archivo cambió**, y eso es lo que verifica la task
 * 14.5: en particular el caso 2 sigue afirmando que `marca` y `sync` quedan
 * intactos, que es lo que prueba que la Escritura_Confirmada_Local escribió
 * `status` y nada más.
 */

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

vi.mock('../../../../lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/auth')>();
  return { ...actual, isAuthenticated: vi.fn(() => true), getClientIp: () => 'test-ip' };
});

// `guard()` delega en `guardSeccion` de lib/permisos (T03), que ya no lee
// `isAuthenticated`: consulta la base a través de una sesión real. Este test
// no ejercita el 401, así que el mock siempre deja pasar con sesión admin.
vi.mock('../../../../lib/permisos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/permisos')>();
  return {
    ...actual,
    guardSeccion: vi.fn(async () => ({
      sesion: {
        usuarioId: 1,
        usuario: 'test',
        nombre: 'Test',
        esAdmin: true,
        debeCambiarClave: false,
        secciones: actual.SECCIONES,
        esFallback: false,
      },
    })),
  };
});

vi.mock('../../../../lib/ads/meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/ads/meta')>();
  return {
    ...actual,
    enviar: vi.fn(),
    fetchObjeto: vi.fn(),
    fetchMinimoPresupuesto: vi.fn().mockResolvedValue(null),
  };
});

const mockEnviar = vi.mocked(enviar);
const mockFetchObjeto = vi.mocked(fetchObjeto);
const mockAuth = vi.mocked(isAuthenticated);

const CUENTA = `T16-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
// ids de 20 dígitos: el esquema cerrado exige ^\d{1,20}$ (R17 c3)
const CAMP_VUELVE = '19160000000000000001';
const CAMP_AUSENTE = '19160000000000000002';

/** Sembrada vieja Y marcada: el caso que la task viene a resolver es justamente
 *  el del objeto que el sync dejó de ver pero que sigue aceptando escrituras. */
async function sembrar(): Promise<void> {
  await q(
    `INSERT INTO ad_accounts (account_id, platform, name, currency, active, timezone)
     VALUES ($1, 'meta', 'test T16', 'EUR', true, 'Europe/Lisbon')
     ON CONFLICT (account_id) DO UPDATE SET active = true`,
    [CUENTA],
  );
  await q(
    `INSERT INTO ad_campaigns (campaign_id, account_id, name, status, effective_status,
                               budget_level, currency, synced_at, desaparecido_at) VALUES
       ($1, $3, 'Campaña que vuelve', 'ACTIVE', 'ACTIVE', 'adset', 'EUR',
        now() - interval '3 days', now() - interval '2 days'),
       ($2, $3, 'Campaña ausente', 'ACTIVE', 'ACTIVE', 'adset', 'EUR',
        now() - interval '3 days', now() - interval '2 days')
     ON CONFLICT (campaign_id) DO UPDATE
       SET status = 'ACTIVE', effective_status = 'ACTIVE',
           synced_at = now() - interval '3 days',
           desaparecido_at = now() - interval '2 days'`,
    [CAMP_VUELVE, CAMP_AUSENTE, CUENTA],
  );
  // El backoff por cuota rechaza el pedido antes del preflight: se limpia acá
  // para que un archivo anterior de la suite no decida el resultado de este.
  await q(
    `UPDATE settings SET value = '""'::jsonb WHERE key IN ('ads_backoff_until', 'ads_backoff_reason')`,
  );
}

/** La marca, el reloj y el estado como texto: la comparación entre el antes y el
 *  después es por igualdad exacta y el texto de un timestamptz no pierde
 *  microsegundos por el camino. */
async function fila(
  campaignId: string,
): Promise<{ marca: string | null; sync: string; status: string | null } | null> {
  return await q1<{ marca: string | null; sync: string; status: string | null }>(
    `SELECT desaparecido_at::text AS marca, synced_at::text AS sync, status
       FROM ad_campaigns WHERE campaign_id = $1`,
    [campaignId],
  );
}

const pedir = (body: Record<string, unknown>): Promise<Response> =>
  POST(
    new Request('http://localhost/api/ads/acciones', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
  );

beforeAll(async () => {
  if (!dbAvailable) return;
  await sembrar();
});

afterAll(async () => {
  if (!dbAvailable) return;
  await q('DELETE FROM ad_actions WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_campaigns WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_accounts WHERE account_id = $1', [CUENTA]);
});

describe.skipIf(!dbAvailable)('refrescarJerarquia y la marca de desaparición (T16, R3.6, R4.7)', () => {
  it('una escritura confirmada cuya relectura trae la fila limpia la marca y adelanta el reloj', async () => {
    mockAuth.mockImplementation(() => true);
    mockEnviar.mockClear();
    mockEnviar.mockResolvedValue({ estado: 'confirmado' });
    // La relectura devuelve el MISMO estado con el que la fila está sembrada, que
    // es el que hace necesaria la acción: así ninguna versión del preflight puede
    // omitir el pedido y el test mide sólo lo que la task cambió.
    mockFetchObjeto.mockResolvedValue({
      objectId: CAMP_VUELVE,
      name: 'Campaña que vuelve',
      status: 'ACTIVE',
      effectiveStatus: 'ACTIVE',
      dailyBudget: null,
      lifetimeBudget: null,
    });

    const antes = await fila(CAMP_VUELVE);
    expect(antes?.marca).not.toBeNull();

    const resp = await pedir({
      level: 'campaign',
      accountId: CUENTA,
      action: 'pause',
      objectIds: [CAMP_VUELVE],
    });
    expect(resp.status).toBe(200);
    const cuerpo = (await resp.json()) as { resultados: { estado: string }[] };
    expect(cuerpo.resultados[0]?.estado).toBe('confirmado');

    await esperarRefrescosPendientes();
    const despues = await fila(CAMP_VUELVE);
    expect(despues?.marca).toBeNull();
    expect(despues?.status).toBe('ACTIVE'); // lo que devolvió la relectura
    expect(new Date(despues!.sync).getTime()).toBeGreaterThan(new Date(antes!.sync).getTime());
  });

  it('una relectura que no trae nada deja la marca y el synced_at viejo intactos', async () => {
    mockAuth.mockImplementation(() => true);
    mockEnviar.mockClear();
    mockEnviar.mockResolvedValue({ estado: 'confirmado' });
    mockFetchObjeto.mockResolvedValue(null); // Meta no devolvió el objeto

    const antes = await fila(CAMP_AUSENTE);
    expect(antes?.marca).not.toBeNull();

    const resp = await pedir({
      level: 'campaign',
      accountId: CUENTA,
      action: 'pause',
      objectIds: [CAMP_AUSENTE],
    });
    expect(resp.status).toBe(200);
    const cuerpo = (await resp.json()) as { resultados: { estado: string }[] };
    expect(cuerpo.resultados[0]?.estado).toBe('confirmado');

    await esperarRefrescosPendientes();
    const despues = await fila(CAMP_AUSENTE);
    expect(despues?.marca).toBe(antes?.marca);
    expect(despues?.sync).toBe(antes?.sync);
  });
});
