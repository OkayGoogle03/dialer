export interface DbConfig {
  host: string;
  port: number;
  name: string;
  tls: boolean;
  poolSize: number;
  apiUser: string;
  apiPassword: string;
  platformUser: string;
  platformPassword: string;
}

export interface AppConfig {
  nodeEnv: string;
  port: number;
  logLevel: string;
  db: DbConfig;
  jwtAccessSecret: string;
  /** 32-byte AES-256-GCM key for SIP/ARI credentials at rest. */
  credentialsKey: Buffer;
  jwtAccessTtlSeconds: number;
  refreshTtlDays: number;
  corsOrigins: string[];
  /** Where the Windows installer is hosted (non-secret, https). Empty = the Download page says it is not published yet. */
  desktopDownloadUrl: string;
  desktopVersion: string;
  natsUrl?: string;
  outboxRelayEnabled: boolean;
  /** Seconds a tenant status is cached by the auth guard (suspension propagation delay). */
  tenantStatusCacheSeconds: number;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

function int(name: string, value: string | undefined, def: number, min: number, max: number): number {
  const n = value === undefined || value === '' ? def : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const errors: string[] = [];
  const req = (k: string) => {
    const v = env[k];
    if (!v) errors.push(`${k} is required`);
    return v ?? '';
  };
  const prefix = env.DB_USER_PREFIX ?? '';
  const jwtAccessSecret = env.JWT_ACCESS_SECRET ?? '';
  if (jwtAccessSecret.length < 32) errors.push('JWT_ACCESS_SECRET must be at least 32 characters');
  const credentialsKey = Buffer.from(env.CREDENTIALS_ENCRYPTION_KEY ?? '', 'base64');
  if (credentialsKey.length !== 32) errors.push('CREDENTIALS_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  const db: DbConfig = {
    host: req('DB_HOST'),
    port: int('DB_PORT', env.DB_PORT, 4000, 1, 65535),
    name: req('DB_NAME'),
    tls: env.DB_TLS === 'true',
    poolSize: int('DB_POOL_SIZE', env.DB_POOL_SIZE, 10, 1, 200),
    apiUser: env.DB_API_USER || `${prefix}dialer_api`,
    apiPassword: req('DB_API_PASSWORD'),
    platformUser: env.DB_PLATFORM_USER || `${prefix}dialer_platform`,
    platformPassword: req('DB_PLATFORM_PASSWORD'),
  };
  if (errors.length) throw new Error(`Invalid configuration:\n - ${errors.join('\n - ')}`);
  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    port: int('PORT', env.PORT, 3000, 1, 65535),
    logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'silent' : 'info'),
    db,
    jwtAccessSecret,
    credentialsKey,
    jwtAccessTtlSeconds: int('JWT_ACCESS_TTL_SECONDS', env.JWT_ACCESS_TTL_SECONDS, 900, 60, 3600),
    refreshTtlDays: int('REFRESH_TTL_DAYS', env.REFRESH_TTL_DAYS, 30, 1, 90),
    corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    desktopDownloadUrl: /^https:\/\/\S+$/.test(env.DESKTOP_DOWNLOAD_URL ?? '') ? env.DESKTOP_DOWNLOAD_URL! : '',
    desktopVersion: (env.DESKTOP_VERSION ?? '').slice(0, 20),
    natsUrl: env.NATS_URL || undefined,
    outboxRelayEnabled: env.OUTBOX_RELAY_ENABLED === 'true',
    tenantStatusCacheSeconds: int('TENANT_STATUS_CACHE_SECONDS', env.TENANT_STATUS_CACHE_SECONDS, 15, 0, 300),
  };
}
