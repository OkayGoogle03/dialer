import { BadRequestException, ConflictException, Injectable, NotFoundException, PayloadTooLargeException, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestContext } from '../common/auth/auth.types';
import { Database, newId, Params, SqlRunner } from '../database/database';
import { iso, nameKey } from '../master-data/common';
import { pickProcessCode } from '../master-data/processes';
import { buildErrorReportCsv } from './error-report';
import { evaluateRows, Evaluation, MasterSnapshot, emptySnapshot, Need, RowError, RowResult } from './evaluate';
import { ImportFileError, MAX_FILE_BYTES, ParsedRow, parseCallerWorkbook, XLSX_MIME } from './excel-format';
import { buildTemplate } from './template';

export type ImportMode = 'valid_only' | 'strict';
export interface Approval { processes: string[]; providers: string[]; callServers: string[]; dids: string[]; links: boolean }

interface RecordRow { id: string; row_no: number; process_name: string | null; service_provider: string | null; did: string | null; prefix: string | null; call_server: string | null; status: string; errors: RowError[] | null; needs: Need[] | null }

const chunk = <T>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const safeName = (n: string) => [...n].filter((ch) => ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 127 && ch !== '\\' && ch !== '/').join('').slice(0, 255) || 'upload.xlsx';

@Injectable()
export class CallerImportService {
  constructor(private readonly db: Database, private readonly audit: AuditService) {}

  // ------------------------------------------------------------------ template
  async template(actor: AuthUser): Promise<Buffer> {
    const lists = await this.db.withTenant(actor.tenantId, async (tx) => {
      const names = async (table: string) => (await tx.query<{ name: string }>(`SELECT name FROM ${table} WHERE tenant_id = :tenantId AND deleted_at IS NULL ORDER BY name LIMIT 1000`)).map((r) => r.name);
      return { processes: await names('outbound_processes'), providers: await names('service_providers'), callServers: await names('call_servers') };
    });
    return buildTemplate(lists);
  }

  // ------------------------------------------------------------------ preview
  async preview(actor: AuthUser, file: { originalname: string; mimetype: string; size: number; buffer: Buffer }, ctx: RequestContext) {
    const name = safeName(file.originalname);
    if (/\.xls$/i.test(name)) throw new BadRequestException('Legacy .xls files are not supported. Open the file in Excel and save it as .xlsx.');
    if (!/\.xlsx$/i.test(name)) throw new BadRequestException('Only .xlsx files are supported.');
    if (![XLSX_MIME, 'application/octet-stream', 'application/zip', 'application/x-zip-compressed'].includes(file.mimetype)) throw new BadRequestException('Unsupported file type.');
    if (file.size > MAX_FILE_BYTES || file.buffer.length > MAX_FILE_BYTES) throw new PayloadTooLargeException('File is too large (limit 4 MB).');

    let parsed;
    try {
      parsed = await parseCallerWorkbook(file.buffer);
    } catch (e) {
      if (e instanceof ImportFileError) throw new BadRequestException({ message: e.message, code: e.code });
      throw e;
    }
    if (parsed.rows.length === 0) throw new BadRequestException({ message: 'The file contains no data rows.', code: 'EMPTY_FILE' });
    const sha = createHash('sha256').update(file.buffer).digest('hex');

    return this.db.withTenant(actor.tenantId, async (tx) => {
      const snap = await this.loadSnapshot(tx);
      const ev = evaluateRows(parsed.rows, snap, { allowProposals: true });
      const batchId = newId();
      await tx.execute(
        `INSERT INTO caller_import_batches (id, tenant_id, file_name, file_sha256, status, total_rows, empty_rows, summary, created_by)
         VALUES (:id, :tenantId, :name, :sha, 'previewed', :total, :empty, :summary, :by)`,
        { id: batchId, name, sha, total: parsed.rows.length, empty: parsed.emptyRows, summary: JSON.stringify(this.summaryOf(ev)), by: actor.userId });
      await this.persistRecords(tx, batchId, parsed.rows, ev.results);
      const prior = await tx.query<{ id: string; created_at: Date }>(
        `SELECT id, created_at FROM caller_import_batches WHERE tenant_id = :tenantId AND file_sha256 = :sha AND status = 'imported' AND id <> :id ORDER BY created_at DESC LIMIT 1`, { sha, id: batchId });
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'caller_import.previewed', entityType: 'caller_import_batch', entityId: batchId, metadata: { file: name, rows: parsed.rows.length, counts: ev.counts } }, ctx);
      return {
        ...(await this.batchView(tx, batchId)),
        rows: await this.records(tx, batchId, {}, 200, 0),
        warnings: prior.length ? [{ code: 'ALREADY_IMPORTED', message: 'This exact file was already imported.', batchId: prior[0].id, importedAt: iso(prior[0].created_at) }] : [],
      };
    });
  }

  // ------------------------------------------------------------------ approve master data
  async approve(actor: AuthUser, batchId: string, approval: Approval, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const batch = await this.lockBatch(tx, batchId);
      if (!['previewed', 'approved'].includes(batch.status)) throw new ConflictException(`Batch is ${batch.status}; upload the file again to approve master data`);
      const rows = await this.loadRows(tx, batchId);
      const snap = await this.loadSnapshot(tx);
      const ev = evaluateRows(rows, snap, { allowProposals: true });
      const p = ev.proposals;
      const known = {
        processes: new Map(p.processes.map((x) => [x.key, x])), providers: new Map(p.providers.map((x) => [x.key, x])),
        callServers: new Map(p.callServers.map((x) => [x.key, x])), dids: new Map(p.dids.map((x) => [x.key, x])),
      };
      for (const [type, keys] of [['processes', approval.processes], ['providers', approval.providers], ['callServers', approval.callServers], ['dids', approval.dids]] as const) {
        const unknown = keys.filter((k) => !known[type].has(k));
        if (unknown.length) throw new BadRequestException(`Unknown ${type} proposal: ${unknown.slice(0, 5).join(', ')}`);
      }

      const ids = { processes: new Map<string, string>(), providers: new Map<string, string>(), servers: new Map<string, string>(), dids: new Map<string, string>() };
      for (const [k, v] of snap.processes) ids.processes.set(k, v.id);
      for (const [k, v] of snap.providers) ids.providers.set(k, v.id);
      for (const [k, v] of snap.servers) ids.servers.set(k, v.id);
      for (const [k, v] of snap.dids) ids.dids.set(k, v.id);

      const mint = (map: Map<string, string>, key: string) => { const id = newId(); map.set(key, id); return id; };
      const by = actor.userId;
      await this.bulkInsert(tx, 'service_providers', ['id', 'tenant_id', 'name', 'status', 'created_by'],
        approval.providers.map((k) => ({ id: mint(ids.providers, k), name: known.providers.get(k)!.name, status: 'pending_configuration', created_by: by })));
      const takenCodes = new Set((await tx.query<{ code: string }>(`SELECT code FROM outbound_processes WHERE tenant_id = :tenantId AND deleted_at IS NULL`)).map((r) => r.code));
      await this.bulkInsert(tx, 'outbound_processes', ['id', 'tenant_id', 'name', 'code', 'created_by'],
        approval.processes.map((k) => { const name = known.processes.get(k)!.name; const code = pickProcessCode(name, takenCodes); takenCodes.add(code); return { id: mint(ids.processes, k), name, code, created_by: by }; }));
      // No host, ARI URL or credentials are invented: the server stays "pending_configuration" until an admin configures and tests it.
      await this.bulkInsert(tx, 'call_servers', ['id', 'tenant_id', 'name', 'status', 'connection_status', 'created_by'],
        approval.callServers.map((k) => ({ id: mint(ids.servers, k), name: known.callServers.get(k)!.name, status: 'pending_configuration', connection_status: 'unknown', created_by: by })));
      await this.bulkInsert(tx, 'provider_dids', ['id', 'tenant_id', 'service_provider_id', 'did', 'prefix', 'status', 'verification_status', 'created_by'],
        approval.dids.map((k) => {
          const item = known.dids.get(k)!;
          const providerId = ids.providers.get(nameKey(item.providerName ?? ''));
          if (!providerId) throw new BadRequestException(`DID ${item.name} needs provider "${item.providerName}" to exist or be approved too`);
          return { id: mint(ids.dids, k), service_provider_id: providerId, did: item.name, prefix: item.prefix ?? null, status: 'pending_verification', verification_status: 'pending', created_by: by };
        }));

      const links = { pp: new Map<string, Record<string, unknown>>(), pd: new Map<string, Record<string, unknown>>(), ps: new Map<string, Record<string, unknown>>() };
      if (approval.links) {
        rows.forEach((_, i) => {
          const res = ev.results[i];
          const n = res.normalized;
          if (!n || res.status !== 'needs_master_data') return;
          const proc = ids.processes.get(n.processKey), prov = ids.providers.get(n.providerKey), srv = ids.servers.get(n.serverKey), did = ids.dids.get(n.did);
          if (!proc) return;
          if (prov && !snap.processProvider.has(`${proc}|${prov}`)) links.pp.set(`${proc}|${prov}`, { process_id: proc, service_provider_id: prov });
          if (did && prov && !snap.processDid.has(`${proc}|${did}`)) links.pd.set(`${proc}|${did}`, { process_id: proc, did_id: did });
          if (srv && !snap.processServer.has(`${proc}|${srv}`)) links.ps.set(`${proc}|${srv}`, { process_id: proc, call_server_id: srv });
        });
        await this.bulkInsert(tx, 'process_provider_assignments', ['tenant_id', 'process_id', 'service_provider_id'], [...links.pp.values()]);
        await this.bulkInsert(tx, 'process_did_assignments', ['tenant_id', 'process_id', 'did_id'], [...links.pd.values()]);
        await this.bulkInsert(tx, 'process_server_assignments', ['tenant_id', 'process_id', 'call_server_id'], [...links.ps.values()]);
      }
      const created = { processes: approval.processes.length, providers: approval.providers.length, callServers: approval.callServers.length, dids: approval.dids.length, links: links.pp.size + links.pd.size + links.ps.size };

      const after = evaluateRows(rows, await this.loadSnapshot(tx), { allowProposals: true });
      await this.persistRecords(tx, batchId, rows, after.results);
      await tx.execute(`UPDATE caller_import_batches SET status = 'approved', summary = :s WHERE tenant_id = :tenantId AND id = :id`, { id: batchId, s: JSON.stringify({ ...this.summaryOf(after), approvedCreated: created }) });
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'caller_import.master_data_approved', entityType: 'caller_import_batch', entityId: batchId, metadata: created }, ctx);
      return { created, ...(await this.batchView(tx, batchId)) };
    });
  }

  // ------------------------------------------------------------------ confirm
  async confirm(actor: AuthUser, batchId: string, mode: ImportMode, ctx: RequestContext) {
    const out = await this.db.withTenant(actor.tenantId, async (tx) => {
      const batch = await this.lockBatch(tx, batchId);
      if (batch.status === 'imported') return { alreadyImported: true as const, rejected: false as const, view: await this.batchView(tx, batchId) };
      if (!['previewed', 'approved'].includes(batch.status)) throw new ConflictException(`Batch is ${batch.status} and cannot be imported`);

      const rows = await this.loadRows(tx, batchId);
      const ev = evaluateRows(rows, await this.loadSnapshot(tx), { allowProposals: false });
      const importable = ev.results.filter((r) => r.status === 'valid' && r.resolved);
      const failed = ev.counts.invalid, duplicates = ev.counts.duplicate;

      if (mode === 'strict' && (failed > 0 || duplicates > 0)) {
        await this.persistRecords(tx, batchId, rows, ev.results);
        await tx.execute(`UPDATE caller_import_batches SET status = 'rejected', mode = 'strict', imported_rows = 0, summary = :s WHERE tenant_id = :tenantId AND id = :id`,
          { id: batchId, s: JSON.stringify({ ...this.summaryOf(ev), importedRows: 0, rejectedReason: 'strict mode: invalid or duplicate rows present' }) });
        await this.audit.log(tx, { actorUserId: actor.userId, action: 'caller_import.rejected', entityType: 'caller_import_batch', entityId: batchId, metadata: { mode, invalid: failed, duplicate: duplicates } }, ctx);
        return { alreadyImported: false as const, rejected: true as const, view: await this.batchView(tx, batchId) };
      }

      // Everything below runs in this one transaction: any failure rolls back all inserted assignments.
      for (const part of chunk(importable, 200)) {
        const p: Params = { batch: batchId, by: actor.userId };
        const tuples = part.map((r, i) => {
          const x = r.resolved!;
          Object.assign(p, { [`i${i}`]: newId(), [`pr${i}`]: x.processId, [`sp${i}`]: x.providerId, [`d${i}`]: x.didId, [`s${i}`]: x.serverId, [`px${i}`]: x.prefix });
          return `(:i${i}, :tenantId, :pr${i}, :sp${i}, :d${i}, :s${i}, :px${i}, 'active', :batch, :by)`;
        });
        await tx.execute(`INSERT INTO caller_assignments (id, tenant_id, process_id, service_provider_id, did_id, call_server_id, prefix, status, import_batch_id, created_by) VALUES ${tuples.join(', ')}`, p);
      }
      const resultsAfter: RowResult[] = ev.results.map((r) => (r.status === 'valid' && r.resolved ? { ...r, status: 'imported' as unknown as RowResult['status'] } : r));
      await this.persistRecords(tx, batchId, rows, resultsAfter);
      const imported = importable.length;
      await tx.execute(`UPDATE caller_import_batches SET status = :st, mode = :mode, imported_rows = :n, summary = :s WHERE tenant_id = :tenantId AND id = :id`,
        { id: batchId, st: imported > 0 ? 'imported' : 'failed', mode, n: imported, s: JSON.stringify({ ...this.summaryOf(ev), importedRows: imported, failedImports: failed, skippedDuplicates: duplicates }) });
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'caller_import.imported', entityType: 'caller_import_batch', entityId: batchId, metadata: { mode, imported, failed, duplicates } }, ctx);
      return { alreadyImported: false as const, rejected: false as const, view: await this.batchView(tx, batchId) };
    });
    if (out.rejected) {
      throw new UnprocessableEntityException({ message: 'Strict import rejected: the file contains invalid or duplicate rows. Nothing was imported.', code: 'STRICT_IMPORT_REJECTED', batch: out.view.batch });
    }
    return { alreadyImported: out.alreadyImported, ...out.view };
  }

  // ------------------------------------------------------------------ reads
  listBatches(actor: AuthUser, q: { limit: number; offset: number; status?: string }) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const p: Params = {};
      let where = '';
      if (q.status) { p.status = q.status; where = ' AND status = :status'; }
      const rows = await tx.query(
        `SELECT id, file_name, status, mode, total_rows, empty_rows, imported_rows, created_by, created_at, summary FROM caller_import_batches
          WHERE tenant_id = :tenantId${where} ORDER BY created_at DESC LIMIT ${q.limit} OFFSET ${q.offset}`, p);
      const [{ n }] = await tx.query<{ n: number }>(`SELECT COUNT(*) AS n FROM caller_import_batches WHERE tenant_id = :tenantId${where}`, p);
      return { items: rows.map((r) => this.batchRow(r)), total: Number(n), limit: q.limit, offset: q.offset };
    });
  }

  getBatch(actor: AuthUser, id: string) {
    return this.db.withTenant(actor.tenantId, (tx) => this.batchView(tx, id));
  }

  batchRecords(actor: AuthUser, id: string, q: { status?: string; limit: number; offset: number }) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      await this.batchView(tx, id);
      return this.records(tx, id, { status: q.status }, q.limit, q.offset);
    });
  }

  batchErrors(actor: AuthUser, id: string, q: { limit: number; offset: number }) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      await this.batchView(tx, id);
      return this.records(tx, id, { problemsOnly: true }, q.limit, q.offset);
    });
  }

  async errorReport(actor: AuthUser, id: string): Promise<{ csv: string; filename: string }> {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      await this.batchView(tx, id);
      const rows = await tx.query<RecordRow>(
        `SELECT row_no, process_name, service_provider, did, prefix, call_server, status, errors FROM caller_import_records
          WHERE tenant_id = :tenantId AND batch_id = :id AND status IN ('invalid', 'duplicate') ORDER BY row_no`, { id });
      return {
        filename: `Project_Dialer_Import_Errors_${id.slice(0, 8)}.csv`,
        csv: buildErrorReportCsv(rows.map((r) => ({ rowNumber: r.row_no, processName: r.process_name, serviceProvider: r.service_provider, did: r.did, prefix: r.prefix, callServer: r.call_server, status: r.status, errors: r.errors ?? [] }))),
      };
    });
  }

  // ------------------------------------------------------------------ delete / rollback
  remove(actor: AuthUser, id: string, ctx: RequestContext) {
    return this.db.withTenant(actor.tenantId, async (tx) => {
      const batch = await this.lockBatch(tx, id);
      if (batch.status === 'imported') {
        const [{ n }] = await tx.query<{ n: number }>(
          `SELECT COUNT(*) AS n FROM outbound_calls oc JOIN caller_assignments ca ON ca.id = oc.caller_assignment_id AND ca.tenant_id = :tenantId
            WHERE oc.tenant_id = :tenantId AND ca.import_batch_id = :id`, { id });
        if (Number(n) > 0) throw new ConflictException('Calls have already been placed using this batch\'s assignments; it cannot be rolled back');
        const r = await tx.execute(`DELETE FROM caller_assignments WHERE tenant_id = :tenantId AND import_batch_id = :id`, { id });
        // The batch is removed together with its assignments (its records cascade); master data created by it stays.
        await tx.execute(`DELETE FROM caller_import_batches WHERE tenant_id = :tenantId AND id = :id`, { id });
        await this.audit.log(tx, { actorUserId: actor.userId, action: 'caller_import.deleted', entityType: 'caller_import_batch', entityId: id, metadata: { status: batch.status, removedAssignments: r.affectedRows } }, ctx);
        return { status: 'deleted', removedAssignments: r.affectedRows };
      }
      await tx.execute(`DELETE FROM caller_import_batches WHERE tenant_id = :tenantId AND id = :id`, { id });
      await this.audit.log(tx, { actorUserId: actor.userId, action: 'caller_import.deleted', entityType: 'caller_import_batch', entityId: id, metadata: { status: batch.status } }, ctx);
      return { status: 'deleted', removedAssignments: 0 };
    });
  }

  // ------------------------------------------------------------------ internals
  /** Chunked multi-row INSERT with named placeholders; the tenant_id column is always the bound context tenant. */
  private async bulkInsert(tx: SqlRunner, table: string, columns: string[], rows: Record<string, unknown>[]) {
    for (const part of chunk(rows, 200)) {
      const p: Params = {};
      const tuples = part.map((r, i) => '(' + columns.map((c) => {
        if (c === 'tenant_id') return ':tenantId';
        p[`${c}_${i}`] = r[c] ?? null;
        return `:${c}_${i}`;
      }).join(', ') + ')');
      await tx.execute(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`, p);
    }
  }

  private summaryOf(ev: Evaluation) {
    return { counts: ev.counts, existing: ev.existing, proposals: ev.proposals };
  }

  private batchRow(r: Record<string, any>) {
    const s = r.summary ?? {};
    return {
      id: r.id, fileName: r.file_name, status: r.status, mode: r.mode, totalRows: r.total_rows, emptyRows: r.empty_rows, importedRows: r.imported_rows,
      createdBy: r.created_by, createdAt: iso(r.created_at), counts: s.counts ?? null,
    };
  }

  private async batchView(tx: SqlRunner, id: string) {
    const [row] = await tx.query(
      `SELECT id, file_name, status, mode, total_rows, empty_rows, imported_rows, created_by, created_at, summary FROM caller_import_batches WHERE tenant_id = :tenantId AND id = :id`, { id });
    if (!row) throw new NotFoundException('Import batch not found');
    const s = row.summary ?? {};
    const c = s.counts ?? { total: row.total_rows, valid: 0, needsMasterData: 0, invalid: 0, duplicate: 0 };
    return {
      batch: this.batchRow(row),
      summary: {
        totalExcelRecords: c.total, validRecords: c.valid + c.needsMasterData, invalidRecords: c.invalid, duplicateRecords: c.duplicate,
        successfullyImported: s.importedRows ?? row.imported_rows ?? 0, failedImports: s.failedImports ?? 0,
      },
      discovery: { existing: s.existing ?? null, proposals: s.proposals ?? null },
    };
  }

  private async lockBatch(tx: SqlRunner, id: string) {
    const [b] = await tx.query<{ id: string; status: string }>(`SELECT id, status FROM caller_import_batches WHERE tenant_id = :tenantId AND id = :id FOR UPDATE`, { id });
    if (!b) throw new NotFoundException('Import batch not found');
    return b;
  }

  private async records(tx: SqlRunner, batchId: string, f: { status?: string; problemsOnly?: boolean }, limit: number, offset: number) {
    const p: Params = { b: batchId };
    let where = '';
    if (f.status) { p.st = f.status; where += ' AND status = :st'; }
    if (f.problemsOnly) where += ` AND status IN ('invalid', 'duplicate')`;
    const rows = await tx.query<RecordRow>(
      `SELECT row_no, process_name, service_provider, did, prefix, call_server, status, errors, needs FROM caller_import_records
        WHERE tenant_id = :tenantId AND batch_id = :b${where} ORDER BY row_no LIMIT ${limit} OFFSET ${offset}`, p);
    const [{ n }] = await tx.query<{ n: number }>(`SELECT COUNT(*) AS n FROM caller_import_records WHERE tenant_id = :tenantId AND batch_id = :b${where}`, p);
    return {
      items: rows.map((r) => ({ rowNumber: r.row_no, processName: r.process_name, serviceProvider: r.service_provider, did: r.did, prefix: r.prefix, callServer: r.call_server, status: r.status, errors: r.errors ?? [], needs: r.needs ?? [] })),
      total: Number(n), limit, offset,
    };
  }

  private async loadRows(tx: SqlRunner, batchId: string): Promise<ParsedRow[]> {
    const rows = await tx.query<RecordRow>(
      `SELECT row_no, process_name, service_provider, did, prefix, call_server, errors FROM caller_import_records WHERE tenant_id = :tenantId AND batch_id = :b ORDER BY row_no`, { b: batchId });
    return rows.map((r) => ({
      rowNumber: r.row_no, processName: r.process_name ?? '', serviceProvider: r.service_provider ?? '', did: r.did ?? '', prefix: r.prefix ?? '', callServer: r.call_server ?? '',
      cellErrors: (r.errors ?? []).filter((e) => e.code === 'INVALID_CELL').map((e) => ({ field: e.field ?? '', message: e.message })),
    }));
  }

  private async persistRecords(tx: SqlRunner, batchId: string, rows: ParsedRow[], results: RowResult[]) {
    await tx.execute(`DELETE FROM caller_import_records WHERE tenant_id = :tenantId AND batch_id = :b`, { b: batchId });
    for (const part of chunk(rows.map((r, i) => ({ r, res: results[i] })), 250)) {
      const p: Params = { b: batchId };
      const tuples = part.map(({ r, res }, i) => {
        Object.assign(p, {
          [`id${i}`]: newId(), [`n${i}`]: r.rowNumber, [`pn${i}`]: r.processName.slice(0, 255), [`sp${i}`]: r.serviceProvider.slice(0, 255), [`d${i}`]: r.did.slice(0, 64),
          [`px${i}`]: r.prefix.slice(0, 32), [`cs${i}`]: r.callServer.slice(0, 255), [`st${i}`]: res.status, [`er${i}`]: JSON.stringify(res.errors), [`nd${i}`]: JSON.stringify(res.needs),
        });
        return `(:id${i}, :tenantId, :b, :n${i}, :pn${i}, :sp${i}, :d${i}, :px${i}, :cs${i}, :st${i}, :er${i}, :nd${i})`;
      });
      await tx.execute(`INSERT INTO caller_import_records (id, tenant_id, batch_id, row_no, process_name, service_provider, did, prefix, call_server, status, errors, needs) VALUES ${tuples.join(', ')}`, p);
    }
  }

  /** Tenant master data in memory for validation. Names match case-insensitively (process code is accepted as an alias). */
  async loadSnapshot(tx: SqlRunner): Promise<MasterSnapshot> {
    const snap = emptySnapshot();
    const procs = await tx.query<{ id: string; name: string; code: string; status: string }>(`SELECT id, name, code, status FROM outbound_processes WHERE tenant_id = :tenantId AND deleted_at IS NULL`);
    for (const p of procs) snap.processes.set(nameKey(p.name), { id: p.id, name: p.name, status: p.status });
    for (const p of procs) if (!snap.processes.has(nameKey(p.code))) snap.processes.set(nameKey(p.code), { id: p.id, name: p.name, status: p.status });
    for (const p of await tx.query<{ id: string; name: string; status: string }>(`SELECT id, name, status FROM service_providers WHERE tenant_id = :tenantId AND deleted_at IS NULL`)) snap.providers.set(nameKey(p.name), p);
    for (const p of await tx.query<{ id: string; name: string; status: string }>(`SELECT id, name, status FROM call_servers WHERE tenant_id = :tenantId AND deleted_at IS NULL`)) snap.servers.set(nameKey(p.name), p);
    for (const d of await tx.query<{ id: string; did: string; service_provider_id: string; status: string }>(`SELECT id, did, service_provider_id, status FROM provider_dids WHERE tenant_id = :tenantId AND deleted_at IS NULL`)) snap.dids.set(d.did, { id: d.id, providerId: d.service_provider_id, status: d.status });
    for (const r of await tx.query<{ a: string; b: string }>(`SELECT process_id AS a, service_provider_id AS b FROM process_provider_assignments WHERE tenant_id = :tenantId`)) snap.processProvider.add(`${r.a}|${r.b}`);
    for (const r of await tx.query<{ a: string; b: string }>(`SELECT process_id AS a, did_id AS b FROM process_did_assignments WHERE tenant_id = :tenantId`)) snap.processDid.add(`${r.a}|${r.b}`);
    for (const r of await tx.query<{ a: string; b: string }>(`SELECT process_id AS a, call_server_id AS b FROM process_server_assignments WHERE tenant_id = :tenantId`)) snap.processServer.add(`${r.a}|${r.b}`);
    for (const r of await tx.query<{ p: string; s: string; d: string; c: string }>(`SELECT process_id AS p, service_provider_id AS s, did_id AS d, call_server_id AS c FROM caller_assignments WHERE tenant_id = :tenantId`)) snap.assignments.add(`${r.p}|${r.s}|${r.d}|${r.c}`);
    return snap;
  }
}
