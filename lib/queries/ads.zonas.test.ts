import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { q } from '../db';
import { TZ_DEFAULT } from '../ads/zona';
import * as repo from '../ads/reglas/repo';
import { getMetricasAds } from './ads';
import { listarCuentas } from '@/app/(panel)/anuncios/reglas/_server';
import { ZONAS_P16 } from '../test/generadores-ads';

// vitest no carga .env solo: se carga acá para que la suite corra contra la base
// real en vez de saltarse en silencio (mismo patrón que repo.test.ts).
if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

const PREFIJO = 'T19-ZONAS-';

// El generador de timezone: las zonas reales del proyecto más NULL, que es
// justo el caso donde los resolvedores discrepaban (repo.zonasDeCuentas
// filtraba `timezone IS NOT NULL` mientras el Lector aplicaba COALESCE).
const genTimezone: fc.Arbitrary<string | null> = fc.option(fc.constantFrom(...ZONAS_P16), { nil: null });

beforeAll(async () => {
  if (!dbAvailable) return;
  await q(`DELETE FROM ad_accounts WHERE account_id LIKE $1`, [PREFIJO + '%']);
});

afterAll(async () => {
  if (!dbAvailable) return;
  await q(`DELETE FROM ad_accounts WHERE account_id LIKE $1`, [PREFIJO + '%']);
});

describe.skipIf(!dbAvailable)('Property 4: Repo, Lector y Panel resuelven la MISMA Zona_Cuenta', () => {
  it('Feature: reglas-anuncios-por-cuenta, Property 4: los tres resolvedores coinciden y devuelven COALESCE(timezone, TZ_DEFAULT)', async () => {
    await fc.assert(
      fc.asyncProperty(
        genTimezone,
        fc.integer({ min: 0, max: 999_999 }),
        async (tz, sufijo) => {
          const accountId = `${PREFIJO}${sufijo}`;
          await q(
            `INSERT INTO ad_accounts (account_id, platform, name, currency, timezone, active)
             VALUES ($1, 'meta', $1, 'EUR', $2, true)`,
            [accountId, tz],
          );
          try {
            const esperada = tz ?? TZ_DEFAULT;

            // 1. El Repo: la consulta por cuenta que usa el Ejecutor.
            const zonaRepo = await repo.zonaDeCuenta(accountId);
            expect(zonaRepo).not.toBeNull();
            expect(zonaRepo!.timezone).toBe(esperada);
            expect(zonaRepo!.activa).toBe(true);

            // 2. El Lector: el rango.timezone que devuelve getMetricasAds.
            const metricas = await getMetricasAds({
              level: 'campaign',
              period: 'today',
              accountIds: [accountId],
              limit: 1,
            });
            expect(metricas.rango.timezone).toBe(esperada);

            // 3. El Panel: la entrada de listarCuentas() de esa cuenta.
            const entradas = await listarCuentas();
            const entrada = entradas.find((c) => c.accountId === accountId);
            expect(entrada).toBeTruthy();
            expect(entrada!.timezone).toBe(esperada);
          } finally {
            await q(`DELETE FROM ad_accounts WHERE account_id = $1`, [accountId]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
