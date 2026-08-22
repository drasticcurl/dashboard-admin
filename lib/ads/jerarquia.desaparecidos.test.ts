import fc from 'fast-check';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { q, q1 } from '../db';
import { sincronizarJerarquia, type ResultadoCuenta } from './jerarquia';
import { fetchAds, fetchAdSets, fetchCampaigns, fetchCuenta, fetchDsaConjuntos } from './meta';
import type { MetaAd, MetaAdSet, MetaCampaign } from './tipos';

/**
 * Tests de la marca de desaparición y del reloj de la corrida (task 6.3).
 * Cubren R3.2 (Meta deja de devolver un objeto → queda distinguible), R3.5
 * (nada se borra), R3.6 (cuando vuelve, la marca se va) y R4.4 / R4.5 (el reloj
 * de la Sync_Jerarquia avanza también cuando falla, con el error al lado).
 *
 * NECESITAN POSTGRES: lo que se verifica es SQL —dos UPDATE dentro de la
 * transacción del upsert— y no hay forma de probarlo sin la base. Sin
 * `DATABASE_URL` el archivo entero se saltea, como el resto de la suite.
 *
 * `lib/ads/meta` se mockea completo: los cinco `fetch` de la jerarquía se
 * reemplazan por listas que el test decide, que es exactamente la variable
 * independiente de estos tests ("qué devolvió Meta en esta corrida"). Ninguna
 * propiedad toca la red.
 *
 * TODO CUELGA DE UNA CUENTA CON ID ÚNICO POR CORRIDA DEL ARCHIVO, y los ids de
 * los objetos llevan ese mismo token: las PK de `ad_campaigns`, `ad_sets` y
 * `ads` son globales, no por cuenta, así que sin el token un archivo que se
 * cayó a mitad dejaría filas que chocan con las de la próxima corrida.
 *
 * LA TRAMPA DEL NIVEL VACÍO. Para que un objeto quede marcado, su nivel tiene
 * que traer AL MENOS OTRO objeto: `debeReconciliarDesaparecidos` saltea el nivel
 * entero cuando la lista viene vacía (una respuesta 200 con `data: []` no se
 * distingue de "la cuenta se quedó sin objetos"). Por eso cada fixture tiene un
 * objeto ANCLA que casi siempre está presente: sin él, "Meta no devolvió nada"
 * no marca nada y los tests pasarían sin ejercitar la marca.
 */

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

vi.mock('./meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./meta')>();
  return {
    ...actual,
    fetchCuenta: vi.fn(),
    fetchCampaigns: vi.fn(),
    fetchAdSets: vi.fn(),
    fetchAds: vi.fn(),
    fetchDsaConjuntos: vi.fn(),
  };
});

const mockCuenta = vi.mocked(fetchCuenta);
const mockCampanias = vi.mocked(fetchCampaigns);
const mockConjuntos = vi.mocked(fetchAdSets);
const mockAnuncios = vi.mocked(fetchAds);
const mockDsa = vi.mocked(fetchDsaConjuntos);

const CUENTA = `DES-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const id = (sufijo: string): string => `${CUENTA}-${sufijo}`;

// ── El fixture: tres objetos por nivel, con roles distintos ─────────────────
// ANCLA: presente en casi todas las corridas. Es el que hace que el nivel se
//        reconcilie (ver "la trampa del nivel vacío" arriba).
// FALTA: el que desaparece.
// CONTROL: desaparece MÁS TARDE que FALTA. Existe para que la igualdad de
//        `desaparecido_at` entre corridas de la Property 5 no pueda pasar por
//        casualidad: si la implementación re-estampara `now()` en cada corrida,
//        las dos marcas serían iguales entre sí y el test lo ve.
const C_ANCLA = id('c-ancla');
const C_FALTA = id('c-falta');
const C_CONTROL = id('c-control');
const S_ANCLA = id('s-ancla');
const S_FALTA = id('s-falta');
const S_CONTROL = id('s-control');
const A_ANCLA = id('a-ancla');
const A_FALTA = id('a-falta');
const A_CONTROL = id('a-control');

/** Objetos que NO están en la base: sirven para que una corrida pueda AGREGAR. */
const C_NUEVA = id('c-nueva');
const S_NUEVO = id('s-nuevo');
const A_NUEVO = id('a-nuevo');

type Nivel = 'campanias' | 'conjuntos' | 'anuncios';
type Presentes = { [N in Nivel]: readonly string[] };

const TODOS: Presentes = {
  campanias: [C_ANCLA, C_FALTA, C_CONTROL],
  conjuntos: [S_ANCLA, S_FALTA, S_CONTROL],
  anuncios: [A_ANCLA, A_FALTA, A_CONTROL],
};

// Toda la jerarquía cuelga de los anclas: un solo padre por nivel mantiene el
// fixture chico y deja que cada nivel se pruebe sin arrastrar a los otros (la
// marca es por nivel, no cascadea).
const conjuntoDeAnuncio = S_ANCLA;
const campaniaDeConjunto = C_ANCLA;

function campania(campaignId: string): MetaCampaign {
  return {
    campaignId,
    name: `Campaña ${campaignId}`,
    objective: 'OUTCOME_SALES',
    status: 'ACTIVE',
    effectiveStatus: 'ACTIVE',
    dailyBudget: null, // ABO: el presupuesto vive en el conjunto
    lifetimeBudget: null,
    bidStrategy: 'LOWEST_COST_WITHOUT_CAP',
    createdTime: '2026-01-01T00:00:00Z',
    startTime: null,
    endTime: null,
  };
}

function conjunto(adsetId: string): MetaAdSet {
  return {
    adsetId,
    campaignId: campaniaDeConjunto,
    name: `Conjunto ${adsetId}`,
    status: 'ACTIVE',
    effectiveStatus: 'ACTIVE',
    dailyBudget: 2500,
    lifetimeBudget: null,
    optimizationGoal: 'OFFSITE_CONVERSIONS',
    billingEvent: 'IMPRESSIONS',
    bidStrategy: 'LOWEST_COST_WITHOUT_CAP',
    createdTime: '2026-01-01T00:00:00Z',
    startTime: null,
    endTime: null,
  };
}

function anuncio(adId: string): MetaAd {
  return {
    adId,
    adsetId: conjuntoDeAnuncio,
    campaignId: campaniaDeConjunto,
    name: `Anuncio ${adId}`,
    status: 'ACTIVE',
    effectiveStatus: 'ACTIVE',
    creativeId: `cr-${adId}`,
    createdTime: '2026-01-01T00:00:00Z',
  };
}

/**
 * 2 ms entre corridas. `desaparecido_at` es el `now()` de la transacción, y los
 * tests de la Property 5 comparan marcas de corridas distintas por IGUALDAD y
 * por ORDEN. Sin separación, dos corridas podrían caer en el mismo instante y
 * una implementación que re-estampa la marca en cada corrida pasaría el test.
 */
const pausa = (): Promise<void> => new Promise((r) => setTimeout(r, 2));

/** Una corrida de la Sync_Jerarquia con Meta devolviendo exactamente `p`. */
async function correr(p: Presentes, opts?: { dryRun?: boolean }): Promise<ResultadoCuenta> {
  await pausa();
  mockCuenta.mockResolvedValue({
    accountId: CUENTA,
    currency: 'EUR',
    timezoneName: 'Europe/Lisbon',
    accountStatus: 1,
  });
  mockCampanias.mockResolvedValue(p.campanias.map(campania));
  mockConjuntos.mockResolvedValue(p.conjuntos.map(conjunto));
  mockAnuncios.mockResolvedValue(p.anuncios.map(anuncio));
  mockDsa.mockResolvedValue([]);

  const r = await sincronizarJerarquia({ cuentas: [CUENTA], dryRun: opts?.dryRun ?? false });
  expect(r.cuentas.map((c) => c.accountId)).toEqual([CUENTA]);
  return r.cuentas[0]!;
}

/**
 * `desaparecido_at` de todos los objetos de la cuenta, como texto y por id.
 * Texto y no `Date`: la comparación entre corridas es por igualdad exacta y el
 * texto de un timestamptz no pierde microsegundos por el camino.
 */
async function marcas(): Promise<Record<string, string | null>> {
  const filas = await q<{ id: string; marca: string | null }>(
    `SELECT campaign_id AS id, desaparecido_at::text AS marca FROM ad_campaigns WHERE account_id = $1
     UNION ALL
     SELECT adset_id, desaparecido_at::text FROM ad_sets WHERE account_id = $1
     UNION ALL
     SELECT ad_id, desaparecido_at::text FROM ads WHERE account_id = $1`,
    [CUENTA],
  );
  return Object.fromEntries(filas.map((f) => [f.id, f.marca]));
}

async function conteos(): Promise<{ campanias: number; conjuntos: number; anuncios: number }> {
  const r = await q1<{ campanias: string; conjuntos: string; anuncios: string }>(
    `SELECT (SELECT count(*) FROM ad_campaigns WHERE account_id = $1) AS campanias,
            (SELECT count(*) FROM ad_sets      WHERE account_id = $1) AS conjuntos,
            (SELECT count(*) FROM ads          WHERE account_id = $1) AS anuncios`,
    [CUENTA],
  );
  return {
    campanias: Number(r!.campanias),
    conjuntos: Number(r!.conjuntos),
    anuncios: Number(r!.anuncios),
  };
}

/**
 * Foto de las tres tablas con TODAS sus columnas menos `synced_at`, para la
 * idempotencia. `synced_at` queda afuera porque avanzar es su trabajo: es el
 * dato que dice "esto se confirmó recién" y una corrida que no lo moviera
 * estaría rota. Lo que tiene que quedar igual es todo el resto, y sobre todo
 * `desaparecido_at`. Que la exclusión no tape una corrida que no escribió nada
 * se verifica aparte, comprobando que `synced_at` SÍ avanzó.
 */
async function foto(): Promise<unknown> {
  const r = await q1<{ snap: unknown }>(
    `WITH c AS (
       SELECT jsonb_agg(to_jsonb(x) - 'synced_at' ORDER BY x.campaign_id) AS j
         FROM ad_campaigns x WHERE x.account_id = $1
     ), s AS (
       SELECT jsonb_agg(to_jsonb(x) - 'synced_at' ORDER BY x.adset_id) AS j
         FROM ad_sets x WHERE x.account_id = $1
     ), a AS (
       SELECT jsonb_agg(to_jsonb(x) - 'synced_at' ORDER BY x.ad_id) AS j
         FROM ads x WHERE x.account_id = $1
     )
     SELECT jsonb_build_object('campanias', c.j, 'conjuntos', s.j, 'anuncios', a.j) AS snap
       FROM c, s, a`,
    [CUENTA],
  );
  return r!.snap;
}

async function maxSyncedAt(): Promise<string> {
  const r = await q1<{ t: string }>(
    `SELECT max(t)::text AS t FROM (
       SELECT max(synced_at) AS t FROM ad_campaigns WHERE account_id = $1
       UNION ALL SELECT max(synced_at) FROM ad_sets  WHERE account_id = $1
       UNION ALL SELECT max(synced_at) FROM ads      WHERE account_id = $1
     ) u`,
    [CUENTA],
  );
  return r!.t;
}

async function reloj(): Promise<{ at: string | null; error: string | null }> {
  const r = await q1<{ at: string | null; error: string | null }>(
    `SELECT last_hierarchy_sync_at::text AS at, last_hierarchy_sync_error AS error
       FROM ad_accounts WHERE account_id = $1`,
    [CUENTA],
  );
  return r!;
}

/** Deja la cuenta creada y vacía de jerarquía, con el reloj sin usar. */
async function reiniciar(): Promise<void> {
  await q('DELETE FROM ads WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_sets WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_campaigns WHERE account_id = $1', [CUENTA]);
  await q(
    `UPDATE ad_accounts
        SET currency = 'EUR', active = true,
            last_hierarchy_sync_at = NULL, last_hierarchy_sync_error = NULL
      WHERE account_id = $1`,
    [CUENTA],
  );
}

beforeAll(async () => {
  if (!dbAvailable) return;
  await q(
    `INSERT INTO ad_accounts (account_id, platform, name, currency, active, timezone)
     VALUES ($1, 'meta', 'test desapariciones', 'EUR', true, 'Europe/Lisbon')
     ON CONFLICT (account_id) DO UPDATE SET active = true, currency = 'EUR'`,
    [CUENTA],
  );
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await reiniciar();
});

afterAll(async () => {
  if (!dbAvailable) return;
  await q('DELETE FROM ads WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_sets WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_campaigns WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_accounts WHERE account_id = $1', [CUENTA]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Ejemplos: la marca se pone, se limpia, y no borra nada
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!dbAvailable)('la marca de desaparición (R3.2, R3.5, R3.6)', () => {
  it('con tres objetos sembrados y Meta devolviendo dos, el tercero queda marcado y los otros en NULL, en los tres niveles', async () => {
    await correr(TODOS);
    expect(await conteos()).toEqual({ campanias: 3, conjuntos: 3, anuncios: 3 });

    const r = await correr({
      campanias: [C_ANCLA, C_CONTROL],
      conjuntos: [S_ANCLA, S_CONTROL],
      anuncios: [A_ANCLA, A_CONTROL],
    });

    const m = await marcas();
    // Uno por nivel: los tres niveles se recorren en el mismo loop y un bug que
    // sólo alcanzara a una de las tres tablas pasaría desapercibido con uno solo.
    expect(m[C_FALTA]).not.toBeNull();
    expect(m[S_FALTA]).not.toBeNull();
    expect(m[A_FALTA]).not.toBeNull();
    expect(m[C_ANCLA]).toBeNull();
    expect(m[C_CONTROL]).toBeNull();
    expect(m[S_ANCLA]).toBeNull();
    expect(m[S_CONTROL]).toBeNull();
    expect(m[A_ANCLA]).toBeNull();
    expect(m[A_CONTROL]).toBeNull();

    // El reporte cuenta lo mismo que la base escribió, ni más ni menos.
    expect(r.desaparecidos).toBe(3);
    // R3.5: nada se borró.
    expect(await conteos()).toEqual({ campanias: 3, conjuntos: 3, anuncios: 3 });
  });

  it('cuando el objeto vuelve a aparecer, la marca se limpia (R3.6)', async () => {
    await correr(TODOS);
    await correr({ campanias: [C_ANCLA], conjuntos: [S_ANCLA], anuncios: [A_ANCLA] });
    const marcados = await marcas();
    expect(marcados[C_FALTA]).not.toBeNull();
    expect(marcados[S_FALTA]).not.toBeNull();
    expect(marcados[A_FALTA]).not.toBeNull();

    const r = await correr(TODOS);

    const m = await marcas();
    for (const objeto of [...TODOS.campanias, ...TODOS.conjuntos, ...TODOS.anuncios]) {
      expect(m[objeto], `${objeto} volvió a aparecer y no puede seguir marcado`).toBeNull();
    }
    expect(r.desaparecidos).toBe(0);
  });

  it('un nivel que vuelve vacío no marca nada, y los otros dos se reconcilian igual', async () => {
    await correr(TODOS);

    // Campañas: 200 con `data: []`. Conjuntos y anuncios traen datos.
    const r = await correr({
      campanias: [],
      conjuntos: [S_ANCLA, S_CONTROL],
      anuncios: [A_ANCLA, A_CONTROL],
    });

    const m = await marcas();
    for (const c of TODOS.campanias) {
      expect(m[c], `${c}: una lista vacía no puede marcar la cuenta entera`).toBeNull();
    }
    expect(m[S_FALTA]).not.toBeNull();
    expect(m[A_FALTA]).not.toBeNull();
    // Ni el reporte anuncia desapariciones que no se escribieron...
    expect(r.desaparecidos).toBe(2);
    // ...ni se perdió ninguna campaña por no venir en la respuesta.
    expect(await conteos()).toEqual({ campanias: 3, conjuntos: 3, anuncios: 3 });
  });

  it('el dry run no escribe la marca ni el reloj de la corrida', async () => {
    await correr(TODOS);
    const relojAntes = await reloj();
    expect(relojAntes.at).not.toBeNull();

    const r = await correr(
      { campanias: [C_ANCLA], conjuntos: [S_ANCLA], anuncios: [A_ANCLA] },
      { dryRun: true },
    );

    const m = await marcas();
    for (const objeto of [...TODOS.campanias, ...TODOS.conjuntos, ...TODOS.anuncios]) {
      expect(m[objeto], `${objeto}: una corrida en seco no marca`).toBeNull();
    }
    expect(await reloj()).toEqual(relojAntes);
    // El dry run igual CUENTA lo que habría marcado: es su razón de ser.
    expect(r.desaparecidos).toBe(6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// El reloj de la corrida (R4.4, R4.5)
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!dbAvailable)('last_hierarchy_sync_at y su error (R4.4, R4.5)', () => {
  it('avanza al terminar bien, avanza también cuando falla con el error al lado, y el error se limpia en la corrida siguiente', async () => {
    await correr(TODOS);
    const bien = await reloj();
    expect(bien.at).not.toBeNull();
    expect(bien.error).toBeNull();

    // Un fallo duro de Meta: el reloj tiene que avanzar igual, porque la columna
    // dice "cuándo terminó el último intento". Si no avanzara, el TTL dejaría de
    // frenar justo cuando Meta está rechazando llamadas.
    await pausa();
    mockCuenta.mockResolvedValue({
      accountId: CUENTA,
      currency: 'EUR',
      timezoneName: 'Europe/Lisbon',
      accountStatus: 1,
    });
    mockCampanias.mockRejectedValue(new Error('Meta no responde'));
    mockConjuntos.mockResolvedValue([]);
    mockAnuncios.mockResolvedValue([]);
    mockDsa.mockResolvedValue([]);
    const fallida = await sincronizarJerarquia({ cuentas: [CUENTA] });
    expect(fallida.cuentas[0]!.error).toContain('Meta no responde');

    const mal = await reloj();
    expect(mal.at).not.toBeNull();
    expect(new Date(mal.at!).getTime()).toBeGreaterThan(new Date(bien.at!).getTime());
    expect(mal.error).toContain('Meta no responde');

    // Y una corrida que termina bien borra el error de la anterior.
    const luego = await correr(TODOS);
    expect(luego.error).toBeNull();
    const limpio = await reloj();
    expect(limpio.error).toBeNull();
    expect(new Date(limpio.at!).getTime()).toBeGreaterThan(new Date(mal.at!).getTime());
  });

  it('una cuenta que no es EUR avanza el reloj con el error en NULL: está fuera de alcance, no fallida', async () => {
    await q(`UPDATE ad_accounts SET currency = 'USD' WHERE account_id = $1`, [CUENTA]);

    const r = await correr(TODOS);

    expect(r.monedaNoSoportada).toBe('USD');
    expect(r.error).toBeNull();
    const reloj1 = await reloj();
    expect(reloj1.at).not.toBeNull();
    expect(reloj1.error).toBeNull();
    // Y no escribió jerarquía: la cuenta se salteó antes de `escribirCuenta`.
    expect(await conteos()).toEqual({ campanias: 0, conjuntos: 0, anuncios: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Feature: frescura-y-acciones-anuncios, Property 5: Idempotencia de la marca
// de desaparición
//
// **Validates: Requirements 3.2, 3.6**
//
// Para toda secuencia de corridas, un objeto presente en la última termina con
// `desaparecido_at IS NULL`, y un objeto ausente termina con la marca de la
// PRIMERA corrida de su racha de ausencia. Dos corridas seguidas con la misma
// respuesta de Meta dejan la base igual.
// ─────────────────────────────────────────────────────────────────────────────

/** Una corrida arbitraria sobre los objetos que YA están en la base. */
const genCorridaFixture: fc.Arbitrary<Presentes> = fc.record({
  campanias: fc.subarray([...TODOS.campanias]),
  conjuntos: fc.subarray([...TODOS.conjuntos]),
  anuncios: fc.subarray([...TODOS.anuncios]),
});

describe.skipIf(!dbAvailable)('Property 5: idempotencia de la marca (R3.2, R3.6)', () => {
  it('un objeto ausente varias corridas seguidas conserva la marca de la PRIMERA en que faltó', async () => {
    await correr(TODOS);

    // Corrida 1: falta C_FALTA. C_CONTROL sigue presente.
    await correr({
      campanias: [C_ANCLA, C_CONTROL],
      conjuntos: [S_ANCLA, S_CONTROL],
      anuncios: [A_ANCLA, A_CONTROL],
    });
    const t1 = await marcas();
    expect(t1[C_FALTA]).not.toBeNull();
    expect(t1[C_CONTROL]).toBeNull();

    // Corrida 2: ahora también falta C_CONTROL. Su marca es de ESTA corrida.
    await correr({ campanias: [C_ANCLA], conjuntos: [S_ANCLA], anuncios: [A_ANCLA] });
    const t2 = await marcas();

    // Corrida 3: los dos siguen faltando y ninguna marca se mueve.
    await correr({ campanias: [C_ANCLA], conjuntos: [S_ANCLA], anuncios: [A_ANCLA] });
    const t3 = await marcas();

    const pares: Array<[string, string]> = [
      [C_FALTA, C_CONTROL],
      [S_FALTA, S_CONTROL],
      [A_FALTA, A_CONTROL],
    ];
    for (const [falta, control] of pares) {
      // La marca del que faltó primero NO se movió en las corridas 2 y 3.
      expect(t2[falta]).toBe(t1[falta]);
      expect(t3[falta]).toBe(t1[falta]);
      // El control es lo que hace que la igualdad de arriba pruebe algo: su
      // marca es de la corrida 2, ESTRICTAMENTE posterior. Si la
      // implementación re-estampara `now()` en cada corrida, las dos marcas
      // serían iguales y esta comparación falla.
      expect(t2[control]).not.toBeNull();
      expect(new Date(t2[control]!).getTime()).toBeGreaterThan(new Date(t1[falta]!).getTime());
      expect(t3[control]).toBe(t2[control]);
    }
  });

  it('dos corridas seguidas con la misma respuesta de Meta dejan la base igual', async () => {
    await correr(TODOS);
    // Con una desaparición ya escrita: la idempotencia que importa es la de un
    // estado que tiene marcas puestas, no la de una base recién sembrada.
    await correr({
      campanias: [C_ANCLA, C_CONTROL],
      conjuntos: [S_ANCLA, S_CONTROL],
      anuncios: [A_ANCLA, A_CONTROL],
    });

    const respuesta: Presentes = {
      campanias: [C_ANCLA, C_CONTROL],
      conjuntos: [S_ANCLA, S_CONTROL],
      anuncios: [A_ANCLA, A_CONTROL],
    };
    const antes = await foto();
    const syncedAntes = await maxSyncedAt();

    const r = await correr(respuesta);

    expect(await foto()).toEqual(antes);
    expect(r.desaparecidos).toBe(3);
    // La foto excluye `synced_at`; esto verifica que la corrida escribió de
    // verdad y que la igualdad de arriba no es la de una corrida que no hizo
    // nada.
    expect(new Date(await maxSyncedAt()).getTime()).toBeGreaterThan(
      new Date(syncedAntes).getTime(),
    );
  });

  it('para toda secuencia de corridas, cada objeto termina con la marca de la primera corrida de su racha de ausencia', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(genCorridaFixture, { minLength: 1, maxLength: 4 }),
        async (secuencia) => {
          await reiniciar();
          await correr(TODOS); // línea de base: los nueve objetos, sin marcas

          const historial: Array<Record<string, string | null>> = [];
          for (const corrida of secuencia) {
            await correr(corrida);
            historial.push(await marcas());
          }
          const finales = historial[historial.length - 1]!;

          for (const nivel of ['campanias', 'conjuntos', 'anuncios'] as const) {
            for (const objeto of TODOS[nivel]) {
              // El modelo: se recorre la secuencia y se decide qué corrida
              // escribió la marca que tiene que haber quedado. Un nivel que
              // vino VACÍO no reconcilia: no marca ni desmarca (la guarda de
              // `debeReconciliarDesaparecidos`), así que no cambia el estado.
              let esperado: number | null = null; // índice de la corrida que marcó
              for (let i = 0; i < secuencia.length; i += 1) {
                const lista = secuencia[i]![nivel];
                if (lista.length === 0) continue;
                if (lista.includes(objeto)) esperado = null;
                else if (esperado === null) esperado = i;
              }

              if (esperado === null) {
                expect(finales[objeto], `${objeto} presente en la última corrida`).toBeNull();
              } else {
                // Igualdad con la marca que se leyó JUSTO DESPUÉS de la corrida
                // que la escribió: si alguna corrida posterior la hubiera
                // re-estampado, los textos no coinciden.
                expect(finales[objeto], `${objeto} debía quedar marcado`).not.toBeNull();
                expect(
                  finales[objeto],
                  `${objeto} tiene que conservar la marca de la corrida ${esperado}`,
                ).toBe(historial[esperado]![objeto]);
              }
            }
          }
        },
      ),
      // Cada iteración son hasta 5 transacciones contra Postgres: la cantidad de
      // corridas se mantiene chica a propósito.
      { numRuns: 10 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Feature: frescura-y-acciones-anuncios, Property 6: Ningún objeto se pierde
//
// **Validates: Requirements 3.5**
//
// Para toda corrida de Sync_Jerarquia, la cantidad de filas de la Jerarquía por
// cuenta no decrece. Un objeto que Meta deja de devolver se marca, nunca se
// borra.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Igual que `genCorridaFixture` pero con un objeto por nivel que NO está en la
 * base: sin él la propiedad se cumpliría con una implementación que nunca
 * escribe nada, y lo que hay que ver es que la cantidad no decrece MIENTRAS la
 * jerarquía cambia.
 */
const genCorridaConNuevos: fc.Arbitrary<Presentes> = fc.record({
  campanias: fc.subarray([...TODOS.campanias, C_NUEVA]),
  conjuntos: fc.subarray([...TODOS.conjuntos, S_NUEVO]),
  anuncios: fc.subarray([...TODOS.anuncios, A_NUEVO]),
});

describe.skipIf(!dbAvailable)('Property 6: ningún objeto se pierde (R3.5)', () => {
  it('para toda secuencia de corridas, la cantidad de filas por cuenta y por nivel nunca decrece', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(genCorridaConNuevos, { minLength: 1, maxLength: 4 }),
        async (secuencia) => {
          await reiniciar();
          await correr(TODOS);
          let previo = await conteos();
          expect(previo).toEqual({ campanias: 3, conjuntos: 3, anuncios: 3 });

          for (const corrida of secuencia) {
            await correr(corrida);
            const ahora = await conteos();
            expect(ahora.campanias).toBeGreaterThanOrEqual(previo.campanias);
            expect(ahora.conjuntos).toBeGreaterThanOrEqual(previo.conjuntos);
            expect(ahora.anuncios).toBeGreaterThanOrEqual(previo.anuncios);
            previo = ahora;
          }

          // Los nueve objetos de la línea de base siguen ahí, marcados o no.
          const m = await marcas();
          for (const objeto of [...TODOS.campanias, ...TODOS.conjuntos, ...TODOS.anuncios]) {
            expect(Object.hasOwn(m, objeto), `${objeto} no puede haber desaparecido`).toBe(true);
          }
        },
      ),
      { numRuns: 10 },
    );
  });
});
