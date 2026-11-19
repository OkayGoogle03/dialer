import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Header, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth/auth.types';
import { CurrentUser, ReqContext, RequirePermissions } from '../common/auth/decorators';
import { SecretsService } from '../common/crypto/secrets.service';
import { Database, newId, Row, SqlRunner } from '../database/database';
import { OutboxService } from '../events/outbox.service';
import { iso, uuidSchema, z, ZodPipe } from '../master-data/common';
import { webrtcUrl } from '../master-data/call-servers';
import { DEFAULT_DIAL_PLAN } from '../master-data/processes';
import { normalizeDestination } from '../routing/routing';

const sipId = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._@+-]+$/, 'letters, digits and . _ @ + - only');
const sipSecret = z.string().min(1).max(200).regex(/^[^\r\n\0]+$/);

export const accountCreateSchema = z.object({
  userId: uuidSchema, callServerId: uuidSchema, sipId, password: sipSecret, displayName: z.string().trim().max(100).optional(),
}).strict();
export const accountUpdateSchema = z.object({
  sipId: sipId.optional(), password: sipSecret.optional(), displayName: z.string().trim().max(100).nullable().optional(), status: z.enum(['active', 'disabled']).optional(),
}).strict();
const registrationSchema = z.object({ accountId: uuidSchema, state: z.enum(['registered', 'unregistered', 'failed']), error: z.string().trim().max(300).optional() }).strict();
const callCreateSchema = z.object({ accountId: uuidSchema, destination: z.string().trim().min(3).max(32), assignmentId: uuidSchema.optional() }).strict();
const callUpdateSchema = z.object({
  status: z.enum(['ringing', 'answered', 'completed', 'failed']), cause: z.string().trim().max(100).optional(), sipCode: z.number().int().min(100).max(699).optional(),
}).strict();
const callListSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).default(0) }).strict();
const accountListSchema = z.object({ userId: uuidSchema.optional(), callServerId: uuidSchema.optional() }).strict();

const ACCOUNT_COLS = `a.id, a.user_id, a.call_server_id, a.sip_id, a.display_name, a.status, a.registration_status, a.registered_at, a.last_seen_at, a.last_error, a.created_at,
  u.email AS user_email, u.display_name AS user_name, s.name AS server_name`;

/** Admin view. The SIP password is write-only here: it is never part of this view. */
const accountView = (r: Row) => ({
  id: r.id, userId: r.user_id, userEmail: r.user_email, userName: r.user_name, callServerId: r.call_server_id, callServerName: r.server_name,
  sipId: r.sip_id, displayName: r.display_name, status: r.status, hasPassword: true,
  registrationStatus: r.registration_status, registeredAt: iso(r.registered_at), lastSeenAt: iso(r.last_seen_at), lastError: r.last_error, createdAt: iso(r.created_at),
});

const TERMINAL = new Set(['completed', 'failed']);
const NEXT: Record<string, string[]> = {
  initiated: ['ringing', 'answered', 'completed', 'failed'],
  ringing: ['answered', 'completed', 'failed'],
  answered: ['completed'],
};

@Injectable()
export class SoftphoneService {
  constructor(private readonly db: Database, private readonly audit: AuditService, private readonly secrets: SecretsService, private readonly outbox: OutboxService) {}

  // ---------------------------------------------------------------- admin: SIP accounts
  listAccounts(actor: AuthUser, q: z.infer<typeof accountListSchema>) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const p: Record<string, unknown> = {};
      let where = '';
      if (q.userId) { p.uid = q.userId; where += ' AND a.user_id = :uid'; }
      if (q.callServerId) { p.sid = q.callServerId; where += ' AND a.call_server_id = :sid'; }
      const rows = await tx.query(
        `SELECT ${ACCOUNT_COLS} FROM softphone_accounts a
           JOIN users u ON u.id = a.user_id AND u.tenant_id = :tenantId
           JOIN call_servers s ON s.id = a.call_server_id AND s.tenant_id = :tenantId
          WHERE a.tenant_id = :tenantId AND a.deleted_at IS NULL${where} ORDER BY u.display_name, a.sip_id LIMIT 500`, p);
      return { items: rows.map(accountView) };
    });
  }

  createAccount(actor: AuthUser, dto: z.infer<typeof accountCreateSchema>, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const [user] = await tx.query(`SELECT id FROM users WHERE tenant_id = :tenantId AND id = :id AND deleted_at IS NULL`, { id: dto.userId });
      if (!user) throw new NotFoundException('User not found');
      const [server] = await tx.query(`SELECT id FROM call_servers WHERE tenant_id = :tenantId AND id = :id AND deleted_at IS NULL`, { id: dto.callServerId });
      if (!server) throw new NotFoundException('Call server not found');
      await this.assertUnique(tx, dto.userId, dto.callServerId, dto.sipId);
      const id = newId();
      await tx.execute(
        `INSERT INTO softphone_accounts (id, tenant_id, user_id, call_server_id, sip_id, display_name, sip_secret_encrypted, created_by)
         VALUES (:id, :tenantId, :uid, :sid, :sip, :dn, :secret, :by)`,
        { id, uid: dto.userId, sid: dto.callServerId, sip: dto.sipId, dn: dto.displayName ?? null, secret: this.secrets.encrypt(dto.password), by: actor.userId });
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'softphone_account.created', entityType: 'softphone_account', entityId: id, metadata: { userId: dto.userId, callServerId: dto.callServerId, sipId: dto.sipId } }, ctx);
      return this.loadAccount(tx, id);
    });
  }

  updateAccount(actor: AuthUser, id: string, dto: z.infer<typeof accountUpdateSchema>, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const [cur] = await tx.query(`SELECT id, user_id, call_server_id, sip_id FROM softphone_accounts WHERE tenant_id = :tenantId AND id = :id AND deleted_at IS NULL FOR UPDATE`, { id });
      if (!cur) throw new NotFoundException('SIP account not found');
      if (dto.sipId && dto.sipId !== cur.sip_id) await this.assertUnique(tx, cur.user_id, cur.call_server_id, dto.sipId, id);
      const sets: string[] = [];
      const p: Record<string, unknown> = { id };
      if (dto.sipId !== undefined) { sets.push('sip_id = :sip'); p.sip = dto.sipId; }
      if (dto.displayName !== undefined) { sets.push('display_name = :dn'); p.dn = dto.displayName; }
      if (dto.status !== undefined) { sets.push('status = :st'); p.st = dto.status; }
      if (dto.password) { sets.push('sip_secret_encrypted = :secret'); p.secret = this.secrets.encrypt(dto.password); }
      if (dto.sipId !== undefined || dto.password) sets.push(`registration_status = 'unknown'`, 'last_error = NULL');
      if (sets.length) await tx.execute(`UPDATE softphone_accounts SET ${sets.join(', ')} WHERE tenant_id = :tenantId AND id = :id`, p);
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'softphone_account.updated', entityType: 'softphone_account', entityId: id,
        metadata: { fields: Object.keys(dto).map((k) => (k === 'password' ? 'password(changed)' : k)) } }, ctx);
      return this.loadAccount(tx, id);
    });
  }

  removeAccount(actor: AuthUser, id: string, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const n = await tx.execute(`UPDATE softphone_accounts SET deleted_at = UTC_TIMESTAMP(3), status = 'disabled' WHERE tenant_id = :tenantId AND id = :id AND deleted_at IS NULL`, { id });
      if (!n.affectedRows) throw new NotFoundException('SIP account not found');
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'softphone_account.deleted', entityType: 'softphone_account', entityId: id }, ctx);
    });
  }

  // ---------------------------------------------------------------- agent: own config
  /**
   * The ONLY place a SIP password leaves the server, and only to the user it belongs to (the browser softphone needs it to REGISTER).
   * Rows are selected by the verified JWT user id; no request parameter can select another user's account.
   */
  config(actor: AuthUser, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const rows = await tx.query(
        `SELECT a.id, a.sip_id, a.display_name, a.sip_secret_encrypted, s.id AS server_id, s.name AS server_name, s.host, s.port, s.sip_transport, s.sip_ws_path, s.sip_realm, s.address_updated_at
           FROM softphone_accounts a JOIN call_servers s ON s.id = a.call_server_id AND s.tenant_id = :tenantId AND s.deleted_at IS NULL AND s.status = 'active'
          WHERE a.tenant_id = :tenantId AND a.user_id = :me AND a.deleted_at IS NULL AND a.status = 'active' ORDER BY s.name`, { me: actor.userId });
      const options = rows.length
        ? await tx.query(
            `SELECT ca.id AS assignment_id, ca.prefix, ca.call_server_id, p.id AS process_id, p.name AS process_name
               FROM caller_assignments ca JOIN outbound_processes p ON p.id = ca.process_id AND p.tenant_id = :tenantId AND p.deleted_at IS NULL AND p.status = 'active'
              WHERE ca.tenant_id = :tenantId AND ca.status = 'active' AND ca.call_server_id IN (:serverIds) ORDER BY p.name, ca.prefix`, { serverIds: [...new Set(rows.map((r) => r.server_id))] })
        : [];
      // Several assignments (different DIDs/providers) can share process + prefix + server; the agent only needs one entry per combination.
      const seen = new Set<string>();
      const dialOptions = options.filter((o) => { const k = `${o.process_id}|${o.prefix}|${o.call_server_id}`; if (seen.has(k)) return false; seen.add(k); return true; })
        .map((o) => ({ assignmentId: o.assignment_id, processId: o.process_id, processName: o.process_name, prefix: o.prefix, callServerId: o.call_server_id }));
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'softphone.config_read', entityType: 'softphone_account', metadata: { accounts: rows.length } }, ctx);
      return {
        accounts: rows.map((r) => ({
          id: r.id, sipId: r.sip_id, displayName: r.display_name, password: this.secrets.decrypt(r.sip_secret_encrypted),
          callServer: {
            id: r.server_id, name: r.server_name, host: r.host, port: r.port, transport: r.sip_transport, wsPath: r.sip_ws_path, realm: r.sip_realm || r.host,
            webrtcUrl: webrtcUrl(r.host, r.port, r.sip_transport, r.sip_ws_path), addressUpdatedAt: iso(r.address_updated_at),
          },
        })),
        dialOptions,
        fetchedAt: new Date().toISOString(),
      };
    });
  }

  reportRegistration(actor: AuthUser, dto: z.infer<typeof registrationSchema>) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const ok = dto.state === 'registered';
      const n = await tx.execute(
        `UPDATE softphone_accounts SET registration_status = :st, last_seen_at = UTC_TIMESTAMP(3), last_error = :err,
                registered_at = IF(:ok = 1, UTC_TIMESTAMP(3), registered_at)
          WHERE tenant_id = :tenantId AND id = :id AND user_id = :me AND deleted_at IS NULL`,
        { id: dto.accountId, me: actor.userId, st: dto.state, err: ok ? null : (dto.error ?? null), ok: ok ? 1 : 0 });
      if (!n.affectedRows) throw new NotFoundException('SIP account not found');
      return { ok: true };
    });
  }

  // ---------------------------------------------------------------- agent: manual calls
  /** The server applies the prefix; the browser only dials what comes back. */
  placeCall(actor: AuthUser, dto: z.infer<typeof callCreateSchema>, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const [acct] = await tx.query(
        `SELECT a.id, a.sip_id, s.id AS server_id, s.host, s.sip_realm FROM softphone_accounts a
           JOIN call_servers s ON s.id = a.call_server_id AND s.tenant_id = :tenantId AND s.deleted_at IS NULL AND s.status = 'active'
          WHERE a.tenant_id = :tenantId AND a.id = :id AND a.user_id = :me AND a.deleted_at IS NULL AND a.status = 'active'`, { id: dto.accountId, me: actor.userId });
      if (!acct) throw new NotFoundException('SIP account not found or its call server is not active');
      let prefix = '';
      // Without a dial option (internal extension, test call) the number is dialed as typed, with only basic length checks.
      let plan = { ...DEFAULT_DIAL_PLAN, minLength: 3, stripLeadingZeros: false };
      let process: { id: string; name: string } | null = null;
      if (dto.assignmentId) {
        const [ca] = await tx.query(
          `SELECT ca.prefix, p.id AS pid, p.name AS pname, p.dial_plan FROM caller_assignments ca
             JOIN outbound_processes p ON p.id = ca.process_id AND p.tenant_id = :tenantId AND p.deleted_at IS NULL AND p.status = 'active'
            WHERE ca.tenant_id = :tenantId AND ca.id = :id AND ca.status = 'active' AND ca.call_server_id = :sid`, { id: dto.assignmentId, sid: acct.server_id });
        if (!ca) throw new BadRequestException('Dial option not found for this call server');
        prefix = ca.prefix; plan = { ...DEFAULT_DIAL_PLAN, ...(ca.dial_plan ?? {}) }; process = { id: ca.pid, name: ca.pname };
      }
      const n = normalizeDestination(dto.destination, prefix, plan);
      if (!n.ok) throw new BadRequestException({ code: n.code, message: n.message });
      const id = newId();
      await tx.execute(
        `INSERT INTO call_sessions (id, tenant_id, direction, status, from_number, to_number, user_id, correlation_id, metadata)
         VALUES (:id, :tenantId, 'outbound', 'initiated', :from, :to, :me, :cid, :meta)`,
        { id, from: acct.sip_id.slice(0, 32), to: n.dialed.slice(0, 32), me: actor.userId, cid: ctx.correlationId ?? null,
          meta: JSON.stringify({ source: 'softphone', accountId: acct.id, callServerId: acct.server_id, prefix, entered: dto.destination.slice(0, 32), process }) });
      await this.outbox.enqueue(tx, actor.tenantId, 'call.created', { call_id: id, direction: 'outbound', from: acct.sip_id.slice(0, 32), to: n.dialed.slice(0, 32), user_id: actor.userId, campaign_id: null, queue_id: null });
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'softphone.call_placed', entityType: 'call_session', entityId: id, metadata: { prefix, processId: process?.id ?? null } }, ctx);
      return { callId: id, dialed: n.dialed, prefix, target: `sip:${n.dialed}@${acct.sip_realm || acct.host}` };
    });
  }

  updateCall(actor: AuthUser, id: string, dto: z.infer<typeof callUpdateSchema>) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const [cur] = await tx.query(
        `SELECT id, status, started_at, answered_at FROM call_sessions WHERE tenant_id = :tenantId AND id = :id AND user_id = :me AND direction = 'outbound'
            AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.source')) = 'softphone' FOR UPDATE`, { id, me: actor.userId });
      if (!cur) throw new NotFoundException('Call not found');
      if (cur.status === dto.status) return { id, status: cur.status }; // idempotent retries from the client
      if (TERMINAL.has(cur.status) || !NEXT[cur.status]?.includes(dto.status)) throw new ConflictException(`Call is ${cur.status}; cannot change to ${dto.status}`);
      const now = new Date();
      if (dto.status === 'ringing') {
        await tx.execute(`UPDATE call_sessions SET status = 'ringing' WHERE tenant_id = :tenantId AND id = :id`, { id });
        await this.outbox.enqueue(tx, actor.tenantId, 'call.ringing', { call_id: id });
      } else if (dto.status === 'answered') {
        await tx.execute(`UPDATE call_sessions SET status = 'answered', answered_at = UTC_TIMESTAMP(3) WHERE tenant_id = :tenantId AND id = :id`, { id });
        await this.outbox.enqueue(tx, actor.tenantId, 'call.answered', { call_id: id, answered_at: now.toISOString() });
      } else if (dto.status === 'completed') {
        await tx.execute(`UPDATE call_sessions SET status = 'completed', ended_at = UTC_TIMESTAMP(3), hangup_cause = :c WHERE tenant_id = :tenantId AND id = :id`, { id, c: dto.cause ?? 'normal_clearing' });
        const started = new Date(cur.started_at).getTime();
        const answered = cur.answered_at ? new Date(cur.answered_at).getTime() : null;
        await this.outbox.enqueue(tx, actor.tenantId, 'call.completed', {
          call_id: id, ended_at: now.toISOString(), duration_seconds: Math.max(0, Math.round((now.getTime() - started) / 1000)),
          billable_seconds: answered ? Math.max(0, Math.round((now.getTime() - answered) / 1000)) : 0, hangup_cause: dto.cause ?? 'normal_clearing',
        });
      } else {
        await tx.execute(`UPDATE call_sessions SET status = 'failed', ended_at = UTC_TIMESTAMP(3), hangup_cause = :c WHERE tenant_id = :tenantId AND id = :id`, { id, c: dto.cause ?? (dto.sipCode ? String(dto.sipCode) : 'failed') });
        await this.outbox.enqueue(tx, actor.tenantId, 'call.failed', { call_id: id, reason: dto.cause ?? 'failed', sip_code: dto.sipCode ?? null });
      }
      return { id, status: dto.status };
    });
  }

  listCalls(actor: AuthUser, q: z.infer<typeof callListSchema>) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const rows = await tx.query(
        `SELECT id, status, from_number, to_number, started_at, answered_at, ended_at, duration_seconds, hangup_cause, JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.prefix')) AS prefix, JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.entered')) AS entered
           FROM call_sessions WHERE tenant_id = :tenantId AND user_id = :me AND direction = 'outbound' AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.source')) = 'softphone'
          ORDER BY started_at DESC LIMIT ${q.limit} OFFSET ${q.offset}`, { me: actor.userId });
      return { items: rows.map((r) => ({ id: r.id, status: r.status, from: r.from_number, dialed: r.to_number, entered: r.entered, prefix: r.prefix, startedAt: iso(r.started_at), answeredAt: iso(r.answered_at), endedAt: iso(r.ended_at), durationSeconds: r.duration_seconds, hangupCause: r.hangup_cause })) };
    });
  }

  // ----------------------------------------------------------------
  private async assertUnique(tx: SqlRunner, userId: string, serverId: string, sip: string, exceptId?: string) {
    const x = exceptId ? ' AND id <> :ex' : '';
    const p = { uid: userId, sid: serverId, sip, ...(exceptId ? { ex: exceptId } : {}) };
    const [byUser] = await tx.query(`SELECT id FROM softphone_accounts WHERE tenant_id = :tenantId AND user_id = :uid AND call_server_id = :sid AND deleted_at IS NULL${x}`, p);
    if (byUser) throw new ConflictException('This user already has a SIP account on that call server');
    const [bySip] = await tx.query(`SELECT id FROM softphone_accounts WHERE tenant_id = :tenantId AND call_server_id = :sid AND sip_id = :sip AND deleted_at IS NULL${x}`, p);
    if (bySip) throw new ConflictException('That SIP ID is already used on this call server');
  }

  private async loadAccount(tx: SqlRunner, id: string) {
    const [row] = await tx.query(
      `SELECT ${ACCOUNT_COLS} FROM softphone_accounts a JOIN users u ON u.id = a.user_id AND u.tenant_id = :tenantId JOIN call_servers s ON s.id = a.call_server_id AND s.tenant_id = :tenantId
        WHERE a.tenant_id = :tenantId AND a.id = :id AND a.deleted_at IS NULL`, { id });
    if (!row) throw new NotFoundException('SIP account not found');
    return accountView(row);
  }
}

@ApiTags('softphone')
@ApiBearerAuth()
@Controller({ version: '1' })
export class SoftphoneController {
  constructor(private readonly svc: SoftphoneService) {}

  // admin
  @Get('softphone-accounts') @RequirePermissions('call_servers:manage')
  list(@CurrentUser() u: AuthUser, @Query(new ZodPipe(accountListSchema)) q: z.infer<typeof accountListSchema>) { return this.svc.listAccounts(u, q); }

  @Post('softphone-accounts') @RequirePermissions('call_servers:manage')
  create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(accountCreateSchema)) dto: z.infer<typeof accountCreateSchema>, @ReqContext() c: RequestContext) { return this.svc.createAccount(u, dto, c); }

  @Put('softphone-accounts/:id') @RequirePermissions('call_servers:manage')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(accountUpdateSchema)) dto: z.infer<typeof accountUpdateSchema>, @ReqContext() c: RequestContext) { return this.svc.updateAccount(u, id, dto, c); }

  @Delete('softphone-accounts/:id') @HttpCode(204) @RequirePermissions('call_servers:manage')
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ReqContext() c: RequestContext) { return this.svc.removeAccount(u, id, c); }

  // agent (own account only)
  @Get('softphone/config') @Header('Cache-Control', 'no-store') @Throttle({ default: { limit: 30, ttl: 60_000 } }) @RequirePermissions('calls:make')
  config(@CurrentUser() u: AuthUser, @ReqContext() c: RequestContext) { return this.svc.config(u, c); }

  @Post('softphone/registration') @HttpCode(200) @Throttle({ default: { limit: 60, ttl: 60_000 } }) @RequirePermissions('calls:make')
  registration(@CurrentUser() u: AuthUser, @Body(new ZodPipe(registrationSchema)) dto: z.infer<typeof registrationSchema>) { return this.svc.reportRegistration(u, dto); }

  @Post('softphone/calls') @HttpCode(201) @Throttle({ default: { limit: 60, ttl: 60_000 } }) @RequirePermissions('calls:make')
  place(@CurrentUser() u: AuthUser, @Body(new ZodPipe(callCreateSchema)) dto: z.infer<typeof callCreateSchema>, @ReqContext() c: RequestContext) { return this.svc.placeCall(u, dto, c); }

  @Patch('softphone/calls/:id') @Throttle({ default: { limit: 120, ttl: 60_000 } }) @RequirePermissions('calls:make')
  updateCall(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(callUpdateSchema)) dto: z.infer<typeof callUpdateSchema>) { return this.svc.updateCall(u, id, dto); }

  @Get('softphone/calls') @RequirePermissions('calls:make')
  calls(@CurrentUser() u: AuthUser, @Query(new ZodPipe(callListSchema)) q: z.infer<typeof callListSchema>) { return this.svc.listCalls(u, q); }
}
