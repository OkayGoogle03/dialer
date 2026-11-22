#!/usr/bin/env bash
# Deploys the PBX kit to a NEW Ubuntu 22.04 / 24.04 server over SSH and validates it from this machine.
# Run from the repository root with Git Bash (Windows), WSL, Linux or macOS. Needs: ssh, tar, and Node.js 22 for the checks.
#
#   ops/pbx-new/deploy-remote.sh ubuntu@203.0.113.5 [-i ~/.ssh/key] [--domain pbx.example.org] [--email you@example.org]
#                                [--allow-prefixes 91,1] [--agents "4001 4002"] [--staging] [--skip-install] [--no-validate] [--dry-run]
#
# What it does (all stages of pbx-setup.sh, non-interactive):
#   1. checks SSH + sudo, uploads ops/ (no secrets are in it)
#   2. writes /etc/pbx-setup.env on the server (root only). Without --domain the name is <ip with dashes>.sslip.io (free, no account) and the
#      certificate uses HTTP-01 on port 80; with a DuckDNS name put DUCKDNS_TOKEN in .deploy/pbx.env (see below), then DNS-01 is used
#   3. runs  pbx-setup.sh all : install, certificate, configure, TURN (coturn), fail2ban, monitoring timer, firewall (SSH allowed first), health, status
#   4. creates the agents; their passwords go to .deploy/agents.env (mode 600, git-ignored), never to the screen or the repository
#   5. reads the TURN secret into .deploy/turn-secret (mode 600) for the API environment (WEBRTC_TURN_SECRET)
#   6. validates from HERE (a different network from the server): DNS, certificate, WebSocket SIP (scripts/check-pbx-wss.mjs)
#      and, when scripts/e2e-audio/node_modules exists, a real two-way audio test with two temporary agents (also through the TURN relay)
# Extra settings (optional) in .deploy/pbx.env as KEY=VALUE lines: DUCKDNS_TOKEN, CERT_MODE, SSH_PORT, MAX_OUTBOUND, MAX_PER_AGENT, MAX_CALL_SECONDS,
#   DENY_PREFIXES, RTP_START, RTP_END, ALERT_URL
# Safe to run again on the same server (every stage is idempotent). If it stops half way see "Recovery" in ops/pbx-new/PRODUCTION.md.
# ufw rate-limits SSH (6 new connections per 30 s per address), so once the firewall is on this script makes only a few connections.
# Nothing is committed or published by this script. --dry-run prints the remote commands instead of running them.
set -euo pipefail

target=""; key=""; domain=""; email=""; allow=""; agents="4001 4002"; staging=0; dry=0; skipinst=0; novalidate=0
while [ $# -gt 0 ]; do case "$1" in
  -i) key="${2:?}"; shift 2 ;; --domain) domain="${2:?}"; shift 2 ;; --email) email="${2:?}"; shift 2 ;; --allow-prefixes) allow="${2:?}"; shift 2 ;;
  --agents) agents="${2:?}"; shift 2 ;; --staging) staging=1; shift ;; --dry-run) dry=1; shift ;; --skip-install) skipinst=1; shift ;; --no-validate) novalidate=1; shift ;;
  -*) echo "unknown option $1" >&2; exit 2 ;; *) target="$1"; shift ;; esac; done
[ -n "$target" ] || { sed -n '2,24p' "$0"; exit 2; }

# --- everything below ends up inside remote shell commands or config files: accept plain values only
bad() { echo "invalid $1" >&2; exit 2; }
printf '%s' "$target" | grep -Eq '^([A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$' || bad "target (user@host)"
[ -z "$key" ] || [ -r "$key" ] || bad "key file (not readable)"
[ -z "$domain" ] || printf '%s' "$domain" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' || bad "--domain (lower-case host name)"
[ -z "$email" ] || printf '%s' "$email" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' || bad "--email"
[ -z "$allow" ] || printf '%s' "$allow" | grep -Eq '^[0-9]+(,[0-9]+)*$' || bad "--allow-prefixes (digits separated by commas)"
for e in $agents; do printf '%s' "$e" | grep -Eq '^[0-9]{3,5}$' || bad "--agents (3-5 digit extensions separated by spaces)"; done

host="${target#*@}"; mkdir -p .deploy; chmod 700 .deploy
[ -f .deploy/pbx.env ] && chmod 600 .deploy/pbx.env
extra=""; [ -f .deploy/pbx.env ] && extra="$(grep -E '^(DUCKDNS_TOKEN|CERT_MODE|SSH_PORT|MAX_OUTBOUND|MAX_PER_AGENT|MAX_CALL_SECONDS|DENY_PREFIXES|RTP_START|RTP_END|ALERT_URL)=' .deploy/pbx.env || true)"

if [ -z "$domain" ]; then
  printf '%s' "$host" | grep -Eq '^[0-9]+(\.[0-9]+){3}$' || { echo "give --domain, or a numeric IP as the host so an sslip.io name can be derived" >&2; exit 2; }
  domain="$(printf '%s' "$host" | tr . -).sslip.io"
fi
[ -n "$email" ] || email="$(git config user.email 2>/dev/null || true)"
[ -n "$email" ] || { echo "give --email (Let's Encrypt sends expiry notices there)" >&2; exit 2; }
printf '%s' "$email" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' || bad "email"

sshopt=(-o StrictHostKeyChecking=accept-new -o ServerAliveInterval=20 -o ConnectTimeout=20); [ -n "$key" ] && sshopt+=(-i "$key")
r() { if [ "$dry" = 1 ]; then printf 'DRY-RUN ssh %s: %s\n' "$target" "$*"; else ssh "${sshopt[@]}" "$target" "$@"; fi; }
step() { printf '\n== %s\n' "$*"; }
have_e2e=0; [ -d scripts/e2e-audio/node_modules ] && have_e2e=1

step "1. SSH and sudo"
r 'sudo -n true && echo "sudo works without a password" && . /etc/os-release && echo "$PRETTY_NAME $(uname -m)"'

if [ "$skipinst" = 1 ]; then echo "(--skip-install: steps 2-4 skipped)"; else
step "2. upload the kit"
if [ "$dry" = 1 ]; then echo "DRY-RUN: tar czf - ops | ssh $target 'mkdir -p ~/pbx-kit && tar xzf - -C ~/pbx-kit'  (an existing ~/pbx-kit/ops is replaced, nothing else is touched)"
else tar czf - ops | ssh "${sshopt[@]}" "$target" 'rm -rf ~/pbx-kit/ops && mkdir -p ~/pbx-kit && tar xzf - -C ~/pbx-kit && find ~/pbx-kit -name "*.sh" -exec sed -i "s/\r$//" {} +'; fi

step "3. settings on the server (root only)"
envfile="DOMAIN=$domain
EMAIL=$email"
[ "$staging" = 1 ] && envfile="$envfile
CERTBOT_STAGING=1"
[ -n "$allow" ] && envfile="$envfile
ALLOW_PREFIXES=$allow"
[ -n "$extra" ] && envfile="$envfile
$extra"
if [ "$dry" = 1 ]; then echo "DRY-RUN: would write /etc/pbx-setup.env with DOMAIN=$domain EMAIL=$email (token and other secrets not shown); an existing file is kept as /etc/pbx-setup.env.bak"
else printf '%s\n' "$envfile" | ssh "${sshopt[@]}" "$target" 'sudo sh -c "umask 077; [ -f /etc/pbx-setup.env ] && cp -a /etc/pbx-setup.env /etc/pbx-setup.env.bak; cat > /etc/pbx-setup.env" && sudo chown root:root /etc/pbx-setup.env && sudo chmod 600 /etc/pbx-setup.env'; fi

step "4. install and configure everything (pbx-setup.sh all)"
r "cd ~/pbx-kit/ops/pbx-new && sudo sh pbx-setup.sh all"
fi

step "5. agents, TURN secret and (for the audio test) two temporary agents: ONE connection (ufw limits new SSH connections)"
: > .deploy/agents.env; chmod 600 .deploy/agents.env
list="$agents"; [ "$have_e2e" = 1 ] && list="$agents 4991 4992"
if [ "$dry" = 1 ]; then echo "DRY-RUN: add-agent.sh for: $list; read /var/lib/pbx-setup/turn-secret"; out=""
else
  out="$(ssh "${sshopt[@]}" "$target" "sh -s" <<EOF
cd ~/pbx-kit/ops/pbx-new
for e in $list; do
  o="\$(sudo sh add-agent.sh "\$e" "Agent \$e" 2>&1 </dev/null)" || { echo "FAILED \$e"; continue; }
  pw="\$(printf '%s\n' "\$o" | awk -F': ' '/SIP password/{print \$2}' | tr -d ' \r')"
  echo "AGENT \$e \$pw"
done
echo "TURNSECRET \$(sudo cat /var/lib/pbx-setup/turn-secret)"
EOF
)"
fi
tp4991=""; tp4992=""; secret=""
while read -r kind a b; do case "$kind" in
  AGENT) case "$a" in 4991) tp4991="$b" ;; 4992) tp4992="$b" ;; *) printf 'SIP_%s=%s\n' "$a" "$b" >> .deploy/agents.env; echo "agent $a created (password saved in .deploy/agents.env)" ;; esac ;;
  FAILED) echo "could not create agent $a (already exists? remove it with add-agent.sh --remove $a)" >&2 ;;
  TURNSECRET) secret="$a" ;; esac; done <<< "$out"
if [ "$dry" != 1 ]; then ( umask 077; printf '%s' "$secret" > .deploy/turn-secret ); chmod 600 .deploy/turn-secret; [ -n "$secret" ] || { echo "no TURN secret returned" >&2; exit 1; }; echo "TURN secret saved to .deploy/turn-secret (not printed)"; fi
cat <<EOF
Set these in the Dialer API environment (Vercel -> Settings -> Environment Variables), then redeploy:
  WEBRTC_TURN_URLS=turn:$domain:3478?transport=udp,turn:$domain:3478?transport=tcp,turns:$domain:5349?transport=tcp
  WEBRTC_TURN_SECRET=<content of .deploy/turn-secret>
  RING_TIMEOUT_SECONDS=45
In the Dialer: Call Servers -> add  host=$domain  transport=WSS  port=8089  path=/ws, Activate, then one SIP account per agent (SIP ID + password from .deploy/agents.env),
or run scripts/dialer-add-pbx.mjs.
EOF

step "6. validate from here (another network than the server)"
if [ "$dry" = 1 ]; then echo "DRY-RUN: node scripts/check-pbx-wss.mjs $domain 8089 /ws ; audio test direct + through TURN"; exit 0; fi
if [ "$novalidate" = 1 ]; then echo "validation skipped (--no-validate)"; [ -z "$tp4991" ] || ssh "${sshopt[@]}" "$target" "cd ~/pbx-kit/ops/pbx-new && sudo sh add-agent.sh --remove 4991 >/dev/null; sudo sh add-agent.sh --remove 4992 >/dev/null" || true; exit 0; fi
node scripts/check-pbx-wss.mjs "$domain" 8089 /ws || { echo "SIGNALLING CHECK FAILED" >&2; exit 1; }
rc=0
if [ "$have_e2e" = 1 ] && [ -n "$tp4991" ] && [ -n "$tp4992" ]; then
  ( cd scripts/e2e-audio
    echo "-- audio, direct path"
    A_EXT=4991 B_EXT=4992 A_PW="$tp4991" B_PW="$tp4992" PBX_WSS="wss://$domain:8089/ws" node run.mjs p2p
    echo "-- audio, through the TURN relay only"
    A_EXT=4991 B_EXT=4992 A_PW="$tp4991" B_PW="$tp4992" PBX_WSS="wss://$domain:8089/ws" TURN_URL="turn:$domain:3478?transport=udp" TURN_SECRET="$secret" FORCE_RELAY=1 node run.mjs p2p ) || rc=1
  ssh "${sshopt[@]}" "$target" "cd ~/pbx-kit/ops/pbx-new && sudo sh add-agent.sh --remove 4991 >/dev/null; sudo sh add-agent.sh --remove 4992 >/dev/null" || true
  [ "$rc" = 0 ] || { echo "AUDIO TEST FAILED" >&2; exit 1; }
else echo "audio test skipped: run  (cd scripts/e2e-audio && npm install)  once, then deploy again, or run the tests by hand (scripts/e2e-audio/README.md)"; fi
echo; echo "Deployment finished. Still to do by hand: set the API variables above, add the call server in the Dialer, and make one real call from a phone on mobile data."
