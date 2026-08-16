/**
 * Tests de scripts/finance-rollup.ts (T01, sección 5).
 *
 * El profit diario es plata: la aritmética (bruto − devuelto − comisiones −
 * costos − ads, de TODOS los funnels juntos) se testea contra Postgres real
 * con filas de daily_metrics sembradas a mano, con los valores concretos de
 * la fase 3 (#15). Sin DATABASE_URL se salta, igual que el resto.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { q } from '../lib/db';
import { getFunnelBySlug } from '../lib/funnels';
import { financeRollupRange, main } from './finance-rollup';

// vitest no carga .env solo (mismo patrón que lib/queries/funnel.test.ts):
// cargarlo acá hace que la suite corra contra la base real en vez de
// saltarse en silencio.
if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

const DAY = '2026-08-10';

describe.skipIf(!dbAvailable)('financeRollupRange', () => {
  let f1: { id: number };
  let f2: { id: number };

  afterEach(async () => {
    await q('DELETE FROM finance_daily_profit WHERE day = $1::date', [DAY]);
    // El test de main() escribe ayer y hoy (T01 §6): se limpian también.
    await q(`DELETE FROM finance_daily_profit WHERE day >= (now()::date - 2)`);
    await q('DELETE FROM daily_metrics WHERE day = $1::date', [DAY]);
  });

  /** Una fila de daily_metrics directa: el rollup de daily_metrics ya la
   *  escribió (o la escribió este test); acá solo importa la aritmética. */
  async function seedDaily(funnelId: number, r: {
    gross: number; refunded: number; commissions: number; costs: number; adSpend: number;
  }): Promise<void> {
    await q(
      `INSERT INTO daily_metrics (funnel_id, day, variant, revenue_gross_eur, revenue_refunded_eur,
                                  commissions_eur, costs_eur, ad_spend_eur)
       VALUES ($1, $2::date, '*', $3::numeric, $4::numeric, $5::numeric, $6::numeric, $7::numeric)
       ON CONFLICT (funnel_id, day, variant) DO UPDATE SET
         revenue_gross_eur = EXCLUDED.revenue_gross_eur,
         revenue_refunded_eur = EXCLUDED.revenue_refunded_eur,
         commissions_eur = EXCLUDED.commissions_eur,
         costs_eur = EXCLUDED.costs_eur,
         ad_spend_eur = EXCLUDED.ad_spend_eur`,
      [funnelId, DAY, r.gross, r.refunded, r.commissions, r.costs, r.adSpend],
    );
  }

  beforeAll(async () => {
    const chau = await getFunnelBySlug('chauhinchazon');
    const reset = await getFunnelBySlug('reset');
    if (!chau || !reset) {
      throw new Error('faltan los funnels del seed: corré npm run db:migrate');
    }
    f1 = { id: chau.id };
    f2 = { id: reset.id };
  });

  it('calcula el profit de TODOS los funnels juntos (fase 3, #15)', async () => {
    // funnel 1: 200 − 0 − 10 − 5 − 85 = 100 · funnel 2: 100 − 10 − 5 − 5 − 30 = 50
    await seedDaily(f1.id, { gross: 200, refunded: 0, commissions: 10, costs: 5, adSpend: 85 });
    await seedDaily(f2.id, { gross: 100, refunded: 10, commissions: 5, costs: 5, adSpend: 30 });

    const res = await financeRollupRange({ from: DAY, to: DAY });
    expect(res.rows).toBe(1);

    const filas = await q<{ day: string; amount_eur: string }>(
      'SELECT day::text AS day, amount_eur::text AS amount_eur FROM finance_daily_profit WHERE day = $1::date',
      [DAY],
    );
    expect(filas).toHaveLength(1);
    expect(filas[0]!.amount_eur).toBe('150.00');
  });

  it('un día sin filas en daily_metrics no escribe fila (no inventa un 0)', async () => {
    const res = await financeRollupRange({ from: DAY, to: DAY });
    expect(res.rows).toBe(0);
  });

  it('recalcula, no acumula: correr dos veces no duplica y pisa el valor viejo', async () => {
    await seedDaily(f1.id, { gross: 200, refunded: 0, commissions: 10, costs: 5, adSpend: 85 });
    await financeRollupRange({ from: DAY, to: DAY });
    // Meta corrige el gasto de ayer: el cron tiene que poder pisar el valor.
    await seedDaily(f1.id, { gross: 200, refunded: 0, commissions: 10, costs: 5, adSpend: 100 });

    const res = await financeRollupRange({ from: DAY, to: DAY });
    expect(res.rows).toBe(1);

    const filas = await q<{ n: string; amount_eur: string }>(
      'SELECT count(*)::text AS n, COALESCE(sum(amount_eur), 0)::text AS amount_eur FROM finance_daily_profit WHERE day = $1::date',
      [DAY],
    );
    expect(filas[0]!.n).toBe('1');
    expect(filas[0]!.amount_eur).toBe('85.00'); // 200 − 0 − 10 − 5 − 100
  });

  it('un día con más gasto que ventas queda en NEGATIVO, no se tapa en 0', async () => {
    await seedDaily(f1.id, { gross: 50, refunded: 0, commissions: 5, costs: 0, adSpend: 120 });

    await financeRollupRange({ from: DAY, to: DAY });

    const filas = await q<{ amount_eur: string }>(
      'SELECT amount_eur::text AS amount_eur FROM finance_daily_profit WHERE day = $1::date',
      [DAY],
    );
    expect(filas[0]!.amount_eur).toBe('-75.00');
  });

  it('main() sin argumentos deja SIEMPRE ayer y hoy registrados (pueden ser 0.00) (T01 §6)', async () => {
    await q('DELETE FROM finance_daily_profit WHERE day >= (now()::date - 2)');

    await main([]);

    const filas = await q<{ day: string; amount_eur: string }>(
      `SELECT day::text AS day, amount_eur::text AS amount_eur
       FROM finance_daily_profit
       WHERE day >= (now()::date - 2)::date
       ORDER BY day`,
    );
    // La base local puede no tener daily_metrics para ayer/hoy: incluso así,
    // el cron materializa las 2 filas con 0.00 — un día ausente del ledger
    // mentiría en el gráfico mensual tanto como una fila falsa.
    expect(filas).toHaveLength(2);
    expect(Number(filas[0]!.amount_eur)).toBeGreaterThanOrEqual(0);
    expect(Number(filas[1]!.amount_eur)).toBeGreaterThanOrEqual(0);
  });
});
