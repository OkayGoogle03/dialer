import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth/auth.types';
import { CurrentUser, ReqContext, RequirePermissions } from '../common/auth/decorators';
import { SecretsService } from '../common/crypto/secrets.service';
import { Database, newId, Row, SqlRunner } from '../database/database';
import { buildSet, HOST_RE, intRange, iso, likePattern, ListQuery, listQuerySchema, nameSchema, z, ZodPipe } from './common';
import { ConnectivityService } from './connectivity.service';

const ariUrl = z.string().trim().max(500).refine((v) => {
  try { const u = new URL(v); return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password; } catch { return false; }
}, 'Must be an http(s) URL without embedded credentials');
const ariUser = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._@-]+$/);
const ariPassword = z.string().min(1).max(200).regex(/^[^\r\n\0]+$/);

export const callServerCreateSchema = z.object({
  name: nameSchema,
  host: z.string().trim().regex(HOST_RE, 'invalid host').optional(),
  port: intRange(1, 65535).optional(),
  instanceId: z.string().trim().max(100).regex(/^[A-Za-z0-9._-]+$/).optional(),
  ariUrl: ariUrl.optional(),
  ariUsername: ariUser.optional(),
  ariPassword: ariPassword.optional(),
  environment: z.enum(['production', 'staging', 'development']).default('production'),
  maxConcurrentCalls: intRange(1, 100_000).default(100),
}).strict();

export const callServerUpdateSchema = z.object({
  name: nameSchema.optional(),
  host: z.string().trim().regex(HOST_RE).nullable().optional(),
  port: intRange(1, 65535).nullable().optional(),
  instanceId: z.string().trim().max(100).regex(/^[A-Za-z0-9._-]+$/).nullable().optional(),
  ariUrl: ariUrl.nullable().optional(),
  ariUsername: ariUser.nullable().optional(),
  ariPassword: ariPassword.optional(),
  environment: z.enum(['production', 'staging', 'development']).optional(),
  maxConcurrentCalls: intRange(1, 100_000).optional(),
  status: z.enum(['pending_configuration', 'active', 'disabled']).optional(),
}).strict();

const COLS = `s.id, s.name, s.host, s.port, s.instance_id, s.ari_url, s.ari_username, s.ari_secret_encrypted IS NOT NULL AS has_password, s.environment,
  s.connection_status, s.connection_checked_at, s.connection_error, s.max_concurrent_calls, s.status, s.created_at`;

export const callServerView = (r: Row) => ({
  id: r.id, name: r.name, host: r.host, port: r.port, instanceId: r.instance_id, ariUrl: r.ari_url, ariUsername: r.ari_username, hasPassword: !!r.has_password,
  environment: r.environment, connectionStatus: r.connection_status, connectionCheckedAt: iso(r.connection_checked_at), connectionError: r.connection_error,
  maxConcurrentCalls: r.max_concurrent_calls, status: r.status, createdAt: iso(r.created_at),
});

const CONNECTION = ['host', 'port', 'instanceId', 'ariUrl', 'ariUsername', 'ariPassword'];

@Injectable()
export class CallServersService {
  constructor(private readonly db: Database, private readonly audit: AuditService, private readonly secrets: SecretsService, private readonly probes: ConnectivityService) {}

  list(actor: AuthUser, q: ListQuery) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const p: Record<string, unknown> = {};
      let where = '';
      if (q.search) { p.search = likePattern(q.search); where += ' AND LOWER(s.name) LIKE :search'; }
      if (q.status) { p.status = q.status; where += ' AND s.status = :status'; }
      const rows = await tx.query(`SELECT ${COLS} FROM call_servers s WHERE s.tenant_id = :tenantId AND s.deleted_at IS NULL${where} ORDER BY s.name LIMIT ${q.limit} OFFSET ${q.offset}`, p);
      const [{ n }] = await tx.query<{ n: number }>(`SELECT COUNT(*) AS n FROM call_servers s WHERE s.tenant_id = :tenantId AND s.deleted_at IS NULL${where}`, p);
      return { items: rows.map(callServerView), total: Number(n), limit: q.limit, offset: q.offset };
    });
  }

  get(actor: AuthUser, id: string) {
    return this.db.withTenant(actor.tenantId, (tx) => this.load(tx, id));
  }

  create(actor: AuthUser, dto: z.infer<typeof callServerCreateSchema>, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const id = newId();
      await tx.execute(
        `INSERT INTO call_servers (id, tenant_id, name, host, port, instance_id, ari_url, ari_username, ari_secret_encrypted, environment, max_concurrent_calls, created_by)
         VALUES (:id, :tenantId, :n, :h, :port, :inst, :url, :u, :secret, :env, :m, :by)`,
        { id, n: dto.name, h: dto.host ?? null, port: dto.port ?? null, inst: dto.instanceId ?? null, url: dto.ariUrl ?? null, u: dto.ariUsername ?? null,
          secret: dto.ariPassword ? this.secrets.encrypt(dto.ariPassword) : null, env: dto.environment, m: dto.maxConcurrentCalls, by: actor.userId },
      );
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'call_server.created', entityType: 'call_server', entityId: id, metadata: { name: dto.name } }, ctx);
      return this.load(tx, id);
    });
  }

  update(actor: AuthUser, id: string, dto: z.infer<typeof callServerUpdateSchema>, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const cur = await this.load(tx, id, true);
      const changed = CONNECTION.some((k) => (dto as Record<string, unknown>)[k] !== undefined && (k === 'ariPassword' || (dto as Record<string, unknown>)[k] !== (cur as Record<string, unknown>)[k]));
      let status = dto.status;
      if (status === 'active' && !changed && cur.connectionStatus !== 'connected') throw new BadRequestException('A call server can be activated only after a successful connectivity test');
      const p: Record<string, unknown> = { id };
      const sets = buildSet(
        { name: 'name', host: 'host', port: 'port', instanceId: 'instance_id', ariUrl: 'ari_url', ariUsername: 'ari_username', environment: 'environment', maxConcurrentCalls: 'max_concurrent_calls' }, dto, p);
      if (dto.ariPassword) { sets.push('ari_secret_encrypted = :secret'); p.secret = this.secrets.encrypt(dto.ariPassword); }
      if (changed) {
        // Connection settings changed: earlier connectivity result no longer applies.
        sets.push(`connection_status = 'unknown'`, 'connection_checked_at = NULL', 'connection_error = NULL');
        if (cur.status === 'active' || status === 'active') status = 'pending_configuration';
      }
      if (status) { sets.push('status = :status'); p.status = status; }
      if (sets.length) await tx.execute(`UPDATE call_servers SET ${sets.join(', ')} WHERE tenant_id = :tenantId AND id = :id`, p);
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'call_server.updated', entityType: 'call_server', entityId: id, metadata: { fields: Object.keys(dto).map((k) => (k === 'ariPassword' ? 'ariPassword(changed)' : k)), connectionReset: changed } }, ctx);
      return this.load(tx, id);
    });
  }

  remove(actor: AuthUser, id: string, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const cur = await this.load(tx, id, true);
      const [{ n }] = await tx.query<{ n: number }>(
        `SELECT (SELECT COUNT(*) FROM caller_assignments WHERE tenant_id = :tenantId AND call_server_id = :id) + (SELECT COUNT(*) FROM process_server_assignments WHERE tenant_id = :tenantId AND call_server_id = :id) AS n`, { id });
      if (Number(n) > 0) throw new ConflictException(`Call server "${cur.name}" is assigned to a process`);
      await tx.execute(`UPDATE call_servers SET deleted_at = UTC_TIMESTAMP(3), status = 'disabled' WHERE tenant_id = :tenantId AND id = :id`, { id });
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'call_server.deleted', entityType: 'call_server', entityId: id, metadata: { name: cur.name } }, ctx);
    });
  }

  /** Real ARI call. "connected" is recorded only if the server actually answers with the stored credentials. */
  async test(actor: AuthUser, id: string, ctx: RequestContext) {
    const secrets = await this.db.withTenant(actor.tenantId, async (tx) => {
      await this.load(tx, id);
      const [row] = await tx.query<{ ari_url: string | null; ari_username: string | null; ari_secret_encrypted: string | null }>(
        `SELECT ari_url, ari_username, ari_secret_encrypted FROM call_servers WHERE tenant_id = :tenantId AND id = :id`, { id });
      return row;
    });
    if (!secrets.ari_url || !secrets.ari_username || !secrets.ari_secret_encrypted) throw new BadRequestException('ARI URL, username and password must be configured before testing');
    const result = await this.probes.probeAri(secrets.ari_url, secrets.ari_username, this.secrets.decrypt(secrets.ari_secret_encrypted));
    return this.db.withTenant(actor.tenantId, async (tx) => {
      await tx.execute(
        `UPDATE call_servers SET connection_status = :s, connection_checked_at = UTC_TIMESTAMP(3), connection_error = :e WHERE tenant_id = :tenantId AND id = :id`,
        { id, s: result.ok ? 'connected' : 'failed', e: result.ok ? null : result.message.slice(0, 500) });
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'call_server.tested', entityType: 'call_server', entityId: id, metadata: { ok: result.ok } }, ctx);
      return { ok: !!result.ok, message: result.message, latencyMs: result.latencyMs ?? null, server: await this.load(tx, id) };
    });
  }

  private async load(tx: SqlRunner, id: string, lock = false) {
    if (lock) await tx.query(`SELECT id FROM call_servers WHERE tenant_id = :tenantId AND id = :id FOR UPDATE`, { id });
    const [row] = await tx.query(`SELECT ${COLS} FROM call_servers s WHERE s.tenant_id = :tenantId AND s.id = :id AND s.deleted_at IS NULL`, { id });
    if (!row) throw new NotFoundException('Call server not found');
    return callServerView(row);
  }
}

@ApiTags('call-servers')
@ApiBearerAuth()
@Controller({ path: 'call-servers', version: '1' })
export class CallServersController {
  constructor(private readonly servers: CallServersService) {}

  @Get() @RequirePermissions('master_data:read')
  list(@CurrentUser() u: AuthUser, @Query(new ZodPipe(listQuerySchema)) q: ListQuery) { return this.servers.list(u, q); }

  @Get(':id') @RequirePermissions('master_data:read')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.servers.get(u, id); }

  @Post() @RequirePermissions('call_servers:manage')
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(callServerCreateSchema)) dto: z.infer<typeof callServerCreateSchema>, @ReqContext() c: RequestContext) { return this.servers.create(u, dto, c); }

  @Put(':id') @RequirePermissions('call_servers:manage')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(callServerUpdateSchema)) dto: z.infer<typeof callServerUpdateSchema>, @ReqContext() c: RequestContext) { return this.servers.update(u, id, dto, c); }

  @Delete(':id') @HttpCode(204) @RequirePermissions('call_servers:manage')
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ReqContext() c: RequestContext) { return this.servers.remove(u, id, c); }

  @Post(':id/test') @HttpCode(200) @Throttle({ default: { limit: 20, ttl: 60_000 } }) @RequirePermissions('call_servers:manage')
  test(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ReqContext() c: RequestContext) { return this.servers.test(u, id, c); }
}
