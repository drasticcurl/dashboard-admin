#!/usr/bin/env bash
#
# Verificación end-to-end del módulo de saldo por cuentas (T06 §5).
#
# Prueba las cinco cosas que ninguna task anterior pudo probar sola, porque
# cruzan capas: la migración, `lib/queries/saldo.ts`, `lib/queries/finance.ts` y
# el módulo viejo de pagos programados, todos juntos.
#
# CONTRA LA BASE LOCAL, nunca contra producción: inserta y borra datos. Se aísla
# con el prefijo 'e2e-saldo-' en el nombre de las cuentas y en la nota de los
# movimientos, y limpia por ese prefijo al empezar y al terminar.
#
#   bash tasks/saldo-cuentas/_verificacion-e2e.sh
#
# Sale con 0 si las cinco afirmaciones dan lo documentado, con 1 si alguna falla.

set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

if [ ! -f .env ]; then
  echo "FALTA .env — este script corre contra la base LOCAL de desarrollo." >&2
  exit 1
fi

FALLOS=0

# `node --env-file` y no `npm run`: los scripts del repo no cargan .env solos.
run_ts() { node --env-file=.env ./node_modules/.bin/tsx "$@"; }

comparar() { # $1=nombre  $2=esperado  $3=obtenido
  if [ "$2" = "$3" ]; then
    printf '  ✓ %s\n' "$1"
  else
    printf '  ✗ %s\n      esperado: %s\n      obtenido: %s\n' "$1" "$2" "$3"
    FALLOS=$((FALLOS + 1))
  fi
}

# ─── 1 a 3: la aritmética, cruzando saldo.ts y finance.ts ────────────────────
echo "── 1-3. patrimonio, día incompleto y ganancia con aporte"

SALIDA=$(run_ts --eval '
import { q } from "./lib/db";
import { createAccount, guardarSaldosDelDia, serieMensual } from "./lib/queries/saldo";
import { createMovement, getFinanceOverview } from "./lib/queries/finance";

const P = "e2e-saldo-";
const limpiar = async () => {
  await q(`DELETE FROM finance_accounts WHERE name LIKE $1`, [P + "%"]);
  await q(`DELETE FROM finance_movements WHERE note LIKE $1`, [P + "%"]);
};

const main = async () => {
  await limpiar();
  const cta = async (n: string, kind: any, openedOn = "2026-06-01") =>
    (await createAccount({ name: P + n, kind, openedOn })).id;

  const arq  = await cta("arq", "dinero");
  const mp   = await cta("mp", "dinero");
  const ret  = await cta("ret", "retenido");
  const meta = await cta("meta", "deuda");

  // ── 1. Un día completo: la deuda RESTA aunque se tipee en positivo.
  //    8000 + 1500 + 700 − 1200 = 9000
  const dia1 = await guardarSaldosDelDia("2026-06-30", [
    { accountId: arq, amountEur: 8000 }, { accountId: mp, amountEur: 1500 },
    { accountId: ret, amountEur: 700 },  { accountId: meta, amountEur: 1200 },
  ]);
  const ov1 = await getFinanceOverview();
  console.log("1a=" + dia1.totalEur);
  console.log("1b=" + ov1.patrimonioTotalEur);
  console.log("1c=" + ov1.diaPatrimonio);
  console.log("1d=" + ov1.desglose?.deudaEur);

  // ── 2. Se borra UNA cuenta del día: el patrimonio de ese día pasa a null y
  //    la cuenta aparece en `faltan`. 8300 sería creíble y equivocado.
  const dia2 = await guardarSaldosDelDia("2026-06-30", [{ accountId: meta, amountEur: null }]);
  console.log("2a=" + dia2.totalEur);
  console.log("2b=" + dia2.faltan.join(","));
  const ov2 = await getFinanceOverview();
  console.log("2c=" + ov2.patrimonioTotalEur);

  // ── 3. Dos meses cerrados + retiro + aporte.
  //    junio 9000 → julio 12500 = Δ 3500;  retiro 200, aporte 3000
  //    ganancia = 3500 − (−200) − 3000 = 700
  await guardarSaldosDelDia("2026-06-30", [{ accountId: meta, amountEur: 1200 }]);
  await guardarSaldosDelDia("2026-07-31", [
    { accountId: arq, amountEur: 11000 }, { accountId: mp, amountEur: 1800 },
    { accountId: ret, amountEur: 200 },   { accountId: meta, amountEur: 500 },
  ]);
  await createMovement({ kind: "retiro", category: null, amountEur: 200, note: P + "retiro", day: "2026-07-15" });
  await createMovement({ kind: "aporte", category: null, amountEur: 3000, note: P + "aporte", day: "2026-07-20" });

  const serie = await serieMensual(12);
  const jul = serie.find((p) => p.month === "2026-07");
  console.log("3a=" + jul?.cierreEur);
  console.log("3b=" + jul?.retirosEur);
  console.log("3c=" + jul?.aportesEur);
  console.log("3d=" + jul?.gananciaEur);

  // Un movimiento NO mueve el patrimonio: el saldo tipeado ya lo incluye.
  const ov3 = await getFinanceOverview();
  console.log("3e=" + ov3.patrimonioTotalEur);

  await limpiar();
};
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
' 2>&1)

if [ $? -ne 0 ]; then
  echo "  ✗ el bloque 1-3 no llegó a correr:"; echo "$SALIDA" | sed 's/^/      /'; FALLOS=$((FALLOS + 1))
else
  v() { echo "$SALIDA" | grep "^$1=" | cut -d= -f2-; }
  comparar "1a. día completo: 8000+1500+700−1200"      "9000"        "$(v 1a)"
  comparar "1b. el patrimonio sale de ese día"         "9000"        "$(v 1b)"
  comparar "1c. y dice de qué día es la foto"          "2026-06-30"  "$(v 1c)"
  comparar "1d. la deuda viaja POSITIVA en el desglose" "1200"       "$(v 1d)"
  comparar "2a. falta una cuenta → null, NO 8300"      "null"        "$(v 2a)"
  comparar "2b. y la nombra"                           "e2e-saldo-meta" "$(v 2b)"
  comparar "2c. sin ningún día completo → null"        "null"        "$(v 2c)"
  comparar "3a. cierre de julio"                       "12500"       "$(v 3a)"
  comparar "3b. retiros de julio (negativos)"          "-200"        "$(v 3b)"
  comparar "3c. aportes de julio (positivos)"          "3000"        "$(v 3c)"
  comparar "3d. ganancia = Δ3500 −(−200) −3000 = 700"  "700"         "$(v 3d)"
  comparar "3e. un movimiento NO mueve el patrimonio"  "12500"       "$(v 3e)"
fi

# ─── 4: el módulo viejo sigue funcionando ────────────────────────────────────
echo
echo "── 4. los pagos programados siguen siendo idempotentes"

SALIDA4=$(run_ts --eval '
import { q } from "./lib/db";
import { runScheduledPayments } from "./lib/queries/finance";

const P = "e2e-saldo-pago";
const main = async () => {
  await q(`DELETE FROM finance_scheduled_payments WHERE name LIKE $1`, [P + "%"]);
  await q(`DELETE FROM finance_movements WHERE note LIKE $1`, [P + "%"]);
  const r = await q<{ id: number }>(
    `INSERT INTO finance_scheduled_payments (name, category, amount_eur, day_of_month)
     VALUES ($1, $2, $3::numeric, $4) RETURNING id`, [P, "alquiler", 400, 5]);
  const id = r[0]!.id;

  // Dos corridas el mismo día. La PK (scheduled_payment_id, month) es la
  // garantía ESTRUCTURAL de que el gasto no se duplica.
  const a = await runScheduledPayments("2026-08-20");
  const b = await runScheduledPayments("2026-08-20");
  console.log("4a=" + a.ejecutados.length);
  console.log("4b=" + b.ejecutados.length);

  const f = await q<{ n: string; monto: string }>(
    `SELECT count(*)::text AS n, COALESCE(sum(amount_eur),0)::text AS monto
       FROM finance_movements WHERE scheduled_payment_id = $1`, [id]);
  console.log("4c=" + f[0]!.n);
  console.log("4d=" + f[0]!.monto);

  await q(`DELETE FROM finance_scheduled_payments WHERE name LIKE $1`, [P + "%"]);
  await q(`DELETE FROM finance_movements WHERE note LIKE $1`, [P + "%"]);
};
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
' 2>&1)

if [ $? -ne 0 ]; then
  echo "  ✗ el bloque 4 no llegó a correr:"; echo "$SALIDA4" | sed 's/^/      /'; FALLOS=$((FALLOS + 1))
else
  v4() { echo "$SALIDA4" | grep "^$1=" | cut -d= -f2-; }
  comparar "4a. la 1ra corrida ejecuta el pago"        "1"        "$(v4 4a)"
  comparar "4b. la 2da no ejecuta nada"                "0"        "$(v4 4b)"
  comparar "4c. y el gasto existe UNA sola vez"        "1"        "$(v4 4c)"
  comparar "4d. por el monto correcto, en negativo"    "-400.00"  "$(v4 4d)"
fi

# ─── 5: nada de lo que ya funcionaba cambió ──────────────────────────────────
echo
echo "── 5. Resumen y Ventas no se movieron"

SALIDA5=$(run_ts --eval '
import { getOverviewData } from "./lib/queries/overview";
import { getSalesData } from "./lib/queries/sales";

// Ninguna query de estos dos módulos se tocó, y ninguna de sus tablas tampoco.
// Lo que se verifica es que SIGUEN RESPONDIENDO: si un import circular o un
// tipo cambiado los rompiera, se vería acá y no en un test unitario.
const main = async () => {
  const r = { from: "2026-08-01", to: "2026-08-31" };
  const ov = await getOverviewData(r as any);
  const sa = await getSalesData(r as any);
  // `resultEur` vive en `totals`, no en la raíz de OverviewData. La primera
  // versión de este script lo buscaba en la raíz y daba `false`: era un fallo del
  // script, no del módulo. Se deja anotado porque el que lo lea va a dudar.
  console.log("5a=" + (typeof ov.totals.resultEur === "number"));
  console.log("5b=" + Array.isArray(ov.byDay));
  console.log("5c=" + (sa !== null && typeof sa === "object"));
};
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
' 2>&1)

if [ $? -ne 0 ]; then
  echo "  ✗ getOverviewData/getSalesData se rompieron:"; echo "$SALIDA5" | sed 's/^/      /'; FALLOS=$((FALLOS + 1))
else
  v5() { echo "$SALIDA5" | grep "^$1=" | cut -d= -f2-; }
  comparar "5a. getOverviewData sigue dando resultEur" "true" "$(v5 5a)"
  comparar "5b. y su serie por día"                    "true" "$(v5 5b)"
  comparar "5c. getSalesData sigue respondiendo"       "true" "$(v5 5c)"
fi

# ─── 6: la tabla vieja no existe y nadie la referencia ───────────────────────
echo
echo "── 6. finance_daily_profit se fue del todo"

EXISTE=$(node --env-file=.env ./node_modules/.bin/tsx --eval '
import { q1 } from "./lib/db";
q1<{ v: boolean }>(`SELECT to_regclass($1) IS NULL AS v`, ["finance_daily_profit"])
  .then((r) => { console.log(String(r!.v)); process.exit(0); })
  .catch(() => { console.log("error"); process.exit(1); });' 2>&1 | tail -1)
comparar "6a. la tabla no existe en la base" "true" "$EXISTE"

# Cuatro archivos la nombran SÓLO en comentarios que explican qué se derogó y por
# qué (finance.ts, su test, saldo.ts y el docblock de finance-scheduled-payments).
# Esos se conservan a propósito: son la respuesta a "¿por qué el patrimonio ya no
# se calcula?". Lo que se busca acá es una referencia EJECUTABLE.
REFS=$(grep -rn "finance_daily_profit\|finance-rollup" \
  --include="*.ts" --include="*.tsx" --include="*.json" \
  lib/ app/ scripts/ components/ package.json 2>/dev/null \
  | grep -v '^\S*: *\*' | grep -v '^\S*: *//' | grep -v '^\S*: *--' \
  | wc -l | tr -d ' ')
comparar "6b. sin referencias EJECUTABLES en el código" "0" "$REFS"

CRON=$(grep -c finance deploy/cron.panel)
comparar "6c. una sola línea de finanzas en el cron" "1" "$CRON"

echo
if [ "$FALLOS" -eq 0 ]; then
  echo "✓ las 6 afirmaciones dieron lo documentado."
  exit 0
fi
echo "✗ $FALLOS afirmación(es) fallaron."
exit 1
