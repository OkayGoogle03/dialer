import { BadRequestException, Controller, Delete, ForbiddenException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query, Res, StreamableFile, UploadedFile, UseInterceptors, ConflictException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import ExcelJS from 'exceljs';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth/auth.types';
import { CurrentUser, ReqContext } from '../common/auth/decorators';
import { SecretsService } from '../common/crypto/secrets.service';
import { cellText, ImportFileError, MAX_FILE_BYTES, XLSX_MIME } from '../caller-import/excel-format';
import { Database, newId, Row, SqlRunner } from '../database/database';
import { HOST_RE, iso, uuidSchema, z, ZodPipe } from '../master-data/common';
import { DEFAULT_DIAL_PLAN } from '../master-data/processes';
import { SoftphoneService } from '../softphone/softphone';

export const LIST_HEADERS = ['Call Server IP', 'SIP ID', 'SIP ID Password', 'Prefix', 'Phone Number'] as const;
const MAX_ROWS = 2000;
const SIP_ID_RE = /^[A-Za-z0-9._@+-]{1,64}$/;
const PREFIX_RE = /^[0-9]{0,6}$/;
const PHONE_RE = /^\+?[0-9]{3,20}$/;

const itemsQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(200), offset: z.coerce.number().int().min(0).default(0), status: z.string().max(16).optional() }).strict();
const listQuery = z.object({ userId: uuidSchema.optional() }).strict();

/** Cells that Excel would read as a formula are neutralised in the export. */
const safe = (v: string | null) => (v && /^[=@+-]/.test(v) && !/^\+?[0-9]+$/.test(v) ? `'${v}` : v ?? '');

interface Parsed { row: number; host: string; sipId: string; password: string; prefix: string; phone: string; error?: string }

export async function buildListTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Calls');
  ws.addRow([...LIST_HEADERS]);
  ws.getRow(1).font = { bold: true };
  ws.columns = [{ width: 22 }, { width: 14 }, { width: 22 }, { width: 10 }, { width: 18 }];
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const c of [1, 2, 3, 4, 5]) ws.getColumn(c).numFmt = '@';
  const info = wb.addWorksheet('Instructions');
  [
    'One row per call. Keep the five headers exactly as they are.',
    'Call Server IP: IP address or host name of the call server (PBX). A new IP is created as a call server automatically.',
    'SIP ID / SIP ID Password: the agent\'s SIP login on that call server (stored encrypted; never exported).',
    'Prefix: digits added in front of the phone number (0-6 digits, may be empty). +international numbers are dialled as they are.',
    'Phone Number: digits, optionally starting with +.',
    'Example row: 10.0.0.5 | 1001 | secret123 | 91 | 9876543210',
  ].forEach((t) => info.addRow([t]));
  info.getColumn(1).width = 120;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function parseList(buf: Buffer): Promise<Parsed[]> {
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) throw new ImportFileError('INVALID_FORMAT', 'The file is not a valid .xlsx workbook.');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as unknown as ExcelJS.Buffer); } catch { throw new ImportFileError('INVALID_FORMAT', 'The workbook could not be read; it may be corrupted.'); }
  const ws = wb.worksheets[0];
  if (!ws) throw new ImportFileError('EMPTY_FILE', 'The workbook has no worksheets.');
  const bad = LIST_HEADERS.filter((h, i) => cellText(ws.getRow(1).getCell(i + 1).value).text !== h);
  if (bad.length) throw new ImportFileError('INVALID_HEADERS', `Invalid headers. The first row must be exactly: ${LIST_HEADERS.join(' | ')}.`);
  const out: Parsed[] = [];
  for (let r = 2; r <= Math.min(ws.rowCount, 100_000); r++) {
    const cells = [1, 2, 3, 4, 5].map((c) => cellText(ws.getRow(r).getCell(c).value));
    if (cells.every((c) => c.text === '' && !c.error)) continue;
    if (out.length >= MAX_ROWS) throw new ImportFileError('TOO_MANY_ROWS', `More than ${MAX_ROWS} rows. Split the file.`);
    const [host, sipId, password, prefix, phone] = cells.map((c) => c.text);
    const item: Parsed = { row: r, host, sipId, password, prefix, phone: phone.replace(/[\s().-]/g, '') };
    const cellErr = cells.find((c) => c.error)?.error;
    if (cellErr) item.error = cellErr;
    else if (!HOST_RE.test(host)) item.error = 'Call Server IP is missing or invalid';
    else if (!SIP_ID_RE.test(sipId)) item.error = 'SIP ID is missing or invalid';
    else if (!password || password.length > 200) item.error = 'SIP ID Password is missing';
    else if (!PREFIX_RE.test(prefix)) item.error = 'Prefix must be 0-6 digits';
    else if (!PHONE_RE.test(item.phone)) item.error = 'Phone Number must be 3-20 digits, optionally starting with +';
    out.push(item);
  }
  if (!out.length) throw new ImportFileError('EMPTY_FILE', 'The file has no data rows.');
  return out;
}

@Injectable()
export class CallListsService {
  constructor(private readonly db: Database, private readonly audit: AuditService, private readonly secrets: SecretsService, private readonly softphone: SoftphoneService) {}

  private isAdmin = (a: AuthUser) => a.permissions.has('caller_import:manage');

  /**
   * Imports the sheet for one agent: creates/updates the call server (by IP), the agent's SIP account (SIP ID + password, encrypted),
   * and stores each row with its prefix and phone number. Bad rows are kept as "invalid" with the reason, so nothing is silently dropped.
   */
  async import(actor: AuthUser, file: Express.Multer.File, userId: string | undefined, name: string | undefined, ctx: RequestContext) {
    if (!this.isAdmin(actor)) throw new ForbiddenException('Missing permission: caller_import:manage');
    let rows: Parsed[];
    try { rows = await parseList(file.buffer); } catch (e) { if (e instanceof ImportFileError) throw new BadRequestException({ code: e.code, message: e.message }); throw e; }
    const target = userId ?? actor.userId;
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const [user] = await tx.query(`SELECT id FROM users WHERE tenant_id = :tenantId AND id = :id AND deleted_at IS NULL AND status = 'active'`, { id: target });
      if (!user) throw new NotFoundException('Agent not found or not active');
      const canCreateServers = actor.permissions.has('call_servers:manage');
      const servers = new Map<string, { id: string; usable: boolean } | null>();
      const accounts = new Map<string, string | null>(); // host -> sipId already bound for this agent on that server (first row wins)
      let createdServers = 0;
      for (const r of rows.filter((x) => !x.error)) {
        const key = r.host.toLowerCase();
        if (!servers.has(key)) {
          const [s] = await tx.query(`SELECT id, status FROM call_servers WHERE tenant_id = :tenantId AND LOWER(host) = :h AND deleted_at IS NULL ORDER BY created_at LIMIT 1`, { h: key });
          if (s) servers.set(key, { id: s.id, usable: s.status === 'active' });
          else if (canCreateServers) {
            const id = newId();
            await tx.execute(`INSERT INTO call_servers (id, tenant_id, name, host, address_updated_at, status, created_by) VALUES (:id, :tenantId, :n, :h, UTC_TIMESTAMP(3), 'active', :by)`, { id, n: r.host.slice(0, 100), h: r.host, by: actor.userId });
            servers.set(key, { id, usable: true }); createdServers++;
          } else servers.set(key, null);
        }
        const srv = servers.get(key);
        if (!srv) { r.error = 'Unknown call server IP (you may not create call servers)'; continue; }
        if (!srv.usable) { r.error = 'Call server is disabled'; continue; }
        const bound = accounts.get(key);
        if (bound === undefined) {
          const err = await this.bindAccount(tx, actor, target, srv.id, r, ctx);
          if (err) { r.error = err; continue; }
          accounts.set(key, r.sipId);
        } else if (bound !== r.sipId) r.error = `This agent already uses SIP ID ${bound} on this call server`;
      }
      const listId = newId();
      const invalid = rows.filter((r) => r.error).length;
      await tx.execute(`INSERT INTO call_lists (id, tenant_id, name, file_name, user_id, total_rows, invalid_rows, created_by) VALUES (:id, :tenantId, :n, :f, :u, :t, :i, :by)`,
        { id: listId, n: (name?.trim() || file.originalname || 'Call list').replace(/\.xlsx$/i, '').slice(0, 150), f: (file.originalname ?? '').slice(0, 255), u: target, t: rows.length, i: invalid, by: actor.userId });
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const p: Record<string, unknown> = { lid: listId };
        const values = chunk.map((r, j) => {
          const srv = servers.get(r.host.toLowerCase());
          Object.assign(p, { [`i${j}`]: newId(), [`n${j}`]: r.row, [`s${j}`]: srv?.id ?? null, [`h${j}`]: r.host.slice(0, 253), [`d${j}`]: r.sipId.slice(0, 64), [`x${j}`]: r.prefix, [`p${j}`]: r.phone.slice(0, 40), [`st${j}`]: r.error ? 'invalid' : 'pending', [`r${j}`]: r.error ?? null });
          return `(:i${j}, :tenantId, :lid, :n${j}, :s${j}, :h${j}, :d${j}, :x${j}, :p${j}, :st${j}, :r${j})`;
        });
        await tx.execute(`INSERT INTO call_list_items (id, tenant_id, list_id, row_no, call_server_id, server_host, sip_id, prefix, phone, status, result) VALUES ${values.join(', ')}`, p);
      }
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'call_list.imported', entityType: 'call_list', entityId: listId, metadata: { rows: rows.length, invalid, createdServers, agent: target } }, ctx);
      return {
        id: listId, total: rows.length, valid: rows.length - invalid, invalid, createdServers,
        errors: rows.filter((r) => r.error).slice(0, 100).map((r) => ({ row: r.row, message: r.error })),
      };
    });
  }

  /** One SIP account per agent per call server; returns an error message if the row cannot be applied. */
  private async bindAccount(tx: SqlRunner, actor: AuthUser, userId: string, serverId: string, r: Parsed, ctx: RequestContext): Promise<string | null> {
    const [mine] = await tx.query(`SELECT id, sip_id FROM softphone_accounts WHERE tenant_id = :tenantId AND user_id = :u AND call_server_id = :s AND deleted_at IS NULL FOR UPDATE`, { u: userId, s: serverId });
    const [clash] = await tx.query(`SELECT id FROM softphone_accounts WHERE tenant_id = :tenantId AND call_server_id = :s AND sip_id = :sip AND deleted_at IS NULL${mine ? ' AND id <> :me' : ''}`, { s: serverId, sip: r.sipId, ...(mine ? { me: mine.id } : {}) });
    if (clash) return `SIP ID ${r.sipId} is already used by another agent on this call server`;
    if (mine) {
      await tx.execute(`UPDATE softphone_accounts SET sip_id = :sip, sip_secret_encrypted = :secret, status = 'active', registration_status = 'unknown', last_error = NULL WHERE tenant_id = :tenantId AND id = :id`, { id: mine.id, sip: r.sipId, secret: this.secrets.encrypt(r.password) });
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'softphone_account.updated', entityType: 'softphone_account', entityId: mine.id, metadata: { via: 'call_list' } }, ctx);
    } else {
      const id = newId();
      await tx.execute(`INSERT INTO softphone_accounts (id, tenant_id, user_id, call_server_id, sip_id, sip_secret_encrypted, created_by) VALUES (:id, :tenantId, :u, :s, :sip, :secret, :by)`, { id, u: userId, s: serverId, sip: r.sipId, secret: this.secrets.encrypt(r.password), by: actor.userId });
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'softphone_account.created', entityType: 'softphone_account', entityId: id, metadata: { via: 'call_list' } }, ctx);
    }
    return null;
  }

  list(actor: AuthUser, q: z.infer<typeof listQuery>) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const mine = !this.isAdmin(actor);
      const p: Record<string, unknown> = {};
      let where = '';
      if (mine) { where = ' AND l.user_id = :me'; p.me = actor.userId; } else if (q.userId) { where = ' AND l.user_id = :uid'; p.uid = q.userId; }
      const lists = await tx.query(
        `SELECT l.id, l.name, l.file_name, l.user_id, l.total_rows, l.invalid_rows, l.created_at, u.display_name AS agent_name FROM call_lists l
           JOIN users u ON u.id = l.user_id AND u.tenant_id = :tenantId WHERE l.tenant_id = :tenantId${where} ORDER BY l.created_at DESC LIMIT 100`, p);
      const counts = lists.length
        ? await tx.query<{ list_id: string; status: string; n: number }>(`SELECT list_id, status, COUNT(*) AS n FROM call_list_items WHERE tenant_id = :tenantId AND list_id IN (:ids) GROUP BY list_id, status`, { ids: lists.map((l) => l.id) })
        : [];
      return { items: lists.map((l) => ({ id: l.id, name: l.name, fileName: l.file_name, agentId: l.user_id, agentName: l.agent_name, total: l.total_rows, invalid: l.invalid_rows, createdAt: iso(l.created_at),
        counts: Object.fromEntries(counts.filter((c) => c.list_id === l.id).map((c) => [c.status, Number(c.n)])) })) };
    });
  }

  async items(actor: AuthUser, listId: string, q: z.infer<typeof itemsQuery>) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const l = await this.loadList(tx, actor, listId);
      const p: Record<string, unknown> = { lid: listId };
      const st = q.status ? ' AND status = :st' : '';
      if (q.status) p.st = q.status;
      const rows = await tx.query(`SELECT * FROM call_list_items WHERE tenant_id = :tenantId AND list_id = :lid${st} ORDER BY row_no LIMIT ${q.limit} OFFSET ${q.offset}`, p);
      const counts = await tx.query<{ status: string; n: number }>(`SELECT status, COUNT(*) AS n FROM call_list_items WHERE tenant_id = :tenantId AND list_id = :lid GROUP BY status`, { lid: listId });
      return { list: { id: l.id, name: l.name, agentId: l.user_id, total: l.total_rows }, counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])), items: rows.map(itemView) };
    });
  }

  /** The agent dials a row: server applies the row's prefix, records the call, links it to the row. The browser then dials the returned target. */
  call(actor: AuthUser, listId: string, itemId: string, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const l = await this.loadList(tx, actor, listId);
      if (l.user_id !== actor.userId) throw new ForbiddenException('Only the agent this list belongs to can place its calls');
      const [it] = await tx.query(`SELECT * FROM call_list_items WHERE tenant_id = :tenantId AND list_id = :lid AND id = :id FOR UPDATE`, { lid: listId, id: itemId });
      if (!it) throw new NotFoundException('Row not found');
      if (it.status === 'invalid') throw new BadRequestException(`This row is invalid: ${it.result ?? 'see the error'}`);
      if (['initiated', 'ringing', 'answered'].includes(it.status) || it.status === 'calling') throw new ConflictException('This number is already being called');
      const [acct] = await tx.query(
        `SELECT a.id, a.sip_id, s.id AS server_id, s.host, s.sip_realm FROM softphone_accounts a
           JOIN call_servers s ON s.id = a.call_server_id AND s.tenant_id = :tenantId AND s.deleted_at IS NULL AND s.status = 'active'
          WHERE a.tenant_id = :tenantId AND a.user_id = :me AND a.call_server_id = :sid AND a.deleted_at IS NULL AND a.status = 'active'`, { me: actor.userId, sid: it.call_server_id });
      if (!acct) throw new NotFoundException('No active SIP account / call server for this row');
      const placed = await this.softphone.placeInTx(tx, actor, acct, it.phone, it.prefix ?? '', { ...DEFAULT_DIAL_PLAN, minLength: 3, stripLeadingZeros: false }, null, ctx, { listItemId: itemId, listId });
      await tx.execute(
        `UPDATE call_list_items SET status = 'calling', result = NULL, sip_code = NULL, dialed = :d, call_session_id = :cid, attempts = attempts + 1, called_at = UTC_TIMESTAMP(3), answered_at = NULL, ended_at = NULL, duration_seconds = NULL
          WHERE tenant_id = :tenantId AND id = :id`, { id: itemId, d: placed.dialed, cid: placed.callId });
      return { ...placed, accountId: acct.id, itemId };
    });
  }

  remove(actor: AuthUser, id: string, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const l = await this.loadList(tx, actor, id);
      await tx.execute(`DELETE FROM call_lists WHERE tenant_id = :tenantId AND id = :id`, { id });
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'call_list.deleted', entityType: 'call_list', entityId: id, metadata: { name: l.name } }, ctx);
    });
  }

  /** Excel export of every row with its outcome. SIP passwords are never included. */
  async export(actor: AuthUser, id: string) {
    const { list, rows } = await this.db.withTenant(actor.tenantId, async (tx) => ({
      list: await this.loadList(tx, actor, id),
      rows: await tx.query(`SELECT * FROM call_list_items WHERE tenant_id = :tenantId AND list_id = :lid ORDER BY row_no`, { lid: id }),
    }));
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Call results');
    const headers = ['Row', 'Call Server IP', 'SIP ID', 'Prefix', 'Phone Number', 'Dialed Number', 'Status', 'Result / Reason', 'SIP Code', 'Attempts', 'Called At (UTC)', 'Answered At (UTC)', 'Ended At (UTC)', 'Duration (s)'];
    ws.addRow(headers);
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.columns = headers.map((h) => ({ width: Math.max(12, h.length + 2) }));
    for (const r of rows) {
      ws.addRow([r.row_no, safe(r.server_host), safe(r.sip_id), safe(r.prefix), safe(r.phone), safe(r.dialed), STATUS_LABEL[r.status] ?? r.status, safe(r.result), r.sip_code ?? '', r.attempts,
        r.called_at ? new Date(r.called_at).toISOString() : '', r.answered_at ? new Date(r.answered_at).toISOString() : '', r.ended_at ? new Date(r.ended_at).toISOString() : '', r.duration_seconds ?? '']);
    }
    for (const c of [2, 3, 4, 5, 6]) ws.getColumn(c).numFmt = '@';
    return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), filename: `${list.name.replace(/[^A-Za-z0-9._-]+/g, '_')}_results.xlsx` };
  }

  private async loadList(tx: SqlRunner, actor: AuthUser, id: string) {
    const [l] = await tx.query(`SELECT * FROM call_lists WHERE tenant_id = :tenantId AND id = :id`, { id });
    if (!l || (!this.isAdmin(actor) && l.user_id !== actor.userId)) throw new NotFoundException('Call list not found');
    return l;
  }
}

const STATUS_LABEL: Record<string, string> = { pending: 'Pending', calling: 'Calling', ringing: 'Ringing', answered: 'Answered', completed: 'Completed', not_answered: 'Not answered', failed: 'Failed', invalid: 'Invalid row' };


const itemView = (r: Row) => ({
  id: r.id, row: r.row_no, serverHost: r.server_host, sipId: r.sip_id, prefix: r.prefix, phone: r.phone, dialed: r.dialed, status: r.status, result: r.result, sipCode: r.sip_code,
  attempts: r.attempts, calledAt: iso(r.called_at), answeredAt: iso(r.answered_at), endedAt: iso(r.ended_at), durationSeconds: r.duration_seconds,
});

@ApiTags('call-lists')
@ApiBearerAuth()
@Controller({ path: 'call-lists', version: '1' })
export class CallListsController {
  constructor(private readonly svc: CallListsService) {}

  @Get('template')
  async template(@Res({ passthrough: true }) res: Response) {
    res.set({ 'Content-Type': XLSX_MIME, 'Content-Disposition': 'attachment; filename="Call_List_Template.xlsx"', 'Cache-Control': 'no-store' });
    return new StreamableFile(await buildListTemplate());
  }

  @Post('import') @HttpCode(201) @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 5, parts: 8 } }))
  import(@CurrentUser() u: AuthUser, @UploadedFile() file: Express.Multer.File | undefined, @Query('userId') userId: string | undefined, @Query('name') name: string | undefined, @ReqContext() ctx: RequestContext) {
    if (!file) throw new BadRequestException('Attach the Excel file in the "file" form field.');
    if (userId !== undefined && !uuidSchema.safeParse(userId).success) throw new BadRequestException('userId must be a UUID');
    return this.svc.import(u, file, userId, name, ctx);
  }

  @Get()
  list(@CurrentUser() u: AuthUser, @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) { return this.svc.list(u, q); }

  @Get(':id/items')
  items(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(itemsQuery)) q: z.infer<typeof itemsQuery>) { return this.svc.items(u, id, q); }

  @Post(':id/items/:itemId/call') @HttpCode(201) @Throttle({ default: { limit: 120, ttl: 60_000 } })
  call(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string, @ReqContext() ctx: RequestContext) { return this.svc.call(u, id, itemId, ctx); }

  @Get(':id/export')
  async export(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const { buffer, filename } = await this.svc.export(u, id);
    res.set({ 'Content-Type': XLSX_MIME, 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
    return new StreamableFile(buffer);
  }

  @Delete(':id') @HttpCode(204)
  remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ReqContext() ctx: RequestContext) { return this.svc.remove(u, id, ctx); }
}
