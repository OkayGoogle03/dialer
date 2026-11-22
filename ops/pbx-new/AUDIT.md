# Pre-deployment audit of the new-PBX kit (`ops/pbx-new`, `ops/pbx`)

Scope: every script and generated configuration in the kit, plus the browser (Dialer) side that talks to it. **Nothing was executed against a live server, and no office address or infrastructure was used.** The scripts were checked by reading them against Asterisk / Ubuntu behaviour, by `sh -n`, and by running the file generation in a scratch folder (`DRY_RUN`, `ASTERISK_ETC`, `PBX_STATE`, `F2B_DIR` overrides). Anything that needs a real Ubuntu server, Asterisk, DuckDNS, Let's Encrypt or a browser call is listed in section 3.

## 1. Bugs found and fixed

| # | Area | Bug | Fix |
|---|---|---|---|
| 1 | PJSIP / WebRTC | `external_media_address` / `external_signaling_address` / `local_net` were only on the UDP transport. The SDP media address comes from the **endpoint's** transport (`transport-wss`), so a NAT'd server (typical cloud VM) would advertise its private address: connected, no audio. | NAT settings are written on **both** transports. |
| 2 | ICE | No ICE host-candidate mapping for a NAT'd server. | `rtp_ice_dialer.conf` with `[ice_host_candidates]` (private => public) is generated when NAT is detected. |
| 3 | Config includes | `http.conf` / `rtp.conf` got a **second** `[general]` section through `#include`. Asterisk reads only the first `[general]` of a file, so the TLS listener and RTP settings would have been silently ignored. | The include line is now placed **inside** the existing `[general]` (or a new one), and the included files contain no header. Verified: rollback returns the files byte-identical to the original. |
| 4 | Certificate permissions | The deploy hook ran with `umask 077` and used `mkdir -p`, so a new `/etc/asterisk/keys` became `root:root 0700` and Asterisk could not read the certificate. | `install -d -o asterisk -g asterisk -m 0750` in the hook and in the certificate stage; certificate `0640`, key `0600`, both owned by `asterisk`. |
| 5 | Renewal | After renewal the hook never checked that Asterisk really serves the new certificate; a reload that does not re-read the file would leave the old certificate to expire. | The hook compares the served certificate serial (via `openssl s_client` on localhost) with the new one and **fails loudly** (exit 1, exact next command) if they differ. `pbx-setup.sh status` shows both serials. |
| 6 | DTLS-SRTP | The `dtls_auto_generate_cert` option was only written if a help query succeeded; `webrtc=yes` gives DTLS but no certificate, so a failed query would have meant no media. | Always written (the kit requires Asterisk >= 16.2, which has it); `add-agent.sh` still verifies that the endpoint loads and restores the file if not. |
| 7 | Secrets in process list | DuckDNS token was in the `curl` command line (visible in `ps`). | Both DuckDNS scripts pass the URL to curl through `-K -` on stdin. The validation string and domain are format-checked before use. |
| 8 | DuckDNS DNS-01 | 40 s wait was short for DuckDNS's 60 s TTL. | 60 s. |
| 9 | Settings file | The env file is sourced as shell with the token in it, with no permission check, and values reached `sh -c` strings. | The script refuses an env file that is not `root:root 0600`; DOMAIN, EMAIL, DuckDNS token and all numbers are validated with strict patterns. |
| 10 | Firewall / SSH | Only the default port 22 was allowed; a non-default sshd port would have been locked out by `ufw enable`. No SSH rate limit; default policies not set. | Every port `sshd -T` reports is allowed first with `ufw limit` (6 connections / 30 s per address); `default deny incoming`, `default allow outgoing`; plan printed, applied only with `--yes`. |
| 11 | Brute force | Nothing protected SIP registration from password guessing. | New `harden` stage: Asterisk security log + a **fail2ban jail with its own filter** (the stock filter may not recognise the WS/WSS transport names), 5 failures / 10 min => 1 hour ban, localhost ignored, SSH jail left on. Agent passwords are random (about 140 bits). |
| 12 | Toll fraud | Any registered agent could place unlimited calls through the trunk. | The dial plan limits concurrent outgoing trunk calls (`MAX_OUTBOUND`, default 5). |
| 13 | Rollback / backup | Only the first original of each file was kept; the rollback computed its timestamp twice (could split across a minute); it did not undo the logger / fail2ban / ACL changes. | A timestamped `.tgz` **snapshot of /etc/asterisk** before `configure` (mode 600) in addition to `<file>.before-pbx-setup`; one timestamp; rollback also removes the logger include, ACL include and fail2ban files, and prints how to restore the snapshot. |
| 14 | Install | `universe` (where Asterisk lives) might be disabled on a minimal image; Asterisk start was not awaited; module list missed `res_pjsip_session`; an existing `chan_sip` could hold port 5060. | Universe is enabled if needed, startup is awaited, module list completed, `chan_sip` conflict is reported with the exact fix. |
| 15 | Safety | `configure` could be run on a PBX that already has transports with the same names or a program on 8089. | It stops with a message instead of continuing. |
| 16 | Agents | ACL added with `--allow-ip` required `core reload` for every change; the trunk password prompt could leave the terminal with echo off. | `core reload` only when an ACL changed; terminal restored on exit. README now recommends the hidden prompt instead of the password on the command line. |

## 2. Review result per area

| # | Area | Result |
|---|---|---|
| 1 | Ubuntu 22.04 / 24.04 | `apt install asterisk` (18.x on 22.04, 20.x on 24.04, from universe) and `certbot` (systemd timer included) fit both; `ufw`, `fail2ban` standard. The script checks `/etc/os-release` and warns on anything else. **Needs real-server test** (package versions, service names). |
| 2 | Asterisk + modules | Version >= 16.2 and `res_http_websocket`, `res_pjsip`, `res_pjsip_transport_websocket`, `res_pjsip_session`, `res_srtp`, `res_rtp_asterisk` are checked after install; the stage aborts otherwise. No Opus (not in the Ubuntu package): codecs are `ulaw, alaw, g722`, which every browser supports. |
| 3 | PJSIP WSS | `transport-wss` (`protocol=wss`) + TLS listener from `http.conf`; per-agent endpoint/auth/aor; `identify_by` default (username). Verification after reload checks the listener and the transport and **reverts on failure**. |
| 4 | DTLS-SRTP / ICE | `webrtc=yes` (AVPF, DTLS with fingerprint check, ICE, rtcp-mux, received-transport media), `dtls_auto_generate_cert=yes`, `icesupport=yes`, STUN configured, host-candidate mapping and external addresses for NAT. TURN is documented but not installed by the kit. |
| 5 | DuckDNS DNS-01 | TXT set / cleared through the DuckDNS API; certbot `--manual` with both hooks; hooks are stored for renewal. |
| 6 | Let's Encrypt | Issuance, `--staging` option, `certbot renew --dry-run` check, timer check. |
| 7 | Permissions + reload | Fixed (item 4, 5 above). |
| 8 | Agents | One endpoint+auth+aor per extension, generated password shown once, duplicate / invalid input refused, endpoint-load verification with automatic restore. Passwords are stored in plain text in `pjsip_agents.conf` (`asterisk:asterisk 0640`) because `auth_type=userpass` needs them; backups `pjsip_agents.conf.before-*` contain them too and should be deleted when no longer needed. |
| 9 | Firewall / SSH | Fixed (item 10). 5060/udp is not opened. Remember the **provider-level** firewall. |
| 10 | NAT | Fixed (items 1, 2). Detection compares the public IP seen from the internet with the server's own addresses (uses the `api.ipify.org` lookup; if it is blocked, set the values by hand). |
| 11 | Browser library | The Dialer uses **JsSIP 3.10.1** (not SIP.js). It speaks what Asterisk's WebSocket transport expects: `sip` WebSocket sub-protocol, `Via ... WSS`, a `.invalid` Contact that `rewrite_contact=yes` fixes, REGISTER expiry 300 s (inside Asterisk's 60-7200 s default window), username-based endpoint identification, ICE servers from the API, DTLS-SRTP by default. SIP.js would work the same way. **Needs real-browser test.** |
| 12 | Vercel origin / API | Nothing in the repository sets a Content-Security-Policy for the web app, so the page may open `wss://` to the PBX (an https page may open wss, not ws). Asterisk does not check the WebSocket `Origin`, so no CORS setting is needed on the PBX; API CORS only concerns the Vercel API. If you add a CSP later it needs `connect-src wss://<your-pbx-name>.duckdns.org:8089` and `Permissions-Policy: microphone=(self)`. `GET /softphone/config` is `no-store` and returns each agent's own credentials only. Browser calling requires the call server set to *Direct browser-to-PBX: WSS* with the **DuckDNS name** (never the IP) and port 8089. |
| 13 | Rollback / backup | Fixed (item 13); tested in the scratch folder: files return byte-identical. Certificate deletion and the DuckDNS token file are asked about. |
| 14 | Unauthorised registration / brute force | Strong generated passwords, optional per-agent source-IP ACL, fail2ban jail (item 11), SSH rate limit, toll-fraud limit. Not covered by the kit: rate limiting at the network edge, GeoIP rules, TLS cipher hardening (see section 3). |

## 3. Still requires real-server testing (cannot be proven here)

1. `apt install asterisk` on a clean 22.04 **and** 24.04: installed version, module list, `asterisk` service, `/etc/asterisk` ownership.
2. That `module reload http` makes Asterisk **serve the renewed certificate** (the hook checks and fails if not: the very first renewal, or `certbot renew --force-renewal`, is the test).
3. The generated `http.conf` / `rtp.conf` / `logger.conf` includes inside `[general]` / `[logfiles]` really take effect on the packaged default files (`http show status` shows TLS on 8089; `rtp show settings` shows ICE; `security_log` file appears).
4. WSS endpoint from outside: `node scripts/check-pbx-wss.mjs <name>.duckdns.org 8089 /ws` from another network (trusted certificate, upgrade, SIP answer).
5. A real browser registration and a call each way: DTLS-SRTP negotiated, audio both directions, two agents at once from different networks, an idle registration surviving more than 5 minutes (NAT / WebSocket idle timers), a call after the tab was in the background.
6. NAT'd (cloud) server: audio in both directions with `external_media_address` + `ice_host_candidates`; TURN if some agents still have one-way audio.
7. DuckDNS DNS-01 end to end (TXT visible to Let's Encrypt within 60 s) and unattended renewal (`certbot renew --dry-run`, then the 60-day renewal itself).
8. fail2ban filter against a real security log: `fail2ban-regex /var/log/asterisk/security_log /etc/fail2ban/filter.d/pbx-asterisk-ws.conf` after a deliberate wrong password (the filter was checked only against sample lines written from Asterisk's documented format), and that a ban really blocks the agent's address.
9. `ufw` plan on a real server with a non-default SSH port; open a second SSH session before `firewall --yes`.
10. `add-agent.sh --allow-ip`: the `acl=` option on the installed Asterisk (`pjsip show endpoint <ext>` lists it, a request from another address is rejected).
11. The phone-network trunk with your provider's real settings (registration or IP auth, number format, codecs).
12. TLS hardening (`testssl.sh`): the stock Asterisk build may still offer old TLS versions or ciphers; disable what the scan flags.

## 4. Deployment checklist

Before the server
- [ ] Server: Ubuntu 22.04 or 24.04, public IPv4, SSH key login, **a second SSH session kept open** during the firewall step.
- [ ] Provider firewall / security group: `22/tcp`, `8089/tcp`, `10000-20000/udp` (and nothing else).
- [ ] DuckDNS name created, token copied. E-mail chosen. (Optional) trunk details from your provider.
- [ ] `scp -r ops user@server:~/` ; `/etc/pbx-setup.env` created as root with mode 600.

On the server, in order (stop at the first failure)
- [ ] `sudo sh pbx-setup.sh preflight` (read the NAT line)
- [ ] `sudo sh pbx-setup.sh install`
- [ ] `sudo sh pbx-setup.sh dns` (the name must resolve to the public IP)
- [ ] `CERTBOT_STAGING=1` in the env file: `sudo sh pbx-setup.sh certificate`; then `certbot delete --cert-name <name>`, remove `CERTBOT_STAGING`, run `certificate` again for the real certificate
- [ ] `sudo sh pbx-setup.sh configure`
- [ ] `sudo sh pbx-setup.sh harden` ; add your own fixed address to `ignoreip` in `/etc/fail2ban/jail.d/pbx-asterisk.local`
- [ ] `sudo sh pbx-setup.sh firewall` (read the plan), then `--yes`, then confirm a **new** SSH login works
- [ ] `sudo sh add-agent.sh 4001 "Name"` per agent (keep each password once; enter it in the Dialer)
- [ ] `sudo sh pbx-setup.sh status` (served serial = disk serial, fail2ban active, ports as expected)

From outside the server
- [ ] `node scripts/check-pbx-wss.mjs <name>.duckdns.org 8089 /ws --origin https://<your-vercel-site>` shows no FAIL
- [ ] Dialer: Call Servers: host = the DuckDNS name, transport *Direct browser-to-PBX: WSS*, port 8089, path `/ws`; SIP accounts per agent
- [ ] Two agents on two networks: Registered, call each other, audio both ways; wrong password is refused and ten wrong tries get the address banned (test from a spare address, not yours)
- [ ] Trunk (optional): `add-trunk.sh`, one outgoing and one incoming call
- [ ] Renewal: `sudo certbot renew --dry-run` succeeds; later `sudo certbot renew --force-renewal` once and `status` shows the new serial being served

Production / Vercel
- [ ] `pnpm db:migrate` on the production database (migrations 0011, 0012)
- [ ] Vercel environment: `WEBRTC_STUN_URLS` (default is fine), `WEBRTC_TURN_*` only if you installed TURN
- [ ] Keep `/root/.../snapshots/*.tgz` and the first `*.before-pbx-setup` files until everything is accepted; delete `pjsip_agents.conf.before-*` backups afterwards (they hold passwords)

Rollback at any point: the table at the end of `README.md`.

---

# Second review (before approval to deploy): issues found and what was done

Found by reading the repository against the real source (see the line references in the table), fixed in the kit / web / API where the owner approved code changes, and tested without touching any server. **Nothing here was run on a VPS.**

| # | Severity | Issue | Fix | Where |
|---|---|---|---|---|
| C1 | critical | `RING_TIMEOUT_SECONDS` defaults to 5 s: the softphone cancels every call before a person can answer | **Not changed in the repository** (it is the owner's earlier business rule and a production setting). Documented as a required Vercel variable (`45`) that needs the owner's approval; the audio test is gated on it | `DEPLOY.md` section 6 and Test B; `config/app.config.json:14` unchanged |
| C2 | critical | The softphone retried a rejected password every 30 s: fail2ban would ban the agent's address, and everyone behind it | A rejected credential (401/403/407) is never retried automatically; a new attempt happens only when the account's password or server address changes (or the page is reloaded). Verified in a real browser against a test PBX that rejects every login: **2 REGISTER messages in 2 minutes (one failed login), and exactly one new attempt after the admin changed the password**. fail2ban now allows 8 failures / 10 min and has `FAIL2BAN_IGNORE` | `apps/web/src/softphone/registrationRetry.ts` (+test), `useSoftphone.ts`, `pbx-setup.sh` |
| C3 | critical | The `[general]` include sat at the top of the section, so the packaged file's own later lines (`bindaddr`, `rtpstart` ...) would override ours | The include is placed at the **end** of the section; `configure` also fails (and reverts) if plain HTTP (8088) ends up listening on all interfaces. Tested with a packaged-style file that has conflicting lines | `pbx-setup.sh` `add_include`, verification step |
| 2a | medium | fail2ban jail would not start without the log file | the file is created (owner `asterisk`) before the jail starts | `pbx-setup.sh` `stage_harden` |
| 2b | medium | DuckDNS requests could use IPv6 on a dual-stack server | `curl -4` in all three places | `duckdns-update.sh`, `duckdns-certbot-hook.sh`, `pbx-setup.sh` |
| 2c | medium | Rate limiting was per address: agents sharing an address share the limit | per signed-in user when the token verifies, per address otherwise (unit-tested incl. forged / expired tokens) | `services/api/src/common/auth/throttler.guard.ts`, `app.module.ts` |
| 2d | medium | No security headers / CSP on the web app | headers + CSP in `vercel.json`; verified with the real build in a browser | `vercel.json` |
| 2e | medium | Any agent could dial any number through the trunk | fail-closed destination rules (`ALLOW_PREFIXES`, `DENY_PREFIXES`, 6-15 digits), per-agent and global call limits, maximum call duration; refusals end as SIP 403 / 503 | `pbx-setup.sh` dial plan |
| 2f | low | The cap-reached outcome showed as "Success: busy" in the Dialer | now SIP 503 (cause 34): "Not success, server problem"; refused destinations are 403 (cause 21): "Not success, refused" | `pbx-setup.sh` dial plan; mapping to be confirmed on a real server |
| 2g | low | `inspect-pbx.sh` ran a command (`fwconsole sa`) not verified as read-only | removed | `ops/pbx/inspect-pbx.sh` |
| 2h | medium | **The settings file was loaded by executing it as shell** (a stray `;command` in it would run as root) | read as plain `KEY=VALUE` lines against a fixed list of names; nothing is executed; tested with a command inside a value (not run) and with unknown names | `pbx-setup.sh` `load_env` |
| 2i | low | `DEFAULT_SIP_TRANSPORT` is `udp` in the repository: an Excel call list can create a UDP server | documented (create the WSS server first, or set `DEFAULT_SIP_TRANSPORT=wss`); repository default unchanged | `DEPLOY.md` section 6 |
| 2j | info | Trunk architecture | reviewed in `TRUNKS.md`: supported now vs development needed | `ops/pbx-new/TRUNKS.md` |

## Remaining known issues (not fixed, by design or because they need a real environment)

* Everything in section 3 of this file under "Still requires real-server testing" is still open: nothing was installed or tested on a VPS.
* The Q.850 cause to SIP mapping used for refusals (21 to 403, 34 to 503) is standard but unconfirmed on the installed Asterisk.
* `ALLOW_PREFIXES` has no safe default other than "refuse everything", so a trunk needs one deliberate setting before the first outgoing call.
* TURN credentials are one shared username/password given to every signed-in agent (time-limited credentials would be a development task).
* Only one trunk is supported by the scripts (`TRUNKS.md`).
* `POST /api/v1/call-servers/{id}/test` makes the API contact the host an administrator names (administrator only, 20/minute); accepted, documented in the design notes.
* The address Vercel passes to the API (rate limits for anonymous requests) is unverified until the first deployment.
* The desktop (Windows) application was not touched.
