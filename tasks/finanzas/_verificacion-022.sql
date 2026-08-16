-- Verificación del esquema de Finanzas (022), YA CORRIDA contra una base
-- scratch con las migraciones 001-020 aplicadas (la 021 no corre desde cero
-- en una base limpia: requiere una fila en ad_accounts que sólo existe una
-- vez sincronizados los anuncios de verdad — no tiene relación con este
-- esquema, es un problema preexistente del repo, anotado en §10 del plan).
--
-- Las 21 afirmaciones de abajo dieron el resultado esperado el 2026-08-16.
-- Todo dentro de una transacción que se descarta: no deja rastro.

\set ON_ERROR_STOP on
BEGIN;

\echo '═══ 1. Un gasto en positivo se rechaza ═══'
\echo 'por qué importa: sin este CHECK, un gasto tipeado sin el signo suma en vez de restar y el patrimonio miente sin avisar'
\echo 'esperado: se rechaza (finance_movements_signo)'
DO $$
BEGIN
  INSERT INTO finance_movements (kind, category, amount_eur, note, day)
  VALUES ('gasto', 'sueldos', 100, 'sueldo cargado mal, en positivo', current_date);
  RAISE EXCEPTION 'NO DEBERIA LLEGAR ACA';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK: se rechazó el gasto en positivo';
END $$;

\echo '═══ 2. Un gasto en negativo, con categoría válida, entra ═══'
\echo 'esperado exactamente: 1'
INSERT INTO finance_movements (kind, category, amount_eur, note, day)
VALUES ('gasto', 'sueldos', -500.00, 'sueldo agosto', '2026-08-01');
SELECT count(*) FROM finance_movements WHERE note = 'sueldo agosto';

\echo '═══ 3. Un retiro en positivo se rechaza ═══'
\echo 'esperado: se rechaza (finance_movements_signo)'
DO $$
BEGIN
  INSERT INTO finance_movements (kind, category, amount_eur, note, day)
  VALUES ('retiro', NULL, 200, 'retiro mal cargado', current_date);
  RAISE EXCEPTION 'NO DEBERIA LLEGAR ACA';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK: se rechazó el retiro en positivo';
END $$;

\echo '═══ 4. Un retiro CON categoría se rechaza (solo el gasto lleva categoría) ═══'
\echo 'por qué importa: un retiro con categoría de gasto contaminaría el desglose por categoría de gastos operativos'
\echo 'esperado: se rechaza (finance_movements_categoria_solo_gasto)'
DO $$
BEGIN
  INSERT INTO finance_movements (kind, category, amount_eur, note, day)
  VALUES ('retiro', 'otros', -200, 'retiro con categoria', current_date);
  RAISE EXCEPTION 'NO DEBERIA LLEGAR ACA';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK: se rechazó el retiro con categoría';
END $$;

\echo '═══ 5. Un retiro válido (negativo, sin categoría) entra ═══'
\echo 'esperado exactamente: 1'
INSERT INTO finance_movements (kind, category, amount_eur, note, day)
VALUES ('retiro', NULL, -300.00, 'retiro para mi cuenta', '2026-08-05');
SELECT count(*) FROM finance_movements WHERE note = 'retiro para mi cuenta';

\echo '═══ 6. Un ajuste en 0 se rechaza (un ajuste tiene que mover algo, o no es un ajuste) ═══'
\echo 'esperado: se rechaza (finance_movements_signo)'
DO $$
BEGIN
  INSERT INTO finance_movements (kind, category, amount_eur, note, day)
  VALUES ('ajuste', NULL, 0, 'ajuste en cero', current_date);
  RAISE EXCEPTION 'NO DEBERIA LLEGAR ACA';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK: se rechazó el ajuste en cero';
END $$;

\echo '═══ 7. Un ajuste puede ser positivo O negativo (es la vía de escape) ═══'
\echo 'esperado exactamente: 2'
INSERT INTO finance_movements (kind, category, amount_eur, note, day) VALUES
  ('ajuste', NULL, 50.00, 'corrección a favor', '2026-08-06'),
  ('ajuste', NULL, -20.00, 'corrección en contra', '2026-08-06');
SELECT count(*) FROM finance_movements WHERE kind = 'ajuste';

\echo '═══ 8. Una categoría fuera de la lista fija se rechaza ═══'
\echo 'esperado: se rechaza (finance_movements_categoria_solo_gasto)'
DO $$
BEGIN
  INSERT INTO finance_movements (kind, category, amount_eur, note, day)
  VALUES ('gasto', 'inventada', -10, 'categoria que no existe', current_date);
  RAISE EXCEPTION 'NO DEBERIA LLEGAR ACA';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK: se rechazó la categoría inventada';
END $$;

\echo '═══ 9. El patrimonio es la suma de LAS DOS tablas, nunca una columna acumulada ═══'
\echo 'esperado exactamente: profit_acumulado=113.45 movimientos_acumulados=-770.00 patrimonio_total=-656.55'
INSERT INTO finance_daily_profit (day, amount_eur) VALUES ('2026-08-01', 123.45), ('2026-08-02', -10.00);
SELECT
  (SELECT COALESCE(SUM(amount_eur), 0) FROM finance_daily_profit) AS profit_acumulado,
  (SELECT COALESCE(SUM(amount_eur), 0) FROM finance_movements) AS movimientos_acumulados,
  (SELECT COALESCE(SUM(amount_eur), 0) FROM finance_daily_profit)
    + (SELECT COALESCE(SUM(amount_eur), 0) FROM finance_movements) AS patrimonio_total;

\echo '═══ 10. finance_daily_profit se RECALCULA (upsert por día), no se acumula ═══'
\echo 'por qué importa: mismo motivo que daily_metrics — si Meta ajusta el gasto de ayer, el cron tiene que poder pisar el valor viejo, no sumarle otra fila'
\echo 'esperado: 2026-08-01 pasa a 999.99, siguen siendo 2 filas'
INSERT INTO finance_daily_profit (day, amount_eur) VALUES ('2026-08-01', 999.99)
  ON CONFLICT (day) DO UPDATE SET amount_eur = EXCLUDED.amount_eur, computed_at = now();
SELECT day, amount_eur FROM finance_daily_profit ORDER BY day;
SELECT count(*) AS filas FROM finance_daily_profit;

\echo '═══ 11. day_of_month fuera de 1-28 se rechaza ═══'
\echo 'por qué importa: un pago del día 31 no puede ejecutarse en febrero — 1-28 es el rango que todos los meses tienen, sin inventar un caso especial de "último día del mes"'
\echo 'esperado: se rechaza (finance_scheduled_payments_dia_valido)'
DO $$
BEGIN
  INSERT INTO finance_scheduled_payments (name, category, amount_eur, day_of_month)
  VALUES ('alquiler', 'alquiler', -400, 31);
  RAISE EXCEPTION 'NO DEBERIA LLEGAR ACA';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK: se rechazó day_of_month = 31';
END $$;

\echo '═══ 12. Un pago programado válido entra con monto POSITIVO ═══'
\echo 'por qué importa: la tabla de plantilla no lleva signo (no es un movimiento, es la receta); el signo lo pone ejecutarPagosAtrasados() al generar el movimiento'
\echo 'esperado exactamente: 1'
INSERT INTO finance_scheduled_payments (name, category, amount_eur, day_of_month)
VALUES ('Alquiler oficina', 'alquiler', 400.00, 5);
SELECT count(*) FROM finance_scheduled_payments;

\echo '═══ 13. Borrar el pago programado NO borra el movimiento ya generado ═══'
\echo 'esperado: scheduled_payment_id queda NULL, la fila sigue'
INSERT INTO finance_movements (kind, category, amount_eur, note, day, scheduled_payment_id)
VALUES ('gasto', 'alquiler', -400.00, 'Alquiler oficina (automático)', '2026-08-05',
        (SELECT id FROM finance_scheduled_payments WHERE name = 'Alquiler oficina'));
DELETE FROM finance_scheduled_payments WHERE name = 'Alquiler oficina';
SELECT scheduled_payment_id, note FROM finance_movements WHERE note = 'Alquiler oficina (automático)';

\echo '═══ 14. Un pago programado no puede ejecutarse dos veces el mismo mes (idempotencia estructural) ═══'
\echo 'por qué importa: si el cron y el botón manual corren casi a la vez, el UNIQUE (no una condición en el código) es lo único que garantiza que el gasto no se duplique'
\echo 'esperado: la segunda corrida del mismo mes se rechaza (unique_violation)'
INSERT INTO finance_scheduled_payments (name, category, amount_eur, day_of_month)
VALUES ('Herramientas SaaS', 'herramientas', 50.00, 10);
DO $$
DECLARE sp_id bigint; mv_id bigint;
BEGIN
  SELECT id INTO sp_id FROM finance_scheduled_payments WHERE name = 'Herramientas SaaS';
  INSERT INTO finance_movements (kind, category, amount_eur, note, day, scheduled_payment_id)
  VALUES ('gasto', 'herramientas', -50, 'Herramientas SaaS (automático)', '2026-08-10', sp_id)
  RETURNING id INTO mv_id;
  INSERT INTO finance_scheduled_payment_runs (scheduled_payment_id, month, movement_id)
  VALUES (sp_id, '2026-08', mv_id);
  INSERT INTO finance_scheduled_payment_runs (scheduled_payment_id, month, movement_id)
  VALUES (sp_id, '2026-08', mv_id);
  RAISE EXCEPTION 'NO DEBERIA LLEGAR ACA';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'OK: se rechazó la segunda corrida del mismo mes';
END $$;

\echo '═══ 15. El profit diario suma TODOS los funnels de daily_metrics, cruzando IDs ═══'
\echo 'esperado exactamente: 150.00  (funnel test-f1: 200-0-10-5-85=100 · funnel test-f2: 100-10-5-5-30=50)'
INSERT INTO funnels (slug, name, ingest_key_hash) VALUES
  ('test-f1', 'Test F1', 'hash1'), ('test-f2', 'Test F2', 'hash2');
INSERT INTO daily_metrics (funnel_id, day, variant, revenue_gross_eur, revenue_refunded_eur, commissions_eur, costs_eur, ad_spend_eur)
SELECT id, '2026-08-10', '*', 200, 0, 10, 5, 85 FROM funnels WHERE slug = 'test-f1';
INSERT INTO daily_metrics (funnel_id, day, variant, revenue_gross_eur, revenue_refunded_eur, commissions_eur, costs_eur, ad_spend_eur)
SELECT id, '2026-08-10', '*', 100, 10, 5, 5, 30 FROM funnels WHERE slug = 'test-f2';
SELECT
  (COALESCE(SUM(revenue_gross_eur), 0) - COALESCE(SUM(revenue_refunded_eur), 0)
   - COALESCE(SUM(commissions_eur), 0) - COALESCE(SUM(costs_eur), 0)
   - COALESCE(SUM(ad_spend_eur), 0)) AS profit_del_dia
FROM daily_metrics WHERE variant = '*' AND day = '2026-08-10';

\echo '═══ 16-19. Qué pagos programados están "atrasados" el 2026-08-20 (query real de _server.ts) ═══'
\echo 'Atrasado: day_of_month=5, sin run este mes → atrasado'
\echo 'Futuro: day_of_month=25, el día todavía no llegó → NO atrasado'
\echo 'YaPagado: day_of_month=10, YA tiene run 2026-08 → NO atrasado (ya se pagó)'
\echo 'Pausado: day_of_month=1, active=false → NO atrasado (está pausado)'
\echo 'esperado EXACTO: una sola fila, "Atrasado"'
-- La afirmación 14 deja a 'Herramientas SaaS' sin run para 2026-08: su DO
-- captura la unique_violation del segundo INSERT y ROLLBACKEA con ella el
-- run del bloque (la semántica del EXCEPTION de PL/pgSQL revierte todo lo
-- del bloque), así que el pago queda "atrasado" a los ojos de esta query.
-- Se limpia para que esta afirmación pruebe exactamente los 4 casos de D8.
DELETE FROM finance_scheduled_payments WHERE name = 'Herramientas SaaS';
INSERT INTO finance_scheduled_payments (name, category, amount_eur, day_of_month, active) VALUES
  ('Atrasado', 'alquiler', 400, 5, true),
  ('Futuro', 'alquiler', 400, 25, true),
  ('Pausado', 'otros', 15, 1, false);
INSERT INTO finance_scheduled_payments (name, category, amount_eur, day_of_month, active)
VALUES ('YaPagado', 'herramientas', 20, 10, true);
INSERT INTO finance_movements (kind, category, amount_eur, note, day, scheduled_payment_id)
VALUES ('gasto', 'herramientas', -20, 'YaPagado (automático)', '2026-08-10',
        (SELECT id FROM finance_scheduled_payments WHERE name = 'YaPagado'));
INSERT INTO finance_scheduled_payment_runs (scheduled_payment_id, month, movement_id)
VALUES ((SELECT id FROM finance_scheduled_payments WHERE name = 'YaPagado'), '2026-08',
        (SELECT id FROM finance_movements WHERE note = 'YaPagado (automático)'));

SELECT sp.name
FROM finance_scheduled_payments sp
WHERE sp.active
  AND sp.day_of_month <= EXTRACT(DAY FROM '2026-08-20'::date)::smallint
  AND NOT EXISTS (
    SELECT 1 FROM finance_scheduled_payment_runs r
    WHERE r.scheduled_payment_id = sp.id AND r.month = to_char('2026-08-20'::date, 'YYYY-MM')
  )
ORDER BY sp.name;

\echo '═══ 20. Evolución mensual: continua, SIN huecos, incluso en un mes sin corridas del cron ═══'
\echo 'por qué importa: un mes ausente en el gráfico miente sobre la continuidad, igual que byDay en overview.ts'
\echo 'esperado EXACTO: 2026-06 → profit 150.00 movimientos -500.00 neto -350.00'
\echo '               2026-07 → profit   0.00 movimientos -400.00 neto -400.00  (julio sin filas de profit, y aparece en 0, no desaparece)'
\echo '               2026-08 → profit  30.00 movimientos -175.00 neto -145.00'
DELETE FROM finance_daily_profit; DELETE FROM finance_movements;
INSERT INTO finance_daily_profit (day, amount_eur) VALUES
  ('2026-06-05', 100.00), ('2026-06-20', 50.00), ('2026-08-01', 40.00), ('2026-08-15', -10.00);
INSERT INTO finance_movements (kind, category, amount_eur, note, day) VALUES
  ('gasto', 'sueldos', -500.00, 'sueldo junio', '2026-06-28'),
  ('gasto', 'alquiler', -400.00, 'alquiler julio', '2026-07-05'),
  ('retiro', NULL, -200.00, 'retiro agosto', '2026-08-10'),
  ('ajuste', NULL, 25.00, 'ajuste agosto', '2026-08-20');
WITH meses AS (
  SELECT generate_series(date_trunc('month', '2026-06-01'::date), date_trunc('month', '2026-08-01'::date), interval '1 month')::date AS mes
),
profit_mes AS (SELECT date_trunc('month', day)::date AS mes, SUM(amount_eur) AS profit FROM finance_daily_profit GROUP BY 1),
mov_mes AS (SELECT date_trunc('month', day)::date AS mes, SUM(amount_eur) AS movimientos FROM finance_movements GROUP BY 1)
SELECT to_char(m.mes, 'YYYY-MM') AS mes, COALESCE(p.profit, 0) AS profit, COALESCE(mv.movimientos, 0) AS movimientos,
       COALESCE(p.profit, 0) + COALESCE(mv.movimientos, 0) AS neto_del_mes
FROM meses m LEFT JOIN profit_mes p ON p.mes = m.mes LEFT JOIN mov_mes mv ON mv.mes = m.mes
ORDER BY m.mes;

\echo '═══ 21. Patrimonio total del histórico completo (no sólo el rango mostrado en el gráfico) ═══'
\echo 'esperado exactamente: -895.00'
SELECT
  (SELECT COALESCE(SUM(amount_eur),0) FROM finance_daily_profit) +
  (SELECT COALESCE(SUM(amount_eur),0) FROM finance_movements) AS patrimonio_total;

ROLLBACK;
