import { buildEvent, EventData, EventType, subjectFor } from '@dialer/event-schemas';
import { Injectable } from '@nestjs/common';
import { currentCorrelationId } from '../common/logging/context';
import { newId, SqlRunner } from '../database/database';

export const PRODUCER = 'api';

const INSERT = `INSERT INTO outbox_events (id, tenant_id, event_type, event_version, subject, correlation_id, producer, payload)`;

/**
 * Transactional outbox: call inside the same transaction as the state change. The event is validated
 * against packages/event-schemas before it is stored, so invalid events fail the business transaction.
 */
@Injectable()
export class OutboxService {
  /** Tenant transaction: the event's tenant is the bound context tenant. */
  async enqueue<T extends EventType>(tx: SqlRunner, tenantId: string, type: T, data: EventData<T>): Promise<string> {
    const v = this.values(tenantId, type, data);
    await tx.execute(`${INSERT} VALUES (:id, :tenantId, :type, :version, :subject, :correlationId, :producer, :payload)`, v.params);
    return v.id;
  }

  /** Platform transaction (cross-tenant): explicit target tenant. */
  async enqueueForTenant<T extends EventType>(tx: SqlRunner, tenantId: string, type: T, data: EventData<T>): Promise<string> {
    const v = this.values(tenantId, type, data);
    await tx.execute(`${INSERT} VALUES (:id, :target, :type, :version, :subject, :correlationId, :producer, :payload)`, { ...v.params, target: tenantId });
    return v.id;
  }

  private values<T extends EventType>(tenantId: string, type: T, data: EventData<T>) {
    const id = newId();
    const env = buildEvent({ eventId: id, type, tenantId, producer: PRODUCER, data, correlationId: currentCorrelationId() });
    return {
      id,
      params: {
        id,
        type,
        version: env.event_version,
        subject: subjectFor(tenantId, type),
        correlationId: env.correlation_id,
        producer: PRODUCER,
        payload: JSON.stringify(env),
      },
    };
  }
}
