-- ════════════════════════════════════════════════════════════════════════════
-- 029 — Insights de IA: análisis generado sobre los datos del panel
--
-- Guarda el resultado de mandarle un resumen de los números a un modelo de
-- OpenAI. La tabla existe por UNA razón operativa: que la pantalla NUNCA llame a
-- la API.
--
-- /resumen es `force-dynamic` y ResumenView repite el pedido cada minuto, así que
-- generar el análisis en el render serían ~1.440 llamadas por día por cada
-- pestaña abierta. Con el resultado en una fila, abrir la pantalla cuesta un
-- SELECT y cero centavos.
--
-- Se escribe desde dos lugares:
--   · scripts/generar-insights.ts, por cron, una vez al día sobre días CERRADOS.
--   · POST /api/ia/insight, cuando el usuario aprieta el botón para un rango.
-- ════════════════════════════════════════════════════════════════════════════


CREATE TABLE IF NOT EXISTS ai_insights (
  id          bigserial   PRIMARY KEY,

  -- Qué pantalla lo pidió. Dos y no una tabla por pantalla: el ciclo de vida es
  -- idéntico (se genera, se cachea por huella, se lee el más nuevo) y lo único
  -- que cambia es la forma del brief, que va en jsonb.
  ambito      text        NOT NULL,

  -- El rango analizado. Se guarda para poder mostrar "esto habla del 1 al 31 de
  -- agosto": un análisis sin su período es una opinión sin sujeto.
  rango_desde date        NOT NULL,
  rango_hasta date        NOT NULL,

  -- ─── LA HUELLA ES LA CACHE, Y ES LO QUE FRENA EL GASTO ───────────────────
  --
  -- sha256 hex del brief canonicalizado. La idea: el insight es una función de
  -- los datos, así que si los datos no cambiaron, la respuesta no puede cambiar
  -- y no hay nada que volver a preguntar. El UNIQUE de abajo convierte eso en
  -- una garantía de la base en vez de una intención del código.
  --
  -- Es MEJOR QUE UN TTL a propósito: un TTL de 6 h regenera cuatro veces por día
  -- aunque no se haya movido un número (un fin de semana sin ventas, o una
  -- instancia que arrancó vacía). La huella regenera cero.
  --
  -- CONSECUENCIA PARA QUIEN ARME UN BRIEF: no puede contener timestamps ni
  -- `generatedAt`. Si los contiene, la huella cambia en cada llamada y la caché
  -- deja de existir sin que nada falle — sólo aparece la factura.
  huella      text        NOT NULL,

  -- Con qué modelo se generó. Va en la fila y no en una env var leída al mostrar
  -- porque el texto guardado lo escribió ESTE modelo: cambiar OPENAI_MODEL no
  -- puede reescribir retroactivamente quién dijo qué.
  modelo      text        NOT NULL,

  -- Los insights estructurados, tal como los devolvió el modelo y ya validados
  -- contra el brief. Forma: { insights: [{ titulo, cuerpo, tono, evidencia }] }.
  cuerpo      jsonb       NOT NULL,

  -- ─── EL BRIEF SE GUARDA, Y NO ES REDUNDANTE ──────────────────────────────
  -- Es exactamente el payload que se le mandó al modelo. Sin esto, dentro de
  -- tres meses hay una afirmación sobre un mes cerrado y ninguna forma de
  -- chequear si los números que citó eran los que había. Es la misma razón por
  -- la que `finance_account_balances` guarda `note`: un número raro se explica
  -- con lo que había alrededor o no se explica.
  brief       jsonb       NOT NULL,

  -- Para saber qué se gastó de verdad, sin depender del dashboard de OpenAI.
  tokens_in   integer     NOT NULL DEFAULT 0,
  tokens_out  integer     NOT NULL DEFAULT 0,

  -- 'cron' | 'manual'. Sirve para contar el techo diario distinguiendo lo que
  -- gastó el usuario apretando el botón de lo que gasta la corrida automática.
  origen      text        NOT NULL,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ai_insights_ambito_valido CHECK (ambito IN ('resumen', 'finanzas')),
  CONSTRAINT ai_insights_origen_valido CHECK (origen IN ('cron', 'manual')),
  CONSTRAINT ai_insights_rango_coherente CHECK (rango_hasta >= rango_desde),
  -- Una huella vacía haría colapsar todas las filas de un ámbito en una sola
  -- por el UNIQUE de abajo: el primer insight quedaría cacheado para siempre.
  CONSTRAINT ai_insights_huella_no_vacia CHECK (length(btrim(huella)) > 0),
  CONSTRAINT ai_insights_tokens_no_negativos CHECK (tokens_in >= 0 AND tokens_out >= 0)
);

-- ESTE INDICE ES LA CACHE. El código hace INSERT ... ON CONFLICT DO NOTHING y
-- después relee: si otra pestaña pidió lo mismo en el mismo instante, una de las
-- dos gana y la otra se encuentra la fila ya escrita, sin lógica de carrera en
-- JS y sin dos llamadas pagas por el mismo contenido.
--
-- La clave es (ambito, huella) y NO incluye el rango: el rango ya está adentro
-- del brief, así que dos rangos distintos dan huellas distintas. Agregarlo al
-- índice no cambiaría nada y dejaría dudas sobre cuál manda.
CREATE UNIQUE INDEX IF NOT EXISTS ai_insights_ambito_huella_uq
  ON ai_insights (ambito, huella);

-- La lectura de las pantallas: el más nuevo de un ámbito.
CREATE INDEX IF NOT EXISTS ai_insights_ambito_reciente_idx
  ON ai_insights (ambito, created_at DESC);

-- El techo diario se cuenta con esto: count(*) del día por origen.
CREATE INDEX IF NOT EXISTS ai_insights_created_at_idx
  ON ai_insights (created_at DESC);

CREATE OR REPLACE TRIGGER ai_insights_updated_at
  BEFORE UPDATE ON ai_insights
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
