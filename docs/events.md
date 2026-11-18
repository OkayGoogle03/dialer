# Events (planned — Phase 1 batch 2 / Phase 2)

Transport: NATS JetStream. Subject: `dialer.<tenant_id>.<event_type>`. Producers write to `outbox_events` in the same DB transaction; a relay publishes with `Nats-Msg-Id = event_id` (JetStream dedupe), marks `published_at`.

Envelope (v1):
```json
{ "event_id": "uuid", "event_type": "call.answered", "event_version": 1, "tenant_id": "uuid",
  "occurred_at": "ISO-8601", "correlation_id": "string", "producer": "telephony-adapter", "data": {} }
```

Event types: call.created, call.ringing, call.answered, call.held, call.resumed, call.transferred, call.completed, call.failed, recording.completed, agent.status_changed, campaign.started, campaign.paused, ai.session.started, ai.transcript.updated, ai.handoff.requested, ai.session.completed.

Consumers: durable pull consumers, explicit ack, `max_deliver` with backoff, DLQ stream `dialer-dlq`, idempotency by `event_id` (processed-events table per consumer). Schemas will live in `packages/event-schemas` (JSON Schema + TS types).
