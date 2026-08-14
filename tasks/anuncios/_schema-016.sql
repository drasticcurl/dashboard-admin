-- ═══════════════════════════════════════════════════════════════════════════
-- 016 — Gestión de anuncios: jerarquía, reglas de automatización y auditoría.
--
-- Este archivo es el DDL canónico del módulo de Anuncios, en un solo archivo.
-- T13 lo copia a `db/migrations/016_ads_gestion.sql` tal cual. No se mejora.
--
-- EJECUTADO Y VERIFICADO contra un PostgreSQL 16 con las migraciones 001-015
-- aplicadas: corre limpio y es idempotente (la segunda corrida no hace nada).
-- La verificación se rehizo después de las correcciones de la revisión técnica
-- del 2026-08-12, así que lo que dice este archivo es lo que la base acepta.
-- Si lo editás, volvé a correrlo en una base descartable ANTES de migrar en
-- serio: la mitad de los CHECK de acá existen para que una regla no pueda
-- gastar plata de forma que nadie configuró.
--
-- ESTA MIGRACIÓN CORRE SOBRE DATOS VIVOS
-- El panel está en producción en la VPS con ventas reales y `ad_spend` cargada.
-- Por eso todo acá es ADITIVO: no hay un solo DROP, ni un ALTER que reescriba
-- una tabla existente, ni un cambio de tipo. La 014 pudo hacer
-- `DROP TABLE ad_spend` porque estaba vacía; hoy no lo está y no se toca.
--
-- PREFLIGHT OBLIGATORIO ANTES DE MIGRAR EN PRODUCCIÓN
-- El único `CREATE INDEX` de este archivo cae sobre `orders`, que es una tabla
-- de escritura activa. El tamaño de `orders` en producción NO está medido: en
-- la base local son un par de filas y eso no dice nada. T13 §3 tiene el
-- preflight (contar filas, medir tamaño, poner `lock_timeout`). No asumas que
-- "son miles y el lock dura milisegundos": medilo.
--
-- POR QUÉ SE PERSISTE LA JERARQUÍA SI `ad_spend` YA TIENE LOS NOMBRES
-- `ad_spend` guarda `campaign_name`/`adset_name`/`ad_name` desnormalizados, pero
-- solo para los objetos QUE GASTARON ESE DÍA. Un conjunto pausado ayer no tiene
-- fila hoy, así que no se puede listar ni reactivar: la pantalla lo perdería de
-- vista justo cuando hace falta. Y `ad_spend` no tiene ni presupuesto ni estado,
-- que son las dos cosas sobre las que este módulo escribe. La jerarquía es el
-- inventario; `ad_spend` es el consumo.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- 1. Jerarquía: campañas → conjuntos → anuncios
-- ───────────────────────────────────────────────────────────────────────────

-- POR QUÉ EL PRESUPUESTO SE GUARDA EN UNIDADES MÍNIMAS (bigint) Y NO EN numeric
-- La Marketing API devuelve y acepta `daily_budget` como entero en la unidad
-- mínima de la moneda de la cuenta: 2500 son €25,00. Guardarlo como
-- numeric(14,2) obliga a dividir al leer y a multiplicar y redondear al
-- escribir, y ese redondeo es exactamente donde una regla de "+20%" termina
-- pidiendo €25,004 y Meta rechaza el POST con un error de validación que en el
-- log parece un problema de permisos. Se guarda el entero que Meta usa y la
-- división por 100 se hace UNA vez, al formatear para la pantalla.
CREATE TABLE IF NOT EXISTS ad_campaigns (
  campaign_id       text        PRIMARY KEY,
  account_id        text        NOT NULL REFERENCES ad_accounts(account_id) ON DELETE CASCADE,
  name              text,
  objective         text,
  -- `status` es lo que el usuario configuró (ACTIVE | PAUSED | ARCHIVED |
  -- DELETED) y es lo único que se puede escribir. `effective_status` es lo que
  -- Meta dice que pasa de verdad y agrega valores que NO se pueden escribir:
  -- CAMPAIGN_PAUSED, ADSET_PAUSED, WITH_ISSUES, DISAPPROVED, PENDING_REVIEW,
  -- IN_PROCESS. Se guardan los dos porque activar un conjunto cuya campaña está
  -- pausada devuelve 200 y no entrega nada: el objeto queda ACTIVE con
  -- effective_status CAMPAIGN_PAUSED. Sin la segunda columna, el panel mostraría
  -- "activo" y el usuario no entendería por qué no gasta.
  status            text,
  effective_status  text,
  -- Dónde vive el presupuesto de esta campaña. 'campaign' = presupuesto de
  -- campaña (CBO / Advantage campaign budget): el POST va a la campaña y
  -- escribir en el conjunto falla. 'adset' = ABO: cada conjunto tiene el suyo y
  -- la campaña no acepta presupuesto. Es el dato que decide a qué id se le pega,
  -- y adivinarlo es la primera causa de acciones que fallan.
  budget_level      text        NOT NULL DEFAULT 'adset',
  daily_budget      bigint,
  lifetime_budget   bigint,
  currency          text,
  bid_strategy      text,
  created_time      timestamptz,
  synced_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ad_campaigns_budget_level_valido CHECK (budget_level IN ('campaign', 'adset'))
);

CREATE INDEX IF NOT EXISTS ad_campaigns_account_idx ON ad_campaigns (account_id);
CREATE INDEX IF NOT EXISTS ad_campaigns_status_idx  ON ad_campaigns (status);

-- ON DELETE CASCADE hacia la campaña: si una campaña se borra en Meta y el sync
-- la saca, sus conjuntos y anuncios no pueden quedar huérfanos apuntando a un id
-- que ya no existe. El gasto histórico NO se toca: vive en `ad_spend`, que no
-- tiene FK hacia acá justamente para que borrar una campaña no borre su plata.
CREATE TABLE IF NOT EXISTS ad_sets (
  adset_id          text        PRIMARY KEY,
  campaign_id       text        NOT NULL REFERENCES ad_campaigns(campaign_id) ON DELETE CASCADE,
  account_id        text        NOT NULL REFERENCES ad_accounts(account_id) ON DELETE CASCADE,
  name              text,
  status            text,
  effective_status  text,
  daily_budget      bigint,
  lifetime_budget   bigint,
  currency          text,
  optimization_goal text,
  billing_event     text,
  bid_strategy      text,
  created_time      timestamptz,
  synced_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ad_sets_campaign_idx ON ad_sets (campaign_id);
CREATE INDEX IF NOT EXISTS ad_sets_account_idx  ON ad_sets (account_id);
CREATE INDEX IF NOT EXISTS ad_sets_status_idx   ON ad_sets (status);

-- Los anuncios NO tienen presupuesto: en Meta el presupuesto existe a nivel
-- campaña (CBO) o conjunto (ABO), nunca a nivel anuncio. Por eso esta tabla no
-- tiene columnas de presupuesto, y una regla de presupuesto con level='ad' se
-- rechaza en la validación en lugar de fallar contra la API.
CREATE TABLE IF NOT EXISTS ads (
  ad_id             text        PRIMARY KEY,
  adset_id          text        NOT NULL REFERENCES ad_sets(adset_id) ON DELETE CASCADE,
  campaign_id       text        NOT NULL,
  account_id        text        NOT NULL REFERENCES ad_accounts(account_id) ON DELETE CASCADE,
  name              text,
  status            text,
  effective_status  text,
  creative_id       text,
  created_time      timestamptz,
  synced_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ads_adset_idx    ON ads (adset_id);
CREATE INDEX IF NOT EXISTS ads_campaign_idx ON ads (campaign_id);
CREATE INDEX IF NOT EXISTS ads_account_idx  ON ads (account_id);
CREATE INDEX IF NOT EXISTS ads_status_idx   ON ads (status);


-- ───────────────────────────────────────────────────────────────────────────
-- 2. Reglas de automatización
-- ───────────────────────────────────────────────────────────────────────────

-- POR QUÉ `enabled` Y `dry_run` NACEN EN false/true
-- Esta tabla le da a un cron la capacidad de gastar plata. Una regla recién
-- creada no puede tocar nada: nace apagada y, cuando se prende, nace simulando.
-- El usuario la mira 24 horas en el historial, ve qué HABRÍA hecho, y recién
-- entonces le saca el modo sombra. Un default al revés convierte un typo en la
-- condición (0.13 en lugar de 1.3) en presupuesto real perdido.
CREATE TABLE IF NOT EXISTS ad_rules (
  id                serial      PRIMARY KEY,
  name              text        NOT NULL,
  enabled           boolean     NOT NULL DEFAULT false,
  dry_run           boolean     NOT NULL DEFAULT true,

  -- ── Alcance: sobre qué objetos mira ──────────────────────────────────────
  -- Array vacío = todas las cuentas activas. Se usa array y no una tabla
  -- puente porque son 2 cuentas, no 200, y un `= ANY($1)` alcanza.
  account_ids       text[]      NOT NULL DEFAULT '{}',
  level             text        NOT NULL,
  status_filter     text        NOT NULL DEFAULT 'active',
  -- Filtro por nombre, case-insensitive, sin regex a propósito: una regla que
  -- se aplica a "PXN" tiene que ser legible por el que la escribió a las 2 AM.
  name_filter       text,
  name_filter_mode  text        NOT NULL DEFAULT 'contains',

  -- ── Acción ───────────────────────────────────────────────────────────────
  action            text        NOT NULL,
  -- ┌───────────────────────────────────────────────────────────────────────┐
  -- │ QUÉ SIGNIFICA `action_value`. LEER ANTES DE ESCRIBIR CUALQUIER CÓDIGO. │
  -- └───────────────────────────────────────────────────────────────────────┘
  -- Con `action_unit = 'percent'` el valor es un FACTOR, no un incremento
  -- (D-A9 del plan):
  --     nuevo = actual × (action_value / 100)
  --     250 → ×2,5   ·   100 → sin cambio   ·   50 → la mitad
  -- Así que 250 sobre €10,00 son €25,00, NO €35,00.
  --
  -- Con `action_unit = 'fixed'` el valor es un importe en EUR y el SIGNO LO
  -- PONE LA ACCIÓN, nunca el valor (que siempre es positivo, lo fuerza el
  -- CHECK ad_rules_presupuesto_completo):
  --     budget_increase → nuevo = actual + action_value
  --     budget_decrease → nuevo = actual − action_value
  --
  -- Está en EUR y no en unidades mínimas porque esta tabla la escribe una
  -- persona en un formulario; la conversión a céntimos se hace UNA vez, en el
  -- borde contra la API (D-A6).
  --
  -- El CHECK ad_rules_percent_direccion de más abajo es el que impide la
  -- confusión que más plata puede costar: un `budget_increase` con 50% no es
  -- "subir poco", es partir el presupuesto al medio.
  action_value      numeric(14,2),
  action_unit       text,
  -- Techo y piso en EUR. El techo es OBLIGATORIO para subir y el piso para
  -- bajar (lo fuerza el CHECK de abajo): sin techo, "+20% cada minuto" son 24
  -- duplicaciones en media hora y €25 se vuelven €4.000 mientras dormís.
  budget_max        numeric(14,2),
  budget_min        numeric(14,2),

  -- ── Ventana de datos con la que decide ───────────────────────────────────
  period            text        NOT NULL DEFAULT 'today',
  -- 'object' = las métricas del objeto mismo, y es lo ÚNICO que acepta esta
  -- versión (ver el CHECK ad_rules_mlevel_valido más abajo).
  --
  -- POR QUÉ 'parent' NO ESTÁ PERMITIDO TODAVÍA
  -- La idea ("no pauses este anuncio si el conjunto entero viene bien") es
  -- buena, pero nadie definió la semántica: cómo se resuelve el id del padre,
  -- qué pasa con dos anuncios del mismo conjunto (¿se deduplica el padre?), a
  -- qué objeto se le aplica la acción, y qué se guarda en `metrics`. Una regla
  -- que el schema acepta y el motor no sabe evaluar decide con el nivel
  -- equivocado o falla en runtime, y las dos cosas se pagan con plata.
  -- La columna queda con su valor por defecto para que abrirla sea un ALTER de
  -- una línea en una 017, cuando la semántica esté escrita y probada.
  metrics_level     text        NOT NULL DEFAULT 'object',

  -- ── Cadencia y frenos ────────────────────────────────────────────────────
  every_minutes     smallint    NOT NULL DEFAULT 15,
  -- Ventana horaria en la ZONA DE LA CUENTA de Meta, igual que todo lo demás
  -- del módulo. NULL en las dos = a cualquier hora. Si start > end, la ventana
  -- cruza la medianoche (22:00→06:00) y el evaluador lo tiene que soportar.
  window_start      time,
  window_end        time,
  max_runs_per_day  smallint,
  -- Los dos frenos que protegen contra el peor modo de falla: dos reglas que se
  -- pelean por el mismo conjunto (una lo sube, otra lo baja) y el reinicio
  -- permanente de la fase de aprendizaje de Meta por editar el presupuesto cada
  -- minuto. Se cuentan contra `ad_actions`, que es el único registro de verdad.
  cooldown_minutes  smallint    NOT NULL DEFAULT 60,
  max_actions_per_object_per_day smallint NOT NULL DEFAULT 4,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_run_at       timestamptz,
  last_run_error    text,

  CONSTRAINT ad_rules_level_valido  CHECK (level IN ('campaign', 'adset', 'ad')),
  CONSTRAINT ad_rules_status_valido CHECK (status_filter IN ('active', 'paused', 'any')),
  CONSTRAINT ad_rules_nfmode_valido CHECK (name_filter_mode IN ('contains', 'not_contains')),
  CONSTRAINT ad_rules_action_valida CHECK (action IN ('pause', 'activate', 'budget_increase', 'budget_decrease')),
  CONSTRAINT ad_rules_unit_valida   CHECK (action_unit IS NULL OR action_unit IN ('percent', 'fixed')),
  CONSTRAINT ad_rules_period_valido CHECK (period IN ('today', 'yesterday', '7d', '7d_excl_today')),
  -- Sólo 'object' en esta versión. Ver el comentario de la columna.
  CONSTRAINT ad_rules_mlevel_valido CHECK (metrics_level IN ('object')),
  CONSTRAINT ad_rules_cadencia_valida CHECK (every_minutes >= 1 AND every_minutes <= 1440),
  CONSTRAINT ad_rules_cooldown_valido CHECK (cooldown_minutes >= 0),
  CONSTRAINT ad_rules_max_objeto_valido CHECK (max_actions_per_object_per_day >= 1),
  -- Una acción de presupuesto necesita monto, unidad y el límite del lado hacia
  -- el que se mueve. Se valida en la base y no solo en zod porque la base es la
  -- última línea: un script o un psql a mano tampoco pueden dejar una regla de
  -- "+20% sin techo" cargada.
  CONSTRAINT ad_rules_presupuesto_completo CHECK (
    action NOT IN ('budget_increase', 'budget_decrease')
    OR (action_value IS NOT NULL AND action_value > 0 AND action_unit IS NOT NULL)
  ),
  CONSTRAINT ad_rules_techo_obligatorio CHECK (action <> 'budget_increase' OR budget_max IS NOT NULL),
  CONSTRAINT ad_rules_piso_obligatorio  CHECK (action <> 'budget_decrease' OR budget_min IS NOT NULL),
  -- EL CHECK QUE IMPIDE QUE UNA REGLA HAGA LO CONTRARIO DE SU NOMBRE
  -- Con `percent` el valor es un factor (ver el comentario de action_value), así
  -- que un factor menor a 100 BAJA el presupuesto y uno mayor lo SUBE. Sin este
  -- CHECK, «subir al 50%» es una regla válida que parte el presupuesto al medio
  -- cada 15 minutos, y el techo obligatorio no la frena porque el resultado
  -- siempre queda por debajo. `action_value > 0` ya lo garantiza el CHECK
  -- ad_rules_presupuesto_completo; acá se agrega la dirección.
  CONSTRAINT ad_rules_percent_direccion CHECK (
    action_unit IS DISTINCT FROM 'percent'
    OR (action = 'budget_increase' AND action_value > 100)
    OR (action = 'budget_decrease' AND action_value < 100)
    OR action NOT IN ('budget_increase', 'budget_decrease')
  ),
  -- Techo y piso coherentes entre sí. Una regla con techo €10 y piso €25 no
  -- tiene ningún valor que satisfaga los dos, y el recorte del motor
  -- (min(max(x, piso), techo)) devolvería el techo siempre, en silencio.
  CONSTRAINT ad_rules_techo_sobre_piso CHECK (
    budget_max IS NULL OR budget_min IS NULL OR budget_max >= budget_min
  ),
  -- Los límites son importes, no deltas: negativos o cero no significan nada.
  CONSTRAINT ad_rules_limites_positivos CHECK (
    (budget_max IS NULL OR budget_max > 0) AND (budget_min IS NULL OR budget_min > 0)
  ),
  -- Un anuncio no tiene presupuesto (ver el comentario de la tabla `ads`).
  CONSTRAINT ad_rules_ad_sin_presupuesto CHECK (
    level <> 'ad' OR action NOT IN ('budget_increase', 'budget_decrease')
  ),
  -- Las dos horas de la ventana van juntas o no van.
  CONSTRAINT ad_rules_ventana_completa CHECK (
    (window_start IS NULL) = (window_end IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS ad_rules_activas_idx ON ad_rules (enabled) WHERE enabled;

-- Nombre único. Dos motivos, y el segundo es el que importa:
--   1. El historial (`ad_actions.rule_name`) se lee por nombre. Dos reglas
--      llamadas igual hacen que "¿qué pausó esto?" no tenga respuesta.
--   2. Es lo que permite que el seed de §6 sea idempotente con
--      ON CONFLICT (name) DO NOTHING, sin inventar una clave natural.
-- La acción "duplicar" del panel tiene que agregar un sufijo al copiar.
CREATE UNIQUE INDEX IF NOT EXISTS ad_rules_name_unico ON ad_rules (name);

-- Condiciones en filas y no en un jsonb: se filtran, se cuentan y se validan con
-- CHECK. Todas las condiciones de una regla se combinan con AND, igual que en el
-- formulario de referencia (los chips "Ventas > 2 · ROI > 1.3 · Gasto < €10").
-- No hay OR a propósito: dos reglas separadas expresan lo mismo y se pueden
-- prender y apagar por separado, que es lo que se quiere a las 3 AM.
CREATE TABLE IF NOT EXISTS ad_rule_conditions (
  id        serial       PRIMARY KEY,
  rule_id   integer      NOT NULL REFERENCES ad_rules(id) ON DELETE CASCADE,
  metric    text         NOT NULL,
  op        text         NOT NULL,
  value     numeric(16,4) NOT NULL,
  position  smallint     NOT NULL DEFAULT 0,

  CONSTRAINT ad_rule_conditions_metric_valida CHECK (metric IN (
    'sales', 'revenue', 'spend', 'net', 'profit', 'roi', 'roas', 'cpa',
    'budget', 'impressions', 'clicks', 'ctr', 'cpc'
  )),
  CONSTRAINT ad_rule_conditions_op_valido CHECK (op IN ('>', '>=', '<', '<=', '=', '!='))
);

CREATE INDEX IF NOT EXISTS ad_rule_conditions_rule_idx ON ad_rule_conditions (rule_id, position);


-- ───────────────────────────────────────────────────────────────────────────
-- 3. Auditoría: corridas y acciones
-- ───────────────────────────────────────────────────────────────────────────

-- POR QUÉ `ON DELETE SET NULL` Y NO CASCADE
-- Con CASCADE, borrar una regla borraba todas sus corridas. Eso deja el
-- historial de `ad_actions` (que sí sobrevive, porque su FK es SET NULL) con
-- filas que apuntan a un `run_id` que ya no existe, y borra la única evidencia
-- de cuántos objetos vio esa regla y cuántos cumplieron. Una tabla de auditoría
-- no se borra desde la pantalla de configuración: las dos FK de este módulo
-- hacia `ad_rules` son SET NULL y `rule_name` queda desnormalizado en las dos.
CREATE TABLE IF NOT EXISTS ad_rule_runs (
  id                  bigserial   PRIMARY KEY,
  rule_id             integer     REFERENCES ad_rules(id) ON DELETE SET NULL,
  rule_name           text,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  -- ESTOS CONTADORES SON EL ÚNICO REGISTRO DE LOS OBJETOS QUE NO CUMPLIERON.
  -- `ad_actions` guarda una fila sólo por objeto que CUMPLIÓ las condiciones
  -- (ejecutado, simulado u omitido por un freno). Los que no cumplieron se
  -- cuentan acá y nada más, por dos razones:
  --   1. Fidelidad: una condición que no se dio no es "una acción simulada".
  --      Escribirla en `ad_actions` con dry_run=true hace que el historial
  --      afirme algo que no pasó.
  --   2. Volumen: con un tick por minuto y unos cientos de objetos, registrar
  --      cada evaluación son cientos de miles de filas por día en la tabla que
  --      además sostiene el cooldown. La auditoría se vuelve inútil por ruido
  --      antes de volverse lenta por tamaño.
  objetos_evaluados   integer     NOT NULL DEFAULT 0,
  objetos_que_cumplen integer     NOT NULL DEFAULT 0,
  acciones_ejecutadas integer     NOT NULL DEFAULT 0,
  acciones_simuladas  integer     NOT NULL DEFAULT 0,
  omitidas            integer     NOT NULL DEFAULT 0,
  dry_run             boolean     NOT NULL,
  error               text
);

CREATE INDEX IF NOT EXISTS ad_rule_runs_rule_idx ON ad_rule_runs (rule_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ad_rule_runs_fecha_idx ON ad_rule_runs (started_at DESC);

-- El registro de todo lo que el módulo hizo o habría hecho.
--
-- POR QUÉ `rule_name` ESTÁ DESNORMALIZADO Y `metrics` ES jsonb
-- El historial se lee semanas después, cuando la regla que causó la acción ya se
-- editó o se borró. Con solo el `rule_id`, "por qué se pausó este conjunto el
-- martes" queda sin respuesta. Se congela el nombre, y en `metrics` los números
-- exactos con los que se decidió: el gasto de hoy cambia todo el tiempo, así que
-- recalcularlo después nunca reproduce la decisión.
--
-- `explicacion` es un renglón en castellano, ya armado, y no un template que se
-- rellena en la UI: es lo que se muestra en el panel Y lo que se manda a
-- Telegram, y las dos cosas tienen que decir exactamente lo mismo.
CREATE TABLE IF NOT EXISTS ad_actions (
  id             bigserial   PRIMARY KEY,
  run_id         bigint      REFERENCES ad_rule_runs(id) ON DELETE SET NULL,
  rule_id        integer     REFERENCES ad_rules(id) ON DELETE SET NULL,
  rule_name      text,
  -- 'rule' = la disparó el motor. 'manual' = la disparó una persona desde el
  -- gestor. 'system' = un cambio de configuración del propio módulo (prender o
  -- apagar el modo simulación global, por ejemplo), que no toca ningún objeto
  -- de Meta pero es el evento más importante que puede pasar acá.
  --
  -- OJO CON QUÉ SIGNIFICA ESTA COLUMNA: es el CANAL, no la persona.
  -- El panel se autentica con una contraseña compartida y una cookie HMAC, sin
  -- usuarios ni roles, así que 'manual' quiere decir "alguien con la contraseña"
  -- y nada más. No hay forma de atribuir una acción a una persona ni de revocar
  -- a una sola. Lo que sí se puede guardar es el rastro técnico de la petición,
  -- y para eso está `actor_hint`.
  source         text        NOT NULL,
  -- Rastro técnico de quién disparó una acción manual o de configuración: IP,
  -- request id, user-agent recortado, lo que haya. Es lo máximo que el modelo de
  -- autenticación actual permite. NO es una identidad y no reemplaza una.
  -- Para el motor va en NULL: ahí el "quién" es la regla.
  actor_hint     text,
  -- `'*'` para los eventos de configuración, que son globales y no pertenecen a
  -- ninguna cuenta. Sin este centinela el evento de "se apagó el modo
  -- simulación" no se puede insertar, porque la columna es NOT NULL.
  account_id     text        NOT NULL DEFAULT '*',
  level          text        NOT NULL,
  object_id      text        NOT NULL,
  object_name    text,
  action         text        NOT NULL,
  before_value   text,
  after_value    text,
  dry_run        boolean     NOT NULL DEFAULT false,
  ok             boolean     NOT NULL,
  -- EL ESTADO DE LA MUTACIÓN REMOTA, QUE NO ES LO MISMO QUE `ok`.
  -- Un POST a Meta no es parte de la transacción de Postgres: si el proceso
  -- muere o el timeout salta después de que Meta aceptó el cambio y antes del
  -- UPDATE local, la acción pasó y nadie la registró. Por eso la fila se
  -- escribe como 'pendiente' ANTES del POST y se cierra después:
  --   pendiente     → se va a intentar (o se murió el proceso a mitad)
  --   confirmado    → Meta respondió éxito
  --   fallido       → Meta respondió error, y está en `error`
  --   indeterminado → timeout o error de red: NO SE SABE si se aplicó.
  --                   Hay que leer el objeto en Meta antes de reintentar.
  --   simulado      → modo sombra: nunca se llamó a Meta
  --   omitido       → cumplió la condición pero un freno lo detuvo
  estado         text        NOT NULL DEFAULT 'confirmado',
  skipped_reason text,
  explicacion    text        NOT NULL,
  metrics        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ad_actions_source_valido CHECK (source IN ('rule', 'manual', 'system')),
  -- 'system' es el nivel de los eventos de configuración: no son una campaña,
  -- ni un conjunto, ni un anuncio.
  CONSTRAINT ad_actions_level_valido  CHECK (level IN ('campaign', 'adset', 'ad', 'system')),
  -- Vocabulario cerrado. Sin este CHECK, T16 escribe 'budget_increase' y T17
  -- escribe 'budget' para la misma cosa, y el filtro del historial no encuentra
  -- ni la mitad de las filas. `budget_set` es la acción manual (se fija un
  -- importe); `budget_increase`/`budget_decrease` son las del motor (se calcula
  -- uno a partir del actual); `config` es el cambio de interruptores.
  CONSTRAINT ad_actions_action_valida CHECK (action IN (
    'pause', 'activate', 'budget_increase', 'budget_decrease', 'budget_set', 'config'
  )),
  CONSTRAINT ad_actions_estado_valido CHECK (estado IN (
    'pendiente', 'confirmado', 'fallido', 'indeterminado', 'simulado', 'omitido'
  )),
  -- Un evento de configuración es global y no toca Meta.
  CONSTRAINT ad_actions_config_coherente CHECK (
    action <> 'config' OR (level = 'system' AND account_id = '*' AND source <> 'rule')
  )
);

-- Este índice es el que sostiene el cooldown y el máximo por objeto: en cada
-- tick, por cada objeto candidato, se pregunta "¿cuántas acciones REALES tuvo
-- hoy y cuándo fue la última?". Sin él, con el historial de un mes cargado, esa
-- consulta se hace lenta justo en el camino que corre cada minuto.
--
-- `estado IN ('confirmado','indeterminado')` y no `ok`: una acción cuyo
-- resultado no se conoce (timeout después del POST) TIENE que consumir cupo del
-- cooldown. Si no lo consumiera, el tick siguiente reintentaría sobre un objeto
-- que quizás ya se movió, y una subida de presupuesto se aplicaría dos veces.
-- Ante la duda, el freno se aplica.
CREATE INDEX IF NOT EXISTS ad_actions_objeto_idx
  ON ad_actions (object_id, created_at DESC)
  WHERE NOT dry_run AND estado IN ('confirmado', 'indeterminado');
CREATE INDEX IF NOT EXISTS ad_actions_fecha_idx ON ad_actions (created_at DESC);
CREATE INDEX IF NOT EXISTS ad_actions_rule_idx  ON ad_actions (rule_id, created_at DESC);
-- La columna "ÚLT. ACTUALIZACIÓN" del gestor: la última acción real por objeto.
CREATE INDEX IF NOT EXISTS ad_actions_ultima_idx
  ON ad_actions (object_id, created_at DESC) WHERE NOT dry_run;
-- Las filas que quedaron a mitad de camino. Es la consulta que corre el
-- reconciliador al arrancar un tick: una fila 'pendiente' de hace más de un
-- minuto significa que el proceso murió entre el INSERT y el POST (o entre el
-- POST y el UPDATE), y hay que leer el objeto en Meta para saber qué pasó.
-- Es un índice parcial sobre un conjunto que normalmente está vacío: no pesa.
CREATE INDEX IF NOT EXISTS ad_actions_sin_cerrar_idx
  ON ad_actions (created_at) WHERE estado IN ('pendiente', 'indeterminado');


-- ───────────────────────────────────────────────────────────────────────────
-- 4. Índices sobre `orders` para el cruce UTM ↔ anuncio
-- ───────────────────────────────────────────────────────────────────────────

-- Las métricas por objeto atribuyen cada venta a su anuncio por el id que viene
-- en los UTMs (`nombre|id`), y agrupan por el día en la zona de la CUENTA de
-- Meta, así que filtran por `purchased_at` y no por `orders.day` (que está
-- congelado en la zona del funnel). Sin índice, cada tick del motor hace un seq
-- scan de `orders` completo.
--
-- SE CREA UN SOLO ÍNDICE, Y NO CUATRO. POR QUÉ.
-- La versión anterior de este archivo agregaba además tres B-tree sobre
-- `utm_campaign`, `utm_medium` y `utm_content` completos. No sirven para la
-- consulta que este módulo hace: T15 no busca `utm_campaign = 'algo'`, extrae el
-- id con `substring(... from '[0-9]+\s*$')` después de matchear con `~`. Un
-- B-tree sobre el valor completo no puede responder ninguna de las dos cosas, así
-- que serían tres índices que nunca se usan, sobre una tabla de escritura activa,
-- pagando su mantenimiento en cada INSERT de una orden.
--
-- El que sí sirve es el de `purchased_at`, porque el pre-filtro de ±2 días de
-- T15 §3 es un rango sobre esa columna y es lo que acota el scan.
--
-- Si con volumen real el `EXPLAIN (ANALYZE, BUFFERS)` de T15 muestra que el
-- filtro por UTM es el cuello de botella, el índice correcto es de EXPRESIÓN
-- sobre el id ya extraído, con la MISMA expresión que usa la query, y va en una
-- 017 medida, no acá a ciegas:
--   CREATE INDEX ... ON orders ((CASE WHEN utm_campaign ~ '\|\s*[0-9]{6,}\s*$'
--     THEN btrim(substring(utm_campaign from '[0-9]+\s*$')) END))
--     WHERE utm_campaign <> '(directo)';
-- T15 §8 tiene el paso de medición que decide si hace falta.
--
-- `CREATE INDEX` normal y no `CONCURRENTLY`: el runner de migraciones envuelve
-- cada archivo en una transacción y CONCURRENTLY no puede correr adentro de una.
-- ESTO TOMA UN LOCK DE ESCRITURA SOBRE `orders`, y cuánto dura depende del
-- tamaño real de la tabla en producción, que NO está medido. El preflight de
-- T13 §3 lo mide y decide. Si es grande, el índice se crea a mano con
-- CONCURRENTLY antes de migrar y la migración lo encuentra hecho por el
-- IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS orders_purchased_at_idx ON orders (purchased_at DESC);


-- ───────────────────────────────────────────────────────────────────────────
-- 5. Settings del módulo — todos en el lado seguro
-- ───────────────────────────────────────────────────────────────────────────

-- Interruptor general y modo sombra global, además del switch por regla. Son dos
-- porque resuelven dos momentos distintos: `ads_rules_enabled=false` es el freno
-- de mano (nada corre), `ads_rules_force_dry_run=true` deja que todo corra y se
-- registre pero que NADA se escriba en Meta. El segundo es el que permite mirar
-- un día entero de decisiones simuladas con las reglas ya prendidas.
--
-- Los dos arrancan en el lado seguro. Después de desplegar, el módulo no toca un
-- solo euro hasta que alguien entra al panel y los cambia a mano.
-- `settings.value` es jsonb (007), no text: los valores van como JSON. Un `''`
-- pelado no es JSON válido y la migración falla con "invalid input syntax for
-- type json"; el string vacío se escribe `'""'`. Los booleanos van sin comillas
-- para que `value = 'true'::jsonb` funcione y no haya que comparar contra
-- `'"true"'`. Se sigue el formato de las filas que ya seedeó la 010
-- (`"EUR"`, `"oficial"`, `180`).
INSERT INTO settings (key, value) VALUES
  ('ads_rules_enabled',        'false'::jsonb),
  ('ads_rules_force_dry_run',  'true'::jsonb),
  ('ads_insights_ttl_seconds', '55'::jsonb),
  -- ┌───────────────────────────────────────────────────────────────────────┐
  -- │ EL TECHO ABSOLUTO. Es el último freno y no lo pone ninguna regla.      │
  -- └───────────────────────────────────────────────────────────────────────┘
  -- El techo por regla (`ad_rules.budget_max`) protege contra que ESA regla se
  -- desboque, pero no contra un error de unidades, de moneda o de payload. Un
  -- POST armado a mano contra `/api/ads/acciones` con `budgetEur: 250000`, o una
  -- regla nueva con el techo mal tipeado, hoy llegarían a Meta tal cual.
  --
  -- Este valor es un máximo por objeto y por día, en EUR, que el servidor
  -- rechaza SIEMPRE: para las reglas, para las acciones manuales y para el
  -- endpoint en lote. Es deliberadamente bajo respecto de lo que el negocio
  -- podría querer: subirlo tiene que ser un acto consciente.
  --
  -- NO se cambia desde `/api/ads/interruptores` ni desde el formulario de
  -- reglas: si el mismo endpoint que mueve presupuesto puede levantar su propio
  -- techo, no es un techo. Se cambia con un UPDATE a mano o con un script
  -- dedicado, y queda registrado en `ad_actions` como evento de configuración.
  ('ads_max_daily_budget_eur', '200'::jsonb),
  -- Tope agregado por corrida y por tick: cuánta plata como máximo puede sumar
  -- el módulo entre TODOS los objetos de un mismo tick. Protege contra el caso
  -- que el tope por objeto no ve: 80 conjuntos que suben €50 cada uno son
  -- €4.000 de presupuesto diario nuevo en un minuto, y cada uno individualmente
  -- estaba dentro del límite.
  ('ads_max_delta_por_tick_eur', '300'::jsonb),
  ('ads_telegram_enabled',     'false'::jsonb),
  -- El bot token es un secreto y esta fila la puede leer el endpoint de
  -- settings: T18 lo enmascara al devolverlo (solo los últimos 4 caracteres) y
  -- nunca lo escribe en un log. Se guarda acá y no en el env porque el usuario
  -- lo carga con un script interactivo, y editar `.env.production` desde un
  -- script obliga a reiniciar PM2 para que tome el cambio.
  ('ads_telegram_bot_token',   '""'::jsonb),
  ('ads_telegram_chat_id',     '""'::jsonb),
  -- Estado del backoff adaptativo. Lo escribe el worker cuando Meta avisa que
  -- se está acercando al límite. Vive en la base y no en memoria para que un
  -- restart de PM2 no borre el castigo y vuelva a golpear la API en frío.
  --
  -- LAS CUATRO FILAS, NO DOS. La política de T18 §4 es "se duplica en cada
  -- reincidencia hasta 60 minutos y se vuelve al intervalo normal después de dos
  -- ticks limpios". Eso no se puede implementar con un `until` y un `reason`: al
  -- reiniciar PM2 se pierde en qué escalón del castigo estaba y cuántos ticks
  -- limpios lleva, que es justo el estado que el backoff necesita recordar.
  --   ads_backoff_until       hasta cuándo está frenado (timestamp o "")
  --   ads_backoff_reason      el motivo, en castellano, para mostrar en el panel
  --   ads_backoff_failures    reincidencias consecutivas → duración del castigo
  --   ads_backoff_clean_ticks ticks seguidos por debajo del 50% de cuota
  --
  -- El backoff es por APP, no por cuenta: `ads_backoff_until` frena el tick
  -- entero. Con dos cuentas alcanza y sobra. Si alguna vez una cuenta se satura
  -- y la otra no, esto hay que abrirlo por cuenta (P-A08) — el header de uso de
  -- Meta viene por cuenta, así que el dato para hacerlo ya está.
  ('ads_backoff_until',        '""'::jsonb),
  ('ads_backoff_reason',       '""'::jsonb),
  ('ads_backoff_failures',     '0'::jsonb),
  ('ads_backoff_clean_ticks',  '0'::jsonb),
  -- ┌───────────────────────────────────────────────────────────────────────┐
  -- │ Lease del worker: la exclusión mutua entre dos instancias del motor.    │
  -- └───────────────────────────────────────────────────────────────────────┘
  --
  -- POR QUÉ UNA FILA Y NO pg_try_advisory_lock
  -- El lock de sesión de PostgreSQL vive atado a la conexión, y `lib/db.ts`
  -- expone un pool que devuelve la conexión después de cada query: no hay dónde
  -- sostenerlo (no exporta ni `getClient` ni `withClient`, sólo `q`, `q1` y
  -- `tx`). La variante transaccional obligaría a tener un BEGIN abierto durante
  -- las llamadas a Meta, que pueden tardar 30 segundos, y una transacción larga
  -- bloquea el autovacuum. Una fila con un UPDATE condicional es atómica igual,
  -- no retiene conexión, y además se puede mirar desde el panel para saber si el
  -- worker está vivo.
  --
  -- POR QUÉ ES UN OBJETO CON DUEÑO Y NO UN TIMESTAMP PELADO
  -- La versión anterior guardaba sólo el timestamp de la toma y renovaba con
  -- `WHERE value = '' OR value::timestamptz < now() - interval '3 minutes'`. Eso
  -- tiene un bug que no se ve leyéndolo: con un vencimiento de 3 minutos y una
  -- cadencia de 1 minuto, el PROPIO worker no puede renovar su lease en el tick
  -- siguiente, porque su lease todavía no venció y el WHERE exige que esté
  -- vencido o vacío. El resultado no es un deadlock ruidoso: el worker
  -- simplemente descarta dos de cada tres ticks y la cadencia real pasa a ser de
  -- 3 minutos, en silencio y para siempre.
  --
  -- Con `owner` el dueño actual siempre puede renovar, otro proceso sólo puede
  -- tomarlo si venció, y la liberación es un compare-and-set por dueño: un
  -- proceso no puede liberar el lease de otro. El valor es:
  --   {"owner": "<pid>-<random>", "expires_at": "2026-08-12T14:32:10.123Z"}
  -- y `{}` significa libre. T18 §3 tiene el SQL de tomar, renovar y liberar.
  --
  -- El caso real que esto evita: `pm2 reload` durante un deploy deja dos
  -- procesos solapados unos segundos, y dos motores evaluando a la vez duplican
  -- cada acción (dos subidas de presupuesto en el mismo tick).
  ('ads_worker_lease',         '{}'::jsonb),
  ('ads_worker_last_tick',     '""'::jsonb)
ON CONFLICT (key) DO NOTHING;


-- ───────────────────────────────────────────────────────────────────────────
-- 6. Seed: las seis reglas que el usuario ya tenía en Utmify
-- ───────────────────────────────────────────────────────────────────────────
--
-- Traducidas 1:1 del export real (`_reglas-utmify.csv`). Nacen TODAS apagadas y
-- en modo sombra, como cualquier regla (D-A12): el seed carga la configuración,
-- no la enciende.
--
-- LOS NOMBRES SE CONSERVAN TAL CUAL, con sus imprecisiones
-- "Duplicar" es en realidad escalar al 250%, los "$" son euros, y en
-- «Apagar - Gasto +$10» la condición real es €7,00 y no €10,00 (el nombre y la
-- condición se separaron en algún momento). No se corrigen: son los nombres con
-- los que el usuario reconoce sus reglas, y van a aparecer en el historial de
-- `ad_actions` durante meses. Cambiarlos rompería ese reconocimiento para
-- arreglar algo que no molesta.
--
-- LAS UNIDADES CAMBIAN Y ESO NO ES OPCIONAL
-- Utmify guarda los montos de las condiciones en CÉNTIMOS (`spend` 1000 = €10,00,
-- `budget` 1100 = €11,00). Acá `ad_rule_conditions.value` está en EUR, igual que
-- `budget_max` y `budget_min`, porque estas filas las escribe una persona en un
-- formulario. La conversión a unidades mínimas se hace UNA vez, contra la API
-- (D-A6). Si se copiaran los céntimos tal cual, la regla «apagar si el gasto
-- pasa de €4» se convertiría en «si pasa de €400» y nunca se dispararía.
--
-- EL PORCENTAJE ES UN FACTOR (D-A9)
-- Utmify guarda `actionPercentInfo: 2.5` y muestra "250%". Significa
-- `nuevo = actual × 2,5`, NO `actual × 3,5`. Se guarda 250 y la fórmula divide
-- por 100. Prueba de que es así: cada techo es el borde superior de su propia
-- condición de presupuesto por 2,5 — €30,00 × 2,5 = €75,00 exacto.
--
-- UNA CONDICIÓN SE CORRIGE, Y ACÁ ESTÁ EL POR QUÉ
-- La última regla exporta `approvedSales LessThan 0`. Con ventas enteras y no
-- negativas, "menos que cero" NO SE PUEDE CUMPLIR NUNCA: esa regla, traducida
-- literal, jamás se dispararía. La intención es la del nombre —"sin ventas"— así
-- que se seedea como `sales = 0`. Es el único cambio de semántica respecto del
-- export y está anotado en P-A05 para que el usuario lo confirme.
--
-- LOS FRENOS QUE UTMIFY NO TENÍA
-- El export trae `executionLimit` vacío: sin límite de ejecuciones. Acá el
-- cooldown y el máximo por objeto son obligatorios, así que se eligieron valores
-- que NO alteran el comportamiento de la escalera: cooldown de 15 minutos (igual
-- que la frecuencia) y 6 acciones por objeto por día. La escalera es
-- auto-limitante por diseño del usuario —cada regla tiene una condición de
-- `budget` que deja de cumplirse en cuanto la regla actúa, y los rangos de las
-- tres no se solapan— así que los frenos son una red y no un cambio de reglas.

INSERT INTO ad_rules (
  name, enabled, dry_run, level, status_filter, action,
  action_value, action_unit, budget_max, period,
  every_minutes, window_start, window_end, max_runs_per_day,
  cooldown_minutes, max_actions_per_object_per_day
) VALUES
  -- «LastSevenDays» de Utmify es "últimos 7 días excluyendo hoy" (así lo muestra
  -- su propia UI). Una campaña pausada no gastó hoy: mirar hoy la dejaría
  -- pausada para siempre.
  -- «OncePerDay» a la hora 0 se expresa con la ventana 00:00-00:59 + cadencia
  -- diaria + un tope de una corrida: las tres juntas hacen que no pueda repetirse
  -- ni correr a otra hora aunque el worker se reinicie a las 3 de la tarde.
  ('Activar todas a las 0 horas a ver como rinden',
   false, true, 'campaign', 'paused', 'activate',
   NULL, NULL, NULL, '7d_excl_today',
   1440, '00:00', '00:59', 1, 60, 4),

  ('Duplicar a $25 - Gasto -$10 +2 ventas ROI +1.3',
   false, true, 'adset', 'active', 'budget_increase',
   250, 'percent', 25.00, 'today',
   15, NULL, NULL, NULL, 15, 6),

  ('Duplicar a $75 - Gasto +$15 ROI +1.3',
   false, true, 'adset', 'active', 'budget_increase',
   250, 'percent', 75.00, 'today',
   15, NULL, NULL, NULL, 15, 6),

  ('Duplicar a $150 - Gasto +$50 ROI +1.3',
   false, true, 'adset', 'active', 'budget_increase',
   250, 'percent', 150.00, 'today',
   15, NULL, NULL, NULL, 15, 6),

  ('Apagar - Gasto +$10 ROI -1.10',
   false, true, 'adset', 'active', 'pause',
   NULL, NULL, NULL, 'today',
   15, NULL, NULL, NULL, 60, 4),

  ('Apagar - Gasto +$4 sin ventas',
   false, true, 'adset', 'active', 'pause',
   NULL, NULL, NULL, 'today',
   15, NULL, NULL, NULL, 60, 4)
ON CONFLICT (name) DO NOTHING;

-- Las condiciones. El `NOT EXISTS` sobre el rule_id es lo que hace idempotente
-- este bloque: si la regla ya tenía condiciones (porque el seed corrió antes, o
-- porque el usuario la editó), no se le agregan duplicadas. Sin eso, una segunda
-- corrida dejaría la regla con las condiciones dos veces y el AND se volvería
-- redundante en el mejor caso e incoherente en el peor.
INSERT INTO ad_rule_conditions (rule_id, metric, op, value, position)
SELECT r.id, c.metric, c.op, c.value, c.position
  FROM ad_rules r
  JOIN (VALUES
    -- Activar campañas pausadas que vinieron rindiendo la semana pasada
    ('Activar todas a las 0 horas a ver como rinden',   'roi',    '>', 1.3,   0),

    -- Escalera de presupuesto. Los montos ya convertidos de céntimos a EUR.
    ('Duplicar a $25 - Gasto -$10 +2 ventas ROI +1.3',  'sales',  '>', 2,     0),
    ('Duplicar a $25 - Gasto -$10 +2 ventas ROI +1.3',  'roi',    '>', 1.3,   1),
    ('Duplicar a $25 - Gasto -$10 +2 ventas ROI +1.3',  'spend',  '<', 10.00, 2),
    ('Duplicar a $25 - Gasto -$10 +2 ventas ROI +1.3',  'budget', '<', 11.00, 3),

    ('Duplicar a $75 - Gasto +$15 ROI +1.3',            'roi',    '>', 1.3,   0),
    ('Duplicar a $75 - Gasto +$15 ROI +1.3',            'spend',  '>', 15.00, 1),
    ('Duplicar a $75 - Gasto +$15 ROI +1.3',            'budget', '>', 20.00, 2),
    ('Duplicar a $75 - Gasto +$15 ROI +1.3',            'budget', '<', 30.00, 3),

    ('Duplicar a $150 - Gasto +$50 ROI +1.3',           'roi',    '>', 1.3,   0),
    ('Duplicar a $150 - Gasto +$50 ROI +1.3',           'spend',  '>', 50.00, 1),

    -- Cortar lo que no rinde. El nombre dice "+$10" pero el export dice 700
    -- céntimos: se respeta el export, que es la regla que estuvo corriendo.
    ('Apagar - Gasto +$10 ROI -1.10',                   'roi',    '<', 1.1,   0),
    ('Apagar - Gasto +$10 ROI -1.10',                   'spend',  '>', 7.00,  1),

    -- `sales = 0` y no `< 0`: ver la nota de P-A05 arriba.
    ('Apagar - Gasto +$4 sin ventas',                   'spend',  '>', 4.00,  0),
    ('Apagar - Gasto +$4 sin ventas',                   'sales',  '=', 0,     1)
  ) AS c(rule_name, metric, op, value, position) ON c.rule_name = r.name
 WHERE NOT EXISTS (SELECT 1 FROM ad_rule_conditions x WHERE x.rule_id = r.id);
