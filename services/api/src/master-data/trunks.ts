import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth/auth.types';
import { CurrentUser, ReqContext, RequirePermissions } from '../common/auth/decorators';
import { SecretsService } from '../common/crypto/secrets.service';
import { Database, newId, Row, SqlRunner } from '../database/database';
import { PjsipTrunkInput, renderPjsipTrunk, trunkEndpointName } from '../telephony/pjsip-config';
import { buildSet, CODECS, HOST_RE, intRange, iso, json, likePattern, ListQuery, listQuerySchema, nameSchema, uuidSchema, z, ZodPipe } from './common';
import { ConnectivityService } from './connectivity.service';

const USER = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._@+-]+$/, 'letters, digits and . _ @ + - only');
const rtp = z.object({ srtp: z.boolean().optional(), portStart: intRange(1024, 65535).optional(), portEnd: intRange(1024, 65535).optional() }).strict();

const trunkBase = {
  host: z.string().trim().regex(HOST_RE, 'invalid host name or IP'),
  port: intRange(1, 65535).optional(),
  transport: z.enum(['udp', 'tcp', 'tls']),
  authMode: z.enum(['registration', 'ip']),
  username: USER,
  authId: USER,
  realm: z.string().trim().regex(HOST_RE, 'invalid realm'),
  outboundProxy: z.string().trim().regex(/^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$/, 'host[:port]'),
  password: z.string().min(1).max(200).regex(/^[^\r\n\0;]+$/, 'must not contain line breaks or ;'),
  registrationExpirySeconds: intRange(60, 3600),
  codecs: z.array(z.enum(CODECS)).min(1).max(6),
  rtp,
  maxConcurrentCalls: intRange(1, 10_000),
  priority: intRange(0, 10_000),
  weight: intRange(0, 1000),
};

export const trunkCreateSchema = z.object({
  name: nameSchema,
  serviceProviderId: uuidSchema,
  host: trunkBase.host,
  port: trunkBase.port,
  transport: trunkBase.transport.default('tls'),
  authMode: trunkBase.authMode.default('registration'),
  username: trunkBase.username.optional(),
  authId: trunkBase.authId.optional(),
  realm: trunkBase.realm.optional(),
  outboundProxy: trunkBase.outboundProxy.optional(),
  password: trunkBase.password.optional(),
  registrationExpirySeconds: trunkBase.registrationExpirySeconds.default(300),
  codecs: trunkBase.codecs.default(['ulaw', 'alaw']),
  rtp: rtp.optional(),
  maxConcurrentCalls: trunkBase.maxConcurrentCalls.default(30),
  priority: trunkBase.priority.default(100),
  weight: trunkBase.weight.default(100),
}).strict();

export const trunkUpdateSchema = z.object({
  name: nameSchema.optional(),
  serviceProviderId: uuidSchema.optional(),
  host: trunkBase.host.optional(),
  port: trunkBase.port,
  transport: trunkBase.transport.optional(),
  authMode: trunkBase.authMode.optional(),
  username: trunkBase.username.nullable().optional(),
  authId: trunkBase.authId.nullable().optional(),
  realm: trunkBase.realm.nullable().optional(),
  outboundProxy: trunkBase.outboundProxy.nullable().optional(),
  password: trunkBase.password.optional(),
  registrationExpirySeconds: trunkBase.registrationExpirySeconds.optional(),
  codecs: trunkBase.codecs.optional(),
  rtp: rtp.nullable().optional(),
  maxConcurrentCalls: trunkBase.maxConcurrentCalls.optional(),
  priority: trunkBase.priority.optional(),
  weight: trunkBase.weight.optional(),
  status: z.enum(['pending_configuration', 'active', 'disabled']).optional(),
}).strict();

const COLS = `t.id, t.name, t.service_provider_id, t.host, t.port, t.transport, t.auth_mode, t.auth_username, t.auth_id, t.realm, t.outbound_proxy,
  t.auth_secret_encrypted IS NOT NULL AS has_password, t.registration_expiry_seconds, t.codecs, t.rtp_config, t.priority, t.weight, t.max_concurrent_calls,
  t.status, t.health_status, t.circuit_state, t.registration_status, t.verification_status, t.verified_at, t.last_health_check_at, t.last_test_error, t.created_at`;

/** Public view: credentials are never returned, only whether a password is stored. */
export const trunkView = (r: Row) => ({
  id: r.id, name: r.name, serviceProviderId: r.service_provider_id, host: r.host, port: r.port, transport: r.transport, authMode: r.auth_mode,
  username: r.auth_username, authId: r.auth_id, realm: r.realm, outboundProxy: r.outbound_proxy, hasPassword: !!r.has_password,
  registrationExpirySeconds: r.registration_expiry_seconds, codecs: r.codecs ?? ['ulaw', 'alaw'], rtp: r.rtp_config, priority: r.priority, weight: r.weight,
  maxConcurrentCalls: r.max_concurrent_calls, status: r.status, healthStatus: r.health_status, circuitState: r.circuit_state,
  registrationStatus: r.registration_status, verificationStatus: r.verification_status, verifiedAt: iso(r.verified_at),
  lastHealthCheckAt: iso(r.last_health_check_at), lastTestError: r.last_test_error, endpointName: trunkEndpointName(r.id), createdAt: iso(r.created_at),
});

const TECHNICAL = ['serviceProviderId', 'host', 'port', 'transport', 'authMode', 'username', 'authId', 'realm', 'outboundProxy', 'password', 'registrationExpirySeconds', 'codecs', 'rtp'];

@Injectable()
export class TrunksService {
  constructor(private readonly db: Database, private readonly audit: AuditService, private readonly secrets: SecretsService, private readonly probes: ConnectivityService) {}

  list(actor: AuthUser, q: ListQuery & { providerId?: string }) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const p: Record<string, unknown> = {};
      let where = '';
      if (q.search) { p.search = likePattern(q.search); where += ' AND LOWER(t.name) LIKE :search'; }
      if (q.status) { p.status = q.status; where += ' AND t.status = :status'; }
      if (q.providerId) { p.provider = q.providerId; where += ' AND t.service_provider_id = :provider'; }
      const rows = await tx.query(`SELECT ${COLS} FROM tenant_sip_providers t WHERE t.tenant_id = :tenantId AND t.deleted_at IS NULL${where} ORDER BY t.priority, t.name LIMIT ${q.limit} OFFSET ${q.offset}`, p);
      const [{ n }] = await tx.query<{ n: number }>(`SELECT COUNT(*) AS n FROM tenant_sip_providers t WHERE t.tenant_id = :tenantId AND t.deleted_at IS NULL${where}`, p);
      return { items: rows.map(trunkView), total: Number(n), limit: q.limit, offset: q.offset };
    });
  }

  get(actor: AuthUser, id: string) {
    return this.db.withTenant(actor.tenantId, (tx) => this.load(tx, id));
  }

  create(actor: AuthUser, dto: z.infer<typeof trunkCreateSchema>, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      await this.assertProvider(tx, dto.serviceProviderId);
      const [generic] = await tx.query<{ id: string }>(`SELECT id FROM sip_providers WHERE \`key\` = 'generic'`);
      const id = newId();
      await tx.execute(
        `INSERT INTO tenant_sip_providers (id, tenant_id, sip_provider_id, service_provider_id, name, host, port, transport, auth_mode, auth_username, auth_id, realm, outbound_proxy,
            auth_secret_encrypted, registration_expiry_seconds, codecs, rtp_config, priority, weight, max_concurrent_calls, status, verification_status, registration_status)
         VALUES (:id, :tenantId, :cat, :sp, :n, :h, :port, :tr, :am, :u, :aid, :realm, :proxy, :secret, :exp, :codecs, :rtp, :pr, :w, :m, 'pending_configuration', 'pending', :reg)`,
        {
          id, cat: generic.id, sp: dto.serviceProviderId, n: dto.name, h: dto.host, port: dto.port ?? (dto.transport === 'tls' ? 5061 : 5060), tr: dto.transport, am: dto.authMode,
          u: dto.username ?? null, aid: dto.authId ?? null, realm: dto.realm ?? null, proxy: dto.outboundProxy ?? null,
          secret: dto.password ? this.secrets.encrypt(dto.password) : null, exp: dto.registrationExpirySeconds, codecs: json(dto.codecs), rtp: json(dto.rtp),
          pr: dto.priority, w: dto.weight, m: dto.maxConcurrentCalls, reg: dto.authMode === 'ip' ? 'not_required' : 'unknown',
        },
      );
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'trunk.created', entityType: 'sip_trunk', entityId: id, metadata: { name: dto.name, host: dto.host, transport: dto.transport } }, ctx);
      return this.load(tx, id);
    });
  }

  update(actor: AuthUser, id: string, dto: z.infer<typeof trunkUpdateSchema>, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const cur = await this.load(tx, id, true);
      if (dto.serviceProviderId && dto.serviceProviderId !== cur.serviceProviderId) {
        await this.assertProvider(tx, dto.serviceProviderId);
        const [{ n }] = await tx.query<{ n: number }>(`SELECT COUNT(*) AS n FROM provider_dids WHERE tenant_id = :tenantId AND trunk_id = :id AND deleted_at IS NULL`, { id });
        if (Number(n) > 0) throw new ConflictException('Reassign or remove the DIDs that use this trunk before moving it to another provider');
      }
      const changed = TECHNICAL.some((k) => {
        const v = (dto as Record<string, unknown>)[k];
        return v !== undefined && (k === 'password' || JSON.stringify(v) !== JSON.stringify((cur as Record<string, unknown>)[k === 'rtp' ? 'rtp' : k]));
      });
      let status = dto.status;
      if (dto.status === 'active' && cur.verificationStatus !== 'verified' && !changed) {
        throw new BadRequestException('A trunk can be activated only after it has been tested and verified');
      }
      const p: Record<string, unknown> = { id };
      const sets = buildSet(
        { name: 'name', serviceProviderId: 'service_provider_id', host: 'host', port: 'port', transport: 'transport', authMode: 'auth_mode', username: 'auth_username', authId: 'auth_id', realm: 'realm',
          outboundProxy: 'outbound_proxy', registrationExpirySeconds: 'registration_expiry_seconds', codecs: 'codecs', rtp: 'rtp_config', maxConcurrentCalls: 'max_concurrent_calls', priority: 'priority', weight: 'weight' },
        dto, p, { codecs: json, rtp: json },
      );
      if (dto.password) { sets.push('auth_secret_encrypted = :secret'); p.secret = this.secrets.encrypt(dto.password); }
      if (dto.authMode) { sets.push('registration_status = :reg'); p.reg = dto.authMode === 'ip' ? 'not_required' : 'unknown'; }
      if (changed) {
        // Editing connection or credential settings invalidates earlier verification; it must be re-tested.
        sets.push(`verification_status = 'pending'`, 'verified_at = NULL', `health_status = 'unknown'`);
        if (cur.status === 'active' || status === 'active') status = 'pending_configuration';
      }
      if (status) { sets.push('status = :status'); p.status = status; }
      if (sets.length) await tx.execute(`UPDATE tenant_sip_providers SET ${sets.join(', ')} WHERE tenant_id = :tenantId AND id = :id`, p);
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'trunk.updated', entityType: 'sip_trunk', entityId: id, metadata: { fields: Object.keys(dto).map((k) => (k === 'password' ? 'password(changed)' : k)), verificationReset: changed } }, ctx);
      return this.load(tx, id);
    });
  }

  remove(actor: AuthUser, id: string, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const cur = await this.load(tx, id, true);
      const [{ dids }] = await tx.query<{ dids: number }>(`SELECT COUNT(*) AS dids FROM provider_dids WHERE tenant_id = :tenantId AND trunk_id = :id AND deleted_at IS NULL`, { id });
      const [{ calls }] = await tx.query<{ calls: number }>(`SELECT COUNT(*) AS calls FROM outbound_calls WHERE tenant_id = :tenantId AND trunk_id = :id AND status IN ('initiated','ringing','answered')`, { id });
      if (Number(dids) > 0 || Number(calls) > 0) throw new ConflictException(`Trunk "${cur.name}" is in use (${dids} DIDs, ${calls} active calls)`);
      await tx.execute(`UPDATE tenant_sip_providers SET deleted_at = UTC_TIMESTAMP(3), status = 'disabled' WHERE tenant_id = :tenantId AND id = :id`, { id });
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'trunk.deleted', entityType: 'sip_trunk', entityId: id, metadata: { name: cur.name } }, ctx);
    });
  }

  /** Network reachability test. Does NOT prove SIP authentication or carrier registration. */
  async test(actor: AuthUser, id: string, ctx: RequestContext) {
    const t = await this.db.withTenant(actor.tenantId, (tx) => this.load(tx, id));
    const probe = t.transport === 'udp'
      ? { ok: null, message: 'UDP trunks cannot be probed from the API. Verify with an Asterisk OPTIONS/registration check, then confirm manually.' }
      : await this.probes.probeTcp(t.host, t.port, t.transport === 'tls');
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const health = probe.ok === null ? 'unknown' : probe.ok ? 'healthy' : 'down';
      await tx.execute(`UPDATE tenant_sip_providers SET health_status = :h, last_health_check_at = UTC_TIMESTAMP(3), last_test_error = :e WHERE tenant_id = :tenantId AND id = :id`,
        { id, h: health, e: probe.ok === false ? probe.message.slice(0, 500) : null });
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'trunk.tested', entityType: 'sip_trunk', entityId: id, metadata: { ok: probe.ok } }, ctx);
      return { ok: probe.ok, message: probe.message, latencyMs: (probe as { latencyMs?: number }).latencyMs ?? null, trunk: await this.load(tx, id) };
    });
  }

  /** Admin attestation that the trunk works. Requires complete credentials and (tcp/tls) a successful reachability test. */
  verify(actor: AuthUser, id: string, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const t = await this.load(tx, id, true);
      if (t.authMode === 'registration' && (!t.username || !t.hasPassword)) throw new BadRequestException('Registration trunks need a username and password before verification');
      if (t.transport !== 'udp' && t.healthStatus !== 'healthy') throw new BadRequestException('Run a successful connectivity test before verifying this trunk');
      await tx.execute(`UPDATE tenant_sip_providers SET verification_status = 'verified', verified_at = UTC_TIMESTAMP(3) WHERE tenant_id = :tenantId AND id = :id`, { id });
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'trunk.verified', entityType: 'sip_trunk', entityId: id, metadata: { method: 'admin_attestation' } }, ctx);
      return this.load(tx, id);
    });
  }

  /** Generated Asterisk config for review. Secrets are always masked. */
  async pjsipPreview(actor: AuthUser, id: string) {
    const t = await this.db.withTenant(actor.tenantId, (tx) => this.load(tx, id));
    const input: PjsipTrunkInput = {
      id: t.id, host: t.host, port: t.port, transport: t.transport, authMode: t.authMode, username: t.username, authId: t.authId, realm: t.realm,
      outboundProxy: t.outboundProxy, registrationExpirySeconds: t.registrationExpirySeconds, codecs: t.codecs, srtp: !!t.rtp?.srtp,
    };
    try {
      return { config: renderPjsipTrunk(input, { maskSecrets: true }) };
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  private async assertProvider(tx: SqlRunner, providerId: string) {
    const rows = await tx.query(`SELECT 1 FROM service_providers WHERE tenant_id = :tenantId AND id = :p AND deleted_at IS NULL`, { p: providerId });
    if (!rows.length) throw new BadRequestException('Provider not found');
  }

  private async load(tx: SqlRunner, id: string, lock = false) {
    if (lock) await tx.query(`SELECT id FROM tenant_sip_providers WHERE tenant_id = :tenantId AND id = :id AND record_status = 1 FOR UPDATE`, { id });
    const [row] = await tx.query(`SELECT ${COLS} FROM tenant_sip_providers t WHERE t.tenant_id = :tenantId AND t.id = :id AND t.deleted_at IS NULL`, { id });
    if (!row) throw new NotFoundException('Trunk not found');
    return trunkView(row);
  }
}

const trunkListQuery = listQuerySchema.extend({ providerId: uuidSchema.optional() }).strict();

@ApiTags('trunks')
@ApiBearerAuth()
@Controller({ path: 'trunks', version: '1' })
export class TrunksController {
  constructor(private readonly trunks: TrunksService) {}

  @Get() @RequirePermissions('master_data:read')
  list(@CurrentUser() u: AuthUser, @Query(new ZodPipe(trunkListQuery)) q: ListQuery & { providerId?: string }) { return this.trunks.list(u, q); }

  @Get(':id') @RequirePermissions('master_data:read')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.trunks.get(u, id); }

  @Post() @RequirePermissions('sip_providers:manage')
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(trunkCreateSchema)) dto: z.infer<typeof trunkCreateSchema>, @ReqContext() c: RequestContext) { return this.trunks.create(u, dto, c); }

  @Put(':id') @RequirePermissions('sip_providers:manage')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(trunkUpdateSchema)) dto: z.infer<typeof trunkUpdateSchema>, @ReqContext() c: RequestContext) { return this.trunks.update(u, id, dto, c); }

  @Delete(':id') @HttpCode(204) @RequirePermissions('sip_providers:manage')
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ReqContext() c: RequestContext) { return this.trunks.remove(u, id, c); }

  @Post(':id/test') @HttpCode(200) @Throttle({ default: { limit: 20, ttl: 60_000 } }) @RequirePermissions('sip_providers:manage')
  test(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ReqContext() c: RequestContext) { return this.trunks.test(u, id, c); }

  @Post(':id/verify') @HttpCode(200) @RequirePermissions('sip_providers:manage')
  verify(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ReqContext() c: RequestContext) { return this.trunks.verify(u, id, c); }

  @Get(':id/pjsip-preview') @RequirePermissions('sip_providers:manage')
  preview(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.trunks.pjsipPreview(u, id); }
}
