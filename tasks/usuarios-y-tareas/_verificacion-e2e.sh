#!/usr/bin/env bash
#
# Verificación de punta a punta del módulo de usuarios y tareas.
#
#   bash tasks/usuarios-y-tareas/_verificacion-e2e.sh
#
# Esperado: los 9 pasos en PASA y exit 0.
#
# Qué hace: levanta un clúster de Postgres EFÍMERO en /tmp, le aplica las 31
# migraciones, corre las dos verificaciones de esta carpeta, siembra los usuarios,
# prueba los permisos a nivel de datos y borra todo al terminar.
#
# NO TOCA NI TU BASE DE DESARROLLO NI PRODUCCIÓN. Es a propósito: `.env` apunta a
# `127.0.0.1:5433/panel`, y el nombre de esa base es IDÉNTICO al de producción de
# hilvanapp (host y puerto son lo único que las distingue). Un script de
# verificación que escribe en la base que el nombre no distingue es exactamente el
# modo de falla que el guard de identidad del deploy de infinix existe para atajar.
#
# Lo que este script NO puede verificar y hay que hacer a mano: los guards de las
# pantallas y los 403 de las API routes con una cookie de verdad. Eso está en
# T03 §7 pasos 3 a 7 y en T05 §7 paso 3, y son los pasos que más importan.
#
set -euo pipefail
cd "$(dirname "$0")/../.."

PGDATA=/tmp/pg-e2e-usuarios
PGPORT=55433
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@16/bin}"
SCRATCH="postgres://panel@127.0.0.1:${PGPORT}/panel_e2e"
export PATH="$PGBIN:$PATH"

fallas=0
pasa() { echo "PASA   $1"; }
falla() { echo "FALLA  $1"; fallas=$((fallas + 1)); }

limpiar() {
  pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$PGDATA"
}
trap limpiar EXIT

if [ ! -f db/migrations/030_usuarios.sql ] || [ ! -f db/migrations/031_tareas.sql ]; then
  echo ""
  echo "Este script corre DESPUÉS de T01: todavía no existen db/migrations/030_usuarios.sql"
  echo "y/o db/migrations/031_tareas.sql. T01 los copia de _schema-030.sql y _schema-031.sql."
  echo ""
  echo "Para verificar el DDL antes de que T01 exista, corré a mano lo de T01 §11 paso 1."
  exit 1
fi

echo ""
echo "── 0. Clúster efímero ────────────────────────────────────────────────"
# initdb y no `docker compose up`: el 2026-09-08 no había ningún Postgres corriendo
# en la máquina de desarrollo (colima apagado, postgresql@16 de brew instalado sin
# arrancar), y un clúster en /tmp no deja nada instalado ni ocupa un puerto conocido.
command -v initdb >/dev/null || { echo "FALLA: no encuentro initdb. Exportá PGBIN."; exit 1; }
limpiar
initdb -U panel --encoding=UTF8 --locale=C -D "$PGDATA" >/tmp/e2e-initdb.log 2>&1
pg_ctl -D "$PGDATA" -o "-p ${PGPORT} -k /tmp -c listen_addresses=127.0.0.1" \
  -l /tmp/e2e-pg.log start >/dev/null
sleep 2
psql "postgres://panel@127.0.0.1:${PGPORT}/postgres" -qc "CREATE DATABASE panel_e2e;"
VER=$(psql "$SCRATCH" -tAc "SHOW server_version;" | cut -d. -f1)
[ "$VER" = "16" ] && pasa "0. Postgres 16 efímero en el puerto ${PGPORT}" \
                  || falla "0. la versión es ${VER}, producción usa 16"

echo ""
echo "── 1. Las 31 migraciones ─────────────────────────────────────────────"
# 001-020 primero. La 021 aborta en una base nueva si no hay una cuenta
# publicitaria activa ('021 abortada: no existe ninguna Cuenta_Activa'), así que va
# un placeholder en el medio. Es la secuencia de /root/panel-infinix-migrate.sh.
for f in db/migrations/0[01]*.sql db/migrations/020*.sql; do
  psql "$SCRATCH" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null 2>/tmp/e2e-err.log \
    || { falla "1. murió en $(basename "$f"): $(tail -1 /tmp/e2e-err.log)"; exit 1; }
done
psql "$SCRATCH" -qc "INSERT INTO ad_accounts (account_id, platform, name, active)
  VALUES ('act_placeholder_e2e','meta','placeholder',true) ON CONFLICT DO NOTHING;"
for f in db/migrations/02*.sql db/migrations/03*.sql; do
  [ -f "$f" ] || continue
  psql "$SCRATCH" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null 2>/tmp/e2e-err.log \
    || { falla "1. murió en $(basename "$f"): $(tail -1 /tmp/e2e-err.log)"; exit 1; }
done
TABLAS=$(psql "$SCRATCH" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")
# 44 con las 29 migraciones + 5 nuevas (usuarios, usuario_secciones, tareas,
# tarea_links, tarea_comentarios) = 49.
[ "$TABLAS" = "49" ] && pasa "1. 49 tablas (44 previas + las 5 del módulo)" \
                     || falla "1. hay $TABLAS tablas, esperaba 49"

echo ""
echo "── 2. Idempotencia de las dos migraciones nuevas ─────────────────────"
psql "$SCRATCH" -v ON_ERROR_STOP=1 -q -f db/migrations/030_usuarios.sql >/dev/null 2>&1 \
  && psql "$SCRATCH" -v ON_ERROR_STOP=1 -q -f db/migrations/031_tareas.sql >/dev/null 2>&1 \
  && pasa "2. la 030 y la 031 corren dos veces sin error" \
  || falla "2. una de las dos no es idempotente"

echo ""
echo "── 3. Las 28 afirmaciones del esquema ────────────────────────────────"
SALIDA=$(psql "$SCRATCH" -f tasks/usuarios-y-tareas/_verificacion-030-031.sql 2>&1)
OK=$(echo "$SALIDA" | grep -c 'NOTICE: *PASA' || true)
NO=$(echo "$SALIDA" | grep -c 'WARNING: *FALLA' || true)
[ "$OK" = "28" ] && [ "$NO" = "0" ] && pasa "3. 28 PASA, 0 FALLA" \
                                   || { falla "3. $OK PASA y $NO FALLA (esperaba 28 y 0)";
                                        echo "$SALIDA" | grep 'FALLA'; }

echo ""
echo "── 4. La base quedó como estaba (el ROLLBACK del paso 3) ─────────────"
RESTO=$(psql "$SCRATCH" -tAc "SELECT (SELECT count(*) FROM usuarios) + (SELECT count(*) FROM tareas);")
[ "$RESTO" = "0" ] && pasa "4. ni un usuario ni una tarea sobrevivieron al ROLLBACK" \
                   || falla "4. quedaron $RESTO filas: la verificación no hizo ROLLBACK"

echo ""
echo "── 5. Sesión, hash y ROI ─────────────────────────────────────────────"
if node tasks/usuarios-y-tareas/_verificacion-sesion.mjs >/tmp/e2e-sesion.log 2>&1; then
  pasa "5. las 16 afirmaciones de _verificacion-sesion.mjs"
else
  falla "5. _verificacion-sesion.mjs salió distinto de 0"
  grep 'FALLA' /tmp/e2e-sesion.log || true
fi

echo ""
echo "── 6. El seed, dos veces ─────────────────────────────────────────────"
# Los pasos 6 a 9 necesitan `scripts/seed-usuarios.ts`, que escribe T01. Sin él, se
# saltean con N/A y NO con PASA.
#
# POR QUÉ ESTA GUARDA EXISTE: la primera versión de este script corrió sin el seed y
# los sub-pasos 6b y 6c dieron PASA, porque comparaban dos strings vacíos y contaban
# 0 filas en una tabla vacía. Un PASA sin que nada haya corrido es peor que un FALLA:
# es la única clase de error que un reporte en verde no puede mostrar.
export DATABASE_URL="$SCRATCH"
if [ ! -f scripts/seed-usuarios.ts ]; then
  echo "N/A    6 a 9. falta scripts/seed-usuarios.ts (lo escribe T01). Sin él, estos"
  echo "       cuatro pasos no se pueden verificar y NO se marcan como PASA."
  echo ""
  echo "══════════════════════════════════════════════════════════════════════"
  if [ "$fallas" = "0" ]; then
    echo "Pasos 0 a 5 EN VERDE. Los 6 a 9 quedan pendientes de T01."
    exit 0
  fi
  echo "$fallas PASOS EN FALLA en los primeros 5"
  exit 1
fi

npm run --silent usuarios:seed -- nahuel:Nahuel >/tmp/e2e-seed1.log 2>&1 \
  || { falla "6. el seed falló: $(tail -2 /tmp/e2e-seed1.log)"; }
HASH_ANTES=$(psql "$SCRATCH" -tAc "SELECT clave_hash FROM usuarios WHERE usuario='lucho';")
# Si el hash está vacío el seed no escribió nada, y comparar dos vacíos daría PASA.
[ -n "$HASH_ANTES" ] || falla "6. el seed no dejó ninguna fila para 'lucho'"
npm run --silent usuarios:seed -- nahuel:Nahuel >/tmp/e2e-seed2.log 2>&1 || true
HASH_DESPUES=$(psql "$SCRATCH" -tAc "SELECT clave_hash FROM usuarios WHERE usuario='lucho';")
ESTADO=$(psql "$SCRATCH" -tAc "SELECT usuario||'|'||es_admin||'|'||debe_cambiar_clave||'|'||activo FROM usuarios ORDER BY id;" | paste -sd, -)
[ "$ESTADO" = "lucho|t|t|t,nahuel|f|t|t" ] \
  && pasa "6a. el seed dejó exactamente: lucho|t|t|t y nahuel|f|t|t" \
  || falla "6a. quedó '$ESTADO'"
# LO QUE MÁS CARO SALE SI ESTÁ MAL: el deploy corre el seed en cada push. Si no es
# idempotente, cada deploy le devuelve la clave 123456 a quien ya la cambió, y
# nadie se entera hasta que alguien no puede entrar con la suya.
[ -n "$HASH_ANTES" ] && [ "$HASH_ANTES" = "$HASH_DESPUES" ] \
  && pasa "6b. la segunda corrida NO le tocó la clave a nadie" \
  || falla "6b. el seed reescribió el hash (o no escribió ninguno): cada deploy resetea las claves"
SECCIONES=$(psql "$SCRATCH" -tAc "SELECT count(*) FROM usuario_secciones;")
USUARIOS=$(psql "$SCRATCH" -tAc "SELECT count(*) FROM usuarios;")
[ "$USUARIOS" = "2" ] && [ "$SECCIONES" = "0" ] \
  && pasa "6c. ninguna sección otorgada (el admin no necesita filas, D11)" \
  || falla "6c. $USUARIOS usuarios (esperaba 2) y $SECCIONES secciones (esperaba 0)"

echo ""
echo "── 7. El admin de la otra instancia sale del env ─────────────────────"
PANEL_ADMIN_USUARIO=ivan PANEL_ADMIN_NOMBRE=Ivan \
  npm run --silent usuarios:seed >/tmp/e2e-seed3.log 2>&1 || true
IVAN=$(psql "$SCRATCH" -tAc "SELECT es_admin FROM usuarios WHERE usuario='ivan';")
LUCHO=$(psql "$SCRATCH" -tAc "SELECT count(*) FROM usuarios WHERE usuario='lucho';")
[ "$IVAN" = "t" ] && [ "$LUCHO" = "1" ] \
  && pasa "7. 'ivan' creado como admin sin tocar a 'lucho'" \
  || falla "7. ivan='$IVAN' y lucho existe='$LUCHO'"

echo ""
echo "── 8. El permiso, a nivel de datos ───────────────────────────────────"
psql "$SCRATCH" -qc "
  INSERT INTO usuario_secciones (usuario_id, seccion)
  SELECT id, s FROM usuarios, unnest(ARRAY['resumen','finanzas','tareas']) s
   WHERE usuario='nahuel';"
NAH=$(psql "$SCRATCH" -tAc "
  SELECT string_agg(seccion, ',' ORDER BY seccion) FROM usuario_secciones s
    JOIN usuarios u ON u.id=s.usuario_id WHERE u.usuario='nahuel';")
[ "$NAH" = "finanzas,resumen,tareas" ] \
  && pasa "8a. nahuel tiene exactamente finanzas, resumen y tareas" \
  || falla "8a. tiene '$NAH'"
# La consulta que corre en CADA pantalla del panel (T01 §5). El LEFT JOIN importa:
# con un JOIN a secas, un usuario sin secciones DESAPARECE y el login lo trata como
# inexistente en vez de mandarlo a /sin-acceso.
SIN=$(psql "$SCRATCH" -tAc "
  SELECT count(*) FROM usuarios u
    LEFT JOIN usuario_secciones s ON s.usuario_id = u.id
   WHERE u.usuario='ivan' AND u.activo GROUP BY u.id;")
[ "$SIN" = "1" ] \
  && pasa "8b. un usuario SIN secciones sigue devolviendo su fila (LEFT JOIN)" \
  || falla "8b. devolvió '$SIN': con un JOIN a secas el usuario desaparece"

echo ""
echo "── 9. El barrido del cron ────────────────────────────────────────────"
psql "$SCRATCH" -qc "
  INSERT INTO tareas (titulo, asignado_a, columna, hecha_at)
  SELECT 'vieja', id, 'hecho', now() - interval '3 days' FROM usuarios WHERE usuario='nahuel';
  INSERT INTO tareas (titulo, asignado_a, columna, hecha_at)
  SELECT 'reciente', id, 'hecho', now() FROM usuarios WHERE usuario='nahuel';
  INSERT INTO tareas (titulo, asignado_a)
  SELECT 'en curso', id FROM usuarios WHERE usuario='nahuel';"
BARRE=$(psql "$SCRATCH" -tAc "
  SELECT count(*) FROM tareas
   WHERE archivada_at IS NULL AND hecha_at IS NOT NULL
     AND hecha_at < now() - make_interval(days => 2);")
[ "$BARRE" = "1" ] \
  && pasa "9. el barrido de 2 días toma 1 de las 3 tarjetas (la de 3 días)" \
  || falla "9. tomaría $BARRE tarjetas, esperaba 1"

echo ""
echo "══════════════════════════════════════════════════════════════════════"
if [ "$fallas" = "0" ]; then
  echo "TODO EN VERDE — 9 pasos"
  echo ""
  echo "Lo que este script NO verificó y hay que hacer a mano:"
  echo "  · los redirects de las pantallas sin permiso   → T03 §7 pasos 3 y 4"
  echo "  · los 403 de las API con una cookie de verdad   → T03 §7 pasos 5 a 7"
  echo "  · que nahuel no pueda editar una tarea ajena    → T05 §7 paso 3"
  echo "  · el drag & drop y su rollback optimista        → T06 §7 pasos 3 y 5"
  exit 0
else
  echo "$fallas PASOS EN FALLA"
  exit 1
fi
