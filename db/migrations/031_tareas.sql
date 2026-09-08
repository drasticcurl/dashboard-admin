-- ════════════════════════════════════════════════════════════════════════════
-- 031 — Tareas: el tablero kanban del panel
--
-- Cuatro columnas fijas (por hacer · en progreso · en revisión · hecho), una
-- persona asignada, una prioridad que se lee por color, notas, links a recursos y
-- comentarios.
--
-- POR QUÉ LAS COLUMNAS SON FIJAS Y NO UNA TABLA
-- Un tablero configurable necesita una tabla de columnas, su orden, su pantalla de
-- administración y un backfill cuando alguien borra una columna con tarjetas
-- adentro. Son cuatro estados de un flujo de trabajo que no va a cambiar, y el
-- CHECK deja agregar un quinto con dos líneas el día que haga falta. La
-- alternativa se descartó por eso, no por apuro.
--
-- POR QUÉ `posicion` ES integer Y SE REESCRIBE ENTERA
-- Al soltar una tarjeta el cliente manda la lista ordenada de ids de la columna
-- afectada y el server reescribe `posicion` como 10, 20, 30… dentro de una
-- transacción. Se descartó el índice fraccionario (insertar en el punto medio entre
-- dos vecinos): existe para listas de miles de items con varios editores
-- simultáneos, y acá son dos o tres personas y decenas de tarjetas. El
-- fraccionario trae una historia de precisión —cuántas inserciones consecutivas en
-- el mismo hueco aguanta el tipo— que no hace falta tener.
--
-- POR QUÉ HAY DOS TABLAS HIJAS EN VEZ DE DOS COLUMNAS jsonb
-- `links` y `comentarios` se editan de a uno desde la UI. Con un array jsonb, cada
-- alta o baja es un read-modify-write de la fila entera: dos personas mirando la
-- misma tarjeta al mismo tiempo (que es LO QUE UN TABLERO COMPARTIDO PROVOCA) se
-- pisan y el segundo borra el link del primero sin que nada falle. Con filas, cada
-- link y cada comentario es un INSERT o un DELETE que no toca a los demás.
-- El jsonb del repo (`ai_insights.cuerpo`, `orders.raw`) es para payloads opacos
-- que se escriben una vez y no se editan.
--
-- ADITIVA. Tres tablas nuevas, ningún ALTER, ningún DROP.
-- Depende de la 030: los tres FK apuntan a `usuarios`.
-- ════════════════════════════════════════════════════════════════════════════


CREATE TABLE IF NOT EXISTS tareas (
  id            bigserial   PRIMARY KEY,

  -- Los dos únicos campos obligatorios de una tarjeta.
  titulo        text        NOT NULL,
  -- ON DELETE RESTRICT y no SET NULL: la columna es NOT NULL porque una tarjeta
  -- sin dueño no es una tarea, es un recordatorio de nadie. Consecuencia
  -- declarada: no se puede borrar un usuario que tenga tarjetas. El camino es
  -- `usuarios.activo = false`, igual que cerrar una cuenta en vez de borrarla
  -- (028 D10).
  asignado_a    integer     NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,

  -- Todo el resto es opcional.
  notas         text,
  vence_el      date,

  -- Quién la creó. Se guarda para poder contestar "¿esto me lo puso alguien o me
  -- lo puse yo?", que es la pregunta que aparece en un tablero compartido.
  -- Nullable porque las tarjetas que cree un script o una sesión del fallback de
  -- `DASHBOARD_PASSWORD` no tienen un usuario detrás.
  creado_por    integer     REFERENCES usuarios(id) ON DELETE RESTRICT,

  columna       text        NOT NULL DEFAULT 'por_hacer',
  prioridad     text        NOT NULL DEFAULT 'media',

  -- Múltiplos de 10 dentro de cada columna, como el `sort_order` de
  -- `finance_accounts` (028): deja meter algo en el medio sin renumerar todo si
  -- alguna vez hace falta hacerlo a mano desde psql.
  posicion      integer     NOT NULL DEFAULT 0,

  -- ─── EL RELOJ DEL ARCHIVADO ──────────────────────────────────────────────
  -- Cuándo entró a 'hecho'. El cron archiva lo que lleva más de 2 días ahí.
  --
  -- Es una columna propia y NO `updated_at`: agregarle un comentario a una tarea
  -- terminada le mueve el `updated_at` (lo hace el trigger) y le reiniciaría el
  -- reloj, así que una tarjeta con conversación activa no se archivaría nunca. Son
  -- dos preguntas distintas: "cuándo se tocó" y "desde cuándo está lista".
  hecha_at      timestamptz,

  -- Archivada = fuera del tablero, visible en "ver archivadas". No se borra: una
  -- tarea que desaparece sola es una tarea que alguien creyó que estaba.
  archivada_at  timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tareas_titulo_no_vacio CHECK (length(btrim(titulo)) > 0),
  CONSTRAINT tareas_columna_valida
    CHECK (columna IN ('por_hacer', 'en_progreso', 'en_revision', 'hecho')),
  -- alta → rojo (bad), media → naranja (warn), baja → gris (neutral).
  CONSTRAINT tareas_prioridad_valida CHECK (prioridad IN ('alta', 'media', 'baja')),

  -- La bicondicional es lo que hace que el reloj del archivado no se pueda
  -- corromper: `hecha_at` está poblada EXACTAMENTE cuando la tarjeta está en
  -- 'hecho'. Sin esto, sacar una tarjeta de 'hecho' de vuelta a 'en progreso' sin
  -- limpiar `hecha_at` la deja archivándose a los dos días mientras alguien la
  -- está trabajando.
  CONSTRAINT tareas_hecha_at_coherente
    CHECK ((columna = 'hecho') = (hecha_at IS NOT NULL)),
  -- Sólo se archiva lo que está hecho.
  CONSTRAINT tareas_archivada_solo_si_hecha
    CHECK (archivada_at IS NULL OR columna = 'hecho'),
  CONSTRAINT tareas_posicion_no_negativa CHECK (posicion >= 0)
);

-- La lectura del tablero: las no archivadas, por columna y en orden.
CREATE INDEX IF NOT EXISTS tareas_tablero_idx
  ON tareas (columna, posicion) WHERE archivada_at IS NULL;

-- El switch de "tareas de X persona".
CREATE INDEX IF NOT EXISTS tareas_asignado_idx
  ON tareas (asignado_a) WHERE archivada_at IS NULL;

-- Lo que barre el cron: hechas hace rato y todavía sin archivar. Índice parcial
-- para que la corrida diaria no escanee el histórico entero.
CREATE INDEX IF NOT EXISTS tareas_por_archivar_idx
  ON tareas (hecha_at) WHERE archivada_at IS NULL AND hecha_at IS NOT NULL;

CREATE OR REPLACE TRIGGER tareas_updated_at
  BEFORE UPDATE ON tareas
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ─── Links de una tarea ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tarea_links (
  id         bigserial   PRIMARY KEY,
  -- CASCADE y no RESTRICT: un link no tiene vida propia, es parte de la tarjeta.
  tarea_id   bigint      NOT NULL REFERENCES tareas(id) ON DELETE CASCADE,
  url        text        NOT NULL,
  -- Cómo se muestra. Sin etiqueta la UI muestra el host de la URL.
  etiqueta   text,
  posicion   integer     NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Sólo http(s). Un `javascript:` guardado acá sale renderizado en un <a href>
  -- del panel y se ejecuta con la sesión de quien lo abra: el CHECK es la defensa
  -- que queda si alguien se olvida de validar en el server.
  CONSTRAINT tarea_links_url_http CHECK (url ~* '^https?://.'),
  CONSTRAINT tarea_links_posicion_no_negativa CHECK (posicion >= 0)
);

CREATE INDEX IF NOT EXISTS tarea_links_tarea_idx
  ON tarea_links (tarea_id, posicion);


-- ─── Comentarios de una tarea ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tarea_comentarios (
  id         bigserial   PRIMARY KEY,
  tarea_id   bigint      NOT NULL REFERENCES tareas(id) ON DELETE CASCADE,
  -- RESTRICT: el comentario dice quién lo escribió y eso no se puede quedar en
  -- NULL. Es la segunda razón por la que los usuarios se desactivan y no se
  -- borran.
  usuario_id integer     NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  cuerpo     text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tarea_comentarios_cuerpo_no_vacio CHECK (length(btrim(cuerpo)) > 0)
);

CREATE INDEX IF NOT EXISTS tarea_comentarios_tarea_idx
  ON tarea_comentarios (tarea_id, created_at);

CREATE OR REPLACE TRIGGER tarea_comentarios_updated_at
  BEFORE UPDATE ON tarea_comentarios
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
