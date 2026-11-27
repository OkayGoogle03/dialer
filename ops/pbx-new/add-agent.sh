#!/bin/sh
# Adds ONE browser agent to the PBX: its own extension, SIP username and a generated strong password, as separate pjsip objects.
# Existing agents and every other part of the PBX are not touched. The password is shown once; enter it in the Dialer
# (Call Servers -> SIP accounts). Run as root on the PBX:
#
#   sudo sh add-agent.sh 4001 "Asha Verma"                             # extension 4001
#   sudo sh add-agent.sh 4002 "Ravi Kumar" --allow-ip 203.0.113.0/24   # PBX-side source-IP restriction for this agent (optional)
#   sudo sh add-agent.sh --remove 4002                                 # removes that agent
#
# --allow-ip is a SECOND layer next to the password: the PBX then only accepts that agent's signalling from the given address/network
# (a named ACL in acl.conf referenced by the endpoint; check it on your version with:  asterisk -rx "pjsip show endpoint <ext>" | grep -i acl).
# Use it only for agents that work from a fixed address; people on mobile data or changing networks should rely on the password alone.
set -eu
ETC="${ASTERISK_ETC:-/etc/asterisk}"
F="$ETC/pjsip_agents.conf"
ACLF="$ETC/acl_agents.conf"   # per-agent source-IP rules (named ACLs, referenced by the endpoint with acl=)
[ -f "$F" ] || { echo "pjsip_agents.conf not found: run 'pbx-setup.sh configure' first" >&2; exit 1; }

drop_block() { # drop_block <file> <marker word> <ext>: removes the block that starts with "; <marker> <ext>" up to the next "; <marker> " line
  [ -f "$1" ] || return 0
  awk -v m="; $2 $3" -v pre="; $2 " '$0==m {skip=1; next} skip && index($0, pre)==1 {skip=0} !skip {print}' "$1" > "$1.tmp" && cat "$1.tmp" > "$1" && rm -f "$1.tmp"
}
# core reload is only needed when an ACL (acl.conf) changed; otherwise reloading PJSIP is enough and touches nothing else
reload_all() { command -v asterisk >/dev/null 2>&1 || return 0; [ "${1:-}" != acl ] || asterisk -rx "core reload" >/dev/null; asterisk -rx "module reload res_pjsip.so" >/dev/null; }

if [ "${1:-}" = "--remove" ]; then
  ext="${2:?usage: add-agent.sh --remove <extension>}"
  grep -q "^; agent $ext\$" "$F" || { echo "agent $ext not found"; exit 1; }
  cp -a "$F" "$F.before-remove-$ext"
  had_acl=""; grep -q "^; acl $ext$" "$ACLF" 2>/dev/null && had_acl=acl
  drop_block "$F" agent "$ext"; drop_block "$ACLF" acl "$ext"
  reload_all "$had_acl"
  echo "agent $ext removed (previous file kept as $F.before-remove-$ext)"; exit 0
fi

ext="${1:?usage: add-agent.sh <extension 3-5 digits> \"Display Name\" [--allow-ip CIDR]}"
name="${2:-Agent $ext}"; shift 2 || true
allow=""
while [ $# -gt 0 ]; do case "$1" in --allow-ip) allow="${2:?--allow-ip needs a value}"; shift 2 ;; *) echo "unknown option $1" >&2; exit 2 ;; esac; done
printf '%s' "$ext" | grep -Eq '^[0-9]{3,5}$' || { echo "extension must be 3-5 digits" >&2; exit 2; }
printf '%s' "$name" | grep -Eq '^[A-Za-z0-9 ._-]{1,40}$' || { echo "display name: letters, digits, space . _ - only (max 40)" >&2; exit 2; }
[ -z "$allow" ] || printf '%s' "$allow" | grep -Eq '^[0-9a-fA-F:.]+(/[0-9]{1,3})?$' || { echo "--allow-ip must be an address or CIDR, for example 203.0.113.7 or 203.0.113.0/24" >&2; exit 2; }
grep -q "^; agent $ext\$" "$F" && { echo "agent $ext already exists (remove it first with --remove)" >&2; exit 1; }
# the extension must not collide with an object that already exists elsewhere in the PBX
if command -v asterisk >/dev/null 2>&1 && asterisk -rx "pjsip show endpoints" | grep -Eq "Endpoint: +$ext( |/)"; then echo "an endpoint named $ext already exists in the PBX" >&2; exit 1; fi

pw="$(head -c 24 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-24)"
dtls="$(cat "${PBX_STATE:-/var/lib/pbx-setup}/dtls_auto" 2>/dev/null || true)"
cp -a "$F" "$F.before-add-$ext"

if [ -n "$allow" ]; then
  # named ACL: our own file, included once from acl.conf (the original acl.conf is kept as acl.conf.before-pbx-setup)
  touch "$ETC/acl.conf"
  grep -qF "#include acl_agents.conf" "$ETC/acl.conf" || {
    [ -f "$ETC/acl.conf.before-pbx-setup" ] || cp -a "$ETC/acl.conf" "$ETC/acl.conf.before-pbx-setup"
    printf '\n; added by pbx-setup\n#include acl_agents.conf\n' >> "$ETC/acl.conf"; }
  [ -f "$ACLF" ] || : > "$ACLF"
  printf '\n; acl %s\n[acl-%s]\ndeny=0.0.0.0/0.0.0.0\npermit=%s\n' "$ext" "$ext" "$allow" >> "$ACLF"
  chmod 640 "$ACLF"; chown asterisk:asterisk "$ACLF" 2>/dev/null || true
fi

{
  printf '\n; agent %s\n' "$ext"
  cat <<EOF
[$ext]
type=endpoint
context=from-agents
disallow=all
allow=ulaw,alaw,g722
transport=transport-wss
auth=$ext
aors=$ext
callerid="$name" <$ext>
webrtc=yes
$dtls
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
EOF
  [ -z "$allow" ] || printf 'acl=acl-%s\n' "$ext"
  cat <<EOF

[$ext]
type=auth
auth_type=userpass
username=$ext
password=$pw

[$ext]
type=aor
max_contacts=5
remove_existing=yes
EOF
} >> "$F"
chmod 640 "$F"; chown asterisk:asterisk "$F" 2>/dev/null || true

if command -v asterisk >/dev/null 2>&1; then
  if [ -n "$allow" ]; then reload_all acl; else reload_all; fi
  sleep 1
  if ! asterisk -rx "pjsip show endpoint $ext" | grep -q "Endpoint:  *$ext"; then
    echo "The PBX did not load the new endpoint: restoring the previous files." >&2
    cp -a "$F.before-add-$ext" "$F"; drop_block "$ACLF" acl "$ext"; reload_all acl; exit 1
  fi
fi
cat <<EOF

Agent added.  Enter these in the Dialer (Call Servers -> SIP accounts -> Add SIP account). The password is shown ONLY now:
  SIP ID / username : $ext
  SIP password      : $pw
  call server       : host = your PBX host name, transport WSS, port 8089, path /ws
EOF
