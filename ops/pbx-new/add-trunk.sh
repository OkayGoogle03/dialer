#!/bin/sh
# Connects the PBX to the phone network through a SIP trunk from YOUR provider (a paid service; the provider gives you the values).
# Outgoing: agents dial a number of 6+ digits (or +E.164) -> it leaves through this trunk.
# Incoming: calls the provider sends to your number ring one agent extension of your choice.
# Run as root on the PBX, after 'pbx-setup.sh configure':
#
#   sudo TRUNK_PASSWORD='provider-password' sh add-trunk.sh --host sip.provider.example --user 1234567 --inbound-ext 4001
#   sudo sh add-trunk.sh --host sip.provider.example --user 1234567 --inbound-ext 4001     # asks for the password without showing it
#   sudo sh add-trunk.sh --host sip.provider.example --ip-auth --inbound-ext 4001          # provider authenticates by your server's IP (no registration)
#   sudo sh add-trunk.sh --remove
#
# Nothing here is guessed: HOST / USER / PASSWORD / authentication style come from your provider's welcome e-mail or portal.
# Some providers need extras (a specific codec, a port other than 5060, a prefix on the dialled number): set STRIP_PREFIX in
# /etc/pbx-setup.env (digits removed from the front of the dialled number) and re-run 'pbx-setup.sh configure'.
set -eu
ETC="${ASTERISK_ETC:-/etc/asterisk}"
T="$ETC/pjsip_trunk.conf"; IN="$ETC/extensions_trunk_in.conf"
[ -f "$T" ] || { echo "run 'pbx-setup.sh configure' first" >&2; exit 1; }
reload_all() { command -v asterisk >/dev/null 2>&1 || return 0; asterisk -rx "module reload res_pjsip.so" >/dev/null; asterisk -rx "dialplan reload" >/dev/null; }

if [ "${1:-}" = "--remove" ]; then
  cp -a "$T" "$T.before-remove"; cp -a "$IN" "$IN.before-remove"
  printf '; phone-network trunk (add-trunk.sh)\n' > "$T"; printf '; inbound calls from the trunk (add-trunk.sh)\n' > "$IN"
  reload_all; echo "trunk removed (previous files kept as *.before-remove)"; exit 0
fi

host=""; user=""; inbound=""; ipauth=0
while [ $# -gt 0 ]; do case "$1" in
  --host) host="${2:?}"; shift 2 ;; --user) user="${2:?}"; shift 2 ;; --inbound-ext) inbound="${2:?}"; shift 2 ;; --ip-auth) ipauth=1; shift ;;
  *) echo "unknown option $1" >&2; exit 2 ;; esac; done
[ -n "$host" ] && [ -n "$inbound" ] || { echo "usage: add-trunk.sh --host <provider host> [--user <name>] --inbound-ext <extension> [--ip-auth]" >&2; exit 2; }
printf '%s' "$host" | grep -Eq '^[A-Za-z0-9.-]+$' || { echo "invalid --host" >&2; exit 2; }
printf '%s' "$inbound" | grep -Eq '^[0-9]{3,5}$' || { echo "--inbound-ext must be an agent extension (3-5 digits)" >&2; exit 2; }
if [ "$ipauth" = 0 ]; then
  [ -n "$user" ] || { echo "--user is required unless --ip-auth" >&2; exit 2; }
  printf '%s' "$user" | grep -Eq '^[A-Za-z0-9._@+-]+$' || { echo "invalid --user" >&2; exit 2; }
  pw="${TRUNK_PASSWORD:-}"
  if [ -z "$pw" ]; then printf 'Provider password (not shown): '; trap 'stty echo 2>/dev/null || true' EXIT INT TERM; stty -echo 2>/dev/null || true; read -r pw; stty echo 2>/dev/null || true; echo; fi
  [ -n "$pw" ] || { echo "empty password" >&2; exit 2; }
  printf '%s' "$pw" | grep -q '[[:space:]]' && { echo "the password contains spaces: edit $T by hand instead" >&2; exit 2; }
fi
if grep -q '^\[trunk-out\]' "$T"; then echo "a trunk already exists: run 'add-trunk.sh --remove' first" >&2; exit 1; fi
cp -a "$T" "$T.before-add"; cp -a "$IN" "$IN.before-add"

{
  if [ "$ipauth" = 0 ]; then cat <<EOF

[trunk-auth]
type=auth
auth_type=userpass
username=$user
password=$pw

[trunk-reg]
type=registration
outbound_auth=trunk-auth
server_uri=sip:$host
client_uri=sip:$user@$host
retry_interval=60
expiration=3600
EOF
  fi
  cat <<EOF

[trunk-aor]
type=aor
contact=sip:$host

[trunk-out]
type=endpoint
transport=transport-udp
context=from-trunk
disallow=all
allow=ulaw,alaw
aors=trunk-aor
direct_media=no
rtp_symmetric=yes
force_rport=yes
EOF
  [ "$ipauth" = 1 ] || printf 'outbound_auth=trunk-auth\nfrom_user=%s\nfrom_domain=%s\n' "$user" "$host"
  cat <<EOF

[trunk-identify]
type=identify
endpoint=trunk-out
match=$host
EOF
} > "$T"
cat > "$IN" <<EOF
; inbound calls from the trunk (add-trunk.sh): they ring extension $inbound
[from-trunk]
exten => trunk-enabled,1,NoOp(marker used by the outbound route)
exten => _X.,1,NoOp(inbound call to \${EXTEN} from \${CALLERID(num)})
 same => n,Dial(PJSIP/$inbound,40)
 same => n,Hangup()
exten => _+X.,1,Goto(from-trunk,\${EXTEN:1},1)
EOF
chmod 640 "$T" "$IN"; chown asterisk:asterisk "$T" "$IN" 2>/dev/null || true
reload_all
if command -v asterisk >/dev/null 2>&1; then
  sleep 3
  asterisk -rx "pjsip show endpoint trunk-out" | grep -q "Endpoint:  *trunk-out" || { echo "The PBX did not load the trunk: restoring the previous files." >&2; cp -a "$T.before-add" "$T"; cp -a "$IN.before-add" "$IN"; reload_all; exit 1; }
  echo "Trunk loaded. Registration state (should become 'Registered' within a minute):"; asterisk -rx "pjsip show registrations"
fi
echo "Test: from a registered browser agent dial a mobile number; from a mobile call your trunk number and extension $inbound should ring."
