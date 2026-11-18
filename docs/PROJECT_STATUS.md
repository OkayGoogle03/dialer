# Project Status

**Current phase:** 1 — Foundation (batches 1–2 done; two verification gaps below block "Phase 1 verified")
**Last updated:** 2026-11-18

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
