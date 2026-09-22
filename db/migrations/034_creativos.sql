-- ════════════════════════════════════════════════════════════════════════════
-- 034 — Creativos: tracker de eficiencia de videos
--
-- Una pestaña nueva y chica: registrar cómo le fue a cada video (alto / medio /
-- bajo), con un nombre o nota corta y el link. Sin columnas, sin drag & drop,
-- sin dueño por fila — el molde de datos es una sola tabla, más simple que
-- `tareas` (031) porque no hace falta nada de lo que esa complejidad resuelve
-- (no hay tablero, no hay "es mía vs es de otro").
--
-- POR QUÉ NO HAY DUEÑO NI RESTRICCIÓN DE EDICIÓN POR FILA
-- A diferencia de `tareas.asignado_a` (031, RESTRICT, "sólo el dueño edita"), acá
-- cualquiera con la sección puede editar o borrar cualquier fila. Es la decisión
-- explícita del pedido: un tracker compartido de eficiencia de creativos, no un
-- tablero personal. `creado_por` se guarda igual (mismo patrón que
-- `tareas.creado_por`: nullable, ON DELETE SET NULL en vez de RESTRICT) sólo para
-- poder mostrar "quién lo cargó" en la UI — nunca se usa para autorizar.
--
-- ON DELETE SET NULL y no RESTRICT en `creado_por`: a diferencia de `tareas`
-- (donde `asignado_a` es NOT NULL y el dueño importa para permisos), acá
-- `creado_por` es puramente informativo. Bloquear la baja de un usuario porque
-- alguna vez cargó un creativo sería una consecuencia rara para un dato que no
-- se usa para nada más que mostrar un nombre.
--
-- POR QUÉ 'rendimiento' ES text + CHECK Y NO UN ENUM NATIVO
-- Mismo motivo que `usuario_secciones.seccion` (030) y `tareas.prioridad` (031):
-- un enum nativo es DDL con candados (agregar un valor se puede, sacarlo no); un
-- CHECK se reemplaza con DROP + ADD si el día de mañana hace falta una cuarta
-- categoría.
--
-- OTORGAMIENTO RETROACTIVO DE LA SECCIÓN NUEVA (decisión explícita, no el
-- default del repo)
-- `030_usuarios.sql` documenta que `usuario_secciones` es opt-in A PROPÓSITO:
-- "no hay fila" ES "no lo ve", así toda sección nueva nace negada y hay que
-- otorgarla a mano — falla cerrado por construcción. Para 'creativos' el pedido
-- fue lo contrario: todos los usuarios ya existentes tienen que verla desde ya,
-- y que el bloqueo (si alguna vez hace falta) sea la excepción manual desde
-- Config → Usuarios. Por eso esta migración, ADEMÁS de agregar 'creativos' al
-- vocabulario del CHECK, inserta la fila de permiso para cada usuario NO-ADMIN
-- que todavía no la tenga (los admin ya ven todo por D11 y no necesitan fila).
-- Es retroactivo SÓLO para los usuarios que existen HOY: un usuario creado
-- después de esta migración pasa por el flujo normal de Config, como cualquier
-- otra sección — el pedido fue sobre el estado actual, no sobre invertir el
-- diseño de permisos para siempre.
--
-- ADITIVA. Una tabla nueva y un ALTER de CHECK (DROP + ADD, no destructivo:
-- todos los valores viejos siguen siendo válidos). Ningún DROP de datos.
-- Depende de la 030: el FK de `creado_por` apunta a `usuarios`, y el ALTER
-- toca el CHECK que esa migración creó.
-- ════════════════════════════════════════════════════════════════════════════


-- ─── La tabla ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS creativos (
  id            bigserial   PRIMARY KEY,

  -- Nombre o nota corta: "no es un título de campaña", es lo que identifica al
  -- video de un vistazo en la tabla ("Testimonio Marta v2", "Hook dolor lumbar").
  nombre        text        NOT NULL,

  link          text        NOT NULL,

  rendimiento   text        NOT NULL,

  -- Quién lo cargó. Puramente informativo (ver nota de arriba) — nunca se usa
  -- para decidir quién puede editar o borrar.
  creado_por    integer     REFERENCES usuarios(id) ON DELETE SET NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT creativos_nombre_no_vacio CHECK (length(btrim(nombre)) > 0),
  -- Sólo http(s), mismo motivo que `tarea_links_url_http` (031): el link sale
  -- renderizado en un <a href> del panel, y un `javascript:` guardado por un
  -- descuido de validación en el server se ejecutaría con la sesión de quien lo
  -- abra. El CHECK es la última defensa.
  CONSTRAINT creativos_link_http CHECK (link ~* '^https?://.'),
  CONSTRAINT creativos_rendimiento_valido CHECK (rendimiento IN ('alto', 'medio', 'bajo'))
);

-- La lectura de la pantalla: lo más nuevo primero.
CREATE INDEX IF NOT EXISTS creativos_created_at_idx
  ON creativos (created_at DESC);

CREATE OR REPLACE TRIGGER creativos_updated_at
  BEFORE UPDATE ON creativos
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ─── Agregar 'creativos' al vocabulario de secciones ────────────────────────

ALTER TABLE usuario_secciones DROP CONSTRAINT usuario_secciones_valida;
ALTER TABLE usuario_secciones ADD CONSTRAINT usuario_secciones_valida CHECK (seccion IN (
  'resumen', 'embudo', 'ventas', 'anuncios', 'finanzas', 'leads', 'config', 'tareas', 'creativos'
));


-- ─── Otorgamiento retroactivo (ver nota de arriba) ──────────────────────────
--
-- Sólo a los usuarios NO-admin: el admin ya ve todo por D11 (`filaASesion` en
-- `lib/permisos.ts` le devuelve las 9 secciones sin mirar la tabla) y darle una
-- fila explícita no cambia nada — sería una fila de más sin ningún efecto.
-- `ON CONFLICT DO NOTHING` por si esta migración se corre dos veces (idempotente,
-- como el resto del repo): la segunda corrida no falla contra el PRIMARY KEY.

INSERT INTO usuario_secciones (usuario_id, seccion)
SELECT u.id, 'creativos'
  FROM usuarios u
 WHERE u.es_admin = false
ON CONFLICT DO NOTHING;
