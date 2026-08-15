import fc from 'fast-check';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { q, q1 } from '../db';
import { genRango } from '../test/generadores-ads';
import { asegurarAlcance } from './alcance';
import { fetchAlcance } from './meta';
import type { NivelAds } from './tipos';

/**
 * Property 10 (task 14.3) y tests de ejemplo de `asegurarAlcance` (task 14.4).
 * El alcance NUNCA se deriva sumando: la clave de `ad_alcance` es (plataforma,
 * cuenta, NIVEL, objeto, RANGO exacto) y la lectura por un triple devuelve
 * exactamente las filas sembradas con ese triple, nunca una suma ni un promedio
 * de rangos vecinos. `fetchAlcance` se mockea: ninguna propiedad toca Meta.
 */

if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

vi.mock('./meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./meta')>();
  return { ...actual, fetchAlcance: vi.fn() };
});

const mockFetchAlcance = vi.mocked(fetchAlcance);

const CUENTA = `P10-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// ─── Property 10 ─────────────────────────────────────────────────────────────

type FilaSembrada = {
  nivel: NivelAds;
  objectId: string;
  from: string;
  to: string;
  reach: number;
};

function genSiembra(): fc.Arbitrary<FilaSembrada[]> {
  return fc.array(
    genRango().chain(({ from, to, level }) =>
      fc
        .tuple(fc.uuid(), fc.integer({ min: 1, max: 100 }))
        .map(([objectId, reach]) => ({ nivel: level, objectId, from, to, reach })),
    ),
    { minLength: 1, maxLength: 60 },
  );
}

async function sembrar(filas: FilaSembrada[]): Promise<void> {
  await q(
    `INSERT INTO ad_accounts (account_id, platform, name, currency, active)
     VALUES ($1, 'meta', 'test', 'EUR', true)
     ON CONFLICT (account_id) DO UPDATE SET active = true`,
    [CUENTA],
  );
  for (const f of filas) {
    await q(
      `INSERT INTO ad_alcance (platform, account_id, level, object_id, date_from, date_to, reach, impressions, frequency, synced_at)
       VALUES ('meta', $1, $2, $3, $4::date, $5::date, $6, $6, 1, now())
       ON CONFLICT (platform, account_id, level, object_id, date_from, date_to)
       DO UPDATE SET reach = EXCLUDED.reach`,
      [CUENTA, f.nivel, f.objectId, f.from, f.to, f.reach],
    );
  }
}

async function leerExacto(
  nivel: NivelAds,
  from: string,
  to: string,
): Promise<{ objectId: string; reach: string }[]> {
  return q(
    `SELECT object_id AS "objectId", reach::text AS reach
       FROM ad_alcance
      WHERE platform = 'meta' AND account_id = $1 AND level = $2
        AND date_from = $3::date AND date_to = $4::date
      ORDER BY object_id`,
    [CUENTA, nivel, from, to],
  );
}

// Feature: gestion-campanas-anuncios, Property 10: El alcance nunca se deriva
// sumando
describe.skipIf(!dbAvailable)('Property 10 (R7 c5, c6)', () => {
  it('para toda siembra de rangos y toda consulta, la lectura devuelve exactamente las filas del (nivel, from, to) exacto y nunca una suma', async () => {
    await fc.assert(
      fc.asyncProperty(genSiembra(), genRango(), async (sembradas, consulta) => {
        await q('DELETE FROM ad_alcance WHERE account_id = $1', [CUENTA]);
        await sembrar(sembradas);

        const leidas = await leerExacto(consulta.level, consulta.from, consulta.to);

        const esperadas = sembradas
          .filter((f) => f.nivel === consulta.level && f.from === consulta.from && f.to === consulta.to)
          .sort((a, b) => (a.objectId < b.objectId ? -1 : 1));

        expect(leidas.map((r) => r.objectId)).toEqual(esperadas.map((e) => e.objectId));
        for (const r of leidas) {
          const esperada = esperadas.find((e) => e.objectId === r.objectId)!;
          expect(Number(r.reach)).toBe(esperada.reach);
        }
        if (esperadas.length === 0) {
          expect(leidas).toEqual([]);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Tests de ejemplo de asegurarAlcance (task 14.4) ─────────────────────────

/** Los cuatro rangos de pantalla resueltos hoy en la zona de la cuenta. */
async function rangosDeHoy(): Promise<{
  hoy: string;
  yesterday: string;
}> {
  const r = await q1<{ hoy: string }>(
    `SELECT (now() AT TIME ZONE 'Europe/Lisbon')::date::text AS hoy`,
  );
  const hoy = r!.hoy;
  const y = await q1<{ d: string }>(`SELECT ($1::date - 1)::text AS d`, [hoy]);
  return { hoy, yesterday: y!.d };
}

async function sembrarCuenta(zona: string): Promise<void> {
  await q(
    `INSERT INTO ad_accounts (account_id, platform, name, currency, active, timezone)
     VALUES ($1, 'meta', 'test', 'EUR', true, $2)
     ON CONFLICT (account_id) DO UPDATE SET active = true, timezone = $2`,
    [CUENTA, zona],
  );
}

const filasDe = (from: string, to: string) => [
  { accountId: CUENTA, objectId: 'obj-1', reach: 100, impressions: 250, frequency: 2.5 },
  { accountId: CUENTA, objectId: 'obj-2', reach: 50, impressions: 100, frequency: 2.0 },
];

afterEach(() => {
  mockFetchAlcance.mockReset();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await q('DELETE FROM ad_alcance WHERE account_id = $1', [CUENTA]);
});

afterAll(async () => {
  if (!dbAvailable) return;
  await q('DELETE FROM ad_alcance WHERE account_id = $1', [CUENTA]);
  await q('DELETE FROM ad_accounts WHERE account_id = $1', [CUENTA]);
});

describe.skipIf(!dbAvailable)('asegurarAlcance — ejemplos (R7 c5, c6)', () => {
  it('el upsert es por rango exacto: la segunda corrida dentro del TTL no llama a Meta, y vencido el TTL pisa sin duplicar', async () => {
    await sembrarCuenta('Europe/Lisbon');
    const { hoy } = await rangosDeHoy();
    mockFetchAlcance.mockResolvedValue(filasDe(hoy, hoy));

    const primera = await asegurarAlcance(CUENTA, 'adset', hoy, hoy);
    expect(primera.pedido).toBe(true);
    expect(primera.error).toBeNull();

    const guardado1 = await q(
      `SELECT object_id FROM ad_alcance
        WHERE account_id = $1 AND level = 'adset' AND date_from = $2::date AND date_to = $2::date
        ORDER BY object_id`,
      [CUENTA, hoy],
    );
    expect(guardado1.map((r) => r.object_id)).toEqual(['obj-1', 'obj-2']);

    // dentro del TTL (55 s): no llama de nuevo
    const segunda = await asegurarAlcance(CUENTA, 'adset', hoy, hoy);
    expect(segunda.pedido).toBe(false);
    expect(mockFetchAlcance).toHaveBeenCalledTimes(1);

    // vencido el TTL: vuelve a llamar y pisa con los mismos valores
    await q(
      `UPDATE ad_alcance SET synced_at = now() - interval '10 minutes' WHERE account_id = $1`,
      [CUENTA],
    );
    const tercera = await asegurarAlcance(CUENTA, 'adset', hoy, hoy);
    expect(tercera.pedido).toBe(true);
    expect(mockFetchAlcance).toHaveBeenCalledTimes(2);
    const n = await q(
      `SELECT count(*)::int AS n FROM ad_alcance
        WHERE account_id = $1 AND level = 'adset' AND date_from = $2::date AND date_to = $2::date`,
      [CUENTA, hoy],
    );
    expect(n[0]!.n).toBe(2); // upsert, no duplicados
  });

  it('un rango cerrado con synced_at posterior a date_to + 2 días es FINAL y no se vuelve a pedir', async () => {
    await sembrarCuenta('Europe/Lisbon');
    const { yesterday } = await rangosDeHoy();
    mockFetchAlcance.mockResolvedValue(filasDe(yesterday, yesterday));

    const primera = await asegurarAlcance(CUENTA, 'adset', yesterday, yesterday);
    expect(primera.pedido).toBe(true);

    // "final": synced_at > date_to + 2 días
    await q(
      `UPDATE ad_alcance SET synced_at = ($1::date + 3)::timestamptz WHERE account_id = $2`,
      [yesterday, CUENTA],
    );
    const segunda = await asegurarAlcance(CUENTA, 'adset', yesterday, yesterday);
    expect(segunda.pedido).toBe(false);
    expect(mockFetchAlcance).toHaveBeenCalledTimes(1);

    // recién cerrado: NO es final y se vuelve a pedir
    await q('UPDATE ad_alcance SET synced_at = now() WHERE account_id = $1', [CUENTA]);
    const tercera = await asegurarAlcance(CUENTA, 'adset', yesterday, yesterday);
    expect(tercera.pedido).toBe(true);
    expect(mockFetchAlcance).toHaveBeenCalledTimes(2);
  });

  it('un período sin fila devuelve NULL (—) y no una suma: pedir hoy y preguntar ayer', async () => {
    await sembrarCuenta('Europe/Lisbon');
    const { hoy, yesterday } = await rangosDeHoy();
    mockFetchAlcance
      .mockResolvedValueOnce(filasDe(hoy, hoy))
      .mockResolvedValueOnce([]); // ayer no tiene datos

    await asegurarAlcance(CUENTA, 'adset', hoy, hoy);
    await asegurarAlcance(CUENTA, 'adset', yesterday, yesterday);

    const ayer = await q(
      `SELECT count(*)::int AS n FROM ad_alcance
        WHERE account_id = $1 AND level = 'adset' AND date_from = $2::date AND date_to = $2::date`,
      [CUENTA, yesterday],
    );
    expect(ayer[0]!.n).toBe(0);
    const hoyN = await q(
      `SELECT count(*)::int AS n FROM ad_alcance
        WHERE account_id = $1 AND level = 'adset' AND date_from = $2::date AND date_to = $2::date`,
      [CUENTA, hoy],
    );
    expect(hoyN[0]!.n).toBe(2); // el de hoy sigue con sus dos filas, sin mezclarse
  });

  it('un nivel distinto no se deriva de otro: el alcance de adset no es el de campaign', async () => {
    await sembrarCuenta('Europe/Lisbon');
    const { hoy } = await rangosDeHoy();
    mockFetchAlcance.mockResolvedValue(filasDe(hoy, hoy));

    await asegurarAlcance(CUENTA, 'adset', hoy, hoy);
    const campaign = await q(
      `SELECT count(*)::int AS n FROM ad_alcance
        WHERE account_id = $1 AND level = 'campaign' AND date_from = $2::date AND date_to = $2::date`,
      [CUENTA, hoy],
    );
    expect(campaign[0]!.n).toBe(0);
  });

  it('un rango que no es de pantalla no llama a Meta (defensa del contrato, P-G07)', async () => {
    await sembrarCuenta('Europe/Lisbon');
    const r = await asegurarAlcance(CUENTA, 'adset', '2020-01-01', '2020-01-10');
    expect(r.pedido).toBe(false);
    expect(mockFetchAlcance).not.toHaveBeenCalled();
  });

  it('nunca tira: un error de Meta deja el alcance en NULL y viaja en error', async () => {
    await sembrarCuenta('Europe/Lisbon');
    const { hoy } = await rangosDeHoy();
    mockFetchAlcance.mockRejectedValue(new Error('Meta no responde'));
    const r = await asegurarAlcance(CUENTA, 'adset', hoy, hoy);
    expect(r.error).toContain('Meta no responde');
  });
});
