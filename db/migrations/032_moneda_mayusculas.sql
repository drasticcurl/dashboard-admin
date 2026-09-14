-- ═══════════════════════════════════════════════════════════════════════════
-- 032 — Los códigos de moneda, en MAYÚSCULA. Una sola forma canónica.
--
-- CORRE SOBRE DATOS VIVOS. Aditiva e idempotente: normaliza el caso de dos
-- columnas de texto y no toca ni un importe.
--
-- ── QUÉ PASABA ────────────────────────────────────────────────────────────
-- `lib/orders/checkout-propio.ts` guardaba `orders.currency` con
-- `.toLowerCase()`, espejando lo que hace `armarPayloadIngest` del checkout. Las
-- dos ventas LATAM del 2026-09-14 quedaron entonces con `currency = 'usd'`,
-- mientras `funnels.sell_currency` del mismo funnel dice 'USD'.
--
-- Nada falla con eso, y ahí está el problema. Las dos queries que convierten el
-- gasto de publicidad a la moneda del funnel —`AD_SPEND_SQL` en
-- lib/queries/sales.ts y la de `ad_spend` en scripts/rollup.ts— unen así:
--
--     WHERE fr.base = f.sell_currency AND fr.quote = 'EUR'
--
-- o sea contra `funnels.sell_currency` ('USD'), no contra `orders.currency`. Con
-- la única fila de cotización cargada como `base = 'usd'`, esa subconsulta
-- devuelve NULL, el `NULLIF(...,0)` la propaga y el `COALESCE(sum(...), 0)`
-- final la convierte en un 0 perfectamente creíble: el funnel LATAM mostraba
-- €0,00 de gasto con campañas gastando de verdad.
--
-- ── POR QUÉ MAYÚSCULA Y NO MINÚSCULA ──────────────────────────────────────
-- Porque es lo que ya está en el resto de la base y no se puede cambiar sin
-- reescribir historia: `funnels.sell_currency` ('ARS', 'USD'), los 6476 orders
-- de Shopify ('ARS'), `ad_accounts.currency` ('EUR') y las 105 filas de
-- `fx_rates` del par del peso ('ARS'→'EUR'). Normalizar hacia minúscula
-- tocaría miles de filas y todos los `WHERE currency = 'ARS'` del código;
-- hacia mayúscula toca 3 filas en total.
--
-- ── EL CÓDIGO YA NO DEPENDE DE ESTO, PERO LA MIGRACIÓN IGUAL HACE FALTA ────
-- `lib/fx.ts:getRate` compara con `upper()` en las dos puntas, así que una fila
-- vieja en minúscula encuentra su cotización igual. Lo que NO se puede arreglar
-- desde el borde de lectura son las dos queries de arriba, que unen columna
-- contra columna dentro del SQL. Por eso las filas se normalizan.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 1. fx_rates
-- ───────────────────────────────────────────────────────────────────────────
--
-- En dos pasos por la PK (day, base, quote): subir una fila a mayúscula cuando
-- ya existe su gemela en mayúscula viola la clave y aborta la migración entera.
--
-- El UPDATE sólo mueve las filas que no colisionan. El `NOT EXISTS` no puede
-- matchear la propia fila: el WHERE de afuera exige que al menos una de las dos
-- columnas difiera de su mayúscula, así que (upper(base), upper(quote)) es
-- siempre una clave distinta de la de `f`.
UPDATE fx_rates f
   SET base = upper(f.base), quote = upper(f.quote)
 WHERE (f.base <> upper(f.base) OR f.quote <> upper(f.quote))
   AND NOT EXISTS (
         SELECT 1 FROM fx_rates g
          WHERE g.day = f.day
            AND g.base = upper(f.base)
            AND g.quote = upper(f.quote));

-- Lo que sigue en minúscula después del UPDATE es, por construcción, un
-- duplicado de una fila que ya existe en mayúscula. Se borra la minúscula y
-- GANA LA MAYÚSCULA, que es la que el cron va a seguir pisando todos los días
-- (`saveRate` escribe `upper(base)`). Si las dos tuvieran cotizaciones
-- distintas, la diferencia no mueve ninguna venta ya guardada: `orders.fx_rate`
-- y `orders.amount_eur` están congelados desde la ingesta (D12/D13).
DELETE FROM fx_rates f
 WHERE f.base <> upper(f.base) OR f.quote <> upper(f.quote);

-- ───────────────────────────────────────────────────────────────────────────
-- 2. orders
-- ───────────────────────────────────────────────────────────────────────────
--
-- No toca `amount_eur`, `fx_rate` ni `fx_day`: la conversión de esas dos ventas
-- ya está hecha y es correcta (rate 0,862246 del 2026-09-14). Cambiar el caso
-- del código de moneda no cambia cuánto valía la venta.
UPDATE orders
   SET currency = upper(currency), updated_at = now()
 WHERE currency <> upper(currency);
