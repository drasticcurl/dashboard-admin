#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Verificación end-to-end de Finanzas (T04 §5) — corre contra la base LOCAL
# de desarrollo, NUNCA contra producción (mismo límite duro que la fase 3 de
# T01).
#
# Prueba el circuito completo: cron de profit (finance-rollup) → cron de
# pagos (finance-scheduled-payments) → lectura de la base. El caso central
# es la idempotencia: correr finance-scheduled-payments dos veces el mismo
# día NO duplica el gasto — es el bug más caro de todo el módulo (plata que
# se cuenta dos veces).
#
# Uso:  bash tasks/finanzas/_verificacion-e2e.sh
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "FALTA DATABASE_URL — corré con el .env cargado:"
  echo "  set -a; source .env; set +a; bash tasks/finanzas/_verificacion-e2e.sh"
  exit 1
fi

PSQL="psql $DATABASE_URL -v ON_ERROR_STOP=1 -tA"

echo "0. Preparando la base (limpia de restos de corridas anteriores)..."
$PSQL -c "DELETE FROM finance_scheduled_payments WHERE name = 'E2E alquiler de prueba';"
$PSQL -c "DELETE FROM finance_movements WHERE note = 'E2E alquiler de prueba (automático)';"

echo "1. Sembrando un pago programado atrasado de prueba (day_of_month = 1)..."
$PSQL -c "INSERT INTO finance_scheduled_payments (name, category, amount_eur, day_of_month, active) VALUES ('E2E alquiler de prueba', 'alquiler', 400, 1, true);"
PAGO_ID=$( $PSQL -c "SELECT id FROM finance_scheduled_payments WHERE name = 'E2E alquiler de prueba';" )
echo "   pago sembrado con id=$PAGO_ID"

echo "2. Corriendo finance-rollup..."
npm run finance:rollup

echo "3. Corriendo finance-scheduled-payments (primera corrida)..."
npm run finance:pagos

echo "4. Verificando que el gasto se generó (esperado: 1 fila, -400.00)..."
FILAS=$( $PSQL -c "SELECT count(*) FROM finance_movements WHERE scheduled_payment_id = $PAGO_ID;" )
MONTO=$( $PSQL -c "SELECT amount_eur FROM finance_movements WHERE scheduled_payment_id = $PAGO_ID;" )
echo "   filas=$FILAS monto=$MONTO"
[ "$FILAS" = "1" ] || { echo "FALLO: se esperaba 1 fila, hay $FILAS"; exit 1; }
[ "$MONTO" = "-400.00" ] || { echo "FALLO: se esperaba -400.00, hay $MONTO"; exit 1; }

RUNS=$( $PSQL -c "SELECT count(*) FROM finance_scheduled_payment_runs WHERE scheduled_payment_id = $PAGO_ID;" )
echo "   runs=$RUNS (finance_scheduled_payment_runs)"
[ "$RUNS" = "1" ] || { echo "FALLO: se esperaba 1 run, hay $RUNS"; exit 1; }

echo "5. Corriendo finance-scheduled-payments OTRA VEZ (no debe duplicar)..."
npm run finance:pagos

echo "6. Verificando que sigue habiendo 1 sola fila (esperado: 1, NO 2)..."
FILAS=$( $PSQL -c "SELECT count(*) FROM finance_movements WHERE scheduled_payment_id = $PAGO_ID;" )
RUNS=$( $PSQL -c "SELECT count(*) FROM finance_scheduled_payment_runs WHERE scheduled_payment_id = $PAGO_ID;" )
echo "   filas=$FILAS runs=$RUNS"
[ "$FILAS" = "1" ] || { echo "FALLO CRÍTICO: el pago se duplicó ($FILAS filas) — reportar, no seguir"; exit 1; }
[ "$RUNS" = "1" ] || { echo "FALLO CRÍTICO: hay $RUNS runs"; exit 1; }

echo "7. Limpiando los datos de prueba..."
$PSQL -c "DELETE FROM finance_scheduled_payments WHERE id = $PAGO_ID;"
# El movimiento generado queda con scheduled_payment_id = NULL (D9) y se
# borra por la nota; el run se fue con el pago (ON DELETE CASCADE).
$PSQL -c "DELETE FROM finance_movements WHERE note = 'E2E alquiler de prueba (automático)';"
$PSQL -c "DELETE FROM finance_daily_profit WHERE day >= (now()::date - 2);"

echo ""
echo "E2E FINANZAS: OK — el circuito completo funciona y el pago no se duplica."
