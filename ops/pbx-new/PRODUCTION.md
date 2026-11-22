# Production deployment: internet-facing PBX with two-way audio (free and open-source software only)

Status of this document: written after the kit was run end to end on a **clean Ubuntu 24.04** machine (a throwaway WSL instance, no DNS, so a
self-signed certificate stood in for Let's Encrypt). Nothing has been deployed to a public server yet; what is verified and what is not is listed in
section 7. Read `DEPLOY.md` for the manual, stage-by-stage path; this file is the automated path.

## 1. Architecture

```
 agent browser / phone (Chrome)                         free-tier VM, public IPv4, Ubuntu 24.04
 ┌───────────────────────────┐   HTTPS                 ┌──────────────────────────────────────────────┐
 │ Dialer web app (Vercel)   │ ─────────► API (Vercel) │  Asterisk 20 (PJSIP)   WSS 8089  + RTP UDP   │
 │  JsSIP softphone          │            │            │  coturn                3478 udp/tcp, 5349    │
 └───────────┬───────────────┘            │ TiDB       │  fail2ban, ufw, certbot (Let's Encrypt)      │
             │ wss://<name>:8089/ws  ─────┼────────────►  all services: systemd, start at boot        │
             │ audio: SRTP/ICE (UDP)  ────┴────────────►  (optional) SIP trunk to a carrier           │
             └─ if UDP is blocked: TURN relay (coturn) ──►                                            │
                                                         └──────────────────────────────────────────────┘
```

* The browser talks to the PBX **directly** (WSS signalling, DTLS-SRTP media). The Vercel API only stores settings and hands each agent their own SIP
  account, the PBX address and short-lived TURN credentials (`WEBRTC_TURN_SECRET`, TURN REST scheme).
* No SIP or media runs on Vercel: see section 1c for the exact reasons.

## 1b. What runs where today (verified from the repository)

| Component | Where | Evidence / caveat |
|---|---|---|
| Web app (React, Vite build) | **Vercel** (static, `apps/web/dist`) | `vercel.json`: `outputDirectory`, SPA rewrite |
| API (NestJS 11 / Node 22, auth, RBAC, agents, call history, TURN credentials) | **Vercel Function** `api/index.js`, region `sin1`, 30 s, 1 GB | `vercel.json`, `api/index.js`; commit "Run the Node.js backend on Vercel; remove Cloudflare Container setup". One project serves both |
| Database | **TiDB Cloud** (`dev_dialer`; the `production` section of `config/app.config.json` is still blank) | the deployed site you use signs in against the dev database |
| Asterisk 20 + PJSIP + WebRTC, coturn | **nowhere public**: only a local WSL test PBX, plus a clean-room test install that is stopped | no public host exists yet |
| JsSIP softphone | runs in each agent's browser | `apps/web/src/softphone/useSoftphone.ts` |

Not verifiable from this machine: the live Vercel project (no deployment URL is stored in the repository, the installed Vercel CLI does not start, and the
available GitHub login has no access to the repository's deployment records), so domain, environment variables and which environment (Preview or
Production) serves the site were not inspected. Nothing about the Vercel project was changed.

## 1c. Can Vercel host Asterisk or coturn? No. The exact limits

| What a PBX needs | What Vercel offers | Result |
|---|---|---|
| A long-running process that keeps SIP registrations and calls alive | Functions are request-driven and stateless; this project's function is capped at 30 s. WebSocket support in Functions is now generally available, but a connection is pinned to one instance and **ends when the function reaches its maximum duration**; state must live in an external store ([Vercel changelog](https://vercel.com/changelog/websocket-support-is-now-generally-available), [community answer](https://community.vercel.com/t/does-vercel-support-websockets-now-that-we-have-fluid-compute/27205)) | cannot hold calls |
| **UDP**: RTP audio, ICE checks, TURN relay (3478, 10000-20000, 49152+) | I found no UDP listener support in Vercel's documentation; Functions are reached through Vercel's HTTPS gateway | **no media path** |
| Public IP and arbitrary ports (8089, 3478, 5349, UDP ranges) | no fixed address, no ports of our choosing | cannot be reached as a PBX |
| systemd-style supervision, restart at boot | none; instances are created and destroyed by the platform | no recovery model |
| A "persistent" alternative | Vercel Sandbox on the free Hobby plan: sessions of at most 45 minutes, 5 hours of active CPU per month, ports exposed only as public URLs ([pricing and quotas](https://vercel.com/docs/sandbox/pricing), [duration](https://vercel.com/kb/guide/vercel-sandbox-duration-and-persistence)) | an ephemeral development box, not a PBX |

Even a Function that proxied WSS to Asterisk would still need the Asterisk host and its UDP media path somewhere else. **Smallest additional infrastructure:
one always-on Linux host with a public IPv4 address and inbound UDP (Asterisk + coturn on it).** Everything else stays on Vercel and TiDB unchanged.

One architecture that avoids that host: plain browser-to-browser WebRTC for agent-to-agent calls only (signalling through the existing API, free public STUN).
It needs no PBX, but it drops everything the PBX provides (trunks, the dial plan and its fraud limits, central call control), still needs a TURN server for the
roughly one in ten networks that block direct paths, and would be a new architecture, so it is not recommended unless real phone numbers are out of scope.

## 2. Server options compared (the kit is provider-neutral; nothing depends on Oracle)

| Option | Cost | Public IPv4 + UDP | Verdict |
|---|---|---|---|
| **Oracle Cloud Always Free** | free, no expiry | yes | best for zero cost; needs a bank card for identity, ARM capacity is often unavailable, idle instances can be reclaimed |
| **A small paid VPS** (1 vCPU / 1 GB, IPv4 included) | roughly USD 3 to 7 per month: Vultr and Linode about USD 5, an OVH promotion about USD 3.20, DigitalOcean's USD 4 plan has only 512 MB, Hetzner pricing and stock were reported unstable in mid-2026 ([comparison](https://cybernews.com/best-web-hosting/cheap-vps-hosting/), affiliate sites: verify on the vendor page) | yes | **most reliable and lowest-friction**; no identity gamble |
| A spare Ubuntu PC or Raspberry Pi at home | free | only with router port forwarding, a dynamic-DNS name, no carrier-grade NAT, and stable power / internet | acceptable for a pilot, not for production |
| Existing company servers | free | unknown | **not evaluated**: your standing rule is that office infrastructure is never touched unless you name a specific host |
| Google / AWS / Azure free tiers | see section 2a | yes | worse than Oracle (1 GB/month egress cap; credits that expire; billed IP) |

**Recommendation:** try Oracle Always Free first (zero cost); if the account or the VM cannot be created, use a roughly USD 5 per month VPS. Both run the same
`deploy-remote.sh`; choosing one does not change any code.

## 2a. The free tiers in detail

| Option | Always free? | Fit for Asterisk + coturn | Main risk |
|---|---|---|---|
| **Oracle Cloud "Always Free"** (recommended) | yes, no expiry | 2 × AMD micro VMs (1/8 OCPU, 1 GB) or an Ampere A1 allocation (sources say 2 OCPU / 12 GB in 2026; older guides say 4 / 24); public IPv4 supported; arm64 works with this kit | **a bank card is required for identity verification** (prepaid / virtual cards are often refused); A1 capacity is often "out of host capacity"; idle instances can be reclaimed; the home region cannot be changed later |
| Google Cloud e2-micro | yes, in us-west1 / us-central1 / us-east1 | runs the kit | only **1 GB/month** of free outbound traffic from North America: relayed or one-way-heavy audio uses that in hours |
| AWS Free Tier | **no**: for accounts opened after July 2025, USD 200 credits for 6 months | runs the kit | not permanent; public IPv4 is billed per hour once credits end |
| Azure free account | 750 h/month of B1s for 12 months | runs the kit | the public IP address is billed separately (about USD 3.65/month) |

Sources (checked in this session; none is Oracle's or Google's own current price list, so verify the numbers in the console before relying on them):
[Oracle free tier 2026 guide](https://shicheng-guo.github.io/tutorials/2026/06/06/oracle-cloud-free-tier),
[Oracle free tier limits](https://agentdeals.dev/vendor/oracle-cloud),
[Google Cloud free tier](https://docs.cloud.google.com/free),
[AWS free tier terms](https://aws.amazon.com/free/terms),
[AWS free-plan credits](https://aws.amazon.com/blogs/aws/aws-free-tier-update-new-customers-can-get-started-and-explore-aws-with-up-to-200-in-credits),
[Azure free services](https://learn.microsoft.com/azure/cost-management-billing/manage/create-free-services).

**The one external authorization this needs:** someone has to create the cloud account (identity check, card) and the VM, then allow SSH from the
deployment machine. That cannot be automated or done on the owner's behalf. Everything after it is one command (section 4).

Inbound ports to open in the provider's firewall / security list (the kit opens the same ones in ufw):

| Port | Why |
|---|---|
| 22/tcp | SSH (ufw rate-limits it; allowed before the firewall is enabled) |
| 80/tcp | Let's Encrypt HTTP-01 validation and renewal (not needed with a DuckDNS DNS-01 setup) |
| 8089/tcp | SIP over WSS from browsers |
| 10000-20000/udp | audio (RTP). Narrow it with `RTP_START` / `RTP_END` if you like |
| 3478/udp+tcp, 5349/tcp | TURN relay |
| 49152-49252/udp | TURN relay media (`TURN_MIN_PORT` / `TURN_MAX_PORT`) |

## 3. Costs, transparently

| Component | Cost |
|---|---|
| Asterisk, coturn, fail2ban, ufw, certbot, JsSIP, Node.js, this kit | free and open source |
| TLS certificate (Let's Encrypt) and a name (`<ip>.sslip.io` or DuckDNS) | free |
| Web app and API on Vercel | free Hobby plan (non-commercial use only); already in use |
| Database (TiDB Cloud) | free tier within its limits; already in use |
| **PBX server with a public IP** | **free only inside Oracle's Always Free allowance; otherwise roughly USD 3 to 7 per month** |
| **Calls to real mobile / landline numbers** | **paid carrier SIP trunk (per-minute charges). There is no free legitimate way.** The trunk path is built and tested against a simulated provider |

Minimum recommended PBX server: Ubuntu 24.04 LTS (22.04 also supported), **1 vCPU, 1 GB RAM (2 GB is comfortable), 10 GB disk, public IPv4, inbound UDP**,
about 100 kbit/s per call per direction (more through TURN). Tested sizing is not available: the kit was only exercised on an idle test machine, so treat
"a handful of simultaneous calls on 1 vCPU" as an estimate, not a measurement. AMD64 was tested; **ARM64 (Oracle's Ampere shape) was NOT tested**: the
packages (asterisk, coturn, certbot, fail2ban, ufw) exist for arm64 in Ubuntu, but no ARM machine was available.

Estimated monthly infrastructure cost: **USD 0** with Oracle Always Free (if the account and a VM can be created), otherwise **about USD 3 to 7** for a small VPS.
Carrier charges for real phone calls come on top and depend on the carrier and destination.

## 4. Deploy (one command, from the repository root)

```bash
# 1. once: key-based SSH to the server works  (ssh ubuntu@<ip>)
# 2. once:  (cd scripts/e2e-audio && npm install)   so the audio test can run at the end
ops/pbx-new/deploy-remote.sh ubuntu@<public-ip> --email you@example.org --allow-prefixes 91
#    add  --domain pbx.example.org  to use your own name, --staging for a practice certificate first
```

It installs and configures everything, creates the agents (passwords in `.deploy/agents.env`, git-ignored), saves the TURN secret to
`.deploy/turn-secret`, and then **proves two-way audio from your machine over the internet**, once directly and once through the TURN relay.
Then register the PBX in the Dialer without clicking:

```bash
DIALER_URL=https://<your-dialer> TENANT=<tenant> ADMIN_EMAIL=... ADMIN_PASSWORD=... \
node scripts/dialer-add-pbx.mjs --host <domain> --accounts-file .deploy/agents.env --user 4001=<agent1 email> --user 4002=<agent2 email>
```

and set `WEBRTC_TURN_URLS` + `WEBRTC_TURN_SECRET` (printed by the deploy script) and `RING_TIMEOUT_SECONDS=45` in the API environment.

Restart and recovery: Asterisk, coturn and fail2ban are systemd services enabled at boot (a bounded `Restart=on-failure` is added when a unit has none);
certificate renewal is a certbot timer whose deploy hook refreshes the copies used by Asterisk and coturn and verifies the served certificate; the
`pbx-health.timer` checks every 5 minutes (it only reports, it never restarts anything). `pbx-setup.sh status` / `health` show it all.

### Recovery if an installation stops half way
1. Read the last lines it printed: every stage stops at the first failure and says what failed. Nothing is changed after that point.
2. Fix the cause (for example DNS not pointing at the server yet, or port 80 blocked) and run the same command again: every stage is idempotent
   (the sandbox test runs `configure` twice; the clean-room test re-ran `configure`, `turn`, `monitor` and `harden`).
3. To go back: `sudo sh pbx-setup.sh rollback` (below). Configuration snapshots are in `/var/lib/pbx-setup/snapshots/`; `/etc/pbx-setup.env.bak` holds the previous settings.
4. If SSH is ever locked out (it should not be: the SSH rule is added before the firewall is enabled and is never removed by rollback), use the provider's
   web console and run `ufw allow 22/tcp`.

## 5. Ports and protocols a server provider must support

| Port | Protocol | Why | Needed when |
|---|---|---|---|
| 22 | TCP | SSH (ufw rate-limits it) | always |
| 80 | TCP | Let's Encrypt HTTP-01 validation and renewal | `CERT_MODE=http` (default without a DuckDNS token) |
| 8089 | TCP (TLS) | SIP over WebSocket Secure from browsers | always |
| 10000-20000 (narrowable) | UDP | RTP audio (DTLS-SRTP) with ICE | always |
| 3478 | UDP and TCP | TURN / STUN | agents behind strict NAT / firewalls |
| 5349 | TCP (TLS) | TURN over TLS | same |
| 49152-49252 | UDP | TURN relay media | same |
| outbound | UDP/TCP | SIP trunk registration, DNS, apt, Let's Encrypt | always |

The provider must give the VM a **public IPv4 address**, allow **inbound UDP** (some providers filter it), and let you open these ports in its own
firewall / security list as well as in ufw. A server behind NAT (typical for cloud VMs) works: the kit detects the public address and advertises it.

## 6. Security review (what was checked and what changed)

| Check | Status |
|---|---|
| Secrets in the working tree and in the whole Git history (keys, tokens, `PASSWORD=` / `SECRET=` values) | VERIFIED: none (patterns scanned; only documented placeholders match). `.env`, `.env.vercel`, `.deploy/` are git-ignored |
| Secrets reaching the browser | VERIFIED: the web app reads no `VITE_` variables; the built bundle has no TURN secret names |
| Long-lived TURN credentials in the browser | FIXED: the old fixed `WEBRTC_TURN_USERNAME/CREDENTIAL` fallback was removed; the API only issues short-lived credentials from `WEBRTC_TURN_SECRET`, and `WEBRTC_TURN_URLS` without the secret is a startup error (unit-tested that the secret never appears in the browser payload) |
| TURN as an open relay / private-network access | FIXED: private, loopback, link-local and IPv6 private ranges denied except the server's own address, RFC 6062 TCP relaying off, per-user quota; relay verified working for the Asterisk path |
| `chan_sip` answering browsers' WebSocket registrations | FIXED: disabled by the kit (found by the clean-room audio test) |
| Per-agent outbound limit and a spoofed SIP `From` | HARDENED (defence in depth): the limit now counts by the authenticated endpoint name. VERIFIED with real calls: a spoofed `From` is rejected earlier, at authentication (SIP 401), and agents keep separate budgets (see 7) |
| Unauthorized outbound calling | VERIFIED by test with real SIP calls through a looped-back test trunk: numbers outside `ALLOW_PREFIXES` get 403, per-agent and global limits get 503 (real carrier trunk NOT VERIFIED — REQUIRES PUBLIC SERVER) |
| Unauthorized PBX provisioning | VERIFIED (API test): provisioning a call server or SIP account needs `call_servers:manage` (an agent gets 403, no token 401); the request sequence of `dialer-add-pbx.mjs` is covered by an API test; the script prints no credentials |
| Unsafe remote commands in `deploy-remote.sh` | FIXED: every argument is validated before it reaches a remote shell (tested with injected input); the remote steps after the firewall use one SSH connection (ufw limits new SSH connections) |
| SSH lock-out | the SSH rule is added first, rate-limited, and kept by rollback; NOT VERIFIED on a real server's provider firewall — REQUIRES PUBLIC SERVER |
| Rollback damaging other services | VERIFIED in the clean-room test: only files and rules the kit added are removed; packages stay installed; originals are restored byte-identical (sandbox: 6 files compared) |
| Static config in TiDB / Vercel | BLOCKED — REQUIRES USER ACTION: production database settings and the variables in section 8 are not set |

## 7. Verification status

Labels: VERIFIED (measured or observed), FIXED (found and corrected in this review), NOT VERIFIED — REQUIRES PUBLIC SERVER, BLOCKED — REQUIRES USER ACTION.

| Item | Status |
|---|---|
| `scripts/e2e-audio`: two-way audio, direct, on a clean Ubuntu 24.04 made by this kit | VERIFIED (tones measured both ways) |
| Same call forced through coturn with short-lived credentials | VERIFIED |
| Registration over WSS, ICE, DTLS-SRTP | VERIFIED (same test) |
| Kit stages on a **brand-new** Ubuntu 24.04 (AMD64): install, configure, turn, harden, monitor, health, add-agent, add-trunk | VERIFIED |
| Re-running configure, turn, monitor, harden on the live system | VERIFIED: all 17 tracked config files byte-identical afterwards (idempotent) |
| Outbound limits with real calls (MAX_OUTBOUND=2, MAX_PER_AGENT=1): 2nd call of one agent refused 503, a spoofed `From` refused 401, another agent has its own budget, global limit 503, slot freed after hang-up, number outside the allow-list 403 | VERIFIED (7 of 7) through a looped-back test trunk |
| TURN credentials through the authenticated endpoint: no token 401; short-lived, derived per user; secret never in the response, headers or API log | VERIFIED (4 API tests + 2 unit tests) |
| Asterisk, coturn, fail2ban, health timer back after a full power-cycle of the machine, audio passing afterwards | VERIFIED |
| `kill -9` of Asterisk, coturn and fail2ban: systemd restarts each within 1 to 2 s | VERIFIED |
| Health: healthy run (exit 0, silent with `--quiet`, no alert); coturn stopped, Asterisk stopped, certificate expiring in 4 days, disk at 95% each detected with exit 1; journal entry; webhook alert received; health never restarts anything; recovery to exit 0 | VERIFIED |
| Health alert hygiene: transient problem (service down 8 s) sends no alert, a persistent one sends exactly one; alerts contain no secret (TURN secret and agent passwords: 0 occurrences) | VERIFIED |
| Health timer fires by itself after boot | VERIFIED (observed in the journal); the exact 5-minute cadence over a long period was NOT measured |
| Rollback (answer "keep the certificate"): six packaged files byte-identical to the originals, kit files moved not deleted, packages and unrelated files untouched, services of the host unaffected; then a full re-install and an audio test | VERIFIED (clean-room) |
| `deploy-remote.sh`: input validation (injected values rejected), dry run, and its single-connection remote step against the clean machine through a stand-in `ssh` | VERIFIED; the real SSH path, upload and `all` over a network are NOT VERIFIED — REQUIRES PUBLIC SERVER |
| Firewall stage: plan and the exact ordered commands (SSH rule first, before `ufw enable`) printed with a dry run | VERIFIED as a dry run only; applying ufw was NOT tested (it would alter the shared test network): NOT VERIFIED — REQUIRES PUBLIC SERVER |
| API: complete suite, run alone, final run | **22 of 22 suites, 192 of 192 tests**, 0 timeouts, 0 connection retries. Earlier complete runs the same day: 20/20 (186/186); then two runs with ONE transient `connect ETIMEDOUT` each (in `caller-import`, then in `call-lists` with five dependent failures), each suite passing alone afterwards; the test helper's connection retry was added after those |
| Earlier API timeout | see section 7a |
| Web tests, lint, typecheck, production build, installer sandbox, shell syntax | VERIFIED: web 8 of 8; lint 0 problems; typecheck passes; build passes; sandbox 35 of 35; all PBX scripts pass `dash -n` / `bash -n` |
| Simulated provider: echo, busy, refused, no answer | VERIFIED (local PBX) |
| Let's Encrypt issuance and renewal (HTTP-01 and DNS-01) | NOT VERIFIED — REQUIRES PUBLIC SERVER |
| Public IP and real NAT behaviour; provider-level firewall | NOT VERIFIED — REQUIRES PUBLIC SERVER |
| Calls between two separate internet networks; mobile data; real-world TURN relay | NOT VERIFIED — REQUIRES PUBLIC SERVER |
| ARM64 (Oracle Ampere) | NOT VERIFIED — no ARM machine; AMD64 only |
| Oracle iptables handling (`oci_prepare`) | NOT VERIFIED — REQUIRES PUBLIC SERVER (written from documentation of the default image) |
| Real SIP carrier; calls to mobile or landline numbers | NOT VERIFIED — REQUIRES PUBLIC SERVER and a paid trunk |
| Vercel project, domain, environment (cannot be inspected from this machine) | BLOCKED — REQUIRES USER ACTION |

### 7a. The earlier API timeout (`dialer.e2e.spec.ts`, then `softphone.e2e.spec.ts`)
* The failing run had **no** `ETIMEDOUT` / `ECONNRESET` / pool errors; only jest timeouts (one 120 s test, one 120 s hook, ten 60 s hooks) and a single 500 whose cause
  was not logged because tests run with logging silenced.
* **Re-run alone on an idle machine:** 14 of 14 passed in 276 s, no error logged by the API. The test that had timed out took 20.9 s (limit 120 s).
* Database round trip when idle: about 70 ms (connect with TLS about 510 ms), stable over repeated probes.
* **Not caused by CPU load:** the same test with 16 busy loops running took 21.9 s (idle 20.9 s). **Not reproduced by network load:** four parallel downloads gave 21.1 s.
* **Not proven:** the exact cause of the two slow runs. The remaining candidates are a transient slowdown on the shared free-tier TiDB cluster or other activity on this PC at
  the time; both can only be assumed, not shown. What was done: `test/global-setup.ts` now prints the database round-trip time at the start of every run, so a slow link is visible
  in the log next to any timeout. Timeouts were not raised and no test was weakened. Run the API suite on an otherwise idle machine.
* The complete run was repeated eight times today. Failures seen: the first run (while I was running other tests at the same time) had 42 `connect ETIMEDOUT`; two later idle-machine runs had one each, in the test helper's own direct connection (`ownerConnection`), once cascading into five dependent failures. All are TCP connect timeouts to the database gateway, so intermittent connectivity to the shared TiDB cluster is real and recurs; no assertion ever failed on its own. `ownerConnection` now retries only the connection attempt (3 tries, each retry printed). The application's own pool was never affected and has no retry.
* The same slow run also exposed a real regression that was **FIXED**: `file-config.spec.ts` asserted the exact shape of the WebRTC config, which my TURN change had extended.

## 8. Production configuration that is missing or incomplete today (BLOCKED — REQUIRES USER ACTION)

| Setting | State |
|---|---|
| `config/app.config.json` `production` section: `DB_HOST`, `DB_NAME`, `DB_USER_PREFIX` | blank on purpose; until filled, a Production deployment answers 503. The site in use is served from the development database |
| Production database | migrations `0011` and `0012` have only been applied to `dev_dialer` / `dev_dialer_test`; `0012` drops 24 unused tables (back up first) |
| Vercel variables: the four secrets (`.env.vercel` lists them), `ENABLE_EXPERIMENTAL_COREPACK=1` | present in the generated file; whether they are set in the project could not be checked |
| `RING_TIMEOUT_SECONDS=45` | not set by the repository (default 5 s cuts calls before anyone can answer) |
| `WEBRTC_TURN_URLS`, `WEBRTC_TURN_SECRET`, optionally `WEBRTC_TURN_TTL_SECONDS` | only after a TURN server exists |
| `DEFAULT_SIP_TRANSPORT=wss` | recommended (repository default is `udp`) |
| Client IP behind Vercel's proxy for rate limiting | unverified until the first real deployment (check the function logs) |

## 9. Rollback

`sudo sh pbx-setup.sh rollback` removes what the kit added: includes and files in `/etc/asterisk` (originals restored byte-identical), the fail2ban jail,
the firewall rules for WSS, RTP, TURN and HTTP-01 (**the SSH rule is kept**), coturn's configuration, the health timer and restart drop-ins. It asks before
deleting the certificate and never uninstalls packages or touches other services. Agents / trunk: `add-agent.sh --remove`, `add-trunk.sh --remove`.
Deployment secrets in `.deploy/` and `/var/lib/pbx-setup/turn-secret` are not deleted automatically.
