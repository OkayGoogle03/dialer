import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { TenantSummary } from '@dialer/shared-types';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth/auth.types';
import { TenantStatusService } from '../common/auth/tenant-status.service';
import { hashPassword } from '../common/crypto/password';
import { PlatformDatabase, Row, SqlRunner } from '../database/database';
import { OutboxService } from '../events/outbox.service';
import { CreateTenantDto, ListTenantsQuery, UpdateTenantDto } from './platform.dto';
import { provisionTenant } from './provisioning';

const SUMMARY_SQL = `
  SELECT t.id, t.slug, t.name, t.status, t.is_platform, t.custom_domain, t.suspended_at, t.suspended_reason, t.created_at,
         (SELECT p.\`key\` FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = t.id AND s.is_current = 1 LIMIT 1) AS plan_key,
         (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id AND u.deleted_at IS NULL) AS user_count
    FROM tenants t
   WHERE t.deleted_at IS NULL`;

function toSummary(r: Row): TenantSummary {
  return {
    id: r.id, slug: r.slug, name: r.name, status: r.status, isPlatform: !!r.is_platform, customDomain: r.custom_domain,
    planKey: r.plan_key, userCount: Number(r.user_count), suspendedAt: r.suspended_at?.toISOString() ?? null,
    suspendedReason: r.suspended_reason, createdAt: r.created_at.toISOString(),
  };
}

@Injectable()
export class PlatformService {
  constructor(
    private readonly db: PlatformDatabase,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly tenantStatus: TenantStatusService,
  ) {}

  list(q: ListTenantsQuery) {
    return this.db.withPlatform(async (tx) => {
      const p: Record<string, unknown> = {};
      let where = '';
      if (q.search) {
        p.search = `%${q.search.toLowerCase().replace(/[\\%_]/g, (m) => '\\' + m)}%`;
        where += ` AND (t.slug LIKE :search OR LOWER(t.name) LIKE :search)`;
      }
      if (q.status) {
        p.status = q.status;
        where += ` AND t.status = :status`;
      }
      const rows = await tx.query(`${SUMMARY_SQL}${where} ORDER BY t.created_at DESC LIMIT ${q.limit} OFFSET ${q.offset}`, p);
      const [{ n }] = await tx.query<{ n: number }>(`SELECT COUNT(*) AS n FROM tenants t WHERE t.deleted_at IS NULL${where}`, p);
      return { items: rows.map(toSummary), total: Number(n), limit: q.limit, offset: q.offset };
    });
  }

  get(id: string) {
    return this.db.withPlatform((tx) => this.load(tx, id));
  }

  async create(actor: AuthUser, dto: CreateTenantDto, ctx: RequestContext) {
    const hash = await hashPassword(dto.adminPassword);
    return this.db.withPlatform(async (tx) => {
      const { tenantId } = await provisionTenant(tx, this.outbox, {
        slug: dto.slug, name: dto.name, planKey: dto.planKey, adminEmail: dto.adminEmail, adminName: dto.adminName,
        adminPasswordHash: hash, actor: { userId: actor.userId, tenantId: actor.tenantId },
      });
      await this.auditPlatform(tx, actor, 'platform.tenant_created', tenantId, { slug: dto.slug, plan: dto.planKey }, ctx);
      return this.load(tx, tenantId);
    });
  }

  async update(actor: AuthUser, id: string, dto: UpdateTenantDto, ctx: RequestContext) {
    return this.db.withPlatform(async (tx) => {
      await this.load(tx, id);
      const sets: string[] = [];
      const p: Record<string, unknown> = { id };
      const map: Record<string, string> = { name: 'name', customDomain: 'custom_domain', timezone: 'timezone', countryCode: 'country_code' };
      for (const [k, col] of Object.entries(map)) {
        const v = (dto as Record<string, unknown>)[k];
        if (v !== undefined) {
          p[k] = typeof v === 'string' && k === 'customDomain' ? v.toLowerCase() : v;
          sets.push(`${col} = :${k}`);
        }
      }
      if (sets.length) await tx.execute(`UPDATE tenants SET ${sets.join(', ')} WHERE id = :id`, p);
      if (dto.planKey || dto.maxConcurrentCalls !== undefined) {
        const [sub] = await tx.query<{ id: string }>(`SELECT id FROM subscriptions WHERE tenant_id = :id AND is_current = 1 FOR UPDATE`, { id });
        if (!sub) throw new BadRequestException('Tenant has no active subscription');
        if (dto.planKey) {
          const r = await tx.execute(`UPDATE subscriptions s JOIN plans pl ON pl.\`key\` = :k SET s.plan_id = pl.id WHERE s.id = :sid`, { k: dto.planKey, sid: sub.id });
          if (!r.affectedRows) throw new BadRequestException('Unknown plan');
        }
        if (dto.maxConcurrentCalls !== undefined) await tx.execute(`UPDATE subscriptions SET max_concurrent_calls = :m WHERE id = :sid`, { m: dto.maxConcurrentCalls, sid: sub.id });
      }
      await this.auditPlatform(tx, actor, 'platform.tenant_updated', id, { fields: Object.keys(dto) }, ctx);
      return this.load(tx, id);
    });
  }

  async suspend(actor: AuthUser, id: string, reason: string, ctx: RequestContext) {
    const result = await this.db.withPlatform(async (tx) => {
      const t = await this.load(tx, id, true);
      if (t.isPlatform) throw new BadRequestException('The platform tenant cannot be suspended');
      if (t.status === 'suspended') return t;
      await tx.execute(`UPDATE tenants SET status = 'suspended', suspended_at = UTC_TIMESTAMP(3), suspended_reason = :r WHERE id = :id`, { id, r: reason });
      const revoked = await tx.execute(`UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP(3) WHERE tenant_id = :id AND revoked_at IS NULL`, { id });
      await this.auditPlatform(tx, actor, 'platform.tenant_suspended', id, { reason, revokedSessions: revoked.affectedRows }, ctx);
      await this.outbox.enqueueForTenant(tx, id, 'tenant.suspended', { reason, by_user_id: actor.userId });
      return this.load(tx, id);
    });
    this.tenantStatus.invalidate(id);
    return result;
  }

  async reactivate(actor: AuthUser, id: string, ctx: RequestContext) {
    const result = await this.db.withPlatform(async (tx) => {
      const t = await this.load(tx, id, true);
      if (t.status === 'active') return t;
      if (t.status === 'closed') throw new BadRequestException('Closed tenants cannot be reactivated');
      await tx.execute(`UPDATE tenants SET status = 'active', suspended_at = NULL, suspended_reason = NULL WHERE id = :id`, { id });
      await this.auditPlatform(tx, actor, 'platform.tenant_reactivated', id, {}, ctx);
      await this.outbox.enqueueForTenant(tx, id, 'tenant.reactivated', { by_user_id: actor.userId });
      return this.load(tx, id);
    });
    this.tenantStatus.invalidate(id);
    return result;
  }

  private async load(tx: SqlRunner, id: string, lock = false): Promise<TenantSummary> {
    if (lock) await tx.query(`SELECT id FROM tenants WHERE id = :id FOR UPDATE`, { id });
    const [row] = await tx.query(`${SUMMARY_SQL} AND t.id = :id`, { id });
    if (!row) throw new NotFoundException('Tenant not found');
    return toSummary(row);
  }

  /** Audit in the target tenant's log (visible to that tenant's auditors) with the platform actor recorded. */
  private auditPlatform(tx: SqlRunner, actor: AuthUser, action: string, tenantId: string, metadata: Record<string, unknown>, ctx: RequestContext) {
    return this.audit.logForTenant(tx, tenantId, { actorUserId: actor.userId, actorTenantId: actor.tenantId, action, entityType: 'tenant', entityId: tenantId, metadata }, ctx);
  }
}
