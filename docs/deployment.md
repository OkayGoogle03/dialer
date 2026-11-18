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

## Vercel (web app + API in one project)
One Vercel project serves the web app (static files from `apps/web/dist`) and the existing Node.js (NestJS) backend as a Vercel Function. `vercel.json` rewrites `/api/*` to `api/index.js`, which loads the compiled app from `services/api/dist`; every other path falls back to the single-page app. The browser talks to one address, so no CORS is needed and the login cookie works.

Project settings (Vercel -> New Project -> import the GitHub repo, root directory `/`, framework "Other"; the install/build commands come from `vercel.json`):

| Setting | Value |
|---|---|
| Environment variable `ENABLE_EXPERIMENTAL_COREPACK` | `1` (makes Vercel use the pinned pnpm 12.8.1) |
| Node.js version | 22.x |
| Production branch | `main` (the `dev` branch gets preview deployments automatically) |
| Function region | `sin1`, set in vercel.json: next to a TiDB cluster in Singapore. Every request makes several database round trips, so keep them close |

Environment variables (Project -> Settings -> Environment Variables; mark secrets Sensitive; use different values for Production and Preview, and a **separate production database**):

| Name | Value |
|---|---|
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_TLS`, `DB_USER_PREFIX` | TiDB connection (`DB_TLS=true`) |
| `DB_API_PASSWORD`, `DB_PLATFORM_PASSWORD` | the restricted `dialer_api` / `dialer_platform` users from `pnpm db:setup-roles` |
| `DB_POOL_SIZE` | `3` (every warm function instance keeps its own connections) |
| `JWT_ACCESS_SECRET` | 48+ random bytes |
| `CREDENTIALS_ENCRYPTION_KEY` | 32 random bytes, base64; never change it for a database that has saved credentials |

Never put the database **owner** credentials in Vercel; run migrations (`pnpm db:migrate`, `pnpm db:setup-roles`) from your own machine.

Serverless limits to know about:
- Request bodies are capped at 4.5 MB, so the Excel upload limit is 4 MB.
- No background jobs: the outbox-to-NATS relay is not started on Vercel. Telephony workers (Phase 2) need a long-running host.
- Rate limits and the tenant-status cache are per warm instance (not shared).
- Cold starts add a second or two to the first request after idle time.
- The Vercel Hobby (free) plan is for non-commercial use only.
- Verified only up to the function entry (run locally with a plain Node server); it has not been deployed from Vercel yet.
