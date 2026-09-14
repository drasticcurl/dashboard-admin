-- ═══════════════════════════════════════════════════════════════════════════
-- 033 — Una cuenta publicitaria, VARIOS funnels: el mapeo por campaña.
--
-- CORRE SOBRE DATOS VIVOS. Aditiva: crea una tabla vacía y no toca ni una fila
-- existente. Con la tabla vacía, todo se comporta exactamente como antes.
--
-- ── QUÉ PASABA ────────────────────────────────────────────────────────────
-- `ad_accounts.funnel_id` es UN funnel por cuenta, y `lib/ads/sync.ts` copia ese
-- valor a cada fila de `ad_spend` que escribe. Alcanzaba mientras cada funnel
-- tuviera su propia cuenta.
--
-- El 2026-09-14 la cuenta `act_2501344510302910` (HIlvanapp → funnel 1,
-- `chauhinchazon`) tenía además 4 campañas `LATAM 14/09 TEST …` gastando ~€59
-- para el funnel 3 (`chauhinchazon-latam`), y el plan es meter también las de
-- `gelatina` (funnel 4) en la misma cuenta. Con la imputación por cuenta:
--
--   · `daily_metrics` del 14/09 mostraba funnel 1 con €149,12 de ads (de los
--     cuales ~€59 eran de LATAM) y funnel 3 con €0,00 y 2 ventas. O sea: Chau
--     Hinchazón pagaba el gasto de LATAM y LATAM parecía gratis.
--   · Lo mismo en Ventas por funnel, que filtra `ad_spend.funnel_id = $1`, y en
--     el Resumen, el brief de IA y la reconciliación, que leen del rollup.
--
-- LO QUE NO ESTABA ROTO, Y POR ESO ESTA MIGRACIÓN ES CHICA: la pestaña de
-- Anuncios. `lib/queries/ads.ts` atribuye las ventas al objeto de Meta por el ID
-- que viene en los UTMs (`{{campaign.name}}|{{campaign.id}}`) y su CTE `ordenes`
-- NO filtra por funnel: la venta LATAM del 14/09 ya se cruzó con el anuncio
-- correcto de la cuenta de AR sin que nadie tocara nada. El ROAS por campaña
-- siempre estuvo bien; lo que estaba mal era a qué funnel se le cobraba el
-- gasto.
--
-- ── POR QUÉ EL MAPEO ES POR CAMPAÑA Y NO POR CONJUNTO O POR ANUNCIO ───────
-- La campaña es la unidad en la que ya se separan los destinos en Meta ("LATAM
-- 14/09 TEST BIDCAP" no manda tráfico al funnel de AR). Un conjunto no cambia de
-- funnel sin cambiar de campaña, y mapear 270 campañas a nivel anuncio es
-- mantenimiento sin caso de uso. Si algún día hace falta, esta tabla admite una
-- columna `adset_id` sin migrar datos.
--
-- ── POR QUÉ NO POR NOMBRE (prefijo 'LATAM ') ──────────────────────────────
-- Porque el nombre se renombra. Es la misma decisión que ya tomó la 014 para
-- cruzar el gasto con las ventas: se une por ID justamente para que un rename en
-- Meta no parta la serie en dos. Un prefijo sirve para SUGERIR el mapeo en la UI
-- (y el endpoint lo usa para eso), nunca como fuente de la imputación: renombrar
-- "LATAM 14/09 TEST BIDCAP" a "TEST BIDCAP" reimputaría un mes de gasto para
-- atrás, en silencio.
--
-- ── POR QUÉ NO DERIVARLO DE LAS VENTAS ────────────────────────────────────
-- Se podría mirar de qué funnel son las ventas atribuidas a cada campaña y
-- deducir el funnel. Es circular y falla justo el día que importa: una campaña
-- que gastó y NO vendió no tendría funnel, y ese es exactamente el gasto que hay
-- que ver. Sirve como DETECTOR (una campaña mapeada al funnel X cuyas ventas son
-- del funnel Y es un error de configuración), no como fuente.
--
-- ── POR QUÉ UNA TABLA APARTE Y NO UNA COLUMNA EN `ad_campaigns` ───────────
-- `ad_campaigns` es un espejo de Meta: lo escribe el sync de la jerarquía y sus
-- filas se marcan `desaparecido_at` cuando Meta deja de devolverlas. Este mapeo
-- es dato del negocio, tipeado por una persona, y no puede vivir a merced de un
-- espejo. Es la misma razón por la que `ad_spend` no tiene FK hacia la jerarquía
-- (comentario de la 016): borrar una campaña no puede borrar su plata.
--
-- Consecuencia buscada: se puede mapear una campaña que todavía no está en
-- `ad_campaigns` (el sync de la jerarquía corre cada 15 min, el de gasto cada
-- hora), y el mapeo sobrevive a que Meta la archive.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ad_campaign_funnel (
  -- El id de campaña de Meta ('120249504324770617'), sin prefijo. Sin FK a
  -- ad_campaigns a propósito (ver arriba).
  campaign_id text        PRIMARY KEY,

  -- A qué funnel se le imputa el gasto de ESTA campaña. NOT NULL: "sin
  -- asignar" no es una fila con NULL, es la ausencia de fila — así el
  -- COALESCE del sync cae al funnel de la cuenta y una campaña sin mapear se
  -- comporta igual que antes de esta migración. Con NULL habría dos formas de
  -- decir lo mismo y una de ellas (fila con NULL) significaría "gasto sin
  -- asignar" en lugar de "heredá de la cuenta".
  funnel_id   smallint    NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,

  -- Denormalizado para poder listar y re-imputar por cuenta sin depender de que
  -- la campaña esté en el espejo de la jerarquía.
  account_id  text        NOT NULL,

  -- El nombre que tenía la campaña cuando se mapeó. Es un rótulo para la UI y
  -- para entender el mapeo seis meses después; NO se usa para resolver nada.
  campaign_name text,

  -- Quién y cuándo. `nota` es para el caso real: "esta la moví a gelatina el
  -- 20/09 porque la duplicé de la de AR".
  nota        text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- El listado y la re-imputación son siempre por cuenta.
CREATE INDEX IF NOT EXISTS ad_campaign_funnel_account_idx ON ad_campaign_funnel (account_id);
CREATE INDEX IF NOT EXISTS ad_campaign_funnel_funnel_idx  ON ad_campaign_funnel (funnel_id);
