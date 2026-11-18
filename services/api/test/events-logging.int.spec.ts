import { buildEvent, subjectFor } from '@dialer/event-schemas';
import pino from 'pino';
import { newId } from '../src/database/database';
import { handleMessage, InboundMessage } from '../src/events/idempotent-consumer';
import { OutboxRelay } from '../src/events/outbox-relay';
import { EventPublisher } from '../src/events/publisher';
import { bearer, ownerConnection, provision, RUN, startApp, TestApp, token } from './support/harness';

class FakePublisher extends EventPublisher {
  published: { subject: string; payload: string; msgId: string }[] = [];
  failNext = 0;
  async publish(subject: string, payload: Uint8Array, msgId: string) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('broker unavailable');
    }
    this.published.push({ subject, payload: Buffer.from(payload).toString(), msgId });
  }
  isConnected() { return true; }
  async close() {}
}

function fakeMsg(data: unknown, deliveryCount = 1) {
  const calls: string[] = [];
  const msg: InboundMessage & { calls: string[] } = {
    calls,
    data: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)),
    subject: 'dialer.x.y',
    deliveryCount,
    ack: () => calls.push('ack'),
    nak: () => calls.push('nak'),
    term: () => calls.push('term'),
  };
  return msg;
}

const silent = pino({ level: 'silent' });
const T = `ev-${RUN}`;

describe('events: outbox, relay, idempotent consumer; structured logging (TiDB)', () => {
  let t: TestApp;
  let tenantId: string;
  let admin: string;

  beforeAll(async () => {
    t = await startApp({ logLevel: 'info' });
    tenantId = (await provision(t.platformDb, T, `admin@${T}.test`, 'events-pass-123')).tenantId;
    admin = await token(t.http, T, `admin@${T}.test`, 'events-pass-123');
  });

  afterAll(async () => t?.close());

  it('writes a validated user.created event in the same transaction as the user', async () => {
    const r = await t.http.post('/api/v1/users').set(bearer(admin)).set('X-Correlation-Id', `corr-${RUN}`)
      .send({ email: `agent@${T}.test`, displayName: 'Agent', password: 'longenough123', roles: ['agent'] }).expect(201);
    const c = await ownerConnection();
    const [rows] = await c.query(`SELECT event_type, subject, correlation_id, payload FROM outbox_events WHERE tenant_id = ? AND event_type = 'user.created'`, [tenantId]);
    await c.end();
    const row = (rows as any[])[0];
    expect(row.subject).toBe(subjectFor(tenantId, 'user.created'));
    expect(row.correlation_id).toBe(`corr-${RUN}`);
    expect(row.payload).toMatchObject({ event_type: 'user.created', event_version: 1, tenant_id: tenantId, producer: 'api', data: { user_id: r.body.id, roles: ['agent'] } });
  });

  it('a failed business transaction leaves no outbox row', async () => {
    await t.http.post('/api/v1/users').set(bearer(admin)).send({ email: `agent@${T}.test`, displayName: 'Dup', password: 'longenough123', roles: ['agent'] }).expect(409);
    const c = await ownerConnection();
    const [rows] = await c.query(`SELECT COUNT(*) AS n FROM outbox_events WHERE tenant_id = ? AND event_type = 'user.created'`, [tenantId]);
    await c.end();
    expect(Number((rows as any[])[0].n)).toBe(1);
  });

  it('relay publishes pending rows with msgId = event_id, retries failures with backoff, and marks published', async () => {
    const pub = new FakePublisher();
    pub.failNext = 1;
    const relay = new OutboxRelay(t.platformDb, pub, silent, { batchSize: 500, maxBackoffMs: 1 });
    let guard = 0;
    while (guard++ < 20) {
      const r = await relay.runOnce();
      if (r.published === 0 && r.failed === 0) break;
    }
    const mine = pub.published.filter((p) => p.subject.startsWith(`dialer.${tenantId}.`));
    expect(mine.map((p) => JSON.parse(p.payload).event_type).sort()).toEqual(['tenant.created', 'user.created']);
    for (const p of mine) expect(JSON.parse(p.payload).event_id).toBe(p.msgId);

    const c = await ownerConnection();
    const [rows] = await c.query(`SELECT published_at, attempts FROM outbox_events WHERE tenant_id = ?`, [tenantId]);
    await c.end();
    expect((rows as any[]).every((r) => r.published_at !== null)).toBe(true);
    expect(Math.max(...(rows as any[]).map((r) => r.attempts))).toBeGreaterThanOrEqual(1);
  });

  it('consumer processes an event once, acks duplicates, retries, then dead-letters', async () => {
    const dlq = new FakePublisher();
    const handled: string[] = [];
    const consumer = `test-consumer-${RUN}`;
    const opts = { consumer, maxDeliver: 3, handler: async (e: { event_id: string }) => { handled.push(e.event_id); } };
    const event = buildEvent({ eventId: newId(), type: 'campaign.started', tenantId, producer: 'test', data: { campaign_id: newId() } });

    const m1 = fakeMsg(event);
    expect(await handleMessage(m1, opts, t.platformDb, dlq, silent)).toBe('processed');
    const m2 = fakeMsg(event, 2);
    expect(await handleMessage(m2, opts, t.platformDb, dlq, silent)).toBe('duplicate');
    expect(handled).toEqual([event.event_id]);
    expect(m1.calls).toEqual(['ack']);
    expect(m2.calls).toEqual(['ack']);

    const failing = { ...opts, handler: async () => { throw new Error('downstream down'); } };
    const e2 = buildEvent({ eventId: newId(), type: 'campaign.paused', tenantId, producer: 'test', data: { campaign_id: newId() } });
    const retry = fakeMsg(e2, 1);
    expect(await handleMessage(retry, failing, t.platformDb, dlq, silent)).toBe('retry');
    expect(retry.calls).toEqual(['nak']);
    const last = fakeMsg(e2, 3);
    expect(await handleMessage(last, failing, t.platformDb, dlq, silent)).toBe('dead_lettered');
    expect(last.calls).toEqual(['term']);
    // failed handler rolled back its idempotency marker, so a later redelivery could still succeed
    expect(await handleMessage(fakeMsg(e2, 1), opts, t.platformDb, dlq, silent)).toBe('processed');

    const bad = fakeMsg({ event_type: 'call.created', data: {} });
    expect(await handleMessage(bad, opts, t.platformDb, dlq, silent)).toBe('dead_lettered');
    expect(dlq.published.map((p) => p.subject)).toEqual([`dlq.${consumer}.campaign.paused`, `dlq.${consumer}.unknown`]);
  });

  it('logs are JSON with correlation id, tenant and user; correlation id is echoed', async () => {
    const corr = `log-${RUN}`;
    const r = await t.http.get('/api/v1/users').set(bearer(admin)).set('X-Correlation-Id', corr).expect(200);
    expect(r.headers['x-correlation-id']).toBe(corr);
    const line = t.logs.lines.find((l) => l.msg === 'request' && l.correlation_id === corr);
    expect(line).toMatchObject({ level: 'info', service: 'api', correlation_id: corr, tenant_id: tenantId, http: { method: 'GET', path: '/api/v1/users', status: 200 } });
    expect(line!.user_id).toMatch(/^[0-9a-f-]{36}$/);

    const gen = await t.http.get('/api/v1/health/live').set('X-Correlation-Id', 'bad id with spaces').expect(200);
    expect(gen.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(t.logs.lines)).not.toMatch(/events-pass-123|longenough123/);
  });
});
