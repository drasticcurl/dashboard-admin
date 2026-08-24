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
  /**
   * Hoy en la TZ del dashboard, 'YYYY-MM-DD'. Va en el overview porque ya se
   * calcula acá para los atrasados, y porque el formulario lo necesita como
   * fecha por defecto: si el cliente lo calculara con la TZ del browser, un
   * movimiento cargado de noche podría quedar con el día de mañana.
   */
  hoy: string;
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
//
// LA CONDICIÓN ESTÁ ESCRITA UNA SOLA VEZ, ACÁ. Antes vivía copiada en tres
// lugares (el overview, el chequeo de un pago suelto y la corrida del cron) y
// las tres tenían que decir exactamente lo mismo para que la pantalla y lo que
// hace el cron no se contradijeran. Tres copias de una regla de negocio son
// tres oportunidades de que una quede vieja. `$1` es SIEMPRE el día de hoy.
const COND_ATRASADO = `
    sp.active
    AND sp.day_of_month <= EXTRACT(DAY FROM $1::date)::smallint
    AND NOT EXISTS (
      SELECT 1 FROM finance_scheduled_payment_runs r
      WHERE r.scheduled_payment_id = sp.id AND r.month = to_char($1::date, 'YYYY-MM')
    )`;

const COLS_SCHEDULED = `sp.id, sp.name, sp.category, sp.amount_eur::text AS amount_eur,
         sp.day_of_month, sp.active, sp.created_at, sp.updated_at`;

const ATRASADOS_SQL = `
  SELECT ${COLS_SCHEDULED}
  FROM finance_scheduled_payments sp
  WHERE ${COND_ATRASADO}
  ORDER BY sp.id`;

const ATRASADOS_IDS_SQL = `
  SELECT sp.id
  FROM finance_scheduled_payments sp
  WHERE ${COND_ATRASADO}`;

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

/** El día de hoy en la TZ del dashboard. Un solo lugar que lo resuelve. */
async function hoyEnTz(): Promise<string> {
  const row = await q1<{ day: string }>(
    `SELECT (now() AT TIME ZONE $1)::date::text AS day`,
    [process.env.DASHBOARD_TZ ?? 'America/Argentina/Buenos_Aires'],
  );
  return row!.day;
}

/**
 * Los ids de los pagos atrasados a una fecha, en UNA query, sirva para uno o
 * para cien. Los ids se guardan como string porque `bigserial` llega como
 * string de node-pg: comparar contra un number daría siempre false.
 */
async function idsAtrasados(hoy: string): Promise<Set<string>> {
  const rows = await q<{ id: string }>(ATRASADOS_IDS_SQL, [hoy]);
  return new Set(rows.map((r) => String(r.id)));
}

export async function getFinanceOverview(): Promise<FinanceOverview> {
  const [patRow, monthRows, scheduledRows, hoy] = await Promise.all([
    q1<{ patrimonio_total_eur: string }>(PATRIMONIO_SQL),
    q<MonthRow>(BY_MONTH_SQL),
    q<ScheduledRow>(LIST_SCHEDULED_SQL),
    hoyEnTz(),
  ]);

  const atrasadoIds = await idsAtrasados(hoy);

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
    atrasados: scheduledRows
      .filter((r) => atrasadoIds.has(String(r.id)))
      .map((r) => toScheduled(r, true)),
    hoy,
    generatedAt: new Date().toISOString(),
  };
}

export async function listMovements(f: MovementsFilters): Promise<FinanceMovement[]> {
  const rows = await q<MovementRow>(LIST_MOVEMENTS_SQL, [f.from ?? null, f.to ?? null, f.kind ?? null]);
  return rows.map(toMovement);
}

/**
 * TRES queries, no `1 + 2N`. Antes esto llamaba `isAtrasado` por fila y cada
 * llamada hacía dos queries más: con 6 pagos eran 13 viajes a la base contra un
 * pool de 10 conexiones, y el costo crecía con cada pago que el usuario cargara.
 * El set de atrasados se resuelve de una sola vez con la misma condición que usa
 * el resto del módulo.
 */
export async function listScheduledPayments(): Promise<ScheduledPayment[]> {
  const [rows, hoy] = await Promise.all([q<ScheduledRow>(LIST_SCHEDULED_SQL), hoyEnTz()]);
  const atrasados = await idsAtrasados(hoy);
  return rows.map((r) => toScheduled(r, atrasados.has(String(r.id))));
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

const MOVEMENT_BY_ID_SQL = `
  SELECT kind, category, amount_eur::text AS amount_eur, note, day::text AS day
  FROM finance_movements WHERE id = $1`;

const INSERT_MOVEMENT_SQL = `
  INSERT INTO finance_movements (kind, category, amount_eur, note, day)
  VALUES ($1, $2, $3::numeric, $4, $5::date)
  RETURNING id, kind, category, amount_eur::text AS amount_eur, note, day::text AS day,
            scheduled_payment_id, created_at, updated_at`;

// Todos los campos van EXPLÍCITOS, sin COALESCE. Con `COALESCE($2, category)`
// era imposible borrar la categoría (mandar null y "no mandar nada" eran lo
// mismo para la base), y `amount_eur = $3::numeric` sin COALESCE reventaba con
// `invalid input syntax for numeric: "undefined"` cuando el PATCH no traía
// monto. Ahora los valores finales se resuelven en JS contra la fila que ya
// existe y el UPDATE escribe los cinco campos siempre.
const UPDATE_MOVEMENT_SQL = `
  UPDATE finance_movements
  SET kind = $2,
      category = $3,
      amount_eur = $4::numeric,
      note = $5,
      day = $6::date
  WHERE id = $1
  RETURNING id, kind, category, amount_eur::text AS amount_eur, note, day::text AS day,
            scheduled_payment_id, created_at, updated_at`;

/**
 * Un pedido mal armado, no una falla del servidor. Existe para que los routes
 * puedan contestar 400 con un mensaje legible sin comparar el texto del error:
 * antes un CHECK violado en un PATCH salía como 500 con el SQLSTATE crudo.
 */
export class FinanceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FinanceInputError';
  }
}

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
    return new FinanceInputError(
      'el monto de un gasto/retiro tiene que ser negativo (o la categoría es inválida)',
    );
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

/**
 * Edita un movimiento. Todo lo que no venga en `input` se queda como está.
 *
 * El `kind` SÍ se puede cambiar (antes el route lo descartaba en silencio y le
 * decía "actualizado" al usuario mientras el tipo seguía igual). Cambiarlo tiene
 * dos consecuencias que se resuelven acá y no en el que llama:
 *
 *  · El signo se recalcula contra el kind FINAL. Pasar un ajuste de +300 a
 *    gasto tiene que dejar −300, no +300: si no, un gasto sumaría al patrimonio
 *    en vez de restar, y el CHECK de la base lo rechazaría de todas formas con
 *    un error ilegible.
 *  · La categoría se limpia sola cuando el tipo deja de ser gasto, porque el
 *    CHECK `finance_movements_categoria_solo_gasto` exige que sea NULL. Antes
 *    esto llegaba crudo a Postgres y salía un 500 con el nombre del constraint.
 */
export async function updateMovement(
  id: number,
  input: Partial<{
    kind: FinanceMovementKind;
    category: FinanceCategory | null;
    amountEur: number;
    note: string;
    day: string;
  }>,
): Promise<FinanceMovement> {
  const actual = await q1<{
    kind: FinanceMovementKind;
    category: FinanceCategory | null;
    amount_eur: string;
    note: string;
    day: string;
  }>(MOVEMENT_BY_ID_SQL, [id]);
  if (!actual) throw new Error('movimiento no encontrado');

  const kind = input.kind ?? actual.kind;

  // Si vino monto nuevo se usa ése; si no, el que ya estaba. En los dos casos
  // pasa por applySign con el kind final, que es lo que arregla el cambio de
  // tipo: applySign('gasto', 300) → −300, applySign('ajuste', −300) → −300.
  const signed = applySign(kind, input.amountEur ?? MONEY(actual.amount_eur));

  let category = input.category !== undefined ? input.category : actual.category;
  if (kind !== 'gasto') category = null;
  if (kind === 'gasto' && category === null) {
    // Mismo mensaje que valida el route en el POST: un gasto sin categoría no
    // existe. Se chequea acá también porque acá es donde se conoce el kind final.
    throw new FinanceInputError('un gasto necesita categoría');
  }

  try {
    const rows = await q<MovementWriteRow>(UPDATE_MOVEMENT_SQL, [
      id,
      kind,
      category,
      String(signed),
      input.note ?? actual.note,
      input.day ?? actual.day,
    ]);
    if (rows.length === 0) throw new Error('movimiento no encontrado');
    return toMovement(rows[0]!);
  } catch (err) {
    // Igual que createMovement: un CHECK violado sale como un mensaje que se
    // puede leer, no como el SQLSTATE crudo (D3/D4).
    throw movementErrorMessage(err);
  }
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

/**
 * Si UN pago está atrasado. Usa exactamente la misma condición que la lista y
 * que el cron (COND_ATRASADO), así que las tres respuestas no pueden diferir.
 */
async function isAtrasado(id: number): Promise<boolean> {
  const hoy = await hoyEnTz();
  const row = await q1<{ id: string }>(
    `SELECT sp.id FROM finance_scheduled_payments sp WHERE sp.id = $2 AND ${COND_ATRASADO}`,
    [hoy, id],
  );
  return row !== null;
}

export async function deleteScheduledPayment(id: number): Promise<void> {
  await q(`DELETE FROM finance_scheduled_payments WHERE id = $1`, [id]);
}

// ─── Ejecución de pagos programados ─────────────────────────────────────────

export type ScheduledRunResult = {
  ejecutados: string[];
  /** Los que NO se pudieron generar, con el motivo. Nunca se descartan. */
  fallidos: { name: string; error: string }[];
};

export async function runScheduledPayments(today: string): Promise<ScheduledRunResult> {
  const atrasados = await q<ScheduledRow>(ATRASADOS_SQL, [today]);

  const ejecutados: string[] = [];
  const fallidos: { name: string; error: string }[] = [];
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
    } catch (err) {
      // Un pago roto no bloquea a los demás, PERO TAMPOCO DESAPARECE. Antes acá
      // había un `catch {}` vacío: el gasto no se generaba, el pago seguía
      // marcado como atrasado y la pantalla contestaba "No hay pagos atrasados
      // para ejecutar" en verde. Un gasto que no se carga y nadie ve es
      // exactamente la clase de silencio que hace que el patrimonio mienta.
      const error = err instanceof Error ? err.message : String(err);
      fallidos.push({ name: sp.name, error });
      console.error(`[finanzas] el pago programado "${sp.name}" (id ${sp.id}) falló: ${error}`);
    }
  }

  return { ejecutados, fallidos };
}
