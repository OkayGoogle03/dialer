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
