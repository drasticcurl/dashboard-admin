-- ═══════════════════════════════════════════════════════════════════════════
-- 036 — Registrar el gasto de ads por HORA, desde ahora.
--
-- El widget "Resultado por hora" del Resumen (neto de la hora − gasto de la
-- hora) necesita el gasto por hora, y `ad_spend` es por DÍA: la sync de Meta
-- (lib/ads/sync.ts) pisa el total del día en cada corrida. Pedido del usuario
-- (2026-09-29): "a partir de ahora lo empezamos a guardar; los anteriores ya no
-- importan". Sin histórico: los días previos a esta migración reparten su gasto
-- parejo en las 24 horas (lo decide la query, no esta tabla).
--
-- CÓMO: cada vez que algo escribe `ad_spend`, un trigger anota el gasto
-- ACUMULADO del día de cada funnel tocado, con la hora en que lo vio. Una fila
-- por (funnel, día, hora de reloj): dentro de la misma hora se queda la ÚLTIMA
-- lectura. La diferencia entre dos lecturas es lo que se gastó entre ellas, y
-- la query (lib/queries/overview.ts, `gastoPorHora`) la reparte entre las horas
-- que cubre ese intervalo.
--
-- POR QUÉ UN TRIGGER Y NO CÓDIGO EN LA SYNC: `lib/ads/**` es la zona que mueve
-- plata real en Meta y el README pide no tocarla sin revisión. El trigger no
-- cambia nada de lo que la sync escribe ni cómo; sólo mira.
--
-- La precisión depende de cada cuánto se sincroniza: el cron corre a los :07
-- de cada hora, y el refresco en vivo (lib/ads/live.ts) cada minuto mientras
-- alguien mira el panel.
--
-- DOS TRIGGERS Y NO UNO: Postgres no permite tablas de transición en un
-- trigger con más de un evento. El `INSERT ... ON CONFLICT DO UPDATE` de la
-- sync dispara los dos (filas nuevas → INSERT, filas pisadas → UPDATE).
--
-- IDEMPOTENTE: IF NOT EXISTS, CREATE OR REPLACE y DROP TRIGGER IF EXISTS.
-- Sin BEGIN/COMMIT (regla del repo: el runner envuelve cada migración).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ad_spend_hora (
  funnel_id      smallint      NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  day            date          NOT NULL,
  -- La hora de reloj (UTC truncado) en que se tomó la lectura: la clave que
  -- deja una fila por hora.
  hora           timestamptz   NOT NULL,
  -- El gasto del día ACUMULADO hasta `tomado_at`, en la moneda de reporte
  -- (misma unidad que ad_spend.spend_eur).
  spend_eur_acum numeric(14,2) NOT NULL,
  tomado_at      timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (funnel_id, day, hora)
);

COMMENT ON TABLE ad_spend_hora IS
  'Lecturas del gasto acumulado del día por funnel, una por hora de reloj (la última). La escribe el trigger de ad_spend (migración 036); la lee el widget Resultado por hora.';

CREATE OR REPLACE FUNCTION registrar_gasto_hora() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO ad_spend_hora (funnel_id, day, hora, spend_eur_acum, tomado_at)
  SELECT a.funnel_id, a.day, date_trunc('hour', now()), COALESCE(SUM(a.spend_eur), 0), now()
    FROM ad_spend a
   WHERE a.funnel_id IS NOT NULL
     AND (a.funnel_id, a.day) IN (
           SELECT DISTINCT n.funnel_id, n.day
             FROM nuevas n
            WHERE n.funnel_id IS NOT NULL
              -- Sólo días recientes: una resync de la semana pasada no dice
              -- nada de a qué hora se gastó.
              AND n.day >= current_date - 2
         )
   GROUP BY a.funnel_id, a.day
  ON CONFLICT (funnel_id, day, hora) DO UPDATE
     SET spend_eur_acum = EXCLUDED.spend_eur_acum,
         tomado_at      = EXCLUDED.tomado_at;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ad_spend_hora_ins ON ad_spend;
CREATE TRIGGER ad_spend_hora_ins
  AFTER INSERT ON ad_spend
  REFERENCING NEW TABLE AS nuevas
  FOR EACH STATEMENT EXECUTE FUNCTION registrar_gasto_hora();

DROP TRIGGER IF EXISTS ad_spend_hora_upd ON ad_spend;
CREATE TRIGGER ad_spend_hora_upd
  AFTER UPDATE ON ad_spend
  REFERENCING NEW TABLE AS nuevas
  FOR EACH STATEMENT EXECUTE FUNCTION registrar_gasto_hora();
