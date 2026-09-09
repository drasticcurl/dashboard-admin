#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════════
# setear-openai-key.sh — pega OPENAI_API_KEY en shared/.env.production de
# HILVANAPP y fija OPENAI_MODEL=gpt-5.6-luna, sin tocar el resto del archivo.
#
#   ssh funnel-vps
#   bash /srv/panel/repo/scripts/setear-openai-key.sh
#
# Corré esto logueado como el usuario `deploy` (tu prompt normal en la VPS).
# NO necesita sudo: `deploy` ya es el dueño de shared/.env.production
# (deploy.sh lo instala con `install -m 600` corriendo como `deploy`).
#
# Fijo a propósito, por pedido explícito: esta instancia es hilvanapp
# (/srv/panel/shared/.env.production) y el modelo es gpt-5.6-luna. NO toca
# infinix (/srv/panel-infinix), que hoy no tiene la key y por la regla de
# instancias (instancias.md) queda byte-idéntica si no se declara.
#
# CORRE EN LA VPS, no en tu máquina local: shared/.env.production no está en
# git (vive fuera del repo) y por eso no existe en tu working tree. El deploy
# hace `git reset --hard origin/main` en $REPO y jamás toca $BASE/shared, así
# que esto es seguro de correr sin que un deploy futuro lo revierta.
#
# Qué hace:
#   1. Verifica que /srv/panel/shared/.env.production exista.
#   2. Te pide la key con el eco APAGADO (no queda en pantalla ni en
#      ~/.bash_history, porque nunca se pasa como argumento).
#   3. La valida con un formato mínimo (arranca con "sk-").
#   4. Inserta o reemplaza OPENAI_API_KEY= y OPENAI_MODEL=gpt-5.6-luna en el
#      archivo, dejando el resto intacto.
#   5. Preserva permisos 600 y el dueño del archivo.
#
# La feature se prende sola en el próximo `pm2 reload`/deploy: no hay
# IA_HABILITADA aparte, es la presencia de la key (ver lib/ia/openai.ts).
#
# gpt-5.6-luna: verificá que tu cuenta lo tenga habilitado y que soporte
# response_format=json_schema con strict:true (lo que este módulo necesita).
# Un ID sin soporte o inexistente falla recién al generar, con un error claro
# de la API — no rompe el build ni el deploy.
# ══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# Se corre como el usuario `deploy`, SIN sudo: `deploy.sh` instala
# shared/.env.production con `install -m 600` corriendo como `deploy` (ver
# deploy/deploy.sh paso 2), así que `deploy` ya es el dueño y no necesita
# escalar a root para editarlo. Pedir sudo acá era de más y sólo suma un
# prompt de contraseña que no hace falta.
if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  echo "ADVERTENCIA: corriendo como root. Este script no lo necesita — si el" >&2
  echo "             archivo lo edita root, puede quedar con dueño equivocado" >&2
  echo "             para cuando 'deploy' necesite tocarlo después." >&2
fi

INSTANCIA="hilvanapp"
ENV_FILE="/srv/panel/shared/.env.production"
MODELO_FIJO="gpt-5.6-luna"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: no encontré $ENV_FILE" >&2
  echo "       ¿Estás en funnel-vps? Corré 'sudo bash /srv/estado.sh' para ubicarte." >&2
  exit 1
fi

if [[ ! -w "$ENV_FILE" ]]; then
  echo "ERROR: no tenés permiso de escritura sobre $ENV_FILE" >&2
  echo "       Normalmente es dueño 'deploy'. Corré esto logueado como deploy," >&2
  echo "       o con: sudo -u deploy bash $0" >&2
  exit 1
fi

echo "Instancia: $INSTANCIA"
echo "Archivo:   $ENV_FILE"
echo "Modelo:    $MODELO_FIJO (fijo)"
echo

# ─── Pedir la key sin eco ────────────────────────────────────────────────────
read -rsp "Pegá la OPENAI_API_KEY (no se muestra en pantalla): " OPENAI_KEY
echo
if [[ -z "$OPENAI_KEY" ]]; then
  echo "ERROR: no pegaste nada, no se modificó el archivo." >&2
  exit 1
fi

# Formato mínimo. No valida que la key SIRVA (eso lo dice la primera llamada
# real, con un 401 claro) — solo atrapa el típico "pegué mal / pegué otra cosa".
if [[ ! "$OPENAI_KEY" =~ ^sk- ]]; then
  echo "ADVERTENCIA: las keys de OpenAI arrancan con 'sk-'. Esto no tiene esa forma." >&2
  read -rp "¿Seguir igual? (s/N): " CONFIRMAR
  [[ "$CONFIRMAR" =~ ^[sS]$ ]] || { echo "Cancelado."; exit 1; }
fi

# ─── Escribir, preservando el resto del archivo ─────────────────────────────
DUENIO="$(stat -c '%U:%G' "$ENV_FILE" 2>/dev/null || stat -f '%Su:%Sg' "$ENV_FILE")"
TMP="$(mktemp)"
trap 'rm -f "$TMP" "$TMP.2"' EXIT

set_var() {
  local var="$1" val="$2" archivo_in="$3" archivo_out="$4"
  if grep -Eq "^${var}=" "$archivo_in"; then
    # Reemplaza SOLO la línea existente, preservando el resto del archivo tal
    # cual. Split en el PRIMER '=' nada más: si el valor tuviera un '=' esto no
    # lo corta a la mitad como haría `awk -F=`.
    awk -v var="$var" -v val="$val" '
      {
        eq = index($0, "=")
        clave = (eq > 0) ? substr($0, 1, eq - 1) : $0
        if (clave == var) { print var "=" val; next }
        print
      }
    ' "$archivo_in" > "$archivo_out"
  else
    cp "$archivo_in" "$archivo_out"
    printf '%s=%s\n' "$var" "$val" >> "$archivo_out"
  fi
}

set_var "OPENAI_API_KEY" "$OPENAI_KEY" "$ENV_FILE" "$TMP"
cp "$TMP" "$TMP.2"
set_var "OPENAI_MODEL" "$MODELO_FIJO" "$TMP.2" "$TMP"

chmod 600 "$TMP"
chown "$DUENIO" "$TMP" 2>/dev/null || true
mv "$TMP" "$ENV_FILE"
trap - EXIT

echo
echo "OK. $ENV_FILE actualizado: OPENAI_API_KEY seteada, OPENAI_MODEL=$MODELO_FIJO."
echo "Permisos: $(stat -c '%a %U:%G' "$ENV_FILE" 2>/dev/null || stat -f '%Lp %Su:%Sg' "$ENV_FILE")"
echo
echo "Esto NO reinicia el panel. Para que tome efecto:"
echo "  sudo -u deploy bash /srv/panel/repo/deploy/deploy.sh"
echo "  (o, si solo cambiás env sin código nuevo: sudo -u deploy pm2 reload panel-3005 --update-env)"
echo
echo "infinix NO fue tocado (sigue sin OPENAI_API_KEY, como corresponde)."
