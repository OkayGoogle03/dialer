#!/bin/sh
# Certbot manual hook for the DNS-01 challenge on a DuckDNS host name. Use it when port 80 of the PBX is NOT reachable from the internet
# (or the PBX has only a private address): Let's Encrypt then verifies you by a TXT record that this script sets through the DuckDNS API.
# The same script is both hooks; certbot saves them in the renewal file, so automatic renewal keeps working.
#
#   sudo sh -c 'umask 077; echo "DUCKDNS_TOKEN=<your token>" > /etc/duckdns.env'
#   sudo install -m 0755 duckdns-certbot-hook.sh /usr/local/sbin/duckdns-certbot-hook.sh
#   sudo certbot certonly --manual --preferred-challenges dns -d your-pbx-name.duckdns.org \
#        --manual-auth-hook "/usr/local/sbin/duckdns-certbot-hook.sh auth" --manual-cleanup-hook "/usr/local/sbin/duckdns-certbot-hook.sh cleanup" \
#        --agree-tos -m you@example.com
#
# Rollback: sudo certbot delete --cert-name your-pbx-name.duckdns.org ; sudo rm /usr/local/sbin/duckdns-certbot-hook.sh /etc/duckdns.env
set -eu
# shellcheck disable=SC1091
. /etc/duckdns.env
sub="${CERTBOT_DOMAIN%.duckdns.org}"
[ "$sub" != "$CERTBOT_DOMAIN" ] || { echo "not a duckdns.org name: $CERTBOT_DOMAIN" >&2; exit 1; }
printf '%s' "$sub" | grep -Eq '^[a-z0-9-]{1,63}$' || { echo "unexpected characters in the domain" >&2; exit 1; }
# the validation string certbot gives us is URL-safe base64; refuse anything else so nothing can be injected into the request
printf '%s' "${CERTBOT_VALIDATION:-}" | grep -Eq '^[A-Za-z0-9_-]{20,128}$' || [ "${1:-}" = cleanup ] || { echo "unexpected validation string" >&2; exit 1; }
call() { printf 'url = "https://www.duckdns.org/update?domains=%s&token=%s&%s&verbose=false"\n' "$sub" "$DUCKDNS_TOKEN" "$1" | curl -4 -fsS -m 20 -K -; }  # token via stdin, not argv
case "${1:-}" in
  auth)
    r="$(call "txt=${CERTBOT_VALIDATION}")"
    [ "$r" = "OK" ] || { echo "DuckDNS TXT update failed: $r" >&2; exit 1; }
    sleep 60   # DuckDNS TXT records have a 60 s TTL; give Let's Encrypt's resolvers time to see the new value
    ;;
  cleanup)
    call "txt=removed&clear=true" >/dev/null || true
    ;;
  *) echo "usage: $0 auth|cleanup" >&2; exit 2 ;;
esac
