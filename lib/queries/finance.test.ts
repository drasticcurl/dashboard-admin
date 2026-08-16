/**
 * Tests de Finanzas — lib/queries/finance.ts (T01, sección 5).
 *
 * Todo el bloque de movimientos corre contra Postgres real: el signo y la
 * categoría son garantías de la BASE (CHECKs, D3/D4), no del código que
 * llama — no se pueden testear con mocks. Sin DATABASE_URL se salta, igual
 * que los otros tests de integración.
 *
 * Aislamiento: los movimientos de prueba llevan note con prefijo
 * 'test-finanzas-' y los pagos programados name con el mismo prefijo; el
 * cleanup borra por ese prefijo. Un run muerto a mitad de camino no deja
 * filas fantasma porque el prefijo es único de los tests.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { q } from '../db';
import {
  createMovement,
  getFinanceOverview,
  runScheduledPayments,
  updateMovement,
  type FinanceCategory,
} from './finance';

// vitest no carga .env solo (mismo patrón que lib/queries/funnel.test.ts):
// cargarlo acá hace que la suite corra contra la base real en vez de
// saltarse en silencio.
if (typeof process.loadEnvFile === 'function' && existsSync(path.join(process.cwd(), '.env'))) {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
}

const dbAvailable = Boolean(process.env.DATABASE_URL);

// Un día fijo de prueba, lejos de los datos reales (que caen en el día de
// hoy). Los pagos con day_of_month 5/6/7 ya pasaron para TODAY.
const TODAY = '2026-08-20';
const PREFIX = 'test-finanzas-';
const notes = (s: string) => `${PREFIX}${s}`;
const names = (s: string) => `${PREFIX}${s}`;

async function seedScheduled(
  name: string,
  category: FinanceCategory,
  amountEur: number,
  dayOfMonth: number,
  active = true,
): Promise<number> {
  const rows = await q<{ id: number }>(
    `INSERT INTO finance_scheduled_payments (name, category, amount_eur, day_of_month, active)
     VALUES ($1, $2, $3::numeric, $4, $5)
     RETURNING id`,
    [name, category, amountEur, dayOfMonth, active],
  );
  return rows[0]!.id;
}

describe.skipIf(!dbAvailable)('createMovement', () => {
  afterEach(cleanup);

  it('1. el signo se aplica en la función: gasto 500 → -500, retiro 300 → -300, ajuste -50 tal cual', async () => {
    const gasto = await createMovement({ kind: 'gasto', category: 'sueldos', amountEur: 500, note: notes('1-gasto'), day: '2026-08-01' });
    expect(gasto.amountEur).toBe(-500);

    const retiro = await createMovement({ kind: 'retiro', category: null, amountEur: 300, note: notes('1-retiro'), day: '2026-08-01' });
    expect(retiro.amountEur).toBe(-300);

    const ajuste = await createMovement({ kind: 'ajuste', category: null, amountEur: -50, note: notes('1-ajuste'), day: '2026-08-01' });
    expect(ajuste.amountEur).toBe(-50);

    // Un ajuste positivo también respeta el signo (la UI manda el signo ya puesto).
    const ajustePos = await createMovement({ kind: 'ajuste', category: null, amountEur: 25, note: notes('1-ajuste-pos'), day: '2026-08-01' });
    expect(ajustePos.amountEur).toBe(25);
  });

  it('1b. el signo se aplica IGUAL en updateMovement: editar un gasto a 600 lo deja en -600', async () => {
    const creado = await createMovement({ kind: 'gasto', category: 'herramientas', amountEur: 500, note: notes('1b'), day: '2026-08-01' });
    expect(creado.amountEur).toBe(-500);

    const editado = await updateMovement(creado.id, { amountEur: 600 });
    expect(editado.amountEur).toBe(-600);

    const enBase = await q<{ amount_eur: string }>(
      'SELECT amount_eur::text AS amount_eur FROM finance_movements WHERE id = $1',
      [creado.id],
    );
    expect(enBase[0]!.amount_eur).toBe('-600.00');
  });

  it('2. un gasto sin categoría falla con mensaje entendible (D4)', async () => {
    await expect(
      createMovement({ kind: 'gasto', category: null, amountEur: 500, note: notes('2'), day: '2026-08-01' }),
    ).rejects.toThrow('el monto de un gasto/retiro tiene que ser negativo (o la categoría es inválida)');
  });

  it('3. un retiro CON categoría falla (D4 visto desde TypeScript, no solo desde SQL)', async () => {
    await expect(
      createMovement({ kind: 'retiro', category: 'otros', amountEur: 200, note: notes('3'), day: '2026-08-01' }),
    ).rejects.toThrow('el monto de un gasto/retiro tiene que ser negativo (o la categoría es inválida)');
  });
});

describe.skipIf(!dbAvailable)('getFinanceOverview', () => {
  afterEach(cleanup);

  it('4. byMonth es continuo: un mes sin filas aparece en 0, no se saltea', async () => {
    await q(`INSERT INTO finance_daily_profit (day, amount_eur) VALUES
      ('2026-06-05', 100.00), ('2026-06-20', 50.00), ('2026-08-01', 40.00), ('2026-08-15', -10.00)`);

    const overview = await getFinanceOverview();

    const porMes = new Map(overview.byMonth.map((p) => [p.month, p]));
    const junio = porMes.get('2026-06');
    const julio = porMes.get('2026-07');
    const agosto = porMes.get('2026-08');

    expect(junio?.profitEur).toBe(150);
    expect(julio?.profitEur).toBe(0); // julio sin filas de profit: 0, no desaparece
    expect(agosto?.profitEur).toBe(30);
    expect(overview.byMonth.length).toBe(12); // SIEMPRE los últimos 12 meses
    expect(overview.byMonth[0]!.month < overview.byMonth[1]!.month).toBe(true);
  });
});

describe.skipIf(!dbAvailable)('runScheduledPayments', () => {
  afterEach(cleanup);

  it('5. un pago pausado (active=false) nunca genera un movimiento', async () => {
    const id = await seedScheduled(names('pausado'), 'otros', 15, 5, false);

    const res = await runScheduledPayments(TODAY);

    expect(res.ejecutados).toHaveLength(0);
    const filas = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM finance_movements WHERE scheduled_payment_id = $1`,
      [id],
    );
    expect(filas[0]!.n).toBe('0');
  });

  it('6. correr dos veces el mismo día no duplica el gasto, y la segunda corrida no revienta', async () => {
    const id = await seedScheduled(names('alquiler'), 'alquiler', 400, 5);

    const primera = await runScheduledPayments(TODAY);
    expect(primera.ejecutados).toHaveLength(1);

    const segunda = await runScheduledPayments(TODAY);
    expect(segunda.ejecutados).toHaveLength(0);

    const filas = await q<{ n: string; monto: string }>(
      `SELECT count(*)::text AS n, COALESCE(sum(amount_eur), 0)::text AS monto
       FROM finance_movements WHERE scheduled_payment_id = $1`,
      [id],
    );
    expect(filas[0]!.n).toBe('1');
    expect(filas[0]!.monto).toBe('-400.00');
  });

  it('7. un pago roto en el medio no bloquea a los demás', async () => {
    const a = await seedScheduled(names('pago-a'), 'alquiler', 400, 5);
    // Pago B: categoría inválida, insertada directo saltando el CHECK de la
    // tabla de pagos — así la inserción del movimiento SÍ falla (CHECK de
    // finance_movements) cuando el cron la ejecuta. PostgreSQL no deja
    // "deshabilitar" un CHECK: se DROP y se re-ADD con NOT VALID, que no
    // valida las filas viejas (solo se usa acá y se vuelve a activar
    // siempre, en el finally, para no dejar la tabla sin constraint).
    await q('ALTER TABLE finance_scheduled_payments DROP CONSTRAINT finance_scheduled_payments_categoria_valida');
    try {
      await q(
        `INSERT INTO finance_scheduled_payments (name, category, amount_eur, day_of_month)
         VALUES ($1, 'inventada', 100, 6)`,
        [names('pago-b')],
      );
    } finally {
      await q(
        `ALTER TABLE finance_scheduled_payments ADD CONSTRAINT finance_scheduled_payments_categoria_valida
         CHECK (category IN ('sueldos', 'herramientas', 'alquiler', 'impuestos', 'otros')) NOT VALID`,
      );
    }
    const c = await seedScheduled(names('pago-c'), 'herramientas', 50, 7);

    const res = await runScheduledPayments(TODAY);

    expect(res.ejecutados).toHaveLength(2); // A y C, no B
    for (const id of [a, c]) {
      const filas = await q<{ n: string }>(
        `SELECT count(*)::text AS n FROM finance_movements WHERE scheduled_payment_id = $1`,
        [id],
      );
      expect(filas[0]!.n).toBe('1');
    }
  });
});

async function cleanup(): Promise<void> {
  // Borrar los pagos de prueba primero (cascade a finance_scheduled_payment_runs);
  // los movimientos que generaron quedan con scheduled_payment_id NULL (D9) y
  // se borran por el prefijo de note. El PREFIX es texto plano de los tests:
  // la interpolación acá es de constantes del propio archivo, nunca de input.
  await q(`DELETE FROM finance_scheduled_payments WHERE name LIKE '${PREFIX}%'`);
  await q(`DELETE FROM finance_movements WHERE note LIKE '${PREFIX}%'`);
  await q(`DELETE FROM finance_daily_profit WHERE day IN ('2026-06-05', '2026-06-20', '2026-08-01', '2026-08-15')`);
}
