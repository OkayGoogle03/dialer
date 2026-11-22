# Project Status

**Current phase:** 1 - Foundation + Batch 3 (master data, Excel caller import, outbound routing core) built and tested; Phase 1 still has two verification gaps (see below)
**Last updated:** 2026-11-19

## Database change (Batch 2)
At the user's direction the database is **TiDB Cloud (MySQL 8 compatible)**, replacing PostgreSQL. TiDB has no row-level security, so tenant isolation is now enforced in application code + schema + DB grants (see decisions D-014…D-020). Migrations were rewritten for TiDB and applied to `dev_dialer`; tests run against `dev_dialer_test` on the same cluster.

## Completed and verified (actually executed 2026-11-18)

| Area | Detail | Evidence |
|---|---|---|
| Migrations | 0001–0005, 46 statements, per-statement checksums, idempotent re-run; applied to real TiDB | `pnpm db:migrate` → applied 46, re-run → 0 |
| DB users | `dialer_api` (tenant-scoped) and `dialer_platform` (cross-tenant) with per-table grants; every table must be classified or setup aborts | grant tests |
| Tenant isolation | `Database.withTenant` binds `:tenantId` from verified context only; SQL guard rejects any tenant-table reference lacking a `:tenantId` bind; composite FKs; API user cannot write `tenants`/`platform_admins`, mutate `audit_logs`, read `outbox_events` or DDL | `isolation.int.spec`, `tenant-guard.spec` |
| Platform Super Admin | `/api/v1/platform/tenants` list/get/create/update/suspend/reactivate; `PlatformAdminGuard` re-checks `platform_admins` on every request; suspension revokes refresh tokens and blocks live access tokens (≤15 s cache, instant on the serving instance); audit in target tenant + outbox events | `platform.e2e.spec` |
| Roles & Teams | Roles CRUD (system roles immutable, custom roles, permission catalogue), Teams CRUD + membership; anti-escalation (cannot grant/act on permissions you lack); Users gained `teamId`, role-key based assignment | `roles-teams.e2e.spec` |
| Shared packages | `@dialer/shared-types`, `validation` (zod + regexes), `event-schemas`, `ui` (components + design tokens), `config` (tsconfig + dual CJS/ESM build) | builds + 8 package tests |
| Logging | pino JSON; `X-Correlation-Id` accepted/generated/echoed; `correlation_id`, `tenant_id`, `user_id` on every line via AsyncLocalStorage; secrets redacted; correlation id stored in audit + outbox | `events-logging.int.spec` |
| Events | Versioned envelope + catalogue (spec's 16 event types + tenant.*/user.created); transactional outbox written in the business transaction; relay with leasing, backoff, `Nats-Msg-Id` dedupe; idempotent consumer (marker + handler in one tx), retry, DLQ | fake-broker tests (below) |
| Web | Platform Tenants, Roles, Teams pages; shared UI/types/validation | typecheck + build; unit tests |
| CI | `.github/workflows/ci.yml`: lint, build packages, typecheck, TiDB service + NATS, migrate twice, tests, build | **workflow not yet executed** (no remote) |

**Test totals (this session):** API 53/53 (7 suites) · packages 8/8 · web 5/5. ESLint clean. `tsc` clean for all workspaces. API and web production builds succeed.

## NOT verified — read before relying on this
1. **NATS JetStream:** Docker is not installed (checked: no `docker` binary, no Docker Desktop directory). `NatsPublisher`, stream creation and `startJetStreamConsumer` are written but **have never run against a real NATS server**. Relay and consumer *logic* is tested with an in-memory broker. Install Docker Desktop (or provide a NATS URL), then run `docker compose up -d nats` and an integration test.
2. **Redis:** compose defined, not used yet (Phase 2).
3. **CI workflow:** YAML not executed. The `pingcap/tidb` service-container image behaviour is assumed.
4. **New web screens** (Platform Tenants, Roles, Teams) are typechecked and built but **not exercised in a browser** this batch. The Batch 1 login flow was browser-tested on the old stack; the API has since changed storage.
5. TiDB `CHECK` constraints are not enforced on this cluster (`tidb_enable_check_constraint=OFF`, and it is a shared cluster — see below). All validation is in the API; SQL `CHECK` clauses are documentation.
6. Hosted-DB credentials were pasted into chat. **Rotate the `…root` password** when convenient; the app itself uses restricted users.

## Pending (still Phase 1)
- [ ] Run NATS integration test (needs Docker or NATS URL), then mark Phase 1 verified.
- [ ] Browser smoke test of new screens.
- [ ] Password reset (needs email provider + token table).
- [ ] Cross-instance tenant-suspension invalidation via Redis pub/sub (Phase 2 with Redis).

## Next (do not start until the two verification items above are closed)
Phase 2 — Telephony core: Asterisk + Kamailio, ARI adapter, SIP provider management (AES-GCM credentials), calls API, call history, recordings.

## Known risks
- No RLS: a developer bypassing `Database.withTenant` (e.g. a raw pool) could leak data. Mitigations: guard, lint rule banning positional placeholders, grants, isolation tests, `TENANT_TABLES` completeness test.
- Shared TiDB cluster: other projects live on it. Only `dev_dialer` and `dev_dialer_test` are touched; never `SET GLOBAL`.
- `trust proxy` = 1 hop; must match real ingress.

## Batch 3 - Master data, Excel caller import, outbound routing (2026-11-19)

### Implemented and verified
| Area | Status |
|---|---|
| Migration 0006 (+ permissions, backfill) | Applied to dev_dialer and dev_dialer_test on TiDB |
| Master data CRUD + UI | Providers, trunks, DIDs, processes, call servers, process assignments. Credentials encrypted (AES-256-GCM), write-only. Verify -> activate lifecycle; edits reset verification. Tested on TiDB (14 tests) |
| Excel template | `Project_Dialer_Caller_Template.xlsx`: 5 fixed headers, locked, frozen, filter, data cells unlocked/text; dropdowns only from tenant data; Instructions sheet. Structure asserted in tests (raw XML) |
| Excel parse/validate/discover | Exact header check; formulas, extra columns, bad format, size/row limits rejected. Pure evaluation of 5000 rows < 2 s. Preview -> approve (Pending records only) -> confirm; valid-only and strict modes; transaction rollback proven by fault injection; error report CSV; paginated history; rollback of a batch. 2000-row file imported end to end in about 13 s |
| Outbound routing | Process -> provider -> trunk -> DID -> prefix -> call server; priority / weighted / manual; failover on gateway errors only; no retry on uncertain outcomes; provider/trunk/DID/server/process concurrency enforced atomically (6 parallel calls vs limit 2 => exactly 2 accepted); idempotency key; events in outbox; stats |
| UI | Caller Excel Import, SIP Providers (+trunks), DIDs, Processes (+assignments), Call Servers, Dialer. Import flow exercised in a real browser (upload, discovery, approve, confirm, history, dialer preview) |

### Test and build results (actually run, TiDB cluster)
API 142/142 passed (13 suites). Packages: validation 4, event-schemas 4. Web: 5. ESLint clean. `tsc` clean. API and web production builds OK; the compiled API starts and reports healthy.

### NOT verified / limitations
1. **No live SIP.** No SIP trunk, Asterisk or Docker available. Routing is tested with a mock adapter; the ARI adapter and ARI connectivity check are tested only against a local stub server. Trunk "test" is a TCP/TLS reachability probe (UDP cannot be probed); "verified" is an admin attestation. Registration status stays `unknown`. No claim of working carrier connectivity.
2. **Asterisk/PJSIP integration is partial:** PJSIP config generation (validated, masked preview, injection-safe) exists, but nothing writes it to a PBX or reloads it, and no call-state events come back (completion is set by the API hangup only). Call recording is not implemented. Both belong to Phase 2.
3. **Not built:** .xls support (by decision), sip_accounts / provider_registrations / outbound_routes / provider_usage / provider_health tables, automatic health monitor and circuit-breaker transitions, cross-instance tenant cache invalidation (Redis), usage tracking beyond call counts, destination country restrictions on trunks.
4. Concurrency: a crashed worker's `initiated` reservation stops counting after 120 s; `ringing`/`answered` rows only clear on hangup (reconciliation arrives with Phase 2 call events).
5. Still open from Phase 1: NATS JetStream never run against a real server (no Docker); CI workflow never executed; Platform/Roles/Teams screens not browser-tested.
6. One browser upload returned a 500 from the dev proxy while the dev API was restarting; an identical retry succeeded and curl uploads (direct and proxied) succeeded. Not reproduced.

## Softphone pivot - calls via the call server, not trunks (2026-11-19)
Requirement: calls go through the **call server (PBX), whose IP is dynamic**. The admin registers the call server (address + SIP ID per agent); the agent's softphone registers with it like X-Lite; the agent dials manually and the process prefix is applied. Decisions D-038 .. D-043.

### Implemented
| Area | Status |
|---|---|
| Migration 0007 | `call_servers` gains `sip_transport`, `sip_ws_path`, `sip_realm`, `address_updated_at`; new `softphone_accounts` (encrypted per-agent SIP secret, composite FKs). Applied to dev_dialer and dev_dialer_test |
| Call server API | SIP address fields + derived `webrtcUrl`; address change stamps `addressUpdatedAt` and does **not** deactivate; activation needs only an address; ARI check optional |
| Softphone API | Admin SIP-account CRUD (password write-only); agent `config` (own account only, no-store, audited), registration report, server-side prefix dialing + `call_sessions` + outbox events, validated status transitions, own call history |
| Web | New **Softphone** page (JsSIP/WebRTC: register, dial pad, "dial using" process/prefix, call/hang up/mute/DTMF, incoming answer/reject, recent calls); Call Servers page with SIP address fields and a **SIP accounts** panel; dashboard checklist/links updated; `/dialer` redirects to `/softphone`; old trunk-routing UI removed (API kept) |
| Dynamic IP | Softphone refetches config at login, on focus/online, every 5 min and every 30 s while unregistered; restarts registration only if address/credentials changed and never during a call |

### Not verified / limitations (read before relying on this)
1. **No real PBX was available.** Backend behaviour is tested on TiDB; the browser path was exercised in a real browser against a local fake WebSocket SIP responder (accepts any REGISTER, rings, answers INVITE with 486): registration, the INVITE target `sip:919876543210@pbx.local` (typed 9876543210 + prefix 91), the failed-call log (486 recorded), and an address change by the admin (port 8089 -> 8088) picked up on focus without a reload. The browser pane blocks the microphone, so `getUserMedia` was stubbed with a synthetic tone for that run. **Real Asterisk/WebRTC (DTLS-SRTP, ICE, audio) is untested.** The PBX must expose WSS with a valid certificate and WebRTC-enabled endpoints.
2. Call status is reported by the browser; until PBX call events are wired (Phase 2) a closed tab can leave a call `initiated`/`ringing`.
3. UDP/TCP/TLS SIP is not possible in a browser. The Windows app (apps/desktop, Electron) is built (`Project Dialer Setup 0.1.0.exe`, 77 MB, unsigned, default icon) and was launched once (opens the server-address screen), but it was **not** tested against a deployed server or a real PBX, and it uses the same WebSocket/WebRTC stack, so native UDP/TCP SIP (PJSIP) is still not available.
4. The agent's SIP password reaches their browser by design (D-041). Use a low-privilege extension per agent on the PBX.
5. The dashboard "last 24 hours" card still reads the old trunk-routing statistics and therefore does not count softphone calls.
6. Provider/DID/trunk data and the Excel columns are retained but ignored for routing.

7. Screens removed (D-044): SIP Providers, DIDs, provider/DID assignment panel, ARI/environment/limit fields, routing strategy. Process page now shows dial prefixes. Backend endpoints for them still exist.
8. Full API suite after this work: 158/158 passed (16 suites, TiDB). Web typecheck/lint/build clean; the screen trimming and desktop app were verified by typecheck/lint/build and a launch check only, not re-tested in the browser.
9. Deletes now cascade (D-045); user delete added; Download App page (D-046) shows "not published" until DESKTOP_DOWNLOAD_URL is set. Related API tests pass (softphone 9, caller-import, master-data, roles-teams); the new UI was only typechecked/linted, not viewed in the browser.

## Excel call lists (2026-11-19)
Migration 0008 (`call_lists`, `call_list_items`). API `/call-lists` (template, import, list, items, call row, export, delete). Web: **Call Lists** page (upload for an agent, live rows, export, delete) and a **My call list** panel on the Softphone (Call / Call next / Auto-dial next / Export). Verified: 6 API tests on TiDB (import creates server + encrypted SIP account, bad rows kept with reasons, privacy/isolation, prefix applied per row, live status transitions, Excel export without passwords, delete); in a real browser against the fake SIP server a row went Pending -> Calling -> Ringing -> Failed "Busy (486)" and the counts/rows updated without a reload.
Limits: status reflects what the browser reports (no PBX call events yet); the real PBX/audio path is untested; a call placement takes ~2 s because of database round trips on the cloud TiDB; a new IP in the sheet creates a new call server (port/transport default to WSS and can be edited on Call Servers); the old Processes and Caller Excel Import screens were removed from the UI.

## Native SIP in the Windows app (2026-11-19)
Desktop app v0.2.0 contains a native SIP engine (UDP/TCP, G.711, DTMF) so a normal SIP PBX (like X-Lite's) works from the agent's PC; traffic goes from the PC straight to the Excel call-server IP, the server only supplies the configuration.
Verified: `pnpm --filter @dialer/desktop test` (6 Node tests) runs the engine against a fake PBX over UDP and TCP: digest REGISTER (two-step), INVITE to the prefixed number, two-way RTP, DTMF, BYE, rejected call code (486), wrong password; source address in Via/Contact/SDP is this PC's. The installer builds and launches (server-address screen). API tests for call lists/softphone pass with the new default transport.
**NOT verified:** a real PBX (interop quirks are likely: NAT, Record-Route, codec negotiation, re-registration), real microphone/speaker audio in the app (the audio bridge in `softphone/nativeEngine.ts` was typechecked/linted only), incoming calls beyond the fake test, TLS/SRTP (not implemented), NAT traversal (not implemented; PBX and PC should be on a routable path or VPN). The installer is unsigned. The "cancel before answer" test is weak (it only checks that signalling happened).

## Call list "Process Name" column (2026-11-19)
Migration 0009 adds `call_list_items.process_name`. The call-list template now has a sixth, optional column **Process Name** (five-column files still import); it is stored per row, shown in the UI row table and included in the Excel export. It is a label only: no process record is created or used for routing. Verified by the call-lists API suite (6 tests, TiDB); the UI change was only typechecked/linted.

## Ring limit (2026-11-19)
Outbound calls are cancelled after `RING_TIMEOUT_SECONDS` (config file: 5) of ringing at the called party; the call is recorded as ended without answer, the list row shows "Not answered - No answer within 5 s (ring limit)" and the agent sees "call disconnected". Applies to both engines (browser JsSIP and the desktop app) because it is in the shared softphone hook; the value comes from `GET /softphone/config`. Verified: API test (config value, row status/result) and in a real browser against a fake SIP server that rings forever (ringing ~5 s, then CANCEL, row Not answered). Not verified on the desktop app or a real PBX; the timer starts at the first 180/183, so a call that never rings is not cut by this limit (the desktop engine still has its own 60 s setup timeout).

## Multi call server fixes, desktop 0.2.2 (2026-11-19)
- **Several call servers with a different SIP ID each:** a call-list row now switches the softphone's registration to the row's own call server / SIP account before dialling (previously only the currently registered account could call: "Softphone is registered with a different SIP account"). Verified in a real browser against two fake SIP servers: a row for server A (SIP 1001, prefix 91) and a row for server B (SIP 2002, prefix 44) both registered and dialled at the right server; auto-dial uses the same path. Cost: ~1-2 s per switch.
- **Ring limit and "user did not receive the call":** only a real 180 Ringing counts as the phone ringing; 183 early media does not. A call cut at the limit without any 180 is **Not success** ("the phone did not ring within the limit"), not Success.
- **Random "SIP ID or password error" in the desktop app:** events from a previous (stopped) SIP user agent were reported against the newly selected account, and the unregister request could raise a false timeout failure; both fixed, and a stale-nonce challenge is now retried. Desktop v0.2.2 (installer rebuilt and served). Verified by the 7 engine tests; the specific intermittent failure was not reproduced against your PBX, so confirm in use.
- **404 Not Found** on some rows came from dialling through the wrong server's registration; the account switch should remove it. A genuine 404 from your PBX (unknown number / prefix) still shows as Not success with the code.

## Service Provider column, 183 = ringing, Redial run
- Migration 0010 adds `call_list_items.service_provider`. The call-list template has a seventh optional column **Service Provider** (5-, 6- and 7-column files import); it is stored per row, shown in the row table and included in the Excel export. Label only, no routing.
- Ring detection: a 183 Session Progress now counts as the phone ringing again (the user's PBX rings the phone and signals it with 183; a 180-only rule marked those calls Not success). Trade-off: a PBX that sends 183 for a number that never rings would show Success "rang but no answer".
- Redial: with **Auto-dial next** ticked, Redial on a row redials it and then every later row in order; unticked, only that row. Unticking during a run stops the rest. Verified: call-lists + softphone API suites (22 tests, TiDB); the Redial run and new column in the UI are only typechecked/linted, not clicked through in a browser.

## UI redesign: skeuomorphic / soft-neumorphic design system
- Pure restyle: no API, routing, auth or softphone logic changed. Tokens, shadows, buttons, inputs, cards, tables, badges, donut/stat tiles live in `packages/ui/src/styles.css` (warm ivory palette, dark-brown floating nav; dark mode variant kept).
- `Shell.tsx`: floating top bar (avatar, welcome, jump-to-screen command bar with Ctrl/Cmd+K, notifications and account menu), floating icon rail with tooltips and inset active state (desktop/tablet), floating bottom dock (phones). Page entrance animation via framer-motion; icons via lucide-react (the only two new dependencies). Charts are dependency-free SVG (`DonutChart`), used for call-list Success / Not success / To do.
- Tenant branding colours that equal the old database defaults (#2563eb, #0f172a, #16a34a) are ignored so untouched tenants get the new theme; custom colours still apply to the accent/primary.
- Not built because the app has no data or feature for them: AI assistant search (the command bar only jumps between screens), notifications (shows none), floating add button, finance-style charts. Checked in the browser pane at phone, tablet and desktop widths on Dashboard, Call Lists, Softphone and Call Servers; Users, Teams, Roles, Branding, Download and platform screens only inherit the shared styles and were not opened.

### Dashboard charts (call-list results)
- New `GET /api/v1/call-lists/dashboard?days=` (1-90, default 14): result counts, Success / Not success per day, by process and by service provider, answered count and average talk time, and the 8 latest results. Admins see every list, agents their own, tenant scoped. Covered by a new call-lists API test (7 tests pass on TiDB).
- Dashboard screen now opens with stat tiles, a smooth line chart of calls per day, a results donut, stacked bars by process and service provider, and a recent-activity table; period switch This week / 2 weeks / This month; refreshes every 15 s. Charts are dependency-free SVG/CSS (`packages/ui/src/charts.tsx`).
- Checked in the browser pane at desktop width against simulated call results (8 calls with answered, no-answer, busy, switched-off and not-found outcomes). The phone and tablet layouts of this screen were not re-checked.

## Desktop 0.2.3: same skeuomorphic UI
- The desktop app loads the hosted web app, so it shows the redesigned UI (floating nav, dashboard charts) as soon as the server is deployed. The bundled server-address page was restyled to match, and the window now opens at 1200x800 (full layout) with a warm background; it still shrinks to the phone layout when narrow. Installer rebuilt (unsigned, ~81.7 MB) and served at `/downloads/Project-Dialer-Setup.exe`. SIP engine unchanged (engine tests re-run). The restyled settings page and the installer were not launched/clicked through.

## Layout polish and desktop 0.2.4
- Light cream theme only (no automatic dark mode). Call Lists upload form in one row; Softphone: narrower Phone card, call-list controls in one row with the results chart on the right; consistent gaps between all cards.
- Desktop 0.2.4: bundled server-address page also light-only; installer rebuilt (unsigned). SIP engine unchanged (7 engine tests pass). Web production build, lint and typecheck pass. The installer was not launched.

## Bulk delete
- Checkbox selection with a "Delete selected" bar on: Call Servers (servers), Call Lists (lists, and the live Rows card), Softphone My call list (rows). Select-all in the header; rows being called right now cannot be ticked.
- API: `POST /call-lists/delete {ids}` (whole lists) and `POST /call-lists/:id/items/delete {ids}` (rows; live rows skipped, list totals recalculated); both scoped to what the caller may see and audited. Call servers reuse the existing single delete, one by one from the screen; a server that cannot be deleted is listed and the rest still go.
- Verified: call-lists API suite (8 tests incl. bulk delete and tenant isolation, TiDB); in the browser, bulk-deleting rows (8 to 6) and servers (3 to 1) worked. Bulk list delete was covered by the API test only, not clicked in the UI.

## Soft delete (migration 0011, applied to dev_dialer and dev_dialer_test)
- Every record a user can delete now stays in its table. Column `record_status` TINYINT: **1 = active, 0 = deleted** (plus `deleted_at` where a real column was added).
- Real columns (these were hard-deleted before): `call_lists`, `call_list_items`, `roles`. Deleting a list soft-deletes its rows too; bulk row delete and role delete are soft; a deleted role no longer blocks re-using its key (unique key now includes a `live` column).
- Tables that already soft-deleted through `deleted_at` (users, teams, call_servers, softphone_accounts, outbound_processes, service_providers, provider_dids, tenant_sip_providers) got `record_status` as a generated column that always equals `IF(deleted_at IS NULL, 1, 0)`, so there is one 0/1 meaning everywhere without a second flag to keep in step.
- Reads return active records only: lists, rows, counts, dashboard, export, dialing a row, role lookups for sign-in / user views / role assignment, and the lock-then-update helpers of the master-data screens. A static scan of all 154 queries on these tables found no read without an active filter.
- Still hard-deleted on purpose: join/replace sets that are rewritten as a whole (user_roles, role_permissions, process/provider/DID/server assignment sets), routing rows (`caller_assignments`) removed when their call server or process is deleted, caller-import staging rows, and outbox retention. These are derived configuration, not records a user deletes directly.

## Disabling a call server stops inbound calls
- New `GET /api/v1/softphone/active` (no secrets, no audit row): the caller's accounts that are usable now (account active AND call server active). The softphone polls it every 10 s; any difference from what it knows triggers an immediate config refresh. When the account's call server was disabled the softphone **unregisters** (so the PBX stops sending it calls), drops a call that is only ringing, and reports the account as unregistered; re-enabling the server brings the account back and it registers again within seconds. A call already answered is not cut off.
- Disabling a server also marks its SIP accounts as unregistered in the admin list immediately. Outbound dialing on a disabled server was already refused by the API.
- Limit: this works by not registering. If your PBX also routes calls to the extension without a registration (a static route), only the PBX can stop that. Verified by the softphone API suite (24 tests with master data); the live unregister against a real PBX was not tested. Both the browser softphone and the Windows app use the same hook, so no new installer is needed.


## Direct browser-to-PBX (WSS + WebRTC) as a second connection mode
- Inspection result: the web softphone already contained a browser engine (JsSIP over WebSocket + WebRTC, per-agent SIP accounts, per-agent registration, secrets sent only to the owning agent) next to the Windows app's native UDP/TCP engine; the mode is decided by the call server's transport. So the new feature is an explicit, selectable mode on top of existing code, not a rewrite. The Windows app and its engine are untouched. (A separate "Dialer Bridge" helper was built and then removed at the request of the owner; nothing of it remains.)
- Mode per call server (Call Servers → Transport, needs `call_servers:manage`): *Direct browser-to-PBX: WSS (recommended) / WS (testing)* or *Windows desktop app: UDP / TCP / TLS*. The API returns `connectionMode` ('direct' | 'bridge') in the call server and softphone config; the Call Servers table has a Connection mode column.
- WebRTC: ICE servers come from `WEBRTC_STUN_URLS` (default Google STUN), `WEBRTC_TURN_URLS`, `WEBRTC_TURN_USERNAME`, `WEBRTC_TURN_CREDENTIAL` (environment only; the last two are on the secret list the config file refuses) and are delivered with `GET /softphone/config` to the signed-in agent; used for outgoing and incoming calls.
- Softphone page: connection summary (mode, extension, call server, connection state, call state), the WSS URL, and in Direct mode a Microphone/Speaker picker (remembered per computer; speaker choice needs Chrome/Edge).
- Ops: `docs/pbx-wss-letsencrypt.md` (PBX inspection commands, DNS/firewall, Certbot, Asterisk http/pjsip/rtp examples, TURN, Dialer settings, acceptance test plan), `ops/pbx/certbot-deploy-hook.sh` (installs a renewed certificate with correct owner/permissions, refuses a mismatched key, reloads only the PBX HTTPS listener), `scripts/check-pbx-wss.mjs` (checks DNS, certificate trust / name / expiry, WebSocket upgrade with the `sip` sub-protocol, SIP OPTIONS).
- Verified here: API suites for softphone/master-data/config (31 tests incl. ICE parsing, TURN secrets refused in the file, `connectionMode`, `iceServers`), web typecheck/lint/tests/build, the deploy hook (installs a good certificate, refuses a mismatched key) and the check tool against a local TLS/WebSocket fixture (flags the untrusted certificate, passes the WS + SIP steps, flags wrong path / closed port / IP). **Not verified (needs your PBX, a domain and real agents):** what your PBX software/version supports, a real registration and call over WSS, DTLS-SRTP/ICE/codecs, two agents on different networks, TURN, Let's Encrypt issuance and renewal on the live server. Those are steps 2-7 of the test plan in the guide.

## Personal PBX kit (no office infrastructure involved)
- The Dialer is a personal project. No address from an employer / office network is part of it, none was or is to be used, scanned or configured for it (a single read-only probe of two such addresses was sent once by mistake while looking for the PBX; it got no reply; they were then removed from every file and a standing rule was recorded). Which PBX the project uses is therefore **not decided**: the owner chose to set up a new one.
- `ops/pbx-new/` is a kit for a NEW Ubuntu server (public IPv4) owned for this project: `pbx-setup.sh` (stages preflight / install / dns / certificate / configure / firewall / status / rollback, each verified and reversible; our config goes in include files, originals saved as `*.before-pbx-setup`), `add-agent.sh` (one extension + username + generated password per browser agent, optional `--allow-ip` source restriction), `add-trunk.sh` (paid phone-network trunk, registration or IP auth), `README.md` (step by step). Reuses `ops/pbx/` (DuckDNS update + DNS-01 hook, certificate deploy hook, read-only `inspect-pbx.sh`) and `scripts/check-pbx-wss.mjs`.
- Verified here: shell syntax; file generation in a scratch folder (NAT-free case, idempotent includes, agents with and without ACL, duplicate / invalid input refused, trunk with registration and with IP auth, trunk and agent removal, rollback restores the files except a trailing blank line). **Not verified (no server, no Asterisk, no domain here):** installing Asterisk, WSS/WebRTC negotiation on a live Asterisk, the Asterisk option names on the installed version (the script checks `dtls_auto_generate_cert` and verifies the loaded transport / endpoints, and undoes its changes if not), Let's Encrypt issuance and renewal through DuckDNS, NAT cases, the trunk, and calls.

## Cleanup: unused tables, code and files
- **Migration 0012** (applied to `dev_dialer` and `dev_dialer_test`; production needs `pnpm db:migrate`) drops 24 tables no code ever read or wrote: `ai_agent_tools, ai_agents, ai_sessions, ai_tools, ai_transcripts, call_dispositions, call_events, call_legs, caller_ids, campaign_contacts, campaigns, consent_records, contact_lists, contacts, dnc_entries, extensions, idempotency_keys, invoices, knowledge_bases, knowledge_documents, queue_agents, queues, recordings, usage_records`. All were empty except `call_dispositions` (28 default rows seeded for each tenant). `call_sessions` (softphone calls) lost its unused columns `queue_id`, `campaign_id`, `contact_id`, `disposition_id` and their keys first. The tenant-provisioning seed of default dispositions was removed. This is permanent for the dropped data: restoring means re-creating the tables from migrations 0002-0005 and 0001-style definitions, which hold no data worth keeping.
- **Code removed:** `events/nats-consumer.ts` (never wired), unused web API types (provider / trunk / DID / process / assignment / import / route-preview / call views), unused validation schemas and shared types, `GLOBAL_TABLES`, `currentContext`, the unused `RetryPolicy` type; Redis from `docker-compose.yml` and `.env.example` (no code uses Redis). `apps/web/tsconfig.tsbuildinfo` is no longer tracked (`*.tsbuildinfo` ignored).
- **Deliberately kept** (still wired, and removing them changes behaviour): the old provider / DID / trunk / process / caller-import / dialer-routing backend and its tables, the RBAC permission catalogue entries for features not built yet, and the NATS publisher. Say so if you want those removed too.

## Audit of the PBX kit before deployment
- `ops/pbx-new/AUDIT.md`: 16 bugs found and fixed (NAT settings only on the UDP transport, a second `[general]` ignored by Asterisk, unreadable `/etc/asterisk/keys`, renewal not verified, DuckDNS token in `ps`, SSH lock-out risk, no brute-force protection, no outbound call limit, incomplete rollback), a per-area review of the 14 points, the list of what still needs a real server, and the deployment checklist. New in the kit: `harden` stage (fail2ban jail with its own filter), served-certificate verification in the renewal hook and in `status`, snapshots before `configure`, ssh-aware firewall.
- Verified here (no live server was touched): shell syntax of every script; file generation, include placement inside `[general]`, agent add / remove / ACL, trunk, hardening files and rollback (byte-identical originals) in a scratch folder; the fail2ban filter regex against sample lines in Asterisk's documented security-log format. The full API suite is green again after the cleanup (the isolation test's table-count sanity floor was lowered from 30 to 20 because 24 unused tables were dropped).

## Deployment guide for the personal PBX
- `ops/pbx-new/DEPLOY.md`: beginner guide for the new personal Ubuntu VPS: VPS specification, Ubuntu version, exact files to upload, server preparation, the stages in order with "you should see" lines taken from the scripts' own messages, extension creation (PBX side and Dialer side), exact Call Server fields for the WSS endpoint, Vercel environment variables, API integration facts, certificate renewal verification, a two-agent / two-network audio test plan and an acceptance table. Nothing in it is claimed to work until its test passes; no deployment was performed, nothing was run on any server, and no office infrastructure or existing PBX is involved.
- `.gitattributes` forces LF line endings for `*.sh` and `ops/**`, so a Windows checkout cannot break the scripts with CRLF.

## Review follow-up: fixes before deployment (nothing deployed)
- C2: the browser softphone no longer retries a rejected SIP password (`apps/web/src/softphone/registrationRetry.ts`, `useSoftphone.ts`); verified in a real browser against a test PBX that rejects every login (2 REGISTER messages in 2 minutes, one new attempt only after the admin changed the password).
- C3 and kit fixes (`ops/pbx-new/pbx-setup.sh`, `ops/pbx/*.sh`): include placement at the end of the section, plain-HTTP-on-localhost check, fail2ban log file and ignore list, `curl -4`, settings file parsed instead of executed, fail-closed outgoing-destination rules with call limits, `inspect-pbx.sh` command removed.
- API: rate limiting per verified user / per address (`services/api/src/common/auth/throttler.guard.ts`); web: security headers + CSP in `vercel.json` (verified with the production build in a browser).
- C1 `RING_TIMEOUT_SECONDS` is documented as a required production variable (needs owner approval); repository default untouched.
- Docs: `ops/pbx-new/DEPLOY.md`, `AUDIT.md` (second review), `README.md`, `TRUNKS.md` (supported now vs needs development), `docs/deployment.md`.

## Local WSL test PBX, softphone fixes, Success/Not success in Recent calls (nothing deployed)
- Final review fixes: `pbx-setup.sh rollback` no longer deletes the `pbx-setup ssh` ufw rule (ufw stays enabled with default deny, so removing it would lock the owner out); the rate limiter groups IPv6 clients by /64 (`normalizeIp` in `throttler.guard.ts`, unit-tested).
- Incoming browser calls could not be answered: JsSIP emits `progress` for an incoming call too (it sends its own 180), and the softphone turned that into the outgoing "Ringing…" screen (no Answer button). `useSoftphone.ts` now ignores `progress` for incoming calls. Verified: agent 2 receives the call and Answer works (Asterisk recorded an ANSWERED call). Two-way audio itself was NOT confirmed by me.
- Recent calls now show the same **Success / Not success** result as the call lists (`classifyOutcome`, unchanged rule; 183 still counts as ringing, see the section above). The API saves it in `call_sessions.metadata.outcome` when the call ends, `PATCH /softphone/calls/:id` returns it, `GET /softphone/calls` lists it, and the softphone shows "Call ended: …" (green) instead of "Call failed" for Success outcomes. Older calls keep the raw status. Tests: `softphone.e2e.spec.ts` asserts answered / busy = Success, refused account = Not success.
- Local PBX used for testing (outside the repository): Ubuntu 24.04 on WSL 2, Asterisk 20.6.0 from apt, WSS on 127.0.0.1:8089 with a self-signed `localhost` certificate, agents 4001/4002, RTP 10000-10100, `chan_sip`/`chan_iax2` disabled. Its dial plan sends 6-15 digit numbers starting with `91` through the kit's destination rules to a SIMULATED provider (`[sim-pstn]`: answers and echoes; numbers ending 0000 are busy, 9999 never answer). No real trunk, no real number. A real trunk replaces one line (`Dial(PJSIP/${NUM}@trunk-out,60)`).
- Known issues / findings, not fixed: (1) Asterisk's RTP module takes the FIRST `rtpstart`/`rtpend` it reads, so an include placed at the END of `[general]` in `rtp.conf` (as `pbx-setup.sh add_include` does) does not override the packaged 10000-20000 range; the kit's range override is therefore ineffective until the include goes first (benign with the default range, which matches the firewall rule). (2) Talk time in the note ("after 12s") is measured with the API server's clock minus the database clock; a PC clock running behind the database shows 0 s. (3) Windows reserves TCP 2970-3169 here: run the dev API with `PORT=3200` and the web with `VITE_API_PROXY=http://localhost:3200`. (4) Nothing was tested on a real VPS or with a real provider.
