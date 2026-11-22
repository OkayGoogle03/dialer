#!/bin/sh
# READ-ONLY inspection of the PBX server. It changes nothing, installs nothing and restarts nothing.
# Run it ON the PBX (as root so it can read the configuration):   sudo sh inspect-pbx.sh
# It writes one report file (mode 600) in the current folder. Passwords / secrets / keys are masked, but still read the file before
# you share it, then send it back so the WSS + WebRTC configuration can be written for what is ACTUALLY installed.
OUT="pbx-inspection-$(hostname 2>/dev/null || echo host)-$(date +%Y%m%d-%H%M%S).txt"
umask 077
: > "$OUT"

section() { printf '\n==================== %s ====================\n' "$1" >> "$OUT"; }
run() { printf '\n$ %s\n' "$*" >> "$OUT"; sh -c "$*" >> "$OUT" 2>&1 || printf '(exit status %s)\n' "$?" >> "$OUT"; }
# print a config file with credentials masked
show() { [ -r "$1" ] || { printf '\n# %s: not present / not readable\n' "$1" >> "$OUT"; return; }
  printf '\n# %s\n' "$1" >> "$OUT"
  sed -E 's/^([[:space:]]*(password|secret|md5_cred|auth_token|tlsprivatekey_pass|pass)[[:space:]]*[=>]+[[:space:]]*).*/\1*****MASKED*****/I' "$1" >> "$OUT" 2>&1; }

section "1. Operating system and hardware"
run 'cat /etc/os-release'
run 'uname -a'
run 'uptime'
run 'hostname -f 2>/dev/null || hostname'

section "2. PBX software and version (nothing is assumed: every common product is asked)"
run 'command -v asterisk && asterisk -V'
run 'command -v asterisk >/dev/null && asterisk -rx "core show version"'
run 'command -v fwconsole && fwconsole --version'           # FreePBX
run 'ls -d /etc/issabel* /etc/elastix* /usr/local/vicidial* /etc/freeswitch* /etc/kamailio* /etc/opensips* 2>/dev/null'
run 'command -v fs_cli && fs_cli -x "version"'             # FreeSWITCH
run 'command -v kamailio && kamailio -V | head -3'
run 'command -v opensips && opensips -V | head -3'
run 'rpm -qa 2>/dev/null | grep -Ei "asterisk|freepbx|issabel|freeswitch|kamailio|opensips|vicidial|coturn" | sort'
run 'dpkg -l 2>/dev/null | grep -Ei "asterisk|freepbx|freeswitch|kamailio|opensips|coturn|certbot" | cut -c1-120'
run 'ps -eo pid,user,comm,args | grep -Ei "[a]sterisk|[f]reeswitch|[k]amailio|[o]pensips|[a]pache|[h]ttpd|[n]ginx|[c]oturn" | cut -c1-170'

section "3. Network: addresses, public IP, listening ports, firewall"
run 'ip -4 addr show 2>/dev/null || ifconfig'
run 'ip route 2>/dev/null | head -5'
# public address as seen from outside (compare with the addresses above: if they differ the PBX is behind NAT)
run 'curl -s -m 5 https://api.ipify.org || wget -qO- -T 5 https://api.ipify.org'
run 'ss -lntup 2>/dev/null || netstat -lntup'
run 'iptables -S 2>/dev/null | head -80'
run 'nft list ruleset 2>/dev/null | head -120'
run 'command -v ufw >/dev/null && ufw status verbose'
run 'command -v firewall-cmd >/dev/null && firewall-cmd --list-all'
run 'systemctl is-active fail2ban 2>/dev/null; command -v fail2ban-client >/dev/null && fail2ban-client status'

section "4. Asterisk: SIP stack, transports, WebSocket / WebRTC support, codecs (skipped if Asterisk is not installed)"
if command -v asterisk >/dev/null 2>&1; then
  run 'asterisk -rx "module show like pjsip" | head -60'
  run 'asterisk -rx "module show like chan_sip"'
  run 'asterisk -rx "module show like websocket"'
  run 'asterisk -rx "module show like srtp"'
  run 'asterisk -rx "module show like http"'
  run 'asterisk -rx "http show status"'
  run 'asterisk -rx "pjsip show transports"'
  run 'asterisk -rx "pjsip show endpoints" | head -60'
  run 'asterisk -rx "sip show settings" | head -40'
  run 'asterisk -rx "sip show peers" | head -30'
  run 'asterisk -rx "core show codecs"'
  run 'asterisk -rx "rtp show settings"'
  run 'asterisk -rx "core show settings" | head -40'
fi

section "5. Configuration files (credentials masked)"
for f in /etc/asterisk/http.conf /etc/asterisk/rtp.conf /etc/asterisk/pjsip.conf /etc/asterisk/pjsip_custom.conf \
         /etc/asterisk/pjsip.transports_custom.conf /etc/asterisk/pjsip.endpoint_custom.conf /etc/asterisk/http_custom.conf \
         /etc/asterisk/sip.conf /etc/asterisk/sip_general_custom.conf /etc/asterisk/modules.conf; do show "$f"; done
run 'ls -la /etc/asterisk | head -80'
run 'ls -la /etc/asterisk/keys 2>/dev/null'

section "6. Existing certificates and HTTPS / web server"
run 'command -v certbot && certbot --version'
run 'certbot certificates 2>/dev/null'
run 'ls -la /etc/letsencrypt/live 2>/dev/null'
run 'systemctl list-timers 2>/dev/null | grep -i certbot'
run 'crontab -l 2>/dev/null | grep -i certbot; grep -ri certbot /etc/cron.d /etc/cron.daily 2>/dev/null | head'
run 'for c in /etc/asterisk/keys/*.crt /etc/asterisk/keys/*.pem /etc/pki/tls/certs/localhost.crt /etc/ssl/certs/ssl-cert-snakeoil.pem; do [ -f "$c" ] && { echo "--- $c"; openssl x509 -in "$c" -noout -subject -issuer -dates 2>&1; }; done'
run 'ls /etc/httpd/conf.d/*.conf /etc/apache2/sites-enabled/* /etc/nginx/conf.d/* 2>/dev/null'
run 'grep -rhE "^[[:space:]]*(Listen|ServerName|SSLCertificateFile)" /etc/httpd /etc/apache2 2>/dev/null | head -20'

section "7. Recent SIP activity (who connects, from where: addresses only, last 40 lines)"
run 'tail -n 40 /var/log/asterisk/full 2>/dev/null | cut -c1-200'

printf '\nReport written to %s (mode 600). Review it (it should contain no passwords), then send it back.\n' "$OUT"
printf '\nReport written to: %s\n' "$OUT"
