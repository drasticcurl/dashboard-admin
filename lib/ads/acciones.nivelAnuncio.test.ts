import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { q } from '../db';
import { fetchObjeto } from './meta';
import { edadDelDatoDeOmision, preflight } from './acciones';

/**
 * El preflight a nivel ANUNCIO (R2.1, R2.2, y el desbloqueo de R6.1 en ese
 * nivel).
 *
 * EL BUG QUE ESTE ARCHIVO FIJA. `leerObjetos` armaba su SELECT con
 * `o.daily_budget` y `o.lifetime_budget` sin condicionar por nivel, pero la tabla
 * `ads` no tiene esas columnas: la migración 016 la creó sin ellas —y lo dice en
 * un comentario, porque en Meta el presupuesto vive en la campaña (CBO) o en el
 * conjunto (ABO), nunca en el anuncio— y la 025 sólo le agregó `desaparecido_at`.
 * Verificado contra la base: `SELECT o.daily_budget FROM ads o` devuelve
 * `column o.daily_budget does not exist`.
 *
 * La consecuencia era que TODA acción de estado a nivel anuncio moría adentro del
 * preflight, antes de llegar a Meta y antes de abrir la fila de auditoría. O sea:
 * el interruptor de una fila de anuncio —la R2 que este spec vino a arreglar— no
 * fallaba por la lógica del toggle, fallaba porque el servidor no podía ni leer
 * el objeto. Ningún test lo tocaba porque los del preflight están todos a nivel
 * conjunto, que es donde vive el presupuesto.
 *
 * Con el arreglo (un NULL tipado por nivel, como los `budgetLevelSql` e
 * `inicioSql` que ya estaban al lado), el nivel `ad` queda accesible y con él la
 * rama `level === 'ad'` de `refrescarJerarquia` en el route de acciones —la de la
 * task 16, que no se podía probar de punta a punta por exactamente este motivo.
 *
 * NECESITA POSTGRES: lo que se verifica es el SQL. Sin `DATABASE_URL` el archivo
 * se saltea, como el resto de la suite. `lib/ads/meta` se mockea salvo
 * `fetchObjeto` y `fetchMinimoPresupuesto`, igual que en
 * `acciones.relectura.test.ts`: nada acá toca la red.
 *
 * Todo cuelga de una cuenta con id único por corrida (las PK de la Jerarquía son
 * globales, no por cuenta) y se borra al final.
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

const CUENTA = `AD-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const id = (sufijo: string): string => `${CUENTA}-${sufijo}`;
const CAMP = id('C1');
const SET = id('S1');

/** El anuncio del caso normal: activo y con un dato fresco. */
const AD_ACTIVO = id('A-activo');
/** Uno pausado, para la dirección inversa del interruptor. */
const AD_PAUSADO = id('A-pausado');
/** Uno con el dato más allá del umbral: entra a la relectura selectiva. */
const AD_VIEJO = id('A-viejo');

const FRESCO = new Date(Date.now() - 5 * 60_000);
const VIEJO = new Date(Date.now() - 48 * 3600_000);

async function pf(accion: 'pause' | 'activate', objectIds: string[]) {
  const r = await preflight({ level: 'ad', accountId: CUENTA, accion, objectIds });
  if (!r.ok) throw new Error(`el preflight rechazó el lote: ${r.error.motivo} — ${r.error.detalle}`);
  return r;
}

describe.skipIf(!dbAvailable)('preflight a nivel anuncio: los anuncios no tienen presupuesto', () => {
  beforeAll(async () => {
    await q(
      `INSERT INTO ad_accounts (account_id, platform, name, currency, timezone, active)
       VALUES ($1, 'meta', 'cuenta de anuncios', 'EUR', 'Europe/Lisbon', true)
       ON CONFLICT (account_id) DO UPDATE SET active = true, currency = 'EUR'`,
      [CUENTA],
    );
    await q(
      `INSERT INTO ad_campaigns (campaign_id, account_id, name, status, effective_status,
                                 budget_level, currency, synced_at)
       VALUES ($1, $2, 'campaña de anuncios', 'ACTIVE', 'ACTIVE', 'adset', 'EUR', now())`,
      [CAMP, CUENTA],
    );
    await q(
      `INSERT INTO ad_sets (adset_id, campaign_id, account_id, name, status, effective_status,
                            daily_budget, currency, synced_at)
       VALUES ($1, $2, $3, 'conjunto de anuncios', 'ACTIVE', 'ACTIVE', 2500, 'EUR', now())`,
      [SET, CAMP, CUENTA],
    );
    await q(
      `INSERT INTO ads (ad_id, adset_id, campaign_id, account_id, name, status, effective_status, synced_at)
       VALUES ($1, $4, $5, $6, 'anuncio activo',  'ACTIVE', 'ACTIVE', $2::timestamptz),
              ($7, $4, $5, $6, 'anuncio pausado', 'PAUSED', 'PAUSED', $2::timestamptz),
              ($8, $4, $5, $6, 'anuncio viejo',   'PAUSED', 'PAUSED', $3::timestamptz)`,
      [AD_ACTIVO, FRESCO.toISOString(), VIEJO.toISOString(), SET, CAMP, CUENTA, AD_PAUSADO, AD_VIEJO],
    );
  });

  afterAll(async () => {
    await q(`DELETE FROM ads WHERE account_id = $1`, [CUENTA]);
    await q(`DELETE FROM ad_sets WHERE account_id = $1`, [CUENTA]);
    await q(`DELETE FROM ad_campaigns WHERE account_id = $1`, [CUENTA]);
    await q(`DELETE FROM ad_accounts WHERE account_id = $1`, [CUENTA]);
  });

  beforeEach(() => {
    mockFetchObjeto.mockReset();
  });

  it('un pause a nivel anuncio pasa el preflight en lugar de romper el SELECT', async () => {
    // El caso que antes tiraba `column o.daily_budget does not exist` adentro de
    // `leerObjetos`, sin llegar a Meta ni a `ad_actions`.
    const r = await pf('pause', [AD_ACTIVO]);

    expect(r.objetos).toHaveLength(1);
    expect(r.objetos[0]!.objectId).toBe(AD_ACTIVO);
    expect(r.objetos[0]!.status).toBe('ACTIVE');
    expect(r.objetos[0]!.campaignId).toBe(CAMP);
    // El anuncio se lee entero y el pause es ejecutable: sin motivo de omisión.
    expect(r.previa.filas[0]!.antes).toBe('ACTIVE');
    expect(r.previa.filas[0]!.despues).toBe('PAUSED');
    expect(r.previa.filas[0]!.motivo).toBeNull();
    expect(r.previa.filas[0]!.ejecutable).toBe(true);
    expect(r.previa.completa).toBe(true);
  });

  it('el presupuesto de un anuncio llega en null, no inventado', async () => {
    // El NULL tipado no es un detalle de SQL: `budgetMode` deriva de estas dos
    // columnas, y un anuncio no tiene ni presupuesto diario ni total. Si el
    // arreglo hubiera puesto un 0 en lugar de NULL, `budgetMode` diría 'daily'
    // y la Previsualizacion de presupuesto empezaría a mentir a este nivel.
    const r = await pf('pause', [AD_ACTIVO]);

    expect(r.objetos[0]!.dailyBudget).toBeNull();
    expect(r.objetos[0]!.budgetMode).toBeNull();
    expect(r.objetos[0]!.budgetLevel).toBeNull();
    expect(r.objetos[0]!.inicioProgramado).toBeNull();
    expect(r.objetos[0]!.currency).toBe('EUR');
  });

  it('activate sobre un anuncio pausado también, y el lote mixto se lee de una vez', async () => {
    const r = await pf('activate', [AD_PAUSADO, AD_ACTIVO]);

    const pausado = r.previa.filas.find((f) => f.objectId === AD_PAUSADO)!;
    const activo = r.previa.filas.find((f) => f.objectId === AD_ACTIVO)!;
    expect(pausado.motivo).toBeNull();
    // El que ya está activo se omite, que es la decisión de R6.1 a este nivel.
    expect(activo.motivo).toBe('ya_esta_en_ese_estado');
  });

  it('la frescura del anuncio viaja, y con ella la antigüedad que el mensaje de Omisión nombra', async () => {
    // R6.1 a nivel anuncio: sin el arreglo del SELECT no había forma de llegar
    // hasta acá. El dato es fresco, así que no hubo relectura y la edad sale del
    // `synced_at` de la fila.
    const r = await pf('activate', [AD_ACTIVO]);

    expect(mockFetchObjeto).not.toHaveBeenCalled();
    expect(r.objetos[0]!.syncedAt).toBe(FRESCO.toISOString());
    expect(r.objetos[0]!.desaparecidoAt).toBeNull();
    const edad = edadDelDatoDeOmision(r.objetos[0]!, r.relecturas.get(AD_ACTIVO));
    expect(edad).toBe('de hace 5 min');
  });

  it('un anuncio viejo se relee contra Meta con su propio nivel', async () => {
    // La relectura selectiva no era alcanzable a nivel anuncio por el mismo
    // motivo, y `fetchObjeto` recibe el nivel para armar los campos que pide.
    mockFetchObjeto.mockResolvedValue({
      objectId: AD_VIEJO,
      name: null,
      status: 'ACTIVE',
      effectiveStatus: 'ACTIVE',
      dailyBudget: null,
      lifetimeBudget: null,
    });

    const r = await pf('activate', [AD_VIEJO]);

    expect(mockFetchObjeto).toHaveBeenCalledWith(AD_VIEJO, 'ad');
    // La base decía PAUSED; Meta dice ACTIVE, así que el activate SÍ se omite,
    // pero decidido contra Meta y no contra una fila de 48 horas.
    const x = r.relecturas.get(AD_VIEJO)!;
    expect(x.resultado).toBe('discrepa');
    expect(r.previa.filas[0]!.motivo).toBe('ya_esta_en_ese_estado');
    expect(edadDelDatoDeOmision(r.objetos[0]!, x)).toBe('confirmado contra Meta al resolver el pedido');
  });

  it('un id que no existe se sigue rechazando en bloque a este nivel', async () => {
    // El arreglo no puede haber aflojado la verificación de pertenencia: el
    // faltante se detecta por la ausencia en el JOIN, no por el presupuesto.
    const r = await preflight({
      level: 'ad',
      accountId: CUENTA,
      accion: 'pause',
      objectIds: [AD_ACTIVO, id('A-inexistente')],
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.motivo).toBe('objetos_invalidos');
  });
});
