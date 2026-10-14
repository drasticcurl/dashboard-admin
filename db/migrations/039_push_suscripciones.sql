-- ═══════════════════════════════════════════════════════════════════════════
-- 039 — Suscripciones push de la PWA (avisos del profit del día).
--
-- Una fila por navegador/celular que activó los avisos. El `endpoint` es la URL
-- que da el servicio push del navegador (Apple, Google o Mozilla) y es único por
-- instalación: si el mismo celular vuelve a activar, se pisa la fila (UPSERT) en
-- vez de duplicar el aviso.
--
-- `p256dh` y `auth` son las claves con las que `web-push` cifra el mensaje: el
-- servicio push lo transporta sin poder leerlo.
--
-- ON DELETE CASCADE con usuarios: si se borra a alguien, sus celulares dejan de
-- recibir el profit. Un usuario DESACTIVADO también deja de recibirlo, pero eso
-- lo filtra el script al enviar (JOIN con `activo`), no esta tabla.
--
-- Cuando el servicio push responde 404/410 la suscripción murió (desinstaló la
-- app, borró datos o sacó el permiso) y `lib/push.ts` borra la fila.
--
-- IDEMPOTENTE.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS push_suscripciones (
  id          serial      PRIMARY KEY,
  usuario_id  integer     NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  endpoint    text        NOT NULL UNIQUE,
  p256dh      text        NOT NULL,
  auth        text        NOT NULL,
  user_agent  text,
  creada_at   timestamptz NOT NULL DEFAULT now(),
  ultimo_ok_at timestamptz
);

CREATE INDEX IF NOT EXISTS push_suscripciones_usuario_idx
  ON push_suscripciones (usuario_id);
