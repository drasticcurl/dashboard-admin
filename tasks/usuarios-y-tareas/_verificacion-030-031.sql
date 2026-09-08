-- ═══════════════════════════════════════════════════════════════════════════
-- Verificación de las migraciones 030 (usuarios) y 031 (tareas).
--
--   psql "$DATABASE_URL" -f tasks/usuarios-y-tareas/_verificacion-030-031.sql
--
-- Esperado: las 28 líneas dicen PASA. Cualquier FALLA es bloqueante.
--
-- El script SIEMBRA para poder probar los constraints (no se puede verificar que
-- algo se rechaza sin intentarlo) y termina en ROLLBACK: la base queda como
-- estaba. El conteo de filas al principio y al final lo demuestra.
--
-- YA CORRIDO EN VERDE contra una base scratch con las 29 migraciones reales
-- aplicadas (Postgres 16.14) el 2026-09-08. Los 28 PASA de abajo son salida real,
-- no una expectativa.
-- ═══════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
\timing off

BEGIN;

-- ── Los dos helpers ────────────────────────────────────────────────────────
-- `pg_temp` y no tablas reales: desaparecen con la sesión, y con el ROLLBACK
-- antes todavía.

CREATE FUNCTION pg_temp.afirmar(cond boolean, chequeo text) RETURNS void AS $$
BEGIN
  IF cond THEN RAISE NOTICE 'PASA   %', chequeo;
  ELSE          RAISE WARNING 'FALLA  %', chequeo;
  END IF;
END $$ LANGUAGE plpgsql;

-- Afirma que un INSERT/UPDATE tiene que EXPLOTAR. El bloque anidado crea una
-- subtransacción, así que el error se captura y la transacción de afuera sigue
-- viva — es la única forma de probar un CHECK sin abortar el script.
CREATE FUNCTION pg_temp.afirmar_rechaza(sentencia text, chequeo text) RETURNS void AS $$
BEGIN
  BEGIN
    EXECUTE sentencia;
    RAISE WARNING 'FALLA  % — la base ACEPTÓ lo que tenía que rechazar', chequeo;
  EXCEPTION WHEN check_violation OR unique_violation OR foreign_key_violation
                 OR not_null_violation THEN
    RAISE NOTICE 'PASA   %', chequeo;
  END;
END $$ LANGUAGE plpgsql;

\echo ''
\echo '── Estado antes de sembrar ───────────────────────────────────────────'
SELECT
  (SELECT count(*) FROM usuarios)          AS usuarios,
  (SELECT count(*) FROM usuario_secciones) AS secciones,
  (SELECT count(*) FROM tareas)            AS tareas;

\echo ''
\echo '── 030 · usuarios ───────────────────────────────────────────────────'

-- El hash de prueba tiene la forma real: scrypt$N$r$p$salt$derivada.
INSERT INTO usuarios (usuario, nombre, clave_hash, es_admin, debe_cambiar_clave)
VALUES ('verif-lucho', 'Lucho', 'scrypt$16384$8$1$' || repeat('a',32) || '$' || repeat('b',64), true,  false),
       ('verif-nahuel','Nahuel','scrypt$16384$8$1$' || repeat('c',32) || '$' || repeat('d',64), false, true);

DO $$
DECLARE admin_id int; otro_id int;
BEGIN
  SELECT id INTO admin_id FROM usuarios WHERE usuario = 'verif-lucho';
  SELECT id INTO otro_id  FROM usuarios WHERE usuario = 'verif-nahuel';

  PERFORM pg_temp.afirmar(admin_id IS NOT NULL AND otro_id IS NOT NULL,
    ' 1. dos usuarios insertados, uno admin y uno no');

  -- El índice único es funcional: normaliza antes de comparar. Sin esto,
  -- "Verif-Lucho" sería una segunda cuenta con la misma intención.
  PERFORM pg_temp.afirmar_rechaza(
    format($q$INSERT INTO usuarios (usuario,nombre,clave_hash)
              VALUES ('verif-lucho','Otro','scrypt$16384$8$1$%s$%s')$q$, repeat('e',32), repeat('f',64)),
    ' 2. usuario duplicado exacto → rechazado');

  PERFORM pg_temp.afirmar_rechaza(
    format($q$INSERT INTO usuarios (usuario,nombre,clave_hash)
              VALUES ('Verif-Lucho','Otro','scrypt$16384$8$1$%s$%s')$q$, repeat('e',32), repeat('f',64)),
    ' 3. usuario con mayúsculas → rechazado (CHECK de normalización)');

  PERFORM pg_temp.afirmar_rechaza(
    format($q$INSERT INTO usuarios (usuario,nombre,clave_hash)
              VALUES ('con espacio','Otro','scrypt$16384$8$1$%s$%s')$q$, repeat('e',32), repeat('f',64)),
    ' 4. usuario con espacio → rechazado');

  -- La defensa contra el bug más caro posible: un script que guarda la contraseña
  -- en claro en vez del hash. El login la compararía contra un scrypt y nadie
  -- podría entrar, o peor, un verify mal escrito la aceptaría tal cual.
  PERFORM pg_temp.afirmar_rechaza(
    $q$INSERT INTO usuarios (usuario,nombre,clave_hash) VALUES ('verif-x','X','123456')$q$,
    ' 5. clave_hash en claro → rechazado (formato scrypt$...)');

  PERFORM pg_temp.afirmar_rechaza(
    $q$INSERT INTO usuarios (usuario,nombre,clave_hash) VALUES ('verif-y','Y','')$q$,
    ' 6. clave_hash vacío → rechazado');

  PERFORM pg_temp.afirmar(
    (SELECT debe_cambiar_clave FROM usuarios WHERE usuario='verif-nahuel'),
    ' 7. debe_cambiar_clave nace en true');

  PERFORM pg_temp.afirmar(
    (SELECT activo AND NOT es_admin FROM usuarios WHERE usuario='verif-nahuel'),
    ' 8. defaults: activo=true, es_admin=false');

  -- ── Permisos ────────────────────────────────────────────────────────────
  INSERT INTO usuario_secciones (usuario_id, seccion) VALUES
    (otro_id,'resumen'), (otro_id,'finanzas'), (otro_id,'tareas');

  PERFORM pg_temp.afirmar(
    (SELECT count(*) FROM usuario_secciones WHERE usuario_id=otro_id) = 3,
    ' 9. las 3 secciones de nahuel otorgadas');

  PERFORM pg_temp.afirmar(
    NOT EXISTS (SELECT 1 FROM usuario_secciones WHERE usuario_id=otro_id AND seccion='config'),
    '10. lo que no se otorgó NO tiene fila (falla cerrado)');

  PERFORM pg_temp.afirmar_rechaza(
    format('INSERT INTO usuario_secciones (usuario_id,seccion) VALUES (%s,%L)', otro_id, 'inventada'),
    '11. sección fuera del vocabulario → rechazada');

  PERFORM pg_temp.afirmar_rechaza(
    format('INSERT INTO usuario_secciones (usuario_id,seccion) VALUES (%s,%L)', otro_id, 'resumen'),
    '12. permiso duplicado → rechazado (PK compuesta)');

  PERFORM pg_temp.afirmar_rechaza(
    'INSERT INTO usuario_secciones (usuario_id,seccion) VALUES (999999,''resumen'')',
    '13. permiso de un usuario inexistente → rechazado (FK)');

  -- El vocabulario tiene que ser EXACTAMENTE estas 8 y ninguna más. Se lee del
  -- CHECK de verdad (`pg_constraint`) y no de una lista escrita acá al lado, que
  -- es lo que haría que la afirmación pase siempre. Si alguien agrega una sección
  -- al CHECK, esto FALLA y lo obliga a mirar también el mapa de rutas de
  -- `lib/permisos.ts` (que tiene su propio test, T02 §5).
  PERFORM pg_temp.afirmar(
    (SELECT count(*) FROM unnest(ARRAY['resumen','embudo','ventas','anuncios',
                                       'finanzas','leads','config','tareas']) s
       WHERE pg_get_constraintdef(c.oid) LIKE '%''' || s || '''%') = 8
      AND (length(pg_get_constraintdef(c.oid))
           - length(replace(pg_get_constraintdef(c.oid), '''', ''))) / 2 = 8,
    '14. el CHECK del vocabulario declara EXACTAMENTE las 8 secciones')
  FROM pg_constraint c WHERE c.conname = 'usuario_secciones_valida';
END $$;

\echo ''
\echo '── 031 · tareas ─────────────────────────────────────────────────────'

DO $$
DECLARE admin_id int; otro_id int; t1 bigint; t2 bigint; t3 bigint; t4 bigint; upd1 timestamptz; upd2 timestamptz;
BEGIN
  SELECT id INTO admin_id FROM usuarios WHERE usuario='verif-lucho';
  SELECT id INTO otro_id  FROM usuarios WHERE usuario='verif-nahuel';

  INSERT INTO tareas (titulo, asignado_a, creado_por, prioridad, posicion)
    VALUES ('Tarea A', otro_id, admin_id, 'alta', 10) RETURNING id INTO t1;
  INSERT INTO tareas (titulo, asignado_a, creado_por, posicion)
    VALUES ('Tarea B', otro_id, admin_id, 20) RETURNING id INTO t2;
  INSERT INTO tareas (titulo, asignado_a, creado_por, columna, hecha_at, posicion)
    VALUES ('Tarea C', admin_id, admin_id, 'hecho', now() - interval '3 days', 10) RETURNING id INTO t3;

  PERFORM pg_temp.afirmar(
    (SELECT columna='por_hacer' AND prioridad='media' AND notas IS NULL AND vence_el IS NULL
       FROM tareas WHERE id=t2),
    '15. defaults de una tarjeta mínima: por_hacer / media / resto NULL');

  PERFORM pg_temp.afirmar_rechaza(
    format('INSERT INTO tareas (titulo,asignado_a) VALUES (%L,%s)', '   ', otro_id),
    '16. título en blanco → rechazado');

  PERFORM pg_temp.afirmar_rechaza(
    format('INSERT INTO tareas (titulo,asignado_a,columna) VALUES (%L,%s,%L)','X',otro_id,'archivado'),
    '17. columna fuera de las 4 → rechazada');

  PERFORM pg_temp.afirmar_rechaza(
    format('INSERT INTO tareas (titulo,asignado_a,prioridad) VALUES (%L,%s,%L)','X',otro_id,'urgentisima'),
    '18. prioridad fuera de las 3 → rechazada');

  -- ── El reloj del archivado, que es lo que más fácil se corrompe ──────────
  PERFORM pg_temp.afirmar_rechaza(
    format('UPDATE tareas SET columna=''hecho'' WHERE id=%s', t1),
    '19. pasar a hecho SIN hecha_at → rechazado');

  PERFORM pg_temp.afirmar_rechaza(
    format('UPDATE tareas SET columna=''en_progreso'' WHERE id=%s', t3),
    '20. sacar de hecho SIN limpiar hecha_at → rechazado');

  PERFORM pg_temp.afirmar_rechaza(
    format('UPDATE tareas SET archivada_at=now() WHERE id=%s', t1),
    '21. archivar una tarjeta que no está en hecho → rechazado');

  -- Lo que el cron va a barrer: en hecho, hace más de 2 días, sin archivar.
  -- t3 tiene hecha_at de hace 3 días → entra. t1 y t2 no están en hecho → no.
  PERFORM pg_temp.afirmar(
    (SELECT count(*) FROM tareas
      WHERE archivada_at IS NULL AND hecha_at IS NOT NULL
        AND hecha_at < now() - interval '2 days'
        AND id IN (t1,t2,t3)) = 1,
    '22. el barrido de 2 días selecciona 1 de las 3 tarjetas sembradas');

  -- ── El trigger de updated_at ─────────────────────────────────────────────
  --
  -- OJO CON CÓMO SE TESTEA ESTO, porque la forma obvia da un falso negativo.
  -- `update_updated_at()` (012_comisiones_reglas.sql:64-70) hace
  -- `NEW.updated_at = now()`, y `now()` en Postgres es la hora de INICIO DE LA
  -- TRANSACCIÓN, constante hasta el COMMIT. Insertar y después updatear dentro del
  -- mismo BEGIN deja los dos valores IDÉNTICOS, y un `pg_sleep` en el medio no
  -- cambia nada. La primera versión de esta afirmación comparaba `upd2 > upd1` y
  -- daba FALLA con el trigger perfectamente instalado.
  --
  -- La fila se siembra vieja EN EL INSERT y no con un UPDATE posterior: el trigger
  -- es BEFORE UPDATE, así que un `UPDATE ... SET updated_at = <viejo>` lo pisa el
  -- propio trigger y vuelve a dar los dos valores iguales. (La segunda versión de
  -- esta afirmación falló por eso.) Consecuencia real y no sólo del test:
  -- `updated_at` NO SE PUEDE ESCRIBIR desde la aplicación — cualquier UPDATE que
  -- la mande la ve reemplazada por now(). Es correcto y es lo que se quiere, pero
  -- descarta backdatear una fila para arreglar un dato.
  INSERT INTO tareas (titulo, asignado_a, creado_por, updated_at)
    VALUES ('Tarea D vieja', otro_id, admin_id, now() - interval '2 days')
    RETURNING id, updated_at INTO t4, upd1;
  UPDATE tareas SET titulo='Tarea D editada' WHERE id=t4;
  SELECT updated_at INTO upd2 FROM tareas WHERE id=t4;
  PERFORM pg_temp.afirmar(upd1 < upd2 AND upd2 = now(),
    '23. trigger updated_at de tareas dispara y pone now()');

  -- Y la consecuencia de lo de arriba, declarada como afirmación para que quede
  -- escrita: `updated_at` NO ordena eventos de una misma transacción. Por eso el
  -- orden del tablero vive en `posicion` y el reloj del archivado en `hecha_at`,
  -- y no se derivan de `updated_at`.
  PERFORM pg_temp.afirmar(
    (SELECT updated_at FROM tareas WHERE id=t2) = (SELECT updated_at FROM tareas WHERE id=t3),
    '24. dos filas escritas en la misma transacción comparten updated_at');

  -- ── Links: el CHECK que evita un javascript: en un href del panel ───────
  INSERT INTO tarea_links (tarea_id,url,etiqueta) VALUES (t1,'https://ejemplo.com/recurso','El brief');
  PERFORM pg_temp.afirmar_rechaza(
    format('INSERT INTO tarea_links (tarea_id,url) VALUES (%s,%L)', t1, 'javascript:alert(1)'),
    '25. url javascript: → rechazada (sólo http/https)');
  PERFORM pg_temp.afirmar_rechaza(
    format('INSERT INTO tarea_links (tarea_id,url) VALUES (%s,%L)', t1, 'ejemplo.com'),
    '26. url sin esquema → rechazada');

  INSERT INTO tarea_comentarios (tarea_id,usuario_id,cuerpo) VALUES (t1,admin_id,'Lo miro mañana');

  -- ── Los ON DELETE, que son la parte que decide qué se puede borrar ──────
  PERFORM pg_temp.afirmar_rechaza(
    format('DELETE FROM usuarios WHERE id=%s', otro_id),
    '27. borrar un usuario CON tarjetas → rechazado (RESTRICT)');

  DELETE FROM tareas WHERE id=t1;
  PERFORM pg_temp.afirmar(
    (SELECT count(*) FROM tarea_links WHERE tarea_id=t1) = 0
    AND (SELECT count(*) FROM tarea_comentarios WHERE tarea_id=t1) = 0,
    '28. borrar una tarjeta se lleva sus links y comentarios (CASCADE)');
END $$;

\echo ''
\echo '── Estado después (tiene que ser IGUAL al de arriba tras el ROLLBACK) ─'

ROLLBACK;

SELECT
  (SELECT count(*) FROM usuarios)          AS usuarios,
  (SELECT count(*) FROM usuario_secciones) AS secciones,
  (SELECT count(*) FROM tareas)            AS tareas,
  (SELECT count(*) FROM tarea_links)       AS links,
  (SELECT count(*) FROM tarea_comentarios) AS comentarios;

\echo ''
\echo 'Esperado: 28 PASA, cero FALLA, y los conteos de arriba en 0 (base scratch)'
\echo 'o iguales a los de antes de sembrar (base con datos).'
\echo ''
