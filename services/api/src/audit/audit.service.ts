import { Injectable } from '@nestjs/common';
import type { RequestContext } from '../common/auth/auth.types';
import { currentCorrelationId } from '../common/logging/context';
import { newId, SqlRunner } from '../database/database';

export interface AuditEntry {
  actorUserId?: string | null;
  actorTenantId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

const COLS = `(id, tenant_id, actor_user_id, actor_tenant_id, action, entity_type, entity_id, metadata, ip_address, correlation_id)`;

function values(entry: AuditEntry, ctx?: RequestContext) {
  return {
    id: newId(),
    actorUserId: entry.actorUserId ?? null,
    actorTenantId: entry.actorTenantId ?? null,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    metadata: JSON.stringify(entry.metadata ?? {}),
    ip: normaliseIp(ctx?.ip),
    correlationId: ctx?.correlationId ?? currentCorrelationId(),
  };
}

/** Audit rows are written inside the caller's transaction so the change and its audit commit atomically. */
@Injectable()
export class AuditService {
  /** Tenant transaction: tenant_id is the bound context tenant. */
  async log(tx: SqlRunner, entry: AuditEntry, ctx?: RequestContext): Promise<void> {
    await tx.execute(
      `INSERT INTO audit_logs ${COLS} VALUES (:id, :tenantId, :actorUserId, :actorTenantId, :action, :entityType, :entityId, :metadata, :ip, :correlationId)`,
      values(entry, ctx),
    );
  }

  /** Platform transaction: explicit target tenant. */
  async logForTenant(tx: SqlRunner, targetTenantId: string, entry: AuditEntry, ctx?: RequestContext): Promise<void> {
    await tx.execute(
      `INSERT INTO audit_logs ${COLS} VALUES (:id, :target, :actorUserId, :actorTenantId, :action, :entityType, :entityId, :metadata, :ip, :correlationId)`,
      { ...values(entry, ctx), target: targetTenantId },
    );
  }
}

export function normaliseIp(ip?: string): string | null {
  if (!ip) return null;
  const v = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return /^[0-9a-fA-F:.]{2,45}$/.test(v) ? v : null;
}
