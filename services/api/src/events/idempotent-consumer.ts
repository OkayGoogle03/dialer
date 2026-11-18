import { dlqSubjectFor, EventEnvelope, EventValidationError, parseEvent } from '@dialer/event-schemas';
import type { Logger } from 'pino';
import { PlatformDatabase, SqlRunner } from '../database/database';
import { EventPublisher } from './publisher';

/** Broker-agnostic view of a delivered message (implemented by a JetStream JsMsg adapter). */
export interface InboundMessage {
  data: Uint8Array;
  subject: string;
  deliveryCount: number;
  ack(): void;
  nak(delayMs?: number): void;
  term(): void;
}

export interface ConsumerOptions {
  consumer: string; // durable name; also the idempotency namespace
  maxDeliver: number;
  handler: (event: EventEnvelope, tx: SqlRunner) => Promise<void>;
}

export type Outcome = 'processed' | 'duplicate' | 'retry' | 'dead_lettered';

/**
 * Exactly-once *effects* on top of at-least-once delivery: the processed_events marker and the handler's DB
 * writes commit in one transaction. Invalid messages and messages that exhaust maxDeliver go to the DLQ stream.
 */
export async function handleMessage(msg: InboundMessage, opts: ConsumerOptions, db: PlatformDatabase, dlq: EventPublisher, logger: Logger): Promise<Outcome> {
  let event: EventEnvelope;
  try {
    event = parseEvent(JSON.parse(Buffer.from(msg.data).toString('utf8')));
  } catch (e) {
    await deadLetter(msg, opts, dlq, e instanceof EventValidationError ? e.message : 'unparseable message', 'unknown');
    logger.warn({ consumer: opts.consumer, subject: msg.subject, err: e }, 'event rejected to DLQ');
    return 'dead_lettered';
  }
  try {
    const processed = await db.withPlatform(async (tx) => {
      const r = await tx.execute(`INSERT IGNORE INTO processed_events (consumer, event_id) VALUES (:c, :e)`, { c: opts.consumer, e: event.event_id });
      if (r.affectedRows === 0) return false;
      await opts.handler(event, tx);
      return true;
    });
    msg.ack();
    return processed ? 'processed' : 'duplicate';
  } catch (e) {
    if (msg.deliveryCount >= opts.maxDeliver) {
      await deadLetter(msg, opts, dlq, String((e as Error).message ?? e), event.event_type, event.event_id);
      logger.error({ consumer: opts.consumer, event_id: event.event_id, err: e }, 'event dead-lettered after max deliveries');
      return 'dead_lettered';
    }
    msg.nak(Math.min(60_000, 1000 * 2 ** msg.deliveryCount));
    logger.warn({ consumer: opts.consumer, event_id: event.event_id, attempt: msg.deliveryCount, err: e }, 'event handler failed; will retry');
    return 'retry';
  }
}

async function deadLetter(msg: InboundMessage, opts: ConsumerOptions, dlq: EventPublisher, reason: string, eventType: string, eventId?: string) {
  const body = JSON.stringify({ consumer: opts.consumer, original_subject: msg.subject, reason, delivery_count: msg.deliveryCount, payload: Buffer.from(msg.data).toString('base64') });
  await dlq.publish(dlqSubjectFor(opts.consumer, eventType), Buffer.from(body), `${opts.consumer}:${eventId ?? Buffer.from(msg.data).toString('base64').slice(0, 64)}`);
  msg.term();
}
