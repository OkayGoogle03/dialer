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

## Configuration (config file + secrets)
Settings are split in two so nothing sensitive is ever committed:

| Where | What | In git? |
|---|---|---|
| `config/app.config.json` | Non-secret settings, with sections `defaults`, `development`, `preview`, `production` (DB host/name/port/TLS/user prefix, log level, token lifetimes, pool size, CORS origins) | yes |
| Host environment (Vercel -> Settings -> Environment Variables) | The four secrets: `DB_API_PASSWORD`, `DB_PLATFORM_PASSWORD`, `JWT_ACCESS_SECRET`, `CREDENTIALS_ENCRYPTION_KEY` | **never** |

Precedence: a real environment variable always overrides the file. The section is chosen by `APP_ENV`, else Vercel's `VERCEL_ENV` (production / preview / development), else `NODE_ENV`. The loader refuses any secret found in the file. The `production` section is blank on purpose: fill in the production database there; until you do, the API reports exactly which settings are missing instead of using the development database.

Generate the two secrets that can be generated with `pnpm secrets:generate` (the two database passwords come from `pnpm db:setup-roles`). Vercel can import them in one go: in Environment Variables, paste several `NAME=value` lines into the first field.

## Vercel (web app + API in one project)
One Vercel project serves the web app (static files from `apps/web/dist`) and the existing Node.js (NestJS) backend as a Vercel Function. `vercel.json` rewrites `/api/*` to `api/index.js`, which loads the compiled app from `services/api/dist`; every other path falls back to the single-page app. The browser talks to one address, so no CORS is needed and the login cookie works.

Project settings (Vercel -> New Project -> import the GitHub repo, **Root Directory `./`**, Application Preset **Other**; the install/build commands come from `vercel.json`):

| Setting | Value |
|---|---|
| Environment variable `ENABLE_EXPERIMENTAL_COREPACK` | `1` (makes Vercel use the pinned pnpm 12.8.1) |
| Node.js version | 22.x |
| Production branch | `main` (the `dev` branch gets preview deployments automatically) |
| Function region | `sin1`, set in vercel.json: next to a TiDB cluster in Singapore. Every request makes several database round trips, so keep them close |
| Secrets | the four from the table above, set for Production and for Preview (use a separate production database and separate secrets) |

Never put the database **owner** credentials in Vercel; run migrations (`pnpm db:migrate`, `pnpm db:setup-roles`) from your own machine.

Serverless limits to know about:
- Request bodies are capped at 4.5 MB, so the Excel upload limit is 4 MB.
- No background jobs: the outbox-to-NATS relay is not started on Vercel. Telephony workers (Phase 2) need a long-running host.
- Rate limits and the tenant-status cache are per warm instance (not shared).
- Cold starts add a second or two to the first request after idle time.
- The Vercel Hobby (free) plan is for non-commercial use only.
- Verified only up to the function entry (run locally with a plain Node server and only the four secrets set); it has not been deployed from Vercel yet.
