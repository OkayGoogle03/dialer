import { Controller, ForbiddenException, Get, Injectable, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../common/auth/auth.types';
import { CurrentUser } from '../common/auth/decorators';
import { Database, Row } from '../database/database';
import { iso, likePattern, z, ZodPipe } from '../master-data/common';

const day = z.string().datetime({ offset: true });
export const historyQuerySchema = z.object({
  tab: z.enum(['all', 'received', 'dialled']).default('all'),
  search: z.string().trim().max(60).optional(),
  from: day.optional(), // the page sends the start / end of the chosen days in the viewer's own time zone
  to: day.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
}).strict();
type HistoryQuery = z.infer<typeof historyQuerySchema>;

const TERMINAL = new Set(['completed', 'failed']);
/** A call with no final report after this long was cut off without one (page closed, connection lost). */
const STALE_MS = 2 * 60 * 60_000;

export type ResultKind = 'answered' | 'missed' | 'rejected' | 'no_answer' | 'not_connected' | 'in_progress' | 'unknown';

/** One word for how a call went, for either direction. */
export function resultKind(c: { direction: string; status: string; answered: boolean; cause: string | null; outcome: string | null; ageMs: number }): ResultKind {
  if (c.answered) return 'answered';
  if (!TERMINAL.has(c.status)) return c.ageMs > STALE_MS ? 'unknown' : 'in_progress';
  if (c.direction === 'inbound') return /reject/i.test(c.cause ?? '') ? 'rejected' : 'missed';
  return c.outcome === 'success' ? 'no_answer' : 'not_connected';
}

const seconds = (a: unknown, b: unknown) => (a && b ? Math.max(0, Math.round((new Date(b as string).getTime() - new Date(a as string).getTime()) / 1000)) : null);
const json = (v: unknown) => ((typeof v === 'string' ? JSON.parse(v) : v) ?? {}) as Record<string, any>;

@Injectable()
export class CallHistoryService {
  constructor(private readonly db: Database) {}

  /** Agents see their own calls; people allowed to read all calls see everyone's. */
  list(actor: AuthUser, q: HistoryQuery) {
    const everyone = actor.permissions.has('calls:read_all');
    if (!everyone && !actor.permissions.has('calls:make')) throw new ForbiddenException('Missing permission: calls:make');
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const p: Record<string, unknown> = {};
      let where = ` AND JSON_UNQUOTE(JSON_EXTRACT(c.metadata, '$.source')) = 'softphone'`;
      if (!everyone) { where += ' AND c.user_id = :me'; p.me = actor.userId; }
      if (q.from) { where += ' AND c.started_at >= :from'; p.from = new Date(q.from); }
      if (q.to) { where += ' AND c.started_at <= :to'; p.to = new Date(q.to); }
      if (q.search) {
        where += ` AND (LOWER(CONCAT_WS(' ', c.from_number, c.to_number, JSON_UNQUOTE(JSON_EXTRACT(c.metadata, '$.entered')), JSON_UNQUOTE(JSON_EXTRACT(c.metadata, '$.callerName')),
          JSON_UNQUOTE(JSON_EXTRACT(c.metadata, '$.process.name')), u.display_name)) LIKE :search)`;
        p.search = likePattern(q.search);
      }
      const base = `FROM call_sessions c LEFT JOIN users u ON u.id = c.user_id AND u.tenant_id = :tenantId WHERE c.tenant_id = :tenantId${where}`;
      const counted = await tx.query<{ direction: string; n: number }>(`SELECT c.direction, COUNT(*) AS n ${base} GROUP BY c.direction`, p);
      const of = (d: string) => Number(counted.find((x) => x.direction === d)?.n ?? 0);
      const counts = { all: of('inbound') + of('outbound'), received: of('inbound'), dialled: of('outbound') };
      const tab = q.tab === 'received' ? ` AND c.direction = 'inbound'` : q.tab === 'dialled' ? ` AND c.direction = 'outbound'` : ` AND c.direction IN ('inbound', 'outbound')`;
      const rows = await tx.query(
        `SELECT c.id, c.direction, c.status, c.from_number, c.to_number, c.started_at, c.answered_at, c.ended_at, c.hangup_cause, c.metadata, u.display_name AS agent_name, u.email AS agent_email
           ${base}${tab} ORDER BY c.started_at DESC, c.id LIMIT ${q.limit} OFFSET ${q.offset}`, p);
      // names behind the server and the other extension, read once instead of per row (deleted ones too: history keeps its names)
      const servers = rows.length ? await tx.query<{ id: string; name: string }>(`SELECT id, name FROM call_servers WHERE tenant_id = :tenantId`) : [];
      const extensions = rows.length
        ? await tx.query<{ call_server_id: string; sip_id: string; display_name: string }>(
          `SELECT a.call_server_id, a.sip_id, x.display_name FROM softphone_accounts a JOIN users x ON x.id = a.user_id AND x.tenant_id = :tenantId WHERE a.tenant_id = :tenantId ORDER BY a.deleted_at IS NULL, a.created_at`)
        : [];
      const serverName = new Map(servers.map((s) => [s.id, s.name]));
      const owner = new Map(extensions.map((e) => [`${e.call_server_id}|${e.sip_id}`, e.display_name])); // a live account is read last and wins
      return { everyone, counts, total: counts[q.tab], items: rows.map((r: Row) => {
        const m = json(r.metadata);
        const received = r.direction === 'inbound';
        const otherNumber = (received ? r.from_number : r.to_number) as string | null;
        const outcome = m.outcome as { status?: string; note?: string } | undefined;
        return {
          id: r.id, direction: received ? 'received' : 'dialled', status: r.status,
          startedAt: iso(r.started_at), answeredAt: iso(r.answered_at), endedAt: iso(r.ended_at),
          ringSeconds: seconds(r.started_at, r.answered_at ?? r.ended_at), talkSeconds: seconds(r.answered_at, r.ended_at), totalSeconds: seconds(r.started_at, r.ended_at),
          otherNumber, otherName: owner.get(`${m.callServerId}|${otherNumber}`) ?? (received ? (m.callerName ?? null) : null),
          myExtension: (received ? r.to_number : r.from_number) as string | null,
          entered: m.entered ?? null, prefix: m.prefix || null, processName: m.process?.name ?? null, fromCallList: !!m.listItemId,
          callServerName: serverName.get(m.callServerId) ?? null, agentName: r.agent_name ?? null, agentEmail: r.agent_email ?? null,
          result: resultKind({ direction: r.direction, status: r.status, answered: !!r.answered_at, cause: r.hangup_cause, outcome: outcome?.status ?? null, ageMs: Date.now() - new Date(r.started_at).getTime() }),
          note: outcome?.note ?? null, hangupCause: r.hangup_cause,
        };
      }) };
    });
  }
}

@ApiTags('call-history')
@ApiBearerAuth()
@Controller({ path: 'call-history', version: '1' })
export class CallHistoryController {
  constructor(private readonly svc: CallHistoryService) {}

  @Get()
  list(@CurrentUser() u: AuthUser, @Query(new ZodPipe(historyQuerySchema)) q: HistoryQuery) { return this.svc.list(u, q); }
}
