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
3. UDP/TCP/TLS SIP is not possible in a browser; it needs the Windows desktop app (**not started**).
4. The agent's SIP password reaches their browser by design (D-041). Use a low-privilege extension per agent on the PBX.
5. The dashboard "last 24 hours" card still reads the old trunk-routing statistics and therefore does not count softphone calls.
6. Provider/DID/trunk data and the Excel columns are retained but ignored for routing.
