-- ════════════════════════════════════════════════════════════════════════════
-- 027 — El saldo se carga A MANO, por cuenta, una vez al día
--
-- DDL CANÓNICO. Ya corrido dos veces contra una base scratch con las
-- migraciones 001-026 aplicadas (menos la 021, ver §3 del plan). T01 lo copia
-- TAL CUAL como db/migrations/027_saldo_cuentas.sql, sin retipearlo.
--
-- Qué cambia respecto de la 022: el patrimonio dejaba de ser
-- SUM(finance_daily_profit) + SUM(finance_movements) y pasa a ser la suma de
-- los saldos que el usuario mide y tipea cada día. El motivo está en el §1 D1
-- del plan: un saldo tipeado ya incluye los gastos (cuando se paga el alquiler
-- el banco ya bajó), así que sumarle los movimientos cuenta el mismo gasto dos
-- veces.
-- ════════════════════════════════════════════════════════════════════════════


-- ─── Las cuentas donde vive (o falta) la plata ───────────────────────────────
--
-- Configurables desde la UI, no fijas en código como las 5 categorías de
-- gasto de la 022. El motivo es que la lista real cambia por fuera del panel:
-- hoy son cuatro, mañana aparece Stripe, un banco nuevo o una segunda deuda.
-- Una lista fija obligaría a un ALTER TABLE + deploy cada vez que el usuario
-- abre una cuenta.
--
-- `kind` es lo que decide el SIGNO con el que la cuenta entra al patrimonio:
--   dinero    → plata disponible ya                        (+)
--   retenido  → plata propia que todavía no se puede tocar  (+)
--   deuda     → lo que se le debe a alguien                (−)
-- Tres y no más: son las tres que el usuario nombró y no hay una cuarta
-- pedida. Agregar un kind es un ALTER del CHECK, no un rediseño.
--
-- `opened_on` / `closed_on` NO son metadata de auditoría (para eso están
-- created_at/updated_at): son la VIGENCIA de la cuenta y participan de la
-- aritmética. Sin `opened_on`, abrir una quinta cuenta hoy dejaría "incompleto"
-- todo el historial anterior (ver §4 del plan: un día cuenta sólo si tiene
-- saldo para TODAS las cuentas vigentes ese día) y el gráfico entero
-- desaparecería de golpe. Es el bug más caro que puede tener este esquema y es
-- una columna.
CREATE TABLE IF NOT EXISTS finance_accounts (
  id         bigserial   PRIMARY KEY,
  name       text        NOT NULL,
  kind       text        NOT NULL,
  -- Desde qué día se le pide saldo a esta cuenta. Editable: el usuario puede
  -- crear "Mercado Pago" hoy y decir que existe desde junio.
  opened_on  date        NOT NULL DEFAULT CURRENT_DATE,
  -- NULL = sigue vigente. Una cuenta cerrada conserva su historial y deja de
  -- pedirse a partir del día siguiente a closed_on. No se borra: borrarla se
  -- lleva sus saldos en cascada y con eso el patrimonio histórico cambia
  -- retroactivamente.
  closed_on  date,
  sort_order smallint    NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT finance_accounts_kind_valido CHECK (kind IN ('dinero', 'retenido', 'deuda')),
  CONSTRAINT finance_accounts_nombre_no_vacio CHECK (length(btrim(name)) > 0),
  CONSTRAINT finance_accounts_vigencia_coherente CHECK (closed_on IS NULL OR closed_on >= opened_on)
);

-- Dos cuentas con el mismo nombre es exactamente cómo se cuenta la misma plata
-- dos veces: el usuario carga "Mercado Pago" en una y al día siguiente en la
-- otra, y el patrimonio del segundo día queda con las dos. El índice es sobre
-- lower(btrim(...)) porque "Mercado Pago" y "mercado pago " son la misma cuenta
-- para una persona y dos filas distintas para un UNIQUE ingenuo.
CREATE UNIQUE INDEX IF NOT EXISTS finance_accounts_name_uq
  ON finance_accounts (lower(btrim(name)));

CREATE OR REPLACE TRIGGER finance_accounts_updated_at
  BEFORE UPDATE ON finance_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ─── El saldo de una cuenta en un día ───────────────────────────────────────
--
-- Un saldo por cuenta y por día, y la PK lo garantiza: cargar dos veces el
-- mismo día es un UPDATE (gana el último), no dos filas que después se suman.
--
-- EL MONTO SE GUARDA SIEMPRE >= 0 Y EL SIGNO LO PONE EL `kind` DE LA CUENTA AL
-- LEER. Es la misma regla que ya usa applySign() con los movimientos de la 022
-- (el formulario nunca le pide a la persona escribir un número negativo), pero
-- acá además es la ÚNICA forma de que la base garantice el signo: un CHECK no
-- puede mirar la tabla finance_accounts, así que si guardáramos la deuda en
-- negativo el signo dependería de que el código que inserta se acuerde. Con el
-- monto siempre positivo, el CHECK es local y verificable, y la conversión
-- vive en UNA sola expresión SQL.
--
-- Consecuencia conocida y aceptada (§10 P-02 del plan): una cuenta de tipo
-- `dinero` en descubierto no se puede tipear. Se modela como una cuenta
-- `deuda` aparte.
CREATE TABLE IF NOT EXISTS finance_account_balances (
  account_id bigint        NOT NULL REFERENCES finance_accounts(id) ON DELETE CASCADE,
  day        date          NOT NULL,
  -- Valor ABSOLUTO tal como lo tipea el usuario. Para una cuenta `deuda`, 500
  -- significa "debemos 500", y entra al patrimonio como −500.
  amount_eur numeric(14,2) NOT NULL,
  -- Por qué ese número, cuando no es obvio ("sin contar los 500 que me deben").
  -- Un salto raro en el gráfico dentro de tres meses se explica acá o no se
  -- explica.
  note       text,
  created_at timestamptz   NOT NULL DEFAULT now(),
  updated_at timestamptz   NOT NULL DEFAULT now(),

  PRIMARY KEY (account_id, day),
  CONSTRAINT finance_account_balances_no_negativo CHECK (amount_eur >= 0)
);

-- El índice es por día porque TODAS las lecturas del módulo son por día o por
-- rango de días (la serie diaria del mes, el cierre de cada mes, el saldo de
-- hoy). Ninguna lectura arranca por cuenta.
CREATE INDEX IF NOT EXISTS finance_account_balances_day_idx
  ON finance_account_balances (day DESC);

CREATE OR REPLACE TRIGGER finance_account_balances_updated_at
  BEFORE UPDATE ON finance_account_balances
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ─── Las cuatro cuentas que el usuario nombró ───────────────────────────────
--
-- Los nombres son los que él usó, no los que suenan mejor: son los que va a
-- reconocer en su propia pantalla. Renombrarlas es un campo de texto en la UI.
-- ON CONFLICT DO NOTHING para que la migración sea idempotente: correrla dos
-- veces no duplica ni pisa un nombre que el usuario ya cambió.
--
-- opened_on queda en CURRENT_DATE (el día en que se corre la migración): no hay
-- saldo histórico que cargar, así que el primer día completo es el primero en
-- que el usuario cargue las cuatro.
INSERT INTO finance_accounts (name, kind, sort_order) VALUES
  ('Arq',                     'dinero',   10),
  ('Mercado Pago',            'dinero',   20),
  ('Retenido en Mercado Pago','retenido', 30),
  ('Deuda con Meta',          'deuda',    40)
ON CONFLICT DO NOTHING;


-- ─── Un cuarto tipo de movimiento: `aporte` ─────────────────────────────────
--
-- El contrario exacto del `retiro`: plata que ENTRA desde afuera del negocio
-- (el usuario pone de su bolsillo, un préstamo, una devolución que no es una
-- venta).
--
-- Existe por la aritmética del gráfico mensual, no por completitud. La ganancia
-- del mes se calcula como Δpatrimonio − retiros (§4 del plan). Si el usuario
-- transfiere 3.000 propios a la cuenta de Arq, el patrimonio sube 3.000 y el
-- gráfico va a decir que el negocio ganó 3.000 que nadie ganó. Con `aporte`, la
-- fórmula lo resta y el número vuelve a ser cierto. Sin él, el único número
-- importante de la pantalla miente exactamente el día en que el usuario mete
-- plata — que es el día en que más lo va a mirar.
--
-- Un `aporte` va SIEMPRE POSITIVO, y el CHECK lo garantiza: es el único kind
-- además de `ajuste` que puede ser positivo, y a diferencia del ajuste no
-- admite negativo (para eso ya está `retiro`).
--
-- `category` queda NULL, igual que retiro y ajuste: un aporte no es un gasto
-- operativo.
--
-- LOS DOS `CHECK` SE REEMPLAZAN, NO SE AGREGAN. Postgres revalida la tabla
-- entera al crear el constraint nuevo: si alguna fila existente lo violara, el
-- ALTER falla y la migración aborta. No puede pasar (las tres ramas viejas
-- siguen intactas dentro de la condición nueva, sólo se agrega una cuarta),
-- pero se verifica en fase 3 sobre una tabla CON filas cargadas —
-- `_verificacion-027.sql` #17 — porque "no puede pasar" es lo que se dice antes
-- de que pase en el deploy.
ALTER TABLE finance_movements DROP CONSTRAINT IF EXISTS finance_movements_kind_valido;
ALTER TABLE finance_movements ADD  CONSTRAINT finance_movements_kind_valido
  CHECK (kind IN ('gasto', 'retiro', 'ajuste', 'aporte'));

ALTER TABLE finance_movements DROP CONSTRAINT IF EXISTS finance_movements_signo;
ALTER TABLE finance_movements ADD  CONSTRAINT finance_movements_signo
  CHECK (
       (kind IN ('gasto', 'retiro') AND amount_eur < 0)
    OR (kind = 'aporte'             AND amount_eur > 0)
    OR (kind = 'ajuste'             AND amount_eur <> 0)
  );

-- La categoría sigue siendo exclusiva del gasto: `aporte` entra en la rama
-- "todo lo que no es gasto va con category NULL", que ya existe y no cambia.
-- Se reescribe igual para dejarla explícita al lado de las otras dos.
ALTER TABLE finance_movements DROP CONSTRAINT IF EXISTS finance_movements_categoria_solo_gasto;
ALTER TABLE finance_movements ADD  CONSTRAINT finance_movements_categoria_solo_gasto
  CHECK (
       (kind =  'gasto' AND category IS NOT NULL
        AND category IN ('sueldos', 'herramientas', 'alquiler', 'impuestos', 'otros'))
    OR (kind <> 'gasto' AND category IS NULL)
  );


-- ─── finance_daily_profit se va ─────────────────────────────────────────────
--
-- El usuario pidió borrarla ("se borra si igual no lo estoy usando"). Se puede
-- borrar sin miedo porque NO CONTIENE NINGÚN DATO PROPIO: cada fila es un
-- cálculo derivado de daily_metrics (bruto − devuelto − comisiones − costos −
-- ads) que scripts/finance-rollup.ts regenera entero con --all.
--
-- Va acá, y no en su propia migración, porque dejarla viva mientras el
-- patrimonio ya no la lee es la peor de las dos opciones: una tabla que se
-- sigue llenando todas las madrugadas con un número que ninguna pantalla
-- muestra es la clase de cosa que dentro de seis meses alguien vuelve a sumar
-- "porque estaba ahí".
--
-- CÓMO REVERTIR, en orden:
--   1. Recrear la tabla con el DDL de tasks/finanzas/_schema-022.sql
--      (que queda en el repo, intacto, justamente para esto).
--   2. Recuperar scripts/finance-rollup.ts del git log (T04 anota el hash en
--      registro.md).
--   3. npm run finance:rollup -- --all
-- El paso 3 reconstruye el 100 % de las filas. Nada de esto es recuperación de
-- datos perdidos: es recomputar.
--
-- ANTES DE CORRER ESTO EN PRODUCCIÓN hay un paso obligatorio del runbook
-- (T04): exportar la tabla a CSV. No porque el dato sea irrecuperable, sino
-- porque comparar el patrimonio viejo contra el nuevo es la única forma de
-- explicar el salto que el usuario va a ver en pantalla.
DROP TABLE IF EXISTS finance_daily_profit;
