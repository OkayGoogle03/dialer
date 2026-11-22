import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogContext {
  correlationId: string;
  tenantId?: string;
  userId?: string;
}

/** Per-request context propagated through async calls (logs, audit rows, outbox events). */
export const requestContext = new AsyncLocalStorage<LogContext>();

export function currentCorrelationId(): string | null {
  return requestContext.getStore()?.correlationId ?? null;
}
