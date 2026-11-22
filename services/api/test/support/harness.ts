import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import mysql from 'mysql2/promise';
import request from 'supertest';
import { createApp } from '../../src/bootstrap';
import { hashPassword } from '../../src/common/crypto/password';
import { createLogger } from '../../src/common/logging/logger';
import { AppConfig, loadConfig } from '../../src/config/env';
import { Database, newId, PlatformDatabase } from '../../src/database/database';
import { createPool } from '../../src/database/mysql';
import { OutboxService } from '../../src/events/outbox.service';
import { EventPublisher } from '../../src/events/publisher';
import { TelephonyAdapter } from '../../src/telephony/telephony-adapter';
import { provisionTenant } from '../../src/platform/provisioning';

/** Unique per test file run so suites can share the persistent test database. */
/** One AES key for the whole test process so credentials encrypted in one place can be decrypted in another. */
export const TEST_CREDENTIALS_KEY = randomBytes(32).toString('base64');

export const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;

export function testConfig(): AppConfig {
  return loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    DB_NAME: process.env.DB_NAME_UNDER_TEST ?? `${process.env.DB_NAME}_test`,
    JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'),
    CREDENTIALS_ENCRYPTION_KEY: TEST_CREDENTIALS_KEY,
    TENANT_STATUS_CACHE_SECONDS: '15',
  });
}

export function pools(config = testConfig()) {
  return {
    db: new Database(createPool(config.db, config.db.apiUser, config.db.apiPassword, 5)),
    platformDb: new PlatformDatabase(createPool(config.db, config.db.platformUser, config.db.platformPassword, 3)),
  };
}

/**
 * Owner connection for assertions that must bypass the app (e.g. reading outbox rows). Never used by app code.
 * Opening a NEW connection to the shared remote database occasionally stalls past the 10 s connect timeout (seen as `connect ETIMEDOUT`, once or twice per
 * complete run, and it made one test fail with five dependent ones). Only the connection attempt is retried (up to 3 times, other errors are never retried)
 * and every retry is printed, so a flaky link stays visible; no assertion is affected.
 */
export async function ownerConnection(config = testConfig()) {
  const transient = new Set(['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'PROTOCOL_CONNECTION_LOST']);
  for (let attempt = 1; ; attempt++) {
    try {
      return await mysql.createConnection({
        host: config.db.host, port: config.db.port, database: config.db.name, user: process.env.DB_OWNER_USER, password: process.env.DB_OWNER_PASSWORD,
        ssl: config.db.tls ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined, timezone: 'Z', namedPlaceholders: true,
      });
    } catch (e) {
      const code = (e as { code?: string }).code ?? '';
      if (attempt >= 3 || !transient.has(code)) throw e;
      console.warn(`[db] owner connection attempt ${attempt} failed (${code}); retrying`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

export class MemoryLogStream extends Writable {
  lines: Record<string, any>[] = [];
  _write(chunk: Buffer, _enc: string, cb: () => void) {
    for (const l of chunk.toString().split('\n').filter(Boolean)) {
      const parsed = JSON.parse(l);
      this.lines.push(parsed);
      if (process.env.DEBUG_LOGS && parsed.level === 'error') console.error(JSON.stringify(parsed).slice(0, 1500));
    }
    cb();
  }
}

export interface TestApp {
  app: INestApplication;
  http: ReturnType<typeof request>;
  db: Database;
  platformDb: PlatformDatabase;
  config: AppConfig;
  logs: MemoryLogStream;
  close(): Promise<void>;
}

export async function startApp(opts: { publisher?: EventPublisher; logLevel?: string; telephony?: TelephonyAdapter; webrtc?: Partial<AppConfig['webrtc']> } = {}): Promise<TestApp> {
  const config = testConfig();
  if (opts.webrtc) config.webrtc = { ...config.webrtc, ...opts.webrtc };
  const { db, platformDb } = pools(config);
  const logs = new MemoryLogStream();
  const logger = createLogger(opts.logLevel ?? 'info', logs);
  const app = await createApp({ config, db, platformDb, logger, publisher: opts.publisher, telephony: opts.telephony });
  await app.init();
  return { app, http: request(app.getHttpServer()), db, platformDb, config, logs, close: () => app.close() };
}

export async function provision(platformDb: PlatformDatabase, slug: string, email: string, password: string, plan = 'starter') {
  const hash = await hashPassword(password);
  return platformDb.withPlatform((tx) => provisionTenant(tx, new OutboxService(), { slug, name: `${slug} Ltd`, planKey: plan, adminEmail: email, adminName: `${slug} admin`, adminPasswordHash: hash }));
}

/** Returns the platform tenant slug and a fresh super-admin login in it (creating the platform tenant once). */
export async function ensurePlatformAdmin(platformDb: PlatformDatabase, password: string): Promise<{ slug: string; email: string; userId: string; tenantId: string }> {
  const hash = await hashPassword(password);
  return platformDb.withPlatform(async (tx) => {
    const [existing] = await tx.query<{ id: string; slug: string }>(`SELECT id, slug FROM tenants WHERE is_platform = 1`);
    const email = `root-${RUN}@platform.test`;
    if (!existing) {
      const r = await provisionTenant(tx, new OutboxService(), { slug: 'platform-test', name: 'Platform', planKey: 'enterprise', adminEmail: email, adminName: 'Root', adminPasswordHash: hash, isPlatform: true });
      return { slug: 'platform-test', email, userId: r.adminUserId, tenantId: r.tenantId };
    }
    const userId = newId();
    await tx.execute(`INSERT INTO users (id, tenant_id, email, display_name, password_hash) VALUES (:id, :t, :e, 'Root', :h)`, { id: userId, t: existing.id, e: email, h: hash });
    await tx.execute(`INSERT INTO user_roles (tenant_id, user_id, role_id) SELECT :t, :u, id FROM roles WHERE tenant_id = :t AND \`key\` = 'tenant_admin'`, { t: existing.id, u: userId });
    await tx.execute(`INSERT INTO platform_admins (user_id, tenant_id) VALUES (:u, :t)`, { u: userId, t: existing.id });
    return { slug: existing.slug, email, userId, tenantId: existing.id };
  });
}

let ipSeq = 0;
/** Distinct client IPs so per-IP login rate limits don't couple unrelated tests. */
export const nextIp = () => {
  ipSeq++;
  return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`;
};

export async function login(http: TestApp['http'], tenant: string, email: string, password: string, ip = nextIp()) {
  return http.post('/api/v1/auth/login').set('X-Forwarded-For', ip).send({ tenant, email, password, refreshTokenDelivery: 'body' });
}

export async function token(http: TestApp['http'], tenant: string, email: string, password: string): Promise<string> {
  const r = await login(http, tenant, email, password);
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}

export const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
