#!/bin/sh
# Certbot deploy hook for an Asterisk PBX: runs after every SUCCESSFUL issue or renewal (certbot calls it as root).
# Install:  sudo install -m 0755 certbot-deploy-hook.sh /etc/letsencrypt/renewal-hooks/deploy/pbx-wss.sh
# Edit DOMAIN, WSS_PORT and the paths below to match your PBX (see docs/pbx-wss-letsencrypt.md). The new-server kit (ops/pbx-new) does this for you.
#
# What it does, safely:
#   1. copies the new certificate + key into a private temp folder and checks they belong together; if not, NOTHING is changed (exit 1)
#   2. installs them in the folder Asterisk reads, owner asterisk, certificate 0640, key 0600, folder 0750 (the folder is not left root-only)
#   3. reloads only the PBX HTTPS/WSS part (no restart, calls in progress are not dropped)
#   4. CHECKS that Asterisk now really serves the new certificate (same serial); if it still serves the old one it exits 1 so certbot reports
#      the failure, and says exactly what to run. A renewal that silently leaves the old certificate would break browsers in <= 30 days.
# PBX_HOOK_NO_RELOAD=1 only copies (used once by pbx-setup.sh before Asterisk is configured).
set -eu

DOMAIN="pbx.example.com"                 # the host name agents' browsers connect to (must match the certificate)
WSS_PORT="8089"
KEYDIR="/etc/asterisk/keys"              # where http.conf tlscertfile / tlsprivatekey point
PBX_USER="asterisk"
PBX_GROUP="asterisk"
RELOAD_CMD='asterisk -rx "module reload http"'   # Asterisk 18/20: reloads the HTTPS/WSS listener. Use your PBX's equivalent otherwise.

# certbot sets RENEWED_LINEAGE to /etc/letsencrypt/live/<name> for the certificate that was just renewed; ignore other certificates
case "${RENEWED_LINEAGE:-}" in */"$DOMAIN") ;; *) exit 0 ;; esac

umask 077
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp "$RENEWED_LINEAGE/fullchain.pem" "$tmp/pbx.crt"
cp "$RENEWED_LINEAGE/privkey.pem"   "$tmp/pbx.key"

# the certificate and the private key must match, otherwise the PBX would stop serving WSS (each step must succeed AND give a non-empty answer)
pub_crt="$(openssl x509 -in "$tmp/pbx.crt" -noout -pubkey)" || { echo "cannot read the new certificate; leaving the current files in place" >&2; exit 1; }
pub_key="$(openssl pkey -in "$tmp/pbx.key" -pubout)" || { echo "cannot read the new private key; leaving the current files in place" >&2; exit 1; }
[ -n "$pub_crt" ] && [ "$pub_crt" = "$pub_key" ] || { echo "certificate and key do not match; leaving the current files in place" >&2; exit 1; }
new_serial="$(openssl x509 -in "$tmp/pbx.crt" -noout -serial)"

# the folder must be readable by the PBX user even though this script runs with umask 077 as root
install -d -o "$PBX_USER" -g "$PBX_GROUP" -m 0750 "$KEYDIR"
install -o "$PBX_USER" -g "$PBX_GROUP" -m 0640 "$tmp/pbx.crt" "$KEYDIR/pbx.crt"
install -o "$PBX_USER" -g "$PBX_GROUP" -m 0600 "$tmp/pbx.key" "$KEYDIR/pbx.key"

# coturn (TURN relay), when installed by the 'turn' stage, reads its own copy of the certificate: refresh it too
COTURN_CERTS="/etc/coturn/certs"
if [ -d "$COTURN_CERTS" ]; then
  install -o turnserver -g turnserver -m 0640 "$tmp/pbx.crt" "$COTURN_CERTS/pbx.crt"
  install -o turnserver -g turnserver -m 0600 "$tmp/pbx.key" "$COTURN_CERTS/pbx.key"
fi

if [ "${PBX_HOOK_NO_RELOAD:-0}" = 1 ]; then echo "pbx-wss: certificate for $DOMAIN installed (reload skipped)"; exit 0; fi

[ -d "$COTURN_CERTS" ] && { systemctl restart coturn 2>/dev/null || echo "pbx-wss: warning: coturn did not restart; run: systemctl restart coturn" >&2; }

sh -c "$RELOAD_CMD"
sleep 3
served="$(openssl s_client -connect "127.0.0.1:$WSS_PORT" -servername "$DOMAIN" </dev/null 2>/dev/null | openssl x509 -noout -serial 2>/dev/null || true)"
if [ "$served" != "$new_serial" ]; then
  echo "pbx-wss: the certificate was installed but Asterisk is still serving '${served:-nothing}' instead of '$new_serial'." >&2
  echo "pbx-wss: run  asterisk -rx 'core restart when convenient'  (waits for calls to finish), then re-check with:  sudo sh pbx-setup.sh status" >&2
  exit 1
fi
echo "pbx-wss: certificate for $DOMAIN installed, reloaded and verified ($new_serial, $(date -u +%FT%TZ))"
