import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth/auth.types';
import { CurrentUser, ReqContext, RequirePermissions } from '../common/auth/decorators';
import { Database, newId, Row, SqlRunner } from '../database/database';
import { buildSet, intRange, iso, json, likePattern, ListQuery, listQuerySchema, nameSchema, retryPolicySchema, z, ZodPipe } from './common';

export const providerCreateSchema = z.object({
  name: nameSchema,
  description: z.string().trim().max(500).optional(),
  priority: intRange(0, 10_000).default(100),
  weight: intRange(0, 1000).default(100),
  maxConcurrentCalls: intRange(1, 10_000).default(30),
  retryPolicy: retryPolicySchema.optional(),
}).strict();

export const providerUpdateSchema = z.object({
  name: nameSchema.optional(),
  description: z.string().trim().max(500).nullable().optional(),
  priority: intRange(0, 10_000).optional(),
  weight: intRange(0, 1000).optional(),
  maxConcurrentCalls: intRange(1, 10_000).optional(),
  retryPolicy: retryPolicySchema.optional(),
  status: z.enum(['pending_configuration', 'active', 'disabled']).optional(),
}).strict();

const FIELDS = { name: 'name', description: 'description', priority: 'priority', weight: 'weight', maxConcurrentCalls: 'max_concurrent_calls', retryPolicy: 'retry_policy', status: 'status' };

const SELECT = `
  SELECT sp.id, sp.name, sp.description, sp.status, sp.priority, sp.weight, sp.max_concurrent_calls, sp.retry_policy, sp.created_at,
         (SELECT COUNT(*) FROM tenant_sip_providers t WHERE t.tenant_id = :tenantId AND t.service_provider_id = sp.id AND t.deleted_at IS NULL) AS trunk_count,
         (SELECT COUNT(*) FROM tenant_sip_providers t WHERE t.tenant_id = :tenantId AND t.service_provider_id = sp.id AND t.deleted_at IS NULL AND t.status = 'active') AS active_trunks,
         (SELECT COUNT(*) FROM provider_dids d WHERE d.tenant_id = :tenantId AND d.service_provider_id = sp.id AND d.deleted_at IS NULL) AS did_count
    FROM service_providers sp WHERE sp.tenant_id = :tenantId AND sp.deleted_at IS NULL`;

export const providerView = (r: Row) => ({
  id: r.id, name: r.name, description: r.description, status: r.status, priority: r.priority, weight: r.weight,
  maxConcurrentCalls: r.max_concurrent_calls, retryPolicy: r.retry_policy ?? { maxAttempts: 2, backoffMs: 0 },
  trunkCount: Number(r.trunk_count), activeTrunks: Number(r.active_trunks), didCount: Number(r.did_count), createdAt: iso(r.created_at),
});

@Injectable()
export class ProvidersService {
  constructor(private readonly db: Database, private readonly audit: AuditService) {}

  list(actor: AuthUser, q: ListQuery) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const p: Record<string, unknown> = {};
      let where = '';
      if (q.search) { p.search = likePattern(q.search); where += ' AND LOWER(sp.name) LIKE :search'; }
      if (q.status) { p.status = q.status; where += ' AND sp.status = :status'; }
      const rows = await tx.query(`${SELECT}${where} ORDER BY sp.priority, sp.name LIMIT ${q.limit} OFFSET ${q.offset}`, p);
      const [{ n }] = await tx.query<{ n: number }>(`SELECT COUNT(*) AS n FROM service_providers sp WHERE sp.tenant_id = :tenantId AND sp.deleted_at IS NULL${where}`, p);
      return { items: rows.map(providerView), total: Number(n), limit: q.limit, offset: q.offset };
    });
  }

  get(actor: AuthUser, id: string) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const view = await this.load(tx, id);
      const trunks = await tx.query(
        `SELECT id, name, status, verification_status, health_status FROM tenant_sip_providers WHERE tenant_id = :tenantId AND service_provider_id = :id AND deleted_at IS NULL ORDER BY priority, name`, { id });
      const processes = await tx.query(
        `SELECT p.id, p.name FROM process_provider_assignments a JOIN outbound_processes p ON p.id = a.process_id AND p.tenant_id = :tenantId
          WHERE a.tenant_id = :tenantId AND a.service_provider_id = :id AND p.deleted_at IS NULL ORDER BY p.name`, { id });
      return { ...view, trunks, processes };
    });
  }

  create(actor: AuthUser, dto: z.infer<typeof providerCreateSchema>, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const id = newId();
      await tx.execute(
        `INSERT INTO service_providers (id, tenant_id, name, description, priority, weight, max_concurrent_calls, retry_policy, created_by)
         VALUES (:id, :tenantId, :n, :d, :pr, :w, :m, :rp, :by)`,
        { id, n: dto.name, d: dto.description ?? null, pr: dto.priority, w: dto.weight, m: dto.maxConcurrentCalls, rp: json(dto.retryPolicy ?? { maxAttempts: 2, backoffMs: 0 }), by: actor.userId },
      );
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'provider.created', entityType: 'service_provider', entityId: id, metadata: { name: dto.name } }, ctx);
      return this.load(tx, id);
    });
  }

  update(actor: AuthUser, id: string, dto: z.infer<typeof providerUpdateSchema>, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const current = await this.load(tx, id, true);
      if (dto.status === 'active' && current.status !== 'active' && current.activeTrunks < 1) {
        throw new BadRequestException('A provider can be activated only after at least one SIP trunk is configured and active');
      }
      const p: Record<string, unknown> = { id };
      const sets = buildSet(FIELDS, dto, p, { retryPolicy: json });
      if (sets.length) await tx.execute(`UPDATE service_providers SET ${sets.join(', ')} WHERE tenant_id = :tenantId AND id = :id`, p);
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'provider.updated', entityType: 'service_provider', entityId: id, metadata: { fields: Object.keys(dto) } }, ctx);
      return this.load(tx, id);
    });
  }

  remove(actor: AuthUser, id: string, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const view = await this.load(tx, id, true);
      const deps = await tx.query<{ k: string; n: number }>(
        `SELECT 'trunks' AS k, COUNT(*) AS n FROM tenant_sip_providers WHERE tenant_id = :tenantId AND service_provider_id = :id AND deleted_at IS NULL
         UNION ALL SELECT 'dids', COUNT(*) FROM provider_dids WHERE tenant_id = :tenantId AND service_provider_id = :id AND deleted_at IS NULL
         UNION ALL SELECT 'process assignments', COUNT(*) FROM process_provider_assignments WHERE tenant_id = :tenantId AND service_provider_id = :id
         UNION ALL SELECT 'caller assignments', COUNT(*) FROM caller_assignments WHERE tenant_id = :tenantId AND service_provider_id = :id`, { id });
      const used = deps.filter((d) => Number(d.n) > 0).map((d) => `${d.n} ${d.k}`);
      if (used.length) throw new ConflictException(`Provider "${view.name}" has dependencies: ${used.join(', ')}`);
      await tx.execute(`UPDATE service_providers SET deleted_at = UTC_TIMESTAMP(3) WHERE tenant_id = :tenantId AND id = :id`, { id });
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'provider.deleted', entityType: 'service_provider', entityId: id, metadata: { name: view.name } }, ctx);
    });
  }

  private async load(tx: SqlRunner, id: string, lock = false) {
    if (lock) await tx.query(`SELECT id FROM service_providers WHERE tenant_id = :tenantId AND id = :id FOR UPDATE`, { id });
    const [row] = await tx.query(`${SELECT} AND sp.id = :id`, { id });
    if (!row) throw new NotFoundException('Provider not found');
    return providerView(row);
  }
}

@ApiTags('providers')
@ApiBearerAuth()
@Controller({ path: 'providers', version: '1' })
export class ProvidersController {
  constructor(private readonly providers: ProvidersService) {}

  @Get() @RequirePermissions('master_data:read')
  list(@CurrentUser() u: AuthUser, @Query(new ZodPipe(listQuerySchema)) q: ListQuery) { return this.providers.list(u, q); }

  @Get(':id') @RequirePermissions('master_data:read')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.providers.get(u, id); }

  @Post() @RequirePermissions('sip_providers:manage')
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(providerCreateSchema)) dto: z.infer<typeof providerCreateSchema>, @ReqContext() c: RequestContext) { return this.providers.create(u, dto, c); }

  @Put(':id') @RequirePermissions('sip_providers:manage')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(providerUpdateSchema)) dto: z.infer<typeof providerUpdateSchema>, @ReqContext() c: RequestContext) { return this.providers.update(u, id, dto, c); }

  @Delete(':id') @HttpCode(204) @RequirePermissions('sip_providers:manage')
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ReqContext() c: RequestContext) { return this.providers.remove(u, id, c); }
}
