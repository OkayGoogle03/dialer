# API

Base: `/api/v1`. OpenAPI UI: `/api/docs`, JSON: `/api/docs/openapi.json` (disabled when `NODE_ENV=production`).

Error envelope (all errors):
```json
{ "error": { "status": 400, "code": "BAD_REQUEST", "message": "Validation failed", "details": ["..."], "correlationId": "..." } }
```

## Implemented
| Method | Path | Auth | Permission |
|---|---|---|---|
| GET | /health/live, /health/ready | public | — |
| POST | /auth/login | public (10/min/IP) | — |
| POST | /auth/refresh | public (30/min/IP) | cookie or body token |
| POST | /auth/logout | public | — |
| GET | /auth/me | bearer | — |
| GET | /public/branding?tenant= | public | — |
| GET | /tenants/current | bearer | tenant:read |
| GET/PUT | /branding | bearer | PUT: branding:manage |
| GET | /users, /users/:id | bearer | users:read |
| POST/PATCH | /users, /users/:id | bearer | users:manage |

Request bodies are whitelisted: unknown properties (e.g. `tenantId`) are rejected with 400.

## Planned (by phase)
Phase 1: platform tenants, roles, teams. Phase 2: extensions, sip-providers, calls (`POST /calls` with `Idempotency-Key`, returns 202), call history, recordings (signed URLs). Phase 4: contacts (CSV import), campaigns, queues, agents, supervisors, reports. Phase 5–6: ai-agents, ai-sessions, knowledge-bases. Phase 7: billing/usage.

## Added in Batch 2
| Method | Path | Permission |
|---|---|---|
| GET | /roles | users:read |
| POST/PATCH/DELETE | /roles, /roles/:id | roles:manage (system roles immutable) |
| GET | /permissions | roles:manage |
| GET | /teams, /teams/:id | users:read |
| POST/PATCH/DELETE | /teams, /teams/:id | teams:manage |
| PUT | /teams/:id/members | teams:manage |
| GET/POST | /platform/tenants | platform admin |
| GET/PATCH | /platform/tenants/:id | platform admin |
| POST | /platform/tenants/:id/suspend, /reactivate | platform admin |

Users now accept `roles` as role keys (including custom roles) and an optional `teamId`; `GET /users` accepts `teamId`. All responses carry `X-Correlation-Id`.
