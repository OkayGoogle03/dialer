# Deployment guide: personal PBX (Ubuntu VPS) + browser dialer on Vercel

> **Automated path:** `PRODUCTION.md` in this folder (one command, `deploy-remote.sh`, includes coturn, HTTP-01 certificates without a DuckDNS account, and a measured two-way audio test). This file is the manual, stage-by-stage version.

For beginners. Follow the stages in order, compare each result with **"You should see"**, and **stop at the first difference**. Read `AUDIT.md` once before you start.

## Ground rules for this deployment

* Use **only the new, personal VPS** and your own accounts (VPS provider, DuckDNS, Vercel). Nothing is run on any office computer, server or network, no existing PBX is touched, and the Windows System Application is not changed or involved.
* Every command in "On the server" is typed on the **VPS**. Every command in "On your PC" is typed on **your own PC** (PowerShell on Windows is fine).
* **Nothing is "working" until its test in stage 9 or 10 passes.** The "You should see" lines are what the scripts print (taken from the scripts' own messages) or what these programs normally print; a real server can differ slightly, which is exactly why you compare. Record each result in the acceptance table at the end.
* Do not paste passwords, the DuckDNS token or agent passwords into chat, tickets or git.

---

## 1. VPS specification

| Item | Minimum | Recommended | Why |
|---|---|---|---|
| CPU | 1 vCPU | 2 vCPU | Asterisk encrypts/decrypts every call's audio (browser side is encrypted) |
| RAM | 1 GB | 2 GB | Asterisk + fail2ban + certbot are light; 2 GB leaves headroom |
| Disk | 10 GB SSD | 20 GB SSD | OS + logs; no call recording is configured |
| Network | **Static public IPv4** | same | Browsers connect to it; a name points at it. IPv6-only does not work with this kit |
| Bandwidth | about 0.1 Mbit/s per simultaneous call, per direction | 5 Mbit/s up/down for ~10 calls | Audio always passes **through** the PBX (`direct_media=no`) |
| Location | Near most of your agents (and your SIP trunk provider, if any) | | Lower delay |
| Access | SSH with a key, root or a sudo user | | |
| Ports the provider must allow in ITS firewall / security group | `22/tcp`, `8089/tcp`, `10000-20000/udp` | | The server's own firewall is configured by the kit; the provider's is not |

Sizing is a starting point for a handful of agents; confirm with the real-call test in stage 10 (CPU and bandwidth while calls run).

## 2. Ubuntu version

**Ubuntu Server 24.04 LTS** (recommended: newer Asterisk, supported longest). **22.04 LTS** also works. Other systems are not supported by this kit. The Asterisk version is whatever Ubuntu publishes; you will check it in stage 4 before installing (it must be 16.2 or newer, the kit stops otherwise).

## 3. Files to upload (exactly these)

From your PC, the repository folder `ops` (the whole folder, it is small). You need all of it because the scripts call each other by relative path:

```
ops/pbx/certbot-deploy-hook.sh        renewal hook (copies + reloads + verifies the certificate)
ops/pbx/duckdns-update.sh             keeps the DuckDNS name pointing at the server
ops/pbx/duckdns-certbot-hook.sh       Let's Encrypt DNS-01 validation through DuckDNS
ops/pbx/inspect-pbx.sh                read-only inspection (optional)
ops/pbx-new/pbx-setup.sh              the staged installer
ops/pbx-new/add-agent.sh              creates one agent extension
ops/pbx-new/add-trunk.sh              optional phone-network trunk
ops/pbx-new/README.md  AUDIT.md  DEPLOY.md  TRUNKS.md
ops/pbx-new/test/kit-sandbox.sh       regression test of the scripts in a scratch folder (optional; run it on your PC or the server before the stages)
```

Not uploaded: everything else in the repository (the web app runs on Vercel). `scripts/check-pbx-wss.mjs` is run **on your PC**, not on the server.

---

## Stage 0: accounts and decisions (on your PC, in a browser)

1. **VPS**: create a server with the specification above (Ubuntu 24.04), add your SSH public key. Write down its **public IP**. In the provider's firewall / security group allow inbound `22/tcp`, `8089/tcp`, `10000-20000/udp`.
2. **DuckDNS**: on duckdns.org sign in, choose a name (for example `my-pbx-name`), click *add domain*, set its IP to the VPS public IP, and copy your **token** (shown at the top of the page). Your host name is `my-pbx-name.duckdns.org`.
3. **E-mail** for Let's Encrypt notices.
4. Decide whether you need real phone numbers (needs a paid SIP trunk from a provider; skip it for now if you only test agent-to-agent).

## Stage 1: SSH key and first login (on your PC)

If you have no SSH key yet:

```powershell
ssh-keygen -t ed25519 -C "personal-pbx"
```
You should see: `Your public key has been saved in C:\Users\<you>\.ssh\id_ed25519.pub`. Paste the content of that `.pub` file into the VPS provider's "SSH key" field when creating the server.

```powershell
ssh root@YOUR_VPS_IP          # some providers use ubuntu@YOUR_VPS_IP instead of root@
```
You should see: a prompt like `root@your-host:~#` (or `ubuntu@...$`). If it says `Permission denied (publickey)`, the key was not added to the server: fix that first.

## Stage 2: prepare the server (on the server)

```bash
# 2.1 system update
apt update && apt -y upgrade
# 2.2 a normal user for daily work (replace deploy with any name)
adduser deploy
usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
# 2.3 restart if the update asked for it
[ -f /var/run/reboot-required ] && reboot
```
You should see: `adduser` asks for a password (choose a long one) and some optional details (press Enter). After a reboot, reconnect with `ssh deploy@YOUR_VPS_IP`. Check:

```bash
lsb_release -d
sudo -v && echo sudo-works
```
You should see: `Description: Ubuntu 24.04.x LTS` (or 22.04.x) and `sudo-works`.

Keep **this** SSH session open and open a **second** terminal with a second `ssh deploy@YOUR_VPS_IP` before the firewall stage, so a mistake cannot lock you out.

## Stage 3: upload the files (on your PC, in the repository folder)

```powershell
scp -r ops deploy@YOUR_VPS_IP:~/
```
You should see: a list of the 12 files with 100% each. Then on the server:

```bash
cd ~/ops/pbx-new && ls
grep -c $'\r' pbx-setup.sh add-agent.sh add-trunk.sh ../pbx/*.sh
```
You should see the script names (`AUDIT.md DEPLOY.md README.md add-agent.sh add-trunk.sh pbx-setup.sh`) and **`0`** for every file in the second command. If any number is not `0` the files have Windows line endings: fix with `sed -i 's/\r$//' pbx-setup.sh add-agent.sh add-trunk.sh ../pbx/*.sh`.

## Stage 4: settings file and read-only preflight (on the server)

Create the settings (replace the three values; the token is the one from duckdns.org):

```bash
sudo sh -c 'umask 077; cat > /etc/pbx-setup.env' <<'EOF'
DOMAIN=my-pbx-name.duckdns.org
EMAIL=you@example.com
DUCKDNS_TOKEN=paste-your-token-here
CERTBOT_STAGING=1
# Outgoing calls through a phone-network trunk: NOTHING leaves until you allow destinations. A number must START with one of these
# digit prefixes (comma separated). Agent-to-agent calls (3-5 digit extensions) are not affected. Example for India + USA/Canada:
#ALLOW_PREFIXES=91,1
#DENY_PREFIXES=1900,91900
# Addresses fail2ban must never ban (your own fixed addresses, space separated). Set it BEFORE running the harden stage.
#FAIL2BAN_IGNORE="203.0.113.7"
EOF
sudo chown root:root /etc/pbx-setup.env && sudo chmod 600 /etc/pbx-setup.env && sudo ls -l /etc/pbx-setup.env
```
You should see: `-rw------- 1 root root ... /etc/pbx-setup.env`. (`CERTBOT_STAGING=1` makes the first certificate a **practice** one; stage 7 switches to the real one.) The file is read as plain `KEY=VALUE` lines and never executed; only the names listed in the header of `pbx-setup.sh` are accepted, and a wrong value (for example letters in `ALLOW_PREFIXES`) stops the script with a clear message.

Check what Ubuntu will install, then run the read-only check:

```bash
apt-cache policy asterisk | head -3
sudo sh pbx-setup.sh preflight
```
You should see: `Candidate:` with an Asterisk version (it must be 16.2 or higher; typically 18.x on 22.04 and 20.x on 24.04). The preflight prints the OS (`supported release`), the server's addresses, `Public IP as seen from the internet: <your VPS IP>` and either `the server has its public address directly (no NAT)` or `...it is behind NAT (typical for cloud VMs)`. Both are fine: the kit handles NAT. It must also say `none of 8089 / 8088 / 5060 / 443 / 80` for ports already in use. If a port is in use by another program, stop and ask.

## Stage 5: install, DNS, certificate (on the server)

```bash
sudo sh pbx-setup.sh install
```
You should see (the last line): `OK: WebSocket, PJSIP, SRTP and RTP modules are present. Next: dns, certificate, configure.` and before it `Installed: Asterisk <version>`. A message that the version is too old or that modules are missing means **stop**.

```bash
sudo sh pbx-setup.sh dns
```
You should see: `DuckDNS updated. Waiting for DNS ...` then `my-pbx-name.duckdns.org -> <your VPS IP>` with no `WARNING`. If it says the name resolves to something else, fix the IP on duckdns.org and wait a minute before continuing.

```bash
sudo sh pbx-setup.sh certificate
```
You should see (this takes about 1-2 minutes because of a 60 second DNS wait): certbot's `Successfully received certificate.`, then `OK: 'certbot renew --dry-run' succeeded (automatic renewal will work)` and `certbot renewal timer: active`. Because staging is on, this is a **practice** certificate: browsers will not trust it yet; that is expected. Common errors: `DuckDNS TXT update failed` (wrong token) or a certbot DNS error (name not created on duckdns.org).

## Stage 6: configure, harden, firewall (on the server)

```bash
sudo sh pbx-setup.sh configure
```
You should see: `Snapshot of /etc/asterisk saved: /var/lib/pbx-setup/snapshots/etc-asterisk-<time>.tgz`, then, if `ALLOW_PREFIXES` is not set, `NOTE: ALLOW_PREFIXES is not set: every outgoing trunk call will be refused until you set it ...` (this is the safe default, not an error), then `OK: WSS listener on 8089 and transport-wss are active. Next: harden, firewall, add agents ...`. If it prints `FAILED: ...` it has already removed its own changes; read `/var/log/asterisk/full` and ask before retrying.

```bash
sudo sh pbx-setup.sh harden
```
You should see: `OK: jail pbx-asterisk is active (also active by default on Ubuntu: the sshd jail)`. The jail bans an address after **8 failed SIP logins within 10 minutes** for 1 hour. The Dialer softphone itself no longer retries a rejected password (it tries once per page load and again only when the saved settings change), so legitimate agents cause at most one failure each time they open the page; addresses you listed in `FAIL2BAN_IGNORE` are never banned. Check with `sudo fail2ban-client status pbx-asterisk`; unban an address with `sudo fail2ban-client set pbx-asterisk unbanip <address>`.

Make sure the **second SSH session is open**, then:

```bash
sudo sh pbx-setup.sh firewall          # prints the plan, changes nothing
sudo sh pbx-setup.sh firewall --yes    # applies it
sudo ufw status numbered
```
You should see in the plan: `limit 22/tcp`, `allow 8089/tcp`, `allow 10000:20000/udp`, and the note that 5060 is not opened. After `--yes`: `Status: active` and rules for those ports. **Now confirm in a NEW terminal that `ssh deploy@YOUR_VPS_IP` still works** before closing the old one.

```bash
sudo sh pbx-setup.sh status
```
You should see: Asterisk version, `http show status` mentioning port `8089`, `transport-wss` in the transports, and under the two certificate headings **the same `serial=` value on disk and served**.

## Stage 7: switch to the real certificate (on the server)

```bash
sudo certbot delete --cert-name my-pbx-name.duckdns.org
sudo sed -i '/^CERTBOT_STAGING=/d' /etc/pbx-setup.env
sudo sh pbx-setup.sh certificate
sudo sh pbx-setup.sh status
```
You should see: `Successfully received certificate.` again, **without** the staging notice, and in `status` the same `serial=` for the file and the served certificate. Reload the listener once so Asterisk serves the real certificate: `sudo asterisk -rx "module reload http"` and run `status` again; the two serials must match. (If they do not, run `sudo asterisk -rx "core restart when convenient"` and check once more.)

## Stage 8: create the SIP extensions for the agents (on the server, then in the Dialer)

### 8a. On the PBX: one extension per agent

```bash
cd ~/ops/pbx-new
sudo sh add-agent.sh 4001 "Asha Verma"
sudo sh add-agent.sh 4002 "Ravi Kumar"
sudo asterisk -rx "pjsip show endpoints" | head
```
You should see, for each agent: `Agent added. Enter these in the Dialer ...`, then `SIP ID / username : 4001`, `SIP password      : <24 random characters>` (shown **once**: copy it now into your password manager), and `call server : host = your PBX host name, transport WSS, port 8089, path /ws`. `pjsip show endpoints` lists `4001` and `4002` as `Unavailable` (not registered yet). Optional extra protection for an agent on a fixed address: `sudo sh add-agent.sh 4003 "Name" --allow-ip 203.0.113.0/24`. Remove an agent: `sudo sh add-agent.sh --remove 4002`.

### 8b. In the Dialer (a browser, signed in as an administrator)

1. **Users**: make sure each agent has their own Dialer user with role *Agent* (permission `calls:make`).
2. **Call Servers → Add call server**, fill exactly:

   | Field | Value |
   |---|---|
   | Server name | `Personal PBX` |
   | SIP server address (IP or host name) | `my-pbx-name.duckdns.org` (the **name**, never the IP: the certificate is for the name) |
   | Transport | **Direct browser-to-PBX: WSS (secure WebSocket + WebRTC, recommended)** |
   | SIP / WebSocket port | `8089` |
   | WebSocket path | `/ws` |
   | SIP domain / realm | leave empty |
   | The rest | leave the defaults |

   Save, then click **Activate** on the new row (new servers start as "pending configuration"). You should see a green `active` status and the Connection mode `Direct browser-to-PBX`.
3. **SIP accounts (agent softphones) → Add SIP account**, once per agent: Agent = that user, Call server = `Personal PBX`, SIP ID = the extension (`4001`), SIP password = the password printed in 8a, display name optional. You should see the account listed (registration shows `unknown` until the agent opens the Softphone).

## Stage 9: verify the endpoint from OUTSIDE (on your PC, a different network from the VPS)

Needs Node.js 22 on your PC and the repository folder.

```powershell
node scripts/check-pbx-wss.mjs my-pbx-name.duckdns.org 8089 /ws --origin https://YOUR-VERCEL-SITE
```
You should see these lines and **no `FAIL`**:

```
OK    DNS my-pbx-name.duckdns.org -> <your VPS IP>
OK    Certificate is trusted (issuer: Let's Encrypt)
OK    Certificate matches my-pbx-name.duckdns.org
OK    Certificate valid until ... (about 89 days left)
OK    WebSocket upgrade accepted on /ws
OK    Sec-WebSocket-Accept is correct
OK    PBX selected the "sip" sub-protocol
OK    SIP over WebSocket works: PBX answered "SIP/2.0 ..."
Signalling looks ready for Direct browser-to-PBX calling. ...
```
Meaning: `Certificate NOT trusted` = you are still on the practice certificate (go back to stage 7) or the name does not match; `TLS connection ... timed out` = the provider firewall or ufw blocks 8089/tcp; `WebSocket upgrade refused` = http/WSS settings (`status`). **This proves signalling only, not audio.**

## Stage 10: audio tests (two agents, two networks)

Register: on two different networks (for example your home Wi-Fi laptop, and a phone on mobile data or a laptop on a phone hotspot), sign in to the Dialer as two different agent users and open **Softphone**. Allow the microphone when the browser asks.

**Test A, registration.** Each Softphone page shows *Mode: Direct browser-to-PBX*, its extension, `Connection: Registered`. On the server: `sudo asterisk -rx "pjsip show contacts"` lists both `4001` and `4002` with `Avail`. If one shows `Registration failed`: wrong SIP password (re-enter it in the Dialer), or the certificate is not trusted (stage 7), or port 8089 blocked.

**Before Test B: the ring limit.** The Softphone cancels an outgoing call that has rung for `RING_TIMEOUT_SECONDS` (the repository default is **5 seconds**). That is far too short for a person to pick up, so Test B would fail with "No answer within 5 s". Set `RING_TIMEOUT_SECONDS=45` in the Vercel environment (section 6; this is a production setting and needs your approval) and redeploy before this test.

**Test B, one call with two-way audio.** On agent 1's Softphone, type `4002` and press Call. Agent 2's page shows *Incoming call*; press Answer. Both people speak and listen. Pass = each hears the other clearly, and *Mute* works. Hang up from either side. If you hear nothing or one way: stage 6 firewall / provider firewall for `10000-20000/udp`, NAT (see `AUDIT.md` section 3), or TURN (`docs/pbx-wss-letsencrypt.md` section 6).

**Test C, two calls at the same time.** You need four browsers (agents 4001-4004: add two more with `add-agent.sh` and the Dialer): start `4001 -> 4002` and, while it is running, `4003 -> 4004`. Pass = both calls have audio at once and hanging up one does not affect the other. With only two agents and a trunk: have each agent call a different mobile phone at the same time instead. While calls run, `sudo asterisk -rx "core show channels"` should list the active channels and `top` should show CPU well below 100%.

**Test D, a wrong password is refused, once, and not retried.** Temporarily save a wrong SIP password for a test account in the Dialer and open the Softphone: it must show `Registration rejected (401 Unauthorized): the SIP username or password is wrong ...`; `sudo tail -n 20 /var/log/asterisk/security_log` shows **one** `ChallengeResponseFailed` for that attempt, and **no more** appear while you wait two minutes (the softphone does not retry). Then restore the right password in the Dialer and reload the Softphone page: it registers. (Do not repeat the wrong password more than a few times from your own address: after 8 failures in 10 minutes fail2ban bans it.)

**Test E, destination restrictions.** With `ALLOW_PREFIXES` set and a trunk added, an agent dialling a number that does not start with an allowed prefix (or starts with a denied one, or has fewer than 6 digits) gets a refused call (SIP 403): the call list row / recent call shows Not success. With `ALLOW_PREFIXES` empty, every trunk number is refused. Agent-to-agent calls still work. `sudo asterisk -rx "dialplan show to-trunk"` shows the rules in force.

## Stage 11: verify certificate renewal (on the server)

```bash
sudo certbot certificates
sudo certbot renew --dry-run
systemctl list-timers | grep -i certbot
```
You should see: your certificate with `VALID: ... days`, `Congratulations, all simulated renewals succeeded`, and a `certbot.timer` entry with a next run time. Then test the real renewal once, with the hook (this is what proves Asterisk picks the new certificate up; it replaces the certificate, which is safe because the hook verifies it):

```bash
sudo certbot renew --force-renewal
sudo sh ~/ops/pbx-new/pbx-setup.sh status
```
You should see: `pbx-wss: certificate for my-pbx-name.duckdns.org installed, reloaded and verified (serial=...)` and in `status` the same `serial=` for the file and the served certificate, **a different serial than before**. If instead you see `Asterisk is still serving ...`, run the command it prints, then check again; do not rely on automatic renewal until this passes. Do not force-renew more than a couple of times (Let's Encrypt rate limits).

---

## 6. Vercel environment variables (Project → Settings → Environment Variables)

The Vercel project, build and deployment already exist (see `docs/deployment.md`); nothing in the web app needs a PBX address: it is typed into the Dialer (stage 8b) and delivered to each signed-in agent.

| Variable | Value | Needed | Note |
|---|---|---|---|
| `DB_API_PASSWORD` | from `pnpm db:setup-roles` | yes | secret |
| `DB_PLATFORM_PASSWORD` | from `pnpm db:setup-roles` | yes | secret |
| `JWT_ACCESS_SECRET` | `pnpm secrets:generate` | yes | secret |
| `CREDENTIALS_ENCRYPTION_KEY` | `pnpm secrets:generate` | yes | secret; **never change it**: stored SIP passwords are encrypted with it |
| `DB_HOST`, `DB_NAME`, `DB_USER_PREFIX` | your production database | yes (or fill the `production` section of `config/app.config.json`) | not secret |
| `ENABLE_EXPERIMENTAL_COREPACK` | `1` | yes | uses the pinned pnpm |
| `RING_TIMEOUT_SECONDS` | `45` (repository default `5`, range 1-120) | **yes for real calls** | how long an outgoing call may ring before the Softphone cancels it; 5 s cannot work with people or phone numbers. Production setting: **not changed by me, needs your approval**; it is the same for everyone in the deployment |
| `DEFAULT_SIP_TRANSPORT` | `wss` (repository default `udp`) | recommended | only used when an Excel call list names a server that does not exist yet (it is then created with this transport). Create the WSS call server first (stage 8b) and use its **host name** in the Excel, and this never matters |
| `WEBRTC_STUN_URLS` | default `stun:stun.l.google.com:19302` | no | change only if you run your own STUN |
| `WEBRTC_TURN_URLS` + `WEBRTC_TURN_SECRET` | your coturn server (`pbx-setup.sh turn` installs it and prints the values) | recommended for real internet use | the secret is shared with coturn; the API derives **short-lived** credentials per agent (`WEBRTC_TURN_TTL_SECONDS`, default 86400, range 300 to 604800). `WEBRTC_TURN_URLS` without the secret is refused at startup; fixed TURN passwords are not supported |

Before the first agent signs in on the production site, run from your own PC (owner credentials stay on your PC, never in Vercel), in this order, with the production database named in your local `.env`: `pnpm db:migrate` (migrations up to 0012 must be applied: the code expects them), then `pnpm db:setup-roles` (creates the two runtime database users with the passwords from your local `.env`), then create the first company and administrator: `PROVISION_ADMIN_PASSWORD=<a strong password> pnpm --filter @dialer/api provision -- --slug <company-id> --name "<Company name>" --email <admin e-mail> --admin-name "<Admin name>"` (type the password without saving it in shell history). Redeploy after changing variables. Until `DB_HOST`, `DB_NAME` and `DB_USER_PREFIX` are set for production the API answers `503` and names the missing settings: that is expected.

## 7. Frontend configuration

There is **no frontend environment variable or code change** for the PBX. The only configuration is the Call Server entry in stage 8b. The page is https (Vercel), the PBX address is `wss://my-pbx-name.duckdns.org:8089/ws`, which the Softphone page displays under the connection summary once an agent is signed in. If your browser blocks the page from opening it: the certificate is not trusted yet, or the call server is set to the unencrypted `WS` transport (an https page may only open `wss://`, and the site's Content-Security-Policy allows only `wss:` for WebSocket connections, so `WS` is blocked by design; use WSS).

**Security headers.** `vercel.json` now sends, for the whole site: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: microphone=(self), camera=(), geolocation=(), payment=(), usb=()`, `Strict-Transport-Security: max-age=31536000`, `Cross-Origin-Opener-Policy: same-origin`; and for the pages (not `/api`) a Content-Security-Policy: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self' wss:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`. Scripts can only come from the site itself, so an injected script could neither load nor send a stolen SIP password to another server over fetch (WebSockets may go to any `wss:` host, which is needed because the PBX address is a setting). `style-src 'unsafe-inline'` is required by the page's inline styles. Tested here in a real browser against the production build with these exact headers: all nine screens load and work, and a `ws://` connection is blocked. Not tested here: the headers on Vercel itself (check the response headers of your site after the first deployment, for example with your browser's network tab).

## 8. Node.js API integration (what the Vercel API provides; nothing to code)

* **No SIP or WebSocket server runs on Vercel.** The Vercel function only stores settings and hands each signed-in agent their own settings. The browser connects to the PBX directly.
* `GET /api/v1/softphone/config` (permission `calls:make`): returns the agent's own account(s) with the SIP password, the call server (`host`, `port`, `transport`, `webrtcUrl`, `connectionMode`) and `iceServers`. Only the owner receives their password (decrypted from the AES-GCM store); it is never logged or shown in lists.
* `GET /api/v1/softphone/active` (every 10 s per open Softphone): when an admin disables the call server the agent unregisters within seconds. Plan note: one open Softphone tab is about 6 requests per minute (about 63,000 per month for an 8 h day, 22 days). Check your Vercel plan limits; Hobby is for non-commercial use only.
* **Rate limiting.** Requests with a valid sign-in token are now counted **per user**, everything else (login attempts, bad tokens) **per client address**. Before, everything was per address, so about ten agents behind one shared address would have used up the 60 requests/minute allowed for `softphone/active` and started getting `429`. A made-up or forged token cannot choose another user's counter (the token is verified, not just read). Limits stay per running function instance on Vercel (not shared between instances). Still to verify on the first deployment: that the address Vercel reports to the API is the visitor's real address (the API trusts one proxy hop); if it were Vercel's own, every anonymous visitor would share one counter for login attempts.
* `POST /api/v1/softphone/registration`, `POST/PATCH /api/v1/softphone/calls`: record registration state and call history.
* Administration (permission `call_servers:manage`): `POST /api/v1/call-servers` (`{ "name", "host", "port": 8089, "sipTransport": "wss", "sipWsPath": "/ws" }`, then `PUT /api/v1/call-servers/{id}` with `{ "status": "active" }`) and `POST /api/v1/softphone-accounts` (`{ "userId", "callServerId", "sipId", "password" }`). The Dialer pages do exactly this.

## 9. Acceptance record (fill in; only a PASS counts as working)

| Check | Result (PASS / FAIL, date) |
|---|---|
| Preflight and install (stage 4-5) | |
| DuckDNS resolves to the VPS IP | |
| Practice certificate issued, `renew --dry-run` OK | |
| `configure` OK, `status` shows 8089 + transport-wss | |
| Real certificate, served serial = file serial | |
| Firewall applied, new SSH login still works | |
| `check-pbx-wss.mjs` from another network: no FAIL | |
| Test A: two agents Registered from two networks | |
| Test B: one call, audio both ways, mute works | |
| Test C: two simultaneous calls with audio | |
| Test D: wrong password refused once, not retried, one log line | |
| Test E: disallowed destination refused, allowed one works (needs a trunk) | |
| `RING_TIMEOUT_SECONDS` raised (approved) before Test B | |
| Forced renewal: new certificate served, calls still work | |

## 10. Rollback

Everything the kit added can be removed: see the rollback table at the end of `README.md` (`sudo sh pbx-setup.sh rollback`, `add-agent.sh --remove`, `add-trunk.sh --remove`, restore a snapshot from `/var/lib/pbx-setup/snapshots/`). In the Dialer, set the call server back to its previous transport or delete it. The Windows System Application is not part of any of this.
