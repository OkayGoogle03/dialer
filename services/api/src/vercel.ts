import 'reflect-metadata';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from './bootstrap';
import { createLogger } from './common/logging/logger';
import { loadConfig } from './config/env';
import { mergeFileConfig } from './config/file-config';
import { Database, PlatformDatabase } from './database/database';
import { createPool } from './database/mysql';

/**
 * Serverless entry (Vercel Functions): builds the same NestJS app as main.ts, but does not listen on a port and does
 * not start the outbox relay (no background timers in a function). The app is created once per warm instance and
 * reused across requests. Keep DB pools tiny: every warm instance holds its own connections.
 */
type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let cached: Promise<Handler> | undefined;

export function getHandler(): Promise<Handler> {
  cached ??= (async () => {
    const config = loadConfig(mergeFileConfig());
    const logger = createLogger(config.logLevel);
    const poolSize = Number(process.env.DB_POOL_SIZE) || 3;
    const db = new Database(createPool(config.db, config.db.apiUser, config.db.apiPassword, poolSize));
    const platformDb = new PlatformDatabase(createPool(config.db, config.db.platformUser, config.db.platformPassword, 2));
    const app = await createApp({ config, db, platformDb, logger });
    await app.init();
    return app.getHttpAdapter().getInstance() as Handler;
  })().catch((e) => {
    cached = undefined; // allow a retry on the next request (for example after fixing an environment variable)
    throw e;
  });
  return cached;
}
