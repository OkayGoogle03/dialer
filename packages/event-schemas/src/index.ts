import { z } from 'zod';

/**
 * Versioned event contracts for NATS JetStream.
 * Subject: dialer.<tenant_id>.<event_type>   Stream: DIALER_EVENTS (subjects dialer.>)
 * Breaking changes require a new event_version; consumers must accept every version they declare.
 */
const uuid = z.string().uuid();
const isoDate = z.string().datetime({ offset: true });

export const envelopeSchema = z.object({
  event_id: uuid,
  event_type: z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/),
  event_version: z.number().int().positive(),
  tenant_id: uuid,
  occurred_at: isoDate,
  correlation_id: z.string().max(100).nullable(),
  producer: z.string().min(1).max(64),
  data: z.unknown(),
});
export type EventEnvelope<T = unknown> = Omit<z.infer<typeof envelopeSchema>, 'data'> & { data: T };

const call = { call_id: uuid };
const agentStatus = z.enum(['available', 'busy', 'wrapup', 'break', 'offline']);

/** Catalogue: event_type -> { version -> data schema }. */
export const EVENT_CATALOG = {
  'call.created': { 1: z.object({ ...call, direction: z.enum(['inbound', 'outbound', 'internal']), from: z.string().max(32), to: z.string().max(32), user_id: uuid.nullish(), campaign_id: uuid.nullish(), queue_id: uuid.nullish() }) },
  'call.ringing': { 1: z.object({ ...call, leg_id: uuid.nullish() }) },
  'call.answered': { 1: z.object({ ...call, leg_id: uuid.nullish(), answered_at: isoDate }) },
  'call.held': { 1: z.object({ ...call, by_user_id: uuid.nullish() }) },
  'call.resumed': { 1: z.object({ ...call, by_user_id: uuid.nullish() }) },
  'call.transferred': { 1: z.object({ ...call, transfer_type: z.enum(['blind', 'attended']), target: z.string().max(255), by_user_id: uuid.nullish() }) },
  'call.completed': { 1: z.object({ ...call, ended_at: isoDate, duration_seconds: z.number().int().nonnegative(), billable_seconds: z.number().int().nonnegative(), hangup_cause: z.string().nullish(), disposition_code: z.string().nullish() }) },
  'call.failed': { 1: z.object({ ...call, reason: z.string().max(200), sip_code: z.number().int().nullish() }) },
  'recording.completed': { 1: z.object({ recording_id: uuid, call_id: uuid, storage_key: z.string(), duration_seconds: z.number().int().nonnegative(), size_bytes: z.number().int().nonnegative() }) },
  'agent.status_changed': { 1: z.object({ user_id: uuid, status: agentStatus, previous_status: agentStatus.nullish(), reason: z.string().max(200).nullish() }) },
  'campaign.started': { 1: z.object({ campaign_id: uuid, by_user_id: uuid.nullish() }) },
  'campaign.paused': { 1: z.object({ campaign_id: uuid, by_user_id: uuid.nullish(), reason: z.string().max(200).nullish() }) },
  'ai.session.started': { 1: z.object({ ai_session_id: uuid, ai_agent_id: uuid, call_id: uuid.nullish(), mode: z.enum(['assist', 'autonomous', 'test']) }) },
  'ai.transcript.updated': { 1: z.object({ ai_session_id: uuid, seq: z.number().int().nonnegative(), speaker: z.enum(['customer', 'agent', 'ai', 'system']), text: z.string(), is_final: z.boolean() }) },
  'ai.handoff.requested': { 1: z.object({ ai_session_id: uuid, call_id: uuid, queue_id: uuid.nullish(), reason: z.string().max(500) }) },
  'ai.session.completed': { 1: z.object({ ai_session_id: uuid, outcome: z.string().nullish(), summary: z.string().nullish(), duration_seconds: z.number().int().nonnegative().nullish() }) },
  // platform / identity
  'tenant.created': { 1: z.object({ slug: z.string(), name: z.string(), plan_key: z.string() }) },
  'tenant.suspended': { 1: z.object({ reason: z.string().nullish(), by_user_id: uuid }) },
  'tenant.reactivated': { 1: z.object({ by_user_id: uuid }) },
  'user.created': { 1: z.object({ user_id: uuid, roles: z.array(z.string()) }) },
} as const;

export type EventType = keyof typeof EVENT_CATALOG;
type LatestVersion<T extends EventType> = keyof (typeof EVENT_CATALOG)[T] & number;
export type EventData<T extends EventType, V extends LatestVersion<T> = 1 & LatestVersion<T>> = z.infer<(typeof EVENT_CATALOG)[T][V] & z.ZodTypeAny>;

export const EVENT_TYPES = Object.keys(EVENT_CATALOG) as EventType[];
export const STREAM_NAME = 'DIALER_EVENTS';
export const STREAM_SUBJECTS = ['dialer.>'];
export const DLQ_STREAM_NAME = 'DIALER_DLQ';
export const DLQ_SUBJECTS = ['dlq.>'];

export function subjectFor(tenantId: string, eventType: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new Error('invalid tenant id for subject');
  return `dialer.${tenantId}.${eventType}`;
}

export function dlqSubjectFor(consumer: string, eventType: string): string {
  return `dlq.${consumer}.${eventType}`;
}

export function latestVersion(type: EventType): number {
  return Math.max(...Object.keys(EVENT_CATALOG[type]).map(Number));
}

export class EventValidationError extends Error {
  constructor(message: string, readonly issues?: unknown) {
    super(message);
  }
}

/** Validates envelope + data against the catalogue. Throws EventValidationError. */
export function parseEvent(raw: unknown): EventEnvelope {
  const env = envelopeSchema.safeParse(raw);
  if (!env.success) throw new EventValidationError('invalid envelope', env.error.issues);
  const versions = (EVENT_CATALOG as Record<string, Record<number, z.ZodTypeAny>>)[env.data.event_type];
  if (!versions) throw new EventValidationError(`unknown event type ${env.data.event_type}`);
  const schema = versions[env.data.event_version];
  if (!schema) throw new EventValidationError(`unsupported version ${env.data.event_version} for ${env.data.event_type}`);
  const data = schema.safeParse(env.data.data);
  if (!data.success) throw new EventValidationError(`invalid data for ${env.data.event_type}`, data.error.issues);
  return { ...env.data, data: data.data };
}

export interface BuildEventInput<T extends EventType> {
  eventId: string;
  type: T;
  tenantId: string;
  producer: string;
  data: EventData<T>;
  correlationId?: string | null;
  occurredAt?: Date;
}

/** Builds and validates an envelope at the latest version of the event type. */
export function buildEvent<T extends EventType>(i: BuildEventInput<T>): EventEnvelope<EventData<T>> {
  const env = {
    event_id: i.eventId,
    event_type: i.type,
    event_version: latestVersion(i.type),
    tenant_id: i.tenantId,
    occurred_at: (i.occurredAt ?? new Date()).toISOString(),
    correlation_id: i.correlationId ?? null,
    producer: i.producer,
    data: i.data,
  };
  return parseEvent(env) as EventEnvelope<EventData<T>>;
}
