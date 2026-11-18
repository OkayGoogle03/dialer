import { describe, expect, it } from 'vitest';
import { buildEvent, EVENT_TYPES, EventValidationError, parseEvent, subjectFor } from './index';

const T = '6f1c1d0e-3c6a-4a51-9a2e-0d6b7c1f8e21';
const E = '0b6a2f5e-8d4c-4e1b-9f3a-2c7d8e9f0a1b';

describe('event schemas', () => {
  it('covers every event type required by the spec', () => {
    for (const t of ['call.created', 'call.ringing', 'call.answered', 'call.held', 'call.resumed', 'call.transferred', 'call.completed', 'call.failed', 'recording.completed', 'agent.status_changed', 'campaign.started', 'campaign.paused', 'ai.session.started', 'ai.transcript.updated', 'ai.handoff.requested', 'ai.session.completed']) {
      expect(EVENT_TYPES).toContain(t);
    }
  });

  it('builds a valid envelope with all required fields', () => {
    const e = buildEvent({ eventId: E, type: 'call.failed', tenantId: T, producer: 'test', data: { call_id: E, reason: 'busy', sip_code: 486 }, correlationId: 'c1' });
    expect(e).toMatchObject({ event_id: E, event_type: 'call.failed', event_version: 1, tenant_id: T, correlation_id: 'c1', producer: 'test' });
    expect(() => new Date(e.occurred_at).toISOString()).not.toThrow();
  });

  it('rejects invalid data, unknown types and versions', () => {
    const base = { event_id: E, event_version: 1, tenant_id: T, occurred_at: new Date().toISOString(), correlation_id: null, producer: 'x' };
    expect(() => parseEvent({ ...base, event_type: 'call.failed', data: { call_id: 'nope', reason: 'x' } })).toThrow(EventValidationError);
    expect(() => parseEvent({ ...base, event_type: 'call.exploded', data: {} })).toThrow(/unknown event type/);
    expect(() => parseEvent({ ...base, event_version: 9, event_type: 'call.ringing', data: { call_id: E } })).toThrow(/unsupported version/);
    expect(() => parseEvent({ ...base, tenant_id: 'x', event_type: 'call.ringing', data: { call_id: E } })).toThrow(/invalid envelope/);
  });

  it('builds tenant-scoped subjects and rejects injection', () => {
    expect(subjectFor(T, 'call.completed')).toBe(`dialer.${T}.call.completed`);
    expect(() => subjectFor('>', 'x')).toThrow();
  });
});
