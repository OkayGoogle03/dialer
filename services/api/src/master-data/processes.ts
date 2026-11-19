import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth/auth.types';
import { CurrentUser, ReqContext, RequirePermissions } from '../common/auth/decorators';
import { Database, newId, Row, SqlRunner } from '../database/database';
import { buildSet, intRange, iso, json, likePattern, ListQuery, listQuerySchema, nameSchema, PREFIX_RE, slugCode, uuidSchema, z, ZodPipe } from './common';

export const dialPlanSchema = z.object({
  stripLeadingZeros: z.boolean().default(true),
  minLength: intRange(3, 15).default(6),
  maxLength: intRange(3, 20).default(15),
  allowedDestinationPrefixes: z.array(z.string().regex(PREFIX_RE)).max(50).default([]),
  blockedDestinationPrefixes: z.array(z.string().regex(PREFIX_RE)).max(50).default([]),
}).strict().refine((d) => d.minLength <= d.maxLength, 'minLength must not exceed maxLength');
export type DialPlan = z.infer<typeof dialPlanSchema>;
export const DEFAULT_DIAL_PLAN: DialPlan = dialPlanSchema.parse({});

const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{1,40}$/, 'A-Z, 0-9 and _ only');

export const processCreateSchema = z.object({
  name: nameSchema,
  code: code.optional(),
  description: z.string().trim().max(500).optional(),
  routingStrategy: z.enum(['priority', 'weighted', 'manual']).default('priority'),
  dialPlan: dialPlanSchema.optional(),
  maxConcurrentCalls: intRange(1, 100_000).default(50),
}).strict();

export const processUpdateSchema = z.object({
  name: nameSchema.optional(),
  code: code.optional(),
  description: z.string().trim().max(500).nullable().optional(),
  defaultServiceProviderId: uuidSchema.nullable().optional(),
  routingStrategy: z.enum(['priority', 'weighted', 'manual']).optional(),
  dialPlan: dialPlanSchema.optional(),
  maxConcurrentCalls: intRange(1, 100_000).optional(),
  status: z.enum(['active', 'disabled']).optional(),
}).strict();

const SELECT = `
  SELECT p.id, p.name, p.code, p.description, p.default_service_provider_id, p.routing_strategy, p.dial_plan, p.max_concurrent_calls, p.status, p.created_at,
         (SELECT COUNT(*) FROM process_provider_assignments a WHERE a.tenant_id = :tenantId AND a.process_id = p.id) AS provider_count,
         (SELECT COUNT(*) FROM process_did_assignments a WHERE a.tenant_id = :tenantId AND a.process_id = p.id) AS did_count,
         (SELECT COUNT(*) FROM process_server_assignments a WHERE a.tenant_id = :tenantId AND a.process_id = p.id) AS server_count,
         (SELECT COUNT(*) FROM caller_assignments a WHERE a.tenant_id = :tenantId AND a.process_id = p.id) AS caller_count
    FROM outbound_processes p WHERE p.tenant_id = :tenantId AND p.deleted_at IS NULL`;

export const processView = (r: Row) => ({
  id: r.id, name: r.name, code: r.code, description: r.description, defaultServiceProviderId: r.default_service_provider_id, routingStrategy: r.routing_strategy,
  dialPlan: { ...DEFAULT_DIAL_PLAN, ...(r.dial_plan ?? {}) }, maxConcurrentCalls: r.max_concurrent_calls, status: r.status,
  providerCount: Number(r.provider_count), didCount: Number(r.did_count), serverCount: Number(r.server_count), callerAssignmentCount: Number(r.caller_count), createdAt: iso(r.created_at),
});

/** In-memory variant for bulk creation: picks a code not in `taken`. */
export function pickProcessCode(name: string, taken: Set<string>): string {
  const base = slugCode(name);
  for (let i = 1; i < 10_000; i++) {
    const candidate = i === 1 ? base : `${base.slice(0, 36)}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new ConflictException('Could not generate a unique process code');
}

/** Unique code from a name, e.g. "Tata Tele" -> TATA_TELE, TATA_TELE_2 ... */
export async function uniqueProcessCode(tx: SqlRunner, name: string): Promise<string> {
  const base = slugCode(name);
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? base : `${base.slice(0, 36)}_${i}`;
    const rows = await tx.query(`SELECT 1 FROM outbound_processes WHERE tenant_id = :tenantId AND code = :c AND deleted_at IS NULL`, { c: candidate });
    if (!rows.length) return candidate;
  }
  throw new ConflictException('Could not generate a unique process code');
}

@Injectable()
export class ProcessesService {
  constructor(private readonly db: Database, private readonly audit: AuditService) {}

  list(actor: AuthUser, q: ListQuery) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const p: Record<string, unknown> = {};
      let where = '';
      if (q.search) { p.search = likePattern(q.search); where += ' AND (LOWER(p.name) LIKE :search OR LOWER(p.code) LIKE :search)'; }
      if (q.status) { p.status = q.status; where += ' AND p.status = :status'; }
      const rows = await tx.query(`${SELECT}${where} ORDER BY p.name LIMIT ${q.limit} OFFSET ${q.offset}`, p);
      const [{ n }] = await tx.query<{ n: number }>(`SELECT COUNT(*) AS n FROM outbound_processes p WHERE p.tenant_id = :tenantId AND p.deleted_at IS NULL${where}`, p);
      return { items: rows.map(processView), total: Number(n), limit: q.limit, offset: q.offset };
    });
  }

  get(actor: AuthUser, id: string) {
    return this.db.withTenant(actor.tenantId, (tx) => this.load(tx, id));
  }

  create(actor: AuthUser, dto: z.infer<typeof processCreateSchema>, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const id = newId();
      const codeValue = dto.code ?? (await uniqueProcessCode(tx, dto.name));
      await tx.execute(
        `INSERT INTO outbound_processes (id, tenant_id, name, code, description, routing_strategy, dial_plan, max_concurrent_calls, created_by)
         VALUES (:id, :tenantId, :n, :c, :d, :rs, :dp, :m, :by)`,
        { id, n: dto.name, c: codeValue, d: dto.description ?? null, rs: dto.routingStrategy, dp: json(dto.dialPlan ?? DEFAULT_DIAL_PLAN), m: dto.maxConcurrentCalls, by: actor.userId },
      );
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'process.created', entityType: 'outbound_process', entityId: id, metadata: { name: dto.name, code: codeValue } }, ctx);
      return this.load(tx, id);
    });
  }

  update(actor: AuthUser, id: string, dto: z.infer<typeof processUpdateSchema>, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      await this.load(tx, id, true);
      if (dto.defaultServiceProviderId) {
        const ok = await tx.query(`SELECT 1 FROM process_provider_assignments WHERE tenant_id = :tenantId AND process_id = :id AND service_provider_id = :sp`, { id, sp: dto.defaultServiceProviderId });
        if (!ok.length) throw new BadRequestException('The default provider must first be assigned to this process');
      }
      const p: Record<string, unknown> = { id };
      const sets = buildSet(
        { name: 'name', code: 'code', description: 'description', defaultServiceProviderId: 'default_service_provider_id', routingStrategy: 'routing_strategy', dialPlan: 'dial_plan', maxConcurrentCalls: 'max_concurrent_calls', status: 'status' },
        dto, p, { dialPlan: json },
      );
      if (sets.length) await tx.execute(`UPDATE outbound_processes SET ${sets.join(', ')} WHERE tenant_id = :tenantId AND id = :id`, p);
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'process.updated', entityType: 'outbound_process', entityId: id, metadata: { fields: Object.keys(dto) } }, ctx);
      return this.load(tx, id);
    });
  }

  remove(actor: AuthUser, id: string, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const cur = await this.load(tx, id, true);
      // Deleting a process removes its dial prefixes (caller assignments) with it.
      const [{ n }] = await tx.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM outbound_calls oc JOIN caller_assignments ca ON ca.id = oc.caller_assignment_id AND ca.tenant_id = :tenantId
          WHERE oc.tenant_id = :tenantId AND ca.process_id = :id`, { id });
      if (Number(n) > 0) throw new ConflictException(`Process "${cur.name}" has call history from the old trunk dialer and cannot be deleted`);
      await tx.execute(`DELETE FROM caller_assignments WHERE tenant_id = :tenantId AND process_id = :id`, { id });
      await tx.execute(`DELETE FROM process_provider_assignments WHERE tenant_id = :tenantId AND process_id = :id`, { id });
      await tx.execute(`DELETE FROM process_did_assignments WHERE tenant_id = :tenantId AND process_id = :id`, { id });
      await tx.execute(`DELETE FROM process_server_assignments WHERE tenant_id = :tenantId AND process_id = :id`, { id });
      await tx.execute(`UPDATE outbound_processes SET deleted_at = UTC_TIMESTAMP(3), status = 'disabled' WHERE tenant_id = :tenantId AND id = :id`, { id });
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'process.deleted', entityType: 'outbound_process', entityId: id, metadata: { name: cur.name } }, ctx);
    });
  }

  private async load(tx: SqlRunner, id: string, lock = false) {
    if (lock) await tx.query(`SELECT id FROM outbound_processes WHERE tenant_id = :tenantId AND id = :id FOR UPDATE`, { id });
    const [row] = await tx.query(`${SELECT} AND p.id = :id`, { id });
    if (!row) throw new NotFoundException('Process not found');
    return processView(row);
  }
}

@ApiTags('processes')
@ApiBearerAuth()
@Controller({ path: 'processes', version: '1' })
export class ProcessesController {
  constructor(private readonly processes: ProcessesService) {}

  @Get() @RequirePermissions('master_data:read')
  list(@CurrentUser() u: AuthUser, @Query(new ZodPipe(listQuerySchema)) q: ListQuery) { return this.processes.list(u, q); }

  @Get(':id') @RequirePermissions('master_data:read')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.processes.get(u, id); }

  @Post() @RequirePermissions('processes:manage')
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(processCreateSchema)) dto: z.infer<typeof processCreateSchema>, @ReqContext() c: RequestContext) { return this.processes.create(u, dto, c); }

  @Put(':id') @RequirePermissions('processes:manage')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(processUpdateSchema)) dto: z.infer<typeof processUpdateSchema>, @ReqContext() c: RequestContext) { return this.processes.update(u, id, dto, c); }

  @Delete(':id') @HttpCode(204) @RequirePermissions('processes:manage')
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ReqContext() c: RequestContext) { return this.processes.remove(u, id, c); }
}
