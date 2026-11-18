import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth/auth.types';
import { CurrentUser, ReqContext, RequirePermissions } from '../common/auth/decorators';
import { Database, newId, Row, SqlRunner } from '../database/database';
import { buildSet, DID_RE, intRange, iso, ListQuery, listQuerySchema, normalizeDid, PREFIX_RE, uuidSchema, z, ZodPipe } from './common';

const didValue = z.string().trim().regex(DID_RE, 'DID must be 6-15 digits, optional leading +').transform(normalizeDid);
const prefix = z.string().trim().regex(PREFIX_RE, 'Prefix must be 1-6 digits');

export const didCreateSchema = z.object({
  did: didValue,
  serviceProviderId: uuidSchema,
  trunkId: uuidSchema.nullable().optional(),
  callerId: didValue.nullable().optional(),
  prefix: prefix.nullable().optional(),
  maxConcurrentCalls: intRange(1, 1000).default(5),
}).strict();

export const didUpdateSchema = z.object({
  did: didValue.optional(),
  serviceProviderId: uuidSchema.optional(),
  trunkId: uuidSchema.nullable().optional(),
  callerId: didValue.nullable().optional(),
  prefix: prefix.nullable().optional(),
  maxConcurrentCalls: intRange(1, 1000).optional(),
  status: z.enum(['pending_verification', 'active', 'disabled']).optional(),
}).strict();

const SELECT = `
  SELECT d.id, d.did, d.service_provider_id, sp.name AS provider_name, d.trunk_id, t.name AS trunk_name, d.caller_id, d.prefix,
         d.verification_status, d.verified_at, d.max_concurrent_calls, d.status, d.created_at
    FROM provider_dids d
    JOIN service_providers sp ON sp.id = d.service_provider_id AND sp.tenant_id = :tenantId
    LEFT JOIN tenant_sip_providers t ON t.id = d.trunk_id AND t.tenant_id = :tenantId
   WHERE d.tenant_id = :tenantId AND d.deleted_at IS NULL`;

export const didView = (r: Row) => ({
  id: r.id, did: r.did, serviceProviderId: r.service_provider_id, providerName: r.provider_name, trunkId: r.trunk_id, trunkName: r.trunk_name,
  callerId: r.caller_id ?? r.did, prefix: r.prefix, verificationStatus: r.verification_status, verifiedAt: iso(r.verified_at),
  maxConcurrentCalls: r.max_concurrent_calls, status: r.status, createdAt: iso(r.created_at),
});

@Injectable()
export class DidsService {
  constructor(private readonly db: Database, private readonly audit: AuditService) {}

  list(actor: AuthUser, q: ListQuery & { providerId?: string }) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const p: Record<string, unknown> = {};
      let where = '';
      if (q.search) { p.search = `%${q.search.replace(/[^0-9+]/g, '')}%`; where += ' AND d.did LIKE :search'; }
      if (q.status) { p.status = q.status; where += ' AND d.status = :status'; }
      if (q.providerId) { p.provider = q.providerId; where += ' AND d.service_provider_id = :provider'; }
      const rows = await tx.query(`${SELECT}${where} ORDER BY sp.name, d.did LIMIT ${q.limit} OFFSET ${q.offset}`, p);
      const [{ n }] = await tx.query<{ n: number }>(`SELECT COUNT(*) AS n FROM provider_dids d WHERE d.tenant_id = :tenantId AND d.deleted_at IS NULL${where}`, p);
      return { items: rows.map(didView), total: Number(n), limit: q.limit, offset: q.offset };
    });
  }

  get(actor: AuthUser, id: string) {
    return this.db.withTenant(actor.tenantId, (tx) => this.load(tx, id));
  }

  create(actor: AuthUser, dto: z.infer<typeof didCreateSchema>, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      await this.assertRelations(tx, dto.serviceProviderId, dto.trunkId ?? null);
      const id = newId();
      await tx.execute(
        `INSERT INTO provider_dids (id, tenant_id, service_provider_id, trunk_id, did, caller_id, prefix, max_concurrent_calls, created_by)
         VALUES (:id, :tenantId, :sp, :trunk, :did, :cid, :prefix, :m, :by)`,
        { id, sp: dto.serviceProviderId, trunk: dto.trunkId ?? null, did: dto.did, cid: dto.callerId ?? null, prefix: dto.prefix ?? null, m: dto.maxConcurrentCalls, by: actor.userId },
      );
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'did.created', entityType: 'did', entityId: id, metadata: { did: dto.did } }, ctx);
      return this.load(tx, id);
    });
  }

  update(actor: AuthUser, id: string, dto: z.infer<typeof didUpdateSchema>, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const cur = await this.load(tx, id, true);
      const providerId = dto.serviceProviderId ?? cur.serviceProviderId;
      const trunkId = dto.trunkId === undefined ? cur.trunkId : dto.trunkId;
      if (dto.serviceProviderId || dto.trunkId !== undefined) await this.assertRelations(tx, providerId, trunkId);
      if (dto.serviceProviderId && dto.serviceProviderId !== cur.serviceProviderId) {
        const [{ n }] = await tx.query<{ n: number }>(
          `SELECT (SELECT COUNT(*) FROM caller_assignments WHERE tenant_id = :tenantId AND did_id = :id) + (SELECT COUNT(*) FROM process_did_assignments WHERE tenant_id = :tenantId AND did_id = :id) AS n`, { id });
        if (Number(n) > 0) throw new ConflictException('This DID is assigned to processes; remove those assignments before changing its provider');
      }
      const identityChanged = (dto.did !== undefined && dto.did !== cur.did) || (dto.serviceProviderId !== undefined && dto.serviceProviderId !== cur.serviceProviderId) || (dto.trunkId !== undefined && dto.trunkId !== cur.trunkId);
      let status = dto.status;
      if (status === 'active' && !identityChanged && cur.verificationStatus !== 'verified') throw new BadRequestException('A DID can be activated only after it has been verified');
      const p: Record<string, unknown> = { id };
      const sets = buildSet({ did: 'did', serviceProviderId: 'service_provider_id', trunkId: 'trunk_id', callerId: 'caller_id', prefix: 'prefix', maxConcurrentCalls: 'max_concurrent_calls' }, dto, p);
      if (identityChanged) {
        sets.push(`verification_status = 'pending'`, 'verified_at = NULL');
        if (cur.status === 'active' || status === 'active') status = 'pending_verification';
      }
      if (status) { sets.push('status = :status'); p.status = status; }
      if (sets.length) await tx.execute(`UPDATE provider_dids SET ${sets.join(', ')} WHERE tenant_id = :tenantId AND id = :id`, p);
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'did.updated', entityType: 'did', entityId: id, metadata: { fields: Object.keys(dto), verificationReset: identityChanged } }, ctx);
      return this.load(tx, id);
    });
  }

  /** Manual attestation: an Excel row or a typed number is never treated as carrier-verified automatically. */
  verify(actor: AuthUser, id: string, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      await this.load(tx, id, true);
      await tx.execute(`UPDATE provider_dids SET verification_status = 'verified', verified_at = UTC_TIMESTAMP(3) WHERE tenant_id = :tenantId AND id = :id`, { id });
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'did.verified', entityType: 'did', entityId: id, metadata: { method: 'admin_attestation' } }, ctx);
      return this.load(tx, id);
    });
  }

  remove(actor: AuthUser, id: string, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const cur = await this.load(tx, id, true);
      const [{ n }] = await tx.query<{ n: number }>(
        `SELECT (SELECT COUNT(*) FROM caller_assignments WHERE tenant_id = :tenantId AND did_id = :id) + (SELECT COUNT(*) FROM process_did_assignments WHERE tenant_id = :tenantId AND did_id = :id) AS n`, { id });
      if (Number(n) > 0) throw new ConflictException(`DID ${cur.did} is assigned to a process`);
      await tx.execute(`UPDATE provider_dids SET deleted_at = UTC_TIMESTAMP(3), status = 'disabled' WHERE tenant_id = :tenantId AND id = :id`, { id });
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'did.deleted', entityType: 'did', entityId: id, metadata: { did: cur.did } }, ctx);
    });
  }

  /** The DID's trunk must belong to the DID's provider. */
  private async assertRelations(tx: SqlRunner, providerId: string, trunkId: string | null) {
    const sp = await tx.query(`SELECT 1 FROM service_providers WHERE tenant_id = :tenantId AND id = :p AND deleted_at IS NULL`, { p: providerId });
    if (!sp.length) throw new BadRequestException('Provider not found');
    if (trunkId) {
      const t = await tx.query(`SELECT 1 FROM tenant_sip_providers WHERE tenant_id = :tenantId AND id = :t AND service_provider_id = :p AND deleted_at IS NULL`, { t: trunkId, p: providerId });
      if (!t.length) throw new BadRequestException('Trunk does not belong to the selected provider');
    }
  }

  private async load(tx: SqlRunner, id: string, lock = false) {
    if (lock) await tx.query(`SELECT id FROM provider_dids WHERE tenant_id = :tenantId AND id = :id FOR UPDATE`, { id });
    const [row] = await tx.query(`${SELECT} AND d.id = :id`, { id });
    if (!row) throw new NotFoundException('DID not found');
    return didView(row);
  }
}

const didListQuery = listQuerySchema.extend({ providerId: uuidSchema.optional() }).strict();
const verifyBody = z.object({ confirm: z.literal(true) }).strict();

@ApiTags('dids')
@ApiBearerAuth()
@Controller({ path: 'dids', version: '1' })
export class DidsController {
  constructor(private readonly dids: DidsService) {}

  @Get() @RequirePermissions('master_data:read')
  list(@CurrentUser() u: AuthUser, @Query(new ZodPipe(didListQuery)) q: ListQuery & { providerId?: string }) { return this.dids.list(u, q); }

  @Get(':id') @RequirePermissions('master_data:read')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.dids.get(u, id); }

  @Post() @RequirePermissions('sip_providers:manage')
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(didCreateSchema)) dto: z.infer<typeof didCreateSchema>, @ReqContext() c: RequestContext) { return this.dids.create(u, dto, c); }

  @Put(':id') @RequirePermissions('sip_providers:manage')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(didUpdateSchema)) dto: z.infer<typeof didUpdateSchema>, @ReqContext() c: RequestContext) { return this.dids.update(u, id, dto, c); }

  @Post(':id/verify') @HttpCode(200) @RequirePermissions('sip_providers:manage')
  verify(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(verifyBody)) _b: unknown, @ReqContext() c: RequestContext) { return this.dids.verify(u, id, c); }

  @Delete(':id') @HttpCode(204) @RequirePermissions('sip_providers:manage')
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ReqContext() c: RequestContext) { return this.dids.remove(u, id, c); }
}
