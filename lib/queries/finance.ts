/**
 * Finanzas — el patrimonio del negocio (plan FINANZAS §4, contrato congelado).
 *
 * Todo en EUR, sin conversión (D10). El patrimonio es una SUMA de dos tablas,
 * nunca una columna acumulada (D1): si un día no cierra, se suma a mano y el
 * error aparece; con un running_total desincronizado no habría forma de
 * notarlo.
 *
 * El signo de un movimiento lo garantiza la base con un CHECK (D3), y esta
 * capa aplica la MISMA regla del lado de TypeScript: createMovement recibe el
 * valor absoluto que tipea el usuario y pone el signo según el kind — el
 * formulario nunca le pide a la persona que escriba un número negativo.
 * updateMovement aplica la misma conversión (lee el kind actual de la fila,
 * que no es editable, antes de poner el signo del monto nuevo).
 */

import { q, q1, tx } from '@/lib/db';

// ─── Tipos (plan §4) ────────────────────────────────────────────────────────

export type FinanceMovementKind = 'gasto' | 'retiro' | 'ajuste';
export type FinanceCategory = 'sueldos' | 'herramientas' | 'alquiler' | 'impuestos' | 'otros';

export type FinanceMovement = {
  id: number;
  kind: FinanceMovementKind;
  category: FinanceCategory | null;
  amountEur: number; // negativo en gasto/retiro, cualquier signo != 0 en ajuste
  note: string;
  day: string; // 'YYYY-MM-DD'
  scheduledPaymentId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type ScheduledPayment = {
  id: number;
  name: string;
  category: FinanceCategory;
  amountEur: number; // SIEMPRE positivo: es la plantilla, no un movimiento
  dayOfMonth: number; // 1-28
  active: boolean;
  /** true si ya pasó su día este mes y todavía no generó el gasto (D8). */
  atrasado: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MonthlyPoint = {
  month: string; // 'YYYY-MM'
  profitEur: number; // SUM(finance_daily_profit) del mes, 0 si no hay filas
  movementsEur: number; // SUM(finance_movements) del mes, 0 si no hay filas
  netEur: number; // profitEur + movementsEur
};

export type FinanceOverview = {
  /** SUM(finance_daily_profit) + SUM(finance_movements) de TODO el histórico (D1). */
  patrimonioTotalEur: number;
  /** Los últimos 12 meses, SIEMPRE continuos: un mes sin filas aparece en 0, no se saltea (D-verificado #20). */
  byMonth: MonthlyPoint[];
  /** Pagos programados con atrasado=true. Se muestra como banner. */
  atrasados: ScheduledPayment[];
  generatedAt: string;
};

// ─── Lectura ────────────────────────────────────────────────────────────────

export type MovementsFilters = { from?: string; to?: string; kind?: FinanceMovementKind };

type MovementRow = {
  id: number;
  kind: FinanceMovementKind;
  category: FinanceCategory | null;
  amount_eur: string;
  note: string;
  day: string;
  scheduled_payment_id: number | null;
  created_at: Date;
  updated_at: Date;
};

type ScheduledRow = {
  id: number;
  name: string;
  category: FinanceCategory;
  amount_eur: string;
  day_of_month: number;
  active: boolean;
  created_at: Date;
  updated_at: Date;
};

type MonthRow = {
  month: string;
  profitEur: string;
  movementsEur: string;
};

const MONEY = (v: string): number => Number(v);
const ISO = (d: Date): string => d.toISOString();

const PATRIMONIO_SQL = `
  SELECT
    (SELECT COALESCE(SUM(amount_eur), 0) FROM finance_daily_profit) +
    (SELECT COALESCE(SUM(amount_eur), 0) FROM finance_movements) AS patrimonio_total_eur`;

const BY_MONTH_SQL = `
  WITH meses AS (
    SELECT generate_series(
      date_trunc('month', now() - interval '11 months'),
      date_trunc('month', now()),
      interval '1 month'
    )::date AS mes
  ),
  profit_mes AS (
    SELECT date_trunc('month', day)::date AS mes, SUM(amount_eur) AS profit
    FROM finance_daily_profit GROUP BY 1
  ),
  mov_mes AS (
    SELECT date_trunc('month', day)::date AS mes, SUM(amount_eur) AS movimientos
    FROM finance_movements GROUP BY 1
  )
  SELECT to_char(m.mes, 'YYYY-MM') AS month,
         COALESCE(p.profit, 0)::text AS "profitEur",
         COALESCE(mv.movimientos, 0)::text AS "movementsEur"
  FROM meses m
  LEFT JOIN profit_mes p ON p.mes = m.mes
  LEFT JOIN mov_mes mv ON mv.mes = m.mes
  ORDER BY m.mes`;

// Atrasados (D8): activo, día ya pasado este mes, sin run para el mes actual.
// La garantía de no-duplicación NO es esta consulta sino la PK compuesta de
// finance_scheduled_payment_runs; esta query solo dice "quién está atrasado".
const ATRASADOS_SQL = `
  SELECT sp.*
  FROM finance_scheduled_payments sp
  WHERE sp.active
    AND sp.day_of_month <= EXTRACT(DAY FROM $1::date)::smallint
    AND NOT EXISTS (
      SELECT 1 FROM finance_scheduled_payment_runs r
      WHERE r.scheduled_payment_id = sp.id AND r.month = to_char($1::date, 'YYYY-MM')
    )`;

const LIST_MOVEMENTS_SQL = `
  SELECT id, kind, category, amount_eur::text AS amount_eur, note, day::text AS day,
         scheduled_payment_id, created_at, updated_at
  FROM finance_movements
  WHERE ($1::date IS NULL OR day >= $1::date)
    AND ($2::date IS NULL OR day <= $2::date)
    AND ($3::text IS NULL OR kind = $3)
  ORDER BY day DESC, id DESC`;

const LIST_SCHEDULED_SQL = `
  SELECT id, name, category, amount_eur::text AS amount_eur, day_of_month,
         active, created_at, updated_at
  FROM finance_scheduled_payments
  ORDER BY day_of_month, name`;

function toMovement(r: MovementRow): FinanceMovement {
  return {
    // bigserial viene como string de node-pg: el contrato del plan promete
    // number, y zod (T02) valida los ids del PATCH como z.number().
    id: Number(r.id),
    kind: r.kind,
    category: r.category,
    amountEur: MONEY(r.amount_eur),
    note: r.note,
    day: r.day,
    scheduledPaymentId: r.scheduled_payment_id === null ? null : Number(r.scheduled_payment_id),
    createdAt: ISO(r.created_at),
    updatedAt: ISO(r.updated_at),
  };
}

function toScheduled(r: ScheduledRow, atrasado: boolean): ScheduledPayment {
  return {
    id: Number(r.id),
    name: r.name,
    category: r.category,
    amountEur: MONEY(r.amount_eur),
    dayOfMonth: r.day_of_month,
    active: r.active,
    atrasado,
    createdAt: ISO(r.created_at),
    updatedAt: ISO(r.updated_at),
  };
}

export async function getFinanceOverview(): Promise<FinanceOverview> {
  const [patRow, monthRows, scheduledRows] = await Promise.all([
    q1<{ patrimonio_total_eur: string }>(PATRIMONIO_SQL),
    q<MonthRow>(BY_MONTH_SQL),
    q<ScheduledRow>(LIST_SCHEDULED_SQL),
  ]);

  const hoy = await q1<{ day: string }>(
    `SELECT (now() AT TIME ZONE $1)::date::text AS day`,
    [process.env.DASHBOARD_TZ ?? 'America/Argentina/Buenos_Aires'],
  );
  const atrasadoIds = new Set(
    (await q<{ id: number }>(ATRASADOS_SQL, [hoy!.day])).map((r) => r.id),
  );

  // El neto de cada mes se suma en JS, después del COALESCE en SQL: las dos
  // CTEs están LEFT JOINadas y sumarlas en SQL arrastraría NULL si alguna de
  // las dos no tiene filas ese mes.
  const byMonth: MonthlyPoint[] = monthRows.map((r) => ({
    month: r.month,
    profitEur: MONEY(r.profitEur),
    movementsEur: MONEY(r.movementsEur),
    netEur: MONEY(r.profitEur) + MONEY(r.movementsEur),
  }));

  return {
    patrimonioTotalEur: MONEY(patRow!.patrimonio_total_eur),
    byMonth,
    atrasados: scheduledRows.filter((r) => atrasadoIds.has(r.id)).map((r) => toScheduled(r, true)),
    generatedAt: new Date().toISOString(),
  };
}

export async function listMovements(f: MovementsFilters): Promise<FinanceMovement[]> {
  const rows = await q<MovementRow>(LIST_MOVEMENTS_SQL, [f.from ?? null, f.to ?? null, f.kind ?? null]);
  return rows.map(toMovement);
}

export async function listScheduledPayments(): Promise<ScheduledPayment[]> {
  const rows = await q<ScheduledRow>(LIST_SCHEDULED_SQL);
  const atrasados = await Promise.all(rows.map((r) => isAtrasado(r.id)));
  return rows.map((r, i) => toScheduled(r, atrasados[i]!));
}

// ─── Escritura ──────────────────────────────────────────────────────────────

/**
 * El signo del monto lo pone ESTA función, no quien la llama (plan §4 regla 1):
 * para gasto/retiro el formulario manda el valor absoluto y acá se aplica
 * -Math.abs(); para ajuste se respeta el signo que ya viene (la UI lo manda
 * con su toggle +/−, porque un ajuste puede ir en cualquier dirección).
 */
export function applySign(kind: FinanceMovementKind, amountEur: number): number {
  return kind === 'ajuste' ? amountEur : -Math.abs(amountEur);
}

type MovementWriteRow = {
  id: number;
  kind: FinanceMovementKind;
  category: FinanceCategory | null;
  amount_eur: string;
  note: string;
  day: string;
  scheduled_payment_id: number | null;
  created_at: Date;
  updated_at: Date;
};

const MOVEMENT_BY_ID_SQL = `SELECT kind FROM finance_movements WHERE id = $1`;

const INSERT_MOVEMENT_SQL = `
  INSERT INTO finance_movements (kind, category, amount_eur, note, day)
  VALUES ($1, $2, $3::numeric, $4, $5::date)
  RETURNING id, kind, category, amount_eur::text AS amount_eur, note, day::text AS day,
            scheduled_payment_id, created_at, updated_at`;

const UPDATE_MOVEMENT_SQL = `
  UPDATE finance_movements
  SET category = COALESCE($2, category),
      amount_eur = $3::numeric,
      note = COALESCE($4, note),
      day = COALESCE($5::date, day)
  WHERE id = $1
  RETURNING id, kind, category, amount_eur::text AS amount_eur, note, day::text AS day,
            scheduled_payment_id, created_at, updated_at`;

function isCheckViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23514'
  );
}

/** Traduce un CHECK violado de la base a un mensaje entendible (D3/D4). */
function movementErrorMessage(err: unknown): Error {
  if (isCheckViolation(err)) {
    return new Error('el monto de un gasto/retiro tiene que ser negativo (o la categoría es inválida)');
  }
  return err instanceof Error ? err : new Error(String(err));
}

export async function createMovement(input: {
  kind: FinanceMovementKind;
  category: FinanceCategory | null;
  amountEur: number;
  note: string;
  day: string;
}): Promise<FinanceMovement> {
  const signed = applySign(input.kind, input.amountEur);
  try {
    const rows = await q<MovementWriteRow>(INSERT_MOVEMENT_SQL, [
      input.kind,
      input.category,
      String(signed),
      input.note,
      input.day,
    ]);
    return toMovement(rows[0]!);
  } catch (err) {
    throw movementErrorMessage(err);
  }
}

export async function updateMovement(
  id: number,
  input: Partial<{
    category: FinanceCategory | null;
    amountEur: number;
    note: string;
    day: string;
  }>,
): Promise<FinanceMovement> {
  let signed = input.amountEur;
  if (input.amountEur !== undefined) {
    // El kind no es editable: el de la fila existente es el que corresponde.
    // Sin este SELECT, editar un gasto con el valor absoluto invertiría el
    // signo en la base sin que nadie lo note (plan §4 regla 1).
    const row = await q1<{ kind: FinanceMovementKind }>(MOVEMENT_BY_ID_SQL, [id]);
    if (!row) throw new Error('movimiento no encontrado');
    signed = applySign(row.kind, input.amountEur);
  }
  const rows = await q<MovementWriteRow>(UPDATE_MOVEMENT_SQL, [
    id,
    input.category === undefined ? null : input.category,
    String(signed),
    input.note ?? null,
    input.day ?? null,
  ]);
  if (rows.length === 0) throw new Error('movimiento no encontrado');
  return toMovement(rows[0]!);
}

export async function deleteMovement(id: number): Promise<void> {
  await q(`DELETE FROM finance_movements WHERE id = $1`, [id]);
}

// ─── Pagos programados ──────────────────────────────────────────────────────

const INSERT_SCHEDULED_SQL = `
  INSERT INTO finance_scheduled_payments (name, category, amount_eur, day_of_month)
  VALUES ($1, $2, $3::numeric, $4)
  RETURNING id, name, category, amount_eur::text AS amount_eur, day_of_month,
            active, created_at, updated_at`;

const UPDATE_SCHEDULED_SQL = `
  UPDATE finance_scheduled_payments
  SET name = COALESCE($2, name),
      category = COALESCE($3, category),
      amount_eur = COALESCE($4::numeric, amount_eur),
      day_of_month = COALESCE($5, day_of_month),
      active = COALESCE($6, active)
  WHERE id = $1
  RETURNING id, name, category, amount_eur::text AS amount_eur, day_of_month,
            active, created_at, updated_at`;

export async function createScheduledPayment(input: {
  name: string;
  category: FinanceCategory;
  amountEur: number;
  dayOfMonth: number;
}): Promise<ScheduledPayment> {
  const rows = await q<ScheduledRow>(INSERT_SCHEDULED_SQL, [
    input.name,
    input.category,
    String(input.amountEur),
    input.dayOfMonth,
  ]);
  return toScheduled(rows[0]!, await isAtrasado(rows[0]!.id));
}

export async function updateScheduledPayment(
  id: number,
  input: Partial<{
    name: string;
    category: FinanceCategory;
    amountEur: number;
    dayOfMonth: number;
    active: boolean;
  }>,
): Promise<ScheduledPayment> {
  const rows = await q<ScheduledRow>(UPDATE_SCHEDULED_SQL, [
    id,
    input.name ?? null,
    input.category ?? null,
    input.amountEur === undefined ? null : String(input.amountEur),
    input.dayOfMonth ?? null,
    input.active === undefined ? null : input.active,
  ]);
  if (rows.length === 0) throw new Error('pago programado no encontrado');
  return toScheduled(rows[0]!, await isAtrasado(id));
}

async function isAtrasado(id: number): Promise<boolean> {
  const hoy = await q1<{ day: string }>(
    `SELECT (now() AT TIME ZONE $1)::date::text AS day`,
    [process.env.DASHBOARD_TZ ?? 'America/Argentina/Buenos_Aires'],
  );
  const row = await q1<{ id: number }>(
    `SELECT sp.id FROM finance_scheduled_payments sp
     WHERE sp.id = $1 AND sp.active
       AND sp.day_of_month <= EXTRACT(DAY FROM $2::date)::smallint
       AND NOT EXISTS (
         SELECT 1 FROM finance_scheduled_payment_runs r
         WHERE r.scheduled_payment_id = sp.id AND r.month = to_char($2::date, 'YYYY-MM')
       )`,
    [id, hoy!.day],
  );
  return row !== null;
}

export async function deleteScheduledPayment(id: number): Promise<void> {
  await q(`DELETE FROM finance_scheduled_payments WHERE id = $1`, [id]);
}

// ─── Ejecución de pagos programados ─────────────────────────────────────────

export async function runScheduledPayments(
  today: string,
): Promise<{ ejecutados: string[] }> {
  const atrasados = await q<ScheduledRow & { atrasado: boolean }>(
    `
    SELECT sp.id, sp.name, sp.category, sp.amount_eur::text AS amount_eur,
           sp.day_of_month, sp.active, sp.created_at, sp.updated_at
    FROM finance_scheduled_payments sp
    WHERE sp.active
      AND sp.day_of_month <= EXTRACT(DAY FROM $1::date)::smallint
      AND NOT EXISTS (
        SELECT 1 FROM finance_scheduled_payment_runs r
        WHERE r.scheduled_payment_id = sp.id AND r.month = to_char($1::date, 'YYYY-MM')
      )
    ORDER BY sp.id`,
    [today],
  );

  const ejecutados: string[] = [];
  const month = today.slice(0, 7);

  for (const sp of atrasados) {
    try {
      // Las dos inserciones van en la MISMA transacción: si el proceso muere
      // entre el movimiento y el run, la próxima corrida vería el pago "sin
      // ejecutar" y duplicaría el gasto (plan §4 regla 4).
      await tx(async (c) => {
        const mv = await c.query<{ id: number }>(
          `INSERT INTO finance_movements (kind, category, amount_eur, note, day, scheduled_payment_id)
           VALUES ('gasto', $1, $2::numeric, $3, $4::date, $5)
           RETURNING id`,
          [sp.category, -Math.abs(MONEY(sp.amount_eur)), `${sp.name} (automático)`, today, sp.id],
        );
        // La PK (scheduled_payment_id, month) es la garantía ESTRUCTURAL (D7):
        // si ya hay un run para este mes (una carrera entre el cron y el botón
        // manual), el ON CONFLICT devuelve 0 filas y el throw hace ROLLBACK de
        // TODO — el movimiento que recién se insertó también se descarta, así
        // que no queda un gasto sin su run esperando a duplicarse en la
        // próxima corrida.
        const run = await c.query(
          `INSERT INTO finance_scheduled_payment_runs (scheduled_payment_id, month, movement_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (scheduled_payment_id, month) DO NOTHING`,
          [sp.id, month, mv.rows[0]!.id],
        );
        if (run.rowCount === 0) {
          throw new Error(`el pago ${sp.name} ya se ejecutó en ${month}`);
        }
      });
      ejecutados.push(sp.name);
    } catch {
      // Un pago roto no bloquea a los demás: el error se reporta en el
      // resultado, no se aborta toda la corrida (plan §4 regla 4).
    }
  }

  return { ejecutados };
}
