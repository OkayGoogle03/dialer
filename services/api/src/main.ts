import 'reflect-metadata';
import { createApp } from './bootstrap';
import { createLogger } from './common/logging/logger';
import { loadConfig } from './config/env';
import { mergeFileConfig } from './config/file-config';
import { Database, PlatformDatabase } from './database/database';
import { createPool } from './database/mysql';
import { NatsPublisher } from './events/nats-publisher';
import { OutboxRelay } from './events/outbox-relay';

async function main() {
  const config = loadConfig(mergeFileConfig());
  const logger = createLogger(config.logLevel);
  const db = new Database(createPool(config.db, config.db.apiUser, config.db.apiPassword));
  const platformDb = new PlatformDatabase(createPool(config.db, config.db.platformUser, config.db.platformPassword, 5));
  const publisher = config.natsUrl ? await NatsPublisher.connect(config.natsUrl, logger) : undefined;
  if (!publisher) logger.warn('NATS_URL not set: events stay in the outbox until a relay with NATS runs');

  const app = await createApp({ config, db, platformDb, logger, publisher });
  const relay = publisher && config.outboxRelayEnabled ? new OutboxRelay(platformDb, publisher, logger.child({ component: 'outbox-relay' })) : undefined;
  relay?.start();
  process.once('SIGTERM', () => relay?.stop());
  process.once('SIGINT', () => relay?.stop());

  await app.listen(config.port);
  logger.info({ port: config.port, relay: !!relay }, 'API listening (docs: /api/docs)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
