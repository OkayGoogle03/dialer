#!/bin/sh
# Keeps a DuckDNS host name pointing at the PBX's public IP (needed only if the PBX's public address is dynamic).
# Install:
#   1. create the token file (root only):   sudo sh -c 'umask 077; echo "DUCKDNS_TOKEN=<your token>" > /etc/duckdns.env'
#   2. install this script:                 sudo install -m 0755 duckdns-update.sh /usr/local/sbin/duckdns-update.sh
#   3. edit SUBDOMAIN below (only the part before .duckdns.org), then run it once: sudo /usr/local/sbin/duckdns-update.sh
#   4. schedule it:  echo '*/5 * * * * root /usr/local/sbin/duckdns-update.sh >/dev/null 2>&1' | sudo tee /etc/cron.d/duckdns
# Rollback: sudo rm /etc/cron.d/duckdns /usr/local/sbin/duckdns-update.sh /etc/duckdns.env  (the DNS record stays until you change it on duckdns.org)
set -eu
SUBDOMAIN="your-pbx-name"
# shellcheck disable=SC1091
. /etc/duckdns.env
printf '%s' "$SUBDOMAIN" | grep -Eq '^[a-z0-9-]{1,63}$' || { echo "invalid SUBDOMAIN" >&2; exit 1; }
# The token is passed to curl through its config on stdin, not on the command line, so it never shows in 'ps' for other users.
# An empty ip= makes DuckDNS use the address the request comes from (the PBX's public IP).
result="$(printf 'url = "https://www.duckdns.org/update?domains=%s&token=%s&ip="\n' "$SUBDOMAIN" "$DUCKDNS_TOKEN" | curl -4 -fsS -m 20 -K -)"
[ "$result" = "OK" ] || { echo "DuckDNS update failed: $result" >&2; exit 1; }
