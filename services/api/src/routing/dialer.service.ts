import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth/auth.types';
import { currentCorrelationId } from '../common/logging/context';
import { SecretsService } from '../common/crypto/secrets.service';
import { Database, newId, Row, SqlRunner } from '../database/database';
import { OutboxService } from '../events/outbox.service';
import { iso } from '../master-data/common';
import { DEFAULT_DIAL_PLAN } from '../master-data/processes';
import { trunkEndpointName } from '../telephony/pjsip-config';
import { TelephonyAdapter } from '../telephony/telephony-adapter';
import { Candidate, normalizeDestination, operationalReasons, orderCandidates } from './routing';

export const ARI_APP = 'project-dialer';
const ACTIVE = `('initiated','ringing','answered')`;
/** A reservation that never got an outcome (crashed worker) stops counting after this many seconds. */
const RESERVATION_TTL_SECONDS = 120;

export interface PlaceCallInput { processId: string; destination: string; providerId?: string }

@Injectable()
export class DialerService {
  /** Replaceable for deterministic weighted-routing tests. */
  rng: () => number = Math.random;

  constructor(
    private readonly db: Database,
    private readonly adapter: TelephonyAdapter,
    private readonly secrets: SecretsService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  /** Active processes that have at least one caller assignment (id + name only). */
  listProcesses(actor: AuthUser) {
    return this.db.withTenant(actor.tenantId, async (tx) => ({
      items: await tx.query<{ id: string; name: string }>(
        `SELECT p.id, p.name FROM outbound_processes p
          WHERE p.tenant_id = :tenantId AND p.deleted_at IS NULL AND p.status = 'active'
            AND EXISTS (SELECT 1 FROM caller_assignments ca WHERE ca.tenant_id = :tenantId AND ca.process_id = p.id AND ca.status = 'active')
          ORDER BY p.name LIMIT 200`),
    }));
  }

  // ------------------------------------------------------------------ route preview (no reservation, no call)
  async previewRoute(actor: AuthUser, input: PlaceCallInput) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const { process, candidates } = await this.candidates(tx, input);
      const views = candidates.map((c) => {
        const reasons = operationalReasons(c);
        const n = normalizeDestination(input.destination, c.prefix, c.process.dialPlan);
        return {
          provider: c.provider.name, trunk: c.trunk.name || null, did: c.did.did, callServer: c.server.name, prefix: c.prefix,
          dialedNumber: n.ok ? n.dialed : null, operational: reasons.length === 0 && n.ok, reasons: n.ok ? reasons : [...reasons, n.code.toLowerCase()],
        };
      });
      const ordered = orderCandidates(candidates.filter((c) => operationalReasons(c).length === 0), process.strategy, process.defaultProviderId, this.rng);
      const first = ordered.find((c) => normalizeDestination(input.destination, c.prefix, c.process.dialPlan).ok);
      return { process: process.name, strategy: process.strategy, selected: first ? { provider: first.provider.name, trunk: first.trunk.name, did: first.did.did, callServer: first.server.name, prefix: first.prefix } : null, candidates: views };
    });
  }

  // ------------------------------------------------------------------ place call
  async placeCall(actor: AuthUser, input: PlaceCallInput, idempotencyKey: string | undefined, _ctx?: RequestContext) {
    if (idempotencyKey !== undefined && !/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) throw new BadRequestException('Idempotency-Key must be 8-200 characters (letters, digits, . _ : -)');
    if (idempotencyKey) {
      const existing = await this.db.withTenant(actor.tenantId, async (tx) => {
        const [r] = await tx.query<{ id: string }>(`SELECT id FROM call_sessions WHERE tenant_id = :tenantId AND idempotency_key = :k`, { k: idempotencyKey });
        return r ? this.callView(tx, r.id) : null;
      });
      if (existing) return existing;
    }
    const plan = await this.db.withTenant(actor.tenantId, async (tx) => {
      const { process, candidates } = await this.candidates(tx, input);
      if (process.status !== 'active') throw new ConflictException('Process is disabled');
      const operational = candidates.filter((c) => operationalReasons(c).length === 0);
      if (!operational.length) {
        const reasons = [...new Set(candidates.flatMap((c) => operationalReasons(c)))];
        throw new ConflictException(`No operational route for this process${reasons.length ? ` (${reasons.join(', ')})` : ' (no caller assignments - import or assign callers first)'}`);
      }
      const ordered = orderCandidates(operational, process.strategy, process.defaultProviderId, this.rng);
      const usable: { c: Candidate; dialed: string }[] = [];
      let destError: { message: string; code: string } | null = null;
      for (const c of ordered) {
        const n = normalizeDestination(input.destination, c.prefix, c.process.dialPlan);
        if (n.ok) usable.push({ c, dialed: n.dialed });
        else destError = n;
      }
      if (!usable.length) throw new BadRequestException(destError?.message ?? 'Invalid destination');
      return usable;
    });

    const maxAttempts = Math.min(5, plan[0].c.provider.maxAttempts);
    let sessionId: string | null = null;
    let attempts = 0;
    let lastFailure = 'no_attempt';
    let sawConcurrency = false;

    for (const { c, dialed } of plan) {
      if (attempts >= maxAttempts) break;
      const reserved = await this.reserve(actor, c, dialed, sessionId, attempts + 1, idempotencyKey);
      if ('duplicateOf' in reserved) return this.db.withTenant(actor.tenantId, (tx) => this.callView(tx, reserved.duplicateOf));
      if (!reserved.ok) { sawConcurrency = true; lastFailure = reserved.reason; continue; }
      sessionId = reserved.sessionId;
      attempts++;

      const creds = await this.serverCreds(actor.tenantId, c.server.id);
      let result;
      try {
        result = await this.adapter.originate({
          callId: reserved.outboundCallId, appName: ARI_APP, endpoint: `PJSIP/${dialed}@${trunkEndpointName(c.trunk.id)}`, callerId: c.did.callerId, ...creds,
        });
      } catch {
        result = { ok: false as const, code: 'adapter_error', retryable: false, uncertain: true };
      }
      if (result.ok) {
        await this.db.withTenant(actor.tenantId, async (tx) => {
          await tx.execute(`UPDATE outbound_calls SET status = 'ringing', channel_id = :ch WHERE tenant_id = :tenantId AND id = :id`, { id: reserved.outboundCallId, ch: result.channelId });
          await tx.execute(`UPDATE call_sessions SET status = 'ringing' WHERE tenant_id = :tenantId AND id = :id`, { id: reserved.sessionId });
          await this.outbox.enqueue(tx, actor.tenantId, 'call.ringing', { call_id: reserved.sessionId });
        });
        return this.db.withTenant(actor.tenantId, (tx) => this.callView(tx, reserved.sessionId));
      }
      lastFailure = result.code;
      const final = !result.retryable || attempts >= maxAttempts;
      await this.db.withTenant(actor.tenantId, async (tx) => {
        await tx.execute(`UPDATE outbound_calls SET status = :st, failure_code = :code, ended_at = UTC_TIMESTAMP(3) WHERE tenant_id = :tenantId AND id = :id`,
          { id: reserved.outboundCallId, st: result.uncertain ? 'uncertain' : 'failed', code: result.code });
        if (final || result.uncertain) {
          await tx.execute(`UPDATE call_sessions SET status = 'failed', ended_at = UTC_TIMESTAMP(3), hangup_cause = :c WHERE tenant_id = :tenantId AND id = :id`, { id: reserved.sessionId, c: result.code });
          await this.outbox.enqueue(tx, actor.tenantId, 'call.failed', { call_id: reserved.sessionId, reason: result.uncertain ? `uncertain:${result.code}` : result.code, sip_code: result.sipCode ?? null });
        }
      });
      if (result.uncertain) {
        // The PBX may have placed the call. Never retry on another route (duplicate-call risk); report the call as uncertain.
        return this.db.withTenant(actor.tenantId, async (tx) => ({ ...(await this.callView(tx, reserved.sessionId)), warning: 'Outcome uncertain: the call may have been placed. Check the call before retrying.' }));
      }
      if (!result.retryable) break;
    }

    if (!sessionId) {
      if (sawConcurrency) throw new HttpException(`Concurrency limit exceeded (${lastFailure})`, 429);
      throw new ConflictException('No route could be reserved');
    }
    throw new HttpException(`All routes failed (last error: ${lastFailure})`, 502);
  }

  // ------------------------------------------------------------------ hangup
  async hangup(actor: AuthUser, callId: string, ctx: RequestContext) {
    const found = await this.db.withTenant(actor.tenantId, async (tx) => {
      const [row] = await tx.query<{ id: string; status: string; channel_id: string | null; call_server_id: string; user_id: string | null; started_at: Date }>(
        `SELECT oc.id, oc.status, oc.channel_id, oc.call_server_id, cs.user_id, cs.started_at
           FROM outbound_calls oc JOIN call_sessions cs ON cs.id = oc.call_session_id AND cs.tenant_id = :tenantId
          WHERE oc.tenant_id = :tenantId AND oc.call_session_id = :id ORDER BY oc.attempt_no DESC LIMIT 1`, { id: callId });
      if (!row) throw new NotFoundException('Call not found');
      if (row.user_id !== actor.userId && !actor.permissions.has('calls:read_all')) throw new ForbiddenException('You can only hang up your own calls');
      return row;
    });
    if (!['initiated', 'ringing', 'answered'].includes(found.status)) return this.db.withTenant(actor.tenantId, (tx) => this.callView(tx, callId));
    if (found.channel_id) {
      const creds = await this.serverCreds(actor.tenantId, found.call_server_id);
      try {
        await this.adapter.hangup({ ...creds, channelId: found.channel_id });
      } catch {
        throw new HttpException('The call server did not confirm the hangup', 502);
      }
    }
    return this.db.withTenant(actor.tenantId, async (tx) => {
      await tx.execute(`UPDATE outbound_calls SET status = 'completed', ended_at = UTC_TIMESTAMP(3) WHERE tenant_id = :tenantId AND id = :id`, { id: found.id });
      await tx.execute(`UPDATE call_sessions SET status = 'completed', ended_at = UTC_TIMESTAMP(3), hangup_cause = 'api_hangup' WHERE tenant_id = :tenantId AND id = :id`, { id: callId });
      const seconds = Math.max(0, Math.round((Date.now() - found.started_at.getTime()) / 1000));
      await this.outbox.enqueue(tx, actor.tenantId, 'call.completed', { call_id: callId, ended_at: new Date().toISOString(), duration_seconds: seconds, billable_seconds: 0, hangup_cause: 'api_hangup' });
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'call.hangup', entityType: 'call', entityId: callId }, ctx);
      return this.callView(tx, callId);
    });
  }

  // ------------------------------------------------------------------ reads
  getCall(actor: AuthUser, id: string) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const v = await this.callView(tx, id);
      if (v.userId !== actor.userId && !actor.permissions.has('calls:read_all')) throw new NotFoundException('Call not found');
      return v;
    });
  }

  listCalls(actor: AuthUser, q: { limit: number; offset: number; processId?: string }) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const p: Record<string, unknown> = { me: actor.userId };
      let where = actor.permissions.has('calls:read_all') ? '' : ' AND cs.user_id = :me';
      if (q.processId) { p.pid = q.processId; where += ' AND oc.process_id = :pid'; }
      const rows = await tx.query(
        `${CALL_SELECT} WHERE cs.tenant_id = :tenantId AND oc.attempt_no = (SELECT MAX(x.attempt_no) FROM outbound_calls x WHERE x.tenant_id = :tenantId AND x.call_session_id = cs.id)${where}
          ORDER BY cs.started_at DESC LIMIT ${q.limit} OFFSET ${q.offset}`, p);
      const [{ n }] = await tx.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM call_sessions cs JOIN outbound_calls oc ON oc.call_session_id = cs.id AND oc.tenant_id = :tenantId
          WHERE cs.tenant_id = :tenantId AND oc.attempt_no = (SELECT MAX(x.attempt_no) FROM outbound_calls x WHERE x.tenant_id = :tenantId AND x.call_session_id = cs.id)${where}`, p);
      return { items: rows.map((r) => this.toView(r, [])), total: Number(n), limit: q.limit, offset: q.offset };
    });
  }

  /** Per-process and per-provider call outcome counts since `days` ago. */
  stats(actor: AuthUser, days: number) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const since = new Date(Date.now() - days * 86_400_000);
      const byProcess = await tx.query(
        `SELECT p.id, p.name, oc.status, COUNT(*) AS n FROM outbound_calls oc JOIN outbound_processes p ON p.id = oc.process_id AND p.tenant_id = :tenantId
          WHERE oc.tenant_id = :tenantId AND oc.started_at >= :since GROUP BY p.id, p.name, oc.status`, { since });
      const byProvider = await tx.query(
        `SELECT sp.id, sp.name, oc.status, COUNT(*) AS n FROM outbound_calls oc JOIN service_providers sp ON sp.id = oc.service_provider_id AND sp.tenant_id = :tenantId
          WHERE oc.tenant_id = :tenantId AND oc.started_at >= :since GROUP BY sp.id, sp.name, oc.status`, { since });
      const fold = (rows: Row[]) => {
        const m = new Map<string, { id: string; name: string; total: number; byStatus: Record<string, number> }>();
        for (const r of rows) {
          const e = m.get(r.id) ?? { id: r.id as string, name: r.name as string, total: 0, byStatus: {} as Record<string, number> };
          e.byStatus[r.status] = Number(r.n);
          e.total += Number(r.n);
          m.set(r.id, e);
        }
        return [...m.values()].sort((a, b) => b.total - a.total);
      };
      return { sinceDays: days, byProcess: fold(byProcess), byProvider: fold(byProvider) };
    });
  }

  // ------------------------------------------------------------------ internals
  /** Loads every (assignment x trunk) candidate for a process, tenant-scoped, without credentials. */
  private async candidates(tx: SqlRunner, input: PlaceCallInput): Promise<{ process: Candidate['process']; candidates: Candidate[] }> {
    const [proc] = await tx.query<Row>(
      `SELECT id, name, status, routing_strategy, dial_plan, max_concurrent_calls, default_service_provider_id FROM outbound_processes WHERE tenant_id = :tenantId AND id = :id AND deleted_at IS NULL`, { id: input.processId });
    if (!proc) throw new NotFoundException('Process not found');
    const process: Candidate['process'] = {
      id: proc.id, name: proc.name, status: proc.status, strategy: proc.routing_strategy, dialPlan: { ...DEFAULT_DIAL_PLAN, ...(proc.dial_plan ?? {}) },
      maxConcurrent: proc.max_concurrent_calls, defaultProviderId: proc.default_service_provider_id,
    };
    if (process.strategy === 'manual' && !input.providerId) throw new BadRequestException('This process uses manual routing: providerId is required');
    const rows = await tx.query<Row>(
      `SELECT ca.id AS assignment_id, ca.status AS assignment_status, ca.prefix,
              sp.id AS sp_id, sp.name AS sp_name, sp.status AS sp_status, sp.priority AS sp_priority, sp.weight AS sp_weight, sp.max_concurrent_calls AS sp_max, sp.retry_policy,
              d.id AS d_id, d.did, d.caller_id, d.status AS d_status, d.verification_status AS d_ver, d.max_concurrent_calls AS d_max, d.trunk_id AS d_trunk,
              s.id AS s_id, s.name AS s_name, s.status AS s_status, s.connection_status AS s_conn, s.ari_url, s.ari_username, s.ari_secret_encrypted IS NOT NULL AS s_secret, s.max_concurrent_calls AS s_max
         FROM caller_assignments ca
         JOIN service_providers sp ON sp.id = ca.service_provider_id AND sp.tenant_id = :tenantId AND sp.deleted_at IS NULL
         JOIN provider_dids d ON d.id = ca.did_id AND d.tenant_id = :tenantId AND d.deleted_at IS NULL
         JOIN call_servers s ON s.id = ca.call_server_id AND s.tenant_id = :tenantId AND s.deleted_at IS NULL
        WHERE ca.tenant_id = :tenantId AND ca.process_id = :pid ${input.providerId ? 'AND ca.service_provider_id = :prov' : ''}`,
      { pid: input.processId, ...(input.providerId ? { prov: input.providerId } : {}) });
    const providerIds = [...new Set(rows.map((r) => r.sp_id))];
    const trunks = providerIds.length
      ? await tx.query<Row>(
          `SELECT id, service_provider_id, name, status, verification_status, health_status, circuit_state, priority, weight, max_concurrent_calls FROM tenant_sip_providers
            WHERE tenant_id = :tenantId AND deleted_at IS NULL AND service_provider_id IN (:ids)`, { ids: providerIds })
      : [];
    const out: Candidate[] = [];
    for (const r of rows) {
      const mine = r.d_trunk ? trunks.filter((t) => t.id === r.d_trunk) : trunks.filter((t) => t.service_provider_id === r.sp_id);
      for (const t of mine.length ? mine : [null]) {
        out.push({
          assignmentId: r.assignment_id, assignmentStatus: r.assignment_status, prefix: r.prefix, process,
          provider: { id: r.sp_id, name: r.sp_name, status: r.sp_status, priority: r.sp_priority, weight: r.sp_weight, max: r.sp_max, maxAttempts: r.retry_policy?.maxAttempts ?? 2 },
          trunk: t
            ? { id: t.id, name: t.name, status: t.status, verification: t.verification_status, health: t.health_status, circuit: t.circuit_state, priority: t.priority, weight: t.weight, max: t.max_concurrent_calls }
            : { id: '', name: '', status: 'missing', verification: 'pending', health: 'unknown', circuit: 'closed', priority: 0, weight: 0, max: 0 },
          did: { id: r.d_id, did: r.did, callerId: r.caller_id ?? r.did, status: r.d_status, verification: r.d_ver, max: r.d_max },
          server: { id: r.s_id, name: r.s_name, status: r.s_status, connection: r.s_conn, ariUrl: r.ari_url, ariUsername: r.ari_username, hasSecret: !!r.s_secret, max: r.s_max },
        });
      }
    }
    return { process, candidates: out };
  }

  /**
   * Atomically checks every concurrency limit and records the reservation. Row locks are taken in a fixed order
   * (provider, trunk, DID, server, process) so concurrent reservations serialise instead of racing or deadlocking.
   */
  private async reserve(actor: AuthUser, c: Candidate, dialed: string, sessionId: string | null, attempt: number, idempotencyKey?: string):
    Promise<{ ok: true; sessionId: string; outboundCallId: string } | { ok: false; reason: string } | { duplicateOf: string }> {
    // Concurrent reservations can deadlock on foreign-key/unique-index locks (TiDB: 1213, write conflict 9007): retry the whole transaction.
    for (let attemptNo = 1; ; attemptNo++) {
      try {
        return await this.reserveOnce(actor, c, dialed, sessionId, attempt, idempotencyKey);
      } catch (e) {
        const errno = (e as { errno?: number }).errno;
        if (attemptNo >= 6 || ![1213, 9007, 8022].includes(errno ?? 0)) throw e;
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 80 * attemptNo));
      }
    }
  }

  private async reserveOnce(actor: AuthUser, c: Candidate, dialed: string, sessionId: string | null, attempt: number, idempotencyKey?: string):
    Promise<{ ok: true; sessionId: string; outboundCallId: string } | { ok: false; reason: string } | { duplicateOf: string }> {
    try {
      return await this.db.withTenant(actor.tenantId, async (tx) => {
        for (const [table, id] of [['service_providers', c.provider.id], ['tenant_sip_providers', c.trunk.id], ['provider_dids', c.did.id], ['call_servers', c.server.id], ['outbound_processes', c.process.id]] as const) {
          await tx.query(`SELECT id FROM ${table} WHERE tenant_id = :tenantId AND id = :lockId FOR UPDATE`, { lockId: id });
        }
        const [n] = await tx.query<Row>(
          `SELECT COALESCE(SUM(service_provider_id = :sp), 0) AS prov, COALESCE(SUM(trunk_id = :tr), 0) AS trunk, COALESCE(SUM(did_id = :d), 0) AS did,
                  COALESCE(SUM(call_server_id = :s), 0) AS srv, COALESCE(SUM(process_id = :p), 0) AS proc
             FROM outbound_calls
            WHERE tenant_id = :tenantId AND status IN ${ACTIVE} AND (status <> 'initiated' OR started_at > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ${RESERVATION_TTL_SECONDS} SECOND))
              AND (service_provider_id = :sp OR trunk_id = :tr OR did_id = :d OR call_server_id = :s OR process_id = :p)
            FOR UPDATE`, // locking read: sees reservations committed by transactions we waited on (a plain read uses the txn start snapshot)
          { sp: c.provider.id, tr: c.trunk.id, d: c.did.id, s: c.server.id, p: c.process.id });
        const limits: [string, number, number][] = [
          ['provider', Number(n.prov), c.provider.max], ['trunk', Number(n.trunk), c.trunk.max], ['did', Number(n.did), c.did.max],
          ['call_server', Number(n.srv), c.server.max], ['process', Number(n.proc), c.process.maxConcurrent],
        ];
        const hit = limits.find(([, used, max]) => used >= max);
        if (hit) return { ok: false as const, reason: `${hit[0]} limit ${hit[2]} reached` };

        let sid = sessionId;
        if (!sid) {
          sid = newId();
          await tx.execute(
            `INSERT INTO call_sessions (id, tenant_id, direction, status, from_number, to_number, user_id, tenant_sip_provider_id, idempotency_key, correlation_id)
             VALUES (:id, :tenantId, 'outbound', 'created', :from, :to, :user, :trunk, :idem, :corr)`,
            { id: sid, from: c.did.callerId, to: dialed, user: actor.userId, trunk: c.trunk.id, idem: idempotencyKey ?? null, corr: currentCorrelationId() });
          await this.outbox.enqueue(tx, actor.tenantId, 'call.created', { call_id: sid, direction: 'outbound', from: c.did.callerId.slice(0, 32), to: dialed.slice(0, 32), user_id: actor.userId, campaign_id: null, queue_id: null });
        } else {
          await tx.execute(`UPDATE call_sessions SET tenant_sip_provider_id = :trunk, from_number = :from WHERE tenant_id = :tenantId AND id = :id`, { id: sid, trunk: c.trunk.id, from: c.did.callerId });
        }
        const ocId = newId();
        await tx.execute(
          `INSERT INTO outbound_calls (id, tenant_id, call_session_id, process_id, service_provider_id, trunk_id, did_id, call_server_id, caller_assignment_id, dialed_number, caller_id, attempt_no, created_by)
           VALUES (:id, :tenantId, :sid, :p, :sp, :tr, :d, :s, :ca, :dialed, :cid, :att, :by)`,
          { id: ocId, sid, p: c.process.id, sp: c.provider.id, tr: c.trunk.id, d: c.did.id, s: c.server.id, ca: c.assignmentId, dialed, cid: c.did.callerId, att: attempt, by: actor.userId });
        return { ok: true as const, sessionId: sid, outboundCallId: ocId };
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'ER_DUP_ENTRY' && idempotencyKey && !sessionId) {
        const dup = await this.db.withTenant(actor.tenantId, (tx) => tx.query<{ id: string }>(`SELECT id FROM call_sessions WHERE tenant_id = :tenantId AND idempotency_key = :k`, { k: idempotencyKey }));
        if (dup[0]) return { duplicateOf: dup[0].id };
      }
      throw e;
    }
  }

  private async serverCreds(tenantId: string, serverId: string) {
    const [r] = await this.db.withTenant(tenantId, (tx) =>
      tx.query<{ ari_url: string; ari_username: string; ari_secret_encrypted: string }>(`SELECT ari_url, ari_username, ari_secret_encrypted FROM call_servers WHERE tenant_id = :tenantId AND id = :id`, { id: serverId }));
    if (!r?.ari_url || !r.ari_username || !r.ari_secret_encrypted) throw new ConflictException('Call server is not configured');
    return { ariUrl: r.ari_url, ariUsername: r.ari_username, ariPassword: this.secrets.decrypt(r.ari_secret_encrypted) };
  }

  private async callView(tx: SqlRunner, id: string) {
    const rows = await tx.query(`${CALL_SELECT} WHERE cs.tenant_id = :tenantId AND cs.id = :id ORDER BY oc.attempt_no`, { id });
    if (!rows.length) throw new NotFoundException('Call not found');
    return this.toView(rows[rows.length - 1], rows);
  }

  private toView(r: Row, attempts: Row[]) {
    return {
      id: r.id, status: r.status, direction: 'outbound', userId: r.user_id, destination: r.dialed_number, callerId: r.caller_id, startedAt: iso(r.started_at), endedAt: iso(r.ended_at),
      route: { process: r.process_name, provider: r.provider_name, trunk: r.trunk_name, did: r.did, prefix: r.prefix, callServer: r.server_name },
      attempts: attempts.map((a) => ({ attempt: a.attempt_no, provider: a.provider_name, callServer: a.server_name, status: a.oc_status, failureCode: a.failure_code })),
    };
  }
}

const CALL_SELECT = `
  SELECT cs.id, cs.status, cs.user_id, cs.started_at, cs.ended_at, oc.attempt_no, oc.status AS oc_status, oc.failure_code, oc.dialed_number, oc.caller_id,
         p.name AS process_name, sp.name AS provider_name, t.name AS trunk_name, d.did, s.name AS server_name, ca.prefix
    FROM call_sessions cs
    JOIN outbound_calls oc ON oc.call_session_id = cs.id AND oc.tenant_id = :tenantId
    JOIN outbound_processes p ON p.id = oc.process_id AND p.tenant_id = :tenantId
    JOIN service_providers sp ON sp.id = oc.service_provider_id AND sp.tenant_id = :tenantId
    JOIN tenant_sip_providers t ON t.id = oc.trunk_id AND t.tenant_id = :tenantId
    JOIN provider_dids d ON d.id = oc.did_id AND d.tenant_id = :tenantId
    JOIN call_servers s ON s.id = oc.call_server_id AND s.tenant_id = :tenantId
    JOIN caller_assignments ca ON ca.id = oc.caller_assignment_id AND ca.tenant_id = :tenantId`;
