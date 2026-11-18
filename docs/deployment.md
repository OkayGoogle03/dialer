# Deployment

## Local development
Prerequisites: Node >= 22, pnpm, a TiDB/MySQL database, Docker Desktop for Redis/NATS.

```bash
cp .env.example .env   # fill DB_*, JWT_ACCESS_SECRET
docker compose up -d   # redis + nats
pnpm install && pnpm build:packages
pnpm db:migrate && pnpm db:setup-roles
PROVISION_ADMIN_PASSWORD=... pnpm --filter @dialer/api provision -- --slug platform --name Platform --email root@example.com --admin-name Root --platform --plan enterprise
pnpm dev:api           # http://localhost:3000/api/docs
pnpm dev:web           # http://localhost:5173
```

Log in at the web app with Company ID `platform` to reach Platform · Tenants.

## Production (planned, Phase 7)
- Kubernetes for API, AI orchestrator, web (static via CDN). Telephony (Kamailio, Asterisk, media-gateway) on dedicated node pools with host networking for RTP, scaled with drain-aware procedures (mark Asterisk node inactive in Kamailio dispatcher, wait for active channels = 0, then remove).
- TiDB Cloud (dedicated tier) with backups; Redis HA; NATS JetStream 3-node cluster; S3 with SSE and lifecycle policies.
- Prometheus + Grafana, centralised JSON logs (already structured), alerting on call failure rate, provider health, RTP quality, event lag.
- Initial sizing estimates are in the master spec section 10 and must be validated by load tests.

## Cloudflare (web + API in one Worker)
`wrangler.jsonc` deploys one Worker per Cloudflare project: static web app (`apps/web/dist`) plus the NestJS API running in a **Cloudflare Container** (`services/api/Dockerfile`). Requests to `/api/*` go through `worker/index.ts` to the container; everything else is the web app. Containers need the **Workers Paid** plan.

| Project | Branch | Build command | Deploy command |
|---|---|---|---|
| `dialer` | `dev` | `pnpm run build` | `npx wrangler deploy` |
| `prod-dialer` | `main` | `pnpm run build` | `npx wrangler deploy --name prod-dialer` |

Set these as **Secrets** (Worker -> Settings -> Variables and Secrets -> type Secret; plain variables are overwritten by deploys). Use different values per project, and use a **separate database** for production:

| Name | Value |
|---|---|
| `DB_HOST`, `DB_PORT`, `DB_NAME` | TiDB connection (`DB_PORT` default 4000) |
| `DB_TLS` | `true` |
| `DB_USER_PREFIX` | TiDB Cloud user prefix, e.g. `abc123.` (empty for self-hosted) |
| `DB_API_PASSWORD`, `DB_PLATFORM_PASSWORD` | passwords of the restricted `dialer_api` / `dialer_platform` users created by `pnpm db:setup-roles` |
| `JWT_ACCESS_SECRET` | 48+ random bytes |
| `CREDENTIALS_ENCRYPTION_KEY` | 32 random bytes, base64. Must stay the same for the life of a database: stored SIP/ARI passwords are encrypted with it |

Never put the database **owner** credentials in Cloudflare; they are only for running migrations from a trusted machine (`pnpm db:migrate`, `pnpm db:setup-roles`).

Notes: the container sleeps after 15 idle minutes, so the first request afterwards waits a few seconds; rate limits and the tenant-status cache live per container instance; the image has been built only by replaying its steps outside Docker (see PROJECT_STATUS).
