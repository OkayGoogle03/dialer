import { STREAM_NAME } from '@dialer/event-schemas';
import { AckPolicy, DeliverPolicy, JetStreamClient, NatsConnection } from 'nats';
import type { Logger } from 'pino';
import { PlatformDatabase } from '../database/database';
import { ConsumerOptions, handleMessage } from './idempotent-consumer';
import { EventPublisher } from './publisher';

/** Runs a durable JetStream pull consumer through handleMessage(). Returns a stop function. */
export async function startJetStreamConsumer(
  nc: NatsConnection,
  js: JetStreamClient,
  filterSubject: string,
  opts: ConsumerOptions,
  db: PlatformDatabase,
  dlq: EventPublisher,
  logger: Logger,
): Promise<() => Promise<void>> {
  const jsm = await nc.jetstreamManager();
  await jsm.consumers.add(STREAM_NAME, {
    durable_name: opts.consumer,
    filter_subject: filterSubject,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
    max_deliver: opts.maxDeliver + 1, // the final delivery is the one we dead-letter
    ack_wait: 30_000_000_000,
  }).catch(async () => jsm.consumers.update(STREAM_NAME, opts.consumer, { filter_subject: filterSubject, max_deliver: opts.maxDeliver + 1 }));
  const consumer = await js.consumers.get(STREAM_NAME, opts.consumer);
  const messages = await consumer.consume({ max_messages: 50 });
  (async () => {
    for await (const m of messages) {
      await handleMessage(
        { data: m.data, subject: m.subject, deliveryCount: m.info.redeliveryCount, ack: () => m.ack(), nak: (d) => m.nak(d), term: () => m.term() },
        opts, db, dlq, logger,
      );
    }
  })().catch((e) => logger.error({ err: e, consumer: opts.consumer }, 'consumer loop crashed'));
  return async () => {
    await messages.close();
  };
}
