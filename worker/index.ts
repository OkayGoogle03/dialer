/**
 * Cloudflare Worker for the whole product:
 *  - /api/*  -> the NestJS API running in a Cloudflare Container (class ApiContainer, image: services/api/Dockerfile)
 *  - anything else -> the static web app (apps/web/dist, single-page-app fallback configured in wrangler.jsonc)
 * The browser only ever talks to one origin, so the httpOnly SameSite=Strict refresh cookie works and no CORS is needed.
 *
 * Configuration is read from this Worker's environment (Cloudflare dashboard -> Worker -> Settings -> Variables and Secrets,
 * type "Secret" so values survive deploys). See docs/deployment.md for the list.
 */
import { Container, getContainer } from '@cloudflare/containers';

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  API: DurableObjectNamespace<ApiContainer>;
  [key: string]: unknown;
}

/** Variables copied from the Worker environment into the container process. Anything not set is simply omitted. */
const API_ENV_KEYS = [
  'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_TLS', 'DB_USER_PREFIX', 'DB_API_USER', 'DB_PLATFORM_USER', 'DB_POOL_SIZE',
  'DB_API_PASSWORD', 'DB_PLATFORM_PASSWORD', 'JWT_ACCESS_SECRET', 'CREDENTIALS_ENCRYPTION_KEY',
  'JWT_ACCESS_TTL_SECONDS', 'REFRESH_TTL_DAYS', 'TENANT_STATUS_CACHE_SECONDS', 'LOG_LEVEL',
] as const;

export class ApiContainer extends Container<Env> {
  defaultPort = 3000;
  /** The container stops after this much idle time and starts again on the next request (a few seconds of cold start). */
  sleepAfter = '15m';
  /** The API must reach TiDB Cloud over the internet. */
  enableInternet = true;
  pingEndpoint = 'api/v1/health/live';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const vars: Record<string, string> = { NODE_ENV: 'production', PORT: '3000' };
    for (const key of API_ENV_KEYS) {
      const v = env[key];
      if (typeof v === 'string' && v !== '') vars[key] = v;
    }
    this.envVars = vars;
  }
}

const json = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ error: { status, code, message } }), { status, headers: { 'Content-Type': 'application/json' } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    const headers = new Headers(request.headers);
    const clientIp = request.headers.get('CF-Connecting-IP');
    if (clientIp) headers.set('X-Forwarded-For', clientIp); // the API trusts exactly one proxy hop
    headers.set('X-Forwarded-Host', url.host);
    try {
      // One named instance for now; rate limits and the tenant-status cache are per instance.
      return await getContainer(env.API, 'api').fetch(new Request(request, { headers }));
    } catch {
      return json(502, 'API_UNAVAILABLE', 'The API is starting or temporarily unavailable. Please retry in a few seconds.');
    }
  },
};
