import { Inject } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/env';
import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Header, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { ImportFileError, MAX_FILE_BYTES, XLSX_MIME } from '../caller-import/excel-format';
import { ACCOUNT_TEMPLATE_FILENAME, AccountRow, buildAccountTemplate, parseAccountWorkbook } from './account-import';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth/auth.types';
import { CurrentUser, ReqContext, RequirePermissions } from '../common/auth/decorators';
import { SecretsService } from '../common/crypto/secrets.service';
import { Database, newId, Row, SqlRunner } from '../database/database';
import { OutboxService } from '../events/outbox.service';
import { iso, uuidSchema, z, ZodPipe } from '../master-data/common';
import { webrtcUrl, connectionMode } from '../master-data/call-servers';
import { DEFAULT_DIAL_PLAN } from '../master-data/processes';
import { normalizeDestination } from '../routing/routing';
import { classifyOutcome } from './call-outcome';
import { turnRestCredential } from './turn';

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
const importQuerySchema = z.object({ dryRun: z.enum(['true', 'false']).default('true') }).strict();
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
  constructor(private readonly db: Database, private readonly audit: AuditService, private readonly secrets: SecretsService, private readonly outbox: OutboxService, @Inject(APP_CONFIG) private readonly appConfig: AppConfig) {}

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

  /**
   * Bulk agent <-> SIP account mapping from an .xlsx. A dry run only reports what each row would do. Otherwise every valid row is created
   * and the others are reported. Existing links are never changed, and passwords are never part of the answer or the audit log.
   */
  async importAccounts(actor: AuthUser, buf: Buffer, dryRun: boolean, ctx: RequestContext) {
    let rows: AccountRow[];
    try { rows = await parseAccountWorkbook(buf); } catch (e) { if (e instanceof ImportFileError) throw new BadRequestException({ code: e.code, message: e.message }); throw e; }
    try {
      return await this.db.withTenant(actor.tenantId, async (tx) => {
        // a few set queries instead of several per row: the whole request has to fit the serverless time limit
        const users = await tx.query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE tenant_id = :tenantId AND deleted_at IS NULL AND status = 'active' AND LOWER(email) IN (:emails)`, { emails: [...new Set(rows.map((r) => r.email))] });
        const servers = await tx.query<{ id: string; name: string }>(`SELECT id, name FROM call_servers WHERE tenant_id = :tenantId AND deleted_at IS NULL`);
        const existing = await tx.query<{ user_id: string; call_server_id: string; sip_id: string }>(`SELECT user_id, call_server_id, sip_id FROM softphone_accounts WHERE tenant_id = :tenantId AND deleted_at IS NULL FOR UPDATE`);
        const userByEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));
        const serverByName = new Map(servers.map((x) => [x.name.toLowerCase(), x.id]));
        const byUser = new Map(existing.map((a) => [`${a.user_id}|${a.call_server_id}`, a.sip_id.toLowerCase()]));
        const bySip = new Set(existing.map((a) => `${a.call_server_id}|${a.sip_id.toLowerCase()}`));
        const fileUsers = new Map<string, number>();
        const fileSips = new Map<string, number>();
        const create: { id: string; userId: string; serverId: string; r: AccountRow }[] = [];
        const results = rows.map((r) => {
          const out = (status: 'create' | 'unchanged' | 'error', message?: string) => ({ row: r.row, agentEmail: r.email, callServer: r.server, sipId: r.sipId, status, message });
          if (r.error) return out('error', r.error);
          const userId = userByEmail.get(r.email);
          if (!userId) return out('error', 'No active user has this email');
          const serverId = serverByName.get(r.server.toLowerCase());
          if (!serverId) return out('error', 'No call server has this name');
          if (!sipId.safeParse(r.sipId).success) return out('error', 'SIP ID is missing or has characters that are not allowed (letters, digits and . _ @ + - only)');
          if (!sipSecret.safeParse(r.password).success) return out('error', 'SIP password is missing or too long');
          if (r.displayName.length > 100) return out('error', 'Display name is longer than 100 characters');
          const userKey = `${userId}|${serverId}`;
          const sipKey = `${serverId}|${r.sipId.toLowerCase()}`;
          const mine = byUser.get(userKey);
          if (mine === r.sipId.toLowerCase()) return out('unchanged', 'Already linked; nothing is changed (the password in the file is ignored)');
          if (mine !== undefined) return out('error', 'This agent already has a SIP account on that call server; edit or remove it first');
          if (bySip.has(sipKey)) return out('error', 'This SIP ID is already linked to another agent on that call server');
          const userRow = fileUsers.get(userKey);
          if (userRow) return out('error', `Row ${userRow} already links this agent on that call server`);
          const sipRow = fileSips.get(sipKey);
          if (sipRow) return out('error', `Row ${sipRow} already uses this SIP ID on that call server`);
          fileUsers.set(userKey, r.row);
          fileSips.set(sipKey, r.row);
          create.push({ id: newId(), userId, serverId, r });
          return out('create');
        });
        if (!dryRun && create.length) {
          for (let i = 0; i < create.length; i += 100) {
            const p: Record<string, unknown> = { by: actor.userId };
            const values = create.slice(i, i + 100).map((c, j) => {
              Object.assign(p, { [`i${j}`]: c.id, [`u${j}`]: c.userId, [`s${j}`]: c.serverId, [`d${j}`]: c.r.sipId, [`n${j}`]: c.r.displayName || null, [`x${j}`]: this.secrets.encrypt(c.r.password) });
              return `(:i${j}, :tenantId, :u${j}, :s${j}, :d${j}, :n${j}, :x${j}, :by)`;
            });
            await tx.execute(`INSERT INTO softphone_accounts (id, tenant_id, user_id, call_server_id, sip_id, display_name, sip_secret_encrypted, created_by) VALUES ${values.join(', ')}`, p);
          }
          await this.audit.log(tx, { actorUserId: actor.userId, action: 'softphone_account.imported', entityType: 'softphone_account', metadata: { created: create.length, accountIds: create.map((c) => c.id) } }, ctx);
        }
        const count = (status: string) => results.filter((x) => x.status === status).length;
        return { dryRun, total: rows.length, toCreate: create.length, created: dryRun ? 0 : create.length, unchanged: count('unchanged'), invalid: count('error'), results };
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'ER_DUP_ENTRY') throw new ConflictException('SIP accounts changed while importing. Nothing was imported: check the file again.');
      throw e;
    }
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
      // A deactivated account is no longer handed to the softphone, which unregisters on its next check: show it as unregistered right away.
      if (dto.status === 'disabled') sets.push(`registration_status = 'unregistered'`, 'last_error = NULL');
      else if (dto.sipId !== undefined || dto.password) sets.push(`registration_status = 'unknown'`, 'last_error = NULL');
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

  /**
   * Cheap check the softphone polls every few seconds: which of the caller's accounts are usable right now (account active AND its call server active).
   * No secrets, no audit row. When a server is disabled its accounts disappear from this list and the softphone unregisters, so no inbound call reaches the agent.
   */
  activeAccountIds(actor: AuthUser) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const rows = await tx.query<{ id: string }>(
        `SELECT a.id FROM softphone_accounts a JOIN call_servers s ON s.id = a.call_server_id AND s.tenant_id = :tenantId AND s.record_status = 1 AND s.status = 'active'
          WHERE a.tenant_id = :tenantId AND a.user_id = :me AND a.record_status = 1 AND a.status = 'active'`, { me: actor.userId });
      return { accountIds: rows.map((r) => r.id) };
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
            id: r.server_id, name: r.server_name, host: r.host, port: r.port ?? (r.sip_transport === 'udp' || r.sip_transport === 'tcp' ? 5060 : r.sip_transport === 'tls' ? 5061 : null), transport: r.sip_transport, wsPath: r.sip_ws_path, realm: r.sip_realm || r.host,
            webrtcUrl: webrtcUrl(r.host, r.port, r.sip_transport, r.sip_ws_path), addressUpdatedAt: iso(r.address_updated_at),
            connectionMode: connectionMode(r.sip_transport),
          },
        })),
        dialOptions,
        fetchedAt: new Date().toISOString(),
        ringTimeoutSeconds: this.appConfig.ringTimeoutSeconds,
        iceServers: this.iceServers(actor.userId),
      };
    });
  }

  /** STUN always; TURN only when configured (relay for agents behind strict NAT / firewalls). TURN credentials are only ever sent to a signed-in agent (short-lived when WEBRTC_TURN_SECRET is set). */
  private iceServers(userId: string) {
    const w = this.appConfig.webrtc;
    const out: { urls: string[]; username?: string; credential?: string }[] = [];
    if (w.stunUrls.length) out.push({ urls: w.stunUrls });
    if (w.turnUrls.length && w.turnSecret) {
      // only short-lived credentials derived from the shared secret (coturn use-auth-secret) ever reach a browser; loadConfig refuses TURN urls without the secret
      out.push({ urls: w.turnUrls, ...turnRestCredential(w.turnSecret, userId, Date.now(), w.turnTtlSeconds) });
    }
    return out;
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
      return this.placeInTx(tx, actor, acct, dto.destination, prefix, plan, process, ctx, {});
    });
  }

  /** Normalises (prefix etc.), writes the call_sessions row + call.created. Shared by manual dialing and call-list rows. */
  async placeInTx(tx: SqlRunner, actor: AuthUser, acct: Row, destination: string, prefix: string, plan: typeof DEFAULT_DIAL_PLAN, process: { id: string | null; name: string } | null, ctx: RequestContext, extraMeta: Record<string, unknown>) {
    {
      const dto = { destination };
      const n = normalizeDestination(dto.destination, prefix, plan);
      if (!n.ok) throw new BadRequestException({ code: n.code, message: n.message });
      const id = newId();
      await tx.execute(
        `INSERT INTO call_sessions (id, tenant_id, direction, status, from_number, to_number, user_id, correlation_id, metadata)
         VALUES (:id, :tenantId, 'outbound', 'initiated', :from, :to, :me, :cid, :meta)`,
        { id, from: acct.sip_id.slice(0, 32), to: n.dialed.slice(0, 32), me: actor.userId, cid: ctx.correlationId ?? null,
          meta: JSON.stringify({ source: 'softphone', accountId: acct.id, callServerId: acct.server_id, prefix, entered: dto.destination.slice(0, 32), process, ...extraMeta }) });
      await this.outbox.enqueue(tx, actor.tenantId, 'call.created', { call_id: id, direction: 'outbound', from: acct.sip_id.slice(0, 32), to: n.dialed.slice(0, 32), user_id: actor.userId, campaign_id: null, queue_id: null });
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'softphone.call_placed', entityType: 'call_session', entityId: id, metadata: { prefix, processId: process?.id ?? null } }, ctx);
      return { callId: id, dialed: n.dialed, prefix, target: `sip:${n.dialed}@${acct.sip_realm || acct.host}` };
    }
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
      let outcome: ReturnType<typeof classifyOutcome> | null = null;
      if (dto.status === 'completed' || dto.status === 'failed') {
        // Same business rule as the Excel call lists: Success when the called phone was reached (answered, rang, busy, declined, hung up), Not success when it never rang.
        const answered = !!cur.answered_at;
        const seconds = answered ? Math.max(0, Math.round((now.getTime() - new Date(cur.answered_at).getTime()) / 1000)) : 0;
        outcome = classifyOutcome({ final: dto.status, answered, rang: answered || cur.status === 'ringing', cause: dto.cause, sipCode: dto.sipCode, seconds });
        await tx.execute(`UPDATE call_sessions SET metadata = JSON_SET(COALESCE(metadata, JSON_OBJECT()), '$.outcome', JSON_OBJECT('status', :os, 'note', :on)) WHERE tenant_id = :tenantId AND id = :id`,
          { id, os: outcome.status, on: outcome.note.slice(0, 300) });
      }
      await this.syncListItem(tx, id, dto);
      return { id, status: dto.status, ...(outcome ? { outcome } : {}) };
    });
  }

  /** Keeps the Excel call-list row in step with the call (live status for the UI and the Excel export). */
  private async syncListItem(tx: SqlRunner, callId: string, dto: z.infer<typeof callUpdateSchema>) {
    const base = `UPDATE call_list_items SET`;
    const where = `WHERE tenant_id = :tenantId AND record_status = 1 AND call_session_id = :cid`;
    const p = { cid: callId, cause: dto.cause ? dto.cause.slice(0, 300) : null };
    if (dto.status === 'ringing') await tx.execute(`${base} status = 'ringing' ${where}`, p);
    else if (dto.status === 'answered') await tx.execute(`${base} status = 'answered', answered_at = UTC_TIMESTAMP(3), result = 'Call answered' ${where}`, p);
    else {
      // final outcome: Success (the phone was reached) or Not success (it never rang), with a note saying what the user did / why it did not connect
      const [cur] = await tx.query<{ status: string; answered_at: Date | null }>(`SELECT status, answered_at FROM call_list_items ${where} FOR UPDATE`, { cid: callId });
      if (!cur) return;
      const answered = !!cur.answered_at;
      const seconds = answered ? Math.max(0, Math.round((Date.now() - new Date(cur.answered_at as Date).getTime()) / 1000)) : 0;
      const outcome = classifyOutcome({ final: dto.status === 'completed' ? 'completed' : 'failed', answered, rang: answered || cur.status === 'ringing', cause: dto.cause, sipCode: dto.sipCode, seconds });
      await tx.execute(`${base} ended_at = UTC_TIMESTAMP(3), status = :st, result = :note, sip_code = :code, duration_seconds = :dur ${where}`,
        { cid: callId, st: outcome.status, note: outcome.note.slice(0, 300), code: dto.sipCode ?? null, dur: answered ? seconds : 0 });
    }
  }

  listCalls(actor: AuthUser, q: z.infer<typeof callListSchema>) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const rows = await tx.query(
        `SELECT id, status, from_number, to_number, started_at, answered_at, ended_at, duration_seconds, hangup_cause, JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.prefix')) AS prefix, JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.process.name')) AS process_name, JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.entered')) AS entered,
                JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.outcome.status')) AS outcome_status, JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.outcome.note')) AS outcome_note
           FROM call_sessions WHERE tenant_id = :tenantId AND user_id = :me AND direction = 'outbound' AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.source')) = 'softphone'
          ORDER BY started_at DESC LIMIT ${q.limit} OFFSET ${q.offset}`, { me: actor.userId });
      return { items: rows.map((r) => ({ id: r.id, status: r.status, from: r.from_number, dialed: r.to_number, entered: r.entered, prefix: r.prefix, processName: r.process_name, startedAt: iso(r.started_at), answeredAt: iso(r.answered_at), endedAt: iso(r.ended_at), durationSeconds: r.duration_seconds, hangupCause: r.hangup_cause, outcome: r.outcome_status ? { status: r.outcome_status, note: r.outcome_note ?? '' } : null })) };
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

  @Get('softphone-accounts/import-template') @RequirePermissions('call_servers:manage')
  async importTemplate(@Res({ passthrough: true }) res: Response) {
    res.set({ 'Content-Type': XLSX_MIME, 'Content-Disposition': `attachment; filename="${ACCOUNT_TEMPLATE_FILENAME}"`, 'Cache-Control': 'no-store' });
    return new StreamableFile(await buildAccountTemplate());
  }

  @Post('softphone-accounts/import') @HttpCode(200) @Throttle({ default: { limit: 20, ttl: 60_000 } }) @RequirePermissions('call_servers:manage')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 5, parts: 8 } }))
  importAccounts(@CurrentUser() u: AuthUser, @UploadedFile() file: Express.Multer.File | undefined, @Query(new ZodPipe(importQuerySchema)) q: z.infer<typeof importQuerySchema>, @ReqContext() c: RequestContext) {
    if (!file) throw new BadRequestException('Attach the Excel file in the "file" form field.');
    return this.svc.importAccounts(u, file.buffer, q.dryRun === 'true', c);
  }

  @Put('softphone-accounts/:id') @RequirePermissions('call_servers:manage')
  update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(accountUpdateSchema)) dto: z.infer<typeof accountUpdateSchema>, @ReqContext() c: RequestContext) { return this.svc.updateAccount(u, id, dto, c); }

  @Delete('softphone-accounts/:id') @HttpCode(204) @RequirePermissions('call_servers:manage')
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ReqContext() c: RequestContext) { return this.svc.removeAccount(u, id, c); }

  // agent (own account only)
  @Get('softphone/config') @Header('Cache-Control', 'no-store') @Throttle({ default: { limit: 30, ttl: 60_000 } }) @RequirePermissions('calls:make')
  config(@CurrentUser() u: AuthUser, @ReqContext() c: RequestContext) { return this.svc.config(u, c); }

  @Get('softphone/active') @Header('Cache-Control', 'no-store') @Throttle({ default: { limit: 60, ttl: 60_000 } }) @RequirePermissions('calls:make')
  active(@CurrentUser() u: AuthUser) { return this.svc.activeAccountIds(u); }

  @Post('softphone/registration') @HttpCode(200) @Throttle({ default: { limit: 60, ttl: 60_000 } }) @RequirePermissions('calls:make')
  registration(@CurrentUser() u: AuthUser, @Body(new ZodPipe(registrationSchema)) dto: z.infer<typeof registrationSchema>) { return this.svc.reportRegistration(u, dto); }

  @Post('softphone/calls') @HttpCode(201) @Throttle({ default: { limit: 60, ttl: 60_000 } }) @RequirePermissions('calls:make')
  place(@CurrentUser() u: AuthUser, @Body(new ZodPipe(callCreateSchema)) dto: z.infer<typeof callCreateSchema>, @ReqContext() c: RequestContext) { return this.svc.placeCall(u, dto, c); }

  @Patch('softphone/calls/:id') @Throttle({ default: { limit: 120, ttl: 60_000 } }) @RequirePermissions('calls:make')
  updateCall(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(callUpdateSchema)) dto: z.infer<typeof callUpdateSchema>) { return this.svc.updateCall(u, id, dto); }

  @Get('softphone/calls') @RequirePermissions('calls:make')
  calls(@CurrentUser() u: AuthUser, @Query(new ZodPipe(callListSchema)) q: z.infer<typeof callListSchema>) { return this.svc.listCalls(u, q); }
}
