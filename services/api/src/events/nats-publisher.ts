import { DLQ_STREAM_NAME, DLQ_SUBJECTS, STREAM_NAME, STREAM_SUBJECTS } from '@dialer/event-schemas';
import { connect, JetStreamClient, NatsConnection, RetentionPolicy, StorageType, nanos } from 'nats';
import type { Logger } from 'pino';
import { EventPublisher } from './publisher';

/** JetStream publisher. Streams are created/updated idempotently on connect. */
export class NatsPublisher extends EventPublisher {
  private constructor(private readonly nc: NatsConnection, private readonly js: JetStreamClient) {
    super();
  }

  static async connect(url: string, logger: Logger): Promise<NatsPublisher> {
    const nc = await connect({ servers: url, name: 'dialer-api', maxReconnectAttempts: -1, reconnectTimeWait: 2000 });
    (async () => {
      for await (const s of nc.status()) logger.info({ nats: { type: s.type, data: String(s.data) } }, 'nats status');
    })().catch(() => undefined);
    const jsm = await nc.jetstreamManager();
    await ensureStream(jsm, {
      name: STREAM_NAME, subjects: STREAM_SUBJECTS, storage: StorageType.File, retention: RetentionPolicy.Limits,
      max_age: nanos(7 * 24 * 3600 * 1000), duplicate_window: nanos(2 * 60 * 1000),
    });
    await ensureStream(jsm, {
      name: DLQ_STREAM_NAME, subjects: DLQ_SUBJECTS, storage: StorageType.File, retention: RetentionPolicy.Limits,
      max_age: nanos(30 * 24 * 3600 * 1000),
    });
    return new NatsPublisher(nc, nc.jetstream());
  }

  get jetstream(): JetStreamClient {
    return this.js;
  }

  async publish(subject: string, payload: Uint8Array, msgId: string): Promise<void> {
    const ack = await this.js.publish(subject, payload, { msgID: msgId, timeout: 5000 });
    if (!ack.stream) throw new Error('publish not acknowledged by a stream');
  }

  isConnected(): boolean {
    return !this.nc.isClosed();
  }

  async close(): Promise<void> {
    await this.nc.drain();
  }
}

type StreamCfg = Parameters<Awaited<ReturnType<NatsConnection['jetstreamManager']>>['streams']['add']>[0];

async function ensureStream(jsm: Awaited<ReturnType<NatsConnection['jetstreamManager']>>, cfg: StreamCfg) {
  try {
    await jsm.streams.info(cfg.name!);
    await jsm.streams.update(cfg.name!, cfg);
  } catch {
    await jsm.streams.add(cfg);
  }
}
