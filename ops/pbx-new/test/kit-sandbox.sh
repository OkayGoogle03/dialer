#!/bin/sh
# Regression test of the kit in a scratch folder: nothing outside it is touched, no Asterisk or root is needed.
# Usage: sh ops/pbx-new/test/kit-sandbox.sh   (prints PASS/FAIL lines, exit status 1 if anything failed)
set -u
export MSYS_NO_PATHCONV=1
KIT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "${TEMP:-}" ] && command -v cygpath >/dev/null 2>&1; then W="$(cygpath -u "$TEMP")/kit-sandbox"; else W="${TMPDIR:-/tmp}/kit-sandbox"; fi
rm -rf "$W" 2>/dev/null; mkdir -p "$W/etc/keys" "$W/state" "$W/f2b"
: > "$W/etc/keys/pbx.crt"; : > "$W/etc/keys/pbx.key"
printf '[general]\nenabled=yes\nbindaddr=0.0.0.0\n\n[other]\nx=1\n' > "$W/etc/http.conf"
printf '[general]\nrtpstart=12000\n' > "$W/etc/rtp.conf"
printf '[logfiles]\nconsole => notice\n' > "$W/etc/logger.conf"
printf '; p\n' > "$W/etc/pjsip.conf"; printf '[general]\n' > "$W/etc/extensions.conf"; printf '; acl\n' > "$W/etc/acl.conf"
cp "$W/etc/http.conf" "$W/orig-http.conf"; cp "$W/etc/rtp.conf" "$W/orig-rtp.conf"; cp "$W/etc/logger.conf" "$W/orig-logger.conf"
cp "$W/etc/pjsip.conf" "$W/orig-pjsip.conf"; cp "$W/etc/extensions.conf" "$W/orig-ext.conf"; cp "$W/etc/acl.conf" "$W/orig-acl.conf"
printf 'DOMAIN=test-pbx.duckdns.org\nEMAIL=me@example.com\nDUCKDNS_TOKEN=abcdefabcdefabcdefab1234\nALLOW_PREFIXES=91,1\nDENY_PREFIXES=1900\nFAIL2BAN_IGNORE="203.0.113.7"\n' > "$W/env"
export ENV_FILE="$W/env" ASTERISK_ETC="$W/etc" PBX_STATE="$W/state" F2B_DIR="$W/f2b"
pass=0; fail=0
check() { if [ "$2" = "0" ]; then echo "PASS  $1"; pass=$((pass+1)); else echo "FAIL  $1"; fail=$((fail+1)); fi; }

DRY_RUN=1 sh $KIT/pbx-setup.sh configure >/dev/null 2>&1; check "configure writes all files" $?
DRY_RUN=1 sh $KIT/pbx-setup.sh configure >/dev/null 2>&1; check "configure is idempotent (second run ok)" $?
[ "$(grep -c '#include http_dialer.conf' "$W/etc/http.conf")" = 1 ]; check "http include appears once" $?
awk '/^\[general\]/{g=1} g&&/#include http_dialer.conf/{inc=NR} /^\[other\]/{o=NR} END{exit !(inc && o && inc<o)}' "$W/etc/http.conf"; check "http include is inside [general], before [other]" $?
awk '/^bindaddr/{b=NR} /#include http_dialer.conf/{i=NR} END{exit !(b<i)}' "$W/etc/http.conf"; check "our include comes AFTER the packaged bindaddr line (ours wins)" $?
grep -q 'REGEX("^(91|1)"' "$W/etc/extensions_dialer.conf"; check "dial plan has the allow-list" $?
grep -q 'REGEX("^(1900)"' "$W/etc/extensions_dialer.conf"; check "dial plan has the deny-list" $?
grep -q 'Hangup(21)' "$W/etc/extensions_dialer.conf" && grep -q 'Hangup(34)' "$W/etc/extensions_dialer.conf"; check "refusals end with cause 21 / 34" $?
DRY_RUN=1 sh $KIT/pbx-setup.sh harden >/dev/null 2>&1; check "harden writes jail + filter + logger include" $?
grep -q '^ignoreip = 127.0.0.1/8 ::1 203.0.113.7' "$W/f2b/jail.d/pbx-asterisk.local"; check "FAIL2BAN_IGNORE reaches the jail" $?
grep -q '^maxretry = 8' "$W/f2b/jail.d/pbx-asterisk.local"; check "jail threshold is 8" $?

unset DRY_RUN
sh $KIT/add-agent.sh 4001 "Asha Verma" >/dev/null 2>&1; check "add agent 4001" $?
sh $KIT/add-agent.sh 4002 "Ravi Kumar" --allow-ip 203.0.113.0/24 >/dev/null 2>&1; check "add agent 4002 with source restriction" $?
grep -q 'acl=acl-4002' "$W/etc/pjsip_agents.conf" && grep -q 'permit=203.0.113.0/24' "$W/etc/acl_agents.conf"; check "ACL generated for 4002" $?
sh $KIT/add-agent.sh 4001 "dup" >/dev/null 2>&1; [ $? -ne 0 ]; check "duplicate extension refused" $?
sh $KIT/add-agent.sh 4003 "bad;name" >/dev/null 2>&1; [ $? -ne 0 ]; check "invalid name refused" $?
for n in 4001 4002; do awk -v n="$n" '$0=="[" n "]"{c++} END{exit !(c==3)}' "$W/etc/pjsip_agents.conf"; check "agent $n has endpoint + auth + aor" $?; done
pw1="$(awk '/^\[4001\]/{s=1} s&&/^password=/{print $0; exit}' "$W/etc/pjsip_agents.conf" | cut -d= -f2)"; pw2="$(awk '/^\[4002\]/{s=1} s&&/^password=/{print $0; exit}' "$W/etc/pjsip_agents.conf" | cut -d= -f2)"
[ -n "$pw1" ] && [ "$pw1" != "$pw2" ] && [ ${#pw1} -ge 20 ]; check "each agent has its own long random password" $?
TRUNK_PASSWORD=sandbox-only sh $KIT/add-trunk.sh --host sip.provider.example --user u1 --inbound-ext 4001 >/dev/null 2>&1; check "add trunk (registration)" $?
sh $KIT/add-trunk.sh --host sip.other.example --user u2 --inbound-ext 4001 </dev/null >/dev/null 2>&1; [ $? -ne 0 ]; check "second trunk refused (documented limit)" $?
sh $KIT/add-agent.sh --remove 4002 >/dev/null 2>&1; check "remove agent 4002" $?
! grep -q 'acl-4002' "$W/etc/acl_agents.conf" "$W/etc/pjsip_agents.conf"; check "agent 4002 and its ACL are gone" $?

export DRY_RUN=1
printf 'n\n' | sh $KIT/pbx-setup.sh rollback >/dev/null 2>&1; check "rollback runs" $?
for f in http rtp logger pjsip; do cmp -s "$W/etc/$f.conf" "$W/orig-$f.conf"; check "rollback restored $f.conf byte-identical" $?; done
cmp -s "$W/etc/extensions.conf" "$W/orig-ext.conf"; check "rollback restored extensions.conf byte-identical" $?
cmp -s "$W/etc/acl.conf" "$W/orig-acl.conf"; check "rollback restored acl.conf byte-identical" $?
[ ! -e "$W/f2b/jail.d/pbx-asterisk.local" ]; check "rollback removed the fail2ban jail" $?
echo "---- $pass passed, $fail failed"
[ "$fail" = 0 ]
