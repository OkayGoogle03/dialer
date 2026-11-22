# Direct browser-to-PBX calling (SIP over WSS + WebRTC) with Let's Encrypt

> New personal PBX: use `ops/pbx-new/README.md` (this guide explains the concepts and the checks).

Two connection modes coexist in the Dialer. The mode is chosen **per call server** (Call Servers → Transport):

| Mode | Transport values | Who does the SIP | Needs |
|---|---|---|---|
| **Windows desktop app** (existing, unchanged) | UDP / TCP / TLS | the SIP engine inside the Windows app, from the agent's own computer | the installed Windows app |
| **Direct browser-to-PBX** (new) | WSS (recommended) / WS (testing only) | the browser itself (JsSIP + WebRTC), straight to the PBX | a PBX that accepts SIP over WebSocket + a trusted certificate for a **host name** |

Nothing about the desktop app, its SIP engine, the call lists, the prefix handling or the agents' accounts changes. A call server is either one mode or the other; use two call server entries (for example `pbx-udp` and `pbx-wss`) if you want both for the same PBX.

This repository cannot see or change your PBX. Everything in sections 1–6 is done **on the PBX server**; section 7 is what to set in the Dialer. The examples are for Asterisk (also what FreePBX is built on); if you run something else, the same ideas apply with that product's settings.

## 0. How the pieces connect

```
Agent's browser ──HTTPS──▶ Dialer web app (Vercel; has its own certificate)
Agent's browser ──WSS (SIP)──▶ pbx.example.com:8089   ◀── needs ITS OWN Let's Encrypt certificate
Agent's browser ◀──SRTP audio (WebRTC, DTLS-SRTP, ICE)──▶ PBX  (UDP 10000-20000)  [or via TURN]
```

The website's certificate does **not** secure the PBX endpoint: the PBX needs its own certificate for its own host name.

## 1. Inspect the PBX first (read-only)

Run on the PBX, then keep the answers:

```bash
asterisk -rx "core show version"                      # Asterisk 16.2+ (18/20 recommended) for pjsip WebRTC
asterisk -rx "module show like websocket"             # res_http_websocket + res_pjsip_transport_websocket must be Running
asterisk -rx "module show like pjsip"                 # chan_pjsip stack (chan_sip's WebRTC support is legacy)
asterisk -rx "http show status"                       # is the HTTPS listener on? which port / cert?
asterisk -rx "pjsip show transports"                  # is there a WSS transport?
asterisk -rx "core show codecs" | grep -Ei "opus|ulaw|alaw|g722"
grep -nE "icesupport|stunaddr|rtpstart|rtpend" /etc/asterisk/rtp.conf
```

Browser-compatible audio needs **ulaw, alaw or opus** (browsers also speak G.722). G.729 and GSM do not work in a browser. DTLS-SRTP needs `res_srtp`, ICE needs `icesupport=yes`.

From **any other computer** you can then check what a browser would see:

```bash
node scripts/check-pbx-wss.mjs pbx.example.com 8089 /ws --origin https://your-dialer-site
```

It reports: DNS, whether the certificate is trusted and matches the name, days left, whether the WebSocket upgrade with the `sip` sub-protocol works, and whether the PBX answers SIP `OPTIONS` through it. (It checks signalling only; audio is proven by the test plan in section 8.)

## 2. DNS and firewall

* A DNS name for the PBX, e.g. `pbx.example.com` → the PBX's public IP. **A bare IP address cannot work**: Let's Encrypt does not issue certificates for IPs, and browsers reject a certificate that does not match the name.
* Open on the PBX firewall: `80/tcp` (only while issuing/renewing with the HTTP-01 challenge; or use the DNS-01 challenge and keep it closed), `8089/tcp` (WSS; or 443 if nothing else uses it), `10000-20000/udp` (RTP, must match `rtp.conf`), and `3478/udp+tcp`, `5349/tcp`, plus a relay range if you run TURN (section 6).
* PBX **behind NAT**: forward those ports and set `external_media_address` / `external_signaling_address` on the transport (and `local_net`).

## 3. Let's Encrypt certificate (Certbot)

```bash
sudo apt install certbot                         # or: sudo snap install --classic certbot
sudo certbot certonly --standalone -d pbx.example.com --preferred-challenges http
#   --standalone needs port 80 free for a few seconds; if a web server uses it, use --webroot -w /var/www/html instead.
#   No inbound port 80 at all? use a DNS challenge: --manual --preferred-challenges dns (or your DNS provider's certbot plugin for hands-free renewal).
```

### Installing the certificate for the PBX, and renewing without breaking calls

Certbot keeps the files in `/etc/letsencrypt/live/pbx.example.com/` (readable by root only). The PBX must not read that folder directly; a **deploy hook** copies the files with the right owner and permissions after every successful renewal and reloads only the PBX's web part:

```bash
sudo install -m 0755 ops/pbx/certbot-deploy-hook.sh /etc/letsencrypt/renewal-hooks/deploy/pbx-wss.sh
sudoedit /etc/letsencrypt/renewal-hooks/deploy/pbx-wss.sh     # set DOMAIN, KEYDIR, user/group, reload command
sudo certbot renew --dry-run                                  # must end with "Congratulations, all simulated renewals succeeded"
sudo certbot renew --force-renewal --deploy-hook /etc/letsencrypt/renewal-hooks/deploy/pbx-wss.sh   # once, to run the hook for real
```

The hook (`ops/pbx/certbot-deploy-hook.sh`): ignores certificates that are not the PBX's, copies `fullchain.pem`/`privkey.pem` to `/etc/asterisk/keys/pbx.crt` (`0640`) and `pbx.key` (`0600`) owned by `asterisk`, **refuses to install a certificate whose key does not match** (the old files stay in place), then runs `asterisk -rx "module reload http"` (no restart, calls are not dropped). Certbot's own systemd timer / cron entry runs `certbot renew` twice a day; renewal starts 30 days before expiry. Confirm the timer: `systemctl list-timers | grep certbot`.

## 4. PBX configuration (Asterisk, pjsip)

`/etc/asterisk/http.conf` (the HTTPS/WebSocket listener):

```ini
[general]
enabled=yes
bindaddr=0.0.0.0
tlsenable=yes
tlsbindaddr=0.0.0.0:8089
tlscertfile=/etc/asterisk/keys/pbx.crt
tlsprivatekey=/etc/asterisk/keys/pbx.key
```

`/etc/asterisk/pjsip.conf`: one WSS transport, and **one endpoint / auth / aor per agent** (each agent has their own extension, username and password; registrations and calls are independent):

```ini
[transport-wss]
type=transport
protocol=wss
bind=0.0.0.0

[webrtc-agent](!)                         ; template shared by all agents
type=endpoint
context=from-agents
disallow=all
allow=opus,ulaw,alaw
transport=transport-wss
webrtc=yes                                ; = use_avpf, media_encryption=dtls, ice_support, rtcp_mux, dtls auto cert, bundle
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes

[4002](webrtc-agent)                      ; one block set per agent
auth=4002
aors=4002
callerid="Agent 4002" <4002>
[4002]
type=auth
auth_type=userpass
username=4002
password=<a long random password, different for every agent>
[4002]
type=aor
max_contacts=2
remove_existing=yes
```

`/etc/asterisk/rtp.conf`: `icesupport=yes` and `stunaddr=stun.l.google.com:19302` (or your own STUN/TURN), and keep `rtpstart/rtpend` equal to the firewall range.

Security that is **separate** from the credentials: username/password authentication is always on; additionally, if every agent connects from known networks, restrict by source with `contact_acl` / `acl` on the endpoint or the firewall, and keep `fail2ban` for the PBX logs. Do not rely on an IP check alone: agents work from different networks and addresses change.

Then reload: `asterisk -rx "core reload"` (use `module reload res_pjsip.so` on a busy system) and run section 1's check again.

## 5. The Dialer side

1. **Call Servers → Edit**: *SIP server address* = `pbx.example.com` (the certificate's name, never the IP), *Transport* = **Direct browser-to-PBX: WSS**, *Port* = `8089`, *WebSocket path* = `/ws`, *Realm* = the PBX's SIP domain if it expects one.
2. **SIP accounts**: one per agent, SIP ID = the extension / username from the PBX, with that agent's password (stored encrypted; sent only to that agent's own signed-in browser after sign-in, never written to logs or shown in lists).
3. **STUN/TURN for browsers** (environment variables on the Dialer API host; defaults work for most networks):
   `WEBRTC_STUN_URLS` (default `stun:stun.l.google.com:19302`), `WEBRTC_TURN_URLS` + `WEBRTC_TURN_SECRET` (short-lived credentials per agent). The TURN user/credential are secrets: environment only, the config file refuses them.
4. The Softphone page shows the mode, extension, call server, connection state and call state, and (in this mode) a *Microphone and speaker* picker (speaker choice needs Chrome or Edge).

## 6. TURN (only if some agents cannot hear audio)

Strict corporate firewalls and symmetric NAT block direct media. Run `coturn` (`apt install coturn`) on a public host with `listening-port=3478`, `tls-listening-port=5349`, `realm=turn.example.com`, `lt-cred-mech`, `user=<name>:<secret>` and a Let's Encrypt certificate for `turn.example.com`, open `3478` and `5349` plus its relay port range, and put its URLs and the user/secret into the four variables above. (`turns:` over 5349/443 passes most firewalls.)

## 7. What was and was not changed in the Dialer

Unchanged: the Windows desktop app and its SIP engine, call lists, prefix logic, agent accounts, registration reporting, outcome rules, soft delete. New: the mode shown and chosen per call server, ICE servers (STUN/TURN) delivered with the softphone configuration, microphone/speaker selection, `scripts/check-pbx-wss.mjs`, `ops/pbx/certbot-deploy-hook.sh`, this guide.

## 8. Test plan (acceptance)

1. `node scripts/check-pbx-wss.mjs pbx.example.com 8089 /ws --origin https://<dialer-site>` → no FAIL lines; certificate "trusted", ≥ 15 days left.
2. Agent A (own extension) signs in from network 1: Softphone shows *Direct browser-to-PBX*, connection **Registered**. Agent B on network 2 (for example a phone hotspot) registers at the same time; both show Registered in Call Servers → SIP accounts.
3. A calls an outside number and B calls another at the same time: both have two-way audio and independent call states, call history and Excel results.
4. Incoming call to A's extension rings only A; answer, mute, hang up.
5. Disable the call server in Call Servers: within ~10 s both agents unregister and receive no calls; enable it: they register again.
6. `certbot renew --dry-run` succeeds; after a forced renewal (`--force-renewal`) the hook installs and reloads, `check-pbx-wss.mjs` still passes, a call in progress is not dropped, and a new registration works.
7. No audio one way for some agents → section 6 (TURN) and the RTP port range / `external_media_address` on a NAT'd PBX.

Not verified from this repository (needs your PBX and real agents): steps 2–7, DTLS-SRTP/ICE/codec negotiation, audio across different networks, and the certificate renewal on the live server.

---

# Addendum: real-PBX workflow (inspect first, change minimally, roll back cleanly)

## A. What is known and what is NOT known about your PBX (nothing is guessed)

| Item | Status |
|---|---|
| PBX software / version / operating system | **Unknown.** Nothing in this repository identifies the real PBX: the design documents mention Asterisk/Kamailio as the planned stack, but the project has only ever been tested against stubs (`docs/PROJECT_STATUS.md`: "No real PBX was available"). |
| Public IP, SIP ports, authentication, existing WSS/WebRTC, existing certificate / HTTPS | **Unknown** until the PBX is inspected. |
| Which server is "the PBX" | **Not decided.** This is a personal project with its own infrastructure. No address from any employer's / office network is part of it and none may be used, scanned or configured for it. The PBX for this project must be a server you own or rent for it (a VPS, a home server you control, or a new one set up for this purpose). |

So the first step is the read-only inspection below, run only on a server that belongs to this project. Do **not** apply any configuration from section 4 of this guide before its output has confirmed the product and version.

## B. Step 1: inspect the PBX (read-only, changes nothing)

On the PBX server, as root (copy the file there first):

```bash
sudo sh inspect-pbx.sh        # from ops/pbx/inspect-pbx.sh
```

It writes one report (mode 600) with: OS and version, which PBX product/version is installed (Asterisk, FreePBX, Issabel, FreeSWITCH, Kamailio, OpenSIPS, Vicidial), network addresses and the PBX's public IP as seen from outside (a difference means NAT), listening ports, firewall rules, fail2ban, Asterisk modules (pjsip / chan_sip / websocket / srtp), `http show status`, transports, endpoints, codecs, RTP settings, the configuration files (passwords masked), existing certificates, certbot and web server state, and the last SIP log lines. Send the report back; the exact commands and configuration for **your** product, version and ports are then written from it.

What the report decides:

| Finding | Consequence |
|---|---|
| Asterisk 16.2 or newer with `res_pjsip_transport_websocket`, `res_http_websocket`, `res_srtp` | WSS + WebRTC is supported: section 4 of this guide applies. |
| Asterisk with only `chan_sip` (no pjsip) | WSS is possible with chan_sip but legacy; adding pjsip alongside it is a bigger change: decide with the report in hand. |
| FreePBX / Issabel on top of Asterisk | Never edit the generated `pjsip.conf` / `http.conf` / `rtp.conf`: the web UI overwrites them. Use FreePBX's `*_custom.conf` files and its Advanced Settings (it has its own HTTPS and certificate manager that can also request Let's Encrypt). |
| FreeSWITCH, Kamailio, OpenSIPS, Vicidial, other | A different set of settings applies (for example FreeSWITCH `wss-binding` in the sofia profile). Report first. |
| PBX has only a private address (10.x / 172.16-31.x / 192.168.x) and no port forward | Browsers outside that network **cannot reach it**, WSS or not. You need a public IP with forwarded ports (below) or a VPN; see C. |

## C. Public reachability, DuckDNS and the certificate

* **Check the public IP**: the report prints the address seen from the internet. If it equals an address on the PBX's own interface, the PBX is directly public. If not, it is behind NAT: forward `8089/tcp` (WSS) and the RTP range `10000-20000/udp` on the router/firewall to the PBX, and set `external_media_address` / `external_signaling_address` + `local_net` on the Asterisk transport. **Forward only these; do not publish 5060 to the internet** (the Windows app's SIP stays on the internal network as today).
* **Hostname**: a free DuckDNS name (`your-pbx-name.duckdns.org`) is fine. Create it on duckdns.org and point it at the public IP. If that IP changes, `ops/pbx/duckdns-update.sh` (cron every 5 minutes, token in a root-only file) keeps it current.
* **Browsers on a public HTTPS site calling a private address**: if you decide to resolve the DuckDNS name to a *private* IP (agents only on the company network/VPN), Chrome and Edge treat this as a "local network" request and may show a permission prompt to connect to devices on the local network; agents must choose Allow, and it will not work from outside the network. A public IP avoids this.
* **Certificate (Certbot)**, two ways, pick by whether port 80 of the PBX is reachable from the internet:
  1. Port 80 reachable: `sudo certbot certonly --standalone -d your-pbx-name.duckdns.org` (section 3 of this guide).
  2. Port 80 not reachable / private address: **DNS-01 through DuckDNS**, with automatic renewal. Put the DuckDNS token in `/etc/duckdns.env` (root-only, one line `DUCKDNS_TOKEN=...`, mode 600), then:
     ```bash
     sudo install -m 0755 ops/pbx/duckdns-certbot-hook.sh /usr/local/sbin/duckdns-certbot-hook.sh
     sudo certbot certonly --manual --preferred-challenges dns -d your-pbx-name.duckdns.org \
          --manual-auth-hook "/usr/local/sbin/duckdns-certbot-hook.sh auth" \
          --manual-cleanup-hook "/usr/local/sbin/duckdns-certbot-hook.sh cleanup" --agree-tos -m you@example.com
     ```
  Then install the deploy hook (section 3) so renewals are copied with `asterisk`-owned `0640/0600` permissions and only the PBX HTTPS listener is reloaded; `sudo certbot renew --dry-run` must succeed.

## D. Change plan: minimal and reversible (apply only after step 1, and for Asterisk only if the report says so)

1. **Back up first** (this is also the rollback source):
   ```bash
   sudo tar czf /root/pbx-config-backup-$(date +%Y%m%d-%H%M).tgz /etc/asterisk /etc/letsencrypt 2>/dev/null
   sudo cp -a /etc/asterisk/http.conf /etc/asterisk/http.conf.before-wss
   ```
2. **Keep the existing SIP services untouched**: do not edit or delete the existing UDP/TCP transports, endpoints or trunks that the Windows application and the carriers use, and do not move them. WSS is an *additional* transport (`[transport-wss]`) and *additional* endpoints for browser agents (their own extensions, usernames and passwords, `webrtc=yes`). Put the new pjsip objects in a separate file (`/etc/asterisk/pjsip_wss.conf`) pulled in with one added line `#include pjsip_wss.conf` at the end of `pjsip.conf` (on FreePBX: `pjsip_custom.conf` / `pjsip.transports_custom.conf`). `http.conf` needs `tlsenable=yes`, `tlsbindaddr=0.0.0.0:8089` and the certificate paths (on FreePBX: Advanced Settings, Asterisk Builtin mini-HTTP, or `http_custom.conf`).
3. **Reload only what changed** (`module reload http`, `module reload res_pjsip.so`), never `core restart`; check `pjsip show transports` still lists the old transports, then `asterisk -rx "http show status"` shows TLS on 8089.
4. **Firewall**: add (never replace) `8089/tcp` and the RTP range `10000-20000/udp` (and `3478`/`5349` for TURN); restrict `8089/tcp` and agents' registrations by source address where agents have fixed networks, as an extra layer on top of the usernames and passwords.
5. **Verify from outside the network** (a phone on mobile data / another site): `node scripts/check-pbx-wss.mjs your-pbx-name.duckdns.org 8089 /ws --origin https://<your-vercel-site>` must show a trusted certificate, WebSocket upgrade and a SIP answer. Then in the Dialer set the call server to *Direct browser-to-PBX: WSS*, host = the DuckDNS name, port 8089, path `/ws`, and run the test plan (section 8), including a call from the Windows application **and** from a browser at the same time.

### Rollback (each step undoes only what it added)

| Undo | Command |
|---|---|
| New pjsip objects | remove the `#include pjsip_wss.conf` line (or the custom file), `asterisk -rx "module reload res_pjsip.so"` |
| TLS listener | `sudo cp -a /etc/asterisk/http.conf.before-wss /etc/asterisk/http.conf && asterisk -rx "module reload http"` |
| Everything in /etc/asterisk | `sudo tar xzf /root/pbx-config-backup-<stamp>.tgz -C /` then `asterisk -rx "core reload"` |
| Certificate and renewal | `sudo certbot delete --cert-name your-pbx-name.duckdns.org`; `sudo rm /etc/letsencrypt/renewal-hooks/deploy/pbx-wss.sh` |
| DuckDNS | `sudo rm /etc/cron.d/duckdns /usr/local/sbin/duckdns-update.sh /usr/local/sbin/duckdns-certbot-hook.sh /etc/duckdns.env` |
| Firewall | delete the rules you added (the exact commands you ran, with `-D` for iptables, `ufw delete`, or `firewall-cmd --remove-*`) |
| Dialer | set the call server back to its previous transport (UDP/TCP); the Windows application never changed |

## E. What stays on Vercel

Frontend, API and database access stay on Vercel and keep using Vercel-managed HTTPS. **No SIP or WebSocket server runs on Vercel**: the browser opens the WSS connection straight to the PBX; Vercel only serves the page and delivers each agent's own SIP settings after sign-in (password to that agent only, STUN/TURN from environment variables).
