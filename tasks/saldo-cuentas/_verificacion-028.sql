-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN DE FASE 3 — saldo por cuentas cargado a mano
--
-- Una afirmación por bloque, con la salida esperada escrita al lado. Corrido
-- contra una base SCRATCH con 001-027 aplicadas + _schema-028.sql. NUNCA
-- contra producción: los bloques 7 en adelante INSERTAN datos.
--
--   docker exec -i panel-db-1 psql -U panel -d panel_scratch -v ON_ERROR_STOP=1 \
--     < tasks/saldo-cuentas/_verificacion-028.sql
--
-- Lo que se prueba acá es la ARITMÉTICA, que es donde este módulo puede mentir
-- sin que nada falle: el signo por tipo de cuenta, qué día se considera
-- completo, y la fórmula de la ganancia mensual (que resta los retiros, no los
-- suma).
-- ════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
\pset pager off

-- Limpieza previa: el archivo se puede correr dos veces seguidas.
DELETE FROM finance_scheduled_payment_runs;
DELETE FROM finance_movements;
DELETE FROM finance_scheduled_payments;
DELETE FROM finance_account_balances;
DELETE FROM finance_accounts;


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. finance_daily_profit YA NO EXISTE (la 028 la borró)
-- esperado exactamente: existe = f
-- ─────────────────────────────────────────────────────────────────────────────
SELECT '1. finance_daily_profit borrada' AS afirmacion,
       EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema = 'public' AND table_name = 'finance_daily_profit') AS existe;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Las dos tablas nuevas existen con los tipos esperados
-- esperado exactamente: 6 filas, amount_eur = numeric(14,2) en balances,
--                       opened_on/closed_on = date en accounts
-- ─────────────────────────────────────────────────────────────────────────────
SELECT '2. tipos' AS afirmacion, table_name, column_name, data_type,
       numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (table_name, column_name) IN (
    ('finance_accounts', 'kind'), ('finance_accounts', 'opened_on'),
    ('finance_accounts', 'closed_on'), ('finance_account_balances', 'amount_eur'),
    ('finance_account_balances', 'day'), ('finance_account_balances', 'note'))
ORDER BY table_name, column_name;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. El CHECK rechaza un saldo NEGATIVO
--    El signo lo pone el kind al leer, no el que inserta (§4 del plan).
-- esperado exactamente: resultado = RECHAZADO (23514)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE a bigint;
BEGIN
  INSERT INTO finance_accounts (name, kind, opened_on) VALUES ('tmp-neg', 'deuda', '2026-01-01')
    RETURNING id INTO a;
  BEGIN
    INSERT INTO finance_account_balances (account_id, day, amount_eur)
      VALUES (a, '2026-01-01', -500.00);
    RAISE NOTICE '3. resultado = ACEPTADO  <-- BUG: un saldo negativo entró';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '3. resultado = RECHAZADO (23514)';
  END;
END $$;
DELETE FROM finance_accounts WHERE name = 'tmp-neg';


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. El CHECK rechaza un kind inventado
-- esperado exactamente: resultado = RECHAZADO (23514)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  INSERT INTO finance_accounts (name, kind) VALUES ('tmp-kind', 'inversion');
  RAISE NOTICE '4. resultado = ACEPTADO  <-- BUG: kind inventado entró';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE '4. resultado = RECHAZADO (23514)';
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Dos cuentas con el mismo nombre (distinta capitalización y espacios) se
--    rechazan. Es cómo se cuenta la misma plata dos veces.
-- esperado exactamente: resultado = RECHAZADO (23505)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  INSERT INTO finance_accounts (name, kind) VALUES ('Mercado Pago', 'dinero');
  BEGIN
    INSERT INTO finance_accounts (name, kind) VALUES ('  mercado pago ', 'dinero');
    RAISE NOTICE '5. resultado = ACEPTADO  <-- BUG: cuenta duplicada entró';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE '5. resultado = RECHAZADO (23505)';
  END;
END $$;
DELETE FROM finance_accounts WHERE lower(btrim(name)) = 'mercado pago';


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. closed_on anterior a opened_on se rechaza
-- esperado exactamente: resultado = RECHAZADO (23514)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  INSERT INTO finance_accounts (name, kind, opened_on, closed_on)
    VALUES ('tmp-vig', 'dinero', '2026-03-01', '2026-02-01');
  RAISE NOTICE '6. resultado = ACEPTADO  <-- BUG: vigencia imposible entró';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE '6. resultado = RECHAZADO (23514)';
END $$;


-- ═══ A partir de acá: el escenario de aritmética ═════════════════════════════
--
-- Cuatro cuentas, vigentes desde el 2026-06-01, más una quinta que se abre
-- recién el 2026-08-10 (para probar que abrir una cuenta no destruye el
-- historial) y una sexta que se cierra el 2026-07-31.

INSERT INTO finance_accounts (id, name, kind, opened_on, closed_on, sort_order) VALUES
  (901, 'Arq',                      'dinero',   '2026-06-01', NULL,         10),
  (902, 'Mercado Pago',             'dinero',   '2026-06-01', NULL,         20),
  (903, 'Retenido en Mercado Pago', 'retenido', '2026-06-01', NULL,         30),
  (904, 'Deuda con Meta',           'deuda',    '2026-06-01', NULL,         40),
  (905, 'Cuenta nueva de agosto',   'dinero',   '2026-08-10', NULL,         50),
  (906, 'Cuenta cerrada en julio',  'dinero',   '2026-06-01', '2026-07-31', 60);

-- Día 2026-06-30: las 5 cuentas vigentes ese día (901-904 + 906) cargadas.
INSERT INTO finance_account_balances (account_id, day, amount_eur) VALUES
  (901, '2026-06-30', 8000.00),
  (902, '2026-06-30', 1500.00),
  (903, '2026-06-30',  700.00),
  (904, '2026-06-30', 1200.00),   -- deuda: entra como −1200
  (906, '2026-06-30',  300.00);

-- Día 2026-07-31: 906 ya cerró ese mismo día, así que TODAVÍA se le pide.
INSERT INTO finance_account_balances (account_id, day, amount_eur) VALUES
  (901, '2026-07-31', 9000.00),
  (902, '2026-07-31', 1000.00),
  (903, '2026-07-31',  500.00),
  (904, '2026-07-31',  900.00),
  (906, '2026-07-31',    0.00);

-- Día 2026-08-05: 906 ya no se pide (cerró el 31/07) y 905 todavía no existe.
-- Cuatro cuentas vigentes, cuatro cargadas → COMPLETO.
INSERT INTO finance_account_balances (account_id, day, amount_eur) VALUES
  (901, '2026-08-05', 9500.00),
  (902, '2026-08-05', 1100.00),
  (903, '2026-08-05',  400.00),
  (904, '2026-08-05', 1000.00);

-- Día 2026-08-20: 905 ya existe → 5 vigentes, pero sólo 4 cargadas → INCOMPLETO.
INSERT INTO finance_account_balances (account_id, day, amount_eur) VALUES
  (901, '2026-08-20', 9800.00),
  (902, '2026-08-20', 1200.00),
  (903, '2026-08-20',  300.00),
  (904, '2026-08-20',  800.00);

-- Día 2026-08-25: las 5 cargadas → COMPLETO. Es el cierre de agosto.
INSERT INTO finance_account_balances (account_id, day, amount_eur) VALUES
  (901, '2026-08-25', 10000.00),
  (902, '2026-08-25',  1300.00),
  (903, '2026-08-25',   200.00),
  (904, '2026-08-25',   700.00),
  (905, '2026-08-25',   450.00);

-- Retiros y gastos, para la fórmula de la ganancia. Los montos van negativos
-- como exige el CHECK de la 022.
INSERT INTO finance_movements (kind, category, amount_eur, note, day) VALUES
  ('retiro', NULL,      -2000.00, 'ver-retiro julio',   '2026-07-15'),
  ('retiro', NULL,       -500.00, 'ver-retiro agosto',  '2026-08-12'),
  ('gasto',  'sueldos',  -300.00, 'ver-gasto agosto',   '2026-08-14');


-- ─────────────────────────────────────────────────────────────────────────────
-- 7. PATRIMONIO POR DÍA, con el signo puesto por el kind y el día marcado
--    completo/incompleto. Es la query central del módulo.
--
-- esperado exactamente:
--   2026-06-30 | esperadas 5 | cargadas 5 | patrimonio  9300.00   (8000+1500+700−1200+300)
--   2026-07-31 | esperadas 5 | cargadas 5 | patrimonio  9600.00   (9000+1000+500−900+0)
--   2026-08-05 | esperadas 4 | cargadas 4 | patrimonio 10000.00   (9500+1100+400−1000)
--   2026-08-20 | esperadas 5 | cargadas 4 | patrimonio (null)     <-- falta la 905
--   2026-08-25 | esperadas 5 | cargadas 5 | patrimonio 11250.00   (10000+1300+200−700+450)
-- ─────────────────────────────────────────────────────────────────────────────
WITH dias AS (
  SELECT generate_series('2026-06-01'::date, '2026-08-31'::date, interval '1 day')::date AS day
),
vigentes AS (
  SELECT d.day, a.id, a.kind
  FROM dias d
  JOIN finance_accounts a
    ON a.opened_on <= d.day
   AND (a.closed_on IS NULL OR d.day <= a.closed_on)
),
cargados AS (
  SELECT v.day, v.kind, b.amount_eur
  FROM vigentes v
  LEFT JOIN finance_account_balances b ON b.account_id = v.id AND b.day = v.day
),
patrimonio AS (
  SELECT day,
         count(*)::int            AS esperadas,
         count(amount_eur)::int   AS cargadas,
         CASE WHEN count(*) > 0 AND count(*) = count(amount_eur)
              THEN SUM(CASE WHEN kind = 'deuda' THEN -amount_eur ELSE amount_eur END)
              ELSE NULL END       AS patrimonio_eur
  FROM cargados
  GROUP BY day
)
SELECT '7. patrimonio por día' AS afirmacion, day::text, esperadas, cargadas,
       patrimonio_eur::text
FROM patrimonio
WHERE cargadas > 0
ORDER BY day;


-- ─────────────────────────────────────────────────────────────────────────────
-- 8. ABRIR UNA CUENTA NUEVA NO ROMPE EL HISTORIAL.
--    La 905 se abrió el 2026-08-10: los días anteriores siguen completos.
--    Sin la columna opened_on, TODO el historial pasaría a incompleto y el
--    gráfico entero desaparecería al crear una cuenta.
-- esperado exactamente: dias_completos_antes_del_10 = 3
--                       (2026-06-30, 2026-07-31, 2026-08-05)
-- ─────────────────────────────────────────────────────────────────────────────
WITH dias AS (
  SELECT generate_series('2026-06-01'::date, '2026-08-09'::date, interval '1 day')::date AS day
),
vigentes AS (
  SELECT d.day, a.id, a.kind FROM dias d
  JOIN finance_accounts a ON a.opened_on <= d.day
                         AND (a.closed_on IS NULL OR d.day <= a.closed_on)
),
cargados AS (
  SELECT v.day, v.kind, b.amount_eur FROM vigentes v
  LEFT JOIN finance_account_balances b ON b.account_id = v.id AND b.day = v.day
)
SELECT '8. opened_on protege el historial' AS afirmacion,
       count(*)::int AS dias_completos_antes_del_10
FROM (
  SELECT day FROM cargados GROUP BY day
  HAVING count(*) = count(amount_eur) AND count(amount_eur) > 0
) t;


-- ─────────────────────────────────────────────────────────────────────────────
-- 9. UNA CUENTA CERRADA DEJA DE PEDIRSE, pero conserva su historial.
--    La 906 cerró el 2026-07-31. El 2026-08-05 no se le pide (4 esperadas) y
--    su saldo del 2026-06-30 sigue estando.
-- esperado exactamente: esperadas_2026_08_05 = 4 | saldos_historicos_906 = 2
-- ─────────────────────────────────────────────────────────────────────────────
SELECT '9. closed_on' AS afirmacion,
       (SELECT count(*)::int FROM finance_accounts a
         WHERE a.opened_on <= '2026-08-05' AND (a.closed_on IS NULL OR '2026-08-05' <= a.closed_on)
       ) AS esperadas_2026_08_05,
       (SELECT count(*)::int FROM finance_account_balances WHERE account_id = 906
       ) AS saldos_historicos_906;


-- ─────────────────────────────────────────────────────────────────────────────
-- 10. CIERRE DE CADA MES = patrimonio del ÚLTIMO DÍA COMPLETO del mes.
--     Ojo agosto: el último día CON DATOS es el 25 (completo), no el 20
--     (incompleto). Un cierre que tomara el último día con datos daría null.
-- esperado exactamente:
--   2026-06 | dia_cierre 2026-06-30 |  9300.00
--   2026-07 | dia_cierre 2026-07-31 |  9600.00
--   2026-08 | dia_cierre 2026-08-25 | 11250.00
-- ─────────────────────────────────────────────────────────────────────────────
WITH dias AS (
  SELECT generate_series('2026-06-01'::date, '2026-08-31'::date, interval '1 day')::date AS day
),
vigentes AS (
  SELECT d.day, a.id, a.kind FROM dias d
  JOIN finance_accounts a ON a.opened_on <= d.day
                         AND (a.closed_on IS NULL OR d.day <= a.closed_on)
),
cargados AS (
  SELECT v.day, v.kind, b.amount_eur FROM vigentes v
  LEFT JOIN finance_account_balances b ON b.account_id = v.id AND b.day = v.day
),
completos AS (
  SELECT day, SUM(CASE WHEN kind = 'deuda' THEN -amount_eur ELSE amount_eur END) AS patrimonio_eur
  FROM cargados GROUP BY day
  HAVING count(*) = count(amount_eur) AND count(amount_eur) > 0
)
SELECT '10. cierre mensual' AS afirmacion,
       to_char(day, 'YYYY-MM') AS mes, day::text AS dia_cierre, patrimonio_eur::text
FROM (
  SELECT DISTINCT ON (date_trunc('month', day)) day, patrimonio_eur
  FROM completos ORDER BY date_trunc('month', day), day DESC
) t
ORDER BY mes;


-- ─────────────────────────────────────────────────────────────────────────────
-- 11. GANANCIA DEL MES = Δ patrimonio − retiros del mes.
--     Los retiros están guardados en NEGATIVO, así que restarlos los SUMA de
--     vuelta: sacar plata propia no es una pérdida del negocio.
--
--     El mes más viejo NO tiene ganancia: sin cierre del mes anterior no hay
--     delta, y tratar el saldo inicial como ganancia inventaría un +9200 que
--     nunca se ganó.
--
-- esperado exactamente:
--   2026-06 | cierre  9300.00 | prev (null)  | retiros        0 | ganancia (null)
--   2026-07 | cierre  9600.00 | prev 9300.00 | retiros −2000.00 | ganancia  2300.00
--   2026-08 | cierre 11250.00 | prev 9600.00 | retiros  −500.00 | ganancia  2150.00
--
--   Julio: subió 300 y además sacó 2000 → ganó 2300.
--   Agosto: subió 1650 y además sacó 500 → ganó 2150. El gasto de 300 NO se
--   suma de vuelta: un sueldo pagado sí es una pérdida del negocio.
--
-- NOTA DE LA FASE 3: los tres valores esperados de este bloque, los de la
-- afirmación 7 y los de la 10 estaban MAL en la primera escritura de este
-- archivo (sumé a mano y me comí el signo de la deuda). La query estaba bien
-- desde el principio. Se corrigieron contra la salida real. Si no se hubiera
-- corrido, las tasks habrían llevado "esperado 3400" y el agente habría salido
-- a buscar un bug que no existe.
-- ─────────────────────────────────────────────────────────────────────────────
WITH dias AS (
  SELECT generate_series('2026-06-01'::date, '2026-08-31'::date, interval '1 day')::date AS day
),
vigentes AS (
  SELECT d.day, a.id, a.kind FROM dias d
  JOIN finance_accounts a ON a.opened_on <= d.day
                         AND (a.closed_on IS NULL OR d.day <= a.closed_on)
),
cargados AS (
  SELECT v.day, v.kind, b.amount_eur FROM vigentes v
  LEFT JOIN finance_account_balances b ON b.account_id = v.id AND b.day = v.day
),
completos AS (
  SELECT day, SUM(CASE WHEN kind = 'deuda' THEN -amount_eur ELSE amount_eur END) AS patrimonio_eur
  FROM cargados GROUP BY day
  HAVING count(*) = count(amount_eur) AND count(amount_eur) > 0
),
cierres AS (
  SELECT DISTINCT ON (date_trunc('month', day))
         date_trunc('month', day)::date AS mes, patrimonio_eur
  FROM completos ORDER BY date_trunc('month', day), day DESC
),
retiros AS (
  SELECT date_trunc('month', day)::date AS mes, SUM(amount_eur) AS retiros_eur
  FROM finance_movements WHERE kind = 'retiro' GROUP BY 1
),
meses AS (
  SELECT generate_series('2026-06-01'::date, '2026-08-01'::date, interval '1 month')::date AS mes
)
SELECT '11. ganancia mensual' AS afirmacion,
       to_char(m.mes, 'YYYY-MM') AS mes,
       c.patrimonio_eur::text                        AS cierre,
       cp.patrimonio_eur::text                       AS prev,
       COALESCE(r.retiros_eur, 0)::text              AS retiros,
       CASE WHEN c.patrimonio_eur IS NULL OR cp.patrimonio_eur IS NULL THEN NULL
            ELSE (c.patrimonio_eur - cp.patrimonio_eur - COALESCE(r.retiros_eur, 0))
       END::text                                     AS ganancia
FROM meses m
LEFT JOIN cierres c  ON c.mes = m.mes
LEFT JOIN cierres cp ON cp.mes = (m.mes - interval '1 month')::date
LEFT JOIN retiros r  ON r.mes = m.mes
ORDER BY m.mes;


-- ─────────────────────────────────────────────────────────────────────────────
-- 12. SERIE DIARIA DEL MES ACTUAL: continua del día 1 a hoy, con null en los
--     días sin carga o incompletos. NUNCA 0: un patrimonio de 0 es un dato
--     real y dramático, y taparlo con 0 lo vuelve indistinguible de "no cargué".
-- esperado exactamente: 31 filas para agosto 2026, de las cuales
--     con_dato = 2 (2026-08-05 y 2026-08-25) y sin_dato = 29
-- ─────────────────────────────────────────────────────────────────────────────
WITH dias AS (
  SELECT generate_series('2026-08-01'::date, '2026-08-31'::date, interval '1 day')::date AS day
),
vigentes AS (
  SELECT d.day, a.id, a.kind FROM dias d
  JOIN finance_accounts a ON a.opened_on <= d.day
                         AND (a.closed_on IS NULL OR d.day <= a.closed_on)
),
cargados AS (
  SELECT v.day, v.kind, b.amount_eur FROM vigentes v
  LEFT JOIN finance_account_balances b ON b.account_id = v.id AND b.day = v.day
),
serie AS (
  SELECT day,
         CASE WHEN count(*) = count(amount_eur) AND count(amount_eur) > 0
              THEN SUM(CASE WHEN kind = 'deuda' THEN -amount_eur ELSE amount_eur END)
              ELSE NULL END AS patrimonio_eur
  FROM cargados GROUP BY day
)
SELECT '12. serie diaria del mes' AS afirmacion,
       count(*)::int                                        AS filas,
       count(patrimonio_eur)::int                           AS con_dato,
       (count(*) - count(patrimonio_eur))::int              AS sin_dato
FROM serie;


-- ─────────────────────────────────────────────────────────────────────────────
-- 13. Cargar dos veces el mismo día es un UPDATE, no una fila nueva.
--     Si fueran dos filas, el patrimonio del día sumaría las dos.
-- esperado exactamente: filas = 1 | amount_eur = 12345.00
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO finance_account_balances (account_id, day, amount_eur) VALUES (901, '2026-08-26', 111.00)
  ON CONFLICT (account_id, day) DO UPDATE SET amount_eur = EXCLUDED.amount_eur;
INSERT INTO finance_account_balances (account_id, day, amount_eur) VALUES (901, '2026-08-26', 12345.00)
  ON CONFLICT (account_id, day) DO UPDATE SET amount_eur = EXCLUDED.amount_eur;
SELECT '13. upsert por (cuenta, día)' AS afirmacion,
       count(*)::int AS filas, max(amount_eur)::text AS amount_eur
FROM finance_account_balances WHERE account_id = 901 AND day = '2026-08-26';


-- ─────────────────────────────────────────────────────────────────────────────
-- 14. La ZONA HORARIA del corte de día: "hoy" y "este mes" se resuelven en
--     DASHBOARD_TZ, no en la del server de Postgres. Con un timestamp de las
--     21:30 de Buenos Aires, la fecha del server europeo ya es el día
--     siguiente — y el día 1 del mes también se corre.
-- esperado exactamente: en_ba = 2026-07-31 | en_lisboa = 2026-08-01
--                       mes_ba = 2026-07-01 | mes_lisboa = 2026-08-01
-- ─────────────────────────────────────────────────────────────────────────────
SELECT '14. corte de día por TZ' AS afirmacion,
       ('2026-07-31 21:30:00-03'::timestamptz AT TIME ZONE 'America/Argentina/Buenos_Aires')::date::text AS en_ba,
       ('2026-07-31 21:30:00-03'::timestamptz AT TIME ZONE 'Europe/Lisbon')::date::text                  AS en_lisboa,
       date_trunc('month', ('2026-07-31 21:30:00-03'::timestamptz AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)::date::text AS mes_ba,
       date_trunc('month', ('2026-07-31 21:30:00-03'::timestamptz AT TIME ZONE 'Europe/Lisbon')::date)::date::text                  AS mes_lisboa;


-- ─────────────────────────────────────────────────────────────────────────────
-- 15. BORRAR UNA CUENTA SE LLEVA SUS SALDOS EN CASCADA, y con eso el
--     patrimonio histórico CAMBIA retroactivamente. Se verifica para
--     documentarlo, no porque esté bien: es el motivo de que la UI ofrezca
--     cerrar (closed_on) y no borrar.
-- esperado exactamente: saldos_antes = 2 | saldos_despues = 0
-- ─────────────────────────────────────────────────────────────────────────────
SELECT '15. cascada al borrar' AS afirmacion,
       (SELECT count(*)::int FROM finance_account_balances WHERE account_id = 906) AS saldos_antes;
DELETE FROM finance_accounts WHERE id = 906;
SELECT '15. cascada al borrar' AS afirmacion,
       (SELECT count(*)::int FROM finance_account_balances WHERE account_id = 906) AS saldos_despues;


-- ─────────────────────────────────────────────────────────────────────────────
-- 16. El seed de la migración es idempotente: ON CONFLICT DO NOTHING sin
--     target atrapa la violación del índice UNIQUE funcional sobre
--     lower(btrim(name)).
-- esperado exactamente: insertadas_2da_vez = 0
-- ─────────────────────────────────────────────────────────────────────────────
DELETE FROM finance_accounts;
INSERT INTO finance_accounts (name, kind, sort_order) VALUES
  ('Arq', 'dinero', 10), ('Mercado Pago', 'dinero', 20),
  ('Retenido en Mercado Pago', 'retenido', 30), ('Deuda con Meta', 'deuda', 40)
ON CONFLICT DO NOTHING;
WITH segunda AS (
  INSERT INTO finance_accounts (name, kind, sort_order) VALUES
    ('Arq', 'dinero', 10), ('Mercado Pago', 'dinero', 20),
    ('Retenido en Mercado Pago', 'retenido', 30), ('Deuda con Meta', 'deuda', 40)
  ON CONFLICT DO NOTHING
  RETURNING 1
)
SELECT '16. seed idempotente' AS afirmacion, count(*)::int AS insertadas_2da_vez FROM segunda;

SELECT '16b. cuentas sembradas' AS afirmacion, count(*)::int AS total FROM finance_accounts;
-- esperado exactamente: total = 4


-- Limpieza final: la scratch se borra igual, pero dejar el escenario adentro
-- hace que una segunda corrida del archivo empiece de cero.
DELETE FROM finance_movements WHERE note LIKE 'ver-%';


-- ─────────────────────────────────────────────────────────────────────────────
-- 17. REEMPLAZAR LOS CHECK DE finance_movements CON LA TABLA CARGADA.
--     Es lo que va a pasar en producción, donde la tabla ya tiene movimientos
--     reales. Si alguna fila existente violara el CHECK nuevo, el ALTER aborta
--     y la migración 028 se cae a la mitad.
--
--     Se cargan primero las 4 clases de movimiento válidas, después se
--     reaplican los tres ALTER (idempotentes por el DROP ... IF EXISTS) y se
--     confirma que ninguna fila se perdió.
--
-- esperado exactamente: filas_antes = 4 | alter = OK | filas_despues = 4
-- ─────────────────────────────────────────────────────────────────────────────
DELETE FROM finance_movements WHERE note LIKE 'ver17-%';
INSERT INTO finance_movements (kind, category, amount_eur, note, day) VALUES
  ('gasto',  'sueldos', -300.00, 'ver17-gasto',  '2026-08-01'),
  ('retiro', NULL,      -900.00, 'ver17-retiro', '2026-08-02'),
  ('ajuste', NULL,      -50.00,  'ver17-ajuste', '2026-08-03'),
  ('aporte', NULL,      3000.00, 'ver17-aporte', '2026-08-04');

SELECT '17. antes del ALTER' AS afirmacion, count(*)::int AS filas_antes
FROM finance_movements WHERE note LIKE 'ver17-%';

DO $$
BEGIN
  ALTER TABLE finance_movements DROP CONSTRAINT IF EXISTS finance_movements_kind_valido;
  ALTER TABLE finance_movements ADD  CONSTRAINT finance_movements_kind_valido
    CHECK (kind IN ('gasto', 'retiro', 'ajuste', 'aporte'));
  ALTER TABLE finance_movements DROP CONSTRAINT IF EXISTS finance_movements_signo;
  ALTER TABLE finance_movements ADD  CONSTRAINT finance_movements_signo
    CHECK ((kind IN ('gasto','retiro') AND amount_eur < 0)
        OR (kind = 'aporte' AND amount_eur > 0)
        OR (kind = 'ajuste' AND amount_eur <> 0));
  RAISE NOTICE '17. alter = OK (revalidó la tabla con filas adentro)';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE '17. alter = FALLÓ  <-- una fila existente viola el CHECK nuevo';
END $$;

SELECT '17. después del ALTER' AS afirmacion, count(*)::int AS filas_despues
FROM finance_movements WHERE note LIKE 'ver17-%';


-- ─────────────────────────────────────────────────────────────────────────────
-- 18. Un `aporte` NEGATIVO se rechaza (para eso está `retiro`), y un `retiro`
--     positivo también. El signo de las 4 clases lo garantiza la base.
-- esperado exactamente: aporte_negativo = RECHAZADO | retiro_positivo = RECHAZADO
--                       aporte_con_categoria = RECHAZADO
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  INSERT INTO finance_movements (kind, category, amount_eur, note, day)
    VALUES ('aporte', NULL, -100.00, 'ver18-a', '2026-08-05');
  RAISE NOTICE '18. aporte_negativo = ACEPTADO  <-- BUG';
EXCEPTION WHEN check_violation THEN RAISE NOTICE '18. aporte_negativo = RECHAZADO';
END $$;
DO $$
BEGIN
  INSERT INTO finance_movements (kind, category, amount_eur, note, day)
    VALUES ('retiro', NULL, 100.00, 'ver18-b', '2026-08-05');
  RAISE NOTICE '18. retiro_positivo = ACEPTADO  <-- BUG';
EXCEPTION WHEN check_violation THEN RAISE NOTICE '18. retiro_positivo = RECHAZADO';
END $$;
DO $$
BEGIN
  INSERT INTO finance_movements (kind, category, amount_eur, note, day)
    VALUES ('aporte', 'sueldos', 100.00, 'ver18-c', '2026-08-05');
  RAISE NOTICE '18. aporte_con_categoria = ACEPTADO  <-- BUG';
EXCEPTION WHEN check_violation THEN RAISE NOTICE '18. aporte_con_categoria = RECHAZADO';
END $$;


-- ─────────────────────────────────────────────────────────────────────────────
-- 19. LA GANANCIA DEL MES RESTA LOS RETIROS Y LOS APORTES.
--     Escenario: el patrimonio subió 3.500 en el mes, pero 3.000 los puso el
--     usuario de su bolsillo y encima sacó 200. El negocio generó 700.
--
--     ganancia = Δ − retiros − aportes
--              = 3500 − (−200) − (3000) = 700
--
--     Sin el término de aportes daría 3.700: el gráfico diría que el negocio
--     ganó cinco veces más de lo que ganó, exactamente el mes en que el usuario
--     inyectó plata.
--
-- esperado exactamente: delta 3500.00 | retiros −200.00 | aportes 3000.00 | ganancia 700.00
-- ─────────────────────────────────────────────────────────────────────────────
DELETE FROM finance_movements WHERE note LIKE 'ver19-%';
INSERT INTO finance_movements (kind, category, amount_eur, note, day) VALUES
  ('retiro', NULL,  -200.00, 'ver19-retiro', '2026-09-10'),
  ('aporte', NULL,  3000.00, 'ver19-aporte', '2026-09-12');

WITH datos AS (
  SELECT 3500.00::numeric AS delta,
         (SELECT COALESCE(SUM(amount_eur), 0) FROM finance_movements
           WHERE kind = 'retiro' AND note LIKE 'ver19-%') AS retiros,
         (SELECT COALESCE(SUM(amount_eur), 0) FROM finance_movements
           WHERE kind = 'aporte' AND note LIKE 'ver19-%') AS aportes
)
SELECT '19. ganancia con aporte' AS afirmacion,
       delta::text, retiros::text, aportes::text,
       (delta - retiros - aportes)::text AS ganancia
FROM datos;

DELETE FROM finance_movements WHERE note LIKE 'ver1%-%';
