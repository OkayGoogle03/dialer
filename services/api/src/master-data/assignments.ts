import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth/auth.types';
import { CurrentUser, ReqContext, RequirePermissions } from '../common/auth/decorators';
import { Database, SqlRunner } from '../database/database';
import { iso, uuidSchema, z, ZodPipe } from './common';

const ids = z.array(uuidSchema).max(500);
export const replaceSchema = z.object({ providerIds: ids, didIds: ids, serverIds: ids }).strict();
export const addSchema = z.object({ processId: uuidSchema, type: z.enum(['provider', 'did', 'server']), targetId: uuidSchema }).strict();
const querySchema = z.object({ processId: uuidSchema }).strict();

export interface AssignmentSet { providerIds: string[]; didIds: string[]; serverIds: string[] }

@Injectable()
export class AssignmentsService {
  constructor(private readonly db: Database, private readonly audit: AuditService) {}

  get(actor: AuthUser, processId: string) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      await this.assertProcess(tx, processId);
      return this.view(tx, processId);
    });
  }

  add(actor: AuthUser, dto: z.infer<typeof addSchema>, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      await this.assertProcess(tx, dto.processId, true);
      const cur = await this.sets(tx, dto.processId);
      const key = dto.type === 'provider' ? 'providerIds' : dto.type === 'did' ? 'didIds' : 'serverIds';
      if (cur[key].includes(dto.targetId)) throw new ConflictException('Already assigned');
      return this.apply(tx, actor, dto.processId, { ...cur, [key]: [...cur[key], dto.targetId] }, ctx);
    });
  }

  replace(actor: AuthUser, processId: string, next: AssignmentSet, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      await this.assertProcess(tx, processId, true);
      return this.apply(tx, actor, processId, next, ctx);
    });
  }

  private async apply(tx: SqlRunner, actor: AuthUser, processId: string, next: AssignmentSet, ctx: RequestContext) {
    const want = { providerIds: [...new Set(next.providerIds)], didIds: [...new Set(next.didIds)], serverIds: [...new Set(next.serverIds)] };
    // Existence (tenant-scoped) of every referenced record.
    await this.assertAll(tx, 'service_providers', want.providerIds, 'provider');
    await this.assertAll(tx, 'call_servers', want.serverIds, 'call server');
    if (want.didIds.length) {
      const dids = await tx.query<{ id: string; service_provider_id: string }>(
        `SELECT id, service_provider_id FROM provider_dids WHERE tenant_id = :tenantId AND id IN (:ids) AND deleted_at IS NULL`, { ids: want.didIds });
      if (dids.length !== want.didIds.length) throw new BadRequestException('One or more DIDs do not exist');
      const bad = dids.filter((d) => !want.providerIds.includes(d.service_provider_id));
      if (bad.length) throw new BadRequestException('Every assigned DID must belong to a provider assigned to this process');
    }
    const cur = await this.sets(tx, processId);
    // Removing a link that imported caller assignments still depend on would orphan routing rows.
    const removed = {
      providers: cur.providerIds.filter((x) => !want.providerIds.includes(x)),
      dids: cur.didIds.filter((x) => !want.didIds.includes(x)),
      servers: cur.serverIds.filter((x) => !want.serverIds.includes(x)),
    };
    for (const [col, list] of [['service_provider_id', removed.providers], ['did_id', removed.dids], ['call_server_id', removed.servers]] as const) {
      if (!list.length) continue;
      const [{ n }] = await tx.query<{ n: number }>(`SELECT COUNT(*) AS n FROM caller_assignments WHERE tenant_id = :tenantId AND process_id = :pid AND ${col} IN (:list)`, { pid: processId, list });
      if (Number(n) > 0) throw new ConflictException('Cannot remove an assignment that is used by caller assignments');
    }
    await this.syncTable(tx, 'process_provider_assignments', 'service_provider_id', processId, want.providerIds);
    await this.syncTable(tx, 'process_did_assignments', 'did_id', processId, want.didIds);
    await this.syncTable(tx, 'process_server_assignments', 'call_server_id', processId, want.serverIds);
    await tx.execute(
      `UPDATE outbound_processes SET default_service_provider_id = NULL
        WHERE tenant_id = :tenantId AND id = :pid AND default_service_provider_id IS NOT NULL AND default_service_provider_id NOT IN (:keep)`,
      { pid: processId, keep: want.providerIds.length ? want.providerIds : ['00000000-0000-0000-0000-000000000000'] });
    await this.audit.log(tx, { actorUserId: actor.userId, action: 'process.assignments_updated', entityType: 'outbound_process', entityId: processId,
      metadata: { providers: want.providerIds.length, dids: want.didIds.length, servers: want.serverIds.length } }, ctx);
    return this.view(tx, processId);
  }

  private async syncTable(tx: SqlRunner, table: 'process_provider_assignments' | 'process_did_assignments' | 'process_server_assignments', col: string, processId: string, wanted: string[]) {
    // table/col come from the closed set above, never from input.
    const present = await tx.query<{ x: string }>(`SELECT ${col} AS x FROM ${table} WHERE tenant_id = :tenantId AND process_id = :pid`, { pid: processId });
    const have = new Set(present.map((r) => r.x));
    for (const id of wanted.filter((x) => !have.has(x))) {
      await tx.execute(`INSERT INTO ${table} (tenant_id, process_id, ${col}) VALUES (:tenantId, :pid, :id)`, { pid: processId, id });
    }
    const drop = [...have].filter((x) => !wanted.includes(x));
    if (drop.length) await tx.execute(`DELETE FROM ${table} WHERE tenant_id = :tenantId AND process_id = :pid AND ${col} IN (:drop)`, { pid: processId, drop });
  }

  private async assertAll(tx: SqlRunner, table: 'service_providers' | 'call_servers', ids: string[], label: string) {
    if (!ids.length) return;
    const rows = await tx.query(`SELECT id FROM ${table} WHERE tenant_id = :tenantId AND id IN (:ids) AND deleted_at IS NULL`, { ids });
    if (rows.length !== ids.length) throw new BadRequestException(`One or more ${label}s do not exist`);
  }

  private async assertProcess(tx: SqlRunner, id: string, lock = false) {
    const rows = await tx.query(`SELECT id FROM outbound_processes WHERE tenant_id = :tenantId AND id = :id AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, { id });
    if (!rows.length) throw new NotFoundException('Process not found');
  }

  private async sets(tx: SqlRunner, pid: string): Promise<AssignmentSet> {
    const col = async (table: string, c: string) =>
      (await tx.query<{ x: string }>(`SELECT ${c} AS x FROM ${table} WHERE tenant_id = :tenantId AND process_id = :pid`, { pid })).map((r) => r.x);
    return { providerIds: await col('process_provider_assignments', 'service_provider_id'), didIds: await col('process_did_assignments', 'did_id'), serverIds: await col('process_server_assignments', 'call_server_id') };
  }

  private async view(tx: SqlRunner, processId: string) {
    const [proc] = await tx.query<{ default_service_provider_id: string | null }>(`SELECT default_service_provider_id FROM outbound_processes WHERE tenant_id = :tenantId AND record_status = 1 AND id = :id`, { id: processId });
    const callerAssignments = await tx.query(
      `SELECT ca.id, sp.name AS provider, d.did, ca.prefix, s.name AS call_server, ca.status, ca.import_batch_id, ca.created_at
         FROM caller_assignments ca
         JOIN service_providers sp ON sp.id = ca.service_provider_id AND sp.tenant_id = :tenantId AND sp.record_status = 1
         JOIN provider_dids d ON d.id = ca.did_id AND d.tenant_id = :tenantId AND d.record_status = 1
         JOIN call_servers s ON s.id = ca.call_server_id AND s.tenant_id = :tenantId AND s.record_status = 1
        WHERE ca.tenant_id = :tenantId AND ca.process_id = :pid ORDER BY sp.name, d.did LIMIT 500`, { pid: processId });
    return {
      processId, ...(await this.sets(tx, processId)), defaultProviderId: proc?.default_service_provider_id ?? null,
      callerAssignments: callerAssignments.map((r) => ({ id: r.id, provider: r.provider, did: r.did, prefix: r.prefix, callServer: r.call_server, status: r.status, importBatchId: r.import_batch_id, createdAt: iso(r.created_at) })),
    };
  }
}

@ApiTags('process-assignments')
@ApiBearerAuth()
@Controller({ path: 'process-assignments', version: '1' })
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Get() @RequirePermissions('master_data:read')
  get(@CurrentUser() u: AuthUser, @Query(new ZodPipe(querySchema)) q: z.infer<typeof querySchema>) { return this.assignments.get(u, q.processId); }

  @Post() @HttpCode(201) @RequirePermissions('processes:manage')
  add(@CurrentUser() u: AuthUser, @Body(new ZodPipe(addSchema)) dto: z.infer<typeof addSchema>, @ReqContext() c: RequestContext) { return this.assignments.add(u, dto, c); }

  @Put(':processId') @RequirePermissions('processes:manage')
  replace(@CurrentUser() u: AuthUser, @Param('processId', ParseUUIDPipe) processId: string, @Body(new ZodPipe(replaceSchema)) dto: z.infer<typeof replaceSchema>, @ReqContext() c: RequestContext) { return this.assignments.replace(u, processId, dto, c); }
}
