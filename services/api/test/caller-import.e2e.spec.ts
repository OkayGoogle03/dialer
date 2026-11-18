import ExcelJS from 'exceljs';
import { AuditService } from '../src/audit/audit.service';
import { HEADERS, TEMPLATE_FILENAME } from '../src/caller-import/excel-format';
import { importRows, post } from './support/fixtures';
import { bearer, nextIp, ownerConnection, provision, RUN, startApp, TestApp, token } from './support/harness';
import { makeWorkbook, SAMPLE_ROWS, uniqueRows } from './support/xlsx';

const A = `ci-a-${RUN}`;
const B = `ci-b-${RUN}`;
const PW = 'import-pass-123';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const names = (rows: string[][]) => ({ processes: rows.map((r) => r[0]), providers: [...new Set(rows.map((r) => r[1]))] });

describe('Caller Excel import (TiDB)', () => {
  let t: TestApp;
  let a: string;
  let b: string;

  const upload = (tok: string, buf: Buffer, filename = 'callers.xlsx', contentType = XLSX) =>
    t.http.post('/api/v1/caller-import/preview').set(bearer(tok)).set('X-Forwarded-For', nextIp()).attach('file', buf, { filename, contentType });
  const assignmentCount = async (tenantId: string) => {
    const c = await ownerConnection();
    const [r] = await c.query(`SELECT COUNT(*) AS n FROM caller_assignments WHERE tenant_id = ?`, [tenantId]);
    await c.end();
    return Number((r as { n: number }[])[0].n);
  };
  let tenantA: string;

  beforeAll(async () => {
    t = await startApp();
    tenantA = (await provision(t.platformDb, A, `admin@${A}.test`, PW)).tenantId;
    await provision(t.platformDb, B, `admin@${B}.test`, PW);
    a = await token(t.http, A, `admin@${A}.test`, PW);
    b = await token(t.http, B, `admin@${B}.test`, PW);
  }, 60_000);

  afterAll(async () => t?.close());

  it('Download Excel Template: exact filename, five headers, no hard-coded provider names', async () => {
    for (const r of [await t.http.post('/api/v1/caller-import/template').set(bearer(a)).buffer().parse(binary).expect(200), await t.http.get('/api/v1/caller-import/template').set(bearer(a)).buffer().parse(binary).expect(200)]) {
      expect(r.headers['content-disposition']).toBe(`attachment; filename="${TEMPLATE_FILENAME}"`);
      expect(r.headers['content-type']).toContain(XLSX);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(r.body as ExcelJS.Buffer);
      expect([1, 2, 3, 4, 5].map((c) => wb.worksheets[0].getRow(1).getCell(c).value)).toEqual([...HEADERS]);
      expect(wb.getWorksheet('Existing Master Data')!.rowCount).toBeLessThanOrEqual(3); // empty tenant: no dropdown data
    }
    await t.http.post('/api/v1/caller-import/template').expect(401);
  });

  it('rejects bad uploads with clear messages and creates nothing', async () => {
    const good = await makeWorkbook(SAMPLE_ROWS);
    expect((await upload(a, good, 'callers.xls', 'application/vnd.ms-excel').expect(400)).body.error.message).toMatch(/\.xls files are not supported/);
    expect((await upload(a, good, 'callers.csv', 'text/csv').expect(400)).body.error.message).toMatch(/Only \.xlsx/);
    expect((await upload(a, good, 'callers.xlsx', 'text/html').expect(400)).body.error.message).toMatch(/Unsupported file type/);
    expect((await upload(a, Buffer.from('Process Name,Service Provider\r\nA,B\r\n'), 'fake.xlsx').expect(400)).body.error.message).toMatch(/not a valid \.xlsx/);
    expect((await t.http.post('/api/v1/caller-import/preview').set(bearer(a)).expect(400)).body.error.message).toMatch(/Attach the Excel file/);
    const renamed = await upload(a, await makeWorkbook(SAMPLE_ROWS, ['Process Name', 'Provider', 'DID', 'Prefix', 'Call Server']), 'x.xlsx').expect(400);
    expect(renamed.body.error.message).toMatch(/column B: expected "Service Provider", found "Provider"/);
    expect((await upload(a, await makeWorkbook(SAMPLE_ROWS, [...HEADERS, 'Tenant ID']), 'x.xlsx').expect(400)).body.error.message).toMatch(/Extra column F/);
    expect((await upload(a, await makeWorkbook([])).expect(400)).body.error.message).toMatch(/no data rows/);
    expect((await upload(a, Buffer.alloc(6 * 1024 * 1024, 1), 'big.xlsx').expect(413)).status).toBe(413);
    expect((await t.http.get('/api/v1/caller-import/batches').set(bearer(a)).expect(200)).body.total).toBe(0);
  });

  it('EMPTY DATABASE: preview discovers and proposes all master data; nothing is created until approved', async () => {
    const rows = uniqueRows(RUN);
    const r = await upload(a, await makeWorkbook(rows)).expect(200);
    expect(r.body.batch).toMatchObject({ status: 'previewed', totalRows: 4, fileName: 'callers.xlsx' });
    expect(r.body.summary).toMatchObject({ totalExcelRecords: 4, validRecords: 4, invalidRecords: 0, duplicateRecords: 0, successfullyImported: 0 });
    const d = r.body.discovery;
    expect(d.existing).toEqual({ processes: 0, providers: 0, callServers: 0, dids: 0 });
    expect(d.proposals.processes).toHaveLength(4);
    expect(d.proposals.providers).toHaveLength(4);
    expect(d.proposals.callServers).toHaveLength(2);
    expect(d.proposals.dids).toHaveLength(4);
    expect(d.proposals.missingLinks).toEqual({ processProvider: 4, processDid: 4, processServer: 4 });
    expect(r.body.rows.items.map((x: { status: string }) => x.status)).toEqual(Array(4).fill('needs_master_data'));
    for (const path of ['providers', 'processes', 'call-servers', 'dids']) expect((await t.http.get(`/api/v1/${path}`).set(bearer(a)).expect(200)).body.total).toBe(0);
    expect(await assignmentCount(tenantA)).toBe(0);
    await t.http.delete(`/api/v1/caller-import/batches/${r.body.batch.id}`).set(bearer(a)).expect(200);
  });

  it('approval creates ONLY pending master records (no invented technical settings), then import creates assignments', async () => {
    const rows = uniqueRows(RUN);
    const { preview, confirm } = await importRows(t.http, a, rows);
    expect(confirm.status).toBe(200);
    expect(confirm.body.summary).toMatchObject({ totalExcelRecords: 4, successfullyImported: 4, failedImports: 0 });
    expect(confirm.body.batch).toMatchObject({ status: 'imported', mode: 'valid_only', importedRows: 4 });

    const providers = (await t.http.get('/api/v1/providers?limit=200').set(bearer(a)).expect(200)).body.items;
    expect(providers.length).toBe(4);
    expect(providers.every((p: { status: string; trunkCount: number }) => p.status === 'pending_configuration' && p.trunkCount === 0)).toBe(true);
    const servers = (await t.http.get('/api/v1/call-servers').set(bearer(a)).expect(200)).body.items;
    expect(servers).toHaveLength(2);
    for (const s of servers) expect(s).toMatchObject({ status: 'pending_configuration', connectionStatus: 'unknown', host: null, ariUrl: null, hasPassword: false });
    const dids = (await t.http.get('/api/v1/dids?limit=200').set(bearer(a)).expect(200)).body.items;
    expect(dids.every((d: { status: string; verificationStatus: string; prefix: string }) => d.status === 'pending_verification' && d.verificationStatus === 'pending' && d.prefix === '91')).toBe(true);
    const processes = (await t.http.get('/api/v1/processes?limit=200').set(bearer(a)).expect(200)).body.items;
    expect(processes).toHaveLength(4);
    expect(processes.every((p: { providerCount: number; didCount: number; serverCount: number; callerAssignmentCount: number }) => p.providerCount === 1 && p.didCount === 1 && p.serverCount === 1 && p.callerAssignmentCount === 1)).toBe(true);

    expect(await assignmentCount(tenantA)).toBe(4);
    const proc = processes.find((p: { name: string }) => p.name === rows[0][0]);
    const asg = (await t.http.get(`/api/v1/process-assignments?processId=${proc.id}`).set(bearer(a)).expect(200)).body;
    expect(asg.callerAssignments).toEqual([expect.objectContaining({ provider: rows[0][1], did: rows[0][2], prefix: '91', callServer: rows[0][4], status: 'active' })]);
    expect(preview.batch.id).toBe(confirm.body.batch.id);
  });

  it('is idempotent: re-confirming a batch is a no-op; re-uploading the same file reports duplicates', async () => {
    const batches = (await t.http.get('/api/v1/caller-import/batches').set(bearer(a)).expect(200)).body;
    const done = batches.items.find((x: { status: string }) => x.status === 'imported');
    const again = await t.http.post('/api/v1/caller-import/confirm').set(bearer(a)).send({ batchId: done.id, mode: 'valid_only' }).expect(200);
    expect(again.body.alreadyImported).toBe(true);
    expect(await assignmentCount(tenantA)).toBe(4);

    // identical content again: every row is a duplicate of an existing assignment, with a warning
    const ownerRows = await (async () => {
      const c = await ownerConnection();
      const [r] = await c.query(`SELECT p.name AS p, sp.name AS s, d.did AS d, ca.prefix AS x, cs.name AS c FROM caller_assignments ca
        JOIN outbound_processes p ON p.id = ca.process_id JOIN service_providers sp ON sp.id = ca.service_provider_id JOIN provider_dids d ON d.id = ca.did_id JOIN call_servers cs ON cs.id = ca.call_server_id WHERE ca.tenant_id = ?`, [tenantA]);
      await c.end();
      return (r as { p: string; s: string; d: string; x: string; c: string }[]).map((x) => [x.p, x.s, x.d, x.x, x.c]);
    })();
    const buf = await makeWorkbook(ownerRows);
    const pv = await upload(a, buf).expect(200);
    expect(pv.body.summary).toMatchObject({ validRecords: 0, duplicateRecords: 4 });
    expect(pv.body.rows.items.every((r: { errors: { code: string }[] }) => r.errors[0].code === 'DUPLICATE_EXISTING')).toBe(true);
    // strict rejects duplicates; valid_only imports nothing and reports failure
    const strict = await t.http.post('/api/v1/caller-import/confirm').set(bearer(a)).send({ batchId: pv.body.batch.id, mode: 'strict' }).expect(422);
    expect(strict.body.error.message).toMatch(/Strict import rejected/);
    expect(await assignmentCount(tenantA)).toBe(4);
    const pv2 = await upload(a, buf).expect(200);
    const none = await t.http.post('/api/v1/caller-import/confirm').set(bearer(a)).send({ batchId: pv2.body.batch.id, mode: 'valid_only' }).expect(200);
    expect(none.body.batch.status).toBe('failed');
    expect(none.body.summary).toMatchObject({ successfullyImported: 0 });
    expect(await assignmentCount(tenantA)).toBe(4);
  });

  it('existing master data validates without approvals; mismatches and bad rows are reported per row', async () => {
    const base = (await t.http.get('/api/v1/dids?limit=200').set(bearer(a)).expect(200)).body.items as { did: string; providerName: string }[];
    const known = SAMPLE_ROWS.map((_, i) => ({ did: base[i].did, provider: base[i].providerName }));
    const procName = `Mixed-${RUN}`;
    const rows = [
      [procName, known[0].provider, known[0].did, '91', `Asterisk-01-${RUN}`], // valid: existing provider/DID/server, new process + links -> needs master data
      [procName, known[1].provider, known[2].did, '91', `Asterisk-01-${RUN}`], // DID belongs to another provider
      [procName, known[1].provider, 'ABC', '91', `Asterisk-01-${RUN}`], // invalid DID
      [procName, known[1].provider, known[1].did, '9 1', `Asterisk-01-${RUN}`], // invalid prefix
      ['', known[1].provider, known[1].did, '91', `Asterisk-01-${RUN}`], // missing process
    ];
    const pv = await upload(a, await makeWorkbook(rows)).expect(200);
    expect(pv.body.summary).toMatchObject({ totalExcelRecords: 5, validRecords: 1, invalidRecords: 4, duplicateRecords: 0 });
    expect(pv.body.discovery.existing).toMatchObject({ providers: 1, dids: 1, callServers: 1 });
    expect(pv.body.discovery.proposals.processes.map((p: { name: string }) => p.name)).toEqual([procName]);
    const codes = pv.body.rows.items.map((r: { errors: { code: string }[] }) => r.errors.map((e) => e.code));
    expect(codes).toEqual([[], ['DID_PROVIDER_MISMATCH'], ['INVALID_DID'], ['INVALID_PREFIX'], ['MISSING_VALUE']]);

    // approve only the new process; valid_only imports the single valid row and skips the rest, never silently
    const key = pv.body.discovery.proposals.processes[0].key;
    await post(t.http, a, '/caller-import/approve-master-data', { batchId: pv.body.batch.id, approve: { processes: [key], links: true } }, 200);
    const done = await t.http.post('/api/v1/caller-import/confirm').set(bearer(a)).send({ batchId: pv.body.batch.id, mode: 'valid_only' }).expect(200);
    expect(done.body.summary).toMatchObject({ totalExcelRecords: 5, successfullyImported: 1, failedImports: 4 });
    expect(await assignmentCount(tenantA)).toBe(5);

    const errors = (await t.http.get(`/api/v1/caller-import/batches/${pv.body.batch.id}/errors`).set(bearer(a)).expect(200)).body;
    expect(errors.total).toBe(4);
    expect(errors.items[0]).toMatchObject({ rowNumber: 3, status: 'invalid' });
    const csv = await t.http.get(`/api/v1/caller-import/batches/${pv.body.batch.id}/download-errors`).set(bearer(a)).buffer().parse(binary).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toMatch(/Project_Dialer_Import_Errors_/);
    const text = (csv.body as Buffer).toString('utf8');
    expect(text).toContain('DID_PROVIDER_MISMATCH');
    expect(text.trim().split('\r\n')).toHaveLength(5); // header + 4 problem rows
    const records = (await t.http.get(`/api/v1/caller-import/batches/${pv.body.batch.id}/records?status=imported`).set(bearer(a)).expect(200)).body;
    expect(records.total).toBe(1);
  });

  it('unapproved master data is never created implicitly: confirm without approval fails every row precisely', async () => {
    const rows = uniqueRows(`na${RUN}`);
    const pv = await upload(a, await makeWorkbook(rows)).expect(200);
    const r = await t.http.post('/api/v1/caller-import/confirm').set(bearer(a)).send({ batchId: pv.body.batch.id, mode: 'valid_only' }).expect(200);
    expect(r.body.summary).toMatchObject({ successfullyImported: 0, failedImports: 4 });
    const errs = (await t.http.get(`/api/v1/caller-import/batches/${pv.body.batch.id}/errors`).set(bearer(a)).expect(200)).body.items;
    expect(errs[0].errors.map((e: { message: string }) => e.message)).toEqual(expect.arrayContaining(['Process Name does not exist.', 'Service Provider is not configured.', 'Call Server does not exist.']));
    expect((await t.http.get(`/api/v1/processes?search=na${RUN}`).set(bearer(a)).expect(200)).body.total).toBe(0);
  });

  it('STRICT import: one bad row rejects everything and saves nothing', async () => {
    const before = await assignmentCount(tenantA);
    const rows = uniqueRows(`st${RUN}`);
    rows[2][2] = 'not-a-did';
    const { confirm } = await importRows(t.http, a, rows, 'strict');
    expect(confirm.status).toBe(422);
    expect(confirm.body.error.message).toMatch(/Nothing was imported/);
    expect(await assignmentCount(tenantA)).toBe(before);
    const batch = (await t.http.get('/api/v1/caller-import/batches?limit=1').set(bearer(a)).expect(200)).body.items[0];
    expect(batch).toMatchObject({ status: 'rejected', mode: 'strict', importedRows: 0 });
  });

  it('STRICT import with all rows valid succeeds', async () => {
    const before = await assignmentCount(tenantA);
    const { confirm } = await importRows(t.http, a, uniqueRows(`ok${RUN}`), 'strict');
    expect(confirm.status).toBe(200);
    expect(confirm.body.batch).toMatchObject({ status: 'imported', mode: 'strict', importedRows: 4 });
    expect(await assignmentCount(tenantA)).toBe(before + 4);
  });

  it('transaction rollback: a failure after the inserts leaves no assignments and the batch stays importable', async () => {
    const rows = uniqueRows(`rb${RUN}`);
    const pv = await upload(a, await makeWorkbook(rows)).expect(200);
    const p = pv.body.discovery.proposals;
    await post(t.http, a, '/caller-import/approve-master-data', { batchId: pv.body.batch.id, approve: { processes: p.processes.map((x: { key: string }) => x.key), providers: p.providers.map((x: { key: string }) => x.key), callServers: p.callServers.map((x: { key: string }) => x.key), dids: p.dids.map((x: { key: string }) => x.key), links: true } }, 200);
    const before = await assignmentCount(tenantA);

    const audit = t.app.get(AuditService);
    const original = audit.log.bind(audit);
    const spy = jest.spyOn(audit, 'log').mockImplementation(async (tx, entry, ctx) => {
      if (entry.action === 'caller_import.imported') throw new Error('simulated failure after inserts');
      return original(tx, entry, ctx);
    });
    await t.http.post('/api/v1/caller-import/confirm').set(bearer(a)).send({ batchId: pv.body.batch.id, mode: 'valid_only' }).expect(500);
    spy.mockRestore();
    expect(await assignmentCount(tenantA)).toBe(before);
    expect((await t.http.get(`/api/v1/caller-import/batches/${pv.body.batch.id}`).set(bearer(a)).expect(200)).body.batch.status).toBe('approved');
    await t.http.post('/api/v1/caller-import/confirm').set(bearer(a)).send({ batchId: pv.body.batch.id, mode: 'valid_only' }).expect(200);
    expect(await assignmentCount(tenantA)).toBe(before + 4);
  });

  it('cross-tenant: another tenant cannot see, approve, confirm, download or delete a batch, and sees none of the master data', async () => {
    const batch = (await t.http.get('/api/v1/caller-import/batches?limit=1').set(bearer(a)).expect(200)).body.items[0];
    expect((await t.http.get('/api/v1/caller-import/batches').set(bearer(b)).expect(200)).body.total).toBe(0);
    await t.http.get(`/api/v1/caller-import/batches/${batch.id}`).set(bearer(b)).expect(404);
    await t.http.get(`/api/v1/caller-import/batches/${batch.id}/errors`).set(bearer(b)).expect(404);
    await t.http.get(`/api/v1/caller-import/batches/${batch.id}/download-errors`).set(bearer(b)).expect(404);
    await t.http.delete(`/api/v1/caller-import/batches/${batch.id}`).set(bearer(b)).expect(404);
    await t.http.post('/api/v1/caller-import/confirm').set(bearer(b)).send({ batchId: batch.id, mode: 'valid_only' }).expect(404);
    await t.http.post('/api/v1/caller-import/approve-master-data').set(bearer(b)).send({ batchId: batch.id, approve: { links: true } }).expect(404);
    // A's names mean nothing in B: the same file is "all new" there, and importing in B never touches A
    const pv = await upload(b, await makeWorkbook(SAMPLE_ROWS)).expect(200);
    expect(pv.body.discovery.existing).toEqual({ processes: 0, providers: 0, callServers: 0, dids: 0 });
    const aBefore = await assignmentCount(tenantA);
    const { confirm } = await importRows(t.http, b, uniqueRows(`bb${RUN}`));
    expect(confirm.status).toBe(200);
    expect(await assignmentCount(tenantA)).toBe(aBefore);
  });

  it('deleting a batch rolls back its assignments (master data stays); unconfirmed batches are simply deleted', async () => {
    const { confirm } = await importRows(t.http, a, uniqueRows(`dl${RUN}`));
    const before = await assignmentCount(tenantA);
    const del = await t.http.delete(`/api/v1/caller-import/batches/${confirm.body.batch.id}`).set(bearer(a)).expect(200);
    expect(del.body).toEqual({ status: 'rolled_back', removedAssignments: 4 });
    expect(await assignmentCount(tenantA)).toBe(before - 4);
    expect((await t.http.get(`/api/v1/caller-import/batches/${confirm.body.batch.id}`).set(bearer(a)).expect(200)).body.batch.status).toBe('rolled_back');
    expect((await t.http.get(`/api/v1/providers?search=Tata-dl${RUN}`).set(bearer(a)).expect(200)).body.total).toBe(1);
    const pv = await upload(a, await makeWorkbook(uniqueRows(`dl2${RUN}`))).expect(200);
    expect((await t.http.delete(`/api/v1/caller-import/batches/${pv.body.batch.id}`).set(bearer(a)).expect(200)).body.status).toBe('deleted');
  });

  it('import history is paginated and filterable', async () => {
    const page1 = (await t.http.get('/api/v1/caller-import/batches?limit=2&offset=0').set(bearer(a)).expect(200)).body;
    const page2 = (await t.http.get('/api/v1/caller-import/batches?limit=2&offset=2').set(bearer(a)).expect(200)).body;
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBeGreaterThan(4);
    expect(page2.items[0].id).not.toBe(page1.items[0].id);
    const imported = (await t.http.get('/api/v1/caller-import/batches?status=imported&limit=100').set(bearer(a)).expect(200)).body;
    expect(imported.items.every((x: { status: string }) => x.status === 'imported')).toBe(true);
    await t.http.get('/api/v1/caller-import/batches?limit=500').set(bearer(a)).expect(200); // clamped to 100
    await t.http.get('/api/v1/caller-import/batches?limit=1000').set(bearer(a)).expect(400);
  });

  it('handles a large file (2000 records) end to end', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => [`LP${i % 25}-${RUN}`, `LS${i % 8}-${RUN}`, String(4000000000 + i), '91', `LC${i % 3}-${RUN}`]);
    // each DID may only appear under one provider: make the provider a function of the DID
    for (const r of rows) r[1] = `LS${Number(r[2]) % 8}-${RUN}`;
    const started = Date.now();
    const { preview, confirm } = await importRows(t.http, a, rows);
    expect(confirm.status).toBe(200);
    expect(preview.summary.totalExcelRecords).toBe(2000);
    expect(confirm.body.summary.successfullyImported).toBe(2000);
    expect(Date.now() - started).toBeLessThan(90_000);
    expect(names(rows).processes.length).toBe(2000);
  }, 180_000);
});

function binary(res: any, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}
