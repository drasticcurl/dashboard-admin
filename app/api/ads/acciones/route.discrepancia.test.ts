import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { q, q1 } from '../../../../lib/db';
import { POST } from './route';
import { enviar, fetchObjeto, setInicio, setNombre } from '../../../../lib/ads/meta';
import { isAuthenticated } from '../../../../lib/auth';

/**
 * El cableado de la task 14.2 en el route: la Discrepancia que el preflight
 * detectó tiene que llegar a `ad_actions.metrics` y a la `explicacion` (R6.3,
 * R6.5, Property 10).
 *
 * QUÉ DEFIENDE ESTE ARCHIVO Y NO LOS DE `lib/ads`. `acciones.relectura.test.ts`
 * prueba que el preflight relee y `acciones.discrepancia.test.ts` que las dos
 * funciones de 14.2 arman bien el jsonb y la frase. Ninguno de los dos prueba
 * que el route las LLAME: sin el cableado las dos funciones son correctas y la
 * fila de auditoría sale igual de vacía que antes. Lo que se verifica acá es el
 * viaje completo, leyendo `ad_actions` de la base después del pedido.
 *
 * LAS TRES RAMAS QUE IMPORTAN, y por qué cada una:
 *
 * 1. La Discrepancia con escritura. Meta desmiente a la base, la acción NO se
 *    omite y se escribe. El bloque `discrepancia` tiene que estar en la fila:
 *    es el registro de por qué el panel escribió sobre un objeto que su copia
 *    local decía que ya estaba en ese estado.
 * 2. La revalidación que coincide, con Omisión. Meta confirma el dato viejo y la
 *    acción se omite. La fila lleva `revalidacion` sin `discrepancia`, y —esto es
 *    lo que se rompe fácil— lo lleva DESPUÉS de `cerrarAccion(id, 'omitido')`,
 *    que no le pasa métricas nuevas. Es la razón por la que el jsonb va en
 *    `abrirAccion`: el dato con el que se decidió existe antes de la decisión.
 * 3. `budget_set`, que no relee. La fila no puede ganar ni una clave: la
 *    presencia del bloque es en sí misma la información «acá la copia local no
 *    alcanzaba», y ponerlo en todas las filas la borraría.
 *
 * Y las dos que confirman lo que la task daba por supuesto: `rename` y
 * `schedule` tampoco releen (`pf.relecturas` está vacío para ellas), así que sus
 * filas no ganan el bloque aunque el objeto esté viejo y marcado.
 *
 * A NIVEL `adset`: es el nivel donde vive el presupuesto en estas cuentas (ABO),
 * el único donde `schedule` es representable, y sirve para las tres acciones de
 * este archivo sin cambiar de objeto.
 *
 * NECESITA POSTGRES: todo lo que se afirma se lee de `ad_actions` y de `ad_sets`.
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
  };
});

const mockEnviar = vi.mocked(enviar);
const mockSetNombre = vi.mocked(setNombre);
const mockSetInicio = vi.mocked(setInicio);
const mockFetchObjeto = vi.mocked(fetchObjeto);
const mockAuth = vi.mocked(isAuthenticated);

const CUENTA = `T142-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/**
 * ids de 20 dígitos: el esquema cerrado exige `^\d{1,20}$` (R17 c3), así que acá
 * no sirve el truco de colgarlos del nombre de la cuenta que usan los tests del
 * preflight. Se arman con el reloj para que una corrida que se cayó a mitad no
 * choque con la siguiente: las PK de `ad_sets` son globales, no por cuenta.
 */
const RAIZ = `142${Date.now()}${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`;
const oid = (n: number): string => `${RAIZ}${String(n).padStart(2, '0')}`;

const CAMP = oid(0);
const S_DISCREPA = oid(1);
const S_COINCIDE = oid(2);
const S_BUDGET = oid(3);
const S_REN_OK = oid(4);
const S_REN_NULO = oid(5);
const S_PROG_OK = oid(6);
const S_PROG_NULO = oid(7);

/** Más allá de cualquier umbral razonable: es la edad del caso de producción. */
const VIEJO = new Date(Date.now() - 48 * 3600_000);

const leido = (objectId: string, over: Record<string, unknown> = {}) => ({
  objectId,
  name: null,
  status: 'PAUSED',
  effectiveStatus: 'PAUSED',
  dailyBudget: null,
  lifetimeBudget: null,
  ...over,
});

const pedir = (body: Record<string, unknown>): Promise<Response> =>
  POST(
    new Request('http://localhost/api/ads/acciones', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as never,
  );

type FilaAccion = {
  estado: string;
  explicacion: string | null;
  metrics: Record<string, unknown> | null;
};

/** La última fila de auditoría del objeto. Es la única fuente de verdad de este
 *  archivo: lo que la respuesta HTTP diga no prueba que se haya escrito. */
async function accion(objectId: string): Promise<FilaAccion> {
  const r = await q1<FilaAccion>(
    `SELECT estado, explicacion, metrics FROM ad_actions
      WHERE account_id = $1 AND object_id = $2 AND source = 'manual'
      ORDER BY id DESC LIMIT 1`,
    [CUENTA, objectId],
  );
  if (!r) throw new Error(`no hay fila de ad_actions para ${objectId}`);
  return r;
}

async function conjunto(
  adsetId: string,
): Promise<{ marca: string | null; sync: string; name: string | null }> {
  const r = await q1<{ marca: string | null; sync: string; name: string | null }>(
    `SELECT desaparecido_at::text AS marca, synced_at::text AS sync, name
       FROM ad_sets WHERE adset_id = $1`,
    [adsetId],
  );
  if (!r) throw new Error(`no hay conjunto ${adsetId}`);
  return r;
}

async function sembrar(): Promise<void> {
  await q(
    `INSERT INTO ad_accounts (account_id, platform, name, currency, active, timezone)
     VALUES ($1, 'meta', 'test T14.2', 'EUR', true, 'Europe/Lisbon')
     ON CONFLICT (account_id) DO UPDATE SET active = true, currency = 'EUR'`,
    [CUENTA],
  );
  // ABO: el presupuesto vive en el conjunto, como en las dos cuentas reales.
  await q(
    `INSERT INTO ad_campaigns (campaign_id, account_id, name, status, effective_status,
                               budget_level, currency, synced_at)
     VALUES ($1, $2, 'Campaña T14.2', 'ACTIVE', 'ACTIVE', 'adset', 'EUR', $3::timestamptz)`,
    [CAMP, CUENTA, VIEJO.toISOString()],
  );
  // Todos PAUSED y con el dato viejo: con esa copia local, `pause` se omite por
  // `ya_esta_en_ese_estado`, que es la decisión que la relectura puede cambiar.
  await q(
    `INSERT INTO ad_sets (adset_id, campaign_id, account_id, name, status, effective_status,
                          currency, daily_budget, synced_at, desaparecido_at) VALUES
       ($1, $8, $9, 'Conjunto que discrepa', 'PAUSED', 'PAUSED', 'EUR', NULL,  $10, NULL),
       ($2, $8, $9, 'Conjunto que coincide', 'PAUSED', 'PAUSED', 'EUR', NULL,  $10, NULL),
       ($3, $8, $9, 'Conjunto con presupuesto', 'PAUSED', 'PAUSED', 'EUR', 500, $10, NULL),
       ($4, $8, $9, 'Conjunto a renombrar', 'PAUSED', 'PAUSED', 'EUR', NULL,   $10, $11),
       ($5, $8, $9, 'Conjunto sin verificar', 'PAUSED', 'PAUSED', 'EUR', NULL, $10, $11),
       ($6, $8, $9, 'Conjunto a programar', 'PAUSED', 'PAUSED', 'EUR', NULL,   $10, $11),
       ($7, $8, $9, 'Conjunto sin programar', 'PAUSED', 'PAUSED', 'EUR', NULL, $10, $11)`,
    [
      S_DISCREPA,
      S_COINCIDE,
      S_BUDGET,
      S_REN_OK,
      S_REN_NULO,
      S_PROG_OK,
      S_PROG_NULO,
      CAMP,
      CUENTA,
      VIEJO.toISOString(),
      new Date(Date.now() - 24 * 3600_000).toISOString(),
    ],
  );
}

beforeAll(async () => {
  if (!dbAvailable) return;
  await sembrar();
});

afterAll(async () => {
  if (!dbAvailable) return;
  await q('DELETE FROM ad_actions WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_sets WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_campaigns WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_accounts WHERE account_id = $1', [CUENTA]);
});

beforeEach(async () => {
  if (!dbAvailable) return;
  mockAuth.mockImplementation(() => true);
  mockEnviar.mockReset();
  mockSetNombre.mockReset();
  mockSetInicio.mockReset();
  mockFetchObjeto.mockReset();
  // Con un backoff por cuota activo la relectura no se intenta y estos tests
  // medirían otra cosa. Es un setting por app: cualquier archivo de la suite
  // pudo dejarlo puesto.
  await q(`UPDATE settings SET value = '""'::jsonb WHERE key = 'ads_backoff_until'`);
});

describe.skipIf(!dbAvailable)('la Discrepancia llega a ad_actions (T14.2, R6.3, R6.5)', () => {
  it('una Discrepancia queda en metrics y nombrada en la explicacion, y la acción se escribe', async () => {
    // La base dice PAUSED con un dato de 48 h; Meta dice ACTIVE. `pause` no se
    // puede omitir y la fila tiene que contar por qué.
    mockFetchObjeto.mockResolvedValue(leido(S_DISCREPA, { status: 'ACTIVE', effectiveStatus: 'ACTIVE' }));
    mockEnviar.mockResolvedValue({ estado: 'confirmado' });

    const resp = await pedir({
      level: 'adset',
      accountId: CUENTA,
      action: 'pause',
      objectIds: [S_DISCREPA],
    });
    expect(resp.status).toBe(200);
    const cuerpo = (await resp.json()) as { resultados: { estado: string }[] };
    expect(cuerpo.resultados[0]?.estado).toBe('confirmado');
    // Lo que prueba que la relectura decidió: sin ella esto no llamaba a Meta.
    expect(mockEnviar).toHaveBeenCalledWith(S_DISCREPA, { status: 'PAUSED' });

    const fila = await accion(S_DISCREPA);
    expect(fila.estado).toBe('confirmado');

    const m = fila.metrics as {
      revalidacion?: Record<string, unknown>;
      discrepancia?: Record<string, unknown>;
    };
    expect(m.discrepancia).toEqual({
      local: 'PAUSED',
      real: 'ACTIVE',
      localEffective: 'PAUSED',
      realEffective: 'ACTIVE',
      syncedAt: VIEJO.toISOString(),
    });
    expect(m.revalidacion).toMatchObject({
      resultado: 'discrepa',
      causa: 'vieja',
      decidioConMeta: true,
      syncedAt: VIEJO.toISOString(),
    });
    expect(m.revalidacion!.edadSegundos as number).toBeGreaterThan(47 * 3600);

    // R6.3 pide NOMBRARLA, no sólo guardarla: el renglón en castellano es lo que
    // se lee en el historial.
    expect(fila.explicacion).toContain('discrepancia');
    expect(fila.explicacion).toContain('Meta decía ACTIVE y la base PAUSED');
    // Y sigue siendo la frase de la acción, no sólo el agregado.
    expect(fila.explicacion).toContain('se pausó el conjunto');
  });

  it('una revalidación que coincide deja el rastro en una fila OMITIDA: el cierre no lo borra', async () => {
    // Meta confirma el dato viejo, así que la Omisión es correcta. Lo que este
    // caso fija es que la fila igual cuente que se decidió contra Meta: sin la
    // anotación, esta fila es idéntica a la de una decidida con un dato de cinco
    // días, y la pregunta «¿el botón está roto o el dato estaba viejo?» vuelve a
    // quedar sin respuesta.
    mockFetchObjeto.mockResolvedValue(leido(S_COINCIDE));

    const resp = await pedir({
      level: 'adset',
      accountId: CUENTA,
      action: 'pause',
      objectIds: [S_COINCIDE],
    });
    expect(resp.status).toBe(200);
    const cuerpo = (await resp.json()) as { resultados: { estado: string; motivo?: string }[] };
    expect(cuerpo.resultados[0]?.estado).toBe('omitido');
    expect(cuerpo.resultados[0]?.motivo).toBe('ya_esta_en_ese_estado');
    // R6.5: la Omisión no llamó a Meta para escribir.
    expect(mockEnviar).not.toHaveBeenCalled();

    const fila = await accion(S_COINCIDE);
    expect(fila.estado).toBe('omitido');

    // El jsonb sobrevivió al UPDATE del cierre, que no le pasa métricas nuevas.
    // Es la razón de poner las métricas en `abrirAccion`: el dato con el que se
    // decidió existe antes de la decisión, así que la fila lo lleva aunque el
    // proceso se muera entre el INSERT y el UPDATE.
    const m = fila.metrics as {
      revalidacion?: Record<string, unknown>;
      discrepancia?: Record<string, unknown>;
    };
    expect(m.revalidacion).toMatchObject({ resultado: 'coincide', decidioConMeta: true });
    expect(m.discrepancia).toBeUndefined();
    expect(fila.explicacion).toContain('revalidado contra Meta');
  });

  it('budget_set no relee y su fila no gana ni una clave', async () => {
    // El objeto está igual de viejo que los otros dos, pero la relectura corre
    // sólo para `pause` y `activate`: acá `pf.relecturas` está vacío y las dos
    // funciones de 14.2 son no-ops. La fila tiene que quedar como antes de la
    // task, con el `extra` del importe intacto.
    mockFetchObjeto.mockResolvedValue(leido(S_BUDGET, { dailyBudget: 800 }));
    mockEnviar.mockResolvedValue({ estado: 'confirmado' });

    const resp = await pedir({
      level: 'adset',
      accountId: CUENTA,
      action: 'budget_set',
      objectIds: [S_BUDGET],
      budgetEur: 8,
    });
    expect(resp.status).toBe(200);

    const fila = await accion(S_BUDGET);
    expect(fila.estado).toBe('confirmado');
    expect(fila.metrics).toEqual({});
    // El `extra` de `budget_set` sigue siendo la transición de importes.
    expect(fila.explicacion).toContain('→');
    expect(fila.explicacion).toContain('se fijó el presupuesto diario del conjunto');
    expect(fila.explicacion).not.toContain('revalid');
  });
});

describe.skipIf(!dbAvailable)('rename y schedule: sin relectura, y la marca de desaparición (T16, R3.6, R4.7)', () => {
  it('rename no gana el bloque de revalidación y, con la relectura que trae la fila, limpia la marca', async () => {
    mockSetNombre.mockResolvedValue({ estado: 'confirmado' });
    mockFetchObjeto.mockResolvedValue(leido(S_REN_OK, { name: 'Conjunto renombrado T14.2' }));

    const antes = await conjunto(S_REN_OK);
    expect(antes.marca).not.toBeNull();

    const resp = await pedir({
      level: 'adset',
      accountId: CUENTA,
      action: 'rename',
      objectIds: [S_REN_OK],
      modo: { tipo: 'exacto', nombre: 'Conjunto renombrado T14.2' },
    });
    expect(resp.status).toBe(200);
    const cuerpo = (await resp.json()) as { resultados: { estado: string }[] };
    expect(cuerpo.resultados[0]?.estado).toBe('confirmado');

    // Lo que esta task daba por supuesto y acá queda confirmado: `pf.relecturas`
    // está vacío para `rename`, así que la fila no gana el bloque.
    const fila = await accion(S_REN_OK);
    expect(fila.metrics).toEqual({});
    expect(fila.explicacion).not.toContain('revalid');

    // La extensión de T16: escritura confirmada + relectura que trajo la fila es
    // la misma evidencia con la que `refrescarJerarquia` limpia la marca.
    const despues = await conjunto(S_REN_OK);
    expect(despues.name).toBe('Conjunto renombrado T14.2');
    expect(despues.marca).toBeNull();
    expect(new Date(despues.sync).getTime()).toBeGreaterThan(new Date(antes.sync).getTime());
  });

  it('rename cuya relectura no trae nombre deja la marca y el synced_at viejo intactos', async () => {
    mockSetNombre.mockResolvedValue({ estado: 'confirmado' });
    mockFetchObjeto.mockResolvedValue(null); // Meta no devolvió el objeto

    const antes = await conjunto(S_REN_NULO);
    expect(antes.marca).not.toBeNull();

    const resp = await pedir({
      level: 'adset',
      accountId: CUENTA,
      action: 'rename',
      objectIds: [S_REN_NULO],
      modo: { tipo: 'exacto', nombre: 'Nombre que no se verifica' },
    });
    expect(resp.status).toBe(200);

    // «Meta no nos dio el objeto» es la evidencia con la que el sync PONE la
    // marca: borrarla acá la contradiría en lugar de corregirla.
    const despues = await conjunto(S_REN_NULO);
    expect(despues.marca).toBe(antes.marca);
    expect(despues.sync).toBe(antes.sync);
    expect(despues.name).toBe(antes.name);
  });

  it('schedule no gana el bloque de revalidación y, con la relectura que trae la fila, limpia la marca', async () => {
    mockSetInicio.mockResolvedValue({ estado: 'confirmado' });
    mockFetchObjeto.mockResolvedValue(leido(S_PROG_OK));

    const antes = await conjunto(S_PROG_OK);
    expect(antes.marca).not.toBeNull();

    const resp = await pedir({
      level: 'adset',
      accountId: CUENTA,
      action: 'schedule',
      objectIds: [S_PROG_OK],
      inicio: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    expect(resp.status).toBe(200);
    const cuerpo = (await resp.json()) as { resultados: { estado: string }[] };
    expect(cuerpo.resultados[0]?.estado).toBe('confirmado');

    // `pf.relecturas` vacío también para `schedule`: la fila conserva sus propias
    // métricas de inicio y ninguna de revalidación.
    const fila = await accion(S_PROG_OK);
    const m = fila.metrics as Record<string, unknown>;
    expect(m.revalidacion).toBeUndefined();
    expect(m.inicio_efectivo).toBeTypeOf('string');

    const despues = await conjunto(S_PROG_OK);
    expect(despues.marca).toBeNull();
    expect(new Date(despues.sync).getTime()).toBeGreaterThan(new Date(antes.sync).getTime());
  });

  it('schedule cuya relectura no trae nada deja la marca y el synced_at viejo intactos', async () => {
    mockSetInicio.mockResolvedValue({ estado: 'confirmado' });
    mockFetchObjeto.mockResolvedValue(null);

    const antes = await conjunto(S_PROG_NULO);
    expect(antes.marca).not.toBeNull();

    const resp = await pedir({
      level: 'adset',
      accountId: CUENTA,
      action: 'schedule',
      objectIds: [S_PROG_NULO],
      inicio: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    expect(resp.status).toBe(200);

    const despues = await conjunto(S_PROG_NULO);
    expect(despues.marca).toBe(antes.marca);
    expect(despues.sync).toBe(antes.sync);
  });
});
