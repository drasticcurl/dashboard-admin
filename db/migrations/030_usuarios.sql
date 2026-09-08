-- ════════════════════════════════════════════════════════════════════════════
-- 030 — Usuarios del panel y qué pestañas ve cada uno
--
-- Hasta acá el panel se autenticaba con UNA contraseña compartida
-- (`DASHBOARD_PASSWORD`) y la cookie no llevaba identidad: `lib/auth.ts:82-89`
-- firma un HMAC sobre un timestamp usando la contraseña como clave. Dos
-- migraciones ya habían anotado la limitación como conocida —
-- `016_ads_gestion.sql:404-416` ("'manual' quiere decir alguien con la
-- contraseña y nada más") y `017_rediseno_ui.sql:149-155` ("si dos personas usan
-- el panel, el que guarda último gana").
--
-- Esta migración crea la identidad. Lo que NO hace, a propósito:
--
--   · NO seedea ningún usuario. El admin lo crea `scripts/seed-usuarios.ts`
--     (`npm run usuarios:seed`), que lee `PANEL_ADMIN_USUARIO`. Tiene que ser un
--     script y no un INSERT acá por DOS razones:
--       1. El admin es distinto por instancia (hilvanapp → lucho, infinix →
--          Ivan) y una migración SQL no lee env vars. El precedente del repo es
--          `funnels.ingest_key_hash`, que se carga con `scripts/set-ingest-key.ts`
--          y nunca desde un .sql.
--       2. Un hash de contraseña dentro de un archivo commiteado es una
--          credencial en el repo. El hash de '123456' es adivinable igual, pero
--          que esté en git lo vuelve permanente.
--
--   · NO rompe el login mientras la tabla esté vacía. `lib/auth.ts` cae a
--     `DASHBOARD_PASSWORD` como hoy y esa sesión vale como admin. Es lo que hace
--     que las DOS instancias sigan entrando en el minuto siguiente al deploy, sin
--     que infinix se entere de nada (regla de instancias: el default es el
--     comportamiento histórico de hilvanapp). El fallback se apaga solo en cuanto
--     hay una fila.
--
-- ADITIVA. Dos tablas nuevas, ningún ALTER, ningún DROP. El panel está en
-- producción en los dos dominios.
-- ════════════════════════════════════════════════════════════════════════════


-- ─── Los usuarios ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS usuarios (
  id            serial      PRIMARY KEY,

  -- Con qué escribe en el login. Minúsculas sin espacios, forzado por el CHECK:
  -- sin eso "Lucho" y "lucho" son dos filas distintas y el índice único de abajo
  -- (que sí normaliza) las dejaría entrar a las dos con la misma intención.
  usuario       text        NOT NULL,

  -- Cómo se muestra en el kanban y en el header. Separado de `usuario` porque el
  -- de arriba es una credencial y este es texto de pantalla: renombrar a alguien
  -- no puede cambiar con qué entra.
  nombre        text        NOT NULL,

  -- ─── EL FORMATO DEL HASH ES PARTE DEL CONTRATO ───────────────────────────
  --   scrypt$<N>$<r>$<p>$<salt hex>$<derivada hex>
  -- Los parámetros van EN la fila y no en una constante del código porque son lo
  -- único que permite subir el costo más adelante sin invalidar los hashes que ya
  -- están: el verify lee N, r y p de la fila que está comprobando. Si vivieran en
  -- el código, cambiar N convertiría todas las contraseñas existentes en basura y
  -- nadie podría entrar.
  --
  -- scrypt y no bcrypt/argon2: viene en `node:crypto`, así que no se toca
  -- `package.json` (y `deploy/deploy.sh:210` corre `npm ci` sin `--omit=dev`, o
  -- sea que un módulo nativo se compilaría en la VPS en cada deploy). Medido en
  -- este repo con Node v24.14.0: N=16384 r=8 p=1 → entre 30 y 99 ms por
  -- verificación (la primera llamada del proceso paga el warm-up del módulo).
  --
  -- Y NO es un sha256 pelado como `funnels.ingest_key_hash`: esa key son 32 bytes
  -- aleatorios y no se puede adivinar, una contraseña que elige una persona sí.
  clave_hash    text        NOT NULL,

  -- El admin ve TODAS las secciones sin necesidad de filas en `usuario_secciones`.
  -- Es a propósito y no por ahorrar filas: si los permisos del admin fueran filas,
  -- un click equivocado en la pantalla de Usuarios lo dejaría afuera de Config —
  -- que es justo la pantalla donde se arregla. Un admin implícitamente total no
  -- se puede autoencerrar.
  es_admin      boolean     NOT NULL DEFAULT false,

  -- Nace en true: el seed pone '123456' y la primera pantalla obliga a cambiarla
  -- (mínimo 15 caracteres, validado en el server). Mientras esté en true la
  -- sesión NO sirve para nada que no sea cambiar la clave.
  debe_cambiar_clave boolean NOT NULL DEFAULT true,

  -- Desactivar es el camino, borrar no. No hay endpoint de DELETE de usuarios: los
  -- FK de `tareas.asignado_a` y `tarea_comentarios.usuario_id` son RESTRICT, así
  -- que borrar a alguien con historial fallaría igual, y la fila es lo que le da
  -- nombre a sus tarjetas viejas. Un usuario inactivo no puede entrar y no aparece
  -- en el selector de asignar, pero sus tareas siguen diciendo quién las hizo.
  activo        boolean     NOT NULL DEFAULT true,

  ultimo_login_at timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT usuarios_usuario_no_vacio  CHECK (length(btrim(usuario)) > 0),
  CONSTRAINT usuarios_nombre_no_vacio   CHECK (length(btrim(nombre)) > 0),
  -- Ni espacios ni mayúsculas: ver el comentario de la columna.
  CONSTRAINT usuarios_usuario_normalizado
    CHECK (usuario = lower(usuario) AND usuario = btrim(usuario) AND position(' ' in usuario) = 0),
  -- Que el hash tenga forma de hash. Una fila con clave_hash = '' o con la
  -- contraseña en claro por un bug de un script sería un login que acepta
  -- cualquier cosa o que no acepta nada, sin un error que lo diga.
  CONSTRAINT usuarios_clave_hash_formato CHECK (clave_hash LIKE 'scrypt$%$%$%$%$%')
);

-- Un usuario, una fila. Funcional sobre lower(btrim(...)) como
-- `finance_accounts (lower(btrim(name)))` de la 028: el CHECK de arriba ya obliga
-- a que la columna venga normalizada, y este índice es la red por si alguien
-- inserta desde psql saltándose el código.
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_usuario_uq
  ON usuarios (lower(btrim(usuario)));

-- El login busca por usuario entre los activos.
CREATE INDEX IF NOT EXISTS usuarios_activos_idx
  ON usuarios (activo) WHERE activo;

CREATE OR REPLACE TRIGGER usuarios_updated_at
  BEFORE UPDATE ON usuarios
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ─── Qué pestañas ve cada uno ───────────────────────────────────────────────
--
-- UNA FILA POR PERMISO OTORGADO, y no siete columnas booleanas ni un text[].
--
-- Con columnas o con array, agregar una pestaña el año que viene obliga a decidir
-- un default para todos los usuarios existentes, y el default cómodo es "true" —
-- o sea que una sección nueva nace visible para todos sin que nadie lo haya
-- pedido. Con filas, "no hay fila" ES "no lo ve", así que una sección nueva nace
-- negada y hay que otorgarla a mano. Falla cerrado por construcción, que es la
-- única forma de que esto no se rompa en silencio.
--
-- Es además el modelo al que el repo ya migró una vez: `021_reglas_por_cuenta.sql`
-- deshizo `ad_rules.account_ids text[]` para pasar a una fila por cuenta.

CREATE TABLE IF NOT EXISTS usuario_secciones (
  usuario_id  integer     NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,

  -- El vocabulario son las 8 pestañas del header (las 7 que ya existen más
  -- Tareas). NO incluye las 3 sub-pestañas de Anuncios ni las 10 secciones de
  -- Config: esas se prenden y se apagan con su pestaña madre entera. Config a
  -- medias no significa nada — es la configuración del sistema.
  --
  -- text + CHECK y no un enum nativo, como las 29 migraciones anteriores: agregar
  -- un valor a un enum es DDL con candados y no se puede quitar; un CHECK se
  -- reemplaza con DROP + ADD.
  seccion     text        NOT NULL,

  created_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (usuario_id, seccion),
  CONSTRAINT usuario_secciones_valida CHECK (seccion IN (
    'resumen', 'embudo', 'ventas', 'anuncios', 'finanzas', 'leads', 'config', 'tareas'
  ))
);

-- El layout del panel pregunta "qué ve este usuario" en cada carga de página.
CREATE INDEX IF NOT EXISTS usuario_secciones_usuario_idx
  ON usuario_secciones (usuario_id);
