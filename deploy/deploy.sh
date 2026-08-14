#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# deploy.sh — build + activación de una release nueva del panel (task T12 §B).
#
#   /srv/panel/repo/deploy/deploy.sh
#
# El código sale de git, igual que en los funnels: /srv/panel/repo es un clon
# de github.com/drasticcurl/dashboard-admin y el paso 1 lo lleva a
# origin/$DEPLOY_BRANCH antes de armar la release. Así el server sabe por
# commit qué está sirviendo y un rollback se puede reproducir.
#
# Hasta 2026-08 este panel se subía con rsync y no había git acá. Ese modo
# sigue disponible para un bring-up (o si GitHub está caído):
#
#   DEPLOY_SOURCE=local sudo -u deploy bash /srv/panel/repo/deploy/deploy.sh
#
# pero NO es el modo de régimen: con `local` el script usa lo que haya en el
# directorio, sin saber de qué commit viene.
#
# Layout que asume:
#   /srv/panel/repo                     ← clon de git (o rsync con DEPLOY_SOURCE=local)
#   /srv/panel/shared/.env.production   ← secretos de la app (chmod 600)
#   /srv/panel/releases/<timestamp>/    ← releases
#   /srv/panel/current                  ← symlink → <release>/.next/standalone
#
# Garantías (las mismas que el deploy.sh de los funnels):
#   - Un solo deploy a la vez (flock).
#   - Si el build, los tests o la migración fallan, `current` no se toca y la
#     release a medio hacer se borra.
#   - Si el panel no contesta 200/307 después del reload, vuelve solo a la
#     release anterior.
# ══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ┌───────────────────────────────────────────────────────────────────────────┐
# │ ESTE SCRIPT SE CORRE COMO EL USUARIO `deploy`, NUNCA COMO root.            │
# └───────────────────────────────────────────────────────────────────────────┘
#   sudo -u deploy bash /srv/panel/repo/deploy/deploy.sh
#
# Correrlo como root parece funcionar y rompe producción de tres formas a la vez,
# todas silenciosas. Pasó el 2026-08-13 y costó una caída:
#
#   1. `pm2` es POR USUARIO. root tiene su propio daemon, así que el
#      `pm2 startOrReload` de más abajo crea un panel-3005 nuevo en el pm2 de
#      root en lugar de recargar el que está sirviendo (el de `deploy`).
#      Resultado: el proceso viejo sigue con el CÓDIGO VIEJO y con el puerto
#      3005 tomado, y el nuevo entra en ciclo de reinicios sin poder bindear.
#      El health check pasa igual, porque el que contesta es el viejo, así que
#      el deploy dice OK y no desplegó nada.
#   2. `install -m 600 .env.production` queda root:root. El panel lo lee para
#      sacar DATABASE_URL (Next carga .env.production del cwd) y el worker con
#      `--env-file`: como `deploy` no puede leerlo, el panel se queda SIN BASE y
#      el worker loguea `node: .env.production: not found` en loop.
#   3. El árbol de la release queda con el uid del rsync (root, o peor, el uid
#      de la máquina de desarrollo).
#
# El guard es una línea y evita las tres.
if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  echo "ERROR: no corras deploy.sh como root." >&2
  echo "       pm2 es por usuario y .env.production queda ilegible para deploy." >&2
  echo "       Usá:  sudo -u deploy bash $0" >&2
  exit 1
fi

if [[ "$(id -un)" != "deploy" ]]; then
  echo "ADVERTENCIA: deploy.sh corriendo como '$(id -un)' y no como 'deploy'." >&2
  echo "             pm2 es por usuario: los procesos van a quedar en el daemon" >&2
  echo "             de '$(id -un)' y el panel que sirve hoy no se va a recargar." >&2
  echo "             Cancelá con Ctrl-C en los próximos 10 s si no era a propósito." >&2
  sleep 10
fi

BASE="/srv/panel"
REPO="$BASE/repo"
SHARED="$BASE/shared"
RELEASES="$BASE/releases"
ECOSYSTEM="$REPO/deploy/ecosystem.config.js"
STAMP="$(date +%Y%m%d%H%M%S)"
RELEASE="$RELEASES/$STAMP"
LOG="$BASE/deploy.log"
KEEP=5

ACTIVATED=0

# `|| true`: si deploy.log no es escribible, el deploy NO se cae por no poder
# loguear (con pipefail, un tee que falla aborta el script entero).
log() { printf '[%s] %s\n' "$(date -Is)" "$*" | tee -a "$LOG" || true; }
fail() { log "ERROR: $*"; exit 1; }

# Una release a medio construir (npm ci / build / test caídos) rompería un
# futuro rollback, que elegiría ese directorio como "release anterior".
on_exit() {
  local rc=$?
  if ((ACTIVATED == 0)) && [[ -d "$RELEASE" ]]; then
    rm -rf "$RELEASE"
    log "release $STAMP descartada (no llegó a activarse)"
  fi
  exit "$rc"
}
trap on_exit EXIT

[[ -d "$BASE" ]] || { echo "no existe $BASE — ¿seguiste docs/runbook.md §1?" >&2; exit 1; }
[[ -f "$REPO/package.json" ]] || fail "no hay package.json en $REPO — ¿el clon de git existe?"
[[ -f "$SHARED/.env.production" ]] || fail "falta $SHARED/.env.production"

# ─── Un build a la vez: el server también está sirviendo el panel ──────────
exec 9>"$BASE/.deploy.lock"
flock -n 9 || fail "ya hay un deploy corriendo para el panel"

# ─── 0. Traer el código ─────────────────────────────────────────────────────
# Mismo switch que el deploy.sh de los funnels, para que los tres proyectos se
# operen igual:
#
#   git   (default) — fetch + reset --hard a origin/$DEPLOY_BRANCH.
#   local           — usa tal cual lo que haya en $REPO (rsync). Bring-up.
#
# El fetch va DESPUÉS del flock: dos deploys simultáneos escribiendo el mismo
# working tree dejarían la release a medio camino entre dos commits.
#
# `reset --hard` descarta cualquier cambio hecho a mano en $REPO. Es a
# propósito: el repo del server no es un workspace. Si hace falta un parche de
# urgencia, va por commit.
SOURCE="${DEPLOY_SOURCE:-git}"
case "$SOURCE" in
  git)
    [[ -d "$REPO/.git" ]] || fail "$REPO no es un clon de git (¿querías DEPLOY_SOURCE=local?)"
    BRANCH="${DEPLOY_BRANCH:-main}"
    git -C "$REPO" fetch --all --prune
    git -C "$REPO" rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1 \
      || fail "no existe origin/$BRANCH en $REPO"
    git -C "$REPO" reset --hard "origin/$BRANCH"
    COMMIT="$(git -C "$REPO" rev-parse --short HEAD)"
    log "release $STAMP ← $BRANCH @ $COMMIT"
    ;;
  local)
    COMMIT="rsync"
    log "release $STAMP ← $REPO (rsync, sin git)"
    ;;
  *)
    fail "DEPLOY_SOURCE inválido: '$SOURCE' (esperado: git | local)"
    ;;
esac

mkdir -p "$RELEASE"

# ─── 1. Código: copia local (repo → release) ──────────────────────────────
# Excludes:
#   node_modules / .next → npm ci y el build los regeneran (y un node_modules
#     de otra arquitectura rompe los binarios nativos).
#   .git / tasks/        → documentos de desarrollo; no van a producción.
#   redesign-ui-tasks/   → idem: entró al repo cuando el panel pasó a git y no
#                          tiene nada que hacer en una release.
#   .env, .env.*         → los secretos de dev NO van al server: el único env
#                          de producción es shared/.env.production (paso 2).
#   ._* / .DS_Store      → AppleDouble y basura de Finder de los rsync hechos
#                          desde una Mac.
rsync -a --delete \
  --exclude='node_modules' --exclude='.next' --exclude='.git' \
  --exclude='tasks' --exclude='redesign-ui-tasks' \
  --exclude='.env' --exclude='.env.*' \
  --exclude='._*' --exclude='.DS_Store' \
  "$REPO/" "$RELEASE/"
cd "$RELEASE"

# ─── 2. Secretos ────────────────────────────────────────────────────────────
install -m 600 "$SHARED/.env.production" "$RELEASE/.env.production"

# ─── 3. Guard de env vars requeridas ────────────────────────────────────────
# Sin estas, el panel compila pero sale roto en producción (login abierto,
# webhooks que rechazan todo por falta de secrets, base inalcanzable).
# POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB NO están acá: eran del
# docker-compose. En la VPS no hay Docker (habría metido sus reglas de iptables
# por delante de ufw, y el modelo de este server es "solo Cloudflare llega al
# 80/443"), así que Postgres es el paquete de Ubuntu y la única interfaz con la
# base es DATABASE_URL. Exigir vars que nada lee es cómo se llega a un deploy
# que falla por una variable muerta: ver P-04 y P-12 del plan.
REQUIRED=(
  DATABASE_URL
  DASHBOARD_PASSWORD
  NEXT_PUBLIC_SITE_URL
  SHOPIFY_WEBHOOK_SECRETS
  # El token de la Marketing API (T13). Sin él el worker de reglas falla en cada
  # tick con un error de credenciales, y antes este guard lo dejaba pasar.
  META_ADS_TOKEN
)
MISSING=()
for var in "${REQUIRED[@]}"; do
  # Exige al menos un caracter que no sea comilla ni espacio después del `=`,
  # así `VAR=`, `VAR=""` y `VAR='  '` también cuentan como faltantes.
  grep -Eq "^${var}=[[:space:]]*[\"']?[^\"'[:space:]]" "$RELEASE/.env.production" \
    || MISSING+=("$var")
done
if ((${#MISSING[@]})); then
  log "env vars faltantes o vacías: ${MISSING[*]}"
  fail "abortado antes del build (${#MISSING[@]} vars)"
fi

# SUPABASE_URL_*/SUPABASE_SERVICE_KEY_* NO van en REQUIRED a propósito: son
# las credenciales de los leads (T09), opcionales — sin ellas el panel anda y
# la sección muestra "no configurado".
log "env vars requeridas: OK (${#REQUIRED[@]} presentes)"

# Se extrae una sola vez y temprano: la usan los tests (paso 4) y la migración
# (paso 6). No se exporta al environment general para no dejar la credencial
# colgada durante `npm ci` y el build, que corren código de terceros.
DB_URL="$(grep -E '^DATABASE_URL=' "$SHARED/.env.production" | head -n1 | cut -d= -f2- | tr -d '"'\''[:space:]')"
[[ -n "$DB_URL" ]] || fail "no pude leer DATABASE_URL de $SHARED/.env.production"

# ─── 4. Build + tests ───────────────────────────────────────────────────────
# `npm ci` SIN --omit=dev, como en los funnels: los scripts de cron corren
# con tsx (P-18), que es una devDependency declarada por T01 y no se puede
# mover a dependencies (está fuera del alcance de T12). El standalone linkea
# el node_modules completo de la release (paso 5) para que tsx exista ahí.
export NODE_OPTIONS="--max-old-space-size=2048"
npm ci --no-audit --no-fund
npm run build
# Los tests corren contra `panel_test`, NUNCA contra la base de producción.
#
# Sin DATABASE_URL, los 70 tests que tocan la base se saltean y el deploy queda
# habilitado por 65 tests de funciones puras. Pero apuntarlos a la base real es
# peor que no correrlos: los de ingest y de órdenes INSERTAN sesiones y ventas,
# así que cada deploy contaminaría las métricas con datos de prueba y nadie lo
# vería hasta que los números no cerraran contra Shopify.
#
# La base de test se migra acá mismo antes de correrlos: es el mismo schema, así
# que si una migración rompe los tests, el deploy se cae ANTES de tocar
# producción.
TEST_DB_URL="${DB_URL%/*}/panel_test"
DATABASE_URL="$TEST_DB_URL" npm run db:migrate
DATABASE_URL="$TEST_DB_URL" npm test

# ─── 5. Completar el standalone ─────────────────────────────────────────────
# Next NO copia public/ ni .next/static/ dentro de .next/standalone/.
# Sin estos dos cp el sitio sale sin CSS y sin imágenes.
STANDALONE="$RELEASE/.next/standalone"
[[ -f "$STANDALONE/server.js" ]] || fail "no se generó .next/standalone (¿falta output:'standalone'?)"
mkdir -p "$STANDALONE/public" "$STANDALONE/.next/static"
# El `if` no es cosmético: este proyecto no tiene public/ (es un panel interno,
# sin assets estáticos) y un `cp` de un directorio inexistente aborta el deploy
# con set -e después de haber corrido build y tests. Los funnels sí lo tienen,
# de ahí venía la línea.
if [ -d "$RELEASE/public" ]; then
  cp -a "$RELEASE/public/." "$STANDALONE/public/"
fi
cp -a "$RELEASE/.next/static/." "$STANDALONE/.next/static/"
install -m 600 "$SHARED/.env.production" "$STANDALONE/.env.production"

# Los scripts de cron (fetch-fx, rollup, ensure-partitions) corren desde
# `current`, que apunta al standalone: los fuentes TS y sus libs van adentro.
# El node_modules que trae el standalone es solo prod (Next lo poda) y no
# tiene tsx: se linkea el de la release completa en su lugar.
cp -a "$RELEASE/scripts" "$STANDALONE/scripts"
cp -a "$RELEASE/lib" "$STANDALONE/lib"
rm -rf "$STANDALONE/node_modules"
ln -s ../../node_modules "$STANDALONE/node_modules"
log "standalone completo (public + .next/static + scripts + lib + .env.production)"

# ─── 6. Migración — ANTES de activar ────────────────────────────────────────
# Si la migración falla, `current` sigue apuntando a la release anterior y el
# panel sigue sirviendo con el schema que ya conoce: una migración rota nunca
# deja el panel caído ni a medio schema.
#
# El worker de reglas se PARA antes de migrar y se levanta recién después del
# health check (paso 8). Si sigue corriendo mientras la migración aplica y el
# symlink se mueve, un tick puede quedar a mitad de camino entre dos schemas o
# ejecutando código viejo contra una release nueva. En el primer deploy el
# proceso todavía no existe, así que el error se ignora.
pm2 stop panel-reglas >/dev/null 2>&1 || true

# `npm run db:migrate` corre con tsx, que NO lee .env.production (P-18): se
# exporta solo DATABASE_URL para esta línea, sin abrirle el resto de secretos
# al environment del build.
DATABASE_URL="$DB_URL" npm run db:migrate

# ─── 6b. El token de ads puede escribir (T13 §8) ─────────────────────────────
# Después de migrar y antes de activar. Sale con 1 si el token no puede escribir,
# así que el deploy se detiene acá en lugar de dejar un worker que va a fallar
# en cada tick. `tsx` no lee .env.production solo: se inyecta con --env-file,
# igual que el cron; un `npm run ads:token` pelado corre sin META_ADS_TOKEN y
# falla siempre por la variable vacía y no por el permiso.
if ! ( cd "$RELEASE" && /usr/bin/node --env-file=.env.production ./node_modules/.bin/tsx \
       scripts/verificar-token-ads.ts ); then
  fail "el token de ads no puede escribir (npm run ads:token falló) — el worker NO se levantó"
fi

# ─── 7. Activar ─────────────────────────────────────────────────────────────
# `readlink -e` (no -f): -f imprime el path y sale 0 aunque el último componente
# no exista, así que en el primer deploy PREVIOUS quedaría igual a
# "$BASE/current" y un rollback armaría un symlink apuntándose a sí mismo.
PREVIOUS="$(readlink -e "$BASE/current" 2>/dev/null || true)"

# El swap tiene que ser atómico: `ln -sfn` sobre un symlink existente hace
# unlink + symlink, y en esa ventana `current` no existe. `mv -T` es un solo
# rename(2), no hay ventana.
ln -sfn "$STANDALONE" "$BASE/current.tmp"
mv -Tf "$BASE/current.tmp" "$BASE/current"
ACTIVATED=1
log "current → $STANDALONE"

rollback_to_previous() {
  if [[ -n "$PREVIOUS" && -f "$PREVIOUS/server.js" ]]; then
    ln -sfn "$PREVIOUS" "$BASE/current.tmp"
    mv -Tf "$BASE/current.tmp" "$BASE/current"
    pm2 reload panel-3005 --update-env || true
    # El worker NO se levanta en un rollback, y eso es lo correcto, no un efecto
    # colateral: es el proceso que puede gastar plata, y ante un deploy dudoso el
    # lado seguro es que no corra. Revertir la app y dejar el worker corriendo
    # código nuevo contra la release vieja sería peor que no tener rollback.
    pm2 stop panel-reglas >/dev/null 2>&1 || true
    log "revertido a $PREVIOUS (panel-reglas detenido)"
  else
    log "sin release anterior válida para revertir (¿primer deploy?)"
  fi
}

# ─── 8. Reload + health check ───────────────────────────────────────────────
# En el primer deploy la app todavía no existe en PM2: `reload` fallaría.
if pm2 describe panel-3005 >/dev/null 2>&1; then
  pm2 reload panel-3005 --update-env || {
    rollback_to_previous
    fail "pm2 reload falló"
  }
else
  log "panel-3005 no existe en PM2 — primer arranque"
  # --only panel-3005: el worker (panel-reglas) se levanta SOLO después del
  # health check. Arrancar el ecosystem entero acá pondría el worker a correr
  # antes de saber si la release está sana.
  pm2 start "$ECOSYSTEM" --only panel-3005 || {
    rollback_to_previous
    fail "pm2 start falló"
  }
fi

ok=0
for _ in $(seq 1 20); do
  sleep 2
  code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3005/ || true)"
  # 200 = página de login; 307 = redirect del middleware con cookie válida.
  # Las dos significan "el server está vivo".
  [[ "$code" == "200" || "$code" == "307" ]] && { ok=1; break; }
done
if ((!ok)); then
  log "el panel no respondió 200/307 en / (último código: ${code:-sin respuesta})"
  rollback_to_previous
  fail "deploy revertido"
fi

# ─── 8b. El worker recién ahora, con la release activada y sana ──────────────
# `startOrReload` y no `reload`: `pm2 reload panel-reglas` FALLA si el proceso
# no existe, y en el primer deploy no existe — el deploy se caería en el último
# paso por algo que no tiene nada que ver con el código. `--update-env` para que
# un cambio en .env.production tome efecto. Y arranca apagado (ads_rules_enabled
# nace en false): levanta, loguea que está apagado y no toca Meta hasta que
# alguien lo prende desde el panel.
pm2 startOrReload "$ECOSYSTEM" --only panel-reglas --update-env

pm2 save --force >/dev/null
log "panel arriba (${code} en /)"

# ─── 9. Poda: deja las 5 releases más nuevas ────────────────────────────────
# Nunca borrar la release que está sirviendo: después de un rollback a una
# release vieja, esa release es de las más antiguas por mtime y entraría en
# la lista de borrado.
LIVE_RELEASE=""
live="$(readlink -e "$BASE/current" 2>/dev/null || true)"
[[ -n "$live" ]] && LIVE_RELEASE="${live%/.next/standalone}"

while read -r dir; do
  dir="${dir%/}"
  [[ -z "$dir" || "$dir" == "$LIVE_RELEASE" ]] && continue
  rm -rf "$dir"
  log "release podada: $(basename "$dir")"
done < <(ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n +$((KEEP + 1)) || true)

log "deploy OK — release $STAMP"
