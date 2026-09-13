#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# setear-openai-key-remoto.sh — CORRE EN TU MÁQUINA (no en la VPS).
#
#   bash scripts/setear-openai-key-remoto.sh
#
# Hace por SSH todo lo que hoy hay que hacer a mano para que el análisis con IA
# quede funcionando en hilvanapp:
#
#   1. Te pide la OPENAI_API_KEY acá, con el eco apagado.
#   2. Sube `scripts/setear-openai-key.sh` a un temporal de la VPS y lo corre
#      pasándole la key por STDIN. Ese script escribe
#      /srv/panel/shared/.env.production (OPENAI_API_KEY + OPENAI_MODEL=gpt-5.6-luna).
#   3. Copia shared/.env.production dentro de la release que está sirviendo y
#      recarga PM2, así la feature se prende AHORA sin esperar un deploy.
#   4. Opcional (te pregunta): corre scripts/generar-insights.ts contra la
#      release viva para comprobar que la key y el modelo funcionan de verdad.
#
# POR QUÉ EL PASO 3 EXISTE. `shared/.env.production` es la fuente de verdad y
# sobrevive a los deploys, pero NO es el archivo que lee el panel: deploy.sh lo
# copia con `install -m 600` dentro de `<release>/.next/standalone/` (paso 5), y
# `current` apunta ahí. El proceso de PM2 y el cron leen ESA copia
# (`cwd: /srv/panel/current` en ecosystem.config.js; `node --env-file=.env.production`
# en cron.panel). Editar solo `shared` deja la key invisible hasta el próximo
# deploy: un `pm2 reload --update-env` a secas relee un archivo que sigue viejo.
#
# POR QUÉ SUBE EL SCRIPT EN VEZ DE LLAMAR AL DEL REPO. `setear-openai-key.sh`
# está en la rama `feat/openai-key-script`, no en `main`, y el deploy hace
# `git reset --hard origin/main`: hoy /srv/panel/repo/scripts/ NO lo tiene.
# Subirlo desde el working tree local hace que esto funcione con la rama
# mergeada o sin mergear, y borra el temporal al salir.
#
# LA KEY NUNCA VA COMO ARGUMENTO, ni acá ni en el comando remoto: viaja por el
# stdin del ssh. Así no queda en `~/.bash_history` local, ni en el `ps` de la
# VPS, ni en los logs de auth de sshd (que registran el comando ejecutado).
#
# NO TOCA INFINIX. Todo apunta a /srv/panel. Por la regla de instancias
# (.kiro/steering/instancias.md), /srv/panel-infinix queda sin OPENAI_API_KEY y
# por lo tanto sin la feature, byte-idéntico a como estaba.
#
# Flags:
#   --sin-prueba   no corre el análisis de verificación (que es una llamada paga)
#   VPS_HOST=otro  usa otro alias de ssh (default: funnel-vps, usuario deploy)
# ══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

HOST="${VPS_HOST:-funnel-vps}"
BASE_REMOTA="/srv/panel"
PROCESO_PM2="panel-3005"
PROBAR=1

for arg in "$@"; do
  case "$arg" in
    --sin-prueba) PROBAR=0 ;;
    -h | --help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *)
      echo "ERROR: argumento desconocido: $arg (¿querías --sin-prueba?)" >&2
      exit 2
      ;;
  esac
done

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

# ─── Guards locales ─────────────────────────────────────────────────────────
# Si esto se corre POR ERROR dentro de la VPS, el ssh a funnel-vps saldría de la
# máquina y volvería a entrar, o fallaría por falta de clave. Mejor decirlo.
if [[ -d "$BASE_REMOTA/shared" ]]; then
  fail "parece que estás DENTRO de la VPS ($BASE_REMOTA existe).
       Acá corré directamente: bash scripts/setear-openai-key.sh"
fi

DIR_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_LOCAL="$DIR_SCRIPT/setear-openai-key.sh"
[[ -f "$SCRIPT_LOCAL" ]] || fail "no encontré $SCRIPT_LOCAL (¿estás en el repo del panel?)"

command -v ssh >/dev/null || fail "no tengo ssh en el PATH"

echo "Instancia: hilvanapp · host ssh: $HOST · base: $BASE_REMOTA"
echo -n "Probando la conexión… "
# BatchMode: si la clave no está, falla en 5 s en vez de quedarse pidiendo una
# contraseña que en esa VPS está deshabilitada igual.
ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" true 2>/dev/null ||
  fail "no pude entrar a $HOST por ssh.
       Probá 'ssh $HOST true' a mano: falta la clave en el agente o el alias en ~/.ssh/config."
echo "OK"

# ─── Paso 0: ¿el shared ya difiere de lo que está sirviendo? ────────────────
# El paso 3 copia shared/.env.production sobre la release viva. Si alguien tocó
# shared después del último deploy, esa copia arrastra TAMBIÉN esos cambios a
# producción, que es un efecto que nadie pidió acá. Se comparan las dos y se
# listan solo los NOMBRES de las claves que difieren — nunca los valores.
echo -n "Comparando shared vs. la release viva… "
DERIVA="$(
  ssh -o BatchMode=yes "$HOST" bash -s <<'REMOTO' || true
set -uo pipefail
SHARED=/srv/panel/shared/.env.production
VIVO=/srv/panel/current/.env.production
[[ -f "$SHARED" ]] || { echo "__SIN_SHARED__"; exit 0; }
[[ -f "$VIVO" ]]   || { echo "__SIN_VIVO__";   exit 0; }
# `s/=.*//` corta el valor antes de imprimir: de este pipe sale una lista de
# nombres de variables, jamás un secreto.
diff <(sort "$SHARED") <(sort "$VIVO") 2>/dev/null |
  grep -E '^[<>] ' |
  sed -E 's/^[<>] //; s/=.*//' |
  grep -E '^[A-Za-z_][A-Za-z0-9_]*$' |
  grep -vE '^OPENAI_(API_KEY|MODEL)$' |
  sort -u
REMOTO
)"
echo "OK"

ACTIVAR=1
case "$DERIVA" in
  *__SIN_SHARED__*)
    fail "no existe $BASE_REMOTA/shared/.env.production en $HOST. ¿Es la VPS correcta?"
    ;;
  *__SIN_VIVO__*)
    echo
    echo "AVISO: no encontré $BASE_REMOTA/current/.env.production (¿nunca se deployó?)."
    echo "       Se va a escribir shared igual, pero la activación queda para un deploy."
    ACTIVAR=0
    ;;
esac

if [[ -n "$DERIVA" && "$ACTIVAR" -eq 1 ]]; then
  echo
  echo "ATENCIÓN: shared/.env.production ya difiere de la release que está sirviendo"
  echo "          en estas variables (nombres, no valores):"
  printf '            %s\n' $DERIVA
  echo
  echo "  Copiar shared sobre la release viva también aplicaría esos cambios."
  read -rp "  ¿Copiar igual y recargar? (s/N): " OK_DERIVA
  if [[ ! "$OK_DERIVA" =~ ^[sS]$ ]]; then
    ACTIVAR=0
    echo "  OK: se escribe shared y NO se toca la release. Activá con un deploy normal."
  fi
fi

# ─── Paso 1: pedir la key ───────────────────────────────────────────────────
echo
read -rsp "Pegá la OPENAI_API_KEY (no se muestra): " KEY
echo
[[ -n "$KEY" ]] || fail "no pegaste nada, no se tocó nada."

# Las keys de OpenAI no tienen espacios: sacar todo blanco evita el clásico
# salto de línea o espacio invisible pegado desde el navegador, que viajaría al
# archivo y haría fallar la auth con un 401 imposible de ver a ojo.
KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"

# El script remoto, si la key no arranca con "sk-", pregunta si seguir leyendo de
# STDIN. Como acá el STDIN remoto es un pipe, ese prompt vería EOF y cancelaría.
# Se resuelve preguntando ACÁ y, si el usuario confirma, mandando la "s" que el
# remoto va a pedir en la segunda línea.
ENTRADA_REMOTA="$KEY"
if [[ ! "$KEY" =~ ^sk- ]]; then
  echo "ADVERTENCIA: las keys de OpenAI arrancan con 'sk-'. Esto no tiene esa forma." >&2
  read -rp "¿Seguir igual? (s/N): " CONFIRMAR
  [[ "$CONFIRMAR" =~ ^[sS]$ ]] || fail "cancelado, no se tocó nada."
  ENTRADA_REMOTA="$KEY
s"
fi

# ─── Paso 2: subir y correr el script que escribe shared ────────────────────
TMP_REMOTO="$(ssh -o BatchMode=yes "$HOST" 'mktemp /tmp/setear-openai-key.XXXXXX.sh')"
[[ -n "$TMP_REMOTO" ]] || fail "no pude crear el temporal en $HOST"
limpiar() { ssh -o BatchMode=yes "$HOST" "rm -f -- '$TMP_REMOTO'" >/dev/null 2>&1 || true; }
trap limpiar EXIT

ssh -o BatchMode=yes "$HOST" "cat > '$TMP_REMOTO'" < "$SCRIPT_LOCAL"

echo
echo "── En la VPS ──────────────────────────────────────────────────────────"
printf '%s\n' "$ENTRADA_REMOTA" | ssh -o BatchMode=yes "$HOST" "bash '$TMP_REMOTO'" ||
  fail "el script remoto falló. shared/.env.production NO fue modificado (escribe con mv atómico)."
unset KEY ENTRADA_REMOTA
echo "───────────────────────────────────────────────────────────────────────"

# ─── Paso 3: activar en la release viva ─────────────────────────────────────
if [[ "$ACTIVAR" -eq 1 ]]; then
  echo
  # Heredoc en comillas ('REMOTO') y los datos por argumentos: así no hay una
  # sola expansión local dentro del bloque remoto, que es de donde salen los
  # errores de quoting difíciles de ver en scripts que se ejecutan por ssh.
  ssh -o BatchMode=yes "$HOST" bash -s -- "$BASE_REMOTA" "$PROCESO_PM2" <<'REMOTO' || fail "no pude activar la key en la release viva. shared quedó bien: corré un deploy normal."
set -euo pipefail
# ssh no interactivo entra con un PATH mínimo: pm2 y node se resuelven a mano.
export PATH="/usr/bin:/usr/local/bin:$PATH"

BASE="$1"
PROCESO="$2"
SHARED="$BASE/shared/.env.production"

[[ -L "$BASE/current" ]] || { echo "ERROR: $BASE/current no es un symlink a una release" >&2; exit 1; }

# Lo mismo que hace deploy.sh paso 5: la copia que el panel lee de verdad.
# El destino pasa por el symlink 'current' y cae dentro de .next/standalone/.
install -m 600 "$SHARED" "$BASE/current/.env.production"
echo "env instalado en $(readlink -f "$BASE/current")/.env.production"

PM2_BIN="$(command -v pm2 || true)"
if [[ -z "$PM2_BIN" ]]; then
  for c in /usr/bin/pm2 /usr/local/bin/pm2 /usr/lib/node_modules/pm2/bin/pm2; do
    [[ -x "$c" ]] && { PM2_BIN="$c"; break; }
  done
fi
[[ -n "$PM2_BIN" ]] || { echo "ERROR: no encontré el binario de pm2" >&2; exit 1; }

# reload y no restart: mismo comando que deploy.sh paso 8. --update-env para que
# el proceso nuevo arranque releyendo el .env.production que acabamos de escribir.
"$PM2_BIN" reload "$PROCESO" --update-env

# Health check igual al del deploy: 200 (login) o 307 (redirect del middleware).
codigo=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 2
  codigo="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3005/ || true)"
  [[ "$codigo" == "200" || "$codigo" == "307" ]] && break
done
[[ "$codigo" == "200" || "$codigo" == "307" ]] ||
  { echo "ERROR: el panel no respondió 200/307 después del reload (último: ${codigo:-sin respuesta})" >&2; exit 1; }
echo "panel arriba ($codigo en /) con la key cargada"
REMOTO
fi

# ─── Paso 4: la prueba de verdad (llamada paga) ─────────────────────────────
if [[ "$PROBAR" -eq 1 && "$ACTIVAR" -eq 1 ]]; then
  echo
  echo "Prueba real: genera el análisis del ámbito 'resumen' sobre la release viva."
  echo "Es UNA llamada paga a OpenAI (y es la única forma de saber si la key sirve y"
  echo "si el modelo gpt-5.6-luna existe en tu cuenta con json_schema strict)."
  read -rp "¿Correrla? (S/n): " OK_PRUEBA
  if [[ ! "$OK_PRUEBA" =~ ^[nN]$ ]]; then
    echo
    echo "── Análisis de prueba ─────────────────────────────────────────────────"
    if ssh -o BatchMode=yes "$HOST" \
      "cd $BASE_REMOTA/current && /usr/bin/node --env-file=.env.production ./node_modules/.bin/tsx scripts/generar-insights.ts --ambito=resumen"; then
      echo "───────────────────────────────────────────────────────────────────────"
      echo "El análisis con IA funciona. En /resumen ya se ve (la pantalla lee la fila"
      echo "de ai_insights, no llama a OpenAI)."
    else
      echo "───────────────────────────────────────────────────────────────────────"
      echo "La key quedó escrita, pero la generación falló. Leé el error de arriba:" >&2
      echo "  · 401                → la key es inválida o de otra organización." >&2
      echo "  · 404 model_not_found → 'gpt-5.6-luna' no existe en tu cuenta. Listá los" >&2
      echo "    IDs reales y cambiá OPENAI_MODEL en shared/.env.production:" >&2
      echo "      ssh $HOST" >&2
      echo "      curl -s https://api.openai.com/v1/models \\" >&2
      echo "        -H \"Authorization: Bearer \\\$OPENAI_API_KEY\" | grep -o '\"id\": \"[^\"]*\"'" >&2
      echo "  · limite_diario      → techo de OPENAI_INSIGHTS_MAX_DIA, no es un error." >&2
      exit 1
    fi
  fi
fi

echo
echo "Listo. Resumen:"
echo "  · $BASE_REMOTA/shared/.env.production: OPENAI_API_KEY + OPENAI_MODEL=gpt-5.6-luna"
if [[ "$ACTIVAR" -eq 1 ]]; then
  echo "  · release viva actualizada y $PROCESO_PM2 recargado: la feature está prendida ahora"
else
  echo "  · release viva SIN tocar: activá con 'sudo -u deploy bash $BASE_REMOTA/repo/deploy/deploy.sh'"
fi
echo "  · el cron de 05:45 ya va a generar los análisis solo (deploy/cron.panel)"
echo "  · infinix (/srv/panel-infinix) no fue tocado: sigue sin la feature"
