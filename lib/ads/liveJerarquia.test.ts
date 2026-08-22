import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { q } from '../db';
import { ensureFreshJerarquia } from './liveJerarquia';
import { sincronizarJerarquia, type ResultadoJerarquia } from './jerarquia';

/**
 * Tests de `ensureFreshJerarquia` (task 9.2): las cuatro defensas del sync de
 * Jerarquía en vivo — TTL propio (R4.2), presupuesto de espera (R4.3), no tirar
 * nunca (R4.4) y compartir el promise en vuelo por cuenta.
 *
 * QUÉ SE MOCKEA Y QUÉ NO
 * Sólo `sincronizarJerarquia`, para poder decidir por test si el sync resuelve
 * al instante, se cuelga o falla. La base es REAL: la frescura que devuelve el
 * módulo sale de `ad_accounts.last_hierarchy_sync_at` con una consulta de
 * verdad, y es justamente lo que hay que verificar — que la respuesta viene de
 * la columna y no del resultado del sync.
 *
 * Los tests que necesitan que el reloj avance usan un guión que escribe la
 * columna igual que `anotarCorrida`: no es un dato falso para que el test pase,
 * es el efecto que el sync real tiene sobre la base, aislado del viaje a Meta.
 *
 * CÓMO SE AÍSLA EL `Map` DE SYNCS EN VUELO DEL MÓDULO
 * `enVuelo` es estado a nivel de módulo y vive entre tests del mismo archivo. Un
 * sync colgado que quedara adentro haría que el test siguiente se colgara con
 * él, o peor, que pasara por el motivo equivocado. Dos defensas, no una:
 *
 *   1. CADA TEST USA SU PROPIA CUENTA (`sembrar` genera un id nuevo). El Map
 *      está indexado por cuenta, así que una entrada filtrada de un test no
 *      puede ser leída por el siguiente ni siquiera si sobrevive.
 *   2. EL `afterEach` SUELTA TODO SYNC COLGADO y espera un turno de macrotarea,
 *      que es lo que deja correr el `.finally` donde el módulo borra la entrada.
 *      Esperar el promise que devuelve `ensureFreshJerarquia` no alcanza: cuando
 *      gana el timeout, la función vuelve con el sync todavía corriendo.
 */

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

vi.mock('./jerarquia', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./jerarquia')>();
  return { ...actual, sincronizarJerarquia: vi.fn() };
});

const mockSync = vi.mocked(sincronizarJerarquia);

const OK: ResultadoJerarquia = { cuentas: [], corridaAt: '' };

const PREFIJO = `LIVEJ-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let contador = 0;

/** Qué hace el sync mockeado cuando lo llaman con esta cuenta. */
const guiones = new Map<string, () => Promise<ResultadoJerarquia>>();

/** Los syncs colgados de este test, para soltarlos en el `afterEach`. */
const colgados: Array<{ soltar: () => void }> = [];

const TTL_ORIGINAL = process.env.ADS_JERARQUIA_TTL_SECONDS;
const TIMEOUT_ORIGINAL = process.env.ADS_JERARQUIA_TIMEOUT_MS;

/**
 * Una cuenta nueva con el reloj de la Jerarquía puesto donde el test lo
 * necesita. `hace` es un intervalo de Postgres ('10 seconds', '20 minutes') o
 * null para una cuenta que nunca se sincronizó.
 */
async function sembrar(opts?: {
  hace?: string | null;
  error?: string | null;
  active?: boolean;
}): Promise<string> {
  const id = `${PREFIJO}-${++contador}`;
  await q(
    `INSERT INTO ad_accounts (account_id, platform, name, currency, active, timezone,
                              last_hierarchy_sync_at, last_hierarchy_sync_error)
     VALUES ($1, 'meta', 'test jerarquía en vivo', 'EUR', $2, 'Europe/Lisbon',
             CASE WHEN $3::text IS NULL THEN NULL ELSE now() - $3::interval END, $4)`,
    [id, opts?.active ?? true, opts?.hace ?? null, opts?.error ?? null],
  );
  return id;
}

/** El sync de esta cuenta resuelve al instante y no toca la base. */
function syncVacio(id: string): void {
  guiones.set(id, async () => OK);
}

/**
 * El sync de esta cuenta hace lo que hace `anotarCorrida`: avanza el reloj y
 * deja (o limpia) el error. Es el efecto real del sync sobre la base.
 */
function syncQueAnota(id: string, error: string | null = null): void {
  guiones.set(id, async () => {
    await q(
      `UPDATE ad_accounts
          SET last_hierarchy_sync_at = now(), last_hierarchy_sync_error = $2
        WHERE account_id = $1`,
      [id, error],
    );
    return OK;
  });
}

/** El sync de esta cuenta falla duro, antes de llegar a anotar nada. */
function syncQueFalla(id: string, msg: string): void {
  guiones.set(id, async () => {
    throw new Error(msg);
  });
}

/** El sync de esta cuenta no termina hasta que alguien lo suelta. */
function syncColgado(id: string): { soltar: () => void; termino: () => boolean } {
  let termino = false;
  let soltar!: () => void;
  const p = new Promise<ResultadoJerarquia>((resolve) => {
    soltar = () => {
      termino = true;
      resolve(OK);
    };
  });
  guiones.set(id, () => p);
  const handle = { soltar, termino: () => termino };
  colgados.push(handle);
  return handle;
}

beforeEach(() => {
  mockSync.mockReset();
  mockSync.mockImplementation(async (opts) => {
    const id = opts?.cuentas?.[0] ?? '';
    const guion = guiones.get(id);
    return guion ? guion() : OK;
  });
  // El módulo loguea el fallo duro con console.error. Se silencia acá y se
  // asserta donde corresponde, en lugar de ensuciar la salida de la suite.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  for (const c of colgados) c.soltar();
  colgados.length = 0;
  // El turno de macrotarea es lo que deja correr el `.then`/`.catch`/`.finally`
  // del módulo, y con él el `enVuelo.delete(accountId)`.
  await new Promise((r) => setTimeout(r, 10));
  guiones.clear();
  vi.mocked(console.error).mockRestore();

  if (process.env.ADS_JERARQUIA_TTL_SECONDS !== TTL_ORIGINAL) {
    if (TTL_ORIGINAL === undefined) delete process.env.ADS_JERARQUIA_TTL_SECONDS;
    else process.env.ADS_JERARQUIA_TTL_SECONDS = TTL_ORIGINAL;
  }
  if (process.env.ADS_JERARQUIA_TIMEOUT_MS !== TIMEOUT_ORIGINAL) {
    if (TIMEOUT_ORIGINAL === undefined) delete process.env.ADS_JERARQUIA_TIMEOUT_MS;
    else process.env.ADS_JERARQUIA_TIMEOUT_MS = TIMEOUT_ORIGINAL;
  }

  if (!dbAvailable) return;
  await q('DELETE FROM ad_accounts WHERE account_id LIKE $1', [`${PREFIJO}%`]);
});

describe.skipIf(!dbAvailable)('ensureFreshJerarquia: el freno propio (R4.2)', () => {
  it('con el reloj fresco no llama a Meta y avisa que no refrescó', async () => {
    const id = await sembrar({ hace: '10 seconds' });
    syncVacio(id);

    const r = await ensureFreshJerarquia(id);

    expect(mockSync).not.toHaveBeenCalled();
    expect(r.refreshed).toBe(false);
    expect(r.syncedAt).not.toBeNull();
    expect(r.ageSeconds).toBeGreaterThanOrEqual(9);
    expect(r.ageSeconds).toBeLessThan(60);
  });

  it('`forzar` saltea el TTL: la cuenta está fresca y el sync se dispara igual', async () => {
    const id = await sembrar({ hace: '10 seconds' });
    syncQueAnota(id);

    const r = await ensureFreshJerarquia(id, { forzar: true });

    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(mockSync).toHaveBeenCalledWith({ cuentas: [id] });
    expect(r.refreshed).toBe(true);
    expect(r.ageSeconds).toBeLessThanOrEqual(1); // el sync movió el reloj
  });

  it('con el reloj vencido dispara el sync sin que nadie fuerce nada', async () => {
    const id = await sembrar({ hace: '20 minutes' }); // el default son 300 s
    syncVacio(id);

    const r = await ensureFreshJerarquia(id);

    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(r.refreshed).toBe(true);
    // El guión no escribió nada, así que la edad es la que la base ya tenía:
    // la respuesta sale de la columna, no de haber llamado al sync.
    expect(r.ageSeconds).toBeGreaterThanOrEqual(1195);
  });

  it('`ADS_JERARQUIA_TTL_SECONDS` se lee en cada llamada, no al importar el módulo', async () => {
    const id = await sembrar({ hace: '60 seconds' });
    syncVacio(id);

    // Con el default de 300 s, 60 s es fresco.
    expect((await ensureFreshJerarquia(id)).refreshed).toBe(false);
    expect(mockSync).not.toHaveBeenCalled();

    // Bajar el freno alcanza para que la MISMA fila pase a estar vencida.
    process.env.ADS_JERARQUIA_TTL_SECONDS = '30';
    expect((await ensureFreshJerarquia(id)).refreshed).toBe(true);
    expect(mockSync).toHaveBeenCalledTimes(1);
  });

  it('una cuenta que nunca se sincronizó dispara el sync, y la respuesta trae el reloj que ese sync escribió', async () => {
    const id = await sembrar({ hace: null });
    syncQueAnota(id);

    const r = await ensureFreshJerarquia(id);

    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(r.refreshed).toBe(true);
    // Si la respuesta viniera de la lectura PREVIA a la carrera, esto seguiría
    // en null: es la prueba de que el módulo relee después de sincronizar.
    expect(r.syncedAt).not.toBeNull();
    expect(r.ageSeconds).toBeLessThanOrEqual(1);
    expect(r.error).toBeNull();
  });

  it('una cuenta inactiva se lee como nunca sincronizada, aunque tenga el reloj fresco', async () => {
    const id = await sembrar({ hace: '10 seconds', active: false });
    syncVacio(id);

    const r = await ensureFreshJerarquia(id);

    // Sin fila que leer no hay edad, así que el TTL no puede frenar nada.
    expect(r.syncedAt).toBeNull();
    expect(r.ageSeconds).toBeNull();
    expect(r.refreshed).toBe(true);
  });
});

describe.skipIf(!dbAvailable)('ensureFreshJerarquia: el presupuesto de espera (R4.3)', () => {
  it('si el sync no termina, vuelve con lo guardado sin esperarlo', async () => {
    const id = await sembrar({ hace: '20 minutes' });
    const colgado = syncColgado(id);

    const antes = Date.now();
    const r = await ensureFreshJerarquia(id, { timeoutMs: 60 });
    const tardo = Date.now() - antes;

    // La prueba de que no esperó: el sync todavía está corriendo.
    expect(colgado.termino()).toBe(false);
    expect(tardo).toBeLessThan(3_000);
    expect(r.refreshed).toBe(true);
    // Y lo que devuelve es lo que la base tiene, no lo que el sync iba a traer.
    expect(r.syncedAt).not.toBeNull();
    expect(r.ageSeconds).toBeGreaterThanOrEqual(1195);
  });

  it('`ADS_JERARQUIA_TIMEOUT_MS` fija el presupuesto cuando el llamador no lo pasa', async () => {
    const id = await sembrar({ hace: '20 minutes' });
    const colgado = syncColgado(id);
    process.env.ADS_JERARQUIA_TIMEOUT_MS = '60';

    const antes = Date.now();
    const r = await ensureFreshJerarquia(id);
    const tardo = Date.now() - antes;

    expect(colgado.termino()).toBe(false);
    expect(tardo).toBeLessThan(3_000);
    expect(r.refreshed).toBe(true);
  });
});

describe.skipIf(!dbAvailable)('ensureFreshJerarquia: no tira nunca (R4.4)', () => {
  it('un fallo duro del sync no propaga la excepción y la respuesta sigue siendo usable', async () => {
    const id = await sembrar({ hace: '20 minutes' });
    syncQueFalla(id, 'Meta no responde');

    const r = await ensureFreshJerarquia(id);

    expect(r.refreshed).toBe(true);
    expect(r.syncedAt).not.toBeNull();
    expect(typeof r.ageSeconds).toBe('number');
    // El fallo duro se cae ANTES de anotar, así que el reloj no se movió y la
    // columna de error sigue vacía: la señal en pantalla es la edad vieja.
    expect(r.ageSeconds).toBeGreaterThanOrEqual(1195);
    expect(r.error).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(id),
      'Meta no responde',
    );
  });

  it('el error que ve la pantalla sale de la columna de la base, no del resultado del sync', async () => {
    const id = await sembrar({ hace: '20 minutes', error: 'límite de la API alcanzado' });
    // El guión resuelve bien y sin errores en el resultado: si el módulo leyera
    // de ahí, este error se perdería.
    syncVacio(id);

    const conError = await ensureFreshJerarquia(id);
    expect(conError.error).toBe('límite de la API alcanzado');

    // Y una corrida que termina bien lo limpia, porque limpia la columna.
    syncQueAnota(id, null);
    const limpio = await ensureFreshJerarquia(id, { forzar: true });
    expect(limpio.error).toBeNull();
    expect(limpio.ageSeconds).toBeLessThanOrEqual(1);
  });
});

describe.skipIf(!dbAvailable)('ensureFreshJerarquia: el sync en vuelo es por cuenta', () => {
  it('dos llamadas simultáneas de la MISMA cuenta comparten un solo sync', async () => {
    const id = await sembrar({ hace: '20 minutes' });
    syncColgado(id);

    const [a, b] = await Promise.all([
      ensureFreshJerarquia(id, { forzar: true, timeoutMs: 60 }),
      ensureFreshJerarquia(id, { forzar: true, timeoutMs: 60 }),
    ]);

    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(mockSync).toHaveBeenCalledWith({ cuentas: [id] });
    expect(a.refreshed).toBe(true);
    expect(b.refreshed).toBe(true);
  });

  it('dos cuentas distintas disparan dos syncs y ninguna espera a la otra', async () => {
    const lenta = await sembrar({ hace: '20 minutes' });
    const rapida = await sembrar({ hace: '20 minutes' });
    const colgado = syncColgado(lenta);
    syncQueAnota(rapida);

    // La lenta arranca primero y queda en vuelo. Su timeout es corto para que el
    // test no tenga que esperarla.
    const enCurso = ensureFreshJerarquia(lenta, { forzar: true, timeoutMs: 200 });
    await vi.waitFor(() => expect(mockSync).toHaveBeenCalledTimes(1));

    // Presupuesto de espera enorme a propósito: si la rápida se colgara del
    // promise de la lenta, esta llamada tendría que agotar los 30 s.
    const antes = Date.now();
    const r = await ensureFreshJerarquia(rapida, { forzar: true, timeoutMs: 30_000 });
    const tardo = Date.now() - antes;

    expect(tardo).toBeLessThan(5_000);
    expect(colgado.termino()).toBe(false); // la lenta sigue colgada
    expect(r.refreshed).toBe(true);
    expect(r.ageSeconds).toBeLessThanOrEqual(1); // trajo LO SUYO, no lo de la otra

    expect(mockSync).toHaveBeenCalledTimes(2);
    expect(mockSync).toHaveBeenCalledWith({ cuentas: [lenta] });
    expect(mockSync).toHaveBeenCalledWith({ cuentas: [rapida] });

    await expect(enCurso).resolves.toMatchObject({ refreshed: true });
  });
});
