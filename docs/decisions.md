# Decision Log

| ID | Date | Decision | Reason |
|---|---|---|---|
| D-001 | 2026-11-18 | pnpm workspaces monorepo; NestJS **11** (not 12) | 11 is the most widely compatible major with swagger/jwt/throttler; 12 is recent. |
| D-002 | 2026-11-18 | Raw SQL migrations + tiny runner (`database/migrate.mjs`) instead of an ORM | RLS policies, partitions, SECURITY DEFINER functions and composite FKs are first-class in SQL; avoids ORM drift. |
| D-003 | 2026-11-18 | Tenant isolation = RLS with `app.tenant_id` set via `set_config(..., true)` per transaction; runtime login role `dialer_api` ∈ `dialer_app` (non-owner, NOBYPASSRLS); FORCE RLS on all tenant tables | Defence in depth: even a missing `WHERE tenant_id` cannot leak data. Transaction-local setting is safe with pooled connections. |
| D-004 | 2026-11-18 | Super Admin = user in the single `is_platform` tenant with `is_platform_admin`. Cross-tenant ops will use a separate `dialer_platform` BYPASSRLS connection used only by the platform module | Keeps the normal request path unable to bypass RLS. |
| D-005 | 2026-11-18 | Composite tenant-aware FKs `(tenant_id, x_id) → x(tenant_id, id)` | FK checks bypass RLS; composite FKs make cross-tenant references impossible. |
| D-006 | 2026-11-18 | Login requires tenant slug (or custom domain → slug); emails unique per tenant | White-label: the same email may exist in multiple tenants. |
| D-007 | 2026-11-18 | Partition `call_events` monthly now; `call_sessions` not partitioned yet | `call_events` is the highest-volume append-only table. Partitioning `call_sessions` would complicate the many FKs into it; revisit at ~50M rows. |
| D-008 | 2026-11-18 | Passwords: Node `crypto.scrypt` (N=2^15, r=8, p=1) | No native dependency (Windows-friendly); memory-hard. |
| D-009 | 2026-11-18 | Refresh token = `tenantId.tokenId.secret`, sha256(secret) stored; rotation with reuse detection revoking the token family. Web gets it as httpOnly SameSite=Strict cookie scoped to `/api/v1/auth`; desktop gets it in the body | Tenant id is only a lookup hint; forged ids find nothing under RLS. Cookie keeps it out of JS. |
| D-010 | 2026-11-18 | Tests use PGlite (Postgres 17 in WASM) with `SET LOCAL ROLE dialer_app` | No Docker on dev machine; still exercises real RLS, FKs, triggers, partitions. |
| D-011 | 2026-11-18 | `sip_providers` = platform catalogue (no secrets); `tenant_sip_providers` = tenant trunks with encrypted credentials, priority/weight/limits/circuit state | Matches "multiple providers per tenant" + provider abstraction. |
| D-012 | 2026-11-18 | AI disclosure message is a NOT NULL column with a CHECK for autonomous agents; predictive/AI campaigns carry `legal_review_confirmed_at` | Compliance enforced at the data layer, not just UI. |
| D-013 | 2026-11-18 | Web: React 19 + Vite 6 + react-router 7, plain CSS design tokens (no UI kit yet) | Minimal dependencies; tokens are overridden per tenant at runtime. |

## Batch 2 (database switched to TiDB by user request)
D-002 now uses `database/dbctl.mjs`. D-003 (RLS), D-004 (BYPASSRLS role), D-005 and D-007 (partitioning) and D-010 (PGlite tests) are superseded by the entries below.

| ID | Decision | Reason |
|---|---|---|
| D-014 | Database = TiDB Cloud (MySQL 8 dialect) at the user's explicit choice, accepting loss of row-level security | User instruction. I recommended keeping PostgreSQL for RLS; recorded as an accepted trade-off. |
| D-015 | Isolation without RLS: (1) `withTenant` binds `:tenantId` from verified context and rejects caller-supplied values; (2) SQL guard requires one `:tenantId` bind per tenant-table reference and forbids comma joins; (3) composite `(tenant_id,id)` FKs; (4) DB-user grants; (5) test that `TENANT_TABLES` covers every table with `tenant_id` | Defence in depth replacing RLS. The guard is heuristic (counts binds); it complements review and tests rather than replacing them. |
| D-016 | Two DB users: `dialer_api` (tenant-scoped; cannot write tenants/platform_admins/audit; cannot read outbox) and `dialer_platform` (cross-tenant; only platform module, outbox relay, consumers, CLI) | Platform privilege is unreachable from tenant routes. |
| D-017 | Super admin = row in `platform_admins` (platform tenant only); JWT `pa` claim is advisory, `PlatformAdminGuard` re-reads the table per request | Instant revocation; tenant users cannot write the table. |
| D-018 | Suspension: 15 s tenant-status cache in the auth guard + refresh-token revocation + local cache invalidation | Bounded propagation without a DB hit per request; Redis broadcast later. |
| D-019 | `call_events` not partitioned on TiDB (partitioned tables cannot carry FKs; TiDB range-shards automatically); retention by TTL job in Phase 2 | Platform difference. |
| D-020 | Integration tests run on `<DB_NAME>_test` in the same TiDB cluster, unique tenant slugs per run | No Docker locally; real engine beats emulation. Slower (network). |
| D-021 | Idempotent DDL and per-statement migration tracking | TiDB DDL is not transactional. |
| D-022 | "Unique among live rows" via virtual column `live = IF(deleted_at IS NULL,1,NULL)` in unique keys | No partial indexes in MySQL. |
| D-023 | Outbox relay: lease columns, per-row exponential backoff, retry forever, `Nats-Msg-Id=event_id`; at-least-once | Several API instances can relay safely; no event loss. |
| D-024 | Consumers: `processed_events` marker and handler in one DB transaction; after `maxDeliver`, dead-letter to `DIALER_DLQ` | Exactly-once effects over at-least-once delivery. |
| D-025 | Shared packages built to CJS+ESM; API/Jest/Vite resolve them from source | No pre-build in dev. |
| D-026 | Anti-escalation: an actor may only grant, or modify holders of, permissions the actor holds | Stops user-managers minting admins. |

## Batch 3 - master data, Excel caller import, outbound routing
The spec for this batch said PostgreSQL; the project database is TiDB (D-014), so TiDB was kept.

| ID | Decision | Reason |
|---|---|---|
| D-027 | "SIP trunk" = the existing `tenant_sip_providers` table (extended in 0006); "service provider" = new `service_providers` business entity above it | Avoids a duplicate trunk table; provider = routing/priority/limits, trunk = connection + encrypted credentials. |
| D-028 | `provider_dids` is the DID master; the older `caller_ids` table (campaign FK) is left untouched | `caller_ids` has no provider link; changing it would break the campaign schema. |
| D-029 | Anything that could carry a call must be *verified*: trunk (test + admin confirm), DID (admin confirm), call server (real ARI check). Editing connection settings resets verification and deactivates. Routing refuses unverified resources | Requirement "never mark unverified provider/DID/server operational". Trunk "verified" = reachable + admin attestation; SIP registration is not proven (Phase 2). |
| D-030 | Excel import is two-phase: preview (read-only) -> approve proposals (creates Pending records, never technical config) -> confirm (re-validates with `allowProposals=false`) | Nothing is created implicitly; confirm cannot import rows whose master data was not approved. |
| D-031 | `.xlsx` only (user decision); header row checked exactly and independently of worksheet protection; template samples live on the Instructions sheet, not the data sheet | `.xls` has no maintained safe parser; samples in the data sheet would be imported by accident. |
| D-032 | Prefix = dial prefix prepended to the destination number for that assignment (+E.164 input is already international) | User had no preference; this is the common dialer meaning. DID stays the caller ID. |
| D-033 | Concurrency reservation: row locks in fixed order (provider, trunk, DID, server, process) + **locking** count read + insert, then adapter call outside the transaction; deadlock retry | TiDB plain reads use the transaction-start snapshot, so a non-locking count let 6/6 parallel calls through a limit of 2 (found by test). |
| D-034 | Uncertain call outcomes (timeout after send) are never retried and are reported as `uncertain`; only gateway failures (500/502/503/504, ARI unreachable) fail over | Avoids duplicate calls. |
| D-035 | Telephony behind `TelephonyAdapter`; `AriTelephonyAdapter` implements ARI HTTP originate/hangup but is only verified against a local stub | No Asterisk or SIP trunk available. |
| D-036 | Connectivity probes allow private ranges (Asterisk is usually internal) but refuse link-local/cloud-metadata addresses; admin-only, rate limited | SSRF mitigation without breaking the normal deployment. |
| D-037 | `caller_import:manage` (supervisor + admin) lets approval create Pending providers/processes/servers/DIDs; activating them needs `sip_providers:manage` / `call_servers:manage` | Imports can propose, only admins can make anything operational. |
