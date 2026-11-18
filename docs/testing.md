# Testing

```bash
pnpm test            # all workspaces (API integration tests need DB_* in .env)
pnpm lint && pnpm typecheck
```

API integration tests prepare `<DB_NAME>_test` on the configured TiDB (migrations + grants) and boot the real Nest app. NATS tests need a NATS server (not yet run: no Docker on the dev machine).

## Results log
| Date | Suite | Result |
|---|---|---|
| 2026-11-18 | API on real TiDB: auth-tenancy (16), platform (8), roles-teams (5), isolation (9), events-logging (4), unit (11) | 53/53 passed |
| 2026-11-18 | packages: validation (4), event-schemas (4); web client (5) | 13/13 passed |
| 2026-11-18 | ESLint, `tsc` for all workspaces, API + web production builds | clean |
| — | Real NATS JetStream integration | **not run** |
| — | CI workflow execution; browser test of Platform/Roles/Teams screens | **not run** |

## Load-test plan (Phase 2+)
SIPp + RTP media scenarios at 50, 100, 250, 400, 500 concurrent calls, then an 8-hour soak. Measure CPU/mem/net, RTP loss/jitter, setup time, API p95, NATS lag, AI end-of-turn latency. No capacity claim is made until these pass with recorded results.
