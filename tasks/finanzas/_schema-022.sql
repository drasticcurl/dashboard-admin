-- ═══════════════════════════════════════════════════════════════════════════
-- 022 — Finanzas: patrimonio del negocio (ledger simple, todo en EUR).
--
-- QUÉ ES
-- Un ledger de movimientos con signo. El patrimonio en cualquier momento es
-- la suma de dos tablas:
--
--   patrimonio = SUM(finance_daily_profit.amount_eur)
--              + SUM(finance_movements.amount_eur)
--
-- No hay una columna "patrimonio acumulado" que se vaya actualizando: sumar
-- siempre desde las filas de abajo es lo que evita que un bug en un UPDATE
-- deje el total desincronizado de sus partes, el mismo motivo por el que
-- daily_metrics se RECALCULA y no se acumula (scripts/rollup.ts).
--
-- POR QUÉ DOS TABLAS Y NO UNA
-- El profit diario se recalcula solo, todos los días, desde daily_metrics
-- (bruto − devuelto − comisiones − costos − ads, de TODOS los funnels): es un
-- número que cambia de fuente constantemente y que puede corregirse solo en
-- los próximos días (Meta ajusta el gasto de ayer después del cierre, igual
-- que ya advierte lib/ads/live.ts). Por eso vive en su propia tabla con PK
-- (day) y se sobreescribe con ON CONFLICT, igual que daily_metrics.
--
-- Los movimientos manuales (gasto, retiro, ajuste) son hechos discretos que
-- el usuario carga una vez y after eso no cambian solos: viven en su propia
-- tabla con id propio, se pueden editar o borrar libremente (D9: no se
-- congelan como las comisiones, porque no son una regla que afecte al
-- futuro, son un hecho ya ocurrido).
--
-- TODO EN EUR, SIEMPRE (D5 de la entrevista)
-- A diferencia de orders/commissions, no hay currency ni fx_rate: el usuario
-- tipea el monto directo en euros. Esto es más simple y a propósito: la
-- plata de compras/gastos personales de este ledger no tiene por qué salir
-- en ARS, y agregar conversión acá sería una feature que nadie pidió.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── El profit diario, recalculable ─────────────────────────────────────────
--
-- PK en `day`: el cron de scripts/finance-rollup.ts recalcula los últimos N
-- días cada vez que corre (mismo patrón que rollup.ts) y el ON CONFLICT pisa
-- el valor viejo. Así una corrida tardía de Meta sobre el gasto de ayer se
-- refleja solo, sin dejar un profit_diario de ayer "congelado" mal para
-- siempre. amount_eur PUEDE ser negativo: un día que se gastó más en ads de
-- lo que entró es un día real y se muestra tal cual, no se tapa en 0.
CREATE TABLE IF NOT EXISTS finance_daily_profit (
  day         date          NOT NULL PRIMARY KEY,
  amount_eur  numeric(14,2) NOT NULL,
  computed_at timestamptz   NOT NULL DEFAULT now()
);

-- ─── Pagos programados: la plantilla, no el hecho ───────────────────────────
--
-- day_of_month se limita a 1-28 a propósito: no todos los meses tienen 29,
-- 30 o 31 días, y "qué día se ejecuta un pago del día 31 en febrero" es una
-- regla de negocio que nadie pidió. Limitando el rango a 1-28 el pago cae
-- SIEMPRE en un día que todos los meses tienen, sin inventar un caso
-- especial ("se corre el último día del mes") para una diferencia de 1 a 3
-- días que a nadie le va a importar en un pago mensual.
CREATE TABLE IF NOT EXISTS finance_scheduled_payments (
  id           bigserial     PRIMARY KEY,
  name         text          NOT NULL,
  category     text          NOT NULL,
  amount_eur   numeric(14,2) NOT NULL,
  day_of_month smallint      NOT NULL,
  active       boolean       NOT NULL DEFAULT true,
  created_at   timestamptz   NOT NULL DEFAULT now(),
  updated_at   timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT finance_scheduled_payments_monto_positivo CHECK (amount_eur > 0),
  CONSTRAINT finance_scheduled_payments_dia_valido CHECK (day_of_month BETWEEN 1 AND 28),
  CONSTRAINT finance_scheduled_payments_categoria_valida CHECK (
    category IN ('sueldos', 'herramientas', 'alquiler', 'impuestos', 'otros')
  )
);

CREATE OR REPLACE TRIGGER finance_scheduled_payments_updated_at
  BEFORE UPDATE ON finance_scheduled_payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── Los movimientos: gasto, retiro, ajuste ─────────────────────────────────
--
-- El signo lo decide el CHECK, no el que llama: un gasto o un retiro SIEMPRE
-- se guardan en negativo. Es la misma razón por la que las comisiones se
-- topean al monto de la venta (migración 011) — la aplicación nunca confía
-- en que el que inserta mandó el signo correcto, la base lo garantiza. Sin
-- este constraint, un gasto cargado en positivo por error suma en vez de
-- restar y el patrimonio queda mintiendo sin que nada avise.
--
-- `ajuste` es el único kind sin restricción de signo: es la vía de escape
-- que el usuario pidió ("una opción de ajuste por las dudas") para corregir
-- el patrimonio a mano cuando algo no cierra, en cualquier dirección.
CREATE TABLE IF NOT EXISTS finance_movements (
  id                   bigserial     PRIMARY KEY,
  kind                 text          NOT NULL,
  -- Solo se usa (y se exige) en los gastos: un retiro o un ajuste no tienen
  -- "categoría de gasto operativo".
  category             text,
  amount_eur           numeric(14,2) NOT NULL,
  note                 text          NOT NULL,
  day                  date          NOT NULL,
  -- Si este movimiento lo generó un pago programado, queda trazado. ON
  -- DELETE SET NULL: borrar el pago programado no borra el historial de lo
  -- que ya se pagó, sólo desvincula el origen.
  scheduled_payment_id bigint        REFERENCES finance_scheduled_payments(id) ON DELETE SET NULL,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  updated_at           timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT finance_movements_kind_valido CHECK (kind IN ('gasto', 'retiro', 'ajuste')),
  CONSTRAINT finance_movements_signo CHECK (
    (kind IN ('gasto', 'retiro') AND amount_eur < 0) OR (kind = 'ajuste' AND amount_eur <> 0)
  ),
  CONSTRAINT finance_movements_categoria_solo_gasto CHECK (
    (kind = 'gasto' AND category IS NOT NULL AND category IN ('sueldos', 'herramientas', 'alquiler', 'impuestos', 'otros'))
    OR (kind <> 'gasto' AND category IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS finance_movements_day_idx ON finance_movements (day DESC);

CREATE OR REPLACE TRIGGER finance_movements_updated_at
  BEFORE UPDATE ON finance_movements
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── Qué pagos programados ya se ejecutaron este mes ────────────────────────
--
-- La idempotencia es ESTRUCTURAL (el UNIQUE de la PK), no lógica: si el cron
-- corre dos veces el mismo día (un reinicio del proceso a mitad de corrida,
-- el mismo caso que ya avisa D-anuncios sobre el motor de reglas), el
-- segundo INSERT choca contra la PK y se descarta con ON CONFLICT DO
-- NOTHING en vez de generar el gasto dos veces.
CREATE TABLE IF NOT EXISTS finance_scheduled_payment_runs (
  scheduled_payment_id bigint      NOT NULL REFERENCES finance_scheduled_payments(id) ON DELETE CASCADE,
  -- 'YYYY-MM': un pago por mes, nunca dos, sin importar cuántas veces corra el cron ese mes.
  month                text        NOT NULL,
  movement_id          bigint      NOT NULL REFERENCES finance_movements(id) ON DELETE CASCADE,
  executed_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scheduled_payment_id, month)
);
