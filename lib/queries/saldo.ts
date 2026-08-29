/**
 * Saldo por cuentas — el patrimonio se MIDE, no se calcula.
 * Plan `tasks/saldo-cuentas/00-PLAN-SALDO.md` §4, contrato congelado.
 *
 * Deroga el D1 del módulo viejo (`tasks/finanzas/`), donde el patrimonio era
 * `SUM(finance_daily_profit) + SUM(finance_movements)` y el primer término salía
 * de `daily_metrics`, o sea de lo que reporta Meta. Acá el usuario tipea una vez
 * al día cuánto hay en cada cuenta y el patrimonio es la suma con el signo de
 * cada tipo. `finance_movements` ya NO suma al patrimonio: un saldo tipeado ya
 * incluye los gastos (cuando se paga el alquiler, el banco ya bajó), así que
 * sumarle los movimientos cuenta el mismo gasto dos veces.
 *
 * Las tres cosas que este archivo tiene que garantizar, en orden de qué tan
 * caro es equivocarse:
 *
 *  1. Un día al que le falta una cuenta devuelve `null`, NUNCA un total
 *     parcial (D5). Un total incompleto no es un número que falta: es un número
 *     equivocado que se ve igual de bien que uno correcto.
 *  2. La ganancia de un mes descuenta los retiros Y los aportes (D7). Sin el
 *     término de aportes, el mes en que el usuario transfiere plata propia el
 *     gráfico dice que el negocio la ganó.
 *  3. La vigencia de una cuenta participa de la aritmética (D6). Sin
 *     `opened_on`, crear una cuenta nueva deja incompletos todos los días
 *     anteriores y el gráfico entero desaparece.
 */

import { q, q1, tx } from '@/lib/db';

// ─── Tipos (plan §4) ────────────────────────────────────────────────────────

export type AccountKind = 'dinero' | 'retenido' | 'deuda';

export const ACCOUNT_KINDS: readonly AccountKind[] = ['dinero', 'retenido', 'deuda'] as const;

export type FinanceAccount = {
  id: number;
  name: string;
  kind: AccountKind;
  /** Desde qué día se le pide saldo a esta cuenta, 'YYYY-MM-DD' (D6). */
  openedOn: string;
  /** null = sigue vigente. */
  closedOn: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

/** Una cuenta con su saldo de UN día puntual. Lo que consume el formulario. */
export type AccountWithBalance = FinanceAccount & {
  /** null = ese día todavía no se cargó esta cuenta. NUNCA 0 por defecto (D5). */
  amountEur: number | null;
  note: string | null;
  /** amountEur con el signo del kind ya aplicado: negativo si kind === 'deuda'. */
  signedEur: number | null;
};

/** El patrimonio de un día, con el desglose y el estado de completitud. */
export type PatrimonioDia = {
  day: string;
  /** null si el día está INCOMPLETO. Nunca un total parcial (D5). */
  totalEur: number | null;
  dineroEur: number;
  retenidoEur: number;
  /** POSITIVO (lo que se debe). `totalEur` lo RESTA. Ver §4 regla 6. */
  deudaEur: number;
  /** Cuentas vigentes ese día (D6). */
  esperadas: number;
  cargadas: number;
  completo: boolean;
  /** Nombres de las cuentas vigentes sin saldo ese día. Alimenta el banner (D9). */
  faltan: string[];
};

export type PuntoDiario = {
  day: string;
  /** null en día incompleto o sin carga (D5, D12). */
  totalEur: number | null;
};

export type PuntoMensual = {
  month: string;
  /** Patrimonio del último día COMPLETO del mes (D8). */
  cierreEur: number | null;
  diaCierre: string | null;
  /** <= 0 */
  retirosEur: number;
  /** >= 0 */
  aportesEur: number;
  /** Δ − retiros − aportes. null si falta el cierre de este mes o del anterior (D7, D8). */
  gananciaEur: number | null;
};

export type SaldoOverview = {
  /** El último día COMPLETO. null si nunca se completó uno (D3). */
  ultimo: PatrimonioDia | null;
  /** El estado de HOY: sirve para el banner y para precargar el formulario. */
  hoy: PatrimonioDia;
  /** Las cuentas vigentes hoy, con el saldo de hoy si ya se cargó. */
  cuentas: AccountWithBalance[];
  /** Hoy en DASHBOARD_TZ, resuelto en el server. */
  hoyStr: string;
  generatedAt: string;
};

/**
 * Un pedido mal armado, no una falla del servidor. Existe para que los routes
 * puedan contestar 400 con un mensaje legible sin comparar el texto del error,
 * igual que `FinanceInputError` en `finance.ts`.
 */
export class SaldoInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaldoInputError';
  }
}

// ─── Helpers de conversión ──────────────────────────────────────────────────

// `numeric` vuelve como string de node-pg: sin el casteo explícito los montos
// llegan como texto y `a + b` los concatena en vez de sumarlos.
const MONEY = (v: string): number => Number(v);
const MONEY_N = (v: string | null): number | null => (v === null ? null : Number(v));
const ISO = (d: Date): string => d.toISOString();

/**
 * El signo con el que una cuenta entra al patrimonio. Pura y testeable sin base.
 *
 * El monto se guarda SIEMPRE >= 0 (lo garantiza un CHECK) y el signo lo pone el
 * `kind` al leer: un CHECK no puede mirar `finance_accounts`, así que si la deuda
 * se guardara en negativo el signo dependería de que el código que inserta se
 * acuerde. Con el monto siempre positivo, la conversión vive en un solo lugar.
 */
export function signoDe(kind: AccountKind, amountEur: number): number {
  return kind === 'deuda' ? -Math.abs(amountEur) : Math.abs(amountEur);
}

// ─── La aritmética, escrita UNA sola vez ────────────────────────────────────

type PatrimonioRow = {
  day: string;
  esperadas: number;
  cargadas: number;
  total_eur: string | null;
  dinero_eur: string;
  retenido_eur: string;
  deuda_eur: string;
  faltan: string[];
};

/**
 * El cuerpo compartido de toda la aritmética del módulo. `diasCte` es lo único
 * que cambia entre las tres lecturas: `generate_series` para las series
 * continuas, `DISTINCT day` para buscar el último día completo sin recorrer toda
 * la historia día por día.
 *
 * Está escrito una sola vez a propósito. La condición "un día está completo"
 * aparecía en cuatro lugares en el borrador y las cuatro tenían que decir
 * exactamente lo mismo para que la pantalla, el gráfico y el cierre mensual no
 * se contradijeran; cuatro copias de una regla de negocio son cuatro
 * oportunidades de que una quede vieja. Es el mismo criterio que `COND_ATRASADO`
 * en `finance.ts`.
 */
const CTE_PATRIMONIO = (diasCte: string): string => `
  WITH dias AS (
    ${diasCte}
  ),
  vigentes AS (
    -- La vigencia es lo que impide que abrir una cuenta hoy deje incompletos
    -- TODOS los días anteriores (D6): esa cuenta no existía, así que nunca tuvo
    -- saldo, así que sin estas dos condiciones el gráfico entero desaparece la
    -- primera vez que el usuario crea una cuenta.
    --
    -- El JOIN es LEFT y NO inner: con un inner, un día en el que no había NINGUNA
    -- cuenta vigente desaparecía de la serie en vez de aparecer como "sin
    -- información", y serieDiaria() de un mes anterior a la primera cuenta
    -- devolvía 0 filas en lugar de los 30 días en null. Lo encontró el test 10.
    SELECT d.day, a.id, a.kind, a.name
    FROM dias d
    LEFT JOIN finance_accounts a
      ON a.opened_on <= d.day
     AND (a.closed_on IS NULL OR d.day <= a.closed_on)
  ),
  cargados AS (
    SELECT v.day, v.id, v.kind, v.name, b.amount_eur
    FROM vigentes v
    LEFT JOIN finance_account_balances b
      ON b.account_id = v.id AND b.day = v.day
  ),
  patrimonio AS (
    SELECT
      d.day,
      -- count(d.id) y no count(*): con el LEFT JOIN de arriba, un día sin cuentas
      -- vigentes trae UNA fila con id NULL, y count(*) la contaría como si
      -- hubiera una cuenta esperada.
      count(d.id)::int         AS esperadas,
      -- count() de una columna cuenta los NO-null: es lo que distingue "cuenta
      -- cargada" de "cuenta vigente pero sin cargar".
      count(d.amount_eur)::int AS cargadas,
      -- NULL, no un parcial, cuando falta una cuenta (D5).
      CASE WHEN count(d.id) > 0 AND count(d.id) = count(d.amount_eur)
           THEN SUM(CASE WHEN d.kind = 'deuda' THEN -d.amount_eur ELSE d.amount_eur END)
           ELSE NULL END AS total_eur,
      COALESCE(SUM(d.amount_eur) FILTER (WHERE d.kind = 'dinero'),   0) AS dinero_eur,
      COALESCE(SUM(d.amount_eur) FILTER (WHERE d.kind = 'retenido'), 0) AS retenido_eur,
      -- POSITIVO a propósito (§4 regla 6): es "cuánto debemos", para el desglose.
      COALESCE(SUM(d.amount_eur) FILTER (WHERE d.kind = 'deuda'),    0) AS deuda_eur,
      -- El "d.id IS NOT NULL" del filtro es por el mismo LEFT JOIN: sin él, un
      -- día sin cuentas devuelve faltan = {NULL}, un array con un elemento nulo
      -- que la UI imprimiría como una cuenta llamada "vacío".
      COALESCE(
        array_agg(d.name ORDER BY d.name)
          FILTER (WHERE d.amount_eur IS NULL AND d.id IS NOT NULL),
        '{}'
      ) AS faltan
    FROM cargados d
    GROUP BY d.day
  )`;

const COLS_PATRIMONIO = `
  day::text AS day, esperadas, cargadas,
  total_eur::text    AS total_eur,
  dinero_eur::text   AS dinero_eur,
  retenido_eur::text AS retenido_eur,
  deuda_eur::text    AS deuda_eur,
  faltan`;

/** Un día puntual. $1 = el día. */
const PATRIMONIO_DIA_SQL = `${CTE_PATRIMONIO(`SELECT $1::date AS day`)}
  SELECT ${COLS_PATRIMONIO} FROM patrimonio`;

/**
 * El último día COMPLETO de toda la historia. $ninguno.
 *
 * Arranca de `DISTINCT day` y no de un `generate_series` sobre todo el histórico:
 * sólo un día que tenga al menos un saldo puede estar completo, así que evaluar
 * los otros es trabajo tirado que además crece para siempre.
 */
const ULTIMO_COMPLETO_SQL = `${CTE_PATRIMONIO(
  `SELECT DISTINCT day FROM finance_account_balances`,
)}
  SELECT ${COLS_PATRIMONIO} FROM patrimonio
  WHERE total_eur IS NOT NULL
  ORDER BY day DESC
  LIMIT 1`;

/** Serie diaria continua. $1 = desde, $2 = hasta. */
const SERIE_DIARIA_SQL = `${CTE_PATRIMONIO(
  `SELECT generate_series($1::date, $2::date, interval '1 day')::date AS day`,
)}
  SELECT ${COLS_PATRIMONIO} FROM patrimonio ORDER BY day`;

/**
 * Serie mensual de GANANCIA. $1 = hoy (en DASHBOARD_TZ), $2 = cuántos meses.
 *
 * `meses` se construye desde `$1::date` y no desde `now()`: el `BY_MONTH_SQL`
 * viejo usaba `now()`, o sea la TZ del server de Postgres, y el 31 a las 21:30 de
 * Buenos Aires eso ya es el mes siguiente en un server europeo (verificado en
 * `_verificacion-027.sql` #14).
 */
const SERIE_MENSUAL_SQL = `${CTE_PATRIMONIO(
  `SELECT DISTINCT day FROM finance_account_balances`,
)},
  completos AS (
    SELECT day, total_eur FROM patrimonio WHERE total_eur IS NOT NULL
  ),
  cierres AS (
    -- El cierre del mes es el último día COMPLETO, no el último con datos (D8):
    -- si el 20 quedó a medio cargar y el 25 está completo, cierra el 25.
    SELECT DISTINCT ON (date_trunc('month', day))
           date_trunc('month', day)::date AS mes,
           day  AS dia_cierre,
           total_eur
    FROM completos
    ORDER BY date_trunc('month', day), day DESC
  ),
  retiros AS (
    SELECT date_trunc('month', day)::date AS mes, SUM(amount_eur) AS retiros_eur
    FROM finance_movements WHERE kind = 'retiro' GROUP BY 1
  ),
  aportes AS (
    SELECT date_trunc('month', day)::date AS mes, SUM(amount_eur) AS aportes_eur
    FROM finance_movements WHERE kind = 'aporte' GROUP BY 1
  ),
  meses AS (
    SELECT generate_series(
      date_trunc('month', $1::date) - make_interval(months => $2::int - 1),
      date_trunc('month', $1::date),
      interval '1 month'
    )::date AS mes
  )
  SELECT to_char(m.mes, 'YYYY-MM')          AS month,
         c.total_eur::text                  AS cierre_eur,
         c.dia_cierre::text                 AS dia_cierre,
         COALESCE(r.retiros_eur, 0)::text   AS retiros_eur,
         COALESCE(ap.aportes_eur, 0)::text  AS aportes_eur,
         -- ganancia = Δ − retiros − aportes (D7). Los retiros están guardados
         -- NEGATIVOS, así que restarlos los suma de vuelta: sacar plata propia no
         -- es una pérdida del negocio. Los aportes están POSITIVOS, así que
         -- restarlos los descuenta: meter plata propia no es una ganancia.
         CASE WHEN c.total_eur IS NULL OR cp.total_eur IS NULL THEN NULL
              ELSE c.total_eur - cp.total_eur
                   - COALESCE(r.retiros_eur, 0) - COALESCE(ap.aportes_eur, 0)
         END::text                          AS ganancia_eur
  FROM meses m
  LEFT JOIN cierres c  ON c.mes = m.mes
  -- El mes calendario ANTERIOR, no el cierre previo que exista (D8): si julio no
  -- tiene ningún día completo, la ganancia de agosto es null y no se calcula
  -- contra junio. Medir dos meses y llamarlo uno es peor que no mostrar nada.
  LEFT JOIN cierres cp ON cp.mes = (m.mes - interval '1 month')::date
  LEFT JOIN retiros r  ON r.mes = m.mes
  LEFT JOIN aportes ap ON ap.mes = m.mes
  ORDER BY m.mes`;

// ─── Cuentas ────────────────────────────────────────────────────────────────

type AccountRow = {
  id: number;
  name: string;
  kind: AccountKind;
  opened_on: string;
  closed_on: string | null;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
};

const COLS_ACCOUNT = `id, name, kind, opened_on::text AS opened_on,
         closed_on::text AS closed_on, sort_order, created_at, updated_at`;

const LIST_ACCOUNTS_SQL = `
  SELECT ${COLS_ACCOUNT} FROM finance_accounts
  WHERE ($1::boolean OR closed_on IS NULL)
  ORDER BY sort_order, name`;

const ACCOUNT_BY_ID_SQL = `SELECT ${COLS_ACCOUNT} FROM finance_accounts WHERE id = $1`;

const INSERT_ACCOUNT_SQL = `
  INSERT INTO finance_accounts (name, kind, opened_on, sort_order)
  VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), COALESCE($4, 0))
  RETURNING ${COLS_ACCOUNT}`;

// Todos los campos EXPLÍCITOS, sin COALESCE contra la columna. Con
// `COALESCE($4, closed_on)` era imposible REABRIR una cuenta: mandar null y no
// mandar nada eran lo mismo para la base. Es el mismo bug que ya tuvo el UPDATE
// de movimientos con la categoría (ver registro.md, 2026-08-24), así que los
// valores finales se resuelven en JS contra la fila que ya existe.
const UPDATE_ACCOUNT_SQL = `
  UPDATE finance_accounts
  SET name = $2, kind = $3, opened_on = $4::date, closed_on = $5::date, sort_order = $6
  WHERE id = $1
  RETURNING ${COLS_ACCOUNT}`;

/** Las cuentas vigentes en un día, con su saldo de ese día si ya se cargó. */
const CUENTAS_CON_SALDO_SQL = `
  SELECT a.id, a.name, a.kind, a.opened_on::text AS opened_on,
         a.closed_on::text AS closed_on, a.sort_order, a.created_at, a.updated_at,
         b.amount_eur::text AS amount_eur, b.note
  FROM finance_accounts a
  LEFT JOIN finance_account_balances b ON b.account_id = a.id AND b.day = $1::date
  WHERE a.opened_on <= $1::date
    AND (a.closed_on IS NULL OR $1::date <= a.closed_on)
  ORDER BY a.sort_order, a.name`;

function toAccount(r: AccountRow): FinanceAccount {
  return {
    // bigserial llega como string de node-pg: el contrato promete number, y el
    // zod de los routes valida los ids con z.number().
    id: Number(r.id),
    name: r.name,
    kind: r.kind,
    openedOn: r.opened_on,
    closedOn: r.closed_on,
    sortOrder: Number(r.sort_order),
    createdAt: ISO(r.created_at),
    updatedAt: ISO(r.updated_at),
  };
}

function toPatrimonio(r: PatrimonioRow | null, day: string): PatrimonioDia {
  if (!r) {
    // No hay ni una cuenta vigente ese día. `completo` es false a propósito, no
    // true-por-vacuidad: un patrimonio sin ninguna cuenta no es un patrimonio
    // de cero, es la ausencia de información.
    return {
      day,
      totalEur: null,
      dineroEur: 0,
      retenidoEur: 0,
      deudaEur: 0,
      esperadas: 0,
      cargadas: 0,
      completo: false,
      faltan: [],
    };
  }
  return {
    day: r.day,
    totalEur: MONEY_N(r.total_eur),
    dineroEur: MONEY(r.dinero_eur),
    retenidoEur: MONEY(r.retenido_eur),
    deudaEur: MONEY(r.deuda_eur),
    esperadas: r.esperadas,
    cargadas: r.cargadas,
    completo: r.esperadas > 0 && r.esperadas === r.cargadas,
    faltan: r.faltan ?? [],
  };
}

/**
 * El día de hoy en la TZ del dashboard. Un solo lugar que lo resuelve, y se
 * resuelve en Postgres: con `Date` de JS, un saldo cargado de noche quedaría con
 * el día de mañana según la zona del browser.
 *
 * Duplicada a propósito con `hoyEnTz()` de `finance.ts`: unificarla obligaría a
 * tocar `lib/day.ts`, que tres tasks leen en paralelo (plan §8). Queda anotado.
 */
async function hoyEnTz(): Promise<string> {
  const row = await q1<{ day: string }>(`SELECT (now() AT TIME ZONE $1)::date::text AS day`, [
    process.env.DASHBOARD_TZ ?? 'America/Argentina/Buenos_Aires',
  ]);
  return row!.day;
}

// ─── Lectura ────────────────────────────────────────────────────────────────

export async function patrimonioDe(day: string): Promise<PatrimonioDia> {
  const row = await q1<PatrimonioRow>(PATRIMONIO_DIA_SQL, [day]);
  return toPatrimonio(row, day);
}

export async function listAccounts(opts?: {
  incluirCerradas?: boolean;
}): Promise<FinanceAccount[]> {
  const rows = await q<AccountRow>(LIST_ACCOUNTS_SQL, [opts?.incluirCerradas ?? false]);
  return rows.map(toAccount);
}

export async function getSaldoOverview(): Promise<SaldoOverview> {
  const hoyStr = await hoyEnTz();

  const [ultimoRow, hoyRow, cuentasRows] = await Promise.all([
    q1<PatrimonioRow>(ULTIMO_COMPLETO_SQL),
    q1<PatrimonioRow>(PATRIMONIO_DIA_SQL, [hoyStr]),
    q<AccountRow & { amount_eur: string | null; note: string | null }>(CUENTAS_CON_SALDO_SQL, [
      hoyStr,
    ]),
  ]);

  const cuentas: AccountWithBalance[] = cuentasRows.map((r) => {
    const base = toAccount(r);
    const amountEur = MONEY_N(r.amount_eur);
    return {
      ...base,
      amountEur,
      note: r.note,
      // El signo se aplica acá y no en la UI: si la pantalla tuviera que
      // decidirlo, cada componente que muestre un saldo sería una oportunidad
      // más de olvidarse el menos de la deuda.
      signedEur: amountEur === null ? null : signoDe(base.kind, amountEur),
    };
  });

  return {
    ultimo: ultimoRow ? toPatrimonio(ultimoRow, ultimoRow.day) : null,
    hoy: toPatrimonio(hoyRow, hoyStr),
    cuentas,
    hoyStr,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * La serie diaria de un mes, del día 1 al último día del mes (o a hoy, si el mes
 * es el actual). SIEMPRE continua: un día sin carga viene con `totalEur: null`,
 * no se saltea. Es el mismo criterio que el `byDay` de `overview.ts`.
 *
 * @param mes 'YYYY-MM'
 */
export async function serieDiaria(mes: string): Promise<PuntoDiario[]> {
  if (!/^\d{4}-\d{2}$/.test(mes)) {
    throw new SaldoInputError(`mes inválido: "${mes}" (se espera YYYY-MM)`);
  }
  const hoyStr = await hoyEnTz();
  const desde = `${mes}-01`;
  // El mes en curso corta en HOY, no en el día 31: dibujar los días que todavía
  // no llegaron como "sin información" hace que el gráfico arranque con una
  // cola vacía a la derecha que parece que faltan datos.
  const finDeMes = await q1<{ hasta: string }>(
    `SELECT LEAST(
       (date_trunc('month', $1::date) + interval '1 month - 1 day')::date,
       $2::date
     )::text AS hasta`,
    [desde, hoyStr],
  );
  const hasta = finDeMes!.hasta;
  // Un mes futuro entero: hasta < desde y generate_series devuelve 0 filas.
  if (hasta < desde) return [];

  const rows = await q<PatrimonioRow>(SERIE_DIARIA_SQL, [desde, hasta]);
  return rows.map((r) => ({ day: r.day, totalEur: MONEY_N(r.total_eur) }));
}

type MensualRow = {
  month: string;
  cierre_eur: string | null;
  dia_cierre: string | null;
  retiros_eur: string;
  aportes_eur: string;
  ganancia_eur: string | null;
};

export async function serieMensual(meses: number): Promise<PuntoMensual[]> {
  if (!Number.isInteger(meses) || meses < 1) {
    throw new SaldoInputError(`meses inválido: ${meses} (se espera un entero >= 1)`);
  }
  const hoyStr = await hoyEnTz();
  const rows = await q<MensualRow>(SERIE_MENSUAL_SQL, [hoyStr, meses]);
  return rows.map((r) => ({
    month: r.month,
    cierreEur: MONEY_N(r.cierre_eur),
    diaCierre: r.dia_cierre,
    retirosEur: MONEY(r.retiros_eur),
    aportesEur: MONEY(r.aportes_eur),
    gananciaEur: MONEY_N(r.ganancia_eur),
  }));
}

// ─── Escritura ──────────────────────────────────────────────────────────────

function isCheckViolation(err: unknown): boolean {
  return codeOf(err) === '23514';
}

function isUniqueViolation(err: unknown): boolean {
  return codeOf(err) === '23505';
}

function codeOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

/**
 * Traduce los CHECK y el UNIQUE de la base a algo que una persona pueda leer.
 * Sin esto, el nombre del constraint sale crudo a la pantalla — ya pasó con los
 * movimientos y está en registro.md.
 */
function accountErrorMessage(err: unknown): Error {
  if (isUniqueViolation(err)) {
    return new SaldoInputError(
      'ya existe una cuenta con ese nombre (no distingue mayúsculas ni espacios de más)',
    );
  }
  if (isCheckViolation(err)) {
    return new SaldoInputError(
      'datos inválidos: el nombre no puede estar vacío, el tipo tiene que ser dinero/retenido/deuda, ' +
        'y la fecha de cierre no puede ser anterior a la de apertura',
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

export async function createAccount(input: {
  name: string;
  kind: AccountKind;
  openedOn?: string;
  sortOrder?: number;
}): Promise<FinanceAccount> {
  try {
    const rows = await q<AccountRow>(INSERT_ACCOUNT_SQL, [
      input.name.trim(),
      input.kind,
      input.openedOn ?? null,
      input.sortOrder ?? null,
    ]);
    return toAccount(rows[0]!);
  } catch (err) {
    throw accountErrorMessage(err);
  }
}

export async function updateAccount(
  id: number,
  input: Partial<{
    name: string;
    kind: AccountKind;
    openedOn: string;
    closedOn: string | null;
    sortOrder: number;
  }>,
): Promise<FinanceAccount> {
  const actual = await q1<AccountRow>(ACCOUNT_BY_ID_SQL, [id]);
  if (!actual) throw new SaldoInputError('esa cuenta no existe');

  // `closedOn` se distingue por `undefined` (no vino) vs `null` (reabrir): son
  // dos intenciones distintas y con COALESCE en SQL serían la misma.
  const closedOn = input.closedOn !== undefined ? input.closedOn : actual.closed_on;

  try {
    const rows = await q<AccountRow>(UPDATE_ACCOUNT_SQL, [
      id,
      input.name !== undefined ? input.name.trim() : actual.name,
      input.kind ?? actual.kind,
      input.openedOn ?? actual.opened_on,
      closedOn,
      input.sortOrder ?? Number(actual.sort_order),
    ]);
    if (rows.length === 0) throw new SaldoInputError('esa cuenta no existe');
    return toAccount(rows[0]!);
  } catch (err) {
    throw accountErrorMessage(err);
  }
}

/** Cuántos saldos se lleva un DELETE. La UI lo necesita para la confirmación (D10). */
export async function contarSaldosDe(id: number): Promise<number> {
  const row = await q1<{ n: string }>(
    `SELECT count(*)::text AS n FROM finance_account_balances WHERE account_id = $1`,
    [id],
  );
  return Number(row!.n);
}

/**
 * Destructivo: `ON DELETE CASCADE` se lleva los saldos, y con eso el patrimonio
 * histórico CAMBIA retroactivamente — días que estaban completos pasan a tener
 * una cuenta menos y su total baja (D10, verificado en #15). Por eso la UI
 * ofrece cerrar (`closedOn`) como acción principal y esto sólo detrás de una
 * confirmación que dice cuántos saldos se van.
 */
export async function deleteAccount(id: number): Promise<void> {
  await q(`DELETE FROM finance_accounts WHERE id = $1`, [id]);
}

const UPSERT_BALANCE_SQL = `
  INSERT INTO finance_account_balances (account_id, day, amount_eur, note)
  VALUES ($1, $2::date, $3::numeric, $4)
  ON CONFLICT (account_id, day)
  DO UPDATE SET amount_eur = EXCLUDED.amount_eur, note = EXCLUDED.note`;

const DELETE_BALANCE_SQL = `
  DELETE FROM finance_account_balances WHERE account_id = $1 AND day = $2::date`;

/**
 * Guarda los saldos de UN día, todos juntos, en UNA transacción.
 *
 * Es una sola transacción y no un upsert por cuenta porque si la tercera falla
 * no puede quedar un día a medio guardar mientras el usuario ya cree que
 * guardó: por D5 un día parcial es un día sin patrimonio, y el peor resultado
 * posible es que la pantalla diga "listo" y el gráfico no tenga el punto.
 *
 * Un `amountEur: null` BORRA el saldo de esa cuenta ese día. No guarda 0: por D5
 * "no hay fila" y "hay una fila en 0" son la diferencia entre un día incompleto
 * y un patrimonio de cero, y las dos cosas tienen que poder decirse.
 */
export async function guardarSaldosDelDia(
  day: string,
  saldos: Array<{ accountId: number; amountEur: number | null; note?: string | null }>,
): Promise<PatrimonioDia> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new SaldoInputError(`día inválido: "${day}" (se espera YYYY-MM-DD)`);
  }
  if (saldos.length === 0) {
    throw new SaldoInputError('no hay ningún saldo para guardar');
  }

  // Una cuenta repetida en el mismo payload haría dos upserts sobre la misma
  // fila y el último ganaría en silencio: el usuario vería guardado un número
  // que no es el que mandó primero. Mejor rechazarlo.
  const ids = saldos.map((s) => s.accountId);
  if (new Set(ids).size !== ids.length) {
    throw new SaldoInputError('hay una cuenta repetida en el pedido');
  }

  // Se validan TODAS las cuentas antes de abrir la transacción: así un id
  // inválido da un 400 limpio en vez de un ROLLBACK a mitad de camino.
  const vigentes = await q<{ id: string; name: string }>(
    `SELECT id, name FROM finance_accounts
      WHERE id = ANY($2::bigint[])
        AND opened_on <= $1::date
        AND (closed_on IS NULL OR $1::date <= closed_on)`,
    [day, ids],
  );
  const vigentesIds = new Set(vigentes.map((r) => Number(r.id)));
  const invalidos = ids.filter((id) => !vigentesIds.has(id));
  if (invalidos.length > 0) {
    throw new SaldoInputError(
      `estas cuentas no existen o no estaban vigentes el ${day}: ${invalidos.join(', ')}`,
    );
  }

  try {
    await tx(async (c) => {
      for (const s of saldos) {
        if (s.amountEur === null) {
          await c.query(DELETE_BALANCE_SQL, [s.accountId, day]);
        } else {
          await c.query(UPSERT_BALANCE_SQL, [
            s.accountId,
            day,
            String(s.amountEur),
            s.note ?? null,
          ]);
        }
      }
    });
  } catch (err) {
    if (isCheckViolation(err)) {
      throw new SaldoInputError(
        'un saldo no puede ser negativo: si la cuenta está en descubierto, cargala como una cuenta de tipo deuda',
      );
    }
    throw err instanceof Error ? err : new Error(String(err));
  }

  return patrimonioDe(day);
}

/**
 * Los nombres de las cuentas vigentes HOY que todavía no tienen saldo cargado.
 * Vacío = el día ya está completo.
 *
 * Existe aparte de `getSaldoOverview()` porque la usa el LAYOUT del panel, o
 * sea que corre en cada carga de cada pantalla (Resumen, Ventas, Anuncios…):
 * `getSaldoOverview` hace cuatro consultas y devuelve el patrimonio, el
 * desglose y las cuentas con sus saldos, y nada de eso se necesita para
 * contestar "¿falta cargar?". Esto es UNA consulta a un índice.
 *
 * La condición de vigencia es la misma de D6 y por eso se lee del mismo lugar
 * conceptual: una cuenta abierta mañana no "falta" hoy.
 *
 * Devuelve TAMBIÉN el día, y no sólo los nombres, porque el llamador lo
 * necesita y no lo puede calcular: el aviso del layout usa la fecha como clave
 * del "descartar por hoy", y con `new Date()` del cliente (o un
 * `toISOString()` en el server, que es UTC) el recordatorio se reactivaría a la
 * medianoche equivocada. La única fecha correcta acá es la de DASHBOARD_TZ, y
 * esta función ya la resolvió para hacer la consulta.
 */
export async function faltanSaldosDeHoy(): Promise<{ hoy: string; faltan: string[] }> {
  const hoy = await hoyEnTz();
  const rows = await q<{ name: string }>(
    `SELECT a.name
       FROM finance_accounts a
      WHERE a.opened_on <= $1::date
        AND (a.closed_on IS NULL OR $1::date <= a.closed_on)
        AND NOT EXISTS (
          SELECT 1 FROM finance_account_balances b
           WHERE b.account_id = a.id AND b.day = $1::date
        )
      ORDER BY a.sort_order, a.name`,
    [hoy],
  );
  return { hoy, faltan: rows.map((r) => r.name) };
}
