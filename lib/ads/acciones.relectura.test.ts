import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { q, q1 } from '../db';
import { fetchObjeto } from './meta';
import {
  decidioConMeta,
  preflight,
  PRESUPUESTO_RELECTURA_MS,
  TOPE_RELECTURA,
  type RelecturaPreflight,
} from './acciones';

/**
 * Relectura selectiva contra Meta en el preflight (task 14.1, R6.2 y R6.3).
 *
 * LO QUE ESTOS TESTS DEFIENDEN. El preflight decide la Omisión
 * `ya_esta_en_ese_estado` con la copia local de la Jerarquía, y en producción esa
 * copia tiene objetos con hasta 5 días y 17 horas de atraso. El caso que hace
 * ver el interruptor como roto es exactamente éste: la base dice PAUSED, Meta
 * dice ACTIVE, el panel contesta "ya está en ese estado" y no llama a nadie.
 * Lo que se verifica acá es que el estado real gane, que el rastro quede, y que
 * cuando la relectura no se puede hacer la acción siga adelante con el dato de
 * la base en lugar de bloquearse.
 *
 * NECESITAN POSTGRES: `leerObjetos` es SQL contra las tres tablas de la
 * Jerarquía con el JOIN a `ad_accounts`, y el umbral sale de `settings`. Sin
 * `DATABASE_URL` el archivo se saltea, como el resto de la suite.
 *
 * `lib/ads/meta` se mockea completo salvo `fetchObjeto` y
 * `fetchMinimoPresupuesto`: "qué contestó Meta en la relectura" es la variable
 * independiente de todos estos casos y ninguno toca la red.
 *
 * TODO CUELGA DE UNA CUENTA CON ID ÚNICO POR CORRIDA: las PK de `ad_campaigns` y
 * `ad_sets` son globales, no por cuenta, así que una corrida que se cayó a mitad
 * no puede dejar filas que choquen con la siguiente.
 *
 * LOS DOS SETTINGS GLOBALES QUE ESTE ARCHIVO TOCA (`ads_frescura_umbral_segundos`
 * y `ads_backoff_until`) se guardan y se restauran: son por app, no por cuenta, y
 * dejarlos movidos rompería a otros archivos de la suite.
 */

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

vi.mock('./meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./meta')>();
  return { ...actual, fetchObjeto: vi.fn(), fetchMinimoPresupuesto: vi.fn().mockResolvedValue(null) };
});

const mockFetchObjeto = vi.mocked(fetchObjeto);

const CUENTA = `REL-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const id = (sufijo: string): string => `${CUENTA}-${sufijo}`;
const CAMP = id('C1');

const UMBRAL = 900;
/** Más allá del umbral por dos órdenes de magnitud: es el caso de producción. */
const VIEJO = new Date(Date.now() - 48 * 3600_000);
const FRESCO = new Date(Date.now() - 60_000);

// Un conjunto por caso, para que ninguno dependa del estado que dejó el anterior.
const SET_DISCREPA = id('S-discrepa');
const SET_COINCIDE = id('S-coincide');
const SET_FRESCO = id('S-fresco');
const SET_ERROR = id('S-error');
const SET_NULO = id('S-nulo');
const SET_MARCADO = id('S-marcado');
const SET_BACKOFF = id('S-backoff');
/** Los del tope: TOPE_RELECTURA + 2 conjuntos viejos en un solo lote. */
const SETS_TOPE = Array.from({ length: TOPE_RELECTURA + 2 }, (_, i) => id(`S-tope-${i}`));

const leido = (objectId: string, status: string, effectiveStatus = status) => ({
  objectId,
  name: null,
  status,
  effectiveStatus,
  dailyBudget: null,
  lifetimeBudget: null,
});

/** El preflight de una acción de estado sobre un solo conjunto. */
async function pf(accion: 'pause' | 'activate' | 'budget_set', objectIds: string[]) {
  const r = await preflight({ level: 'adset', accountId: CUENTA, accion, objectIds });
  if (!r.ok) throw new Error(`el preflight rechazó el lote: ${r.error.motivo} — ${r.error.detalle}`);
  return r;
}

function relectura(
  r: { relecturas: Map<string, RelecturaPreflight> },
  objectId: string,
): RelecturaPreflight {
  const x = r.relecturas.get(objectId);
  if (!x) throw new Error(`no hay rastro de relectura para ${objectId}`);
  return x;
}

let umbralOriginal: unknown;
let backoffOriginal: unknown;

describe.skipIf(!dbAvailable)('preflight — relectura selectiva contra Meta (R6.2, R6.3)', () => {
  beforeAll(async () => {
    const previos = await q<{ key: string; value: unknown }>(
      `SELECT key, value FROM settings WHERE key IN ('ads_frescura_umbral_segundos', 'ads_backoff_until')`,
    );
    const m = new Map(previos.map((f) => [f.key, f.value]));
    umbralOriginal = m.get('ads_frescura_umbral_segundos') ?? UMBRAL;
    backoffOriginal = m.get('ads_backoff_until') ?? '';

    await q(
      `INSERT INTO ad_accounts (account_id, platform, name, currency, timezone, active)
       VALUES ($1, 'meta', 'cuenta de relectura', 'EUR', 'Europe/Lisbon', true)
       ON CONFLICT (account_id) DO UPDATE SET active = true, currency = 'EUR'`,
      [CUENTA],
    );
    await q(
      `INSERT INTO ad_campaigns (campaign_id, account_id, name, status, effective_status,
                                 budget_level, currency, synced_at)
       VALUES ($1, $2, 'campaña de relectura', 'ACTIVE', 'ACTIVE', 'adset', 'EUR', $3::timestamptz)`,
      [CAMP, CUENTA, VIEJO.toISOString()],
    );

    // Los conjuntos: todos PAUSED en la base. Con ese dato, `pause` se omite por
    // `ya_esta_en_ese_estado` — que es justamente la decisión que la relectura
    // tiene que poder cambiar.
    const viejos = [SET_DISCREPA, SET_COINCIDE, SET_ERROR, SET_NULO, SET_BACKOFF, ...SETS_TOPE];
    await q(
      `INSERT INTO ad_sets (adset_id, campaign_id, account_id, name, status, effective_status,
                            currency, synced_at)
       SELECT sid, $2, $1, 'S ' || sid, 'PAUSED', 'PAUSED', 'EUR', $4::timestamptz
         FROM unnest($3::text[]) AS sid`,
      [CUENTA, CAMP, viejos, VIEJO.toISOString()],
    );
    // El fresco: mismo estado, dato de hace un minuto.
    await q(
      `INSERT INTO ad_sets (adset_id, campaign_id, account_id, name, status, effective_status,
                            currency, synced_at)
       VALUES ($1, $2, $3, 'S fresco', 'PAUSED', 'PAUSED', 'EUR', $4::timestamptz)`,
      [SET_FRESCO, CAMP, CUENTA, FRESCO.toISOString()],
    );
    // El marcado: dato FRESCO pero con la marca de desaparición. Entra a la
    // relectura por la marca, no por la edad: si sólo se mirara `synced_at`,
    // este objeto pasaría de largo.
    await q(
      `INSERT INTO ad_sets (adset_id, campaign_id, account_id, name, status, effective_status,
                            currency, synced_at, desaparecido_at)
       VALUES ($1, $2, $3, 'S marcado', 'PAUSED', 'PAUSED', 'EUR', $4::timestamptz, now())`,
      [SET_MARCADO, CAMP, CUENTA, FRESCO.toISOString()],
    );
  });

  afterAll(async () => {
    await q(`DELETE FROM ad_sets WHERE account_id = $1`, [CUENTA]);
    await q(`DELETE FROM ad_campaigns WHERE account_id = $1`, [CUENTA]);
    await q(`DELETE FROM ad_accounts WHERE account_id = $1`, [CUENTA]);
    await q(`UPDATE settings SET value = $1::jsonb WHERE key = 'ads_frescura_umbral_segundos'`, [
      JSON.stringify(umbralOriginal),
    ]);
    await q(`UPDATE settings SET value = $1::jsonb WHERE key = 'ads_backoff_until'`, [
      JSON.stringify(backoffOriginal),
    ]);
  });

  beforeEach(async () => {
    mockFetchObjeto.mockReset();
    await q(`UPDATE settings SET value = $1::jsonb WHERE key = 'ads_frescura_umbral_segundos'`, [
      String(UMBRAL),
    ]);
    await q(`UPDATE settings SET value = '""'::jsonb WHERE key = 'ads_backoff_until'`);
  });

  it('el estado real de Meta gana sobre el de la base y la acción NO se omite', async () => {
    // La base dice PAUSED (dato de hace 48 h); Meta dice ACTIVE. `pause` no se
    // puede omitir: el objeto está entregando.
    mockFetchObjeto.mockResolvedValue(leido(SET_DISCREPA, 'ACTIVE'));

    const r = await pf('pause', [SET_DISCREPA]);

    expect(mockFetchObjeto).toHaveBeenCalledTimes(1);
    expect(mockFetchObjeto).toHaveBeenCalledWith(SET_DISCREPA, 'adset');
    // La decisión: sin relectura esto sería 'ya_esta_en_ese_estado'.
    expect(r.previa.filas[0]!.motivo).toBeNull();
    expect(r.previa.filas[0]!.antes).toBe('ACTIVE');
    // El objeto que viaja al route lleva el estado real, así el `before_value`
    // de la auditoría no puede contradecir al `antes` del mensaje.
    expect(r.objetos[0]!.status).toBe('ACTIVE');
    expect(r.objetos[0]!.effectiveStatus).toBe('ACTIVE');

    const x = relectura(r, SET_DISCREPA);
    expect(x.resultado).toBe('discrepa');
    expect(x.causa).toBe('vieja');
    expect(x.local).toBe('PAUSED');
    expect(x.real).toBe('ACTIVE');
    expect(x.localEffective).toBe('PAUSED');
    expect(x.realEffective).toBe('ACTIVE');
    expect(x.syncedAt).toBe(VIEJO.toISOString());
    expect(x.edadSegundos).toBeGreaterThanOrEqual(48 * 3600 - 5);
    expect(decidioConMeta(x)).toBe(true);
  });

  it('cuando Meta confirma el estado de la base, la Omisión queda y se anota que se revalidó', async () => {
    mockFetchObjeto.mockResolvedValue(leido(SET_COINCIDE, 'PAUSED'));

    const r = await pf('pause', [SET_COINCIDE]);

    expect(mockFetchObjeto).toHaveBeenCalledTimes(1);
    expect(r.previa.filas[0]!.motivo).toBe('ya_esta_en_ese_estado');
    const x = relectura(r, SET_COINCIDE);
    expect(x.resultado).toBe('coincide');
    expect(x.local).toBe('PAUSED');
    expect(x.real).toBe('PAUSED');
    // La diferencia que 14.3 necesita: acá la omisión NO se decidió con un dato
    // de hace 48 h, se decidió con una lectura de ahora.
    expect(decidioConMeta(x)).toBe(true);
  });

  it('un dato dentro del umbral no se relee: cero llamadas y cero rastro', async () => {
    const r = await pf('pause', [SET_FRESCO]);

    expect(mockFetchObjeto).not.toHaveBeenCalled();
    expect(r.relecturas.size).toBe(0);
    expect(r.previa.filas[0]!.motivo).toBe('ya_esta_en_ese_estado');
    // La antigüedad para el mensaje de R6.1 sale de acá cuando no hubo relectura.
    expect(r.objetos[0]!.syncedAt).toBe(FRESCO.toISOString());
  });

  it('un Objeto_Desaparecido se relee aunque su dato esté fresco', async () => {
    mockFetchObjeto.mockResolvedValue(leido(SET_MARCADO, 'ACTIVE'));

    const r = await pf('pause', [SET_MARCADO]);

    expect(mockFetchObjeto).toHaveBeenCalledTimes(1);
    const x = relectura(r, SET_MARCADO);
    expect(x.causa).toBe('desaparecida');
    expect(x.resultado).toBe('discrepa');
    expect(r.previa.filas[0]!.motivo).toBeNull();
  });

  it('si fetchObjeto tira, se decide con la base y se anota, sin bloquear la acción', async () => {
    mockFetchObjeto.mockRejectedValue(new Error('(#17) User request limit reached'));

    const r = await pf('pause', [SET_ERROR]);

    // R6.2: no bloquea. El lote pasa el preflight igual.
    expect(r.previa.filas[0]!.motivo).toBe('ya_esta_en_ese_estado');
    expect(r.objetos[0]!.status).toBe('PAUSED');
    const x = relectura(r, SET_ERROR);
    expect(x.resultado).toBe('error');
    expect(x.real).toBeNull();
    expect(x.detalle).toContain('17');
    expect(decidioConMeta(x)).toBe(false);
  });

  it('si Meta no devuelve el objeto, queda no_encontrado y el estado local no se toca', async () => {
    mockFetchObjeto.mockResolvedValue(null);

    const r = await pf('pause', [SET_NULO]);

    expect(r.objetos[0]!.status).toBe('PAUSED');
    const x = relectura(r, SET_NULO);
    expect(x.resultado).toBe('no_encontrado');
    expect(x.real).toBeNull();
    expect(decidioConMeta(x)).toBe(false);
  });

  it(`un lote con más candidatos que el tope relee ${TOPE_RELECTURA} y anota el resto`, async () => {
    mockFetchObjeto.mockImplementation(async (objectId: string) => leido(objectId, 'ACTIVE'));

    const r = await pf('pause', SETS_TOPE);

    expect(mockFetchObjeto).toHaveBeenCalledTimes(TOPE_RELECTURA);
    expect(r.relecturas.size).toBe(SETS_TOPE.length);
    const releidos = SETS_TOPE.filter((s) => relectura(r, s).resultado === 'discrepa');
    const afuera = SETS_TOPE.filter((s) => relectura(r, s).resultado === 'no_intentada');
    expect(releidos).toHaveLength(TOPE_RELECTURA);
    expect(afuera).toHaveLength(2);
    // Los de afuera del tope se deciden con la base, que dice PAUSED → omitidos.
    for (const s of afuera) {
      expect(relectura(r, s).detalle).toContain(String(TOPE_RELECTURA));
      expect(r.previa.filas.find((f) => f.objectId === s)!.motivo).toBe('ya_esta_en_ese_estado');
    }
    // Y los releídos, con el estado real → ejecutables.
    for (const s of releidos) {
      expect(r.previa.filas.find((f) => f.objectId === s)!.motivo).toBeNull();
    }
  });

  it('con un backoff por cuota activo no se le suma ni una lectura a Meta', async () => {
    const hasta = new Date(Date.now() + 10 * 60_000).toISOString();
    await q(`UPDATE settings SET value = $1::jsonb WHERE key = 'ads_backoff_until'`, [
      JSON.stringify(hasta),
    ]);

    const r = await pf('activate', [SET_BACKOFF]);

    expect(mockFetchObjeto).not.toHaveBeenCalled();
    const x = relectura(r, SET_BACKOFF);
    expect(x.resultado).toBe('no_intentada');
    expect(x.detalle).toContain('backoff');
    expect(decidioConMeta(x)).toBe(false);
  });

  it('la relectura no aplica a las acciones que no son de estado', async () => {
    const r = await pf('budget_set', [SET_DISCREPA]);

    expect(mockFetchObjeto).not.toHaveBeenCalled();
    expect(r.relecturas.size).toBe(0);
  });

  it('el presupuesto de tiempo corta el lote sin dejar la lectura colgada', async () => {
    // Una lectura que nunca vuelve: la primera se come el presupuesto entero y
    // las demás quedan sin intentar. Sin el corte, esto serían 12 × 30 s.
    mockFetchObjeto.mockImplementation(() => new Promise(() => {}));

    const arranque = Date.now();
    const r = await pf('pause', SETS_TOPE);
    const tardo = Date.now() - arranque;

    expect(tardo).toBeLessThan(PRESUPUESTO_RELECTURA_MS + 2_000);
    const errores = SETS_TOPE.filter((s) => relectura(r, s).resultado === 'error');
    expect(errores).toHaveLength(1);
    expect(relectura(r, errores[0]!).detalle).toContain('presupuesto');
    // Todo el resto se decidió con la base, y el lote pasó el preflight.
    expect(r.relecturas.size).toBe(SETS_TOPE.length);
    for (const s of SETS_TOPE) expect(r.objetos.find((o) => o.objectId === s)!.status).toBe('PAUSED');
  });
});
