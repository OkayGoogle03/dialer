#!/bin/sh
# Sets up Asterisk for direct browser-to-PBX calling (SIP over WSS + WebRTC) on a NEW Ubuntu 22.04 / 24.04 server that belongs to this project.
# One stage at a time; each stage verifies itself and can be rolled back. Run as root on the NEW server only.
#
#   sudo sh pbx-setup.sh preflight     read-only: OS, public IP, NAT, ports in use, what is already installed  (changes nothing)
#   sudo sh pbx-setup.sh install       apt install asterisk certbot curl ufw fail2ban ; checks WSS/WebRTC modules are present
#   sudo sh pbx-setup.sh dns           DuckDNS: point the name at this server + keep it updated (cron)
#   sudo sh pbx-setup.sh certificate   Let's Encrypt certificate (DNS-01 through DuckDNS) + renewal hook
#   sudo sh pbx-setup.sh configure     snapshot of /etc/asterisk, then writes OUR files and includes them; auto-reverts if verification fails
#   sudo sh pbx-setup.sh harden        fail2ban against SIP brute force (Asterisk security log + jail), SSH jail stays on
#   sudo sh pbx-setup.sh firewall      prints the ufw plan; apply with:  sudo sh pbx-setup.sh firewall --yes
#   sudo sh pbx-setup.sh status        health report (also compares the certificate Asterisk SERVES with the one on disk)
#   sudo sh pbx-setup.sh rollback      removes everything these stages added (asks before deleting the certificate)
#
# Settings go in /etc/pbx-setup.env (root:root, mode 600, the script refuses anything looser):
#   DOMAIN=your-pbx-name.duckdns.org   EMAIL=you@example.com   DUCKDNS_TOKEN=xxxxxxxx
#   # optional:  CERTBOT_STAGING=1  RTP_START=10000  RTP_END=20000  WSS_PORT=8089  SSH_PORT=22  STRIP_PREFIX=0
#   # outgoing calls (toll-fraud protection). With ALLOW_PREFIXES empty NO call may leave through the trunk:
#   #   ALLOW_PREFIXES=91,1       digits a number must START with (after STRIP_PREFIX), comma separated
#   #   DENY_PREFIXES=1900,91900  checked first; premium / special numbers you never want
#   #   MAX_OUTBOUND=5  MAX_PER_AGENT=2  MAX_CALL_SECONDS=3600
#   # fail2ban:  FAIL2BAN_IGNORE="203.0.113.7 198.51.100.0/24"   (your own fixed addresses: never banned)
# Environment overrides for testing the file generation without touching a real PBX:  ASTERISK_ETC=/some/dir  DRY_RUN=1
set -eu

ENV_FILE="${ENV_FILE:-/etc/pbx-setup.env}"
ETC="${ASTERISK_ETC:-/etc/asterisk}"
F2B="${F2B_DIR:-/etc/fail2ban}"   # override only for tests
KEYDIR="$ETC/keys"
STATE="${PBX_STATE:-/var/lib/pbx-setup}"
DRY="${DRY_RUN:-0}"
HERE="$(cd "$(dirname "$0")" && pwd)"

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then printf 'DRY-RUN: %s\n' "$*"; else sh -c "$*"; fi; }
need_root() { [ "$DRY" = 1 ] || [ "$(id -u)" -eq 0 ] || die "run as root (sudo)"; }
num() { printf '%s' "$2" | grep -Eq '^[0-9]+$' || die "$1 must be a number (got '$2')"; }

load_env() {
  [ -r "$ENV_FILE" ] || die "$ENV_FILE not found. Create it (root, mode 600) with DOMAIN, EMAIL and DUCKDNS_TOKEN: see the header of this script."
  if [ "$DRY" != 1 ]; then
    mode="$(stat -c %a "$ENV_FILE")"; owner="$(stat -c %u "$ENV_FILE")"
    [ "$owner" = 0 ] && [ "$mode" = 600 ] || die "$ENV_FILE must be owned by root with mode 600 (it holds the DuckDNS token). Fix:  sudo chown root:root $ENV_FILE && sudo chmod 600 $ENV_FILE"
  fi
  # The file is READ as KEY=VALUE lines, never executed: only the known names below are accepted and a value can never run a command.
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"; val="${line#*=}"
    [ "$key" != "$line" ] || die "$ENV_FILE: a line without '=' (lines must be KEY=VALUE or start with #)"
    case "$key" in
      DOMAIN|EMAIL|DUCKDNS_TOKEN|CERTBOT_STAGING|RTP_START|RTP_END|WSS_PORT|SSH_PORT|STRIP_PREFIX|MAX_OUTBOUND|MAX_PER_AGENT|MAX_CALL_SECONDS|ALLOW_PREFIXES|DENY_PREFIXES|FAIL2BAN_IGNORE) ;;
      *) die "$ENV_FILE: unknown setting '$key'" ;;
    esac
    val="${val#\"}"; val="${val%\"}"; val="${val#\'}"; val="${val%\'}"
    eval "$key=\$val"
  done < "$ENV_FILE"
  : "${DOMAIN:?DOMAIN missing in $ENV_FILE}" "${EMAIL:?EMAIL missing in $ENV_FILE}"
  RTP_START="${RTP_START:-10000}"; RTP_END="${RTP_END:-20000}"; WSS_PORT="${WSS_PORT:-8089}"; SSH_PORT="${SSH_PORT:-22}"
  STRIP_PREFIX="${STRIP_PREFIX:-0}"; MAX_OUTBOUND="${MAX_OUTBOUND:-5}"; MAX_PER_AGENT="${MAX_PER_AGENT:-2}"; MAX_CALL_SECONDS="${MAX_CALL_SECONDS:-3600}"
  ALLOW_PREFIXES="${ALLOW_PREFIXES:-}"; DENY_PREFIXES="${DENY_PREFIXES:-}"; FAIL2BAN_IGNORE="${FAIL2BAN_IGNORE:-}"
  for v in RTP_START RTP_END WSS_PORT SSH_PORT STRIP_PREFIX MAX_OUTBOUND MAX_PER_AGENT MAX_CALL_SECONDS; do eval "num $v \"\$$v\""; done
  # destination rules go into the dial plan: digits only, comma separated
  for v in ALLOW_PREFIXES DENY_PREFIXES; do eval "val=\$$v"; [ -z "$val" ] || printf '%s' "$val" | grep -Eq '^[0-9]+(,[0-9]+)*$' || die "$v must be digits separated by commas, for example 91,1 (got '$val')"; done
  for a in $(printf '%s' "$FAIL2BAN_IGNORE" | tr ',' ' '); do printf '%s' "$a" | grep -Eq '^[0-9a-fA-F:.]+(/[0-9]{1,3})?$' || die "FAIL2BAN_IGNORE: '$a' is not an address or CIDR"; done
  [ "$RTP_START" -lt "$RTP_END" ] || die "RTP_START must be lower than RTP_END"
  # values end up inside shell commands and config files: accept only plain host / e-mail characters
  printf '%s' "$DOMAIN" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' || die "DOMAIN is not a plain lower-case host name"
  printf '%s' "$EMAIL" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' || die "EMAIL looks invalid"
  [ -z "${DUCKDNS_TOKEN:-}" ] || printf '%s' "$DUCKDNS_TOKEN" | grep -Eq '^[A-Za-z0-9-]{20,60}$' || die "DUCKDNS_TOKEN has unexpected characters (expected the token from duckdns.org: letters, digits, dashes)"
}

ast() { if command -v asterisk >/dev/null 2>&1; then asterisk -rx "$1"; else echo "(asterisk not installed)"; fi; }
public_ip() { curl -4 -fsS -m 8 https://api.ipify.org 2>/dev/null || true; }
local_ips() { ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1; }

# ---- files: first-original backup, include handling
backup_once() { [ -f "$1" ] || return 0; [ -f "$1.before-pbx-setup" ] || cp -a "$1" "$1.before-pbx-setup"; }
snapshot() { # timestamped copy of the whole configuration (the restore point used by rollback instructions)
  [ "$DRY" = 1 ] && return 0
  mkdir -p "$STATE/snapshots"; chmod 700 "$STATE" "$STATE/snapshots"
  f="$STATE/snapshots/etc-asterisk-$(date +%Y%m%d-%H%M%S).tgz"
  tar czf "$f" -C / "${ETC#/}" 2>/dev/null; chmod 600 "$f"
  say "Snapshot of $ETC saved: $f   (restore: tar xzf $f -C / && asterisk -rx 'core reload')"
}
add_include() { # add_include <file> <include name> [section]: idempotent. With a section, the include goes INSIDE that section.
  # Asterisk reads only the FIRST [general] of a file, so an included [general] block would be ignored. The include goes at the
  # END of the section (just before the next header, or at the end of the file): when a setting appears twice in one section the
  # LAST one wins, so our values must come after anything the packaged file already sets (rtpstart, bindaddr, ...).
  f="$1"; inc="$2"; sec="${3:-}"
  touch "$f"
  grep -qF "#include $inc" "$f" && return 0
  backup_once "$f"
  if [ -z "$sec" ]; then printf '\n; added by pbx-setup\n#include %s\n' "$inc" >> "$f"; return 0; fi
  if grep -q "^\[$sec\]" "$f"; then
    awk -v sec="[$sec]" -v inc="$inc" '
      function put() { if (insec && !done) { print ""; print "; added by pbx-setup"; print "#include " inc; done = 1 } }
      !done && $0 == sec { insec = 1; print; next }
      insec && !done && substr($0, 1, 1) == "[" { put(); insec = 0 }
      { print }
      END { put() }' "$f" > "$f.tmp"
    cat "$f.tmp" > "$f"; rm -f "$f.tmp"
  else printf '\n[%s]\n; added by pbx-setup\n#include %s\n' "$sec" "$inc" >> "$f"; fi
}
remove_include() { # removes our include line, the marker comment right above it and the blank line we put above that: the file returns byte-identical
  f="$1"; inc="$2"; [ -f "$f" ] || return 0
  awk -v inc="#include $inc" '
    { l[NR] = $0 }
    END {
      for (i = 1; i <= NR; i++) if (l[i] == inc) {
        skip[i] = 1
        if (i > 1 && l[i-1] == "; added by pbx-setup") { skip[i-1] = 1; if (i > 2 && l[i-2] == "") skip[i-2] = 1 }
      }
      for (i = 1; i <= NR; i++) if (!skip[i]) print l[i]
    }' "$f" > "$f.tmp"
  cat "$f.tmp" > "$f"; rm -f "$f.tmp"
}
reload_pbx() { command -v asterisk >/dev/null 2>&1 || return 0; for m in http res_pjsip.so res_rtp_asterisk.so; do asterisk -rx "module reload $m" >/dev/null; done; asterisk -rx "dialplan reload" >/dev/null; asterisk -rx "logger reload" >/dev/null; }
asterisk_own() { chown asterisk:asterisk "$@" 2>/dev/null || true; chmod 640 "$@"; }

# ------------------------------------------------------------------------------------------------ preflight
stage_preflight() {
  say "== Operating system"; [ -r /etc/os-release ] && . /etc/os-release && say "$PRETTY_NAME"
  case "${ID:-}:${VERSION_ID:-}" in ubuntu:22.04|ubuntu:24.04) say "supported release" ;; *) say "WARNING: this kit is written for Ubuntu 22.04 / 24.04 LTS (apt). Found: ${ID:-unknown} ${VERSION_ID:-}" ;; esac
  say; say "== Addresses on this server"; local_ips
  pub="$(public_ip)"; say "Public IP as seen from the internet: ${pub:-could not be determined}"
  if [ -n "$pub" ] && local_ips | grep -qx "$pub"; then say "=> the server has its public address directly (no NAT)."
  elif [ -n "$pub" ]; then say "=> the public IP is NOT on this server: it is behind NAT (typical for cloud VMs). 'configure' then sets external_media_address / external_signaling_address / local_net and the ICE host candidate mapping. Open the ports in the PROVIDER's firewall / security group as well as in ufw."; fi
  say; say "== SSH (kept reachable by the firewall stage)"; (sshd -T 2>/dev/null | awk '/^port /{print "sshd port: " $2}') || true
  say; say "== Already listening on the ports this kit uses"
  ss -lntup 2>/dev/null | grep -E ":(8089|8088|5060|443|80)\b" || say "none of 8089 / 8088 / 5060 / 443 / 80"
  say; say "== Already installed?"; command -v asterisk >/dev/null && asterisk -V || say "asterisk: not installed"; command -v certbot >/dev/null && certbot --version || say "certbot: not installed"
  say; say "== Existing Asterisk configuration (if any) is snapshotted, saved as <file>.before-pbx-setup and never overwritten"
  [ -d "$ETC" ] && ls -la "$ETC" | head -20 || say "$ETC does not exist yet"
}

# ------------------------------------------------------------------------------------------------ install
stage_install() {
  need_root
  run "apt-get update"
  # Asterisk, certbot, fail2ban and ufw are in Ubuntu's 'universe' component; make sure it is enabled (a minimal image may not have it)
  if [ "$DRY" != 1 ] && ! apt-cache policy asterisk | grep -q 'Candidate: [0-9]'; then
    run "apt-get install -y software-properties-common" && run "add-apt-repository -y universe" && run "apt-get update"
    apt-cache policy asterisk | grep -q 'Candidate: [0-9]' || die "the asterisk package is not available from the enabled apt sources"
  fi
  run "DEBIAN_FRONTEND=noninteractive apt-get install -y asterisk certbot curl ufw fail2ban openssl ca-certificates"
  [ "$DRY" = 1 ] && return 0
  v="$(asterisk -V 2>/dev/null | sed -E 's/[^0-9]*([0-9]+\.[0-9]+).*/\1/')"
  say "Installed: $(asterisk -V)"
  major="${v%%.*}"; minor="${v#*.}"
  { [ "$major" -gt 16 ] || { [ "$major" -eq 16 ] && [ "$minor" -ge 2 ]; }; } || die "Asterisk $v is older than 16.2: WebRTC needs 16.2 or newer. Use a newer Ubuntu release or build Asterisk from source, then rerun."
  systemctl enable --now asterisk >/dev/null 2>&1 || true
  i=0; until asterisk -rx "core show version" >/dev/null 2>&1; do i=$((i+1)); [ $i -lt 20 ] || die "asterisk did not start: systemctl status asterisk"; sleep 2; done
  missing=""
  for m in res_http_websocket res_pjsip res_pjsip_transport_websocket res_pjsip_session res_srtp res_rtp_asterisk; do
    asterisk -rx "module show like $m" | grep -q "$m" || missing="$missing $m"
  done
  [ -z "$missing" ] || die "required modules not available:$missing (check /etc/asterisk/modules.conf for noload lines, and that the package asterisk-modules is installed)"
  asterisk -rx "module show like chan_sip" | grep -q "Running" && say "note: the old chan_sip driver is also running; it is not used by this kit. If it holds port 5060, the trunk transport below will fail to bind: disable it with 'noload = chan_sip.so' in modules.conf, or set another port."
  say "OK: WebSocket, PJSIP, SRTP and RTP modules are present. Next: dns, certificate, configure."
}

# ------------------------------------------------------------------------------------------------ dns (DuckDNS)
stage_dns() {
  need_root; load_env
  case "$DOMAIN" in *.duckdns.org) ;; *) say "DOMAIN is not on duckdns.org: nothing to do"; return 0 ;; esac
  : "${DUCKDNS_TOKEN:?DUCKDNS_TOKEN missing in $ENV_FILE}"
  sub="${DOMAIN%.duckdns.org}"
  printf '%s' "$sub" | grep -Eq '^[a-z0-9-]{1,63}$' || die "DuckDNS sub-domain has unexpected characters"
  [ "$DRY" = 1 ] || ( umask 077; printf 'DUCKDNS_TOKEN=%s\n' "$DUCKDNS_TOKEN" > /etc/duckdns.env )
  run "install -m 0755 '$HERE/../pbx/duckdns-update.sh' /usr/local/sbin/duckdns-update.sh"
  run "sed -i 's/^SUBDOMAIN=.*/SUBDOMAIN=\"$sub\"/' /usr/local/sbin/duckdns-update.sh"
  run "/usr/local/sbin/duckdns-update.sh"
  [ "$DRY" = 1 ] || printf '*/5 * * * * root /usr/local/sbin/duckdns-update.sh >/dev/null 2>&1\n' > /etc/cron.d/duckdns
  pub="$(public_ip)"
  say "DuckDNS updated. Waiting for DNS ($DOMAIN should resolve to ${pub:-this server's public IP})..."
  i=0; got=""; while [ $i -lt 12 ]; do got="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1)"; [ -n "$got" ] && break; i=$((i+1)); sleep 5; done
  say "$DOMAIN -> ${got:-(no answer yet: DuckDNS can take a minute; rerun status later)}"
  [ -z "${pub:-}" ] || [ "${got:-}" = "$pub" ] || say "WARNING: $DOMAIN resolves to ${got:-nothing} but this server's public IP is $pub. Do not continue until they match."
}

# ------------------------------------------------------------------------------------------------ certificate
stage_certificate() {
  need_root; load_env
  [ -r /etc/duckdns.env ] || [ "$DRY" = 1 ] || die "run the dns stage first (it stores the DuckDNS token for the validation hook)"
  run "install -m 0755 '$HERE/../pbx/duckdns-certbot-hook.sh' /usr/local/sbin/duckdns-certbot-hook.sh"
  staging=""; [ "${CERTBOT_STAGING:-0}" = 1 ] && staging="--staging" && say "Using the Let's Encrypt STAGING environment (practice certificate, NOT trusted by browsers). Before going live: certbot delete --cert-name $DOMAIN, remove CERTBOT_STAGING, rerun this stage."
  run "certbot certonly --manual --preferred-challenges dns -d '$DOMAIN' --manual-auth-hook '/usr/local/sbin/duckdns-certbot-hook.sh auth' --manual-cleanup-hook '/usr/local/sbin/duckdns-certbot-hook.sh cleanup' --agree-tos -m '$EMAIL' --non-interactive $staging"
  # the folder Asterisk reads: owned by asterisk, not world-readable (the umask of root must not turn it into a root-only folder)
  run "install -d -o asterisk -g asterisk -m 0750 '$KEYDIR'"
  run "install -m 0755 '$HERE/../pbx/certbot-deploy-hook.sh' /etc/letsencrypt/renewal-hooks/deploy/pbx-wss.sh"
  run "sed -i 's/^DOMAIN=.*/DOMAIN=\"$DOMAIN\"/; s/^WSS_PORT=.*/WSS_PORT=\"$WSS_PORT\"/' /etc/letsencrypt/renewal-hooks/deploy/pbx-wss.sh"
  if [ "$DRY" != 1 ]; then
    # install the first copy with the same hook that renewals use (Asterisk is not configured yet, so only copy: the reload step is skipped)
    PBX_HOOK_NO_RELOAD=1 RENEWED_LINEAGE="/etc/letsencrypt/live/$DOMAIN" sh /etc/letsencrypt/renewal-hooks/deploy/pbx-wss.sh || die "installing the certificate for Asterisk failed"
    certbot renew --dry-run >/dev/null 2>&1 && say "OK: 'certbot renew --dry-run' succeeded (automatic renewal will work)" || say "WARNING: certbot renew --dry-run failed; run it by hand and read the error before relying on renewal"
    systemctl list-timers 2>/dev/null | grep -qi certbot && say "certbot renewal timer: active" || say "WARNING: no certbot systemd timer found; add:  echo '17 3,15 * * * root certbot renew -q' > /etc/cron.d/certbot-renew"
  fi
}

# ------------------------------------------------------------------------------------------------ configure
stage_configure() {
  need_root; load_env
  [ -r "$KEYDIR/pbx.crt" ] || die "no certificate in $KEYDIR yet: run the certificate stage first"
  if [ "$DRY" != 1 ]; then
    existing="$(ast "pjsip show transports" 2>/dev/null || true)"
    printf '%s' "$existing" | grep -Eq "Transport:  *transport-(wss|udp)" && ! grep -q "#include pjsip_dialer.conf" "$ETC/pjsip.conf" && die "a transport named transport-wss / transport-udp already exists in this Asterisk. This kit is for a fresh server: stop, and review 'asterisk -rx \"pjsip show transports\"'."
    ss -lnt 2>/dev/null | grep -q ":$WSS_PORT " && ! ast "http show status" | grep -q ":$WSS_PORT" && die "port $WSS_PORT/tcp is already used by another program"
  fi
  snapshot
  mkdir -p "$STATE"
  for f in http.conf pjsip.conf rtp.conf extensions.conf; do backup_once "$ETC/$f"; done

  # --- NAT: if the public IP is not on this server, Asterisk must advertise it in SIP/SDP and in the ICE candidates
  pub="$(public_ip)"; nat=""; ice=""
  if [ "$DRY" != 1 ] && [ -n "$pub" ] && ! local_ips | grep -qx "$pub"; then
    nets="$(ip -4 -o route show scope link 2>/dev/null | awk '{print $1}' | grep '/' | sort -u)"
    [ -n "$nets" ] || die "NAT detected but no local network found to put in local_net: set it by hand in pjsip_dialer.conf"
    nat="external_media_address=$pub
external_signaling_address=$pub"
    for n in $nets; do nat="$nat
local_net=$n"; done
    ice="[ice_host_candidates]"
    for a in $(local_ips); do ice="$ice
$a => $pub"; done
    say "NAT detected: advertising $pub (local_net: $(echo $nets))"
  fi

  cat > "$ETC/http_dialer.conf" <<EOF
; written by pbx-setup. It is included INSIDE the [general] section of http.conf (no header here). Remove the include line to undo.
servername=PersonalPBX
enabled=yes
bindaddr=127.0.0.1
bindport=8088
tlsenable=yes
tlsbindaddr=0.0.0.0:$WSS_PORT
tlscertfile=$KEYDIR/pbx.crt
tlsprivatekey=$KEYDIR/pbx.key
EOF

  cat > "$ETC/pjsip_dialer.conf" <<EOF
; written by pbx-setup. Remove the '#include pjsip_dialer.conf' line from pjsip.conf to undo.
; Browser agents register over WSS. Agents are added with add-agent.sh (pjsip_agents.conf).
; NAT settings (if any) must be on EVERY transport an endpoint uses: the media address in the SDP comes from the endpoint's transport.
[transport-wss]
type=transport
protocol=wss
bind=0.0.0.0
$nat

; UDP transport used only by a phone-network trunk (outgoing registration to your provider)
[transport-udp]
type=transport
protocol=udp
bind=0.0.0.0:5060
$nat

#include pjsip_agents.conf
#include pjsip_trunk.conf
EOF
  [ -f "$ETC/pjsip_agents.conf" ] || printf '; browser agents, one block per agent (add-agent.sh)\n' > "$ETC/pjsip_agents.conf"
  [ -f "$ETC/pjsip_trunk.conf" ] || printf '; phone-network trunk (add-trunk.sh)\n' > "$ETC/pjsip_trunk.conf"
  # DTLS-SRTP: webrtc=yes switches DTLS on but supplies no certificate; Asterisk generates its own for the DTLS handshake (peers verify the fingerprint in the SDP)
  echo "dtls_auto_generate_cert=yes" > "$STATE/dtls_auto"

  cat > "$ETC/rtp_dialer.conf" <<EOF
; written by pbx-setup. Included INSIDE the [general] section of rtp.conf (no header here). Remove the include line to undo.
rtpstart=$RTP_START
rtpend=$RTP_END
icesupport=yes
stunaddr=stun.l.google.com:19302
EOF
  printf '; written by pbx-setup. ICE host candidates for a server behind NAT (own section).\n%s\n' "$ice" > "$ETC/rtp_ice_dialer.conf"

  # ---- dial plan. Written by a function with a QUOTED heredoc, so Asterisk's ${...} / $[...] reach the file untouched; only the numbers
  # and the (digits-only, already validated) prefix lists are inserted with printf.
  allow_re="$(printf '%s' "$ALLOW_PREFIXES" | tr ',' '|')"; deny_re="$(printf '%s' "$DENY_PREFIXES" | tr ',' '|')"
  [ -n "$ALLOW_PREFIXES" ] || say "NOTE: ALLOW_PREFIXES is not set: every outgoing trunk call will be refused until you set it in $ENV_FILE and rerun 'configure'."
  write_dialplan() {
    cat <<'EOF'
; written by pbx-setup. Remove the '#include extensions_dialer.conf' line from extensions.conf to undo.
[from-agents]
; 3-5 digit numbers ring another agent's extension; longer numbers go to the phone-network trunk
exten => _XXX.,1,NoOp(agent ${CALLERID(num)} calls ${EXTEN})
 same => n,GotoIf($[${LEN(${EXTEN})} > 5]?outside)
 same => n,Dial(PJSIP/${EXTEN},30)
 same => n,Hangup()
 same => n(outside),Goto(to-trunk,${EXTEN},1)
exten => _+X.,1,Goto(to-trunk,${EXTEN:1},1)

[to-trunk]
EOF
    printf '; Toll-fraud protection for every call that leaves through the trunk (settings in %s):\n' "$ENV_FILE"
    printf ';   1. the number (after STRIP_PREFIX=%s) must be 6-15 digits\n' "$STRIP_PREFIX"
    printf ';   2. it must NOT start with DENY_PREFIXES : %s\n' "${DENY_PREFIXES:-none set}"
    printf ';   3. it must start with ALLOW_PREFIXES    : %s\n' "${ALLOW_PREFIXES:-NONE SET, so every outgoing call is refused}"
    printf ';   4. at most %s calls at once for the whole PBX, %s per agent, %s seconds per call\n' "$MAX_OUTBOUND" "$MAX_PER_AGENT" "$MAX_CALL_SECONDS"
    printf '; A refused destination ends with SIP 403 (cause 21), a limit with SIP 503 (cause 34).\n'
    printf 'exten => _X.,1,Set(NUM=${EXTEN:%s})\n' "$STRIP_PREFIX"
    cat <<'EOF'
 same => n,GotoIf($[${DIALPLAN_EXISTS(from-trunk,trunk-enabled,1)}]?checks:none)
 same => n(checks),GotoIf($[${REGEX("^[0-9]+$" ${NUM})} = 0]?denied)
 same => n,GotoIf($[${LEN(${NUM})} < 6 | ${LEN(${NUM})} > 15]?denied)
EOF
    if [ -n "$DENY_PREFIXES" ]; then printf ' same => n,GotoIf($[${REGEX("^(%s)" ${NUM})}]?denied)\n' "$deny_re"; fi
    if [ -n "$ALLOW_PREFIXES" ]; then printf ' same => n,GotoIf($[${REGEX("^(%s)" ${NUM})} = 0]?denied)\n' "$allow_re"; else printf ' same => n,Goto(denied)\n'; fi
    printf ' same => n,Set(GROUP()=outbound)\n same => n,Set(GROUP(agent)=${CALLERID(num)})\n'
    printf ' same => n,GotoIf($[${GROUP_COUNT(outbound)} > %s]?limit)\n' "$MAX_OUTBOUND"
    printf ' same => n,GotoIf($[${GROUP_COUNT(${CALLERID(num)}@agent)} > %s]?limit)\n' "$MAX_PER_AGENT"
    printf ' same => n,Set(TIMEOUT(absolute)=%s)\n' "$MAX_CALL_SECONDS"
    cat <<'EOF'
 same => n,Dial(PJSIP/${NUM}@trunk-out,60)
 same => n,Hangup()
 same => n(denied),NoOp(outgoing call refused: destination not allowed)
 same => n,Hangup(21)
 same => n(limit),NoOp(outgoing call refused: call limit reached)
 same => n,Hangup(34)
 same => n(none),Playback(ss-noservice)
 same => n,Hangup(34)

#include extensions_trunk_in.conf
EOF
  }
  write_dialplan > "$ETC/extensions_dialer.conf"
  [ -f "$ETC/extensions_trunk_in.conf" ] || printf '; inbound calls from the trunk (add-trunk.sh)\n' > "$ETC/extensions_trunk_in.conf"

  add_include "$ETC/http.conf" http_dialer.conf general
  add_include "$ETC/rtp.conf" rtp_dialer.conf general
  [ -z "$ice" ] || add_include "$ETC/rtp.conf" rtp_ice_dialer.conf
  add_include "$ETC/pjsip.conf" pjsip_dialer.conf
  add_include "$ETC/extensions.conf" extensions_dialer.conf
  [ "$DRY" = 1 ] && { say "DRY-RUN: files written under $ETC; not reloading."; return 0; }
  asterisk_own "$ETC"/*_dialer.conf "$ETC"/pjsip_agents.conf "$ETC"/pjsip_trunk.conf "$ETC"/extensions_trunk_in.conf

  # --- reload only what changed, then verify. If verification fails the includes are removed again (the system returns to how it was).
  reload_pbx
  sleep 2
  ok=1
  ast "http show status" | grep -qi ":$WSS_PORT" || { say "FAILED: Asterisk is not listening for HTTPS on $WSS_PORT"; ok=0; }
  ast "pjsip show transports" | grep -q "transport-wss" || { say "FAILED: transport-wss is not loaded"; ok=0; }
  # plain (unencrypted) HTTP must only listen on localhost, whatever the packaged http.conf said
  if ss -lnt 2>/dev/null | grep -Eq '(0\.0\.0\.0|\*|\[::\]):8088[[:space:]]'; then say "FAILED: plain HTTP (8088) listens on all interfaces"; ok=0; fi
  ast "rtp show settings" | grep -Eqi "ICE support:? +Yes" || say "WARNING: could not confirm ICE support in 'rtp show settings'; check it by hand"
  if [ "$ok" = 0 ]; then
    say "Verification failed: removing our includes and reloading (nothing else was changed)."
    remove_include "$ETC/http.conf" http_dialer.conf; remove_include "$ETC/pjsip.conf" pjsip_dialer.conf
    remove_include "$ETC/rtp.conf" rtp_dialer.conf; remove_include "$ETC/rtp.conf" rtp_ice_dialer.conf; remove_include "$ETC/extensions.conf" extensions_dialer.conf
    reload_pbx
    say "Read /var/log/asterisk/full for the reason, fix, and rerun: sudo sh pbx-setup.sh configure"
    exit 1
  fi
  say "OK: WSS listener on $WSS_PORT and transport-wss are active. Next: harden, firewall, add agents (add-agent.sh), then test from outside with scripts/check-pbx-wss.mjs."
}

# ------------------------------------------------------------------------------------------------ harden (brute force protection)
stage_harden() {
  need_root; load_env
  [ -d "$F2B" ] || die "fail2ban is not installed: run the install stage"
  mkdir -p "$STATE"; backup_once "$ETC/logger.conf"
  # Asterisk's security log records failed logins / unknown users / ACL violations with the client's address
  printf '; written by pbx-setup. Included INSIDE [logfiles] of logger.conf.\nsecurity_log => security\n' > "$ETC/logger_dialer.conf"
  # fail2ban refuses a jail whose log file does not exist yet: create it (owner asterisk) before the jail starts
  [ "$DRY" = 1 ] || { [ -e /var/log/asterisk/security_log ] || install -o asterisk -g asterisk -m 0640 /dev/null /var/log/asterisk/security_log; }
  add_include "$ETC/logger.conf" logger_dialer.conf logfiles
  asterisk_own "$ETC/logger_dialer.conf"
  [ "$DRY" = 1 ] || asterisk -rx "logger reload" >/dev/null
  # our own filter: the stock Asterisk filter may not know the WebSocket transport names (WS/WSS) in RemoteAddress
  mkdir -p "$F2B/filter.d" "$F2B/jail.d"
  cat > "$F2B/filter.d/pbx-asterisk-ws.conf" <<'EOF'
# written by pbx-setup: failed SIP logins over any transport (UDP / TCP / TLS / WS / WSS) from Asterisk's security log
[Definition]
failregex = ^\[[^\]]*\]\s+SECURITY\[\d+\]\s+\S+:\s+SecurityEvent="(?:FailedACL|InvalidAccountID|ChallengeResponseFailed|InvalidPassword|AuthMethodNotAllowed)".*RemoteAddress="IPV[46]/[A-Za-z]+/<HOST>/\d+"
ignoreregex =
datepattern = ^\[%%Y-%%m-%%d %%H:%%M:%%S\]
EOF
  cat > "$F2B/jail.d/pbx-asterisk.local" <<EOF
# written by pbx-setup. 8 failed logins within 10 minutes ban the address for 1 hour. The Dialer softphone no longer retries a rejected password,
# so a legitimate agent causes at most one failure per page load. Addresses in FAIL2BAN_IGNORE (/etc/pbx-setup.env) are never banned.
[pbx-asterisk]
enabled  = true
filter   = pbx-asterisk-ws
logpath  = /var/log/asterisk/security_log
port     = $WSS_PORT,5060
maxretry = 8
findtime = 600
bantime  = 3600
ignoreip = 127.0.0.1/8 ::1 $(printf '%s' "$FAIL2BAN_IGNORE" | tr ',' ' ')
EOF
  say "Test the filter against the real log once an agent has failed a login:  fail2ban-regex /var/log/asterisk/security_log /etc/fail2ban/filter.d/pbx-asterisk-ws.conf"
  [ "$DRY" = 1 ] || { systemctl enable --now fail2ban >/dev/null 2>&1 || true; systemctl restart fail2ban; sleep 2; [ "$DRY" = 1 ] || fail2ban-client status pbx-asterisk >/dev/null 2>&1 && say "OK: jail pbx-asterisk is active (also active by default on Ubuntu: the sshd jail)" || say "WARNING: jail pbx-asterisk did not start: journalctl -u fail2ban | tail"; }
}

# ------------------------------------------------------------------------------------------------ firewall
stage_firewall() {
  need_root; load_env
  # every port sshd really listens on is allowed first (not only the default), so the firewall cannot lock you out
  sshports="$(sshd -T 2>/dev/null | awk '/^port /{print $2}' | sort -u)"; [ -n "$sshports" ] || sshports="$SSH_PORT"
  printf '%s\n' "$sshports" | grep -qx "$SSH_PORT" || sshports="$sshports
$SSH_PORT"
  say "Plan (ufw). SSH is allowed and rate-limited FIRST so you cannot lock yourself out:"
  for p in $sshports; do say "  limit ${p}/tcp                (SSH, max 6 new connections / 30 s per address)"; done
  say "  default: deny incoming, allow outgoing"
  say "  allow ${WSS_PORT}/tcp           (SIP over WSS from browsers)"
  say "  allow ${RTP_START}:${RTP_END}/udp  (audio)"
  say "  (3478 / 5349 for TURN are NOT opened; add them only if you install TURN later: docs/pbx-wss-letsencrypt.md, section 6)"
  say "  5060/udp is NOT opened: the trunk registers outward and the provider's calls come back through that registration."
  say "ALSO open the same ports in your hosting provider's own firewall / security group, otherwise nothing reaches the server."
  [ "${1:-}" = "--yes" ] || { say; say "Nothing changed. To apply: sudo sh pbx-setup.sh firewall --yes"; return 0; }
  for p in $sshports; do run "ufw limit ${p}/tcp comment 'pbx-setup ssh'"; done
  run "ufw default deny incoming"
  run "ufw default allow outgoing"
  run "ufw allow ${WSS_PORT}/tcp comment 'pbx-setup wss'"
  run "ufw allow ${RTP_START}:${RTP_END}/udp comment 'pbx-setup rtp'"
  run "ufw --force enable"
  run "ufw status numbered"
}

# ------------------------------------------------------------------------------------------------ status
stage_status() {
  load_env
  say "== Asterisk"; ast "core show version"; ast "http show status" | head -12; ast "pjsip show transports" | head -12
  say; say "== Registered browser agents"; ast "pjsip show contacts" | head -20
  say; say "== Certificate on disk"; [ -r "$KEYDIR/pbx.crt" ] && openssl x509 -in "$KEYDIR/pbx.crt" -noout -subject -issuer -dates -serial || say "no certificate installed"
  say; say "== Certificate Asterisk is SERVING (must have the same serial as the file on disk)"
  openssl s_client -connect "127.0.0.1:$WSS_PORT" -servername "$DOMAIN" </dev/null 2>/dev/null | openssl x509 -noout -serial -enddate 2>/dev/null || say "could not read the served certificate (is the HTTPS listener up?)"
  say; say "== DNS"; getent hosts "$DOMAIN" || say "$DOMAIN does not resolve yet"; say "public IP: $(public_ip)"
  say; say "== Firewall"; command -v ufw >/dev/null && ufw status | head -15
  say; say "== fail2ban"; command -v fail2ban-client >/dev/null && fail2ban-client status 2>/dev/null | head -5
  say; say "Check from OUTSIDE your server (phone on mobile data, other network):  node scripts/check-pbx-wss.mjs $DOMAIN $WSS_PORT /ws"
}

# ------------------------------------------------------------------------------------------------ rollback
stage_rollback() {
  need_root; load_env
  say "Rolling back what pbx-setup added (the Asterisk package itself stays installed)."
  remove_include "$ETC/http.conf" http_dialer.conf; remove_include "$ETC/pjsip.conf" pjsip_dialer.conf
  remove_include "$ETC/rtp.conf" rtp_dialer.conf; remove_include "$ETC/rtp.conf" rtp_ice_dialer.conf; remove_include "$ETC/extensions.conf" extensions_dialer.conf
  remove_include "$ETC/acl.conf" acl_agents.conf; remove_include "$ETC/logger.conf" logger_dialer.conf
  for f in http pjsip rtp extensions logger acl; do [ -f "$ETC/$f.conf.before-pbx-setup" ] && say "original of $f.conf is kept as $f.conf.before-pbx-setup"; done
  stamp="$(date +%Y%m%d-%H%M%S)"; removed="$STATE/removed-$stamp"; mkdir -p "$removed"; chmod 700 "$removed"
  for f in http_dialer.conf pjsip_dialer.conf rtp_dialer.conf rtp_ice_dialer.conf extensions_dialer.conf extensions_trunk_in.conf pjsip_trunk.conf pjsip_agents.conf acl_agents.conf logger_dialer.conf; do
    if [ -f "$ETC/$f" ]; then mv "$ETC/$f" "$removed/"; fi
  done
  reload_pbx
  rm -f "$F2B/jail.d/pbx-asterisk.local" "$F2B/filter.d/pbx-asterisk-ws.conf"
  command -v fail2ban-client >/dev/null && systemctl restart fail2ban 2>/dev/null || true
  if command -v ufw >/dev/null; then for n in $(ufw status numbered | grep 'pbx-setup' | grep -v 'pbx-setup ssh' | sed -E 's/^\[ *([0-9]+)\].*/\1/' | sort -rn); do ufw --force delete "$n" >/dev/null; done; say "ufw: the WSS and RTP rules added by pbx-setup were removed; the SSH rule is KEPT on purpose (ufw stays enabled with default deny, so removing it would lock you out). Remove it yourself only after checking 'ufw status'"; fi
  rm -f /etc/cron.d/duckdns /usr/local/sbin/duckdns-update.sh /usr/local/sbin/duckdns-certbot-hook.sh /etc/letsencrypt/renewal-hooks/deploy/pbx-wss.sh
  say "Agent and trunk definitions were moved to $removed (not deleted). Whole-configuration snapshots are in $STATE/snapshots."
  printf 'Also delete the Let'"'"'s Encrypt certificate for %s and /etc/duckdns.env? [y/N] ' "$DOMAIN"; read -r a || a=n
  case "$a" in y|Y) certbot delete --cert-name "$DOMAIN" || true; rm -f /etc/duckdns.env "$KEYDIR/pbx.crt" "$KEYDIR/pbx.key" ;; *) say "certificate and token file kept" ;; esac
  say "Rollback finished. Verify: asterisk -rx 'pjsip show transports'"
}

cmd="${1:-}"; [ $# -gt 0 ] && shift
case "$cmd" in
  preflight) stage_preflight ;; install) stage_install ;; dns) stage_dns ;; certificate) stage_certificate ;; configure) stage_configure ;;
  harden) stage_harden ;; firewall) stage_firewall "$@" ;; status) stage_status ;; rollback) stage_rollback ;;
  *) sed -n '2,24p' "$0"; exit 2 ;;
esac
