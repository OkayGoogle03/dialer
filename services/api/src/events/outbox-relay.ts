import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import { PlatformDatabase } from '../database/database';
import { EventPublisher } from './publisher';

export interface RelayOptions {
  batchSize?: number;
  leaseMs?: number;
  idleDelayMs?: number;
  maxBackoffMs?: number;
  workerId?: string;
}

/**
 * Relays outbox rows to JetStream. Delivery is at-least-once:
 *  - rows are leased (locked_by/locked_until) so several API instances can run relays safely;
 *  - Nats-Msg-Id = event_id, so JetStream drops duplicates inside its duplicate window;
 *  - failures back off exponentially per row and are retried forever (never dropped), with an error log.
 * Ordering is best-effort by occurred_at; consumers must be idempotent and tolerate reordering.
 */
export class OutboxRelay {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly o: Required<RelayOptions>;

  constructor(private readonly db: PlatformDatabase, private readonly publisher: EventPublisher, private readonly logger: Logger, opts: RelayOptions = {}) {
    this.o = {
      batchSize: opts.batchSize ?? 100,
      leaseMs: opts.leaseMs ?? 30_000,
      idleDelayMs: opts.idleDelayMs ?? 1_000,
      maxBackoffMs: opts.maxBackoffMs ?? 300_000,
      workerId: opts.workerId ?? `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`,
    };
  }

  /** Processes one batch. Returns counts. */
  async runOnce(): Promise<{ published: number; failed: number }> {
    await this.db.withPlatform((tx) =>
      tx.execute(
        `UPDATE outbox_events SET locked_by = :w, locked_until = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL :leaseMs * 1000 MICROSECOND)
          WHERE pending = 1
            AND (next_attempt_at IS NULL OR next_attempt_at <= UTC_TIMESTAMP(3))
            AND (locked_until IS NULL OR locked_until < UTC_TIMESTAMP(3))
          ORDER BY occurred_at LIMIT ${Number(this.o.batchSize)}`,
        { w: this.o.workerId, leaseMs: this.o.leaseMs },
      ),
    );
    const rows = await this.db.withPlatform((tx) =>
      tx.query<{ id: string; subject: string; payload: unknown; attempts: number }>(
        `SELECT id, subject, payload, attempts FROM outbox_events
          WHERE locked_by = :w AND published_at IS NULL AND locked_until >= UTC_TIMESTAMP(3) ORDER BY occurred_at`,
        { w: this.o.workerId },
      ),
    );
    let published = 0;
    let failed = 0;
    for (const row of rows) {
      const body = typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload);
      try {
        await this.publisher.publish(row.subject, Buffer.from(body), row.id);
        await this.db.withPlatform((tx) =>
          tx.execute(`UPDATE outbox_events SET published_at = UTC_TIMESTAMP(3), locked_by = NULL, locked_until = NULL, attempts = attempts + 1, last_error = NULL WHERE id = :id`, { id: row.id }));
        published++;
      } catch (e) {
        failed++;
        const attempts = row.attempts + 1;
        const backoff = Math.min(this.o.maxBackoffMs, 1000 * 2 ** Math.min(attempts, 20));
        this.logger.error({ err: e, outbox_id: row.id, attempts }, 'outbox publish failed');
        await this.db.withPlatform((tx) =>
          tx.execute(
            `UPDATE outbox_events SET attempts = :attempts, last_error = :err, locked_by = NULL, locked_until = NULL,
                    next_attempt_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL :ms * 1000 MICROSECOND) WHERE id = :id`,
            { id: row.id, attempts, err: String((e as Error).message ?? e).slice(0, 1000), ms: backoff },
          ));
      }
    }
    return { published, failed };
  }

  /** Deletes published rows older than retentionDays. */
  async prune(retentionDays = 7): Promise<number> {
    const r = await this.db.withPlatform((tx) =>
      tx.execute(`DELETE FROM outbox_events WHERE published_at IS NOT NULL AND published_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL :d DAY) LIMIT 10000`, { d: retentionDays }));
    return r.affectedRows;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      let delay = this.o.idleDelayMs;
      try {
        const r = await this.runOnce();
        if (r.published + r.failed >= this.o.batchSize) delay = 0;
      } catch (e) {
        this.logger.error({ err: e }, 'outbox relay iteration failed');
      }
      if (this.running) this.timer = setTimeout(tick, delay);
    };
    this.timer = setTimeout(tick, 0);
    this.logger.info({ worker: this.o.workerId }, 'outbox relay started');
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }
}
