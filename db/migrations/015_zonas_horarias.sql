-- ═══════════════════════════════════════════════════════════════════════════
-- 015 — Zona horaria de la cuenta publicitaria.
--
-- EL PROBLEMA QUE RESUELVE
-- Hay DOS calendarios en juego y hasta ahora se comparaban como si fueran uno:
--
--   · `orders.day` / `sessions.day` / `events.day` se calculan con
--     `funnels.timezone` (la zona de la tienda).
--   · `ad_spend.day` viene de Meta con `time_increment=1`, y Meta reporta los
--     días en la zona de la CUENTA publicitaria, que puede ser otra.
--
-- Con la tienda en America/Argentina/Buenos_Aires (UTC−3) y la cuenta en
-- Europe/Lisbon (UTC+1), la medianoche de Meta cae a las 20:00 del día anterior
-- en Argentina: el día de Meta arranca 4 horas antes. El ROAS de un día
-- cualquiera estaba dividiendo la facturación de un recorte por el gasto de
-- otro, y nada avisaba.
--
-- POR QUÉ SE GUARDA Y NO SE ASUME
-- Meta expone `timezone_name` por cuenta. Guardarlo permite (a) que el panel
-- avise cuando los dos calendarios no coinciden, en vez de mostrar un ROAS
-- desalineado en silencio, y (b) que el usuario elija: si pone la zona de la
-- tienda igual a la de la cuenta, los dos días coinciden y el cruce es exacto
-- sin necesidad de datos por hora.
--
-- POR QUÉ NO SE REBUCKETEA EL GASTO
-- Reexpresar el gasto diario de Meta en otra zona necesita el desglose por
-- hora (`hourly_stats_aggregated_by_advertiser_time_zone`); repartir un total
-- diario entre dos días con una proporción inventada daría un número que
-- parece preciso y no lo es. Mientras el gasto siga siendo diario, la zona se
-- informa y el usuario decide.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE ad_accounts
  -- NULL = todavía no se sincronizó desde Meta. No hay default: inventar
  -- 'UTC' haría parecer que el dato está confirmado cuando no se pidió nunca.
  ADD COLUMN IF NOT EXISTS timezone text;

COMMENT ON COLUMN ad_accounts.timezone IS
  'Zona horaria con la que Meta reporta los días de esta cuenta (timezone_name). Define el corte de ad_spend.day.';

COMMENT ON COLUMN funnels.timezone IS
  'Zona horaria de la tienda: define el corte de orders.day, sessions.day y events.day. Cambiarla recalcula esos días (ver scripts/recompute-days.ts).';
