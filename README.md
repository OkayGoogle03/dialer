# Project Dialer

White-label, multi-tenant AI dialer SaaS on TiDB (MySQL 8). Current state: **Phase 1 — Foundation** (see [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md)).

```
apps/web                 React 19 + Vite admin/agent UI
services/api             NestJS 11 REST API (/api/v1, OpenAPI at /api/docs)
database/migrations      SQL migrations; dbctl.mjs (migrate, roles, grants)
packages/                shared-types, validation, event-schemas, ui, config
docs/                    architecture, database, api, events, security, deployment, testing, decisions
```

Quick start: see [docs/deployment.md](docs/deployment.md). Tests: `pnpm test` (needs DB_* in .env; NATS tests need Docker).
